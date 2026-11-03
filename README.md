# dsh-local-delegate — 本地小模型委派插件

把**机械性文本工作**（翻译、摘要、字段抽取、分类、改写、commit message、命名）交给本地廉价模型，主模型只保留判断与工具调用。

关键不在「多一个模型工具」，而在**正文走哪条路**：插件自己读文件、分块、调用本地模型、写回结果，所以整篇文档**不会进入主模型上下文**。一篇 10KB 文档的翻译，主模型只花约 150 token（一次调用），而不是约 5,000 token（读原文 + 写译文）。

0.4.0 新增两个能力（默认关闭/默认等级下行为与 0.3.0 完全一致）：

- **本地 AI 介入程度（按项目工作区）**：`无 / 轻度 / 默认 / 更高 / 最高`；默认 = 当前行为；「最高」让主 agent 只做规划，所有修改/命令交给本地 worker 子 agent；
- **SlaveAgentTeams（多从节点并行）**：root/Team Lead 一次并行启动多个 slave 子 agent，每个跑在本地廉价模型或云端路由上，再由 master 汇总；与原生 Agent Teams 共存。

0.4.1 新增：**输入框快捷等级选择器** —— 在文本对话框工具栏（模型 / 推理等级附近）显示紧凑的「本地 AI 介入程度」选择器，并提供一个开关控制是否显示（默认显示）。

- 当前版本：**0.4.1**
- 协议：Ollama 原生 `/api/chat`（可关思考、保活、控上下文）或任意 OpenAI 兼容端点
- 配置：**DSH GUI 可视化配置**（Plugins → 行 Configure，或 Settings → 本地模型），也继续支持 profile `cordis.patch.yml` 覆盖
- 安装与验证：**一键部署**（把你的智能体指向本仓库即可）见 [DEPLOY.md](DEPLOY.md)；手动/升级/回滚见 [INSTALL.md](INSTALL.md)

## 一键部署（交给你的智能体）

在 DSH 会话里直接粘贴（其他用户无需手工改 profile）：

```text
请帮我在这台机器上安装（或升级）DSH 插件 dsh-local-delegate（GitHub: MythGreenLand/dsh-local-delegate，最新 Release）。
1) 下载 Release 资产 dsh-local-delegate-v<版本>.zip（或 git clone --depth 1 --branch <tag> https://github.com/MythGreenLand/dsh-local-delegate）；
2) 解压到 %USERPROFILE%\.dsh\local-plugins\dsh-local-delegate-<版本>（macOS/Linux：~/.dsh/local-plugins/...）；
3) 已安装旧版本时先 plugin_manager action=remove_bundle target=dsh-local-delegate，再 plugin_manager action=install_bundle target=<解压后的插件目录>；
4) 刷新 GUI 后确认 Settings → 本地模型 出现「本地 AI 介入程度」「SlaveAgentTeams」卡片、输入框出现「本地 AI：默认 ▾」，并让 local_health 返回 v<版本>。
```

Windows 也可以先跑 `pwsh -NoProfile -File scripts\install-from-github.ps1 -Version latest`（macOS/Linux：`bash scripts/install-from-github.sh latest`）准备版本目录，再让智能体执行 `plugin_manager install_bundle`。详见 [DEPLOY.md](DEPLOY.md)。

## GUI 配置（0.3.0 新增；0.4.x 扩展）

安装后有两个入口，指向同一份配置：

1. **Plugins → Installed plugins → dsh-local-delegate → 行 Configure**（原生位置）；
2. **Settings → 本地模型**（侧边导航新增分区）。

页面卡片顺序：状态 → 端点 → 备用端点 → 委派限制 → Subagent 路由 → **本地 AI 介入程度** → **SlaveAgentTeams（多从节点并行）** → 节省统计 → 保存栏。

页面能力：

