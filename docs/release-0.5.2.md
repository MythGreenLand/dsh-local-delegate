# dsh-local-delegate v0.5.2

打包默认值与依赖声明的修正版，功能与 0.5.1 相同：没有新增工具、没有改策略、没有改 GUI。

## 改了什么

- **默认端点不再指向维护者内网**：`cordis.patch.yml` 里的 `endpoint.baseURL` 从 `http://10.0.101.11:11434` 改为 `http://127.0.0.1:11434`（Ollama 默认端口），`model` 仍是示例名 `gemma4:e2b`。
- **不再捆绑备用端点**：`fallbackEndpoints` 默认改为空数组。原来默认带一条指向 `127.0.0.1` 的 `gemma4:26b` 备用项，对别人的机器没有意义。
- **peer 范围放宽**：`@deepseek-ai/schemastery` 从 `~3.18.5` 改为 `>=3.18.1 <3.18.6-0 || >=3.18.6-0 <4.0.0`。旧范围会静默排除 `3.18.6-alpha.x` 这类预发布版本，让预发布 harness 上 `npm install` 报 ERESOLVE；新范围带显式预发布分支。
- **文档**：README 增加「前置条件」一节（需要的 DSH 版本、可达端点、默认值需要改）；顶部的版本流水账移到「版本历史」；去掉写死且互相矛盾的 token 数字（150 / 200 / 5,000 / 10,600 / 26,000），改为指向 `/localstats` 与 GUI 节省统计的实测口径（字符数 ÷ 3.2）。INSTALL / DEPLOY 的示例地址同步改成 `127.0.0.1`。

## 升级

已有 0.5.x：先移除旧 bundle，再安装 0.5.2 目录。**profile 里覆盖过 `config` 的用户不受影响**——只有仍在用 bundle 默认值的人，端点才会跟着变成 `127.0.0.1:11434`。

```text
plugin_manager action=remove_bundle target=dsh-local-delegate
plugin_manager action=install_bundle target=%USERPROFILE%\.dsh\local-plugins\dsh-local-delegate-0.5.2
```

刷新 Web GUI（F5）。配置仍保存在 profile 的 `cordis.patch.yml`。

## 验证

- `npm test`：110 项全过（host / client / levels / policy / slaves / regressions），exit 0。
- `cordis.patch.yml` 用库内配置 schema 解析通过；默认配置下插件加载无报错，端点不可达时状态为 `unavailable` 并在 `/localdoctor` 给出修复提示。

## 已知限制

与 0.5.1 相同：`max`（L4）是 scoped prompt + `tools.restrict` 的强约束近似；Agent Teams teammate 仍用 Team 继承的强模型；统计是内存计数。
