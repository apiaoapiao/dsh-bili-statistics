/**
 * dsh-bili-statistics 宿主入口。
 * 职责：注册 bili_intent_* 工具、按配置定时统计、把统计事实与计划情况落盘并投递私信。
 * 报告里的概览与计划情况由插件自己调用宿主 LLM 生成（可在设置页关闭），会话里的模型也可以用 annotate 覆盖。
 */
import { computeFacts } from './domain/facts.js';
import { fetchHistory, buildCookieHeader } from './adapters/bili.js';
import { resolveWindow, formatLocal, nextCronFire, defaultCronFor, SCHEDULE_MODES, WINDOW_MODES } from './domain/time.js';
import { saveReport, buildSummary, renderMarkdown } from './domain/report.js';
import { polishReport, polishDm, modelTarget, DEFAULT_REPORT_PROMPT, DEFAULT_DM_PROMPT } from './services/polish.js';
import { registerApi, API_PREFIX } from './transport/api.js';
import { loadOverrides, saveOverrides, settingsFile, pickEditable } from './core/store.js';
import { DEFAULT_CONFIG, DEFAULT_REPORT_DIR, NOTIFY_CHANNELS, TONE_WORDS, clampInt, normalizeConfig, pickExistingDir } from './config/defaults.js';
import { OUTPUT_SCHEMA, cardPayload } from './contracts/card-meta.js';
import { redact, showMid, roleLabel, describePollResult, describeLoginState, pickEvidence, textOut } from './core/present.js';
import { migrateLegacyStateDir } from './core/migrate.js';
import { createTools } from './tools/index.js';
import { deliverAll } from './services/notify.js';
import {
  loadState,
  saveState,
  setIntention,
  daysSinceSet,
  recordRun,
  recordHypotheses,
  recordFeedback,
  markNotified,
  recordScheduleEvent,
  makeId
} from './core/state.js';
import { expandHome, truncate, pct, isPlainObject, deepMerge } from './core/util.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeQr, toDots, ECC } from './core/qr.js';
import { generateQr, pollQr, generateTvQr, pollTvQr, fetchNav, buildCookie as buildLoginCookie } from './adapters/bili-login.js';
import { loadCreds, saveCreds, setRoleCreds, setPending, clearPending, setChannel, cookieFrom, describeLogin, ROLES } from './core/creds.js';


export const inject = ['tools'];

