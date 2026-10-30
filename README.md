<p align="center"><a href="./README.md">English</a> | <a href="./README.zh-CN.md">中文</a></p>

<p align="center"><strong>Bilibili Watch Statistics</strong> — <em>see what you actually watched.</em></p>

<p align="center"><sub>No runtime dependencies · QR sign-in · Local Markdown/HTML reports · DM &amp; email digests · Model-written overview and plan status</sub></p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-bili-statistics"><img src="https://img.shields.io/npm/v/dsh-bili-statistics?style=flat-square" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="license"></a>
  <a href="https://github.com/apiaoapiao/dsh-bili-statistics"><img src="https://img.shields.io/badge/GitHub-apiaoapiao%2Fdsh--bili--statistics-181717?style=flat-square&logo=github" alt="GitHub"></a>
</p>

A Bilibili watch-statistics plugin for DSH (DeepSeek Harness) that puts your **plan** next to **what you actually watched**.

It reads **your own** watch history from Bilibili's official API, computes a set of statistical facts locally, and then lets the host model write an overview, a plan-status section based on the real video titles, and a digest in the tone you configured. The result shows up as a session card, lands in a Markdown or HTML report, and can be delivered to your Bilibili DM inbox or an email address.


## Features

- **Statistics** — item count, mean completion, share after 22:00, autoplay chains and a comparison against the last 14 runs; per day, week, month or custom range, with calendar or rolling windows
- **Model notes** — the model names this period's viewing state (for example "late-night recommendation binge"), gives one line of evidence, a 150–350 word overview, and 1–3 plan-status items; every item has to mention a specific video title or author and cite at least 2 record indexes
- **Interactions** — likes, coins (with the coin count) and favorites inside the window, plus how many live streams you watched and an estimate of the time spent there; favorites use the save time kept in the folders, likes and coins are checked against each video you watched
- **Reports** — Markdown or a self-contained HTML file, filed automatically into `daily/`, `weekly/`, `monthly/` and `custom/`
- **Notifications** — Bilibili DM and email, either or both; the tone comes from one editable prompt that both channels share
- **Scheduling** — daily, weekly, monthly or custom, with the trigger time picked from dropdowns; it fetches history, writes the report and sends the digest by itself, no session needed
- **QR sign-in** — web and TV channels, switching to TV automatically when the web channel is blocked
- **Settings page** — sign-in, model, prompts, schedule, saving and notifications all live in DSH Settings, so you never have to memorise tool names

## Requirements

- DSH (DeepSeek Harness) web profile
- Node.js 22 or newer
- A Bilibili account you can scan a QR code with, to read history; plus a **different** account to send DMs (the API rejects messages to yourself)

## Install

```bash
# from npm (recommended)
dsh plugin --profile web add dsh-bili-statistics

# or from a local checkout, when you want to change the code
git clone https://github.com/apiaoapiao/dsh-bili-statistics.git
dsh plugin --profile web add 'file:/path/to/dsh-bili-statistics'
```

The package ships with defaults, so it works right after install. Refresh the GUI page and the tools, cards and settings page appear. Once you edit `src/*.js`, restart `dsh web` — the ESM loader caches the old implementation and will not hot-replace it.

To change defaults, edit the profile's `cordis.patch.yml` (see [Configuration](#configuration)) or just use the settings page, which writes an override layer with higher priority.

## Quick start

1. Open DSH Settings and pick **Bilibili watch statistics** in the sidebar
2. Under **Current status**, click **Scan** → **Account that reads watch history**, then scan with the Bilibili app and confirm (the web channel falls back to TV automatically if blocked)
3. To receive DMs, sign in a second account the same way, this time choosing **Account that sends DMs**
4. Under **Model and tone**, pick a provider and model; it also works without one, the report just lists numbers
5. Click **Run statistics now** and check **Latest output** to see what the digest looks like
6. For scheduled runs, enable **Schedule**, choose a period and trigger time, then tick **DM** or **Email** under **Notification channels**

