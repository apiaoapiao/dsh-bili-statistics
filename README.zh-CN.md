<p align="center"><a href="./README.md">English</a> | <a href="./README.zh-CN.md">中文</a></p>

<p align="center"><strong>B 站观看统计</strong> — <em>看清自己到底看了什么。</em></p>

<p align="center"><sub>零运行时依赖 · 扫码登录 · 本地 Markdown/HTML 报告 · 私信与邮件摘要 · 模型写概览与计划情况</sub></p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-bili-statistics"><img src="https://img.shields.io/npm/v/dsh-bili-statistics?style=flat-square" alt="npm 版本"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="license"></a>
  <a href="https://github.com/apiaoapiao/dsh-bili-statistics"><img src="https://img.shields.io/badge/GitHub-apiaoapiao%2Fdsh--bili--statistics-181717?style=flat-square&logo=github" alt="GitHub"></a>
</p>

把「计划」和「实际看了什么」摆在一起看的 B 站观看统计插件（DSH / DeepSeek Harness）。

它从 B 站官方接口读取**你自己**的观看历史，在本地算出一组统计事实，再让宿主大模型照着每条视频的标题写一段概览、一份计划完成情况，并按你设定的语气生成一条摘要；结果渲染成会话卡片、落盘 Markdown/HTML 报告，可推送 B 站私信或邮件。

## 功能

- **统计**：条数、平均完成度、22 点后占比、连续播放、与最近 14 次基线的对比，按日 / 周 / 月 / 自定义区间统计，支持自然日历与滚动窗口
- **模型说明**：模型给本次观看起一个状态名（例如「深夜连刷推荐」）并写一句依据、一段 150–350 字概览、1–3 条计划完成情况；每条都要点到具体视频标题或作者，并引用至少 2 条记录编号
- **互动**：窗口内的点赞、投币（含枚数）、收藏数，看了几场直播与估算的直播停留时长；收藏按收藏夹里的收藏时间算，点赞与投币按「看过的视频现在还在不在赞 / 投过币」对照
- **报告**：Markdown 或 HTML 自包含单文件，按周期自动分进 `daily/`、`weekly/`、`monthly/`、`custom/` 子目录
- **通知**：B 站私信与邮件，可多选；语气由一段可编辑的提示词控制，两个渠道共用
- **定时**：每天 / 每周 / 每月 / 自定义区间，触发时间用下拉列表选，到点自己拉历史、写报告、发通知，不需要会话在场
- **扫码登录**：网页通道与 TV 通道，网页通道被风控拦截时自动切换
- **设置页**：登录、模型、提示词、定时、保存、通知都收在 DSH 设置里，不用记工具名

## 环境要求

- DSH（DeepSeek Harness）的 web profile
- Node.js 22 或更高
- 一个能扫码的 B 站账号用于读历史；想收私信再准备一个**不同的**账号用于发送（收发同 UID 会被接口拒绝）

## 安装

```bash
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-bili-statistics

# 或者从本地源码安装
git clone https://github.com/apiaoapiao/dsh-bili-statistics.git
dsh plugin --profile web add 'file:/path/to/dsh-bili-statistics'
```

包内自带默认配置，装好即可用。之后刷新 GUI 页面，工具、卡片与设置页就会出现。改过 `src/*.js` 之后需要重启 `dsh web`，ESM 已缓存的旧实现不会热替换。

想改默认值，编辑 profile 的 `cordis.patch.yml`（字段见下方「配置」），或者直接用设置页——设置页写的是覆盖层，优先级更高。

## 快速开始

1. 打开 DSH 设置，左栏找到「B 站观看统计」
2. 「当前状态」里点「扫码登录」，选「读历史账号」，手机 B 站扫码并确认（网页通道被拦时会自动切到 TV 通道）
3. 想收私信，再用同样方式登录「发私信号」
4. 在「模型与语气」里选一个 provider 与 model；不选也能用，只是报告里只有数字
5. 点「立即统计一次」，在「本次输出预览」里看摘要长什么样
6. 想定时收，在「定时任务」里打开开关、选周期与触发时间，再在「通知渠道」勾好私信或邮件

