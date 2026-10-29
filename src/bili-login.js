/** B 站扫码登录：生成二维码、轮询状态、验证 cookie 是否可用。仅用 Node 内置 fetch。 */
import { createHash } from 'node:crypto';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const QR_GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const QR_POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
// TV 端扫码通道：当网页端 poll 被风控拦截（HTTP 412 / code -412）时改走这条路。
const TV_AUTH_URL = 'https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code';
const TV_POLL_URL = 'https://passport.bilibili.com/x/passport-tv-login/qrcode/poll';
const TV_APPKEY = '4409e2ce8ffd12b8';
const TV_APPSEC = '59b43e04ad6965f34319062b478f83dd';
export const LOGIN_CHANNELS = ['web', 'tv'];

const DEFAULT_TIMEOUT_MS = 15000;

function defaultFetch() {
  if (typeof globalThis.fetch !== 'function') throw new Error('当前运行环境没有 fetch，无法访问 B 站接口');
  return globalThis.fetch;
}

async function fetchJson(url, { headers = {}, cookie = '', timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl, method = 'GET', body = null } = {}) {
  const doFetch = fetchImpl ?? defaultFetch();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await doFetch(url, {
      method,
      ...(body ? { body } : {}),
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.bilibili.com/',
        Accept: 'application/json, text/plain, */*',
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers
      },
      signal: controller ? controller.signal : undefined
    });
    if (!response || typeof response.text !== 'function') throw new Error('B 站接口返回了预料之外的响应');
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('B 站接口返回的不是 JSON（HTTP ' + (response.status ?? '?') + '）');
    }
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('访问 B 站接口超时');
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 生成登录二维码，返回 qrcode_key 与二维码内容 url。 */
export async function generateQr(options = {}) {
  const data = await fetchJson(QR_GENERATE_URL + '?source=main-fe-header', options);
  if (!data || data.code !== 0 || !data.data || typeof data.data.url !== 'string') {
    throw new Error('生成登录二维码失败：' + describeApiError(data));
  }
  return { qrcodeKey: String(data.data.qrcode_key), url: data.data.url };
}

/**
 * 轮询一次扫码状态。
 * @returns {{state:'waiting'|'scanned'|'confirmed'|'expired'|'error', message:string, sessdata?:string, biliJct?:string, mid?:string|null, credentialUrl?:string}}
 */
export async function pollQr({ qrcodeKey, ...options } = {}) {
  if (!qrcodeKey) throw new Error('缺少 qrcode_key');
  const url = QR_POLL_URL + '?qrcode_key=' + encodeURIComponent(qrcodeKey) + '&source=main-fe-header';
  const data = await fetchJson(url, options);
  if (!data || data.code !== 0 || !data.data) {
    return {
      state: 'error',
      message: '轮询扫码状态失败：' + describeApiError(data),
      apiCode: data && typeof data === 'object' && typeof data.code === 'number' ? data.code : null
    };
  }
  const code = data.data.code;
  if (code === 0) {
    const parsed = parseCredentialUrl(data.data.url);
    if (!parsed.sessdata) {
      return { state: 'error', message: '扫码成功但没有拿到 SESSDATA，请重试' };
    }
    return {
      state: 'confirmed',
      message: '扫码登录成功',
      credentialUrl: data.data.url,
      ...parsed
    };
  }
  if (code === 86101) return { state: 'waiting', message: '还没有扫码' };
  if (code === 86090) return { state: 'scanned', message: '已扫码，请在手机上点“确认登录”' };
  if (code === 86038) return { state: 'expired', message: '二维码已失效，请重新生成' };
  return { state: 'waiting', message: '未知状态码 ' + code };
}

/** TV 端扫码用的签名参数（params 按 key 排序拼接后接 appsec，再取 md5）。 */
function tvSignedBody(extra) {
  const params = { appkey: TV_APPKEY, local_id: '0', ts: String(Math.floor(Date.now() / 1000)), ...extra };
  const query = Object.keys(params)
    .sort()
    .map((key) => key + '=' + String(params[key]))
    .join('&');
  const sign = createHash('md5').update(query + TV_APPSEC).digest('hex');
  return new URLSearchParams({ ...params, sign });
}

