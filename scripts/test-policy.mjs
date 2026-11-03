/**
 * Headless checks for the v0.4 levels policy (lib/policy.js), the
 * `local_worker` tool definition (lib/worker-tool.js), and the L0/L1
 * defense-in-depth guards in index.js. Run with `node scripts/test-policy.mjs`.
 *
 * Everything here is mock-based: a fake Host ctx (agents/on/effect/get), a fake
 * per-agent scoped ctx (tools.register/restrict/view + systemPrompt
 * section/context) and a fake workspace registry / Agent Teams membership.
 */
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import { Config, readConfig } from '../lib/config.js'
import { LEVEL_GUIDANCE_ORDER, LOCAL_TOOLS, TEAM_TOOLS } from '../lib/levels.js'
import { createLevelsPolicy } from '../lib/policy.js'

const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

/* ── mocks ─────────────────────────────────────────────────────────────── */

const BASE_TOOLS = [
  'read',
  'glob',
  'grep',
  'bash',
  'pwsh',
  'write',
  'edit',
  'todo_write',
  'ask_user_question',
  'present',
  'goal',
  'local_transform',
  'local_batch',
  'local_health',
  'subagent',
  'workflow',
  'ralph',
  'schedule_create',
  'schedule_list',
  'schedule_update',
  'schedule_delete',
  ...TEAM_TOOLS,
]

/** A fake `agent.ctx`: records every scoped registration and its disposer. */
function createScopedMock({ tools: globalTools = BASE_TOOLS, useView = true } = {}) {
  const names = [...globalTools]
  const state = {
    sections: [],
    contexts: [],
    tools: [],
    restricts: [],
    sectionCalls: 0,
    contextCalls: 0,
    registerCalls: 0,
    restrictCalls: 0,
    viewScopes: [],
    getScopes: [],
    disposals: 0,
  }
  const wrapped = (label, onDispose) => {
    let done = false
    return () => {
      if (done) return
      done = true
      state.disposals += 1
      onDispose?.(label)
    }
  }
  const removeFrom = (array, value) => {
    const index = array.indexOf(value)
    if (index >= 0) array.splice(index, 1)
  }
  const tools = {
    register(definition) {
      state.registerCalls += 1
      state.tools.push(definition)
      return wrapped(`tool:${definition.name}`, () => removeFrom(state.tools, definition))
    },
    restrict(filter) {
      state.restrictCalls += 1
      state.restricts.push(filter)
      return wrapped('restrict', () => removeFrom(state.restricts, filter))
    },
    view(scope) {
      state.viewScopes.push(scope)
      return useView ? { restrictableNames: new Set(names) } : undefined
    },
    get(name, scope) {
      state.getScopes.push(scope)
      return names.includes(name) ? { name } : undefined
    },
  }
  const systemPrompt = {
    section(value) {
      state.sectionCalls += 1
      state.sections.push(value)
      return wrapped(`section:${value.name}`, () => removeFrom(state.sections, value))
    },
    context(value) {
      state.contextCalls += 1
      state.contexts.push(value)
      return wrapped(`context:${value.name}`, () => removeFrom(state.contexts, value))
    },
  }
  return { state, scoped: { tools, systemPrompt } }
}

/** A fake live Agent handle (only the fields the policy reads). */
function makeAgent({ id, cwd = 'C:/work/alpha', parentSession, scoped, options, localModel = false } = {}) {
  return {
    id,
    session: { id, header: { cwd, ...(parentSession ? { parentSession } : {}) } },
    options: options ?? (localModel ? { provider: 'local-delegate', model: 'gemma4:e2b' } : { provider: 'deepseek', model: 'deepseek-flash' }),
    ctx: scoped,
  }
}

/** A fake DSH plugins context: agents registry, events, effects, service lookup. */
function createHost({ config = configFor(), workspaceRegistry, agentTeams, agents = [], globalPrompt } = {}) {
  const state = { config, workspaceRegistry, agentTeams, agents, globalPrompt, handlers: new Map(), effects: [], logs: [], globalTools: [], commands: [] }
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    on(name, handler) {
      state.handlers.set(name, handler)
      return () => state.handlers.delete(name)
    },
    effect(fn) {
      const cleanup = fn()
      state.effects.push(cleanup)
      return () => {
        const index = state.effects.indexOf(cleanup)
        if (index >= 0) state.effects.splice(index, 1)
        if (typeof cleanup === 'function') cleanup()
      }
    },
    get(name) {
      if (name === 'workspaceRegistry') return state.workspaceRegistry
      if (name === 'agentTeams') return state.agentTeams
      if (name === 'systemPrompt') return state.globalPrompt
      if (name === 'commands') {
        return { register: (command) => state.commands.push(command) }
      }
      if (name === 'agents') {
        return {
          list: () => state.agents,
          get: (id) => state.agents.find((agent) => agent.session?.id === id),
        }
      }
      return undefined
    },
    tools: { register: (definition) => state.globalTools.push(definition) },
  }
  return { ctx, state }
}

