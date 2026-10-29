/**
 * 状态快照：工具与设置页共用同一份字段，避免两处口径不一致。
 * 纯读：只读 state.json / credentials.json 与配置，不写任何文件。
 */
import { loadState, daysSinceSet } from '../core/state.js';
import { loadCreds } from '../core/creds.js';
import { nextCronFire, formatLocal, resolveWindow, defaultCronFor } from '../domain/time.js';
import { showMid, redact } from '../core/present.js';
import { expandHome } from '../core/util.js';
import { modelTarget } from './polish.js';

export function statusSnapshot({ stateDir, getConfig, scheduleSnapshot, effectiveNotifyConfig, describeLoginSlot, readerCredentials }) {
  const cfg = getConfig();
  const zone = cfg.schedule.timezone;
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
