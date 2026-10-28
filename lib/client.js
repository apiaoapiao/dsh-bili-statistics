/**
 * dsh-bili-statistics 的浏览器半侧。
 *
 * 只做一件事：为 bili_intent_* 这组 wire 工具注册 `tool.call.toolview` 卡片。
 * 卡片是只读的：它读宿主经 presentationMeta 落进 tool/result 的展示载荷，
 * 不发起任何远程调用（owner 里没有 sessionId，客户端按钮无法触发工具调用）。
 *
 * 约束：必须是已构建的 __ModuleLoader__ bundle；只 require 平台冻结表里的 react；
 * 不 import 任何 @deepseek-ai/* 客户端包（primitives 被明令禁止，控件全部手写）。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-bili-statistics',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const NS = 'bili-statistics';

    /** 需要接管外观的 wire 工具名；其余工具继续走通用卡片。 */
    const TOOL_KEYS = [
      'bili_intent_set',
      'bili_intent_status',
      'bili_intent_facts',
      'bili_intent_annotate',
      'bili_intent_report',
      'bili_intent_feedback',
      'bili_intent_notify',
      'bili_intent_login',
      'bili_intent_login_poll'
    ];

    const TOOL_LABEL = {
      bili_intent_set: 'tool.set',
      bili_intent_status: 'tool.status',
      bili_intent_facts: 'tool.facts',
      bili_intent_annotate: 'tool.annotate',
      bili_intent_report: 'tool.report',
      bili_intent_feedback: 'tool.feedback',
      bili_intent_notify: 'tool.notify',
      bili_intent_login: 'tool.bili_intent_login',
      bili_intent_login_poll: 'tool.bili_intent_login_poll'
    };

    /** 简体中文词条（键集的事实来源）。 */
    const zh = {
        "title": "B 站观看统计",
        "preparing": "准备统计观看历史",
        "running": "正在拉取观看历史…",
        "failed": "统计失败",
        "items": "条记录",
        "shape": "观看状态",
        "confidence": "可信度",
        "completion": "平均完成度",
        "lateNight": "深夜占比",
        "chains": "连续自动播放",
        "hypotheses": "计划情况",
    "overview": "概览",
        "evidence": "证据",
        "empty": "本次窗口没有足够记录，或看不出明确模式。",
        "factsOnly": "仅有统计事实：这次没有模型给出的结论。",
        "footer": "数字来自 B 站接口；「观看状态」和「是不是自己点的」都是推断。",
        "openReport": "打开报告",
        "inspect": "查看详情",
        "baseline": "基线",
        "clue": "线索",
        "shape.fragmented_binge": "碎片化连刷",
        "shape.comfort_repetition": "重复性陪伴观看",
        "shape.focused_longform": "相对专注的长内容",
        "shape.late_night_surf": "深夜滑屏",
        "shape.mixed": "混合型",
        "tool.set": "计划",
        "tool.status": "状态",
        "tool.facts": "统计事实",
        "tool.annotate": "计划情况",
        "tool.report": "观看报告",
        "tool.feedback": "报告反馈",
        "tool.notify": "私信通知",
        "status.intention": "当前计划",
        "status.noIntention": "还没有定计划",
        "status.runs": "历史运行",
        "notify.sent": "已投递",
        "notify.dry": "预演（未真正发送）",
        "notify.failed": "投递失败",
        "inference": "推断",
        "tool.bili_intent_login": "扫码登录",
        "tool.bili_intent_login_poll": "扫码状态",
        "login.hint": "用手机 B 站 App 扫一扫，然后在手机上点确认",
        "login.hintTv": "这是 TV 通道的码：用手机 B 站 App 扫一扫，确认「登录 TV 版」",
        "login.switched": "网页端扫码被 B 站拦截（-412），已自动切换到 TV 通道，请重新扫码",
        "login.channel.web": "网页通道",
        "login.channel.tv": "TV 通道",
        "login.role.reader": "读观看历史的账号",
        "login.role.sender": "发私信的账号",
        "login.expire": "二维码 {s} 秒内有效",
        "login.expired": "二维码已失效：重新发起登录会刷新",
        "login.url": "卡片没显示二维码？把这个链接发到手机打开：",
        "loginState.waiting": "等待扫码",
        "loginState.scanned": "已扫码，等手机确认",
        "loginState.confirmed": "登录成功",
        "loginState.expired": "二维码已失效",
        "loginState.error": "查询失败",
        "loginState.usable": "凭据已验证",
        "loginState.unverified": "凭据已保存，未验证",
        "login.preparing": "正在生成二维码…",
        "login.running": "正在向 B 站确认…",
        "settings.nav": "B 站观看统计",
        "settings.title": "B 站观看统计",
        "settings.subtitle": "交互都在这里；会话里的工具只读统计与报告。",
        "settings.status": "当前状态",
        "settings.login": "扫码登录",
        "settings.loginIdle": "上面点「扫码登录」，二维码会显示在这里。",
        "settings.loginDone": "登录成功",
        "settings.intent": "计划",
        "settings.intentPlaceholder": "例如：这周只看两门课的公开课，十一点前睡",
        "settings.saveIntent": "保存计划",
        "settings.savedIntent": "计划已保存",
        "settings.logout": "退出登录",
        "settings.scan": "扫码登录",
        "settings.notLoggedIn": "未登录",
        "settings.days": "天",
        "settings.latest": "最近一次统计",
        "settings.noRun": "还没有跑过",
        "settings.runNow": "立即统计一次",
        "settings.running": "统计中…",
        "settings.runDone": "已生成报告",
        "settings.notifyTest": "发测试私信",
        "settings.sending": "发送中…",
        "settings.notifyDone": "测试私信已发出",
        "settings.notifyPlaceholder": "留空则用最近一次统计的摘要",
        "settings.manualHint": "定时任务不依赖这个页面：到点照样拉历史、写报告、按通知渠道发送。测试私信在「通知渠道 → 私信设置」里。",
        "settings.tab.bili_dm": "私信设置",
        "settings.tab.email": "邮件设置",
        "settings.dmPanelHint": "只影响语气，不影响统计数字；可用 {max_chars} 表示字数上限。",
        "settings.dmTextLabel": "测试私信内容",
        "settings.schedule": "定时任务",
        "settings.scheduleOn": "启用定时",
        "settings.scheduleOff": "定时已暂停",
        "settings.scheduleMode": "周期",
        "settings.scheduleWindow": "统计窗口",
        "settings.triggerTime": "触发时间",
        "settings.weekdayLabel": "星期",
        "settings.dayOfMonth": "日期",
        "settings.weekday.1": "周一",
        "settings.weekday.2": "周二",
        "settings.weekday.3": "周三",
        "settings.weekday.4": "周四",
        "settings.weekday.5": "周五",
        "settings.weekday.6": "周六",
        "settings.weekday.7": "周日",
        "settings.mode.daily": "每天",
        "settings.mode.weekly": "每周",
        "settings.mode.monthly": "每月",
        "settings.mode.custom": "自定义区间",
        "settings.window.daily.calendar": "昨天整天",
        "settings.window.daily.rolling": "最近 24 小时",
        "settings.window.weekly.calendar": "过去 7 个自然日",
        "settings.window.weekly.rolling": "最近 7×24 小时",
        "settings.window.monthly.calendar": "上一个自然月",
        "settings.window.monthly.rolling": "最近 30 天",
        "settings.scheduleNext": "下次",
        "settings.scheduleLast": "上次触发",
        "settings.lastRan": "已执行",
        "settings.lastSkipped": "跳过",
        "settings.lastFailed": "失败",
        "settings.scheduleHint": "到点按上面的设置统计；改完点「保存设置」立即生效，不用重启",
        "settings.customFrom": "开始日期",
        "settings.customTo": "结束日期",
        "settings.scheduleSaved": "定时已保存",
        "settings.receiver": "接收方 UID（私信发给谁）",
        "settings.receiverEmpty": "还没有可用的接收方：先扫码登录读历史账号，或在这里填 UID",
        "settings.receiverHint": "实际收件人",
        "settings.receiverFromReader": "来自读历史账号",
        "settings.actions": "手动触发",
        "settings.preview": "本次输出预览",
        "settings.model": "模型与语气",
        "settings.provider": "模型提供方",
        "settings.noModel": "不启用（只用模板摘要）",
        "settings.pickModel": "请选择模型",
        "settings.reportPolish": "模型写概览与计划情况（照视频标题）",
        "settings.modelReady": "模型已就绪",
        "settings.modelMissing": "未选择模型：报告只有数字，没有概览和计划情况",
        "settings.reportPrompt": "概览与计划情况的提示词（留空用内置）",
        "settings.dmPrompt": "语气提示词（私信与邮件共用，留空用内置）",
        "settings.maxChars": "私信字数上限",
        "settings.maxTokens": "最大 token",
        "settings.timeout": "超时（毫秒）",
        "settings.save": "保存设置",
        "settings.configSaved": "设置已保存",
        "settings.rejected": "已忽略",
        "settings.file": "覆盖配置写在",
        "settings.polished": "模型润色",
        "settings.fallback": "模板摘要",
  "settings.polishFail": "润色失败",
        "settings.loading": "读取中…",
        "settings.groupSave": "本地保存",
        "settings.groupNotify": "通知渠道",
        "settings.saveLocal": "保存报告到本地",
        "settings.format": "格式",
        "settings.format.markdown": "Markdown",
        "settings.format.html": "HTML",
        "settings.format.both": "两种都写",
        "settings.saveDir": "报告目录",
        "settings.dirPick": "常用位置",
        "settings.dir.default": "默认",
        "settings.dir.documents": "文档",
        "settings.dir.desktop": "桌面",
        "settings.dirCheck": "检查目录",
        "settings.dirHint": "留空 = 插件默认目录，支持 ~ 开头；检查会创建目录并试写一个临时文件",
        "settings.dirCurrent": "当前",
        "settings.dirOk": "目录可用",
        "settings.dirBad": "目录不可用",
        "settings.dirCreated": "已创建",
        "settings.channels": "渠道",
        "settings.channel.bili_dm": "私信",
        "settings.channel.email": "邮件",
        "settings.channelHint": "勾选才会推送；各渠道互相独立，一个失败不影响其它",
        "settings.smtpHost": "SMTP 主机",
        "settings.smtpPort": "端口",
        "settings.smtpSecure": "隐式 TLS（465）",
        "settings.smtpAllowPlain": "允许明文",
        "settings.smtpUser": "登录名",
        "settings.smtpPass": "授权码",
        "settings.smtpPassSet": "已保存，留空不改",
        "settings.emailFrom": "发件地址",
        "settings.emailTo": "收件地址",
        "settings.emailFromName": "显示名",
        "settings.subjectPrefix": "主题前缀",
        "settings.attachReport": "附 Markdown 报告",
        "settings.emailRetries": "重试",
        "settings.emailBackoff": "退避（毫秒）",
        "settings.emailTest": "发送测试邮件",
        "settings.emailSending": "发送中…",
        "settings.emailDone": "已发出测试邮件",
        "settings.emailHint": "端口与加密要配对：465 用隐式 TLS，587 用 STARTTLS；授权码在邮箱设置里单独生成，不是登录密码",
        "settings.notifyFailed": "发送失败"
    };

    /** 英文词条，与 zh 键集完全一致。 */
    const en = {
        "title": "Bilibili watch statistics",
        "preparing": "Preparing watch-history statistics",
        "running": "Fetching watch history…",
        "failed": "Statistics failed",
        "items": "items",
        "shape": "Viewing type",
        "confidence": "Reliability",
        "completion": "Mean completion",
        "lateNight": "Late-night share",
        "chains": "Longest autoplay run",
        "hypotheses": "Plan status",
    "overview": "Overview",
        "evidence": "Evidence",
        "empty": "Not enough records in this window, or no clear pattern.",
        "factsOnly": "Statistics only: the model gave no conclusions this time.",
        "footer": "Numbers come from Bilibili; viewing type and whether you clicked are inferred.",
        "openReport": "Open report",
        "inspect": "Inspect",
        "baseline": "Baseline",
        "clue": "Clue",
        "shape.fragmented_binge": "Fragmented binge",
        "shape.comfort_repetition": "Comfort repetition",
        "shape.focused_longform": "Focused long-form",
        "shape.late_night_surf": "Late-night surfing",
        "shape.mixed": "Mixed",
        "tool.set": "Plan",
        "tool.status": "Status",
        "tool.facts": "Statistical facts",
        "tool.annotate": "Plan status",
        "tool.report": "Watch report",
        "tool.feedback": "Report feedback",
        "tool.notify": "DM notification",
        "status.intention": "Current plan",
        "status.noIntention": "No plan set yet",
        "status.runs": "History runs",
        "notify.sent": "Delivered",
        "notify.dry": "Dry run (nothing sent)",
        "notify.failed": "Delivery failed",
        "inference": "inference",
        "tool.bili_intent_login": "QR login",
        "tool.bili_intent_login_poll": "QR login status",
        "login.hint": "Scan with the Bilibili app, then confirm on your phone",
        "login.hintTv": "TV channel QR: scan with the Bilibili app and approve the TV sign-in prompt",
        "login.switched": "Web QR polling was blocked by Bilibili (-412); switched to the TV channel, please scan again",
        "login.channel.web": "Web channel",
        "login.channel.tv": "TV channel",
        "login.role.reader": "Account that reads watch history",
        "login.role.sender": "Account that sends DMs",
        "login.expire": "QR code valid for {s}s",
        "login.expired": "QR code expired: starting again refreshes it",
        "login.url": "No QR code on the card? Open this link on your phone:",
        "loginState.waiting": "Waiting for scan",
        "loginState.scanned": "Scanned, confirm on phone",
        "loginState.confirmed": "Logged in",
        "loginState.expired": "QR code expired",
        "loginState.error": "Check failed",
        "loginState.usable": "Credentials verified",
        "loginState.unverified": "Saved, not verified",
        "login.preparing": "Generating QR code…",
        "login.running": "Contacting Bilibili…",
        "settings.nav": "Bilibili watch statistics",
        "settings.title": "Bilibili watch statistics",
        "settings.subtitle": "All interaction lives here; session tools only read statistics and reports.",
        "settings.status": "Current state",
        "settings.login": "QR login",
        "settings.loginIdle": "Pick `Scan` above and the QR code shows up here.",
        "settings.loginDone": "Logged in",
        "settings.intent": "Plan",
        "settings.intentPlaceholder": "e.g. only two open courses this week, asleep before 23:00",
        "settings.saveIntent": "Save plan",
        "settings.savedIntent": "Plan saved",
        "settings.logout": "Log out",
        "settings.scan": "Scan",
        "settings.notLoggedIn": "Not logged in",
        "settings.days": "days",
        "settings.latest": "Latest run",
        "settings.noRun": "No run yet",
        "settings.runNow": "Run statistics now",
        "settings.running": "Running…",
        "settings.runDone": "Report generated",
        "settings.notifyTest": "Send test DM",
        "settings.sending": "Sending…",
        "settings.notifyDone": "Test DM sent",
        "settings.notifyPlaceholder": "Leave empty to use the latest summary",
        "settings.manualHint": "Scheduled runs do not depend on this page: they still fetch history, write reports and send via the chosen channels. Test DMs live under Notify → DM settings.",
        "settings.tab.bili_dm": "DM settings",
        "settings.tab.email": "Email settings",
        "settings.dmPanelHint": "Only the tone changes, not the numbers. Use {max_chars} for the character budget.",
        "settings.dmTextLabel": "Test DM content",
        "settings.schedule": "Schedule",
        "settings.scheduleOn": "Enable schedule",
        "settings.scheduleOff": "Schedule paused",
        "settings.scheduleMode": "Period",
        "settings.scheduleWindow": "Window",
        "settings.triggerTime": "Trigger time",
        "settings.weekdayLabel": "Weekday",
        "settings.dayOfMonth": "Day",
        "settings.weekday.1": "Mon",
        "settings.weekday.2": "Tue",
        "settings.weekday.3": "Wed",
        "settings.weekday.4": "Thu",
        "settings.weekday.5": "Fri",
        "settings.weekday.6": "Sat",
        "settings.weekday.7": "Sun",
        "settings.mode.daily": "Daily",
        "settings.mode.weekly": "Weekly",
        "settings.mode.monthly": "Monthly",
        "settings.mode.custom": "Custom range",
        "settings.window.daily.calendar": "Yesterday (whole day)",
        "settings.window.daily.rolling": "Last 24 hours",
        "settings.window.weekly.calendar": "Past 7 calendar days",
        "settings.window.weekly.rolling": "Last 7×24 hours",
        "settings.window.monthly.calendar": "Previous calendar month",
        "settings.window.monthly.rolling": "Last 30 days",
        "settings.scheduleNext": "Next",
        "settings.scheduleLast": "Last run",
        "settings.lastRan": "ran",
        "settings.lastSkipped": "skipped",
        "settings.lastFailed": "failed",
        "settings.scheduleHint": "Fires at the time above; click Save to apply immediately, no restart needed",
        "settings.customFrom": "From",
        "settings.customTo": "To",
        "settings.scheduleSaved": "Schedule saved",
        "settings.receiver": "Recipient UID (who receives the DM)",
        "settings.receiverEmpty": "No recipient yet: sign in the history account first, or type a UID here",
        "settings.receiverHint": "Effective recipient",
        "settings.receiverFromReader": "from the history account",
        "settings.actions": "Manual triggers",
        "settings.preview": "Output preview",
        "settings.model": "Model and tone",
        "settings.provider": "Provider",
        "settings.noModel": "Disabled (template summary only)",
        "settings.pickModel": "Pick a model",
        "settings.reportPolish": "Model writes overview and plan status (from video titles)",
        "settings.modelReady": "Model is ready",
        "settings.modelMissing": "No model selected: the report has numbers only",
        "settings.reportPrompt": "Overview and plan status prompt (empty = built-in)",
        "settings.dmPrompt": "Tone prompt (shared by DM and email; empty = built-in)",
        "settings.maxChars": "DM character limit",
        "settings.maxTokens": "Max tokens",
        "settings.timeout": "Timeout (ms)",
        "settings.save": "Save settings",
        "settings.configSaved": "Settings saved",
        "settings.rejected": "Ignored",
        "settings.file": "Override file",
        "settings.polished": "Model polished",
        "settings.fallback": "Template summary",
  "settings.polishFail": "Polish failed",
        "settings.loading": "Loading…",
        "settings.groupSave": "Local saving",
        "settings.groupNotify": "Notification channels",
        "settings.saveLocal": "Save reports to disk",
        "settings.format": "Format",
        "settings.format.markdown": "Markdown",
        "settings.format.html": "HTML",
        "settings.format.both": "Both",
        "settings.saveDir": "Report folder",
        "settings.dirPick": "Quick picks",
        "settings.dir.default": "Default",
        "settings.dir.documents": "Documents",
        "settings.dir.desktop": "Desktop",
        "settings.dirCheck": "Check folder",
        "settings.dirHint": "Empty = plugin default; ~ is expanded. Checking creates the folder and writes a probe file.",
        "settings.dirCurrent": "Current",
        "settings.dirOk": "Folder is usable",
        "settings.dirBad": "Folder is not usable",
        "settings.dirCreated": "created",
        "settings.channels": "Channels",
        "settings.channel.bili_dm": "DM",
        "settings.channel.email": "Email",
        "settings.channelHint": "Only checked channels push; they are independent, one failure does not block the others",
        "settings.smtpHost": "SMTP host",
        "settings.smtpPort": "Port",
        "settings.smtpSecure": "Implicit TLS (465)",
        "settings.smtpAllowPlain": "Allow plaintext",
        "settings.smtpUser": "Login",
        "settings.smtpPass": "App password",
        "settings.smtpPassSet": "Saved, leave empty to keep",
        "settings.emailFrom": "From",
        "settings.emailTo": "To",
        "settings.emailFromName": "Sender name",
        "settings.subjectPrefix": "Subject prefix",
        "settings.attachReport": "Attach Markdown report",
        "settings.emailRetries": "Retries",
        "settings.emailBackoff": "Backoff (ms)",
        "settings.emailTest": "Send test email",
        "settings.emailSending": "Sending…",
        "settings.emailDone": "Test email sent",
        "settings.emailHint": "Port and encryption must match: 465 uses implicit TLS, 587 upgrades via STARTTLS. The app password is generated in your mailbox settings, not your login password",
        "settings.notifyFailed": "Delivery failed"
    };

    /** 全部样式内联，只用主题变量，不加载外部样式表。 */
    const S = {
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-lg)',
        background: 'var(--dsw-alias-bg-base)',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        fontSize: '13px',
        lineHeight: '1.5',
        color: 'var(--dsw-alias-label-primary)'
      },
      slim: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '6px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-tertiary)',
        padding: '4px 2px'
      },
      slimLabel: { color: 'var(--dsw-alias-label-secondary)' },
      slimText: {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      },
      head: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '8px'
      },
      headLeft: { display: 'flex', alignItems: 'baseline', gap: '6px' },
      title: { fontSize: '13px', fontWeight: 600 },
      headMeta: {
        fontSize: '12px',
        color: 'var(--dsw-alias-label-tertiary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      },
      badge: {
        border: '1px solid var(--dsw-alias-border-l3)',
        borderRadius: '999px',
        padding: '0 6px',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap'
      },
      grid: { display: 'flex', flexWrap: 'wrap', gap: '8px 16px' },
      cell: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: '88px' },
      cellLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      cellValue: { fontSize: '13px', fontVariantNumeric: 'tabular-nums' },
      note: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      overview: {
        fontSize: '13px',
        lineHeight: '1.6',
        color: 'var(--dsw-alias-label-secondary)',
        wordBreak: 'break-word',
        maxHeight: '120px',
        overflow: 'auto'
      },
      list: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        margin: 0,
        padding: 0,
        listStyle: 'none'
      },
      item: {
        borderLeft: '2px solid var(--dsw-alias-border-l3)',
        paddingLeft: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px'
      },
      itemText: { fontSize: '13px' },
      chips: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)'
      },
      foot: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-tertiary)'
      },
      actions: { display: 'flex', gap: '6px' },
      button: {
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm)',
        color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: '11px',
        padding: '2px 8px',
        cursor: 'pointer'
      },
      qrWrap: {
        alignSelf: 'center',
        background: '#ffffff',
        borderRadius: 'var(--dsw-radius-sm)',
        padding: '6px',
        lineHeight: 0
      },
      qrText: {
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
        wordBreak: 'break-all',
        userSelect: 'text'
      },
      error: { color: 'var(--dsw-alias-state-error-primary)' },
      panel: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '2px 0', fontSize: '13px' },
      group: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-lg)',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px'
      },
      groupTitle: { fontSize: '13px', fontWeight: 600 },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '13px' },
      rowKey: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', minWidth: '96px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      fieldLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      clock: { display: 'flex', alignItems: 'center', gap: '4px' },
      clockColon: { color: 'var(--dsw-alias-label-secondary)' },
      input: {
        font: 'inherit',
        fontSize: '13px',
        padding: '4px 6px',
        borderRadius: 'var(--dsw-radius-sm)',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        width: '100%',
        boxSizing: 'border-box'
      },
      textarea: {
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '1.6',
        padding: '6px',
        minHeight: '72px',
        resize: 'vertical',
        borderRadius: 'var(--dsw-radius-sm)',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        width: '100%',
        boxSizing: 'border-box'
      },
      primary: {
        background: 'var(--dsw-alias-interactive-bg-hover-solid)',
        border: '1px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-sm)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '12px',
        padding: '3px 10px',
        cursor: 'pointer'
      },
      ok: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary)' },
      bad: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      hint: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      pre: {
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: '11px',
        lineHeight: '1.5',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        margin: 0,
        maxHeight: '180px',
        overflow: 'auto',
        color: 'var(--dsw-alias-label-secondary)'
      }
    };

    /** 取词条；空串/缺键/抛错都退回 fallback，卡片绝不因缺翻译崩掉。 */
    function text(t, key, fallback) {
      try {
        const value = typeof t === 'function' ? t(key) : key;
        if (typeof value === 'string' && value.length > 0 && value !== key) return value;
      } catch (error) {
        /* 忽略：缺翻译不是渲染错误 */
      }
      return fallback;
    }

    function clip(value, max) {
      const text = String(value == null ? '' : value);
      return text.length > max ? text.slice(0, max - 1) + '…' : text;
    }

    function pct(value) {
      return typeof value === 'number' && isFinite(value) ? Math.round(value * 100) + '%' : '—';
    }

    function num(value) {
      return typeof value === 'number' && isFinite(value) ? String(value) : '—';
    }

    /** tool/result 的 content 里第一段文本，作为没有展示载荷时的兜底摘要。 */
    function firstText(block) {
      const content = block && Array.isArray(block.content) ? block.content : [];
      for (const part of content) {
        if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0) {
          return clip(part.text.trim().replace(/\s+/g, ' '), 180);
        }
      }
      return '';
    }

    /** 失败态的错误文案：error 可能是字符串，也可能是 {message}。 */
    function errorText(block, fallback) {
      const error = block ? block.error : null;
      if (typeof error === 'string' && error.length > 0) return clip(error, 180);
      if (error && typeof error.message === 'string' && error.message.length > 0) return clip(error.message, 180);
      const textContent = firstText(block);
      return textContent.length > 0 ? textContent : fallback;
    }

    function cell(label, value, extra) {
      const children = [
        h('span', { key: 'label', style: S.cellLabel }, label),
        h('span', { key: 'value', style: S.cellValue }, value)
      ];
      if (typeof extra === 'string' && extra.length > 0) {
        children.push(h('span', { key: 'extra', style: S.note }, extra));
      }
      return h('div', { key: label, style: S.cell }, children);
    }

    function slimRow(className, label, detail, isError) {
      return h('div', { style: S.slim, className: className }, [
        h('span', { key: 'label', style: S.slimLabel }, label),
        typeof detail === 'string' && detail.length > 0
          ? h('span', { key: 'detail', style: isError ? S.error : S.slimText }, detail)
          : null
      ]);
    }

    /** 统计事实卡片：只展示已落库的展示载荷，不重新计算。 */
    function reportCard(props, meta, tr) {
      const windowInfo = meta.window && typeof meta.window === 'object' ? meta.window : {};
      const shape = typeof meta.shape === 'string' ? meta.shape : 'mixed';
      // 模型起的观看状态名优先；模型没跑（离线 / 失败）时退回规则标签。
      const modelShape = typeof meta.shape_label === 'string' && meta.shape_label.trim().length > 0 ? meta.shape_label.trim() : '';
      const shapeReason = typeof meta.shape_reason === 'string' ? meta.shape_reason.trim() : '';
      const shapeLabel = modelShape || tr('shape.' + shape, shape);
      const baseline = meta.baseline && typeof meta.baseline === 'object' ? meta.baseline : null;
      let baselineNote = null;
      if (baseline && typeof baseline.lookback_runs === 'number' && baseline.lookback_runs >= 3 && typeof baseline.delta_ratio === 'number') {
        const sign = baseline.delta_ratio > 0 ? '+' : '';
        baselineNote = tr('baseline', 'baseline') + ' · ' + baseline.lookback_runs + '× → ' + sign + pct(baseline.delta_ratio);
      }
      const cells = [
        cell(tr('items', 'items'), num(meta.total_items), baselineNote),
        cell(
          tr('shape', 'shape'),
          shapeLabel,
          modelShape
            ? (shapeReason.length > 0 ? clip(shapeReason, 40) : null)
            : tr('confidence', 'confidence') + ' ' + pct(meta.confidence)
        ),
        cell(tr('completion', 'completion'), pct(meta.completion)),
        cell(tr('lateNight', 'late-night'), pct(meta.late_night_share)),
        cell(tr('chains', 'binge run'), num(meta.max_chain))
      ];
      const hypotheses = Array.isArray(meta.hypotheses) ? meta.hypotheses : [];
      const items = hypotheses.map((hypothesis, index) => {
        const evidenceCount = Array.isArray(hypothesis.evidence) ? hypothesis.evidence.length : 0;
        const chips = [tr('evidence', 'evidence') + ' ' + evidenceCount];
        if (typeof hypothesis.clue === 'string' && hypothesis.clue.length > 0) {
          chips.push(tr('clue', 'clue') + '：' + clip(hypothesis.clue, 80));
        }
        return h('li', { key: 'h' + index, style: S.item }, [
          h('span', { key: 'text', style: S.itemText }, String(hypothesis.text == null ? '' : hypothesis.text)),
          h('span', { key: 'chips', style: S.chips }, chips.join(' · '))
        ]);
      });
      const paths = Array.isArray(meta.paths) ? meta.paths.filter((entry) => typeof entry === 'string' && entry.length > 0) : [];
      const actions = [];
      if (paths.length > 0 && typeof props.openFile === 'function') {
        actions.push(h('button', {
          key: 'open',
          type: 'button',
          style: S.button,
          onClick: () => props.openFile(paths[0])
        }, tr('openReport', 'open report')));
      }
      if (typeof props.inspect === 'function') {
        actions.push(h('button', {
          key: 'inspect',
          type: 'button',
          style: S.button,
          onClick: () => props.inspect()
        }, tr('inspect', 'inspect')));
      }
      const overview = typeof meta.overview === 'string' ? meta.overview.trim().replace(/\s+/g, ' ') : '';
      const body = [];
      body.push(h('div', { key: 'grid', style: S.grid }, cells));
      if (overview.length > 0) {
        body.push(h('div', { key: 'overview', style: S.overview, title: meta.overview }, tr('overview', 'overview') + '：' + clip(overview, 300)));
      }
      body.push(h('div', { key: 'rule', style: S.note }, hypotheses.length > 0 ? tr('hypotheses', 'hypotheses') : tr('factsOnly', 'statistics only')));
      if (items.length > 0) body.push(h('ul', { key: 'list', style: S.list }, items));
      if (hypotheses.length === 0 && num(meta.total_items) === '0') {
        body.push(h('div', { key: 'empty', style: S.note }, tr('empty', 'no clear pattern')));
      }
      body.push(h('div', { key: 'foot', style: S.foot }, [
        h('span', { key: 'note' }, tr('footer', '')),
        actions.length > 0 ? h('div', { key: 'actions', style: S.actions }, actions) : null
      ]));
      return h('div', {
        className: 'bili-intent-card',
        style: S.card,
        'data-tool': props.toolName,
        'data-shape': shape
      }, [
        h('div', { key: 'head', style: S.head }, [
          h('div', { key: 'left', style: S.headLeft }, [
            h('span', { key: 'title', style: S.title }, tr('title', 'intent drift')),
            h('span', { key: 'badge', style: S.badge }, tr('inference', 'inference'))
          ]),
          h('span', { key: 'window', style: S.headMeta }, typeof windowInfo.label === 'string' ? windowInfo.label : '')
        ])
      ].concat(body));
    }

    /** 没有展示载荷的 bili_* 工具：一行摘要，保持会话里不占地方。 */
    function compactRow(props, meta, tr) {
      const label = tr(TOOL_LABEL[props.toolName] || 'title', String(props.toolName || ''));
      let detail = firstText(props.block);
      if (meta) {
        if (typeof meta.intention === 'string' && meta.intention.length > 0) {
          detail = '「' + clip(meta.intention, 120) + '」';
        } else if (typeof meta.saved === 'number') {
          detail = String(meta.saved) + ' 条';
        } else if (typeof meta.verdict === 'string') {
          detail = meta.verdict;
        }
      }
      return slimRow('bili-intent-row', label, detail, false);
    }

    /**
     * 把宿主算好的矩阵画成 SVG：白底黑码（扫码枪/相机需要高对比），
     * 横向连续的黑格合并成一条 path，一张码通常只有几百个节点。
     */
    function qrSvg(dots, size) {
      const rows = typeof dots === 'string' ? dots.split('\n').filter((row) => row.length > 0) : [];
      if (rows.length === 0) return null;
      const n = typeof size === 'number' && size > 0 ? size : rows.length;
      let d = '';
      for (let y = 0; y < rows.length; y += 1) {
        const row = rows[y];
        let x = 0;
        while (x < row.length) {
          if (row.charAt(x) !== '1') {
            x += 1;
            continue;
          }
          let end = x;
          while (end < row.length && row.charAt(end) === '1') end += 1;
          d += 'M' + x + ' ' + y + 'h' + (end - x) + 'v1h-' + (end - x) + 'z';
          x = end;
        }
      }
      const px = 200;
      return h('svg', {
        key: 'qr',
        viewBox: '0 0 ' + n + ' ' + n,
        width: px,
        height: px,
        shapeRendering: 'crispEdges',
        focusable: 'false',
        role: 'img',
        'aria-label': 'QR'
      }, [
        h('rect', { key: 'bg', x: 0, y: 0, width: n, height: n, fill: '#ffffff' }),
        h('path', { key: 'fg', d: d, fill: '#000000' })
      ]);
    }

    /** 扫码登录卡片：二维码 + 链接兜底（卡片画不出码时还能把链接发到手机）。 */
    function loginCard(props, meta, tr) {
      const role = meta.role === 'sender' ? 'sender' : 'reader';
      const svg = qrSvg(meta.dots, meta.size);
      const seconds = typeof meta.expires_in_seconds === 'number' ? meta.expires_in_seconds : 180;
      const url = typeof meta.url === 'string' ? meta.url : '';
      const body = [];
      if (svg) {
        body.push(h('div', { key: 'qr', style: S.qrWrap }, svg));
        body.push(h('div', { key: 'hint', style: S.note }, tr('login.hint', 'scan and confirm on your phone')));
      } else {
        body.push(h('div', { key: 'hint', style: S.note }, tr('login.expired', 'QR code expired')));
      }
      if (url.length > 0) {
        body.push(h('div', { key: 'urlLabel', style: S.note }, tr('login.url', 'Open this link on your phone:')));
        body.push(h('div', { key: 'url', style: S.qrText, title: url }, url));
      }
      return h('div', {
        className: 'bili-intent-card bili-intent-login',
        style: S.card,
        'data-tool': props.toolName,
        'data-role': role
      }, [
        h('div', { key: 'head', style: S.head }, [
          h('div', { key: 'left', style: S.headLeft }, [
            h('span', { key: 'title', style: S.title }, tr('tool.bili_intent_login', 'QR login')),
            h('span', { key: 'badge', style: S.badge }, tr('login.role.' + role, role))
          ]),
          h('span', { key: 'expire', style: S.headMeta }, tr('login.expire', 'valid for {s}s').replace('{s}', String(seconds)))
        ])
      ].concat(body));
    }

    /** 扫码状态卡片：一行说清「在等 / 已扫 / 成功 / 失效」。 */
    function loginStateCard(props, meta, tr) {
      const state = typeof meta.state === 'string' && meta.state.length > 0 ? meta.state : 'error';
      const role = meta.role === 'sender' ? 'sender' : 'reader';
      const isError = state === 'error' || state === 'expired';
      const label = tr('loginState.' + state, state);
      const parts = [tr('login.role.' + role, role)];
      if (typeof meta.uname === 'string' && meta.uname.length > 0) parts.push(clip(meta.uname, 24));
      else if (typeof meta.mid === 'number') parts.push('UID ' + meta.mid);
      if (state === 'confirmed') parts.push(tr(meta.usable ? 'loginState.usable' : 'loginState.unverified', ''));
      if (typeof meta.message === 'string' && meta.message.length > 0 && state !== 'confirmed') {
        parts.push(clip(meta.message, 80));
      }
      return slimRow('bili-intent-row bili-intent-login-state', label, parts.filter((part) => part.length > 0).join(' · '), isError);
    }

    /** 所有 bili_intent_* 共用的卡片入口。 */
    function Card(props) {
      const safeProps = props || {};
      const t = safeProps.t;
      const tr = (key, fallback) => text(t, key, fallback);
      const busyLabel = tr(TOOL_LABEL[safeProps.toolName] || 'tool.facts', tr('tool.facts', 'facts'));
      const isLogin = String(safeProps.toolName || '').indexOf('bili_intent_login') === 0;
      if (safeProps.phase === 'preparing') {
        return slimRow('bili-intent-row', busyLabel, tr(isLogin ? 'login.preparing' : 'preparing', 'preparing…'), false);
      }
      if (safeProps.phase === 'start') {
        return slimRow('bili-intent-row', busyLabel, tr(isLogin ? 'login.running' : 'running', 'running…'), false);
      }
      const block = safeProps.block || {};
      if (block.isError) {
        return slimRow('bili-intent-row', tr('failed', 'failed'), errorText(block, ''), true);
      }
      const meta = block.meta && typeof block.meta === 'object' ? block.meta : null;
      if (meta && meta.kind === 'bili-intent-report') return reportCard(safeProps, meta, tr);
      if (meta && meta.kind === 'bili-intent-login') return loginCard(safeProps, meta, tr);
      if (meta && meta.kind === 'bili-intent-login-state') return loginStateCard(safeProps, meta, tr);
      return compactRow(safeProps, meta, tr);
    }

    /* ------------------------------------------------------------------ *
     * 设置页
     *
     * 工具卡片是只读的（owner 里没有 sessionId，客户端按钮无法触发工具调用），
     * 所以交互入口另走一条同源 HTTP 路由：宿主把同一批函数挂在 /bili-statistics/api/*，
     * 这里用 fetch 直接调，既不依赖会话，也不会往会话日志里写 command 事件。
     * ------------------------------------------------------------------ */

    const API_BASE = '/bili-statistics/api';

    async function callApi(action, options) {
      const spec = options || {};
      const init = { method: spec.method || 'GET', credentials: 'same-origin' };
      if (spec.body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(spec.body);
      }
      const response = await fetch(API_BASE + '?action=' + encodeURIComponent(action), init);
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      if (!payload || payload.ok !== true) {
        const message = payload && typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status;
        throw new Error(message);
      }
      return payload.data;
    }

    /** 设置页：登录、统计、私信、计划四组动作 + 模型与语气配置。 */
    /** 设置页的 t：优先用槽位下发的 props.t，宿主不传时退回 apply 里绑定的 locale t。 */
    let localeT = null;

    // 设置页只给「点选列表」，cron 由这里换算，用户不需要认识表达式。
    const clampInt = function (value, min, max, fallback) {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      const rounded = Math.trunc(n);
      if (rounded < min || rounded > max) return fallback;
      return rounded;
    };

    /** 把 cron 解析成「几点几分、周几、几号」；不是简单表达式就退回该周期的默认值。 */
    const cronParts = function (cron, mode) {
      const fallback = {
        hourly: mode === 'daily' || mode === 'custom' ? 22 : 8,
        minute: 0,
        weekday: 1,
        day_of_month: 1
      };
      const fields = String(cron || '').trim().split(/\s+/);
      if (fields.length !== 5) return fallback;
      if (!/^\d{1,2}$/.test(fields[0]) || !/^\d{1,2}$/.test(fields[1])) return fallback;
      const minute = Number(fields[0]);
      const hourly = Number(fields[1]);
      if (minute > 59 || hourly > 23) return fallback;
      const result = { hourly: hourly, minute: minute, weekday: fallback.weekday, day_of_month: fallback.day_of_month };
      if (/^\d{1,2}$/.test(fields[4])) {
        const day = Number(fields[4]);
        if (day >= 0 && day <= 7) result.weekday = day === 0 ? 7 : day;
      }
      if (/^\d{1,2}$/.test(fields[2])) {
        const date = Number(fields[2]);
        if (date >= 1 && date <= 31) result.day_of_month = date;
      }
      return result;
    };

    /** 由列表选择拼回 cron：每日/自定义只用到时间，每周加周几，每月加几号。 */
    const cronFrom = function (schedule) {
      const minute = clampInt(schedule.minute, 0, 59, 0);
      const hourly = clampInt(schedule.hourly, 0, 23, 22);
      if (schedule.mode === 'weekly') {
        return [minute, hourly, '*', '*', clampInt(schedule.weekday, 1, 7, 1) % 7].join(' ');
      }
      if (schedule.mode === 'monthly') {
        return [minute, hourly, clampInt(schedule.day_of_month, 1, 31, 1), '*', '*'].join(' ');
      }
      return [minute, hourly, '*', '*', '*'].join(' ');
    };

    function SettingsPanel(props) {
      const t = (props && typeof props.t === 'function' ? props.t : null) || localeT;
      const tr = (key, fallback) => text(t, key, fallback);
      const live = useRef(true);

      const [status, setStatus] = useState(null);
      const [config, setConfig] = useState(null);
      const [models, setModels] = useState(null);
      const [draft, setDraft] = useState(null);
      const [qr, setQr] = useState(null);
      const [loginState, setLoginState] = useState(null);
      const [intention, setIntention] = useState(null);
      const [intentDraft, setIntentDraft] = useState('');
      const [summary, setSummary] = useState('');
      const [dmText, setDmText] = useState('');
      const [busy, setBusy] = useState('');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [dirState, setDirState] = useState(null);
      const [notifyTab, setNotifyTab] = useState('bili_dm');

      useEffect(function () {
        live.current = true;
        return function () {
          live.current = false;
        };
      }, []);

      const applyConfig = (next) => {
        setConfig(next);
        setDraft({
          provider: next.llm.provider || '',
          model: next.llm.model || '',
          report_polish: next.report.polish !== false,
          report_prompt: next.llm.report_prompt || '',
          dm_prompt: next.llm.dm_prompt || '',
          max_tokens: next.llm.max_tokens,
          timeout_ms: next.llm.timeout_ms,
          summary_max_chars: next.notify.summary_max_chars,
          receiver_mid: (next.notify && next.notify.receiver_mid) || '',
          report_save_local: !next.report || next.report.save_local !== false,
          report_format: (next.report && next.report.format) || 'markdown',
          report_dir: (next.report && next.report.local_dir) || '',
          channels: next.notify && Array.isArray(next.notify.channels) ? next.notify.channels.slice() : ['bili_dm'],
          email: (function (value) {
            const email = value && typeof value === 'object' ? value : {};
            return {
              host: email.host || '',
              port: Number(email.port) || 465,
              secure: email.secure !== false,
              allow_plain: email.allow_plain === true,
              user: email.user || '',
              pass: '',
              pass_set: email.pass_set === true,
              from: email.from || '',
              to: email.to || '',
              from_name: email.from_name || '',
              subject_prefix: email.subject_prefix || '',
              attach_report: email.attach_report === true,
              timeout_ms: Number(email.timeout_ms) || 20000,
              retries: Number.isFinite(Number(email.retries)) ? Number(email.retries) : 1,
              backoff_ms: Number.isFinite(Number(email.backoff_ms)) ? Number(email.backoff_ms) : 2000
            };
          })(next.notify && next.notify.email),
          schedule: (function (value) {
            const schedule = value && typeof value === 'object' ? value : {};
            const mode = schedule.mode || 'daily';
            const source = schedule.cron_custom || schedule.cron || '';
            const parts = cronParts(source, mode);
            return {
              enabled: schedule.enabled !== false,
              mode: mode,
              window: schedule.window || 'calendar',
              cron_custom: source,
              hourly: parts.hourly,
              minute: parts.minute,
              weekday: parts.weekday,
              day_of_month: parts.day_of_month,
              custom_from: schedule.custom_from || '',
              custom_to: schedule.custom_to || ''
            };
          })(next.schedule)
        });
      };

      const refresh = function () {
        return Promise.all([callApi('status'), callApi('config'), callApi('intent')])
          .then(function (values) {
            if (!live.current) return;
            setStatus(values[0]);
            applyConfig(values[1]);
            setIntention(values[2].intention || null);
            setError('');
          })
          .catch(function (failure) {
            if (live.current) setError(String(failure && failure.message ? failure.message : failure));
          });
      };

      useEffect(function () {
        refresh();
        callApi('models')
          .then(function (next) {
            if (live.current) setModels(next);
          })
          .catch(function () {});
      }, []);

      const act = async function (name, work) {
        setBusy(name);
        setError('');
        setNotice('');
        try {
          return await work();
        } catch (failure) {
          if (live.current) setError(String(failure && failure.message ? failure.message : failure));
          return null;
        } finally {
          if (live.current) setBusy('');
        }
      };

      /** 多渠道并发发送时，取第一条失败原因给人看。 */
      const firstFailure = function (results) {
        const list = Array.isArray(results) ? results : [];
        for (const item of list) {
          if (item && item.ok === false) return String(item.error || item.channel || '');
        }
        return '';
      };

      const beginLogin = async function (role) {
        let data = await act('login-' + role, function () {
          return callApi('login-start', { method: 'POST', body: { role: role } });
        });
        if (!data) return;
        let triedSwitch = false;
        for (;;) {
          setQr(data);
          setLoginState({ role: role, state: 'waiting', channel: data.channel });
          if (data.channel === 'tv') setNotice(tr('login.switched', '已切换到 TV 扫码通道，请重新扫码'));
          const deadline = Date.now() + (Number(data.expires_in_seconds) || 180) * 1000;
          let next = null;
          while (live.current && Date.now() < deadline) {
            try {
              next = await callApi('login-poll', {
                method: 'POST',
                body: { qrcodeKey: data.qrcode_key, waitSeconds: 15 }
              });
            } catch (failure) {
              next = {
                role: role,
                state: 'error',
                message: String(failure && failure.message ? failure.message : failure)
              };
            }
            if (!live.current) return;
            if (next.state === 'switch') break;
            setLoginState(next);
            if (next.state === 'confirmed') {
              setQr(null);
              setNotice(tr('settings.loginDone', '登录成功'));
              refresh();
              return;
            }
            if (next.state === 'expired' || next.state === 'error') {
              if (next.state === 'expired') setQr(null);
              return;
            }
          }
          if (!live.current) return;
          if (next && next.state === 'switch' && !triedSwitch) {
            triedSwitch = true;
            setQr(null);
            data = await act('login-' + role, function () {
              return callApi('login-start', { method: 'POST', body: { role: role, channel: 'tv' } });
            });
            if (!data) return;
            continue;
          }
          setLoginState({ role: role, state: 'expired' });
          return;
        }
      };

      const logout = async function (role) {
        const done = await act('logout-' + role, function () {
          return callApi('login-logout', { method: 'POST', body: { role: role } });
        });
        if (!done) return;
        setLoginState(null);
        refresh();
      };

      const runNow = async function () {
        const data = await act('run', function () {
          return callApi('run-now', { method: 'POST', body: {} });
        });
        if (!data) return;
        setSummary(data.narrative || data.summary || '');
        if (!data.polished && data.polish_message) {
          setError(tr('settings.polishFail', '润色失败') + '：' + data.polish_message);
        }
        const pieces = [tr('settings.runDone', '已生成报告'), data.total_items + ' ' + tr('items', '条记录')];
        if (data.polished) pieces.push(tr('settings.polished', '模型润色'));
        else if (data.polish_reason) pieces.push(tr('settings.fallback', '模板摘要') + '（' + data.polish_reason + '）');
        setNotice(pieces.join(' · '));
        refresh();
      };

      const notifyTest = async function () {
        const body = dmText.trim().length > 0 ? { text: dmText.trim(), only: 'bili_dm' } : { only: 'bili_dm' };
        const data = await act('notify', function () {
          return callApi('notify-test', { method: 'POST', body: body });
        });
        if (!data) return;
        setSummary(data.content || '');
        if (!data.delivered) {
          setError(tr('settings.notifyFailed', '发送失败') + '：' + firstFailure(data.results));
          return;
        }
        if (!data.polished && data.polish_message) {
          setError(tr('settings.polishFail', '润色失败') + '：' + data.polish_message);
        }
        const pieces = [tr('settings.notifyDone', '已发送测试私信'), data.polished ? tr('settings.polished', '模型润色') : tr('settings.fallback', '模板摘要')];
        setNotice(pieces.join(' · '));
        setDmText('');
      };

      /** 只发一封测试邮件：验证 SMTP 连通性与收件箱落点，不发私信。 */
      const emailTest = async function () {
        const body = dmText.trim().length > 0 ? { text: dmText.trim() } : {};
        const data = await act('email', function () {
          return callApi('email-test', { method: 'POST', body: body });
        });
        if (!data) return;
        setSummary(data.content || '');
        if (!data.delivered) {
          setError(tr('settings.notifyFailed', '发送失败') + '：' + firstFailure(data.results));
          return;
        }
        if (!data.polished && data.polish_message) {
          setError(tr('settings.polishFail', '润色失败') + '：' + data.polish_message);
        }
        const pieces = [tr('settings.emailDone', '已发出测试邮件')];
        if (data.attached) pieces.push(tr('settings.attachReport', '附 Markdown 报告'));
        setNotice(pieces.join(' · '));
      };

      /** 检查报告目录：空白表示用插件默认目录，交给宿主展开 ~ 并试写。 */
      const checkReportDir = async function () {
        const fallback = (config && config.report && config.report.default_dir) || '';
        const value = (draft && draft.report_dir ? draft.report_dir : '').trim() || fallback;
        const data = await act('dir', function () {
          return callApi('dir-check', { method: 'POST', body: { value: value } });
        });
        if (!data) {
          setDirState({ ok: false, text: tr('settings.dirBad', '目录不可用') });
          return;
        }
        setDirState({
          ok: true,
          text: tr('settings.dirOk', '目录可用') + '：' + data.resolved + (data.created ? '（' + tr('settings.dirCreated', '已创建') + '）' : '')
        });
      };

      const saveIntent = async function () {
        const next = intentDraft.trim();
        if (next.length === 0) return;
        const data = await act('intent', function () {
          return callApi('intent-set', { method: 'POST', body: { text: next } });
        });
        if (!data) return;
        setIntention(data.intention);
        setIntentDraft('');
        setNotice(tr('settings.savedIntent', '计划已保存'));
      };

      const saveConfig = async function () {
        if (!draft) return;
        const patch = {
          llm: {
            provider: draft.provider,
            model: draft.model,
            report_prompt: draft.report_prompt,
            dm_prompt: draft.dm_prompt,
            max_tokens: draft.max_tokens,
            timeout_ms: draft.timeout_ms
          },
          report: {
            polish: draft.report_polish,
            save_local: draft.report_save_local !== false,
            format: draft.report_format,
            local_dir: (draft.report_dir || '').trim()
          },
          notify: {
            summary_max_chars: draft.summary_max_chars,
            channels: draft.channels,
            bili_dm: { receiver_mid: draft.receiver_mid || '' },
            email: (function () {
              const email = {
                host: draft.email.host,
                port: draft.email.port,
                secure: draft.email.secure,
                allow_plain: draft.email.allow_plain,
                user: draft.email.user,
                from: draft.email.from,
                to: draft.email.to,
                from_name: draft.email.from_name,
                subject_prefix: draft.email.subject_prefix,
                attach_report: draft.email.attach_report,
                timeout_ms: draft.email.timeout_ms,
                retries: draft.email.retries,
                backoff_ms: draft.email.backoff_ms
              };
              // 授权码留空表示不改：配置接口只回 pass_set，不回原文。
              if (String(draft.email.pass || '').trim().length > 0) email.pass = draft.email.pass;
              return email;
            })()
          },
          schedule: {
            enabled: draft.schedule.enabled !== false,
            mode: draft.schedule.mode,
            window: draft.schedule.window,
            cron: cronFrom(draft.schedule),
            custom_from: draft.schedule.custom_from || '',
            custom_to: draft.schedule.custom_to || ''
          }
        };
        const data = await act('config', function () {
          return callApi('config-set', { method: 'POST', body: { patch: patch } });
        });
        if (!data) return;
        // 重新拉一遍 config：config-set 的 effective 只回显部分字段（授权码不回传），
        // 拿它重建 draft 会把密码、显示名等清空。
        await refresh();
        const pieces = [tr('settings.configSaved', '设置已保存')];
        if (data.rejected && data.rejected.length > 0) pieces.push(tr('settings.rejected', '已忽略') + '：' + data.rejected.join('、'));
        setNotice(pieces.join(' · '));
      };

      const field = function (key, label, control) {
        return h('label', { key: key, style: S.field }, [
          h('span', { key: 'label', style: S.fieldLabel }, label),
          control
        ]);
      };

      const textInput = function (key, value, onChange, extra) {
        const merged = { key: key, style: S.input, value: value == null ? '' : String(value), onChange: function (event) { onChange(event.target.value); } };
        const rest = extra || {};
        for (const name of Object.keys(rest)) merged[name] = rest[name];
        return h('input', merged);
      };

      const busyNow = busy.length > 0;
      const statusRows = [];

      if (status) {
        statusRows.push(h('div', { key: 'intent', style: S.row }, [
          h('span', { key: 'k', style: S.rowKey }, tr('status.intention', '当前计划')),
          h('span', { key: 'v' }, intention
            ? '「' + clip(intention.text, 60) + '」' + (typeof intention.days_since_set === 'number' ? ' · ' + intention.days_since_set + ' ' + tr('settings.days', '天') : '')
            : tr('status.noIntention', '还没有定计划'))
        ]));
        const latest = status.latest_run;
        statusRows.push(h('div', { key: 'latest', style: S.row }, [
          h('span', { key: 'k', style: S.rowKey }, tr('settings.latest', '最近一次统计')),
          h('span', { key: 'v' }, latest
            ? String(latest.created_at || '') + ' · ' + num(latest.total_items) + ' ' + tr('items', '条记录') + ' · ' + (String(latest.shape_label || '').trim() || tr('shape.' + latest.shape, String(latest.shape || '')))
            : tr('settings.noRun', '还没有跑过'))
        ]));
        const login = status.login && typeof status.login === 'object' ? status.login : {};
        for (const role of ['reader', 'sender']) {
          const entry = login[role] || {};
          const cells = [
            h('span', { key: 'k', style: S.rowKey }, tr('login.role.' + role, role)),
            h('span', { key: 'v', style: entry.logged_in ? S.ok : S.hint }, entry.logged_in
              ? String(entry.uname || ('UID ' + entry.mid)) + (entry.usable === false ? ' · ' + tr('loginState.unverified', '已保存未验证') : '')
              : tr('settings.notLoggedIn', '未登录'))
          ];
          cells.push(h('button', {
            key: 'scan',
            type: 'button',
            style: S.primary,
            disabled: busyNow,
            onClick: function () { beginLogin(role); }
          }, tr('settings.scan', '扫码登录')));
          if (entry.logged_in) {
            cells.push(h('button', {
              key: 'out',
              type: 'button',
              style: S.button,
              disabled: busyNow,
              onClick: function () { logout(role); }
            }, tr('settings.logout', '退出登录')));
          }
          statusRows.push(h('div', { key: 'login-' + role, style: S.row }, cells));
        }
      }

      const loginRows = [];
      if (qr) {
        const svg = qrSvg(qr.dots, qr.size);
        const seconds = typeof qr.expires_in_seconds === 'number' ? qr.expires_in_seconds : 180;
        loginRows.push(h('div', { key: 'hint', style: S.hint }, tr(qr.channel === 'tv' ? 'login.hintTv' : 'login.hint', '用 B 站客户端扫码并在手机上确认') + ' · ' + tr('login.expire', '二维码 {s} 秒内有效').replace('{s}', String(seconds))));
        if (svg) loginRows.push(h('div', { key: 'qr', style: S.qrWrap }, svg));
        if (typeof qr.url === 'string' && qr.url.length > 0) {
          loginRows.push(h('div', { key: 'url', style: S.qrText, title: qr.url }, qr.url));
        }
      }
      if (loginState) {
        const state = String(loginState.state || 'error');
        const tone = state === 'confirmed' ? S.ok : state === 'error' || state === 'expired' ? S.bad : S.hint;
        const parts = [tr('login.role.' + (loginState.role === 'sender' ? 'sender' : 'reader'), ''), tr('loginState.' + state, state)];
        if (typeof loginState.uname === 'string' && loginState.uname.length > 0) parts.push(clip(loginState.uname, 24));
        if (typeof loginState.message === 'string' && loginState.message.length > 0 && state !== 'confirmed') parts.push(clip(loginState.message, 80));
        loginRows.push(h('div', { key: 'state', style: tone }, parts.filter(function (part) { return part.length > 0; }).join(' · ')));
      }

      const providers = models && Array.isArray(models.providers) ? models.providers : [];
      const modelList = models && models.models && draft && models.models[draft.provider] ? models.models[draft.provider] : [];
      const modelRows = draft
        ? [
            h('div', { key: 'pair', style: S.row }, [
              h('div', { key: 'p', style: { flex: '1 1 160px' } }, field('provider', tr('settings.provider', '模型提供方'),
                h('select', {
                  style: S.input,
                  value: draft.provider,
                  onChange: function (event) { setDraft(Object.assign({}, draft, { provider: event.target.value, model: '' })); }
                }, [h('option', { key: '', value: '' }, tr('settings.noModel', '不启用（只用模板摘要）'))].concat(
                  providers.map(function (provider) {
                    return h('option', { key: provider.id, value: provider.id }, provider.name);
                  })
                )))),
              h('div', { key: 'm', style: { flex: '1 1 160px' } }, field('model', tr('settings.model', '模型'),
                h('select', {
                  style: S.input,
                  value: draft.model,
                  onChange: function (event) { setDraft(Object.assign({}, draft, { model: event.target.value })); }
                }, [h('option', { key: '', value: '' }, tr('settings.pickModel', '请选择'))].concat(
                  modelList.map(function (model) {
                    return h('option', { key: model.id, value: model.id }, model.name);
                  })
                ))))
            ]),
            h('div', { key: 'toggles', style: S.row }, [
              h('label', { key: 'polish', style: S.row }, [
                h('input', {
                  key: 'cb',
                  type: 'checkbox',
                  checked: draft.report_polish !== false,
                  onChange: function (event) { setDraft(Object.assign({}, draft, { report_polish: event.target.checked })); }
                }),
                h('span', { key: 't', style: S.fieldLabel }, tr('settings.reportPolish', '模型写概览与计划情况（照视频标题）'))
              ]),
              h('span', { key: 'ready', style: config && config.model_ready ? S.ok : S.hint }, config && config.model_ready
                ? tr('settings.modelReady', '模型已就绪')
                : tr('settings.modelMissing', '未选择模型：报告只有数字，没有概览和计划情况'))
            ]),
            field('reportPrompt', tr('settings.reportPrompt', '概览与计划情况的提示词（留空用内置）'),
              h('textarea', {
                style: S.textarea,
                value: draft.report_prompt,
                placeholder: config && config.defaults ? config.defaults.report_prompt : '',
                onChange: function (event) { setDraft(Object.assign({}, draft, { report_prompt: event.target.value })); }
              })),
            h('div', { key: 'numbers', style: S.row }, [
              h('div', { key: 'tokens', style: { width: '130px' } }, field('tokens', tr('settings.maxTokens', '最大 token'),
                textInput('tokensInput', draft.max_tokens, function (value) {
                  setDraft(Object.assign({}, draft, { max_tokens: Number(value) }));
                }, { type: 'number', min: 800, max: 8000 }))),
              h('div', { key: 'timeout', style: { width: '130px' } }, field('timeout', tr('settings.timeout', '超时（毫秒）'),
                textInput('timeoutInput', draft.timeout_ms, function (value) {
                  setDraft(Object.assign({}, draft, { timeout_ms: Number(value) }));
                }, { type: 'number', min: 1000, max: 120000 })))
            ]),
            config && config.settings_file
              ? h('div', { key: 'file', style: S.hint }, tr('settings.file', '覆盖配置写在') + '：' + config.settings_file)
              : null,
            h('div', { key: 'saveRow', style: S.row }, [
              h('button', {
                key: 'save',
                type: 'button',
                style: S.primary,
                disabled: busyNow,
                onClick: function () { saveConfig(); }
              }, tr('settings.save', '保存设置'))
            ])
          ]
        : [];

      const option = function (value, label) {
        return h('option', { key: value, value: value }, label);
      };

      const windowOptions = function (mode) {
        return ['calendar', 'rolling'].map(function (value) {
          return option(value, tr('settings.window.' + mode + '.' + value, value));
        });
      };

      const pad2 = function (value) { return String(value).padStart(2, '0'); };
      const hourOptions = [];
      for (let i = 0; i < 24; i += 1) hourOptions.push(option(String(i), pad2(i)));
      const minuteOptions = [];
      for (let i = 0; i < 60; i += 5) minuteOptions.push(option(String(i), pad2(i)));
      const dayOptions = [];
      for (let i = 1; i <= 31; i += 1) dayOptions.push(option(String(i), String(i)));
      const weekdayOptions = [1, 2, 3, 4, 5, 6, 7].map(function (value) {
        return option(String(value), tr('settings.weekday.' + value, '周' + value));
      });

      const setSchedule = function (patch) {
        setDraft(Object.assign({}, draft, { schedule: Object.assign({}, draft.schedule, patch) }));
      };

      const CHANNEL_ORDER = ['bili_dm', 'email'];

      /** 勾选通知渠道：按 bili_dm → email 固定顺序存，便于和配置文件对照。 */
      const toggleChannel = function (name) {
        const list = Array.isArray(draft.channels) ? draft.channels.slice() : [];
        const at = list.indexOf(name);
        if (at >= 0) list.splice(at, 1);
        else list.push(name);
        const ordered = CHANNEL_ORDER.filter(function (item) { return list.indexOf(item) >= 0; });
        setDraft(Object.assign({}, draft, { channels: ordered }));
      };

      const setEmail = function (patch) {
        setDraft(Object.assign({}, draft, { email: Object.assign({}, draft.email, patch) }));
      };

      /** ISO 时间转本地「2026-10-27 21:25」，用浏览器所在时区，不用 UTC。 */
      const localTime = function (iso) {
        const ts = Date.parse(iso);
        if (!Number.isFinite(ts)) return '';
        const at = new Date(ts);
        return at.getFullYear() + '-' + pad2(at.getMonth() + 1) + '-' + pad2(at.getDate()) + ' ' + pad2(at.getHours()) + ':' + pad2(at.getMinutes());
      };

      /** 定时事件的一句话说明：结果 + 原因（跳过与失败要让人一眼看出为什么）。 */
      const describeEvent = function (event) {
        if (!event || typeof event !== 'object') return '';
        const label = event.result === 'ran'
          ? tr('settings.lastRan', '已执行')
          : event.result === 'error'
            ? tr('settings.lastFailed', '失败')
            : tr('settings.lastSkipped', '跳过');
        const reason = typeof event.reason === 'string' && event.reason.length > 0 ? '（' + clip(event.reason, 60) + '）' : '';
        return label + reason;
      };

      const scheduleRows = draft && draft.schedule
        ? [
            h('div', { key: 'row', style: S.row }, [
              h('label', { key: 'on', style: S.row }, [
                h('input', {
                  key: 'cb',
                  type: 'checkbox',
                  checked: draft.schedule.enabled !== false,
                  onChange: function (event) { setSchedule({ enabled: event.target.checked }); }
                }),
                h('span', { key: 'label' }, tr('settings.scheduleOn', '启用定时'))
              ]),
              h('div', { key: 'mode', style: { flex: '0 0 140px' } }, field('modeSelect', tr('settings.scheduleMode', '周期'),
                h('select', {
                  style: S.input,
                  value: draft.schedule.mode,
                  onChange: function (event) { setSchedule({ mode: event.target.value }); }
                }, ['daily', 'weekly', 'monthly', 'custom'].map(function (value) {
                  return option(value, tr('settings.mode.' + value, value));
                })))),
              draft.schedule.mode === 'custom' ? null : h('div', { key: 'window', style: { flex: '1 1 180px' } },
                field('windowSelect', tr('settings.scheduleWindow', '统计窗口'),
                  h('select', {
                    style: S.input,
                    value: draft.schedule.window,
                    onChange: function (event) { setSchedule({ window: event.target.value }); }
                  }, windowOptions(draft.schedule.mode)))),
            ].filter(function (entry) { return entry !== null; })),
            h('div', { key: 'timeRow', style: S.row }, [
              h('div', { key: 'time', style: { flex: '0 0 190px' } }, field('timeLabel', tr('settings.triggerTime', '触发时间'),
                h('div', { key: 'clock', style: S.clock }, [
                  h('div', { key: 'hour', style: { flex: '0 0 78px' } }, h('select', {
                    style: S.input,
                    value: String(draft.schedule.hourly),
                    onChange: function (event) { setSchedule({ hourly: Number(event.target.value) }); }
                  }, hourOptions)),
                  h('span', { key: 'colon', style: S.clockColon }, ':'),
                  h('div', { key: 'minute', style: { flex: '0 0 78px' } }, h('select', {
                    style: S.input,
                    value: String(draft.schedule.minute),
                    onChange: function (event) { setSchedule({ minute: Number(event.target.value) }); }
                  }, minuteOptions))
                ]))),
              draft.schedule.mode === 'weekly' ? h('div', { key: 'weekday', style: { flex: '0 0 110px' } },
                field('weekdayLabel', tr('settings.weekdayLabel', '星期'), h('select', {
                  style: S.input,
                  value: String(draft.schedule.weekday),
                  onChange: function (event) { setSchedule({ weekday: Number(event.target.value) }); }
                }, weekdayOptions))) : null,
              draft.schedule.mode === 'monthly' ? h('div', { key: 'dom', style: { flex: '0 0 110px' } },
                field('domLabel', tr('settings.dayOfMonth', '日期'), h('select', {
                  style: S.input,
                  value: String(draft.schedule.day_of_month),
                  onChange: function (event) { setSchedule({ day_of_month: Number(event.target.value) }); }
                }, dayOptions))) : null
            ].filter(function (entry) { return entry !== null; })),
            draft.schedule.mode === 'custom' ? h('div', { key: 'range', style: S.row }, [
              h('div', { key: 'from', style: { flex: '1 1 160px' } }, field('fromInput', tr('settings.customFrom', '开始日期'),
                textInput('fromInput', draft.schedule.custom_from, function (value) { setSchedule({ custom_from: value }); }, { placeholder: 'YYYY-MM-DD' }))),
              h('div', { key: 'to', style: { flex: '1 1 160px' } }, field('toInput', tr('settings.customTo', '结束日期'),
                textInput('toInput', draft.schedule.custom_to, function (value) { setSchedule({ custom_to: value }); }, { placeholder: 'YYYY-MM-DD' })))
            ]) : null,
            h('div', { key: 'hint', style: S.hint }, [
              tr('settings.scheduleHint', 'cron 留空用默认'),
              status && status.schedule && status.schedule.next_fire
                ? ' · ' + tr('settings.scheduleNext', '下次') + ' ' + status.schedule.next_fire +
                  (status.schedule.next_window ? '（' + status.schedule.next_window + '）' : '')
                : ''
            ].join('')),
            status && status.schedule && status.schedule.last_event
              ? h('div', { key: 'lastRun', style: S.hint }, tr('settings.scheduleLast', '上次触发') + ' ' + localTime(status.schedule.last_event.at) + ' · ' + describeEvent(status.schedule.last_event))
              : null,
            h('div', { key: 'saveRow', style: S.row }, [
              h('button', {
                key: 'save',
                type: 'button',
                style: S.primary,
                disabled: busyNow,
                onClick: function () { saveConfig(); }
              }, tr('settings.save', '保存设置'))
            ])
          ].filter(function (entry) { return entry !== null; })
        : [];

      const emailOn = draft && Array.isArray(draft.channels) && draft.channels.indexOf('email') >= 0;

      const dirChoices = draft
        ? ((config && config.report && config.report.dir_options && config.report.dir_options.options) || [])
        : [];

      const saveRows = draft
        ? [
            h('div', { key: 'row', style: S.row }, [
              h('label', { key: 'on', style: S.row }, [
                h('input', {
                  key: 'cb',
                  type: 'checkbox',
                  checked: draft.report_save_local !== false,
                  onChange: function (event) { setDraft(Object.assign({}, draft, { report_save_local: event.target.checked })); }
                }),
                h('span', { key: 'l', style: S.fieldLabel }, tr('settings.saveLocal', '保存报告到本地'))
              ]),
              h('div', { key: 'fmt', style: { flex: '0 0 160px' } }, field('fmt', tr('settings.format', '格式'),
                h('select', {
                  style: S.input,
                  value: draft.report_format,
                  onChange: function (event) { setDraft(Object.assign({}, draft, { report_format: event.target.value })); }
                }, ['markdown', 'html', 'both'].map(function (value) {
                  return h('option', { key: value, value: value }, tr('settings.format.' + value, value));
                })))),
            ]),
            h('div', { key: 'dirRow', style: S.row }, [
              h('div', { key: 'dirField', style: { flex: '1 1 320px' } }, field('dir', tr('settings.saveDir', '报告目录'),
                h('input', {
                  style: S.input,
                  type: 'text',
                  value: draft.report_dir,
                  placeholder: (config && config.report && config.report.default_dir) || '',
                  onChange: function (event) { setDraft(Object.assign({}, draft, { report_dir: event.target.value })); }
                }))),
              h('button', {
                key: 'check',
                type: 'button',
                style: S.button,
                disabled: busyNow,
                onClick: function () { checkReportDir(); }
              }, tr('settings.dirCheck', '检查目录'))
            ]),
            h('div', { key: 'dirPick', style: S.row }, [
              h('span', { key: 'k', style: S.fieldLabel }, tr('settings.dirPick', '常用位置'))
            ].concat(dirChoices.map(function (option) {
              return h('button', {
                key: option.key,
                type: 'button',
                style: S.button,
                title: option.path,
                disabled: busyNow,
                onClick: function () {
                  setDirState(null);
                  setDraft(Object.assign({}, draft, { report_dir: option.key === 'default' ? '' : option.path }));
                }
              }, tr('settings.dir.' + option.key, option.key));
            }))),
            h('div', { key: 'dirHint', style: S.hint }, tr('settings.dirHint', '留空 = 插件默认目录，支持 ~ 开头；检查会创建目录并试写一个临时文件')),
            config && config.report && config.report.local_dir
              ? h('div', { key: 'dirNow', style: S.hint }, tr('settings.dirCurrent', '当前') + '：' + config.report.local_dir)
              : null,
            dirState ? h('div', { key: 'dirState', style: dirState.ok ? S.ok : S.bad }, dirState.text) : null,
            h('div', { key: 'saveRow', style: S.row }, [
              h('button', {
                key: 'save',
                type: 'button',
                style: S.primary,
                disabled: busyNow,
                onClick: function () { saveConfig(); }
              }, tr('settings.save', '保存设置'))
            ])
          ].filter(function (entry) { return entry !== null; })
        : [];

      const renderNotify = function () {
        const notifyTabs = h('div', { key: 'tabs', style: S.row }, ['bili_dm', 'email'].map(function (name) {
          const active = notifyTab === name;
          return h('button', {
            key: name,
            type: 'button',
            style: active ? S.primary : S.button,
            onClick: function () { setNotifyTab(name); }
          }, tr('settings.tab.' + name, name));
        }));

        const dmPanel = h('div', { key: 'dmPanel', style: S.panel }, [
          field('receiver', tr('settings.receiver', '接收方 UID（私信发给谁）'),
            textInput('receiverInput', draft.receiver_mid, function (value) {
              setDraft(Object.assign({}, draft, { receiver_mid: String(value).replace(/\D/g, '') }));
            }, {
              placeholder: config && config.notify && config.notify.effective_receiver
                ? config.notify.effective_receiver
                : tr('settings.receiverEmpty', '还没可用的接收方：先扫码登录读历史账号，或在这里填 UID')
            })),
          config && config.notify && config.notify.effective_receiver
            ? h('div', { key: 'receiverHint', style: S.hint },
                tr('settings.receiverHint', '实际收件人') + '：' + config.notify.effective_receiver +
                (config.notify.receiver_source === 'reader' ? '（' + tr('settings.receiverFromReader', '来自读历史账号') + '）' : ''))
            : null,
          h('div', { key: 'chars', style: { width: '130px' } }, field('chars', tr('settings.maxChars', '私信字数上限'),
            textInput('charsInput', draft.summary_max_chars, function (value) {
              setDraft(Object.assign({}, draft, { summary_max_chars: Number(value) }));
            }, { type: 'number', min: 60, max: 800 }))),
          field('dmText', tr('settings.dmTextLabel', '测试私信内容'),
            textInput('dmTextInput', dmText, setDmText, {
              placeholder: tr('settings.notifyPlaceholder', '留空则用最近一次统计的摘要')
            })),
          h('div', { key: 'dmAct', style: S.row }, [
            h('button', {
              key: 'save',
              type: 'button',
              style: S.primary,
              disabled: busyNow,
              onClick: function () { saveConfig(); }
            }, tr('settings.save', '保存设置')),
            h('button', {
              key: 'test',
              type: 'button',
              style: S.button,
              disabled: busyNow,
              onClick: function () { notifyTest(); }
            }, busy === 'notify' ? tr('settings.sending', '发送中…') : tr('settings.notifyTest', '发测试私信'))
          ])
        ].filter(function (entry) { return entry !== null; }));

        return [
            h('div', { key: 'chan', style: S.row }, [
              h('span', { key: 'k', style: S.fieldLabel }, tr('settings.channels', '渠道'))
            ].concat(CHANNEL_ORDER.map(function (name) {
              const on = Array.isArray(draft.channels) && draft.channels.indexOf(name) >= 0;
              return h('label', { key: name, style: S.row }, [
                h('input', {
                  key: 'cb',
                  type: 'checkbox',
                  checked: on,
                  onChange: function () { toggleChannel(name); }
                }),
                h('span', { key: 'l' }, tr('settings.channel.' + name, name))
              ]);
            }))),
            h('div', { key: 'chanHint', style: S.hint }, tr('settings.channelHint', '勾选才会推送；各渠道互相独立，一个失败不影响其它')),
            h('div', { key: 'tone', style: S.panel }, [
              field('dmPrompt', tr('settings.dmPrompt', '语气提示词（私信与邮件共用，留空用内置）'),
                h('textarea', {
                  key: 'dmPromptInput',
                  style: S.textarea,
                  value: draft.dm_prompt,
                  placeholder: config && config.defaults ? config.defaults.dm_prompt : '',
                  onChange: function (event) { setDraft(Object.assign({}, draft, { dm_prompt: event.target.value })); }
                })),
              h('div', { key: 'toneHint', style: S.hint }, tr('settings.dmPanelHint', '提示词只改语气，不影响统计数字；留空用内置。'))
            ]),
            notifyTabs,
            notifyTab === 'email'
              ? h('div', { key: 'smtp', style: S.panel }, [
                  h('div', { key: 'hostRow', style: S.row }, [
                    h('div', { key: 'host', style: { flex: '1 1 200px' } }, field('smtpHost', tr('settings.smtpHost', 'SMTP 主机'),
                      textInput('smtpHostInput', draft.email.host, function (value) { setEmail({ host: value }); }, { placeholder: 'smtp.qq.com' }))),
                    h('div', { key: 'port', style: { flex: '0 0 110px' } }, field('smtpPort', tr('settings.smtpPort', '端口'),
                      textInput('smtpPortInput', draft.email.port, function (value) { setEmail({ port: Number(value) || 465 }); }, { type: 'number', min: 1, max: 65535 }))),
                    h('label', { key: 'secure', style: S.row }, [
                      h('input', {
                        key: 'cb',
                        type: 'checkbox',
                        checked: draft.email.secure !== false,
                        onChange: function (event) { setEmail({ secure: event.target.checked }); }
                      }),
                      h('span', { key: 'l' }, tr('settings.smtpSecure', '隐式 TLS（465）'))
                    ])
                  ]),
                  h('div', { key: 'userRow', style: S.row }, [
                    h('div', { key: 'user', style: { flex: '1 1 200px' } }, field('smtpUser', tr('settings.smtpUser', '登录名'),
                      textInput('smtpUserInput', draft.email.user, function (value) { setEmail({ user: value }); }, { placeholder: 'you@qq.com' }))),
                    h('div', { key: 'pass', style: { flex: '1 1 200px' } }, field('smtpPass', tr('settings.smtpPass', '授权码'),
                      textInput('smtpPassInput', draft.email.pass, function (value) { setEmail({ pass: value }); }, {
                        type: 'password',
                        placeholder: draft.email.pass_set ? tr('settings.smtpPassSet', '已保存，留空不改') : ''
                      })))
                  ]),
                  h('div', { key: 'addrRow', style: S.row }, [
                    h('div', { key: 'from', style: { flex: '1 1 200px' } }, field('emailFrom', tr('settings.emailFrom', '发件地址'),
                      textInput('emailFromInput', draft.email.from, function (value) { setEmail({ from: value }); }, { placeholder: 'you@qq.com' }))),
                    h('div', { key: 'to', style: { flex: '1 1 200px' } }, field('emailTo', tr('settings.emailTo', '收件地址'),
                      textInput('emailToInput', draft.email.to, function (value) { setEmail({ to: value }); }, { placeholder: 'you@qq.com' })))
                  ]),
                  h('div', { key: 'nameRow', style: S.row }, [
                    h('div', { key: 'fromName', style: { flex: '1 1 160px' } }, field('emailFromName', tr('settings.emailFromName', '显示名'),
                      textInput('emailFromNameInput', draft.email.from_name, function (value) { setEmail({ from_name: value }); }, { placeholder: 'B站观看统计' }))),
                    h('div', { key: 'prefix', style: { flex: '0 0 160px' } }, field('subjectPrefix', tr('settings.subjectPrefix', '主题前缀'),
                      textInput('subjectPrefixInput', draft.email.subject_prefix, function (value) { setEmail({ subject_prefix: value }); }, { placeholder: '[B站观看统计]' })))
                  ]),
                  h('div', { key: 'numRow', style: S.row }, [
                    h('div', { key: 'timeout', style: { width: '130px' } }, field('emailTimeout', tr('settings.timeout', '超时（毫秒）'),
                      textInput('emailTimeoutInput', draft.email.timeout_ms, function (value) { setEmail({ timeout_ms: Number(value) || 20000 }); }, { type: 'number', min: 1000, max: 120000 }))),
                    h('div', { key: 'retries', style: { width: '110px' } }, field('emailRetries', tr('settings.emailRetries', '重试'),
                      textInput('emailRetriesInput', draft.email.retries, function (value) { setEmail({ retries: Number(value) || 0 }); }, { type: 'number', min: 0, max: 5 }))),
                    h('div', { key: 'backoff', style: { width: '130px' } }, field('emailBackoff', tr('settings.emailBackoff', '退避（毫秒）'),
                      textInput('emailBackoffInput', draft.email.backoff_ms, function (value) { setEmail({ backoff_ms: Number(value) || 0 }); }, { type: 'number', min: 0, max: 60000 })))
                  ]),
                  h('label', { key: 'attach', style: S.row }, [
                    h('input', {
                      key: 'cb',
                      type: 'checkbox',
                      checked: draft.email.attach_report === true,
                      onChange: function (event) { setEmail({ attach_report: event.target.checked }); }
                    }),
                    h('span', { key: 'l' }, tr('settings.attachReport', '附 Markdown 报告'))
                  ]),
                  h('label', { key: 'plain', style: S.row }, [
                    h('input', {
                      key: 'cb',
                      type: 'checkbox',
                      checked: draft.email.allow_plain === true,
                      onChange: function (event) { setEmail({ allow_plain: event.target.checked }); }
                    }),
                    h('span', { key: 'l' }, tr('settings.smtpAllowPlain', '允许明文'))
                  ]),
                  h('div', { key: 'hint', style: S.hint }, tr('settings.emailHint', '端口与加密要配对：465 用隐式 TLS，587 用 STARTTLS；授权码在邮箱设置里单独生成，不是登录密码')),
                  h('div', { key: 'actRow', style: S.row }, [
                    h('button', {
                      key: 'save',
                      type: 'button',
                      style: S.primary,
                      disabled: busyNow,
                      onClick: function () { saveConfig(); }
                    }, tr('settings.save', '保存设置')),
                    h('button', {
                      key: 'test',
                      type: 'button',
                      style: S.button,
                      disabled: busyNow,
                      onClick: function () { emailTest(); }
                    }, busy === 'email' ? tr('settings.emailSending', '发送中…') : tr('settings.emailTest', '发送测试邮件'))
                  ])
                ])
              : dmPanel
          ].filter(function (entry) { return entry !== null; });
      };

      const notifyRows = draft ? renderNotify() : [];

      const actionRows = [
        h('div', { key: 'row', style: S.row }, [
          h('button', {
            key: 'run',
            type: 'button',
            style: S.primary,
            disabled: busyNow,
            onClick: function () { runNow(); }
          }, busy === 'run' ? tr('settings.running', '统计中…') : tr('settings.runNow', '立即统计一次'))
        ]),
        h('div', { key: 'hintText', style: S.hint }, tr('settings.manualHint', '定时任务不依赖这个页面：到点照样拉历史、写报告、按通知渠道发送。测试私信在「通知渠道 → 私信设置」里。'))
      ];

      const intentRows = [
        h('div', { key: 'row', style: S.row }, [
          h('div', { key: 'in', style: { flex: '1 1 240px' } }, textInput('intentInput', intentDraft, setIntentDraft, {
            placeholder: tr('settings.intentPlaceholder', '例如：这周只看两门课的公开课，十一点前睡')
          })),
          h('button', {
            key: 'save',
            type: 'button',
            style: S.primary,
            disabled: busyNow,
            onClick: function () { saveIntent(); }
          }, tr('settings.saveIntent', '保存计划'))
        ])
      ];

      const reportRows = summary.length > 0
        ? [h('pre', { key: 'summary', style: S.pre }, summary)]
        : [];

      return h('div', { className: 'bili-settings', style: S.panel }, [
        h('div', { key: 'head', style: S.row }, [
          h('span', { key: 'title', style: S.groupTitle }, tr('settings.title', 'B 站观看统计')),
          h('span', { key: 'sub', style: S.hint }, tr('settings.subtitle', '交互都在这里；会话里的工具只读统计与报告。'))
        ]),
        error ? h('div', { key: 'error', style: S.bad }, error) : null,
        notice ? h('div', { key: 'notice', style: S.ok }, notice) : null,
        h('div', { key: 'statusGroup', style: S.group }, [
          h('div', { key: 'h', style: S.groupTitle }, tr('settings.status', '当前状态')),
          statusRows.length > 0 ? h('div', { key: 'rows', style: S.panel }, statusRows) : h('div', { key: 'loading', style: S.hint }, tr('settings.loading', '读取中…'))
        ]),
        h('div', { key: 'loginGroup', style: S.group }, [
          h('div', { key: 'h', style: S.groupTitle }, tr('settings.login', '扫码登录')),
          loginRows.length > 0 ? h('div', { key: 'rows', style: S.panel }, loginRows) : h('div', { key: 'idle', style: S.hint }, tr('settings.loginIdle', '上面点「扫码登录」，二维码会显示在这里。'))
        ]),
        h('div', { key: 'intentGroup', style: S.group }, [
          h('div', { key: 'h', style: S.groupTitle }, tr('settings.intent', '计划')),
          intentRows
        ]),
        h('div', { key: 'modelGroup', style: S.group }, [
          h('div', { key: 'h', style: S.groupTitle }, tr('settings.model', '模型与语气')),
          modelRows.length > 0 ? h('div', { key: 'rows', style: S.panel }, modelRows) : h('div', { key: 'loading', style: S.hint }, tr('settings.loading', '读取中…'))
        ]),
        h('div', { key: 'scheduleGroup', style: S.group }, [
          h('div', { key: 'h', style: S.groupTitle }, tr('settings.schedule', '定时任务')),
          scheduleRows.length > 0 ? h('div', { key: 'rows', style: S.panel }, scheduleRows) : h('div', { key: 'loading', style: S.hint }, tr('settings.loading', '读取中…'))
        ]),
        h('div', { key: 'saveGroup', style: S.group }, [
          h('div', { key: 'h', style: S.groupTitle }, tr('settings.groupSave', '本地保存')),
          saveRows.length > 0 ? h('div', { key: 'rows', style: S.panel }, saveRows) : h('div', { key: 'loading', style: S.hint }, tr('settings.loading', '读取中…'))
        ]),
        h('div', { key: 'notifyGroup', style: S.group }, [
          h('div', { key: 'h', style: S.groupTitle }, tr('settings.groupNotify', '通知渠道')),
          notifyRows.length > 0 ? h('div', { key: 'rows', style: S.panel }, notifyRows) : h('div', { key: 'loading', style: S.hint }, tr('settings.loading', '读取中…'))
        ]),
        h('div', { key: 'actionGroup', style: S.group }, [
          h('div', { key: 'h', style: S.groupTitle }, tr('settings.actions', '手动触发')),
          actionRows
        ]),
        reportRows.length > 0 ? h('div', { key: 'reportGroup', style: S.group }, [
          h('div', { key: 'h', style: S.groupTitle }, tr('settings.preview', '本次输出预览')),
          reportRows
        ]) : null
      ]);
    }

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, 'bili-statistics: dictionaries');
      ctx.slots.inject('tool.call.toolview', function* () {
        for (const key of TOOL_KEYS) {
          yield ctx.slots.register({
            name: 'tool.call.toolview',
            key: key,
            locale: NS,
            order: 6
          }, Card);
        }
      });
      /** ctx.locale.bind(ns) 给出带命名空间的 t；缺它时退回显示键名，不让设置页崩掉。 */
      const t = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : function (key) { return key; };
      localeT = t;
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'bili-statistics',
          order: 60,
          label: function () { return text(t, 'settings.nav', 'B 站观看统计'); },
          locale: NS
        }, SettingsPanel);
      });
    }

    return {
      inject: ['slots', 'locale'],
      apply: apply
    };
  }
});