function buildPolicy(host, extra = {}) {
  return createLevelsPolicy({
    ctx: host.ctx,
    getConfig: () => host.state.config,
    getSlaveTeams: extra.getSlaveTeams ?? (() => undefined),
    log: (level, message) => host.state.logs.push({ level, message }),
    stats: {},
    startSlaveActivation: extra.startSlaveActivation,
  })
}

const BASE_RAW = {
  endpoint: { baseURL: 'http://127.0.0.1:11434', model: 'gemma4:e2b' },
  warmupOnStart: false,
}

function configFor(overrides = {}) {
  return readConfig(Config({ ...BASE_RAW, ...overrides }))
}

function registry(entities) {
  return { list: () => entities }
}

function workspaceEntity({ path, title = '', sessionIds = [], id } = {}) {
  return { id: id ?? title ?? path, path, title, sessionIds }
}

async function tempDir(prefix) {
  return fsp.mkdtemp(nodePath.join(os.tmpdir(), prefix))
}

function workspacePathSet(map) {
  return Object.fromEntries(Object.entries(map))
}

/* ── installation by level ─────────────────────────────────────────────── */

check('L0 planner: shadows guidance, adds level context, denies local_* tools, no worker tool', async () => {
  const { state, scoped } = createScopedMock()
  const agent = makeAgent({ id: 'l0-root', scoped })
  const host = createHost({ config: configFor({ defaultLevel: 'none' }), agents: [agent] })
  const policy = buildPolicy(host)
  await policy.start()

  assert.equal(state.sections.length, 1, 'one scoped prompt shadow')
  assert.equal(state.sections[0].name, 'tool:local-delegate')
  assert.equal(state.sections[0].order, LEVEL_GUIDANCE_ORDER)
  assert.equal(state.sections[0].interpolate, false)
  assert.match(state.sections[0].text, /disabled|none/i)
  assert.equal(state.contexts.length, 1, 'one independent level context')
  assert.equal(state.contexts[0].name, 'local-delegate:level')
  assert.equal(state.contexts[0].order, 10051)
  assert.equal(typeof state.contexts[0].text, 'function')
  assert.match(state.contexts[0].text({}), /level: none/)
  assert.equal(state.tools.length, 0, 'no local_worker at L0')
  assert.equal(state.restricts.length, 1)
  assert.deepEqual(state.restricts[0].deny, LOCAL_TOOLS)
  assert.equal(state.viewScopes[0], agent, 'tools.view is asked for the agent scope')

  const info = policy.describeAgent(agent)
  assert.equal(info.level, 'none')
  assert.equal(info.root, true)
  assert.equal(info.policyKind, 'planner')
  assert.equal(info.installed.prompt, true)
  assert.equal(info.installed.levelContext, true)
  assert.equal(info.installed.workerTool, false)
  assert.deepEqual(info.installed.restrictDeny, LOCAL_TOOLS)

  assert.equal(host.state.handlers.size, 3, 'agent/created + agent/disposed + loader/volatile-update')
  policy.dispose()
})

check('restriction falls back to per-name tools.get when view() is unavailable', async () => {
  {
    const { state, scoped } = createScopedMock({ useView: false })
    const agent = makeAgent({ id: 'l0-fallback', scoped })
    const host = createHost({ config: configFor({ defaultLevel: 'none' }), agents: [agent] })
    const policy = buildPolicy(host)
    await policy.start()
    assert.equal(state.restricts.length, 1)
    assert.deepEqual(state.restricts[0].deny, LOCAL_TOOLS)
    assert.ok(state.getScopes.length > 0 && state.getScopes.every((scope) => scope === agent), 'tools.get is scoped by the agent')
    policy.dispose()
  }
  {
    const { state, scoped } = createScopedMock({ useView: false })
    const agent = makeAgent({ id: 'l4-fallback', scoped })
    const host = createHost({ config: configFor({ defaultLevel: 'max' }), agents: [agent] })
    const policy = buildPolicy(host)
    await policy.start()
    const deny = state.restricts[0].deny
    assert.ok(deny.includes('bash'))
    assert.ok(deny.includes('local_transform'))
    assert.ok(!deny.includes('run_code'))
    policy.dispose()
  }
})

