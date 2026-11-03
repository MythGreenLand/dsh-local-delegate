/**
 * dsh-local-delegate — delegate mechanical text work to a local cheap model.
 *
 * The main agent keeps every judgement and tool call; only text transformations
 * whose content the main model does not need to understand are executed by a
 * local model (Ollama native API or any OpenAI-compatible endpoint). Content is
 * passed as FILE PATHS, read and written by this Host plugin, so the source text
 * never enters the parent conversation. That difference is what turns a large
 * translation from a five-thousand-token main-model turn into a two-hundred-token
 * call.
 *
 * Reliability features: a primary endpoint plus ordered fallbacks, one bounded
 * retry for transport errors, a startup probe with actionable log lines, a
 * runtime-context availability line, and `/localdoctor` diagnostics.
 *
 * @module dsh-local-delegate
 */
import nodePath from 'node:path'
import { promises as fsp } from 'node:fs'
import { callModel, probeEndpoint, endpointLabel, isRetryableEndpointError } from './lib/endpoint.js'
import { splitText, joinChunks } from './lib/chunker.js'
import {
  resolveFrom,
  isInside,
  matchesDeniedPath,
  findSecret,
  defaultOutputPath,
  atomicWrite,
  formatBytes,
} from './lib/guard.js'
import { createStats, recordSuccess, recordFailure, renderStats } from './lib/stats.js'
import {
  Config,
  configWarnings,
  endpointChain,
  endpointSummaryText,
  modelForEndpoint,
  readConfig,
} from './lib/config.js'
import { createApiHandler, withResolvedKey } from './lib/api.js'
import { levelOfAgent } from './lib/levels.js'
import { createSlaveTeamsService, startSlaveActivation } from './lib/slaves.js'
import { createLevelsPolicy } from './lib/policy.js'

export { Config }

export const name = 'local-delegate'
export const inject = ['tools']

/** Reported by local_health, /localdoctor, the startup log line, and the GUI. */
const PLUGIN_VERSION = '0.4.1'

const TASKS = ['translate', 'summarize', 'extract', 'classify', 'rewrite', 'commit_message', 'names']


function hostOf(baseURL) {
  try {
    return new URL(baseURL).host
  } catch {
    return String(baseURL)
  }
}

function endpointSummary(entry) {
  if (!entry) return null
  return {
    kind: entry.endpoint.kind,
    baseURL: entry.endpoint.baseURL,
    model: entry.model ?? entry.endpoint.model ?? '',
    reachable: entry.probe?.ok === true,
    model_found: entry.probe?.modelFound === true,
    latency_ms: entry.probe?.latencyMs ?? null,
    error: entry.probe?.error ?? null,
  }
}

function targetLanguageOf(args) {
  const value = typeof args.target_language === 'string' ? args.target_language.trim() : ''
  return value || 'Simplified Chinese'
}

function buildPrompt(task, chunk, options) {
  const language = options.targetLanguage
  switch (task) {
    case 'translate':
      return {
        system:
          `You are a translation engine. Translate the user's text into ${language}. ` +
          'Return only the translation; preserve Markdown formatting, code blocks, URLs and inline code exactly. ' +
          'Do not add notes, explanations, or the source text.',
        user: chunk,
      }
    case 'summarize':
      return {
        system:
          `You are a summarization engine. Summarize the user's text in ${language}. ` +
          'Keep key facts, numbers, names and decisions; drop boilerplate. Return only the summary (about 200 words at most).',
        user: chunk,
      }
    case 'extract':
      return {
        system:
          `You are an extraction engine. Extract only what this instruction asks for from the user's text: ` +
          `${options.instructions || 'key facts'}. Return a concise plain-text list; no commentary.`,
        user: chunk,
      }
    case 'classify':
      return {
        system:
          `You are a classifier. Assign the user's text to exactly one label from: ` +
          `${options.instructions || 'positive, negative, neutral'}. Return only the label.`,
        user: chunk,
      }
    case 'rewrite':
      return {
        system:
          `You are a rewriting engine. Rewrite the user's text following this instruction: ` +
          `${options.instructions || 'make it clearer and more concise'}. Return only the rewritten text.`,
        user: chunk,
      }
    case 'commit_message':
      return {
        system:
          'You are a git commit message generator. Produce a Conventional Commits message for the user\'s diff: ' +
          'a subject line of at most 72 characters and, when useful, a body wrapped at 72 columns. Return only the message.',
        user: chunk,
      }
    case 'names':
      return {
        system:
          'You are a naming assistant. Propose 5 concise candidate names for the user\'s description, ' +
          'one per line, no commentary.',
        user: chunk,
      }
    default:
      throw new Error(`LOCAL_TASK_INVALID: expected one of ${TASKS.join(', ')}`)
  }
}

async function runLimited(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const size = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assertRate(runtime) {
  const now = Date.now()
  const cutoff = now - 60_000
  runtime.rate = runtime.rate.filter((time) => time > cutoff)
  if (runtime.rate.length >= runtime.config.maxCallsPerMinute) {
    throw new Error(
      `LOCAL_RATE_LIMITED: more than ${runtime.config.maxCallsPerMinute} local model requests in a minute; ` +
        'wait or raise maxCallsPerMinute, and do the remaining work yourself for now',
    )
  }
  runtime.rate.push(now)
}

function abortedError(signal) {
  const error = new Error('local model request aborted by the caller')
  error.code = 'LOCAL_ABORTED'
  return error
}

/**
 * Run one model request over the endpoint chain: primary first, then each
 * fallback. Transport-level failures get a bounded retry; HTTP 4xx and guard
 * failures move straight to the next endpoint (or fail loudly).
 */
async function callWithFallback(runtime, request) {
  const config = runtime.config
  const chain = endpointChain(config)
  const errors = []
  for (const endpoint of chain) {
    if (request.signal?.aborted) throw abortedError(request.signal)
    const model = modelForEndpoint(config, endpoint, request.task)
    const attempts = 1 + config.retries
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      assertRate(runtime)
      try {
        const result = await callModel({
          endpoint: withResolvedKey(endpoint),
          model,
          system: request.system,
          user: request.user,
          maxOutputTokens: request.maxOutputTokens,
          signal: request.signal,
        })
        return {
          ...result,
          model,
          endpoint,
          endpointLabel: endpointLabel(endpoint, model),
          fallback: endpoint !== config.endpoint,
        }
      } catch (error) {
        lastError = error
        if (error?.code === 'LOCAL_ABORTED' || request.signal?.aborted) throw abortedError(request.signal)
        const retryable = isRetryableEndpointError(error)
        if (!retryable || attempt === attempts) break
        await sleep(350 * attempt)
      }
    }
    errors.push(`${endpointLabel(endpoint, model)}: ${String(lastError?.message ?? lastError)}`)
  }
  throw new Error(`LOCAL_UNAVAILABLE: every configured endpoint failed — ${errors.join(' | ')}`)
}

