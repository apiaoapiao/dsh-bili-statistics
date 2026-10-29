/** 通知投递：B 站私信与邮件。全部可注入 fetch/sleep/connect，便于离线测试。 */
import { realSleep } from '../core/util.js';
import { sendMail } from '../adapters/smtp.js';

const IM_URL = 'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg';

export class NotifyError extends Error {
  constructor(message, { channel, code, retryable = false } = {}) {
    super(message);
    this.name = 'NotifyError';
    this.channel = channel ?? null;
    this.code = code ?? null;
    this.retryable = retryable;
  }
}

function formEncode(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) search.append(key, String(value));
  return search.toString();
}

/**
 * 发一条 B 站私信。sender 与 receiver 必须是不同 uid（相同会被接口拒绝，code 21026）。
 * content 会以纯文本形式放进 msg[content] 的 JSON 里。
 */
export async function sendBiliDm({
  senderSessdata,
  senderBiliJct,
  senderMid,
  receiverMid,
  content,
  fetchImpl = globalThis.fetch,
  sleep = realSleep,
  retries = 2,
  backoffMs = 2000,
  timeoutMs = 15000,
  signal
} = {}) {
  if (!senderSessdata) throw new NotifyError('缺少发送方 SESSDATA', { channel: 'bili_dm' });
  if (!senderBiliJct) throw new NotifyError('缺少发送方 bili_jct（csrf）', { channel: 'bili_dm' });
  const from = Number(senderMid);
  const to = Number(receiverMid);
  if (!Number.isFinite(from) || from <= 0) throw new NotifyError('发送方 uid 非法', { channel: 'bili_dm' });
  if (!Number.isFinite(to) || to <= 0) {
    throw new NotifyError('接收方 uid 非法：还没设置接收方 UID（设置页“接收方 UID”，或先扫码登录读历史账号，会自动发给它）', {
      channel: 'bili_dm'
    });
  }
  if (from === to) throw new NotifyError('发送方与接收方是同一个 uid，接口会拒绝私信', { channel: 'bili_dm' });

  const text = String(content ?? '').trim();
  if (text.length === 0) throw new NotifyError('私信内容为空', { channel: 'bili_dm' });

  const body = formEncode({
    'msg[sender_uid]': from,
    'msg[receiver_id]': to,
    'msg[receiver_type]': 1,
    'msg[msg_type]': 1,
    'msg[content]': JSON.stringify({ content: text }),
    'msg[dev_id]': globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-dsh`,
    'msg[timestamp]': Math.floor(Date.now() / 1000),
    csrf: senderBiliJct
  });

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(backoffMs * attempt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(IM_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: `SESSDATA=${senderSessdata}; bili_jct=${senderBiliJct}`,
          Referer: 'https://message.bilibili.com/',
          Origin: 'https://message.bilibili.com',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
        },
        body,
        signal: signal ?? controller.signal
      });
      const payload = await response.json().catch(() => null);
      const code = Number(payload?.code ?? -1);
      if (response.ok && code === 0) return { ok: true, channel: 'bili_dm', code, payload };
      if (code === -111) throw new NotifyError('csrf 校验失败（-111）：bili_jct 与 SESSDATA 不匹配或已过期', { channel: 'bili_dm', code });
      if (code === 21026) throw new NotifyError('接收方不可用（21026）：不能给自己发私信，或对方拒收', { channel: 'bili_dm', code });
      if (code === -352 || code === -412 || response.status === 412 || response.status === 429) {
        lastError = new NotifyError(`私信接口风控或限流（code ${code}，HTTP ${response.status}）`, { channel: 'bili_dm', code, retryable: true });
        continue;
      }
      throw new NotifyError(`私信发送失败：code=${code} ${payload?.message ?? ''}`, { channel: 'bili_dm', code });
    } catch (error) {
      if (error instanceof NotifyError) {
        if (error.retryable && attempt < retries) {
          lastError = error;
          continue;
        }
        throw error;
      }
      lastError = new NotifyError(`私信请求异常：${error?.message ?? error}`, { channel: 'bili_dm', retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new NotifyError('私信发送失败（未知原因）', { channel: 'bili_dm' });
}

/**
 * 发一封摘要邮件。邮件渠道只承载那条 ≤200 字摘要（可选附带 Markdown 报告的附件），
 * 不携带原始观看记录、Cookie 或 SMTP 授权码。
 */
export async function sendEmail({
  host,
  port = 465,
  secure = true,
  allowPlain = false,
  user = '',
  pass = '',
  from,
  to,
  fromName = '',
  subjectPrefix = '',
  content,
  attachment = null,
  timeoutMs = 20000,
  retries = 1,
  backoffMs = 2000,
  connect,
  sleep = realSleep,
  now
} = {}) {
  if (!String(host ?? '').trim()) {
    throw new NotifyError('还没有配置 SMTP 主机：请到设置页「邮件通知」填好主机、端口与授权码', { channel: 'email' });
  }
  const text = String(content ?? '').trim();
  if (text.length === 0) throw new NotifyError('邮件内容是空的', { channel: 'email' });
  const file = attachment && attachment.content ? attachment : null;
  try {
    const result = await sendMail({
      host,
      port,
      secure,
      allowPlain,
      user,
      pass,
      from,
      to,
      fromName,
      subjectPrefix,
      text,
      attachment: file,
      timeoutMs,
      retries,
      backoffMs,
      connect,
      sleep,
      now
    });
    return { ...result, channel: 'email', attached: Boolean(file) };
  } catch (error) {
    throw new NotifyError('邮件发送失败：' + (error?.message ?? String(error)), {
      channel: 'email',
      code: error?.code ?? null,
      retryable: error?.retryable === true
    });
  }
}

/**
 * 按 config.channels 的顺序依次投递。返回每个渠道的结果；任一成功即记 delivered。
 * 单个渠道失败只影响它自己：私信挂了照样发邮件，也不影响报告落盘。
 * attachment 只在邮件渠道使用（{ filename, content }），其它渠道忽略。
 */
export async function deliverAll(config, { content, attachment = null, deps = {} } = {}) {
  const results = [];
  const channels = Array.isArray(config?.channels) ? config.channels : [];
  for (const channel of channels) {
    try {
      if (channel === 'bili_dm') {
        const dm = config?.bili_dm ?? {};
        const result = await sendBiliDm({
          ...deps.biliDmDeps,
          senderSessdata: dm.sender_sessdata,
          senderBiliJct: dm.sender_bili_jct,
          senderMid: dm.sender_mid,
          receiverMid: dm.receiver_mid,
          content
        });
        results.push(result);
      } else if (channel === 'email') {
        const email = config?.email ?? {};
        const result = await sendEmail({
          ...deps.emailDeps,
          host: email.host,
          port: email.port,
          secure: email.secure !== false,
          allowPlain: email.allow_plain === true,
          user: email.user,
          pass: email.pass,
          from: email.from,
          to: email.to,
          fromName: email.from_name,
          subjectPrefix: email.subject_prefix,
          content,
          attachment
        });
        results.push(result);
      } else {
        results.push({ ok: false, channel, error: `未知渠道 ${channel}` });
      }
    } catch (error) {
      results.push({ ok: false, channel, error: error?.message ?? String(error) });
    }
  }
  return { delivered: results.some((r) => r.ok), results };
}
