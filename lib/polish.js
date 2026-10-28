/**
 * 模型润色：把统计事实改写成自然语言导读与私信文案。
 * 设计约束：模型只负责叙述，不产生数字；模型不可用 / 失败 / 超时一律返回 ok=false，
 * 由调用方回退到模板文案，绝不因为模型问题而丢掉报告或通知。
 */

/** 报告导读的默认系统提示词。数字必须来自输入，推断必须标注。 */
export const DEFAULT_REPORT_PROMPT = [
  '你是一位中文写作助手，任务是把一份 B 站观看行为的统计事实改写成一段可读的导读。',
  '硬性要求：',
  '1. 只使用输入里出现的数字与条目，不得新增、四舍五入或推算任何数字；不确定就不写。',
  '2. 不得评价用户的自控力、意志力、人品，不得给出建议、劝告或"你应该"式的句子。',
  '3. 必须区分硬事实与推断：推断要写成"看起来像""可能是"，不要当成结论。',
  '4. 不要重复罗列全部统计项，挑 2–4 个最值得注意的点串成 150–350 字的连续段落。',
  '5. 直接输出正文，不要标题、不要 Markdown 代码围栏、不要"以下是"之类的开场白。',
  '6. 通篇用简体中文。'
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

const FENCE = /^\s*```[a-zA-Z]*\s*\n?|\n?\s*```\s*$/g;

/** 去掉模型爱加的代码围栏、书名号式开场白与首尾空白。 */
export function sanitizeModelText(input) {
  let text = String(input ?? '').replace(FENCE, '').trim();
  text = text.replace(/^(以下|下面)(是|为)[^\n]{0,40}[:：]\s*/u, '');
  return text.trim();
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
  maxTokens = 600,
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
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
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
    return { ok: false, text: '', reason: 'empty-output', message: '模型返回了空文本', elapsed_ms: elapsed() };
  }
  return { ok: true, text: cleaned, reason: null, message: null, elapsed_ms: elapsed() };
}

/** 报告导读请求：输入是模板渲染出的完整 Markdown，模型只重写叙述部分。 */
export function buildReportRequest(config, { facts, hypotheses = [], markdown = '' } = {}) {
  const system = String(config?.llm?.report_prompt ?? '').trim() || DEFAULT_REPORT_PROMPT;
  const lines = [];
  lines.push('窗口：' + (facts?.window?.label ?? '未知'));
  lines.push('条目数：' + (facts?.total_items ?? 0));
  if (facts?.behavior_shape) {
    lines.push('形态推断：' + facts.behavior_shape.shape + '（置信度 ' + facts.behavior_shape.confidence + '，这是启发式推断，不是事实）');
    if (Array.isArray(facts.behavior_shape.signals) && facts.behavior_shape.signals.length > 0) {
      lines.push('形态依据：' + facts.behavior_shape.signals.join('；'));
    }
  }
  if (facts?.time_distribution) {
    lines.push('22 点后占比：' + (facts.time_distribution.after_22_share ?? '未知'));
    lines.push('深夜条目数：' + (facts.time_distribution.late_night_count ?? '未知'));
  }
  if (facts?.passive_chain) lines.push('最长连续被动链：' + facts.passive_chain.max_consecutive + ' 条');
  if (facts?.repetition) lines.push('同作者最长连续：' + facts.repetition.max_same_author_run + ' 条');
  if (facts?.baseline && facts.baseline.lookback_runs > 0 && facts.baseline.delta_ratio !== null) {
    lines.push('与最近 ' + facts.baseline.lookback_runs + ' 次中位数（' + facts.baseline.median_items + ' 条）相比：' + (facts.baseline.delta_ratio >= 0 ? '高' : '低') + Math.abs(Math.round(facts.baseline.delta_ratio * 100)) + '%');
  }
  if (facts?.intent_anchor) {
    lines.push('用户的意图档案（' + (facts.intent_anchor.days_since_set ?? '?') + ' 天前设置）：' + facts.intent_anchor.text);
  }
  if (Array.isArray(hypotheses) && hypotheses.length > 0) {
    lines.push('已保存的行为假设（推断）：' + hypotheses.map((h) => h.text).join('；'));
  }
  const prompt = [
    '以下是本次统计的原始报告（Markdown），供你了解全貌：',
    '',
    String(markdown ?? '').slice(0, 4000),
    '',
    '请基于上面的数字，写一段 150–350 字的导读，放在报告开头。只叙述，不评价、不建议。'
  ].join('\n');
  return { system, prompt, lines };
}

/** 私信文案请求：把模板摘要改写成指定语气的短句。 */
export function buildDmRequest(config, { facts, summary, maxChars = 200 } = {}) {
  const template = String(config?.llm?.dm_prompt ?? '').trim() || DEFAULT_DM_PROMPT;
  const system = template.replaceAll('{max_chars}', String(maxChars));
  const prompt = [
    '统计事实：' + String(summary ?? ''),
    facts?.window?.label ? '窗口：' + facts.window.label : '',
    facts?.behavior_shape ? '形态推断：' + facts.behavior_shape.shape + '（置信度 ' + facts.behavior_shape.confidence + '）' : '',
    facts?.baseline && facts.baseline.lookback_runs > 0 && facts.baseline.delta_ratio !== null
      ? '与最近 ' + facts.baseline.lookback_runs + ' 次中位数相比：' + (facts.baseline.delta_ratio >= 0 ? '高' : '低') + Math.abs(Math.round(facts.baseline.delta_ratio * 100)) + '%'
      : '',
    '',
    '请写成一条不超过 ' + maxChars + ' 字的私信正文。'
  ].filter((line) => line !== '').join('\n');
  return { system, prompt };
}

/** 报告导读：失败时返回 ok=false，调用方继续用模板报告。 */
export async function polishReport({ llm, config, facts, hypotheses, markdown, signal } = {}) {
  const target = modelTarget(config);
  if (!target) return { ok: false, text: '', reason: 'no-model', message: '未配置模型' };
  const req = buildReportRequest(config, { facts, hypotheses, markdown });
  const result = await generateText(llm, {
    ...target,
    system: req.system,
    prompt: req.prompt,
    maxTokens: config?.llm?.max_tokens ?? 600,
    timeoutMs: config?.llm?.timeout_ms ?? 20000,
    signal
  });
  return result.ok ? { ok: true, text: result.text, reason: null, provider: target.provider, model: target.model, elapsed_ms: result.elapsed_ms } : result;
}

/** 私信文案：失败时返回 ok=false，调用方回退模板摘要。 */
export async function polishDm({ llm, config, facts, summary, maxChars = 200, signal } = {}) {
  const target = modelTarget(config);
  if (!target) return { ok: false, text: '', reason: 'no-model', message: '未配置模型' };
  const req = buildDmRequest(config, { facts, summary, maxChars });
  const result = await generateText(llm, {
    ...target,
    system: req.system,
    prompt: req.prompt,
    maxTokens: Math.min(config?.llm?.max_tokens ?? 600, 400),
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
