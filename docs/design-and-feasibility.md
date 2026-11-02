# 本地小模型委派插件（dsh-local-delegate）—— 可行性评估与实施方案

> 目标：让 Agent 在工作时**主动识别**「不需要强模型」的机械类操作（翻译、摘要、抽取、分类、改写、批量注释等），把其中的**繁重部分**交给内网 Ollama 上的 8B 级小模型，只把「指令 + 结果」留在主模型上下文里，从而显著降低 API token 消耗，同时不牺牲主模型的判断力。
>
> 评估基线：本机 DSH `0.2.1-rc.5`（desktop profile），主模型 `deepseek-account/deepseek-flash`。所有 API 结论均来自本机运行时的 `cordis_inspect_query`（Service / Event / Config）与随包 README，不是猜测。

---

## 0. 结论摘要（先看这段）

| 问题 | 结论 |
|---|---|
| 技术可行性 | **高**。约 60–70% 的能力 DSH 已经内置（pi-ai 自定义 OpenAI 兼容路由、subagent 模型选择、`llm/stream` 路由瀑布钩子、`defineTool` / `systemPrompt` / `ctx.jobs` 扩展点），只差一层「判断策略 + 文件级委派 + 预算/安全护栏 + 节省统计」。 |
| 经济性 | **值得做，但只在正确的场景**。机械文本任务（整文件翻译/摘要/抽取/批量注释）可省主模型 **85%–97%** 的 token；短文本（< ~800 token）委派反而更贵，必须设阈值。项目整体节省取决于任务构成，典型 **15%–40%**。 |
| 主要成本 | 一个 Host-only 插件，约 **700–900 行 JS**，≈1–1.5 天出 MVP；不改 DSH 源码、不重装、不过多依赖社区插件。 |
| 主要风险 | ① 8B 质量（必须保留降级）；② Ollama 默认上下文窗口只有 2k–4k（必须显式配置，并做分块）；③ 内网延迟；④ 误派（把需要推理的活派出去）——用「提示词规则 + 代码护栏 + 主模型复核」三重控制。 |
| 建议路径 | ✅ 已按此完成：**Phase 0/1 配置接入** → **Phase 2 MVP 插件**（`plugins/dsh-local-delegate/`，已安装并端到端验收）。Phase 3/4/5 为可选增强。 |

### 0.1 实测记录（2026-11-03，本轮会话已验证，不是估算）

| 项目 | 本机 | 内网服务器 `<ollama-host>` |
|---|---|---|
| Ollama | 0.33.1（AMD AI Bundle），`127.0.0.1:11434` | **0.40.13**，`:11434` 从 DSH 宿主机可达（65ms） |
| 模型 | `gemma4:26b`（Q4_K_M，25.2B，19GB，ctx 262144） | **`gemma4:e2b`（Q4_K_M，5.1B，7.2GB，ctx 131072）** |
| 能力 | completion/vision/tools/thinking | completion/vision/**audio**/tools/thinking |
| 暖机吞吐 | ≈10.6 tok/s | **≈47.8 tok/s**（实测 96 输出 token / 2.2s） |
| 冷加载 | 93s | 40s（首次） |
| 原生 `/api/chat` + `think:false` | 1.03s 返回正确中文 | 正确（短句“构建成功。”；长句翻译质量良好） |
| OpenAI `/v1/chat/completions` 默认 | content 为空（120 token 全给思考） | content 为空（reasoning 字段有 332 字符思考） |
| `/v1` + `reasoning_effort: "none"` | — | **可用**：132ms 返回“构建成功。”，4 token；流式 SSE、`stream_options.include_usage`、`tools` 调用均正常 |
| 结论 | 可作备用/高质量通道 | **主通道**：快、免费、协议兼容良好；已写入 DSH 路由（见 §1.1） |

---

## 1. 现状核查：DSH 已经给了什么，还缺什么

以下全部在本机 live 树中确认过。

### 1.1 模型通道：Ollama 可以「零代码」接入

- `llm` 服务是 provider 中立层（`registerAdapter` / `stream`），`@deepseek-ai/dsh-llm-pi-ai`（**已挂载**，`llm-pi-ai` 行）是通用的多协议适配器：支持 `openai-completions`、`openai-responses`、`anthropic-messages` 三种协议、自定义 `baseURL`、自定义 `models` 清单、`compat` 兼容开关。
- Models 设置页（`dsh-client-ui-settings-models`，**已挂载**）提供 **Add model provider → Custom model API**：填 Provider ID、端点、协议、至少一个模型，即写入 `llm-pi-ai` 命名空间，**无需重启**。
- 已知限制（官方 README）：无鉴权的 OpenAI 兼容本地服务需要一个**占位 key**（`apiKeyEnv` 引用）或 `headers.Authorization`。Ollama 用 `Authorization: Bearer ollama` 即可。
- 模型发现：`openai-completions` 走 `GET {baseURL}/models`，Ollama 的 `/v1/models` 支持，因此「发现模型」按钮可用。

**结论**：把内网 Ollama 变成 DSH 里可选路由（`ollama-local/qwen3:8b`），是**纯配置**，不需要写插件。

**已落地（2026-11-03）**：在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 增加了两行（原文件已备份到 `workspace/.tmp/cordis.patch.yml.bak`）：

