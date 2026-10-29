/**
 * 扫码登录用例：生成二维码、轮询结果、落盘凭据。
 * 网页端被 B 站风控拦截（-412）时自动切到 TV 扫码通道。
 */
import { loadCreds, setRoleCreds, setPending, setChannel } from '../core/creds.js';
import { encodeQr, toDots, ECC } from '../core/qr.js';
import { generateQr, pollQr, generateTvQr, pollTvQr, fetchNav, buildCookie as buildLoginCookie } from '../adapters/bili-login.js';
import { clampInt } from '../config/defaults.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export async function startLogin(role, options = {}, { stateDir }) {
  const who = role === 'sender' ? 'sender' : 'reader';
  const saved = loadCreds(stateDir).channel;
  const channel = options.channel === 'tv' || options.channel === 'web' ? options.channel : saved === 'tv' ? 'tv' : 'web';
  const { qrcodeKey, url } = channel === 'tv' ? await generateTvQr() : await generateQr();
  const qr = encodeQr(url, { ecc: ECC.MEDIUM, minVersion: 1, maxVersion: 10 });
  const expiresIn = 180;
  setPending(stateDir, {
    qrcode_key: qrcodeKey,
    role: who,
    channel,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString()
  });
  setChannel(stateDir, channel);
  return { role: who, channel, qrcode_key: qrcodeKey, url, dots: toDots(qr), size: qr.size, expires_in_seconds: expiresIn };
}

export async function pollLogin({ qrcodeKey, waitSeconds = 15, signal } = {}, { stateDir }) {
  const creds = loadCreds(stateDir);
  const pending = creds.pending;
  const key = qrcodeKey && String(qrcodeKey).trim().length > 0 ? String(qrcodeKey).trim() : pending?.qrcode_key;
  if (!key) throw new Error('没有待完成的扫码登录：请先调用 bili_intent_login 生成二维码');
  const role = pending && pending.qrcode_key === key ? pending.role : 'reader';
  const channel =
    pending && pending.qrcode_key === key && pending.channel === 'tv' ? 'tv' : creds.channel === 'tv' ? 'tv' : 'web';
  const wait = clampInt(waitSeconds ?? 15, 0, 60, 15);
  const deadline = Date.now() + wait * 1000;
  const switchToTv = () => {
    setChannel(stateDir, 'tv');
    return {
      state: 'switch',
      role,
      channel: 'tv',
      qrcode_key: key,
      message: 'B 站拦截了网页端扫码请求（code -412），已切换到 TV 扫码通道'
    };
  };
  const isBanned = (result) =>
    channel === 'web' &&
    result &&
    (result.apiCode === -412 || (typeof result.message === 'string' && /-?412/.test(result.message)));
  const once = async () => {
    try {
      return channel === 'tv' ? await pollTvQr({ qrcodeKey: key }) : await pollQr({ qrcodeKey: key });
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      if (channel === 'web' && /412/.test(message)) return { state: 'banned', message, apiCode: 412 };
      return { state: 'error', message, apiCode: null };
    }
  };
  let last = await once();
  if (last.state === 'banned') return switchToTv();
  if (isBanned(last)) return switchToTv();
  while (last.state !== 'confirmed' && last.state !== 'expired' && last.state !== 'error' && Date.now() < deadline) {
    await sleep(2000);
    if (Date.now() > deadline) break;
    last = await once();
    if (last.state === 'banned') return switchToTv();
    if (isBanned(last)) return switchToTv();
  }
  if (last.state !== 'confirmed') {
    return { state: last.state, role, channel, qrcode_key: key, message: last.message };
  }
  const nav = await fetchNav({ cookie: buildLoginCookie(last.sessdata, last.biliJct) });
  const entry = {
    sessdata: last.sessdata,
    bili_jct: last.biliJct,
    mid: nav?.mid ?? last.mid ?? null,
    uname: nav?.uname ?? null
  };
  setRoleCreds(stateDir, role, entry);
  return {
    state: 'confirmed',
    role,
    channel,
    qrcode_key: key,
    mid: entry.mid,
    uname: entry.uname,
    usable: nav !== null,
    message: nav === null ? '凭据已保存，但 nav 接口未确认可用，稍后可用 bili_intent_status 复查' : '扫码登录成功'
  };
}