## 使用

### 设置页

| 区域 | 能做什么 |
| --- | --- |
| 当前状态 | 看计划、最近一次统计、两个账号是否登录 |
| 扫码登录 | 选「读号」或「发私信号」生成二维码，确认后自动保存凭据，也能一键退出 |
| 计划 | 直接改写计划文本（等价于 `bili_intent_set`） |
| 模型与语气 | 选 provider / model、开关「模型写概览与计划情况」、编辑提示词、改最大 token 与超时 |
| 定时任务 | 开关定时、选周期与窗口、用下拉列表选小时/分钟（每周再加星期、每月再加日期）、看下次触发时间与上次触发结果 |
| 本地保存 | 开关是否落盘、选格式、改报告目录（可填路径或用常用位置，也能先「检查目录」） |
| 通知渠道 | 勾选 B 站私信 / 邮件，填两个渠道共用的语气提示词，再用「私信设置」「邮件设置」进入各自的表单与测试按钮 |
| 手动触发 | 「立即统计一次」 |
| 本次输出预览 | 显示刚生成的摘要，确认私信会写成什么样 |

设置页写入的是 `state_dir/settings.json`，启动时深合并到 profile 配置之上，所以重启后仍生效；删掉该文件就回到 profile 配置。设置页只允许改模型、提示词、开关、摘要长度、接收方 UID、定时规则、保存格式、报告目录、通知渠道与 SMTP 设置；cookie、发送方 UID 仍然只能走 profile 配置，提交这些字段会被拒绝并在返回里列出键名。

### 会话里的工具

不用设置页时，也可以直接在会话里让模型调用工具：

| 工具 | 作用 |
| --- | --- |
| `bili_intent_set` | 记录本轮计划（自由文本） |
| `bili_intent_status` | 查看计划、最近一次统计、定时下次触发、通知渠道、两个账号的登录状态 |
| `bili_intent_login` | 生成扫码登录二维码（`role`: reader / sender） |
| `bili_intent_login_poll` | 查询扫码状态并保存凭据（`wait_seconds`: 0–60） |
| `bili_intent_facts` | 拉历史 + 算统计事实（`mode`: daily/weekly/monthly/custom，`window`: calendar/rolling，`from`/`to`） |
| `bili_intent_annotate` | 写入 1–3 条计划情况（模型没给出判断时的备份） |
| `bili_intent_report` | 生成卡片并落盘 Markdown/HTML |
| `bili_intent_feedback` | 对结果打分（accurate / inexact / incomplete / useless） |
| `bili_intent_notify` | 推送摘要，`dry_run: true` 只预览 |

典型工具链：

```
bili_intent_set(text="这周想早点睡，晚上尽量不看长视频")
bili_intent_facts(mode="weekly")
bili_intent_report(run_id="<上一步的 run_id>")
```

`facts` 返回统计事实与编号后的证据列表。想让模型自己判断，可以在 `facts` 之后让它在会话里写 1–3 条结论，再调用 `bili_intent_annotate`（每条必须引用 ≥2 个有效编号），最后 `bili_intent_report`。

### 定时任务

周期决定「多久跑一次」，窗口决定「每次统计哪一段」：

| 周期 | 自然日历（calendar） | 滚动（rolling） |
| --- | --- | --- |
| `daily` | **默认**：昨天整天 | 从触发时刻往前推 24 小时 |
| `weekly` | 过去 7 个自然日 | 从触发时刻往前推 7×24 小时 |
| `monthly` | 上一个自然月 | 从触发时刻往前推 30 天 |
| `custom` | 用 `custom_from` / `custom_to` 指定区间 | 同左（自定义区间优先） |

默认触发时间：每天 22:00、每周一 08:00、每月 1 日 08:00。设置页里不用写 cron，选小时与分钟（每 5 分钟一档）即可；配置文件和工具参数仍接受五段 cron。

每次到点都重新拉一遍历史、重新统计、重新写报告，没有「同一天只跑一次」这类跳过，保证数字是当下重新拉的。唯一的跳过情形是还没登录 B 站，这时会在触发记录里写明原因。手动「立即统计一次」与定时互不干扰：手动只统计与落盘、不发通知；定时照常重新统计、照常发通知。

