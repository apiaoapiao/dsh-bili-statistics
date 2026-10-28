# dsh-bili-statistics（B 站观看统计）

把「我这周本来想做什么」和「我实际看了什么」摆在一起看的小镜子。它只做三件事：

1. 按周期从 B 站拉取**你自己的**观看历史（官方接口，只读）；
2. 在本地算出统计事实（条数、完成度、深夜占比、连续播放链等）；
3. 把统计事实交给模型：一种用法是会话里的模型据此写 1–3 条带证据的偏离假设，另一种是插件自己调用宿主模型，为报告写一段导读、把私信摘要改写成你设定的语气；结果渲染成卡片、落盘 Markdown/HTML，并可私信推送到你自己的另一个账号。

它**不做**的事：不拦截、不屏蔽、不弹窗催促、不做专注模式、不自动干预、不评价你的自控力、不给自己发私信。

---

## 快速开始

```bash
# 1. 安装到当前 web profile（本地目录不需要联网，加 --offline 更快）
#    把路径换成你 clone 下来的仓库目录
dsh plugin --profile web add 'file:/path/to/dsh-bili-statistics' --offline

# 2. 确认 profile 已启用这个 bundle
#    ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 里会自动出现 @local/dsh-bili-statistics

# 3. 刷新 GUI 页面，让客户端卡片 bundle 加载
#    （改过 lib/*.js 之后需要重启 dsh web，ESM 已缓存的旧实现不会热替换）
```

也可以完全不记工具名：打开 DSH 设置 →「B 站观看统计」，扫码登录后点「立即统计一次」，再在「模型与语气」里选个模型、改改报告导读提示词，在「通知渠道」里勾好私信或邮件。

想用工具链（更适合让模型参与判断）就在会话里：

```
bili_intent_set(text="这周想早点睡，晚上尽量不看长视频")
```

```
bili_intent_facts(mode="weekly")
```

`facts` 返回统计事实与编号证据列表。模型据此判断，再调用：

```
bili_intent_annotate(run_id="<上一步的 run_id>", hypotheses=[
  { text: "…只描述可观察的行为…", evidence: [3, 7], clue: "可验证的线索", certainty: "inference" }
])
```

```
bili_intent_report(run_id="<run_id>")
```

---

## 配置

所有配置都在 profile 的 `cordis.patch.yml` 或本包的 `cordis.patch.yml` 里，键名与下面的默认值一一对应。

```yaml
- insert:
    - id: bili-statistics
      name: '@local/dsh-bili-statistics'
      config:
        bili:
          sessdata: ''            # 可选：留空则用 bili_intent_login 扫码登录保存的凭据
          bili_jct: ''            # 可选：同上，扫码登录会一起保存
          page_size: 30           # 1–30，接口上限 30
          request_interval_ms: 400
          max_pages: 40
        schedule:
          enabled: true
          mode: daily             # daily | weekly | monthly | custom
          window: calendar        # calendar：自然日/自然周/自然月；rolling：从触发时刻往前推固定时长
          cron: ''                # 留空则 daily=0 22 * * *、weekly=0 8 * * 1、monthly=0 8 1 * *
          timezone: Asia/Shanghai
          custom_from: ''         # mode: custom 时必填，YYYY-MM-DD
          custom_to: ''           # 可选，留空表示到现在
        report:
          save_local: true
          local_dir: ~/.dsh/bili-statistics/reports
          format: markdown        # markdown | html | both
          evidence_limit: 20      # 2–40，交给模型的证据条数上限
          polish: true            # 是否让模型为报告写「形态导读」（失败自动退回纯模板）
        llm:
          provider: ''            # 由设置页写入；留空表示不调用模型
          model: ''
          report_prompt: ''       # 报告导读的系统提示词，留空用内置约束
          dm_prompt: ''           # 私信改写的系统提示词（控语气），留空用内置约束
          max_tokens: 600         # 64–4000
          timeout_ms: 20000       # 1000–120000，超时按失败处理
        notify:
          channels: [bili_dm]     # bili_dm / email，可多选；留空 [] 表示不发通知
          summary_max_chars: 200  # 60–800
          bili_dm:
            sender_sessdata: ''   # 可选：留空则用扫码登录的「发私信账号」
            sender_bili_jct: ''   # 可选：同上
            sender_mid: ''        # 发送方 UID；留空时取扫码登录保存的 mid
            receiver_mid: ''      # 接收方 UID；留空自动用「读历史账号」的 mid（必须与 sender_mid 不同）
          email:
            host: ''              # 例如 smtp.qq.com；留空表示没配邮件
            port: 465             # 465 配 secure: true（隐式 TLS）；587 配 secure: false（STARTTLS）
            secure: true
            allow_plain: false    # 只有确认内网服务器不需要加密时才打开
            user: ''              # SMTP 登录账号，通常与 from 相同
            pass: ''              # SMTP 授权码（不是登录密码）
            from: ''              # 发件地址，必须与 SMTP 账号一致，否则多数服务商会拒
            to: ''                # 收件地址，可以等于 from（自发自收）
            from_name: B站观看统计
            subject_prefix: '[B站观看统计]'
            attach_report: false  # 默认关；打开后额外附一份 Markdown 报告
            timeout_ms: 20000
            retries: 1            # 4xx 才重试
            backoff_ms: 2000
        state_dir: ~/.dsh/bili-statistics
```

