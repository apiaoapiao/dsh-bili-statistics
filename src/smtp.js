/**
 * 最小 SMTP 客户端：只做一件事——把一段纯文本（可选附带一个 Markdown 附件）发出去。
 * 为什么不用 nodemailer：本机 npm 安装被沙箱拦（EPERM），而 SMTP 协议本身足够简单，
 * 用 node:net / node:tls 说一遍，反而少一个运行时依赖与一处供应链风险。
 * 只支持 AUTH LOGIN（QQ / 163 / Gmail 都支持），不实现 OAuth2 与 SMTPUTF8。
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { realSleep } from './util.js';

const CRLF = '\r\n';
const CRLF_BUFFER = Buffer.from(CRLF);
const EHLO_NAME = 'dsh-bili-statistics';
const ADDRESS_RE = /^[^@\s]+@[^@\s]+$/;

export class SmtpError extends Error {
  constructor(message, { code = null, command = null, retryable = false } = {}) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    this.command = command;
    this.retryable = retryable;
  }
}

/** RFC 2047：主题、显示名里出现非 ASCII 字符时用 base64 编码字，否则原样。 */
export function encodeHeader(text) {
  const value = String(text ?? '');
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return '=?UTF-8?B?' + Buffer.from(value, 'utf8').toString('base64') + '?=';
}

function formatAddress(name, address) {
  const addr = String(address ?? '').trim();
  const display = String(name ?? '').trim();
  return display.length > 0 ? encodeHeader(display) + ' <' + addr + '>' : '<' + addr + '>';
}

/** base64 每 76 字符折行（MIME 惯例），顺带保证不会出现以 "." 开头的行。 */
function wrap76(base64) {
  const text = String(base64);
  const lines = [];
  for (let index = 0; index < text.length; index += 76) lines.push(text.slice(index, index + 76));
  return lines.join(CRLF);
}

function randomToken() {
  return crypto.randomBytes(12).toString('hex');
}

/**
 * 组装一封 MIME 邮件。正文与附件都用 base64，避免中文编码、
 * 8bit 传输与行首点（dot-stuffing）三类坑。
 */