/** Probe the primary endpoint and every fallback; derive the effective status. */
async function refreshHealth(runtime) {
  const config = runtime.config
  const results = []
  for (const endpoint of endpointChain(config)) {
    const model = String(endpoint.model || config.endpoint.model || '')
    let probe
    try {
      probe = await probeEndpoint({ endpoint: withResolvedKey(endpoint), model })
    } catch (error) {
      probe = { ok: false, latencyMs: 0, modelFound: false, models: [], error: String(error?.message ?? error) }
    }
    results.push({ endpoint, model, probe })
  }
  const primary = results[0]
  const primaryOk = primary?.probe?.ok === true
  const fallbackOk = results.slice(1).find((entry) => entry.probe.ok) ?? null
  runtime.health = {
    status: primaryOk ? 'available' : fallbackOk ? 'degraded' : 'unavailable',
    checkedAt: Date.now(),
    primary: primary ?? null,
    fallbacks: results.slice(1),
    effective: primaryOk ? primary : fallbackOk,
    error: primary?.probe?.error ?? null,
  }
  return runtime.health
}

async function sessionCwd(ctx, exec) {
  const directories = ctx.get('workingDirectory')
  if (directories) {
    if (exec.agent) {
      try {
        return await directories.ensure(exec.agent, exec.signal)
      } catch {
        /* fall through to the configured default */
      }
    }
    if (typeof directories.defaultDirectory === 'string' && directories.defaultDirectory) return directories.defaultDirectory
  }
  return process.cwd()
}

function allowedRoots(config, cwd) {
  const roots = [cwd]
  for (const entry of config.allowRoots) {
    if (!entry) continue
    roots.push(nodePath.isAbsolute(entry) ? nodePath.normalize(entry) : nodePath.resolve(cwd, entry))
  }
  return roots
}

/** Show a workspace-relative path when inside the working directory, else the absolute path. */
function displayPath(cwd, absolute) {
  const relative = nodePath.relative(cwd, absolute)
  if (!relative || relative.startsWith('..') || nodePath.isAbsolute(relative)) return absolute
  return relative.split(nodePath.sep).join('/')
}

function resolveCheckedPath(config, cwd, target, label) {
  const absolute = resolveFrom(cwd, target)
  const roots = allowedRoots(config, cwd)
  const inside = config.allowOutsideCwd || roots.some((root) => isInside(root, absolute))
  if (!inside) {
    throw new Error(
      `LOCAL_PATH_OUTSIDE_WORKSPACE: ${label} "${target}" is outside the allowed roots. ` +
        `Use working_directory to cd into that folder, or add its parent directory to "allowRoots" ` +
        `in the local-delegate config. Allowed roots: ${roots.join(', ')}`,
    )
  }
  if (matchesDeniedPath(cwd, absolute, config.denyGlobs)) {
    throw new Error(`LOCAL_PATH_DENIED: ${label} "${target}" matches a denied path pattern (${config.denyGlobs.join(', ')})`)
  }
  return absolute
}

/**
 * Defense-in-depth level guard for the local_* tools.
 *
 * The scoped policy (lib/policy.js) already hides/blocks tools per level; this
 * check runs inside each tool so a missing or stale scoped layer (custom preset,
 * agent created before the policy, `levelsEnabled` changed without reinstall)
 * cannot silently bypass L0/L1. Unknown agents resolve to null and are not
 * guarded — behavior must stay identical to v0.3 when levels are default.
 */
function localLevelFor(ctx, config, exec) {
  if (!exec || !exec.agent) return null
  try {
    const workspaceRegistry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    const info = levelOfAgent({ config, workspaceRegistry, agent: exec.agent })
    return info && typeof info.level === 'string' ? info : null
  } catch {
    return null
  }
}

function levelError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

/** Run one transform over already-chunked text; returns the assembled result. */
async function transformText(runtime, task, text, options, signal) {
  const config = runtime.config
  const chunks = splitText(text, config.chunkChars)
  if (chunks.length === 0) {
    return { text: '', chunks: 0, promptTokens: 0, completionTokens: 0, model: '', endpoint: null, fallback: false }
  }

  const outputs = await runLimited(chunks, config.maxConcurrency, async (chunk) => {
    const prompt = buildPrompt(task, chunk, options)
    return callWithFallback(runtime, {
      task,
      system: prompt.system,
      user: prompt.user,
      maxOutputTokens: options.maxOutputTokens,
      signal,
    })
  })

  const promptTokens = outputs.reduce((sum, entry) => sum + (entry.promptTokens || 0), 0)
  const completionTokens = outputs.reduce((sum, entry) => sum + (entry.completionTokens || 0), 0)
  const last = outputs[outputs.length - 1]
  let assembled = joinChunks(outputs.map((entry) => entry.text))

  // A multi-chunk summary is a reduce, not a concatenation.
  if (task === 'summarize' && chunks.length > 1 && assembled.length > 0) {
    const reduce = await callWithFallback(runtime, {
      task,
      system: `You are a summarization engine. Merge the section summaries into one coherent summary in ${options.targetLanguage}. Return only the summary.`,
      user: assembled,
      maxOutputTokens: options.maxOutputTokens,
      signal,
    })
    assembled = reduce.text
    last.endpointLabel = reduce.endpointLabel
    last.fallback = last.fallback || reduce.fallback
  }

  return {
    text: assembled,
    chunks: chunks.length,
    promptTokens,
    completionTokens,
    model: last.model,
    endpoint: last.endpointLabel,
    fallback: outputs.some((entry) => entry.fallback) || last.fallback,
  }
}