## Usage

### Settings page

| Area | What you can do |
| --- | --- |
| Current status | See your plan, the latest run, and whether both accounts are signed in |
| Scan | Pick the role that reads history or the one that sends DMs, show a QR code, save credentials after confirmation, or log out |
| Plan | Rewrite the plan text directly (same as `bili_intent_set`) |
| Model and tone | Pick provider / model, toggle "Model writes overview and plan status", edit prompts, adjust max tokens and timeout |
| Schedule | Enable scheduling, choose period and window, pick hour and minute from dropdowns (plus weekday for weekly, day of month for monthly), and see the next fire time and the last trigger result |
| Local saving | Toggle saving to disk, pick the format, change the report directory (type a path or choose a common location, or **Check directory** first) |
| Notification channels | Tick Bilibili DM and/or email, edit the tone prompt shared by both, then enter each channel's form and test button via **DM settings** / **Email settings** |
| Manual triggers | **Run statistics now** |
| Latest output | Shows the freshly generated digest, so you know what the DM will say |

The settings page writes `state_dir/settings.json`, which is deep-merged on top of the profile config at startup, so it survives restarts; delete that file to fall back to the profile config. It may only change the model, prompts, toggles, digest length, recipient UID, schedule rules, save format, report directory, notification channels and SMTP settings. Cookies and the sender UID still have to come from the profile config — submitting those fields is rejected and the rejected keys are listed in the response.

### Tools in a session

Without the settings page you can also let the model call tools directly in a session:

| Tool | What it does |
| --- | --- |
| `bili_intent_set` | Record the plan for this round (free text) |
| `bili_intent_status` | Plan, latest run, next scheduled fire, notification channels, sign-in state of both accounts |
| `bili_intent_login` | Create a QR sign-in code (`role`: reader / sender) |
| `bili_intent_login_poll` | Check the scan state and save credentials (`wait_seconds`: 0–60) |
| `bili_intent_facts` | Fetch history and compute statistical facts (`mode`: daily/weekly/monthly/custom, `window`: calendar/rolling, `from` / `to`) |
| `bili_intent_annotate` | Store 1–3 plan-status items (a fallback when the model gives no conclusions) |
| `bili_intent_report` | Render the card and save Markdown/HTML |
| `bili_intent_feedback` | Rate the result (accurate / inexact / incomplete / useless) |
| `bili_intent_notify` | Push the digest; `dry_run: true` only previews it |

A typical chain:

```
bili_intent_set(text="I want to sleep earlier this week, no long videos at night")
bili_intent_facts(mode="weekly")
bili_intent_report(run_id="<run_id from the previous call>")
```

`facts` returns the statistics plus an indexed evidence list. If you want the model to judge for itself, let it write 1–3 conclusions in the session after `facts`, store them with `bili_intent_annotate` (each must cite at least 2 valid indexes), then call `bili_intent_report`.

### Scheduled runs

The period decides how often it runs; the window decides which range is measured:

| Period | Calendar | Rolling |
| --- | --- | --- |
| `daily` | **Default**: all of yesterday | 24 hours before the trigger time |
| `weekly` | the past 7 calendar days | 7×24 hours before the trigger time |
| `monthly` | the previous calendar month | 30 days before the trigger time |
| `custom` | the range given by `custom_from` / `custom_to` | same (a custom range wins) |

Default trigger times: 22:00 daily, Monday 08:00 weekly, the 1st at 08:00 monthly. You never type cron in the settings page — pick an hour and minute (5-minute steps); the profile config and tool arguments still accept a five-field cron.

Every fire re-fetches history, recomputes and rewrites the report; there is no "only once a day" skipping, so the numbers are always fresh. The only skip is "not signed in to Bilibili yet", and the trigger log records the reason. **Run statistics now** does not interfere with the schedule: a manual run only collects and saves, it sends no notifications; the schedule keeps recomputing and notifying as usual.

