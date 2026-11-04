/**
 * Headless smoke test for the browser half: evaluates client.js in a Node VM
 * with a tiny fake React renderer, runs apply(), and renders the page once.
 * This catches reference errors and registration mistakes before an app restart.
 * Run with `node scripts/test-client.mjs`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')

let captured
const sandbox = {
  URL,
  JSON,
  setTimeout,
  clearTimeout,
  fetch: async () => {
    throw new Error('network disabled in test')
  },
  window: {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
  },
  document: {
    createElement: () => ({ setAttribute() {}, textContent: '', remove() {} }),
    head: { appendChild() {} },
  },
}
sandbox.globalThis = sandbox
vm.runInNewContext(source, sandbox, { filename: 'client.js' })
assert.ok(captured, 'client.js must call window.__ModuleLoader__.load')
assert.equal(captured.id, 'dsh-local-delegate')

// ── tiny fake React ────────────────────────────────────────────────────────
const draftOverride = {
  endpoint: {
    kind: 'ollama-native',
    baseURL: 'http://10.0.101.11:11434',
    path: '',
    model: 'gemma4:e2b',
    apiKey: '',
    apiKeyEnv: '',
    headers: {},
    numCtx: 32768,
    keepAlive: '30m',
    think: false,
    reasoningEffort: 'none',
    timeoutMs: 120000,
    temperature: 0,
    maxOutputTokens: 4096,
  },
  fallbackEndpoints: [],
  modelsByTask: {},
  retries: 1,
  maxInlineChars: 8000,
  chunkChars: 4000,
  maxConcurrency: 2,
  maxSourceChars: 200000,
  maxBatchFiles: 10,
  maxBatchChars: 120000,
  maxResultChars: 6000,
  maxCallsPerMinute: 40,
  promptHelp: true,
  warmupOnStart: true,
  probeAllowPublic: false,
  // ── 0.4.0 fields (contract §2) ─────────────────────────────────────────
  levelsEnabled: true,
  defaultLevel: 'default',
  workspaceLevels: {},
  workerProvider: 'spawn',
  workerPreset: 'standard',
  workerRouteProvider: 'local-delegate',
  workerRouteModel: '',
  workerMaxDepth: 1,
  lightMinChars: 8000,
  lightMinFiles: 3,
  highMinChars: 2000,
  plannerAllowRead: true,
  plannerFallback: 'strong-worker',
  plannerDenyExtra: [],
  plannerAllowExtra: [],
  applyToLiveAgents: false,
  composerLevelPicker: true,
  slaveTeamsEnabled: false,
  slaveNodes: [],
  slaveTeamDefaultNode: '',
  slaveTeamProvider: 'spawn',
  slaveTeamPreset: 'standard',
  slaveTeamMaxSlaves: 4,
  slaveTeamMaxDepth: 1,
  slaveTeamFallback: 'inherit',
  slaveTeamPromptHelp: true,
}
let hook = { state: 0, states: 0 }
const React = {
  Fragment: 'Fragment',
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children: children.length > 1 ? children : children[0] } }
  },
  useState(initial) {
    hook.state++
    const index = hook.states++
    return [index === 0 ? draftOverride : initial, () => {}]
  },
  useEffect() {
    hook.state++
  },
  useCallback(fn) {
    hook.state++
    return fn
  },
  useMemo(fn) {
    hook.state++
    return fn()
  },
  useRef() {
    hook.state++
    return { current: false }
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    hook.state++
    return getSnapshot()
  },
}

function render(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(render).join('')
  if (typeof node.type === 'function') {
    hook = { state: 0, states: 0 }
    return render(node.type(node.props))
  }
  return render(node.props && node.props.children)
}

const controller = value => ({
  getSnapshot: () => ({ status: 'ready', writable: true, revision: 1, value, base: value, user: {} }),
  subscribe: () => () => {},
  mutate: async () => true,
  dispose: async () => {},
})

const form = controller(draftOverride)
const piForm = controller({ providers: {} })
const subForm = controller({ enabled: false, allowedModels: [] })

const registrations = []
const ctx = {
  locale: {
    bind: () => key => key,
    register: () => () => {},
  },
  effect: fn => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  slots: {
    inject(_name, callback) {
      callback()
    },
    register(options, Component) {
      registrations.push({ options, Component })
      return () => {}
    },
  },
  configForms: {
    get: id => (id === 'local-delegate' ? form : id === 'llm-pi-ai' ? piForm : subForm),
  },
}

const factory = captured.factory
const moduleExports = factory(name => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
assert.ok(moduleExports.__test, 'test seams must be exported')
assert.equal(moduleExports.inject.join(','), 'slots,locale,configForms')

moduleExports.apply(ctx)
assert.equal(registrations.length, 3, 'all three surfaces must register')
const row = registrations.find(entry => entry.options.name === 'plugins.row.config')
const section = registrations.find(entry => entry.options.name === 'settings.section')
const composerEntry = registrations.find(entry => entry.options.name === 'conversation.input.left')
assert.ok(row)
assert.equal(row.options.key, 'dsh-local-delegate#local-delegate')
assert.ok(section)
assert.equal(section.options.id, 'local-delegate')
assert.ok(composerEntry, 'composer level picker must register')
assert.equal(composerEntry.options.id, 'local-delegate-level-picker')
assert.equal(composerEntry.options.order, 30)

const props = { t: key => key, form, piForm, subForm }
assert.equal(row.Component({ view: 'summary', ...props }), 'summary')
const pageTree = row.Component({ view: 'page', ...props })
const html = render(pageTree)
assert.ok(html.includes('title'), 'full page must render the title')
assert.ok(html.includes('endpointSection') && html.includes('test'), 'page must render the endpoint section and actions')
assert.ok(html.includes('levelsWorkspaces'), 'page must render the levels card')
assert.ok(html.includes('composerLevel'), 'levels card must render the composer picker toggle')
assert.ok(html.includes('slaveTeamsEnable'), 'page must render the SlaveAgentTeams card')

// Card order: Subagent → Levels → SlaveTeams → Stats.
assert.ok(
  html.indexOf('subagentHint') < html.indexOf('levelsWorkspaces'),
  'levels card must follow the Subagent card',
)
assert.ok(
  html.indexOf('levelsWorkspaces') < html.indexOf('slaveTeamsEnable'),
  'levels card must precede the SlaveAgentTeams card',
)
assert.ok(
  html.indexOf('slaveTeamsEnable') < html.indexOf('statsHint'),
  'SlaveAgentTeams card must precede the Stats card',
)
assert.ok(html.includes('statsHint'), 'stats card must still render')

const {
  buildOps,
  buildPiProvider,
  buildChainUnrouteOps,
  chainRouteIds,
  validateEndpointNumbers,
  groupChainEndpoints,
  chainRouteProviderId,
  buildChainRouteOps,
  missingChainModels,
  HealthCard,
  SubagentCard,
  LevelsCard,
  SlaveTeamsCard,
  StatsCard,
  ProbeResult,
  ComposerLevelPicker,
  composerLevelModel,
  resolveComposerWorkspace,
  withWorkspaceLevel,
  findWorkspaceLevel,
} = moduleExports.__test
assert.equal(typeof LevelsCard, 'function', '__test must export LevelsCard')
assert.equal(typeof SlaveTeamsCard, 'function', '__test must export SlaveTeamsCard')
assert.equal(typeof ComposerLevelPicker, 'function', '__test must export ComposerLevelPicker')

const ops = buildOps(draftOverride, { ...draftOverride, endpoint: { ...draftOverride.endpoint, model: 'other' } })
assert.equal(ops.map(op => op.path.join('.')).join(','), 'endpoint')
assert.equal(buildOps(draftOverride, { ...draftOverride }).length, 0, 'unchanged draft must produce no ops')

const levelOps = buildOps(draftOverride, { ...draftOverride, defaultLevel: 'high' })
assert.equal(levelOps.map(op => op.path.join('.')).join(','), 'defaultLevel', 'defaultLevel change must set the scalar')
assert.equal(levelOps[0].value, 'high')

const workspaceLevels = { 'C:/ws/a': 'max' }
const workspaceOps = buildOps(draftOverride, { ...draftOverride, workspaceLevels })
assert.equal(workspaceOps.map(op => op.path.join('.')).join(','), 'workspaceLevels', 'workspaceLevels change must be one whole-value set')
assert.equal(JSON.stringify(workspaceOps[0].value), JSON.stringify(workspaceLevels), 'workspaceLevels op must carry the whole object')
assert.equal(workspaceOps[0].op, 'set')
assert.equal(workspaceOps[0].path.join('.'), 'workspaceLevels')

const slaveNodes = [
  { name: 'local', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b', note: '' },
  { name: 'cloud', kind: 'cloud', provider: 'deepseek-account', model: 'deepseek-flash', note: 'fast' },
]
const slaveOps = buildOps(draftOverride, { ...draftOverride, slaveTeamsEnabled: true, slaveNodes })
assert.equal(slaveOps.map(op => op.path.join('.')).join(','), 'slaveTeamsEnabled,slaveNodes', 'slave fields must emit in contract order')
assert.equal(JSON.stringify(slaveOps[1].value), JSON.stringify(slaveNodes), 'slaveNodes op must carry the whole array')

const lightOps = buildOps(draftOverride, { ...draftOverride, lightMinChars: 5000 })
assert.equal(lightOps.map(op => op.path.join('.')).join(','), 'lightMinChars')

const composerToggleOps = buildOps(draftOverride, { ...draftOverride, composerLevelPicker: false })
assert.equal(composerToggleOps.map(op => op.path.join('.')).join(','), 'composerLevelPicker', 'composer toggle must set the scalar')

const combinedOps = buildOps(draftOverride, {
  ...draftOverride,
  defaultLevel: 'max',
  workspaceLevels,
  lightMinChars: 5000,
  slaveTeamsEnabled: true,
  slaveNodes,
})
assert.equal(
  combinedOps.map(op => op.path.join('.')).join(','),
  'defaultLevel,workspaceLevels,lightMinChars,slaveTeamsEnabled,slaveNodes',
  'v0.4 ops must follow the contract field order',
)

assert.equal(
  JSON.stringify(withWorkspaceLevel({ 'c:\\ws\\a': 'light' }, 'C:/ws/a', 'max')),
  JSON.stringify({ 'C:/ws/a': 'max' }),
  'workspace keys must match case/slash-insensitively',
)
assert.equal(JSON.stringify(withWorkspaceLevel({ 'C:/ws/a': 'max' }, 'C:/ws/a', '')), '{}', 'empty level clears the override')
assert.equal(findWorkspaceLevel({ 'c:\\ws\\a': 'high' }, 'C:/ws/A'), 'high')

const ollamaProvider = buildPiProvider(draftOverride.endpoint)
assert.equal(ollamaProvider.api, 'openai-completions')
assert.equal(ollamaProvider.baseURL, 'http://10.0.101.11:11434/v1')
assert.equal(ollamaProvider.models[0].id, 'gemma4:e2b')
assert.equal(ollamaProvider.headers.Authorization, 'Bearer ollama')
const keyedProvider = buildPiProvider({ ...draftOverride.endpoint, kind: 'openai-compatible', apiKey: 'sk-test' })
assert.equal(keyedProvider.headers.Authorization, 'Bearer sk-test')
const multiModelProvider = buildPiProvider(draftOverride.endpoint, ['gemma4:e2b', 'gemma4:e4b'])
assert.equal(JSON.stringify(multiModelProvider.models.map(model => model.id)), JSON.stringify(['gemma4:e2b', 'gemma4:e4b']), 'a chain group carries every model on the same host')
assert.equal(chainRouteProviderId(0), 'local-delegate')
assert.equal(chainRouteProviderId(2), 'local-delegate-fb2')
const chainGroups = groupChainEndpoints({
  endpoint: { kind: 'ollama-native', baseURL: 'http://127.0.0.1:11434/', model: 'gemma4:e4b', headers: {} },
  fallbackEndpoints: [
    { kind: 'ollama-native', baseURL: 'http://127.0.0.1:11434', model: 'gemma4:e2b', headers: {} },
    { kind: 'ollama-native', baseURL: 'http://10.0.101.11:11434', model: 'gemma4:e2b', headers: {} },
    { kind: 'ollama-native', baseURL: '', model: 'ignored', headers: {} },
  ],
})
assert.equal(chainGroups.length, 2, 'the chain is grouped by host/credentials')
assert.equal(JSON.stringify(chainGroups[0].models), JSON.stringify(['gemma4:e4b', 'gemma4:e2b']), 'models on one host share a route')
assert.equal(chainGroups[1].endpoint.baseURL, 'http://10.0.101.11:11434')
const chainRouteOps = buildChainRouteOps({
  endpoint: { kind: 'ollama-native', baseURL: 'http://127.0.0.1:11434', model: 'gemma4:e4b' },
  fallbackEndpoints: [{ kind: 'ollama-native', baseURL: 'http://10.0.101.11:11434', model: 'gemma4:e2b' }],
})
assert.equal(chainRouteOps.length, 2, 'one pi-ai op per endpoint-chain host')
assert.equal(chainRouteOps[0].path.join('.'), 'providers.local-delegate')
assert.equal(chainRouteOps[1].path.join('.'), 'providers.local-delegate-fb1')
assert.equal(chainRouteOps[0].value.baseURL, 'http://127.0.0.1:11434/v1')
assert.equal(JSON.stringify(chainRouteOps[1].value.models.map(model => model.id)), JSON.stringify(['gemma4:e2b']))

// A model the health probe reports missing must not become a slave route.
const unhealthy = {
  primary: { baseURL: 'http://127.0.0.1:11434', model: 'gemma4:e4b', modelFound: true },
  fallbacks: [{ baseURL: 'http://127.0.0.1:11434', model: 'gemma4:e2b', modelFound: false }],
}
assert.equal(missingChainModels(unhealthy).size, 1, 'health must expose known-missing endpoint models')
const healthyChainOps = buildChainRouteOps(
  {
    endpoint: { kind: 'ollama-native', baseURL: 'http://127.0.0.1:11434', model: 'gemma4:e4b' },
    fallbackEndpoints: [{ kind: 'ollama-native', baseURL: 'http://127.0.0.1:11434', model: 'gemma4:e2b' }],
  },
  unhealthy,
)
assert.equal(healthyChainOps.length, 1, 'a host with one available model keeps one route')
assert.equal(JSON.stringify(healthyChainOps[0].value.models.map(model => model.id)), JSON.stringify(['gemma4:e4b']))

// Removing the route must cover the primary and every fallback-chain provider.
const unrouteOps = buildChainUnrouteOps({
  'local-delegate': { api: 'openai-completions' },
  'local-delegate-fb1': { api: 'openai-completions' },
  'local-delegate-fb2': { api: 'openai-completions' },
  'intranet-gemma': { api: 'openai-completions' },
})
assert.equal(JSON.stringify(unrouteOps.map(op => op.path.join('.'))), JSON.stringify(['providers.local-delegate', 'providers.local-delegate-fb1', 'providers.local-delegate-fb2']))
assert.ok(unrouteOps.every(op => op.op === 'unset'))
assert.equal(JSON.stringify(chainRouteIds({ 'local-delegate': {}, 'local-delegate-fb9': {}, 'other': {} })), JSON.stringify(['local-delegate', 'local-delegate-fb9']))

// Auto-registration preserves a user-customized provider instead of clobbering it.
const customProvider = {
  displayName: 'My private Gemma route',
  api: 'openai-completions',
  baseURL: 'http://127.0.0.1:11434/v1',
  headers: { Authorization: 'Bearer my-secret', 'X-Custom': 'keep' },
  models: [{ id: 'gemma4:e2b', contextWindow: 65536 }, { id: 'old-model' }],
  reasoningEfforts: { off: 'none' },
}
const mergedProvider = buildPiProvider(
  { ...draftOverride.endpoint, baseURL: 'http://127.0.0.1:11434', numCtx: 32768, maxOutputTokens: 4096 },
  ['gemma4:e4b'],
  undefined,
  customProvider,
)
assert.equal(mergedProvider.displayName, 'My private Gemma route', 'custom displayName is preserved')
assert.equal(mergedProvider.headers.Authorization, 'Bearer my-secret', 'custom auth header is preserved')
assert.equal(mergedProvider.headers['X-Custom'], 'keep', 'extra headers are preserved')
assert.equal(JSON.stringify(mergedProvider.models.map(model => model.id)), JSON.stringify(['gemma4:e2b', 'old-model', 'gemma4:e4b']), 'existing models stay first, new models are appended')
assert.equal(mergedProvider.models[0].contextWindow, 65536, 'existing model metadata is preserved')
assert.equal(JSON.stringify(mergedProvider.reasoningEfforts), JSON.stringify({ off: 'none' }), 'unmanaged fields are preserved')
const pluginNamed = buildPiProvider(draftOverride.endpoint, ['gemma4:e4b'], undefined, {
  displayName: '本地/降智模型（SlaveAgentTeams 自动路由）',
  models: [{ id: 'gemma4:e2b' }],
})
assert.equal(pluginNamed.displayName, '本地/降智模型（dsh-local-delegate）', 'a plugin-generated name may be refreshed')
const chainWithCustom = buildChainRouteOps(
  { endpoint: { kind: 'ollama-native', baseURL: 'http://127.0.0.1:11434', model: 'gemma4:e4b' }, fallbackEndpoints: [] },
  undefined,
  { 'local-delegate': customProvider },
)
assert.equal(chainWithCustom[0].value.displayName, 'My private Gemma route', 'chain sync keeps the custom provider name')

// Endpoint number validation stops a saved 0 from breaking every request.
const tKey = key => (key === 'endpointNumberInvalid' ? '{field} {min} {max}' : key)
assert.equal(validateEndpointNumbers(draftOverride.endpoint, tKey), null, 'valid endpoint numbers pass')
assert.match(validateEndpointNumbers({ ...draftOverride.endpoint, timeoutMs: 0 }, tKey).text, /timeoutMs/)
assert.match(validateEndpointNumbers({ ...draftOverride.endpoint, maxOutputTokens: 0 }, tKey).text, /maxOutputTokens/)
assert.match(validateEndpointNumbers({ ...draftOverride.endpoint, numCtx: 0 }, tKey).text, /numCtx/)
assert.match(validateEndpointNumbers({ ...draftOverride.endpoint, temperature: 3 }, tKey).text, /temperature/)
assert.equal(validateEndpointNumbers({ ...draftOverride.endpoint, timeoutMs: undefined }, tKey), null, 'an absent field is not validated')

assert.ok(render(HealthCard({ t: key => key, health: { status: 'available', checkedAt: 1, effective: { baseURL: 'http://x', model: 'm', latencyMs: 12 } }, status: { config: draftOverride }, onRefresh: () => {} })))
assert.ok(render(SubagentCard({ t: key => key, piReady: true, subReady: true, routeRegistered: false, subAllowed: false, busy: '', onEnable: () => {}, onDisable: () => {}, savedEndpoint: draftOverride.endpoint })))
const subagentNoticeHtml = render(
  SubagentCard({
    t: key => key,
    piReady: true,
    subReady: true,
    routeRegistered: false,
    subAllowed: false,
    busy: '',
    notice: { kind: 'ok', text: 'subagentDone' },
    onEnable: () => {},
    onDisable: () => {},
    savedEndpoint: draftOverride.endpoint,
  }),
)
assert.ok(subagentNoticeHtml.includes('subagentDone'), 'Subagent action feedback must render inside the card')

const healthChainHtml = render(
  HealthCard({
    t: key => key,
    health: {
      status: 'degraded',
      checkedAt: 1,
      primary: { baseURL: 'http://primary', model: 'm1', reachable: true, modelFound: true, latencyMs: 5, error: null },
      fallbacks: [
        { baseURL: 'http://fallback-a', model: 'm2', reachable: false, modelFound: false, latencyMs: 3, error: 'ECONNREFUSED' },
        { baseURL: 'http://fallback-b', model: 'm3', reachable: true, modelFound: false, latencyMs: 4, error: null },
      ],
      effective: { baseURL: 'http://fallback-b', model: 'm3', reachable: true, modelFound: false, latencyMs: 4, error: null },
    },
    status: { config: draftOverride },
    onRefresh: () => {},
  }),
)
assert.ok(healthChainHtml.includes('healthEndpoints'), 'health card must render the endpoint chain')
assert.ok(healthChainHtml.includes('healthFallback') && healthChainHtml.includes('healthPrimary'), 'health card must label primary and fallbacks')
assert.ok(healthChainHtml.includes('healthOffline'), 'health card must show an offline fallback')
assert.ok(healthChainHtml.includes('healthModelMissing'), 'health card must show a reachable fallback with a missing model')
assert.ok(healthChainHtml.includes('http://fallback-a'), 'health card must show fallback addresses')

// LevelsCard: workspace list, override matching, and the high/max route warning.
const levelsHtml = render(
  LevelsCard({
    t: key => key,
    current: { ...draftOverride, defaultLevel: 'high', workspaceLevels: { 'C:/ws/a': 'max' } },
    disabled: false,
    update: () => {},
    levelsInfo: {
      ok: true,
      levels: ['none', 'light', 'default', 'high', 'max'],
      workspaces: [
        { id: 'w1', title: 'Workspace A', path: 'C:\\ws\\a', level: 'max', source: 'override' },
        { id: 'w2', title: 'Workspace B', path: 'C:/ws/b', level: 'default', source: 'default' },
      ],
    },
    levelsError: '',
    onRefreshLevels: () => {},
    routeRegistered: false,
    endpointModel: 'gemma4:e2b',
    listValue: () => '',
    onListChange: () => {},
    onWorkspaceLevel: () => {},
  }),
)
assert.ok(levelsHtml.includes('Workspace A'), 'levels card must render workspace titles')
assert.ok(levelsHtml.includes('C:\\ws\\a'), 'levels card must render workspace paths')
assert.ok(levelsHtml.includes('levelsNeedsRoute'), 'levels card must warn when high/max has no local-delegate route')
assert.ok(levelsHtml.includes('levelsDefault') && levelsHtml.includes('levelsAdvanced'), 'levels card must render its level controls')

// LevelsCard without /levels data must render the empty state instead of throwing.
const levelsEmptyHtml = render(
  LevelsCard({
    t: key => key,
    current: draftOverride,
    disabled: true,
    update: () => {},
    levelsInfo: null,
    levelsError: 'HTTP 404',
    onRefreshLevels: () => {},
    routeRegistered: true,
    endpointModel: 'gemma4:e2b',
    listValue: () => '',
    onListChange: () => {},
    onWorkspaceLevel: () => {},
  }),
)
assert.ok(levelsEmptyHtml.includes('levelsNoWorkspaces'), 'levels card must render the no-workspace hint')
assert.ok(levelsEmptyHtml.includes('levelsLoadFailed'), 'levels card must surface the /levels error')

// SlaveTeamsCard: node editor, route warning, implicit node, compatibility note.
const slaveHtml = render(
  SlaveTeamsCard({
    t: key => key,
    current: { ...draftOverride, slaveTeamsEnabled: true, slaveNodes },
    disabled: false,
    update: () => {},
    piReady: true,
    providers: [{ id: 'local-delegate', models: ['gemma4:e2b'] }],
    routeRegistered: false,
    endpointModel: 'gemma4:e2b',
    onSetNode: () => {},
    onAddNode: () => {},
    onRemoveNode: () => {},
    onFillLocalNode: () => {},
  }),
)
assert.ok(slaveHtml.includes('local') && slaveHtml.includes('deepseek-account'), 'slave card must render node names/providers')
assert.ok(slaveHtml.includes('slaveAddNode') && slaveHtml.includes('slaveFillLocal'), 'slave card must render the node actions')
assert.ok(slaveHtml.includes('slaveRouteMissing'), 'slave card must warn when local-delegate is not registered')
assert.ok(slaveHtml.includes('slaveCompatNote') && slaveHtml.includes('slaveToolsNote'), 'slave card must document Team compatibility and tools')

const slaveEmptyHtml = render(
  SlaveTeamsCard({
    t: key => (key === 'slaveImplicitNode' ? 'slaveImplicitNode {node}' : key),
    current: { ...draftOverride, slaveTeamsEnabled: true, slaveTeamAutoDiscover: false, slaveNodes: [] },
    disabled: false,
    update: () => {},
    piReady: true,
    providers: [],
    routeRegistered: true,
    endpointModel: 'gemma4:e2b',
    autoDiscover: false,
    onSetNode: () => {},
    onAddNode: () => {},
    onRemoveNode: () => {},
    onFillLocalNode: () => {},
  }),
)
assert.ok(slaveEmptyHtml.includes('slaveImplicitNode'), 'slave card must explain the implicit local node when auto discovery is off')
assert.ok(slaveEmptyHtml.includes('gemma4:e2b'), 'implicit node hint must name the endpoint model')

// Auto mode: one switch, detected pool, no manual rows required.
const slaveAutoHtml = render(
  SlaveTeamsCard({
    t: key => (key === 'slaveAutoDetected' ? 'slaveAutoDetected {count}/{nodes}' : key),
    current: { ...draftOverride, slaveTeamsEnabled: true, slaveNodes: [] },
    disabled: false,
    update: () => {},
    piReady: true,
    providers: [],
    routeRegistered: false,
    endpointModel: 'gemma4:e2b',
    autoInfo: {
      mode: 'auto',
      enabled: true,
      nodes: [
        { name: 'intranet-gemma/gemma4:e2b', kind: 'local', provider: 'intranet-gemma', model: 'gemma4:e2b' },
        { name: 'deepseek-account/deepseek-flash', kind: 'cloud', provider: 'deepseek-account', model: 'deepseek-flash' },
      ],
      providers: [
        { id: 'intranet-gemma', models: ['gemma4:e2b'] },
        { id: 'deepseek-account', models: ['deepseek-flash'] },
      ],
      issues: [],
    },
    autoDiscover: true,
    onRefreshAuto: () => {},
    onSyncRoutes: () => {},
    onSetNode: () => {},
    onAddNode: () => {},
    onRemoveNode: () => {},
    onFillLocalNode: () => {},
  }),
)
assert.ok(slaveAutoHtml.includes('slaveAutoMode'), 'auto mode must be labelled')
assert.ok(slaveAutoHtml.includes('slaveAutoDetected 2/2'), 'auto mode must show detected routes/nodes')
assert.ok(slaveAutoHtml.includes('intranet-gemma/gemma4:e2b'), 'auto mode must list detected nodes')
assert.ok(!slaveAutoHtml.includes('slaveImplicitNode'), 'auto mode must not fall back to the implicit-node warning')
assert.ok(slaveAutoHtml.includes('slaveAutoRefresh') && slaveAutoHtml.includes('slaveAutoSyncNow'), 'auto mode must offer refresh + route sync')

const slaveAvailableHtml = render(
  SlaveTeamsCard({
    t: key => key,
    current: {
      ...draftOverride,
      slaveTeamsEnabled: true,
      slaveNodes: [{ name: 'chosen', kind: 'local', provider: 'local-delegate', model: 'gemma4:e4b' }],
    },
    disabled: false,
    update: () => {},
    piReady: true,
    providers: [],
    routeRegistered: true,
    endpointModel: 'gemma4:e4b',
    autoInfo: {
      mode: 'explicit',
      enabled: true,
      nodes: [{ name: 'chosen', kind: 'local', provider: 'local-delegate', model: 'gemma4:e4b' }],
      detected: [
        { name: 'local-delegate/gemma4:e4b', kind: 'local', provider: 'local-delegate', model: 'gemma4:e4b' },
        { name: 'local-delegate/gemma4:e2b', kind: 'local', provider: 'local-delegate', model: 'gemma4:e2b' },
      ],
      providers: [{ id: 'local-delegate', models: ['gemma4:e4b', 'gemma4:e2b'] }],
      issues: [],
    },
    autoDiscover: true,
    onRefreshAuto: () => {},
    onSyncRoutes: () => {},
    onSetNode: () => {},
    onAddNode: () => {},
    onRemoveNode: () => {},
    onFillLocalNode: () => {},
  }),
)
assert.ok(slaveAvailableHtml.includes('slaveAvailable'), 'available-node picker must render')
assert.ok(slaveAvailableHtml.includes('slaveAvailableSelected'), 'available-node picker must render the selected count')
assert.ok(slaveAvailableHtml.includes('local-delegate/gemma4:e2b'), 'available-node picker must list unselected detection')
assert.ok(slaveAvailableHtml.includes('slaveSelectAll'), 'available-node picker must offer select-all')

// Exact card titles (tags make the title key unambiguous).
const tag = key => '«' + key + '»'
const levelsTagged = render(
  LevelsCard({
    t: tag,
    current: draftOverride,
    disabled: false,
    update: () => {},
    levelsInfo: null,
    levelsError: '',
    onRefreshLevels: () => {},
    routeRegistered: true,
    endpointModel: 'gemma4:e2b',
    listValue: () => '',
    onListChange: () => {},
    onWorkspaceLevel: () => {},
  }),
)
assert.ok(levelsTagged.includes('«levels»'), 'levels card must render its title')
const slaveTagged = render(
  SlaveTeamsCard({
    t: tag,
    current: draftOverride,
    disabled: false,
    update: () => {},
    piReady: true,
    providers: [],
    routeRegistered: true,
    endpointModel: 'gemma4:e2b',
    onSetNode: () => {},
    onAddNode: () => {},
    onRemoveNode: () => {},
    onFillLocalNode: () => {},
  }),
)
assert.ok(slaveTagged.includes('«slaveTeams»'), 'SlaveAgentTeams card must render its title')

const statsHtml = render(
  StatsCard({
    t: key => key,
    stats: {
      calls: 2,
      failed: 0,
      chunkCalls: 3,
      charsIn: 100,
      charsOut: 50,
      localPromptTokens: 10,
      localCompletionTokens: 20,
      estimatedSavedTokens: 120,
      startedAt: 1,
      byTask: { translate: { calls: 2 } },
      workersStarted: 2,
      workersFailed: 1,
      slavesStarted: 5,
      slavesSettled: 4,
      slavesFailed: 1,
      byNode: { local: 3, cloud: 2 },
      lastError: null,
    },
    onRefresh: () => {},
  }),
)
assert.ok(statsHtml.includes('statsWorkers') && statsHtml.includes('statsSlaves'), 'stats card must show worker/slave counters')
assert.ok(statsHtml.includes('statsByNode') && statsHtml.includes('local'), 'stats card must show the per-node slave breakdown')
assert.ok(render(StatsCard({ t: key => key, stats: { calls: 0, failed: 0, chunkCalls: 0, workersStarted: 0 }, onRefresh: () => {} })), 'empty stats card must still render')
assert.ok(render(ProbeResult({ t: key => key, probe: { ok: true, modelFound: true, latencyMs: 9, models: ['m'], endpoint: 'ollama://x/m' } })))

// ── composer level picker (0.4.1) ─────────────────────────────────────────
const wsA = { workspaceId: 'ws-a', path: 'C:/ws/a', title: 'Alpha', sessionIds: ['s1'] }
const wsB = { workspaceId: 'ws-b', path: 'C:/ws/b', title: 'Beta', sessionIds: [] }
assert.equal(resolveComposerWorkspace([wsA, wsB], 's1'), wsA, 'composer workspace resolution follows sessionIds')
assert.equal(resolveComposerWorkspace([wsA, wsB], 's2'), null, 'unknown sessions have no workspace')
assert.equal(resolveComposerWorkspace(undefined, 's1'), null, 'missing workspace snapshot is safe')

const wsModel = composerLevelModel({ ...draftOverride, workspaceLevels: { 'c:\\ws\\a': 'high' } }, wsA, key => key)
assert.equal(wsModel.mode, 'workspace')
assert.equal(wsModel.override, 'high')
assert.equal(wsModel.value, 'high')
assert.equal(wsModel.options.length, 6, 'workspace mode must offer follow-default plus five levels')
const defaultModel = composerLevelModel(draftOverride, null, key => key)
assert.equal(defaultModel.mode, 'default')
assert.equal(defaultModel.value, 'default')
assert.equal(defaultModel.options.length, 5, 'default mode offers the five levels only')
assert.equal(composerLevelModel({ ...draftOverride, composerLevelPicker: false }, wsA, key => key), null, 'toggle off hides the picker')
assert.equal(composerLevelModel({ ...draftOverride, levelsEnabled: false }, wsA, key => key), null, 'levels off hides the picker')

const composerForm = controller({ ...draftOverride, workspaceLevels: { 'C:/ws/a': 'high' } })
const composerHtml = render(
  React.createElement(ComposerLevelPicker, {
    t: key => key,
    form: composerForm,
    sessionId: 's1',
    useWorkspaces: selector => selector({ items: [wsA, wsB] }),
  }),
)
assert.ok(composerHtml.includes('composerLevelShort'), 'composer trigger must render its label')
assert.ok(composerHtml.includes('levelHigh'), 'composer trigger must show the effective workspace level')
assert.ok(composerHtml.includes('composerLevelMenuTitle'), 'composer menu must render its title')
assert.ok(composerHtml.includes('composerLevelWorkspace'), 'composer menu must name the current workspace')

const composerHiddenHtml = render(
  React.createElement(ComposerLevelPicker, {
    t: key => key,
    form: controller({ ...draftOverride, composerLevelPicker: false }),
    sessionId: 's1',
    useWorkspaces: selector => selector({ items: [wsA] }),
  }),
)
assert.equal(composerHiddenHtml, '', 'disabled composer picker renders nothing')

const composerDefaultHtml = render(
  React.createElement(ComposerLevelPicker, {
    t: key => key,
    form: controller(draftOverride),
    sessionId: 'ungrouped',
    useWorkspaces: selector => selector({ items: [wsA, wsB] }),
  }),
)
assert.ok(composerDefaultHtml.includes('composerLevelDefaultMode'), 'unmatched session edits the default level and says so')

console.log('ok - client bundle evaluates, registers, and renders (levels + SlaveAgentTeams cards)')




