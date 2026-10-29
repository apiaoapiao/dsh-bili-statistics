/**
 * 九个 bili_intent_* 工具的定义。
 * 生成逻辑放在宿主 apply 里（collectRun / renderReport / 登录 / 状态快照），
 * 通过 deps 注入，工具本身只做参数校验与结果组装。
 */
import { OUTPUT_SCHEMA, cardPayload } from '../contracts/card-meta.js';
import { textOut, describeLoginState, roleLabel, describePollResult } from '../core/present.js';
import { pct, truncate } from '../core/util.js';
import { TONE_WORDS } from '../config/defaults.js';
import {
  loadState,
  saveState,
  setIntention,
  recordHypotheses,
  recordFeedback,
  markNotified
} from '../core/state.js';
import { deliverAll } from '../services/notify.js';

/**
 * @param {object} deps
 * @param {string} deps.stateDir 数据目录
 * @param {() => object} deps.getConfig 取当前生效配置（设置页改动会热替换，必须每次现取）
 * @param {Function} deps.statusSnapshot 状态快照
 * @param {Function} deps.startLogin 生成登录二维码
 * @param {Function} deps.pollLogin 轮询登录状态
 * @param {Function} deps.collectRun 拉历史并计算 facts
 * @param {Function} deps.requireRun 取指定 run，缺省取最近一次
 * @param {Function} deps.renderReport 渲染报告并落盘
 * @param {Function} deps.composeDm 组装通知文案
 * @param {Function} deps.emailAttachment 组装邮件附件
 * @param {Function} deps.effectiveNotifyConfig 生效的通知配置
 * @returns {object[]} 工具定义
 */
