/**
 * 配置的单一真相：默认值、取值范围与归一化都在这里。
 * 设置页白名单（core/store.js）与各工具读到的 cfg 都以本文件为准。
 */
import fs from 'node:fs';
import path from 'node:path';
import { expandHome, deepMerge } from '../core/util.js';
import { SCHEDULE_MODES, WINDOW_MODES } from '../domain/time.js';

/** 支持的推送渠道。 */
export const NOTIFY_CHANNELS = ['bili_dm', 'email'];

/** 模型写计划情况时不该出现的评价词。 */
export const TONE_WORDS = ['自律', '意志力', '懒惰', '放纵', '戒掉', '建议你', '应该少'];

const DEFAULT_CONFIG = {
  bili: { sessdata: '', bili_jct: '', cookie: '', page_size: 30, request_interval_ms: 400, max_pages: 40 },
  schedule: { enabled: true, mode: 'daily', window: 'calendar', cron: '', timezone: 'Asia/Shanghai', custom_from: '', custom_to: '' },
  report: { save_local: true, local_dir: '~/.dsh/bili-statistics/reports', format: 'markdown', evidence_limit: 20, polish: true },
  llm: { enabled: true, provider: '', model: '', report_prompt: '', dm_prompt: '', max_tokens: 2000, timeout_ms: 20000 },
  notify: {
    channels: ['bili_dm'],
    summary_max_chars: 200,
    bili_dm: { sender_sessdata: '', sender_bili_jct: '', sender_mid: '', receiver_mid: '' },
    email: {
      // 个人邮箱自发自收：host/port/secure 三者必须与邮箱服务商公告的端口配对
      host: '',
      port: 465,
      secure: true,
      user: '',
      pass: '',
      from: '',
      to: '',
      from_name: 'B站观看统计',
      subject_prefix: '[B站观看统计]',
      timeout_ms: 20000,
      retries: 1,
      backoff_ms: 2000,
      attach_report: false,
      allow_plain: false
    }
  },
  state_dir: '~/.dsh/bili-statistics'
};

export { DEFAULT_CONFIG };

export const DEFAULT_REPORT_DIR = DEFAULT_CONFIG.report.local_dir;

/** 报告目录归一：空值回落默认；盘符根不接受（避免直接往 C:\ 里写）。 */
export function normalizeReportDir(value) {
  const text = String(value ?? '').trim();
  if (text.length === 0) return DEFAULT_REPORT_DIR;
  try {
    const resolved = path.resolve(expandHome(text));
    if (path.parse(resolved).root === resolved) return DEFAULT_REPORT_DIR;
    return text;
  } catch {
    return DEFAULT_REPORT_DIR;
  }
}

/** 返回第一个存在的目录，用于处理 Documents/Desktop 被 OneDrive 接管的情况。 */
export function pickExistingDir(candidates) {
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {}
  }
  return null;
}

export function clampInt(value, lo, hi, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

export function normalizeConfig(raw) {
  const cfg = deepMerge(DEFAULT_CONFIG, raw ?? {});
  cfg.bili.page_size = clampInt(cfg.bili.page_size, 1, 30, 30);
  cfg.bili.request_interval_ms = clampInt(cfg.bili.request_interval_ms, 0, 10000, 400);
  cfg.bili.max_pages = clampInt(cfg.bili.max_pages, 1, 60, 40);
  cfg.report.evidence_limit = clampInt(cfg.report.evidence_limit, 2, 40, 20);
  if (!SCHEDULE_MODES.includes(cfg.schedule.mode)) cfg.schedule.mode = 'daily';
  if (!WINDOW_MODES.includes(cfg.schedule.window)) cfg.schedule.window = 'calendar';
  cfg.report.polish = cfg.report.polish !== false;
  cfg.llm.enabled = cfg.llm.enabled !== false;
  cfg.llm.provider = String(cfg.llm.provider ?? '').trim();
  cfg.llm.model = String(cfg.llm.model ?? '').trim();
  cfg.llm.max_tokens = clampInt(cfg.llm.max_tokens, 800, 8000, 2000);
  cfg.llm.timeout_ms = clampInt(cfg.llm.timeout_ms, 1000, 120000, 20000);
  cfg.notify.summary_max_chars = clampInt(cfg.notify.summary_max_chars, 60, 800, 200);
  cfg.notify.channels = Array.isArray(cfg.notify.channels)
    ? Array.from(
        new Set(
          cfg.notify.channels
            .map((channel) => String(channel ?? '').trim())
            .filter((channel) => NOTIFY_CHANNELS.includes(channel))
        )
      )
    : ['bili_dm'];
  const email = cfg.notify.email;
  email.host = String(email.host ?? '').trim();
  email.port = clampInt(email.port, 1, 65535, 465);
  email.secure = email.secure !== false;
  email.allow_plain = email.allow_plain === true;
  email.user = String(email.user ?? '').trim();
  email.pass = String(email.pass ?? '');
  email.from = String(email.from ?? '').trim();
  email.to = String(email.to ?? '').trim();
  email.from_name = String(email.from_name ?? '').trim();
  email.subject_prefix = String(email.subject_prefix ?? '').trim();
  email.timeout_ms = clampInt(email.timeout_ms, 1000, 120000, 20000);
  email.retries = clampInt(email.retries, 0, 5, 1);
  email.backoff_ms = clampInt(email.backoff_ms, 0, 60000, 2000);
  email.attach_report = email.attach_report === true;
  if (cfg.report.format !== 'markdown' && cfg.report.format !== 'html' && cfg.report.format !== 'both') {
    cfg.report.format = 'markdown';
  }
  cfg.report.local_dir = normalizeReportDir(cfg.report.local_dir);
  return cfg;
}