### 怎么登录 B 站（推荐：扫码）

插件提供两条扫码登录通道，各登录一个账号：

| 角色 | 用途 | 调用 |
| --- | --- | --- |
| `reader` | 读观看历史 | `bili_intent_login(role="reader")` |
| `sender` | 发私信 | `bili_intent_login(role="sender")` |

流程：调用工具 → 会话里出现一张带二维码的卡片 → 手机 B 站 App 扫码并在手机上点确认 → 调用 `bili_intent_login_poll` 完成登录。凭据落在 `state_dir/credentials.json`（明文，注意本机文件权限），之后 `bili.sessdata` 与 `notify.bili_dm.sender_*` 都可以留空。

卡片画不出二维码时，工具返回里带一个登录链接，可把链接发到手机用浏览器打开（等价于扫码）。二维码默认 180 秒有效，过期重新调用即可。

### 备选：手填 Cookie

- 浏览器登录 bilibili.com → F12 → Application/存储 → Cookies → `https://www.bilibili.com`；
- `SESSDATA` → `bili.sessdata`；
- `bili_jct` → `bili.bili_jct`（CSRF，私信接口要用）；
- 自己的 UID：打开 <https://api.bilibili.com/x/web-interface/nav>，看 `data.mid`；
- 接收方 UID：想让哪个账号收到私信（可以是你的小号，但**不能和发送方同一个 UID**，否则接口返回 21026）。

发送方和接收方的 Cookie 可以来自两个不同账号——这正是"给自己发一条私信提醒"的做法。配置里的 `bili.sessdata` 优先级高于扫码保存的 reader 凭据。

---

## 设置页

打开 DSH GUI 的「设置」，左栏会多出一节「B 站观看统计」（设置页 id `bili-statistics`）。它把日常要动手的事都收在一处，不用记工具名：

