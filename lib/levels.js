/**
 * Pure level/workspace logic for the "本地 AI 介入程度" feature (v0.4).
 *
 * Every export here is a pure function of its arguments (plus `node:fs` /
 * `node:path` for realpath resolution) so the Host policy layer, the HTTP API,
 * and headless tests can all share it. There are no DSH imports on purpose:
 * `agent`, `ctx`, and `workspaceRegistry` are consumed structurally and mocked
 * in tests.
 *
 * Levels:
 *   none    – local model disabled by policy for the workspace
 *   light   – delegate only long/mechanical work (thresholds from config)
 *   default – no scoped layer at all (byte-for-byte v0.3 behavior)
 *   high    – prefer local delegation; `local_worker` is available
 *   max     – planner only: delegate every implementation step to workers
 */
import fs from 'node:fs'
import path from 'node:path'

/** Valid level names, ordered from least to most local-model involvement. */
export const LEVELS = ['none', 'light', 'default', 'high', 'max']

/** System-prompt order of the global `tool:local-delegate` guidance section. */
export const LEVEL_GUIDANCE_ORDER = 10050

/** Tools registered by this plugin (denied at L0, re-enabled selectively). */
export const LOCAL_TOOLS = ['local_transform', 'local_batch', 'local_health']

/** Tools that mutate files / run commands / start work; denied at L4. */
export const EXECUTION_TOOLS = ['bash', 'pwsh', 'write', 'edit', 'terminal', 'workflow', 'ralph', 'subagent', 'local_transform', 'local_batch']

/** Read-only inspection tools; kept for L4 planners when plannerAllowRead is on. */
export const READONLY_TOOLS = ['read', 'glob', 'grep']

/** Agent Teams tools; when present, a planner keeps `subagent` for team compatibility. */
export const TEAM_TOOLS = [
  'spawn_teammate',
  'send_message',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
]

/** Planning/coordination tools that a planner keeps (listed for documentation/tests). */
export const PLANNING_TOOLS = [
  'todo_write',
  'ask_user_question',
  'present',
  'goal',
  'memory_search',
  'memory_remember',
  'schedule_create',
  'schedule_list',
  'schedule_update',
  'schedule_delete',
]

/** Return a valid level string or null. Values are matched exactly. */
export function normalizeLevel(value) {
  return typeof value === 'string' && LEVELS.includes(value) ? value : null
}

/**
 * Resolve a path to its canonical real path when possible.
 * `realpathSync.native` resolves symlinks and Windows drive-letter casing;
 * when the target does not exist we fall back to `path.resolve`.
 * Backslashes are intentionally preserved (comparison normalizes separators).
 */
export function canonicalPath(target) {
  if (typeof target !== 'string' || target.trim() === '') return ''
  try {
    return fs.realpathSync.native(target)
  } catch {
    try {
      return path.resolve(target)
    } catch {
      return target
    }
  }
}

