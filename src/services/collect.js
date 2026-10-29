/**
 * 采集用例：拉观看历史 → 计算统计事实 → 记账，返回最新的 run。
 * 宿主闭包（配置、凭据读取）由调用方传入，本文件不做 ctx 访问。
 */
import { fetchHistory } from '../adapters/bili.js';
import { computeFacts } from '../domain/facts.js';
import { resolveWindow } from '../domain/time.js';
import { pickEvidence } from '../core/present.js';
import { loadState, saveState, recordRun, makeId, daysSinceSet } from '../core/state.js';

export async function collectRun(options, { stateDir, getConfig, readerCredentials }) {
  const cfg = getConfig();
  const zone = cfg.schedule.timezone;
  const now = Date.now();
  const state = loadState(stateDir);
  const mode = options.mode ?? cfg.schedule.mode;
  const windowMode = options.window ?? cfg.schedule.window;
  const window = resolveWindow({
    mode,
    windowMode,
    now,
    timeZone: zone,
    customFrom: options.from ?? cfg.schedule.custom_from,
    customTo: options.to ?? cfg.schedule.custom_to,
    weeklyAnchorMs: now
  });
  const { cookie } = readerCredentials();
  if (cookie.length === 0) {
    throw new Error('还没有登录 B 站：请先调用 bili_intent_login 扫码登录（role=reader），或在插件配置的 bili.sessdata 里填入 cookie');
  }
  let fetched;
  try {
    fetched = await fetchHistory({
      cookie,
      windowFrom: window.from,
      windowTo: window.to,
      pageSize: cfg.bili.page_size,
      intervalMs: cfg.bili.request_interval_ms,
      maxPages: cfg.bili.max_pages,
      signal: options.signal
    });
  } catch (error) {
    throw new Error('拉取观看历史失败：' + (error?.message ?? String(error)));
  }
  const intention = state.intention
    ? {
        id: state.intention.id,
        text: state.intention.text,
        created_at: state.intention.created_at,
        days_since_set: daysSinceSet(state.intention, now)
      }
    : null;
  const facts = computeFacts({
    items: fetched.items,
    window: { from: window.from, to: window.to, mode, window_mode: windowMode, label: window.label },
    timeZone: zone,
    intention,
    runs: state.runs
  });
  const evidence = pickEvidence(fetched.items, cfg.report.evidence_limit, zone);
  const run = {
    id: makeId('run'),
    created_at: new Date(now).toISOString(),
    // manual：设置页「立即统计一次」或工具调用；schedule：定时触发。
    trigger: options.trigger === 'schedule' ? 'schedule' : 'manual',
    window: facts.window,
    total_items: facts.total_items,
    shape: facts.behavior_shape.shape,
    confidence: facts.behavior_shape.confidence,
    pages: fetched.pages.length,
    facts,
    evidence
  };
  recordRun(state, run);
  saveState(stateDir, state);
  return { run, facts, evidence, state };
}
