import test from "node:test";
import assert from "node:assert/strict";

/** 收集 __ModuleLoader__ 注册的 factory。 */
function loadBundle() {
  const bundles = [];
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        bundles.push(definition);
      }
    }
  };
  return bundles;
}

/**
 * 极简 React 替身：卡片只用 createElement，设置页额外用 useState/useEffect/useRef。
 * hooks 按渲染次序存放在数组里，beginRender() 归零游标，模拟一次渲染。
 */
let reactInstance = null;

function fakeReact() {
  let cursor = 0;
  const cells = [];
  const ranEffects = new Set();
  const api = {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      cells.length = 0;
      ranEffects.clear();
    },
    createElement(type, props, children) {
      return { type, props: props ?? {}, children };
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = typeof initial === "function" ? initial() : initial;
      return [
        cells[index],
        (next) => {
          cells[index] = typeof next === "function" ? next(cells[index]) : next;
        }
      ];
    },
    useEffect(fn) {
      const index = cursor++;
      if (ranEffects.has(index)) return;
      ranEffects.add(index);
      fn();
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = { current: initial };
      return cells[index];
    }
  };
  reactInstance = api;
  return api;
}

/** 取最近一次创建的 React 替身，供设置页测试重渲染。 */
function currentReact() {
  assert.ok(reactInstance !== null, "React 替身应已创建");
  return reactInstance;
}

/** 清空 hooks 状态，让设置页从初始状态重新挂载。 */
function resetReact() {
  const api = currentReact();
  api.reset();
  return api;
}

/** 把渲染树拍平成纯文本，方便断言。 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const inner = node.props?.children;
  const head = inner === undefined ? node.children : inner;
  return textOf(head);
}

/** 找到满足条件的第一个节点。 */
function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (predicate(node)) return node;
  const inner = node.props?.children;
  return find(inner === undefined ? node.children : inner, predicate);
}

let cachedModule = null;

async function loadClient() {
  if (cachedModule !== null) return cachedModule;
  const bundles = loadBundle();
  await import(new URL("../src/client.js", import.meta.url).href);
  assert.equal(bundles.length, 1, "客户端 bundle 应注册一次");
  const bundle = bundles[0];
  assert.equal(bundle.id, "@local/dsh-bili-statistics");
  const factory = bundle.factory;
  const module = factory((request) => {
    if (request === "react") return fakeReact();
    throw new Error("不允许 require: " + request);
  });
  cachedModule = module;
  return module;
}

/** 假的客户端 ctx，记录注册结果。 */
function fakeContext(module) {
  const registered = [];
  const effects = [];
  const dictionaries = [];
  const ctx = {
    effect(fn, label) {
      effects.push({ label, dispose: fn() });
      return { dispose() {} };
    },
    locale: {
      register(namespace, dicts) {
        dictionaries.push({ namespace, dicts });
        return { dispose() {} };
      }
    },
    slots: {
      inject(owner, callback) {
        const result = callback();
        const list = result && typeof result[Symbol.iterator] === "function" ? [...result] : [result];
        for (const entry of list) registered.push(entry);
        return { dispose() {} };
      },
      register(spec, component) {
        return { spec, component };
      }
    }
  };
  module.apply(ctx);
  return { registered, effects, dictionaries };
}

const SAMPLE_META = {
  kind: "bili-intent-report",
  run_id: "run_2026-10-26_001",
  window: { from: 1, to: 2, mode: "daily", label: "2026-10-25", timezone: "Asia/Shanghai" },
  total_items: 23,
  shape: "fragmented_binge",
  confidence: 0.62,
  completion: 0.31,
  late_night_share: 0.48,
  max_chain: 7,
  baseline: { lookback_runs: 5, median_items: 18, delta_ratio: 0.27 },
  overview: "这周的观看几乎都发生在深夜，且多数条目只看了开头几分钟。",
  shape_label: "深夜连刷推荐",
  shape_reason: "22 点后的条目多数只看了前几分钟",
  hypotheses: [
    { text: "深夜连续被动播放集中在两个游戏区 up 主。", clue: "22:40 起 7 条连播", evidence: [3, 5] }
  ],
  paths: ["/home/user/.dsh/bili-statistics/reports/report-2026-10-25.md"]
};