| 区域 | 能做什么 |
| --- | --- |
| 当前状态 | 看意图、最近一次统计、两个账号是否登录 |
| 扫码登录 | 选「读号」或「发私信号」生成二维码，确认后自动保存凭据；也能一键退出登录 |
| 意图锚点 | 直接改写意图文本（等价于 `bili_intent_set`） |
| 模型与语气 | 选 provider / model、开关报告润色、编辑报告导读提示词、改最大 token 与超时（保存按钮在这一块最下方） |
| 定时任务 | 开关定时、选周期（每天/每周/每月/自定义区间）、选统计窗口、用下拉列表选小时/分钟（每周再加星期、每月再加日期）、看下次触发时间与上次触发结果 |
| 本地保存 | 开关是否落盘、选格式（Markdown / HTML / 两者）、改报告目录（可直接填路径或用常用位置按钮，还能先「检查目录」）；关掉就只出卡片与通知（保存按钮在这一块最下方） |
| 通知渠道 | 先勾选要用的渠道（B 站私信 / 邮件，可多选），再用「私信设置」「邮件设置」两个按钮进入各自的设置界面：私信界面填接收方 UID、私信语气提示词、摘要字数上限并能发测试私信；邮件界面填 SMTP 主机端口授权码与收发件人，并能发测试邮件 |
| 手动触发 | 「立即统计一次」（等价于 `facts` + `report`）；测试私信与测试邮件已移进各自的设置界面 |
| 本次输出预览 | 显示刚生成的摘要，确认私信会写成什么样 |

设置页写入的是 `state_dir/settings.json`（覆盖层），启动时深合并到 profile 配置之上，因此**它的优先级高于 `cordis.patch.yml`**，重启后仍生效。删除该文件或调用清空即可回到 profile 配置。

只允许改「模型、提示词、开关、摘要长度、接收方 UID、定时规则、本地保存格式、报告目录、通知渠道、SMTP 设置」这几类字段；cookie、发送方 UID 仍然只能走 profile 配置——设置页提交这些字段会被拒绝，并在返回的 `rejected` 里列出键名，避免把凭据写坏。改完定时规则会立刻重排下一次触发，不用重启。

私信的接收方默认取「读历史账号」的 UID：两个号都扫码登录后，统计结果直接发到你自己常用的那个号，不用手填。若想发给别人，在「通知渠道 → 私信设置 → 接收方 UID」里填目标 UID 即可（留空则回到自动回落）。

页面按钮走本机接口 `/bili-statistics/api?action=…`（带同源校验，跨站请求返回 403）。所有动作与工具复用同一套函数，两种入口不会出现两套口径。

### 定时任务

周期（`schedule.mode`）与统计窗口（`schedule.window`）是两个独立维度：周期决定「多久跑一次」，窗口决定「每次统计哪一段时间」。

| 周期 | 自然日历（calendar） | 滚动（rolling） |
| --- | --- | --- |
| `daily` | **默认**：昨天整天（00:00 → 今天 00:00） | 从触发时刻往前推 24 小时 |
| `weekly` | 过去 7 个自然日（今天 00:00 往前 7 天） | 从触发时刻往前推 7×24 小时 |
| `monthly` | 上一个自然月（上月 1 日 00:00 → 本月 1 日 00:00，跨年自动处理） | 从触发时刻往前推 30 天（不超过一个月） |
| `custom` | 用 `custom_from` / `custom_to` 指定区间，结束日期含当天 | 同左（自定义区间优先于窗口策略） |

默认触发时间按周期给：每天 22:00、每周一 08:00、每月 1 日 08:00。设置页里不用写 cron：选小时（00–23）、分钟（每 5 分钟一档），每周再加「星期」下拉、每月再加「日期」下拉，插件自己换算成五段 cron 存进 `schedule.cron`。配置文件和工具参数仍接受五段 cron（如 `30 21 * * *`）——cron 里不是「分 时 日 月 周」这种简单形式时，设置页会退回默认值显示，保存后会被覆盖，所以要么只用列表，要么只改配置文件。下次触发时间与它对应的窗口会显示在设置页的「定时任务」和 `bili_intent_status` 的 `next_fire` / `next_window` 里。

定时任务与卡片解耦：到点由宿主侧直接拉历史、算统计事实、写报告文件、按渠道发私信，不需要会话在场，也不需要模型（配了模型才会额外润色）。

