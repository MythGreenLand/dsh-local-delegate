/**
 * Configuration schema and normalization for dsh-local-delegate.
 *
 * The GUI-editable subset is declared `.volatile()` so @deepseek-ai/dsh-settings
 * can project it into a form and the Loader can hot-update it in place:
 * a volatile field parses to `{ get(): snapshot }` instead of a plain value, so
 * runtime code must read the current snapshot instead of capturing it once.
 * Non-volatile fields (enabled, path policy) keep the normal reload lifecycle.
 */
import z from '@deepseek-ai/schemastery'

export const DEFAULT_DENY_GLOBS = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.credentials*',
  '**/secrets/**',
  '**/.git/**',
]

export const DEFAULT_ENDPOINT = Object.freeze({
  kind: 'ollama-native',
  baseURL: 'http://127.0.0.1:11434',
  path: '',
  model: '',
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
})

export const EndpointSchema = z.object({
  kind: z.union(['ollama-native', 'openai-compatible']).default('ollama-native'),
  baseURL: z.string().default(DEFAULT_ENDPOINT.baseURL),
  path: z.string().default(''),
  model: z.string().default(''),
  apiKey: z.string().default(''),
  apiKeyEnv: z.string().default(''),
  headers: z.dict(z.string()).default({}),
  numCtx: z.number().default(DEFAULT_ENDPOINT.numCtx),
  keepAlive: z.string().default(DEFAULT_ENDPOINT.keepAlive),
  think: z.boolean().default(false),
  reasoningEffort: z.string().default('none'),
  timeoutMs: z.number().default(DEFAULT_ENDPOINT.timeoutMs),
  temperature: z.number().default(0),
  maxOutputTokens: z.number().default(DEFAULT_ENDPOINT.maxOutputTokens),
})

/** Schema exported to the Loader; volatile fields are editable in the GUI. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  endpoint: EndpointSchema.volatile(),
  fallbackEndpoints: z.array(EndpointSchema).default([]).volatile(),
  modelsByTask: z.dict(z.string()).default({}).volatile(),
  retries: z.number().default(1).volatile(),
  maxInlineChars: z.number().default(8000).volatile(),
  chunkChars: z.number().default(4000).volatile(),
  maxConcurrency: z.number().default(2).volatile(),
  maxSourceChars: z.number().default(200000).volatile(),
  maxBatchFiles: z.number().default(10).volatile(),
  maxBatchChars: z.number().default(120000).volatile(),
  maxResultChars: z.number().default(6000).volatile(),
  maxCallsPerMinute: z.number().default(40).volatile(),
  promptHelp: z.boolean().default(true).volatile(),
  warmupOnStart: z.boolean().default(true).volatile(),
  probeAllowPublic: z.boolean().default(false).volatile(),
  allowOutsideCwd: z.boolean().default(false),
  allowRoots: z.array(z.string()).default([]),
  denyGlobs: z.array(z.string()).default(DEFAULT_DENY_GLOBS),
})

function positive(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

export function normalizeEndpoint(source) {
  const raw = source && typeof source === 'object' ? source : {}
  return {
    ...DEFAULT_ENDPOINT,
    ...raw,
    headers: { ...DEFAULT_ENDPOINT.headers, ...(raw.headers ?? {}) },
  }
}

/** Merge defaults into the live config and reject what cannot work. */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const endpoint = normalizeEndpoint(source.endpoint)
  if (endpoint.kind !== 'ollama-native' && endpoint.kind !== 'openai-compatible') {
    throw new Error(`local-delegate: endpoint.kind must be "ollama-native" or "openai-compatible", got ${JSON.stringify(endpoint.kind)}`)
  }
  if (typeof endpoint.baseURL !== 'string' || endpoint.baseURL.trim() === '') {
    throw new Error('local-delegate: endpoint.baseURL must be a non-empty string (for example http://10.0.101.11:11434)')
  }
  const fallbackEndpoints = Array.isArray(source.fallbackEndpoints)
    ? source.fallbackEndpoints.filter((entry) => entry && typeof entry === 'object').map(normalizeEndpoint)
    : []
  return {
    enabled: source.enabled !== false,
    endpoint,
    fallbackEndpoints,
    modelsByTask: source.modelsByTask && typeof source.modelsByTask === 'object' ? source.modelsByTask : {},
    maxInlineChars: positive(source.maxInlineChars, 8000),
    chunkChars: Math.max(500, positive(source.chunkChars, 4000)),
    maxConcurrency: Math.max(1, Math.min(8, positive(source.maxConcurrency, 2))),
    maxSourceChars: positive(source.maxSourceChars, 200000),
    maxBatchFiles: positive(source.maxBatchFiles, 10),
    maxBatchChars: positive(source.maxBatchChars, 120000),
    maxResultChars: positive(source.maxResultChars, 6000),
    maxCallsPerMinute: positive(source.maxCallsPerMinute, 40),
    retries: Math.max(0, Math.min(3, Math.floor(Number(source.retries) || 0))),
    promptHelp: source.promptHelp !== false,
    warmupOnStart: source.warmupOnStart !== false,
    probeAllowPublic: source.probeAllowPublic === true,
    allowOutsideCwd: source.allowOutsideCwd === true,
    allowRoots: Array.isArray(source.allowRoots) ? source.allowRoots.filter((entry) => typeof entry === 'string' && entry.trim()) : [],
    denyGlobs: Array.isArray(source.denyGlobs) ? source.denyGlobs : DEFAULT_DENY_GLOBS,
  }
}

