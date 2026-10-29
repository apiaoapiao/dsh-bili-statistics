/** 通用小工具：路径展开、数值统计、原子写文件、可注入的 sleep。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 把 `~/x` 展开为家目录下的绝对路径；其它输入原样返回。 */
export function expandHome(input) {
  if (typeof input !== 'string' || input.length === 0) return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return input;
}

/** 保证目录存在（递归）。 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 原子写 JSON：先写临时文件再 rename，避免读方读到半个文件。 */
export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 读 JSON；不存在或损坏时返回 fallback，并把损坏内容备份到 .broken。 */
export function readJsonSafe(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (text.trim().length === 0) return structuredClone(fallback);
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === 'ENOENT') return structuredClone(fallback);
    try {
      const broken = `${file}.broken-${Date.now()}`;
      fs.renameSync(file, broken);
    } catch {}
    return structuredClone(fallback);
  }
}

/** 写文本文件（覆盖）。 */
export function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** 是否为普通对象（排除 null / 数组）。 */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 递归合并纯对象；override 里的数组整体替换，不做逐项合并。 */
export function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(override)) return out;
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

/** 比率；分母为 0 时返回 null，避免用 0 假装"没有"。 */
export function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

/** 中位数；空数组返回 null。 */
export function median(values) {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 === 0 ? (list[mid - 1] + list[mid]) / 2 : list[mid];
}

/** 保留 n 位小数。 */
export const round = (value, digits = 3) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

/** 百分比文本。 */
export const pct = (value, digits = 0) => (Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '—');

/** 秒 → 人读时长。 */
export function humanDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** 可注入的 sleep，测试里替换成立即返回。 */
export const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 深拷贝一个纯 JSON 值。 */
export const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** 截断字符串，保留尾部省略号。 */
export function truncate(text, limit) {
  const source = String(text ?? '');
  if (source.length <= limit) return source;
  return `${source.slice(0, Math.max(0, limit - 1))}…`;
}
