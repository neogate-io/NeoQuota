# CPA Quota Monitor

独立的 CPA Codex 账号池额度监控页。官方 CPA 仓库不需要改动；本项目构建出单文件 `dist/quota-monitor.html`，并提供一个独立 Bun/SQLite 监控服务。

## 构建前端

```bash
bun install --frozen-lockfile
bun run build
```

产物：

```text
dist/quota-monitor.html
```

## 启动监控服务

单 CPA：

```bash
export MONITOR_KEY="监控页登录密码"
export CPA_API_BASE="http://154.21.88.164:8398"
export CPA_MANAGEMENT_KEY="CPA management key"
export PORT=8787
export DB_PATH="./data/quota-monitor.sqlite"
export COLLECT_USAGE_MODE=continuous
export COLLECT_USAGE_TICK_SECONDS=180
export COLLECT_USAGE_MAX_REQUESTS_PER_MINUTE=2
export COLLECT_USAGE_NORMAL_MIN_INTERVAL_MINUTES=90
export COLLECT_USAGE_HOT_MIN_INTERVAL_MINUTES=30
export COLLECT_USAGE_MAX_STALENESS_MINUTES=120
export COLLECT_CONCURRENCY=2
export COLLECT_MANUAL_CONCURRENCY=10
export COLLECT_MANUAL_MAX_REQUESTS_PER_MINUTE=10
export COLLECT_USAGE_JITTER_SECONDS=45
export COLLECT_USAGE_ERROR_BACKOFF_MINUTES=10
export COLLECT_USAGE_ERROR_BACKOFF_MAX_MINUTES=120
export CPA_REQUEST_TIMEOUT_SECONDS=60
export CACHE_TRUST_MAX_MINUTES=60
export ALERT_POOL_REMAINING_HOURS_WARN=6
export ALERT_POOL_REMAINING_HOURS_CRITICAL=3
export ALERT_POOL_REMAINING_HOURS_EMERGENCY=1
export ALERT_SMS_PROVIDER=aliyun
export ALERT_SMS_RECIPIENTS="13800138000,13900139000"
export ALIYUN_SMS_ACCESS_KEY_ID="阿里云 AccessKeyId"
export ALIYUN_SMS_ACCESS_KEY_SECRET="阿里云 AccessKeySecret"
export ALIYUN_SMS_SIGN_NAME="短信签名"
export ALIYUN_SMS_TEMPLATE_CODE="SMS_xxx"

bun run server
```

多 CPA：

```bash
export MONITOR_KEY="监控页登录密码"
export CPA_TARGETS='[
  {"id":"main","name":"Main CPA","apiBase":"http://154.21.88.164:8398","managementKey":"key-a"},
  {"id":"backup","name":"Backup CPA","apiBase":"http://127.0.0.1:8398","managementKey":"key-b"}
]'

bun run server
```

`CPA_TARGETS` 设置后，会替代 `CPA_API_BASE` / `CPA_MANAGEMENT_KEY` 单 CPA 配置。SQLite 表中的快照、账号样本和采集状态都会按 `cpa_id` 隔离，前端可以用下拉框切换不同 CPA。

## 采集频率与风控保护

监控服务会查询启用 Codex 账号的 `wham/usage`，这是额度读取请求，不是模型对话请求，但账号池较大时仍建议保守采集。默认策略是低频连续巡检，目标是判断未来几小时额度是否够用，而不是分钟级实时账单：