每次到点都重新拉一遍历史、重新统计、重新写报告，没有「同一天只跑一次」这类跳过：手动统计过的日期、同一天第二次及以后的触发，都照常执行，保证数据是当下重新拉的。唯一的跳过情形是还没登录 B 站（既没扫码也没配 `sessdata`），这时会记一条「跳过」并在原因里说明。每次触发（执行、跳过、失败）都会写进 `state.schedule_log`，设置页「定时任务」底下显示一行「上次触发 21:25 · 已执行」，`bili_intent_status` 里的 `schedule.last_event` / `schedule.recent_events` 是同一份记录。

手动触发（「立即统计一次」与 `bili_intent_facts` 工具）的边界：

- **与定时互不干扰**：手动统计只统计与落盘，不发私信；定时到点照常重新统计、照常发私信。私信没有每日次数限制，「发测试私信」只用于自测，不占任何名额、不影响定时任务。
- **会改写最新记录**：手动那条成为 `state.runs[0]`，设置页「最近统计」、报告卡片、`bili_intent_status.latest_run` 显示的都是它；它也进入基线样本（最近 14 条的中位数比较），同一天多跑几次会让基线里混入窗口重叠的样本。

### 模型润色与私信语气

插件通过宿主注入的 `llm` 服务调用模型（`ctx.llm.stream`），需要你在设置页选定 provider 与 model：

- **报告导读**：模板报告照常渲染，模型额外写一段「形态导读（模型生成）」，只叙述数字，不评价、不建议。关掉 `report.polish` 或没选模型时，这一节直接不出现，报告其余部分不受影响。
- **私信语气**：模板摘要给出硬事实，模型按 `llm.dm_prompt` 改写。提示词里可用 `{max_chars}` 占位，会被替换成本次字数上限。
- **失败即降级**：模型超时、报错、返回空文本时，结果里 `polished: false` 并带 `polish_reason`（如 `no-model` / `error` / `empty-output`），报告照常落盘，私信退回模板摘要，绝不发空消息。

---

## 本地保存

报告默认落到 `state_dir/reports/`，文件名按窗口类型取：`report-2026-10-28.md`（日/月）、`report-2026-W44.md`（周）、`report-2026-10-28-custom.md`（自定义区间），后缀随格式是 `.md` 或 `.html`。

| 字段 | 含义 |
| --- | --- |
| `report.save_local` | 总开关。关掉后统计、卡片、通知都照常，只是不写文件 |
| `report.format` | `markdown` / `html` / `both`。HTML 是自包含单文件（内联样式、无外链），可直接浏览器打开或归档 |
| `report.local_dir` | 落盘目录，支持 `~`；留空表示用插件默认目录。设置页可直接改 |

设置页「本地保存」里的勾选框、格式下拉和目录输入框写的就是这三个字段，改完点「保存设置」立即生效（不用重启）。

改目录的三种方式：

1. 直接在输入框里填绝对路径或 `~/xxx`；
2. 点「常用位置」里的「默认 / 文档 / 桌面」——默认会把输入框清空（表示回落到插件默认目录），文档与桌面填的是各自的 `B站观看报告` 子目录；
3. 填完点「检查目录」：宿主会真的 `mkdir -p` 并把一个临时文件写进去再删掉，成功提示「目录可用（已创建）」，失败会说明是不能创建还是不可写。

