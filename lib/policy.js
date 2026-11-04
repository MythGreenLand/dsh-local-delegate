/**
 * Per-agent "local AI involvement level" policy (v0.4).
 *
 * At `agent/created` (and for every live agent at start) this service resolves
 * the level of the agent's workspace and installs scoped registrations on
 * `agent.ctx`:
 *
 *   none    – shadow the global delegation guidance; deny local_* tools
 *   light   – conservative guidance (thresholds enforced inside the tools)
 *   default – install NOTHING (byte-for-byte v0.3 behavior)
 *   high    – positive guidance + scoped `local_worker` tool for roots
 *   max     – planner guidance + `local_worker` + scoped tool restriction
 *
 * Child agents and Agent Teams teammates always use worker policy: no planner
 * restriction, no `local_worker`, plus a local-worker note when their model is
 * the local route. Team leads stay planners and keep every team tool.
 *
 * SlaveAgentTeams tools are installed by lib/slaves.js through installFor() and
 * only on root/planner agents with `slaveTeamsEnabled`.
 *
 * Every scoped registration is captured as a disposer and released in reverse
 * order. install() is idempotent: a second call disposes the previous layer
 * first, and dispose()/disposeAgent() are safe to call more than once.
 */
import {
  EXECUTION_TOOLS,
  LEVEL_GUIDANCE_ORDER,
  LOCAL_TOOLS,
  PLANNING_TOOLS,
  READONLY_TOOLS,
  TEAM_TOOLS,
  isChildAgent,
  levelOfAgent,
  levelPromptText,
  normalizeLevel,
  plannerDenyList,
  policyKind,
  teamRole as readTeamRole,
} from './levels.js'
import { createLocalWorkerTool } from './worker-tool.js'

const SHADOW_SECTION_NAME = 'tool:local-delegate'
const LEVEL_CONTEXT_NAME = 'local-delegate:level'
const LEVEL_CONTEXT_ORDER = 10051
const WORKER_NOTE_NAME = 'local-delegate:worker'
const WORKER_NOTE_ORDER = 10052

const WORKER_NOTE_TEXT =
  'You are a local-model worker subagent. Produce verifiable output (a diff, the changed files, or test output) and state how it can be checked. ' +
  'If the task cannot be completed, report the concrete error and what the parent should try instead; do not guess.'

const PLANNER_DENY_CANDIDATES = [
  ...EXECUTION_TOOLS,
  ...LOCAL_TOOLS,
  ...READONLY_TOOLS,
  ...TEAM_TOOLS,
  ...PLANNING_TOOLS,
]

function emptyInstalled() {
  return { prompt: false, levelContext: false, workerTool: false, workerNote: false, restrictDeny: [], slaveTeams: false }
}

function once(fn, onError) {
  let called = false
  return () => {
    if (called) return
    called = true
    try {
      fn()
    } catch (error) {
      onError?.(error)
    }
  }
}

/**
 * Create the levels policy service.
 * @param {object} deps
 * @param {object} deps.ctx Host plugin context.
 * @param {() => object} deps.getConfig live normalized config reader.
 * @param {() => object|undefined} [deps.getSlaveTeams] SlaveAgentTeams service.
 * @param {(level: string, message: string) => void} [deps.log] logger.
 * @param {object} [deps.stats] statistics (reserved; worker tool records its own).
 * @param {(spec: object) => object|Promise<object>} [deps.startSlaveActivation]
 *   Optional injection for tests; production lazily imports it from ./slaves.js.
 * @returns {object} policy service
 */