- 协议（Ollama 原生 / OpenAI 兼容）、服务器地址、模型（可拉取列表后下拉选择）、API Key / API Key 环境变量；
- 高级：`path`、`timeoutMs`、`temperature`、`maxOutputTokens`、`think`、`reasoningEffort`、`numCtx`、`keepAlive`、额外 headers（JSON）；
- 备用端点（fallbackEndpoints）增删改；
- 委派限制：`retries`、分块、并发、批量/内联上限、每分钟调用数等；
- **测试连接**（用表单里未保存的值探测，只允许回环/内网目标；公网需显式打开 `probeAllowPublic`）；
- **节省统计**：委派调用数、失败数、本地处理字符、本地 token、估算节省的主模型 token；0.4.0 起还展示 `local_worker` 与 slave 的启动/失败/完成计数及按节点统计（内存计数，插件重载清零）；
- **作为 Subagent / 模型选择器路由**：把当前端点注册为 `llm-pi-ai` 的 provider `local-delegate`，并写入 `subagent-model-selection-settings` 的 `allowedModels`。Subagent 策略在新建会话时采样，启用后请新开会话。
- **本地 AI 介入程度**：默认等级 + 工作区列表（来自 `GET /api/local-delegate/levels`）+ 高级项；「更高/最高」在缺少 `local-delegate` 路由时给出醒目警告；
- **SlaveAgentTeams**：开关、从节点列表编辑器（本地/云端、provider/model datalist、备注、增删、「用本地端点填充一个本地节点」）、默认节点、最大 slave 数、preset、失败回退、提示词开关。
- **输入框快捷等级选择器（0.4.1）**：在「本地 AI 介入程度」卡片里用「在输入框显示等级选择器」（`composerLevelPicker`）开关是否在文本对话框工具栏显示选择器。

保存行为：

- 保存写入 profile 的 `cordis.patch.yml` 中 `- id: local-delegate` 覆盖行，**数秒内热生效**，无需重启；
- 首次保存会生成**完整覆盖行**（未在 GUI 暴露的普通字段会按当前 raw 值钉住）；删除该行即回到 bundle 默认值；
- `apiKey` 会以明文写进 profile patch；更推荐用 `apiKeyEnv`（环境变量/DSH 凭据引用名）；
- `allowOutsideCwd` / `allowRoots` / `denyGlobs` 等安全策略**有意保留 YAML**，页面只读展示生效值；
- `workspaceLevels`、`slaveNodes`、`plannerDenyExtra`、`plannerAllowExtra` 等对象/数组字段**整值覆盖保存**（删除工作区覆盖 = 在 GUI 里选「跟随默认」；删除节点 = 点节点行「删除节点」）。

### 输入框快捷等级选择器（0.4.1 新增）

文本对话框（composer）工具栏左侧、模型与推理等级控件附近会出现一个紧凑的 **「本地 AI：默认 ▾」** 按钮（`conversation.input.left` 插槽）：

- 点击展开 5 个等级；当前会话已归属工作区时**修改该工作区的覆盖等级**（菜单含「跟随默认」用于删除覆盖），未归属工作区时修改**全局默认等级**并在菜单中明确提示；
- 选择后立即通过 config form 写回 profile `cordis.patch.yml`（与设置页同一保存链路），**新会话生效**（运行中会话需 `applyToLiveAgents: true`）；
- 触发按钮会显示当前生效等级；工作区覆盖值带 `*` 标记；节省空间、不占用模型选择器位置；
- 可在 **Settings → 本地模型 → 本地 AI 介入程度** 卡片里用「在输入框显示等级选择器」（`composerLevelPicker`，默认 `true`）关闭/重新开启；关闭后仅隐藏该控件，设置页仍可配置等级；
- `levelsEnabled: false` 时选择器自动隐藏；Host 未提供 Workspace 快照（老版本/非 Web）时退化为默认等级模式，不会报错。

## 本地 AI 介入程度（0.4.0 新增）

### 等级语义