- `COLLECT_USAGE_MODE=continuous`：默认连续错峰模式；兼容 `COLLECT_STRATEGY=adaptive/full`，但即使使用 full 或旧接口 `forceFull=true`，也会按安全限速执行。
- `COLLECT_USAGE_TICK_SECONDS=180`：后台每 3 分钟检查一次是否有账号到期。
- `COLLECT_USAGE_MAX_REQUESTS_PER_MINUTE=2`：后台真实 usage 查询启动预算，默认每分钟最多启动 2 个账号。
- `COLLECT_USAGE_NORMAL_MIN_INTERVAL_MINUTES=90`：普通账号采样间隔，默认约 90 分钟。
- `COLLECT_USAGE_HOT_MIN_INTERVAL_MINUTES=30`：近期有消耗、余额偏低或接近 reset 的账号会更早复采，默认约 30 分钟。
- `COLLECT_USAGE_MAX_STALENESS_MINUTES=120`：账号长期没成功采样时会提高优先级；账号数很多时仍优先遵守全局请求预算。
- `COLLECT_CONCURRENCY=2`：后台自动巡检最多同时进行 2 个真实 usage 查询。
- `COLLECT_MANUAL_CONCURRENCY=10`：页面“智能采集”最多同时进行 10 个真实 usage 查询。
- `COLLECT_MANUAL_MAX_REQUESTS_PER_MINUTE=10`：页面“智能采集”的真实 usage 查询启动预算，默认每分钟最多启动 10 个账号。
- `COLLECT_USAGE_JITTER_SECONDS=45`：采集调度会用 jitter 分散账号到期时间；真实 usage 请求启动时会叠加最多 10 秒随机等待，避免固定节奏。
- `COLLECT_USAGE_ERROR_BACKOFF_MINUTES=10`：账号遇到 `401 / 403 / 429 / rate limit` 类错误后进入退避。
- `COLLECT_USAGE_ERROR_BACKOFF_MAX_MINUTES=120`：连续异常时指数退避，最长 120 分钟。
- `CPA_REQUEST_TIMEOUT_SECONDS=60`：访问 CPA Management API 超过 60 秒会失败并写入采集状态，避免页面一直等待。
- `CACHE_TRUST_MAX_MINUTES=60`：缓存 quota 超过 60 分钟未真实刷新时，不再计入“保守可用额度”。
- `ALERT_POOL_REMAINING_HOURS_WARN=6`：预计可撑时间低于 6 小时时进入补号预警。
- `ALERT_POOL_REMAINING_HOURS_CRITICAL=3`：预计可撑时间低于 3 小时时进入严重预警。
- `ALERT_POOL_REMAINING_HOURS_EMERGENCY=1`：预计可撑时间低于 1 小时时进入紧急预警。

近 10/30/60 分钟和近 3 小时消耗只基于 fresh 真实样本。统计时会使用账号真实查询完成时间 `quota_sampled_at`，并按 `account_key` 分组；窗口开始前最多 90 分钟内的 baseline 样本可以参与计算，避免跨窗口边界的消耗被漏掉。

## 短信预警

服务端每次采集完成后会复用总览页的风险判断，命中以下情况会发送短信：

- 账号池容量预警：`risk.tone` 达到 `warn` 或 `critical`，也就是预计可撑时间低于 `ALERT_POOL_REMAINING_HOURS_WARN` / `ALERT_POOL_REMAINING_HOURS_CRITICAL` / `ALERT_POOL_REMAINING_HOURS_EMERGENCY`。
- 账号池使用异常：启用账号出现 `failed`、`backoff`、`unknown` 等硬异常，数量达到 `ALERT_ACCOUNT_ISSUE_THRESHOLD`。

推荐直接使用阿里云短信：

```bash
export ALERT_SMS_PROVIDER=aliyun
export ALERT_SMS_RECIPIENTS="13800138000,13900139000"
export ALIYUN_SMS_ACCESS_KEY_ID="..."
export ALIYUN_SMS_ACCESS_KEY_SECRET="..."
export ALIYUN_SMS_SIGN_NAME="安师傅"
export ALIYUN_SMS_TEMPLATE_CODE="SMS_xxx"
export ALIYUN_SMS_TEMPLATE_PARAM_NAME=content
```

阿里云短信模板需要提前审核。默认会把告警短文放进模板变量 `content`，也就是请求里的 `TemplateParam={"content":"[CPA预警] ..."}`；如果模板变量名不是 `content`，用 `ALIYUN_SMS_TEMPLATE_PARAM_NAME` 调整。

