// Extract human-visible text from a course's HTML pages into Markdown-ish files.
// Usage: node extract-html.mjs <srcRoot> <outRoot>
// Keeps headings, paragraphs, list items and table cells; drops script/style/head/nav-JS.
import { promises as fs } from 'node:fs'
import nodePath from 'node:path'

const SRC = nodePath.resolve(process.argv[2] ?? '.')
const OUT = nodePath.resolve(process.argv[3] ?? '.l10n-src')

const SKIP_TREE = ['IMS']
const SKIP_FILES = new Set(['terms-of-use.html'])

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'br', 'dd', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'html', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const SKIP_TAGS = new Set(['script', 'style', 'head', 'noscript', 'iframe', 'object', 'embed', 'svg'])

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷', eacute: 'é', egrave: 'è',
}

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : match
  })
}

function tagInfo(raw) {
  const inner = raw.slice(1, -1).trim()
  const closing = inner.startsWith('/')
  const selfClosing = inner.endsWith('/')
  const name = (closing ? inner.slice(1) : inner).split(/[\s/>]/)[0].toLowerCase()
  return { name, closing, selfClosing }
}

function blocksToMarkdown(html) {
  const parts = html.split(/(<!--[\s\S]*?-->|<[^>]+>)/)
  const blocks = []
  let current = ''
  let prefix = ''
  const skipStack = []

  const flush = () => {
    const text = current.replace(/\s+/g, ' ').trim()
    current = ''
    if (!text) return
    blocks.push((prefix + text).trimEnd())
    prefix = ''
  }

  for (const part of parts) {
    if (part.startsWith('<!--')) continue
    if (part.startsWith('<')) {
      const { name, closing, selfClosing } = tagInfo(part)
      if (SKIP_TAGS.has(name)) {
        if (!closing && !selfClosing) skipStack.push(name)
        else if (closing && skipStack[skipStack.length - 1] === name) skipStack.pop()
        continue
      }
      if (skipStack.length > 0) continue
      if (!BLOCK_TAGS.has(name)) continue
      if (closing || selfClosing) {
        flush()
        continue
      }
      flush()
      if (HEADING_TAGS.has(name)) prefix = '#'.repeat(Number(name[1])) + ' '
      else if (name === 'li') prefix = '- '
      else prefix = ''
      continue
    }
    if (skipStack.length > 0) continue
    current += decodeEntities(part)
  }
  flush()

  // Collapse repeated blank-ish structures and drop boilerplate-only lines.
  const cleaned = []
  for (const block of blocks) {
    if (!block) continue
    if (!block.replace(/^[#\-\s]+/, '').trim()) continue
    cleaned.push(block)
  }
  return cleaned.join('\n\n')
}

function titleOf(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!match) return ''
  return decodeEntities(match[1]).replace(/\s+/g, ' ').trim()
}

async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = nodePath.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_TREE.includes(entry.name)) continue
      yield* walk(full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

let converted = 0
let chars = 0
const files = []
for await (const file of walk(SRC)) {
  if (!file.toLowerCase().endsWith('.html')) continue
  const relative = nodePath.relative(SRC, file)
  if (SKIP_FILES.has(nodePath.basename(file).toLowerCase())) continue
  const html = await fs.readFile(file, 'utf8')
  const markdown = blocksToMarkdown(html)
  if (!markdown.trim()) continue
  const title = titleOf(html)
  const body = title && !markdown.startsWith('# ') ? `# ${title}\n\n${markdown}` : markdown
  const target = nodePath.join(OUT, relative.replace(/\.html$/i, '.md'))
  await fs.mkdir(nodePath.dirname(target), { recursive: true })
  await fs.writeFile(target, body.trimEnd() + '\n', 'utf8')
  converted += 1
  chars += body.length
  files.push({ relative, markdown: body.length })
}

files.sort((a, b) => a.relative.localeCompare(b.relative))
for (const file of files) console.log(`${String(file.markdown).padStart(7)} chars  ${file.relative.replace(/\.html$/i, '.md')}`)
console.log(`\nconverted ${converted} files, ${chars} chars total -> ${OUT}`)
