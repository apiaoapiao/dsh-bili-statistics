/**
 * 设置页写入的覆盖层：<state_dir>/settings.json。
 * 
 * 需要自己解析 YAML 并处理并发，风险高于收益；这里只覆盖少数"内容型"设置，
 * 生效方式是启动时深合并到 profile 配置之上，改动后调用方 reload 即可。
 */
import path from 'node:path';
import { expandHome, ensureDir, isPlainObject, deepMerge, readJsonSafe, writeJsonAtomic, clamp } from './util.js';
import { SCHEDULE_MODES, WINDOW_MODES, parseCron } from '../domain/time.js';
import { NOTIFY_CHANNELS } from '../config/defaults.js';

const TEXT_LIMIT = 4000;


const REPORT_FORMATS = ['markdown', 'html', 'both'];

export function settingsFile(dir) {
  return path.join(expandHome(dir), 'settings.json');
}

/** 读覆盖层；文件不存在或损坏时返回空对象。 */
export function loadOverrides(dir) {
  const value = readJsonSafe(settingsFile(dir), {});
  return isPlainObject(value) ? value : {};
}

/** 深合并写入覆盖层，返回保存后的内容。 */
export function saveOverrides(dir, patch) {
  const merged = deepMerge(loadOverrides(dir), isPlainObject(patch) ? patch : {});
  const file = settingsFile(dir);
  ensureDir(path.dirname(file));
  writeJsonAtomic(file, merged);
  return merged;
}

/** 清空覆盖层（回到 profile 配置）。 */
export function resetOverrides(dir) {
  writeJsonAtomic(settingsFile(dir), {});
  return {};
}

const asBool = (value) => value === true || value === 'true' || value === 1 || value === '1';
const asText = (value, limit = TEXT_LIMIT) => {
  const text = String(value ?? '').trim();
  return text.length > limit ? text.slice(0, limit) : text;
};
/** uid 只保留数字；空串表示“清空并回落到读历史账号”。 */
const asDigits = (value, limit) => String(value ?? '').replace(/\D/g, '').slice(0, limit);

const isDateOnly = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * 只允许设置页改这些字段：模型、提示词、开关、摘要长度、接收方 UID、定时规则。
 * 其它字段（cookie、发送方 uid、落盘目录）必须走 profile，避免设置页把凭据写坏。
 */
