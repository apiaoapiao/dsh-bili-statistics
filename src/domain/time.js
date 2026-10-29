/** 时区相关计算与极简 cron 求下一次触发时刻（支持 5 段：分 时 日 月 周）。 */

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** 用 Intl 取某时刻在指定时区的本地墙钟字段。 */
export function localParts(epochMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short'
  });
  const parts = formatter.formatToParts(new Date(epochMs));
  const pick = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour: Number(pick('hour')),
    minute: Number(pick('minute')),
    second: Number(pick('second')),
    weekday: WEEKDAY_INDEX[pick('weekday')] ?? 0
  };
}

/** 某时刻在该时区相对 UTC 的偏移毫秒数（东八区为 +8h）。 */
export function zoneOffsetMs(epochMs, timeZone) {
  const p = localParts(epochMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** 把时区里的墙钟时间换算成 epoch 毫秒；跨夏令时用两次迭代收敛。 */
export function localToEpoch({ year, month, day, hour, minute }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const first = guess - zoneOffsetMs(guess, timeZone);
  const second = guess - zoneOffsetMs(first, timeZone);
  return second;
}

/** "YYYY-MM-DD" → {year,month,day}。 */
export function parseDateOnly(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** 时区里今天的 00:00。 */
export function startOfLocalDay(epochMs, timeZone) {
  const p = localParts(epochMs, timeZone);
  return localToEpoch({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 }, timeZone);
}

/** 时区里 `days` 天前的 00:00（用于 daily/weekly 窗口）。 */
export function startOfLocalDayOffset(epochMs, timeZone, days) {
  const p = localParts(epochMs - days * 86400000, timeZone);
  return localToEpoch({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 }, timeZone);
}

/** ISO 周编号，用于报告 id。 */
export function isoWeek(epochMs, timeZone) {
  const p = localParts(epochMs, timeZone);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return { year: date.getUTCFullYear(), week };
}

/** 解析单段 cron 字段为允许值集合；越界或语法错误抛错。 */
export function parseCronField(field, min, max, label) {
  const allowed = new Set();
  for (const chunk of String(field).split(',')) {
    const piece = chunk.trim();
    if (piece.length === 0) throw new Error(`cron 字段 ${label} 出现空项`);
    const [rangePart, stepPart] = piece.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) throw new Error(`cron 字段 ${label} 的步长非法: ${piece}`);
    let lo;
    let hi;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number);
      lo = a;
      hi = b;
    } else {
      lo = Number(rangePart);
      hi = lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`cron 字段 ${label} 的取值非法: ${piece}（允许 ${min}-${max}）`);
    }
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return allowed;
}

