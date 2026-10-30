/** B 站接口访问层：观看历史分页、帐号 uid 探测。所有网络调用可注入，便于离线测试。 */
import { realSleep } from '../core/util.js';

const HISTORY_URL = 'https://api.bilibili.com/x/web-interface/history/cursor';
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const RELATION_URL = 'https://api.bilibili.com/x/web-interface/archive/relation';
const FAV_FOLDERS_URL = 'https://api.bilibili.com/x/v3/fav/folder/created/list-all';
const FAV_RESOURCE_URL = 'https://api.bilibili.com/x/v3/fav/resource/list';

const DEFAULT_HEADERS = {
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*'
};

/** 接口错误：带 code，便于上层按错误码决定是否退避。 */
export class BiliApiError extends Error {
  constructor(message, { code, retryable = false, payload } = {}) {
    super(message);
    this.name = 'BiliApiError';
    this.code = code ?? null;
    this.retryable = retryable;
    this.payload = payload ?? null;
  }
}

/** 组装 Cookie 头：优先用整条 cookie，否则由 sessdata 拼。 */
export function buildCookieHeader(bili = {}) {
  const raw = typeof bili.cookie === 'string' ? bili.cookie.trim() : '';
  if (raw.length > 0) return raw;
  const sessdata = typeof bili.sessdata === 'string' ? bili.sessdata.trim() : '';
  return sessdata.length > 0 ? `SESSDATA=${sessdata}` : '';
}

/** 把一条历史记录归一化成统计用结构。 */
export function normalizeItem(raw) {
  const duration = Number(raw?.duration ?? 0);
  const progress = Number(raw?.progress ?? 0);
  // 历史接口把 bvid 与 business 放在 history 子对象里，顶层没有这两个字段。
  const nested = raw?.history && typeof raw.history === 'object' ? raw.history : {};
  let completion = null;
  if (duration > 0) {
    if (progress < 0) completion = 1;
    else completion = Math.min(1, Math.max(0, progress / duration));
  }
  return {
    ts: Number(raw?.view_at ?? 0),
    title: String(raw?.title ?? '').trim(),
    longTitle: String(raw?.long_title ?? '').trim(),
    author: String(raw?.author_name ?? '').trim(),
    authorMid: Number(raw?.author_mid ?? 0) || null,
    bvid: typeof raw?.bvid === 'string' && raw.bvid.length > 0 ? raw.bvid : typeof nested.bvid === 'string' && nested.bvid.length > 0 ? nested.bvid : null,
    business: String(raw?.business ?? nested.business ?? 'archive'),
    durationSec: duration > 0 ? duration : null,
    progressSec: progress < 0 ? duration : progress,
    completion,
    finished: progress < 0 || (duration > 0 && progress / duration >= 0.95)
  };
}

/** 单次请求：带超时与一次错误码重试策略。 */
async function requestJson(url, { cookie, fetchImpl, sleep, intervalMs, retries, signal }) {
  let attempt = 0;
  let lastError = null;
  while (attempt <= retries) {
    if (attempt > 0) await sleep(intervalMs * 2 ** attempt);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { ...DEFAULT_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
        signal
      });
    } catch (error) {
      lastError = new BiliApiError(`请求失败：${error?.message ?? error}`, { retryable: true });
      attempt += 1;
      continue;
    }
    if (response.status === 412 || response.status === 429) {
      lastError = new BiliApiError(`接口返回 HTTP ${response.status}（风控或限流）`, {
        code: response.status,
        retryable: true
      });
      attempt += 1;
      continue;
    }
    let body;
    try {
      body = await response.json();
    } catch (error) {
      lastError = new BiliApiError(`响应不是 JSON（HTTP ${response.status}）`, { retryable: false });
      break;
    }
    if (!response.ok) {
      lastError = new BiliApiError(`接口返回 HTTP ${response.status}`, { code: response.status, payload: body });
      break;
    }
    const code = Number(body?.code ?? -1);
    if (code === 0) return body.data ?? {};
    if (code === -352 || code === -412) {
      lastError = new BiliApiError(`接口风控（code ${code}）：${body?.message ?? ''}`, {
        code,
        retryable: true,
        payload: body
      });
      attempt += 1;
      continue;
    }
    const hint =
      code === -101
        ? 'Cookie 未登录或已过期，请重新导出 SESSDATA'
        : code === -400
          ? '请求参数被拒绝'
          : String(body?.message ?? '');
    lastError = new BiliApiError(`接口错误 code=${code}：${hint}`, { code, payload: body });
    break;
  }
  throw lastError ?? new BiliApiError('未知的接口失败');
}

