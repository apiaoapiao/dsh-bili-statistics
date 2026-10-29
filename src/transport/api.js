/**
 * 设置页的跨进程通道：挂在宿主 webServer 上的一小组同源 JSON 路由。
 * 
 */

export const API_PREFIX = '/bili-statistics/api';

const MAX_BODY_BYTES = 64 * 1024;

/** 同源校验：浏览器跨站请求会带不匹配的 Origin，直接拒绝；无 Origin 的非浏览器调用放行。 */
export function isSameOrigin(req) {
  const origin = req?.headers?.origin;
  if (!origin || String(origin).length === 0) return true;
  try {
    const parsed = new URL(String(origin));
    const host = String(req?.headers?.host ?? '');
    return host.length > 0 && parsed.host === host;
  } catch {
    return false;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error) => reject(error));
  });
}

/** GET 只读动作；写动作必须用 POST，避免被 <img>/链接意外触发。 */
const READ_ACTIONS = new Set(['status', 'config', 'intent', 'report-latest', 'models', 'login-poll']);

const ACTION_METHOD = {
  status: 'get',
  config: 'get',
  intent: 'get',
  'report-latest': 'get',
  models: 'get',
  'login-poll': 'get',
  'login-start': 'post',
  'run-now': 'post',
  'notify-test': 'post',
  'email-test': 'post',
  'dir-check': 'post',
  'intent-set': 'post',
  'config-set': 'post',
  'login-logout': 'post'
};

/** 把 action 映射到宿主闭包里的实现。 */
function dispatch(handlers, action, payload) {
  switch (action) {
    case 'status':
      return handlers.status();
    case 'config':
      return handlers.configGet();
    case 'intent':
      return handlers.intentGet();
    case 'report-latest':
      return handlers.reportLatest();
    case 'models':
      return handlers.models();
    case 'login-start':
      return handlers.loginStart({ role: payload.role });
    case 'login-poll':
      return handlers.loginPoll({ qrcodeKey: payload.qrcode_key, waitSeconds: payload.wait_seconds });
    case 'login-logout':
      return handlers.loginLogout({ role: payload.role });
    case 'run-now':
      return handlers.runNow({ mode: payload.mode });
    case 'notify-test':
      return handlers.notifyTest({ text: payload.text, only: payload.only });
    case 'email-test':
      return handlers.emailTest({ text: payload.text });
    case 'dir-check':
      return handlers.dirCheck({ value: payload.value });
    case 'intent-set':
      return handlers.intentSet({ text: payload.text });
    case 'config-set':
      return handlers.configSet({ patch: payload.patch });
    default:
      throw new Error('未知动作：' + action);
  }
}

/**
 * 注册路由。webServer.register 返回 dispose；host 侧应放进 ctx.effect。
 * @returns {() => void}
 */
export function registerApi(webServer, handlers, { prefix = API_PREFIX, log = () => {} } = {}) {
  const dispose = webServer.register({
    kind: 'prefix',
    path: prefix,
    async handler(req, res) {
      try {
        if (!isSameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: '拒绝跨站请求' });
          return;
        }
        const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1');
        const action = String(url.searchParams.get('action') ?? '').trim();
        const method = String(req.method ?? 'GET').toUpperCase();
        if (!action) {
          sendJson(res, 400, { ok: false, error: '缺少 action 参数' });
          return;
        }
        const expected = ACTION_METHOD[action];
        if (expected === undefined) {
          sendJson(res, 404, { ok: false, error: '未知动作：' + action });
          return;
        }
        if ((expected === 'post' && method !== 'POST') || (expected === 'get' && method !== 'GET' && method !== 'POST')) {
          sendJson(res, 405, { ok: false, error: '动作 ' + action + ' 需要 ' + expected.toUpperCase() });
          return;
        }
        let payload = {};
        if (method === 'POST') {
          const raw = await readBody(req);
          if (raw.trim().length > 0) {
            try {
              payload = JSON.parse(raw);
            } catch {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
              return;
            }
            if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
              sendJson(res, 400, { ok: false, error: '请求体必须是对象' });
              return;
            }
          }
        } else {
          payload = Object.fromEntries(url.searchParams.entries());
        }
        if (READ_ACTIONS.has(action) && method === 'GET') {
          // 只读动作允许 query 传参（例如 login-poll?qrcode_key=...）
        }
        const data = await dispatch(handlers, action, payload ?? {});
        sendJson(res, 200, { ok: true, action, data: data ?? null });
      } catch (error) {
        log('warn', '设置页接口失败：' + (error?.message ?? String(error)));
        sendJson(res, 200, { ok: false, error: error?.message ?? String(error) });
      }
    }
  });
  return typeof dispose === 'function' ? dispose : () => {};
}
