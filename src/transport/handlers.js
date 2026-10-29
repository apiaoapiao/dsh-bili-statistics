/**
 * 设置页接口实现：与工具复用同一套函数（登录、统计、报告、通知），保证两边口径一致。
 * 宿主能力（采集、渲染、调度、状态快照）由 deps 注入，这里只做参数整理与返回。
 */
import { expandHome } from '../core/util.js';
import { loadState, saveState, setIntention, daysSinceSet } from '../core/state.js';
import { loadCreds, saveCreds } from '../core/creds.js';
import { saveOverrides, pickEditable, settingsFile } from '../core/store.js';
import { DEFAULT_REPORT_DIR } from '../config/defaults.js';
import { renderMarkdown, buildSummary } from '../domain/report.js';
import { defaultCronFor } from '../domain/time.js';
import { modelTarget, DEFAULT_REPORT_PROMPT, DEFAULT_DM_PROMPT } from '../services/polish.js';

export function createHandlers(deps) {
  const {
    stateDir,
    getConfig,
    getOverrides,
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
  } = deps;

  return {
    status: async () => statusSnapshot(),

    models: async () => {
      const cfg = getConfig();
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

    configGet: async () => {
      const cfg = getConfig();
      return {
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
      overrides: getOverrides(),
      settings_file: settingsFile(stateDir),
      model_ready: modelTarget(cfg) !== null
      };
    },

    dirCheck: async ({ value }) => checkDir(value),

    configSet: async ({ patch }) => {
      const { patch: clean, rejected } = pickEditable(patch);
      if (Object.keys(clean).length === 0) {
        throw new Error('没有可写入的字段' + (rejected.length > 0 ? '：' + rejected.join('、') : ''));
      }
      const saved = saveOverrides(stateDir, clean);
      reloadConfig();
      const cfg = getConfig();
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
      const cfg = getConfig();
      const zone = cfg.schedule.timezone;
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
}