也可以保留通用 webhook 方式：

```bash
export ALERT_SMS_PROVIDER=webhook
export ALERT_SMS_WEBHOOK_URL="https://example.com/sms-webhook"
export ALERT_SMS_RECIPIENTS="13800138000"
```

webhook 请求体里会同时带一条可直接发送的 `message` 和结构化指标，方便 webhook 自己裁剪短信内容：

```json
{
  "type": "quota_monitor_alert",
  "channel": "sms",
  "severity": "warn",
  "kind": "account-issues",
  "cpaId": "main",
  "cpaName": "Main CPA",
  "recipients": ["13800138000"],
  "title": "账号池使用异常",
  "message": "[CPA预警] Main CPA：账号池使用异常，硬异常 2 个，失败/未知 2 个，异常账号：acc-a(退避)、acc-b(失败)",
  "metrics": {
    "enabledAccounts": 20,
    "failedOrUnknownAccounts": 2,
    "hardIssueAccounts": 2,
    "hourlyBurnUsd": 12.3,
    "oneHourBurnUsd": 14.2,
    "threeHourBurnUsd": 11.8,
    "burnRateBasis": "one-hour",
    "availableHours": 2.4,
    "estimatedDepletionAt": 1764590400000
  }
}
```

可选配置：

- `ALERT_SMS_ENABLED=true`：没有配置阿里云参数或 webhook URL 时默认关闭；配置完整后默认开启；显式设置为 `false` 可强制关闭。
- `ALERT_SMS_PROVIDER=aliyun`：短信发送方式，可选 `aliyun` / `webhook`；不填时会优先按完整阿里云参数判断。
- `ALIYUN_SMS_ACCESS_KEY_ID` / `ALIBABACLOUD_ACCESS_KEY_ID`：阿里云短信 AccessKeyId。
- `ALIYUN_SMS_ACCESS_KEY_SECRET` / `ALIBABACLOUD_ACCESS_KEY_SECRET`：阿里云短信 AccessKeySecret。
- `ALIYUN_SMS_SIGN_NAME`：阿里云短信签名。
- `ALIYUN_SMS_TEMPLATE_CODE`：阿里云短信模板 Code。
- `ALIYUN_SMS_TEMPLATE_PARAM_NAME=content`：告警短信正文使用的模板变量名，默认 `content`。
- `ALIYUN_SMS_REGION_ID=cn-hangzhou`：阿里云短信 Region，默认 `cn-hangzhou`。
- `ALIYUN_SMS_ENDPOINT=https://dysmsapi.aliyuncs.com`：阿里云短信 endpoint，默认官方 Dysmsapi endpoint。
- `ALERT_SMS_WEBHOOK_URL` / `ALERT_WEBHOOK_URL`：短信 webhook 地址。
- `ALERT_SMS_WEBHOOK_TOKEN` / `ALERT_WEBHOOK_TOKEN`：可选 Bearer Token，会放到 `Authorization` header。
- `ALERT_SMS_RECIPIENTS=13800138000,13900139000`：收件手机号列表；阿里云直发时会用英文逗号拼成 `PhoneNumbers`，webhook 方式会原样放进请求体。
- `ALERT_SMS_MIN_TONE=warn`：容量告警最低级别，可选 `watch`、`warn`、`critical`，默认 `warn`。
- `ALERT_ACCOUNT_ISSUE_THRESHOLD=1`：硬异常账号达到多少个才发账号异常短信，默认 1。
- `ALERT_SMS_COOLDOWN_MINUTES=30`：同一 CPA、同一类告警的冷却时间，默认 30 分钟；升级为更严重级别或异常数量上升会立即发送。
- `ALERT_SMS_TIMEOUT_SECONDS=10`：调用 webhook 超时时间，默认 10 秒。
- `ALERT_SMS_MAX_MESSAGE_CHARS=500`：`message` 最大长度，默认 500。

