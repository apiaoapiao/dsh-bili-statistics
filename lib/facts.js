/** 纯函数统计层：把观看历史条目压成可核验的 StatisticalFacts。不访问网络、不读文件。 */
import { median, ratio, round } from './util.js';
import { localParts } from './time.js';

export const PASSIVE_COMPLETION = 0.25;
export const ACTIVE_COMPLETION = 0.85;
const CHAIN_GAP_MS = 30 * 60 * 1000;
const LATE_HOURS = new Set([22, 23, 0, 1, 2, 3]);

/** 按条目推断"主动/被动"。接口不返回来源，因此这里产出的是推断而不是事实。 */
export function inferOrigin(items) {
  const active = [];
  const passive = [];
  const uncertain = [];
  for (const item of items) {
    if (item.completion === null) uncertain.push(item);
    else if (item.completion >= ACTIVE_COMPLETION) active.push(item);
    else if (item.completion <= PASSIVE_COMPLETION) passive.push(item);
    else uncertain.push(item);
  }
  return {
    active,
    passive,
    uncertain,
    facts: {
      active_high_confidence: active.length,
      passive_high_confidence: passive.length,
      uncertain: uncertain.length,
      basis: [
        `完成度 ≥ ${Math.round(ACTIVE_COMPLETION * 100)}% 视作主动观看的高置信候选`,
        `完成度 ≤ ${Math.round(PASSIVE_COMPLETION * 100)}% 视作被动观看的高置信候选`,
        '来源（搜索 / 推荐 / 关注动态）不在该接口返回中，以上仅为行为推断'
      ]
    }
  };
}

/** 连续被动观看链：时间相邻、间隔 < 30 分钟、完成度低，长度 ≥ 3 才记录。 */
export function computeChains(items, timeZone) {
  const passiveKeys = new Set(items.filter((item) => item.completion !== null && item.completion <= PASSIVE_COMPLETION).map((item) => item.ts));
  const chains = [];
  let current = [];
  const flush = () => {
    if (current.length >= 3) {
      chains.push({
        start_index: current[0].index,
        length: current.length,
        hour: localParts(current[0].ts * 1000, timeZone).hour
      });
    }
    current = [];
  };
  items.forEach((item, index) => {
    const prev = current.length > 0 ? current[current.length - 1] : null;
    const gapOk = prev === null || (item.ts - prev.ts) * 1000 <= CHAIN_GAP_MS;
    if (passiveKeys.has(item.ts) && gapOk) current.push({ ...item, index });
    else {
      flush();
      if (passiveKeys.has(item.ts)) current.push({ ...item, index });
    }
  });
  flush();
  chains.sort((a, b) => b.length - a.length);
  return { max_consecutive: chains.length > 0 ? chains[0].length : 0, chains: chains.slice(0, 5) };
}

/** 重复度：同一作者反复出现、同一标题反复出现、同作者最长连续段。 */
export function computeRepetition(items) {
  const byAuthor = new Map();
  const byTitle = new Map();
  for (const item of items) {
    if (item.author) byAuthor.set(item.author, (byAuthor.get(item.author) ?? 0) + 1);
    if (item.title) byTitle.set(item.title, (byTitle.get(item.title) ?? 0) + 1);
  }
  const topAuthors = [...byAuthor.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([author, count]) => ({ author, count, share: round(ratio(count, items.length), 3) }));
  const repeatedTitles = [...byTitle.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([title, times]) => ({ title, times }));
  let maxRun = 0;
  let run = 1;
  for (let i = 1; i < items.length; i += 1) {
    if (items[i].author && items[i].author === items[i - 1].author) {
      run += 1;
      if (run > maxRun) maxRun = run;
    } else {
      run = 1;
    }
  }
  return { top_authors: topAuthors, repeated_titles: repeatedTitles, max_same_author_run: maxRun };
}

/** 完成度分布：只统计 completion 可计算的条目。 */
export function computeCompletion(items) {
  const known = items.filter((item) => item.completion !== null);
  const rates = known.map((item) => item.completion);
  const sum = rates.reduce((acc, v) => acc + v, 0);
  return {
    sample_size: known.length,
    mean_completion_rate: rates.length > 0 ? round(sum / rates.length, 3) : null,
    median_completion_rate: round(median(rates), 3),
    low_progress_items: known.filter((item) => item.completion <= PASSIVE_COMPLETION).length,
    distribution: {
      finished: known.filter((item) => item.finished).length,
      half: known.filter((item) => item.completion >= 0.5 && !item.finished).length,
      quarter: known.filter((item) => item.completion > PASSIVE_COMPLETION && item.completion < 0.5).length,
      skipped: known.filter((item) => item.completion <= PASSIVE_COMPLETION).length
    }
  };
}

