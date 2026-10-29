/** 扫码登录得到的凭据：按角色分槽存放，落在 state_dir/credentials.json。 */
import path from 'node:path';
import { expandHome, readJsonSafe, writeJsonAtomic } from './util.js';

export const ROLES = ['reader', 'sender'];

const EMPTY = { version: 1, reader: null, sender: null, pending: null, channel: 'web' };

function normalizeChannel(value) {
  return value === 'tv' ? 'tv' : 'web';
}

export function credsFile(dir) {
  return path.join(expandHome(dir), 'credentials.json');
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sessdata = typeof raw.sessdata === 'string' ? raw.sessdata.trim() : '';
  if (sessdata.length === 0) return null;
  const biliJct = typeof raw.bili_jct === 'string' ? raw.bili_jct.trim() : typeof raw.biliJct === 'string' ? raw.biliJct.trim() : '';
  return {
    sessdata,
    bili_jct: biliJct,
    mid: raw.mid == null || raw.mid === '' ? null : String(raw.mid),
    uname: typeof raw.uname === 'string' && raw.uname.length > 0 ? raw.uname : null,
    saved_at: typeof raw.saved_at === 'string' ? raw.saved_at : null,
    source: raw.source === 'qr' ? 'qr' : 'manual'
  };
}

/** 读凭据：缺失或损坏时返回空槽，不抛错。 */
export function loadCreds(dir) {
  const raw = readJsonSafe(credsFile(dir), EMPTY);
  return {
    version: 1,
    reader: normalizeEntry(raw?.reader),
    sender: normalizeEntry(raw?.sender),
    pending: raw?.pending && typeof raw.pending === 'object' && typeof raw.pending.qrcode_key === 'string' ? raw.pending : null,
    channel: normalizeChannel(raw?.channel)
  };
}

export function saveCreds(dir, creds) {
  const next = {
    version: 1,
    reader: creds.reader ?? null,
    sender: creds.sender ?? null,
    pending: creds.pending ?? null,
    channel: normalizeChannel(creds.channel)
  };
  writeJsonAtomic(credsFile(dir), next);
  return next;
}

/** 写入某个角色的凭据，同时清掉待完成的登录。 */
export function setRoleCreds(dir, role, entry) {
  if (!ROLES.includes(role)) throw new Error('未知的登录角色：' + role);
  const creds = loadCreds(dir);
  creds[role] = { ...entry, saved_at: entry.saved_at ?? new Date().toISOString(), source: 'qr' };
  creds.pending = null;
  return saveCreds(dir, creds);
}

export function setPending(dir, pending) {
  const creds = loadCreds(dir);
  creds.pending = pending;
  return saveCreds(dir, creds);
}

export function clearPending(dir) {
  const creds = loadCreds(dir);
  if (!creds.pending) return creds;
  creds.pending = null;
  return saveCreds(dir, creds);
}

/** 记住上次可用的扫码通道（网页端被风控拦截后会自动切到 tv）。 */
export function setChannel(dir, channel) {
  const creds = loadCreds(dir);
  const next = normalizeChannel(channel);
  if (creds.channel === next) return creds;
  creds.channel = next;
  return saveCreds(dir, creds);
}

/** 由凭据拼出请求头里的 Cookie。 */
export function cookieFrom(entry) {
  if (!entry || !entry.sessdata) return '';
  const parts = ['SESSDATA=' + entry.sessdata];
  if (entry.bili_jct) parts.push('bili_jct=' + entry.bili_jct);
  return parts.join('; ');
}

/** 给状态面板用的摘要。 */
export function describeLogin(entry) {
  if (!entry) return null;
  return {
    mid: entry.mid,
    uname: entry.uname,
    saved_at: entry.saved_at,
    login_source: entry.source
  };
}