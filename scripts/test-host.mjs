/**
 * Headless checks for the Host half: schema/volatile shape, apply() wiring,
 * status API, and the probe SSRF guard. Run with `node scripts/test-host.mjs`.
 */
import assert from 'node:assert/strict'
import { Config, readConfig, normalizeConfig, configWarnings } from '../lib/config.js'
import { requestRejection } from '../lib/trust.js'
import { createApiHandler } from '../lib/api.js'
import { apply } from '../index.js'

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
  assert.equal(commands.length, 2)
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
  assert.equal(status.version, '0.3.0')
  assert.equal(status.config.endpoint.baseURL, 'http://10.0.101.11:11434')
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
