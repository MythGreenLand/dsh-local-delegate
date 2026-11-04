/**
 * Regression checks for the fixes made after the 0.5.0 review:
 * symlink path escapes, batch output collisions, Windows deny-glob casing,
 * health/modelFound handling, per-task model precedence, summary accounting,
 * and live promptHelp toggling.
 *
 * Run with `node scripts/test-regressions.mjs`.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { executeBatch, executeTransform, apply } from '../index.js'
import { modelForEndpoint } from '../lib/config.js'
import { matchesDeniedPath } from '../lib/guard.js'
import { probeEndpoint } from '../lib/endpoint.js'
import { createStats, recordSuccess, renderStats } from '../lib/stats.js'

const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

function makeConfig(port, overrides = {}) {
  return {
    enabled: true,
    endpoint: {
      kind: 'ollama-native',
      baseURL: `http://127.0.0.1:${port}`,
      path: '',
      model: 'm1',
      apiKey: '',
      apiKeyEnv: '',
      headers: {},
      numCtx: 4096,
      keepAlive: '1m',
      think: false,
      reasoningEffort: 'none',
      timeoutMs: 10_000,
      temperature: 0,
      maxOutputTokens: 256,
    },
    fallbackEndpoints: [],
    modelsByTask: {},
    retries: 0,
    maxInlineChars: 8000,
    chunkChars: 500,
    maxConcurrency: 1,
    maxSourceChars: 200_000,
    maxBatchFiles: 10,
    maxBatchChars: 120_000,
    maxResultChars: 6000,
    maxCallsPerMinute: 100,
    promptHelp: true,
    warmupOnStart: false,
    levelsEnabled: false,
    defaultLevel: 'default',
    workspaceLevels: {},
    allowOutsideCwd: false,
    allowRoots: [],
    denyGlobs: [],
    ...overrides,
  }
}

function runtimeFor(config) {
  return { config, stats: createStats(), rate: [], health: { status: 'unknown' } }
}

function ctxFor(workspace) {
  return {
    get(name) {
      if (name === 'workingDirectory') {
        return { defaultDirectory: workspace, ensure: async () => workspace }
      }
      return undefined
    },
  }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

async function main() {
  const calls = { count: 0 }
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/tags') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ models: [{ name: 'm1' }] }))
      return
    }
    if (req.url === '/api/chat') {
      let body = ''
      for await (const chunk of req) body += chunk
      calls.count += 1
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        message: { content: `out-${calls.count}` },
        prompt_eval_count: 10,
        eval_count: 5,
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const port = await listen(server)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-local-delegate-regression-'))
  try {
    const workspace = path.join(tmp, 'ws')
    await fs.mkdir(workspace, { recursive: true })

    check('modelsByTask takes precedence over endpoint.model', () => {
      const config = makeConfig(port, {
        endpoint: { ...makeConfig(port).endpoint, model: 'endpoint-model' },
        modelsByTask: { translate: 'task-model' },
      })
      assert.equal(modelForEndpoint(config, config.endpoint, 'translate'), 'task-model')
      assert.equal(modelForEndpoint(config, { model: 'fallback-model' }, 'translate'), 'task-model')
      assert.equal(modelForEndpoint(config, config.endpoint, 'summarize'), 'endpoint-model')
    })

    check('Windows deny globs are case-insensitive', () => {
      if (process.platform !== 'win32') return
      assert.equal(matchesDeniedPath('C:\\ws', 'C:\\ws\\.ENV', ['**/.env']), true)
      assert.equal(matchesDeniedPath('C:\\ws', 'C:\\ws\\.env', ['**/.env']), true)
      assert.equal(matchesDeniedPath('C:\\ws', 'C:\\ws\\notes.txt', ['**/.env']), false)
    })

    check('probeEndpoint does not accept a partial model tag', async () => {
      const config = makeConfig(port)
      const probe = await probeEndpoint({ endpoint: config.endpoint, model: 'm' })
      assert.equal(probe.ok, true)
      assert.equal(probe.modelFound, false)
      const exact = await probeEndpoint({ endpoint: config.endpoint, model: 'm1' })
      assert.equal(exact.modelFound, true)
    })

    check('a source symlink cannot read outside the workspace', async () => {
      const outside = path.join(tmp, 'outside.txt')
      await fs.writeFile(outside, 'outside secret')
      const link = path.join(workspace, 'link.txt')
      try {
        await fs.symlink(outside, link, 'file')
      } catch (error) {
        console.log('skip - symlink creation unavailable:', error.code)
        return
      }
      const config = makeConfig(port)
      await assert.rejects(
        () => executeTransform(runtimeFor(config), ctxFor(workspace), { agent: null }, { task: 'summarize', path: 'link.txt' }),
        /LOCAL_PATH_OUTSIDE_WORKSPACE/,
      )
    })

    check('a symlinked out_dir cannot write outside the workspace', async () => {
      const outside = path.join(tmp, 'outside-dir')
      await fs.mkdir(outside, { recursive: true })
      await fs.writeFile(path.join(workspace, 'doc.txt'), 'document')
      const link = path.join(workspace, 'outlink')
      try {
        await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error) {
        console.log('skip - directory symlink unavailable:', error.code)
        return
      }
      const config = makeConfig(port)
      await assert.rejects(
        () =>
          executeBatch(runtimeFor(config), ctxFor(workspace), { agent: null }, {
            task: 'rewrite',
            paths: ['doc.txt'],
            out_dir: 'outlink',
            dry_run: false,
          }),
        /LOCAL_PATH_OUTSIDE_WORKSPACE/,
      )
    })

    check('local_batch gives same-basename inputs distinct outputs', async () => {
      const x = path.join(workspace, 'x')
      const y = path.join(workspace, 'y')
      await fs.mkdir(x, { recursive: true })
      await fs.mkdir(y, { recursive: true })
      await fs.writeFile(path.join(x, 'same.md'), 'alpha')
      await fs.writeFile(path.join(y, 'same.md'), 'beta')
      const config = makeConfig(port)
      const result = await executeBatch(runtimeFor(config), ctxFor(workspace), { agent: null }, {
        task: 'rewrite',
        paths: ['x/same.md', 'y/same.md'],
        out_dir: 'out',
        dry_run: false,
      })
      assert.equal(result.ok, true)
      assert.equal(result.written.length, 2)
      assert.equal(new Set(result.written).size, 2, 'written paths must be unique')
      const names = (await fs.readdir(path.join(workspace, 'out'))).sort()
      assert.deepEqual(names, ['same.local-2.md', 'same.local.md'])
    })

    check('local_batch applies denied globs to each output path', async () => {
      await fs.mkdir(path.join(workspace, '.git'), { recursive: true })
      await fs.writeFile(path.join(workspace, 'deny-source.txt'), 'source')
      const config = makeConfig(port, { denyGlobs: ['**/.git/**'] })
      const result = await executeBatch(runtimeFor(config), ctxFor(workspace), { agent: null }, {
        task: 'rewrite',
        paths: ['deny-source.txt'],
        out_dir: '.git',
        dry_run: false,
      })
      assert.equal(result.ok, false)
      assert.equal(result.failed, 1)
      assert.equal(result.written.length, 0)
      assert.match(result.failures[0].reason, /LOCAL_PATH_DENIED/)
      await assert.rejects(() => fs.stat(path.join(workspace, '.git', 'deny-source.local.txt')), /ENOENT/)
    })

    check('multi-chunk summarize counts the reduce request and its tokens', async () => {
      const config = makeConfig(port)
      const paragraph = 'A'.repeat(300)
      const text = [paragraph, paragraph, paragraph].join('\n\n')
      const before = calls.count
      const result = await executeTransform(runtimeFor(config), ctxFor(workspace), { agent: null }, {
        task: 'summarize',
        text,
        target_language: 'English',
      })
      const used = calls.count - before
      assert.equal(result.chunks, 4, 'three chunks + one reduce request')
      assert.equal(result.local_tokens, used * 15, 'all four requests are counted')
      assert.equal(used, 4)
      assert.equal(result.text, `out-${calls.count}`)
    })

    check('renderStats names the degraded fallback endpoint', () => {
      const stats = createStats()
      recordSuccess(stats, { task: 'translate', charsIn: 100, charsOut: 20, chunkCalls: 1, promptTokens: 1, completionTokens: 1 })
      const text = renderStats(
        stats,
        makeConfig(port).endpoint,
        {
          status: 'degraded',
          effective: { endpoint: { baseURL: 'http://127.0.0.1:11434' }, model: 'm1' },
          primary: { probe: { error: 'connection refused' } },
        },
      )
      assert.match(text, /fallback http:\/\/127\.0\.0\.1:11434 is available/)
      assert.doesNotMatch(text, /fallback unknown/)
    })

    function applyFor(config) {
      const tools = []
      const handlers = new Map()
      const sections = []
      const disposed = { count: 0 }
      const systemPrompt = {
        section(value) {
          sections.push(value)
          return () => {
            disposed.count += 1
          }
        },
        context() {
          return () => {}
        },
      }
      const ctx = {
        logger: { info() {}, warn() {}, debug() {}, error() {} },
        get(name) {
          if (name === 'systemPrompt') return systemPrompt
          return undefined
        },
        on(name, handler) {
          const list = handlers.get(name) ?? []
          list.push(handler)
          handlers.set(name, list)
        },
        effect(fn) {
          const dispose = fn()
          return typeof dispose === 'function' ? dispose : () => {}
        },
        tools: { register(tool) { tools.push(tool) } },
      }
      apply(ctx, config)
      return { tools, handlers, sections, disposed }
    }

    check('health reports a broken fallback and still marks a usable primary ready', async () => {
      const primary = makeConfig(port)
      const fallback = { ...primary.endpoint, model: 'm2' }
      const config = makeConfig(port, { fallbackEndpoints: [fallback] })
      const { tools } = applyFor(config)
      const health = await tools.find((tool) => tool.name === 'local_health').execute()
      assert.equal(health.status, 'available')
      assert.equal(health.fallbacks[0].model_found, false)
      assert.ok(health.remediation.some((item) => item.includes('fallbackEndpoints[0]')))
      assert.ok(health.remediation.some((item) => item.includes('does not advertise model "m2"')))
    })

    check('health uses a usable fallback when the primary model is missing', async () => {
      const primary = { ...makeConfig(port).endpoint, model: 'missing-model' }
      const fallback = { ...makeConfig(port).endpoint, model: 'm1' }
      const config = makeConfig(port, { endpoint: primary, fallbackEndpoints: [fallback] })
      const { tools } = applyFor(config)
      const health = await tools.find((tool) => tool.name === 'local_health').execute()
      assert.equal(health.status, 'degraded')
      assert.equal(health.effective.model, 'm1')
      assert.ok(health.remediation.some((item) => item.includes('does not advertise model "missing-model"')))
    })

    check('promptHelp is applied and removed on volatile updates', () => {
      const config = makeConfig(port, { promptHelp: true })
      const { handlers, sections, disposed } = applyFor(config)
      assert.equal(sections.length, 1)
      const fire = () => {
        for (const handler of handlers.get('loader/volatile-update') ?? []) handler()
      }
      config.promptHelp = false
      fire()
      assert.equal(disposed.count, 1)
      config.promptHelp = true
      fire()
      assert.equal(sections.length, 2)
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
      console.error(`\n${failed} regression check(s) failed`)
      process.exitCode = 1
    } else {
      console.log(`\nall ${checks.length} regression checks passed`)
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

await main()
