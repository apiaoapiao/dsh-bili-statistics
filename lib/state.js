/** 本地状态：意图档案、历史 run、LLM 假设、反馈、通知去重。全部落在单个 JSON 文件里。 */
import path from 'node:path';
import { expandHome, readJsonSafe, writeJsonAtomic, clone } from './util.js';

const DEFAULT_STATE = {
  version: 1,
  intention: null,
  intention_history: [],
  runs: [],
  hypotheses: [],
  feedback: [],
  notify: { last_sent_at: null, last_channel: null, last_report_id: null },
  schedule_log: []
};

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
  return merged;
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

/** 设置（或替换）当前意图档案，旧档案进历史。 */
export function setIntention(state, text, { now = Date.now(), source = 'tool' } = {}) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length === 0) throw new Error('意图描述不能为空');
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

/** 追加 LLM（或规则）生成的行为假设。 */
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
