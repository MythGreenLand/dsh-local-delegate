# 安装与使用（dsh-local-delegate）

本插件是 **Host + Client bundle**：一个目录，不需要构建、不需要 npm 发布。Host 半提供本地模型工具（`local_transform` / `local_batch` / `local_health`，`high`/`max` 等级 root agent 额外有 scoped `local_worker`，打开 SlaveAgentTeams 时 root/Team Lead 额外有 5 个 `slave_team_*`）、委派提示词、可用性上下文、按工作区的等级策略与 3 个命令（`/localdoctor`、`/localstats`、`/localpolicy`）；Client 半（`client.js`）提供 Web GUI 配置页（Plugins 行 Configure + Settings → 本地模型），0.4.0 起含「本地 AI 介入程度」与「SlaveAgentTeams（多从节点并行）」两张卡片，0.4.1 起在输入框工具栏（模型/推理等级旁）增加可开关的「本地 AI 介入程度」快捷选择器。

## 0. 前置检查（安装前，2 分钟）

```powershell
# 1) 从 DSH 宿主机验证端点可达、模型存在、能生成（不经过插件）
node "<插件目录>\scripts\verify-endpoint.mjs" --base-url http://10.0.101.11:11434 --model gemma4:e2b
# OpenAI 兼容端点示例：
node "<插件目录>\scripts\verify-endpoint.mjs" --kind openai-compatible --base-url http://host:11434/v1 --model gemma4:e2b --api-key ollama
```

期望输出 `PASS` + 延迟/模型列表/一次中文翻译。失败时脚本会直接给出原因（不可达 / 模型不存在 / 思考模型空输出）。

> 想用「更高/最高」等级或 `local_worker`：还需要在安装后通过 GUI 的「启用为 Subagent 模型」注册 `llm-pi-ai` provider `local-delegate`。
> 想用 SlaveAgentTeams 的云端节点：先在 Models / llm 插件里注册对应 provider/model（例如 `deepseek-account` / `deepseek-flash`）。

## 0.5 一键部署（推荐：交给你的智能体）

其他用户无需手工改 profile：把仓库地址给智能体，让它自己下载发布包并注册 bundle。DSH 会话里直接粘贴：

```text
请帮我在这台机器上安装（或升级）DSH 插件 dsh-local-delegate（GitHub: MythGreenLand/dsh-local-delegate，最新 Release）。
步骤：
1) 用你的工具下载该 Release 的资产 dsh-local-delegate-v<版本>.zip（失败则 git clone --depth 1 --branch <tag> https://github.com/MythGreenLand/dsh-local-delegate）；
2) 解压/克隆到稳定的版本目录：%USERPROFILE%\.dsh\local-plugins\dsh-local-delegate-<版本>（macOS/Linux：~/.dsh/local-plugins/dsh-local-delegate-<版本>）；
3) 已安装旧版本时先调用 plugin_manager action=remove_bundle target=dsh-local-delegate；
4) 调用 plugin_manager action=install_bundle target=<插件目录>；
5) 刷新 Web GUI，确认 Settings → 本地模型 出现「本地 AI 介入程度」「SlaveAgentTeams（多从节点并行）」卡片、输入框工具栏出现「本地 AI：默认 ▾」，并调用 local_health 确认返回 v<版本>。
不要手工编辑 profile 的 package.json；完成后汇报版本、安装路径和检查结果。
```

也可以先由本地脚本准备版本目录（脚本只下载/解压/校验，不注册 bundle）：

```powershell
# Windows（PowerShell 7）：下载最新 Release
pwsh -NoProfile -File scripts\install-from-github.ps1 -Version latest
# 指定版本 / 自定义目录 / 覆盖同版本目录
pwsh -NoProfile -File scripts\install-from-github.ps1 -Version v0.5.1 -Force
```

```bash
# macOS / Linux
bash scripts/install-from-github.sh latest
```

