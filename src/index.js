/**
 * dsh-bili-statistics 宿主入口。
 * 职责：注册 bili_intent_* 工具、按配置定时统计、把统计事实与计划情况落盘并投递私信。
 * 报告里的概览与计划情况由插件自己调用宿主 LLM 生成（可在设置页关闭），会话里的模型也可以用 annotate 覆盖。
 */
import { buildCookieHeader } from './adapters/bili.js';
import { nextCronFire, defaultCronFor } from './domain/time.js';
import { registerApi, API_PREFIX } from './transport/api.js';
import { loadOverrides } from './core/store.js';
import { DEFAULT_CONFIG, DEFAULT_REPORT_DIR, NOTIFY_CHANNELS, normalizeConfig, pickExistingDir } from './config/defaults.js';
import { migrateLegacyStateDir } from './core/migrate.js';
import { createTools } from './tools/index.js';
import { createHandlers } from './transport/handlers.js';
import { collectRun as collectRunImpl } from './services/collect.js';
import { renderReport as renderReportImpl, composeDm as composeDmImpl, emailAttachment as emailAttachmentImpl } from './services/render.js';
import { statusSnapshot as statusSnapshotImpl } from './services/status.js';
import { startLogin as startLoginImpl, pollLogin as pollLoginImpl } from './services/login.js';
import { deliverAll } from './services/notify.js';
import {
  loadState,
  saveState,
  markNotified,
  recordScheduleEvent
} from './core/state.js';
import { expandHome, truncate, deepMerge } from './core/util.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCreds, cookieFrom, describeLogin } from './core/creds.js';


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
    const creds = loadCreds(stateDir);
    if (fromConfig.length > 0) {
      return { cookie: fromConfig, source: 'config', mid: String(cfg.bili?.mid ?? '').trim() || null };
    }
    if (creds.reader && creds.reader.sessdata) {
      return { cookie: cookieFrom(creds.reader), source: 'qr', mid: creds.reader.mid ?? null };
    }
    return { cookie: '', source: null, mid: null };
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

  /** 采集：拉历史 → 算 facts → 记账。见 services/collect.js。 */
  const collectRun = (options = {}) =>
    collectRunImpl(options, { stateDir, getConfig: () => cfg, readerCredentials });

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

  /** 报告渲染：模板正文 + 模型写的观看状态、概览与计划情况。见 services/render.js。 */
  const renderReport = (run, hypotheses, options = {}) =>
    renderReportImpl(run, hypotheses, options, { stateDir, getConfig: () => cfg, getLlm: llmService });

  /** 私信文案：模板摘要 + 模型按 dm_prompt 改写语气。见 services/render.js。 */
  const composeDm = (facts, options = {}) =>
    composeDmImpl(facts, options, { getConfig: () => cfg, getLlm: llmService });

  /** 邮件附件：仅在 attach_report 开启且渠道含 email 时准备。见 services/render.js。 */
  const emailAttachment = (facts, hypotheses = [], narrative = null, shape = null) =>
    emailAttachmentImpl(facts, hypotheses, narrative, shape, { getConfig: () => cfg });

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

  /** 状态快照：工具与设置页共用的只读汇总。见 services/status.js。 */
  const statusSnapshot = () =>
    statusSnapshotImpl({
      stateDir,
      getConfig: () => cfg,
      scheduleSnapshot,
      effectiveNotifyConfig,
      describeLoginSlot,
      readerCredentials
    });

  /** 扫码登录：生成二维码、轮询结果并落盘凭据。见 services/login.js。 */
  const startLogin = (role, options = {}) => startLoginImpl(role, options, { stateDir });

  const pollLogin = (options = {}) => pollLoginImpl(options, { stateDir });

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
  const apiHandlers = createHandlers({
    stateDir,
    getConfig: () => cfg,
    getOverrides: () => overrides,
    reloadConfig,
    armScheduler,
    log,
    statusSnapshot,
    scheduleSnapshot,
    llmService,
    effectiveNotifyConfig,
    describeLoginSlot,
    startLogin,
    pollLogin,
    collectRun,
    renderReport,
    runNotifyTest,
    dirOptions,
    checkDir
  });

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