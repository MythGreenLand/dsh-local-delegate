/**
 * Headless checks for the SlaveAgentTeams host core (lib/slaves.js) and the
 * v0.4 stats additions. Run with `node scripts/test-slaves.mjs`.
 *
 * Mocks are deliberately shaped like the rc.5 contracts:
 *   ctx.get('llm').resolveCallConfig(route, signal)
 *   ctx.subagents.{getProvider,startActivation,sendMessage,interrupt}
 *   agent.ctx.{tools.register,systemPrompt.section,systemPrompt.context}
 */
import assert from 'node:assert/strict'
import {
  SLAVE_TOOL_NAMES,
  createSlaveTeamsService,
  normalizeSlaveNode,
  preflightSlaveRoute,
  resolveSlaveNodes,
  selectSlaveNode,
  startSlaveActivation,
} from '../lib/slaves.js'
import {
  createStats,
  recordSlaveFailure,
  recordSlaveSettled,
  recordSlaveStart,
  recordWorkerFailure,
  recordWorkerStart,
  renderStats,
  statsSnapshot,
} from '../lib/stats.js'

const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    endpoint: { kind: 'ollama-native', baseURL: 'http://10.0.101.11:11434', model: 'gemma4:e2b' },
    fallbackEndpoints: [],
    modelsByTask: {},
    maxResultChars: 6000,
    workerRouteProvider: 'local-delegate',
    workerRouteModel: '',
    slaveTeamsEnabled: true,
    slaveNodes: [],
    slaveTeamDefaultNode: '',
    slaveTeamProvider: 'spawn',
    slaveTeamPreset: 'standard',
    slaveTeamMaxSlaves: 4,
    slaveTeamMaxDepth: 1,
    slaveTeamFallback: 'inherit',
    slaveTeamPromptHelp: true,
    ...overrides,
  }
}

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Host context mock: services are read through ctx.get(name). */
function mockHost({ llm, subagents } = {}) {
  const services = new Map()
  if (llm !== undefined) services.set('llm', llm)
  if (subagents !== undefined) services.set('subagents', subagents)
  return {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    get(name) {
      return services.get(name)
    },
    services,
  }
}

/** Exact-agent scope mock; each registration returns a disposer. */
function mockAgent({ id = 'root-agent', parentSession = null } = {}) {
  const registered = []
  const sections = []
  const contexts = []
  const scoped = {
    systemPrompt: {
      section(value) {
        sections.push(value)
        return () => {
          const index = sections.indexOf(value)
          if (index >= 0) sections.splice(index, 1)
        }
      },
      context(value) {
        contexts.push(value)
        return () => {
          const index = contexts.indexOf(value)
          if (index >= 0) contexts.splice(index, 1)
        }
      },
    },
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
  }
  return {
    agent: {
      id,
      session: { header: { parentSession } },
      options: { provider: 'deepseek-account', model: 'deepseek-flash' },
      ctx: scoped,
    },
    registered,
    sections,
    contexts,
  }
}

/** LLM service mock with per-route failure injection. */
function mockLlm({ reject = null, rejectProvider = null } = {}) {
  const calls = []
  return {
    calls,
    async resolveCallConfig(route, signal) {
      calls.push({ route, signal })
      if (rejectProvider && route.provider === rejectProvider) throw new Error(`no adapter for ${route.provider}`)
      if (reject) throw reject
    },
  }
}

/** Subagent service mock: every start returns a pending result promise. */
function mockSubagents({ capabilities = { agentOptions: true, agentPreset: true }, behavior = null } = {}) {
  const calls = { start: [], send: [], interrupt: [] }
  const providers = new Map([['spawn', { name: 'spawn', capabilities, inheritsParentContext: false }]])
  const pending = []
  const subagents = {
    calls,
    pending,
    getProvider(name) {
      return providers.get(name)
    },
    async startActivation(spec) {
      calls.start.push(spec)
      const index = calls.start.length
      if (behavior) {
        const outcome = behavior(spec, index)
        if (outcome?.error) throw outcome.error
      }
      const childId = `child-${index}`
      let resolveResult
      let rejectResult
      const result = new Promise((resolve, reject) => {
        resolveResult = resolve
        rejectResult = reject
      })
      const handle = { childId, result, dispose() {} }
      pending.push({ childId, resolve: resolveResult, reject: rejectResult, spec })
      return handle
    },
    async sendMessage(sender, targetId, content, options) {
      calls.send.push({ sender, targetId, content, options })
      return `msg-${calls.send.length}`
    },
    interrupt(targetId, authority) {
      calls.interrupt.push({ targetId, authority })
    },
  }
  return subagents
}

function setupSlaveAgent({ config = baseConfig(), subagents = mockSubagents(), llm = mockLlm(), level = 'default' } = {}) {
  const host = mockHost({ llm, subagents })
  const stats = createStats()
  const service = createSlaveTeamsService({ ctx: host, getConfig: () => config, log: () => {}, stats })
  const mocked = mockAgent()
  const dispose = service.installFor(mocked.agent, level)
  assert.equal(typeof dispose, 'function', 'installFor should install for an enabled root agent with usable nodes')
  const byName = new Map(mocked.registered.map((definition) => [definition.name, definition]))
  const exec = (signal = new AbortController().signal) => ({ agent: mocked.agent, signal })
  return {
    config,
    host,
    stats,
    service,
    agent: mocked.agent,
    registered: mocked.registered,
    sections: mocked.sections,
    contexts: mocked.contexts,
    dispose,
    exec,
    tool(name) {
      const definition = byName.get(name)
      assert.ok(definition, `tool ${name} should be registered`)
      return definition
    },
    spawn: byName.get('slave_team_spawn'),
    status: byName.get('slave_team_status'),
    wait: byName.get('slave_team_wait'),
    send: byName.get('slave_team_send'),
    interrupt: byName.get('slave_team_interrupt'),
    subagents,
    llm,
  }
}