| 等级 | 值 | 行为（root agent） |
|---|---|---|
| 无 | `none` | 本工作区禁用本地模型：scoped 拒绝 `local_transform` / `local_batch` / `local_health`（工具内部还有硬守卫），不注册 `local_worker`；主 agent 自己完成。 |
| 轻度 | `light` | 保留本地工具但只允许「明显机械/长文档」：文件模式 `stat.size ≥ lightMinChars`（默认 8000），批量非 dry-run 文件数 `≥ lightMinFiles`（默认 3）；内联 `text` 一律拒绝（提示改用 `path` 或自己做）；提示词走保守版；不注册 `local_worker`。 |
| 默认 | `default` | **不安装任何 scoped 层** —— 与 v0.3.0 行为 byte-for-byte 一致（安装的 scoped 内容为空，提示词/工具集合不变）。 |
| 更高 | `high` | 机械块优先交给本地模型（内联阈值降到 `highMinChars`，默认 2000）；root 额外注册 `local_worker`，可把一个完整任务交给本地 worker 子 agent。 |
| 最高 | `max` | 主 agent 只做**规划**（`todo_write`、Team 任务板等），所有实现/修改/命令交给 `local_worker`；scoped `tools.restrict` 拒绝已知执行类工具（`bash`、`pwsh`、`write`、`edit`、`workflow`、`ralph`、`subagent`、`local_transform`、`local_batch` 等）；Team 工具保留；`read/glob/grep` 是否可用由 `plannerAllowRead` 决定。 |

补充说明：