test("注册九个 bili_intent_* 的 toolview 卡片与中英词典", async () => {
  const module = await loadClient();
  const { registered, dictionaries } = fakeContext(module);
  const cards = registered.filter((entry) => entry.spec.name === "tool.call.toolview");
  const keys = cards.map((entry) => entry.spec.key).sort();
  assert.deepEqual(keys, [
    "bili_intent_annotate",
    "bili_intent_facts",
    "bili_intent_feedback",
    "bili_intent_login",
    "bili_intent_login_poll",
    "bili_intent_notify",
    "bili_intent_report",
    "bili_intent_set",
    "bili_intent_status"
  ]);
  for (const entry of cards) {
    assert.equal(entry.spec.locale, "bili-statistics");
    assert.equal(typeof entry.component, "function");
  }
  const section = registered.find((entry) => entry.spec.name === "settings.section");
  assert.ok(section, "应注册一个 settings.section 设置页");
  assert.equal(section.spec.id, "bili-statistics");
  assert.equal(typeof section.component, "function");
  assert.equal(typeof section.spec.label(), "string");
  assert.equal(dictionaries.length, 1);
  assert.equal(dictionaries[0].namespace, "bili-statistics");
  const zhKeys = Object.keys(dictionaries[0].dicts.zh).sort();
  const enKeys = Object.keys(dictionaries[0].dicts.en).sort();
  assert.deepEqual(enKeys, zhKeys, "中英键集必须一致");
});

test("统计事实卡片渲染关键数字与假设", async () => {
  const module = await loadClient();
  const { registered, dictionaries } = fakeContext(module);
  const card = registered.find((entry) => entry.spec.key === "bili_intent_report").component;
  const zh = dictionaries[0].dicts.zh;
  const t = (key) => zh[key] ?? key;
  let opened = null;
  const tree = card({
    phase: "result",
    toolName: "bili_intent_report",
    block: { isError: false, meta: SAMPLE_META, content: [{ type: "text", text: "报告已生成" }] },
    openFile: (path) => { opened = path; },
    t
  });
  const text = textOf(tree);
  for (const expected of ["23", "深夜连刷推荐", "22 点后的条目多数只看了前几分钟", "31%", "48%", "7", "概览：这周的观看几乎都发生在深夜", "深夜连续被动播放", "证据 2"]) {
    assert.ok(text.includes(expected), "卡片应包含 " + expected + "，实际：" + text);
  }
  assert.ok(!text.includes("碎片化连刷"), "有模型起的名字时不该再显示规则标签");
  const ruleTree = card({
    phase: "result",
    toolName: "bili_intent_report",
    block: { isError: false, meta: { ...SAMPLE_META, shape_label: null, shape_reason: null }, content: [] },
    openFile: () => {},
    t
  });
  const ruleText = textOf(ruleTree);
  assert.ok(ruleText.includes("碎片化连刷"), "没有模型起的名字时退回规则标签");
  assert.ok(ruleText.includes("62%"), "退回落时显示可信度");
  assert.ok(text.includes("2026-10-25"), "应展示窗口标签");
  const button = find(tree, (node) => node.type === "button" && textOf(node).includes("打开报告"));
  assert.ok(button !== null, "报告路径存在时应给出打开按钮");
  button.props.onClick();
  assert.equal(opened, SAMPLE_META.paths[0]);
});

test("没有假设时退回仅统计事实，不渲染空列表", async () => {
  const module = await loadClient();
  const { registered, dictionaries } = fakeContext(module);
  const card = registered.find((entry) => entry.spec.key === "bili_intent_facts").component;
  const zh = dictionaries[0].dicts.zh;
  const t = (key) => zh[key] ?? key;
  const tree = card({
    phase: "result",
    toolName: "bili_intent_facts",
    block: { isError: false, meta: { ...SAMPLE_META, hypotheses: [], paths: [] }, content: [] },
    t
  });
  const text = textOf(tree);
  assert.ok(text.includes(zh.factsOnly), "应提示仅有统计事实");
  assert.ok(!text.includes(zh.hypotheses), "不应渲染假设小节标题");
  assert.equal(find(tree, (node) => node.type === "ul"), null, "空假设不应渲染列表");
  assert.equal(find(tree, (node) => node.type === "button"), null, "没有路径时不出现打开按钮");
});