export function createLevelsPolicy({ ctx, getConfig, getSlaveTeams, log, stats, startSlaveActivation } = {}) {
  const installed = new Map()
  const listeners = []
  let started = false
  let disposed = false
  let startPromise = null
  let lazyActivation = null

  const report = (level, message) => {
    try {
      log?.(level, message)
    } catch {
      /* logging must never break lifecycle work */
    }
  }

  const lookup = (name) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  function readConfig() {
    try {
      const value = typeof getConfig === 'function' ? getConfig() : undefined
      return value && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  function listAgents() {
    const registry = lookup('agents')
    try {
      const list = registry && typeof registry.list === 'function' ? registry.list() : []
      return Array.isArray(list) ? list.filter((agent) => agent && typeof agent === 'object') : []
    } catch {
      return []
    }
  }

  function slaveTeamsService() {
    try {
      const service = typeof getSlaveTeams === 'function' ? getSlaveTeams() : undefined
      return service && typeof service === 'object' ? service : undefined
    } catch {
      return undefined
    }
  }

  function sessionLabel(agent) {
    try {
      return String(agent?.session?.id ?? agent?.id ?? '(unknown)')
    } catch {
      return '(unknown)'
    }
  }

  function resolveAgentInfo(agent, config) {
    let info = null
    try {
      info = levelOfAgent({ config, workspaceRegistry: lookup('workspaceRegistry'), agent })
    } catch (error) {
      report('debug', `policy: level resolution failed for ${sessionLabel(agent)}: ${String(error?.message ?? error).slice(0, 200)}`)
    }
    const level = normalizeLevel(info?.level) ?? normalizeLevel(config?.defaultLevel) ?? 'default'
    const source = info?.source === 'workspace' || info?.source === 'default' || info?.source === 'unmatched' ? info.source : 'unmatched'
    const workspace = info?.workspace && typeof info.workspace === 'object' ? info.workspace : null
    let kind = 'planner'
    try {
      kind = policyKind(ctx, agent) === 'worker' ? 'worker' : 'planner'
    } catch {
      kind = isChildAgent(agent) ? 'worker' : 'planner'
    }
    let membershipRole
    try {
      membershipRole = readTeamRole(ctx, agent)
    } catch {
      membershipRole = undefined
    }
    return { level, source, workspace, kind, teamRole: membershipRole }
  }

  /** Inherited (restrictable) global tool names for one agent scope. */
  function knownToolsFor(agent, candidates = []) {
    const known = new Set()
    const tools = agent?.ctx?.tools
    if (!tools) return known
    try {
      if (typeof tools.view === 'function') {
        // dsh-tools views are keyed by the agent (`tools.schemas(exec.agent)`,
        // `assembleContextFor` sets `scope: agent`), not by the scoped ctx.
        const view = tools.view(agent)
        const names = view?.restrictableNames
        if (names && typeof names[Symbol.iterator] === 'function') {
          for (const name of names) if (typeof name === 'string' && name) known.add(name)
        }
      }
    } catch {
      /* fall back to per-name lookups below */
    }
    if (known.size === 0 && typeof tools.get === 'function') {
      for (const name of candidates) {
        if (known.has(name)) continue
        try {
          if (tools.get(name, agent)) known.add(name)
        } catch {
          /* unknown names are simply skipped */
        }
      }
    }
    return known
  }

  function pushDisposer(record, disposer) {
    if (typeof disposer === 'function') record.disposers.push(disposer)
  }

  function levelContextText(record) {
    return () => {
      try {
        const config = readConfig()
        const parts = [`Local delegate level: ${record.level} (source: ${record.source}).`]
        if (record.workspace) {
          const label = String(record.workspace.title || record.workspace.path || '').trim()
          if (label) parts.push(`Workspace: ${label}.`)
        } else if (record.source === 'unmatched') {
          parts.push('Workspace: not matched to a registered workspace; the default level applies.')
        }
        parts.push(`Policy role: ${record.kind}${record.teamRole ? ` (Agent Teams ${record.teamRole})` : ''}.`)
        if (record.level === 'none') {
          parts.push('local_transform, local_batch and local_health are blocked in this workspace.')
        } else if (record.level === 'light') {
          parts.push(
            `Delegation threshold: files of at least ${config.lightMinChars} characters or batches of ${config.lightMinFiles}+ files; inline text is rejected.`,
          )
        } else if (record.level === 'high') {
          parts.push(`Delegation threshold: files of at least ${config.highMinChars} characters; local_worker is available.`)
        } else if (record.level === 'max' && record.kind === 'planner') {
          parts.push('Planner policy: execution tools are restricted; hand implementation to local_worker.')
        }
        if (record.kind === 'planner' && (record.level === 'high' || record.level === 'max')) {
          const model = String(config.workerRouteModel || config.endpoint?.model || '').trim() || '(unset)'
          parts.push(
            `Local worker route: ${config.workerRouteProvider}/${model} (preset ${config.workerPreset}, max depth ${config.workerMaxDepth}).`,
          )
        }
        if (config.slaveTeamsEnabled === true) {
          if (record.kind !== 'planner') {
            parts.push('SlaveAgentTeams tools are not installed for worker agents.')
          } else if (record.installed.slaveTeams === true) {
            parts.push('SlaveAgentTeams tools are installed.')
          } else {
            parts.push(
              `SlaveAgentTeams is enabled, but its tools are not installed for this agent (no usable slave node at level "${record.level}").`,
            )
          }
        }
        return parts.join(' ')
      } catch {
        return ''
      }
    }
  }

  function applyLevelPrompt(record, config) {
    const scoped = record.agent.ctx
    const text = levelPromptText(record.level, {
      config,
      role: record.kind,
      workspace: record.workspace,
      teamRole: record.teamRole,
      slaveTeam: { enabled: config.slaveTeamsEnabled === true },
    })
    const promptText =
      typeof text === 'string' && text.trim()
        ? text
        : `Local AI intervention level "${record.level}" applies to this workspace; follow the level guidance when delegating work to the local model.`
    const systemPrompt = scoped?.systemPrompt
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      const disposer = systemPrompt.section({
        name: SHADOW_SECTION_NAME,
        order: LEVEL_GUIDANCE_ORDER,
        interpolate: false,
        text: promptText,
      })
      pushDisposer(record, disposer)
      record.installed.prompt = true
    }
    if (systemPrompt && typeof systemPrompt.context === 'function') {
      const disposer = systemPrompt.context({
        name: LEVEL_CONTEXT_NAME,
        order: LEVEL_CONTEXT_ORDER,
        interpolate: false,
        required: false,
        text: levelContextText(record),
      })
      pushDisposer(record, disposer)
      record.installed.levelContext = true
    }
  }

  function applyLocalDeny(record, agent) {
    const tools = agent.ctx?.tools
    if (!tools || typeof tools.restrict !== 'function') return
    const known = knownToolsFor(agent, LOCAL_TOOLS)
    const deny = LOCAL_TOOLS.filter((name) => known.has(name))
    if (deny.length === 0) return
    pushDisposer(record, tools.restrict({ deny }))
    record.installed.restrictDeny = deny
  }

  function applyPlannerDeny(record, config, agent) {
    const tools = agent.ctx?.tools
    if (!tools || typeof tools.restrict !== 'function') return
    const candidates = [...PLANNER_DENY_CANDIDATES, ...(Array.isArray(config.plannerDenyExtra) ? config.plannerDenyExtra : []), ...(Array.isArray(config.plannerAllowExtra) ? config.plannerAllowExtra : [])]
    const known = knownToolsFor(agent, candidates)
    if (known.size === 0) return
    const deny = plannerDenyList({ knownTools: [...known], config }).filter((name) => name !== 'run_code' && known.has(name))
    if (deny.length === 0) return
    pushDisposer(record, tools.restrict({ deny }))
    record.installed.restrictDeny = deny
  }

  function lazyStartSlaveActivation(spec) {
    if (typeof startSlaveActivation === 'function') return startSlaveActivation(spec)
    if (!lazyActivation) {
      lazyActivation = import('./slaves.js').then((module) => {
        if (typeof module.startSlaveActivation !== 'function') {
          throw new Error('lib/slaves.js does not export startSlaveActivation')
        }
        return module.startSlaveActivation
      })
    }
    return lazyActivation.then((activate) => activate(spec))
  }

  function applyWorkerTool(record, config, agent) {
    const tools = agent.ctx?.tools
    if (!tools || typeof tools.register !== 'function') return
    const tool = createLocalWorkerTool({
      ctx,
      getConfig: readConfig,
      startSlaveActivation: lazyStartSlaveActivation,
      log: report,
      stats,
    })
    pushDisposer(record, tools.register(tool))
    record.installed.workerTool = true
  }

  function isLocalWorkerAgent(agent, config) {
    let options
    try {
      options = agent?.options
    } catch {
      options = undefined
    }
    const provider = typeof options?.provider === 'string' ? options.provider : ''
    const model = typeof options?.model === 'string' ? options.model : ''
    const routeProvider = String(config.workerRouteProvider || '')
    const endpointModel = String(config.endpoint?.model || '')
    if (routeProvider && provider === routeProvider) return true
    if (endpointModel && model === endpointModel) return true
    return false
  }

  function applyWorkerNote(record, config, agent) {
    if (!isLocalWorkerAgent(agent, config)) return
    const systemPrompt = agent.ctx?.systemPrompt
    if (!systemPrompt || typeof systemPrompt.section !== 'function') return
    pushDisposer(
      record,
      systemPrompt.section({ name: WORKER_NOTE_NAME, order: WORKER_NOTE_ORDER, interpolate: false, text: WORKER_NOTE_TEXT }),
    )
    record.installed.workerNote = true
  }

  async function installSlaveTeams(record, agent, level) {
    const service = slaveTeamsService()
    if (!service || typeof service.installFor !== 'function') return
    try {
      const result = await service.installFor(agent, level)
      if (typeof result === 'function') {
        pushDisposer(
          record,
          once(result, (error) => report('debug', `policy: SlaveAgentTeams disposer failed for ${sessionLabel(agent)}: ${String(error?.message ?? error).slice(0, 200)}`)),
        )
      }
      record.installed.slaveTeams = typeof result === 'function' ? true : Boolean(result)
    } catch (error) {
      report('warn', `policy: SlaveAgentTeams install failed for ${sessionLabel(agent)}: ${String(error?.message ?? error).slice(0, 240)}`)
    }
  }

  function disposeRecord(record) {
    if (!record) return
    const stack = Array.isArray(record.disposers) ? record.disposers.splice(0) : []
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const dispose = stack[index]
      if (typeof dispose !== 'function') continue
      try {
        dispose()
      } catch (error) {
        report('debug', `policy: scoped disposer failed: ${String(error?.message ?? error).slice(0, 200)}`)
      }
    }
    record.installed = emptyInstalled()
  }

  /**
   * Install (or reinstall) the scoped policy for one agent.
   * @returns {Promise<object|null>} the installation record, or null when the
   *   agent has no scoped context / nothing to install.
   */
  async function install(agent) {
    if (!agent || typeof agent !== 'object' || disposed) return null
    const previous = installed.get(agent)
    if (previous) {
      installed.delete(agent)
      disposeRecord(previous)
    }
    let scoped
    try {
      scoped = agent.ctx
    } catch {
      scoped = undefined
    }
    if (!scoped || typeof scoped !== 'object') return null

    const config = readConfig()
    const info = resolveAgentInfo(agent, config)
    const record = {
      agent,
      level: info.level,
      source: info.source,
      workspace: info.workspace,
      kind: info.kind,
      teamRole: info.teamRole,
      disposers: [],
      installed: emptyInstalled(),
    }

    const attempt = (label, fn) => {
      try {
        fn()
      } catch (error) {
        report('warn', `policy: ${label} failed for ${sessionLabel(agent)}: ${String(error?.message ?? error).slice(0, 240)}`)
      }
    }

    if (info.level !== 'default') {
      attempt('level prompt', () => applyLevelPrompt(record, config))
      if (info.level === 'none') attempt('L0 local tool restriction', () => applyLocalDeny(record, agent))
      if ((info.level === 'high' || info.level === 'max') && info.kind === 'planner') {
        attempt('local_worker registration', () => applyWorkerTool(record, config, agent))
      }
      if (info.level === 'max' && info.kind === 'planner') {
        attempt('L4 planner restriction', () => applyPlannerDeny(record, config, agent))
      }
      if (info.kind === 'worker') attempt('worker note', () => applyWorkerNote(record, config, agent))
    }

    if (info.kind === 'planner' && config.slaveTeamsEnabled === true) {
      await installSlaveTeams(record, agent, info.level)
    }

    installed.set(agent, record)
    return record
  }

  /** Idempotently remove every scoped registration for one agent. */
  function disposeAgent(agent) {
    if (!agent || typeof agent !== 'object') return
    const record = installed.get(agent)
    if (record) {
      installed.delete(agent)
      disposeRecord(record)
    }
    const service = slaveTeamsService()
    if (service && typeof service.disposeFor === 'function') {
      try {
        service.disposeFor(agent)
      } catch (error) {
        report('debug', `policy: SlaveAgentTeams dispose failed for ${sessionLabel(agent)}: ${String(error?.message ?? error).slice(0, 200)}`)
      }
    }
  }

  /** Reinstall every live agent (used when applyToLiveAgents is on). */
  async function reinstallAll() {
    if (disposed) return
    const agents = listAgents()
    for (const agent of agents) {
      try {
        await install(agent)
      } catch (error) {
        report('warn', `policy: reinstall failed for ${sessionLabel(agent)}: ${String(error?.message ?? error).slice(0, 240)}`)
      }
    }
    for (const agent of [...installed.keys()]) {
      if (!agents.includes(agent)) disposeAgent(agent)
    }
  }

  /** Snapshot for `/localpolicy` (config-free; caller prints config itself). */
  function describeAgent(agent) {
    const config = readConfig()
    const record = installed.get(agent)
    const info = record
      ? { level: record.level, source: record.source, workspace: record.workspace, kind: record.kind, teamRole: record.teamRole }
      : resolveAgentInfo(agent, config)
    let child = false
    try {
      child = isChildAgent(agent)
    } catch {
      child = false
    }
    let slaveTeams = { enabled: config.slaveTeamsEnabled === true, nodes: null }
    try {
      const service = slaveTeamsService()
      const summary = service && typeof service.summarize === 'function' ? service.summarize() : undefined
      if (summary && typeof summary === 'object') {
        const nodes = summary.nodes
        slaveTeams = {
          enabled: config.slaveTeamsEnabled === true,
          nodes: Array.isArray(nodes) ? nodes.length : typeof nodes === 'number' ? nodes : null,
        }
      }
    } catch {
      /* summary is diagnostic only */
    }
    return {
      sessionId: (() => {
        try {
          return String(agent?.session?.id ?? agent?.id ?? '')
        } catch {
          return ''
        }
      })(),
      root: !child,
      child,
      teamRole: info.teamRole ?? 'none',
      policyKind: info.kind,
      workspacePath: info.workspace && typeof info.workspace.path === 'string' ? info.workspace.path : null,
      workspaceTitle: info.workspace && typeof info.workspace.title === 'string' ? info.workspace.title : '',
      level: info.level,
      source: info.source,
      unmatched: info.source === 'unmatched',
      installed: record
        ? { ...record.installed, restrictDeny: [...(record.installed.restrictDeny ?? [])] }
        : { ...emptyInstalled(), restrictDeny: [] },
      slaveTeams,
    }
  }

  /**
   * Subscribe to agent lifecycle and install the current policy on every live
   * agent. Safe to call once; returns a promise that resolves after the initial
   * pass (listeners are registered synchronously before it).
   */
  function start() {
    if (started) return startPromise
    started = true
    if (typeof ctx?.on === 'function') {
      const created = ctx.on('agent/created', (payload) => {
        const agent = payload?.agent
        if (!agent) return undefined
        return install(agent).catch((error) => {
          report('warn', `policy: install failed for ${sessionLabel(agent)}: ${String(error?.message ?? error).slice(0, 240)}`)
          return null
        })
      })
      const disposedOff = ctx.on('agent/disposed', (payload) => {
        const agent = payload?.agent
        if (agent) disposeAgent(agent)
      })
      const updated = ctx.on('loader/volatile-update', () => {
        if (readConfig().applyToLiveAgents !== true) return undefined
        return reinstallAll().catch((error) => {
          report('warn', `policy: live reinstall failed: ${String(error?.message ?? error).slice(0, 240)}`)
        })
      })
      for (const off of [created, disposedOff, updated]) if (typeof off === 'function') listeners.push(off)
    }
    if (typeof ctx?.effect === 'function') {
      try {
        ctx.effect(() => () => dispose(), 'local-delegate: levels policy')
      } catch {
        /* composition without effects still works via explicit dispose() */
      }
    }
    startPromise = (async () => {
      for (const agent of listAgents()) {
        try {
          await install(agent)
        } catch (error) {
          report('warn', `policy: install failed for ${sessionLabel(agent)}: ${String(error?.message ?? error).slice(0, 240)}`)
        }
      }
    })()
    return startPromise
  }

  /** Release every scoped registration and listener; idempotent. */
  function dispose() {
    if (disposed) return
    disposed = true
    for (const off of listeners.splice(0)) {
      if (typeof off !== 'function') continue
      try {
        off()
      } catch {
        /* listener removers are best-effort */
      }
    }
    for (const agent of [...installed.keys()]) {
      try {
        disposeAgent(agent)
      } catch {
        /* keep disposing the rest */
      }
    }
    installed.clear()
  }

  return { start, dispose, reinstallAll, install, disposeAgent, describeAgent }
}
