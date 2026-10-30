/**
 * 互动采集用例：点赞 / 投币 / 收藏 / 直播观看。
 * 接口限制：点赞与投币接口不返回"动作时间"，只返回"当前状态"，所以按窗口内看过的视频逐条对照；
 * 收藏夹条目带 fav_time，直接翻分页就能拿到精确时间。任何一步失败都只降级这一类数据，不让整次统计失败。
 */
import { fetchFavFolders, fetchFavPage, fetchVideoRelation } from '../adapters/bili.js';
import { realSleep } from '../core/util.js';

/** 每个收藏夹最多翻几页：倒序分页，翻到窗口外就停。 */
const FAV_MAX_PAGES = 3;
/** 报告里给几个例子就够，不做全量列表。 */
const SAMPLE_TITLES = 5;

/**
 * 关系查询的候选顺序：先窗口内收藏的那些（很多人一边收藏一边点赞），再看完的，最后其余。
 * 不能按"最新 N 条"截断——互动往往落在窗口最老端，从新往旧截会把整段漏掉。
 */
function orderCandidates(items, favItems) {
  const seen = new Set();
  const out = [];
  const push = (bvid) => {
    const key = typeof bvid === 'string' ? bvid.trim() : '';
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };
  for (const entry of favItems) push(entry.bvid);
  for (const item of items) {
    if (Number(item.completion ?? 0) >= 0.95) push(item.bvid);
  }
  for (const item of items) push(item.bvid);
  return out;
}

function sampleOf(list) {
  return list.slice(0, SAMPLE_TITLES).map((item) => ({
    title: String(item.title ?? ''),
    bvid: item.bvid ?? null,
    author: String(item.author ?? '')
  }));
}

/** 空壳：没开或全失败时也保持字段形状一致，报告与卡片不用判空。 */
export function emptyInteractions(note = null) {
  return {
    enabled: false,
    likes: { count: 0, videos: [] },
    coins: { count: 0, total: 0, videos: [] },
    favorites: { count: 0, source: 'skipped', videos: [] },
    sampled: { relation: 0, errors: 0, folders: 0 },
    notes: note ? [note] : []
  };
}

/**
 * 采集窗口内的互动数据。
 * @param {Array<object>} items 窗口内观看历史（按时间升序）
 * @param {{from: number, to: number}} window 窗口边界（毫秒）
 * @param {{getConfig: Function, cookie: string, mid?: string|number, fetchImpl?: Function, sleep?: Function, signal?: AbortSignal}} deps
 */
export async function collectInteractions(items, window, deps = {}) {
  const { getConfig, cookie = '', mid = null, fetchImpl = globalThis.fetch, sleep = realSleep, signal } = deps;
  const cfg = getConfig();
  if (cfg?.bili?.interactions === false) {
    return emptyInteractions('配置里关掉了点赞 / 投币 / 收藏的采集');
  }
  if (!Array.isArray(items) || items.length === 0) return emptyInteractions('这次窗口里没有观看记录，互动数据没有可对照的样本');

  const intervalMs = Number(cfg?.bili?.request_interval_ms ?? 400) || 0;
  const maxRelation = Math.max(0, Number(cfg?.bili?.interaction_max ?? 60) || 0);
  const notes = [];
  const result = emptyInteractions();
  result.enabled = true;
  result.notes = notes;

  // 1) 收藏：有 fav_time，先按收藏夹精确算，再用视频关系兜底。
  const favSeen = new Set();
  const favItems = [];
  const readerMid = Number(mid ?? 0) || 0;
  if (readerMid > 0) {
    try {
      const folders = await fetchFavFolders(readerMid, { cookie, fetchImpl, sleep, intervalMs: 0, retries: 1, signal });
      result.sampled.folders = folders.length;
      for (const folder of folders) {
        for (let page = 1; page <= FAV_MAX_PAGES; page += 1) {
          if (intervalMs > 0) await sleep(intervalMs);
          let payload;
          try {
            payload = await fetchFavPage(folder.id, page, { cookie, fetchImpl, sleep, intervalMs: 0, retries: 1, signal });
          } catch (error) {
            result.sampled.errors += 1;
            break;
          }
          if (payload.items.length === 0) break;
          let oldest = Infinity;
          for (const entry of payload.items) {
            if (entry.favTime > 0) oldest = Math.min(oldest, entry.favTime);
            const at = entry.favTime * 1000;
            if (entry.invalid || at < window.from || at >= window.to) continue;
            const key = entry.bvid || 'oid:' + String(entry.oid ?? '');
            if (favSeen.has(key)) continue;
            favSeen.add(key);
            favItems.push(entry);
          }
          if (oldest * 1000 < window.from || !payload.hasMore) break;
        }
      }
      favItems.sort((a, b) => b.favTime - a.favTime);
      result.favorites = { count: favItems.length, source: 'folder', videos: sampleOf(favItems) };
    } catch (error) {
      notes.push('收藏夹接口没读成功：' + (error?.message ?? String(error)));
    }
  } else {
    notes.push('不知道账号 uid，收藏数改按看过的视频对照');
  }

  // 2) 点赞 / 投币：接口不返回动作时间，按窗口内看过的视频逐条问"现在还在吗"。
  const candidates = orderCandidates(items, favItems);
  const scope = maxRelation > 0 ? candidates.slice(0, maxRelation) : [];
  if (scope.length < candidates.length) {
    notes.push('点赞 / 投币只对照了 ' + scope.length + ' 条（窗口内共 ' + candidates.length + ' 条有 bvid）');
  }
  const liked = [];
  const coined = [];
  const favFromRelation = [];
  for (let index = 0; index < scope.length; index += 1) {
    if (index > 0 && intervalMs > 0) await sleep(intervalMs);
    let relation;
    try {
      relation = await fetchVideoRelation(scope[index], { cookie, fetchImpl, sleep, intervalMs: 0, retries: 1, signal });
    } catch (error) {
      result.sampled.errors += 1;
      continue;
    }
    result.sampled.relation += 1;
    const source = items.find((item) => item.bvid === scope[index]) ?? favItems.find((entry) => entry.bvid === scope[index]);
    const entry = { title: source?.title ?? '', bvid: scope[index], author: source?.author ?? '' };
    if (relation.like) liked.push(entry);
    if (relation.coin > 0) coined.push({ ...entry, coins: relation.coin });
    if (relation.favorite) favFromRelation.push(entry);
  }
  result.likes = { count: liked.length, videos: sampleOf(liked) };
  result.coins = {
    count: coined.length,
    total: coined.reduce((acc, item) => acc + item.coins, 0),
    videos: sampleOf(coined)
  };
  if (result.favorites.source !== 'folder') {
    result.favorites = { count: favFromRelation.length, source: 'relation', videos: sampleOf(favFromRelation) };
  }
  return result;
}