check('L1 light: conservative guidance only (no restrict, no worker tool)', async () => {
  const { state, scoped } = createScopedMock()
  const agent = makeAgent({ id: 'l1-root', scoped })
  const host = createHost({ config: configFor({ defaultLevel: 'light' }), agents: [agent] })
  const policy = buildPolicy(host)
  await policy.start()

  assert.equal(state.sections.length, 1)
  assert.match(state.sections[0].text, /light/i)
  assert.match(state.sections[0].text, /8000/)
  assert.equal(state.contexts.length, 1)
  assert.match(state.contexts[0].text({}), /8000/)
  assert.match(state.contexts[0].text({}), /inline text is rejected/i)
  assert.equal(state.restricts.length, 0, 'L1 only changes delegation thresholds')
  assert.equal(state.tools.length, 0, 'no local_worker at L1')
  policy.dispose()
})

check('L2 default: zero scoped registrations (v0.3 behavior preserved)', async () => {
  const { state, scoped } = createScopedMock()
  const agent = makeAgent({ id: 'l2-root', scoped })
  const host = createHost({ config: configFor({}), agents: [agent] })
  const policy = buildPolicy(host)
  await policy.start()

  assert.equal(state.sectionCalls, 0)
  assert.equal(state.contextCalls, 0)
  assert.equal(state.registerCalls, 0)
  assert.equal(state.restrictCalls, 0)
  assert.deepEqual(state.sections, [])
  assert.deepEqual(state.contexts, [])
  assert.deepEqual(state.tools, [])
  assert.deepEqual(state.restricts, [])

  const info = policy.describeAgent(agent)
  assert.equal(info.level, 'default')
  assert.equal(info.installed.prompt, false)
  assert.equal(info.installed.workerTool, false)
  assert.deepEqual(info.installed.restrictDeny, [])
  policy.dispose()
})

check('L3 high: positive guidance + scoped local_worker, no restrict', async () => {
  const { state, scoped } = createScopedMock()
  const agent = makeAgent({ id: 'l3-root', scoped })
  const host = createHost({ config: configFor({ defaultLevel: 'high' }), agents: [agent] })
  const policy = buildPolicy(host)
  await policy.start()

  assert.equal(state.sections.length, 1)
  assert.match(state.sections[0].text, /local_worker/)
  assert.equal(state.tools.length, 1)
  const worker = state.tools[0]
  assert.equal(worker.name, 'local_worker')
  assert.deepEqual(worker.parameters.required, ['description', 'task'])
  assert.deepEqual(Object.keys(worker.parameters.properties).sort(), ['cwd', 'description', 'max_depth', 'task'])
  assert.equal(typeof worker.execute, 'function')
  assert.equal(typeof worker.output.render, 'function')
  assert.equal(state.restricts.length, 0)

  const info = policy.describeAgent(agent)
  assert.equal(info.installed.workerTool, true)
  policy.dispose()
})

check('L4 max planner: local_worker + restriction on execution tools, keeps read/planning/team tools', async () => {
  const { state, scoped } = createScopedMock()
  const agent = makeAgent({ id: 'l4-root', scoped })
  const host = createHost({ config: configFor({ defaultLevel: 'max' }), agents: [agent] })
  const policy = buildPolicy(host)
  await policy.start()

  assert.equal(state.sections.length, 1, 'planner guidance')
  assert.match(state.sections[0].text, /planner/i)
  assert.equal(state.tools.length, 1)
  assert.equal(state.tools[0].name, 'local_worker')
  assert.equal(state.restricts.length, 1)
  const deny = state.restricts[0].deny
  for (const name of ['bash', 'pwsh', 'write', 'edit', 'workflow', 'ralph', 'local_transform', 'local_batch']) {
    assert.ok(deny.includes(name), `${name} must be denied for an L4 planner`)
  }
  for (const name of ['read', 'glob', 'grep', 'todo_write', 'ask_user_question', 'present', 'local_health', ...TEAM_TOOLS, 'run_code']) {
    assert.ok(!deny.includes(name), `${name} must NOT be denied for an L4 planner (deny: ${deny.join(',')})`)
  }
  assert.ok(!deny.includes('subagent'), 'team tools present -> subagent stays available')

  const info = policy.describeAgent(agent)
  assert.equal(info.installed.workerTool, true)
  assert.ok(info.installed.restrictDeny.includes('bash'))
  policy.dispose()
})