export function buildMessage({ from, to, fromName = '', subject = '', text = '', attachment = null, now = Date.now() }) {
  const headers = [
    'Date: ' + new Date(now).toUTCString(),
    'From: ' + formatAddress(fromName, from),
    'To: ' + formatAddress('', to),
    'Subject: ' + encodeHeader(subject),
    'Message-ID: <' + randomToken() + '@dsh-bili-statistics>',
    'MIME-Version: 1.0',
    'X-Mailer: dsh-bili-statistics'
  ];
  const bodyText = String(text ?? '').replace(/\r?\n/g, CRLF);
  if (attachment && attachment.content) {
    const boundary = 'dsh-' + randomToken();
    const filename = String(attachment.filename ?? 'report.md').replace(/["\r\n\\]/g, '');
    headers.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
    const textPart = [
      '--' + boundary,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(Buffer.from(bodyText, 'utf8').toString('base64'))
    ].join(CRLF);
    const filePart = [
      '--' + boundary,
      'Content-Type: text/markdown; charset=utf-8; name="' + filename + '"',
      'Content-Disposition: attachment; filename="' + filename + '"',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(Buffer.from(String(attachment.content), 'utf8').toString('base64'))
    ].join(CRLF);
    const body = textPart + CRLF + filePart + CRLF + '--' + boundary + '--';
    return headers.join(CRLF) + CRLF + CRLF + body + CRLF;
  }
  headers.push('Content-Type: text/plain; charset=utf-8');
  headers.push('Content-Transfer-Encoding: base64');
  return headers.join(CRLF) + CRLF + CRLF + wrap76(Buffer.from(bodyText, 'utf8').toString('base64')) + CRLF;
}

/** 一条 SMTP 会话：按行读写，多行响应以 "250-" 续、"250 " 收尾。 */
class Session {
  constructor(socket, { timeoutMs = 20000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.buffer = Buffer.alloc(0);
    this.lines = [];
    this.pending = null;
    this.timer = null;
    this.failure = null;
    this.socket = null;
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new SmtpError('连接被服务器关闭', { retryable: true })));
  }

  /** STARTTLS：先把明文 socket 的监听摘掉，再升级，避免同一批字节被解析两次。 */
  async upgradeTls({ host }) {
    const previous = this.socket;
    previous.removeAllListeners('data');
    previous.removeAllListeners('error');
    previous.removeAllListeners('close');
    const next = await new Promise((resolve, reject) => {
      const socket = tls.connect({ socket: previous, servername: host, rejectUnauthorized: true }, () => resolve(socket));
      socket.once('error', reject);
    });
    this.attach(next);
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let index;
    while ((index = this.buffer.indexOf(CRLF_BUFFER)) >= 0) {
      const line = this.buffer.subarray(0, index).toString('utf8');
      this.buffer = this.buffer.subarray(index + CRLF_BUFFER.length);
      this.lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) this.settle();
    }
  }

  settle() {
    const lines = this.lines;
    this.lines = [];
    if (!this.pending) return;
    const last = lines[lines.length - 1] ?? '000';
    const reply = { code: Number(last.slice(0, 3)), lines, text: lines.map((line) => line.slice(4)).join('\n') };
    const { resolve } = this.pending;
    this.pending = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    resolve(reply);
  }

  read() {
    return new Promise((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      this.pending = { resolve, reject };
      this.timer = setTimeout(() => {
        this.fail(new SmtpError('等待服务器响应超时（' + this.timeoutMs + ' ms）', { retryable: true }));
      }, this.timeoutMs);
    });
  }

  fail(error) {
    if (this.failure) return;
    this.failure =
      error instanceof SmtpError ? error : new SmtpError('SMTP 网络错误：' + (error?.message ?? String(error)), { retryable: true });
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const pending = this.pending;
    this.pending = null;
    if (pending) pending.reject(this.failure);
    try {
      this.socket?.destroy();
    } catch {
      // 已经断开就无所谓
    }
  }

  send(line) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.socket.write(line + CRLF, (error) => (error ? reject(error) : resolve()));
    });
  }

  async command(line, expected, label = null) {
    await this.send(line);
    const reply = await this.read();
    if (!expected.includes(reply.code)) {
      // 认证阶段发出去的是 base64 凭据，用固定的 AUTH 作前缀，既不泄露密码也便于排查
      const verb = label ?? line.split(' ')[0];
      throw new SmtpError('SMTP ' + verb + ' 失败：' + reply.code + ' ' + reply.text, {
        code: reply.code,
        command: verb,
        retryable: reply.code >= 400 && reply.code < 500
      });
    }
    return reply;
  }

  /** DATA 阶段：354 之后发正文，行首的点做 dot-stuffing，最后一行是单个 "."。 */
  async data(message) {
    await this.command('DATA', [354]);
    const stuffed = String(message)
      .split(CRLF)
      .map((line) => (line.startsWith('.') ? '.' + line : line))
      .join(CRLF);
    const trimmed = stuffed.endsWith(CRLF) ? stuffed.slice(0, -CRLF.length) : stuffed;
    await this.send(trimmed + CRLF + '.');
    const reply = await this.read();
    if (reply.code !== 250) {
      throw new SmtpError('SMTP DATA 失败：' + reply.code + ' ' + reply.text, {
        code: reply.code,
        command: 'DATA',
        retryable: reply.code >= 400 && reply.code < 500
      });
    }
    return reply;
  }
}

/** 默认连接器：secure=true 直接 TLS（465），否则明文连接后用 STARTTLS 升级（587）。 */
export function defaultConnect({ host, port, secure, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    const readyEvent = secure ? 'secureConnect' : 'connect';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SmtpError('连接 SMTP 服务器超时：' + host + ':' + port, { retryable: true }));
    }, timeoutMs);
    socket.once(readyEvent, () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(new SmtpError('连接 SMTP 服务器失败（' + host + ':' + port + '）：' + (error?.message ?? String(error)), { retryable: true }));
    });
  });
}

function checkAddress(value, label) {
  const text = String(value ?? '').trim();
  if (text.length === 0) throw new SmtpError('缺少' + label, { retryable: false });
  if (!ADDRESS_RE.test(text)) throw new SmtpError(label + '不是合法邮箱地址：' + text, { retryable: false });
  return text;
}