export async function executeTransform(runtime, ctx, exec, args) {
  const config = runtime.refresh ? runtime.refresh() : runtime.config
  if (!config.enabled) throw new Error('LOCAL_DISABLED: the local-delegate plugin is disabled (enabled=false)')
  const level = localLevelFor(ctx, config, exec)
  if (level?.level === 'none') {
    throw levelError(
      'LOCAL_LEVEL_DISABLED',
      'this workspace is set to level "none", so local_transform is disabled here; complete the work yourself without the local model',
    )
  }
  const task = typeof args.task === 'string' ? args.task : ''
  if (!TASKS.includes(task)) {
    throw new Error(`LOCAL_TASK_INVALID: "task" must be one of ${TASKS.join(', ')}`)
  }
  const hasPath = typeof args.path === 'string' && args.path.trim() !== ''
  const hasText = typeof args.text === 'string' && args.text.length > 0
  if (hasPath === hasText) {
    throw new Error('LOCAL_SOURCE_INVALID: provide exactly one of "path" (preferred) or "text"')
  }
  if (level?.level === 'light' && hasText) {
    throw levelError(
      'LOCAL_LEVEL_GUARD',
      `this workspace is at level "light", which only delegates files of at least ${config.lightMinChars} characters; ` +
        'inline text is not allowed here. Write the text to a file and pass "path", or do the work yourself',
    )
  }
  if (task === 'translate' && !(typeof args.target_language === 'string' && args.target_language.trim())) {
    throw new Error('LOCAL_TARGET_LANGUAGE_REQUIRED: task "translate" requires "target_language"')
  }
  const options = {
    targetLanguage: targetLanguageOf(args),
    instructions: typeof args.instructions === 'string' ? args.instructions : '',
    maxOutputTokens:
      Number.isFinite(Number(args.max_output_tokens)) && Number(args.max_output_tokens) > 0
        ? Math.floor(Number(args.max_output_tokens))
        : undefined,
  }
  const cwd = await sessionCwd(ctx, exec)
  const started = Date.now()

  if (hasPath) {
    const sourcePath = resolveCheckedPath(config, cwd, args.path, 'path')
    const stat = await fsp.stat(sourcePath).catch(() => undefined)
    if (!stat || !stat.isFile()) throw new Error(`LOCAL_SOURCE_MISSING: "${args.path}" is not a readable file`)
    if (level?.level === 'light' && stat.size < config.lightMinChars) {
      throw levelError(
        'LOCAL_LEVEL_GUARD',
        `this workspace is at level "light", which only delegates files of at least ${config.lightMinChars} characters ` +
          `("${args.path}" is ${stat.size}); do this one yourself or switch the workspace level`,
      )
    }
    if (stat.size > config.maxSourceChars) {
      throw new Error(
        `LOCAL_SOURCE_TOO_LARGE: "${args.path}" is ${formatBytes(stat.size)}; the limit is ${formatBytes(config.maxSourceChars)}. ` +
          'Split the work into smaller files or raise maxSourceChars.',
      )
    }
    const text = await fsp.readFile(sourcePath, 'utf8')
    const secret = findSecret(text)
    if (secret) {
      throw new Error(
        `LOCAL_SECRET_REFUSED: "${args.path}" looks like it contains a ${secret.name}; do not send credentials to the local model. ` +
          'Handle this file yourself or redact it first.',
      )
    }
    const outputPath = args.out_path
      ? resolveCheckedPath(config, cwd, args.out_path, 'out_path')
      : resolveCheckedPath(config, cwd, nodePath.relative(cwd, defaultOutputPath(sourcePath)), 'out_path')
    const result = await transformText(runtime, task, text, options, exec.signal)
    if (!result.text.trim()) throw new Error('LOCAL_EMPTY_OUTPUT: the local model returned empty output; do the work yourself')
    await atomicWrite(outputPath, result.text)
    const durationMs = Date.now() - started
    recordSuccess(runtime.stats, {
      task,
      charsIn: text.length,
      charsOut: result.text.length,
      chunkCalls: result.chunks,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      endpoint: result.endpoint,
    })
    return {
      ok: true,
      mode: 'file',
      task,
      model: result.model,
      endpoint: result.endpoint,
      used_fallback: result.fallback,
      source: args.path,
      output_path: displayPath(cwd, outputPath),
      chunks: result.chunks,
      chars_in: text.length,
      chars_out: result.text.length,
      local_tokens: result.promptTokens + result.completionTokens,
      duration_ms: durationMs,
      preview: result.text.slice(0, 240),
    }
  }

  if (args.text.length > config.maxInlineChars) {
    throw new Error(
      `LOCAL_INLINE_TOO_LARGE: inline text is ${args.text.length} chars; the limit is ${config.maxInlineChars}. ` +
        'Write it to a file and call this tool with "path" instead — pasted text costs main-model output tokens.',
    )
  }
  const secret = findSecret(args.text)
  if (secret) {
    throw new Error(`LOCAL_SECRET_REFUSED: the text looks like it contains a ${secret.name}; do not send credentials to the local model.`)
  }
  const result = await transformText(runtime, task, args.text, options, exec.signal)
  if (!result.text.trim()) throw new Error('LOCAL_EMPTY_OUTPUT: the local model returned empty output; do the work yourself')
  const durationMs = Date.now() - started
  recordSuccess(runtime.stats, {
    task,
    charsIn: args.text.length,
    charsOut: result.text.length,
    chunkCalls: result.chunks,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    endpoint: result.endpoint,
  })
  const truncated =
    result.text.length > config.maxResultChars
      ? result.text.slice(0, config.maxResultChars) +
        `\n…[truncated ${result.text.length - config.maxResultChars} chars — use file mode for full output]`
      : result.text
  return {
    ok: true,
    mode: 'inline',
    task,
    model: result.model,
    endpoint: result.endpoint,
    used_fallback: result.fallback,
    chunks: result.chunks,
    chars_in: args.text.length,
    chars_out: result.text.length,
    local_tokens: result.promptTokens + result.completionTokens,
    duration_ms: durationMs,
    text: truncated,
  }
}