check('L4 plannerDenyList honors plannerAllowRead=false and deny/allow extras', async () => {
  const tools = [...BASE_TOOLS, 'mcp_custom', 'third_party_tool']
  {
    const { state, scoped } = createScopedMock({ tools })
    const agent = makeAgent({ id: 'l4-noread', scoped })
    const host = createHost({ config: configFor({ defaultLevel: 'max', plannerAllowRead: false }), agents: [agent] })
    const policy = buildPolicy(host)
    await policy.start()
    const deny = state.restricts[0].deny
    for (const name of ['read', 'glob', 'grep']) assert.ok(deny.includes(name), `${name} denied when plannerAllowRead=false`)
    policy.dispose()
  }
  {
    const { state, scoped } = createScopedMock({ tools })
    const agent = makeAgent({ id: 'l4-extras', scoped })
    const host = createHost({
      config: configFor({ defaultLevel: 'max', plannerDenyExtra: ['mcp_custom'], plannerAllowExtra: ['bash'] }),
      agents: [agent],
    })
    const policy = buildPolicy(host)
    await policy.start()
    const deny = state.restricts[0].deny
    assert.ok(deny.includes('mcp_custom'), 'plannerDenyExtra is denied when known')
    assert.ok(!deny.includes('bash'), 'plannerAllowExtra wins over the execution list')
    assert.ok(!deny.includes('third_party_tool'), 'unknown third-party tools stay available')
    policy.dispose()
  }
})

check('L4 without team tools also denies subagent', async () => {
  const tools = BASE_TOOLS.filter((name) => !TEAM_TOOLS.includes(name))
  const { state, scoped } = createScopedMock({ tools })
  const agent = makeAgent({ id: 'l4-noteam', scoped })
  const host = createHost({ config: configFor({ defaultLevel: 'max' }), agents: [agent] })
  const policy = buildPolicy(host)
  await policy.start()
  assert.ok(state.restricts[0].deny.includes('subagent'))
  policy.dispose()
})

/* ── roles: child, teammate, team lead ─────────────────────────────────── */

check('child agent at L4 uses worker policy: no planner restriction, no local_worker', async () => {
  const { state, scoped } = createScopedMock()
  const agent = makeAgent({ id: 'l4-child', parentSession: 'parent-1', scoped, localModel: true })
  const host = createHost({ config: configFor({ defaultLevel: 'max' }), agents: [agent] })
  const policy = buildPolicy(host)
  await policy.start()

  assert.equal(state.restricts.length, 0, 'children are never planner-restricted')
  assert.equal(state.tools.length, 0, 'children do not get local_worker')
  assert.equal(state.sections.length, 2, 'level shadow + local worker note')
  assert.deepEqual(
    state.sections.map((section) => section.name).sort(),
    ['local-delegate:worker', 'tool:local-delegate'],
  )
  assert.match(state.sections.find((section) => section.name === 'local-delegate:worker').text, /verifiable/i)

  const info = policy.describeAgent(agent)
  assert.equal(info.root, false)
  assert.equal(info.child, true)
  assert.equal(info.policyKind, 'worker')
  assert.equal(info.installed.workerTool, false)
  assert.equal(info.installed.workerNote, true)
  policy.dispose()
})

check('local worker note is skipped for a strong-model child', async () => {
  const { state, scoped } = createScopedMock()
  const agent = makeAgent({ id: 'strong-child', parentSession: 'parent-1', scoped })
  const host = createHost({ config: configFor({ defaultLevel: 'high' }), agents: [agent] })
  const policy = buildPolicy(host)
  await policy.start()
  assert.equal(state.sections.filter((section) => section.name === 'local-delegate:worker').length, 0)
  assert.equal(state.sections.length, 1)
  policy.dispose()
})

check('Team teammate is worker policy; Team Lead is planner and keeps team tool names', async () => {
  const { state, scoped } = createScopedMock()
  const teammate = makeAgent({ id: 'teammate-1', scoped })
  const lead = makeAgent({ id: 'lead-1', scoped: createScopedMock().scoped })
  const agentTeams = {
    tryMembership(agent) {
      if (agent === teammate) return { role: 'teammate', id: 'team-1', name: 'worker' }
      if (agent === lead) return { role: 'lead', id: 'team-1', name: 'lead' }
      return undefined
    },
  }
  const host = createHost({ config: configFor({ defaultLevel: 'max' }), agents: [teammate, lead], agentTeams })
  const policy = buildPolicy(host)
  await policy.start()

  const teammateInfo = policy.describeAgent(teammate)
  assert.equal(teammateInfo.teamRole, 'teammate')
  assert.equal(teammateInfo.policyKind, 'worker')
  assert.equal(teammateInfo.installed.workerTool, false)
  assert.deepEqual(teammateInfo.installed.restrictDeny, [])

  const leadInfo = policy.describeAgent(lead)
  assert.equal(leadInfo.teamRole, 'lead')
  assert.equal(leadInfo.policyKind, 'planner')
  assert.equal(leadInfo.installed.workerTool, true)
  assert.ok(leadInfo.installed.restrictDeny.length > 0, 'Team Lead is still a planner')
  for (const name of TEAM_TOOLS) {
    assert.ok(!leadInfo.installed.restrictDeny.includes(name), `Team Lead keeps ${name}`)
  }
  const leadShadow = lead.ctx.systemPrompt && lead.ctx.systemPrompt
  assert.ok(leadShadow, 'lead has a scoped ctx')
  policy.dispose()
})