/** Normalize separators/case/trailing separators for comparison only. */
function comparablePath(value) {
  return String(value)
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * Whether two paths point at the same location.
 * Case-insensitive and `/`-vs-`\` insensitive; no filesystem access.
 */
export function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = comparablePath(a)
  const right = comparablePath(b)
  return left !== '' && left === right
}

/**
 * Find the `workspaceLevels` key matching a workspace path.
 * Comparison ignores case and separator style; returns the original key or null.
 */
export function findLevelKey(workspaceLevels, workspacePath) {
  if (!workspaceLevels || typeof workspaceLevels !== 'object' || Array.isArray(workspaceLevels)) return null
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') return null
  for (const key of Object.keys(workspaceLevels)) {
    if (samePath(key, workspacePath)) return key
  }
  return null
}

/**
 * Resolve the level for a workspace path.
 * `levelsEnabled: false` behaves like `default` (no scoped layers).
 */
export function resolveLevel(config, workspacePath) {
  const source = config && typeof config === 'object' ? config : {}
  if (source.levelsEnabled === false) return 'default'
  const fallback = normalizeLevel(source.defaultLevel) ?? 'default'
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') return fallback
  const key = findLevelKey(source.workspaceLevels, workspacePath)
  if (key === null) return fallback
  return normalizeLevel(source.workspaceLevels[key]) ?? fallback
}

/**
 * Find the workspace entity for an agent.
 * First by session id membership, then by canonical session cwd vs workspace path.
 * @param {{ list?: () => Array<object> }|undefined} workspaceRegistry
 * @param {object|undefined} agent
 * @returns {object|null} the registry entity or null
 */
export function sessionWorkspace(workspaceRegistry, agent) {
  if (!workspaceRegistry || typeof workspaceRegistry.list !== 'function') return null
  let entities
  try {
    entities = workspaceRegistry.list()
  } catch {
    return null
  }
  if (!Array.isArray(entities) || entities.length === 0) return null
  const session = agent?.session
  const sessionId = session?.id
  if (typeof sessionId === 'string' && sessionId !== '') {
    for (const entity of entities) {
      if (!entity || typeof entity !== 'object') continue
      if (Array.isArray(entity.sessionIds) && entity.sessionIds.includes(sessionId)) return entity
    }
  }
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') return null
  const target = canonicalPath(cwd)
  if (!target) return null
  for (const entity of entities) {
    if (!entity || typeof entity.path !== 'string' || entity.path.trim() === '') continue
    if (samePath(canonicalPath(entity.path), target)) return entity
  }
  return null
}

/**
 * Resolve level + workspace for one agent.
 * source is 'workspace' when a workspace-level override matched, 'default'
 * when a known workspace uses the default level, and 'unmatched' when the
 * agent's session could not be tied to a workspace at all.
 * @param {{ config?: object, workspaceRegistry?: object, agent?: object }} args
 * @returns {{ level: string, workspace: object|null, source: 'workspace'|'default'|'unmatched' }}
 */
export function levelOfAgent({ config, workspaceRegistry, agent } = {}) {
  const workspace = sessionWorkspace(workspaceRegistry, agent)
  if (!workspace) {
    return { level: resolveLevel(config, ''), workspace: null, source: 'unmatched' }
  }
  const workspacePath = typeof workspace.path === 'string' ? workspace.path : ''
  const level = resolveLevel(config, workspacePath)
  if (config && config.levelsEnabled === false) return { level: 'default', workspace, source: 'default' }
  const key = findLevelKey(config?.workspaceLevels, workspacePath)
  return { level, workspace, source: key === null ? 'default' : 'workspace' }
}

/** True when the agent is a child session (subagent/teammate), false for roots. */
export function isChildAgent(agent) {
  return agent?.session?.header?.parentSession != null
}

/**
 * Read the Agent Teams membership role for an agent, if the service is mounted.
 * Always guarded: a faulty service must never break policy installation.
 * @returns {'lead'|'teammate'|undefined}
 */
export function teamRole(ctx, agent) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('agentTeams') : undefined
    const membership = service?.tryMembership?.(agent)
    const role = membership?.role
    return role === 'lead' || role === 'teammate' ? role : undefined
  } catch {
    return undefined
  }
}

/** 'worker' for child/teammate agents, 'planner' for roots (incl. Team Lead). */
export function policyKind(ctx, agent) {
  if (isChildAgent(agent)) return 'worker'
  if (teamRole(ctx, agent) === 'teammate') return 'worker'
  return 'planner'
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
}

/**
 * Tools an L4 planner must not see.
 * deny = knownTools ∩ ((EXECUTION_TOOLS ∪ LOCAL_TOOLS ∪ READONLY_TOOLS ∪ plannerDenyExtra)
 *         − plannerAllowExtra
 *         − (plannerAllowRead ? READONLY_TOOLS : [])
 *         − (team tools present ? ['subagent'] : []))
 * `run_code` (PTC transport) and `local_health` (no-token diagnostic kept by
 * the planner) are never named; unknown tools are never denied.
 * Result order follows `knownTools`; duplicates are removed.
 * @param {{ knownTools?: string[], config?: object }} args
 * @returns {string[]}
 */
export function plannerDenyList({ knownTools, config } = {}) {
  const known = stringList(knownTools)
  const source = config && typeof config === 'object' ? config : {}
  const denyExtra = stringList(source.plannerDenyExtra)
  const allowExtra = new Set(stringList(source.plannerAllowExtra))
  const allowRead = source.plannerAllowRead !== false
  const hasTeamTools = known.some((name) => TEAM_TOOLS.includes(name))
  // READONLY_TOOLS join the candidate set and are removed again when
  // plannerAllowRead is on; otherwise plannerAllowRead would have no effect.
  const candidates = new Set([...EXECUTION_TOOLS, ...LOCAL_TOOLS, ...READONLY_TOOLS, ...denyExtra])
  // Never named: run_code is the PTC transport (restrict throws on it), and
  // local_health is a no-token diagnostic the planner keeps by default
  // (levels-plan §3 L4's retain list) so it can verify the worker route before
  // delegating. An explicit plannerDenyExtra may still deny local_health.
  const explicitDeny = new Set(denyExtra)
  const seen = new Set()
  const deny = []
  for (const name of known) {
    if (seen.has(name) || name === 'run_code') continue
    if (name === 'local_health' && !explicitDeny.has(name)) continue
    if (!candidates.has(name)) continue
    if (allowExtra.has(name)) continue
    if (allowRead && READONLY_TOOLS.includes(name)) continue
    if (hasTeamTools && name === 'subagent') continue
    seen.add(name)
    deny.push(name)
  }
  return deny
}

function threshold(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.max(1, Math.floor(number)) : fallback
}

function workspaceLabel(workspace) {
  if (!workspace || typeof workspace !== 'object') return ''
  return String(workspace.title || workspace.path || '').trim()
}

/**
 * Scoped guidance for one level. The text is installed into a scoped
 * `tool:local-delegate` section (order 10050); `default` returns '' because
 * that level must install nothing at all.
 * @param {string} level
 * @param {{ config?: object, role?: 'planner'|'worker', workspace?: object, teamRole?: string, slaveTeam?: object }} context
 * @returns {string}
 */
export function levelPromptText(level, { config, role, workspace, teamRole: membershipRole, slaveTeam } = {}) {
  const kind = normalizeLevel(level)
  if (kind === null || kind === 'default') return ''
  const source = config && typeof config === 'object' ? config : {}
  const workerText =
    'You are a worker agent for this workspace: complete the delegated task and return verifiable results ' +
    '(a diff, files changed, or test output). If it fails, report the concrete error instead of guessing.'
  if (role === 'worker') {
    if (kind === 'none') return `Local AI intervention is disabled for this workspace (level "none"); use the tools you have and do not call local_* tools.\n${workerText}`
    return workerText
  }
  const label = workspaceLabel(workspace)
  const workspaceLine = label ? `Workspace: ${label}.` : ''
  if (kind === 'none') {
    return [
      'Local AI intervention is disabled for this workspace (level "none").',
      'The local_* tools are unavailable here; complete the work yourself.',
      workspaceLine,
    ].filter(Boolean).join('\n')
  }
  if (kind === 'light') {
    const minChars = threshold(source.lightMinChars, 8000)
    const minFiles = threshold(source.lightMinFiles, 3)
    return [
      'Local AI intervention is light for this workspace (level "light").',
      `Delegate only obviously mechanical or long-document work: a single file of at least ${minChars} characters, or a batch of at least ${minFiles} files.`,
      'Handle short text yourself; do not use inline local_transform for short snippets.',
      workspaceLine,
    ].filter(Boolean).join('\n')
  }
  if (kind === 'high') {
    const minChars = threshold(source.highMinChars, 2000)
    return [
      'Local AI intervention is high for this workspace (level "high").',
      `Prefer handing mechanical blocks to the local model (files of at least ${minChars} characters).`,
      'Use local_worker to delegate a whole mechanical task to a local worker subagent; review its output before relying on it.',
      workspaceLine,
    ].filter(Boolean).join('\n')
  }
  // max
  const lines = [
    'You are the planner for this workspace (level "max").',
    'Plan first: write the plan with todo_write or the team task board before acting.',
    'Hand every implementation, file modification, and command execution to local_worker; do not run them yourself.',
    'Review worker results (diff/tests) and only accept verified work.',
  ]
  if (source.plannerAllowRead === false) {
    lines.push('read/glob/grep are disabled for your role; delegate inspection to local_worker as well.')
  } else {
    lines.push('read/glob/grep remain available for planning and review.')
  }
  lines.push('local_health remains available (it generates no tokens); use it to verify the worker route before delegating.')
  if (membershipRole === 'lead') {
    lines.push('Your Agent Teams tools stay available: teammates run on the strong model, keep using them for team coordination.')
  }
  if (slaveTeam?.enabled === true) {
    lines.push('For multiple independent implementation tasks, prefer slave_team_spawn to run them in parallel and collect results with slave_team_wait.')
  }
  if (label) lines.push(`Workspace: ${label}.`)
  return lines.join('\n')
}