### 通知

- **B 站私信**：需要两个不同 UID。接收方默认取「读历史账号」，想让别的号收到，在「通知渠道 → 私信设置 → 接收方 UID」里填。
- **邮件**：QQ / 163 用 SMTP 授权码（不是登录密码），Gmail 用应用专用密码。`465 + 隐式 TLS` 或 `587 + STARTTLS`，两者必须配对。`from` 要与 SMTP 登录账号一致，可以等于 `to`（自发自收）。
- **内容边界**：正文只有一条不超过 `summary_max_chars`（默认 200 字）的摘要，不含原始观看记录、不含 cookie、不含 SMTP 凭据；只有显式打开 `attach_report` 才额外附一份 Markdown 报告。
- **失败隔离**：某个渠道失败不影响另一个，也不影响报告落盘。每个渠道各有一条成功/失败结果，任一成功即视为已送达。
- **不限次数**：定时到点且勾了渠道就发，觉得吵就少勾渠道或把周期改成每周 / 每月。

## 报告与数据

报告默认落在 `~/.dsh/bili-statistics/reports/`，按窗口分子目录，文件名取**被统计区间的最后一天**（不是点按钮那天）：

| 窗口 | 子目录 | 文件名示例 |
| --- | --- | --- |
| 日 | `daily/` | `report-2026-10-28.md` |
| 周 | `weekly/` | `report-2026-W44.md`（ISO 周号） |
| 月 | `monthly/` | `report-2026-10.md` |
| 自定义 | `custom/` | `report-2026-10-28-custom.md` |

同一窗口重复统计仍是同名覆盖（保持「一天一份」），不同窗口互不覆盖。报告目录可以在设置页里改，保存前可以先「检查目录」——宿主会真的建目录并试写一个临时文件。

互动数字的口径：

- **收藏**：逐夹翻收藏夹分页，按每条的收藏时间落进窗口，已失效（被删 / 下架）的条目不计
- **点赞 / 投币**：B 站不提供带动作时间的点赞与投币列表，只能对窗口内看过的视频逐条查「当前是否点赞、投了几枚」，条数上限由 `bili.interaction_max` 决定（默认 200，按「窗口内收藏 → 看完的 → 其余」排序取前 N）。所以这是「现在还在不在」的对照结果，不含看了没记录的点赞；一天 150 条左右时这一步大约要 1 分钟
- **直播**：场次按直播记录条数算；历史接口不返回单场观看时长（`duration` 与 `progress` 恒为 0），时长按相邻观看记录的时间差估算，单场最多按 30 分钟算——时间差拉到几小时时不可能真看了那么久，所以只作量级参考

`state_dir`（默认 `~/.dsh/bili-statistics`）里还有：

- `state.json`：计划、每次统计的运行记录、计划情况、反馈、触发日志
- `credentials.json`：扫码登录得到的 SESSDATA、bili_jct、UID、昵称
- `settings.json`：设置页写入的覆盖层

凭据是**明文**保存的，注意本机文件权限；删除 `state_dir` 即彻底重置。从旧名字 `dsh-bili-intent-drift` 升级时，旧数据目录会被整份复制过来，扫码登录与历史报告不用重做。

## 配置

键名与默认值（都可以在 profile 的 `cordis.patch.yml` 里改）：