不接受盘符根目录（如 `F:\`），免得报告散在盘根；清空输入框保存则回到默认目录。目录只影响报告落盘位置，与通知渠道无关。

落盘与通知互不影响：写文件失败不影响发通知，发通知失败也不影响已经写好的文件。想在本地留档但不想被打扰，把 `notify.channels` 清空即可。

## 邮件通知

把 `notify.channels` 加上 `email` 并填好 `notify.email`，或在设置页「通知渠道」勾上「邮件」再填表单。要点：

1. **授权码不是登录密码**：QQ 邮箱在「设置 → 账户 → POP3/IMAP/SMTP 服务」开启并生成授权码；163 邮箱同理；Gmail 需要应用专用密码。把授权码填进 `pass`（设置页里叫「授权码」）。
2. **端口与加密必须配对**：`465 + secure: true`（隐式 TLS，最省事），或 `587 + secure: false`（STARTTLS）。配对错了要么连不上，要么卡在等 220 响应。服务器没宣告 STARTTLS 而你又要求加密时，插件会直接报错而不是降级明文——除非显式把 `allow_plain` 打开。
3. **自发自收**：`from` 与 `to` 可以相同；`from` 必须与 SMTP 登录账号一致，否则多数服务商会以「发件人不符」拒收。
4. **内容边界**：正文只有一条 ≤ `summary_max_chars` 的摘要；不含原始观看记录、不含 cookie、不含 SMTP 凭据。只有 `attach_report: true` 时才额外附一份 Markdown 报告（同样不含凭据）。
5. **失败隔离**：邮件失败只影响邮件自己——私信照发、文件照写。`results` 里每个渠道各有一条 `ok` / `error`，任一成功即 `delivered: true`。
6. **测试入口**：设置页「通知渠道」里的「发送测试邮件」只发一封测试摘要（带附件开关同样生效），用来验证连通性和垃圾箱落点；它不占任何名额，也不影响定时任务。

邮件客户端是插件自己实现的最小 SMTP（`lib/smtp.js`，只用 Node 内置 `net`/`tls`/`crypto`，不依赖 nodemailer），因此不支持 OAuth2、不支持除附件外的 MIME 扩展；`4xx` 类错误按 `retries` 重试并线性退避，`5xx` 直接失败。

---

## 九个工具

| 工具 | 作用 | 关键点 |
| --- | --- | --- |
| `bili_intent_set` | 记录本轮意图（自由文本） | 立即生效，不会改写历史意图 |
| `bili_intent_status` | 查看当前意图、最近一次统计、定时下次触发时间、通知渠道、两个账号的登录状态 | 只读 |
| `bili_intent_login` | 生成扫码登录二维码 | 参数 `role`(reader/sender)；卡片直接画二维码，另附登录链接兜底 |
| `bili_intent_login_poll` | 查询扫码状态并保存凭据 | 参数 `wait_seconds`(0–60)；确认后用 nav 接口验证账号可用性 |
| `bili_intent_facts` | 拉历史 + 算统计事实 | 参数 `mode`(daily/weekly/monthly/custom)、`window`(calendar/rolling)、`from`、`to` |
| `bili_intent_annotate` | 写入 1–3 条偏离假设 | 每条必须 ≥2 个有效证据序号；正文 ≤240 字；含评价性措辞会返回 `tone_warnings` |
| `bili_intent_report` | 生成卡片 + 落盘 Markdown/HTML | 返回文件路径，卡片上可点「打开报告」 |
| `bili_intent_feedback` | 对假设打分 | `accurate` / `inexact` / `incomplete` / `useless` |
| `bili_intent_notify` | 手动/定时推送摘要 | 每次调用都真发，不做每日次数限制；`dry_run: true` 只预览 |

设计约束（写在工具描述里，也由校验强制执行）：

- 只解释偏离，不评价自控力，不给建议；
- 每条假设必须锚定 ≥2 条真实记录，序号对应 `facts` 返回的编号；
- 区分「硬事实」（接口字段）与「推断」（行为形态、来源判断）；
- 允许「这周看不出明确模式」——空输出是合法结果；
- 证据序号越界或不足时，该条假设会被丢弃并在 `rejected` 里说明原因。

---

## 数据说明与已知限制

**硬事实**：标题、作者、`view_at`、`progress`、`duration`、`business`、`bvid`。

**推断**：`history/cursor` 接口**不返回"这条是主动点的还是自动播的"**，所以「主动/被动」只能按行为形态（进度条位置、时长、连续播放链）启发式推断，并带置信度。卡片上「行为形态」与「置信度」就是这件事的可见交代。

其他限制：

- 分页深度受 `max_pages` 限制，超长窗口可能截断；
- 接口有频率限制，默认 400ms 间隔、遇到 `-352/-412` 会退避重试；
- 两个通知渠道都可用，但能力有边界：邮件只发摘要（附件需显式开启）、B 站私信是纯文本且要求收发账号不同；
- 通知不做每日次数限制：定时任务到点且勾了渠道就发。觉得吵就少勾渠道或把定时改成每周/每月；
- 凭据是明文的：扫码登录后存在 `state_dir/credentials.json`，手填时存在 profile 配置里，两者都不加密，注意本机文件权限；
- 模型润色依赖宿主 `llm` 服务：设置页里没选 provider/model 时报告与私信都退回模板，不会报错；
- 仓库里没有任何账号凭据：TV 扫码通道用的 `appkey`/`appsec` 是 B 站 TV 客户端的公开常量（社区通用），不代表任何个人账号；你的 SESSDATA、bili_jct、UID、邮箱授权码只存在于本机 `state_dir` 或 profile 配置里。

---

## 数据落盘

- 报告：`~/.dsh/bili-statistics/reports/`（`.md` / `.html`，按日期命名）
- 状态：`~/.dsh/bili-statistics/state.json`（意图、统计运行记录、假设、反馈、通知去重标记）
- 登录凭据：`~/.dsh/bili-statistics/credentials.json`（reader/sender 两个账号的 SESSDATA、bili_jct、mid、昵称）
- 设置页覆盖层：`~/.dsh/bili-statistics/settings.json`（模型、提示词、开关、摘要长度；优先级高于 profile 配置）

删除 `state_dir` 即彻底重置。

> 插件以前叫 `dsh-bili-intent-drift`，数据目录是 `~/.dsh/bili-intent-drift`。第一次以新名字启动时，插件会把旧目录整份复制到 `~/.dsh/bili-statistics`（旧目录保留，确认无误后可手动删除），所以扫码登录、历史报告、定时设置都不用重做。

---

## 开发

```bash
node test/host.test.mjs    # 宿主侧：工具注册、全链路、通知渠道、扫码登录、设置页接口、模型润色降级、邮件端到端
node test/smtp.test.mjs    # SMTP 客户端：假服务器上的命令序列、认证、MIME 附件、4xx 重试与 5xx 失败
node test/client.test.mjs  # 客户端：九张卡片、设置页渲染、二维码、词典一致性
node test/qr.test.mjs      # 二维码编码器：与 Nayuki 实现的黄金矩阵逐位比对
Get-ChildItem lib/*.js | ForEach-Object { node --check $_.FullName }
```

注意：**不要用 `node --test <file>`**，它会 spawn 子进程，在本机沙箱下会 `spawn EPERM`；测试文件是可直接执行的普通脚本（内部用 `node:test`）。

目录结构：

```
lib/index.js    宿主入口：配置、工具、定时、状态编排
lib/bili.js     观看历史接口（分页、退避、游标）
lib/facts.js    统计事实（完成度、深夜占比、连续链、来源推断）
lib/report.js   报告渲染（Markdown / HTML）
lib/polish.js   模型调用：报告导读与私信改写（含降级）
lib/api.js      设置页用的 HTTP 路由（同源校验、动作分发）
lib/store.js    settings.json 覆盖层与可写字段白名单
lib/notify.js   通知渠道（B 站私信、邮件）
lib/smtp.js     最小 SMTP 客户端（net/tls，AUTH LOGIN、MIME、重试）
lib/state.js    状态持久化
lib/time.js     cron 解析与本地时间
lib/util.js     小工具（expandHome、脱敏、截断）
lib/qr.js       二维码编码器（字节模式、版本自选、掩码评分，无依赖）
lib/bili-login.js 扫码登录接口（生成、轮询、nav 验证）
lib/creds.js    登录凭据读写（credentials.json）
lib/client.js   浏览器 bundle：九张 `tool.call.toolview` 卡片 + `settings.section` 设置页
locale/*.json   插件列表展示用的标题与描述
test/fixtures/  二维码黄金矩阵（回归测试用）
```