然后在 DSH 里让智能体执行脚本打印的 `plugin_manager action=install_bundle target=<目录>`（升级时先 `remove_bundle`），刷新 GUI 即完成。完整说明与验收清单见 [DEPLOY.md](DEPLOY.md)。

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
3. 确认结果：`application: applied`，无 warnings；插件出现在 Plugins → Installed plugins，标题「本地小模型委派」。
4. Client 半生效：刷新 Web GUI，打开 Plugins → dsh-local-delegate → 行 Configure；或 Settings → 本地模型。若入口不存在，见第 6 节「GUI 入口不出现」。

> 也可以用 DSH 的 `dsh plugin add <目录>`（若本机 PATH 里有 `dsh` 命令）。不要手工改 profile 的 package.json。
> 若脚本报 `AuthorizationManager check failed`，说明用的是 Windows PowerShell 5.1；改用 `pwsh`（PowerShell 7）执行。

## 2. 安装后验证清单（必须逐条过）

| 检查 | 做什么 | 期望 |
|---|---|---|
| 插件已激活 | Settings → Plugins 查看「本地小模型委派」 | 已启用，描述/图标正常 |
| 工具已注册 | 新会话里让 Agent 调用 `local_health` | `local delegate: ready`，primary reachable、model advertised |
| 命令已注册 | 输入框输入 `/localdoctor`、`/localstats`、`/localpolicy` | 能看到命令并返回诊断/统计/等级策略 |
| 一次内联翻译 | 让 Agent：`用 local_transform 把 "hello world" 翻成中文` | 返回中文 + endpoint/耗时回执 |
| 一次文件翻译 | 让 Agent 翻一个工作目录内的 md 文件 | 生成 `<名字>.local.md`，回执只含摘要不含全文 |
| 安全策略 | 翻含 `sk-` 的长字符串 / 工作目录之外的路径 | 分别返回 `LOCAL_SECRET_REFUSED` / `LOCAL_PATH_OUTSIDE_WORKSPACE` |
| **等级卡片（0.4.0）** | Settings → 本地模型，滚动到「本地 AI 介入程度」 | 5 段默认等级下拉；工作区列表显示标题 + 路径 + 等级下拉；没有工作区时显示「未找到工作区」提示 |
| **默认行为不变（0.4.0）** | 保持默认等级=默认、SlaveAgentTeams 关闭，开新会话 | 与 0.3.0 完全一致：只有 3 个 `local_*` 全局工具，无 `local_worker` / `slave_team_*` |
| **等级解析（0.4.0）** | 给当前工作区设「最高」，新会话执行 `/localpolicy` | 显示工作区路径/标题、`level=max`、来源 `workspace`、planner deny 列表、`local_worker` 已注册 |
| **SlaveAgentTeams（0.4.0）** | 打开开关并配置至少一个节点，新会话 | root/Team Lead 能看到 5 个 `slave_team_*` 工具；child/teammate 不可见；节省统计卡出现 slave 计数 |
| **输入框快捷选择器（0.4.1）** | 打开任一会话，看输入框工具栏（模型/推理等级控件旁） | 出现「本地 AI：<当前等级> ▾」按钮；点击可选择 5 个等级；选「更高」后新会话 `/localpolicy` 显示对应等级 |
| **选择器开关（0.4.1）** | Settings → 本地模型 → 本地 AI 介入程度，取消勾选「在输入框显示等级选择器」→ 保存 → 刷新会话 | 输入框里的选择器消失；重新勾选 + 保存后恢复显示；设置页等级配置不受影响 |

全部通过即安装完成。

## 3. 改端点 / 等级 / SlaveAgentTeams（GUI 或 YAML，均热生效）

**推荐用 GUI**：Plugins → dsh-local-delegate → Configure，或 Settings → 本地模型。保存后写入 profile 覆盖行并在数秒内热生效；页面上有「测试连接」「拉取模型」、节省统计、等级卡片与 SlaveAgentTeams 卡片。