/* ── workspaces ────────────────────────────────────────────────────────── */

check('workspace override resolves through registry + workspaceLevels (case/separator insensitive)', async () => {
  const dir = await tempDir('policy-ws-')
  const other = await tempDir('policy-ws-other-')
  try {
    const { state, scoped } = createScopedMock()
    const agent = makeAgent({ id: 'ws-agent', cwd: dir, scoped })
    const registryMock = registry([
      workspaceEntity({ path: other, title: 'Other', sessionIds: [] }),
      workspaceEntity({ path: dir, title: 'Alpha', sessionIds: ['ws-agent'] }),
    ])
    const key = process.platform === 'win32' ? dir.replace(/\\/g, '/').toUpperCase() : dir
    const host = createHost({
      config: configFor({ defaultLevel: 'default', workspaceLevels: workspacePathSet({ [key]: 'high' }) }),
      workspaceRegistry: registryMock,
      agents: [agent],
    })
    const policy = buildPolicy(host)
    await policy.start()

    const info = policy.describeAgent(agent)
    assert.equal(info.level, 'high')
    assert.equal(info.source, 'workspace')
    assert.equal(info.workspaceTitle, 'Alpha')
    assert.equal(info.workspacePath, dir)
    assert.equal(info.unmatched, false)
    assert.equal(state.tools.length, 1, 'workspace override installs the L3 layer')
    policy.dispose()
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
    await fsp.rm(other, { recursive: true, force: true })
  }
})

check('unmatched workspace falls back to defaultLevel and is reported', async () => {
  const { state, scoped } = createScopedMock()
  const agent = makeAgent({ id: 'unmatched', cwd: 'C:/definitely/missing/path', scoped })
  const host = createHost({ config: configFor({ defaultLevel: 'light' }), agents: [agent] })
  const policy = buildPolicy(host)
  await policy.start()
  const info = policy.describeAgent(agent)
  assert.equal(info.level, 'light')
  assert.equal(info.source, 'unmatched')
  assert.equal(info.unmatched, true)
  assert.equal(info.workspacePath, null)
  policy.dispose()
})

/* ── lifecycle: idempotency, events, live reinstall ────────────────────── */

check('disposers are idempotent and cleanly unwind every scoped registration', async () => {
  const { state, scoped } = createScopedMock()
  const agent = makeAgent({ id: 'lifecycle', scoped })
  const host = createHost({ config: configFor({ defaultLevel: 'max' }), agents: [agent] })
  const policy = buildPolicy(host)
  await policy.start()

  const registrations = state.sections.length + state.contexts.length + state.tools.length + state.restricts.length
  assert.equal(registrations, 4)
  assert.equal(state.disposals, 0)

  await policy.install(agent)
  assert.equal(state.sections.length, 1, 'reinstall does not stack shadows')
  assert.equal(state.tools.length, 1, 'reinstall does not stack local_worker')
  assert.equal(state.restricts.length, 1, 'reinstall does not stack restrictions')
  assert.equal(state.disposals, registrations, 'previous layer disposed exactly once')

  policy.disposeAgent(agent)
  assert.equal(state.sections.length, 0)
  assert.equal(state.contexts.length, 0)
  assert.equal(state.tools.length, 0)
  assert.equal(state.restricts.length, 0)
  assert.equal(state.disposals, registrations * 2)

  policy.disposeAgent(agent)
  assert.equal(state.disposals, registrations * 2, 'second disposeAgent is a no-op')

  await policy.install(agent)
  assert.equal(state.tools.length, 1, 'a disposed agent can be reinstalled')
  policy.dispose()
  assert.equal(state.sections.length, 0)
  assert.equal(state.tools.length, 0)
  assert.equal(state.restricts.length, 0)
})