1. `llm-pi-ai` 路由 `intranet-gemma`：`api: openai-completions`、`baseURL: http://<ollama-host>:11434/v1`、`headers.Authorization: Bearer ollama`（占位）、模型 `gemma4:e2b`（ctx 131072，maxTokens 8192，`input: [text, image]`、`compat.supportsReasoningEffort: true`、`reasoningEfforts: {off: none, low: low, medium: medium, high: high}`）。
2. `subagent-model-selection-settings`：`enabled: true`，`allowedModels: [{provider: intranet-gemma, model: gemma4:e2b}]`（Tier 2 前置；新会话生效）。

YAML 与 `llm-pi-ai` 的 live Config schema 已核对通过；DSH 的 HMR 会监视 profile patch 并热应用（无效编辑会被拒绝、保留运行中配置，不会 boot 失败）。**仍需在 GUI 侧确认**：Settings → Models 出现「内网 Gemma4 (<ollama-host>)」行、composer 模型选择器出现 `intranet-gemma/gemma4:e2b`；若未出现，重启一次桌面端（冷加载配置）。

### 1.2 委派：内置 subagent 已支持「由模型选择子 agent 用哪个模型」

- `subagent` 服务的 `SubagentProvider` 契约含 `agentRouteDefaults`；`spawn`（进程内）provider 宣称 `agentOptions` 能力。
- 标准预设 `preset-standard` 的 `subagent` 工具配置里 **已经打开** `modelSelectionSettings: true`（见 `dsh-web-app/presets/standard.patch.yml`）。
- 开关在 Host 设置命名空间 `subagent-model-selection`（`enabled` + `allowedModels: [{provider, model}]`），由 `dsh-tool-subagent/model-selection-settings` 行提供；打开后：
  - `subagent` 工具 schema 增加 `provider` / `model` / `reasoning_effort` 三个参数；
  - 同时注册 `list_subagent_models` 工具用于发现允许的 route；
  - 策略在**新的顶层会话**组合时采样一次，并记录进会话、被所有子会话继承（改配置对老会话不生效）。
- 设置界面：官方 `dsh-client-ui-settings-subagent` 页（Settings → Plugins → Subagent）随 web-app bundle 声明；本 profile 的 live 树里该行当前状态为 `absent`（未激活），**需要在实现阶段实测确认该页是否渲染**；若不可用，插件可直接把配置写进 `cordis.patch.yml`（`subagent-model-selection-settings` 行），效果等价。

### 1.3 自动路由：官方钩子存在

- 事件 `llm/stream`：`waterfall`，描述就是「Waterfall around every streaming model call (retry, replay, routing)」——**这正是做「按请求类型改道」的官方入口**。
- `GenerateOptions.purpose?: 'compaction' | 'session-title'` —— 可以精确识别「会话标题」「上下文压缩」这两类**不需要强模型**的辅助请求，与用户诉求高度契合。
- 另有 `agent/request` waterfall（可改主循环模型的 call config），但**不建议**用来做「按难度动态换主模型」，理由见 §6。

### 1.4 插件扩展点（已确认签名）

| 能力 | 服务/API | 用途 |
|---|---|---|
| 注册模型工具 | `ctx.tools.register(defineTool({...}))`（`@deepseek-ai/dsh-tools`） | `local_transform` / `local_batch` |
| 加系统提示词 | `ctx.systemPrompt.section({name, order, text})` / `ctx.systemPrompt.context({...})` | 委派策略 + 本地模型实时可用性 |
| 调模型 | `ctx.llm.stream({provider, model, messages, ...})` / `prepareCall` | 本地模型单次调用（流式，带 usage） |
| 子 agent | `ctx.subagents.startActivation(...)` | 可选的本地子 agent 档 |
| 后台任务 | `ctx.jobs` | 大批量文件处理不阻塞工具调用 |
| 持久统计 | `ctx.storage` / `ctx.storageDomain` | 节省统计 |
| 人类命令 | `ctx.commands.register(...)` | `/localstats` |
| 打包安装 | workspace 里写 bundle（`package.json` + `cordis.patch.yml`），`plugin_manager` `install_bundle` 安装 | 交付形态 |

### 1.5 真正的缺口（= 插件要补的东西）

1. **没有「文件级」委派**：内置 `subagent`/`workflow` 委派是「整段任务文本」进上下文。把 2.5k token 的文档写进工具参数，主模型要先**输出**这 2.5k token（输出比输入更贵），省不了多少，甚至更贵。
2. **没有「该不该委派」的可执行策略**：只有工具描述，没有阈值、没有反例清单、没有预算控制、没有失败降级规则。
3. **没有安全护栏**：不会拦截 API key / 密码 / 用户隐私外发到内网模型，没有路径白名单、大小上限、并发/超时/熔断。
4. **没有节省度量**：无法回答「这个插件到底省了多少」。
5. **没有把「会话标题/压缩」这类天然低价值请求自动切走**的现成实现。

---

## 2. 关键洞察：省 token 的正确姿势是「传路径，不传正文」

工具调用的**参数**和**结果**都会进入主模型上下文并计费。所以：

- ❌ `local_llm(task="translate", text="<10KB 文档>")` → 主模型先输出 10KB 参数（≈2.5k token 输出），本地模型再翻译。**几乎不省，甚至更贵**。
- ✅ `local_transform(task="translate", source={file:"docs/README.md"}, target={file:"docs/README.zh.md"})` → 主模型只输出 ~120 token 的调用；插件自己读文件、分块、调本地模型、写回、返回 ≤200 token 的摘要。**省 95%+**。