```yaml
bili:
  sessdata: ''            # 留空则用扫码登录保存的凭据
  bili_jct: ''            # 同上
  page_size: 30           # 接口上限 30
  request_interval_ms: 400
  max_pages: 40
  interactions: true      # 采集点赞 / 投币 / 收藏 / 直播
  interaction_max: 200    # 最多对照多少条看过的视频，越多越慢（200 条约 80 秒）
schedule:
  enabled: true
  mode: daily             # daily | weekly | monthly | custom
  window: calendar        # calendar | rolling
  cron: ''                # 留空按周期取默认（22:00 / 周一 08:00 / 1 日 08:00）
  timezone: Asia/Shanghai
  custom_from: ''         # mode: custom 时必填
  custom_to: ''
report:
  save_local: true
  local_dir: ~/.dsh/bili-statistics/reports
  format: markdown        # markdown | html | both
  evidence_limit: 20      # 2–40，交给模型的证据条数
  polish: true            # 模型写概览与计划情况
llm:
  provider: ''            # 留空表示不调用模型
  model: ''
  report_prompt: ''       # 概览与计划情况的写法（管文风，不管 JSON 格式）
  dm_prompt: ''           # 私信与邮件共用的改写提示词（控语气），可用 {max_chars}
  max_tokens: 2000        # 800–8000；实际润色时报告至少 2000、私信至少 1600
  timeout_ms: 20000
notify:
  channels: [bili_dm]     # bili_dm / email，可多选；[] 表示不发通知
  summary_max_chars: 200  # 60–800
  bili_dm:
    sender_sessdata: ''   # 留空则用扫码登录的「发私信号」
    sender_bili_jct: ''
    sender_mid: ''
    receiver_mid: ''      # 留空自动用「读历史账号」的 UID
  email:
    host: ''              # 例如 smtp.qq.com；留空表示没配邮件
    port: 465             # 465 + secure: true，或 587 + secure: false
    secure: true
    allow_plain: false    # 只有内网服务器不需要加密时才打开
    user: ''              # SMTP 登录账号，通常与 from 相同
    pass: ''              # SMTP 授权码
    from: ''              # 发件地址，须与 SMTP 账号一致
    to: ''                # 收件地址，可以等于 from
    from_name: B站观看统计
    subject_prefix: '[B站观看统计]'
    attach_report: false  # 打开后额外附一份 Markdown 报告
    timeout_ms: 20000
    retries: 1            # 仅 4xx 重试
    backoff_ms: 2000
state_dir: ~/.dsh/bili-statistics
```

## 隐私

- 只读 B 站官方接口，只取你自己账号的观看历史；不发任何写操作（私信除外，只发给你指定的接收方）
- 统计与报告都在本机生成，不上传到第三方；模型调用走你在 DSH 里配置的 provider
- 仓库里没有任何账号凭据。TV 扫码通道用的 `appkey` / `appsec` 是 B 站 TV 客户端的公开常量，不代表任何个人账号
- 你的 SESSDATA、bili_jct、UID 与邮箱授权码只存在于本机的 `state_dir` 或 profile 配置里

## 已知限制

- 观看历史接口**不返回来源**，「主动点的还是自动播的」只能按完成度、时长与连续播放推断。规则先投一个标签并给出可信度，模型再结合标题写成一句人看得懂的状态名；没有模型时显示规则标签与可信度
- 分页受 `max_pages` 限制，超长窗口可能被截断；接口有频率限制，默认 400ms 间隔，遇到 `-352` / `-412` 会退避重试
- 模型依赖宿主的 `llm` 服务：没选 provider/model、超时或报错时，报告只留数字、通知退回模板摘要，不报错；输出被 token 截断时会给出提示，把 `max_tokens` 调大即可
- 邮件客户端是自带的最小 SMTP 实现，不支持 OAuth2；B 站私信是纯文本且要求收发账号不同
- 网页扫码通道可能被 B 站风控拦截（`-412`），此时会自动切到 TV 扫码通道
- 点赞与投币没有动作时间，只能按窗口内看过的视频对照「现在是否还赞着 / 投过币」，条数受 `interaction_max` 限制（超出时优先保证收藏与看完的那些）；直播按记录条数计场次，时长按记录间隔估算、单场最多 30 分钟

## 实现说明

纯 ESM，没有构建步骤，也没有第三方运行时依赖——二维码编码器与 SMTP 客户端都是自带实现（只用 Node 内置模块）。宿主侧提供工具、状态与定时，浏览器侧提供会话卡片与设置页。

源码按职责分层：`src/domain`（统计与渲染，纯函数）、`src/adapters`（B 站接口与 SMTP）、`src/core`（状态、凭据、配置）、`src/services`（模型调用、通知）、`src/tools` 与 `src/transport`（工具定义、设置页接口）、`src/index.js`（只做编排）。

## 许可

MIT，见 [LICENSE](./LICENSE)。