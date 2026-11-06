# 一键部署 dsh-local-delegate（交给你的智能体）

本页给“其他用户”使用：把下面任意一段**复制给你的 DSH 智能体**，它就能自己下载、安装/升级并做安装后检查。无需手工改 `package.json`、无需构建。

- 仓库：<https://github.com/MythGreenLand/dsh-local-delegate>
- 发布包：<https://github.com/MythGreenLand/dsh-local-delegate/releases/latest>
- 当前版本：`v0.5.2`（DSH `0.2.1-rc.5`）

---

## 方式 A（推荐）一句话让智能体部署

在 DSH 会话里直接粘贴：

```text
请帮我在这台机器上安装（或升级）DSH 插件 dsh-local-delegate（GitHub: MythGreenLand/dsh-local-delegate，最新 Release）。
步骤：
1) 用你的工具下载该 Release 的资产 dsh-local-delegate-v<版本>.zip（或 git clone --depth 1 --branch <tag> https://github.com/MythGreenLand/dsh-local-delegate）；
2) 解压到一个稳定的版本目录：%USERPROFILE%\.dsh\local-plugins\dsh-local-delegate-<版本>（macOS/Linux 用 ~/.dsh/local-plugins/...）；
3) 如果已安装旧版本，先在 DSH 里调用 plugin_manager action=remove_bundle target=dsh-local-delegate；
4) 调用 plugin_manager action=install_bundle target=<解压后的插件目录>；
5) 刷新 Web GUI 后，确认 Settings → 本地模型 出现「本地 AI 介入程度」和「SlaveAgentTeams（多从节点并行）」卡片、输入框工具栏出现「本地 AI：默认 ▾」；在会话里调用 local_health 确认返回 v<版本>。
不要手工编辑 profile 的 package.json；完成后请汇报 release 版本、安装路径和上述检查结果。
```

> 把 `<版本>` 换成例如 `0.4.1` / `v0.4.1`（下载资产名用带 v 的 tag，安装目录名用不带 v 的版本号）。

## 方式 B：脚本准备目录，再由智能体安装

Windows（PowerShell 7）：

```powershell
pwsh -NoProfile -File scripts\install-from-github.ps1 -Version latest
# 或指定版本 / 自定义目录 / 覆盖已存在目录：
# pwsh -NoProfile -File scripts\install-from-github.ps1 -Version v0.4.1 -InstallDir "$env:USERPROFILE\.dsh\local-plugins\dsh-local-delegate-0.4.1"
```

macOS / Linux：

```bash
bash scripts/install-from-github.sh latest
```

脚本只做“下载 + 解压 + 校验 + 放到版本目录”，最后打印下一步。到 DSH 里让智能体执行：

```text
plugin_manager action=remove_bundle target=dsh-local-delegate   # 仅升级时需要
plugin_manager action=install_bundle target=<脚本打印的安装目录>
```

然后 **刷新 Web GUI（F5）**；若新卡片/控件不出现，重启一次 DSH 桌面端（Client 半模块缓存兜底）。

## 方式 C：手工安装（离线/发布包）

1. 从 [Releases](https://github.com/MythGreenLand/dsh-local-delegate/releases/latest) 下载 `dsh-local-delegate-v0.5.2.zip`；
2. 解压到 `%USERPROFILE%\.dsh\local-plugins\dsh-local-delegate-0.5.2`（目录里应直接看到 `index.js`、`client.js`、`package.json`）；
3. 在 DSH 里让智能体执行 `plugin_manager action=install_bundle target=<上述目录>`；
4. 刷新 GUI，按 [INSTALL.md](INSTALL.md) 的“安装后验证清单”逐项检查。

---

## 智能体验收清单（安装后应满足）

- [ ] `local_health` 回执显示 `v0.5.2`（或目标版本）；
- [ ] Settings → 本地模型 有两个新卡片：`本地 AI 介入程度`、`SlaveAgentTeams（多从节点并行）`；
- [ ] 输入框工具栏（模型/推理等级旁）出现 `本地 AI：默认 ▾`；设置卡片里的「在输入框显示等级选择器」可开关它；
- [ ] 默认配置（等级=默认、SlaveAgentTeams 关闭）下行为与 0.3.0 一致，仅多出可选的本地能力；
- [ ] 若需要 slave：打开 SlaveAgentTeams 开关即可；保存时端点链（主端点 + 备用端点）会自动注册为 `llm-pi-ai` 路由，无需手工加节点。

## 兼容性

- 需要 DSH `0.2.1-rc.5`（package.json `dsh.compatibility` 已声明）；
- 插件同时提供 Host 与 Client 半；Client 半更新后必须刷新页面/重启一次桌面端；
- 升级/回滚详见 [INSTALL.md](INSTALL.md)；旧版本目录保留即可回滚。