这就是插件最核心的设计约束：**所有面向文件的工具都必须支持 `file` 模式，并且默认推荐 `file` 模式**；`inline` 模式只服务小段文本（< 8KB），且工具返回值只回摘要 + 句柄，不回全文。

### 估算对比（数量级参考，非账单预测）

| 场景 | 主模型直接做（token） | 本地委派·文件模式（token） | 主模型节省 |
|---|---|---|---|
| 翻译 10KB 文档（≈2.5k tok） | 输入 2.5k + 输出 2.5k ≈ **5k** | 调用 0.12k + 摘要 0.15k ≈ **0.27k** | **≈95%** |
| 汇总 40KB 构建日志（≈10k tok） | 输入 10k + 输出 0.6k ≈ **10.6k** | 0.2k + 0.3k ≈ **0.5k** | **≈95%** |
| 20 个文件批量加 docstring | 20×(0.8k+0.5k) ≈ **26k** | 一次调用 0.3k + 汇总 0.4k ≈ **0.7k** | **≈97%** |
| 短句翻译（< 200 tok） | ≈ **0.2k** | 工具 schema+调用+结果 ≈ **0.25k** | **负数，不划算** |
| 会话标题（每会话 1 次） | 0.3k–1k | ≈ **0.01k**（主模型零调用） | **100%** |

→ 阈值规则：**内容 < ~800 token 的机械任务不要委派**；而「整个文件 / 批量文件 / 超长日志」是这类插件的主要收益来源。

---

## 3. 方案设计

### 3.1 三层委派（由浅入深，可独立启用）

```
Tier 0  纯配置      Ollama → llm-pi-ai 自定义路由        （0 代码，30 分钟）
Tier 1  插件工具    local_transform / local_batch         （核心，MVP）
Tier 2  子 agent    内置 subagent + 本地模型路由           （多步机械活，需人工复核）
Tier 3  自动路由    llm/stream 把「会话标题/压缩」切到本地 （零判断、全自动，可选）
```

- **Tier 0**：模型出现在 DSH 模型选择器里，也能被 `subagent` / `workflow` 显式指定。这是所有上层能力的前提。
- **Tier 1（核心）**：主模型仍负责全部判断与工具使用，只把「纯文本变换」外包。**这是最安全、最省 token、对 8B 最友好的形态**。工具内部自行读文件、分块、限流、校验、写回、统计。
- **Tier 2**：适合「多文件、多步骤但机械」的活（例如：给 `src/` 下每个导出函数补 JSDoc、把 `docs/` 全部翻成中文、批量重命名）。让本地模型带最小工具集跑子 agent；**子 agent 的产物必须由主模型复核**，且默认禁止写操作或只允许写 `docs/`（可配置）。
- **Tier 3**：不需要任何「判断」——会话标题、上下文压缩本来就与主任务质量无关，直接改道。默认只开「会话标题」，压缩默认关闭（8B 摘要质量会影响长会话后续表现）。

### 3.2 「主动识别并判断」怎么落地：不靠玄学，靠三件确定的东西

1. **可执行的正/反例清单**（写进系统提示词，约 120 token）：
   - 该派：翻译、摘要、字段抽取、分类打标、风格改写、docstring/注释生成、commit message、命名候选；**且**内容较大（> ~800 token）或涉及整文件/批量文件；**且**主模型不需要理解正文、只需拿到结果。
   - 不该派：需要读代码语义才能做的修改、调试与根因分析、架构/方案决策、最终给用户的结论、任何含密钥/密码/私人数据的内容、**一次失败后不重试**（自己接管）。
   - 为什么不用「单独的小分类器模型」：多一次调用、多一次延迟、多一个故障点，而且分类本身不可靠——主模型自己判断更准，成本只是几十个 token 的规则。
2. **工具描述本身承担决策引导**（遵循 DSH 的 `agent-experience` 规范：只写行为、不写实现；参数规则写在参数上；同一事实只说一次）。
3. **代码侧硬护栏**（不依赖模型自觉）：
   - 内容/文件大小上限、超时、并发上限、每轮委派次数预算（默认 8 次/轮，防打转）；
   - 密钥/隐私正则拦截（`sk-...`、`AKIA...`、`-----BEGIN ... PRIVATE KEY-----`、`.env`/`credentials`/`*.pem`/`*.key` 路径）→ 直接拒绝并提示「请自行处理或先脱敏」；
   - 路径白名单（默认只允许当前工作目录下），禁止读 `/etc`、家目录密钥等；
   - 「只尝试一次」：本地失败/超时 → 返回明确错误 + 「请自行完成」，主模型自然降级，绝不反复重试烧时间；
   - 熔断：连续 N 次失败后 5 分钟内不再调用本地模型，并在运行时上下文中提示「本地模型暂不可用」。

### 3.3 工具设计（MVP 就这两个）

**`local_transform`** —— 单次/少量文本变换
- 参数（参数规则写在参数描述里）：
  - `task`：枚举 `translate | summarize | extract | classify | rewrite | docstrings | commit_message | names`
  - `source`：`{ kind: "file", path }`（**推荐**）或 `{ kind: "inline", text }`（≤ 8KB，超出报错并提示改用 file）
  - `target`（可选）：`{ kind: "file", path }`（写回/另存）或 `{ kind: "return" }`（仅返回结果，≤ 4KB，超出写临时文件并回路径）
  - `target_language` / `instructions` / `max_output_tokens`
