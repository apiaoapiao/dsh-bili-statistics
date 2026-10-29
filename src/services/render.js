/**
 * 渲染用例：报告正文（模板 + 模型写的观看状态、概览与计划情况）、私信文案、邮件附件。
 * 模型调用失败一律降级为模板，不抛错。
 */
import { loadState, saveState } from '../core/state.js';
import { saveReport, buildSummary, renderMarkdown } from '../domain/report.js';
import { formatLocal } from '../domain/time.js';
import { polishReport, polishDm } from './polish.js';

/** 模型配置指纹：换了模型或提示词就重新生成，否则复用上次结果。 */
function reportStamp(cfg) {
  return [cfg.llm.provider, cfg.llm.model, String(cfg.llm.report_prompt ?? '').slice(0, 60)].join('|');
}

/**
 * 报告渲染：模板正文（数字全部来自统计）+ 模型写的概览与计划情况。
 * 模型失败就等于没有这两节，报告本身不降级；同一份统计的成功结果会缓存到 run 上，避免重复调用。
 */
export async function renderReport(run, hypotheses, options, { stateDir, getConfig, getLlm }) {
  const cfg = getConfig();
  const zone = cfg.schedule.timezone;
  if (!run.facts) throw new Error('这条统计记录缺少 facts，请重新调用 bili_intent_facts');
  const now = Date.now();
  const state = loadState(stateDir);
  const stored = state.runs.find((entry) => entry.id === run.id) ?? null;
  // 之前用过的观看状态名：给模型做连续性参考，同一个状态别每次换说法。
  const knownShapes = [];
  for (const entry of state.runs) {
    if (entry.id === run.id) continue;
    const label = entry?.generated?.shape?.label;
    if (typeof label !== 'string') continue;
    const clean = label.trim();
    if (clean.length > 0 && !knownShapes.includes(clean)) knownShapes.push(clean);
    if (knownShapes.length >= 3) break;
  }
  const rawCached = !options.refresh && stored?.generated && stored.generated.stamp === reportStamp(cfg) ? stored.generated : null;
  // 旧版本解析失败时会把整段 JSON 当概览写进缓存：这种缓存作废，重新生成一次。
  const dirtyOverview = rawCached && typeof rawCached.overview === 'string' && /^\s*\{/.test(rawCached.overview);
  const cached = dirtyOverview ? null : rawCached;
  let narrative = null;
  let shape = null;
  let generated = [];
  let polish = { ok: false, reason: 'disabled', message: null };
  if (cached) {
    narrative = typeof cached.overview === 'string' ? cached.overview : null;
    generated = Array.isArray(cached.hypotheses) ? cached.hypotheses : [];
    if (cached.shape && typeof cached.shape.label === 'string' && cached.shape.label.trim().length > 0) {
      shape = { label: cached.shape.label.trim(), reason: typeof cached.shape.reason === 'string' ? cached.shape.reason : null };
    }
    polish = { ok: true, reason: null, message: null, cached: true };
  }
  // 早期缓存里没有模型起的观看状态名：当成缓存不完整，补调一次模型；失败就继续用缓存里的概览与计划情况。
  const needShape = Boolean(cached) && shape === null && cfg.report.polish;
  if ((!cached || needShape) && cfg.report.polish) {
    const template = renderMarkdown(run.facts, { hypotheses, now, timeZone: zone });
    const fresh = await polishReport({
      llm: getLlm(),
      config: cfg,
      facts: run.facts,
      evidence: Array.isArray(run.evidence) ? run.evidence : [],
      hypotheses,
      markdown: template,
      knownShapes,
      signal: options.signal
    });
    if (fresh.ok) {
      polish = fresh;
      narrative = fresh.text;
      generated = Array.isArray(fresh.hypotheses) ? fresh.hypotheses : [];
      if (typeof fresh.shape === 'string' && fresh.shape.trim().length > 0) {
        shape = {
          label: fresh.shape.trim(),
          reason: typeof fresh.shape_reason === 'string' && fresh.shape_reason.trim().length > 0 ? fresh.shape_reason.trim() : null
        };
      }
      if (stored) {
        stored.generated = {
          stamp: reportStamp(cfg),
          at: new Date(now).toISOString(),
          overview: narrative,
          shape,
          hypotheses: generated
        };
        saveState(stateDir, state);
      }
    } else if (!cached) {
      polish = fresh;
    }
  }
  const used = generated.length > 0 ? generated : hypotheses;
  const paths = cfg.report.save_local
    ? saveReport({
        dir: cfg.report.local_dir,
        format: cfg.report.format,
        facts: run.facts,
        hypotheses: used,
        narrative,
        shape,
        now,
        timeZone: zone
      })
    : [];
  const summary = buildSummary(run.facts, { maxChars: cfg.notify.summary_max_chars });
  return {
    paths,
    summary,
    narrative,
    hypotheses: used,
    hypotheses_source: generated.length > 0 ? 'model' : 'saved',
    shape_label: shape?.label ?? null,
    shape_reason: shape?.reason ?? null,
    shape_source: shape ? 'model' : 'rule',
    polished: polish.ok,
    polish_reason: polish.reason ?? null,
    polish_message: polish.message ?? null,
    cached: Boolean(cached)
  };
}

/**
 * 私信正文：模板摘要给出硬事实，模型按 llm.dm_prompt 改写语气。
 * 模型失败就用模板，绝不发空消息。
 */
export async function composeDm(facts, { maxChars, signal, shapeLabel = '' } = {}, { getConfig, getLlm }) {
  const cfg = getConfig();
  const budget = maxChars ?? cfg.notify.summary_max_chars;
  const template = facts ? buildSummary(facts, { maxChars: budget, shapeLabel }) : '今天没有新的观看记录。';
  if (!facts) return { text: template, polished: false, reason: 'no-facts', message: null };
  const result = await polishDm({ llm: getLlm(), config: cfg, facts, summary: template, maxChars: budget, shapeLabel, signal });
  if (!result.ok) {
    return { text: template, polished: false, reason: result.reason ?? 'unknown', message: result.message ?? null };
  }
  return { text: result.text, polished: true, reason: null, message: null, provider: result.provider, model: result.model };
}

/**
 * 邮件附件：只有显式开启 attach_report、且渠道里确实有 email 时才准备。
 * 附件就是这份 Markdown 报告本身，不含原始观看记录，也不含任何凭据。
 */
export function emailAttachment(facts, hypotheses = [], narrative = null, shape = null, { getConfig }) {
  const cfg = getConfig();
  const zone = cfg.schedule.timezone;
  if (!cfg.notify.channels.includes('email')) return null;
  if (cfg.notify.email.attach_report !== true) return null;
  if (!facts) return null;
  try {
    const content = renderMarkdown(facts, { hypotheses, narrative, shape, timeZone: zone });
    const stamp = formatLocal(Date.now(), zone).slice(0, 10);
    return { filename: 'bili-watch-' + stamp + '.md', content };
  } catch {
    return null;
  }
}
