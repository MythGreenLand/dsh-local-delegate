#!/usr/bin/env node
/**
 * Verify one local-model endpoint before installing or when delegation fails.
 *
 * Usage:
 *   node scripts/verify-endpoint.mjs --base-url http://10.0.101.11:11434 --model gemma4:e2b
 *   node scripts/verify-endpoint.mjs --kind openai-compatible --base-url http://host:11434/v1 \
 *        --model gemma4:e2b --api-key ollama
 *
 * Exit code 0 when the endpoint is reachable, advertises the model, and answers
 * one tiny translation; 1 otherwise.
 */
import { callModel, probeEndpoint } from '../lib/endpoint.js'

function parseArgs(argv) {
  const options = {
    kind: 'ollama-native',
    baseURL: '',
    model: '',
    path: '',
    apiKey: '',
    think: false,
    reasoningEffort: 'none',
    timeoutMs: 150000,
    json: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[++index]
    switch (arg) {
      case '--kind': options.kind = next(); break
      case '--base-url': case '--baseURL': options.baseURL = next(); break
      case '--model': options.model = next(); break
      case '--path': options.path = next(); break
      case '--api-key': options.apiKey = next(); break
      case '--think': options.think = next() !== 'false'; break
      case '--reasoning-effort': options.reasoningEffort = next(); break
      case '--timeout': options.timeoutMs = Number(next()) || options.timeoutMs; break
      case '--json': options.json = true; break
      case '--help': case '-h':
        console.log('Options: --kind ollama-native|openai-compatible --base-url URL --model ID [--path PATH] [--api-key KEY] [--think false] [--reasoning-effort none] [--timeout MS] [--json]')
        process.exit(0)
        break
      default:
        if (arg.startsWith('--base-url=')) options.baseURL = arg.slice('--base-url='.length)
        else if (arg.startsWith('--model=')) options.model = arg.slice('--model='.length)
        break
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const endpoint = {
  kind: options.kind === 'openai-compatible' ? 'openai-compatible' : 'ollama-native',
  baseURL: options.baseURL,
  path: options.path,
  model: options.model,
  apiKey: options.apiKey,
  headers: {},
  numCtx: 32768,
  keepAlive: '30m',
  think: options.think,
  reasoningEffort: options.reasoningEffort,
  timeoutMs: options.timeoutMs,
  temperature: 0,
  maxOutputTokens: 128,
}

function fail(reason) {
  if (options.json) console.log(JSON.stringify({ ok: false, reason }, null, 2))
  else console.error(`FAIL: ${reason}`)
  process.exit(1)
}

if (!options.baseURL) fail('--base-url is required (for example http://10.0.101.11:11434)')
if (!options.model) fail('--model is required (for example gemma4:e2b)')

const probe = await probeEndpoint({ endpoint, model: options.model })
if (!probe.ok) {
  fail(
    `endpoint ${options.baseURL} is unreachable: ${probe.error}. ` +
      'Check that the server is running, listens on 0.0.0.0 for LAN access, and the firewall allows the port.',
  )
}
if (!probe.modelFound) {
  fail(
    `endpoint reachable but does not advertise model "${options.model}". ` +
      `Available: ${probe.models.join(', ') || '(none)'}`,
  )
}

let generation
try {
  const started = Date.now()
  generation = await callModel({
    endpoint,
    model: options.model,
    system: 'Translate into Simplified Chinese. Return only the translation.',
    user: 'The build finished successfully.',
    maxOutputTokens: 128,
  })
  generation.durationMs = Date.now() - started
} catch (error) {
  fail(
    `endpoint reachable but generation failed: ${error.message}. ` +
      'For thinking models keep think=false (Ollama native) or reasoningEffort="none" (OpenAI-compatible).',
  )
}

const summary = {
  ok: true,
  kind: endpoint.kind,
  baseURL: options.baseURL,
  model: options.model,
  probe: { latencyMs: probe.latencyMs, models: probe.models.slice(0, 10) },
  generation: {
    text: generation.text.trim(),
    promptTokens: generation.promptTokens,
    completionTokens: generation.completionTokens,
    durationMs: generation.durationMs,
  },
}
if (options.json) console.log(JSON.stringify(summary, null, 2))
else {
  console.log('PASS')
  console.log(`endpoint : ${endpoint.kind} ${options.baseURL}`)
  console.log(`model    : ${options.model}`)
  console.log(`probe    : ${probe.latencyMs}ms; advertised models: ${probe.models.slice(0, 10).join(', ') || '(none)'}`)
  console.log(`generate : ${generation.durationMs}ms, ${generation.completionTokens} output tokens`)
  console.log(`output   : ${generation.text.trim()}`)
}