- 行为：读 → 按段落分块（**按实测吞吐定块大小**：默认每块目标 ≈600–800 输出 token，约 60–90 秒；可配）→ 顺序或受限并发调用本地模型 → 拼接 → 写目标文件 → 返回 `{ output_path?, chars_in, chars_out, chunks, local_tokens, duration_ms, preview_chars }`（**绝不回全文**）。
  - 总输出超过单次工具时间预算（默认 120s）时，**自动转为后台 job**，立即返回 `job_id`，结果从 `job_output` 取；避免工具超时把主 agent 卡住。
  - 调本地模型走 **Ollama 原生 `/api/chat`**（插件自带轻量客户端），而不是 OpenAI 兼容层：这样可以显式 `think:false`（避免思考 token 把 `max_tokens` 吃光、返回空内容——实测已复现）、`options.num_ctx`、`num_predict`、`keep_alive`（保持暖机），且本地无鉴权、无需占位 key。
- 失败：`{ error, code, fallback: "handle_directly" }`，不重试。

**`local_batch`** —— 批量文件
- 参数：`task`、`paths: string[]`（或 `glob` + `cwd`）、`target_dir?`（默认原地/另存目录）、`instructions?`、`dry_run?`（默认 true，先出计划与试译 1 个，确认后再写）。
- 行为：后台 job（`ctx.jobs`）执行，立即返回 `job_id`；进度/失败清单从 `job_output` 读取；结束回 `{ processed, failed: [{path, reason}], written: [...] }`。
- 失败隔离：单文件失败不影响其他文件；任何写失败不覆盖原文件（临时文件 + 原子替换）。

**`local_health`**（可选小工具）：返回本地模型可用性、模型名、最近一次延迟、剩余预算。也可以只放在 runtime context 里，不占工具位。

#### 3.3.1 端点必须全可配（用户明确要求：地址 / 协议 / 模型都是配置项）

插件不自带任何硬编码端点，全部来自 `Config`（也是设置页/`cordis.patch.yml` 的同一份 schema）：

```yaml
endpoint:
  kind: ollama-native          # ollama-native（默认，支持 think/keep_alive/num_ctx）| openai-compatible
  baseURL: http://<ollama-host>:11434
  path: /api/chat              # openai-compatible 时为 /v1/chat/completions（或任意网关路径）
  model: gemma4:e2b
  apiKey: ''                   # 可选：OpenAI 兼容网关的 key（本地 Ollama 留空）
  headers: {}                  # 可选：Authorization 等自定义头
  numCtx: 32768                # ollama-native：请求上下文
  keepAlive: 30m               # ollama-native：暖机保持时间
  think: false                 # ollama-native：思考开关（本类模型必须 false）
  timeoutMs: 120000
modelsByTask:                  # 可选：不同任务用不同模型（例如 translate 用 8B，summarize 用 26B）
  translate: gemma4:e2b
  summarize: gemma4:26b
fallbackEndpoints: []          # 可选：主端点失败时的备用端点（同结构）
```

这样后续换机器、换模型、走 LM Studio / llama.cpp / vLLM / 任何 OpenAI 兼容内网网关，都只改配置，不改代码。

### 3.4 提示词与上下文

- 系统提示词 section（固定、前缀稳定，≈120 token）：上面的正/反例清单 + 「优先 file 模式」+ 「失败就自己来」。
- 运行时 context（仅在变化时追加）：`local model ollama-local/qwen3:8b: available (p50 1.8s), budget 8 this turn`；不可用时提示直接自己做。
- 顺序：插件 Config 里的 `order` 可配，默认排在工具 guidance 之后（`getSectionOrder` 不可用时用固定值，见实现阶段核对）。

### 3.5 节省统计（回答「到底省了多少」）

- 每次本地调用记录：`chars_in/out`、本地模型 usage token、耗时、任务类型、是否降级。
- 估算主模型等价 token：按「若由主模型完成需要的输入+输出」近似（内容 token + 产出 token），实现上用字符数/4 或 `tokenMeter.estimateMessage` 估算；**只展示「估算」字样，不承诺金额**。
- `/localstats` 命令输出：本会话/今日/累计的本地调用数、本地处理 token、估算主模型等价 token、降级次数、按任务类型分布。
- 后续（Phase 5）可做一个小设置页卡片展示同一数据；MVP 先命令行。

### 3.6 安全与合规

- 内网 Ollama 虽然不出网，但仍按「外部模型」对待：默认不发送含密钥/隐私的内容；路径白名单；日志只记路径与统计，不记正文。
- 工具执行走 DSH 现有 sandbox/fs 服务，不绕过权限策略；写操作沿用现有 `fs` 写入与版本校验。
- 本地模型输出**不可信**：写回文件前做基本校验（非空、长度在预期范围、可解码），批量模式默认 `dry_run` 先行；关键文件不自动覆盖（可选备份 `.bak`）。

---

## 4. 分期实施计划（每期都有验收标准）

### Phase 0 连通性验证（**已完成**）
- ✅ 本机 Ollama：0.33.1，`gemma4:26b`，暖机 10.6 tok/s，冷启动 93s。
- ✅ 内网 Ollama **<ollama-host>:11434**：0.40.13，`gemma4:e2b`（5.1B / 7.2GB / ctx 131072 / 支持 tools+thinking），暖机 **47.8 tok/s**，冷加载 40s；原生 `/api/chat + think:false`、`/v1` + `reasoning_effort:"none"`、流式 SSE、`stream_options.include_usage`、tools 调用**全部实测通过**。
- ✅ 服务端设置：上下文 131072（足够，无需额外 `num_ctx` 调整；插件仍会显式下发）；建议把 `OLLAMA_KEEP_ALIVE` 设为 30m 避免反复冷加载。
- 结论：主通道定为内网 `gemma4:e2b`，本机 `gemma4:26b` 作为备用/高质量通道。

