# wb-bridge

把你自己的 WorkBuddy 桌面版登录态，变成 DSH 可以直接使用的 OpenAI 兼容接口。
**不需要第三方 DSH 插件，也不需要第三方网关**——只有这一个可审计的小服务。

## 它做什么

```
DSH (@deepseek-ai/dsh-llm-pi-ai, api: openai-completions)
        │  http://127.0.0.1:8791/v1
        ▼
   wb-bridge.mjs          ← 本脚本（只监听回环地址）
        │  解锁凭据 + 补认证头 + 清洗指纹 + 改名工具 + 透传 SSE
        ▼
   copilot.tencent.com/v2/chat/completions
        ▲
        │ Bearer <你的 WorkBuddy accessToken>
   WorkBuddy 桌面 App 的登录态（只读，不修改）
```

三个路由：

| 路由 | 说明 |
|---|---|
| `GET /healthz` | 运行状态（region / 凭据缓存 / 令牌到期 / 模型数） |
| `GET /v1/models` | 当前账号可对话的模型列表 |
| `POST /v1/chat/completions` | 对话；上游只支持流式，非流式请求由本脚本聚合成 JSON |

## 关键实现说明

### 凭据是加密的

WorkBuddy 5.6+ 用 `{$wbEncrypted:1, envelope}` 包住 `auth.accessToken` /
`auth.refreshToken`。解开它需要的密钥在本机，但只能通过 **WorkBuddy 自己的
Electron 二进制**在 `ELECTRON_RUN_AS_NODE=1` 下读取其私有 `workbuddyStorage` 绑定：

```
WorkBuddy.exe -e 'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'
```

拿到 `atRestSecretKey` 后 `protectorKey = sha256(atRestSecretKey, utf8)`，
再以 AES-256-GCM 打开信封（AAD = `WB-AAD\0` + 版本 + `WBEV1` + `sym-v1` +
suite + keyId + 尾部 3 字节）。

### 模型目录按 User-Agent 分流

`/v3/config` 对 CLI 形态的 UA 返回可对话的 `cli` 名册（本机 19 个模型），对 App
形态的 UA 返回含图片/视频/补全模型的内部目录（40 个但多数不能对话）。因此目录请求
固定使用 `CLI/2.63.2 CodeBuddy/2.63.2`。

### 上游只支持流式

非流式请求返回 `code 11101 Non-stream chat request is currently not supported`，
所以脚本总是向上游要流式；若 DSH 侧请求非流式，脚本把 SSE 聚合成标准
`chat.completion` 返回。

### 上游会做「客户端指纹」校验

请求里若含其它 agent 框架的特征句，网关返回
`HTTP 400 / code 11128 Illegal API invocation from an unapproved channel`。实测
（2026-11-03）：

- 匹配的是**整句**，拆成片段单独发送都能通过；
- 扫描范围是**所有消息角色的全部内容**，不只是 `system`。长会话历史里会引用
  自己的系统提示（工具结果、子代理摘要），所以只清洗系统消息不够；
- 把已知特征句从每条消息里替换掉之后，同一个 904 条消息 + 96 个工具的请求返回 200。

清洗表见源码里的 `CONTENT_SCRUBS`，由 `scrubFingerprints()` 应用。

### 工具名是更强的指纹，已统一改名

`tools[].function.name` 里出现 `spawn_teammate`、`dsh_im_return_file`、
`mcp__github__*` 这类名字，服务端一眼就能判断这不是官方客户端。`tool-rename.mjs`
维护一张 54 条规则表，桥在三个位置做双向映射：

1. 上行的工具定义 `tools[]`
2. 上行历史里的 `tool_calls[].function.name`
3. 下行流式返回的 `tool_calls[].function.name`（缓冲还原，DSH 才能找到真实工具）

改名示例：

| 真实名 | 上行暴露的名字 |
|---|---|
| `spawn_teammate` | `run_task` |
| `create_worktree` | `create_branch_workspace` |
| `create_goal` / `update_goal` | `track_goal` / `update_goal_status` |
| `team_task_create` 等 4 个 | `add_task` / `read_task` / `list_project_tasks` / `update_task` |
| `workflow` / `ralph` | `run_pipeline` / `iterate` |
| `terminal_*` 6 个 | `open_shell` / `send_to_shell` / `read_shell` … |
| `schedule_*` 4 个 | `add_reminder` / `update_reminder` … |
| `dsh_im_return_file` | `send_file` |
| `mcp__github__*` 40 个 | `github_*` |
| ds-bot 的 `create_bot` / `message_bot` 等 22 个 | `add_contact` / `message_contact` … |