### Notifications

- **Bilibili DM** — needs two different UIDs. The recipient defaults to the history account; put a different UID under **Notification channels → DM settings → Recipient UID** if you want it elsewhere.
- **Email** — QQ / 163 use an SMTP authorization code (not your login password), Gmail uses an app password. Use `465 + implicit TLS` or `587 + STARTTLS`; the port and the encryption setting must match. `from` must equal the SMTP login account and may equal `to` (send to yourself).
- **Content boundary** — the body is a single digest of at most `summary_max_chars` (200 by default). It contains no raw watch history, no cookies and no SMTP credentials; a Markdown report is attached only when `attach_report` is explicitly enabled.
- **Failure isolation** — one failing channel affects neither the other channel nor writing the report. Each channel gets its own result, and a single success counts as delivered.
- **No rate limit** — whenever the schedule fires with a channel ticked, it sends. If that is too noisy, untick a channel or switch the period to weekly / monthly.

## Reports and data

Reports go to `~/.dsh/bili-statistics/reports/` by default and are filed into a subdirectory per window. The filename uses the **last day of the measured range**, not the day you clicked the button:

| Window | Subdirectory | Example filename |
| --- | --- | --- |
| Daily | `daily/` | `report-2026-10-28.md` |
| Weekly | `weekly/` | `report-2026-W44.md` (ISO week) |
| Monthly | `monthly/` | `report-2026-10.md` |
| Custom | `custom/` | `report-2026-10-28-custom.md` |

Re-running the same window overwrites the same file (one file per day), while different windows never overwrite each other. The report directory can be changed in the settings page; click **Check directory** before saving — the host really creates the directory and writes a temporary probe file.

How the interaction numbers are counted:

- **Favorites** — every folder is paged through and each entry is placed by its save time; entries that are invalid (deleted or taken down) are skipped
- **Likes / coins** — Bilibili exposes no list with action timestamps, so each video watched inside the window is checked for "is it liked / how many coins does it have right now". The number of videos checked is capped by `bili.interaction_max` (200 by default, prioritising favourites, then fully-watched videos, then the rest), so this is a "still there?" check and does not include likes on videos you never watched; a typical day of ~150 videos takes about a minute
- **Live** — the number of streams is the number of live records; the history API does not return a per-session duration (`duration` and `progress` are always 0), so the time is estimated from the gap to the next record and capped at 30 minutes per session — a gap of several hours almost certainly is not real viewing time, so treat the total as an order of magnitude

`state_dir` (default `~/.dsh/bili-statistics`) also holds:

- `state.json` — the plan, every run, plan-status items, feedback and the trigger log
- `credentials.json` — SESSDATA, bili_jct, UID and nickname from QR sign-in
- `settings.json` — the override layer written by the settings page

Credentials are stored in **plain text**; mind the file permissions. Deleting `state_dir` resets everything. When upgrading from the old name `dsh-bili-intent-drift`, the old data directory is copied over once, so sign-in and past reports carry over.
## Configuration

