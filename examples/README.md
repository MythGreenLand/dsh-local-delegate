# 示例：HTML 课程本地化管线

这两个零依赖脚本演示如何把「整站 HTML 课程」安全地交给本地模型翻译。不要直接翻原始 HTML——5B 级模型会多写/漏写闭合标签；正确做法是先抽取可见文本，翻完再重建页面。

## 流程

```
原始 HTML ──extract-html.mjs──▶ Markdown（标题/段落/列表）──▶ dsh-local-delegate local_batch ──▶ build-zh.mjs ──▶ 中文站点
```

1. 抽取（脚本只保留可读文本，跳过 script/style/head/导航）：

   ```powershell
   node extract-html.mjs <课程目录> <课程目录>/.l10n-src
   ```

2. 翻译（在 DSH 会话里让 Agent 执行，或直接调插件工具）：对 `.l10n-src` 下的 Markdown 分批 `local_batch`，输出到 `.l10n-zh`。

3. 重建（生成 `course-zh/`：索引页 + 每页 HTML + Markdown）：

   ```powershell
   node build-zh.mjs <课程目录>
   ```

## 实测（供参考）

- 61,150 源字符 / 28 页 → 5.1 分钟、29,534 local tokens、0 失败；
- 折算主模型等价 ≈27.1k token，实际调度开销 ≈2k，**节省 ≈92%**；
- 质量：术语与结构保留良好；5.1B 的典型错误（人名直译、个别词义反译）需抽查校对。

脚本假设输入目录里有 `content/sessions/*.html` 与 `content/transcripts/*.html`；不同课程包可自行调整 `extract-html.mjs` 里的遍历根目录。