async function deliverOnce({
  host,
  port,
  secure,
  allowPlain,
  user,
  pass,
  from,
  to,
  fromName,
  subject,
  text,
  attachment,
  timeoutMs,
  connect,
  now
}) {
  const socket = await connect({ host, port, secure, timeoutMs });
  const session = new Session(socket, { timeoutMs });
  try {
    const greeting = await session.read();
    if (greeting.code !== 220) {
      throw new SmtpError('服务器未返回 220 欢迎语：' + greeting.code + ' ' + greeting.text, { code: greeting.code });
    }
    let ehlo = await session.command('EHLO ' + EHLO_NAME, [250]);
    if (!secure) {
      const startTls = ehlo.lines.some((line) => line.slice(4).trim().toUpperCase().startsWith('STARTTLS'));
      if (startTls) {
        await session.command('STARTTLS', [220]);
        await session.upgradeTls({ host });
        ehlo = await session.command('EHLO ' + EHLO_NAME, [250]);
      } else if (!allowPlain) {
        throw new SmtpError('服务器没有宣告 STARTTLS，而当前配置要求加密传输：请改用 465 + 隐式 TLS，或确认端口正确', {
          retryable: false
        });
      }
    }
    if (user) {
      const authAdvertised = ehlo.lines.some((line) => {
        const capability = line.slice(4).trim().toUpperCase();
        return capability === 'AUTH' || capability.startsWith('AUTH ') || capability.startsWith('AUTH=');
      });
      if (!authAdvertised) throw new SmtpError('服务器没有宣告 AUTH，无法登录发信', { retryable: false });
      await session.command('AUTH LOGIN', [334], 'AUTH');
      await session.command(Buffer.from(user, 'utf8').toString('base64'), [334], 'AUTH');
      await session.command(Buffer.from(pass ?? '', 'utf8').toString('base64'), [235], 'AUTH');
    }
    await session.command('MAIL FROM:<' + from + '>', [250]);
    await session.command('RCPT TO:<' + to + '>', [250, 251]);
    await session.data(buildMessage({ from, to, fromName, subject, text, attachment, now }));
    await session.command('QUIT', [221]).catch(() => {});
    return { ok: true, channel: 'email', host, port, to, subject };
  } finally {
    try {
      session.socket?.destroy();
    } catch {
      // 已经断开
    }
  }
}

/**
 * 发一封邮件。失败按 retries 重试（仅网络错误与 4xx），认证/地址类错误直接抛。
 * @returns {{ok: true, channel: 'email', host: string, port: number, to: string, subject: string}}
 */
export async function sendMail({
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
  text,
  attachment = null,
  timeoutMs = 20000,
  retries = 1,
  backoffMs = 2000,
  connect = defaultConnect,
  sleep = realSleep,
  now = Date.now()
} = {}) {
  const cleanHost = String(host ?? '').trim();
  if (cleanHost.length === 0) throw new SmtpError('缺少 SMTP 主机', { retryable: false });
  const portNumber = Number(port);
  if (!Number.isFinite(portNumber) || portNumber <= 0 || portNumber > 65535) {
    throw new SmtpError('SMTP 端口非法：' + String(port), { retryable: false });
  }
  const addrFrom = checkAddress(from, '发件地址');
  const addrTo = checkAddress(to, '收件地址');
  const body = String(text ?? '').trim();
  if (body.length === 0) throw new SmtpError('邮件正文为空', { retryable: false });
  const prefix = String(subjectPrefix ?? '').trim();
  const stamp = new Date(now).toISOString().slice(0, 10);
  const subject = (prefix.length > 0 ? prefix + ' ' : '') + 'B 站观看摘要 · ' + stamp;

  const maxAttempts = Math.max(0, Math.min(5, Math.round(Number(retries) || 0)));
  let lastError = null;
  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 0) await sleep(Math.max(0, Number(backoffMs) || 0) * attempt);
    try {
      return await deliverOnce({
        host: cleanHost,
        port: portNumber,
        secure: secure !== false,
        allowPlain: allowPlain === true,
        user: String(user ?? ''),
        pass: String(pass ?? ''),
        from: addrFrom,
        to: addrTo,
        fromName,
        subject,
        text: body,
        attachment,
        timeoutMs,
        connect,
        now
      });
    } catch (error) {
      lastError =
        error instanceof SmtpError
          ? error
          : new SmtpError('邮件发送失败：' + (error?.message ?? String(error)), { retryable: true });
      if (!lastError.retryable) throw lastError;
    }
  }
  throw lastError;
}
