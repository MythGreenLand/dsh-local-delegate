# dsh-local-delegate — 本地小模型委派插件

把**机械性文本工作**（翻译、摘要、字段抽取、分类、改写、commit message、命名）交给本地廉价模型，主模型只保留判断与工具调用。

关键不在「多一个模型工具」，而在**正文走哪条路**：插件自己读文件、分块、调用本地模型、写回结果，所以整篇文档**不会进入主模型上下文**。一篇 10KB 文档的翻译，主模型只花约 150 token（一次调用），而不是约 5,000 token（读原文 + 写译文）。

- 当前版本：**0.2.1**
- 协议：Ollama 原生 `/api/chat`（可关思考、保活、控上下文）或任意 OpenAI 兼容端点
- 安装与验证：见 [INSTALL.md](INSTALL.md)（推荐按版本目录安装，升级可免重启加载）

## 仓库结构

```
index.js / lib/            Host 插件：工具、端点链客户端、分块、护栏、统计
cordis.patch.yml           bundle 补丁：插入插件行（默认 localhost，安装前按需改）
scripts/                   verify-endpoint.mjs（安装前自检）、sync-install.ps1（同步+升级）
locale/ · icon.svg         插件显示元数据
docs/design-and-feasibility.md   设计/可行性/实测记录（含成本模型与风险）
examples/                  HTML→Markdown→翻译→重建网页的本地化示例脚本
README.md · INSTALL.md     使用与安装手册
```

## 快速开始

```powershell
# 1) 先验证端点（不安装任何东西）
node scripts/verify-endpoint.mjs --base-url http://127.0.0.1:11434 --model gemma4:e2b

# 2) 同步到版本目录（PowerShell 7）
pwsh -NoProfile -File scripts/sync-install.ps1

# 3) 在 DSH 会话里让 Agent 执行：
#    plugin_manager action=install_bundle target=<第 2 步输出的目录>

# 4) 会话内验证：local_health → local delegate: ready (status: available, v0.2.1)
```

完整步骤（验证清单、配置、免重启升级、回滚、故障排查）见 [INSTALL.md](INSTALL.md)。

## 示例：把一门在线课程本地化

`examples/` 里是两个零依赖脚本，演示「HTML 抽取 → 纯文本翻译 → 重建网页」的流程（直接翻原始 HTML 会被 5B 模型破坏标签结构）：

```powershell
node examples/extract-html.mjs <课程目录> <课程目录>/.l10n-src
# 让 Agent 用 local_batch 翻译 .l10n-src 下的 Markdown
node examples/build-zh.mjs <课程目录>
```

实测：61k 源字符、28 页，5.1 分钟、29.5k local tokens，预计为主模型节省约 92% token。细节见 [docs/design-and-feasibility.md](docs/design-and-feasibility.md)。

## 设计文档

[docs/design-and-feasibility.md](docs/design-and-feasibility.md) 记录了可行性论证、DSH 现有能力核查、分层委派设计、安全与失败处理、成本模型、分期计划与实测数据。

## 许可证

MIT，见 [LICENSE](LICENSE)。

## 工具

| 工具 | 用途 |
|---|---|
| `local_transform` | 单次变换。**优先 `path` 文件模式**：插件读取文件并写回，正文不进对话；`text` 只用于短片段（≤ `maxInlineChars`） |
| `local_batch` | 多文件批量。默认 **dry-run**（只返回计划），`dry_run: false` 才执行；输出到 `out_dir`（默认 `.local-out/`） |
| `local_health` | 探测整条端点链 + 返回配置与修复建议，不生成 token；状态行包含插件版本 |

文件模式默认输出路径：源文件名插入 `.local`（`README.md` → `README.local.md`）。工作目录之外的路径会在回执里显示绝对路径。

## 可用性机制（0.2.x）

- **端点故障转移**：`endpoint` 主端点 + `fallbackEndpoints` 备用链；主端点不可达/报错时自动依次尝试，回执里标注 `(fallback)`。
- **有限重试**：`retries`（0–3，默认 1）只对传输类错误重试（连接失败、超时、5xx、429）；HTTP 4xx（模型不存在、鉴权错）直接换下一个端点。
- **启动自检**：插件加载后 1.5s 探活一次，成功/降级/失败各打一行带修复提示的日志；之后每 120s 刷新一次可用性。
- **运行上下文**：系统提示词里只有一行状态（`available` / `degraded` / `unavailable` + 修复指引），状态不变时不重复追加。
- **`/localdoctor` 命令**：一次性输出配置、端点链探测、路径策略、统计与**可执行的修复清单**。
- **配置自检**：`model` 为空、`baseURL` 非 http(s)、fallback 缺字段等会在加载时以 warning 日志提示，而不是等到第一次调用才报错。

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
      baseURL: http://<ollama-host>:11434
      path: ""                       # 默认 /api/chat 或 /v1/chat/completions
      model: gemma4:e2b
      apiKey: ""                     # 仅 OpenAI 兼容端点需要
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
    allowOutsideCwd: false           # true = 不限制路径（不推荐）
    allowRoots: []                   # 允许访问的额外根目录（绝对路径或相对 cwd）
    denyGlobs: ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/.credentials*", "**/secrets/**", "**/.git/**"]
    promptHelp: true                 # 关闭后不注入委派提示词（节省约 300 token/请求）
    warmupOnStart: true              # 启动探活 + 周期刷新
```

## 使用方式

让主模型自然使用即可，插件已通过提示词说明何时该委派。典型请求：

- 「把 `docs/README.md` 翻成中文」→ Agent 调用 `local_transform(path=..., target_language=...)`
- 「把这 5 个 md 翻成中文」→ `local_batch` 先 dry-run，再 `dry_run:false`
- 「这个报错日志太长，总结一下」→ 文件模式 `summarize`
- 「看一下本地模型是否可用」→ `local_health`
- 人工诊断：`/localdoctor`；用量：`/localstats`

## 安全

- **密钥拦截**：私钥块、AWS/GitHub/Slack token、`sk-…`、JWT、`password=…` 在请求发出前拒绝。
- **路径约束**：默认只能在会话工作目录（或 `allowRoots`）内读写；`.env`、密钥、`secrets/`、`.git/` 默认拒绝。
- **不静默重试**：本地失败返回可执行错误并提示「自己完成」，不会让 Agent 反复重试。
- **原子写入**：临时文件 + rename；输出先做非空校验。
- 本地模型输出不可信：批量默认 dry-run，关键文件请主模型抽查。

## 成本模型

| 工作 | 主模型直接做 | 文件模式委派 |
|---|---|---|
| 翻译 10KB 文档 | ≈5,000 token | ≈200 token |
| 汇总 40KB 日志 | ≈10,600 token | ≈500 token |
| 20 个文件批量加注释 | ≈26,000 token | ≈700 token |
| 翻译一句话 | ≈200 token | 更贵 → 已在提示词里要求自己做 |

## 已知限制

- 统计是内存态（重载清零），不做持久化账本。
- 批量是同步执行，靠 `maxBatchChars/maxBatchFiles` 控制单次时长；超长任务请拆批。
- 翻译按块拼接，极端排版（表格/脚注）会被规整化。
- 直接翻原始 HTML 有破坏标签结构风险（实测 5.1B 会多写/漏写闭合标签）；请先抽取纯文本再翻译。
- 插件运行在 Host 进程内，路径/密钥策略是**策略约束**，不是操作系统沙箱。