export async function executeBatch(runtime, ctx, exec, args) {
  const config = runtime.refresh ? runtime.refresh() : runtime.config
  if (!config.enabled) throw new Error('LOCAL_DISABLED: the local-delegate plugin is disabled (enabled=false)')
  const level = localLevelFor(ctx, config, exec)
  if (level?.level === 'none') {
    throw levelError(
      'LOCAL_LEVEL_DISABLED',
      'this workspace is set to level "none", so local_batch is disabled here; complete the work yourself without the local model',
    )
  }
  const task = typeof args.task === 'string' ? args.task : ''
  if (!TASKS.includes(task)) throw new Error(`LOCAL_TASK_INVALID: "task" must be one of ${TASKS.join(', ')}`)
  const paths = Array.isArray(args.paths) ? args.paths.filter((entry) => typeof entry === 'string' && entry.trim() !== '') : []
  if (paths.length === 0) throw new Error('LOCAL_PATHS_REQUIRED: provide a non-empty "paths" array')
  if (paths.length > config.maxBatchFiles) {
    throw new Error(`LOCAL_BATCH_TOO_LARGE: ${paths.length} files; the limit is ${config.maxBatchFiles}. Split the batch.`)
  }
  const dryRun = args.dry_run !== false
  if (level?.level === 'light' && !dryRun && paths.length < config.lightMinFiles) {
    throw levelError(
      'LOCAL_LEVEL_GUARD',
      `this workspace is at level "light", which only executes batches of at least ${config.lightMinFiles} files ` +
        `(${paths.length} requested); dry runs are allowed. Add more files, do the work yourself, or switch the workspace level`,
    )
  }
  if (task === 'translate' && !(typeof args.target_language === 'string' && args.target_language.trim())) {
    throw new Error('LOCAL_TARGET_LANGUAGE_REQUIRED: task "translate" requires "target_language"')
  }
  const options = {
    targetLanguage: targetLanguageOf(args),
    instructions: typeof args.instructions === 'string' ? args.instructions : '',
    maxOutputTokens: undefined,
  }
  const cwd = await sessionCwd(ctx, exec)
  const files = []
  for (const target of paths) {
    const absolute = resolveCheckedPath(config, cwd, target, 'paths')
    const stat = await fsp.stat(absolute).catch(() => undefined)
    if (!stat || !stat.isFile()) throw new Error(`LOCAL_SOURCE_MISSING: "${target}" is not a readable file`)
    files.push({ input: target, absolute, size: stat.size })
  }
  const totalChars = files.reduce((sum, entry) => sum + entry.size, 0)
  if (totalChars > config.maxBatchChars) {
    throw new Error(
      `LOCAL_BATCH_TOO_LARGE: ${formatBytes(totalChars)} total; the limit is ${formatBytes(config.maxBatchChars)}. Split the batch.`,
    )
  }
  const outDir = args.out_dir
    ? resolveCheckedPath(config, cwd, args.out_dir, 'out_dir')
    : nodePath.join(cwd, '.local-out')
  const relativeOut = displayPath(cwd, outDir)

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      task,
      model: modelForEndpoint(config, config.endpoint, task),
      files: files.map((entry) => ({ path: entry.input, bytes: entry.size })),
      total_chars: totalChars,
      out_dir: relativeOut,
      note: 'dry run: nothing was written. Call again with dry_run=false to execute.',
    }
  }

  const started = Date.now()
  const written = []
  const failed = []
  const endpoints = new Set()
  let usedFallback = false
  let charsIn = 0
  let charsOut = 0
  let promptTokens = 0
  let completionTokens = 0
  let chunks = 0

  for (const entry of files) {
    try {
      if (entry.size > config.maxSourceChars) {
        throw new Error(`file is ${formatBytes(entry.size)}, over the per-file limit ${formatBytes(config.maxSourceChars)}`)
      }
      const text = await fsp.readFile(entry.absolute, 'utf8')
      const secret = findSecret(text)
      if (secret) throw new Error(`contains a ${secret.name}; refused`)
      const result = await transformText(runtime, task, text, options, exec.signal)
      if (!result.text.trim()) throw new Error('empty model output')
      const outputPath = nodePath.join(outDir, nodePath.basename(defaultOutputPath(entry.absolute)))
      await atomicWrite(outputPath, result.text)
      written.push(displayPath(cwd, outputPath))
      charsIn += text.length
      charsOut += result.text.length
      promptTokens += result.promptTokens
      completionTokens += result.completionTokens
      chunks += result.chunks
      if (result.endpoint) endpoints.add(result.endpoint)
      usedFallback = usedFallback || result.fallback === true
    } catch (error) {
      failed.push({ path: entry.input, reason: String(error?.message ?? error).slice(0, 240) })
    }
  }

  if (written.length > 0) {
    recordSuccess(runtime.stats, {
      task,
      charsIn,
      charsOut,
      chunkCalls: chunks,
      promptTokens,
      completionTokens,
      endpoint: endpoints.size === 1 ? [...endpoints][0] : [...endpoints].join(', '),
    })
  }
  if (failed.length > 0) recordFailure(runtime.stats, task, `${failed.length} file(s) failed`)

  return {
    ok: failed.length === 0,
    dry_run: false,
    task,
    model: modelForEndpoint(config, config.endpoint, task),
    endpoints: [...endpoints],
    used_fallback: usedFallback,
    processed: written.length,
    failed: failed.length,
    written,
    failures: failed,
    chars_in: charsIn,
    chars_out: charsOut,
    local_tokens: promptTokens + completionTokens,
    duration_ms: Date.now() - started,
  }
}

/* ── rendering ─────────────────────────────────────────────────────────── */