const VOLATILE = Symbol.for('cosmokit.volatile.write')

/** Recursively read volatile references into plain JSON-shaped values. */
export function unwrapVolatile(value) {
  if (value === null || typeof value !== 'object') return value
  if (VOLATILE in value && typeof value.get === 'function') return unwrapVolatile(value.get())
  if (Array.isArray(value)) return value.map(unwrapVolatile)
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrapVolatile(child)]))
}

/** Read the current live configuration from the raw (ref-bearing) config object. */
export function readConfig(rawConfig) {
  return normalizeConfig(unwrapVolatile(rawConfig))
}

export function configWarnings(config) {
  const warnings = []
  if (!config.endpoint.model) {
    warnings.push('endpoint.model is empty: local_* tools fail until it is set (for example "gemma4:e2b") in the local-delegate config row')
  }
  if (!/^https?:\/\//i.test(config.endpoint.baseURL)) {
    warnings.push(`endpoint.baseURL should start with http:// or https:// (got ${JSON.stringify(config.endpoint.baseURL)})`)
  }
  for (const [index, fallback] of config.fallbackEndpoints.entries()) {
    if (!fallback.baseURL) warnings.push(`fallbackEndpoints[${index}].baseURL is empty`)
    if (!fallback.model && !config.endpoint.model) warnings.push(`fallbackEndpoints[${index}].model is empty and no primary model is configured`)
  }
  if (config.chunkChars > config.maxSourceChars) warnings.push('chunkChars is larger than maxSourceChars; long files will be rejected before chunking')
  return warnings
}

/** Stable one-line description used by logs, the GUI status card, and health output. */
export function endpointSummaryText(config) {
  const model = config.endpoint.model || '(unset)'
  return `${config.endpoint.kind} ${config.endpoint.baseURL} model=${model}`
}

/** Primary endpoint followed by every fallback, in attempt order. */
export function endpointChain(config) {
  return [config.endpoint, ...config.fallbackEndpoints]
}

/** Resolve the model for one task: per-task override, then endpoint model, then primary model. */
export function modelForEndpoint(config, endpoint, task) {
  const override = config.modelsByTask?.[task]
  const primary = typeof override === 'string' && override.trim() ? override.trim() : String(config.endpoint.model || '').trim()
  const model = String(endpoint.model || primary || '').trim()
  if (!model) {
    throw new Error(
      'LOCAL_MODEL_UNSET: set endpoint.model (for example "gemma4:e2b") in the local-delegate plugin config, then run local_health',
    )
  }
  return model
}

/** JSON-safe configuration snapshot for the GUI status route (secrets stay out). */
export function publicConfig(config) {
  return {
    enabled: config.enabled,
    endpoint: {
      kind: config.endpoint.kind,
      baseURL: config.endpoint.baseURL,
      path: config.endpoint.path,
      model: config.endpoint.model,
      apiKeyConfigured: Boolean(config.endpoint.apiKey),
      apiKeyEnv: config.endpoint.apiKeyEnv || '',
      headers: Object.keys(config.endpoint.headers || {}),
      numCtx: config.endpoint.numCtx,
      keepAlive: config.endpoint.keepAlive,
      think: config.endpoint.think,
      reasoningEffort: config.endpoint.reasoningEffort,
      timeoutMs: config.endpoint.timeoutMs,
      temperature: config.endpoint.temperature,
      maxOutputTokens: config.endpoint.maxOutputTokens,
    },
    fallbackEndpoints: config.fallbackEndpoints.map((entry) => ({
      kind: entry.kind,
      baseURL: entry.baseURL,
      model: entry.model,
      timeoutMs: entry.timeoutMs,
    })),
    modelsByTask: config.modelsByTask,
    retries: config.retries,
    maxInlineChars: config.maxInlineChars,
    chunkChars: config.chunkChars,
    maxConcurrency: config.maxConcurrency,
    maxSourceChars: config.maxSourceChars,
    maxBatchFiles: config.maxBatchFiles,
    maxBatchChars: config.maxBatchChars,
    maxResultChars: config.maxResultChars,
    maxCallsPerMinute: config.maxCallsPerMinute,
    promptHelp: config.promptHelp,
    warmupOnStart: config.warmupOnStart,
    probeAllowPublic: config.probeAllowPublic,
    allowOutsideCwd: config.allowOutsideCwd,
    allowRoots: config.allowRoots,
    denyGlobs: config.denyGlobs,
  }
}
