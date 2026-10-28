/** 报告渲染与落盘：Markdown / 独立 HTML，以及通知用的短摘要。 */
import path from 'node:path';
import { expandHome, ensureDir, pct, truncate, writeText, humanDuration } from './util.js';
import { formatLocal, isoWeek, localParts } from './time.js';

const SHAPE_LABEL = {
  fragmented_binge: '碎片化连刷',
  comfort_repetition: '重复性陪伴观看',
  focused_longform: '相对专注的长内容',
  late_night_surf: '深夜滑屏',
  mixed: '混合形态'
};

const label = (shape) => SHAPE_LABEL[shape] ?? shape;

/** 报告文件名：日模式用日期，周模式用 ISO 周，其它用窗口标签。 */
export function reportFileName(facts, now, timeZone, extension) {
  const p = localParts(now, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const mode = facts?.window?.mode;
  let base = `report-${stamp}`;
  if (mode === 'weekly') {
    const { year, week } = isoWeek(now, timeZone);
    base = `report-${year}-W${String(week).padStart(2, '0')}`;
  } else if (mode === 'custom') {
    base = `report-${stamp}-custom`;
  }
  return `${base}.${extension}`;
}

function factsRows(facts) {
  const rows = [
    ['条目数', String(facts.total_items)],
    ['行为形态（推断）', `${label(facts.behavior_shape.shape)} · 置信度 ${facts.behavior_shape.confidence}`],
    ['平均完成度', pct(facts.completion_on_active.mean_completion_rate, 0)],
    ['低进度条目', `${facts.completion_on_active.low_progress_items} / ${facts.completion_on_active.sample_size}`],
    ['22 点后占比', pct(facts.time_distribution.after_22_share, 0)],
    ['最长连续被动链', `${facts.passive_chain.max_consecutive} 条`],
    ['同作者最长连续', `${facts.repetition.max_same_author_run} 条`],
    ['观看总时长', humanDuration(facts.duration.total_sec)]
  ];
  return rows;
}

/** 渲染 Markdown 报告。hypotheses 可以为空（此时明说"没有给出假设"）。 */
export function renderMarkdown(facts, { hypotheses = [], narrative = null, now = Date.now(), timeZone = 'Asia/Shanghai' } = {}) {
  const lines = [];
  lines.push(`# B 站观看形态报告 · ${facts.window.label}`);
  lines.push('');
  lines.push(`窗口：${formatLocal(facts.window.from, timeZone)} → ${formatLocal(facts.window.to, timeZone)}（${facts.window.timezone}）`);
  lines.push(`生成时间：${formatLocal(now, timeZone)}`);
  lines.push('');
  lines.push('## 统计事实');
  lines.push('');
  for (const [key, value] of factsRows(facts)) lines.push(`- **${key}**：${value}`);
  lines.push('');
  if (facts.baseline.lookback_runs > 0 && facts.baseline.delta_ratio !== null) {
    const dir = facts.baseline.delta_ratio >= 0 ? '高于' : '低于';
    lines.push(
      `与最近 ${facts.baseline.lookback_runs} 次的中位数（${facts.baseline.median_items} 条）相比，本次${dir}基线的 ${Math.abs(Math.round(facts.baseline.delta_ratio * 100))}%。`
    );
    lines.push('');
  } else if (facts.intent_anchor === null) {
    lines.push('> 未设置意图档案，报告只做形态统计，不比较偏离。');
    lines.push('');
  }
  if (typeof narrative === 'string' && narrative.trim().length > 0) {
    lines.push('## 形态导读（模型生成）');
    lines.push('');
    lines.push(narrative.trim());
    lines.push('');
  }
  if (facts.behavior_shape.signals.length > 0) {
    lines.push('## 形态依据');
    lines.push('');
    for (const signal of facts.behavior_shape.signals) lines.push(`- ${signal}`);
    lines.push('');
  }
  if (facts.time_distribution.busiest_hours.length > 0) {
    const busy = facts.time_distribution.busiest_hours.map((h) => `${h.hour} 点（${h.count} 条）`).join('、');
    lines.push('## 时段分布');
    lines.push('');
    lines.push(`最集中的时段：${busy}。22 点后 ${facts.time_distribution.late_night_count} 条。`);
    lines.push('');
  }
  lines.push('## 行为假设（推断，不是事实）');
  lines.push('');
  if (hypotheses.length === 0) {
    lines.push('本次没有给出假设：统计事实不足以支撑一个可检验的推断。');
  } else {
    hypotheses.forEach((hypothesis, index) => {
      lines.push(`${index + 1}. **${hypothesis.text}**`);
      if (hypothesis.clue) lines.push(`   - 可验证线索：${hypothesis.clue}`);
      if (Array.isArray(hypothesis.evidence) && hypothesis.evidence.length > 0) {
        lines.push(`   - 依据：${hypothesis.evidence.map((e) => String(e).slice(0, 120)).join('；')}`);
      }
    });
  }
  lines.push('');
  if (facts.intent_anchor) {
    lines.push(`意图锚点（${facts.intent_anchor.days_since_set ?? '?'} 天前设置）：${facts.intent_anchor.text}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('说明：接口不返回来源，本报告中的"形态"与"主动/被动"均为行为推断；报告不做评价、不给建议。');
  return `${lines.join('\n')}\n`;
}

/** 渲染单文件 HTML（内联样式，不依赖外部资源）。 */
export function renderHtml(facts, { hypotheses = [], narrative = null, now = Date.now(), timeZone = 'Asia/Shanghai' } = {}) {
  const escape = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const rows = factsRows(facts)
    .map(([key, value]) => `<tr><th>${escape(key)}</th><td>${escape(value)}</td></tr>`)
    .join('');
  const signals = facts.behavior_shape.signals.map((s) => `<li>${escape(s)}</li>`).join('');
  const narrativeBlock =
    typeof narrative === 'string' && narrative.trim().length > 0
      ? `<h2>形态导读（模型生成）</h2>${narrative
          .trim()
          .split(/\n{2,}/)
          .map((para) => `<p>${escape(para)}</p>`)
          .join('')}`
      : '';
  const hyps = hypotheses
    .map((h) => {
      const ev = Array.isArray(h.evidence) && h.evidence.length > 0 ? `<p class="ev">依据：${escape(h.evidence.join('；'))}</p>` : '';
      const clue = h.clue ? `<p class="ev">可验证线索：${escape(h.clue)}</p>` : '';
      return `<li><strong>${escape(h.text)}</strong>${clue}${ev}</li>`;
    })
    .join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>B 站观看形态报告 · ${escape(facts.window.label)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; margin: 0 auto; max-width: 720px; padding: 32px 20px 64px; line-height: 1.6; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 8px; letter-spacing: .04em; text-transform: uppercase; opacity: .65; }
  .meta { opacity: .6; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 8px 0; border-bottom: 1px solid rgba(128,128,128,.25); vertical-align: top; }
  th { width: 42%; font-weight: 500; opacity: .7; }
  ul, ol { padding-left: 20px; }
  li { margin: 6px 0; }
  .ev { margin: 2px 0; font-size: 13px; opacity: .7; }
  footer { margin-top: 36px; font-size: 12px; opacity: .55; border-top: 1px solid rgba(128,128,128,.25); padding-top: 12px; }
</style></head>
<body>
<h1>B 站观看形态报告 · ${escape(facts.window.label)}</h1>
<p class="meta">${escape(formatLocal(facts.window.from, timeZone))} → ${escape(formatLocal(facts.window.to, timeZone))} · ${escape(facts.window.timezone)}</p>
<h2>统计事实</h2>
<table>${rows}</table>
${narrativeBlock}
${signals ? `<h2>形态依据</h2><ul>${signals}</ul>` : ''}
<h2>行为假设（推断）</h2>
${hyps ? `<ol>${hyps}</ol>` : '<p class="meta">本次没有给出假设：统计事实不足以支撑一个可检验的推断。</p>'}
${facts.intent_anchor ? `<h2>意图锚点</h2><p>${escape(facts.intent_anchor.text)}</p><p class="meta">${escape(String(facts.intent_anchor.days_since_set ?? '?'))} 天前设置</p>` : ''}
<footer>接口不返回来源，"形态"与"主动/被动"均为行为推断。本报告不做评价、不给建议。生成于 ${escape(formatLocal(now, timeZone))}</footer>
</body></html>
`;
}

/** 落盘报告，返回写出的文件路径列表。 */
export function saveReport({ dir, format = 'markdown', facts, hypotheses, narrative = null, now = Date.now(), timeZone }) {
  const target = expandHome(dir);
  ensureDir(target);
  const written = [];
  if (format === 'markdown' || format === 'both') {
    const file = path.join(target, reportFileName(facts, now, timeZone, 'md'));
    writeText(file, renderMarkdown(facts, { hypotheses, narrative, now, timeZone }));
    written.push(file);
  }
  if (format === 'html' || format === 'both') {
    const file = path.join(target, reportFileName(facts, now, timeZone, 'html'));
    writeText(file, renderHtml(facts, { hypotheses, narrative, now, timeZone }));
    written.push(file);
  }
  return written;
}

/** 通知摘要：不超过 maxChars，只陈述统计事实，不评价。 */
export function buildSummary(facts, { maxChars = 200 } = {}) {
  const shape = `${label(facts.behavior_shape.shape)}（推断，置信度 ${facts.behavior_shape.confidence}）`;
  const parts = [
    `${facts.window.label}：${facts.total_items} 条`,
    `形态 ${shape}`,
    `平均完成度 ${pct(facts.completion_on_active.mean_completion_rate, 0)}`,
    `22 点后 ${pct(facts.time_distribution.after_22_share, 0)}`
  ];
  return truncate(parts.join('，'), maxChars);
}

export { SHAPE_LABEL };
