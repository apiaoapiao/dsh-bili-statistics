/**
 * 宿主侧集成测试：用假 ctx 与假 fetch 走一遍真实工具链。
 * 运行：node test/host.test.mjs
 * 注意：不要用 node --test，本沙箱禁止管道 stdio 子进程，会以 spawn EPERM 失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const zone = 'Asia/Shanghai';
const nowSec = Math.floor(Date.now() / 1000);
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: zone });
const YESTERDAY = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: zone });

/** 12 条历史：6 条低完成度（被动候选）、4 条高完成度、2 条中间值；间隔 60 秒，形成一条连续链。 */
function fixtureItems() {
  const plan = [
    ...Array.from({ length: 6 }, () => ({ progress: 40, duration: 600 })),
    ...Array.from({ length: 4 }, () => ({ progress: 595, duration: 600 })),
    ...Array.from({ length: 2 }, () => ({ progress: 300, duration: 600 }))
  ];
  return plan.map((entry, index) => ({
    title: '视频 ' + (index + 1),
    long_title: '第 ' + (index + 1) + ' 集',
    author_name: index < 3 ? '同一作者' : '作者 ' + index,
    author_mid: 100 + index,
    bvid: 'BV' + String(index).padStart(10, '0'),
    view_at: nowSec - (plan.length - index) * 60,
    progress: entry.progress,
    duration: entry.duration,
    business: 'archive'
  }));
}

const realFetch = globalThis.fetch;
let fetchHandler = async () => {
  throw new Error('测试里没有安装 fetch 处理器');
};
globalThis.fetch = (url, init) => fetchHandler(String(url), init ?? {});

function historyResponse() {
  const pageCalls = { count: 0 };
  return async () => {
    pageCalls.count += 1;
    const list = pageCalls.count === 1 ? fixtureItems() : [];
    return {
      status: 200,
      ok: true,
      json: async () => ({ code: 0, message: '0', data: { list, cursor: { max: 0, view_at: 0, business: '' } } })
    };
  };
}

function makeHarness(services = {}) {
  const tools = new Map();
  const disposers = [];
  const logs = [];
  const ctx = {
    logger: () => ({
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m])
    }),
    // 与真实 cordis 一致：effect 立即执行回调，返回的清理函数登记进 disposers。
    effect: (fn) => {
      const dispose = fn();
      const entry = typeof dispose === 'function' ? dispose : () => {};
      disposers.push(entry);
      return entry;
    },
    on: () => () => {},
    get: (name) => services[name],
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      }
    }
  };
  return { tools, logs, disposers, ctx };
}

const { apply } = await import('../lib/index.js');
const { sendBiliDm } = await import('../lib/notify.js');

function baseConfig(dir, overrides = {}) {
  return {
    bili: { sessdata: 'FAKE_SESSDATA', request_interval_ms: 0 },
    schedule: { enabled: false, mode: 'custom', timezone: zone, custom_from: YESTERDAY, custom_to: TODAY },
    report: { save_local: true, local_dir: path.join(dir, 'reports'), format: 'both', evidence_limit: 20 },
    notify: { channels: [], summary_max_chars: 200 },
    state_dir: dir,
    ...overrides
  };
}

function boot(dir, overrides, services) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const harness = makeHarness(services);
  apply(harness.ctx, baseConfig(dir, overrides));
  const call = (name, args) => harness.tools.get(name).execute(args ?? {}, { signal: undefined });
  return { ...harness, call };
}

const main = boot(path.join(here, '.tmp-main'));

test('注册九个工具且注入 tools', async () => {
  const { apply: applyAgain, inject } = await import('../lib/index.js');
  assert.equal(typeof applyAgain, 'function');
  assert.deepEqual(inject, ['tools']);
  assert.deepEqual([...main.tools.keys()].sort(), [
    'bili_intent_annotate',
    'bili_intent_facts',
    'bili_intent_feedback',
    'bili_intent_login',
    'bili_intent_login_poll',
    'bili_intent_notify',
    'bili_intent_report',
    'bili_intent_set',
    'bili_intent_status'
  ]);
  for (const definition of main.tools.values()) {
    assert.equal(typeof definition.description, 'string');
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.parameters.additionalProperties, false);
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.execute, 'function');
  }
});

test('set → facts → annotate → report → feedback → status 全链路', async () => {
  fetchHandler = historyResponse();

  const set = await main.call('bili_intent_set', { text: '每晚只看 30 分钟课程录播，不看推荐流。' });
  assert.match(set.intention.text, /课程录播/);
  assert.equal(set.intention.id.startsWith('intent'), true);

  const factsResult = await main.call('bili_intent_facts', {});
  assert.equal(typeof factsResult.run_id, 'string');
  assert.equal(factsResult.facts.total_items, 12);
  assert.equal(factsResult.facts.origin_inferred.passive_high_confidence, 6);
  assert.equal(factsResult.facts.origin_inferred.active_high_confidence, 4);
  assert.equal(factsResult.evidence.length, 12);
  assert.equal(factsResult.facts.passive_chain.max_consecutive, 6);
  assert.equal(factsResult.facts.intent_anchor.text, '每晚只看 30 分钟课程录播，不看推荐流。');
  assert.ok(factsResult.facts.baseline.note.includes('样本不足'));

  const annotate = await main.call('bili_intent_annotate', {
    hypotheses: [
      { text: '同一作者的短视频连续播放，完成度普遍低于 20%', evidence: [1, 2], clue: '下次统计看同作者连续段是否仍 ≤ 20%', certainty: 'inference' },
      { text: '深夜靠刷视频放松，说明我自律不够', evidence: [3, 4], certainty: 'inference' },
      { text: '', evidence: [1, 2] },
      { text: '这是一条超过长度上限的假设'.repeat(30), evidence: [1, 2] },
      { text: '证据不足的假设', evidence: [1] },
      { text: '引用越界', evidence: [99, 98] }
    ]
  });
  assert.equal(annotate.saved.length, 2);
  assert.deepEqual(annotate.tone_warnings, ['自律']);
  assert.equal(annotate.saved[0].evidence[0].includes('视频 1'), true);
  assert.equal(annotate.rejected.length, 4);
  const annotateText = main.tools.get('bili_intent_annotate').output.render({}, annotate)[0].text;
  assert.match(annotateText, /评价性措辞（自律）/);

  const report = await main.call('bili_intent_report', {});
  assert.equal(report.paths.length, 2);
  assert.ok(report.paths.some((item) => item.endsWith('.md')));
  assert.ok(report.paths.some((item) => item.endsWith('.html')));
  for (const file of report.paths) assert.equal(fs.existsSync(file), true);
  const markdown = fs.readFileSync(report.paths.find((item) => item.endsWith('.md')), 'utf8');
  assert.match(markdown, /同一作者的短视频连续播放/);
  assert.match(markdown, /硬事实|推断/);
  assert.equal(report.summary.length <= 200, true);

  const meta = main.tools.get('bili_intent_report').output.presentationMeta({}, report);
  assert.equal(meta.kind, 'bili-intent-report');
  assert.equal(meta.total_items, 12);
  assert.equal(meta.hypotheses.length, 2);
  assert.equal(meta.paths.length, 2);
  assert.equal(typeof meta.confidence, 'number');

  const feedback = await main.call('bili_intent_feedback', { verdict: 'accurate', note: '形态对上了' });
  assert.equal(feedback.feedback.verdict, 'accurate');

  const status = await main.call('bili_intent_status', {});
  assert.equal(status.run_count, 1);
  assert.equal(status.hypothesis_count, 2);
  assert.equal(status.feedback_count, 1);
  assert.equal(status.schedule.enabled, false);
  assert.equal(status.schedule.next_fire, null);
  assert.equal(status.bili.has_cookie, true);
  assert.equal(status.latest_run.total_items, 12);

  const dry = await main.call('bili_intent_notify', { dry_run: true });
  assert.equal(dry.dry_run, true);
  assert.ok(dry.content.length > 0);
  assert.equal(dry.content.length <= 200, true);

  await assert.rejects(() => main.call('bili_intent_notify', {}), /未配置通知渠道/);
});