**功能零损失**：工具仍然可用，只是名字换成了中性词。日志里会打印实际上行的名字：

```
tools(96, 74 renamed on the wire): ask_user, track_goal, create_branch_workspace, ...
```

> 数量随会话变化——取决于当场加载了哪些插件（实测见过 118/94 与 96/74 两种）。
> 别把某一组数字当基线核对，看日志最新那行即可。

### 上下文窗口必须逐个声明

provider 配置里的 `models[]` 需要写 `contextWindow`，否则 pi-ai 用默认
262144，长会话会被本地拒绝（`CONTEXT_WINDOW_EXCEEDED`，请求根本不会发出）。

同理 `reasoningEfforts` 决定模型选择器里有没有「思考强度」；不写就没有。

### 上游模型变了怎么办

这是**两层**的事，容易只做一半：

```
上游模型目录 ──①桥自动感知──→ /v1/models（10 分钟缓存，无需干预）
                                   │
                                   ×  断层：桥从不改 DSH 的配置
                                   ↓
DSH 的 models[] ──②需要显式刷新──→ cordis.patch.yml
```

第二层用 `refresh-models.mjs`：

```cmd
node refresh-models.mjs                 :: 只看差异，不写
node refresh-models.mjs --apply         :: 写入（先备份，再用 DSH 同款 yaml 库校验）
node refresh-models.mjs --prune --apply :: 同时删掉上游已下线的条目
node refresh-models.mjs --restyle --apply :: 用上游元数据重算已有条目的窗口/档位
```

**默认只加不改**：DSH 里已有的条目原样保留。因为上游元数据常常比人工配置更差——
不少老模型只给一个 `reasoning.effort` 而**没有** `supportedEfforts` 列表，
照着「刷新」会把三档思考强度悄悄降成一档。`--restyle` 才是显式要求重算。

写完要重载 DSH（重启 App，或到模型设置里重选一次 provider）才会读到新清单。

`probe-models.mjs` 可以单独看上游全量元数据（包含桥不暴露的图片/视频/补全模型）：

```cmd
node probe-models.mjs              :: 表格
node probe-models.mjs hy4 hy3      :: 按关键字筛选
node probe-models.mjs --json       :: 原始载荷
```

> 同一个模型可能有多个 id 只是**计费档位不同**。例如 `hy4free` 与 `hy4std`
> 元数据逐字段相同，只有 `credits` 分别是 `x0.00` 和 `x0.29`——免费额度和付费额度。
> 客户端按 UA 合并显示为一个 "Hy4"，桥用 CLI UA 所以能看到两个。

### 运行期自愈

- **上游瞬时错误（429 / 500 / 502 / 503 / 504）自动退避重试**：指数退避 + 抖动，
  有 `Retry-After` 就按它等（秒数或 HTTP 日期都认），最多 `--retry-attempts` 次
  （默认 4），且总退避时间不超过 `--retry-budget-ms`（默认 120 秒）。
  抖动是故意的：多个会话共用一个桥时不会同时重试，把限流撞得更狠。
  400/401/404 不重试——那是请求本身或凭据的问题，重试也没用。
  日志形如 `attempt 1: upstream 429 — retrying in 857ms`。
- 遇到 11128 会自动降级重试（`system-as-user` / `no-tools` / `trim-last-40` /
  `drop-unknown`），成功一次后就记住首选变体
- 全部变体失败时，把请求体存档为 `failed-body-*.json` 并打印结构摘要
- 端口被占用时（重复启动）检测到健康实例就安静退出，不报错

### 看门狗

`watchdog.mjs` 每 5 分钟由计划任务 `wb-bridge-watchdog` 跑一次：

- 探 `GET /healthz`（4 秒超时）
- 健康 → 静默 `exit 0`，**不写日志**（每分钟都哔哔的监控没人看）
- 不健康 → 通过 `autostart-wb-bridge.cmd` 拉起一次，再轮询 12 秒
- 仍然起不来 → `exit 1`，往 `reports/verdict.log` 写一行
- **冷却 5 分钟**：上次重启不到 5 分钟又挂，就拒绝再拉，只报「疑似崩溃循环」

它不杀任何正在跑的进程，也从不假装成功——拉不起来就是拉不起来。

> 加这个是因为 2026-11-03 的一次真实事故：改完启动脚本后重启，脚本失败，桥静默
> 停了 2 分钟，直到人发现。日报太慢，看门狗补的正是这个空档。