test("进行中与失败态都用一行摘要", async () => {
  const module = await loadClient();
  const { registered } = fakeContext(module);
  const card = registered[0].component;
  const t = (key) => key;
  const running = card({ phase: "start", toolName: "bili_intent_facts", block: { name: "bili_intent_facts" }, t });
  assert.ok(textOf(running).includes("running"));
  const failed = card({
    phase: "result",
    toolName: "bili_intent_facts",
    block: { isError: true, error: { message: "未配置 B 站 Cookie" }, meta: null, content: [] },
    t
  });
  const failedText = textOf(failed);
  assert.ok(failedText.includes("failed"));
  assert.ok(failedText.includes("未配置 B 站 Cookie"));
});

test("缺翻译不炸：t 抛错时退回内置英文兜底", async () => {
  const module = await loadClient();
  const { registered } = fakeContext(module);
  const card = registered[0].component;
  const tree = card({
    phase: "result",
    toolName: "bili_intent_status",
    block: { isError: false, meta: null, content: [{ type: "text", text: "当前计划：少刷游戏区" }] },
    t() { throw new Error("locale seat missing"); }
  });
  assert.ok(textOf(tree).includes("少刷游戏区"));
});
test("扫码登录卡片画出二维码并给出链接兜底", async () => {
  const { encodeQr, toDots } = await import("../src/qr.js");
  const module = await loadClient();
  const { registered, dictionaries } = fakeContext(module);
  const card = registered.find((entry) => entry.spec.key === "bili_intent_login").component;
  const zh = dictionaries[0].dicts.zh;
  const t = (key) => zh[key] ?? key;
  const url = "https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=0123456789abcdef0123456789abcdef&from=";
  const qr = encodeQr(url, { ecc: 1 });
  const tree = card({
    phase: "result",
    toolName: "bili_intent_login",
    block: {
      isError: false,
      content: [{ type: "text", text: "请扫码" }],
      meta: {
        kind: "bili-intent-login",
        role: "reader",
        url,
        dots: toDots(qr),
        size: qr.size,
        expires_in_seconds: 180
      }
    },
    t
  });
  const path = find(tree, (node) => node.type === "path" && typeof node.props.d === "string" && node.props.d.length > 0);
  assert.ok(path !== null, "应把矩阵画成 path");
  const background = find(tree, (node) => node.type === "rect");
  assert.equal(background.props.fill, "#ffffff", "二维码需要白底");
  const text = textOf(tree);
  assert.ok(text.includes(url), "卡片应展示可复制的登录链接");
  assert.ok(text.includes(zh["login.role.reader"]), "应标明是读观看历史的账号");
  assert.ok(text.includes("180"), "应展示有效期");
});

test("扫码状态卡片按状态给出中文结论", async () => {
  const module = await loadClient();
  const { registered, dictionaries } = fakeContext(module);
  const card = registered.find((entry) => entry.spec.key === "bili_intent_login_poll").component;
  const zh = dictionaries[0].dicts.zh;
  const t = (key) => zh[key] ?? key;
  const scanned = card({
    phase: "result",
    toolName: "bili_intent_login_poll",
    block: {
      isError: false,
      content: [],
      meta: { kind: "bili-intent-login-state", state: "scanned", role: "sender", message: "已扫码，请在手机上确认" }
    },
    t
  });
  const scannedText = textOf(scanned);
  assert.ok(scannedText.includes(zh["loginState.scanned"]));
  assert.ok(scannedText.includes(zh["login.role.sender"]));

  const confirmed = card({
    phase: "result",
    toolName: "bili_intent_login_poll",
    block: {
      isError: false,
      content: [],
      meta: { kind: "bili-intent-login-state", state: "confirmed", role: "reader", mid: 42, uname: "测试号", usable: true }
    },
    t
  });
  const confirmedText = textOf(confirmed);
  assert.ok(confirmedText.includes(zh["loginState.confirmed"]));
  assert.ok(confirmedText.includes("测试号"));
  assert.ok(confirmedText.includes(zh["loginState.usable"]));
});