- **本地 AI 介入程度**：选默认等级（无/轻度/默认/更高/最高）、给单个工作区设置覆盖（选「跟随默认」可删除覆盖）、在「等级高级设置」里调 worker 路由/阈值/planner 选项。选「更高/最高」但还没注册 `local-delegate` 路由时，卡片会给出警告。
- **SlaveAgentTeams（0.5.0 单开关）**：打开开关即可。root/Team Lead 在 spawn 时自动发现所有已挂载的 LLM 路由/模型（本地优先），节点失败自动换下一个；保存配置时还会把 `endpoint` + `fallbackEndpoints` 自动注册成 `llm-pi-ai` 路由。卡片里可「刷新检测」「立即注册端点链路由」，节点列表保留为高级手动覆盖（非空时不再自动发现）。
- **输入框快捷等级选择器（0.4.1）**：在「本地 AI 介入程度」卡片勾选「在输入框显示等级选择器」（`composerLevelPicker`，默认开启）。刷新 GUI 后，输入框工具栏出现「本地 AI：默认 ▾」；点击即可切换当前工作区等级（会话未归属工作区时改全局默认等级）。关闭勾选会隐藏该控件，设置页配置不受影响。

也可以继续手工编辑 profile 的 `cordis.patch.yml`（按行 id 覆盖，同 id 后写覆盖前写，保存后 1–5 秒生效，无需重启）：

```yaml
- id: local-delegate
  name: "dsh-local-delegate"
  config:
    enabled: true
    retries: 1
    endpoint:
      kind: ollama-native            # ollama-native 或 openai-compatible
      baseURL: http://10.0.101.11:11434
      model: gemma4:e2b
      think: false                   # 思考模型必须 false
      keepAlive: 30m
      numCtx: 32768
      timeoutMs: 120000
    fallbackEndpoints: []            # 可放备用端点，主端点故障时自动降级
    allowRoots: []                   # 允许访问工作目录之外的额外根目录

    # 0.4.0：等级（全部默认值 = 与 0.3.0 行为一致）
    levelsEnabled: true
    defaultLevel: default            # none | light | default | high | max
    workspaceLevels: {}              # 工作区 canonical path -> 等级
    plannerFallback: strong-worker
    applyToLiveAgents: false

    # 0.5.0：SlaveAgentTeams（默认关闭；打开即自动模式）
    slaveTeamsEnabled: false
    slaveTeamAutoDiscover: true      # false = 只用下面的手动节点池
    slaveNodes: []                   # 手动覆盖：[{name, kind: local|cloud, provider, model, note}]
    slaveTeamDefaultNode: ""
    slaveTeamMaxSlaves: 4
    slaveTeamFallback: inherit
```

> ⚠️ 该行的 `config` 是**整块替换**：手工覆盖时要把想保留的字段都写出来（其余回到默认值）。GUI 保存只写入发生变化的字段，未改动字段继续继承默认值。

## 4. 升级到 0.5.1（免重启流程）

0.5.1 修复了等级 none 的 slave 工具误报、端点数值 0 校验、Remove route 遗留 fb 路由、自动注册覆盖用户 provider 定制、send 后续回合状态、`slaveTeamAutoDiscover:false` 的 /slaves 模式以及重复标签；安装流程与 0.5.0 相同。`n`n0.5.0 把 SlaveAgentTeams 改成单开关自动模式：默认 `slaveTeamAutoDiscover: true`，`slaveTeamsEnabled` 打开后在 spawn 时自动发现所有已挂载 LLM 路由/模型（本地优先），节点失败自动换下一个；保存配置时把 `endpoint` + `fallbackEndpoints` 自动注册为 `llm-pi-ai` 路由。显式 `slaveNodes` 仍可手动覆盖。默认关闭时行为与 0.4.1 完全一致。