/** 时段分布：本地小时直方图 + 22 点后（含 0–3 点）占比。 */
export function computeTimeDistribution(items, timeZone) {
  const hourly = new Array(24).fill(0);
  let late = 0;
  let passiveLate = 0;
  for (const item of items) {
    const { hour } = localParts(item.ts * 1000, timeZone);
    hourly[hour] += 1;
    if (LATE_HOURS.has(hour)) {
      late += 1;
      if (item.completion !== null && item.completion <= PASSIVE_COMPLETION) passiveLate += 1;
    }
  }
  return {
    hourly,
    busiest_hours: hourly
      .map((count, hour) => ({ hour, count }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.count - a.count || a.hour - b.hour)
      .slice(0, 3),
    late_night_count: late,
    after_22_share: round(ratio(late, items.length), 3),
    passive_share_after_22: round(ratio(passiveLate, late), 3)
  };
}

/** 行为形态：用可观测的量投票得出一个带置信度的标签，而不是假装知道"意图"。 */
export function classifyShape({ total, repetition, completion, time, chains, origin }) {
  const candidates = [];
  const lateShare = time.after_22_share ?? 0;
  const meanCompletion = completion.mean_completion_rate ?? 0;
  const passiveShare = ratio(origin.passive_high_confidence, total) ?? 0;
  const signals = [];

  if (repetition.max_same_author_run >= 5 || repetition.repeated_titles.length >= 3) {
    const weight = repetition.max_same_author_run >= 8 ? 0.72 : 0.6;
    candidates.push({ shape: 'comfort_repetition', weight });
    signals.push(`同一作者最长连续 ${repetition.max_same_author_run} 条，重复标题 ${repetition.repeated_titles.length} 个`);
  }
  if (lateShare >= 0.4) {
    candidates.push({ shape: 'late_night_surf', weight: lateShare >= 0.6 ? 0.7 : 0.55 });
    signals.push(`22 点后条目占比 ${Math.round(lateShare * 100)}%`);
  }
  if (total >= 4 && meanCompletion >= 0.75) {
    candidates.push({ shape: 'focused_longform', weight: meanCompletion >= 0.9 ? 0.75 : 0.6 });
    signals.push(`平均完成度 ${Math.round(meanCompletion * 100)}%`);
  }
  if (total >= 8 && passiveShare >= 0.4 && meanCompletion < 0.45) {
    candidates.push({ shape: 'fragmented_binge', weight: chains.max_consecutive >= 5 ? 0.68 : 0.58 });
    signals.push(`被动候选占比 ${Math.round(passiveShare * 100)}%，最长连续链 ${chains.max_consecutive} 条`);
  }

  if (candidates.length === 0) {
    return { shape: 'mixed', confidence: total >= 5 ? 0.35 : 0.2, signals: ['没有出现足够集中的单一形态'], alternatives: [] };
  }
  candidates.sort((a, b) => b.weight - a.weight);
  const top = candidates[0];
  const second = candidates[1];
  const margin = second === undefined ? 0.1 : Math.max(0, Math.min(0.15, top.weight - second.weight));
  return {
    shape: top.shape,
    confidence: round(Math.min(0.9, top.weight + margin * 0.5), 2),
    signals,
    alternatives: candidates.slice(1, 3).map((c) => ({ shape: c.shape, weight: c.weight }))
  };
}

/** 与历史 run 的中位数比较，样本不足时明确说明拿不到基线。 */
export function computeBaseline(runs, currentTotal) {
  const totals = runs
    .map((run) => run?.total_items)
    .filter((v) => Number.isFinite(v))
    .slice(-14);
  const mean = totals.length > 0 ? totals.reduce((a, b) => a + b, 0) / totals.length : null;
  return {
    lookback_runs: totals.length,
    mean_items: mean === null ? null : round(mean, 2),
    median_items: round(median(totals), 2),
    delta_ratio: mean !== null && mean > 0 ? round((currentTotal - mean) / mean, 3) : null,
    note: totals.length < 3 ? '历史样本不足 3 次，暂不给出相对基线的偏离' : null
  };
}

/** 汇总入口：items 必须已按 ts 升序。 */
export function computeFacts({ items, window, timeZone, intention = null, runs = [] }) {
  const total = items.length;
  const origin = inferOrigin(items);
  const chains = computeChains(items, timeZone);
  const repetition = computeRepetition(items);
  const completion = computeCompletion(items);
  const time = computeTimeDistribution(items, timeZone);
  const shape = classifyShape({ total, repetition, completion, time, chains, origin: origin.facts });
  const days = new Set(items.map((item) => localParts(item.ts * 1000, timeZone).day)).size;
  const durations = items.map((item) => item.durationSec).filter((v) => Number.isFinite(v) && v > 0);
  return {
    window: { from: window.from, to: window.to, mode: window.mode, label: window.label, timezone: timeZone },
    total_items: total,
    active_days: days,
    origin_inferred: origin.facts,
    behavior_shape: shape,
    repetition,
    completion_on_active: completion,
    time_distribution: time,
    passive_chain: chains,
    duration: { total_sec: durations.reduce((acc, v) => acc + v, 0), median_sec: round(median(durations), 0) },
    baseline: computeBaseline(runs, total),
    intent_anchor: intention
      ? {
          profile_id: intention.id,
          text: intention.text,
          created_at: intention.created_at,
          days_since_set: intention.days_since_set ?? null
        }
      : null,
    caveats: [
      '接口不返回来源，origin_inferred 与 behavior_shape 是行为推断，不是事实',
      '完成度依赖条目自带的 duration/progress，缺失时样本会变小'
    ]
  };
}