function receiptText(value) {
  const lines = []
  if (!value || typeof value !== 'object') return String(value)
  lines.push(`local ${value.task}: ${value.mode} mode, model ${value.model}`)
  if (value.endpoint) lines.push(`endpoint: ${value.endpoint}${value.used_fallback ? ' (fallback)' : ''}`)
  if (value.source) lines.push(`source: ${value.source}`)
  if (value.output_path) lines.push(`output: ${value.output_path}`)
  if (value.mode === 'file') {
    lines.push(`${value.chunks} chunk(s), ${value.chars_in} chars in -> ${value.chars_out} chars out, ${value.local_tokens} local tokens, ${value.duration_ms}ms`)
    if (value.preview) lines.push(`preview: ${String(value.preview).replace(/\s+/g, ' ').slice(0, 240)}`)
  } else if (typeof value.text === 'string') {
    lines.push(`${value.chunks} chunk(s), ${value.local_tokens} local tokens, ${value.duration_ms}ms`)
    lines.push(value.text)
  }
  return lines.join('\n')
}

function batchText(value) {
  if (!value || typeof value !== 'object') return String(value)
  if (value.dry_run) {
    return [
      `local_batch dry run: ${value.task}, model ${value.model}`,
      `${value.files.length} file(s), ${value.total_chars} chars total, output dir ${value.out_dir}`,
      'Files: ' + value.files.map((entry) => `${entry.path} (${entry.bytes} B)`).join(', '),
      value.note,
    ].join('\n')
  }
  const lines = [
    `local_batch ${value.task}: ${value.processed} processed, ${value.failed} failed, model ${value.model}`,
    `${value.chars_in} chars in -> ${value.chars_out} chars out, ${value.local_tokens} local tokens, ${value.duration_ms}ms`,
  ]
  if (value.endpoints?.length > 0) lines.push(`endpoints: ${value.endpoints.join(', ')}${value.used_fallback ? ' (fallback used)' : ''}`)
  if (value.written.length > 0) lines.push('Written: ' + value.written.join(', '))
  if (value.failures.length > 0) {
    lines.push('Failures:')
    for (const failure of value.failures) lines.push(`- ${failure.path}: ${failure.reason}`)
  }
  return lines.join('\n')
}

function healthText(value) {
  if (!value || typeof value !== 'object') return String(value)
  const lines = []
  lines.push(`local delegate: ${value.ok ? 'ready' : 'not ready'} (status: ${value.status}${value.config?.version ? `, v${value.config.version}` : ''})`)
  if (value.effective) {
    lines.push(`effective endpoint: ${value.effective.kind} ${value.effective.baseURL} model=${value.effective.model} (${value.effective.latency_ms}ms)`)
  }
  if (value.primary) {
    lines.push(
      `primary: ${value.primary.baseURL} model=${value.primary.model} reachable=${value.primary.reachable} model_found=${value.primary.model_found}` +
        (value.primary.error ? ` error=${value.primary.error}` : ''),
    )
  }
  for (const [index, fallback] of (value.fallbacks ?? []).entries()) {
    lines.push(
      `fallback[${index}]: ${fallback.baseURL} model=${fallback.model} reachable=${fallback.reachable} model_found=${fallback.model_found}` +
        (fallback.error ? ` error=${fallback.error}` : ''),
    )
  }
  if (value.remediation?.length > 0) {
    lines.push('remediation:')
    for (const item of value.remediation) lines.push(`- ${item}`)
  }
  return lines.join('\n')
}

function remediationFor(runtime) {
  const config = runtime.config
  const health = runtime.health
  const items = []
  if (!config.enabled) {
    items.push('The plugin is disabled (enabled=false). Set "enabled: true" on the local-delegate config row and save; it applies within seconds.')
  }
  if (!config.endpoint.model) {
    items.push('endpoint.model is empty. Set it to a model the endpoint serves, for example "gemma4:e2b", then run local_health again.')
  }
  if (health.status === 'unavailable') {
    items.push(
      `Primary endpoint ${config.endpoint.baseURL} is unreachable. Confirm the server is running and the DSH host can reach it ` +
        '(for Ollama: OLLAMA_HOST=0.0.0.0, firewall open, then `node -e "fetch(\'http://HOST:11434/api/tags\')"`).',
    )
    items.push('If this machine is a standby, add a reachable endpoint to fallbackEndpoints so mechanical work keeps flowing.')
  } else if (health.status === 'degraded') {
    items.push('Primary endpoint is down; work is routed to a fallback. Check the primary server when convenient.')
  }
  if (health.primary?.probe?.ok === true && health.primary?.probe?.modelFound === false) {
    items.push(
      `The endpoint does not advertise model "${config.endpoint.model}". Run \`ollama list\` on the server and fix endpoint.model ` +
        '(or pull the model), otherwise every request fails with HTTP 404/model-not-found.',
    )
  }
  if (config.endpoint.kind === 'openai-compatible' && health.primary?.probe?.ok !== true && /HTTP 4\d\d/.test(String(health.primary?.probe?.error))) {
    items.push('OpenAI-compatible routes usually need a placeholder key/Authorization header even for local servers (endpoint.apiKey or endpoint.headers).')
  }
  return items
}

function healthValue(runtime) {
  if (runtime.refresh) runtime.refresh()
  const health = runtime.health
  const value = {
    ok: health.status !== 'unavailable',
    status: health.status,
    primary: endpointSummary(health.primary),
    fallbacks: (health.fallbacks ?? []).map(endpointSummary),
    effective: endpointSummary(health.effective),
    config: {
      version: PLUGIN_VERSION,
      enabled: runtime.config.enabled,
      endpoint_kind: runtime.config.endpoint.kind,
      endpoint_baseURL: runtime.config.endpoint.baseURL,
      endpoint_model: runtime.config.endpoint.model || '',
      think: runtime.config.endpoint.think,
      reasoning_effort: runtime.config.endpoint.reasoningEffort || null,
      retries: runtime.config.retries,
      chunkChars: runtime.config.chunkChars,
      maxConcurrency: runtime.config.maxConcurrency,
      maxInlineChars: runtime.config.maxInlineChars,
      maxSourceChars: runtime.config.maxSourceChars,
      maxBatchFiles: runtime.config.maxBatchFiles,
      maxBatchChars: runtime.config.maxBatchChars,
      allowOutsideCwd: runtime.config.allowOutsideCwd,
      allowRoots: runtime.config.allowRoots,
      denyGlobs: runtime.config.denyGlobs,
      modelsByTask: runtime.config.modelsByTask,
    },
    remediation: remediationFor(runtime),
  }
  return value
}