check('start() installs live agents and handles agent/created + agent/disposed', async () => {
  const { state: firstState, scoped: firstScoped } = createScopedMock()
  const first = makeAgent({ id: 'live-1', scoped: firstScoped })
  const host = createHost({ config: configFor({ defaultLevel: 'light' }), agents: [first] })
  const policy = buildPolicy(host)
  await policy.start()

  assert.equal(firstState.sections.length, 1, 'live agent installed at start')
  assert.equal(host.state.effects.length, 1, 'ctx.effect cleanup registered')

  const { state: secondState, scoped: secondScoped } = createScopedMock()
  const second = makeAgent({ id: 'live-2', scoped: secondScoped })
  host.state.agents.push(second)
  await host.state.handlers.get('agent/created')({ agent: second, source: 'startup' })
  assert.equal(secondState.sections.length, 1, 'agent/created installs the layer')

  host.state.handlers.get('agent/disposed')({ agent: second })
  assert.equal(secondState.sections.length, 0, 'agent/disposed unwinds the layer')
  assert.equal(secondState.disposals, 2, 'level shadow + level context')

  await host.state.effects[0]()
  assert.equal(firstState.sections.length, 0, 'ctx.effect cleanup unwinds live agents')
  assert.equal(firstState.disposals, 2)
})

check('applyToLiveAgents reinstalls live agents on loader/volatile-update', async () => {
  const { state, scoped } = createScopedMock()
  const agent = makeAgent({ id: 'volatile', scoped })
  const host = createHost({ config: configFor({ defaultLevel: 'default', applyToLiveAgents: false }), agents: [agent] })
  const policy = buildPolicy(host)
  await policy.start()
  assert.equal(state.sectionCalls, 0, 'default level installs nothing')

  const update = host.state.handlers.get('loader/volatile-update')
  assert.equal(typeof update, 'function')

  host.state.config = configFor({ defaultLevel: 'high', applyToLiveAgents: false, workspaceLevels: {} })
  await update()
  assert.equal(state.sectionCalls, 0, 'applyToLiveAgents=false leaves live agents alone')

  host.state.config = configFor({ defaultLevel: 'high', applyToLiveAgents: true })
  await update()
  assert.equal(state.sections.length, 1, 'live agent picks up L3 guidance')
  assert.equal(state.tools.length, 1, 'live agent now sees local_worker')
  assert.equal(policy.describeAgent(agent).level, 'high')

  host.state.config = configFor({ defaultLevel: 'none', applyToLiveAgents: true })
  await update()
  assert.equal(state.tools.length, 0, 'local_worker removed after switching to L0')
  assert.equal(state.restricts.length, 1, 'L0 restriction installed live')
  assert.deepEqual(state.restricts[0].deny, LOCAL_TOOLS)
  assert.equal(policy.describeAgent(agent).level, 'none')
  policy.dispose()
})

/* ── SlaveAgentTeams wiring ────────────────────────────────────────────── */

check('SlaveAgentTeams installFor only runs for root planners when enabled', async () => {
  const calls = { installs: [], disposes: 0, disposerRuns: 0 }
  const service = {
    installFor(agent, level) {
      calls.installs.push({ id: agent.id, level })
      return () => {
        calls.disposerRuns += 1
      }
    },
    disposeFor() {
      calls.disposes += 1
    },
    summarize: () => ({ enabledAgents: 1, runningSlaves: 0, nodes: 2 }),
  }
  const rootScoped = createScopedMock()
  const childScoped = createScopedMock()
  const root = makeAgent({ id: 'root', scoped: rootScoped.scoped })
  const child = makeAgent({ id: 'child', parentSession: 'root', scoped: childScoped.scoped })
  const host = createHost({
    config: configFor({ defaultLevel: 'default', slaveTeamsEnabled: true }),
    agents: [root, child],
  })
  const policy = buildPolicy(host, { getSlaveTeams: () => service })
  await policy.start()

  assert.equal(calls.installs.length, 1, 'only the root gets slave tools')
  assert.deepEqual(calls.installs[0], { id: 'root', level: 'default' }, 'slave tools install even at L2')
  const rootInfo = policy.describeAgent(root)
  assert.equal(rootInfo.installed.slaveTeams, true)
  assert.equal(rootInfo.slaveTeams.nodes, 2)
  assert.equal(policy.describeAgent(child).installed.slaveTeams, false)

  policy.disposeAgent(root)
  assert.equal(calls.disposerRuns, 1, 'installer disposer ran once')
  assert.equal(calls.disposes, 1, 'disposeFor forwarded')
  policy.dispose()
})

