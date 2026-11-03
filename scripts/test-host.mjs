/**
 * Headless checks for the Host half: schema/volatile shape, apply() wiring,
 * status API, and the probe SSRF guard. Run with `node scripts/test-host.mjs`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Config, readConfig, normalizeConfig, configWarnings, publicConfig } from '../lib/config.js'
import { requestRejection } from '../lib/trust.js'
import { createApiHandler } from '../lib/api.js'
import { apply } from '../index.js'

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

function mockContext({ connection } = {}) {
  const tools = []
  const commands = []
  const routes = []
  const handlers = new Map()
  const systemPrompt = { sections: [], contexts: [], section(value) { this.sections.push(value) }, context(value) { this.contexts.push(value) } }
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    // The levels policy (owned by the policy worker) enumerates live agents at
    // start; keep an empty registry so this host mock also serves v0.4 wiring.
    agents: { list: () => [] },
    on(name, handler) {
      handlers.set(name, handler)
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (name === 'systemPrompt') return systemPrompt
      if (name === 'commands') return { register: value => commands.push(value) }
      if (name === 'connection') return connection
      return undefined
    },
    tools: { register: value => tools.push(value) },
    inject(_deps, callback) {
      callback({
        webServer: { register: route => { routes.push(route); return () => {} } },
        effect: fn => {
          const dispose = fn()
          return typeof dispose === 'function' ? dispose : () => {}
        },
        get: name => (name === 'connection' ? connection : undefined),
        logger: ctx.logger,
      })
    },
  }
  return { ctx, tools, commands, routes, handlers, systemPrompt }
}

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers || {}
    },
    end(body) {
      this.body = String(body ?? '')
    },
  }
}

check('volatile config parses to refs and readConfig unwraps', () => {
  const raw = Config({
    endpoint: { baseURL: 'http://10.0.101.11:11434', model: 'gemma4:e2b' },
    retries: 2,
  })
  const isRef = value => value && typeof value === 'object' && typeof value.get === 'function' && Symbol.for('cosmokit.volatile.write') in value
  assert.ok(isRef(raw.endpoint))
  assert.ok(isRef(raw.fallbackEndpoints))
  const config = readConfig(raw)
  assert.equal(config.endpoint.baseURL, 'http://10.0.101.11:11434')
  assert.equal(config.endpoint.model, 'gemma4:e2b')
  assert.equal(config.retries, 2)
  assert.deepEqual(config.fallbackEndpoints, [])
  assert.equal(config.composerLevelPicker, true, 'composer level picker defaults on')
  const offConfig = readConfig(Config({ endpoint: { baseURL: 'http://127.0.0.1:11434' }, composerLevelPicker: false }))
  assert.equal(offConfig.composerLevelPicker, false, 'composer level picker toggle normalizes off')
  assert.equal(configWarnings(config).length, 0)
})

check('normalizeConfig rejects invalid kind', () => {
  assert.throws(() => normalizeConfig({ endpoint: { kind: 'bogus', baseURL: 'http://x' } }), /endpoint\.kind/)
})

check('trust fence rejects a non-loopback Host without connection', () => {
  const req = { headers: { host: '192.168.1.5:8896' } }
  assert.equal(requestRejection(req, undefined), 403)
  assert.equal(requestRejection({ headers: { host: '127.0.0.1:8896', origin: 'https://evil.example' } }, undefined), 403)
  assert.equal(requestRejection({ headers: { host: '127.0.0.1:8896', origin: 'http://127.0.0.1:8896' } }, undefined), undefined)
})

check('trust fence prefers connection.admit', () => {
  const deny = { admit: () => ({ rejection: 401 }) }
  assert.equal(requestRejection({ headers: {} }, deny), 401)
  const allow = { admit: () => ({ peer: {} }) }
  assert.equal(requestRejection({ headers: { host: '192.168.1.5:8896' } }, allow), undefined)
})

check('apply registers tools, prompt, routes, commands', async () => {
  const raw = Config({
    endpoint: { baseURL: 'http://10.0.101.11:11434', model: 'gemma4:e2b' },
    warmupOnStart: false,
  })
  const { ctx, tools, commands, routes, handlers, systemPrompt } = mockContext({
    connection: { admit: () => ({ peer: {} }) },
  })
  apply(ctx, raw)
  assert.equal(tools.length, 3)
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['local_batch', 'local_health', 'local_transform'])
  const commandNames = commands.map(command => command.name)
  assert.ok(commandNames.includes('localstats'))
  assert.ok(commandNames.includes('localdoctor'))
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/api/local-delegate')
  assert.ok(systemPrompt.sections.length >= 1)
  assert.ok(systemPrompt.contexts.length >= 1)
  assert.equal(typeof handlers.get('loader/volatile-update'), 'function')
})

check('status API returns version/config/stats and blocks public probe', async () => {
  const raw = Config({
    endpoint: { baseURL: 'http://10.0.101.11:11434', model: 'gemma4:e2b' },
    warmupOnStart: false,
  })
  const { ctx, routes } = mockContext({ connection: { admit: () => ({ peer: {} }) } })
  apply(ctx, raw)
  const handler = routes[0].handler

  const statusRes = fakeResponse()
  await handler({ method: 'GET', url: '/api/local-delegate/status', headers: {} }, statusRes)
  assert.equal(statusRes.status, 200)
  const status = JSON.parse(statusRes.body)
  assert.equal(status.version, pkg.version)
  assert.equal(status.config.endpoint.baseURL, 'http://10.0.101.11:11434')
  assert.equal(status.config.levelsEnabled, true)
  assert.equal(status.config.defaultLevel, 'default')
  assert.deepEqual(status.config.workspaceLevels, {})
  assert.equal(status.config.composerLevelPicker, true)
  assert.equal(status.config.slaveTeamsEnabled, false)
  assert.deepEqual(status.config.slaveNodes, [])
  assert.equal(typeof status.stats.calls, 'number')

  const blockedRes = fakeResponse()
  await handler(
    {
      method: 'POST',
      url: '/api/local-delegate/probe',
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ endpoint: { baseURL: 'https://example.com', model: 'x' } }))
      },
    },
    blockedRes,
  )
  assert.equal(blockedRes.status, 400)
  const blocked = JSON.parse(blockedRes.body)
  assert.equal(blocked.ok, false)
  assert.match(String(blocked.error), /LOCAL_PROBE_BLOCKED/)
})

function levelsHandler({ config, registry, registryThrows = false } = {}) {
  return createApiHandler({
    getRuntime: () => ({ health: null, stats: { calls: 0 } }),
    getConnection: () => ({ admit: () => ({ peer: {} }) }),
    getWorkspaceRegistry: registryThrows
      ? () => {
          throw new Error('registry unavailable')
        }
      : () => registry,
    refresh: () => config,
    version: pkg.version,
    log: () => {},
  })
}

async function requestLevels(handler, method = 'GET') {
  const res = fakeResponse()
  await handler({ method, url: '/api/local-delegate/levels', headers: {} }, res)
  return { res, body: res.body ? JSON.parse(res.body) : null }
}

function baseConfig(extra = {}) {
  return normalizeConfig({
    endpoint: { baseURL: 'http://10.0.101.11:11434', model: 'gemma4:e2b' },
    ...extra,
  })
}

check('new levels/slave-team config fields parse, normalize, and appear in publicConfig', () => {
  const raw = Config({
    endpoint: { baseURL: 'http://10.0.101.11:11434', model: 'gemma4:e2b' },
    levelsEnabled: true,
    defaultLevel: 'high',
    workspaceLevels: { 'C:\\Work\\Alpha': 'max' },
    workerPreset: 'standard',
    workerRouteProvider: 'local-delegate',
    workerRouteModel: ' gemma4:e2b ',
    workerMaxDepth: 9,
    lightMinChars: 0,
    lightMinFiles: 2,
    highMinChars: 500,
    plannerAllowRead: false,
    plannerFallback: 'fail',
    plannerDenyExtra: [' custom_exec ', ''],
    plannerAllowExtra: ['bash'],
    applyToLiveAgents: true,
    slaveTeamsEnabled: true,
    slaveNodes: [{ name: ' local ', kind: 'cloud', provider: ' intranet-gemma ', model: ' gemma4:e2b ', note: ' x ' }],
    slaveTeamDefaultNode: ' local ',
    slaveTeamProvider: 'spawn',
    slaveTeamPreset: 'standard',
    slaveTeamMaxSlaves: 99,
    slaveTeamMaxDepth: 0,
    slaveTeamFallback: 'fail',
    slaveTeamPromptHelp: false,
    composerLevelPicker: false,
  })
  assert.equal(typeof raw.defaultLevel.get, 'function', 'new fields are volatile refs')
  assert.equal(typeof raw.slaveNodes.get, 'function')
  assert.equal(typeof raw.composerLevelPicker.get, 'function')
  const config = readConfig(raw)
  assert.equal(config.levelsEnabled, true)
  assert.equal(config.defaultLevel, 'high')
  assert.deepEqual(config.workspaceLevels, { 'C:\\Work\\Alpha': 'max' })
  assert.equal(config.workerRouteModel, 'gemma4:e2b')
  assert.equal(config.workerMaxDepth, 5)
  assert.equal(config.lightMinChars, 8000, '<=0 falls back to the default')
  assert.equal(config.lightMinFiles, 2)
  assert.equal(config.highMinChars, 500)
  assert.equal(config.plannerAllowRead, false)
  assert.equal(config.plannerFallback, 'fail')
  assert.deepEqual(config.plannerDenyExtra, ['custom_exec'])
  assert.deepEqual(config.plannerAllowExtra, ['bash'])
  assert.equal(config.applyToLiveAgents, true)
  assert.equal(config.slaveTeamsEnabled, true)
  assert.deepEqual(config.slaveNodes, [{ name: 'local', kind: 'cloud', provider: 'intranet-gemma', model: 'gemma4:e2b', note: 'x' }])
  assert.equal(config.slaveTeamDefaultNode, 'local')
  assert.equal(config.slaveTeamMaxSlaves, 8, 'clamped to 1..8')
  assert.equal(config.slaveTeamMaxDepth, 1, 'clamped to 1..5')
  assert.equal(config.slaveTeamFallback, 'fail')
  assert.equal(config.slaveTeamPromptHelp, false)
  assert.equal(config.composerLevelPicker, false)

  const defaults = readConfig(Config({ endpoint: { baseURL: 'http://10.0.101.11:11434', model: 'gemma4:e2b' } }))
  assert.equal(defaults.levelsEnabled, true)
  assert.equal(defaults.defaultLevel, 'default')
  assert.deepEqual(defaults.workspaceLevels, {})
  assert.equal(defaults.workerProvider, 'spawn')
  assert.equal(defaults.workerRouteProvider, 'local-delegate')
  assert.equal(defaults.workerRouteModel, '')
  assert.equal(defaults.workerMaxDepth, 1)
  assert.equal(defaults.lightMinChars, 8000)
  assert.equal(defaults.lightMinFiles, 3)
  assert.equal(defaults.highMinChars, 2000)
  assert.equal(defaults.plannerAllowRead, true)
  assert.equal(defaults.plannerFallback, 'strong-worker')
  assert.equal(defaults.applyToLiveAgents, false)
  assert.equal(defaults.slaveTeamsEnabled, false)
  assert.deepEqual(defaults.slaveNodes, [])
  assert.equal(defaults.slaveTeamMaxSlaves, 4)
  assert.equal(defaults.slaveTeamFallback, 'inherit')
  assert.equal(defaults.slaveTeamPromptHelp, true)
  assert.equal(defaults.composerLevelPicker, true)

  const normalized = normalizeConfig({
    endpoint: { baseURL: 'http://10.0.101.11:11434', model: 'gemma4:e2b' },
    defaultLevel: 'bogus',
    workspaceLevels: { 'C:\\Work\\Alpha': 'high', 'C:\\Bad': 'bogus', '': 'max' },
    slaveNodes: ['not-an-object', { name: ' x ', kind: 'bogus', provider: '', model: '', note: null }],
    workerMaxDepth: 0,
    slaveTeamMaxSlaves: 0,
  })
  assert.equal(normalized.defaultLevel, 'default')
  assert.deepEqual(normalized.workspaceLevels, { 'C:\\Work\\Alpha': 'high' })
  assert.deepEqual(normalized.slaveNodes, [{ name: 'x', kind: 'local', provider: 'local-delegate', model: '', note: '' }])
  assert.equal(normalized.workerMaxDepth, 1)
  assert.equal(normalized.slaveTeamMaxSlaves, 1)

  const pub = publicConfig(config)
  for (const field of [
    'levelsEnabled',
    'defaultLevel',
    'workspaceLevels',
    'workerProvider',
    'workerPreset',
    'workerRouteProvider',
    'workerRouteModel',
    'workerMaxDepth',
    'lightMinChars',
    'lightMinFiles',
    'highMinChars',
    'plannerAllowRead',
    'plannerFallback',
    'plannerDenyExtra',
    'plannerAllowExtra',
    'applyToLiveAgents',
    'composerLevelPicker',
    'slaveTeamsEnabled',
    'slaveNodes',
    'slaveTeamDefaultNode',
    'slaveTeamProvider',
    'slaveTeamPreset',
    'slaveTeamMaxSlaves',
    'slaveTeamMaxDepth',
    'slaveTeamFallback',
    'slaveTeamPromptHelp',
  ]) {
    assert.ok(field in pub, `publicConfig.${field} is present`)
  }
  assert.equal(pub.defaultLevel, 'high')
  assert.deepEqual(pub.workspaceLevels, { 'C:\\Work\\Alpha': 'max' })
  assert.deepEqual(pub.slaveNodes, [{ name: 'local', kind: 'cloud', provider: 'intranet-gemma', model: 'gemma4:e2b', note: 'x' }])
  assert.equal(pub.slaveTeamMaxSlaves, 8)
})

check('configWarnings covers workspace keys, implicit nodes, default node, duplicates', () => {
  const defaultWarnings = configWarnings(baseConfig())
  assert.deepEqual(defaultWarnings, [], 'defaults stay warning-free (v0.3 behavior)')

  const workspaceWarnings = configWarnings(
    baseConfig({
      workspaceLevels: { 'relative/path': 'high', 'C:\\Work\\Dup': 'max', 'c:/work/dup': 'none' },
    }),
  )
  assert.ok(workspaceWarnings.some((warning) => /not an absolute workspace path/.test(warning)))
  assert.ok(workspaceWarnings.some((warning) => /same workspace/.test(warning)))

  const noNodeWarnings = configWarnings(
    normalizeConfig({
      endpoint: { baseURL: 'http://10.0.101.11:11434', model: '' },
      slaveTeamsEnabled: true,
    }),
  )
  assert.ok(noNodeWarnings.some((warning) => /no usable slave node/.test(warning) && /endpoint\.model/.test(warning)))

  const nodeWarnings = configWarnings(
    baseConfig({
      slaveTeamsEnabled: true,
      slaveNodes: [
        { name: 'dup', provider: 'local-delegate', model: 'a' },
        { name: 'dup', provider: 'local-delegate', model: 'b' },
      ],
      slaveTeamDefaultNode: 'missing',
    }),
  )
  assert.ok(nodeWarnings.some((warning) => /duplicate names/.test(warning)))
  assert.ok(nodeWarnings.some((warning) => /slaveTeamDefaultNode "missing" is not in the slave node pool/.test(warning)))
})

check('/levels lists workspaces with override/default and slave-team summary', async () => {
  const config = baseConfig({
    defaultLevel: 'light',
    workspaceLevels: { 'c:/work/alpha': 'high' },
    slaveTeamsEnabled: true,
    slaveNodes: [{ name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' }],
    slaveTeamDefaultNode: 'local',
  })
  const registry = {
    list: () => [
      { id: 'ws-a', title: 'Alpha', path: 'C:\\Work\\Alpha', sessionIds: ['s1'] },
      { id: 'ws-b', title: 'Beta', path: 'C:/Work/Beta', sessionIds: [] },
    ],
  }
  const { res, body } = await requestLevels(levelsHandler({ config, registry }))
  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.version, pkg.version)
  assert.deepEqual(body.levels, ['none', 'light', 'default', 'high', 'max'])
  assert.equal(body.levelsEnabled, true)
  assert.equal(body.defaultLevel, 'light')
  assert.equal(body.unavailable, undefined)
  assert.deepEqual(body.workspaces, [
    { id: 'ws-a', title: 'Alpha', path: 'C:\\Work\\Alpha', level: 'high', source: 'override' },
    { id: 'ws-b', title: 'Beta', path: 'C:/Work/Beta', level: 'light', source: 'default' },
  ])
  assert.deepEqual(body.slaveTeam, {
    enabled: true,
    defaultNode: 'local',
    maxSlaves: 4,
    nodes: [{ name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' }],
    issues: [],
  })
})

check('/levels degrades gracefully without a workspace registry', async () => {
  const config = baseConfig({ defaultLevel: 'max', slaveTeamsEnabled: true })
  const missing = await requestLevels(levelsHandler({ config, registry: undefined }))
  assert.equal(missing.res.status, 200)
  assert.equal(missing.body.ok, true)
  assert.equal(missing.body.defaultLevel, 'max')
  assert.deepEqual(missing.body.workspaces, [])
  assert.equal(typeof missing.body.unavailable, 'string')
  assert.match(missing.body.unavailable, /workspaceRegistry/)
  assert.equal(missing.body.slaveTeam.enabled, true)
  assert.deepEqual(missing.body.slaveTeam.nodes, [{ name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' }])
  assert.ok(missing.body.slaveTeam.issues.length === 0)

  const throwing = await requestLevels(levelsHandler({ config, registryThrows: true }))
  assert.equal(throwing.res.status, 200)
  assert.deepEqual(throwing.body.workspaces, [])
  assert.match(throwing.body.unavailable, /registry unavailable/)

  const notAnArray = await requestLevels(levelsHandler({ config, registry: { list: () => 'nope' } }))
  assert.equal(notAnArray.res.status, 200)
  assert.deepEqual(notAnArray.body.workspaces, [])
  assert.match(notAnArray.body.unavailable, /did not return an array/)

  const wrongMethod = await requestLevels(levelsHandler({ config, registry: { list: () => [] } }), 'POST')
  assert.equal(wrongMethod.res.status, 405)
  assert.equal(wrongMethod.body.ok, false)
})

check('unauthorized request is rejected before routing', async () => {
  const raw = Config({ endpoint: { baseURL: 'http://10.0.101.11:11434', model: 'gemma4:e2b' }, warmupOnStart: false })
  const { ctx, routes } = mockContext({ connection: { admit: () => ({ rejection: 403 }) } })
  apply(ctx, raw)
  const res = fakeResponse()
  await routes[0].handler({ method: 'GET', url: '/api/local-delegate/status', headers: {} }, res)
  assert.equal(res.status, 403)
})

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