/** 解析 5 段 cron。 */
export function parseCron(expression) {
  const fields = String(expression ?? '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron 需要 5 段（分 时 日 月 周），收到 ${fields.length} 段`);
  return {
    minutes: parseCronField(fields[0], 0, 59, 'minute'),
    hours: parseCronField(fields[1], 0, 23, 'hour'),
    days: parseCronField(fields[2], 1, 31, 'day-of-month'),
    months: parseCronField(fields[3], 1, 12, 'month'),
    weekdays: parseCronField(fields[4].replace(/^7$/, '0'), 0, 6, 'day-of-week'),
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*'
  };
}

/** 计算下一次触发时刻（epoch 毫秒），找不到返回 null。 */
export function nextCronFire(expression, fromMs, timeZone, horizonDays = 400) {
  const cron = typeof expression === 'string' ? parseCron(expression) : expression;
  const start = localParts(fromMs, timeZone);
  const base = localToEpoch({ year: start.year, month: start.month, day: start.day, hour: 0, minute: 0 }, timeZone);
  for (let dayOffset = 0; dayOffset <= horizonDays; dayOffset += 1) {
    const dayStart = base + dayOffset * 86400000;
    const p = localParts(dayStart + 3600000, timeZone);
    if (!cron.months.has(p.month)) continue;
    const domHit = cron.days.has(p.day);
    const dowHit = cron.weekdays.has(p.weekday);
    const dayHit = cron.domRestricted && cron.dowRestricted ? domHit || dowHit : domHit && dowHit;
    if (!dayHit) continue;
    for (const hour of [...cron.hours].sort((a, b) => a - b)) {
      for (const minute of [...cron.minutes].sort((a, b) => a - b)) {
        const epoch = localToEpoch({ year: p.year, month: p.month, day: p.day, hour, minute }, timeZone);
        if (epoch > fromMs) return epoch;
      }
    }
  }
  return null;
}

/** 支持的周期：每天、每周、每月（最长一个月）、自定义区间。 */
export const SCHEDULE_MODES = ['daily', 'weekly', 'monthly', 'custom'];

/** 窗口策略：calendar 按自然日/自然月切，rolling 从触发时刻往前推固定时长。 */
export const WINDOW_MODES = ['calendar', 'rolling'];

/** 每种周期的默认 cron：每天 22:00、每周一 08:00、每月 1 日 08:00。 */
export function defaultCronFor(mode) {
  if (mode === 'weekly') return '0 8 * * 1';
  if (mode === 'monthly') return '0 8 1 * *';
  return '0 22 * * *';
}

const dayStart = (parts, timeZone) =>
  localToEpoch({ year: parts.year, month: parts.month, day: parts.day, hour: 0, minute: 0 }, timeZone);

/**
 * 依据 mode、窗口策略与触发时刻算统计窗口 [from, to)；now 由调用方给出，方便测试。
 * daily 默认取「昨天」这一整天，rolling 则取触发时刻往前 24 小时——两者差在
 * 是否包含"今天已经看了的部分"，前者适合每天固定时刻复盘，后者适合滚动观察。
 */
export function resolveWindow({ mode, windowMode, now, timeZone, customFrom, customTo, weeklyAnchorMs }) {
  const rolling = windowMode === 'rolling';
  if (mode === 'custom') {
    const fromDate = parseDateOnly(customFrom);
    if (!fromDate) throw new Error(`custom 窗口缺少合法的 custom_from（YYYY-MM-DD）`);
    const from = localToEpoch({ ...fromDate, hour: 0, minute: 0 }, timeZone);
    let end = now;
    if (customTo) {
      const endDate = parseDateOnly(customTo);
      if (!endDate) throw new Error('custom_to 必须是 YYYY-MM-DD');
      end = localToEpoch({ ...endDate, hour: 0, minute: 0 }, timeZone) + 86400000;
    }
    return { from, to: end, label: `${customFrom} → ${customTo ?? 'now'}` };
  }
  if (mode === 'weekly') {
    if (rolling) return { from: now - 7 * 86400000, to: now, label: '最近 7×24 小时' };
    const anchor = Number.isFinite(weeklyAnchorMs) ? weeklyAnchorMs : now;
    const anchorStart = dayStart(localParts(anchor, timeZone), timeZone);
    return { from: anchorStart - 7 * 86400000, to: anchorStart, label: '过去 7 个自然日' };
  }
  if (mode === 'monthly') {
    if (rolling) return { from: now - 30 * 86400000, to: now, label: '最近 30 天' };
    const today = localParts(now, timeZone);
    const thisMonth = localToEpoch({ year: today.year, month: today.month, day: 1, hour: 0, minute: 0 }, timeZone);
    const prev = today.month === 1 ? { year: today.year - 1, month: 12 } : { year: today.year, month: today.month - 1 };
    const from = localToEpoch({ year: prev.year, month: prev.month, day: 1, hour: 0, minute: 0 }, timeZone);
    return { from, to: thisMonth, label: '上一个自然月' };
  }
  if (rolling) return { from: now - 86400000, to: now, label: '最近 24 小时' };
  const today = localParts(now, timeZone);
  const todayStart = dayStart(today, timeZone);
  const startDay = localParts(todayStart - 86400000 + 3600000, timeZone);
  return { from: dayStart(startDay, timeZone), to: todayStart, label: '昨天（自然日）' };
}

/** 时区里格式化为 "YYYY-MM-DD HH:mm"。 */
export function formatLocal(epochMs, timeZone) {
  const p = localParts(epochMs, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** 时区里格式化为 "MM-DD HH:mm"。 */
export function formatLocalShort(epochMs, timeZone) {
  const p = localParts(epochMs, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}