### Phase 1 纯配置接入（**已写入，待 GUI 确认**）
- ✅ 已写入 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`：
  - `llm-pi-ai` 路由 `intranet-gemma`（`openai-completions` + `http://<ollama-host>:11434/v1` + 占位 `Authorization: Bearer ollama` + 模型 `gemma4:e2b` + `reasoningEfforts` 全档位 + `compat.supportsReasoningEffort: true`）；
  - `subagent-model-selection-settings`：`enabled: true`，允许 `intranet-gemma/gemma4:e2b`。
- ✅ YAML 解析 + `llm-pi-ai` live Config schema 校验通过；备份 `workspace/.tmp/cordis.patch.yml.bak`。
- ⏳ GUI 确认：Settings → Models 出现「内网 Gemma4 (<ollama-host>)」，composer 模型列表出现 `intranet-gemma/gemma4:e2b`；新建会话后 `subagent` 工具应出现 `provider`/`model` 参数与 `list_subagent_models`。若看不到，重启桌面端一次。
- ⚠️ 思考模型注意：`gemma4:e2b` 声明了 thinking。pi-ai 路由侧已用 `reasoning_efforts` + `compat` 兜底；若 Tier 2 子 agent 出现空回复，说明 pi-ai 对 `off` 档位选择了「省略字段」，改为在插件侧走原生 `/api/chat + think:false`（Tier 1 已如此）。

> 说明：Phase 1 对 **Tier 2（本地子 agent）是必需前置**；对 **Tier 1（插件工具）可选**——插件自带原生 Ollama 客户端，不依赖 pi-ai 路由也能工作。Phase 1 也能通过 `workflow` / `subagent` 显式指定本地模型，但「整段文本进参数」收益有限——真正的收益在 Phase 2。

### Phase 2 MVP 插件 `dsh-local-delegate` ✅ **已交付并验收（2026-11-03）**

交付物（Host-only bundle，无需构建工具；已通过 `plugin_manager install_bundle` 安装，`fiberPhase: active`）：

```
plugins/dsh-local-delegate/
  package.json          # dsh.bundle.patch + exports(locale/icon)
  cordis.patch.yml      # insert 一行 host 插件（默认指向内网 gemma4:e2b）
  index.js              # apply(): Config、3 个工具、prompt section、runtime context、/localstats
  lib/endpoint.js       # 双客户端：原生 Ollama(/api/chat) + OpenAI 兼容(/v1/chat/completions)、超时、usage 归一
  lib/chunker.js        # 段落/句子感知分块 + 多段摘要 reduce
  lib/guard.js          # 密钥正则、路径包含、denyGlobs、原子写入
  lib/stats.js          # 计数与「主模型等价 token」估算
  locale/zh.json, locale/en.json, icon.svg, README.md
```

实际实现与初版设计的差异（更保守、可验证）：

| 设计稿 | 落地 |
|---|---|
| `provider`/`model` 两个字段 | 统一为 `endpoint { kind, baseURL, path, model, apiKey, headers, numCtx, keepAlive, think, reasoningEffort, timeoutMs, temperature, maxOutputTokens }` + `modelsByTask`（用户要求的通用可配置） |
| `perTurnBudget` | 改为 `maxCallsPerMinute` 滑动窗口限流（不依赖会话事件，MVP 更稳） |
| 后台 job 批量 | MVP 用 `maxBatchFiles` + `maxBatchChars` 上限 + 顺序处理（不引入 jobs 依赖） |
| 熔断 | 「一次失败即返回可执行错误 + 提示自行完成」；健康探测每 120s 更新可用性上下文 |
| `/localstats` | 已注册；统计为内存态（reload 清零，README 已注明） |

**验收记录（全部实测通过）**：

| 项目 | 结果 |
|---|---|
| 安装 | `application: applied`，bundle `dsh-local-delegate 0.1.0`，plugin row `enabled=true / fiberPhase=active`，无 warnings |
| Config schema | `Config.listConfigs` → `include:local-delegate` status `schema`，全部字段/默认值正确投影 |
| `local_health` | `available`，模型 advertised，probe 17ms |
| 文件翻译（975 字符 md） | 1 chunk，975 → 355 字符，465 local tokens，7.0s；输出 `en-doc.local.md`，Markdown 标题/列表/编号完整保留 |
| 内联翻译 | 286ms，「构建成功。所有测试通过。」 |
| 分类 | 178ms，输出 `bug report` |
| 多块摘要（6608 字符 → 2 chunks + reduce） | 18.0s，输出 348 字符中文摘要，覆盖全部要点 |
| 批量 dry-run → execute | dry run 返回计划；`dry_run:false` 处理 2 文件 0 失败，写入 `.local-out/` |
| 密钥拦截 | `LOCAL_SECRET_REFUSED`（sk- token 文件被拒，未发出请求） |
| 路径越界 | `LOCAL_PATH_OUTSIDE_WORKSPACE`（`C:\Windows\win.ini` 被拒） |
| 热开关（用户路径） | 在 profile patch 增加 `local-delegate` 行覆盖 `enabled:false` → 5s 内工具被摘除、prompt section 消失；删除该行后恢复 |
| 分块/glob/密钥/统计单测 | `.tmp/test-libs.mjs` 全部通过（含 9 项 glob/密钥用例、端到端 native/openai 两种协议调用） |