1. **备份**（可回滚）：
   - 复制 profile 的 `cordis.patch.yml`（桌面端默认在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`）；
   - 保留旧版本目录（如 `dsh-local-delegate-0.4.1`），不要删。
2. 修改/同步源码到 **0.5.1 新版本目录**（脚本自动读取 `package.json` 版本号）：
   ```powershell
   pwsh -NoProfile -File "<源码目录>\scripts\sync-install.ps1"
   ```
   它会做：语法检查 → 同步到 `%USERPROFILE%\.dsh\local-plugins\dsh-local-delegate-0.5.1` → 打印下一步。
3. 让 Agent 先卸载旧包、再装新目录：
   ```
   plugin_manager action=remove_bundle target=dsh-local-delegate
   plugin_manager action=install_bundle target=C:\Users\<你>\.dsh\local-plugins\dsh-local-delegate-0.5.1
   ```
4. **刷新 Web GUI**（F5）：SlaveAgentTeams 卡片应出现「自动检测并启用…」开关、自动模式面板与「刷新检测 / 立即注册端点链路由」按钮。若入口/控件没出现，**重启一次 DSH 桌面端**（Client 半模块缓存兜底）。
5. 验证：`local_health` 状态行显示 `v0.5.1`；`/localpolicy` 显示 `slave teams: enabled=..., mode=auto`；打开开关后新会话里 `slave_team_status` 返回自动检测到的节点。
6. 保持默认等级/开关关闭时行为与 0.4.1 一致（旧测试与手工流程全过）。

同一版本重复安装不会重新加载代码；这也是脚本按版本分目录的原因。

## 5. 禁用 / 回滚 / 卸载

- **临时关闭 0.4.x 新行为（最轻量）**：GUI 里把默认等级设为「默认」、关闭 SlaveAgentTeams（或 YAML 里 `levelsEnabled: false` / `slaveTeamsEnabled: false`），即回到 v0.3 行为；只想隐藏输入框选择器时取消勾选 `composerLevelPicker` 即可；`applyToLiveAgents: true` 时运行中的 agent 也会立即重装。
- **回滚等级/节点配置**：GUI 把工作区改回「跟随默认」（删除 `workspaceLevels` 覆盖）、删除 slave 节点、恢复默认等级；或从备份恢复 profile `cordis.patch.yml`，或直接删除该行覆盖（回到 bundle 默认值）。
- **完整回滚到 0.3.0**：
  1. 备份当前 profile patch；
  2. `plugin_manager action=remove_bundle target=dsh-local-delegate`；
  3. `plugin_manager action=install_bundle target=C:\Users\<你>\.dsh\local-plugins\dsh-local-delegate-0.3.0`；
  4. 如果 profile patch 里还留着 0.4.0 新增字段（`levelsEnabled`、`defaultLevel`、`workspaceLevels`、`slaveTeamsEnabled`、`slaveNodes` 等），把它删掉或从备份恢复，避免旧 schema 校验报错；重启 DSH。
- **临时禁用（热生效）**：profile patch 覆盖该行 `enabled: false`（或 Plugins 页行开关）。工具、提示词、上下文与 GUI 页配置立即消失；重设为 `true` 恢复。
- **彻底卸载**：`plugin_manager action=remove_bundle target=dsh-local-delegate`，然后重启 DSH。插件无持久化数据，卸载即干净。

## 6. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 工具不存在 | 插件行未激活 / 被禁用 / 加载失败 | Settings → Plugins 查看状态；`/localdoctor` 不可用时看 DSH 启动日志里的 `local-delegate:` 行 |
| 升级后版本没变 | 模块缓存（同路径重装） | 换版本目录重新安装，或重启 DSH 桌面端 |
| GUI 入口不出现 | Client bundle 未加载 / `dsh.client` 或 `exports["./client"]` 缺失 / 页面未刷新 | 检查 package.json 三项声明；刷新页面；在 Settings → Built-in plugins → Plugin list 看该包的同步失败原因 |
| **等级卡片不出现（0.4.0）** | Client 半仍是旧版本 / 页面未刷新 | 确认安装的是 0.4.0 目录；刷新 GUI；仍不出现则重启 DSH 桌面端 |
| **输入框选择器不出现（0.4.1）** | Client 半是旧版本 / `composerLevelPicker` 关闭 / `levelsEnabled` 关闭 / 当前会话未挂载 composer | 确认安装 0.4.1 并刷新 GUI（必要时重启）；检查设置页「在输入框显示等级选择器」是否勾选、等级策略是否启用；在已打开的会话里查看输入框工具栏 |
| **工作区列表为空** | workspaceRegistry 未挂载 / 当前没有打开的工作区 / Host 还是旧版本 | 在 DSH 里打开一个工作区后点「刷新工作区列表」；确认 Host 版本 0.4.0；卡片会显示 `/levels` 错误或 unavailable 说明 |
| **「更高/最高」警告需要 local-delegate 路由** | `llm-pi-ai` 里没有 provider `local-delegate` | 先点本页「启用为 Subagent 模型」，再新开会话；或把 `workerRouteProvider` 改成已注册的路由 |
| **设了「无」但 Agent 仍在用本地模型** | 会话是在改等级**之前**创建的 | 新开会话，或打开 `applyToLiveAgents` 后重新保存；`/localpolicy` 可确认当前 agent 解析等级 |
| **L4 下 Agent 仍直接执行** | L4 是强约束近似；未知/第三方工具默认放行 | 用 `/localpolicy` 看 deny 列表；用 `plannerDenyExtra` 补禁用第三方执行工具；`plannerAllowRead: false` 收紧只读 |
| **local_worker 报路由不可用** | `workerRouteProvider`/`workerRouteModel` 未注册，或本地路由未启用 | 检查「启用为 Subagent 模型」与 `workerRouteProvider`；错误信息会提示 `SLAVE_ROUTE_UNAVAILABLE` 类的修复方向 |
| **SlaveAgentTeams 工具不可见** | 未打开开关 / 没有可用节点 / 当前等级为「无」过滤了本地节点 / 不是 root 或 Team Lead | 检查开关与节点（隐式节点需要 `endpoint.model`）；child/teammate 永远不可见；`/localpolicy` 可看 slave 工具数 |
| **节点路由不可用** | 节点 provider/model 未在 llm 注册 | 先在 Models 页注册 provider/model；本地节点需先启用 `local-delegate` 路由；`slaveTeamFallback: inherit` 可用父模型重试 |
| **`ACTIVATION_LIMIT_REACHED`** | 同时活跃的子 agent 达到上限（默认 8） | 等已有 slave/子 agent 完成，或调低 `slaveTeamMaxSlaves`，或提高 DSH 的 `maxActiveSubagents` |
| **teammate 用的是强模型** | 当前 DSH 的 Team spawn 不带模型参数 | 已知限制（本版不改变）；本地执行用 `local_worker` 或 slave |
| GUI 保存被拒 | 值未通过 Host 校验，或配置被其他编辑器改动 | 页面会提示；0.4.0 新增校验：等级非法、阈值为 0 或负数、从节点名称为空/重复、`slaveTeamMaxSlaves` 越界（1–8）、深度越界（1–5）。刷新后重试 |
| `local_health` 返回 unavailable | 端点不可达 | 用 `scripts/verify-endpoint.mjs` 复测；检查 Ollama 是否 `OLLAMA_HOST=0.0.0.0`、防火墙、端口 |
| `model_found: false` | 模型名不对/未拉取 | 在服务端 `ollama list`，改 `endpoint.model` 或 `ollama pull` |
| 生成报 empty content | 思考模型把预算耗在 thinking | `think: false`（ollama-native）或 `reasoningEffort: "none"`（openai-compatible） |
| `LOCAL_PATH_OUTSIDE_WORKSPACE` | 文件在工作目录之外 | 用 `working_directory` 切过去，或把父目录加入 `allowRoots` |
| `LOCAL_SECRET_REFUSED` | 内容含疑似凭据 | 由主模型自行处理或先脱敏 |
| `LOCAL_BATCH_TOO_LARGE` | 超过 `maxBatchFiles`/`maxBatchChars` | 拆批，或调高这两个上限 |
| `LOCAL_LEVEL_GUARD` / `LOCAL_LEVEL_DISABLED` | 等级守卫拒绝（轻度阈值不足 / 无等级禁用本地工具） | 改用文件模式且足够大，或调整工作区等级/阈值 |
| 超时 | 长文本/慢模型 | 调高 `endpoint.timeoutMs`，或调小 `chunkChars` 拆分请求 |
| 提示词变长影响成本 | `promptHelp: true` 固定约 300 token | 不需要时设 `promptHelp: false` |

更多配置字段与成本说明见 `README.md`。