function cookiesFromTv(data) {
  const list = data && data.cookie_info && Array.isArray(data.cookie_info.cookies) ? data.cookie_info.cookies : [];
  const map = {};
  for (const item of list) {
    if (item && typeof item.name === 'string') map[item.name] = item.value == null ? '' : String(item.value);
  }
  const mid = map.DedeUserID ?? '';
  return {
    sessdata: String(map.SESSDATA ?? '').trim(),
    biliJct: String(map.bili_jct ?? '').trim(),
    mid: mid.length > 0 ? mid : data && data.mid != null ? String(data.mid) : null
  };
}

/** 生成 TV 端扫码二维码：网页端 poll 被风控拦截时的备用通道。 */
export async function generateTvQr(options = {}) {
  const data = await fetchJson(TV_AUTH_URL, { ...options, method: 'POST', body: tvSignedBody({}) });
  if (!data || data.code !== 0 || !data.data || typeof data.data.url !== 'string' || typeof data.data.auth_code !== 'string') {
    throw new Error('生成 TV 扫码二维码失败：' + describeApiError(data));
  }
  return { qrcodeKey: String(data.data.auth_code), url: data.data.url };
}

/** 轮询一次 TV 端扫码状态，成功时从 cookie_info 取 SESSDATA / bili_jct / mid。 */
export async function pollTvQr({ qrcodeKey, ...options } = {}) {
  if (!qrcodeKey) throw new Error('缺少 auth_code');
  const data = await fetchJson(TV_POLL_URL, { ...options, method: 'POST', body: tvSignedBody({ auth_code: qrcodeKey }) });
  if (!data || typeof data !== 'object') {
    return { state: 'error', message: 'TV 扫码接口没有返回内容', apiCode: null };
  }
  if (data.code === 0 && data.data) {
    const parsed = cookiesFromTv(data.data);
    if (!parsed.sessdata) return { state: 'error', message: '扫码成功但没有拿到 SESSDATA，请重试', apiCode: 0 };
    return { state: 'confirmed', message: '扫码登录成功', ...parsed, apiCode: 0 };
  }
  if (data.code === 86039) return { state: 'waiting', message: '还没有扫码', apiCode: 86039 };
  if (data.code === 86090) return { state: 'scanned', message: '已扫码，请在手机上点“确认登录”', apiCode: 86090 };
  if (data.code === 86038) return { state: 'expired', message: '二维码已失效，请重新生成', apiCode: 86038 };
  return { state: 'error', message: '轮询扫码状态失败：' + describeApiError(data), apiCode: data.code ?? null };
}

/** 从登录成功返回的跳转 url 里解析凭据。 */
export function parseCredentialUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return {};
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {};
  }
  const sessdata = parsed.searchParams.get('SESSDATA') ?? '';
  const biliJct = parsed.searchParams.get('bili_jct') ?? '';
  const mid = parsed.searchParams.get('DedeUserID');
  return {
    sessdata: sessdata.trim(),
    biliJct: biliJct.trim(),
    mid: mid && mid.length > 0 ? mid : null
  };
}

/** 用 cookie 调 nav 接口，确认凭据可用并取昵称。失败返回 null（不影响已保存的凭据）。 */
export async function fetchNav({ cookie, ...options } = {}) {
  if (!cookie) return null;
  try {
    const data = await fetchJson(NAV_URL, { ...options, cookie });
    if (!data || data.code !== 0 || !data.data || !data.data.isLogin) return null;
    return {
      mid: data.data.mid == null ? null : String(data.data.mid),
      uname: typeof data.data.uname === 'string' ? data.data.uname : null
    };
  } catch {
    return null;
  }
}

export function buildCookie(sessdata, biliJct) {
  const parts = [];
  if (sessdata) parts.push('SESSDATA=' + sessdata);
  if (biliJct) parts.push('bili_jct=' + biliJct);
  return parts.join('; ');
}

function describeApiError(data) {
  if (!data || typeof data !== 'object') return '响应为空';
  const code = data.code ?? '?';
  const message = data.message || data.msg || '未知错误';
  return 'code ' + code + '（' + message + '）';
}