test('render 与 metadata 形状对得上前端卡片', () => {
  const definition = main.tools.get('bili_intent_facts');
  assert.equal(definition.output.schema.type, 'object');
  const rendered = definition.output.render({}, {
    run: { id: 'run_x', facts: { window: { label: '今日' } } },
    facts: {
      window: { label: '今日' },
      total_items: 3,
      behavior_shape: { shape: 'mixed', confidence: 0.3 },
      completion_on_active: { mean_completion_rate: 0.5 },
      time_distribution: { after_22_share: 0.5 },
      passive_chain: { max_consecutive: 2 },
      repetition: { max_same_author_run: 2 }
    },
    evidence: [1, 2, 3]
  });
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /窗口 今日：3 条/);
  assert.match(rendered[0].text, /证据序号：1–3/);
});

test('B 站私信：配置字段映射、不做每日限制、csrf 失败', async () => {
  const dmCalls = [];
  let dmReply = { code: 0, message: '0' };
  const history = historyResponse();
  fetchHandler = async (url, init) => {
    if (url.includes('send_msg')) {
      dmCalls.push({ url, init });
      return { status: 200, ok: true, statusText: 'OK', json: async () => dmReply };
    }
    return history();
  };

  const harness = boot(path.join(here, '.tmp-dm'), {
    notify: {
      channels: ['bili_dm'],
      summary_max_chars: 200,
      bili_dm: { sender_sessdata: 'SENDER_SESSDATA', sender_bili_jct: 'SENDER_JCT', sender_mid: 111, receiver_mid: 222 }
    }
  });

  await harness.call('bili_intent_facts', {});
  const first = await harness.call('bili_intent_notify', {});
  assert.equal(first.delivered, true);
  assert.equal(dmCalls.length, 1);
  const body = new URLSearchParams(String(dmCalls[0].init.body));
  assert.equal(body.get('msg[sender_uid]'), '111');
  assert.equal(body.get('msg[receiver_id]'), '222');
  assert.equal(body.get('msg[receiver_type]'), '1');
  assert.equal(body.get('msg[msg_type]'), '1');
  assert.equal(body.get('csrf'), 'SENDER_JCT');
  assert.match(body.get('msg[content]'), /"content":"/);
  // csrf 校验会比对 cookie 里的 bili_jct 与表单 csrf，所以两者都要带
  assert.equal(dmCalls[0].init.headers.Cookie, 'SESSDATA=SENDER_SESSDATA; bili_jct=SENDER_JCT');

  const again = await harness.call('bili_intent_notify', {});
  assert.equal(again.delivered, true, '不做每日一次限制：同一天再发一次也要真发');
  assert.equal(dmCalls.length, 2);

  dmReply = { code: -111, message: 'csrf校验失败' };
  const failed = await harness.call('bili_intent_notify', {});
  assert.equal(failed.delivered, false);
  assert.match(failed.results[0].error, /csrf/);

  await assert.rejects(
    () => sendBiliDm({ senderSessdata: 'S', senderBiliJct: 'J', senderMid: 5, receiverMid: 5, content: 'x' }),
    /同一个 uid/
  );
  await assert.rejects(() => sendBiliDm({ senderSessdata: 'S', senderBiliJct: 'J', senderMid: 0, receiverMid: 5, content: 'x' }), /发送方 uid 非法/);
  assert.equal(dmCalls.length, 3);

  fs.rmSync(path.join(here, '.tmp-dm'), { recursive: true, force: true });
});

test('接收方 UID 缺省时回落到读历史账号，设置页可改', async () => {
  const dmCalls = [];
  const history = historyResponse();
  fetchHandler = async (url, init) => {
    if (url.includes('send_msg')) {
      dmCalls.push({ url, init });
      return { status: 200, ok: true, statusText: 'OK', json: async () => ({ code: 0, message: '0' }) };
    }
    return history();
  };

  const dir = path.join(here, '.tmp-receiver');
  fs.rmSync(dir, { recursive: true, force: true });
  const routes = [];
  const webServer = { register(route) { routes.push(route); return () => {}; } };
  const harness = boot(
    dir,
    { notify: { channels: ['bili_dm'], bili_dm: { sender_sessdata: '', sender_bili_jct: '', sender_mid: '', receiver_mid: '' } } },
    { webServer }
  );
  const api = (action, options) => hitApi(routes[0], action, options);

  // 只有扫码登录保存的两个账号，没有手填配置
  fs.writeFileSync(
    path.join(dir, 'credentials.json'),
    JSON.stringify({
      reader: { sessdata: 'READER_SESS', bili_jct: 'READER_JCT', mid: '555', uname: '读号', saved_at: '2026-10-27T00:00:00.000Z' },
      sender: { sessdata: 'SENDER_SESS', bili_jct: 'SENDER_JCT', mid: '666', uname: '发号', saved_at: '2026-10-27T00:00:00.000Z' },
      pending: null,
      channel: 'tv'
    })
  );

  const status = await harness.call('bili_intent_status');
  assert.match(status.notify.bili_dm_sender, /^666/);
  assert.match(status.notify.bili_dm_receiver, /^555/);
  assert.equal(status.notify.bili_dm_receiver_source, 'reader');

  await harness.call('bili_intent_facts', {});
  const sent = await harness.call('bili_intent_notify', {});
  assert.equal(sent.delivered, true);
  const body = new URLSearchParams(String(dmCalls[0].init.body));
  assert.equal(body.get('msg[sender_uid]'), '666');
  assert.equal(body.get('msg[receiver_id]'), '555');
  assert.equal(dmCalls[0].init.headers.Cookie, 'SESSDATA=SENDER_SESS; bili_jct=SENDER_JCT');

  // 设置页把接收方改成 777，覆盖回落值
  const cfg = await api('config-set', { method: 'POST', body: { patch: { notify: { bili_dm: { receiver_mid: '777' } } } } });
  assert.deepEqual(cfg.payload.data.rejected, []);
  assert.equal(cfg.payload.data.effective.effective_receiver, '777');
  assert.equal(cfg.payload.data.effective.receiver_source, 'config');

  const after = await harness.call('bili_intent_status');
  assert.match(after.notify.bili_dm_receiver, /^777/);
  assert.equal(after.notify.bili_dm_receiver_source, 'config');

  // 清空则回到回落
  const cleared = await api('config-set', { method: 'POST', body: { patch: { notify: { bili_dm: { receiver_mid: '' } } } } });
  assert.equal(cleared.payload.data.effective.effective_receiver, '555');
  fs.rmSync(dir, { recursive: true, force: true });
});


test('扫码登录：生成二维码 → 轮询确认 → 凭据落盘并复查', async () => {
  const KEY = 'abcdefabcdefabcdefabcdefabcdef01';
  const CRED_URL =
    'https://passport.biligame.com/crossDomain?DedeUserID=888888&DedeUserID__ckMd5=abc&SESSDATA=NEW_SESSDATA&bili_jct=NEW_JCT&gourl=x';
  const seen = [];
  const jsonResponse = (body) => ({ status: 200, ok: true, text: async () => JSON.stringify(body) });
  fetchHandler = async (url) => {
    seen.push(url);
    if (url.includes('/x/passport-login/web/qrcode/generate')) {
      return jsonResponse({
        code: 0,
        message: '0',
        data: { url: 'https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=' + KEY + '&from=', qrcode_key: KEY }
      });
    }
    if (url.includes('/x/passport-login/web/qrcode/poll')) {
      return jsonResponse({ code: 0, message: '0', data: { code: 0, message: '', url: CRED_URL } });
    }
    if (url.includes('/x/web-interface/nav')) {
      return jsonResponse({ code: 0, message: '0', data: { isLogin: true, mid: 888888, uname: '扫码号' } });
    }
    throw new Error('意外的请求：' + url);
  };

  const dir = path.join(here, '.tmp-login');
  const harness = boot(dir, { bili: { sessdata: '', request_interval_ms: 0 } });
  const call = (name, args) => harness.tools.get(name).execute(args ?? {}, { signal: undefined });

  const login = await call('bili_intent_login', { role: 'reader' });
  assert.equal(login.role, 'reader');
  assert.equal(login.qrcode_key, KEY);
  assert.equal(typeof login.dots, 'string');
  assert.ok(login.size >= 21, '二维码尺寸应为合法版本');
  assert.equal(login.expires_in_seconds, 180);

  const decision = harness.tools.get('bili_intent_login');
  assert.equal(decision.output.presentationMeta({}, login).kind, 'bili-intent-login');
  assert.equal(decision.output.presentationMeta({}, login).dots.length, login.dots.length);

  const poll = await call('bili_intent_login_poll', { wait_seconds: 0 });
  assert.equal(poll.state, 'confirmed');
  assert.equal(poll.mid, '888888');
  assert.equal(poll.uname, '扫码号');
  assert.equal(poll.usable, true);

  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'));
  assert.equal(stored.reader.sessdata, 'NEW_SESSDATA');
  assert.equal(stored.reader.bili_jct, 'NEW_JCT');
  assert.equal(stored.pending, null, '确认后应清掉待完成二维码');

  const status = await call('bili_intent_status');
  assert.equal(status.login.reader.logged_in, true);
  assert.equal(status.login.reader.source, 'qr');
  assert.equal(status.bili.has_cookie, true);
  assert.ok(seen.some((url) => url.includes('qrcode/generate')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('网页端扫码被 -412 拦截时自动切到 TV 通道并落盘凭据', async () => {
  const WEB_KEY = 'a'.repeat(32);
  const TV_CODE = 'cafebabecafebabecafebabecafebabe';
  const seen = [];
  const jsonResponse = (body) => ({ status: 200, ok: true, text: async () => JSON.stringify(body) });
  fetchHandler = async (url, init) => {
    seen.push(((init && init.method) || 'GET') + ' ' + url);
    if (url.includes('/x/passport-login/web/qrcode/generate')) {
      return jsonResponse({ code: 0, data: { url: 'https://account.bilibili.com/h5/scan?qrcode_key=' + WEB_KEY, qrcode_key: WEB_KEY } });
    }
    if (url.includes('/x/passport-login/web/qrcode/poll')) {
      return jsonResponse({ code: -412, message: 'request was banned', ttl: 1 });
    }
    if (url.includes('/x/passport-tv-login/qrcode/auth_code')) {
      return jsonResponse({
        code: 0,
        data: { url: 'https://passport.bilibili.com/x/passport-tv-login/h5/qrcode/auth?auth_code=' + TV_CODE, auth_code: TV_CODE }
      });
    }
    if (url.includes('/x/passport-tv-login/qrcode/poll')) {
      return jsonResponse({
        code: 0,
        data: {
          mid: 777777,
          cookie_info: {
            cookies: [
              { name: 'SESSDATA', value: 'TV_SESS' },
              { name: 'bili_jct', value: 'TV_JCT' },
              { name: 'DedeUserID', value: '777777' }
            ]
          }
        }
      });
    }
    if (url.includes('/x/web-interface/nav')) {
      return jsonResponse({ code: 0, data: { isLogin: true, mid: 777777, uname: '电视号' } });
    }
    throw new Error('意外的请求：' + url);
  };

  const dir = path.join(here, '.tmp-tv');
  fs.rmSync(dir, { recursive: true, force: true });
  const harness = boot(dir, { bili: { sessdata: '', request_interval_ms: 0 } });
  const call = (name, args) => harness.tools.get(name).execute(args ?? {}, { signal: undefined });

  const login = await call('bili_intent_login', { role: 'reader' });
  assert.equal(login.channel, 'web');
  assert.equal(login.qrcode_key, WEB_KEY);

  const first = await call('bili_intent_login_poll', { wait_seconds: 0 });
  assert.equal(first.state, 'switch');
  assert.equal(first.channel, 'tv');
  assert.match(first.message, /-412/);

  const stored1 = JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'));
  assert.equal(stored1.channel, 'tv', '应记住切到了 TV 通道');

  const tv = await call('bili_intent_login', { role: 'reader' });
  assert.equal(tv.channel, 'tv');
  assert.equal(tv.qrcode_key, TV_CODE);
  assert.ok(tv.url.includes('passport-tv-login'), 'TV 二维码应指向 TV 授权页');

  const done = await call('bili_intent_login_poll', { wait_seconds: 0 });
  assert.equal(done.state, 'confirmed');
  assert.equal(done.channel, 'tv');
  assert.equal(done.mid, '777777');
  assert.equal(done.uname, '电视号');

  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'));
  assert.equal(stored.reader.sessdata, 'TV_SESS');
  assert.equal(stored.reader.bili_jct, 'TV_JCT');
  assert.equal(stored.pending, null);
  assert.ok(seen.some((line) => line.startsWith('POST') && line.includes('passport-tv-login')));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 极简 http 请求/响应替身，只覆盖设置页接口用到的那几个方法。 */
function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: '', payload: null };
  res.setHeader = (key, value) => {
    res.headers[String(key).toLowerCase()] = value;
    return res;
  };
  res.end = (chunk) => {
    res.body = typeof chunk === 'string' ? chunk : String(chunk ?? '');
    try {
      res.payload = JSON.parse(res.body);
    } catch {
      res.payload = null;
    }
    return res;
  };
  return res;
}

function fakeReq({ method = 'GET', action = '', origin, host = '127.0.0.1:3080', body } = {}) {
  const listeners = new Map();
  const chunk = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  const req = {
    method,
    url: '/bili-statistics/api?action=' + encodeURIComponent(action),
    headers: { host, ...(origin ? { origin } : {}) },
    on(event, fn) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return req;
    },
    destroy() {}
  };
  req.flush = () => {
    if (chunk) for (const fn of listeners.get('data') ?? []) fn(chunk);
    for (const fn of listeners.get('end') ?? []) fn();
  };
  return req;
}

async function hitApi(route, action, options = {}) {
  const req = fakeReq({ action, ...options });
  const res = fakeRes();
  const pending = route.handler(req, res);
  req.flush();
  await pending;
  return { status: res.statusCode, payload: res.payload, headers: res.headers };
}

test('设置页接口：状态、模型列表、改配置、改计划、跨站与错误码', async () => {
  const dir = path.join(here, '.tmp-api');
  const routes = [];
  const webServer = {
    register(route) {
      routes.push(route);
      return () => {};
    }
  };
  const llm = {
    listProviders: () => [{ id: 'stub', name: 'Stub Provider' }],
    listModels: async (id) => (id === 'stub' ? [{ id: 'stub-1', name: 'Stub Model' }] : [])
  };
  fetchHandler = historyResponse();
  const harness = boot(dir, {}, { webServer, llm });
  assert.equal(routes.length, 1, '应挂载一个前缀路由');
  const route = routes[0];
  assert.equal(route.path, '/bili-statistics/api');
  const api = (action, options) => hitApi(route, action, options);

  const statusRes = await api('status');
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(statusRes.payload.ok, true);
  assert.equal(statusRes.payload.action, 'status');
  assert.equal(statusRes.payload.data.bili.has_cookie, true);

  const models = await api('models');
  assert.equal(models.payload.ok, true);
  assert.deepEqual(models.payload.data.providers, [{ id: 'stub', name: 'Stub Provider' }]);
  assert.deepEqual(models.payload.data.models.stub, [{ id: 'stub-1', name: 'Stub Model' }]);
  assert.deepEqual(models.payload.data.current, { provider: '', model: '' });

  const before = await api('config');
  assert.equal(before.payload.data.llm.provider, '');
  assert.equal(before.payload.data.report.polish, true);
  assert.equal(before.payload.data.notify.summary_max_chars, 200);
  assert.equal(before.payload.data.model_ready, false);
  assert.ok(before.payload.data.defaults.dm_prompt.length > 0, '应回传默认提示词供前端做 placeholder');
  assert.ok(before.payload.data.settings_file.endsWith('settings.json'));

  const saved = await api('config-set', {
    method: 'POST',
    body: {
      patch: {
        llm: { provider: 'stub', model: 'stub-1', dm_prompt: '语气温和，只陈述事实。' },
        report: { polish: false },
        notify: { summary_max_chars: 300 }
      }
    }
  });
  assert.equal(saved.payload.ok, true);
  assert.deepEqual(saved.payload.data.rejected, []);
  assert.equal(saved.payload.data.effective.report_polish, false);
  assert.equal(saved.payload.data.effective.model_ready, true);

  const after = await api('config');
  assert.equal(after.payload.data.llm.provider, 'stub');
  assert.equal(after.payload.data.llm.model, 'stub-1');
  assert.equal(after.payload.data.llm.dm_prompt, '语气温和，只陈述事实。');
  assert.equal(after.payload.data.report.polish, false);
  assert.equal(after.payload.data.notify.summary_max_chars, 300);
  assert.equal(after.payload.data.model_ready, true);
  const stored = JSON.parse(fs.readFileSync(before.payload.data.settings_file, 'utf8'));
  assert.equal(stored.llm.model, 'stub-1');

  const intentSet = await api('intent-set', { method: 'POST', body: { text: '  只看公开课，不刷推荐  ' } });
  assert.equal(intentSet.payload.ok, true);
  assert.equal(intentSet.payload.data.intention.text, '只看公开课，不刷推荐');
  const intent = await api('intent');
  assert.equal(intent.payload.data.intention.text, '只看公开课，不刷推荐');
  assert.equal(typeof intent.payload.data.intention.days_since_set, 'number');

  const run = await api('run-now', { method: 'POST', body: {} });
  assert.equal(run.payload.ok, true);
  assert.equal(run.payload.data.total_items, 12);
  assert.equal(run.payload.data.paths.length, 2);
  const latest = await api('report-latest');
  assert.equal(latest.payload.data.run.total_items, 12);
  assert.ok(latest.payload.data.markdown_preview.length > 0);

  assert.equal((await api('run-now')).status, 405, '写动作必须 POST');
  assert.equal((await api('nope')).status, 404, '未知动作 404');
  assert.equal((await api('')).status, 400, '缺 action 参数 400');
  const cross = await api('status', { origin: 'http://evil.example' });
  assert.equal(cross.status, 403, '跨站请求应拒绝');

  const denied = await api('config-set', { method: 'POST', body: { patch: { bili: { sessdata: 'X' } } } });
  assert.equal(denied.payload.ok, false);
  assert.match(denied.payload.error, /没有可写入的字段/);

  const mixed = await api('config-set', {
    method: 'POST',
    body: { patch: { llm: { provider: 'stub' }, state_dir: 'C:/tmp/elsewhere' } }
  });
  assert.equal(mixed.payload.ok, true);
  assert.ok(mixed.payload.data.rejected.includes('state_dir'), '落盘目录不在设置页白名单内');

  const scheduleSet = await api('config-set', {
    method: 'POST',
    body: { patch: { schedule: { enabled: true, mode: 'monthly', window: 'rolling', cron: '0 9 1 * *' } } }
  });
  assert.equal(scheduleSet.payload.ok, true);
  assert.deepEqual(scheduleSet.payload.data.rejected, []);
  assert.equal(scheduleSet.payload.data.effective.schedule.enabled, true, '设置页可以打开定时');
  assert.equal(scheduleSet.payload.data.effective.schedule.mode, 'monthly');
  assert.equal(scheduleSet.payload.data.effective.schedule.window, 'rolling');
  assert.equal(scheduleSet.payload.data.effective.schedule.cron, '0 9 1 * *');
  const storedSchedule = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(storedSchedule.schedule.mode, 'monthly');
  const statusAfter = await api('status');
  assert.equal(statusAfter.payload.data.schedule.mode, 'monthly');
  assert.equal(statusAfter.payload.data.schedule.window, 'rolling');
  assert.equal(typeof statusAfter.payload.data.schedule.next_fire, 'string');
  assert.equal(statusAfter.payload.data.schedule.next_window, '最近 30 天');

  const badCron = await api('config-set', {
    method: 'POST',
    body: { patch: { schedule: { mode: 'daily', cron: '99 0 0' } } }
  });
  assert.equal(badCron.payload.ok, true);
  assert.ok(badCron.payload.data.rejected.includes('schedule.cron'), '非法 cron 单独拒绝');
  assert.equal(badCron.payload.data.effective.schedule.mode, 'daily');
  assert.equal(badCron.payload.data.effective.schedule.cron, '0 9 1 * *', '非法 cron 被拒后保留原来的表达式');

  // 报告目录：可选、可校验、可回落默认。
  const customDir = path.join(dir, 'my-reports');
  const dirOk = await api('dir-check', { method: 'POST', body: { value: customDir } });
  assert.equal(dirOk.payload.ok, true);
  assert.equal(dirOk.payload.data.resolved, path.resolve(customDir));
  assert.equal(dirOk.payload.data.created, true, '首次检查应真的建出目录');
  assert.ok(fs.existsSync(customDir));
  const dirAgain = await api('dir-check', { method: 'POST', body: { value: customDir } });
  assert.equal(dirAgain.payload.data.created, false, '已存在的目录不再算新建');
  const dirEmpty = await api('dir-check', { method: 'POST', body: { value: '   ' } });
  assert.equal(dirEmpty.payload.ok, false);
  assert.match(dirEmpty.payload.error, /不能为空/);
  const dirRoot = await api('dir-check', { method: 'POST', body: { value: path.parse(dir).root } });
  assert.equal(dirRoot.payload.ok, false, '盘符根不能直接当报告目录');
  assert.equal((await api('dir-check')).status, 405, 'dir-check 必须 POST');

  const dirSaved = await api('config-set', { method: 'POST', body: { patch: { report: { local_dir: customDir } } } });
  assert.equal(dirSaved.payload.data.rejected.length, 0);
  assert.equal(dirSaved.payload.data.effective.report.local_dir, path.resolve(customDir));
  fetchHandler = historyResponse();
  const customRun = await api('run-now', { method: 'POST', body: {} });
  assert.equal(customRun.payload.ok, true);
  assert.ok(
    customRun.payload.data.paths[0].startsWith(path.resolve(customDir)),
    '报告应写到新目录：' + customRun.payload.data.paths[0]
  );

  const dirOptions = await api('config');
  assert.ok(Array.isArray(dirOptions.payload.data.report.dir_options.options));
  assert.equal(dirOptions.payload.data.report.dir_options.options[0].key, 'default');
  assert.ok(dirOptions.payload.data.report.default_dir.length > 0);

  const dirReset = await api('config-set', { method: 'POST', body: { patch: { report: { local_dir: '' } } } });
  assert.equal(dirReset.payload.ok, true);
  const afterReset = await api('config');
  assert.equal(afterReset.payload.data.report.local_dir, afterReset.payload.data.report.default_dir, '清空回落默认目录');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('模型：报告写概览与计划情况、私信换语气；模型失败则静默降级', async () => {
  fetchHandler = historyResponse();
  const calls = [];
  const goodLlm = {
    stream: async function* (options) {
      calls.push(options);
      yield { type: 'text-delta', text: '{"shape":"深夜连刷推荐","shape_reason":"22 点后的条目多数只看了前几分钟",' };
      yield { type: 'text-delta', text: '"overview":"这周的观看几乎都发生在深夜，' };
      yield { type: 'text-delta', text: '且多数条目只看了开头几分钟。","hypotheses":[{"text":"深夜更容易顺着推荐往下刷，而不是自己搜。","clue":"若下周深夜条目仍集中在前几分钟，说明还是自动播放。","evidence":[1,2]}]}' };
    }
  };
  const dir = path.join(here, '.tmp-polish');
  const harness = boot(
    dir,
    { llm: { provider: 'stub', model: 'stub-1', report_prompt: '只叙述数字，不评价。', dm_prompt: '用平实语气，不评价。' } },
    { llm: goodLlm }
  );
  await harness.call('bili_intent_facts', {});
  const report = await harness.call('bili_intent_report', {});
  assert.equal(report.polished, true);
  assert.equal(report.polish_reason, null);
  const markdown = fs.readFileSync(report.paths.find((item) => item.endsWith('.md')), 'utf8');
  assert.match(markdown, /## 概览/);
  assert.match(markdown, /这周的观看几乎都发生在深夜/);
  assert.ok(!/模型生成/.test(markdown), '报告里不该出现"模型生成"字样');
  assert.equal(report.hypotheses_source, 'model', '计划情况应由模型生成');
  assert.match(markdown, /深夜更容易顺着推荐往下刷/, '模型写的计划情况应进报告');
  assert.match(markdown, /## 计划情况/, '该节标题叫计划情况');
  assert.ok(!/行为假设/.test(markdown), '报告里不该再有行为假设字样');
  assert.match(markdown, /依据：.*视频 1/, '计划情况应引用具体视频标题');
  assert.equal(report.shape_source, 'model', '观看状态名应由模型给');
  assert.equal(report.shape_label, '深夜连刷推荐');
  assert.match(markdown, /观看状态（推断）.*深夜连刷推荐/, '报告里用模型起的名字');
  assert.ok(!/碎片化连刷/.test(markdown), '有模型标签时不该再出现规则标签');
  assert.match(markdown, /22 点后的条目多数只看了前几分钟/, '模型给的理由应进判断依据');
  const card = harness.tools.get('bili_intent_report').output.presentationMeta({}, report);
  assert.match(String(card.overview), /这周的观看几乎都发生在深夜/, '卡片应带模型写的概览');
  assert.equal(card.shape_label, '深夜连刷推荐', '卡片应带模型起的观看状态名');
  assert.equal(card.shape_reason, '22 点后的条目多数只看了前几分钟');
  assert.equal(card.hypotheses.length, 1, '卡片应带模型写的计划情况');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'stub');
  assert.equal(calls[0].model, 'stub-1');
  assert.equal(calls[0].system, '只叙述数字，不评价。', '报告导读应使用设置里的提示词');
  assert.equal(calls[0].messages[0].role, 'user');

  const dry = await harness.call('bili_intent_notify', { dry_run: true });
  assert.equal(dry.polished, true, '私信正文应走模型改写');
  assert.match(dry.content, /深夜/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].system, '用平实语气，不评价。', '私信语气应使用 dm_prompt');
  assert.equal(calls[1].temperature, 0.4);
  assert.match(calls[1].messages[0].content[0].text, /观看状态：深夜连刷推荐/, '私信提示词里应带上模型起的观看状态名');
  fs.rmSync(dir, { recursive: true, force: true });

  const badDir = path.join(here, '.tmp-polish-bad');
  const badLlm = {
    stream: async function* () {
      throw new Error('上游 500');
    }
  };
  const broken = boot(badDir, { llm: { provider: 'stub', model: 'stub-1' } }, { llm: badLlm });
  await broken.call('bili_intent_facts', {});
  const fallback = await broken.call('bili_intent_report', {});
  assert.equal(fallback.polished, false);
  assert.equal(fallback.polish_reason, 'error');
  assert.equal(fallback.paths.length, 2, '模型失败不影响报告落盘');
  assert.equal(fallback.shape_source, 'rule', '模型失败时退回规则标签');
  assert.equal(fallback.shape_label, null);
  const plain = fs.readFileSync(fallback.paths.find((item) => item.endsWith('.md')), 'utf8');
  assert.ok(!/## 概览/.test(plain));
  assert.ok(!/深夜连刷推荐/.test(plain));
  fs.rmSync(badDir, { recursive: true, force: true });
});

test('模型只给思考过程或被截断时，报告降级并说明原因', async () => {
  const dir = path.join(here, '.tmp-polish-truncated');
  fetchHandler = historyResponse();
  const truncatedLlm = {
    stream: async function* () {
      yield { type: 'reasoning-delta', index: 0, text: '先看看完成度和时长…' };
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
    }
  };
  const harness = boot(dir, { llm: { provider: 'stub', model: 'stub-1' } }, { llm: truncatedLlm });
  await harness.call('bili_intent_facts', {});
  const report = await harness.call('bili_intent_report', {});
  assert.equal(report.polished, false, '只有思考过程时不算润色成功');
  assert.equal(report.polish_reason, 'truncated');
  assert.match(String(report.polish_message), /max tokens/, '要告诉用户是 token 不够');
  assert.equal(report.shape_source, 'rule', '润色失败时退回规则标签');
  const markdown = fs.readFileSync(report.paths.find((item) => item.endsWith('.md')), 'utf8');
  assert.match(markdown, /观看状态（推断）.*深夜滑屏/, '退回规则标签');
  assert.ok(!/## 概览/.test(markdown), '没有正文就不该写概览段');
  fs.rmSync(dir, { recursive: true, force: true });

  const onlyDir = path.join(here, '.tmp-polish-thinking-only');
  fetchHandler = historyResponse();
  const thinkOnlyLlm = {
    stream: async function* () {
      yield { type: 'reasoning-delta', index: 0, text: '想了很多但没写正文' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  };
  const second = boot(onlyDir, { llm: { provider: 'stub', model: 'stub-1' } }, { llm: thinkOnlyLlm });
  await second.call('bili_intent_facts', {});
  const fallback = await second.call('bili_intent_report', {});
  assert.equal(fallback.polished, false);
  assert.equal(fallback.polish_reason, 'thinking-only');
  assert.match(String(fallback.polish_message), /思考过程/);
  fs.rmSync(onlyDir, { recursive: true, force: true });
});

test('模型输出被截断时报告里不出现 JSON 键，文件落到周期子目录', async () => {
  const dir = path.join(here, '.tmp-polish-partial-json');
  fetchHandler = historyResponse();
  const partialLlm = {
    stream: async function* () {
      yield { type: 'text-delta', text: '{"shape":"深夜跨题材低进度跳看","shape_reason":"22 点后占 36.4%、深夜 32 条","overview":"观看记录铺满一整天：最早 00:22 打开《广州商学院事件》，最晚 23:27 还在看李翔看世界讲姆巴佩；22 点后占 36.4' };
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
    }
  };
  const harness = boot(dir, { llm: { provider: 'stub', model: 'stub-1' } }, { llm: partialLlm });
  await harness.call('bili_intent_facts', {});
  const report = await harness.call('bili_intent_report', {});
  const markdown = fs.readFileSync(report.paths.find((item) => item.endsWith('.md')), 'utf8');
  assert.ok(!/\{\s*"shape"/.test(markdown), '概览里不能出现 JSON 键');
  assert.ok(!/shape_reason/.test(markdown), '报告里不能出现字段名');
  assert.ok(!/"overview"/.test(markdown), '报告里不能出现 overview 键名');
  assert.equal(report.shape_label, '深夜跨题材低进度跳看', '截断但能捞到观看状态名就用它');
  const subdir = path.basename(path.dirname(report.paths[0]));
  assert.ok(['daily', 'weekly', 'monthly', 'custom'].includes(subdir), '报告应落到周期子目录，实际：' + subdir);

  assert.ok(report.paths.every((item) => fs.existsSync(item)), '报告文件确实写出来了');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('旧缓存缺观看状态名时补调一次模型并写回', async () => {
  fetchHandler = historyResponse();
  const calls = [];
  const llm = {
    stream: async function* (options) {
      calls.push(options);
      yield { type: 'text-delta', text: '{"shape":"深夜连刷推荐","shape_reason":"多数只看了前几分钟","overview":"这周的观看几乎都发生在深夜。","hypotheses":[]}' };
    }
  };
  const dir = path.join(here, '.tmp-shape-cache');
  const harness = boot(dir, { llm: { provider: 'stub', model: 'stub-1' } }, { llm });
  await harness.call('bili_intent_facts', {});
  const first = await harness.call('bili_intent_report', {});
  assert.equal(first.shape_label, '深夜连刷推荐');
  assert.equal(calls.length, 1);

  // 模拟早期版本的缓存：概览与计划情况还在，但没有 shape。
  const statePath = path.join(dir, 'state.json');
  const cached = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  cached.runs[0].generated.shape = null;
  fs.writeFileSync(statePath, JSON.stringify(cached));

  const second = await harness.call('bili_intent_report', {});
  assert.equal(calls.length, 2, '缺观看状态名时应补调一次模型');
  assert.equal(second.shape_label, '深夜连刷推荐');
  assert.equal(second.shape_source, 'model');
  const reloaded = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(reloaded.runs[0].generated.shape.label, '深夜连刷推荐', '补调后应写回缓存');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('旧缓存把半截 JSON 当成了概览时作废并重算', async () => {
  fetchHandler = historyResponse();
  const calls = [];
  const llm = {
    stream: async function* (options) {
      calls.push(options);
      yield { type: 'text-delta', text: '{"shape":"深夜连刷推荐","shape_reason":"多数只看了前几分钟","overview":"这周的观看几乎都发生在深夜。","hypotheses":[]}' };
    }
  };
  const dir = path.join(here, '.tmp-dirty-cache');
  const harness = boot(dir, { llm: { provider: 'stub', model: 'stub-1' } }, { llm });
  await harness.call('bili_intent_facts', {});
  const first = await harness.call('bili_intent_report', {});
  assert.equal(calls.length, 1);

  // 模拟旧版本留下的脏缓存：整段 JSON 被当成 overview 存了下来。
  const statePath = path.join(dir, 'state.json');
  const cached = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  cached.runs[0].generated.overview = '{"shape":"深夜跨题材低进度跳看","overview":"观看记录铺满一整天';
  fs.writeFileSync(statePath, JSON.stringify(cached));

  const second = await harness.call('bili_intent_report', {});
  assert.equal(calls.length, 2, '脏缓存应作废并重新生成');
  const markdown = fs.readFileSync(second.paths.find((item) => item.endsWith('.md')), 'utf8');
  assert.ok(!/\{\s*"shape"/.test(markdown), '报告里不能出现 JSON 键');
  assert.match(markdown, /这周的观看几乎都发生在深夜/);
  assert.equal(first.shape_label, '深夜连刷推荐');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('定时触发：每次到点都重新统计，私信也不做每日限制', async () => {
  const dir = path.join(here, '.tmp-schedule');
  const routes = [];
  const webServer = {
    register(route) {
      routes.push(route);
      return () => {};
    }
  };
  const dmCalls = [];
  const items = fixtureItems();
  fetchHandler = async (url) => {
    if (url.includes('send_msg')) {
      dmCalls.push({ url });
      return { status: 200, ok: true, statusText: 'OK', json: async () => ({ code: 0, message: '0' }) };
    }
    return {
      status: 200,
      ok: true,
      json: async () => ({ code: 0, message: '0', data: { list: items, cursor: { max: 0, view_at: 0, business: '' } } })
    };
  };
  const harness = boot(
    dir,
    {
      schedule: { enabled: true, mode: 'daily', window: 'rolling', cron: '0 3 * * *', timezone: zone },
      notify: {
        channels: ['bili_dm'],
        bili_dm: { sender_sessdata: 'SENDER_SESSDATA', sender_bili_jct: 'SENDER_JCT', sender_mid: '1000001', receiver_mid: '1000002' }
      }
    },
    { webServer }
  );
  const route = routes[0];
  const api = (action, options) => hitApi(route, action, options);

  // 先手动统计一次：这就是用户 21:21 点「立即统计」那种情形。
  await harness.call('bili_intent_facts', {});
  let state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].trigger, 'manual');

  // 改定时规则会重新武装定时器；把 setTimeout 换成可捕获的，拿到「到点」回调。
  const realSetTimeout = globalThis.setTimeout;
  const pending = [];
  const captureTimer = function (fn, ms, ...rest) {
    if (ms >= 1000) {
      pending.push(fn);
      return { unref() {} };
    }
    return realSetTimeout(fn, Math.max(0, ms), ...rest);
  };
  const arm = async function (cron) {
    globalThis.setTimeout = captureTimer;
    try {
      const saved = await api('config-set', {
        method: 'POST',
        body: { patch: { schedule: { enabled: true, mode: 'daily', window: 'rolling', cron } } }
      });
      assert.equal(saved.payload.ok, true);
      return pending.pop();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  };
  let fire = await arm('0 3 * * *');
  assert.equal(typeof fire, 'function', '改定时规则后应重新武装定时器');
  await fire();

  state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(state.runs.length, 2, '定时触发应新增一条 run（手动那条不该挡住它）');
  assert.equal(state.runs[0].trigger, 'schedule');
  assert.equal(state.schedule_log[0].result, 'ran');
  assert.equal(state.schedule_log[0].run_id, state.runs[0].id);
  assert.equal(dmCalls.length, 1, '定时任务配了私信就该发');
  let status = await api('status');
  assert.equal(status.payload.data.schedule.last_event.result, 'ran');
  assert.ok(status.payload.data.schedule.recent_events.length >= 1);

  // 中间再手动跑一次，然后同一天再触发一次：仍然重新统计、仍然发私信。
  await harness.call('bili_intent_facts', {});
  fire = await arm('5 3 * * *');
  await fire();

  state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(state.runs.length, 4, '同一天第二次定时触发也要重新统计');
  assert.equal(state.runs[0].trigger, 'schedule');
  assert.equal(state.schedule_log[0].result, 'ran');
  assert.equal(dmCalls.length, 2, '不做每日一次限制：第二次到点照样发私信');
  status = await api('status');
  assert.equal(status.payload.data.schedule.last_event.result, 'ran');
  assert.equal(status.payload.data.schedule.last_event.notified, true);

  harness.disposers.forEach((fn) => fn());
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 极简假 SMTP：只够核对 MAIL/RCPT 与 DATA 正文，不实现 TLS（对应 465 之外的自建/内网场景）。 */
function startFakeSmtp() {
  const log = [];
  const messages = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 fake.local ESMTP' + '\r\n');
    let buffer = '';
    let mode = 'command';
    let data = '';
    let authStep = 0;
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        if (mode === 'data') {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          mode = 'command';
          messages.push(data);
          data = '';
          socket.write('250 2.0.0 queued as FAKE1' + '\r\n');
          continue;
        }
        const index = buffer.indexOf('\r\n');
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        log.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          socket.write('250-fake.local' + '\r\n' + '250-AUTH LOGIN PLAIN' + '\r\n' + '250 8BITMIME' + '\r\n');
        } else if (upper.startsWith('AUTH LOGIN')) {
          authStep = 1;
          socket.write('334 VXNlcm5hbWU6' + '\r\n');
        } else if (authStep === 1) {
          authStep = 2;
          socket.write('334 UGFzc3dvcmQ6' + '\r\n');
        } else if (authStep === 2) {
          authStep = 3;
          socket.write('235 2.7.0 accepted' + '\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          socket.write('250 2.1.0 ok' + '\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          socket.write('250 2.1.5 ok' + '\r\n');
        } else if (upper === 'DATA') {
          mode = 'data';
          socket.write('354 end with <CRLF>.<CRLF>' + '\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 bye' + '\r\n');
          socket.end();
        } else {
          socket.write('500 5.5.1 unknown' + '\r\n');
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

test('邮件通知：SMTP 端到端发出摘要，可附 Markdown，失败不阻塞私信', async () => {
  const smtp = await startFakeSmtp();
  const dir = path.join(here, '.tmp-email');
  const routes = [];
  const webServer = {
    register(route) {
      routes.push(route);
      return () => {};
    }
  };
  const dmCalls = [];
  const history = historyResponse();
  fetchHandler = async (url, init) => {
    if (String(url).includes('send_msg')) {
      dmCalls.push({ url });
      return { status: 200, ok: true, statusText: 'OK', json: async () => ({ code: 0, message: '0' }) };
    }
    return history(url, init);
  };
  const emailBase = {
    host: '127.0.0.1',
    port: smtp.port,
    secure: false,
    allow_plain: true,
    user: 'me@test.local',
    pass: 'AUTH_CODE',
    from: 'me@test.local',
    to: 'me@test.local',
    from_name: 'B站观看统计',
    subject_prefix: '[B站观看统计]',
    attach_report: true,
    retries: 0,
    timeout_ms: 5000
  };
  const harness = boot(
    dir,
    {
      notify: {
        channels: ['email'],
        email: emailBase,
        bili_dm: { sender_sessdata: 'SENDER_SESSDATA', sender_bili_jct: 'SENDER_JCT', sender_mid: '1000001', receiver_mid: '1000002' }
      }
    },
    { webServer }
  );
  const api = (action, options) => hitApi(routes[0], action, options);

  // 先造一次 run，让附件有 facts 可渲染。
  await harness.call('bili_intent_facts', {});
  // 假 SMTP 只服务一次连接没问题，但保险起见每次测试邮件前清空记录。
  const res = await api('email-test', { method: 'POST', body: { text: '今天看了 12 条，深夜居多。' } });
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.data.delivered, true, '邮件应投递成功');
  assert.equal(res.payload.data.channel, 'email');
  assert.equal(res.payload.data.attached, true, '开了 attach_report 就该带附件');
  assert.equal(smtp.messages.length, 1);
  assert.ok(smtp.log.includes('MAIL FROM:<me@test.local>'));
  assert.ok(smtp.log.includes('RCPT TO:<me@test.local>'));
  const message = smtp.messages[0];
  assert.match(message, /To: .*<me@test\.local>/);
  assert.match(message, /multipart\/mixed/);
  assert.match(message, /bili-watch-\d{4}-\d{2}-\d{2}\.md/, '附件名应是 Markdown 报告');
  const subjectLine = message.split('\r\n').find((line) => line.startsWith('Subject: '));
  const encoded = /=\?UTF-8\?B\?([^?]+)\?=/.exec(subjectLine ?? '');
  assert.ok(encoded, '主题里的中文应做 RFC 2047 编码');
  assert.match(Buffer.from(encoded[1], 'base64').toString('utf8'), /B 站观看摘要/);
  assert.equal(dmCalls.length, 0, '只发邮件时不该去打私信接口');

  // 邮件坏掉（端口不可连）但渠道里还有私信：私信照发，邮件失败只记在自己的结果里。
  const broken = await api('config-set', {
    method: 'POST',
    body: { patch: { notify: { channels: ['email', 'bili_dm'], email: { port: 1 } } } }
  });
  assert.equal(broken.payload.ok, true);
  assert.deepEqual(broken.payload.data.effective.channels, ['email', 'bili_dm']);
  const mixed = await api('notify-test', { method: 'POST', body: { text: '这是一条测试消息。' } });
  assert.equal(mixed.payload.ok, true);
  assert.equal(mixed.payload.data.delivered, true, '邮件失败不应阻塞私信');
  const byChannel = new Map(mixed.payload.data.results.map((item) => [item.channel, item]));
  assert.equal(byChannel.get('email').ok, false);
  assert.equal(byChannel.get('bili_dm').ok, true);
  assert.equal(dmCalls.length, 1, '这时该发出一条私信');

  harness.disposers.forEach((fn) => fn());
  await smtp.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('清理', () => {
  globalThis.fetch = realFetch;
  fs.rmSync(path.join(here, '.tmp-main'), { recursive: true, force: true });
  assert.ok(main.logs.some(([level]) => level === 'info'));
});