> 说明：`enabled:false` 时运行时上下文与工具会立即摘除（已实测），是给用户的一键回滚开关。

**0.2.1 可用性增强（2026-11-03，安装/使用流程完善）**

- 端点链故障转移 `fallbackEndpoints` + 传输错误有限重试 `retries`（4xx 直接换端点，不空转）。
- 启动自检：加载后 1.5s 探活一次，按 available/degraded/unavailable 打带修复提示的日志；之后每 120s 刷新。
- 运行时上下文按状态提示：主端点故障时改为「已降级到 fallback ... 可用」。
- `local_health` 升级为「配置 + 端点链探测 + 修复建议」，状态行带插件版本。
- 新增 `/localdoctor` 人工诊断命令：配置、端点链、路径策略、统计、可执行修复清单。
- 新增 `allowRoots`：工作目录之外的额外根目录白名单，越界错误直接给出「切工作目录或加 allowRoots」指引。
- 安装/升级脚本：`scripts/verify-endpoint.mjs`（安装前自检：可达/模型存在/能生成）、`scripts/sync-install.ps1`（语法检查 + 按版本目录同步，升级免重启）。
- 安装位置改为按版本目录 `%USERPROFILE%\.dsh\local-plugins\dsh-local-delegate-<version>`：版本变化即换目录，模块 URL 变化使 **DSH 免重启加载新代码**（实测 0.2.0→0.2.1 热生效）。
- 本轮验证：mock-context 29 项全通过；热切换主端点→备用端点成功且回执标注 `(fallback)`；`allowRoots` 绝对路径成功；越界错误含 allowRoots 指引；升级后 `local_health` 显示 `v0.2.1`。

### Phase 3 本地子 agent 档（约 0.5 天，零代码为主）
1. Host 设置 `subagent-model-selection`：`enabled: true`，`allowedModels: [{provider: ollama-local, model: qwen3:8b}]`（GUI 不可用时写进 profile patch）。
2. **必须新开会话**（策略在会话组合时采样）。
3. 提示词里加一条：多文件/多步骤机械活优先 `subagent` + `provider/model` 指定本地模型，任务里写明「逐文件处理，禁止删除/重命名，完成后列清单」。
4. 验收：`list_subagent_models` 能看到本地 route；一次「给 5 个文件补文件头注释」的子任务由本地模型完成，主模型复核 diff；子会话头部显示本地模型。
5. 安全：默认不建议给本地子 agent 开写权限；若要写，限制目标目录并在提示词要求「先 dry-run 列计划」。

### Phase 4 自动路由（约 0.5 天）
1. 监听 `llm/stream` waterfall，仅当 `options.purpose === 'session-title'`（可选 `'compaction'`）且本地可用时，换 `provider/model` 转发，失败 `next()` 兜底。
2. 记录节省，加入 `/localstats`。
3. 验收：新会话标题由本地模型生成（日志/统计可见），主模型调用数减少；本地不可用时标题仍正常生成。
4. 压缩路由默认关闭并在 README 标注风险（8B 摘要质量影响长会话）。

### Phase 5 可选增强（按需）
- 设置页卡片：在 `settings.plugins.tab` 或 `plugins.bundle.config` slot 展示节省面板（Client 半分，需 UI 规范）；
- 「超大工具结果本地摘要」（`tools/post-execute`）：对超过阈值的工具结果先用本地模型摘要再入上下文（风险较高，默认关闭，作为实验开关）；
- 支持多本地模型（按任务类型路由到不同模型/不同 Ollama 实例）。

---

## 5. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 8B 质量不够（长句、专业术语、代码） | 输出不可用 | 任务白名单 + 输出长度/非空校验 + 失败一次即降级 + 批量默认 dry-run + 主模型复核 |
| Ollama 默认上下文 2k–4k | 长文档被静默截断 | 服务端设 `OLLAMA_CONTEXT_LENGTH` 或用 Modelfile 固定 `num_ctx`；插件侧始终分块（不依赖超大上下文） |
| 思考模型经 `/v1` 只返回空内容 | 子 agent 拿到空回复 | 原生 `/api/chat` + `think:false`（Tier 1 已内置）；pi-ai 路由条目声明 `reasoningEfforts: false`（Tier 2） |
| 冷启动慢（26B 实测 93s；8B 视显存可能 10–40s） | 首次调用超时 | 启动/首轮做一次 `keep_alive` 预热；首调用超时放宽（180s）；之后走暖机通道 |
| 延迟高（本机 26B 实测 ≈10.6 tok/s） | 工具超时、Agent 空转 | 单块目标 ≤800 输出 token（≈75s）；总时长超 120s 自动转后台 job；并发 ≤2 |
| 内网连通/防火墙 | 功能整体不可用 | Phase 0 先验证；熔断 + runtime context 提示；一键关闭（Config `enabled:false` 立即摘除全部贡献） |
| 内容外发合规 | 数据风险 | 只发内网；密钥/敏感路径正则拦截；路径白名单；日志不记正文 |
| 误派（把该自己做的活派出去） | 质量下降、返工 | 提示词正/反例 + 阈值 + 每轮预算 + 「一次失败即接管」；主模型保留最终解释权 |
| 省略 `/localstats` 导致无法评估 | 无法证明收益 | MVP 必须带统计；验收时做 A/B 对照 |
| DSH 升级导致 API 漂移 | 插件失效 | 只用稳定服务（tools/systemPrompt/llm/jobs/storage），peerDependencies 按 0.2.x 范围声明；升级后跑验收清单 |
| 插件与现有社区插件冲突（如 dsh-our-free-model 也接 Ollama） | route 重名 | 路由 ID 用独立前缀（`ollama-local`）；若用户已在 our-free-model 配过，复用其 route 即可，不重复注册 |

