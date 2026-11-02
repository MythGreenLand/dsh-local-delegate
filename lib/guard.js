/**
 * Safety guards: path containment, denied-path globs, high-confidence secret
 * detection, and atomic output writes.
 */
import { promises as fsp } from 'node:fs'
import nodePath from 'node:path'

const GLOB_CACHE = new Map()

/** Convert a small glob dialect (`**`, `*`, `?`) into an anchored RegExp. */
export function globToRegExp(glob) {
  const key = String(glob)
  const cached = GLOB_CACHE.get(key)
  if (cached) return cached
  let out = '^'
  for (let index = 0; index < key.length; index += 1) {
    const char = key[index]
    if (char === '*') {
      if (key[index + 1] === '*') {
        index += 1
        if (key[index + 1] === '/') {
          index += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      out += '\\' + char
    } else {
      out += char
    }
  }
  out += '$'
  const compiled = new RegExp(out)
  GLOB_CACHE.set(key, compiled)
  return compiled
}

/** Resolve a user-supplied path against the session working directory. */
export function resolveFrom(cwd, target) {
  return nodePath.resolve(cwd, String(target))
}

/** Whether `target` stays inside `root`. */
export function isInside(root, target) {
  const relative = nodePath.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !nodePath.isAbsolute(relative))
}

/** Denied-path test on both the workspace-relative and absolute POSIX forms. */
export function matchesDeniedPath(cwd, target, globs) {
  const absolute = String(target).split(nodePath.sep).join('/')
  const relative = nodePath.relative(cwd, target).split(nodePath.sep).join('/')
  return (globs || []).some((glob) => {
    if (!glob) return false
    const regex = globToRegExp(glob)
    return regex.test(relative) || regex.test(absolute)
  })
}

const SECRET_PATTERNS = [
  { name: 'private key block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'API key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'JSON Web Token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'password assignment', regex: /\bpassword\s*[:=]\s*['"]?[^\s'"`]{8,}/i },
]

/**
 * Detect high-confidence credential material that must not be sent to a
 * separate model endpoint.
 * @param {string} text candidate payload.
 * @returns {{name:string}|null} the first matching pattern, or null.
 */
export function findSecret(text) {
  const value = String(text ?? '')
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(value)) return { name: pattern.name }
  }
  return null
}

/** Default output path: insert `.local` before the extension (`a.md` -> `a.local.md`). */
export function defaultOutputPath(sourcePath) {
  const parsed = nodePath.parse(sourcePath)
  return nodePath.join(parsed.dir, `${parsed.name}.local${parsed.ext}`)
}

/** Write through a temporary sibling and replace atomically where possible. */
export async function atomicWrite(target, content) {
  await fsp.mkdir(nodePath.dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(temporary, content, 'utf8')
  try {
    await fsp.rename(temporary, target)
  } catch {
    await fsp.rm(target, { force: true })
    await fsp.rename(temporary, target)
  }
}

/** Human-readable byte count. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