/** 拉取指定窗口内的全部观看历史，返回按时间升序的归一化条目。 */
export async function fetchHistory(options) {
  const {
    cookie,
    windowFrom,
    windowTo = Date.now(),
    pageSize = 30,
    intervalMs = 400,
    maxPages = 40,
    fetchImpl = globalThis.fetch,
    sleep = realSleep,
    retries = 2,
    signal,
    onPage
  } = options;
  if (typeof fetchImpl !== 'function') throw new BiliApiError('当前环境没有可用的 fetch 实现');
  const items = [];
  const pages = [];
  let max = 0;
  let viewAt = 0;
  let business = '';
  for (let page = 0; page < maxPages; page += 1) {
    if (page > 0 && intervalMs > 0) await sleep(intervalMs);
    const url = new URL(HISTORY_URL);
    url.searchParams.set('ps', String(Math.min(30, Math.max(1, pageSize))));
    url.searchParams.set('max', String(max));
    url.searchParams.set('view_at', String(viewAt));
    url.searchParams.set('business', business);
    const data = await requestJson(url.toString(), { cookie, fetchImpl, sleep, intervalMs, retries, signal });
    const list = Array.isArray(data.list) ? data.list : [];
    const cursor = data.cursor ?? {};
    pages.push({ page, count: list.length, cursor });
    if (typeof onPage === 'function') onPage({ page, count: list.length, cursor });
    if (list.length === 0) break;
    let oldest = Infinity;
    for (const raw of list) {
      const item = normalizeItem(raw);
      if (item.ts <= 0) continue;
      oldest = Math.min(oldest, item.ts);
      if (item.ts * 1000 >= windowFrom && item.ts * 1000 < windowTo) items.push(item);
    }
    if (oldest * 1000 < windowFrom) break;
    const nextMax = Number(cursor.max ?? 0);
    const nextViewAt = Number(cursor.view_at ?? 0);
    const nextBusiness = String(cursor.business ?? '');
    if (nextMax === max && nextViewAt === viewAt && nextBusiness === business) break;
    max = nextMax;
    viewAt = nextViewAt;
    business = nextBusiness;
  }
  items.sort((a, b) => a.ts - b.ts);
  return { items, pages };
}

/** 单个视频与当前登录账号的关系：是否点赞、投了几枚币、是否收藏。 */
export async function fetchVideoRelation(bvid, options = {}) {
  const { cookie, fetchImpl = globalThis.fetch, sleep = realSleep, intervalMs = 400, retries = 1, signal } = options;
  const key = typeof bvid === 'string' ? bvid.trim() : '';
  if (key.length === 0) return { bvid: null, like: false, coin: 0, favorite: false };
  const url = new URL(RELATION_URL);
  url.searchParams.set('bvid', key);
  const data = await requestJson(url.toString(), { cookie, fetchImpl, sleep, intervalMs, retries, signal });
  return {
    bvid: key,
    like: data?.like === true,
    coin: Math.max(0, Number(data?.coin ?? 0) || 0),
    favorite: data?.favorite === true
  };
}

/** 收藏夹列表：只有元数据，没有创建时间，所以要知道"最近收藏了什么"还得逐夹翻分页。 */
export async function fetchFavFolders(mid, options = {}) {
  const { cookie, fetchImpl = globalThis.fetch, sleep = realSleep, intervalMs = 0, retries = 1, signal } = options;
  const url = new URL(FAV_FOLDERS_URL);
  url.searchParams.set('up_mid', String(mid));
  const data = await requestJson(url.toString(), { cookie, fetchImpl, sleep, intervalMs, retries, signal });
  const list = Array.isArray(data?.list) ? data.list : [];
  return list
    .map((folder) => ({
      id: Number(folder?.id ?? 0) || 0,
      title: String(folder?.title ?? '').trim(),
      count: Number(folder?.media_count ?? 0) || 0
    }))
    .filter((folder) => folder.id > 0);
}

/** 单个收藏夹的一页：按收藏时间倒序，fav_time 是收藏动作的时间戳。 */
export async function fetchFavPage(mediaId, page = 1, options = {}) {
  const { cookie, fetchImpl = globalThis.fetch, sleep = realSleep, intervalMs = 0, retries = 1, signal } = options;
  const url = new URL(FAV_RESOURCE_URL);
  url.searchParams.set('media_id', String(mediaId));
  url.searchParams.set('pn', String(Math.max(1, page)));
  url.searchParams.set('ps', '20');
  url.searchParams.set('platform', 'web');
  const data = await requestJson(url.toString(), { cookie, fetchImpl, sleep, intervalMs, retries, signal });
  const medias = Array.isArray(data?.medias) ? data.medias : [];
  const items = medias.map((media) => ({
    oid: Number(media?.id ?? 0) || null,
    bvid: typeof media?.bvid === 'string' && media.bvid.length > 0 ? media.bvid : null,
    title: String(media?.title ?? '').trim(),
    author: String(media?.upper?.name ?? '').trim(),
    favTime: Number(media?.fav_time ?? 0) || 0,
    // attr 的 bit3 表示条目已失效（视频被删/下架），统计时跳过
    invalid: (Number(media?.attr ?? 0) & 8) !== 0
  }));
  return { items, hasMore: data?.has_more === true };
}

/** 用 nav 接口探测当前 Cookie 对应的 uid。 */
export async function fetchNavUid({ cookie, fetchImpl = globalThis.fetch, sleep = realSleep, signal } = {}) {
  const data = await requestJson(NAV_URL, { cookie, fetchImpl, sleep, intervalMs: 0, retries: 1, signal });
  if (!data?.isLogin) throw new BiliApiError('Cookie 未登录，无法探测 uid', { code: -101 });
  const mid = Number(data.mid ?? 0);
  if (!mid) throw new BiliApiError('nav 接口没有返回 mid');
  return { mid, uname: String(data.uname ?? '') };
}