export function apply(ctx, config) {
  const stateDir = expandHome((config && config.state_dir) || DEFAULT_CONFIG.state_dir);
  const migratedFrom = migrateLegacyStateDir(stateDir);
  let overrides = loadOverrides(stateDir);
  let cfg = normalizeConfig(deepMerge(config ?? {}, overrides));
  let zone = cfg.schedule.timezone;
  /** 设置页改了覆盖层之后热生效：重新合并 + 重新规范化。 */
  const reloadConfig = () => {
    overrides = loadOverrides(stateDir);
    cfg = normalizeConfig(deepMerge(config ?? {}, overrides));
    zone = cfg.schedule.timezone;
    return cfg;
  };

  /** 读历史的凭据：优先显式配置，其次扫码登录保存的 reader。 */
  function readerCredentials() {
    const fromConfig = buildCookieHeader(cfg.bili);
    if (fromConfig.length > 0) return { cookie: fromConfig, source: 'config' };
    const creds = loadCreds(stateDir);
    if (creds.reader && creds.reader.sessdata) return { cookie: cookieFrom(creds.reader), source: 'qr' };
    return { cookie: '', source: null };
  }

  /**
   * 发私信的有效配置：显式配置缺项时用扫码登录保存的 sender 补齐。
   * 接收方缺省时回落到“读历史”账号（通常就是自己的主号），这样扫码登录两个号就能直接收私信。
   */
  function effectiveNotifyConfig() {
    const dm = { ...cfg.notify.bili_dm };
    const creds = loadCreds(stateDir);
    if (!dm.sender_sessdata) {
      if (creds.sender && creds.sender.sessdata) {
        dm.sender_sessdata = creds.sender.sessdata;
        if (!dm.sender_bili_jct) dm.sender_bili_jct = creds.sender.bili_jct;
        if (!dm.sender_mid && creds.sender.mid) dm.sender_mid = creds.sender.mid;
      }
    }
    if (!String(dm.receiver_mid ?? '').trim()) {
      const senderMid = String(dm.sender_mid ?? '').trim();
      const readerMid = String(creds.reader?.mid ?? '').trim();
      const fromConfig = String(cfg.bili?.mid ?? '').trim();
      const candidates = [readerMid, fromConfig];
      for (const mid of candidates) {
        if (mid && mid !== senderMid) {
          dm.receiver_mid = mid;
          dm.receiver_source = 'reader';
          break;
        }
      }
    } else {
      dm.receiver_source = 'config';
    }
    return { ...cfg.notify, bili_dm: dm };
  }

  /** 状态面板用的登录槽位描述。 */
  function describeLoginSlot(role) {
    const creds = loadCreds(stateDir);
    if (role === 'reader') {
      const reader = readerCredentials();
      if (reader.source === 'config') return { logged_in: true, source: 'config', mid: null, uname: null, saved_at: null };
      if (reader.source === 'qr' && creds.reader) {
        const info = describeLogin(creds.reader);
        return { logged_in: true, source: 'qr', mid: info?.mid ?? null, uname: info?.uname ?? null, saved_at: info?.saved_at ?? null };
      }
      return { logged_in: false, source: null, mid: null, uname: null, saved_at: null };
    }
    const dm = effectiveNotifyConfig().bili_dm;
    if (!dm.sender_sessdata) return { logged_in: false, source: null, mid: null, uname: null, saved_at: null };
    const source = cfg.notify.bili_dm.sender_sessdata ? 'config' : 'qr';
    const saved = creds.sender ? describeLogin(creds.sender) : null;
    return {
      logged_in: true,
      source,
      mid: dm.sender_mid || saved?.mid || null,
      uname: source === 'qr' ? saved?.uname ?? null : null,
      saved_at: source === 'qr' ? saved?.saved_at ?? null : null
    };
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

  const log = (level, message) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('bili-statistics') : ctx.logger;
      if (logger && typeof logger[level] === 'function') logger[level](message);
    } catch {}
  };

  if (migratedFrom) log('info', '旧数据目录已迁移到 ' + migratedFrom + '（原目录保留，可手动删除）');

  /** 拉取 + 统计 + 记账，返回最新的 run。 */
  async function collectRun(options = {}) {
    const now = Date.now();
    const state = loadState(stateDir);
    const mode = options.mode ?? cfg.schedule.mode;
    const windowMode = options.window ?? cfg.schedule.window;
    const window = resolveWindow({
      mode,
      windowMode,
      now,
      timeZone: zone,
      customFrom: options.from ?? cfg.schedule.custom_from,
      customTo: options.to ?? cfg.schedule.custom_to,
      weeklyAnchorMs: now
    });
    const { cookie } = readerCredentials();
    if (cookie.length === 0) {
      throw new Error('还没有登录 B 站：请先调用 bili_intent_login 扫码登录（role=reader），或在插件配置的 bili.sessdata 里填入 cookie');
    }
    let fetched;
    try {
      fetched = await fetchHistory({
        cookie,
        windowFrom: window.from,
        windowTo: window.to,
        pageSize: cfg.bili.page_size,
        intervalMs: cfg.bili.request_interval_ms,
        maxPages: cfg.bili.max_pages,
        signal: options.signal
      });
    } catch (error) {
      throw new Error('拉取观看历史失败：' + (error?.message ?? String(error)));
    }
    const intention = state.intention
      ? {
          id: state.intention.id,
          text: state.intention.text,
          created_at: state.intention.created_at,
          days_since_set: daysSinceSet(state.intention, now)
        }
      : null;
    const facts = computeFacts({
      items: fetched.items,
      window: { from: window.from, to: window.to, mode, window_mode: windowMode, label: window.label },
      timeZone: zone,
      intention,
      runs: state.runs
    });
    const evidence = pickEvidence(fetched.items, cfg.report.evidence_limit, zone);
    const run = {
      id: makeId('run'),
      created_at: new Date(now).toISOString(),
      // manual：设置页「立即统计一次」或工具调用；schedule：定时触发。跳过判定只认 schedule。
      trigger: options.trigger === 'schedule' ? 'schedule' : 'manual',
      window: facts.window,
      total_items: facts.total_items,
      shape: facts.behavior_shape.shape,
      confidence: facts.behavior_shape.confidence,
      pages: fetched.pages.length,
      facts,
      evidence
    };
    recordRun(state, run);
    saveState(stateDir, state);
    return { run, facts, evidence, state };
  }

  function requireRun(state, runId) {
    if (runId) {
      const hit = state.runs.find((entry) => entry.id === runId);
      if (!hit) throw new Error('找不到 run_id：' + runId);
      return hit;
    }
    const latest = state.runs[0];
    if (!latest) throw new Error('还没有统计记录，请先调用 bili_intent_facts');
    return latest;
  }

  /** 懒取 llm 服务：宿主没有装载 llm 时返回 undefined，润色自动降级。 */
  function llmService() {
    try {
      if (typeof ctx.get === 'function') return ctx.get('llm') ?? undefined;
    } catch {}
    return undefined;
  }

  /** 模型配置指纹：换了模型或提示词就重新生成，否则复用上次结果。 */
  function reportStamp() {
    return [cfg.llm.provider, cfg.llm.model, String(cfg.llm.report_prompt ?? '').slice(0, 60)].join('|');
  }

  /**
   * 报告渲染：模板正文（数字全部来自统计）+ 模型写的概览与计划情况。
   * 模型失败就等于没有这两节，报告本身不降级；同一份统计的成功结果会缓存到 run 上，避免重复调用。
   */
  async function renderReport(run, hypotheses, options = {}) {
    if (!run.facts) throw new Error('这条统计记录缺少 facts，请重新调用 bili_intent_facts');
    const now = Date.now();
    const state = loadState(stateDir);
    const stored = state.runs.find((entry) => entry.id === run.id) ?? null;
    // 之前用过的观看状态名：给模型做连续性参考，同一个状态别每次换说法。
    const knownShapes = [];
    for (const entry of state.runs) {
      if (entry.id === run.id) continue;
      const label = entry?.generated?.shape?.label;
      if (typeof label !== 'string') continue;
      const clean = label.trim();
      if (clean.length > 0 && !knownShapes.includes(clean)) knownShapes.push(clean);
      if (knownShapes.length >= 3) break;
    }
    const rawCached = !options.refresh && stored?.generated && stored.generated.stamp === reportStamp() ? stored.generated : null;
    // 旧版本解析失败时会把整段 JSON 当概览写进缓存：这种缓存作废，重新生成一次。
    const dirtyOverview = rawCached && typeof rawCached.overview === 'string' && /^\s*\{/.test(rawCached.overview);
    const cached = dirtyOverview ? null : rawCached;
    let narrative = null;
    let shape = null;
    let generated = [];
    let polish = { ok: false, reason: 'disabled', message: null };
    if (cached) {
      narrative = typeof cached.overview === 'string' ? cached.overview : null;
      generated = Array.isArray(cached.hypotheses) ? cached.hypotheses : [];
      if (cached.shape && typeof cached.shape.label === 'string' && cached.shape.label.trim().length > 0) {
        shape = { label: cached.shape.label.trim(), reason: typeof cached.shape.reason === 'string' ? cached.shape.reason : null };
      }
      polish = { ok: true, reason: null, message: null, cached: true };
    }
    // 早期缓存里没有模型起的观看状态名：当成缓存不完整，补调一次模型；失败就继续用缓存里的概览与计划情况。
    const needShape = Boolean(cached) && shape === null && cfg.report.polish;
    if ((!cached || needShape) && cfg.report.polish) {
      const template = renderMarkdown(run.facts, { hypotheses, now, timeZone: zone });
      const fresh = await polishReport({
        llm: llmService(),
        config: cfg,
        facts: run.facts,
        evidence: Array.isArray(run.evidence) ? run.evidence : [],
        hypotheses,
        markdown: template,
        knownShapes,
        signal: options.signal
      });
      if (fresh.ok) {
        polish = fresh;
        narrative = fresh.text;
        generated = Array.isArray(fresh.hypotheses) ? fresh.hypotheses : [];
        if (typeof fresh.shape === 'string' && fresh.shape.trim().length > 0) {
          shape = {
            label: fresh.shape.trim(),
            reason: typeof fresh.shape_reason === 'string' && fresh.shape_reason.trim().length > 0 ? fresh.shape_reason.trim() : null
          };
        }
        if (stored) {
          stored.generated = {
            stamp: reportStamp(),
            at: new Date(now).toISOString(),
            overview: narrative,
            shape,
            hypotheses: generated
          };
          saveState(stateDir, state);
        }
      } else if (!cached) {
        polish = fresh;
      }
    }
    const used = generated.length > 0 ? generated : hypotheses;
    const paths = cfg.report.save_local
      ? saveReport({
          dir: cfg.report.local_dir,
          format: cfg.report.format,
          facts: run.facts,
          hypotheses: used,
          narrative,
          shape,
          now,
          timeZone: zone
        })
      : [];
    const summary = buildSummary(run.facts, { maxChars: cfg.notify.summary_max_chars });
    return {
      paths,
      summary,
      narrative,
      hypotheses: used,
      hypotheses_source: generated.length > 0 ? 'model' : 'saved',
      shape_label: shape?.label ?? null,
      shape_reason: shape?.reason ?? null,
      shape_source: shape ? 'model' : 'rule',
      polished: polish.ok,
      polish_reason: polish.reason ?? null,
      polish_message: polish.message ?? null,
      cached: Boolean(cached)
    };
  }

  /**
   * 私信正文：模板摘要给出硬事实，模型按 llm.dm_prompt 改写语气。
   * 模型失败就用模板，绝不发空消息。
   */
  async function composeDm(facts, { maxChars = cfg.notify.summary_max_chars, signal, shapeLabel = '' } = {}) {
    const template = facts ? buildSummary(facts, { maxChars, shapeLabel }) : '今天没有新的观看记录。';
    if (!facts) return { text: template, polished: false, reason: 'no-facts', message: null };
    const result = await polishDm({ llm: llmService(), config: cfg, facts, summary: template, maxChars, shapeLabel, signal });
    if (!result.ok) {
      return { text: template, polished: false, reason: result.reason ?? 'unknown', message: result.message ?? null };
    }
    return { text: result.text, polished: true, reason: null, message: null, provider: result.provider, model: result.model };
  }

  /**
   * 邮件附件：只有显式开启 attach_report、且渠道里确实有 email 时才准备。
   * 附件就是这份 Markdown 报告本身，不含原始观看记录，也不含任何凭据。
   */
  function emailAttachment(facts, hypotheses = [], narrative = null, shape = null) {
    if (!cfg.notify.channels.includes('email')) return null;
    if (cfg.notify.email.attach_report !== true) return null;
    if (!facts) return null;
    try {
      const content = renderMarkdown(facts, { hypotheses, narrative, shape, timeZone: zone });
      const stamp = formatLocal(Date.now(), zone).slice(0, 10);
      return { filename: 'bili-watch-' + stamp + '.md', content };
    } catch {
      return null;
    }
  }

  /** 定时规则快照：cron 留空时按周期给默认值，设置页据此显示"生效值"。 */
  function scheduleSnapshot() {
    return {
      enabled: cfg.schedule.enabled,
      mode: cfg.schedule.mode,
      window: cfg.schedule.window,
      cron: cfg.schedule.cron || defaultCronFor(cfg.schedule.mode),
      cron_custom: cfg.schedule.cron || '',
      timezone: zone,
      custom_from: cfg.schedule.custom_from,
      custom_to: cfg.schedule.custom_to
    };
  }

  /** 状态快照：工具与设置页共用同一份字段，避免两处口径不一致。 */
  function statusSnapshot() {
    const state = loadState(stateDir);
    const creds = loadCreds(stateDir);
    const latest = state.runs[0] ?? null;
    let nextFire = null;
    let nextWindow = null;
    if (cfg.schedule.enabled) {
      const expression = cfg.schedule.cron || defaultCronFor(cfg.schedule.mode);
      try {
        const epoch = nextCronFire(expression, Date.now(), zone);
        nextFire = epoch === null ? null : formatLocal(epoch, zone);
        if (epoch !== null) {
          nextWindow = resolveWindow({
            mode: cfg.schedule.mode,
            windowMode: cfg.schedule.window,
            now: epoch,
            timeZone: zone,
            customFrom: cfg.schedule.custom_from,
            customTo: cfg.schedule.custom_to,
            weeklyAnchorMs: epoch
          }).label;
        }
      } catch (error) {
        nextFire = 'cron 无法解析：' + (error?.message ?? String(error));
      }
    }
    return {
      intention: state.intention
        ? { text: state.intention.text, created_at: state.intention.created_at, days_since_set: daysSinceSet(state.intention) }
        : null,
      latest_run: latest
        ? {
            id: latest.id,
            created_at: latest.created_at,
            total_items: latest.total_items,
            shape: latest.shape,
            shape_label: typeof latest?.generated?.shape?.label === 'string' && latest.generated.shape.label.trim().length > 0 ? latest.generated.shape.label.trim() : null
          }
        : null,
      run_count: state.runs.length,
      feedback_count: state.feedback.length,
      hypothesis_count: state.hypotheses.length,
      schedule: {
        ...scheduleSnapshot(),
        next_fire: nextFire,
        next_window: nextWindow,
        last_event: state.schedule_log[0] ?? null,
        recent_events: state.schedule_log.slice(0, 3)
      },
      notify: (() => {
        const dm = effectiveNotifyConfig().bili_dm;
        const email = cfg.notify.email;
        return {
          channels: cfg.notify.channels,
          summary_max_chars: cfg.notify.summary_max_chars,
          bili_dm_sender: showMid(dm.sender_mid),
          bili_dm_receiver: showMid(dm.receiver_mid),
          bili_dm_receiver_source: dm.receiver_mid ? dm.receiver_source ?? null : null,
          email: {
            enabled: cfg.notify.channels.includes('email'),
            configured: Boolean(email.host && email.from && email.to),
            host: email.host || '未配置',
            port: email.port,
            secure: email.secure,
            user: email.user ? redact(email.user) : '未配置',
            from: email.from || '未配置',
            to: email.to || '未配置',
            from_name: email.from_name,
            subject_prefix: email.subject_prefix,
            attach_report: email.attach_report
          }
        };
      })(),
      report: {
        save_local: cfg.report.save_local,
        format: cfg.report.format,
        local_dir: expandHome(cfg.report.local_dir),
        polish: cfg.report.polish
      },
      llm: {
        enabled: cfg.llm.enabled,
        provider: cfg.llm.provider,
        model: cfg.llm.model,
        ready: modelTarget(cfg) !== null,
        report_polish: cfg.report.polish
      },
      bili: { has_cookie: readerCredentials().cookie.length > 0 },
      login: {
        reader: describeLoginSlot('reader'),
        sender: describeLoginSlot('sender'),
        pending: creds.pending
          ? {
              role: creds.pending.role,
              channel: creds.pending.channel === 'tv' ? 'tv' : 'web',
              expires_at: creds.pending.expires_at ?? null
            }
          : null,
        channel: creds.channel
      },
      state_dir: stateDir
    };
  }

  /** 生成扫码二维码（工具与设置页共用）。channel=web 走网页端，tv 走 TV 端（网页端被风控拦截时的备用通道）。 */
  async function startLogin(role, options = {}) {
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

  /** 轮询扫码结果并落盘凭据（工具与设置页共用）。网页端被风控拦截（-412）时自动切到 TV 通道。 */
  async function pollLogin({ qrcodeKey, waitSeconds = 15, signal } = {}) {
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

  for (const definition of createTools({
    stateDir,
    getConfig: () => cfg,
    statusSnapshot,
    startLogin,
    pollLogin,
    collectRun,
    requireRun,
    renderReport,
    composeDm,
    emailAttachment,
    effectiveNotifyConfig
  })) ctx.tools.register(definition);
  /** 无人值守管线：统计 → 落盘 → 发私信。每次到点都重新拉一遍历史，不跳过。异常只记日志，不拖垮宿主。 */
  async function runScheduled() {
    const state = loadState(stateDir);
    if (readerCredentials().cookie.length === 0) {
      recordScheduleEvent(state, { result: 'skipped', reason: '还没有登录 B 站（未扫码也没配 sessdata）' });
      saveState(stateDir, state);
      log('info', '还没有登录 B 站（未扫码也没配 sessdata），跳过本次定时统计');
      return;
    }
    try {
      const { run, facts } = await collectRun({ trigger: 'schedule' });
      const rendered = await renderReport(run, []);
      const paths = rendered.paths;
      log('info', '定时统计完成：' + run.id + '（' + paths.join('、') + '）' + (rendered.polished ? '，含模型概览' : '，无模型概览'));
      const fresh = loadState(stateDir);
      let delivered = false;
      let note = '报告已写入 ' + paths.length + ' 个文件';
      if (cfg.notify.channels.length === 0) {
        note += '；没有配置通知渠道';
      } else {
        const composed = await composeDm(facts, { maxChars: cfg.notify.summary_max_chars, shapeLabel: rendered.shape_label || '' });
        const content = composed.text;
        const attachment = emailAttachment(facts, rendered.hypotheses, rendered.narrative, rendered.shape_label ? { label: rendered.shape_label, reason: rendered.shape_reason } : null);
        const outcome = await deliverAll(effectiveNotifyConfig(), { content, attachment });
        if (outcome.delivered) {
          const first = outcome.results.find((entry) => entry.ok);
          markNotified(fresh, { channel: first?.channel ?? null, reportId: run.id });
          delivered = true;
          note += '；已发送通知';
          log('info', '已发送通知：' + content);
        } else {
          const detail = outcome.results.map((entry) => entry.channel + ' ' + entry.error).join('；');
          note += '；通知发送失败：' + detail;
          log('warn', '通知发送失败：' + detail);
        }
      }
      recordScheduleEvent(fresh, { result: 'ran', reason: note, run_id: run.id, notified: delivered });
      saveState(stateDir, fresh);
    } catch (error) {
      const failed = loadState(stateDir);
      const message = error?.message ?? String(error);
      recordScheduleEvent(failed, { result: 'error', reason: message });
      saveState(stateDir, failed);
      log('warn', '定时统计失败：' + message);
    }
  }

  let scheduleTimer = null;
  let scheduleDisposed = false;

  /** 重新武装定时器：设置页改完周期/窗口后立即生效，不必重启。 */
  function armScheduler() {
    if (scheduleDisposed) return;
    if (scheduleTimer !== null) {
      clearTimeout(scheduleTimer);
      scheduleTimer = null;
    }
    if (!cfg.schedule.enabled) return;
    const expression = cfg.schedule.cron || defaultCronFor(cfg.schedule.mode);
    let next = null;
    try {
      next = nextCronFire(expression, Date.now(), zone);
    } catch (error) {
      log('warn', 'cron 表达式无法解析，定时停用：' + (error?.message ?? String(error)));
      return;
    }
    if (next === null) {
      log('warn', '按当前 cron 找不到下一次触发时间：' + expression);
      return;
    }
    const delay = Math.max(1000, next - Date.now());
    scheduleTimer = setTimeout(async () => {
      try {
        await runScheduled();
      } catch (error) {
        log('warn', '定时统计失败：' + (error?.message ?? String(error)));
      }
      armScheduler();
    }, Math.min(delay, 2147483647));
    if (typeof scheduleTimer.unref === 'function') scheduleTimer.unref();
  }

  function startScheduler() {
    const dispose = () => {
      scheduleDisposed = true;
      if (scheduleTimer !== null) clearTimeout(scheduleTimer);
      scheduleTimer = null;
    };
    try {
      ctx.effect(() => dispose, 'bili-statistics:schedule');
    } catch {
      try {
        ctx.on('dispose', dispose);
      } catch {}
    }
    if (!cfg.schedule.enabled) {
      log('info', '定时已关闭（schedule.enabled=false），只保留手动触发');
      return;
    }
    armScheduler();
  }

  /**
   * 发一条测试消息。only 指定就只发那一个渠道（设置页的「发测试私信 / 发测试邮件」用它），
   * 否则按配置的渠道顺序全发。内容同样会先按 llm.dm_prompt 改写语气。
   */
  async function runNotifyTest({ text, only } = {}) {
    const state = loadState(stateDir);
    const latest = state.runs[0] ?? null;
    let content;
    let polished = false;
    let polishReason = null;
    let polishMessage = null;
    if (text && String(text).trim().length > 0) {
      content = truncate(String(text).trim(), cfg.notify.summary_max_chars);
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
    const target = NOTIFY_CHANNELS.includes(String(only ?? '').trim()) ? String(only).trim() : null;
    const base = effectiveNotifyConfig();
    const config = target ? { ...base, channels: [target] } : base;
    if (config.channels.length === 0) {
      throw new Error('未配置通知渠道：notify.channels 至少要有一个（bili_dm / email）');
    }
    const hypotheses = latest ? state.hypotheses.filter((item) => item.run_id === latest.id) : [];
    const attachment = emailAttachment(latest?.facts ?? null, hypotheses, latest?.generated?.overview ?? null, latest?.generated?.shape ?? null);
    const outcome = await deliverAll(config, { content, attachment });
    return {
      delivered: outcome.delivered,
      channel: target,
      content,
      polished,
      polish_reason: polishReason,
      polish_message: polishMessage,
      attached: Boolean(attachment),
      results: outcome.results
    };
  }

  /** 目录候选：默认数据目录 + 文档/桌面下的子目录（自动躲开 OneDrive 重定向）。 */
  function dirOptions() {
    const home = os.homedir();
    const documents = pickExistingDir([path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Documents')]);
    const desktop = pickExistingDir([path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop')]);
    const options = [{ key: 'default', path: expandHome(DEFAULT_REPORT_DIR) }];
    if (documents) options.push({ key: 'documents', path: path.join(documents, 'B站观看报告') });
    if (desktop) options.push({ key: 'desktop', path: path.join(desktop, 'B站观看报告') });
    return { home, options };
  }

  /** 校验一个目录能不能用：建得出来、写得进去。失败抛错，由接口层转成 ok:false。 */
  function checkDir(value) {
    const input = String(value ?? '').trim();
    if (input.length === 0) throw new Error('目录不能为空');
    const resolved = path.resolve(expandHome(input));
    if (path.parse(resolved).root === resolved) throw new Error('不能直接用盘符根目录，请再套一层子目录');
    const created = !fs.existsSync(resolved);
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch (error) {
      throw new Error('无法创建目录：' + (error?.message ?? String(error)));
    }
    const probe = path.join(resolved, '.bili-write-test-' + process.pid + '-' + Date.now() + '.tmp');
    try {
      fs.writeFileSync(probe, 'ok', 'utf8');
    } catch (error) {
      throw new Error('目录不可写：' + (error?.message ?? String(error)));
    } finally {
      try { fs.rmSync(probe, { force: true }); } catch {}
    }
    return { ok: true, input, resolved, created };
  }

  /**
   * 设置页接口实现：全部复用工具里的同一套函数（登录、统计、报告、私信），
   * 这样设置页与工具不会出现两套口径。
   */
  const apiHandlers = {
    status: async () => statusSnapshot(),

    models: async () => {
      const llm = llmService();
      if (!llm) return { providers: [], models: {}, current: { provider: cfg.llm.provider, model: cfg.llm.model }, error: '宿主没有 llm 服务' };
      const providers =
        typeof llm.listProviders === 'function'
          ? llm.listProviders().map((p) => ({ id: String(p.id), name: String(p.name ?? p.id) }))
          : [];
      const models = {};
      for (const provider of providers) {
        try {
          const list = await llm.listModels(provider.id);
          models[provider.id] = (Array.isArray(list) ? list : []).map((m) => ({ id: String(m.id), name: String(m.name ?? m.id) }));
        } catch {
          models[provider.id] = [];
        }
      }
      return { providers, models, current: { provider: cfg.llm.provider, model: cfg.llm.model } };
    },

    configGet: async () => ({
      llm: { ...cfg.llm },
      report: {
        polish: cfg.report.polish,
        save_local: cfg.report.save_local,
        format: cfg.report.format,
        local_dir: expandHome(cfg.report.local_dir),
        default_dir: expandHome(DEFAULT_REPORT_DIR),
        dir_options: dirOptions()
      },
      notify: {
        channels: [...cfg.notify.channels],
        summary_max_chars: cfg.notify.summary_max_chars,
        receiver_mid: String(cfg.notify.bili_dm.receiver_mid ?? ''),
        effective_receiver: String(effectiveNotifyConfig().bili_dm.receiver_mid ?? ''),
        receiver_source: effectiveNotifyConfig().bili_dm.receiver_source ?? null,
        email: {
          host: cfg.notify.email.host,
          port: cfg.notify.email.port,
          secure: cfg.notify.email.secure,
          user: cfg.notify.email.user,
          pass_set: cfg.notify.email.pass.length > 0,
          from: cfg.notify.email.from,
          to: cfg.notify.email.to,
          from_name: cfg.notify.email.from_name,
          subject_prefix: cfg.notify.email.subject_prefix,
          attach_report: cfg.notify.email.attach_report,
          allow_plain: cfg.notify.email.allow_plain,
          timeout_ms: cfg.notify.email.timeout_ms,
          retries: cfg.notify.email.retries,
          backoff_ms: cfg.notify.email.backoff_ms
        }
      },
      defaults: { report_prompt: DEFAULT_REPORT_PROMPT, dm_prompt: DEFAULT_DM_PROMPT },
      schedule: scheduleSnapshot(),
      overrides,
      settings_file: settingsFile(stateDir),
      model_ready: modelTarget(cfg) !== null
    }),

    dirCheck: async ({ value }) => checkDir(value),

    configSet: async ({ patch }) => {
      const { patch: clean, rejected } = pickEditable(patch);
      if (Object.keys(clean).length === 0) {
        throw new Error('没有可写入的字段' + (rejected.length > 0 ? '：' + rejected.join('、') : ''));
      }
      const saved = saveOverrides(stateDir, clean);
      reloadConfig();
      if ('schedule' in clean) {
        armScheduler();
        log('info', '定时规则已更新：' + cfg.schedule.mode + ' / ' + cfg.schedule.window + ' / ' + (cfg.schedule.cron || defaultCronFor(cfg.schedule.mode)));
      }
      return {
        applied: clean,
        rejected,
        overrides: saved,
        effective: {
          llm: { ...cfg.llm },
          report_polish: cfg.report.polish,
          report: {
            save_local: cfg.report.save_local,
            format: cfg.report.format,
            local_dir: expandHome(cfg.report.local_dir)
          },
          channels: [...cfg.notify.channels],
          summary_max_chars: cfg.notify.summary_max_chars,
          email: {
            host: cfg.notify.email.host,
            port: cfg.notify.email.port,
            secure: cfg.notify.email.secure,
            from: cfg.notify.email.from,
            to: cfg.notify.email.to,
            attach_report: cfg.notify.email.attach_report,
            configured: Boolean(cfg.notify.email.host && cfg.notify.email.from && cfg.notify.email.to)
          },
          receiver_mid: String(cfg.notify.bili_dm.receiver_mid ?? ''),
          effective_receiver: String(effectiveNotifyConfig().bili_dm.receiver_mid ?? ''),
          receiver_source: effectiveNotifyConfig().bili_dm.receiver_source ?? null,
          schedule: scheduleSnapshot(),
          model_ready: modelTarget(cfg) !== null
        }
      };
    },

    intentGet: async () => {
      const state = loadState(stateDir);
      return {
        intention: state.intention
          ? { text: state.intention.text, created_at: state.intention.created_at, days_since_set: daysSinceSet(state.intention) }
          : null
      };
    },

    intentSet: async ({ text }) => {
      const clean = String(text ?? '').trim();
      if (clean.length === 0) throw new Error('计划不能为空');
      const state = loadState(stateDir);
      const intention = setIntention(state, clean, { source: 'settings' });
      saveState(stateDir, state);
      return { intention };
    },

    loginStart: async ({ role, channel }) => startLogin(role, { channel }),

    loginPoll: async ({ qrcodeKey, waitSeconds }) => pollLogin({ qrcodeKey, waitSeconds: waitSeconds ?? 0 }),

    loginLogout: async ({ role }) => {
      const who = role === 'sender' ? 'sender' : 'reader';
      const creds = loadCreds(stateDir);
      saveCreds(stateDir, { ...creds, [who]: null, pending: null });
      return { role: who, logged_out: true, login: describeLoginSlot(who) };
    },

    runNow: async ({ mode, window: windowArg }) => {
      const { run, facts } = await collectRun({ mode: mode || undefined, window: windowArg || undefined });
      const state = loadState(stateDir);
      const hypotheses = state.hypotheses.filter((h) => h.run_id === run.id);
      const rendered = await renderReport(run, hypotheses);
      return {
        run_id: run.id,
        total_items: facts.total_items,
        shape: run.shape,
        shape_label: rendered.shape_label,
        shape_source: rendered.shape_source,
        confidence: run.confidence,
        hypotheses_count: rendered.hypotheses.length,
        hypotheses_source: rendered.hypotheses_source,
        paths: rendered.paths,
        summary: rendered.summary,
        narrative: rendered.narrative,
        polished: rendered.polished,
        polish_reason: rendered.polish_reason,
        polish_message: rendered.polish_message
      };
    },

    notifyTest: (payload) => runNotifyTest(payload ?? {}),

    /** 设置页的「发送测试邮件」：只走邮件渠道，其它渠道一概不碰。 */
    emailTest: (payload) => runNotifyTest({ ...(payload ?? {}), only: 'email' }),

    reportLatest: async () => {
      const state = loadState(stateDir);
      const run = state.runs[0] ?? null;
      if (!run) return { run: null };
      const saved = state.hypotheses.filter((h) => h.run_id === run.id);
      const hypotheses = Array.isArray(run.generated?.hypotheses) && run.generated.hypotheses.length > 0 ? run.generated.hypotheses : saved;
      const shape = run.generated?.shape ?? null;
      const markdown = renderMarkdown(run.facts, { hypotheses, narrative: run.generated?.overview ?? null, shape, timeZone: zone });
      return {
        run: { id: run.id, created_at: run.created_at, total_items: run.total_items, shape: run.shape, shape_label: shape?.label ?? null },
        summary: buildSummary(run.facts, { maxChars: cfg.notify.summary_max_chars }),
        markdown_preview: markdown.slice(0, 1500),
        report_dir: expandHome(cfg.report.local_dir)
      };
    }
  };

  /** 把设置页接口挂到宿主 webServer；没有该服务（例如纯终端环境）时只记一条日志。 */
  function mountApi(scope) {
    let server;
    try {
      server = typeof scope.get === 'function' ? scope.get('webServer') : scope.webServer;
    } catch {
      server = undefined;
    }
    if (!server || typeof server.register !== 'function') {
      log('info', '没有 webServer 服务，设置页动作入口未挂载（工具入口不受影响）');
      return;
    }
    scope.effect(() => registerApi(server, apiHandlers, { log }), 'bili-statistics:api');
    log('info', '设置页接口已挂载：' + API_PREFIX);
  }

  try {
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mountApi);
    else mountApi(ctx);
  } catch (error) {
    log('warn', '设置页接口挂载失败：' + (error?.message ?? String(error)));
  }

  startScheduler();
  log('info', 'bili-statistics 已加载：mode=' + cfg.schedule.mode + ' timezone=' + zone + ' channels=' + cfg.notify.channels.join(','));
}

export const name = 'bili-statistics';