页面右上角的“页面自动刷新”只读取监控服务数据，不会触发账号 usage 查询。页面里的“智能采集”用于当前 CPA 全池小批量并发错峰补齐：新增账号、首次初始化、补完整快照都点它；它会把当前 CPA 的所有启用 Codex 账号纳入本轮目标，但仍按 `COLLECT_MANUAL_CONCURRENCY` 和 `COLLECT_MANUAL_MAX_REQUESTS_PER_MINUTE` 控制同时查询数和启动频率，退避中的账号会跳过，不会集中请求全部账号。以 38 个账号、最多 10 并发、每分钟最多启动 10 个真实 usage 查询计算，完整补齐通常需要约 6-9 分钟。

顶部会区分“保守可用额度”和“账面额度”。账面额度统计 `fresh + cached` 可用账号；保守可用额度只统计 `fresh + 未超过 CACHE_TRUST_MAX_MINUTES 的 cached`。一旦账号出现 `401 / 403 / 429 / rate limit` 等错误进入 `backoff`，或处于 `failed / pending`，会立刻从总额度、成功账号数和刷新时间分布中剔除，避免影响补号判断。总览页会显示预计可撑时间、预计耗尽时间、估算每小时消耗、估算口径、消耗覆盖、fresh 覆盖、可信覆盖、过期缓存数和未来 5 小时容量曲线。账号身份优先使用 `chatgpt_account_id`，再回退到 `authIndex` 和文件名，避免同一位置换号时误沿用旧缓存。账号很多时建议保持默认 continuous 策略，避免频繁手动全量采集。

## 反向代理

推荐同源部署：

```text
/quota-monitor.html     -> 静态文件 dist/quota-monitor.html
/quota-monitor-api/*    -> Bun 服务 http://127.0.0.1:8787/quota-monitor-api/*
```

Nginx 示例：

```nginx
location = /quota-monitor.html {
  alias /path/to/cpa-quota-monitor/dist/quota-monitor.html;
}

location /quota-monitor-api/ {
  proxy_pass http://127.0.0.1:8787;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

## 页面入口

前端仍然只需要部署一个单文件 `quota-monitor.html`。页面内部使用 Hash 子页面：

```text
/quota-monitor.html#/overview          总览页
/quota-monitor.html#/accounts          账号明细页
/quota-monitor.html#/refresh-times     刷新时间分布页
```

直接访问 `/quota-monitor.html` 时会自动进入 `#/overview`。

## 数据与安全

- `CPA_MANAGEMENT_KEY` 只在服务端环境变量中使用，不返回给前端，不写入 SQLite。
- `MONITOR_KEY` 是监控页自己的登录密码，登录成功后通过 HttpOnly cookie 访问监控 API。
- SQLite 默认保留最近 7 天采样。
- 美元值是按社区实测价格表折算的估算值，不是 OpenAI 官方账单金额。

## 默认价格表

默认价格表为 `参考图 2026-04-10`：

| 套餐 | 5h | 周限 |
| --- | ---: | ---: |
| 普号 | 未计价 | $10.58 |
| Plus | $18.77 | $117.31 |
| Team | $21.65 | $135.33 |
| Pro | $317.16 | $1858.00 |

页面里可以编辑价格表，修改后会用新价格重新计算最新统计和历史趋势展示。

## 价格依据

这组默认值来自 2026-04-10 的社区实测，不是 OpenAI 官方账单金额。OpenAI 当前公开说明中，Codex 更偏向 credits / token-based rate card 和按套餐共享 agentic usage limit 的口径；不同任务、模型、上下文、fast mode 会导致消耗差异。

- 社区参考：<https://linux.do/t/topic/1937028>
- OpenAI Codex rate card：<https://help.openai.com/en/articles/20001106-codex-rate-card>
- Using Codex with your ChatGPT plan：<https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan>
- ChatGPT credits / flexible usage：<https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-freegopluspro-sora>
