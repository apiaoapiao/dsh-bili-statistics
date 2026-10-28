/**
 * 模型润色：把统计事实改写成自然语言的观看状态名、概览、计划完成情况与私信文案。
 * 设计约束：模型只负责叙述与推断，不产生数字；模型不可用 / 失败 / 超时一律返回 ok=false，
 * 由调用方回退到模板文案，绝不因为模型问题而丢掉报告或通知。
 */
import { pct } from './util.js';
import { SHAPE_LABEL } from './report.js';

/** 报告概览 + 计划完成情况的默认系统提示词。数字必须来自输入，推断必须标注。 */
export const DEFAULT_REPORT_PROMPT = [
  '你是一位中文写作助手。你会拿到一份 B 站观看统计、若干条带编号的观看记录（含标题、作者、完成度、时长），以及用户自己定的计划。',
  '你要写三样东西：一个观看状态名、一段概览，以及对计划完成情况的说明。',
  '硬性要求：',
  '1. 只使用输入里出现的数字与条目，不得新增、四舍五入或推算任何数字；不确定就不写。',
  '2. 不得评价用户的自控力、意志力、人品，不得给出建议、劝告或"你应该"式的句子。',
  '3. 必须区分硬事实与推断：推断要写成"看起来像""可能是"，不要当成结论。',
  '4. 观看状态名用 2–10 个汉字，自己概括这批记录到底是怎么被看的，要具体（可以点出时段、内容类型、作者的重复），不要套用"碎片化连刷"这类现成分类，也不要写评价词。',
  '5. 观看状态的理由写一句话，说清凭什么这么判断，必须引用输入里的数字或条目，不超过 60 字。',
  '6. 概览挑 2–4 个最值得注意的点串成 150–350 字的连续段落，不要重复罗列全部统计项。',
  '7. 计划情况：用户定过计划，就对照计划用统计数字和具体视频标题说明哪部分做到了、哪部分没做到（例如计划只看公开课，实际记录里出现了哪些别的题材）；用户没定计划，就改为说明这次观看本身的完成情况——哪些条目看完了、哪些只开了头、集中在什么内容上。每条都要点到标题或作者，并引用至少 2 条记录编号；不要替他编一个目标，也不要给建议。',
  '8. 写法是陈述已经发生的事，不要写成假设、预测或建议；通篇用简体中文。'
].join('\n');

/** 私信文案的默认系统提示词，语气可在此或设置页里调整。 */
export const DEFAULT_DM_PROMPT = [
  '你是一个克制的个人助理，帮用户把当天的 B 站观看统计写成一条发给自己的私信。',
  '硬性要求：',
  '1. 语气平实、就事论事，像日程提醒，不说教、不鼓励、不批评，不用感叹号。',
  '2. 只写输入里给出的数字，不推测未提供的信息，不做建议。',
  '3. 一句话或两句话，总长不超过 {max_chars} 字。',
  '4. 直接输出正文，不要称呼、不要"以下是"、不要代码围栏。',
  '5. 通篇用简体中文。'
].join('\n');

const FENCE = /^\s*[`]{3}[a-zA-Z]*\s*\n?|\n?\s*[`]{3}\s*$/g;

/** 去掉模型爱加的代码围栏、书名号式开场白与首尾空白。 */
export function sanitizeModelText(input) {
  let text = String(input ?? '').replace(FENCE, '').trim();
  text = text.replace(/^(以下|下面)(是|为)[^\n]{0,40}[:：]\s*/u, '');
  return text.trim();
}

const clip = (value, max) => {
  const text = String(value ?? '').trim();
  return text.length > max ? text.slice(0, max) : text;
};

