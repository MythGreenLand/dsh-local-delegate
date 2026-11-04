# dsh-local-delegate v0.5.1

本地小模型委派插件（DSH `0.2.1-rc.5`）。把翻译、摘要、抽取、分类、改写等机械文本工作交给本地廉价模型，正文由插件读写、不进入主模型上下文。

## 本版亮点

### v0.5.0：SlaveAgentTeams 单开关自动模式

- 打开 `slaveTeamsEnabled` 后，root / Team Lead 在 spawn 时自动发现所有已挂载的 LLM 路由与模型（本地/内网优先，云端作为故障转移）。
- 单个节点启动失败自动换下一个；所有候选失败后才按 `slaveTeamFallback` 回退父模型或报错。
- 保存配置或点击“注册端点链路由”时，把 `endpoint` + `fallbackEndpoints` 按 host 自动注册为 `llm-pi-ai` 路由（`local-delegate`、`local-delegate-fb1`…）。
- 提供 5 个工具：`slave_team_spawn` / `status` / `wait` / `send` / `interrupt`。slave 是独立 child agent，不是 Team teammate，与原生 Agent Teams 共存。

### v0.5.1：修复

- **等级 `none` 提示准确**：不再误报“slave 工具已安装”，与实际 Tool 列表一致。
- **端点数值校验**：`timeoutMs` / `maxOutputTokens` / `numCtx` / `temperature` 在 GUI 与 Host 双重校验；空值不再变成 0 导致 1ms 超时或零输出。
- **Remove route 清理完整**：同时移除 `local-delegate` 与所有 `local-delegate-fbN`，失败时不再误报成功。
- **保留用户 provider 定制**：自动注册不覆盖自定义 `displayName`、模型顺序/元数据、额外 headers 和未管理字段。
- **`slave_team_send` 后续回合可见**：监听 `subagent/end`，`status` 显示 running，`wait` 等待新回合并更新输出预览与 `stop_reason`。
- **L0 自动模式不再安装空工具**：等级 `none` 且无显式节点时不注册 5 个 slave 工具；显式 cloud 节点仍可用。
- **`/slaves` 尊重 `slaveTeamAutoDiscover:false`**：返回 `implicit` 模式与隐式节点池。
- **GUI 细节**：等级卡复选框标签不再重复；README/INSTALL 更正“GUI 保存只写变化字段”。
- 路由同步不再因旧 revision 失败。

## 升级 / 安装

已有 0.4.x 或 0.5.0：先移除旧 bundle，再安装 0.5.1 目录。首次安装可下载下方 Release 资产 `dsh-local-delegate-v0.5.1.zip`，解压到 `%USERPROFILE%\.dsh\local-plugins\dsh-local-delegate-0.5.1`。

```text
plugin_manager action=remove_bundle target=dsh-local-delegate
plugin_manager action=install_bundle target=%USERPROFILE%\.dsh\local-plugins\dsh-local-delegate-0.5.1
```

刷新 Web GUI（F5）。新目录安装无需重启；配置仍保存在 profile 的 `cordis.patch.yml`。

## 验证

- `npm test`：110 项全过（host / client / levels / policy / slaves / regressions）。
- 真实 Ollama 端点：`local_transform` / `local_batch` / `local_health` / fallback / 安全守卫全过。
- 隔离 Web GUI：配置页、等级、SlaveAgentTeams、provider 保留、数值校验、Remove route、autoDiscover 模式均通过；无页面异常。
- 真实会话：`none` 上下文准确；`slave_team_send` 后 `wait` 能等待并显示新回合结果。

## 已知限制

- `max`（L4）是 scoped prompt + `tools.restrict` 的强约束近似，不能 100% 阻止模型直接作答。
- Agent Teams teammate 仍使用 Team 继承的强模型（DSH rc.5 Team spawn 不接受 model）。
- “Register endpoint-chain routes now” 会按健康探测跳过暂时不可达/模型缺失的备用端点；保存配置不做该过滤。
- 统计为内存计数，插件重载清零。