---

## 6. 明确不做（非目标）

1. **不按「难度」动态切换主模型**（`agent/request` 改主循环模型）。理由：主 agent 的推理连续性、KV cache 前缀稳定性、工具调用一致性都会被破坏；判断错了代价远大于省下的 token。主模型始终是强模型。
2. **不让本地模型执行 bash/edit/删除**（除非 Phase 3 显式配置 + 人工复核）。8B 的工具调用可靠性不足以承担破坏性操作。
3. **不写新的 session 事件类型**（DSH 不允许自定义 type 的可恢复写入；用既有事件 + 插件内状态 + 存储服务）。
4. **不承诺具体金额**，只报 token 与估算等价 token（价格随供应商变动）。
5. **不把「判断」外包给分类器模型**：多一次调用/延迟/故障点，效果还不如主模型按规则自判。

---

## 7. 当前状态与可选下一步

1. **已完成**：Phase 0（连通性）、Phase 1（pi-ai 路由 + subagent 模型选择）、Phase 2（MVP 插件交付并验收）。主通道为内网 `<ollama-host>:11434` + `gemma4:e2b`，本机 `gemma4:26b` 可作备用。
2. **插件开关与配置入口**：在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 中覆盖 `- id: local-delegate` 行的 `config`（同 id 后写覆盖前写），改完 1–5s 内热生效；`enabled:false` 一键摘除全部工具与提示词。插件目录：`plugins/dsh-local-delegate/`，README 有完整字段表。
3. **可选下一步**：
   - a) 在真实项目里用一轮（让 Agent 翻译/摘要整文件），结束后运行 `/localstats` 看节省估算；
   - b) Phase 4：把「会话标题/压缩」自动路由到本地模型（零判断、全自动）；
   - c) Phase 5：设置页面板展示节省数据；
   - d) Phase 3 验收：新建会话后让 `subagent` 带 `provider/model` 跑一次本地子 agent（配置已就位）。
4. 若还有「绝不能外发」的目录/文件模式，告诉我，我加进 `denyGlobs` 默认值。
5. GUI 侧仍建议确认一次：Settings → Models 出现「内网 Gemma4 (<ollama-host>)」、composer 模型列表出现 `intranet-gemma/gemma4:e2b`（看不到就重启桌面端一次）。

---

## 附录 A：pi-ai 自定义 Ollama 路由（配置写法）

> 与 Models 页「Custom model API」等价；二选一。字段以 `dsh-llm-pi-ai` 的 Config schema 为准。

```yaml
# 追加到 %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml（本机已按此写入 intranet-gemma）
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      intranet-gemma:
        displayName: 内网 Gemma4 (<ollama-host>)
        api: openai-completions
        baseURL: http://<ollama-host>:11434/v1
        # 无鉴权的本地服务需要一个占位 Authorization（官方已知限制）
        headers:
          Authorization: Bearer ollama
        defaultContextWindow: 131072
        defaultMaxTokens: 8192
        models:
          - id: gemma4:e2b
            name: Gemma4 E2B（内网 Ollama）
            contextWindow: 131072
            maxTokens: 8192
            input: [text, image]
            compat:
              supportsReasoningEffort: true
            # 该模型带 thinking：off->none 让请求带 reasoning_effort=none，
            # 否则 Ollama 的 /v1 只输出思考、content 为空（已实测）。
            reasoningEfforts:
              off: none
              low: low
              medium: medium
              high: high
```

> 说明：若换成**非思考模型**（如 qwen3:8b 的 non-thinking 变体），`reasoningEfforts: false` 即可，`compat` 可省略。
> 字段已用 `Config.listConfigs` 对 `llm-pi-ai` 的 live schema 核对：`providers.<id>.{api, baseURL, headers, displayName, defaultContextWindow, defaultMaxTokens, models[{id,name,contextWindow,maxTokens,input,reasoningEfforts,compat}]}` 均存在。

> 注意：`cordis.patch.yml` 是「按行整块替换 config」，追加该行前先确认 `llm-pi-ai` 行是否已被其他 patch 覆盖；安装插件后建议把本地模型配置留在你自己的 patch 层，插件只引用 route 名。

## 附录 B：插件 Config 示例（端点全可配，初始默认值）

```yaml
- insert:
    - id: local-delegate
      name: 'dsh-local-delegate'
      config:
        enabled: true
        endpoint:
          kind: ollama-native              # ollama-native | openai-compatible
          baseURL: http://<ollama-host>:11434
          path: /api/chat
          model: gemma4:e2b
          apiKey: ''                       # openai-compatible 网关才需要
          headers: {}
          numCtx: 32768
          keepAlive: 30m
          think: false                     # 思考模型必须 false
          timeoutMs: 120000
        modelsByTask: {}                   # 例：{ translate: gemma4:e2b, summarize: gemma4:26b }
        fallbackEndpoints: []              # 例：[{ kind: ollama-native, baseURL: http://127.0.0.1:11434, model: gemma4:26b }]
        maxInlineChars: 8000
        chunkChars: 12000
        maxConcurrency: 2
        perTurnBudget: 8
        allowedGlobs: ['**/*']
        denyGlobs: ['**/.env*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/.credentials*']
        autoRoute:
          sessionTitle: true
          compaction: false
```

