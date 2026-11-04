/**
 * SlaveAgentTeams host core for dsh-local-delegate v0.4.
 *
 * A "slave" is an ordinary continuable child agent started through
 * `ctx.subagents.startActivation({ provider: 'spawn', ... })` on one of the
 * configured `slaveNodes` LLM routes (a cheap local model or a cloud model).
 * The root agent (the "master") gets five Agent-scoped tools
 * (`slave_team_spawn|status|wait|send|interrupt`) plus a scoped prompt section
 * and a dynamic runtime context. Nothing global is touched and no Team tool
 * name is reused, so Agent Teams keeps working exactly as before.
 *
 * Design constraints (v0.4 contract §6):
 * - Root agent only. Child agents and Team teammates never get these tools.
 * - `slaveTeamsEnabled !== true` or an empty node pool after level filtering
 *   installs nothing.
 * - Results come only from the activation `result` promise; this module keeps
 *   a per-root run registry (childId, node, model, result promise, preview).
 * - Failures are per task: one bad node never stops the other slaves.
 * - `fallback: 'inherit'` retries once without `agentOptions` (parent model).
 */

import { recordSlaveFailure, recordSlaveSettled, recordSlaveStart } from './stats.js'

const DEFAULT_PROVIDER = 'spawn'
const DEFAULT_PRESET = 'standard'
const DEFAULT_MAX_SLAVES = 4
const MAX_SLAVES = 8
const DEFAULT_MAX_DEPTH = 1
const MAX_DEPTH = 5
const MAX_NODES = 12
const AUTO_DISCOVERY_TIMEOUT_MS = 2_500
const AUTO_DISCOVERY_CACHE_MS = 5_000
const LOCAL_PROVIDER_PATTERN = /local|intranet|ollama|lmstudio|lm-studio|llama|vllm|llamacpp|gpt4all|home|nas|lan/i
const DEFAULT_WAIT_TIMEOUT_MS = 600_000
const MIN_WAIT_TIMEOUT_MS = 1_000
const MAX_WAIT_TIMEOUT_MS = 1_800_000
const PREVIEW_CHARS = 800
const WAIT_TOTAL_CHARS = 6_000
const PROMPT_NODE_LINES = 8
const SLAVE_SECTION_NAME = 'tool:local-delegate:slave-teams'
const SLAVE_SECTION_ORDER = 10053
const SLAVE_CONTEXT_NAME = 'local-delegate:slave-status'
const SLAVE_CONTEXT_ORDER = 10053
const TOOL_OUTPUT_SCHEMA = { type: 'object' }