export function pickEditable(patch) {
  const input = isPlainObject(patch) ? patch : {};
  const out = {};
  const rejected = [];
  const put = (target, key, value) => {
    if (!isPlainObject(target[key])) target[key] = {};
    target[key] = value;
  };
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case 'llm': {
        const llm = isPlainObject(value) ? value : {};
        const next = {};
        if ('enabled' in llm) next.enabled = asBool(llm.enabled);
        if ('provider' in llm) next.provider = asText(llm.provider, 120);
        if ('model' in llm) next.model = asText(llm.model, 160);
        if ('report_prompt' in llm) next.report_prompt = asText(llm.report_prompt);
        if ('dm_prompt' in llm) next.dm_prompt = asText(llm.dm_prompt);
        if ('max_tokens' in llm) next.max_tokens = clamp(Math.round(Number(llm.max_tokens) || 2000), 800, 8000);
        if ('timeout_ms' in llm) next.timeout_ms = clamp(Math.round(Number(llm.timeout_ms) || 20000), 1000, 120000);
        if (Object.keys(next).length === 0) rejected.push('llm');
        else put(out, 'llm', next);
        break;
      }
      case 'report': {
        const report = isPlainObject(value) ? value : {};
        const next = {};
        if ('polish' in report) next.polish = asBool(report.polish);
        if ('save_local' in report) next.save_local = asBool(report.save_local);
        if ('format' in report) {
          const format = String(report.format ?? '').trim();
          if (REPORT_FORMATS.includes(format)) next.format = format;
          else rejected.push('report.format');
        }
        if ('local_dir' in report) {
          const dir = asText(report.local_dir, 800);
          const resolved = dir === '' ? '' : path.resolve(expandHome(dir));
          if (dir !== '' && path.parse(resolved).root === resolved) rejected.push('report.local_dir');
          else next.local_dir = dir;
        }
        if (Object.keys(next).length === 0) rejected.push('report');
        else put(out, 'report', next);
        break;
      }
      case 'notify': {
        const notify = isPlainObject(value) ? value : {};
        const next = {};
        if ('summary_max_chars' in notify) {
          next.summary_max_chars = clamp(Math.round(Number(notify.summary_max_chars) || 200), 60, 800);
        }
        if ('channels' in notify) {
          const list = Array.isArray(notify.channels) ? notify.channels.map((item) => String(item ?? '').trim()) : [];
          const unknown = list.filter((item) => !NOTIFY_CHANNELS.includes(item));
          if (unknown.length > 0) rejected.push('notify.channels.' + unknown.join('/'));
          next.channels = Array.from(new Set(list.filter((item) => NOTIFY_CHANNELS.includes(item))));
        }
        if ('bili_dm' in notify) {
          const dm = isPlainObject(notify.bili_dm) ? notify.bili_dm : {};
          const dmNext = {};
          if ('receiver_mid' in dm) dmNext.receiver_mid = asDigits(dm.receiver_mid, 20);
          if (Object.keys(dmNext).length > 0) next.bili_dm = dmNext;
        }
        if ('email' in notify) {
          const email = isPlainObject(notify.email) ? notify.email : {};
          const emailNext = {};
          if ('host' in email) emailNext.host = asText(email.host, 160);
          if ('port' in email) emailNext.port = clamp(Math.round(Number(email.port) || 465), 1, 65535);
          if ('secure' in email) emailNext.secure = asBool(email.secure);
          if ('allow_plain' in email) emailNext.allow_plain = asBool(email.allow_plain);
          if ('user' in email) emailNext.user = asText(email.user, 160);
          if ('pass' in email) emailNext.pass = asText(email.pass, 200);
          if ('from' in email) emailNext.from = asText(email.from, 160);
          if ('to' in email) emailNext.to = asText(email.to, 160);
          if ('from_name' in email) emailNext.from_name = asText(email.from_name, 60);
          if ('subject_prefix' in email) emailNext.subject_prefix = asText(email.subject_prefix, 40);
          if ('timeout_ms' in email) emailNext.timeout_ms = clamp(Math.round(Number(email.timeout_ms) || 20000), 1000, 120000);
          if ('retries' in email) emailNext.retries = clamp(Math.round(Number(email.retries) || 0), 0, 5);
          if ('backoff_ms' in email) emailNext.backoff_ms = clamp(Math.round(Number(email.backoff_ms) || 0), 0, 60000);
          if ('attach_report' in email) emailNext.attach_report = asBool(email.attach_report);
          if (Object.keys(emailNext).length > 0) next.email = emailNext;
          else rejected.push('notify.email');
        }
        if (Object.keys(next).length === 0) rejected.push('notify');
        else put(out, 'notify', next);
        break;
      }
      case 'schedule': {
        const schedule = isPlainObject(value) ? value : {};
        const next = {};
        if ('enabled' in schedule) next.enabled = asBool(schedule.enabled);
        if ('mode' in schedule) {
          const mode = String(schedule.mode ?? '').trim();
          if (SCHEDULE_MODES.includes(mode)) next.mode = mode;
          else rejected.push('schedule.mode');
        }
        if ('window' in schedule) {
          const windowMode = String(schedule.window ?? '').trim();
          if (WINDOW_MODES.includes(windowMode)) next.window = windowMode;
          else rejected.push('schedule.window');
        }
        if ('cron' in schedule) {
          const cron = asText(schedule.cron, 120);
          if (cron === '') {
            next.cron = '';
          } else {
            try {
              parseCron(cron);
              next.cron = cron;
            } catch {
              rejected.push('schedule.cron');
            }
          }
        }
        for (const key of ['custom_from', 'custom_to']) {
          if (!(key in schedule)) continue;
          const text = asText(schedule[key], 10);
          if (text === '' || isDateOnly(text)) next[key] = text;
          else rejected.push('schedule.' + key);
        }
        if (Object.keys(next).length === 0) {
          if (!rejected.some((entry) => entry.startsWith('schedule'))) rejected.push('schedule');
        } else {
          put(out, 'schedule', next);
        }
        break;
      }
      default:
        rejected.push(key);
    }
  }
  return { patch: out, rejected };
}