> 换端点/换模型/换协议只改 `endpoint`（或 `modelsByTask`），不改代码；插件同时支持原生 Ollama 与任意 OpenAI 兼容端点（LM Studio / llama.cpp / vLLM / 内网网关）。

## 附录 C：提示词 section 草稿（模型可见，≈120 token）

```
Local cheap model: `{{local_provider}}/{{local_model}}` on the intranet (free). Delegate MECHANICAL text work whose content you do not need to understand, only its result: translate, summarize, extract fields, classify, rewrite style, generate docstrings/comments, commit messages, name candidates.

Prefer `local_transform`/`local_batch` with a file PATH (`source.kind: "file"`) instead of pasting text — pasted text costs output tokens. Delegate when content is larger than ~800 tokens or spans one or more whole files.

Do the work yourself when it needs judgment or trust: code changes and debugging, architecture/decisions, final user-facing answers, secrets/credentials/personal data, or anything you must verify line by line. If the local model fails once or returns unusable output, stop delegating and do it yourself. Batch jobs default to a dry run first.
```

## 附录 D：实现阶段需要逐一核对的 API（避免拍脑袋）

- `defineTool` 的 `parameters` DSL（`string`/`number`/`boolean`/`array`/`object`/`oneOf`）与 `output.schema`、`render` 契约；
- `ctx.llm.stream()` 的 `RequestMessage` 构造（user content 用 block 数组）与 `usage` chunk 归一；
- `ctx.systemPrompt.context(...)` 的 `provider`/`order` 参数与 `required` 语义；
- `ctx.jobs.start` 的 job 句柄、`append/updateProgress`，以及 `local_batch` 结果如何一次性返回；
- `ctx.commands.register` 的 definition 形状与文案本地化（`locale/*.json`）；
- `ctx.storage` 或 `storageDomain` 的写入 API 与 profile 数据目录（做统计持久化）；
- 标准预设 `subagent` 的 `modelSelectionSettings` 生效条件（需新会话），以及 Settings → Plugins → Subagent 页在本 profile 是否渲染（live 树里该行状态为 `absent`，需实测；不可用则直接写 patch）。

## 附录 E：实测记录与可复现脚本（2026-11-03）

**本机**：Windows（10.0.26300），AMD GPU 24GB，Ollama **0.33.1**（AMD AI Bundle），模型 **gemma4:26b**（GGUF Q4_K_M，25.2B，19GB，ctx 262144，能力 `completion/vision/tools/thinking`），`OLLAMA_FLASH_ATTENTION=1`、`OLLAMA_KV_CACHE_TYPE=q8_0`。

**内网**：`<ollama-host>:11434`，Ollama **0.40.13**，模型 **gemma4:e2b**（Q4_K_M，5.1B，7.2GB，ctx 131072，能力 `completion/vision/audio/tools/thinking`），从 DSH 宿主机可达（`/api/version` 65ms）。

| 测试 | 本机 gemma4:26b | 内网 gemma4:e2b |
|---|---|---|
| `GET /api/tags` / `/v1/models` | 正常 | 正常 |
| 原生 `/api/chat + think:false` 短句翻译 | 1.03s，「构建成功完成。」5 tok | 正确「构建成功。」；冷加载 40s |
| 原生 `/api/chat + think:false` 长句翻译 | 124 tok / 12.6s ≈ **10.6 tok/s**，质量好 | 96 tok / 2.2s ≈ **47.8 tok/s**，质量好 |
| `/v1/chat/completions` 默认 | content 空（120 tok 全给思考） | content 空（reasoning 332 字符） |
| `/v1` + `reasoning_effort: "none"` | — | **正常**：132ms、4 tok、非流式与流式均通过 |
| `/v1` 流式 SSE + `stream_options.include_usage` | — | **正常**：5 个事件、`usage` 返回 |
| `/v1` + `tools`（function calling） | — | **正常**：返回 `get_weather` 工具调用 |
| 冷启动 | 93s（19GB） | 40s（7.2GB） |

可复现脚本（已放在 workspace，Node fetch，避免 PowerShell 5.1 的 Schannel 问题）：

```powershell
node .tmp/probe-intranet-ollama.mjs http://<ollama-host>:11434 gemma4:e2b   # 端点/模型/原生对话/吞吐
node .tmp/probe-intranet-v1.mjs http://<ollama-host>:11434/v1 gemma4:e2b    # 流式/usage/tools/思考开关
```

对插件的直接结论（按内网 47.8 tok/s 重新定标）：

1. 插件主通道用**原生 `/api/chat`** 并显式 `think:false`；若走 OpenAI 兼容端点，必须显式带 `reasoning_effort:"none"`（或在 pi-ai 侧用 `reasoningEfforts` + `compat` 兜底）。
2. 分块目标：单块 ≈**1,200–1,500 输出 token**（内网 ≈25–30s/块，本机 26B ≈2 分钟/块，按端点实测调）；单文件超预算转后台 job；总耗时上限按 120s 配置。
3. 预热：插件加载/首次使用前发一次 `keep_alive=30m` 的极小请求；冷启动 40–93s 需容错。
4. `keep_alive` 设 30m，避免反复冷加载 7.2–19GB 模型。
5. 若改用 8B（内网或本机），速度预计提升数倍，可把分块目标与并发上调（由实测 tok/s 决定）。
