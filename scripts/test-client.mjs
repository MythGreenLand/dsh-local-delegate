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
assert.equal(registrations.length, 2, 'both surfaces must register')
const row = registrations.find(entry => entry.options.name === 'plugins.row.config')
const section = registrations.find(entry => entry.options.name === 'settings.section')
assert.ok(row)
assert.equal(row.options.key, 'dsh-local-delegate#local-delegate')
assert.ok(section)
assert.equal(section.options.id, 'local-delegate')

const props = { t: key => key, form, piForm, subForm }
assert.equal(row.Component({ view: 'summary', ...props }), 'summary')
const pageTree = row.Component({ view: 'page', ...props })
const html = render(pageTree)
assert.ok(html.includes('title'), 'full page must render the title')
assert.ok(html.includes('endpointSection') && html.includes('test'), 'page must render the endpoint section and actions')

const { buildOps, buildPiProvider, HealthCard, SubagentCard, StatsCard, ProbeResult } = moduleExports.__test
const ops = buildOps(draftOverride, { ...draftOverride, endpoint: { ...draftOverride.endpoint, model: 'other' } })
assert.equal(ops.map(op => op.path.join('.')).join(','), 'endpoint')
const ollamaProvider = buildPiProvider(draftOverride.endpoint)
assert.equal(ollamaProvider.api, 'openai-completions')
assert.equal(ollamaProvider.baseURL, 'http://10.0.101.11:11434/v1')
assert.equal(ollamaProvider.models[0].id, 'gemma4:e2b')
assert.equal(ollamaProvider.headers.Authorization, 'Bearer ollama')
const keyedProvider = buildPiProvider({ ...draftOverride.endpoint, kind: 'openai-compatible', apiKey: 'sk-test' })
assert.equal(keyedProvider.headers.Authorization, 'Bearer sk-test')

assert.ok(render(HealthCard({ t: key => key, health: { status: 'available', checkedAt: 1, effective: { baseURL: 'http://x', model: 'm', latencyMs: 12 } }, status: { config: draftOverride }, onRefresh: () => {} })))
assert.ok(render(SubagentCard({ t: key => key, piReady: true, subReady: true, routeRegistered: false, subAllowed: false, busy: '', onEnable: () => {}, onDisable: () => {}, savedEndpoint: draftOverride.endpoint })))
assert.ok(render(StatsCard({ t: key => key, stats: { calls: 2, failed: 0, chunkCalls: 3, charsIn: 100, charsOut: 50, localPromptTokens: 10, localCompletionTokens: 20, estimatedSavedTokens: 120, startedAt: 1, byTask: { translate: { calls: 2 } }, lastError: null }, onRefresh: () => {} })))
assert.ok(render(ProbeResult({ t: key => key, probe: { ok: true, modelFound: true, latencyMs: 9, models: ['m'], endpoint: 'ollama://x/m' } })))

console.log('ok - client bundle evaluates, registers, and renders')




