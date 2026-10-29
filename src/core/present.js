/**
 * 面向人和模型的文字呈现：脱敏、登录状态、证据挑选、工具文本输出。
 * 纯函数，不做 IO。
 */
import { formatLocal } from '../domain/time.js';
import { truncate } from './util.js';

export function redact(secret) {
  const text = String(secret ?? '');
  return text.length === 0 || text === '0' ? '' : text.slice(0, 4) + '***';
}

/** UID 只露前四位；未配置时明确说出来，而不是显示一个假的掩码。 */
export function showMid(value) {
  const masked = redact(value);
  return masked.length === 0 ? '未配置' : masked;
}

export function roleLabel(role) {
  return role === 'sender' ? '发私信' : '读观看历史';
}

export function describePollResult(value) {
  if (value.state === 'confirmed') {
    const who = value.uname ? value.uname : value.mid ? 'uid ' + redact(value.mid) : '已登录';
    return '扫码登录成功（' + roleLabel(value.role) + '）：' + who + '。' + (value.message ?? '');
  }
  if (value.state === 'switch') return value.message ?? '已切换扫码通道，请重新生成二维码';
  if (value.state === 'expired') return '二维码已失效，请重新调用 bili_intent_login 生成新的二维码';
  if (value.state === 'error') return '登录失败：' + (value.message ?? '未知错误');
  return roleLabel(value.role) + '：' + (value.message ?? '还在等待扫码');
}

export function describeLoginState(slot) {
  if (!slot || !slot.logged_in) return '未登录';
  const who = slot.uname ? slot.uname : slot.mid ? 'uid ' + redact(slot.mid) : '身份未验证';
  return (slot.source === 'config' ? '已用配置 cookie 登录' : '已扫码登录') + '（' + who + '）';
}

/** 从条目里挑有限条证据，保证模型引用的序号可核对。 */
export function pickEvidence(items, limit, timeZone) {
  const scored = items.map((item) => {
    const completion = item.completion === null ? 0.5 : item.completion;
    const minutes = Math.min(item.durationSec ?? 0, 7200) / 60;
    return { item, score: (1 - completion) * 2 + minutes / 60 };
  });
  scored.sort((a, b) => b.score - a.score);
  const chosen = scored.slice(0, Math.max(2, limit)).map((entry) => entry.item);
  chosen.sort((a, b) => a.ts - b.ts);
  return chosen.map((item, index) => ({
    index: index + 1,
    time: formatLocal(item.ts * 1000, timeZone),
    title: truncate(item.longTitle ? item.title + ' / ' + item.longTitle : item.title, 90),
    author: item.author || null,
    completion: item.completion,
    duration_min: item.durationSec === null ? null : Math.round(item.durationSec / 60)
  }));
}

export const textOut = (text) => [{ type: 'text', text }];