function doctorText(runtime) {
  const config = runtime.refresh ? runtime.refresh() : runtime.config
  const health = runtime.health
  const lines = []
  lines.push(`Local delegate doctor (plugin v${PLUGIN_VERSION})`)
  lines.push(`config: enabled=${config.enabled}, kind=${config.endpoint.kind}, baseURL=${config.endpoint.baseURL}, model=${config.endpoint.model || '(unset)'}`)
  lines.push(`retries=${config.retries}, keepAlive=${config.endpoint.keepAlive}, think=${config.endpoint.think}, timeoutMs=${config.endpoint.timeoutMs}`)
  lines.push(`chunkChars=${config.chunkChars}, concurrency=${config.maxConcurrency}, inline<${config.maxInlineChars}, source<${config.maxSourceChars}, batch=${config.maxBatchFiles} files/${config.maxBatchChars} chars, calls/min=${config.maxCallsPerMinute}`)
  lines.push(`paths: allowOutsideCwd=${config.allowOutsideCwd}, allowRoots=${JSON.stringify(config.allowRoots)}, denyGlobs=${config.denyGlobs.length} pattern(s)`)
  for (const warning of configWarnings(config)) lines.push(`warning: ${warning}`)
  lines.push('')
  lines.push(healthText(healthValue(runtime)))
  lines.push('')
  lines.push(renderStats(runtime.stats, config.endpoint, health))
  lines.push('')
  lines.push('usage: prefer local_transform(path=...) for one file, local_batch(paths=[...]) for many (dry run first), local_health to re-probe.')
  lines.push('install/upgrade: see the plugin README (Settings → Plugins for bundle state, profile cordis.patch.yml for row config).')
  return lines.join('\n')
}

/** Live agents when the registry service is mounted; null when unavailable. */
function listLiveAgents(ctx) {
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (!registry || typeof registry.list !== 'function') return null
    const list = registry.list()
    return Array.isArray(list) ? list.filter((agent) => agent && typeof agent === 'object') : null
  } catch {
    return null
  }
}

/** Render the `/localpolicy` report: config summary plus every live agent's scoped state. */
function policyText(runtime, ctx, policy) {
  const config = runtime.refresh ? runtime.refresh() : runtime.config
  const lines = []
  lines.push(`Local delegate policy (plugin v${PLUGIN_VERSION})`)
  lines.push(
    `levels: enabled=${config.levelsEnabled}, default=${config.defaultLevel}, applyToLiveAgents=${config.applyToLiveAgents}`,
  )
  const workspaceKeys = config.workspaceLevels && typeof config.workspaceLevels === 'object' ? Object.keys(config.workspaceLevels) : []
  if (workspaceKeys.length === 0) {
    lines.push('workspace overrides: (none)')
  } else {
    lines.push('workspace overrides:')
    for (const key of workspaceKeys.sort()) lines.push(`  - ${config.workspaceLevels[key]}: ${key}`)
  }
  const workerModel = config.workerRouteModel || config.endpoint.model || '(unset)'
  lines.push(
    `worker: provider=${config.workerProvider}, preset=${config.workerPreset}, route=${config.workerRouteProvider}/${workerModel}, ` +
      `maxDepth=${config.workerMaxDepth}, fallback=${config.plannerFallback}`,
  )
  lines.push(
    `thresholds: light >= ${config.lightMinChars} chars or >= ${config.lightMinFiles} files; high >= ${config.highMinChars} chars; ` +
      `plannerAllowRead=${config.plannerAllowRead}`,
  )
  lines.push(
    `slave teams: enabled=${config.slaveTeamsEnabled}` +
      (config.slaveTeamsEnabled ? `, defaultNode=${config.slaveTeamDefaultNode || '(round-robin)'}, maxSlaves=${config.slaveTeamMaxSlaves}` : ''),
  )
  lines.push('')
  const agents = listLiveAgents(ctx)
  if (agents === null) {
    lines.push('live agents: ctx.agents is not available; showing configuration only.')
    return lines.join('\n')
  }
  if (agents.length === 0) {
    lines.push('live agents: (none)')
    return lines.join('\n')
  }
  lines.push(`live agents (${agents.length}):`)
  for (const agent of agents) {
    let info
    try {
      info = policy.describeAgent(agent)
    } catch (error) {
      lines.push(`- session ${String(agent?.session?.id ?? agent?.id ?? '?')}: describe failed: ${String(error?.message ?? error).slice(0, 200)}`)
      continue
    }
    const role = info.teamRole && info.teamRole !== 'none' ? `, Team ${info.teamRole}` : ''
    lines.push(`- session ${info.sessionId || '?'}: ${info.root ? 'root' : 'child'}${role} (${info.policyKind})`)
    lines.push(
      `  level: ${info.level} (source: ${info.source})${info.unmatched ? ' — workspace not matched; the default level applies' : ''}`,
    )
    const where = info.workspaceTitle || info.workspacePath || '(no workspace)'
    lines.push(`  workspace: ${where}${info.workspaceTitle && info.workspacePath ? ` (${info.workspacePath})` : ''}`)
    const installed = info.installed ?? {}
    const parts = []
    if (installed.prompt) parts.push('prompt override')
    if (installed.levelContext) parts.push('level context')
    if (installed.workerNote) parts.push('worker note')
    if (installed.workerTool) parts.push('local_worker')
    if (installed.slaveTeams) parts.push('slave tools')
    lines.push(`  installed: ${parts.length > 0 ? parts.join(', ') : '(no scoped layer — v0.3 behavior)'}`)
    if (installed.restrictDeny?.length > 0) lines.push(`  restrict deny: ${installed.restrictDeny.join(', ')}`)
    if (info.slaveTeams?.enabled) lines.push(`  slave nodes: ${info.slaveTeams.nodes ?? 'unknown'}`)
  }
  return lines.join('\n')
}

/* ── plugin entry ─────────────────────────────────────────────────────── */

const TOOL_OUTPUT_SCHEMA = { type: 'object' }

/**
 * Register the plugin's tools, prompt guidance, health context, and commands.
 * @param {object} ctx Cordis plugin context.
 * @param {object} rawConfig validated row config.
 */
