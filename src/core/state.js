/** 本地状态：计划、历史 run、计划情况条目、反馈与通知记录。全部落在单个 JSON 文件里。 */
import path from 'node:path';
import { expandHome, readJsonSafe, writeJsonAtomic, clone } from './util.js';

const DEFAULT_STATE = {
  version: 2,
  intention: null,
  intention_history: [],
  runs: [],
  hypotheses: [],
  feedback: [],
  notify: { last_sent_at: null, last_channel: null, last_report_id: null },
  schedule_log: []
};

/** 当前状态文件版本。加字段不需要升版本（loadState 会逐字段兜底）；改字段语义或类型才升。 */
const CURRENT_VERSION = 2;

/**
 * 版本迁移链：键是「从哪个版本升上来」，函数把旧状态就地补齐到下一版。
 * 加新版本时 CURRENT_VERSION 加一，并在这里补一条 MIGRATIONS[旧版本]。
 * 迁移只做幂等的字段补齐，不删字段——旧版本遗留的字段留着不影响读取。
 */
const MIGRATIONS = {
  // v1 → v2：给每条 run 补 generated（模型写的观看状态名、概览与计划情况）与 trigger（manual / schedule）。
  1: (state) => {
    for (const run of Array.isArray(state.runs) ? state.runs : []) {
      if (!run || typeof run !== 'object') continue;
      if (run.generated === undefined) run.generated = null;
      if (run.trigger !== 'schedule' && run.trigger !== 'manual') run.trigger = 'manual';
    }
  }
};

/** 按版本号逐级迁移；比当前代码新的状态原样返回，不降级改写（避免旧代码吃掉新字段）。 */
export function migrateState(state) {
  let version = Number.isInteger(state.version) && state.version > 0 ? state.version : 1;
  if (version > CURRENT_VERSION) return state;
  while (version < CURRENT_VERSION) {
    const step = MIGRATIONS[version];
    if (typeof step !== 'function') {
      version = CURRENT_VERSION;
      break;
    }
    step(state);
    version += 1;
  }
  state.version = CURRENT_VERSION;
  return state;
}

export function stateFile(dir) {
  return path.join(expandHome(dir), 'state.json');
}

/** 读状态：缺失或损坏时返回空骨架，不会抛错。 */
export function loadState(dir) {
  const raw = readJsonSafe(stateFile(dir), DEFAULT_STATE);
  const merged = { ...clone(DEFAULT_STATE), ...raw };
  if (!Array.isArray(merged.runs)) merged.runs = [];
  if (!Array.isArray(merged.intention_history)) merged.intention_history = [];
  if (!Array.isArray(merged.hypotheses)) merged.hypotheses = [];
  if (!Array.isArray(merged.feedback)) merged.feedback = [];
  if (!merged.notify || typeof merged.notify !== 'object') merged.notify = clone(DEFAULT_STATE.notify);
  if (!Array.isArray(merged.schedule_log)) merged.schedule_log = [];
  return migrateState(merged);
}

export function saveState(dir, state) {
  writeJsonAtomic(stateFile(dir), state);
  return state;
}

/** 生成短 id，前缀便于人读。 */
export function makeId(prefix) {
  const stamp = new Date().toISOString().replace(/[:.T-]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${stamp}-${rand}`;
}

/** 设置（或替换）当前计划，旧计划进历史。 */
export function setIntention(state, text, { now = Date.now(), source = 'tool' } = {}) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length === 0) throw new Error('计划不能为空');
  if (state.intention) {
    state.intention_history.unshift({ ...state.intention, retired_at: new Date(now).toISOString() });
  }
  state.intention = {
    id: makeId('intent'),
    text: trimmed,
    created_at: new Date(now).toISOString(),
    source
  };
  state.intention_history = state.intention_history.slice(0, 50);
  return state.intention;
}

export function daysSinceSet(intention, now = Date.now()) {
  if (!intention?.created_at) return null;
  const then = Date.parse(intention.created_at);
  if (!Number.isFinite(then)) return null;
  return Math.floor((now - then) / 86400000);
}

/** 记录一次统计 run，只保留最近 60 条。 */
export function recordRun(state, run) {
  state.runs.unshift(run);
  state.runs = state.runs.slice(0, 60);
  return run;
}

/** 追加 LLM（或规则）生成的计划情况条目。 */
export function recordHypotheses(state, runId, hypotheses, { now = Date.now(), source = 'llm' } = {}) {
  const saved = hypotheses.map((item) => ({
    id: makeId('hyp'),
    run_id: runId,
    text: String(item.text ?? '').trim(),
    evidence: Array.isArray(item.evidence) ? item.evidence : [],
    clue: typeof item.clue === 'string' ? item.clue : null,
    certainty: item.certainty === 'fact' ? 'fact' : 'inference',
    source,
    created_at: new Date(now).toISOString()
  }));
  state.hypotheses.unshift(...saved);
  state.hypotheses = state.hypotheses.slice(0, 200);
  return saved;
}

/** 记录用户对报告的反馈。 */
export function recordFeedback(state, { runId, verdict, note = null }, { now = Date.now() } = {}) {
  const allowed = new Set(['accurate', 'inexact', 'incomplete', 'useless']);
  if (!allowed.has(verdict)) throw new Error(`未知的反馈类型: ${verdict}`);
  const entry = {
    id: makeId('fb'),
    run_id: runId ?? null,
    verdict,
    note: note ? String(note).slice(0, 500) : null,
    created_at: new Date(now).toISOString()
  };
  state.feedback.unshift(entry);
  state.feedback = state.feedback.slice(0, 200);
  return entry;
}

export function markNotified(state, { now = Date.now(), channel, reportId }) {
  state.notify = {
    last_sent_at: new Date(now).toISOString(),
    last_channel: channel ?? null,
    last_report_id: reportId ?? null
  };
  return state.notify;
}

/**
 * 记录一次定时触发的结果：ran（跑了）/ skipped（跳过）/ error（失败）。
 * 只留最近 20 条，用来回答“到点了为什么什么都没发生”。
 */
export function recordScheduleEvent(state, { now = Date.now(), result, reason = null, run_id = null, notified = false } = {}, { max = 20 } = {}) {
  const allowed = new Set(['ran', 'skipped', 'error']);
  const entry = {
    at: new Date(now).toISOString(),
    result: allowed.has(result) ? result : 'error',
    reason: reason === null || reason === undefined ? null : String(reason).slice(0, 300),
    run_id: run_id ?? null,
    notified: notified === true
  };
  const previous = Array.isArray(state.schedule_log) ? state.schedule_log : [];
  state.schedule_log = [entry, ...previous].slice(0, max);
  return entry;
}

/** 最近一次 run 的 id，供反馈工具默认使用。 */
export function latestRunId(state) {
  return state.runs[0]?.id ?? null;
}