export function createTools(deps) {
  const {
    stateDir,
    getConfig,
    statusSnapshot,
    startLogin,
    pollLogin,
    collectRun,
    requireRun,
    renderReport,
    composeDm,
    emailAttachment,
    effectiveNotifyConfig
  } = deps;

  const definitions = [];


  definitions.push({
    name: 'bili_intent_set',
    description:
      '设置（或替换）当前的观看计划。计划是一句话：这段时间想用 B 站做什么、不做什么。之后的统计报告会拿实际观看与它对照，但不做评价、不给建议。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '一句话计划，例如：每晚只看 30 分钟课程录播，不看推荐流。' }
      },
      required: ['text'],
      additionalProperties: false
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => textOut('计划已更新：' + value.intention.text),
      presentationMeta: (args, value) => ({ kind: 'bili-intent-set', intention: value.intention })
    },
    async execute(args) {
      const state = loadState(stateDir);
      const intention = setIntention(state, args.text, { source: 'tool' });
      saveState(stateDir, state);
      return { intention };
    }
  });

  definitions.push({
    name: 'bili_intent_status',
    description: '查看插件当前状态：计划、最近一次统计、历史 run 数量、通知与定时配置（密钥已脱敏）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => {
        const lines = [
          '计划：' + (value.intention ? value.intention.text + '（' + value.intention.days_since_set + ' 天前定的）' : '还没有定计划'),
          '最近一次统计：' + (value.latest_run ? value.latest_run.created_at + ' · ' + value.latest_run.total_items + ' 条' : '还没有'),
          '历史 run：' + value.run_count + ' 次，反馈：' + value.feedback_count + ' 条',
          '定时：' + (value.schedule.enabled ? value.schedule.mode + '，下次 ' + (value.schedule.next_fire ?? '未计算') : '已关闭'),
          '通知渠道：' + (value.notify.channels.length > 0 ? value.notify.channels.join('、') : '未配置'),
          '读历史账号：' + describeLoginState(value.login.reader),
          '私信账号：' + describeLoginState(value.login.sender),
          '扫码登录：' + (value.login.pending ? '有一张未完成的二维码（' + roleLabel(value.login.pending.role) + '），可用 bili_intent_login_poll 查询' : '无待完成登录')
        ];
        return textOut(lines.join('；'));
      }
    },
    async execute() {
      return statusSnapshot();
    }
  });

  definitions.push({
    name: 'bili_intent_login',
    description:
      '生成 B 站扫码登录二维码：用来登录“读观看历史”的账号或“发私信”的账号。把卡片上的二维码交给用户用手机 B 站 App 扫码，确认后调用 bili_intent_login_poll 完成登录。登录得到的凭据保存在插件数据目录，之后不用再手填 cookie。',
    parameters: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          enum: ['reader', 'sender'],
          description: 'reader=读观看历史的账号（默认），sender=发私信的账号'
        },
        channel: {
          type: 'string',
          enum: ['web', 'tv'],
          description: '扫码通道：web=网页端（默认），tv=TV 端。网页端轮询被 B 站风控拦截（code -412）时会自动切到 tv'
        }
      },
      additionalProperties: false
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) =>
        textOut(
          '已生成扫码登录二维码（' +
            roleLabel(value.role) +
            '，' +
            (value.channel === 'tv' ? 'TV 通道' : '网页通道') +
            '）：请用手机 B 站 App 扫码并在手机上确认，然后调用 bili_intent_login_poll。二维码 ' +
            value.expires_in_seconds +
            ' 秒内有效；卡片里没显示二维码时，可让用户用浏览器打开：' +
            value.url
        ),
      presentationMeta: (args, value) => ({
        kind: 'bili-intent-login',
        role: value.role,
        channel: value.channel ?? 'web',
        url: value.url,
        dots: value.dots,
        size: value.size,
        expires_in_seconds: value.expires_in_seconds
      })
    },
    async execute(args) {
      return startLogin(args.role, { channel: args.channel });
    }
  });

  definitions.push({
    name: 'bili_intent_login_poll',
    description:
      '查询扫码登录进度（可在内部等待一段时间）。扫码确认成功后立即把凭据保存到插件数据目录，并用 nav 接口验证账号是否可用。',
    parameters: {
      type: 'object',
      properties: {
        qrcode_key: { type: 'string', description: '要查询的二维码 key，默认用最近一次 bili_intent_login 生成的那张' },
        wait_seconds: { type: 'integer', description: '最多等待多少秒（0–60，默认 15），到时间仍未确认就返回当前状态' }
      },
      additionalProperties: false
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => textOut(describePollResult(value)),
      presentationMeta: (args, value) => ({
        kind: 'bili-intent-login-state',
        state: value.state,
        role: value.role,
        channel: value.channel ?? null,
        mid: value.mid ?? null,
        uname: value.uname ?? null,
        usable: value.usable ?? null,
        message: value.message ?? null
      })
    },
    async execute(args) {
      return pollLogin({ qrcodeKey: args.qrcode_key, waitSeconds: args.wait_seconds, signal: undefined });
    }
  });

  definitions.push({
    name: 'bili_intent_facts',
    description:
      '拉取指定窗口内的 B 站观看历史，计算 StatisticalFacts（条目数、完成度、时段、重复度、最长连续自动播放、与历史基线对比）并返回可引用的证据序号。只给事实与推断，不下结论、不给建议。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'custom'], description: '统计周期类型，默认取配置里的 mode' },
        window: { type: 'string', enum: ['calendar', 'rolling'], description: '窗口策略：calendar 按自然日/自然月切（daily 默认取昨天整天），rolling 从此刻往前推固定时长（daily 为 24 小时）' },
        from: { type: 'string', description: 'custom 模式的开始日期 YYYY-MM-DD' },
        to: { type: 'string', description: 'custom 模式的结束日期 YYYY-MM-DD（含当天）' }
      },
      additionalProperties: false
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => {
        const facts = value.facts;
        const lines = [
          '窗口 ' + facts.window.label + '：' + facts.total_items + ' 条，规则标签 ' + facts.behavior_shape.shape + '（可信度 ' + facts.behavior_shape.confidence + '；只是按完成度与时长的投票结果，出报告时会由模型给出更贴切的状态名）',
          '平均完成度 ' + pct(facts.completion_on_active.mean_completion_rate, 0) + '，22 点后占比 ' + pct(facts.time_distribution.after_22_share, 0),
          '最长连续自动播放 ' + facts.passive_chain.max_consecutive + ' 条，同作者最长连续 ' + facts.repetition.max_same_author_run + ' 条',
          '证据序号：1–' + value.evidence.length + '，可用 bili_intent_annotate 引用'
        ];
        return textOut(lines.join('；'));
      },
      presentationMeta: (args, value) => cardPayload(value.run, [], [])
    },
    async execute(args, exec) {
      const { run, facts, evidence } = await collectRun({ mode: args.mode, window: args.window, from: args.from, to: args.to, signal: exec?.signal });
      return { run_id: run.id, run, facts, evidence };
    }
  });

  definitions.push({
    name: 'bili_intent_annotate',
    description:
      '保存你对照用户计划做出的完成情况判断（1–3 条）。每条必须引用至少 2 个 bili_intent_facts 返回的证据序号；用统计数字与具体视频标题说明计划里哪部分做到、哪部分没做到，不评价自控力、不给建议。证据序号无效的条目会被丢弃。',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: '要挂到哪次统计上，默认最近一次' },
        hypotheses: {
          type: 'array',
          description: '1–3 条计划完成情况',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: '一条计划完成情况的陈述，不超过 240 字' },
              evidence: { type: 'array', items: { type: 'integer' }, description: '引用的证据序号，至少 2 个' },
              clue: { type: 'string', description: '判断依据（数字或条目特征）' },
              certainty: { type: 'string', enum: ['fact', 'inference'], description: '这条陈述是硬事实还是推断' }
            },
            required: ['text', 'evidence'],
            additionalProperties: false
          }
        }
      },
      required: ['hypotheses'],
      additionalProperties: false
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => {
        const tone = Array.isArray(value.tone_warnings) && value.tone_warnings.length > 0
          ? '；有评价性措辞（' + value.tone_warnings.join('、') + '），建议改成描述可观察的行为'
          : '';
        if (value.saved.length === 0) {
          return textOut('没有保存任何计划情况：' + (value.rejected.map((r) => r.reason).join('；') || '缺少有效内容') + tone);
        }
        return textOut('已保存 ' + value.saved.length + ' 条计划情况' + (value.rejected.length > 0 ? '，丢弃 ' + value.rejected.length + ' 条' : '') + tone);
      },
      presentationMeta: (args, value) => ({ kind: 'bili-intent-annotate', run_id: value.run_id, saved: value.saved.length })
    },
    async execute(args) {
      const state = loadState(stateDir);
      const run = requireRun(state, args.run_id);
      if (!Array.isArray(run.evidence) || run.evidence.length === 0) {
        throw new Error('这次统计没有证据集，无法校验引用，请重新调用 bili_intent_facts');
      }
      const accepted = [];
      const rejected = [];
      for (const raw of Array.isArray(args.hypotheses) ? args.hypotheses : []) {
        if (accepted.length >= 3) {
          rejected.push({ text: String(raw?.text ?? ''), reason: '一次最多保存 3 条计划情况' });
          continue;
        }
        const text = String(raw?.text ?? '').trim();
        if (text.length === 0) {
          rejected.push({ text, reason: '正文为空' });
          continue;
        }
        if (text.length > 240) {
          rejected.push({ text: truncate(text, 40), reason: '正文超过 240 字' });
          continue;
        }
        const refs = Array.isArray(raw?.evidence) ? raw.evidence.map((v) => Number(v)).filter((v) => Number.isInteger(v)) : [];
        const valid = [...new Set(refs.filter((v) => v >= 1 && v <= run.evidence.length))];
        if (valid.length < 2) {
          rejected.push({ text: truncate(text, 40), reason: '需要至少 2 个有效的证据序号（当前范围 1–' + run.evidence.length + '）' });
          continue;
        }
        const tone = TONE_WORDS.filter((word) => text.includes(word));
        accepted.push({
          text,
          evidence: valid.map((index) => {
            const entry = run.evidence[index - 1];
            return entry.time + ' ' + entry.title;
          }),
          clue: raw?.clue ? truncate(String(raw.clue), 160) : null,
          certainty: raw?.certainty === 'fact' ? 'fact' : 'inference',
          tone_warnings: tone
        });
      }
      const saved = recordHypotheses(state, run.id, accepted);
      saveState(stateDir, state);
      const toneWarnings = [...new Set(accepted.flatMap((item) => item.tone_warnings ?? []))];
      return { run_id: run.id, saved, rejected, tone_warnings: toneWarnings };
    }
  });

  definitions.push({
    name: 'bili_intent_report',
    description:
      '把某次统计的 facts 与已保存的计划情况渲染成报告，按配置落盘（markdown/html），并返回摘要。会话里的卡片会展示这次报告。不新拉数据；需要新数据先调用 bili_intent_facts。',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: '要出报告的统计 id，默认最近一次' }
      },
      additionalProperties: false
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => {
        const head = value.paths.length > 0 ? '报告已写入：' + value.paths.join('、') : '报告未落盘（save_local 关闭）';
        return textOut(head + '；' + value.summary);
      },
      presentationMeta: (args, value) =>
        cardPayload(value.run, value.hypotheses, value.paths, value.narrative, value.shape_label ? { label: value.shape_label, reason: value.shape_reason } : null)
    },
    async execute(args) {
      const state = loadState(stateDir);
      const run = requireRun(state, args.run_id);
      const hypotheses = state.hypotheses.filter((h) => h.run_id === run.id);
      const rendered = await renderReport(run, hypotheses);
      return {
        run_id: run.id,
        run,
        facts: run.facts,
        hypotheses: rendered.hypotheses,
        hypotheses_source: rendered.hypotheses_source,
        paths: rendered.paths,
        summary: rendered.summary,
        narrative: rendered.narrative,
        shape_label: rendered.shape_label,
        shape_reason: rendered.shape_reason,
        shape_source: rendered.shape_source,
        polished: rendered.polished,
        polish_reason: rendered.polish_reason,
        polish_message: rendered.polish_message
      };
    }
  });

  definitions.push({
    name: 'bili_intent_feedback',
    description: '记录你对某份报告的看法（准确 / 不准确 / 不完整 / 没用），可附一句说明。只用于后续统计调整，不触发任何自动改动。',
    parameters: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['accurate', 'inexact', 'incomplete', 'useless'], description: '对报告的判断' },
        note: { type: 'string', description: '可选的一句补充说明' },
        run_id: { type: 'string', description: '针对哪次统计，默认最近一次' }
      },
      required: ['verdict'],
      additionalProperties: false
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => textOut('已记录反馈：' + value.feedback.verdict + '（' + value.feedback.run_id + '）'),
      presentationMeta: (args, value) => ({ kind: 'bili-intent-feedback', verdict: value.feedback.verdict })
    },
    async execute(args) {
      const state = loadState(stateDir);
      const run = requireRun(state, args.run_id);
      const feedback = recordFeedback(state, { runId: run.id, verdict: args.verdict, note: args.note ?? null });
      saveState(stateDir, state);
      return { feedback };
    }
  });

  definitions.push({
    name: 'bili_intent_notify',
    description:
      '把摘要发到已配置的通知渠道（B 站私信 / 邮件，可多选）。不发内容时用最近一次统计的摘要。每次调用都会真发，不做每日次数限制。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发送的内容，留空则用最近一次统计摘要' },
        dry_run: { type: 'boolean', description: '只组装内容不真的发送' }
      },
      additionalProperties: false
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => {
        if (value.dry_run) return textOut('（演练）将发送：' + value.content);
        if (value.delivered) return textOut('已发送：' + value.content);
        return textOut('发送失败：' + value.results.map((r) => r.channel + ' ' + r.error).join('；'));
      }
    },
    async execute(args) {
      const state = loadState(stateDir);
      const cfg = getConfig();
      const latest = state.runs[0];
      let content;
      let polished = false;
      let polishReason = null;
      let polishMessage = null;
      if (args.text && String(args.text).trim().length > 0) {
        content = truncate(String(args.text).trim(), cfg.notify.summary_max_chars);
      } else {
        const composed = await composeDm(latest?.facts ?? null, {
          maxChars: cfg.notify.summary_max_chars,
          shapeLabel: latest?.generated?.shape?.label ?? ''
        });
        content = composed.text;
        polished = composed.polished;
        polishReason = composed.reason;
        polishMessage = composed.message;
      }
      if (args.dry_run) return { dry_run: true, content, polished, polish_reason: polishReason, polish_message: polishMessage, results: [] };
      if (cfg.notify.channels.length === 0) throw new Error('未配置通知渠道：notify.channels 至少要有一个（bili_dm / email）');
      const latestHypotheses = latest
        ? (Array.isArray(latest.generated?.hypotheses) && latest.generated.hypotheses.length > 0
            ? latest.generated.hypotheses
            : state.hypotheses.filter((item) => item.run_id === latest.id))
        : [];
      const attachment = emailAttachment(latest?.facts ?? null, latestHypotheses, latest?.generated?.overview ?? null, latest?.generated?.shape ?? null);
      const outcome = await deliverAll(effectiveNotifyConfig(), { content, attachment });
      if (outcome.delivered) {
        const first = outcome.results.find((entry) => entry.ok);
        markNotified(state, { channel: first?.channel ?? null, reportId: latest?.id ?? null });
        saveState(stateDir, state);
      }
      return { delivered: outcome.delivered, content, polished, polish_reason: polishReason, polish_message: polishMessage, results: outcome.results };
    }
  });

  return definitions;
}