test("设置页渲染交互入口、登录状态与模型配置", async () => {
  const module = await loadClient();
  const { registered, dictionaries } = fakeContext(module);
  const section = registered.find((entry) => entry.spec.name === "settings.section");
  const zh = dictionaries[0].dicts.zh;
  const t = (key) => zh[key] ?? key;
  const react = currentReact();

  const payloads = {
    status: {
      intention: { text: "只看公开课", days_since_set: 3 },
      latest_run: { id: "r1", created_at: "2026-10-26T22:00:00+08:00", total_items: 23, shape: "fragmented_binge" },
      login: {
        reader: { logged_in: true, uname: "读号", mid: 1, usable: true },
        sender: { logged_in: false }
      },
      schedule: {
        enabled: true,
        mode: "daily",
        window: "calendar",
        cron: "0 22 * * *",
        cron_custom: "",
        timezone: "Asia/Shanghai",
        next_fire: "2026-10-27 22:00",
        next_window: "昨天（自然日）",
        last_event: {
          at: "2026-10-27T13:25:00.000Z",
          result: "skipped",
          reason: "今天已经跑过定时统计（2026-10-27 21:21）",
          notified: false
        }
      }
    },
    config: {
      llm: { enabled: true, provider: "", model: "", report_prompt: "", dm_prompt: "", max_tokens: 600, timeout_ms: 20000 },
      report: { polish: true },
      notify: { summary_max_chars: 200 },
      schedule: {
        enabled: true,
        mode: "daily",
        window: "calendar",
        cron: "0 22 * * *",
        cron_custom: "",
        timezone: "Asia/Shanghai",
        custom_from: "",
        custom_to: ""
      },
      defaults: { report_prompt: "内置报告提示词", dm_prompt: "内置私信提示词" },
      overrides: {},
      settings_file: "C:\\state\\settings.json",
      model_ready: false
    },
    intent: { intention: { text: "只看公开课", days_since_set: 3 } },
    models: {
      providers: [{ id: "p1", name: "Provider One" }],
      models: { p1: [{ id: "m1", name: "Model One" }] },
      current: {}
    }
  };

  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const action = new URL(String(url), "http://127.0.0.1").searchParams.get("action") ?? "";
    seen.push(action);
    const data = payloads[action];
    return {
      status: 200,
      json: async () => (data === undefined ? { ok: false, error: "unknown action " + action } : { ok: true, action, data })
    };
  };

  try {
    react.beginRender();
    section.component({ t, close() {} });
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
    react.beginRender();
    const tree = section.component({ t, close() {} });
    const text = textOf(tree);
    const expected = [
      zh["settings.title"],
      zh["settings.status"],
      "只看公开课",
      "读号",
      zh["settings.scan"],
      zh["settings.runNow"],
      zh["settings.notifyTest"],
      zh["settings.save"],
      "Provider One",
      zh["settings.modelMissing"],
      zh["settings.schedule"],
      zh["settings.scheduleOn"],
      zh["settings.mode.daily"],
      zh["settings.window.daily.calendar"],
      zh["settings.triggerTime"],
      zh["settings.scheduleHint"],
      "2026-10-27 22:00",
      zh["settings.scheduleLast"],
      zh["settings.lastSkipped"],
      "今天已经跑过定时统计"
    ];
    for (const item of expected) {
      assert.ok(text.includes(item), "设置页应包含 " + item + "，实际：" + text);
    }
    assert.ok(seen.includes("status"), "应读取状态");
    assert.ok(seen.includes("models"), "应读取模型列表");
    const runButton = find(tree, (node) => node.type === "button" && textOf(node).includes(zh["settings.runNow"]));
    assert.ok(runButton !== null, "应有立即统计按钮");
    assert.equal(typeof runButton.props.onClick, "function");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("设置页用列表选触发时间，改成每周后保存的是对应 cron", async () => {
  const module = await loadClient();
  const { registered, dictionaries } = fakeContext(module);
  const section = registered.find((entry) => entry.spec.name === "settings.section");
  const zh = dictionaries[0].dicts.zh;
  const t = (key) => zh[key] ?? key;

  const baseSchedule = {
    enabled: true,
    mode: "daily",
    window: "calendar",
    cron: "0 22 * * *",
    cron_custom: "",
    timezone: "Asia/Shanghai",
    custom_from: "",
    custom_to: ""
  };
  const config = {
    llm: { enabled: true, provider: "", model: "", report_prompt: "", dm_prompt: "", max_tokens: 600, timeout_ms: 20000 },
    report: { polish: true },
    notify: { summary_max_chars: 200 },
    schedule: baseSchedule,
    defaults: { report_prompt: "内置报告提示词", dm_prompt: "内置私信提示词" },
    overrides: {},
    settings_file: "C:\\state\\settings.json",
    model_ready: false
  };
  const payloads = {
    status: {
      intention: null,
      latest_run: null,
      login: { reader: { logged_in: false }, sender: { logged_in: false } },
      schedule: Object.assign({}, baseSchedule, { next_fire: "2026-10-27 22:00", next_window: "昨天（自然日）" })
    },
    config,
    intent: { intention: null },
    models: { providers: [], models: {}, current: {} },
    "config-set": {
      applied: ["schedule"],
      rejected: [],
      overrides: {},
      effective: {
        llm: config.llm,
        report_polish: true,
        summary_max_chars: 200,
        receiver_mid: "",
        effective_receiver: "",
        receiver_source: "config",
        model_ready: false,
        schedule: Object.assign({}, baseSchedule)
      }
    }
  };

  const writes = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const action = new URL(String(url), "http://127.0.0.1").searchParams.get("action") ?? "";
    const body = options && typeof options.body === "string" ? JSON.parse(options.body) : null;
    if (action === "config-set") writes.push(body);
    const data = payloads[action];
    return {
      status: 200,
      json: async () => (data === undefined ? { ok: false, error: "unknown action " + action } : { ok: true, action, data })
    };
  };

  try {
    const react = resetReact();
    react.beginRender();
    section.component({ t, close() {} });
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
    react.beginRender();
    let tree = section.component({ t, close() {} });

    const modeSelect = find(tree, (node) => node.type === "select"
      && node.props.value === "daily"
      && Array.isArray(node.children)
      && node.children.some((child) => child && child.props && child.props.value === "weekly"));
    assert.ok(modeSelect !== null, "应有周期下拉，实际：" + textOf(tree));
    modeSelect.props.onChange({ target: { value: "weekly" } });
    react.beginRender();
    tree = section.component({ t, close() {} });
    const weeklyText = textOf(tree);
    assert.ok(weeklyText.includes(zh["settings.weekdayLabel"]), "每周应出现星期选择，实际：" + weeklyText);
    for (const value of [1, 2, 3, 4, 5, 6, 7]) {
      assert.ok(weeklyText.includes(zh["settings.weekday." + value]), "应列出 " + zh["settings.weekday." + value]);
    }
    assert.ok(!weeklyText.includes("（cron）"), "不应该再有 cron 输入");

    const hourSelect = find(tree, (node) => node.type === "select" && node.props.value === "22");
    assert.ok(hourSelect !== null, "应有小时下拉且默认 22");
    assert.equal(hourSelect.children.length, 24, "小时应有 24 项");
    hourSelect.props.onChange({ target: { value: "9" } });
    react.beginRender();
    tree = section.component({ t, close() {} });
    const minuteSelect = find(tree, (node) => node.type === "select"
      && node.props.value === "0"
      && Array.isArray(node.children)
      && node.children.length === 12);
    assert.ok(minuteSelect !== null, "应有分钟下拉且默认 0");
    minuteSelect.props.onChange({ target: { value: "30" } });

    react.beginRender();
    tree = section.component({ t, close() {} });
    const saveButton = find(tree, (node) => node.type === "button" && textOf(node) === zh["settings.save"]);
    assert.ok(saveButton !== null, "应有保存设置按钮");
    saveButton.props.onClick();
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes.length, 1, "应提交一次配置");
    assert.equal(writes[0].patch.schedule.mode, "weekly");
    assert.equal(writes[0].patch.schedule.window, "calendar");
    assert.equal(writes[0].patch.schedule.cron, "30 9 * * 1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("设置页可切本地保存格式、勾邮件渠道并发送测试邮件", async () => {
  const module = await loadClient();
  const { registered, dictionaries } = fakeContext(module);
  const section = registered.find((entry) => entry.spec.name === "settings.section");
  const zh = dictionaries[0].dicts.zh;
  const t = (key) => zh[key] ?? key;

  const baseSchedule = {
    enabled: true,
    mode: "daily",
    window: "calendar",
    cron: "0 22 * * *",
    cron_custom: "",
    timezone: "Asia/Shanghai",
    custom_from: "",
    custom_to: ""
  };
  const config = {
    llm: { enabled: true, provider: "", model: "", report_prompt: "", dm_prompt: "", max_tokens: 600, timeout_ms: 20000 },
    report: { polish: true, save_local: true, format: "markdown", local_dir: "C:\\state\\reports" },
    notify: {
      channels: ["bili_dm"],
      summary_max_chars: 200,
      receiver_mid: "",
      effective_receiver: "",
      receiver_source: "config",
      email: {
        host: "smtp.qq.com",
        port: 465,
        secure: true,
        user: "me@qq.com",
        pass_set: true,
        from: "me@qq.com",
        to: "me@qq.com",
        from_name: "B站观看统计",
        subject_prefix: "[B站观看统计]",
        attach_report: false,
        allow_plain: false,
        timeout_ms: 20000,
        retries: 1,
        backoff_ms: 2000
      }
    },
    schedule: baseSchedule,
    defaults: { report_prompt: "内置报告提示词", dm_prompt: "内置私信提示词" },
    overrides: {},
    settings_file: "C:\\state\\settings.json",
    model_ready: false
  };
  const payloads = {
    status: {
      intention: null,
      latest_run: null,
      login: { reader: { logged_in: false }, sender: { logged_in: false } },
      schedule: Object.assign({}, baseSchedule, { next_fire: "2026-10-27 22:00", next_window: "昨天（自然日）" })
    },
    config,
    intent: { intention: null },
    models: { providers: [], models: {}, current: {} },
    "email-test": { delivered: true, channel: "email", content: "这周看了 23 条。", polished: false, attached: false, results: [] },
    "config-set": { applied: [], rejected: [], overrides: {}, effective: {} }
  };

  const seen = [];
  const writes = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const action = new URL(String(url), "http://127.0.0.1").searchParams.get("action") ?? "";
    seen.push(action);
    if (action === "config-set" && options && typeof options.body === "string") writes.push(JSON.parse(options.body));
    const data = payloads[action];
    return {
      status: 200,
      json: async () => (data === undefined ? { ok: false, error: "unknown action " + action } : { ok: true, action, data })
    };
  };

  try {
    const react = resetReact();
    react.beginRender();
    section.component({ t, close() {} });
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
    react.beginRender();
    let tree = section.component({ t, close() {} });
    let text = textOf(tree);
    assert.ok(text.includes(zh["settings.groupSave"]), "应有本地保存分块，实际：" + text);
    assert.ok(text.includes(zh["settings.groupNotify"]), "应有通知渠道分块");
    assert.ok(text.includes(zh["settings.saveDir"]), "应显示报告目录");
    assert.ok(text.includes("C:\\state\\reports"), "应显示真实目录");
    assert.ok(text.includes(zh["settings.channel.bili_dm"]), "应列出私信渠道");
    assert.ok(!text.includes(zh["settings.smtpHost"]), "没勾邮件时不应展开 SMTP 字段");

    const emailLabel = find(tree, (node) => node.type === "label" && textOf(node).trim() === zh["settings.channel.email"]);
    assert.ok(emailLabel !== null, "应有邮件渠道复选框");
    const emailBox = find(emailLabel, (node) => node.type === "input" && node.props.type === "checkbox");
    emailBox.props.onChange();
    react.beginRender();
    tree = section.component({ t, close() {} });
    text = textOf(tree);
    assert.ok(text.includes(zh["settings.tab.bili_dm"]), "应有私信设置按钮");
    assert.ok(text.includes(zh["settings.dmPrompt"]), "渠道区应有共用的语气提示词");
    assert.ok(text.includes(zh["settings.dmPanelHint"]), "语气提示词下方应有说明");
    assert.ok(
      text.indexOf(zh["settings.dmPrompt"]) < text.indexOf(zh["settings.tab.bili_dm"]),
      "语气提示词应位于渠道选择与标签页之上"
    );
    assert.ok(text.includes(zh["settings.dmTextLabel"]), "测试私信内容输入框应有标签");
    const dmField = find(tree, (node) => node.type === "label" && textOf(node).trim() === zh["settings.dmTextLabel"]);
    assert.ok(dmField !== null, "测试私信内容应是带标签的字段");
    assert.ok(!dmField.props.style || !dmField.props.style.flex, "测试私信内容字段不应被 flex 拉伸");
    const emailTab = find(tree, (node) => node.type === "button" && textOf(node) === zh["settings.tab.email"]);
    assert.ok(emailTab !== null, "应有邮件设置按钮");
    emailTab.props.onClick();
    react.beginRender();
    tree = section.component({ t, close() {} });
    text = textOf(tree);
    assert.ok(text.includes(zh["settings.smtpHost"]), "切到邮件设置应展开 SMTP 主机");
    assert.ok(text.includes(zh["settings.smtpPort"]), "应有端口");
    assert.ok(text.includes(zh["settings.smtpPass"]), "应有授权码");
    assert.ok(text.includes(zh["settings.emailHint"]), "应有端口与加密的提示");
    assert.ok(text.includes(zh["settings.dmPrompt"]), "切到邮件设置后语气提示词仍在（私信与邮件共用）");
    assert.ok(
      text.indexOf(zh["settings.dmPrompt"]) < text.indexOf(zh["settings.smtpHost"]),
      "语气提示词应位于邮件表单之上"
    );

    const testButton = find(tree, (node) => node.type === "button" && textOf(node) === zh["settings.emailTest"]);
    assert.ok(testButton !== null, "应有发送测试邮件按钮");
    testButton.props.onClick();
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(seen.includes("email-test"), "应只调用 email-test，实际：" + seen.join(","));

    react.beginRender();
    tree = section.component({ t, close() {} });
    const passInput = find(tree, (node) => node.type === "input" && node.props.type === "password");
    assert.ok(passInput !== null, "应有授权码输入框");
    assert.equal(passInput.props.placeholder, zh["settings.smtpPassSet"], "已存的授权码要提示留空不改");
    passInput.props.onChange({ target: { value: "SECRET_CODE" } });
    react.beginRender();
    tree = section.component({ t, close() {} });
    const saveButton = find(tree, (node) => node.type === "button" && textOf(node) === zh["settings.save"]);
    saveButton.props.onClick();
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes.length, 1, "应提交一次配置");
    const patch = writes[0].patch;
    assert.equal(patch.report.save_local, true);
    assert.equal(patch.report.format, "markdown");
    assert.ok(patch.notify.channels.includes("email"), "渠道里应带上邮件");
    assert.equal(patch.notify.email.host, "smtp.qq.com");
    assert.equal(patch.notify.email.port, 465);
    assert.equal(patch.notify.email.pass, "SECRET_CODE", "填了授权码才写");
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("设置页可选报告目录：常用位置一键填入，检查与保存都走接口", async () => {
  const module = await loadClient();
  const { registered, dictionaries } = fakeContext(module);
  const section = registered.find((entry) => entry.spec.name === "settings.section");
  const zh = dictionaries[0].dicts.zh;
  const t = (key) => zh[key] ?? key;

  const desktopDir = "C:\\Users\\user\\Desktop\\B站观看报告";
  const config = {
    llm: { enabled: true, provider: "", model: "", report_prompt: "", dm_prompt: "", max_tokens: 600, timeout_ms: 20000 },
    report: {
      polish: true,
      save_local: true,
      format: "markdown",
      local_dir: "C:\\state\\reports",
      default_dir: "C:\\state\\default-reports",
      dir_options: {
        home: "C:\\Users\\user",
        options: [
          { key: "default", path: "C:\\state\\default-reports" },
          { key: "documents", path: "C:\\Users\\user\\Documents\\B站观看报告" },
          { key: "desktop", path: desktopDir }
        ]
      }
    },
    notify: { channels: [], summary_max_chars: 200, receiver_mid: "", effective_receiver: "", receiver_source: "config" },
    schedule: {
      enabled: true,
      mode: "daily",
      window: "calendar",
      cron: "0 22 * * *",
      cron_custom: "",
      timezone: "Asia/Shanghai",
      custom_from: "",
      custom_to: ""
    },
    defaults: { report_prompt: "内置报告提示词", dm_prompt: "内置私信提示词" },
    overrides: {},
    settings_file: "C:\\state\\settings.json",
    model_ready: false
  };
  const payloads = {
    status: {
      intention: null,
      latest_run: null,
      login: { reader: { logged_in: false }, sender: { logged_in: false } },
      schedule: Object.assign({}, config.schedule, { next_fire: "2026-10-27 22:00", next_window: "昨天（自然日）" })
    },
    config,
    intent: { intention: null },
    models: { providers: [], models: {}, current: {} },
    "dir-check": { ok: true, input: desktopDir, resolved: desktopDir, created: true },
    "config-set": { applied: [], rejected: [], overrides: {}, effective: {} }
  };

  const seen = [];
  const writes = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const action = new URL(String(url), "http://127.0.0.1").searchParams.get("action") ?? "";
    seen.push(action);
    if (action === "config-set" && options && typeof options.body === "string") writes.push(JSON.parse(options.body));
    const data = payloads[action];
    return {
      status: 200,
      json: async () => (data === undefined ? { ok: false, error: "unknown action " + action } : { ok: true, action, data })
    };
  };

  try {
    const react = resetReact();
    react.beginRender();
    section.component({ t, close() {} });
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
    react.beginRender();
    let tree = section.component({ t, close() {} });
    let text = textOf(tree);
    assert.ok(text.includes(zh["settings.dirPick"]), "应有常用位置一行：" + text);
    assert.ok(text.includes(zh["settings.dir.documents"]), "应有文档快捷按钮");
    assert.ok(text.includes(zh["settings.dir.desktop"]), "应有桌面快捷按钮");

    const deskButton = find(tree, (node) => node.type === "button" && textOf(node) === zh["settings.dir.desktop"]);
    assert.ok(deskButton !== null, "应有桌面快捷按钮");
    deskButton.props.onClick();
    react.beginRender();
    tree = section.component({ t, close() {} });
    const dirInput = find(tree, (node) => node.type === "input" && node.props.value === desktopDir);
    assert.ok(dirInput !== null, "点快捷按钮应把目录填进输入框");

    const checkButton = find(tree, (node) => node.type === "button" && textOf(node) === zh["settings.dirCheck"]);
    assert.ok(checkButton !== null, "应有检查目录按钮");
    checkButton.props.onClick();
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(seen.includes("dir-check"), "应调用目录检查接口，实际：" + seen.join(","));
    react.beginRender();
    tree = section.component({ t, close() {} });
    text = textOf(tree);
    assert.ok(text.includes(zh["settings.dirOk"]), "应显示目录可用：" + text);
    assert.ok(text.includes(zh["settings.dirCreated"]), "应提示已创建");

    const saveButton = find(tree, (node) => node.type === "button" && textOf(node) === zh["settings.save"]);
    assert.ok(saveButton !== null);
    saveButton.props.onClick();
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes.length, 1, "应提交一次配置");
    assert.equal(writes[0].patch.report.local_dir, desktopDir);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