export function apply(ctx, rawConfig) {
  const runtime = {
    raw: rawConfig,
    config: readConfig(rawConfig),
    stats: createStats(),
    rate: [],
    health: { status: 'unknown', checkedAt: 0, primary: null, fallbacks: [], effective: null, error: null },
  }

  const logger = ctx.logger
  const log = (level, message) => {
    try {
      logger?.[level]?.(`local-delegate: ${message}`)
    } catch {
      /* logging must never break activation */
    }
  }

  /** Re-read the live (volatile-updated) config; keep the old snapshot on invalid values. */
  const refreshConfig = () => {
    try {
      runtime.config = readConfig(runtime.raw)
    } catch (error) {
      log('warn', `live config update rejected: ${String(error?.message ?? error).slice(0, 240)}`)
    }
    return runtime.config
  }
  refreshConfig()
  runtime.refresh = refreshConfig

  // Volatile-only edits (the GUI save path) update config references in place;
  // refresh derived state and re-probe without remounting the plugin.
  if (typeof ctx.on === 'function') {
    let probeTimer
    ctx.on('loader/volatile-update', () => {
      const before = endpointSummaryText(runtime.config)
      const after = endpointSummaryText(refreshConfig())
      if (before !== after) log('info', `config updated: ${after}`)
      clearTimeout(probeTimer)
      probeTimer = setTimeout(() => {
        void refreshHealth(runtime).catch(() => {})
      }, 500)
      probeTimer.unref?.()
    })
    if (typeof ctx.effect === 'function') ctx.effect(() => () => clearTimeout(probeTimer), 'local-delegate: volatile probe timer')
  }

  // Same-origin GUI API: status / probe / models. Runs in its own fiber so a
  // composition without an HTTP server cannot take the tools down with it.
  if (typeof ctx.inject === 'function') {
    const getConnection = () => (typeof ctx.get === 'function' ? ctx.get('connection') : undefined)
    ctx.inject(['webServer'], (scoped) => {
      const server = scoped.webServer
      if (!server || typeof server.register !== 'function') return
      const handler = createApiHandler({
        getRuntime: () => runtime,
        getConnection,
        refresh: refreshConfig,
        version: PLUGIN_VERSION,
        log,
        getWorkspaceRegistry: () => (typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined),
      })
      scoped.effect(
        () => server.register({ kind: 'prefix', path: '/api/local-delegate', handler }),
        'local-delegate: settings API',
      )
    })
  }

  const config = runtime.config
  for (const warning of configWarnings(config)) log('warn', warning)
  log('info', `ready: v${PLUGIN_VERSION} ${endpointSummaryText(config)}`)

  const systemPrompt = ctx.get('systemPrompt')

  if (config.enabled) {
    if (config.promptHelp && systemPrompt) {
      systemPrompt.section({
        name: 'tool:local-delegate',
        order: 10050,
        interpolate: false,
        text: [
          'A local cheap model endpoint is configured for mechanical text work (free, separate from this conversation); its current model, address, and availability appear in the runtime context below.',
          'Delegate MECHANICAL text work whose content you do not need to understand, only its result: translate, summarize, extract fields, classify, rewrite, write commit messages, propose names.',
          'Call `local_transform` with a file `path` (preferred) or `local_batch` with `paths`; never paste long text into the call — text written into a tool call costs output tokens, a path costs about a hundred. Delegate when the content is larger than ~800 tokens or spans whole files; for many files let `local_batch` run its default dry run first.',
          'Do the work yourself when it needs judgement or trust: code changes and debugging, architecture or decisions, final user-facing answers, secrets or credentials or personal data, or anything you must verify line by line.',
          'If the local model fails once or returns unusable output, stop delegating and do it yourself. `local_health` checks the endpoint chain without generating tokens.',
        ].join(' '),
      })
    }

    if (systemPrompt) {
      const configRef = runtime
      systemPrompt.context({
        name: 'local-delegate-status',
        order: 10050,
        interpolate: false,
        required: false,
        text: () => {
          const active = configRef.config
          if (!active.enabled) return ''
          const health = configRef.health
          const where = hostOf(active.endpoint.baseURL)
          const model = active.endpoint.model || '(unset)'
          if (health.status === 'available') {
            return `Local cheap model \`${model}\` at ${where} is available.`
          }
          if (health.status === 'degraded' && health.effective) {
            return `Local cheap model primary endpoint is unavailable; fallback \`${health.effective.model}\` at ${hostOf(health.effective.endpoint.baseURL)} is available.`
          }
          if (health.status === 'unavailable') {
            return `Local cheap model \`${model}\` at ${where} is unavailable (${health.error || 'probe failed'}). Do mechanical text work yourself; run local_health or /localdoctor for diagnostics.`
          }
          return `Local cheap model \`${model}\` at ${where} is configured; use local_health before delegating mechanical text work.`
        },
      })
    }

    ctx.tools.register({
      name: 'local_transform',
      description:
        'Transform one text with a local cheap model instead of spending main-model tokens: translate, summarize, extract, classify, rewrite, write a commit message, or propose names. Prefer `path` over `text` — the file is read by this tool, so its content never enters this conversation. Returns a short receipt (plus the result only for inline mode), never the full file.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', enum: TASKS, description: 'The mechanical operation to perform.' },
          path: {
            type: 'string',
            description:
              'Source file path relative to the working directory. Preferred for anything larger than a few paragraphs: the tool reads and rewrites it without loading the text into the conversation.',
          },
          text: {
            type: 'string',
            description: 'Inline source text, within the configured inline character limit. Use only for short snippets; prefer path.',
          },
          out_path: {
            type: 'string',
            description:
              'Output file path for path mode. Defaults to the source path with ".local" before the extension (README.md -> README.local.md).',
          },
          target_language: {
            type: 'string',
            description: 'Target language for task=translate (e.g. "Simplified Chinese", "English"). Required for translate.',
          },
          instructions: {
            type: 'string',
            description: 'Task-specific instruction: fields to extract, labels to classify into, or rewriting guidance.',
          },
          max_output_tokens: {
            type: 'number',
            description: 'Per-chunk output token cap; defaults to the endpoint configuration.',
          },
        },
        required: ['task'],
        additionalProperties: false,
      },
      output: { schema: TOOL_OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: receiptText(value) }] },
      timeoutMs: 900_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          return await executeTransform(runtime, ctx, exec, args && typeof args === 'object' ? args : {})
        } catch (error) {
          recordFailure(runtime.stats, args?.task, error?.message)
          throw enrich(error)
        }
      },
    })

    ctx.tools.register({
      name: 'local_batch',
      description:
        'Run one mechanical transformation (translate, summarize, extract, classify, rewrite) over several files with a local cheap model. Defaults to a dry run: the first call returns the plan, and `dry_run=false` executes it. Writes outputs under `out_dir` (default .local-out) and returns per-file results, never file contents.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', enum: TASKS, description: 'The mechanical operation to perform on every file.' },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files to process, relative to the working directory, within the configured batch file limit.',
          },
          out_dir: { type: 'string', description: 'Directory for outputs, relative to the working directory. Defaults to .local-out.' },
          target_language: { type: 'string', description: 'Target language for task=translate. Required for translate.' },
          instructions: { type: 'string', description: 'Task-specific instruction passed to every file.' },
          dry_run: { type: 'boolean', description: 'When true (default) only return the plan; set false to actually process and write files.' },
        },
        required: ['task', 'paths'],
        additionalProperties: false,
      },
      output: { schema: TOOL_OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: batchText(value) }] },
      timeoutMs: 900_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          return await executeBatch(runtime, ctx, exec, args && typeof args === 'object' ? args : {})
        } catch (error) {
          recordFailure(runtime.stats, args?.task, error?.message)
          throw enrich(error)
        }
      },
    })

    ctx.tools.register({
      name: 'local_health',
      description:
        'Check the configured local cheap-model endpoint chain and its configuration without generating tokens. Returns reachability, model availability, effective endpoint, budgets, and remediation steps when something is wrong. Use it when delegation fails or before delegating a large batch; do not poll it.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: TOOL_OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: healthText(value) }] },
      timeoutMs: 30_000,
      isConcurrencySafe: () => true,
      async execute() {
        await refreshHealth(runtime)
        return healthValue(runtime)
      },
    })
  }

  // v0.4: per-workspace levels policy + SlaveAgentTeams scoped tools. The
  // services are created here so commands can report their state; the policy
  // starts after the global tools above exist (L0/L4 restriction needs their
  // names) and is cleaned up through ctx.effect on unload/HMR.
  const slaveTeams = createSlaveTeamsService({ ctx, getConfig: refreshConfig, log, stats: runtime.stats })
  const policy = createLevelsPolicy({
    ctx,
    getConfig: refreshConfig,
    getSlaveTeams: () => slaveTeams,
    log,
    stats: runtime.stats,
    startSlaveActivation,
  })

  const commands = ctx.get('commands')
  if (commands) {
    commands.register({
      name: 'localstats',
      description: 'Show local cheap-model delegation statistics (calls, tokens processed, estimated main-model tokens avoided)',
      handler: () => {
        if (runtime.refresh) runtime.refresh()
        return {
          kind: 'success',
          text: renderStats(runtime.stats, runtime.config.endpoint, runtime.health),
        }
      },
    })
    commands.register({
      name: 'localdoctor',
      description: 'Diagnose the local-delegate setup: endpoint chain, model availability, limits, and remediation steps',
      handler: () => ({ kind: 'success', text: doctorText(runtime) }),
    })
    commands.register({
      name: 'localpolicy',
      description:
        'Show the local AI involvement level policy: levels, workspace overrides, worker route, and the scoped policy installed on each live agent',
      handler: () => {
        try {
          return { kind: 'success', text: policyText(runtime, ctx, policy) }
        } catch (error) {
          return { kind: 'error', text: `localpolicy failed: ${String(error?.message ?? error).slice(0, 300)}` }
        }
      },
    })
  }

  if (config.enabled) {
    try {
      const started = policy.start()
      if (started && typeof started.catch === 'function') {
        started.catch((error) => log('warn', `levels policy initial install failed: ${String(error?.message ?? error).slice(0, 240)}`))
      }
    } catch (error) {
      log('warn', `levels policy failed to start: ${String(error?.message ?? error).slice(0, 240)}`)
    }
    if (typeof ctx.effect === 'function') {
      ctx.effect(
        () => () => {
          try {
            policy.dispose()
          } catch {
            /* disposal must never break unload */
          }
          try {
            slaveTeams.disposeAll()
          } catch {
            /* disposal must never break unload */
          }
        },
        'local-delegate: policy',
      )
    }
  }

  if (config.enabled && config.warmupOnStart) {
    const startWarmup = () => {
      const probeAndLog = () => {
        const active = runtime.refresh ? runtime.refresh() : runtime.config
        refreshHealth(runtime)
          .then((health) => {
            if (health.status === 'available') {
              log('info', `connected: ${active.endpoint.baseURL} model=${active.endpoint.model || '(unset)'} (${health.primary?.probe?.latencyMs ?? '?'}ms)`)
            } else if (health.status === 'degraded') {
              log('warn', `primary endpoint unavailable; fallback ${health.effective?.endpoint?.baseURL ?? 'unknown'} is serving`)
            } else {
              log('warn', `endpoint unavailable at ${config.endpoint.baseURL}: ${health.error ?? 'probe failed'} — run /localdoctor for remediation`)
            }
          })
          .catch(() => {})
      }
      const kick = setTimeout(probeAndLog, 1500)
      kick.unref?.()
      const timer = setInterval(probeAndLog, 120_000)
      timer.unref?.()
      return () => {
        clearTimeout(kick)
        clearInterval(timer)
      }
    }
    if (typeof ctx.effect === 'function') ctx.effect(startWarmup)
    else startWarmup()
  }
}

/** Append the actionable fallback hint exactly once. */
function enrich(error) {
  const message = String(error?.message ?? error)
  if (message.includes('fallback')) return error
  const wrapped = new Error(`${message}; fallback: complete this work yourself without the local model`)
  wrapped.code = error?.code
  return wrapped
}




