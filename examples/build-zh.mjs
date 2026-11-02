// Build a browsable Chinese course site from the translated Markdown files.
// Usage: node build-zh.mjs <courseRoot>
// Input : <courseRoot>/.l10n-zh/*.local.md
// Output: <courseRoot>/course-zh/{*.md, *.html, index.html}
import { promises as fs } from 'node:fs'
import nodePath from 'node:path'

const ROOT = nodePath.resolve(process.argv[2] ?? '.')
const SRC = nodePath.join(ROOT, '.l10n-zh')
const OUT = nodePath.join(ROOT, 'course-zh')

const GROUPS = [
  { id: 'overview', label: '课程总览', files: ['start', 'sessions', 'syllabus'] },
  { id: 'lectures', label: '课程讲义（20 讲）', files: Array.from({ length: 20 }, (_, index) => `lecture${String(index + 1).padStart(2, '0')}`) },
  { id: 'sessions', label: '考试与教师', files: ['midterm_exam', 'final_exam', 'brownell', 'chun'] },
  { id: 'transcripts', label: '讲座文字稿', files: ['transcript01'] },
]
const GROUP_OF = new Map()
for (const group of GROUPS) for (const file of group.files) GROUP_OF.set(file, group.id)

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inline(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

function mdToHtml(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const html = []
  let paragraph = []
  let list = []
  const flushParagraph = () => {
    if (paragraph.length === 0) return
    html.push(`<p>${inline(paragraph.join(' ').trim())}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (list.length === 0) return
    html.push('<ul>' + list.map((item) => `<li>${inline(item)}</li>`).join('') + '</ul>')
    list = []
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1].length
      html.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`)
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph()
      list.push(bullet[1].trim())
      continue
    }
    flushList()
    paragraph.push(line.trim())
  }
  flushParagraph()
  flushList()
  return html.join('\n')
}

function titleOf(markdown, fallback) {
  const GENERIC = /^(Open Yale Courses|耶鲁公开课)\s*$/i
  const COURSE = /^PSYC\s*110\s*[:：]/i
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    const text = heading ? heading[1].trim() : line
    if (!text) continue
    if (GENERIC.test(text) || COURSE.test(text)) continue
    if (text.startsWith('<<') || text.startsWith('上一') || text.startsWith('下一')) continue
    if (text.length > 90) continue
    return text
  }
  return fallback
}

function page(title, body, navHtml) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 780px; margin: 0 auto; padding: 36px 22px 80px; font: 17px/1.85 -apple-system, "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 1.7em; line-height: 1.35; } h2 { font-size: 1.35em; margin-top: 1.6em; }
  h3 { font-size: 1.12em; margin-top: 1.3em; } p { margin: .85em 0; }
  ul { padding-left: 1.3em; } li { margin: .3em 0; }
  nav { margin-bottom: 28px; font-size: .92em; display: flex; gap: 14px; flex-wrap: wrap; }
  a { color: #2563eb; text-decoration: none; } a:hover { text-decoration: underline; }
  footer { margin-top: 48px; font-size: .85em; opacity: .65; }
</style>
</head>
<body>
<nav>${navHtml}</nav>
<article>
${body}
</article>
<footer>本页由 dsh-local-delegate 插件在内网 Ollama（gemma4:e2b）上翻译；机器翻译结果，专业术语可能有偏差。</footer>
</body>
</html>
`
}

const files = (await fs.readdir(SRC)).filter((name) => name.endsWith('.local.md')).sort()
const pages = []
for (const file of files) {
  const base = file.replace(/\.local\.md$/, '')
  const markdown = await fs.readFile(nodePath.join(SRC, file), 'utf8')
  const title = titleOf(markdown, base)
  const group = GROUP_OF.get(base) ?? 'overview'
  pages.push({ base, title, group, markdown })
}

await fs.mkdir(OUT, { recursive: true })
const indexLinks = []
for (const entry of pages) {
  const html = mdToHtml(entry.markdown)
  const fileName = `${entry.base}.html`
  await fs.writeFile(nodePath.join(OUT, fileName), page(entry.title, html, '<a href="index.html">← 返回目录</a>'), 'utf8')
  await fs.writeFile(nodePath.join(OUT, `${entry.base}.md`), entry.markdown, 'utf8')
  indexLinks.push({ ...entry, fileName })
}

const sections = []
for (const group of GROUPS) {
  const items = indexLinks.filter((entry) => entry.group === group.id)
  if (items.length === 0) continue
  sections.push(
    `<h2>${group.label}</h2>\n<ul>\n${items
      .map((entry) => `<li><a href="${entry.fileName}">${escapeHtml(entry.title)}</a></li>`)
      .join('\n')}\n</ul>`,
  )
}

const indexHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>心理学导论（PSYC 110）中文译本</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 780px; margin: 0 auto; padding: 44px 22px 80px; font: 17px/1.8 -apple-system, "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 1.8em; line-height: 1.3; } h2 { font-size: 1.2em; margin-top: 1.8em; border-bottom: 1px solid rgba(127,127,127,.3); padding-bottom: .25em; }
  ul { padding-left: 1.3em; } li { margin: .35em 0; }
  a { color: #2563eb; text-decoration: none; } a:hover { text-decoration: underline; }
  footer { margin-top: 48px; font-size: .85em; opacity: .65; }
</style>
</head>
<body>
<h1>心理学导论（PSYC 110）中文译本</h1>
<p>Open Yale Courses 课程包的中文机翻译本：课程总览、20 讲摘要、考试信息与讲座文字稿。由 <code>dsh-local-delegate</code> 插件在内网 Ollama 上的 <code>gemma4:e2b</code> 模型完成翻译，主模型（deepseek-flash）只负责调度与校验。</p>
${sections.join('\n')}
<footer>机器翻译结果，专业术语可能有偏差；原文版权归 Yale University 所有（CC BY-NC-SA 3.0）。</footer>
</body>
</html>
`
await fs.writeFile(nodePath.join(OUT, 'index.html'), indexHtml, 'utf8')
console.log(`built ${indexLinks.length} pages -> ${OUT}`)