- **按工作区生效**：优先级为 workspaceRegistry 的 `sessionIds` 归属 → session header `cwd` 与工作区 canonical path 精确匹配（大小写、`/` 与 `\` 不敏感）→ 未匹配时用 `defaultLevel`。GUI 工作区列表显示 Host 返回的 canonical `path`；选择「跟随默认」会删除该工作区的覆盖。
- **生效时机**：默认对**新会话**生效（agent 创建时采样）；`applyToLiveAgents: true` 时设置变化会立即重装运行中 agent 的 scoped 层（可能损失一部分 prompt 缓存）。
- **`levelsEnabled: false`**：所有工作区按 `default` 处理（全局开关，便于临时关闭新行为）。
- **前提**：`high` / `max`（以及 `local_worker`）依赖 `llm-pi-ai` 中已存在 provider `local-delegate` —— 先点页面上的「启用为 Subagent 模型」，再新开会话。`workerRouteProvider` / `workerRouteModel` 可改用其他已注册的 LLM 路由。
- **诊断**：会话里执行 `/localpolicy`，输出配置摘要 + 每个 live agent 的 sessionId、root/child、Team 角色、工作区/标题、解析等级与来源、已安装的 scoped 内容（提示词覆盖、restrict deny 列表、`local_worker`、slave 工具数、节点数）与不匹配提示。

### L4（最高）的精确边界

- 拒绝列表 = 已知工具 ∩ `((执行类工具 ∪ 本地工具 ∪ plannerDenyExtra) − plannerAllowExtra − (plannerAllowRead ? read/glob/grep : ∅) − (Team 工具可用时保留 subagent))`；
- `run_code` **永不**出现在拒绝列表（PTC 模式下改为限制其绑定工具）；`local_health`（不生成 token 的探测工具）默认保留给 planner，用于在委派前确认 worker 路由；
- **未知/第三方工具默认放行**（兼容优先）；想收紧用 `plannerDenyExtra`，想豁免用 `plannerAllowExtra`；
- **L4 是「强约束近似」**：靠 scoped 提示词 + `tools.restrict`，不能 100% 阻止模型直接作答；需要严格隔离时请配合 `plannerAllowRead=false`、`plannerDenyExtra` 使用；
- **失败回退**：`plannerFallback: strong-worker`（默认）在本地 worker 启动/执行失败时改用 `workerPreset` + 默认强模型重试一次（在回执里标注 `fallback`，成本会上升）；`fail` 则把可操作错误返回给 planner；
- **worker 角色**（child / teammate）不套 planner 限制，也不暴露 `local_worker`（`workerMaxDepth` 默认 1，避免递归）；
- **与 Agent Teams**：Team Lead 仍按 planner 策略，但保留全部 team 工具；teammate 是 child，不受 planner 限制。**teammate 当前仍使用 Team 继承的强模型**（DSH rc.5 的 Team spawn 不带模型参数），只有 `local_worker` / slave 才是本地模型。

### 高级项（GUI「等级高级设置」折叠）

| 字段 | 默认 | 说明 |
|---|---|---|
| `workerProvider` | `spawn` | 启动 `local_worker` 的 subagent provider。 |
| `workerPreset` | `standard` | `local_worker` 子 agent 的 agent preset。 |
| `workerRouteProvider` | `local-delegate` | 本地 worker 的 LLM 路由 provider。 |
| `workerRouteModel` | `""` | 本地 worker 的路由模型；空 = 用 `endpoint.model`。 |
| `workerMaxDepth` | `1` | worker 子 agent 可再派生的深度（1–5）。 |
| `lightMinChars` | `8000` | 「轻度」文件模式的最低字符数。 |
| `lightMinFiles` | `3` | 「轻度」批量任务的最低文件数。 |
| `highMinChars` | `2000` | 「更高」内联文本可委派的最低字符数。 |
| `plannerAllowRead` | `true` | 「最高」是否保留 `read/glob/grep` 给 planner。 |
| `plannerFallback` | `strong-worker` | 本地 worker 失败时：`strong-worker`（强模型重试）/ `fail`（直接报错）。 |
| `plannerDenyExtra` | `[]` | 额外的 L4 禁用工具（逗号分隔 / YAML 数组）。 |
| `plannerAllowExtra` | `[]` | 从 L4 禁用列表中豁免的工具（逗号分隔 / YAML 数组）。 |
| `applyToLiveAgents` | `false` | 设置变化时立即重装运行中 agent。 |
| `composerLevelPicker` | `true` | 是否在输入框工具栏显示「本地 AI 介入程度」快捷选择器（0.4.1；只影响显示，不影响策略）。 |

## SlaveAgentTeams（多从节点并行，0.4.0 新增）

打开 `slaveTeamsEnabled` 后，**root / Team Lead agent** 会获得一组「从节点团队」工具：一次调用并行启动多个 slave 子 agent（每个都是独立的 continuable child session），每个 slave 跑在 `slaveNodes` 里指定的节点上（本地廉价模型或云端模型路由），由 master 等待/汇总结果。child agent 与 teammate **永远不装**这些工具（防止递归与权限扩散）。

### 从节点池

每个节点是一个 `{ name, kind, provider, model, note }`：

- `provider` / `model` 是 **LLM 路由**，必须能被 `ctx.get('llm').resolveCallConfig({ provider, model })` 解析，例如：
  - 本地：`local-delegate` / `gemma4:e2b`（由 v0.3 的「启用为 Subagent 模型」创建）；
  - 云端：`deepseek-account` / `deepseek-flash`、`intranet-gemma` / `gemma4:e2b` 等你已在 Models / llm 插件注册的路由。
- `kind: 'local' | 'cloud'` 只影响等级联动：等级 `none` 时**过滤掉所有 local 节点**；过滤后没有可用节点则不安装 slave 工具。
- `model` 留空 = 用 `endpoint.model`；隐式节点（`slaveNodes` 为空时）是 `local-delegate/<workerRouteModel 或 endpoint.model>`，model 为空则节点无效。
- 名字须唯一（重名保留第一个），节点顺序稳定；最多使用前 12 个。
- `slaveTeamDefaultNode` 指定默认节点；空 = **轮询**（round-robin）。单次 spawn 也可用 `default_node` / 每个任务的 `node` 覆盖。
- **深度**：`slaveTeamMaxDepth`（默认 1）沿用 tool-subagent 的 `maxDepth` 语义（当前按「子 agent 的派生深度」处理）；默认值下 slave 不会再派生 slave。若后续 DSH 版本语义变化，以实测为准。

### 5 个工具

| 工具 | 参数 | 返回 / 用途 |
|---|---|---|
| `slave_team_spawn` | `tasks: [{ name?, task, node? }]`（1..`slaveTeamMaxSlaves`）、`default_node?`、`preset?`、`max_depth?` | 快速依次启动 N 个 slave 子 agent（启动后立即并行运行），返回 `started: [{ name, child_id, node, provider, model, kind }]` 与 `failed: [{ name, node, error }]`；部分失败不中断其余任务。 |
| `slave_team_status` | `name?` | 查看该 master 已启动 slave 的状态（`running` / `settled` / `failed`）、stop_reason、耗时与 ≤800 字符输出预览。 |
| `slave_team_wait` | `names?`、`timeout_ms?`、`mode?: 'all'\|'any'` | 等待 slave 结果（默认 all、600s、clamp 1s..30min）；返回 settled/pending、`timed_out` 与有界输出预览；超时不是错误，可再次调用。 |
| `slave_team_send` | `name`、`message` | 给运行中的 slave 发消息（Team 模式下 `send_message` 被 team 工具 shadow，用这个 steer slave）。 |
| `slave_team_interrupt` | `name` | 中断一个 slave（fire-and-return；其 result 仍会 settle，通常 stop_reason 为 aborted）。 |

使用方式：主 agent 只需自然规划，例如「同时把这三个独立文件各自加注释」→ Agent 调用 `slave_team_spawn`（3 个 task，节点自动选择）→ `slave_team_wait` 汇总。安装 slave 工具时还会注入 scoped 提示词（可用 `slaveTeamPromptHelp: false` 关闭）与动态状态行，帮助模型正确使用。

### 与原生 Agent Teams 的兼容性

- **不注册任何与 team 工具同名的工具**（全部以 `slave_team_` 开头），不修改 `agentTeams` 服务、不改全局设置、不改其他插件；
- Team Lead 同时拿到 team 工具与 slave 工具：teammate 用 team 工具，slave 用 slave 工具；两类 roster 互不干扰（slave 不出现在 team 名单，teammate 不出现在 slave 名单）；
- slave 是**子 agent（child session）**：会出现在原生 `list_agents` 的 children 里（若该工具存在），但**不是** team teammate，不会被 `wait_agent` 等待；非 Team 模式下原生 `send_message(child_id)` 也能 steer slave；
- teammate 仍用强模型；本功能不把 teammate 切到本地模型；
- 若 profile 未启用 Agent Teams，本功能单独正常工作；`slaveTeamFallback: inherit`（默认）在节点路由失败时去掉 `agentOptions` 用父模型重试一次（成本上升），`fail` 直接给可操作错误（`SLAVE_ROUTE_UNAVAILABLE`）；
- 容量：DSH 每个 activation 树默认 `maxActiveSubagents=8`；`slaveTeamMaxSlaves` 默认 4、clamp 1..8，spawn 超限会返回可操作错误（`slaveTeamMaxSlaves` / `ACTIVATION_LIMIT_REACHED`）。

## 工具（Host 全局）

| 工具 | 用途 |
|---|---|
| `local_transform` | 单次变换。**优先 `path` 文件模式**：插件读取文件并写回，正文不进对话；`text` 只用于短片段（≤ `maxInlineChars`） |
| `local_batch` | 多文件批量。默认 **dry-run**（只返回计划），`dry_run: false` 才执行；输出到 `out_dir`（默认 `.local-out/`） |
| `local_health` | 探测整条端点链 + 返回配置与修复建议，不生成 token；状态行包含插件版本 |

0.4.0 起，`high` / `max` 等级的 root agent 还会在 scoped scope 内看到 `local_worker`（把整块任务交给本地 worker 子 agent）；打开 SlaveAgentTeams 时 root/Team Lead 额外看到 5 个 `slave_team_*` 工具。它们**不是全局工具**，只挂在对应用户的 agent scope 上，插件卸载/agent 销毁时自动清理。

文件模式默认输出路径：源文件名插入 `.local`（`README.md` → `README.local.md`）。工作目录之外的路径会在回执里显示绝对路径。

## 可用性机制（0.2.0 新增）

- **端点故障转移**：`endpoint` 主端点 + `fallbackEndpoints` 备用链；主端点不可达/报错时自动依次尝试，回执里标注 `(fallback)`。
- **有限重试**：`retries`（0–3，默认 1）只对传输类错误重试（连接失败、超时、5xx、429）；HTTP 4xx（模型不存在、鉴权错）直接换下一个端点。
- **启动自检**：插件加载后 1.5s 探活一次，成功/降级/失败各打一行带修复提示的日志；之后每 120s 刷新一次可用性。
- **运行上下文**：系统提示词里只有一行状态（`available` / `degraded` / `unavailable` + 修复指引），状态不变时不重复追加。
- **`/localdoctor` 命令**：一次性输出配置、端点链探测、路径策略、统计与**可执行的修复清单**。
- **配置自检**：`model` 为空、`baseURL` 非 http(s)、fallback 缺字段、等级/节点配置矛盾等会在加载时以 warning 日志提示，而不是等到第一次调用才报错。

## 配置参考

覆盖 profile `cordis.patch.yml` 中 `- id: local-delegate` 行的 `config`（整块替换，需写全想保留的字段；保存后 1–5 秒热生效）：

```yaml
- id: local-delegate
  name: "dsh-local-delegate"
  config:
    enabled: true
    retries: 1
    endpoint:
      kind: ollama-native            # ollama-native | openai-compatible
      baseURL: http://10.0.101.11:11434
      path: ""                       # 默认 /api/chat 或 /v1/chat/completions
      model: gemma4:e2b
      apiKey: ""                     # 明文密钥（GUI 也可填）；更推荐下面的 apiKeyEnv
      apiKeyEnv: ""                  # 环境变量 / DSH 凭据引用名，作为 apiKey 的替代
      headers: {}                    # 例：{ Authorization: "Bearer ollama" }
      numCtx: 32768                  # ollama-native
      keepAlive: 30m                 # ollama-native，避免反复冷加载
      think: false                   # 思考模型必须 false
      reasoningEffort: none          # openai-compatible 下发 reasoning_effort
      timeoutMs: 120000
      temperature: 0
      maxOutputTokens: 4096
    fallbackEndpoints:               # 主端点故障时按顺序尝试
      - kind: ollama-native
        baseURL: http://127.0.0.1:11434
        model: gemma4:26b
        timeoutMs: 240000
    modelsByTask: {}                 # 例：{ translate: gemma4:e2b, summarize: gemma4:26b }
    maxInlineChars: 8000             # text 模式上限；超过要求改用文件模式
    chunkChars: 4000                 # 每次模型请求的字符块上限
    maxConcurrency: 2                # 块级并发（1–8）
    maxSourceChars: 200000           # 单文件上限
    maxBatchFiles: 10                # 单次批量文件数上限
    maxBatchChars: 120000            # 单次批量总字符上限
    maxResultChars: 6000             # 内联模式回给主模型的正文上限
    maxCallsPerMinute: 40            # 本地请求限流
    probeAllowPublic: false          # GUI「测试连接」是否允许探测公网地址（默认只允许回环/内网）
    allowOutsideCwd: false           # true = 不限制路径（不推荐）
    allowRoots: []                   # 允许访问的额外根目录（绝对路径或相对 cwd）
    denyGlobs: ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/.credentials*", "**/secrets/**", "**/.git/**"]
    promptHelp: true                 # 关闭后不注入委派提示词（节省约 300 token/请求）
    warmupOnStart: true              # 启动探活 + 周期刷新

    # ── 本地 AI 介入程度（0.4.0） ─────────────────────────────
    levelsEnabled: true              # false = 所有工作区按 default（临时关闭新行为）
    defaultLevel: default            # none | light | default | high | max
    workspaceLevels: {}              # 工作区规范路径 -> 等级；GUI 用 registry 的 canonical path 写入
    # 例：
    # workspaceLevels:
    #   C:/Users/me/work/proj-a: high
    #   D:/work/legacy: none
    workerProvider: spawn            # 启动 local_worker 的 subagent provider
    workerPreset: standard           # local_worker 的 agent preset
    workerRouteProvider: local-delegate
    workerRouteModel: ""             # 空 = endpoint.model
    workerMaxDepth: 1                # 1–5
    lightMinChars: 8000              # L1 文件模式最低字符数
    lightMinFiles: 3                 # L1 批量最低文件数
    highMinChars: 2000               # L3 内联可委派最低字符数
    plannerAllowRead: true           # L4 是否保留 read/glob/grep
    plannerFallback: strong-worker   # strong-worker | fail
    plannerDenyExtra: []             # 例：[bash, write]
    plannerAllowExtra: []            # 例：[local_transform]
    applyToLiveAgents: false         # 设置变化时立即重装运行中的 agent
    composerLevelPicker: true        # 0.4.1：在输入框工具栏显示等级选择器（false = 隐藏）

    # ── SlaveAgentTeams（0.4.0） ──────────────────────────────
    slaveTeamsEnabled: false
    slaveNodes: []                   # 节点池；空 = 隐式本地节点（依赖 endpoint.model）
    # 例：
    # slaveNodes:
    #   - name: local
    #     kind: local
    #     provider: local-delegate
    #     model: gemma4:e2b
    #   - name: cloud
    #     kind: cloud
    #     provider: deepseek-account
    #     model: deepseek-flash
    #     note: "云端兜底"
    slaveTeamDefaultNode: ""         # 空 = 轮询
    slaveTeamProvider: spawn         # 启动 slave 的 subagent provider
    slaveTeamPreset: standard
    slaveTeamMaxSlaves: 4            # 1–8（单次 spawn 最多 slave 数）
    slaveTeamMaxDepth: 1             # 1–5；默认 slave 不能再派生 slave
    slaveTeamFallback: inherit       # inherit | fail（节点路由失败时）
    slaveTeamPromptHelp: true        # 注入 SlaveAgentTeams 使用指引
```

升级/回滚步骤、GUI 入口不出现等排障见 [INSTALL.md](INSTALL.md)。

## 使用方式

让主模型自然使用即可，插件已通过提示词说明何时该委派。典型请求：

- 「把 `docs/README.md` 翻成中文」→ Agent 调用 `local_transform(path=..., target_language=...)`
- 「把这 5 个 md 翻成中文」→ `local_batch` 先 dry-run，再 `dry_run:false`
- 「这个报错日志太长，总结一下」→ 文件模式 `summarize`
- 「看一下本地模型是否可用」→ `local_health`
- 「把这个工作区设成最高等级」→ 先在 GUI 设置等级；新会话里主 agent 只出计划，`local_worker` 执行（`/localpolicy` 可确认解析结果）
- 「在当前输入框直接把等级切到更高」→ 点输入框工具栏的「本地 AI：默认 ▾」选「更高」（0.4.1；可在设置页关闭该控件）
- 「同时给这三个独立文件补注释」→ 打开 SlaveAgentTeams 后，Agent 用 `slave_team_spawn` 并行派给 3 个 slave，再 `slave_team_wait` 汇总
- 人工诊断：`/localdoctor`；用量：`/localstats`；等级/策略现状：`/localpolicy`

## 安全

- **密钥拦截**：私钥块、AWS/GitHub/Slack token、`sk-…`、JWT、`password=…` 在请求发出前拒绝。
- **路径约束**：默认只能在会话工作目录（或 `allowRoots`）内读写；`.env`、密钥、`secrets/`、`.git/` 默认拒绝。
- **不静默重试**：本地失败返回可执行错误并提示「自己完成」，不会让 Agent 反复重试。
- **原子写入**：临时文件 + rename；输出先做非空校验。
- **等级/组队不放大权限**：等级与 slave 工具都只挂 root/Lead 的 scoped scope，不修改全局工具与设置；child/teammate 永不被套 planner 限制，也永不安装 slave 工具；本功能不放宽任何 sandbox/审批权限。
- 本地模型输出不可信：批量默认 dry-run，关键文件请主模型抽查。

## 成本模型

| 工作 | 主模型直接做 | 文件模式委派 |
|---|---|---|
| 翻译 10KB 文档 | ≈5,000 token | ≈200 token |
| 汇总 40KB 日志 | ≈10,600 token | ≈500 token |
| 20 个文件批量加注释 | ≈26,000 token | ≈700 token |
| 翻译一句话 | ≈200 token | 更贵 → 已在提示词里要求自己做 |

0.4.0 的等级进一步改变成本结构：

- `light`：只有长文档/批量才委派，短文本主模型自己处理，减少「为省 token 反而多花一次调用」；
- `high` / `max`：主模型只负责规划与验收，执行 token 落在本地模型上；但本地 5B 模型做多步修改不可靠，`plannerFallback: strong-worker`（默认）会在失败时用强模型重试，成本会上升——建议先在低风险、可验证的任务（加注释、格式转换、独立文件翻译）上试点；
- SlaveAgentTeams：N 个 slave 并行，主模型只花规划 + 汇总 token；slave 失败 `inherit` 回退同样会改用父模型（成本上升），可用 `fail` 让成本更可预测。

## 已知限制

- **L4 是强约束近似**：靠 scoped prompt + `tools.restrict`，无法 100% 阻止模型直接作答；未被 `tools.restrict` 覆盖的第三方工具默认放行（可用 `plannerDenyExtra` 收紧）。
- **本地小模型（如 5B）做多步修改不可靠**：默认 `plannerFallback: strong-worker` 保证完成但成本上升；建议先用可验证的小任务试点。
- **SlaveAgentTeams 的 slave 是子 agent，不是原生 team teammate**：不出现在 team roster、不参与 `wait_agent`，也不共享 team 任务板；与原生 Team 的「成员可互相消息/共享任务板」不同。
- **teammate 仍使用 Team 继承的强模型**：DSH rc.5 的 Team spawn 不传 model，本插件不改变这一点；需要本地 teammate 需上游支持或 Phase C 的 provider 包装（本版未做）。
- **等级默认对新会话生效**：`applyToLiveAgents` 打开后才会重装运行中的 agent，且可能导致 prompt 缓存失效。
- **scoped API 属于 DSH 0.2.1-rc.5 契约**：`agent/created`、`tools.restrict`、systemPrompt scoped、`startActivation`、`agentOptions` 等均来自 rc.5；DSH 升级需回归。
- **GUI 保存会生成完整覆盖行**（v0.3 已知限制），未暴露的普通字段按当前 raw 值钉住。
- **输入框选择器（0.4.1）依赖 Web GUI 的 `conversation.input.left` 插槽与 Workspace 快照**：老版本 Host 或非 Web 部署下不会显示；会话未归属工作区时按钮改为编辑全局默认等级（菜单内会提示），不影响设置页的按工作区配置。
- 统计是内存态（重载清零），不做持久化账本。
- 批量是同步执行，靠 `maxBatchChars/maxBatchFiles` 控制单次时长；超长任务请拆批。
- 翻译按块拼接，极端排版（表格/脚注）会被规整化。
- 直接翻原始 HTML 有破坏标签结构风险（实测 5.1B 会多写/漏写闭合标签）；请先抽取纯文本再翻译。
- 插件运行在 Host 进程内，路径/密钥策略是**策略约束**，不是操作系统沙箱。
