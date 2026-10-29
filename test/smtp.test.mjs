/**
 * SMTP 客户端回归：本机起一个假 SMTP 服务器（node:net，127.0.0.1 随机端口），
 * 逐条核对命令、认证凭据、MIME 结构与错误分支。
 * 运行：node test/smtp.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { sendMail, buildMessage, encodeHeader, SmtpError } from '../src/smtp.js';

const CRLF = '\r\n';

function startFakeSmtp({ authCode = 235, startTls = false, greeting = '220 fake.local ESMTP', failFirstData = false } = {}) {
  const log = [];
  const messages = [];
  let dataAttempts = 0;
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write(greeting + CRLF);
    let buffer = '';
    let mode = 'command';
    let data = '';
    let authStep = 0;
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        if (mode === 'data') {
          const end = buffer.indexOf(CRLF + '.' + CRLF);
          if (end < 0) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + CRLF.length + 1 + CRLF.length);
          mode = 'command';
          dataAttempts += 1;
          if (failFirstData && dataAttempts === 1) {
            socket.write('451 4.3.0 try again later' + CRLF);
          } else {
            messages.push(data);
            socket.write('250 2.0.0 queued as FAKE1' + CRLF);
          }
          data = '';
          continue;
        }
        const index = buffer.indexOf(CRLF);
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + CRLF.length);
        log.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          const lines = ['250-fake.local'];
          if (startTls) lines.push('250-STARTTLS');
          lines.push('250-AUTH LOGIN PLAIN');
          lines.push('250 8BITMIME');
          socket.write(lines.join(CRLF) + CRLF);
        } else if (upper === 'STARTTLS') {
          socket.write('220 2.0.0 go ahead' + CRLF);
        } else if (upper.startsWith('AUTH LOGIN')) {
          authStep = 1;
          socket.write('334 VXNlcm5hbWU6' + CRLF);
        } else if (authStep === 1) {
          authStep = 2;
          socket.write('334 UGFzc3dvcmQ6' + CRLF);
        } else if (authStep === 2) {
          authStep = 3;
          socket.write(authCode === 235 ? '235 2.7.0 accepted' + CRLF : '535 5.7.8 authentication failed' + CRLF);
        } else if (upper.startsWith('MAIL FROM')) {
          socket.write('250 2.1.0 ok' + CRLF);
        } else if (upper.startsWith('RCPT TO')) {
          socket.write('250 2.1.5 ok' + CRLF);
        } else if (upper === 'DATA') {
          mode = 'data';
          socket.write('354 end with <CRLF>.<CRLF>' + CRLF);
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 bye' + CRLF);
          socket.end();
        } else {
          socket.write('500 5.5.1 unknown' + CRLF);
        }
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        log,
        messages,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}

function headerLine(message, name) {
  const prefix = name.toLowerCase() + ': ';
  const line = message.split(CRLF).find((item) => item.toLowerCase().startsWith(prefix));
  return line ? line.slice(prefix.length) : '';
}

function decodeMimeWord(value) {
  const match = /^=\?UTF-8\?B\?(.+)\?=$/.exec(value);
  return match ? Buffer.from(match[1], 'base64').toString('utf8') : value;
}

function splitMessage(message) {
  const index = message.indexOf(CRLF + CRLF);
  return { head: message.slice(0, index), body: message.slice(index + 4) };
}

function decodeBase64(text) {
  return Buffer.from(text.split(CRLF).join(''), 'base64').toString('utf8');
}

const BASE = {
  host: '127.0.0.1',
  secure: false,
  allowPlain: true,
  user: 'me@qq.com',
  pass: 'AUTH_CODE_123',
  from: 'me@qq.com',
  to: 'me@qq.com',
  fromName: 'B站观看统计',
  subjectPrefix: '[B站观看统计]',
  text: '今天看了 12 条，深夜占 62%。',
  timeoutMs: 5000,
  retries: 0
};

test('能发出中文摘要：认证、信封、主题与正文都对', async () => {
  const fake = await startFakeSmtp();
  try {
    const result = await sendMail({ ...BASE, port: fake.port });
    assert.equal(result.ok, true);
    assert.equal(result.channel, 'email');
    assert.deepEqual(fake.log.slice(0, 6), [
      'EHLO dsh-bili-statistics',
      'AUTH LOGIN',
      Buffer.from('me@qq.com').toString('base64'),
      Buffer.from('AUTH_CODE_123').toString('base64'),
      'MAIL FROM:<me@qq.com>',
      'RCPT TO:<me@qq.com>'
    ]);
    assert.equal(fake.log[fake.log.length - 1], 'QUIT');
    const message = fake.messages[0];
    const subject = decodeMimeWord(headerLine(message, 'Subject'));
    assert.match(subject, /^\[B站观看统计\] B 站观看摘要 · \d{4}-\d{2}-\d{2}$/);
    const from = headerLine(message, 'From');
    assert.match(from, /<me@qq\.com>$/);
    assert.equal(decodeMimeWord(from.slice(0, from.indexOf(' <'))), 'B站观看统计');
    assert.equal(headerLine(message, 'To'), '<me@qq.com>');
    const { body } = splitMessage(message);
    assert.equal(decodeBase64(body), '今天看了 12 条，深夜占 62%。');
  } finally {
    await fake.close();
  }
});

test('开启附件时是 multipart/mixed，附件能还原成 Markdown', async () => {
  const fake = await startFakeSmtp();
  try {
    await sendMail({
      ...BASE,
      port: fake.port,
      text: '摘要正文',
      attachment: { filename: 'report-2026-10-28.md', content: '# 报告\n\n- 12 条' }
    });
    const message = fake.messages[0];
    const type = headerLine(message, 'Content-Type');
    assert.match(type, /^multipart\/mixed; boundary="dsh-[0-9a-f]+"$/);
    const boundary = /boundary="([^"]+)"/.exec(type)[1];
    const segments = message.split('--' + boundary);
    assert.equal(segments.length, 4);
    const textPart = segments[1];
    assert.equal(decodeBase64(textPart.slice(textPart.indexOf(CRLF + CRLF) + 4)), '摘要正文');
    const filePart = segments[2];
    assert.match(filePart, /Content-Disposition: attachment; filename="report-2026-10-28\.md"/);
    assert.match(filePart, /Content-Type: text\/markdown; charset=utf-8/);
    assert.equal(decodeBase64(filePart.slice(filePart.indexOf(CRLF + CRLF) + 4)), '# 报告\n\n- 12 条');
    assert.equal(segments[3], '--');
  } finally {
    await fake.close();
  }
});

test('认证失败直接抛错且只试一次', async () => {
  const fake = await startFakeSmtp({ authCode: 535 });
  try {
    await assert.rejects(
      () => sendMail({ ...BASE, port: fake.port, retries: 3, backoffMs: 1 }),
      (error) => {
        assert.ok(error instanceof SmtpError);
        assert.equal(error.code, 535);
        assert.equal(error.retryable, false);
        assert.match(error.message, /AUTH 失败：535/);
        return true;
      }
    );
    assert.equal(fake.log.filter((line) => line.toUpperCase() === 'AUTH LOGIN').length, 1);
    assert.equal(fake.messages.length, 0);
  } finally {
    await fake.close();
  }
});

test('服务器不宣告 STARTTLS 时不退回明文', async () => {
  const fake = await startFakeSmtp();
  try {
    await assert.rejects(
      () => sendMail({ ...BASE, port: fake.port, allowPlain: false }),
      /没有宣告 STARTTLS/
    );
    assert.equal(fake.log.filter((line) => line.startsWith('AUTH')).length, 0);
    assert.equal(fake.messages.length, 0);
  } finally {
    await fake.close();
  }
});

test('4xx 会重试一次并最终成功', async () => {
  const fake = await startFakeSmtp({ failFirstData: true });
  try {
    const result = await sendMail({ ...BASE, port: fake.port, retries: 1, backoffMs: 1 });
    assert.equal(result.ok, true);
    assert.equal(fake.log.filter((line) => line.startsWith('EHLO')).length, 2);
    assert.equal(fake.messages.length, 1);
  } finally {
    await fake.close();
  }
});

test('地址与正文在本地校验，不碰网络', async () => {
  await assert.rejects(() => sendMail({ ...BASE, host: '  ', port: 465 }), /缺少 SMTP 主机/);
  await assert.rejects(() => sendMail({ ...BASE, port: 465, from: 'not-an-email' }), /发件地址不是合法邮箱地址/);
  await assert.rejects(() => sendMail({ ...BASE, port: 465, to: '' }), /缺少收件地址/);
  await assert.rejects(() => sendMail({ ...BASE, port: 70000 }), /SMTP 端口非法/);
  await assert.rejects(() => sendMail({ ...BASE, port: 465, text: '   ' }), /邮件正文为空/);
});

test('buildMessage 与 encodeHeader 的细节', () => {
  assert.equal(encodeHeader('plain subject'), 'plain subject');
  assert.equal(encodeHeader('B站观看统计'), '=?UTF-8?B?' + Buffer.from('B站观看统计', 'utf8').toString('base64') + '?=');
  const message = buildMessage({ from: 'a@b.com', to: 'c@d.com', subject: 'plain', text: 'line1\nline2' });
  assert.match(message, /^Content-Type: text\/plain; charset=utf-8/m);
  const { body } = splitMessage(message);
  assert.equal(decodeBase64(body), 'line1\r\nline2');
  assert.match(message, /\r\n$/);
});
