/**
 * 窗口计算：天/周/月 × 自然日历 / 滚动，边界必须钉死，
 * 否则"昨天的数字"会因为多算或少算几小时而在夜里漂移。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWindow, defaultCronFor, formatLocal, SCHEDULE_MODES, WINDOW_MODES } from '../lib/time.js';

const ZONE = 'Asia/Shanghai';
const at = (iso) => Date.parse(iso);
const labels = (window) => [formatLocal(window.from, ZONE), formatLocal(window.to, ZONE), window.label];

test('每天：默认取昨天整天，滚动取触发时刻往前 24 小时', () => {
  const now = at('2026-03-15T22:00:00+08:00');
  const calendar = resolveWindow({ mode: 'daily', windowMode: 'calendar', now, timeZone: ZONE });
  assert.deepEqual(labels(calendar), ['2026-03-14 00:00', '2026-03-15 00:00', '昨天（自然日）']);

  const rolling = resolveWindow({ mode: 'daily', windowMode: 'rolling', now, timeZone: ZONE });
  assert.equal(rolling.to, now);
  assert.equal(rolling.from, now - 24 * 3600 * 1000);
  assert.equal(rolling.label, '最近 24 小时');
});

test('每周：自然日 7 天，滚动 7×24 小时', () => {
  const now = at('2026-03-15T22:00:00+08:00');
  const calendar = resolveWindow({ mode: 'weekly', windowMode: 'calendar', now, timeZone: ZONE });
  assert.deepEqual(labels(calendar), ['2026-03-08 00:00', '2026-03-15 00:00', '过去 7 个自然日']);

  const rolling = resolveWindow({ mode: 'weekly', windowMode: 'rolling', now, timeZone: ZONE });
  assert.equal(rolling.from, now - 7 * 24 * 3600 * 1000);
  assert.equal(rolling.to, now);
});

test('每月：自然月口径含跨年，滚动不超过一个月', () => {
  const march = at('2026-03-15T22:00:00+08:00');
  const calendar = resolveWindow({ mode: 'monthly', windowMode: 'calendar', now: march, timeZone: ZONE });
  assert.deepEqual(labels(calendar), ['2026-02-01 00:00', '2026-03-01 00:00', '上一个自然月']);

  const january = at('2026-01-05T09:00:00+08:00');
  const crossYear = resolveWindow({ mode: 'monthly', windowMode: 'calendar', now: january, timeZone: ZONE });
  assert.deepEqual(labels(crossYear).slice(0, 2), ['2025-12-01 00:00', '2026-01-01 00:00']);

  const rolling = resolveWindow({ mode: 'monthly', windowMode: 'rolling', now: march, timeZone: ZONE });
  assert.equal(rolling.from, march - 30 * 24 * 3600 * 1000);
  assert.equal(rolling.to, march);
  assert.equal(rolling.label, '最近 30 天');
});

test('自定义区间优先于窗口策略，且结束日期含当天', () => {
  const now = at('2026-03-15T22:00:00+08:00');
  const window = resolveWindow({ mode: 'custom', windowMode: 'rolling', now, timeZone: ZONE, customFrom: '2026-03-01', customTo: '2026-03-03' });
  assert.deepEqual(labels(window).slice(0, 2), ['2026-03-01 00:00', '2026-03-04 00:00']);
  assert.equal(window.label, '2026-03-01 → 2026-03-03');
});

test('周期默认时间与枚举值', () => {
  assert.deepEqual(SCHEDULE_MODES, ['daily', 'weekly', 'monthly', 'custom']);
  assert.deepEqual(WINDOW_MODES, ['calendar', 'rolling']);
  assert.equal(defaultCronFor('daily'), '0 22 * * *');
  assert.equal(defaultCronFor('weekly'), '0 8 * * 1');
  assert.equal(defaultCronFor('monthly'), '0 8 1 * *');
  assert.equal(defaultCronFor('custom'), '0 22 * * *');
});