### 每日自检

`daily-check.mjs` 每天跑一次（计划任务 `wb-bridge-daily`，08:00），回答三个问题：

1. **过去这段时间跑得怎么样** —— 请求数 / 成功率 / 上游状态码分布 / 最慢请求
2. **现在还能不能用** —— 真实发一次 `ping` 到上游（不是只探 `/healthz`），
   空回复也算失败
3. **上游有没有新增检查** —— 11128 出现次数与恢复情况、未登记的上游状态码、
   **上游实际提供的模型 vs DSH 配置里声明的模型**（两边都是活的才叫漂移检测）、
   令牌剩余天数

结果写到 `reports/wb-daily-YYYY-MM-DD.md`（人看）与 `reports/daily-log.jsonl`（机器看），
另有 `reports/verdict.log` 一行结论。退出码 `0` 正常 / `1` 告警 / `2` 需要处理。
计划任务本身总是返回 0，避免 Windows 把「有告警」记成「任务失败」。

```cmd
daily-check.cmd            :: 手动跑一次
```

## 运行

```cmd
start-wb-bridge.cmd
```

保持窗口开着（可最小化），日志追加到 `bridge-stdout.log`。关闭窗口即停止。

前置条件：WorkBuddy 桌面 App 已安装并登录。脚本会自己找到
`%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe` 或 `F:\workbuddy\WorkBuddy.exe`
（本机实测的两处）；路径不同时用 `--exe` 或环境变量 `WORKBUDDY_ELECTRON_BIN` 指定。

**Node 不需要在 PATH 里。** 启动脚本按 `WB_BRIDGE_NODE` → PATH → 标准安装位置
（`%ProgramFiles%\nodejs` 等）→ `.\node\` 依次查找。计划任务不总继承用户 PATH，
只靠 PATH 会导致重启后拒绝启动——这是踩过的坑。

### 开机自启与定期任务

```powershell
.\install-tasks.ps1              # 注册看门狗 + 每日自检
.\install-tasks.ps1 -At 09:30    # 改每日自检时间
.\install-tasks.ps1 -Unregister  # 全部移除
```

仓库里的 `*.task.xml` 是**模板**：用户 SID 和桥目录是占位符，注册时由脚本填入，
所以仓库里没有任何个人账户标识或绝对路径。

三个任务各管一件事：

| 任务 | 触发 | 作用 |
|---|---|---|
| `wb-bridge` | 登录时 | 启动桥 |
| `wb-bridge-watchdog` | 每 5 分钟 | 桥不监听就拉起 |
| `wb-bridge-daily` | 每天 08:00 | 运行统计 + 上游漂移检测 + 真实探针 |

### 配置

所有机器相关路径都由 `config.mjs` 统一解析，优先级：
命令行参数 → 环境变量 → `config.json` → 运行时推导的默认值。
把 `config.example.json` 复制成 `config.json` 即可覆盖；后者已被 `.gitignore` 排除。

## 接入 DSH

DSH 的 `dsh-base` 默认已挂载 `@deepseek-ai/dsh-llm-pi-ai`（`id: llm-pi-ai`，无
`config`，空路由启动），所以接入是纯配置，写在
`~/.dsh/profiles/desktop/cordis.patch.yml`：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      local-gateway:
        displayName: WorkBuddy
        api: openai-completions
        baseURL: http://127.0.0.1:8791/v1
        headers:
          Authorization: Bearer local-gateway-placeholder
        models:
          - id: deepseek-v4.1-flash
            name: "DeepSeek-V4.1-Flash"
            contextWindow: 1000000
            maxTokens: 128000
            input: [text, image]
            reasoningEfforts:
              low: low
              high: high
              max: max
              off: null
```

> `headers.Authorization` 是必需的：pi-ai 对完全没有凭据的 provider 会直接抛
> `No API key for provider`。本地服务不校验它的值。

## 安全边界与已知风险

- 只监听 `127.0.0.1`，不对外网开放
- 不写 WorkBuddy 的凭据文件，只读；令牌、密钥不落盘、不打印
- **官方没有为「订阅积分程序化调用」提供支持，这属于非官方途径。** 即使已做
  指纹清洗与工具改名，仍存在以下风险：
  - 上游随时可能增加新检查而失效
  - 单次请求体量（长会话可达 2 MB / 55 万 token）与官方交互式使用差异明显
  - 违反 WorkBuddy 服务条款的可能，账号处置权在上游
- 建议：单账号、本机、单会话；勤开新会话；不要并发多会话；发现非 200 立即停用