check('SlaveAgentTeams is skipped when disabled', async () => {
  const calls = { installs: 0 }
  const service = { installFor() { calls.installs += 1; return null }, disposeFor() {}, summarize: () => ({ nodes: 0 }) }
  const { scoped } = createScopedMock()
  const root = makeAgent({ id: 'root-off', scoped })
  const host = createHost({ config: configFor({ defaultLevel: 'default', slaveTeamsEnabled: false }), agents: [root] })
  const policy = buildPolicy(host, { getSlaveTeams: () => service })
  await policy.start()
  assert.equal(calls.installs, 0)
  policy.dispose()
})

/* ── worker tool definition (dependency-injected activation) ───────────── */

check('local_worker validates exec.agent and an unset model with actionable errors', async () => {
  const { state, scoped } = createScopedMock()
  const agent = makeAgent({ id: 'worker-call', scoped })
  const host = createHost({ config: configFor({ defaultLevel: 'high', endpoint: { baseURL: BASE_RAW.endpoint.baseURL, model: '' } }), agents: [agent] })
  const policy = buildPolicy(host)
  await policy.start()
  const worker = state.tools[0]
  assert.equal(worker.name, 'local_worker')
  await assert.rejects(() => worker.execute({ description: 'x', task: 'y' }, {}), /LOCAL_WORKER_NO_AGENT/)
  await assert.rejects(
    () => worker.execute({ description: 'x', task: 'y' }, { agent }),
    (error) => error.code === 'LOCAL_MODEL_UNSET' && /endpoint\.model/.test(error.message),
  )
  assert.ok(host.state.logs.every((entry) => entry.level !== 'error'))
  policy.dispose()
})

check('local_worker starts an activation via startSlaveActivation with the contract request', async () => {
  const seen = []
  const { state, scoped } = createScopedMock()
  const agent = makeAgent({ id: 'worker-ok', scoped })
  const host = createHost({ config: configFor({ defaultLevel: 'high', plannerFallback: 'strong-worker' }), agents: [agent] })
  const policy = buildPolicy(host, {
    startSlaveActivation: async (spec) => {
      seen.push(spec)
      return { childId: 'child-42', node: spec.node, fallback: 'inherit' }
    },
  })
  await policy.start()
  const worker = state.tools[0]
  const result = await worker.execute(
    { description: 'Translate docs', task: 'Translate docs/README.md into Chinese', max_depth: 2 },
    { agent, signal: undefined },
  )
  assert.equal(seen.length, 1)
  const spec = seen[0]
  assert.equal(spec.parent, agent)
  assert.equal(spec.task, 'Translate docs/README.md into Chinese')
  assert.equal(spec.label, 'Translate docs')
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.preset, 'standard')
  assert.equal(spec.maxDepth, 2)
  assert.equal(spec.fallback, 'inherit')
  assert.equal(spec.node.name, 'local-worker')
  assert.equal(spec.node.kind, 'local')
  assert.equal(spec.node.provider, 'local-delegate')
  assert.equal(spec.node.model, 'gemma4:e2b')

  assert.equal(result.kind, 'activation')
  assert.equal(result.subagentId, 'child-42')
  assert.equal(result.fallback, 'inherit')
  assert.equal(result.routed_to, 'local-delegate/gemma4:e2b')
  policy.dispose()
})

/* ── L0/L1 defense-in-depth guards in the tools themselves ─────────────── */