// ---------------------------------------------------------------------------
// Node model
// ---------------------------------------------------------------------------

check('normalizeSlaveNode trims fields and tolerates bad drafts', () => {
  assert.deepEqual(normalizeSlaveNode({ name: ' a ', kind: 'CLOUD', provider: ' p ', model: ' m ', note: ' n ' }), {
    name: 'a',
    kind: 'cloud',
    provider: 'p',
    model: 'm',
    note: 'n',
  })
  assert.equal(normalizeSlaveNode({ kind: 'weird' }).kind, 'local')
  assert.equal(normalizeSlaveNode({ provider: '' }).provider, 'local-delegate')
  assert.equal(normalizeSlaveNode({ model: '' }).model, '')
  assert.deepEqual(normalizeSlaveNode(null), {
    name: '',
    kind: 'local',
    provider: 'local-delegate',
    model: '',
    note: '',
  })
})

check('resolveSlaveNodes uses an implicit local node from the worker route', () => {
  const resolved = resolveSlaveNodes(baseConfig({ slaveNodes: [] }), 'default')
  assert.equal(resolved.nodes.length, 1)
  assert.deepEqual(resolved.nodes[0], {
    name: 'local',
    kind: 'local',
    provider: 'local-delegate',
    model: 'gemma4:e2b',
    note: 'implicit endpoint node',
  })
  assert.equal(resolved.issues.length, 0)
})

check('resolveSlaveNodes reports an implicit node with no model', () => {
  const resolved = resolveSlaveNodes(
    baseConfig({ endpoint: { model: '' }, slaveNodes: [], workerRouteModel: '' }),
    'default',
  )
  assert.equal(resolved.nodes.length, 0)
  assert.match(resolved.issues.join(' '), /endpoint\.model is empty/)
})

check('resolveSlaveNodes applies endpoint model, dedupes names, truncates after 12', () => {
  const resolved = resolveSlaveNodes(
    baseConfig({
      endpoint: { model: 'fallback-model' },
      slaveNodes: [
        { name: 'b', kind: 'cloud', provider: 'deepseek-account', model: 'deepseek-flash' },
        { name: 'a', kind: 'local', provider: 'local-delegate', model: '' },
        { name: 'B', kind: 'local', provider: 'x', model: 'y' },
      ],
    }),
    'default',
  )
  assert.deepEqual(resolved.nodes.map((node) => node.name), ['b', 'a'])
  assert.equal(resolved.nodes[1].model, 'fallback-model')
  assert.match(resolved.issues.join(' '), /duplicate node name "B"/)

  const many = resolveSlaveNodes(
    baseConfig({
      slaveNodes: Array.from({ length: 13 }, (_, index) => ({
        name: `n${index + 1}`,
        kind: 'cloud',
        provider: 'deepseek-account',
        model: 'deepseek-flash',
      })),
    }),
    'default',
  )
  assert.equal(many.nodes.length, 12)
  assert.match(many.issues.join(' '), /only the first 12 slave nodes/)
})