/** 从（可能被截断的）JSON 文本里捞一个字符串字段，捞不到返回空串。 */
function extractJsonString(raw, key) {
  const pattern = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"');
  const matched = String(raw ?? '').match(pattern);
  if (!matched) return '';
  try {
    return String(JSON.parse('"' + matched[1] + '"'));
  } catch {
    return matched[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
}

/** 概览里混进 JSON 结构时（典型是被截断的输出），只保留 JSON 之前的人话。 */
function stripJsonNoise(value) {
  const text = String(value ?? '');
  const cut = text.search(/\{\s*"/);
  return (cut >= 0 ? text.slice(0, cut) : text).trim();
}

/**
 * 解析模型输出：期望是 {"shape":"…","overview":"…","hypotheses":[{text,clue,evidence:[1,3]}]}。
 * 解析失败时逐字段捞取；捞不到就留空，绝不把原始 JSON 结构当成概览。永不抛错。
 * @returns {{overview: string, hypotheses: Array, shape: string, shape_reason: string, parsed: boolean}}
 */
export function parseReportOutput(raw, evidence = []) {
  const text = sanitizeModelText(raw);
  const base = { overview: '', hypotheses: [], shape: '', shape_reason: '', parsed: false };
  if (text.length === 0) return base;
  const looksJson = /\{\s*"|"(overview|shape|shape_reason)"\s*:/.test(text);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let data = null;
  if (start >= 0 && end > start) {
    const slice = text.slice(start, end + 1);
    try {
    data = JSON.parse(slice);
  } catch {
    try {
      data = JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      data = null;
    }
  }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    if (!looksJson) {
      // 模型没按 JSON 输出，但写了一段人话：整段当概览。
      const plain = stripJsonNoise(text);
      return plain.length > 0 ? Object.assign({}, base, { overview: clip(plain, 1200) }) : base;
    }
    // JSON 不完整（典型是被 max tokens 截断）：逐字段捞，别让 {"shape":… 之类的结构进概览。
    const overview = stripJsonNoise(extractJsonString(text, 'overview'));
    const shape = extractJsonString(text, 'shape').split('\n')[0];
    const reason = extractJsonString(text, 'shape_reason');
    if (overview.length === 0 && shape.trim().length === 0) return base;
    return Object.assign({}, base, {
      overview: clip(overview, 1200),
      shape: clip(shape.replace(/^["'「『]+|["'」』]+$/g, '').trim(), 16),
      shape_reason: clip(reason, 80)
    });
  }
  const list = Array.isArray(evidence) ? evidence : [];
  const hypotheses = [];
  for (const item of Array.isArray(data.hypotheses) ? data.hypotheses : []) {
    if (hypotheses.length >= 3) break;
    const body = clip(item?.text, 240);
    if (body.length === 0) continue;
    const refs = Array.isArray(item?.evidence)
      ? item.evidence.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 1 && value <= list.length)
      : [];
    const unique = [...new Set(refs)];
    if (unique.length < 2) continue;
    hypotheses.push({
      text: body,
      clue: item?.clue ? clip(item.clue, 160) : null,
      evidence: unique.map((index) => {
        const entry = list[index - 1] ?? {};
        return String(entry.time ?? '') + ' ' + String(entry.title ?? '');
      }),
      refs: unique
    });
  }
  const overview = stripJsonNoise(typeof data.overview === 'string' ? clip(data.overview, 1200) : '');
  const shape = clip(String(data.shape ?? '').split('\n')[0].replace(/^["'「『]+|["'」』]+$/g, '').trim(), 16);
  const shapeReason = clip(data.shape_reason, 80);
  if (overview.length === 0 && hypotheses.length === 0 && shape.length === 0) return base;
  return { overview, hypotheses, shape, shape_reason: shapeReason, parsed: true };
}

/** 生效的模型目标：provider 与 model 都非空才算配置好。 */
export function modelTarget(config) {
  const llm = config?.llm ?? {};
  const provider = String(llm.provider ?? '').trim();
  const model = String(llm.model ?? '').trim();
  if (provider.length === 0 || model.length === 0) return null;
  if (llm.enabled === false) return null;
  return { provider, model };
}

/**
 * 单次文本生成：拼接 text-delta，超时或异常都收敛成 {ok:false}，绝不抛给调用方。
 * @returns {Promise<{ok: boolean, text: string, reason: string|null, message: string|null, elapsed_ms: number}>}
 */
export async function generateText(llm, {
  provider,
  model,
  system,
  prompt,
  maxTokens = 900,
  temperature = 0.3,
  timeoutMs = 20000,
  signal
} = {}) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, text: '', reason: 'no-llm', message: '宿主没有提供 llm 服务', elapsed_ms: elapsed() };
  }
  if (!provider || !model) {
    return { ok: false, text: '', reason: 'no-model', message: '没有配置 provider/model', elapsed_ms: elapsed() };
  }
  const text = String(prompt ?? '').trim();
  if (text.length === 0) {
    return { ok: false, text: '', reason: 'empty-prompt', message: '提示词为空', elapsed_ms: elapsed() };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  const onAbort = () => controller.abort();
  if (signal && typeof signal.addEventListener === 'function') {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let out = '';
  let reasoning = '';
  let finish = null;
  try {
    const stream = llm.stream({
      provider,
      model,
      system: system ? String(system) : undefined,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      maxTokens: Math.max(64, Math.round(maxTokens)),
      temperature,
      signal: controller.signal
    });
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
      else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text;
      else if (chunk.type === 'finish') finish = chunk.reason ?? null;
    }
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      text: '',
      reason: aborted ? 'timeout' : 'error',
      message: aborted ? '模型调用超过 ' + timeoutMs + 'ms 未返回' : (error?.message ?? String(error)),
      elapsed_ms: elapsed()
    };
  } finally {
    clearTimeout(timer);
    if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
  }

  const cleaned = sanitizeModelText(out);
  if (cleaned.length === 0) {
    // 空正文要区分原因：模型报错、超时、被 max tokens 截断、思考占满额度都没正文，但处理方式不同。
    const kind = typeof finish === 'string'
      ? finish
      : (finish && typeof finish.kind === 'string' ? finish.kind : null);
    const failure = finish && typeof finish === 'object' && finish.failure && typeof finish.failure.message === 'string'
      ? finish.failure.message
      : null;
    if (kind === 'error') {
      return { ok: false, text: '', reason: 'error', message: failure ?? '模型返回了错误', elapsed_ms: elapsed() };
    }
    if (kind === 'aborted') {
      return { ok: false, text: '', reason: 'timeout', message: failure ?? '模型调用被中断', elapsed_ms: elapsed() };
    }
    if (kind === 'max-tokens') {
      return {
        ok: false,
        text: '',
        reason: 'truncated',
        message: '模型输出被 max tokens 截断（思考过程也占额度）：把设置页里的 max tokens 调大一些',
        elapsed_ms: elapsed()
      };
    }
    if (reasoning.trim().length > 0) {
      return {
        ok: false,
        text: '',
        reason: 'thinking-only',
        message: '模型只输出了思考过程，没有正文：把 max tokens 调大一些',
        elapsed_ms: elapsed()
      };
    }
    return { ok: false, text: '', reason: 'empty-output', message: '模型返回了空文本', elapsed_ms: elapsed() };
  }
  return { ok: true, text: cleaned, reason: null, message: null, elapsed_ms: elapsed() };
}

/** 把证据集写成给模型看的编号清单：标题是计划情况唯一的落地素材。 */
export function evidenceLines(evidence = []) {
  const list = Array.isArray(evidence) ? evidence : [];
  if (list.length === 0) return [];
  return list.map((entry, index) => {
    const parts = [String(entry.time ?? ''), clip(entry.title, 90) || '（无标题）'];
    if (entry.author) parts.push('作者 ' + clip(entry.author, 40));
    if (entry.completion !== null && entry.completion !== undefined) parts.push('完成度 ' + pct(entry.completion, 0));
    if (entry.duration_min) parts.push(entry.duration_min + ' 分钟');
    return (index + 1) + '. ' + parts.filter((line) => line !== '').join(' · ');
  });
}

/** 报告请求：输入是统计数字、证据清单与模板报告，模型输出一段 JSON。 */
export function buildReportRequest(config, { facts, evidence = [], hypotheses = [], markdown = '', knownShapes = [] } = {}) {
  const system = String(config?.llm?.report_prompt ?? '').trim() || DEFAULT_REPORT_PROMPT;
  const lines = [];
  lines.push('窗口：' + (facts?.window?.label ?? '未知'));
  lines.push('条目数：' + (facts?.total_items ?? 0));
  if (facts?.behavior_shape) {
    lines.push('规则初步判断（只是参考，你可以给出更贴切的说法）：' + (SHAPE_LABEL[facts.behavior_shape.shape] ?? facts.behavior_shape.shape) + '（可信度 ' + facts.behavior_shape.confidence + '，这是根据完成度与时长推出来的，不是事实）');
    const known = (Array.isArray(knownShapes) ? knownShapes : []).map((item) => String(item ?? '').trim()).filter((item) => item.length > 0);
    if (known.length > 0) lines.push('此前用过的观看状态（能沿用就沿用，同一个状态别每次换名字；不合适再新起）：' + known.join('、'));
    if (Array.isArray(facts.behavior_shape.signals) && facts.behavior_shape.signals.length > 0) {
      lines.push('判断依据：' + facts.behavior_shape.signals.join('；'));
    }
  }
  if (facts?.time_distribution) {
    lines.push('22 点后占比：' + (facts.time_distribution.after_22_share ?? '未知'));
    lines.push('深夜条目数：' + (facts.time_distribution.late_night_count ?? '未知'));
  }
  if (facts?.passive_chain) lines.push('最长连续自动播放：' + facts.passive_chain.max_consecutive + ' 条');
  if (facts?.repetition) lines.push('同作者最长连续：' + facts.repetition.max_same_author_run + ' 条');
  if (facts?.baseline && facts.baseline.lookback_runs > 0 && facts.baseline.delta_ratio !== null) {
    lines.push('与最近 ' + facts.baseline.lookback_runs + ' 次中位数（' + facts.baseline.median_items + ' 条）相比：' + (facts.baseline.delta_ratio >= 0 ? '高' : '低') + Math.abs(Math.round(facts.baseline.delta_ratio * 100)) + '%');
  }
  if (facts?.intent_anchor) {
    lines.push('用户定的计划（' + (facts.intent_anchor.days_since_set ?? '?') + ' 天前）：' + facts.intent_anchor.text);
  } else {
    lines.push('用户还没有定计划：计划情况这一节改成写这次观看本身的完成情况（哪些看完、哪些只开了头、集中在什么内容上），不要替他编目标。');
  }
  if (Array.isArray(hypotheses) && hypotheses.length > 0) {
    lines.push('此前保存过的计划情况（可参考，不要照抄）：' + hypotheses.map((h) => h.text).join('；'));
  }
  const numbered = evidenceLines(evidence);
  const prompt = [
    '统计数字：',
    lines.join('\n'),
    '',
    '本次涉及的观看记录（编号用来给计划情况做引用）：',
    numbered.length > 0 ? numbered.join('\n') : '（这次没有可用记录）',
    '',
    '报告模板正文（供你了解全貌）：',
    '',
    String(markdown ?? '').slice(0, 4000),
    '',
    '请只输出一个 JSON 对象，不要代码围栏，不要任何额外说明：',
    '{"shape":"2–10 字的观看状态名","shape_reason":"一句话说清依据","overview":"150–350 字概览","hypotheses":[{"text":"计划里的某一条做到了或没做到，或这次观看的完成情况，写成一句陈述","clue":"这条判断的依据（数字或条目特征）","evidence":[1,3]}]}',
    'shape 要贴合这批记录（时段、内容类型、作者重复都可以点出来），不要套用现成的固定分类；shape_reason 不超过 60 字，引用输入里的数字或条目。',
    'hypotheses 字段承载计划情况，给 1–3 条：有计划的，对照上面的计划说明哪些做到了、哪些没做到；没有计划的，写这次观看本身的完成情况（哪些看完了、哪些只开了头、集中在什么内容上）。每条都引用至少 2 个记录编号，并点到具体视频标题或作者。'
  ].join('\n');
  return { system, prompt, lines };
}

/** 私信文案请求：把模板摘要改写成指定语气的短句。 */
export function buildDmRequest(config, { facts, summary, maxChars = 200, shapeLabel = '' } = {}) {
  const template = String(config?.llm?.dm_prompt ?? '').trim() || DEFAULT_DM_PROMPT;
  const system = template.replaceAll('{max_chars}', String(maxChars));
  const ruleShape = facts?.behavior_shape ? (SHAPE_LABEL[facts.behavior_shape.shape] ?? facts.behavior_shape.shape) : '';
  const usedShape = String(shapeLabel ?? '').trim() || ruleShape;
  const prompt = [
    '统计事实：' + String(summary ?? ''),
    facts?.window?.label ? '窗口：' + facts.window.label : '',
    usedShape ? '观看状态：' + usedShape : '',
    facts?.baseline && facts.baseline.lookback_runs > 0 && facts.baseline.delta_ratio !== null
      ? '与最近 ' + facts.baseline.lookback_runs + ' 次中位数相比：' + (facts.baseline.delta_ratio >= 0 ? '高' : '低') + Math.abs(Math.round(facts.baseline.delta_ratio * 100)) + '%'
      : '',
    '',
    '请写成一条不超过 ' + maxChars + ' 字的私信正文。'
  ].filter((line) => line !== '').join('\n');
  return { system, prompt };
}

/** 报告概览 + 计划情况：失败时返回 ok=false，调用方继续用模板报告。 */
export async function polishReport({ llm, config, facts, evidence = [], hypotheses, markdown, knownShapes = [], signal } = {}) {
  const target = modelTarget(config);
  if (!target) return { ok: false, text: '', reason: 'no-model', message: '未配置模型' };
  const req = buildReportRequest(config, { facts, evidence, hypotheses, markdown, knownShapes });
  const result = await generateText(llm, {
    ...target,
    system: req.system,
    prompt: req.prompt,
    maxTokens: Math.max(config?.llm?.max_tokens ?? 2000, 2000),
    timeoutMs: config?.llm?.timeout_ms ?? 20000,
    signal
  });
  if (!result.ok) return result;
  const parsed = parseReportOutput(result.text, evidence);
  const overview = parsed.overview;
  if (overview.length === 0 && parsed.hypotheses.length === 0 && !parsed.shape) {
    return { ok: false, text: '', reason: 'empty-output', message: '模型没有给出可用的概览', elapsed_ms: result.elapsed_ms };
  }
  return {
    ok: true,
    text: overview,
    overview,
    shape: parsed.shape,
    shape_reason: parsed.shape_reason,
    hypotheses: parsed.hypotheses,
    parsed: parsed.parsed,
    reason: null,
    provider: target.provider,
    model: target.model,
    elapsed_ms: result.elapsed_ms
  };
}

/** 私信文案：失败时返回 ok=false，调用方回退模板摘要。 */
export async function polishDm({ llm, config, facts, summary, maxChars = 200, shapeLabel = '', signal } = {}) {
  const target = modelTarget(config);
  if (!target) return { ok: false, text: '', reason: 'no-model', message: '未配置模型' };
  const req = buildDmRequest(config, { facts, summary, maxChars, shapeLabel });
  const result = await generateText(llm, {
    ...target,
    system: req.system,
    prompt: req.prompt,
    maxTokens: Math.max(config?.llm?.max_tokens ?? 1600, 1600),
    temperature: 0.4,
    timeoutMs: config?.llm?.timeout_ms ?? 20000,
    signal
  });
  if (!result.ok) return result;
  return {
    ok: true,
    text: result.text.length > maxChars ? result.text.slice(0, maxChars) : result.text,
    reason: null,
    provider: target.provider,
    model: target.model,
    elapsed_ms: result.elapsed_ms
  };
}