/** The exact tool names this module registers (never a native Team tool name). */
export const SLAVE_TOOL_NAMES = Object.freeze([
  'slave_team_spawn',
  'slave_team_status',
  'slave_team_wait',
  'slave_team_send',
  'slave_team_interrupt',
])

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function safeString(value) {
  if (typeof value === 'string') return value.trim()
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function errorMessage(error) {
  return String(error?.message ?? error ?? 'unknown error')
}

function codedError(code, message, cause) {
  const error = new Error(`${code}: ${message}`, cause === undefined ? undefined : { cause })
  error.code = code
  return error
}

function isAbortError(error, signal) {
  if (signal?.aborted) return true
  return error?.name === 'AbortError' || safeString(error?.code) === 'ABORT_ERR'
}

function clampInt(value, min, max, fallback) {
  const number = Math.floor(Number(value))
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

function truncateText(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text
  return text.slice(0, max)
}

/** Flatten an activation `output` (content blocks, string, or fold) to text. */
function outputText(output) {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part.text === 'string') return part.text
        if (part && typeof part.type === 'string' && part.type !== 'text') return ''
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (output && typeof output === 'object') {
    if (typeof output.text === 'string') return output.text
    if (Array.isArray(output.content)) return outputText(output.content)
    if (Array.isArray(output.output)) return outputText(output.output)
    if (typeof output.output === 'string') return output.output
    try {
      const json = JSON.stringify(output)
      return json === '{}' ? '' : json
    } catch {
      return ''
    }
  }
  return ''
}

function sameNodeName(left, right) {
  return safeString(left).toLowerCase() === safeString(right).toLowerCase() && safeString(left) !== ''
}

function findNodeByName(nodes, name) {
  const requested = safeString(name)
  if (!requested || !Array.isArray(nodes)) return null
  const exact = nodes.find((node) => node.name === requested)
  if (exact) return exact
  const insensitive = safeString(name).toLowerCase()
  return nodes.find((node) => safeString(node.name).toLowerCase() === insensitive) ?? null
}

function uniqueName(base, used) {
  const start = safeString(base) || 'slave'
  if (!used.has(start)) return start
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${start}-${index}`
    if (!used.has(candidate)) return candidate
  }
  return `${start}-${Date.now()}`
}

function nodeSummaryLine(node) {
  const model = node.model || '(endpoint model)'
  const note = node.note ? ` — ${node.note}` : ''
  return `- ${node.name} (${node.kind}) ${node.provider}/${model}${note}`
}

function subagentsOf(context) {
  if (!context) return undefined
  try {
    const direct = context.subagents
    if (direct && typeof direct === 'object') return direct
  } catch {
    /* a service may be absent in a reduced composition; fall through to get() */
  }
  if (typeof context.get === 'function') {
    try {
      return context.get('subagents')
    } catch {
      return undefined
    }
  }
  return undefined
}

function signalOf(exec) {
  const signal = exec?.signal
  if (signal && typeof signal.addEventListener === 'function') return signal
  return new AbortController().signal
}

// ---------------------------------------------------------------------------
// Node model (§6.2)
// ---------------------------------------------------------------------------

/**
 * Normalize one `slaveNodes[]` entry. Tolerant by design: the GUI may persist
 * half-finished drafts, so unknown kinds fall back to `'local'` and an empty
 * provider falls back to the v0.3 subagent route provider name.
 * @param {unknown} raw one configured (or implicit) node.
 * @returns {{name: string, kind: 'local'|'cloud', provider: string, model: string, note: string}}
 */
export function normalizeSlaveNode(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const kind = safeString(source.kind).toLowerCase() === 'cloud' ? 'cloud' : 'local'
  return {
    name: safeString(source.name),
    kind,
    provider: safeString(source.provider) || 'local-delegate',
    model: safeString(source.model),
    note: safeString(source.note),
  }
}

/**
 * Build the usable node pool for one level.
 *
 * - `slaveNodes` empty → one implicit `{ name: 'local', kind: 'local' }` node
 *   from `workerRouteProvider`/`workerRouteModel` (v0.3 subagent route).
 * - An explicit node with an empty model uses `endpoint.model`.
 * - `level === 'none'` filters every `kind === 'local'` node (L0 = no local
 *   models); cloud nodes stay usable.
 * - Duplicate names keep the first; more than 12 nodes are truncated.
 * @param {object} config live normalized plugin config.
 * @param {string} [level] resolved agent level (`none|light|default|high|max`).
 * @returns {{nodes: Array<object>, dropped: Array<{name: string, reason: string}>, issues: string[]}}
 */
export function resolveSlaveNodes(config, level) {
  const source = config && typeof config === 'object' ? config : {}
  const endpointModel = safeString(source.endpoint?.model)
  const dropped = []
  const issues = []
  const candidates = []

  const rawNodes = Array.isArray(source.slaveNodes) ? source.slaveNodes : []
  if (rawNodes.length === 0) {
    const implicit = normalizeSlaveNode({
      name: 'local',
      kind: 'local',
      provider: source.workerRouteProvider || 'local-delegate',
      model: source.workerRouteModel || endpointModel,
      note: 'implicit endpoint node',
    })
    if (!implicit.model) {
      issues.push(
        'no slaveNodes configured and endpoint.model is empty: set slaveNodes or the local endpoint model before enabling SlaveAgentTeams',
      )
    } else {
      candidates.push({ node: implicit, index: 0 })
    }
  } else {
    rawNodes.forEach((raw, index) => {
      const node = normalizeSlaveNode(raw)
      if (!node.name) {
        node.name = `node${index + 1}`
        issues.push(`slaveNodes[${index}] has no name; using "${node.name}"`)
      }
      if (!node.model) node.model = endpointModel
      candidates.push({ node, index })
    })
  }

  // L0 filters every local node before validity/truncation checks so the
  // ordinary "no nodes at level none" case is silent rather than an issue.
  const filtered = []
  for (const candidate of candidates) {
    if (safeString(level) === 'none' && candidate.node.kind === 'local') {
      dropped.push({ name: candidate.node.name, reason: 'level "none" disables local slave nodes' })
      continue
    }
    filtered.push(candidate)
  }

  const nodes = []
  for (const { node } of filtered) {
    if (!node.model) {
      const reason = 'missing model: set node.model or endpoint.model'
      dropped.push({ name: node.name, reason })
      issues.push(`slave node "${node.name}" is unusable: ${reason}`)
      continue
    }
    if (nodes.some((existing) => sameNodeName(existing.name, node.name))) {
      const reason = `duplicate node name "${node.name}" ignored`
      dropped.push({ name: node.name, reason })
      issues.push(reason)
      continue
    }
    if (nodes.length >= MAX_NODES) {
      const reason = `only the first ${MAX_NODES} slave nodes are used`
      dropped.push({ name: node.name, reason })
      issues.push(reason)
      continue
    }
    nodes.push(node)
  }

  return { nodes, dropped, issues }
}

/**
 * Pick the node for one task: explicit task name > call/config default >
 * round-robin by `index`. An unknown explicit name returns null (the call site
 * reports it as an actionable per-task failure); a configured default node that
 * no longer exists falls through to round-robin.
 */
export function selectSlaveNode(nodes, requestedName, defaultNode, index) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null
  const requested = safeString(requestedName)
  if (requested) return findNodeByName(nodes, requested)
  const fallback = safeString(defaultNode)
  if (fallback) {
    const match = findNodeByName(nodes, fallback)
    if (match) return match
  }
  const position = Number.isInteger(index) && index >= 0 ? index : 0
  return nodes[position % nodes.length]
}

/**
 * Ordered failover candidates for one task (v0.5): an explicit node is used
 * alone, a configured default comes first, and the remaining pool follows in
 * round-robin order starting at `index`.
 *
 * With `preferLocal`, round-robin starts on the local subset (when any) and
 * cloud nodes are only used as later failover candidates. Automatic mode uses
 * this so a multi-task spawn does not drift onto paid/cloud routes by accident.
 * @returns {Array<object>} candidate nodes (possibly empty for an unknown name).
 */
export function candidateSlaveNodes(nodes, requestedName, defaultNode, index, { preferLocal = false } = {}) {
  const pool = Array.isArray(nodes) ? nodes : []
  if (pool.length === 0) return []
  const requested = safeString(requestedName)
  if (requested) {
    const match = findNodeByName(pool, requested)
    return match ? [match] : []
  }
  const ordered = []
  const fallback = safeString(defaultNode)
  const preferred = fallback ? findNodeByName(pool, fallback) : null
  if (preferred) ordered.push(preferred)
  const position = Number.isInteger(index) && index >= 0 ? index : 0
  const locals = preferLocal ? pool.filter((node) => node.kind === 'local') : []
  const rotation = locals.length > 0 ? locals : pool
  for (let offset = 0; offset < rotation.length; offset += 1) {
    const node = rotation[(position + offset) % rotation.length]
    if (!ordered.includes(node)) ordered.push(node)
  }
  for (let offset = 0; offset < pool.length; offset += 1) {
    const node = pool[(position + offset) % pool.length]
    if (!ordered.includes(node)) ordered.push(node)
  }
  return ordered
}

/** Whether a failed start should try the next node instead of aborting the task. */
function isNodeFailoverError(error) {
  const code = safeString(error?.code)
  const message = errorMessage(error)
  if (code === 'ACTIVATION_LIMIT_REACHED' || /ACTIVATION_LIMIT_REACHED|subagent limit reached/i.test(message)) return false
  if (code === 'UNAUTHORIZED' || /UNAUTHORIZED/.test(message)) return false
  if (code === 'CONTINUATION_UNAVAILABLE' || /CONTINUATION_UNAVAILABLE/.test(message)) return false
  if (code === 'NO_PROVIDER' || /no subagent provider registered/i.test(message)) return false
  return true
}

// ---------------------------------------------------------------------------
// Automatic node discovery (v0.5)
// ---------------------------------------------------------------------------

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), Math.max(1, timeoutMs))
    timer.unref?.()
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Enumerate every mounted LLM route and the models its adapter advertises.
 *
 * Metadata only: pi-ai's `listModels` reads its in-memory profile, so no model
 * request or token is generated. Missing `llm`, a failing provider, and an
 * empty catalog are reported as issues instead of throwing, because automatic
 * discovery must never take the slave tools down with it.
 * @param {object} ctx host context.
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{providers: Array<{id: string, name: string, models: string[]}>, issues: string[]}>}
 */
export async function discoverLlmRoutes(ctx, { timeoutMs = AUTO_DISCOVERY_TIMEOUT_MS } = {}) {
  const llm =
    ctx && typeof ctx.get === 'function'
      ? (() => {
          try {
            return ctx.get('llm')
          } catch {
            return undefined
          }
        })()
      : undefined
  if (!llm || typeof llm.listProviders !== 'function') {
    return { providers: [], issues: ['the llm service is unavailable; automatic slave-node discovery is skipped'] }
  }
  let infos
  try {
    infos = await withTimeout(Promise.resolve(llm.listProviders()), timeoutMs)
  } catch (error) {
    return { providers: [], issues: [`llm.listProviders() failed: ${errorMessage(error)}`] }
  }
  const issues = []
  const providers = []
  const infosList = Array.isArray(infos) ? infos : []
  // Query providers concurrently so one slow adapter cannot serialize spawn.
  const listed = await Promise.all(
    infosList.map(async (info) => {
      const id = safeString(info?.id)
      if (!id) return null
      const name = safeString(info?.name) || id
      try {
        if (typeof llm.listModels !== 'function') {
          issues.push('the llm service does not expose listModels(); automatic slave-node discovery is skipped')
          return null
        }
        const models = await withTimeout(Promise.resolve(llm.listModels(id)), timeoutMs)
        const ids = (Array.isArray(models) ? models : []).map((entry) => safeString(entry?.id ?? entry?.model)).filter(Boolean)
        return ids.length > 0 ? { id, name, models: ids } : null
      } catch (error) {
        issues.push(`llm.listModels("${id}") failed: ${errorMessage(error)}`)
        return null
      }
    }),
  )
  for (const entry of listed) {
    if (entry) providers.push(entry)
  }
  return { providers, issues }
}

/** Classify a route as a local/self-hosted model rather than a cloud account. */
export function isLocalSlaveProvider(provider, name) {
  return LOCAL_PROVIDER_PATTERN.test(`${safeString(provider)} ${safeString(name)}`)
}

/**
 * Turn a discovered route catalog into the automatic slave-node pool.
 *
 * One node per (route, model), local routes first, duplicates removed, capped
 * at MAX_NODES. `level === 'none'` filters local nodes exactly like the manual
 * pool so the level contract keeps working in auto mode.
 * @param {Array<{id: string, name?: string, models: string[]}>} providers
 * @param {string} [level]
 */
export function autoNodesFromProviders(providers, level) {
  const nodes = []
  const dropped = []
  const issues = []
  const seen = new Set()
  for (const provider of Array.isArray(providers) ? providers : []) {
    const id = safeString(provider?.id)
    if (!id) continue
    const kind = isLocalSlaveProvider(id, provider?.name) ? 'local' : 'cloud'
    for (const rawModel of Array.isArray(provider?.models) ? provider.models : []) {
      const model = safeString(rawModel)
      if (!model) continue
      const name = `${id}/${model}`
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      if (safeString(level) === 'none' && kind === 'local') {
        dropped.push({ name, reason: 'level "none" disables local slave nodes' })
        continue
      }
      seen.add(key)
      nodes.push(normalizeSlaveNode({ name, kind, provider: id, model, note: 'auto-detected route' }))
    }
  }
  nodes.sort((left, right) =>
    left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === 'local' ? -1 : 1,
  )
  for (const node of nodes.slice(MAX_NODES)) {
    dropped.push({ name: node.name, reason: `only the first ${MAX_NODES} slave nodes are used` })
  }
  if (dropped.some((entry) => entry.reason.startsWith('only the first'))) {
    issues.push(`automatic discovery found more than ${MAX_NODES} routes; only the first ${MAX_NODES} are used`)
  }
  return { nodes: nodes.slice(0, MAX_NODES), dropped, issues }
}

// ---------------------------------------------------------------------------
// Route preflight (§6.5)
// ---------------------------------------------------------------------------

const LOCAL_ROUTE_REMEDIATION =
  'for a local node, open Settings → Local model and click "Enable for Subagent" so llm-pi-ai exposes the "local-delegate" route, then check node.provider/node.model'
const CLOUD_ROUTE_REMEDIATION =
  'for a cloud node, register that provider and model in the Models / llm-pi-ai settings'

/**
 * Resolve one slave node's LLM route through the live `llm` service before any
 * child is created (the subagent service itself does not validate routes; a
 * bad route would otherwise fail at the child's first model call).
 *
 * Missing `llm` service → `{ ok: false, skipped: true }` (startActivation is
 * left to fail loudly). An unresolvable route throws `SLAVE_ROUTE_UNAVAILABLE`
 * with node-specific remediation.
 * @param {object} ctx host context.
 * @param {{name?: string, provider?: string, model?: string}} node slave node.
 * @param {AbortSignal} [signal] caller cancellation.
 * @returns {Promise<{ok: boolean, skipped?: boolean, provider: string, model: string, reason?: string}>}
 */
export async function preflightSlaveRoute(ctx, node, signal) {
  const provider = safeString(node?.provider)
  const model = safeString(node?.model)
  const name = safeString(node?.name) || '(unnamed)'
  if (!provider || !model) {
    throw codedError(
      'SLAVE_ROUTE_UNAVAILABLE',
      `slave node "${name}" needs a provider and a model before it can start (got provider="${provider}", model="${model}"); ${node?.kind === 'cloud' ? CLOUD_ROUTE_REMEDIATION : LOCAL_ROUTE_REMEDIATION}`,
    )
  }
  const llm =
    ctx && typeof ctx.get === 'function'
      ? (() => {
          try {
            return ctx.get('llm')
          } catch {
            return undefined
          }
        })()
      : undefined
  if (!llm) {
    return { ok: false, skipped: true, provider, model, reason: 'the llm service is unavailable; route preflight skipped' }
  }
  if (typeof llm.resolveCallConfig !== 'function') {
    throw codedError(
      'SLAVE_ROUTE_UNAVAILABLE',
      `the llm service does not expose resolveCallConfig(), so slave node "${name}" route "${provider}/${model}" cannot be verified; ${node?.kind === 'cloud' ? CLOUD_ROUTE_REMEDIATION : LOCAL_ROUTE_REMEDIATION}`,
    )
  }
  try {
    await llm.resolveCallConfig({ provider, model }, signal)
    return { ok: true, provider, model }
  } catch (error) {
    if (isAbortError(error, signal)) throw error
    throw codedError(
      'SLAVE_ROUTE_UNAVAILABLE',
      `slave node "${name}" route "${provider}/${model}" cannot be resolved: ${errorMessage(error)}; ${node?.kind === 'cloud' ? CLOUD_ROUTE_REMEDIATION : LOCAL_ROUTE_REMEDIATION}`,
      error,
    )
  }
}

// ---------------------------------------------------------------------------
// Activation start (§6.5)
// ---------------------------------------------------------------------------

function requestFor({ parent, task, preset, maxDepth, node, cwd }) {
  const request = {
    parent,
    prompt: [{ type: 'text', text: task }],
    agentPreset: preset,
    maxDepth,
  }
  // Only a routed slave carries agentOptions; an inherited (fallback) child
  // must omit it so the spawn provider inherits the parent model.
  if (node) request.agentOptions = { provider: node.provider, model: node.model }
  // Optional local_worker cwd pass-through (plan §4.6); not part of the base
  // SlaveAgentTeams request, so the exact §6.5 shape stays unchanged when absent.
  if (cwd) request.cwd = cwd
  return request
}

/**
 * Providers that must not trigger the `inherit` retry: retrying would fail the
 * same way (or double-consume a slot), so report the actionable error instead.
 */
function isRetryableStartError(error) {
  const code = safeString(error?.code)
  const message = errorMessage(error)
  if (code === 'ACTIVATION_LIMIT_REACHED' || /ACTIVATION_LIMIT_REACHED|subagent limit reached/i.test(message)) return false
  if (code === 'UNAUTHORIZED' || /UNAUTHORIZED/.test(message)) return false
  if (code === 'CONTINUATION_UNAVAILABLE' || /CONTINUATION_UNAVAILABLE/.test(message)) return false
  if (code === 'NO_PROVIDER' || /no subagent provider registered/i.test(message)) return false
  return true
}

function wrapStartError(error, { node, provider, attempt, firstError }) {
  const raw = errorMessage(error)
  const code = safeString(error?.code)
  const nodeLabel = node ? ` on slave node "${node.name}" (${node.provider}/${node.model})` : ''
  if (code === 'ACTIVATION_LIMIT_REACHED' || /ACTIVATION_LIMIT_REACHED|subagent limit reached/i.test(raw)) {
    return codedError(
      'ACTIVATION_LIMIT_REACHED',
      `cannot start a slave${nodeLabel}: the subagent activation limit was reached (maxActiveSubagents, default 8 live children per root). Wait for a running child/slave to finish, raise the Subagent "maxActiveSubagents" setting, or spawn fewer slaves, then retry.`,
      error,
    )
  }
  if (code === 'NO_PROVIDER' || /no subagent provider registered/i.test(raw)) {
    return codedError(
      'SLAVE_PROVIDER_UNAVAILABLE',
      `subagent provider "${provider}" is not registered, so a slave${nodeLabel} cannot start; mount the subagent service/provider (the built-in "spawn" provider) or set slaveTeamProvider to a registered provider`,
      error,
    )
  }
  if (code === 'UNSUPPORTED_CAPABILITY' || /does not support/.test(raw)) {
    return codedError(
      'UNSUPPORTED_CAPABILITY',
      `subagent provider "${provider}" cannot start a routed slave${nodeLabel}: ${raw}. Use a provider that supports agentOptions/agentPreset (the built-in "spawn" does), or pick a node model that the provider manages itself.`,
      error,
    )
  }
  if (attempt === 'inherit') {
    return codedError(
      'SLAVE_START_FAILED',
      `slave start failed${nodeLabel}: ${errorMessage(firstError)}; the automatic fallback to the parent model also failed: ${raw}. Check the node route, the provider, and the Subagent settings, or set slaveTeamFallback="fail" to surface only the routed error.`,
      error,
    )
  }
  return codedError(
    'SLAVE_START_FAILED',
    `slave start failed${nodeLabel}: ${raw}. Check the node route/provider and the Subagent settings; ` +
      'with slaveTeamFallback="inherit" a routed failure automatically retries on the parent model.',
    error,
  )
}

/**
 * Start exactly one slave activation.
 *
 * Request shape (contract §6.5): `{ parent, prompt, agentPreset, maxDepth }`
 * plus `agentOptions: { provider, model }` only when a node routes the child.
 * `startActivation` is called with `{ provider, label, request, signal,
 * delivery: 'parent' }`.
 *
 * When a routed start fails and `fallback === 'inherit'`, the call retries once
 * without `agentOptions`; the returned `fallback` says which path won.
 * @param {object} params
 * @param {object} params.ctx host context.
 * @param {object} params.parent exact live parent agent (the master).
 * @param {string} params.task prompt text.
 * @param {string} [params.label] activation label (shown in child lists).
 * @param {{name?: string, provider?: string, model?: string}} [params.node] routed node.
 * @param {string} [params.preset] agent preset, default "standard".
 * @param {number} [params.maxDepth] delegation depth, default 1 (clamped 1..5).
 * @param {string} [params.provider] subagent provider, default "spawn".
 * @param {'inherit'|'fail'} [params.fallback] routed-start fallback, default "inherit".
 * @param {AbortSignal} [params.signal] caller cancellation.
 * @param {string} [params.cwd] optional working directory (local_worker pass-through).
 * @returns {Promise<{childId: string, node: object|null, fallback: 'none'|'inherit', handle: object}>}
 */
export async function startSlaveActivation({
  ctx,
  parent,
  task,
  label,
  node,
  preset,
  maxDepth,
  provider,
  fallback,
  signal,
  cwd,
} = {}) {
  if (!parent || typeof parent !== 'object') {
    throw codedError('SLAVE_NO_PARENT', 'a slave activation needs the exact live parent (master) agent')
  }
  const taskText = safeString(task)
  if (!taskText) {
    throw codedError('SLAVE_TASK_EMPTY', 'a slave activation needs a non-empty task prompt')
  }
  const subagents = subagentsOf(ctx)
  if (!subagents || typeof subagents.startActivation !== 'function') {
    throw codedError(
      'SLAVE_UNAVAILABLE',
      'the subagents service is not available, so SlaveAgentTeams cannot start child agents; mount @deepseek-ai/dsh-subagent (the built-in "spawn" provider) and retry',
    )
  }
  const providerName = safeString(provider) || DEFAULT_PROVIDER
  const presetName = safeString(preset) || DEFAULT_PRESET
  const depth = clampInt(maxDepth, 1, MAX_DEPTH, DEFAULT_MAX_DEPTH)
  const signalObject = signal && typeof signal.addEventListener === 'function' ? signal : new AbortController().signal
  const fallbackMode = safeString(fallback) === 'fail' ? 'fail' : 'inherit'
  const routedNode = node && typeof node === 'object' ? node : null
  const labelText = safeString(label) || safeString(routedNode?.name) || 'slave'
  const cwdText = safeString(cwd)

  if (routedNode) {
    const providerEntry =
      typeof subagents.getProvider === 'function' ? subagents.getProvider(providerName) : undefined
    if (providerEntry && providerEntry.capabilities?.agentOptions !== true) {
      throw codedError(
        'UNSUPPORTED_CAPABILITY',
        `subagent provider "${providerName}" does not support per-child agentOptions, so slave node "${routedNode.name ?? '?'}" cannot choose its own model (${routedNode.provider ?? '?'}/${routedNode.model ?? '?'}); use a provider that supports agentOptions (the built-in "spawn" does) or remove node routing`,
      )
    }
    if (!safeString(routedNode.provider) || !safeString(routedNode.model)) {
      throw codedError(
        'SLAVE_ROUTE_UNAVAILABLE',
        `slave node "${routedNode.name ?? '?'}" is missing a provider or model; configure both in the SlaveAgentTeams settings before spawning`,
      )
    }
  }

  const baseRequest = requestFor({
    parent,
    task: taskText,
    preset: presetName,
    maxDepth: depth,
    node: null,
    cwd: cwdText,
  })
  const routedRequest = routedNode
    ? requestFor({ parent, task: taskText, preset: presetName, maxDepth: depth, node: routedNode, cwd: cwdText })
    : baseRequest
  const spec = (request) => ({
    provider: providerName,
    label: labelText,
    request,
    signal: signalObject,
    delivery: 'parent',
  })

  try {
    const handle = await subagents.startActivation(spec(routedRequest))
    if (!handle || typeof handle.childId !== 'string' || handle.childId === '') {
      throw codedError('SLAVE_START_FAILED', 'startActivation returned no childId; the subagent provider may be misconfigured')
    }
    return { childId: handle.childId, node: routedNode, fallback: 'none', handle }
  } catch (error) {
    if (isAbortError(error, signalObject)) throw error
    if (!routedNode || fallbackMode !== 'inherit' || !isRetryableStartError(error)) {
      throw wrapStartError(error, { node: routedNode, provider: providerName, attempt: 'first' })
    }
    // Strong-worker fallback: retry once with no agentOptions so the child
    // inherits the parent's (strong) model. Keep the preset and depth.
    try {
      const handle = await subagents.startActivation(spec(baseRequest))
      if (!handle || typeof handle.childId !== 'string' || handle.childId === '') {
        throw codedError('SLAVE_START_FAILED', 'fallback startActivation returned no childId')
      }
      return { childId: handle.childId, node: routedNode, fallback: 'inherit', handle }
    } catch (retryError) {
      if (isAbortError(retryError, signalObject)) throw retryError
      throw wrapStartError(retryError, {
        node: routedNode,
        provider: providerName,
        attempt: 'inherit',
        firstError: error,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Service (§6.5)
// ---------------------------------------------------------------------------

function createLogger(log, ctx) {
  const emit = (level, message) => {
    try {
      if (typeof log === 'function') {
        log(level, `slave-teams: ${message}`)
        return
      }
      const sink = ctx?.logger?.[level]
      if (typeof sink === 'function') sink.call(ctx.logger, `slave-teams: ${message}`)
    } catch {
      /* logging must never break registration */
    }
  }
  return {
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    debug: (message) => emit('debug', message),
  }
}

function isRootAgent(agent) {
  if (!agent || typeof agent !== 'object') return false
  return agent.session?.header?.parentSession === null || agent.session?.header?.parentSession === undefined
}

/**
 * Create the SlaveAgentTeams service. One instance per plugin load.
 * @param {object} options
 * @param {object} options.ctx host context (llm/subagents services are read lazily).
 * @param {() => object} [options.getConfig] reads the live normalized config.
 * @param {(level: string, message: string) => void} [options.log] host logger.
 * @param {object|(() => object)} [options.stats] v0.4 stats object.
 * @returns {{
 *   installFor: (agent: object, level?: string) => (() => void) | null,
 *   disposeFor: (agent: object) => void,
 *   statusFor: (agent: object) => object,
 *   listRuns: (agent: object) => Array<object>,
 *   summarize: () => object,
 *   disposeAll: () => void,
 * }}
 */
export function createSlaveTeamsService({ ctx, getConfig, log, stats } = {}) {
  /** @type {Map<object, {agent: object, level: string, nodes: Array<object>, disposers: Function[], runs: Array<object>, nextIndex: number}>} */
  const entries = new Map()
  const logger = createLogger(log, ctx)

  function readConfig() {
    try {
      const config = typeof getConfig === 'function' ? getConfig() : undefined
      return config && typeof config === 'object' ? config : {}
    } catch (error) {
      logger.warn(`live config read failed: ${errorMessage(error)}`)
      return {}
    }
  }

  function currentStats() {
    try {
      return typeof stats === 'function' ? stats() : stats
    } catch {
      return undefined
    }
  }

  function ensureEntry(agent) {
    let entry = entries.get(agent)
    if (!entry) {
      entry = { agent, level: 'default', mode: 'implicit', nodes: [], disposers: [], runs: [], nextIndex: 0 }
      entries.set(agent, entry)
    }
    return entry
  }

  function markFollowUp(run) {
    if (!run) return
    if (!run.followUpPending || typeof run.resolveFollowUp !== 'function') {
      run.followUpPending = true
      run.followUpDone = new Promise((resolve) => {
        run.resolveFollowUp = resolve
      })
    }
    run.followUpAt = Date.now()
  }

  /**
   * A follow-up message starts a new turn in the same continuable child. The
   * original activation result is already settled, so the run record is only
   * updated when the subagent service publishes the next `subagent/end` edge.
   */
  function handleSubagentEnd(first, second) {
    const info = first && typeof first === 'object' && first.id ? first : second && typeof second === 'object' && second.id ? second : first
    if (!info || typeof info.id !== 'string') return
    for (const entry of entries.values()) {
      const run = entry.runs.find((candidate) => candidate.childId === info.id)
      if (!run || run.followUpPending !== true) continue
      const startedAt = run.followUpAt || run.startedAt
      settleRun(
        run,
        info.stopReason !== 'error',
        { stopReason: info.stopReason, output: info.lastAssistantMessage },
        { countStats: false },
      )
      run.durationMs = Math.max(0, (run.settledAt || Date.now()) - startedAt)
      const resolve = run.resolveFollowUp
      run.resolveFollowUp = undefined
      run.followUpDone = undefined
      try {
        resolve?.()
      } catch {
        /* a wait resolver must never break event dispatch */
      }
    }
  }

  let removeSubagentEnd = null
  if (ctx && typeof ctx.on === 'function') {
    try {
      removeSubagentEnd = ctx.on('subagent/end', handleSubagentEnd)
    } catch (error) {
      logger.debug(`subagent/end listener unavailable: ${errorMessage(error)}`)
    }
  }

  /**
   * Resolve the node pool for a level (v0.5). Explicit `slaveNodes` always win
   * (manual override); otherwise every mounted LLM route is auto-detected and
   * the old implicit endpoint node is kept as the fallback when discovery finds
   * nothing. Results are cached briefly so status/wait calls stay cheap.
   */
  let discoveryCache = { key: '', at: 0, value: null }
  async function poolFor(level) {
    const config = readConfig()
    const explicit = Array.isArray(config.slaveNodes) ? config.slaveNodes : []
    if (explicit.length > 0) {
      return { ...resolveSlaveNodes(config, level), mode: 'explicit', providers: [] }
    }
    if (config.slaveTeamAutoDiscover === false) {
      return { ...resolveSlaveNodes(config, level), mode: 'implicit', providers: [] }
    }
    const key = JSON.stringify([
      safeString(level),
      safeString(config.endpoint?.baseURL),
      safeString(config.endpoint?.model),
      (Array.isArray(config.fallbackEndpoints) ? config.fallbackEndpoints : []).map((entry) => [
        safeString(entry?.baseURL),
        safeString(entry?.model),
      ]),
    ])
    if (discoveryCache.key === key && discoveryCache.value && Date.now() - discoveryCache.at < AUTO_DISCOVERY_CACHE_MS) {
      return discoveryCache.value
    }
    const discovery = await discoverLlmRoutes(ctx)
    const automatic = autoNodesFromProviders(discovery.providers, level)
    let value
    if (automatic.nodes.length > 0) {
      value = {
        ...automatic,
        mode: 'auto',
        providers: discovery.providers,
        issues: [...discovery.issues, ...automatic.issues],
      }
    } else {
      const implicit = resolveSlaveNodes(config, level)
      value = {
        ...implicit,
        mode: implicit.nodes.length > 0 ? 'implicit' : 'auto-empty',
        providers: discovery.providers,
        issues: [...discovery.issues, ...implicit.issues],
      }
    }
    discoveryCache = { key, at: Date.now(), value }
    return value
  }

  function uninstallScoped(entry) {
    const disposers = Array.isArray(entry?.disposers) ? entry.disposers : []
    entry.disposers = []
    for (let index = disposers.length - 1; index >= 0; index -= 1) {
      try {
        disposers[index]()
      } catch (error) {
        logger.warn(`slave scope disposer failed: ${errorMessage(error)}`)
      }
    }
  }

  function runCounts(runs) {
    let running = 0
    let settled = 0
    let failed = 0
    for (const run of runs) {
      if (run.state === 'running' || run.followUpPending) running += 1
      else if (run.state === 'failed') failed += 1
      else settled += 1
    }
    return { running, settled, failed }
  }

  function publicRun(record) {
    const view = {
      name: record.name,
      child_id: record.childId,
      node: record.node,
      provider: record.provider,
      model: record.model,
      kind: record.kind,
      status: record.followUpPending ? 'running' : record.state,
    }
    if (record.stopReason !== undefined) view.stop_reason = record.stopReason
    if (record.durationMs !== undefined) view.duration_ms = record.durationMs
    if (record.outputPreview) view.output_preview = record.outputPreview
    if (record.error !== undefined) view.error = record.error
    if (record.followUpPending) {
      view.follow_up_pending = true
      if (record.followUpAt !== undefined) view.follow_up_sent_at = record.followUpAt
    }
    return view
  }

  /** Previews are bounded per run; `wait` also bounds the total result size. */
  function applyPreviewBudget(views, maxChars) {
    let used = 0
    for (const view of views) {
      if (!view.output_preview) continue
      const remaining = Math.max(0, maxChars - used)
      if (view.output_preview.length > remaining) {
        view.output_preview = remaining > 0 ? view.output_preview.slice(0, remaining) : ''
        if (!view.output_preview) delete view.output_preview
      }
      used += view.output_preview?.length ?? 0
      if (used >= maxChars) return
    }
  }

  function settleRun(record, ok, valueOrError, { countStats = true } = {}) {
    record.settledAt = Date.now()
    record.durationMs = record.settledAt - record.startedAt
    record.followUpPending = false
    if (ok) {
      record.state = 'settled'
      record.stopReason = safeString(valueOrError?.stopReason) || 'completed'
      record.outputPreview = truncateText(outputText(valueOrError?.output), PREVIEW_CHARS)
    } else {
      record.state = 'failed'
      record.stopReason = 'error'
      record.error = truncateText(errorMessage(valueOrError), PREVIEW_CHARS)
      record.outputPreview = record.error
    }
    if (countStats) {
      try {
        recordSlaveSettled(currentStats(), {
          node: { name: record.node, provider: record.provider },
          ok,
        })
      } catch {
        /* stats must never break settlement */
      }
    }
    return record
  }

  /**
   * Register one started activation. `done` always resolves (never rejects) so
   * `slave_team_wait` can race it and the original result rejection is handled.
   */
  function registerRun(entry, { name, node, handle, fallback, label }) {
    const record = {
      name,
      label: label || name,
      childId: handle.childId,
      node: node.name,
      provider: node.provider,
      model: node.model,
      kind: node.kind,
      fallback,
      startedAt: Date.now(),
      state: 'running',
      stopReason: undefined,
      outputPreview: undefined,
      error: undefined,
      durationMs: undefined,
      resultPromise: handle.result,
      done: null,
    }
    record.done = Promise.resolve(handle.result).then(
      (value) => settleRun(record, true, value),
      (error) => settleRun(record, false, error),
    )
    entry.runs.push(record)
    return record
  }

  function settleSnapshot(agent) {
    const entry = entries.get(agent)
    const runs = entry?.runs ?? []
    return { entry, runs, counts: runCounts(runs) }
  }

  function promptSectionText(nodes, meta = {}) {
    const mode = safeString(meta.mode)
    const lines = nodes.slice(0, PROMPT_NODE_LINES).map(nodeSummaryLine)
    if (nodes.length > PROMPT_NODE_LINES) lines.push(`- … ${nodes.length - PROMPT_NODE_LINES} more node(s)`)
    const header =
      mode === 'auto'
        ? 'SlaveAgentTeams (local-delegate) is available in automatic mode: slave nodes are detected when spawning from every mounted LLM route (local routes first, then cloud), and a failed node is retried on the next one. Each slave is an independent continuable child agent, NOT a Team teammate.'
        : 'SlaveAgentTeams (local-delegate) is available: you are the master of these slave nodes. Each slave is an independent continuable child agent, NOT a Team teammate.'
    const autoNote =
      mode === 'auto'
        ? 'No manual slaveNodes are configured: use `slave_team_spawn` directly and let node selection round-robin across local routes. `slave_team_status` returns the currently detected pool.'
        : ''
    return [
      header,
      ...lines,
      ...(autoNote ? [autoNote] : []),
      'Use `slave_team_spawn` with 1..N independent tasks to start slaves in parallel (each task may name a node; otherwise the configured default node or round-robin is used, and a node that cannot start is retried on the next one). Collect results with `slave_team_wait` (mode "all" or "any", bounded timeout), inspect progress with `slave_team_status`, steer a running slave with `slave_team_send`, and stop one with `slave_team_interrupt`.',
      'Delegate independent mechanical work (edits, batches, checks) to cheap nodes and verify/synthesize their results yourself; keep judgement, architecture, and final answers on the main model.',
      'Boundary: slave tools are separate from Agent Teams. Slaves are children: they never appear in the Team roster and `wait_agent` does not wait for them; Team teammates are not slaves. Both tool families can be used in the same session.',
    ].join('\n')
  }

  function slaveStatusContext(agent) {
    const entry = entries.get(agent)
    if (!entry || entry.runs.length === 0) return ''
    const counts = runCounts(entry.runs)
    const lastFailure = [...entry.runs].reverse().find((run) => run.state === 'failed')
    const nodes = entry.nodes.map((node) => node.name).join(', ')
    return (
      `SlaveAgentTeams: ${counts.running} running, ${counts.settled} settled, ${counts.failed} failed` +
      (nodes ? `; nodes: ${nodes}` : '') +
      (lastFailure ? `. Last failure (${lastFailure.name}): ${truncateText(lastFailure.error ?? '', 240)}` : '')
    )
  }

  // -- Tool implementations -------------------------------------------------

  async function executeSpawn(args, exec, installAgent) {
    const master = exec?.agent ?? installAgent
    const entry = ensureEntry(master)
    const config = readConfig()
    const level = entry.level || safeString(config.defaultLevel) || 'default'
    const resolved = await poolFor(level)
    if (resolved.nodes.length === 0) {
      throw codedError(
        'SLAVE_NO_NODES',
        `no usable slave node for level "${level}"; ${resolved.issues.join('; ') || 'configure slaveNodes, endpoint.model, or a mounted LLM route before spawning'}`,
      )
    }
    entry.mode = resolved.mode
    entry.nodes = resolved.nodes
    const maxSlaves = clampInt(config.slaveTeamMaxSlaves, 1, MAX_SLAVES, DEFAULT_MAX_SLAVES)
    const tasks = Array.isArray(args?.tasks) ? args.tasks : []
    if (tasks.length < 1) {
      throw codedError('SLAVE_TASKS_REQUIRED', 'pass at least one task in `tasks` (each entry needs a non-empty `task`)')
    }
    if (tasks.length > maxSlaves) {
      throw codedError(
        'SLAVE_TOO_MANY_TASKS',
        `requested ${tasks.length} tasks but slaveTeamMaxSlaves is ${maxSlaves}; split the work, spawn fewer tasks, or raise slaveTeamMaxSlaves (max 8)`,
      )
    }
    const requestedDefault = safeString(args?.default_node)
    if (requestedDefault && !findNodeByName(resolved.nodes, requestedDefault)) {
      throw codedError(
        'SLAVE_NODE_UNKNOWN',
        `slave node "${requestedDefault}" is not configured for level "${level}"; available nodes: ${resolved.nodes.map((node) => node.name).join(', ')}`,
      )
    }
    const defaultNode = requestedDefault || safeString(config.slaveTeamDefaultNode)
    const preset = safeString(args?.preset) || safeString(config.slaveTeamPreset) || DEFAULT_PRESET
    const maxDepth = clampInt(args?.max_depth ?? config.slaveTeamMaxDepth, 1, MAX_DEPTH, DEFAULT_MAX_DEPTH)
    const provider = safeString(config.slaveTeamProvider) || DEFAULT_PROVIDER
    const fallback = safeString(config.slaveTeamFallback) === 'fail' ? 'fail' : 'inherit'
    const signal = signalOf(exec)
    const routeChecks = new Map()
    const started = []
    const failed = []
    const usedNames = new Set(entry.runs.map((run) => run.name))

    const checkRoute = (node) => {
      const key = `${node.provider}\u0000${node.model}`
      if (!routeChecks.has(key)) routeChecks.set(key, preflightSlaveRoute(ctx, node, signal))
      return routeChecks.get(key)
    }

    for (const [index, item] of tasks.entries()) {
      const requestedName = safeString(item?.name)
      const name = uniqueName(requestedName || `slave${index + 1}`, usedNames)
      usedNames.add(name)
      const requestedNode = safeString(item?.node)
      const taskText = safeString(item?.task)
      if (!taskText) {
        failed.push({ name, node: requestedNode || null, error: 'SLAVE_TASK_EMPTY: `task` must be a non-empty string' })
        recordSlaveFailure(currentStats(), { node: requestedNode || 'unknown', message: 'task was empty' })
        continue
      }
      if (requestedNode && !findNodeByName(resolved.nodes, requestedNode)) {
        failed.push({
          name,
          node: requestedNode,
          error: `SLAVE_NODE_UNKNOWN: slave node "${requestedNode}" is not configured for level "${level}"; available nodes: ${resolved.nodes.map((candidate) => candidate.name).join(', ')}`,
        })
        recordSlaveFailure(currentStats(), { node: requestedNode, message: 'unknown node' })
        continue
      }
      // Advance the round-robin cursor only when this task actually used it
      // (no explicit node and no configured default that still exists).
      const defaultMatches = defaultNode ? findNodeByName(resolved.nodes, defaultNode) : null
      const candidates = candidateSlaveNodes(resolved.nodes, requestedNode, defaultNode, entry.nextIndex, {
        preferLocal: resolved.mode === 'auto',
      })
      if (!requestedNode && !defaultMatches) entry.nextIndex += 1
      const tried = []
      let startedInfo = null
      let lastError = null
      for (const [attempt, node] of candidates.entries()) {
        const isLast = attempt === candidates.length - 1
        try {
          await checkRoute(node)
          const result = await startSlaveActivation({
            ctx,
            parent: master,
            task: taskText,
            label: name,
            node,
            preset,
            maxDepth,
            provider,
            // Node-level failover happens first; the parent-model `inherit`
            // retry is reserved for the last candidate so a dead cheap node
            // does not immediately burn main-model tokens.
            fallback: isLast ? fallback : 'fail',
            signal,
          })
          startedInfo = { node, result }
          break
        } catch (error) {
          lastError = error
          tried.push({ node: node.name, error: errorMessage(error) })
          if (!isNodeFailoverError(error)) break
        }
      }
      if (!startedInfo) {
        failed.push({
          name,
          node: tried[0]?.node ?? requestedNode ?? null,
          error: lastError ? errorMessage(lastError) : 'SLAVE_START_FAILED: no slave node could start the task',
          ...(tried.length > 0 ? { tried } : {}),
        })
        recordSlaveFailure(currentStats(), { node: tried[0]?.node ?? requestedNode ?? 'unknown', message: lastError ? errorMessage(lastError) : 'start failed' })
        continue
      }
      const { node, result } = startedInfo
      registerRun(entry, { name, node, handle: result.handle, fallback: result.fallback, label: name })
      recordSlaveStart(currentStats(), node)
      started.push({
        name,
        child_id: result.childId,
        node: node.name,
        provider: node.provider,
        model: node.model,
        kind: node.kind,
        fallback: result.fallback,
        ...(tried.length > 0 ? { attempts: tried.length + 1, tried } : {}),
      })
    }

    const note =
      started.length === 0
        ? `No slave started (${failed.length} task(s) failed). Fix the errors in failed[] and retry.`
        : `${started.length} of ${tasks.length} slave(s) started; use slave_team_wait to collect results` +
          (failed.length > 0 ? `, ${failed.length} task(s) failed (see failed[])` : '') +
          '.'
    return {
      started,
      failed,
      nodes: resolved.nodes.map((node) => node.name),
      mode: resolved.mode,
      note,
    }
  }

  async function executeStatus(args, exec, installAgent) {
    const master = exec?.agent ?? installAgent
    const { entry, runs, counts } = settleSnapshot(master)
    const requested = safeString(args?.name)
    let selected = runs
    if (requested) {
      selected = runs.filter((run) => run.name === requested || run.childId === requested)
      if (selected.length === 0) {
        throw codedError(
          'SLAVE_UNKNOWN_NAME',
          `no slave named "${requested}"; known slaves: ${runs.map((run) => run.name).join(', ') || '(none)'}`,
        )
      }
    }
    const config = readConfig()
    const level = entry?.level || safeString(config.defaultLevel) || 'default'
    const resolved = await poolFor(level)
    const result = {
      slaves: selected.map(publicRun),
      running: counts.running,
      settled: counts.settled,
      failed: counts.failed,
      nodes: resolved.nodes.map((node) => node.name),
      mode: resolved.mode,
      ...(resolved.issues.length > 0 ? { issues: resolved.issues.slice(0, 5) } : {}),
    }
    if (runs.length === 0) result.note = 'No slave has been started by this agent yet; call slave_team_spawn first.'
    return result
  }

  async function executeWait(args, exec, installAgent) {
    const master = exec?.agent ?? installAgent
    const { runs } = settleSnapshot(master)
    const requestedNames = Array.isArray(args?.names) ? args.names.map(safeString).filter(Boolean) : []
    let selected = runs
    if (requestedNames.length > 0) {
      const unknown = requestedNames.filter((name) => !runs.some((run) => run.name === name))
      if (unknown.length > 0) {
        throw codedError(
          'SLAVE_UNKNOWN_NAME',
          `no slave named "${unknown.join('", "')}"; known slaves: ${runs.map((run) => run.name).join(', ') || '(none)'}`,
        )
      }
      selected = runs.filter((run) => requestedNames.includes(run.name))
    }
    if (selected.length === 0) {
      return {
        settled: [],
        pending: [],
        timed_out: false,
        note: runs.length === 0 ? 'No slave has been started by this agent yet; call slave_team_spawn first.' : 'No slave matched `names`.',
      }
    }
    const timeoutMs = clampInt(args?.timeout_ms, MIN_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS, DEFAULT_WAIT_TIMEOUT_MS)
    const mode = safeString(args?.mode) === 'any' ? 'any' : 'all'
    const signal = signalOf(exec)
    const config = readConfig()
    const totalPreview = clampInt(config.maxResultChars, 1_000, 20_000, WAIT_TOTAL_CHARS)
    const isPending = (run) => run.state === 'running' || run.followUpPending === true
    const waiting = selected.filter(isPending)
    // mode "any" is satisfied immediately when at least one selected slave has
    // already settled; do not wait for the remaining running ones.
    const alreadySatisfied = mode === 'any' && selected.some((run) => !isPending(run))
    let timedOut = false
    let aborted = false
    if (waiting.length > 0 && !alreadySatisfied) {
      const outcome = await waitForRuns(waiting, {
        timeoutMs,
        mode,
        signal,
        doneOf: (run) => (run.followUpPending && run.followUpDone ? run.followUpDone : run.done),
      })
      timedOut = outcome.timedOut
      aborted = outcome.aborted
    }
    const settled = selected.filter((run) => !isPending(run)).map(publicRun)
    const pending = selected.filter(isPending).map(publicRun)
    applyPreviewBudget(settled, totalPreview)
    const note = aborted
      ? `Wait aborted after ${pending.length} slave(s) were still running; call slave_team_wait again to continue.`
      : timedOut
        ? `Timed out after ${timeoutMs}ms with ${pending.length} slave(s) still running; call slave_team_wait again to continue.`
        : pending.length > 0
          ? `${settled.length} slave(s) settled; ${pending.length} still running (mode "${mode}"). Call slave_team_wait again to collect the rest.`
          : `All ${settled.length} target slave(s) settled.`
    return { settled, pending, timed_out: timedOut, note }
  }

  async function executeSend(args, exec, installAgent) {
    const master = exec?.agent ?? installAgent
    const name = safeString(args?.name)
    const message = safeString(args?.message)
    if (!name || !message) {
      throw codedError('SLAVE_INVALID_ARGUMENT', '`name` and a non-empty `message` are required')
    }
    const { runs } = settleSnapshot(master)
    const run = runs.find((candidate) => candidate.name === name || candidate.childId === name)
    if (!run) {
      throw codedError(
        'SLAVE_UNKNOWN_NAME',
        `no slave named "${name}"; known slaves: ${runs.map((candidate) => candidate.name).join(', ') || '(none)'}`,
      )
    }
    const subagents = subagentsOf(ctx)
    if (!subagents || typeof subagents.sendMessage !== 'function') {
      throw codedError(
        'SLAVE_UNAVAILABLE',
        'the subagents service is unavailable, so a slave cannot be messaged; mount @deepseek-ai/dsh-subagent and retry',
      )
    }
    markFollowUp(run)
    let messageId
    try {
      messageId = await subagents.sendMessage(
        master,
        run.childId,
        [{ type: 'text', text: message }],
        { signal: signalOf(exec) },
      )
    } catch (error) {
      run.followUpPending = false
      run.followUpDone = undefined
      run.resolveFollowUp = undefined
      throw error
    }
    return {
      sent: true,
      name: run.name,
      message_id: messageId ?? null,
      follow_up_pending: true,
      note: 'The follow-up runs as a new turn in this slave. slave_team_wait now waits for the next settlement; the previous result stays visible until then.',
    }
  }

  async function executeInterrupt(args, exec, installAgent) {
    const master = exec?.agent ?? installAgent
    const name = safeString(args?.name)
    if (!name) throw codedError('SLAVE_INVALID_ARGUMENT', '`name` is required')
    const { runs } = settleSnapshot(master)
    const run = runs.find((candidate) => candidate.name === name || candidate.childId === name)
    if (!run) {
      throw codedError(
        'SLAVE_UNKNOWN_NAME',
        `no slave named "${name}"; known slaves: ${runs.map((candidate) => candidate.name).join(', ') || '(none)'}`,
      )
    }
    const subagents = subagentsOf(ctx)
    if (!subagents || typeof subagents.interrupt !== 'function') {
      throw codedError(
        'SLAVE_UNAVAILABLE',
        'the subagents service is unavailable, so a slave cannot be interrupted; mount @deepseek-ai/dsh-subagent and retry',
      )
    }
    subagents.interrupt(run.childId, { kind: 'ancestor', agent: master })
    return { accepted: true, name: run.name }
  }

  // -- Tool definitions -----------------------------------------------------

  function definitionsFor(installAgent) {
    const spawn = {
      name: 'slave_team_spawn',
      description:
        'Start 1..N slave subagents in parallel on the configured or auto-detected SlaveAgentTeams nodes (cheap local or cloud models; automatic mode discovers every mounted LLM route/model at spawn time and prefers local routes). Each slave is an independent continuable child agent; it is not a Team teammate. A node that cannot start is retried on the next candidate. Returns which slaves started with their child_id/node/model and which tasks failed with actionable errors. Results are collected later with slave_team_wait; status/send/interrupt operate by slave name.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description:
              'Independent tasks, one slave per entry (1..slaveTeamMaxSlaves, max 8). Keep tasks disjoint: each slave works in the same workspace, so give it its own files or an explicit read-only job. Each task should include the files, the acceptance criteria, and how to verify the result.',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Short unique slave name, used later by status/wait/send/interrupt. Defaults to slave1..N; duplicates are suffixed -2, -3.',
                },
                task: {
                  type: 'string',
                  description: 'Complete, self-contained task prompt for the slave.',
                },
                node: {
                  type: 'string',
                  description:
                    'Slave node name from the current pool (manual or auto-detected; see slave_team_status). Omit for the default node or local-first round-robin.',
                },
              },
              required: ['task'],
              additionalProperties: false,
            },
          },
          default_node: {
            type: 'string',
            description: 'Node name for tasks without `node`; overrides the configured default node for this call only.',
          },
          preset: {
            type: 'string',
            description: 'Agent preset for the slaves; defaults to the configured slaveTeamPreset (standard).',
          },
          max_depth: {
            type: 'number',
            description: 'Delegation depth for the slaves (1..5); defaults to slaveTeamMaxDepth.',
          },
        },
        required: ['tasks'],
        additionalProperties: false,
      },
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderSpawn(value) }],
      },
      timeoutMs: 120_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return await executeSpawn(args && typeof args === 'object' ? args : {}, exec, installAgent)
      },
    }

    const status = {
      name: 'slave_team_status',
      description:
        'Report the slave runs started by this master: per-slave node/model, status (running|settled|failed), stop reason, duration, and a bounded output preview. Use it to check progress without waiting; use slave_team_wait to block for results.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Only report this slave name (or child_id). Omit for every slave.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
      },
      timeoutMs: 30_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return await executeStatus(args && typeof args === 'object' ? args : {}, exec, installAgent)
      },
    }

    const wait = {
      name: 'slave_team_wait',
      description:
        'Wait for slave results. Default mode "all" waits until every selected slave settles; "any" returns as soon as one settles. Returns settled/pending slave summaries with stop reason and bounded output previews. A timeout is not an error — call again to keep waiting.',
      parameters: {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'string' },
            description: 'Slave names to wait for; omit to wait for every slave started by this agent.',
          },
          timeout_ms: {
            type: 'number',
            description: `Wait budget in milliseconds (clamped ${MIN_WAIT_TIMEOUT_MS}..${MAX_WAIT_TIMEOUT_MS}); defaults to ${DEFAULT_WAIT_TIMEOUT_MS}.`,
          },
          mode: {
            type: 'string',
            enum: ['all', 'any'],
            description: '"all" waits for every selected slave, "any" returns after the first result. Defaults to all.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderWait(value) }],
      },
      timeoutMs: 1_800_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return await executeWait(args && typeof args === 'object' ? args : {}, exec, installAgent)
      },
    }

    const send = {
      name: 'slave_team_send',
      description:
        'Send a message to one running (or idle continuable) slave by name. The slave receives it at its next step boundary or starts another turn; a later slave_team_wait waits for that follow-up settlement. Returns the accepted message id. Use it to steer a slave; the Team send_message tool does not address slaves.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Slave name (or child_id) from slave_team_spawn/status.' },
          message: { type: 'string', description: 'Message text for the slave.' },
        },
        required: ['name', 'message'],
        additionalProperties: false,
      },
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [
          {
            type: 'text',
            text: `Message sent to slave "${value.name}" (id ${value.message_id ?? 'unknown'}).${value.note ? ' ' + value.note : ''}`,
          },
        ],
      },
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return await executeSend(args && typeof args === 'object' ? args : {}, exec, installAgent)
      },
    }

    const interrupt = {
      name: 'slave_team_interrupt',
      description:
        'Interrupt one slave by name. Fire-and-return: the cancel signal is issued, the slave may keep running until it observes it, and its result promise still settles (typically with stop_reason "aborted"). Pending inbox work and published descendants are preserved.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Slave name (or child_id) from slave_team_spawn/status.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: `Interrupt accepted for slave "${value.name}".` }],
      },
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return await executeInterrupt(args && typeof args === 'object' ? args : {}, exec, installAgent)
      },
    }

    return [spawn, status, wait, send, interrupt]
  }

  // -- Bound-wait helper ----------------------------------------------------

  function waitForRuns(runs, { timeoutMs, mode, signal, doneOf = (run) => run.done }) {
    if (!Array.isArray(runs) || runs.length === 0) {
      return Promise.resolve({ timedOut: false, aborted: false })
    }
    return new Promise((resolve) => {
      let finished = false
      let timer
      const finish = (outcome) => {
        if (finished) return
        finished = true
        if (timer !== undefined) clearTimeout(timer)
        try {
          signal?.removeEventListener?.('abort', onAbort)
        } catch {
          /* ignore */
        }
        resolve(outcome)
      }
      const onAbort = () => finish({ timedOut: false, aborted: true })
      if (signal?.aborted) {
        finish({ timedOut: false, aborted: true })
        return
      }
      try {
        signal?.addEventListener?.('abort', onAbort, { once: true })
      } catch {
        /* ignore */
      }
      timer = setTimeout(() => finish({ timedOut: true, aborted: false }), timeoutMs)
      const all = runs.map((run) => doneOf(run))
      const raced = mode === 'any' ? Promise.race(all) : Promise.all(all)
      raced.then(
        () => finish({ timedOut: false, aborted: false }),
        () => finish({ timedOut: false, aborted: false }),
      )
    })
  }

  // -- Renderers ------------------------------------------------------------

  function renderSpawn(value) {
    const lines = []
    if (value?.mode === 'auto') lines.push(`Node pool: automatic (${Array.isArray(value.nodes) ? value.nodes.length : 0} detected route/model pair(s))`)
    if (Array.isArray(value?.started) && value.started.length > 0) {
      lines.push(`Started ${value.started.length} slave(s):`)
      for (const item of value.started) {
        lines.push(
          `  - ${item.name} → ${item.node} (${item.provider}/${item.model}); child_id ${item.child_id}${item.fallback === 'inherit' ? '; fallback=inherit (parent model)' : ''}${item.attempts > 1 ? `; ${item.attempts} node attempt(s)` : ''}`,
        )
      }
    }
    if (Array.isArray(value?.failed) && value.failed.length > 0) {
      lines.push(`Failed ${value.failed.length} task(s):`)
      for (const item of value.failed) {
        const tried = Array.isArray(item.tried) && item.tried.length > 1 ? ` (tried ${item.tried.map((entry) => entry.node).join(' → ')})` : ''
        lines.push(`  - ${item.name} (${item.node ?? 'no node'}): ${item.error}${tried}`)
      }
    }
    if (value?.note) lines.push(String(value.note))
    return lines.join('\n') || 'No slave started.'
  }

  function renderStatus(value) {
    const slaves = Array.isArray(value?.slaves) ? value.slaves : []
    if (slaves.length === 0) {
      const lines = [String(value?.note ?? 'No slave has been started by this agent yet.')]
      if (value?.mode === 'auto' && Array.isArray(value.nodes) && value.nodes.length > 0) {
        lines.push(`Detected node pool (${value.nodes.length}): ${value.nodes.join(', ')}`)
      }
      return lines.join('\n')
    }
    const mode = value?.mode === 'auto' ? ' (automatic pool)' : ''
    const lines = [`Slaves: ${slaves.length} shown; ${value.running} running, ${value.settled} settled, ${value.failed} failed${mode}.`]
    for (const item of slaves) {
      const tail =
        item.status === 'running'
          ? ''
          : `, stop_reason=${item.stop_reason ?? 'unknown'}, ${item.duration_ms ?? 0}ms`
      lines.push(`  - ${item.name} [${item.node}; ${item.provider}/${item.model}] ${item.status}${tail}`)
      if (item.output_preview) {
        const preview = String(item.output_preview).split('\n').slice(0, 3).join(' / ')
        lines.push(`    ${truncateText(preview, 320)}`)
      }
      if (item.error) lines.push(`    error: ${truncateText(String(item.error), 320)}`)
    }
    return lines.join('\n')
  }

  function renderWait(value) {
    const settled = Array.isArray(value?.settled) ? value.settled : []
    const pending = Array.isArray(value?.pending) ? value.pending : []
    const lines = []
    if (settled.length > 0) {
      lines.push(`Settled ${settled.length} slave(s):`)
      for (const item of settled) {
        lines.push(
          `  - ${item.name} → ${item.status} (stop_reason=${item.stop_reason ?? 'unknown'}, ${item.duration_ms ?? 0}ms)`,
        )
        if (item.output_preview) {
          lines.push(`    ${truncateText(String(item.output_preview).split('\n').slice(0, 4).join(' / '), 320)}`)
        }
        if (item.error) lines.push(`    error: ${truncateText(String(item.error), 320)}`)
      }
    }
    if (pending.length > 0) lines.push(`Still running: ${pending.map((item) => item.name).join(', ')}`)
    if (value?.note) lines.push(String(value.note))
    return lines.join('\n') || 'No slave result yet.'
  }

  // -- Public service surface ----------------------------------------------

  function installFor(agent, level) {
    if (!isRootAgent(agent)) return null
    const scoped = agent.ctx
    if (
      !scoped ||
      typeof scoped !== 'object' ||
      !scoped.tools ||
      typeof scoped.tools.register !== 'function' ||
      !scoped.systemPrompt
    ) {
      return null
    }
    const config = readConfig()
    const resolvedLevel = safeString(level) || safeString(config.defaultLevel) || 'default'
    if (config.slaveTeamsEnabled !== true) {
      const existing = entries.get(agent)
      if (existing && existing.disposers.length > 0) uninstallScoped(existing)
      return null
    }
    // v0.5: the switch alone decides whether the tools exist. Automatic node
    // discovery is asynchronous, so an empty synchronous snapshot must NOT
    // uninstall the tools (a transient discovery failure used to hide them).
    const explicit = Array.isArray(config.slaveNodes) ? config.slaveNodes : []
    const auto = explicit.length === 0 && config.slaveTeamAutoDiscover !== false
    const resolved = resolveSlaveNodes(config, resolvedLevel)
    if (resolvedLevel === 'none' && auto) {
      // L0 with automatic discovery has no synchronous cloud candidate to
      // prove a usable node; do not install five dead tools that can only
      // return SLAVE_NO_NODES. Explicit cloud nodes still install below.
      const existingEntry = entries.get(agent)
      if (existingEntry && existingEntry.disposers.length > 0) uninstallScoped(existingEntry)
      logger.info('SlaveAgentTeams: automatic discovery is not installed at level "none"; configure explicit cloud nodes to use slaves')
      return null
    }
    if (!auto && resolved.nodes.length === 0) {
      // Manual/implicit mode resolves synchronously, so an empty pool is a
      // policy/configuration outcome (for example level "none" filtering every
      // local node), not a transient discovery miss.
      const existingEntry = entries.get(agent)
      if (existingEntry && existingEntry.disposers.length > 0) uninstallScoped(existingEntry)
      logger.warn(
        `SlaveAgentTeams is enabled but the node pool is empty at level "${resolvedLevel}": ${resolved.issues.join('; ') || 'configure slaveNodes or endpoint.model'}`,
      )
      return null
    }
    const mode = explicit.length > 0 ? 'explicit' : auto ? 'auto' : 'implicit'
    const existing = entries.get(agent)
    if (existing && existing.disposers.length > 0) uninstallScoped(existing)
    const entry = ensureEntry(agent)
    entry.level = resolvedLevel
    entry.mode = mode
    entry.nodes = resolved.nodes
    entry.disposers = []
    const disposers = entry.disposers
    const add = (disposer) => {
      if (typeof disposer === 'function') disposers.push(disposer)
    }
    try {
      if (config.slaveTeamPromptHelp !== false) {
        add(
          scoped.systemPrompt.section({
            name: SLAVE_SECTION_NAME,
            order: SLAVE_SECTION_ORDER,
            interpolate: false,
            text: promptSectionText(resolved.nodes, { mode }),
          }),
        )
      }
      if (typeof scoped.systemPrompt.context === 'function') {
        add(
          scoped.systemPrompt.context({
            name: SLAVE_CONTEXT_NAME,
            order: SLAVE_CONTEXT_ORDER,
            interpolate: false,
            required: false,
            text: () => slaveStatusContext(agent),
          }),
        )
      }
      for (const definition of definitionsFor(agent)) {
        add(scoped.tools.register(definition))
      }
    } catch (error) {
      uninstallScoped(entry)
      entries.delete(agent)
      logger.warn(`failed to install SlaveAgentTeams tools: ${errorMessage(error)}`)
      return null
    }
    logger.info(
      `installed for agent ${safeString(agent.id) || '(unnamed)'} at level "${resolvedLevel}" with ${resolved.nodes.length} node(s): ${resolved.nodes.map((node) => node.name).join(', ')}`,
    )
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const current = entries.get(agent)
      if (current && current.disposers === disposers) uninstallScoped(current)
    }
  }

  function disposeFor(agent) {
    const entry = entries.get(agent)
    if (!entry) return
    uninstallScoped(entry)
    entries.delete(agent)
  }

  function statusFor(agent) {
    const entry = entries.get(agent)
    const config = readConfig()
    const level = entry?.level || safeString(config.defaultLevel) || 'default'
    const explicit = Array.isArray(config.slaveNodes) ? config.slaveNodes : []
    const autoDiscover = explicit.length === 0 && config.slaveTeamAutoDiscover !== false
    const resolved = resolveSlaveNodes(config, level)
    const mode = entry?.mode || (explicit.length > 0 ? 'explicit' : autoDiscover ? 'auto' : 'implicit')
    const counts = runCounts(entry?.runs ?? [])
    return {
      installed: Boolean(entry && entry.disposers.length > 0),
      enabled: config.slaveTeamsEnabled === true,
      level,
      mode,
      autoDiscover,
      nodes: (entry?.nodes ?? resolved.nodes).map((node) => ({ ...node })),
      issues: [...resolved.issues],
      running: counts.running,
      settled: counts.settled,
      failed: counts.failed,
      runs: (entry?.runs ?? []).map(publicRun),
    }
  }

  function listRuns(agent) {
    return (entries.get(agent)?.runs ?? []).map(publicRun)
  }

  /**
   * Read-only auto-detection snapshot for the GUI (`GET /slaves`): which routes
   * are mounted, which models they advertise, and the pool a spawn would use.
   * `detected` is the full mountable catalog (for the GUI checkbox picker);
   * `nodes` is the currently saved/selected pool.
   */
  async function discover(levelOverride) {
    const config = readConfig()
    const level = safeString(levelOverride) || safeString(config.defaultLevel) || 'default'
    const explicit = Array.isArray(config.slaveNodes) ? config.slaveNodes : []
    const autoDiscover = config.slaveTeamAutoDiscover !== false
    // Always enumerate mounted routes: the GUI needs the full "available
    // nodes" catalog even when a manual/explicit node list already exists.
    const discovery = await discoverLlmRoutes(ctx)
    const automatic = autoNodesFromProviders(discovery.providers, level)
    const useAutomatic = autoDiscover && automatic.nodes.length > 0
    const pool = explicit.length > 0 ? resolveSlaveNodes(config, level) : useAutomatic ? automatic : resolveSlaveNodes(config, level)
    const mode = explicit.length > 0 ? 'explicit' : useAutomatic ? 'auto' : autoDiscover ? 'auto-empty' : 'implicit'
    return {
      mode,
      enabled: config.slaveTeamsEnabled === true,
      autoDiscover,
      level,
      nodes: pool.nodes.map((node) => ({ ...node })),
      // Every currently mountable route/model, independent of the saved pool.
      detected: automatic.nodes.map((node) => ({ ...node })),
      providers: discovery.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        models: [...provider.models],
      })),
      issues: [...discovery.issues, ...(pool.issues ?? []), ...(automatic.issues ?? [])],
      dropped: (pool.dropped ?? []).map((entry) => ({ ...entry })),
    }
  }

  function summarize() {
    const config = readConfig()
    const level = safeString(config.defaultLevel) || 'default'
    const explicit = Array.isArray(config.slaveNodes) ? config.slaveNodes : []
    const autoDiscover = explicit.length === 0 && config.slaveTeamAutoDiscover !== false
    const resolved = resolveSlaveNodes(config, level)
    let enabledAgents = 0
    let runningSlaves = 0
    let settledSlaves = 0
    let failedSlaves = 0
    for (const entry of entries.values()) {
      if (entry.disposers.length > 0) enabledAgents += 1
      const counts = runCounts(entry.runs)
      runningSlaves += counts.running
      settledSlaves += counts.settled
      failedSlaves += counts.failed
    }
    return {
      enabledAgents,
      runningSlaves,
      settledSlaves,
      failedSlaves,
      mode: explicit.length > 0 ? 'explicit' : autoDiscover ? 'auto' : 'implicit',
      autoDiscover,
      nodes: resolved.nodes.map((node) => ({ ...node })),
      issues: [...resolved.issues],
    }
  }

  function disposeAll() {
    for (const entry of entries.values()) uninstallScoped(entry)
    entries.clear()
    if (typeof removeSubagentEnd === 'function') {
      try {
        removeSubagentEnd()
      } catch {
        /* listener disposal must never break unload */
      }
      removeSubagentEnd = null
    }
  }

  return { installFor, disposeFor, statusFor, listRuns, summarize, discover, disposeAll }
}