Keys and defaults (all of them can be changed in the profile's `cordis.patch.yml`):

```yaml
bili:
  sessdata: ''            # empty = use the credentials saved by QR sign-in
  bili_jct: ''            # same
  page_size: 30           # the API caps this at 30
  request_interval_ms: 400
  max_pages: 40
  interactions: true      # collect likes / coins / favorites / live
  interaction_max: 200    # how many watched videos to check; higher = slower (~80s for 200)
schedule:
  enabled: true
  mode: daily             # daily | weekly | monthly | custom
  window: calendar        # calendar | rolling
  cron: ''                # empty = period default (22:00 / Mon 08:00 / 1st 08:00)
  timezone: Asia/Shanghai
  custom_from: ''         # required when mode: custom
  custom_to: ''
report:
  save_local: true
  local_dir: ~/.dsh/bili-statistics/reports
  format: markdown        # markdown | html | both
  evidence_limit: 20      # 2–40, how many records are handed to the model
  polish: true            # model writes the overview and plan status
llm:
  provider: ''            # empty = never call the model
  model: ''
  report_prompt: ''       # how to write the overview and plan status (style only, not the JSON shape)
  dm_prompt: ''           # rewrite prompt shared by DM and email (controls tone); {max_chars} supported
  max_tokens: 2000        # 800–8000; at render time report ≥ 2000, DM ≥ 1600
  timeout_ms: 20000
notify:
  channels: [bili_dm]     # bili_dm / email, any combination; [] disables notifications
  summary_max_chars: 200  # 60–800
  bili_dm:
    sender_sessdata: ''   # empty = the signed-in sender account
    sender_bili_jct: ''
    sender_mid: ''
    receiver_mid: ''      # empty = the UID of the history account
  email:
    host: ''              # e.g. smtp.qq.com; empty = email not configured
    port: 465             # 465 + secure: true, or 587 + secure: false
    secure: true
    allow_plain: false    # only for internal relays that cannot do TLS
    user: ''              # SMTP login account, usually the same as from
    pass: ''              # SMTP authorization code
    from: ''              # sender address, must match the SMTP account
    to: ''                # recipient address, may equal from
    from_name: B站观看统计
    subject_prefix: '[B站观看统计]'
    attach_report: false  # attach a Markdown report as well
    timeout_ms: 20000
    retries: 1            # only 4xx are retried
    backoff_ms: 2000
state_dir: ~/.dsh/bili-statistics
```

## Privacy

- Reads Bilibili's official API only, and only your own watch history; no write operations except DMs, and those go only to the recipient you specify
- Statistics and reports are generated locally and never uploaded; model calls go to the provider you configured in DSH
- The repository contains no account credentials. The `appkey` / `appsec` used by the TV sign-in channel are public constants of Bilibili's TV client and belong to no personal account
- Your SESSDATA, bili_jct, UID and email authorization code live only in your local `state_dir` or profile config

## Known limitations

- The watch-history API **does not return the source**, so "did I click this or did autoplay?" can only be inferred from completion, duration and consecutive plays. Rules vote for a label with a confidence, then the model turns it into a human-readable name using the titles; without a model you see the rule label and its confidence
- Paging is bounded by `max_pages`, so very long windows may be truncated; the API is rate limited (400 ms interval by default) and retries with backoff on `-352` / `-412`
- Model output depends on the host's `llm` service: with no provider/model selected, on timeout, or on error, the report keeps its numbers and notifications fall back to the template digest, with no error raised; when output is cut off by tokens you get a hint, and raising `max_tokens` fixes it
- The email client is a minimal built-in SMTP implementation without OAuth2; Bilibili DMs are plain text and require different sender and receiver accounts
- The web QR channel may be blocked by Bilibili's risk control (`-412`); the plugin then switches to the TV channel automatically
- Likes and coins carry no timestamp, so they are checked as "still liked / still coined?" on the videos watched inside the window, bounded by `interaction_max` (favourites and fully-watched videos are checked first); live streams are counted from the records and their time is estimated from the gaps, capped at 30 minutes per session

## Implementation notes

Pure ESM, no build step and no third-party runtime dependencies — the QR encoder and the SMTP client are built in and use Node core modules only. The host side provides tools, state and scheduling; the browser side provides session cards and the settings page.

The source is layered by responsibility: `src/domain` (statistics and rendering, pure functions), `src/adapters` (Bilibili API and SMTP), `src/core` (state, credentials, config), `src/services` (model calls, notifications), `src/tools` and `src/transport` (tool definitions, settings-page API), and `src/index.js` (orchestration only).

## License

Released under the MIT License. See [LICENSE](./LICENSE).