check('resolveSlaveNodes level none filters local nodes and keeps cloud nodes', () => {
  const config = baseConfig({
    slaveNodes: [
      { name: 'local-a', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' },
      { name: 'cloud-a', kind: 'cloud', provider: 'deepseek-account', model: 'deepseek-flash' },
    ],
  })
  const none = resolveSlaveNodes(config, 'none')
  assert.deepEqual(none.nodes.map((node) => node.name), ['cloud-a'])
  assert.deepEqual(none.dropped.map((entry) => entry.name), ['local-a'])
  assert.match(none.dropped[0].reason, /level "none" disables local slave nodes/)

  const implicitNone = resolveSlaveNodes(baseConfig({ slaveNodes: [] }), 'none')
  assert.equal(implicitNone.nodes.length, 0)
  assert.deepEqual(implicitNone.dropped.map((entry) => entry.name), ['local'])
})

check('selectSlaveNode prefers explicit name, then default, then round-robin', () => {
  const nodes = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
  assert.equal(selectSlaveNode(nodes, 'b', null, 0).name, 'b')
  assert.equal(selectSlaveNode(nodes, 'B', null, 0).name, 'b')
  assert.equal(selectSlaveNode(nodes, null, 'c', 0).name, 'c')
  assert.equal(selectSlaveNode(nodes, null, null, 0).name, 'a')
  assert.equal(selectSlaveNode(nodes, null, '', 4).name, 'b')
  assert.equal(selectSlaveNode(nodes, 'missing', null, 0), null)
  assert.equal(selectSlaveNode(nodes, null, 'gone', 1).name, 'b')
  assert.equal(selectSlaveNode([], 'a', null, 0), null)
})

// ---------------------------------------------------------------------------
// Route preflight
// ---------------------------------------------------------------------------

check('preflightSlaveRoute resolves the route through llm.resolveCallConfig', async () => {
  const llm = mockLlm()
  const host = mockHost({ llm })
  const controller = new AbortController()
  const result = await preflightSlaveRoute(
    host,
    { name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' },
    controller.signal,
  )
  assert.deepEqual(result, { ok: true, provider: 'local-delegate', model: 'gemma4:e2b' })
  assert.deepEqual(llm.calls[0].route, { provider: 'local-delegate', model: 'gemma4:e2b' })
  assert.equal(llm.calls[0].signal, controller.signal)
})

check('preflightSlaveRoute throws SLAVE_ROUTE_UNAVAILABLE with remediation', async () => {
  const host = mockHost({ llm: mockLlm({ reject: new Error('no adapter for route') }) })
  await assert.rejects(
    preflightSlaveRoute(host, { name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' }),
    (error) => {
      assert.equal(error.code, 'SLAVE_ROUTE_UNAVAILABLE')
      assert.match(error.message, /cannot be resolved/)
      assert.match(error.message, /Enable for Subagent/)
      return true
    },
  )
  await assert.rejects(
    preflightSlaveRoute(host, { name: 'bad', kind: 'cloud', provider: '', model: '' }),
    (error) => {
      assert.equal(error.code, 'SLAVE_ROUTE_UNAVAILABLE')
      assert.match(error.message, /provider and a model/)
      return true
    },
  )
})

check('preflightSlaveRoute skips cleanly when the llm service is absent', async () => {
  const result = await preflightSlaveRoute(
    mockHost(),
    { name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' },
  )
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
  assert.match(result.reason, /llm service is unavailable/)
})

// ---------------------------------------------------------------------------
// startSlaveActivation
// ---------------------------------------------------------------------------

check('startSlaveActivation sends the exact routed request shape', async () => {
  const subagents = mockSubagents()
  const parent = { id: 'master-agent' }
  const controller = new AbortController()
  const result = await startSlaveActivation({
    ctx: mockHost({ subagents }),
    parent,
    task: 'update the changelog',
    label: 'slave1',
    node: { name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' },
    preset: 'standard',
    maxDepth: 2,
    provider: 'spawn',
    fallback: 'inherit',
    signal: controller.signal,
  })
  assert.equal(result.childId, 'child-1')
  assert.equal(result.fallback, 'none')
  assert.equal(result.node.name, 'local')
  assert.equal(subagents.calls.start.length, 1)
  const spec = subagents.calls.start[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.label, 'slave1')
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.signal, controller.signal)
  assert.deepEqual(Object.keys(spec.request).sort(), ['agentOptions', 'agentPreset', 'maxDepth', 'parent', 'prompt'])
  assert.deepEqual(spec.request, {
    parent,
    prompt: [{ type: 'text', text: 'update the changelog' }],
    agentPreset: 'standard',
    maxDepth: 2,
    agentOptions: { provider: 'local-delegate', model: 'gemma4:e2b' },
  })
})

check('startSlaveActivation omits agentOptions for an inherited child and defaults the rest', async () => {
  const subagents = mockSubagents()
  const parent = { id: 'master-agent' }
  const result = await startSlaveActivation({
    ctx: mockHost({ subagents }),
    parent,
    task: 'do the work',
    node: null,
    signal: new AbortController().signal,
  })
  assert.equal(result.fallback, 'none')
  assert.equal(result.node, null)
  const spec = subagents.calls.start[0]
  assert.equal('agentOptions' in spec.request, false)
  assert.equal(spec.request.agentPreset, 'standard')
  assert.equal(spec.request.maxDepth, 1)
  assert.equal(spec.provider, 'spawn')
  assert.ok(spec.signal instanceof AbortSignal)
})

check('startSlaveActivation forwards optional cwd and keeps it on inherit retry', async () => {
  const subagents = mockSubagents({
    behavior: (_spec, index) => (index === 1 ? { error: new Error('route exploded') } : {}),
  })
  const result = await startSlaveActivation({
    ctx: mockHost({ subagents }),
    parent: { id: 'master-agent' },
    task: 'work in a subdirectory',
    node: { name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' },
    cwd: 'packages/app',
    fallback: 'inherit',
    signal: new AbortController().signal,
  })
  assert.equal(result.fallback, 'inherit')
  assert.equal(subagents.calls.start[0].request.cwd, 'packages/app')
  assert.equal('agentOptions' in subagents.calls.start[1].request, false)
  assert.equal(subagents.calls.start[1].request.cwd, 'packages/app')
})

check('startSlaveActivation falls back to inherit without agentOptions', async () => {
  const subagents = mockSubagents({
    behavior: (_spec, index) => (index === 1 ? { error: new Error('route exploded') } : {}),
  })
  const result = await startSlaveActivation({
    ctx: mockHost({ subagents }),
    parent: { id: 'master-agent' },
    task: 'work',
    label: 'slave1',
    node: { name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' },
    preset: 'standard',
    maxDepth: 1,
    provider: 'spawn',
    fallback: 'inherit',
    signal: new AbortController().signal,
  })
  assert.equal(result.fallback, 'inherit')
  assert.equal(subagents.calls.start.length, 2)
  assert.equal('agentOptions' in subagents.calls.start[0].request, true)
  assert.equal('agentOptions' in subagents.calls.start[1].request, false)
})

check('startSlaveActivation reports both failures when inherit also fails', async () => {
  const subagents = mockSubagents({
    behavior: (_spec, index) =>
      index === 1 ? { error: new Error('routed boom') } : { error: new Error('inherited boom') },
  })
  await assert.rejects(
    startSlaveActivation({
      ctx: mockHost({ subagents }),
      parent: { id: 'master-agent' },
      task: 'work',
      node: { name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' },
      fallback: 'inherit',
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.equal(error.code, 'SLAVE_START_FAILED')
      assert.match(error.message, /routed boom/)
      assert.match(error.message, /fallback to the parent model also failed/)
      assert.match(error.message, /inherited boom/)
      return true
    },
  )
})

check('startSlaveActivation does not retry when fallback is fail', async () => {
  const subagents = mockSubagents({ behavior: () => ({ error: new Error('routed boom') }) })
  await assert.rejects(
    startSlaveActivation({
      ctx: mockHost({ subagents }),
      parent: { id: 'master-agent' },
      task: 'work',
      node: { name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' },
      fallback: 'fail',
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.equal(error.code, 'SLAVE_START_FAILED')
      assert.match(error.message, /slave node "local"/)
      return true
    },
  )
  assert.equal(subagents.calls.start.length, 1)
})

check('startSlaveActivation rejects unsupported agentOptions without calling startActivation', async () => {
  const subagents = mockSubagents({ capabilities: { agentOptions: false, agentPreset: false } })
  await assert.rejects(
    startSlaveActivation({
      ctx: mockHost({ subagents }),
      parent: { id: 'master-agent' },
      task: 'work',
      node: { name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' },
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED_CAPABILITY')
      assert.match(error.message, /agentOptions/)
      assert.match(error.message, /spawn/)
      return true
    },
  )
  assert.equal(subagents.calls.start.length, 0)
})

check('startSlaveActivation maps ACTIVATION_LIMIT_REACHED to an actionable error without retry', async () => {
  const subagents = mockSubagents({
    behavior: () => ({ error: codedError('ACTIVATION_LIMIT_REACHED', 'subagent limit reached') }),
  })
  await assert.rejects(
    startSlaveActivation({
      ctx: mockHost({ subagents }),
      parent: { id: 'master-agent' },
      task: 'work',
      node: { name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' },
      fallback: 'inherit',
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.equal(error.code, 'ACTIVATION_LIMIT_REACHED')
      assert.match(error.message, /maxActiveSubagents/)
      assert.match(error.message, /Wait for a running child/)
      return true
    },
  )
  assert.equal(subagents.calls.start.length, 1)
})

// ---------------------------------------------------------------------------
// Service install gating
// ---------------------------------------------------------------------------

check('installFor is gated on the switch, root role, and a non-empty node pool', () => {
  const disabledConfig = baseConfig({ slaveTeamsEnabled: false })
  const disabled = setupServiceOnly(disabledConfig)
  assert.equal(disabled.service.installFor(disabled.mocked.agent, 'default'), null)
  assert.equal(disabled.mocked.registered.length, 0)

  const enabledConfig = baseConfig({
    slaveNodes: [{ name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' }],
  })
  const childMocked = mockAgent({ parentSession: 'parent-session' })
  const childService = createSlaveTeamsService({
    ctx: mockHost({ subagents: mockSubagents(), llm: mockLlm() }),
    getConfig: () => enabledConfig,
    log: () => {},
    stats: createStats(),
  })
  assert.equal(childService.installFor(childMocked.agent, 'max'), null)
  assert.equal(childMocked.registered.length, 0)

  // Level none filters the only (local) node => no tools.
  const localOnly = baseConfig({
    slaveNodes: [{ name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' }],
  })
  const noneService = createSlaveTeamsService({
    ctx: mockHost({ subagents: mockSubagents(), llm: mockLlm() }),
    getConfig: () => localOnly,
    log: () => {},
    stats: createStats(),
  })
  assert.equal(noneService.installFor(mockAgent().agent, 'none'), null)
})

check('installFor registers exactly the five slave tools, prompt section, and context', () => {
  const config = baseConfig({
    slaveNodes: [
      { name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' },
      { name: 'cloud', kind: 'cloud', provider: 'deepseek-account', model: 'deepseek-flash' },
    ],
  })
  const setup = setupSlaveAgent({ config })
  assert.deepEqual(setup.registered.map((definition) => definition.name).sort(), [...SLAVE_TOOL_NAMES].sort())
  assert.equal(setup.sections.length, 1)
  const section = setup.sections[0]
  assert.equal(section.name, 'tool:local-delegate:slave-teams')
  assert.equal(section.order, 10053)
  assert.equal(section.interpolate, false)
  assert.match(section.text, /SlaveAgentTeams/)
  assert.match(section.text, /local \(local\) local-delegate\/gemma4:e2b/)
  assert.match(section.text, /cloud \(cloud\) deepseek-account\/deepseek-flash/)
  assert.match(section.text, /not a Team teammate/i)
  assert.equal(setup.contexts.length, 1)
  const context = setup.contexts[0]
  assert.equal(context.name, 'local-delegate:slave-status')
  assert.equal(context.order, 10053)
  assert.equal(context.interpolate, false)
  assert.equal(context.required, false)
  assert.equal(context.text(), '')
  // Tool timeout/isConcurrencySafe contract.
  assert.equal(setup.spawn.timeoutMs, 120000)
  assert.equal(setup.status.timeoutMs, 30000)
  assert.equal(setup.wait.timeoutMs, 1800000)
  assert.equal(setup.send.timeoutMs, 60000)
  assert.equal(setup.interrupt.timeoutMs, 30000)
  assert.equal(setup.status.isConcurrencySafe(), true)
  assert.equal(setup.send.isConcurrencySafe(), true)
  assert.equal(setup.spawn.isConcurrencySafe(), false)
  assert.equal(setup.wait.isConcurrencySafe(), false)
  assert.equal(setup.interrupt.isConcurrencySafe(), false)
  assert.equal(setup.service.statusFor(setup.agent).installed, true)
})

check('installFor honours slaveTeamPromptHelp=false and is idempotent', () => {
  const config = baseConfig({
    slaveTeamPromptHelp: false,
    slaveNodes: [{ name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' }],
  })
  const host = mockHost({ subagents: mockSubagents(), llm: mockLlm() })
  const service = createSlaveTeamsService({ ctx: host, getConfig: () => config, log: () => {}, stats: createStats() })
  const mocked = mockAgent()
  const first = service.installFor(mocked.agent, 'default')
  assert.equal(typeof first, 'function')
  assert.equal(mocked.sections.length, 0)
  assert.equal(mocked.contexts.length, 1)
  assert.equal(mocked.registered.length, 5)

  const second = service.installFor(mocked.agent, 'default')
  assert.equal(typeof second, 'function')
  assert.equal(mocked.registered.length, 5, 'reinstall must not stack tool registrations')
  assert.equal(mocked.sections.length, 0)
  assert.equal(mocked.contexts.length, 1)
  first()
  assert.equal(mocked.registered.length, 5, 'stale disposer must not remove the reinstall')
  second()
  assert.equal(mocked.registered.length, 0)
  assert.equal(mocked.contexts.length, 0)
  assert.equal(service.statusFor(mocked.agent).installed, false)
})

function setupServiceOnly(config) {
  const host = mockHost({ subagents: mockSubagents(), llm: mockLlm() })
  const stats = createStats()
  const service = createSlaveTeamsService({ ctx: host, getConfig: () => config, log: () => {}, stats })
  const mocked = mockAgent()
  return { host, stats, service, mocked }
}

// ---------------------------------------------------------------------------
// slave_team_spawn
// ---------------------------------------------------------------------------

check('slave_team_spawn validates task count and default node', async () => {
  const setup = setupSlaveAgent({ config: baseConfig({
    slaveNodes: [
      { name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' },
      { name: 'cloud', kind: 'cloud', provider: 'deepseek-account', model: 'deepseek-flash' },
    ],
  }) })
  await assert.rejects(setup.spawn.execute({ tasks: [] }, setup.exec()), /SLAVE_TASKS_REQUIRED/)
  await assert.rejects(
    setup.spawn.execute({ tasks: Array.from({ length: 5 }, (_, index) => ({ task: `t${index}` })) }, setup.exec()),
    /SLAVE_TOO_MANY_TASKS/,
  )
  await assert.rejects(
    setup.spawn.execute({ tasks: [{ task: 'x' }], default_node: 'nope' }, setup.exec()),
    /SLAVE_NODE_UNKNOWN/,
  )
  assert.equal(setup.subagents.calls.start.length, 0)
})

check('slave_team_spawn starts tasks sequentially with round-robin nodes', async () => {
  const setup = setupSlaveAgent({ config: baseConfig({
    slaveNodes: [
      { name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' },
      { name: 'cloud', kind: 'cloud', provider: 'deepseek-account', model: 'deepseek-flash' },
    ],
  }) })
  const result = await setup.spawn.execute(
    { tasks: [{ task: 'one' }, { name: 'custom', task: 'two' }] },
    setup.exec(),
  )
  assert.equal(result.started.length, 2)
  assert.deepEqual(result.started.map((item) => item.name), ['slave1', 'custom'])
  assert.deepEqual(result.started.map((item) => item.node), ['local', 'cloud'])
  assert.deepEqual(result.started.map((item) => item.child_id), ['child-1', 'child-2'])
  assert.deepEqual(result.nodes, ['local', 'cloud'])
  assert.equal(result.failed.length, 0)
  assert.match(result.note, /2 of 2 slave\(s\) started/)
  assert.equal(setup.subagents.calls.start.length, 2)
  assert.deepEqual(setup.subagents.calls.start[0].request.agentOptions, {
    provider: 'local-delegate',
    model: 'gemma4:e2b',
  })
  assert.deepEqual(setup.subagents.calls.start[1].request.agentOptions, {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
  })
  assert.equal(setup.subagents.calls.start[0].label, 'slave1')
  assert.equal(setup.subagents.calls.start[1].label, 'custom')
  assert.equal(setup.llm.calls.length, 2, 'route preflight runs once per distinct route')
  assert.equal(setup.stats.slavesStarted, 2)
  assert.equal(setup.stats.byNode.local.started, 1)
  assert.equal(setup.stats.byNode.cloud.started, 1)
})

check('slave_team_spawn captures per-task failures and keeps starting the rest', async () => {
  const setup = setupSlaveAgent({
    config: baseConfig({
      slaveNodes: [
        { name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' },
        { name: 'bad', kind: 'cloud', provider: 'bad-provider', model: 'x' },
      ],
    }),
    llm: mockLlm({ rejectProvider: 'bad-provider' }),
  })
  const result = await setup.spawn.execute(
    {
      tasks: [
        { name: 'broken', task: 'a', node: 'bad' },
        { name: 'missing', task: 'b', node: 'not-configured' },
        { name: 'empty', task: '   ' },
        { name: 'good', task: 'c', node: 'local' },
      ],
    },
    setup.exec(),
  )
  assert.equal(result.started.length, 1)
  assert.equal(result.started[0].name, 'good')
  assert.equal(result.failed.length, 3)
  const byName = new Map(result.failed.map((item) => [item.name, item]))
  assert.match(byName.get('broken').error, /SLAVE_ROUTE_UNAVAILABLE/)
  assert.match(byName.get('missing').error, /SLAVE_NODE_UNKNOWN/)
  assert.match(byName.get('empty').error, /SLAVE_TASK_EMPTY/)
  assert.equal(setup.subagents.calls.start.length, 1, 'only the good task reaches startActivation')
  assert.equal(setup.stats.slavesStarted, 1)
  assert.equal(setup.stats.slavesFailed, 3)
})

check('slave_team_spawn uniquifies duplicate task names and honours maxSlaves', async () => {
  const setup = setupSlaveAgent({ config: baseConfig({
    slaveTeamMaxSlaves: 2,
    slaveNodes: [{ name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' }],
  }) })
  const result = await setup.spawn.execute(
    { tasks: [{ name: 'x', task: 'a' }, { name: 'x', task: 'b' }] },
    setup.exec(),
  )
  assert.deepEqual(result.started.map((item) => item.name), ['x', 'x-2'])
  assert.equal(result.started[0].node, 'local')
  assert.equal(result.started[1].node, 'local')
})

check('slave_team_spawn at level none uses only cloud nodes', async () => {
  const config = baseConfig({
    slaveNodes: [
      { name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' },
      { name: 'cloud', kind: 'cloud', provider: 'deepseek-account', model: 'deepseek-flash' },
    ],
  })
  const setup = setupSlaveAgent({ config, level: 'none' })
  assert.deepEqual(setup.service.statusFor(setup.agent).nodes.map((node) => node.name), ['cloud'])
  const result = await setup.spawn.execute({ tasks: [{ task: 'cloud only' }] }, setup.exec())
  assert.equal(result.started.length, 1)
  assert.equal(result.started[0].node, 'cloud')
  assert.equal(setup.subagents.calls.start.length, 1)
})

// ---------------------------------------------------------------------------
// status / wait
// ---------------------------------------------------------------------------

check('slave_team_status reports running then settled runs with bounded preview', async () => {
  const setup = setupSlaveAgent({ config: baseConfig({
    slaveNodes: [{ name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' }],
  }) })
  await setup.spawn.execute({ tasks: [{ name: 'one', task: 'a' }] }, setup.exec())
  const running = await setup.status.execute({}, setup.exec())
  assert.equal(running.slaves.length, 1)
  assert.equal(running.slaves[0].status, 'running')
  assert.equal(running.slaves[0].node, 'local')
  assert.equal(running.running, 1)
  assert.equal(running.settled, 0)
  assert.deepEqual(running.nodes, ['local'])

  setup.subagents.pending[0].resolve({
    output: [{ type: 'text', text: 'x'.repeat(2000) }],
    stopReason: 'completed',
  })
  await tick()
  const settled = await setup.status.execute({ name: 'one' }, setup.exec())
  assert.equal(settled.slaves[0].status, 'settled')
  assert.equal(settled.slaves[0].stop_reason, 'completed')
  assert.equal(typeof settled.slaves[0].duration_ms, 'number')
  assert.ok(settled.slaves[0].output_preview.length <= 800)
  assert.equal(settled.running, 0)
  assert.equal(settled.settled, 1)
  assert.equal(setup.stats.slavesSettled, 1)

  await assert.rejects(setup.status.execute({ name: 'nope' }, setup.exec()), /SLAVE_UNKNOWN_NAME/)
  const empty = setupSlaveAgent({ config: baseConfig({
    slaveNodes: [{ name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' }],
  }) })
  const emptyStatus = await empty.status.execute({}, empty.exec())
  assert.equal(emptyStatus.slaves.length, 0)
  assert.match(emptyStatus.note, /call slave_team_spawn first/)
})

check('slave_team_wait waits for all, respects any mode, timeouts, and aborts', async () => {
  const setup = setupSlaveAgent({ config: baseConfig({
    slaveTeamMaxSlaves: 8,
    slaveNodes: [{ name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' }],
  }) })
  await setup.spawn.execute({ tasks: [{ name: 'a', task: 'a' }, { name: 'b', task: 'b' }] }, setup.exec())
  setup.subagents.pending[0].resolve({ output: [{ type: 'text', text: 'done a' }], stopReason: 'completed' })
  setup.subagents.pending[1].resolve({ output: [{ type: 'text', text: 'done b' }], stopReason: 'completed' })
  await tick()
  const all = await setup.wait.execute({ timeout_ms: 5000 }, setup.exec())
  assert.equal(all.timed_out, false)
  assert.equal(all.settled.length, 2)
  assert.equal(all.pending.length, 0)
  assert.deepEqual(all.settled.map((item) => item.name).sort(), ['a', 'b'])
  assert.ok(all.settled.every((item) => item.status === 'settled'))
  assert.match(all.note, /All 2 target slave\(s\) settled/)

  // any mode returns immediately when one run is already settled.
  const anySetup = setupSlaveAgent({ config: baseConfig({
    slaveNodes: [{ name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' }],
  }) })
  await anySetup.spawn.execute({ tasks: [{ name: 'a', task: 'a' }, { name: 'b', task: 'b' }] }, anySetup.exec())
  anySetup.subagents.pending[0].resolve({ output: [{ type: 'text', text: 'done a' }], stopReason: 'completed' })
  await tick()
  const any = await anySetup.wait.execute({ mode: 'any', timeout_ms: 5000 }, anySetup.exec())
  assert.equal(any.timed_out, false)
  assert.equal(any.settled.length, 1)
  assert.equal(any.pending.length, 1)

  // Timeout is not an error; the run stays pending.
  const timeoutSetup = setupSlaveAgent({ config: baseConfig({
    slaveNodes: [{ name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' }],
  }) })
  await timeoutSetup.spawn.execute({ tasks: [{ name: 'slow', task: 'a' }] }, timeoutSetup.exec())
  const started = Date.now()
  const timedOut = await timeoutSetup.wait.execute({ timeout_ms: 50 }, timeoutSetup.exec())
  assert.equal(timedOut.timed_out, true)
  assert.equal(timedOut.settled.length, 0)
  assert.equal(timedOut.pending.length, 1)
  assert.match(timedOut.note, /Timed out after 1000ms/)
  assert.ok(Date.now() - started >= 900, 'timeout is clamped to at least 1000ms')

  // Abort resolves the wait with a pending remainder.
  const abortSetup = setupSlaveAgent({ config: baseConfig({
    slaveNodes: [{ name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' }],
  }) })
  await abortSetup.spawn.execute({ tasks: [{ name: 'slow', task: 'a' }] }, abortSetup.exec())
  const controller = new AbortController()
  const pendingWait = abortSetup.wait.execute({ timeout_ms: 30000 }, abortSetup.exec(controller.signal))
  setTimeout(() => controller.abort(), 10)
  const aborted = await pendingWait
  assert.equal(aborted.timed_out, false)
  assert.equal(aborted.pending.length, 1)
  assert.match(aborted.note, /aborted/)

  const emptyWaitSetup = setupSlaveAgent({ config: baseConfig({
    slaveNodes: [{ name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' }],
  }) })
  const emptyWait = await emptyWaitSetup.wait.execute({}, emptyWaitSetup.exec())
  assert.equal(emptyWait.settled.length, 0)
  assert.equal(emptyWait.pending.length, 0)
  assert.equal(emptyWait.timed_out, false)
  assert.match(emptyWait.note, /call slave_team_spawn first/)
  await assert.rejects(
    emptyWaitSetup.wait.execute({ names: ['ghost'] }, emptyWaitSetup.exec()),
    /SLAVE_UNKNOWN_NAME/,
  )
})

check('slave_team_wait bounds the total output preview size', async () => {
  const setup = setupSlaveAgent({ config: baseConfig({
    slaveTeamMaxSlaves: 8,
    slaveNodes: [{ name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' }],
  }) })
  const tasks = Array.from({ length: 8 }, (_, index) => ({ name: `s${index}`, task: 'x' }))
  await setup.spawn.execute({ tasks }, setup.exec())
  for (const pending of setup.subagents.pending) {
    pending.resolve({ output: [{ type: 'text', text: 'y'.repeat(3000) }], stopReason: 'completed' })
  }
  await tick()
  const result = await setup.wait.execute({ timeout_ms: 5000 }, setup.exec())
  assert.equal(result.settled.length, 8)
  const total = result.settled.reduce((sum, item) => sum + (item.output_preview?.length ?? 0), 0)
  assert.ok(total <= 6000, `total preview ${total} must stay within 6000 chars`)
  assert.ok(result.settled.every((item) => (item.output_preview?.length ?? 0) <= 800))
})

// ---------------------------------------------------------------------------
// send / interrupt / service lifecycle
// ---------------------------------------------------------------------------

check('slave_team_send forwards to subagents.sendMessage', async () => {
  const setup = setupSlaveAgent({ config: baseConfig({
    slaveNodes: [{ name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' }],
  }) })
  await setup.spawn.execute({ tasks: [{ name: 'one', task: 'a' }] }, setup.exec())
  const controller = new AbortController()
  const result = await setup.send.execute({ name: 'one', message: 'please hurry' }, setup.exec(controller.signal))
  assert.deepEqual(result, { sent: true, name: 'one', message_id: 'msg-1' })
  assert.equal(setup.subagents.calls.send.length, 1)
  const call = setup.subagents.calls.send[0]
  assert.equal(call.sender, setup.agent)
  assert.equal(call.targetId, 'child-1')
  assert.deepEqual(call.content, [{ type: 'text', text: 'please hurry' }])
  assert.equal(call.options.signal, controller.signal)
  await assert.rejects(setup.send.execute({ name: 'nope', message: 'x' }, setup.exec()), /SLAVE_UNKNOWN_NAME/)
})

check('slave_team_interrupt forwards to subagents.interrupt with ancestor authority', async () => {
  const setup = setupSlaveAgent({ config: baseConfig({
    slaveNodes: [{ name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' }],
  }) })
  await setup.spawn.execute({ tasks: [{ name: 'one', task: 'a' }] }, setup.exec())
  const result = await setup.interrupt.execute({ name: 'one' }, setup.exec())
  assert.deepEqual(result, { accepted: true, name: 'one' })
  assert.equal(setup.subagents.calls.interrupt.length, 1)
  assert.deepEqual(setup.subagents.calls.interrupt[0], {
    targetId: 'child-1',
    authority: { kind: 'ancestor', agent: setup.agent },
  })
})

check('service lifecycle: statusFor/listRuns/summarize/disposeFor/disposeAll', async () => {
  const config = baseConfig({
    slaveNodes: [
      { name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' },
      { name: 'cloud', kind: 'cloud', provider: 'deepseek-account', model: 'deepseek-flash' },
    ],
  })
  const setup = setupSlaveAgent({ config })
  await setup.spawn.execute({ tasks: [{ name: 'one', task: 'a' }] }, setup.exec())
  assert.equal(setup.service.listRuns(setup.agent).length, 1)
  const status = setup.service.statusFor(setup.agent)
  assert.equal(status.installed, true)
  assert.equal(status.enabled, true)
  assert.deepEqual(status.nodes.map((node) => node.name), ['local', 'cloud'])
  assert.equal(status.running, 1)
  const summary = setup.service.summarize()
  assert.equal(summary.enabledAgents, 1)
  assert.equal(summary.runningSlaves, 1)
  assert.deepEqual(summary.nodes.map((node) => node.name), ['local', 'cloud'])

  setup.service.disposeFor(setup.agent)
  assert.equal(setup.registered.length, 0)
  assert.equal(setup.sections.length, 0)
  assert.equal(setup.contexts.length, 0)
  assert.equal(setup.service.statusFor(setup.agent).installed, false)
  assert.deepEqual(setup.service.listRuns(setup.agent), [])
  assert.equal(setup.service.summarize().enabledAgents, 0)

  // Reinstall then disposeAll.
  setup.service.installFor(setup.agent, 'default')
  assert.equal(setup.registered.length, 5)
  setup.service.disposeAll()
  assert.equal(setup.registered.length, 0)
  assert.equal(setup.service.summarize().enabledAgents, 0)
})

check('disabled at runtime disposes an existing installation on reinstall', () => {
  const config = baseConfig({
    slaveNodes: [{ name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' }],
  })
  const host = mockHost({ subagents: mockSubagents(), llm: mockLlm() })
  const service = createSlaveTeamsService({ ctx: host, getConfig: () => config, log: () => {}, stats: createStats() })
  const mocked = mockAgent()
  assert.equal(typeof service.installFor(mocked.agent, 'default'), 'function')
  assert.equal(mocked.registered.length, 5)
  config.slaveTeamsEnabled = false
  assert.equal(service.installFor(mocked.agent, 'default'), null)
  assert.equal(mocked.registered.length, 0)
  assert.equal(mocked.contexts.length, 0)
  assert.equal(service.statusFor(mocked.agent).installed, false)
})

// ---------------------------------------------------------------------------
// stats additions
// ---------------------------------------------------------------------------

check('stats record worker/slave counters and stay backward compatible', () => {
  const stats = createStats()
  recordWorkerStart(stats, { name: 'local-worker' })
  recordWorkerFailure(stats, 'worker exploded')
  recordSlaveStart(stats, { name: 'local' })
  recordSlaveStart(stats, { name: 'cloud' })
  recordSlaveSettled(stats, { node: { name: 'local' }, ok: true })
  recordSlaveSettled(stats, { node: { name: 'cloud' }, ok: false })
  recordSlaveFailure(stats, { node: { name: 'bad-node' }, message: 'route failed' })
  assert.equal(stats.workersStarted, 1)
  assert.equal(stats.workersFailed, 1)
  assert.equal(stats.slavesStarted, 2)
  assert.equal(stats.slavesSettled, 2)
  assert.equal(stats.slavesFailed, 2)
  assert.deepEqual(stats.byNode.local, { started: 1, settled: 1, failed: 0 })
  assert.deepEqual(stats.byNode.cloud, { started: 1, settled: 1, failed: 1 })
  assert.deepEqual(stats.byNode['bad-node'], { started: 0, settled: 0, failed: 1 })
  assert.match(stats.lastError, /slave: route failed/)

  const snapshot = statsSnapshot(stats)
  assert.equal(snapshot.slavesStarted, 2)
  assert.equal(snapshot.slavesSettled, 2)
  assert.equal(snapshot.byNode.local.started, 1)

  const text = renderStats(stats, { kind: 'ollama-native', baseURL: 'http://x', model: 'm' }, null)
  assert.match(text, /^Local delegate: ollama-native http:\/\/x model=m/)
  assert.match(text, /Calls: 0 ok, 0 failed/)
  assert.match(text, /Workers: 1 started, 1 failed/)
  assert.match(text, /Slaves: 2 started, 2 settled, 2 failed/)
  assert.match(text, /Delegation by node:/)
  assert.match(text, /Since: /)
})

check('recorders tolerate a pre-v0.4 stats object', () => {
  const legacy = { startedAt: Date.now(), calls: 0, failed: 0, byTask: {}, byEndpoint: {}, lastError: null }
  recordSlaveStart(legacy, { name: 'local' })
  recordSlaveSettled(legacy, { node: 'local', ok: true })
  recordWorkerStart(legacy, 'local-worker')
  recordWorkerFailure(legacy, 'nope')
  assert.equal(legacy.slavesStarted, 1)
  assert.equal(legacy.slavesSettled, 1)
  assert.equal(legacy.workersStarted, 1)
  assert.equal(legacy.workersFailed, 1)
  assert.equal(legacy.byNode.local.started, 1)
})

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

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