check('L0/L1 tool guards fail with actionable error codes before any model call', async () => {
  let indexModule
  try {
    indexModule = await import('../index.js')
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && /slaves\.js/.test(String(error?.message))) {
      throw new Error(`index.js import is pending lib/slaves.js (owner D): ${error.message}`)
    }
    throw error
  }
  const { executeTransform, executeBatch } = indexModule
  assert.equal(typeof executeTransform, 'function')
  assert.equal(typeof executeBatch, 'function')

  const ctx = { get: () => undefined }
  const agent = { id: 'guard-agent', session: { id: 'guard-agent', header: { cwd: process.cwd() } } }
  const exec = { agent, signal: undefined }
  const runtimeFor = (config) => ({ config, refresh: () => config, stats: {} })

  for (const config of [configFor({ defaultLevel: 'none' })]) {
    const runtime = runtimeFor(config)
    await assert.rejects(
      () => executeTransform(runtime, ctx, exec, { task: 'summarize', text: 'short' }),
      (error) => error.code === 'LOCAL_LEVEL_DISABLED' && /level "none"/.test(error.message),
    )
    await assert.rejects(
      () => executeBatch(runtime, ctx, exec, { task: 'summarize', paths: ['a.txt'] }),
      (error) => error.code === 'LOCAL_LEVEL_DISABLED',
    )
  }

  const light = configFor({ defaultLevel: 'light', allowOutsideCwd: true, lightMinChars: 8000, lightMinFiles: 3 })
  const runtime = runtimeFor(light)
  await assert.rejects(
    () => executeTransform(runtime, ctx, exec, { task: 'summarize', text: 'short inline text' }),
    (error) => error.code === 'LOCAL_LEVEL_GUARD' && /inline text/.test(error.message),
  )

  const dir = await tempDir('policy-guard-')
  try {
    const smallPath = nodePath.join(dir, 'small.md')
    await fsp.writeFile(smallPath, 'tiny', 'utf8')
    await assert.rejects(
      () => executeTransform(runtime, ctx, exec, { task: 'summarize', path: smallPath }),
      (error) => error.code === 'LOCAL_LEVEL_GUARD' && /level "light"/.test(error.message),
    )

    // Dry runs are explicitly allowed at L1 and never reach the model.
    const dry = await executeBatch(runtime, ctx, exec, { task: 'summarize', paths: [smallPath], dry_run: true })
    assert.equal(dry.dry_run, true)
    assert.equal(dry.processed, undefined)
    assert.equal(dry.files.length, 1)

    await assert.rejects(
      () => executeBatch(runtime, ctx, exec, { task: 'summarize', paths: [smallPath], dry_run: false }),
      (error) => error.code === 'LOCAL_LEVEL_GUARD' && /at least 3 files/.test(error.message),
    )
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

check('default level keeps the v0.3 tool path (guards do not fire)', async () => {
  let indexModule
  try {
    indexModule = await import('../index.js')
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && /slaves\.js/.test(String(error?.message))) {
      throw new Error(`index.js import is pending lib/slaves.js (owner D): ${error.message}`)
    }
    throw error
  }
  const ctx = { get: () => undefined }
  const agent = { id: 'default-agent', session: { id: 'default-agent', header: { cwd: process.cwd() } } }
  const config = configFor({ defaultLevel: 'default', allowOutsideCwd: true })
  const runtime = { config, refresh: () => config, stats: {} }
  const dir = await tempDir('policy-default-')
  try {
    const filePath = nodePath.join(dir, 'doc.md')
    await fsp.writeFile(filePath, 'content', 'utf8')
    const dry = await indexModule.executeBatch(runtime, ctx, { agent }, { task: 'summarize', paths: [filePath] })
    assert.equal(dry.dry_run, true)
    assert.equal(dry.total_chars, 7)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

check('apply() wires the policy service and /localpolicy reports live scoped state', async () => {
  let indexModule
  try {
    indexModule = await import('../index.js')
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && /slaves\.js/.test(String(error?.message))) {
      throw new Error(`index.js import is pending lib/slaves.js (owner D): ${error.message}`)
    }
    throw error
  }
  const { state, scoped } = createScopedMock()
  const agent = makeAgent({ id: 'apply-agent', cwd: process.cwd(), scoped })
  const host = createHost({ config: configFor({ defaultLevel: 'max' }), agents: [agent] })
  const raw = Config({
    endpoint: { baseURL: BASE_RAW.endpoint.baseURL, model: 'gemma4:e2b' },
    warmupOnStart: false,
    defaultLevel: 'max',
  })
  indexModule.apply(host.ctx, raw)
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.ok(host.state.globalTools.some((tool) => tool.name === 'local_transform'), 'global v0.3 tools still registered')
  assert.equal(state.tools.length, 1, 'scoped local_worker installed through apply()')
  assert.equal(state.tools[0].name, 'local_worker')
  assert.equal(state.restricts.length, 1, 'L4 restriction installed through apply()')

  const command = host.state.commands.find((entry) => entry.name === 'localpolicy')
  assert.ok(command, '/localpolicy command registered')
  const result = command.handler()
  assert.equal(result.kind, 'success')
  assert.match(result.text, /levels: enabled=true/)
  assert.match(result.text, /level: max/)
  assert.match(result.text, /local_worker/)
  assert.match(result.text, /restrict deny:/)

  for (const cleanup of [...host.state.effects]) if (typeof cleanup === 'function') cleanup()
  assert.equal(state.sections.length, 0, 'effect cleanup unwinds the scoped layer')
  assert.equal(state.tools.length, 0)
  assert.equal(state.restricts.length, 0)
})

/* ── runner ────────────────────────────────────────────────────────────── */

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log('ok   -', name)
  } catch (error) {
    failed += 1
    console.error('FAIL -', name)
    console.error(error)
  }
}
if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log(`\nall ${checks.length} checks passed`)
