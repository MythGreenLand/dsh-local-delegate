/**
 * Safety guards: path containment, denied-path globs, high-confidence secret
 * detection, and atomic output writes.
 */
import { promises as fsp, lstatSync, realpathSync, statSync } from 'node:fs'
import nodePath from 'node:path'

const GLOB_CACHE = new Map()
const WINDOWS = process.platform === 'win32'

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

/**
 * Resolve an existing path to its real target so a symlink cannot move the
 * check outside the workspace. Nonexistent paths keep their lexical form; the
 * caller reports the missing-file error.
 */
export function canonicalExistingPath(value) {
  const resolved = nodePath.resolve(String(value))
  try {
    return nodePath.normalize(realpathSync.native(resolved))
  } catch {
    return resolved
  }
}

/**
 * Resolve the parent chain of a path that may not exist yet (an output file).
 * Existing symlinked directories are followed to their real target, so a
 * symlinked `out_dir` cannot redirect the write outside the workspace.
 */
export function canonicalWritePath(value) {
  const resolved = nodePath.resolve(String(value))
  // An existing directory (including a junction/symlink to one) is the write
  // destination itself, so resolve it rather than appending it to its parent.
  try {
    const link = lstatSync(resolved)
    if (link.isDirectory()) return nodePath.normalize(realpathSync.native(resolved))
    if (link.isSymbolicLink()) {
      try {
        if (statSync(resolved).isDirectory()) return nodePath.normalize(realpathSync.native(resolved))
      } catch {
        /* broken link: fall through to the parent-chain check */
      }
    }
  } catch {
    /* target does not exist yet */
  }
  let current = nodePath.dirname(resolved)
  const missing = [nodePath.basename(resolved)]
  for (;;) {
    try {
      lstatSync(current)
      return nodePath.join(canonicalExistingPath(current), ...missing)
    } catch {
      const parent = nodePath.dirname(current)
      if (parent === current) return nodePath.join(current, ...missing)
      missing.unshift(nodePath.basename(current))
      current = parent
    }
  }
}

/** Denied-path test on both the workspace-relative and absolute POSIX forms. */
export function matchesDeniedPath(cwd, target, globs) {
  // Windows paths are case-insensitive, so `.ENV` and `.env` are the same file.
  const fold = (value) => (WINDOWS ? String(value).toLowerCase() : String(value))
  const absolute = fold(String(target).split(nodePath.sep).join('/'))
  const relative = fold(nodePath.relative(cwd, target).split(nodePath.sep).join('/'))
  return (globs || []).some((glob) => {
    if (!glob) return false
    const pattern = fold(WINDOWS ? String(glob).replace(/\\/g, '/') : String(glob))
    const regex = globToRegExp(pattern)
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
