# 安装与使用（dsh-local-delegate）

本插件是 **Host-only bundle**：一个目录 + 一份插件行配置，不需要构建、不需要 npm 发布。安装后 DSH 会获得 3 个模型工具、一段委派提示词、可用性上下文与 2 个命令。

## 0. 前置检查（安装前，2 分钟）

```powershell
# 1) 从 DSH 宿主机验证端点可达、模型存在、能生成（不经过插件）
node "<插件目录>\scripts\verify-endpoint.mjs" --base-url http://<ollama-host>:11434 --model gemma4:e2b
# OpenAI 兼容端点示例：
node "<插件目录>\scripts\verify-endpoint.mjs" --kind openai-compatible --base-url http://host:11434/v1 --model gemma4:e2b --api-key ollama
```

期望输出 `PASS` + 延迟/模型列表/一次中文翻译。失败时脚本会直接给出原因（不可达 / 模型不存在 / 思考模型空输出）。

## 1. 安装

插件目录必须长期存在（DSH 以符号链接方式引用它）。推荐流程：

1. 把插件同步到稳定位置（**按版本分目录**，升级时换新目录才能免重启加载新代码）：
   ```
   %USERPROFILE%\.dsh\local-plugins\dsh-local-delegate-<版本>\
   ```
   用插件自带脚本一步完成「语法检查 + 同步」（需要 PowerShell 7）：
   ```powershell
   pwsh -NoProfile -File "<插件源码目录>\scripts\sync-install.ps1"
   ```
2. 在 DSH 会话里让 Agent 执行安装（等价于 Plugin Manager 的 install_bundle）：
   ```
   plugin_manager action=install_bundle target=<上一步输出的绝对路径>
   ```
3. 确认结果：`application: applied`，无 warnings；插件出现在 Settings → Plugins 的内置插件列表，标题「本地小模型委派」。

> 也可以用 DSH 的 `dsh plugin add <目录>`（若本机 PATH 里有 `dsh` 命令）。不要手工改 profile 的 package.json。
> 若脚本报 `AuthorizationManager check failed`，说明用的是 Windows PowerShell 5.1；改用 `pwsh`（PowerShell 7）执行。

## 2. 安装后验证清单（必须逐条过）

| 检查 | 做什么 | 期望 |
|---|---|---|
| 插件已激活 | Settings → Plugins 查看「本地小模型委派」 | 已启用，描述/图标正常 |
| 工具已注册 | 新会话里让 Agent 调用 `local_health` | `local delegate: ready`，primary reachable、model advertised |
| 命令已注册 | 输入框输入 `/localdoctor`、`/localstats` | 能看到命令并返回诊断/统计 |
| 一次内联翻译 | 让 Agent：`用 local_transform 把 "hello world" 翻成中文` | 返回中文 + endpoint/耗时回执 |
| 一次文件翻译 | 让 Agent 翻一个工作目录内的 md 文件 | 生成 `<名字>.local.md`，回执只含摘要不含全文 |
| 安全策略 | 翻含 `sk-` 的长字符串 / 工作目录之外的路径 | 分别返回 `LOCAL_SECRET_REFUSED` / `LOCAL_PATH_OUTSIDE_WORKSPACE` |

全部通过即安装完成。

## 3. 改端点 / 模型 / 超时（热生效）

在 profile 的 `cordis.patch.yml` 里**按行 id 覆盖**（同 id 后写覆盖前写，保存后 1–5 秒生效，无需重启）：

```yaml
- id: local-delegate
  name: "dsh-local-delegate"
  config:
    enabled: true
    retries: 1
    endpoint:
      kind: ollama-native            # ollama-native 或 openai-compatible
      baseURL: http://<ollama-host>:11434
      model: gemma4:e2b
      think: false                   # 思考模型必须 false
      keepAlive: 30m
      numCtx: 32768
      timeoutMs: 120000
    fallbackEndpoints: []            # 可放备用端点，主端点故障时自动降级
    allowRoots: []                   # 允许访问工作目录之外的额外根目录
```

> ⚠️ 该行的 `config` 是**整块替换**：覆盖时要把想保留的字段都写出来（其余回到默认值）。

## 4. 升级（免重启流程）

插件以**符号链接目录**方式安装、Node 有模块缓存，因此升级要换一个**新版本目录**让 DSH 重新 import：

1. 修改源码（本仓库版本位于 `workspace/plugins/dsh-local-delegate`），并把 `package.json`/`PLUGIN_VERSION` 一起升版本；
2. 同步到新的版本目录（脚本自动读取版本号）：
   ```powershell
   pwsh -NoProfile -File "<源码目录>\scripts\sync-install.ps1"
   ```
   它会做：语法检查 → 同步到 `%USERPROFILE%\.dsh\local-plugins\dsh-local-delegate-<新版本>` → 打印下一步。
3. 让 Agent 先卸载旧包、再装新目录：
   ```
   plugin_manager action=remove_bundle target=dsh-local-delegate
   plugin_manager action=install_bundle target=%USERPROFILE%\.dsh\local-plugins\dsh-local-delegate-<新版本>
   ```
4. 新会话验证：`local_health` 的状态行应显示 `v<新版本>`。若版本未变，重启一次 DSH 桌面端（模块缓存兜底）。

同一版本重复安装不会重新加载代码；这也是脚本按版本分目录的原因。

## 5. 禁用 / 回滚 / 卸载

- **临时禁用（热生效）**：profile patch 覆盖该行 `enabled: false`。工具、提示词、上下文立即消失；重设为 `true` 恢复。
- **回滚到默认端点**：删除 profile patch 里的覆盖行，恢复 bundle 自带配置。
- **彻底卸载**：`plugin_manager action=remove_bundle target=dsh-local-delegate`，然后重启 DSH。插件无持久化数据，卸载即干净。

## 6. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 工具不存在 | 插件行未激活 / 被禁用 / 加载失败 | Settings → Plugins 查看状态；`/localdoctor` 不可用时看 DSH 启动日志里的 `local-delegate:` 行 |
| 升级后版本没变 | 模块缓存（同路径重装） | 换版本目录重新安装，或重启 DSH 桌面端 |
| `local_health` 返回 unavailable | 端点不可达 | 用 `scripts/verify-endpoint.mjs` 复测；检查 Ollama 是否 `OLLAMA_HOST=0.0.0.0`、防火墙、端口 |
| `model_found: false` | 模型名不对/未拉取 | 在服务端 `ollama list`，改 `endpoint.model` 或 `ollama pull` |
| 生成报 empty content | 思考模型把预算耗在 thinking | `think: false`（ollama-native）或 `reasoningEffort: "none"`（openai-compatible） |
| `LOCAL_PATH_OUTSIDE_WORKSPACE` | 文件在工作目录之外 | 用 `working_directory` 切过去，或把父目录加入 `allowRoots` |
| `LOCAL_SECRET_REFUSED` | 内容含疑似凭据 | 由主模型自行处理或先脱敏 |
| `LOCAL_BATCH_TOO_LARGE` | 超过 `maxBatchFiles`/`maxBatchChars` | 拆批，或调高这两个上限 |
| 超时 | 长文本/慢模型 | 调高 `endpoint.timeoutMs`，或调小 `chunkChars` 拆分请求 |
| 提示词变长影响成本 | `promptHelp: true` 固定约 300 token | 不需要时设 `promptHelp: false` |

更多配置字段与成本说明见 `README.md`。
