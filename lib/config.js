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

/** Local-AI intervention levels, ordered from least to most involvement. */
export const LEVEL_VALUES = ['none', 'light', 'default', 'high', 'max']

/** One SlaveAgentTeams node: an LLM route (local provider/model or cloud route). */
export const SlaveNodeSchema = z.object({
  name: z.string().default(''),
  kind: z.union(['local', 'cloud']).default('local'),
  provider: z.string().default('local-delegate'),
  model: z.string().default(''),
  note: z.string().default(''),
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

  // Local-AI intervention levels (v0.4). Defaults keep v0.3 behavior: level
  // "default" installs no scoped policy, and slave teams start disabled.
  levelsEnabled: z.boolean().default(true).volatile(),
  defaultLevel: z.union(LEVEL_VALUES).default('default').volatile(),
  workspaceLevels: z.dict(z.union(LEVEL_VALUES)).default({}).volatile(),
  workerProvider: z.string().default('spawn').volatile(),
  workerPreset: z.string().default('standard').volatile(),
  workerRouteProvider: z.string().default('local-delegate').volatile(),
  workerRouteModel: z.string().default('').volatile(),
  workerMaxDepth: z.number().default(1).volatile(),
  lightMinChars: z.number().default(8000).volatile(),
  lightMinFiles: z.number().default(3).volatile(),
  highMinChars: z.number().default(2000).volatile(),
  plannerAllowRead: z.boolean().default(true).volatile(),
  plannerFallback: z.union(['strong-worker', 'fail']).default('strong-worker').volatile(),
  plannerDenyExtra: z.array(z.string()).default([]).volatile(),
  plannerAllowExtra: z.array(z.string()).default([]).volatile(),
  applyToLiveAgents: z.boolean().default(false).volatile(),
  // Show the quick level picker inside the conversation composer tool row.
  composerLevelPicker: z.boolean().default(true).volatile(),

  // SlaveAgentTeams (parallel slave nodes).
  slaveTeamsEnabled: z.boolean().default(false).volatile(),
  slaveTeamAutoDiscover: z.boolean().default(true).volatile(),
  slaveNodes: z.array(SlaveNodeSchema).default([]).volatile(),
  slaveTeamDefaultNode: z.string().default('').volatile(),
  slaveTeamProvider: z.string().default('spawn').volatile(),
  slaveTeamPreset: z.string().default('standard').volatile(),
  slaveTeamMaxSlaves: z.number().default(4).volatile(),
  slaveTeamMaxDepth: z.number().default(1).volatile(),
  slaveTeamFallback: z.union(['inherit', 'fail']).default('inherit').volatile(),
  slaveTeamPromptHelp: z.boolean().default(true).volatile(),

  allowOutsideCwd: z.boolean().default(false),
  allowRoots: z.array(z.string()).default([]),
  denyGlobs: z.array(z.string()).default(DEFAULT_DENY_GLOBS),
})

function positive(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.max(1, Math.floor(number)) : fallback
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

function stringValue(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
}

function levelValue(value, fallback) {
  return typeof value === 'string' && LEVEL_VALUES.includes(value) ? value : fallback
}

/** Normalize one SlaveAgentTeams node; never throws (GUI drafts may be partial). */
export function normalizeSlaveNode(source) {
  const raw = source && typeof source === 'object' ? source : {}
  return {
    name: typeof raw.name === 'string' ? raw.name.trim() : '',
    kind: raw.kind === 'cloud' ? 'cloud' : 'local',
    provider: stringValue(raw.provider, 'local-delegate'),
    model: typeof raw.model === 'string' ? raw.model.trim() : '',
    note: typeof raw.note === 'string' ? raw.note.trim() : '',
  }
}

function normalizeWorkspaceLevels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const levels = {}
  for (const [key, level] of Object.entries(value)) {
    if (typeof key !== 'string' || key.trim() === '') continue
    if (typeof level === 'string' && LEVEL_VALUES.includes(level)) levels[key] = level
  }
  return levels
}

function boundedNumber(value, fallback, min, max, { integer = false, missingAtOrBelow } = {}) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  if (missingAtOrBelow !== undefined && number <= missingAtOrBelow) return fallback
  const clamped = Math.min(max, Math.max(min, number))
  return integer ? Math.floor(clamped) : clamped
}

export function normalizeEndpoint(source) {
  const raw = source && typeof source === 'object' ? source : {}
  const merged = {
    ...DEFAULT_ENDPOINT,
    ...raw,
    headers: { ...DEFAULT_ENDPOINT.headers, ...(raw.headers ?? {}) },
  }
  // A GUI empty NumberInput becomes 0; 0 must never reach the wire protocol
  // (timeoutMs 0 would abort every request after 1ms, maxOutputTokens 0 would
  // request zero output tokens). Clamp both GUI and YAML input here.
  return {
    ...merged,
    numCtx: boundedNumber(merged.numCtx, DEFAULT_ENDPOINT.numCtx, 512, 1_048_576, { integer: true, missingAtOrBelow: 0 }),
    timeoutMs: boundedNumber(merged.timeoutMs, DEFAULT_ENDPOINT.timeoutMs, 1_000, 3_600_000, { integer: true, missingAtOrBelow: 0 }),
    maxOutputTokens: boundedNumber(merged.maxOutputTokens, DEFAULT_ENDPOINT.maxOutputTokens, 1, 1_000_000, {
      integer: true,
      missingAtOrBelow: 0,
    }),
    temperature: boundedNumber(merged.temperature, DEFAULT_ENDPOINT.temperature, 0, 2),
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
    throw new Error('local-delegate: endpoint.baseURL must be a non-empty string (for example http://127.0.0.1:11434)')
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
    levelsEnabled: source.levelsEnabled !== false,
    defaultLevel: levelValue(source.defaultLevel, 'default'),
    workspaceLevels: normalizeWorkspaceLevels(source.workspaceLevels),
    workerProvider: stringValue(source.workerProvider, 'spawn'),
    workerPreset: stringValue(source.workerPreset, 'standard'),
    workerRouteProvider: stringValue(source.workerRouteProvider, 'local-delegate'),
    workerRouteModel: typeof source.workerRouteModel === 'string' ? source.workerRouteModel.trim() : '',
    workerMaxDepth: clampInteger(source.workerMaxDepth, 1, 1, 5),
    lightMinChars: positiveInteger(source.lightMinChars, 8000),
    lightMinFiles: positiveInteger(source.lightMinFiles, 3),
    highMinChars: positiveInteger(source.highMinChars, 2000),
    plannerAllowRead: source.plannerAllowRead !== false,
    plannerFallback: source.plannerFallback === 'fail' ? 'fail' : 'strong-worker',
    plannerDenyExtra: stringList(source.plannerDenyExtra),
    plannerAllowExtra: stringList(source.plannerAllowExtra),
    applyToLiveAgents: source.applyToLiveAgents === true,
    composerLevelPicker: source.composerLevelPicker !== false,
    slaveTeamsEnabled: source.slaveTeamsEnabled === true,
    slaveTeamAutoDiscover: source.slaveTeamAutoDiscover !== false,
    slaveNodes: Array.isArray(source.slaveNodes)
      ? source.slaveNodes.filter((entry) => entry && typeof entry === 'object').map(normalizeSlaveNode)
      : [],
    slaveTeamDefaultNode: typeof source.slaveTeamDefaultNode === 'string' ? source.slaveTeamDefaultNode.trim() : '',
    slaveTeamProvider: stringValue(source.slaveTeamProvider, 'spawn'),
    slaveTeamPreset: stringValue(source.slaveTeamPreset, 'standard'),
    slaveTeamMaxSlaves: clampInteger(source.slaveTeamMaxSlaves, 4, 1, 8),
    slaveTeamMaxDepth: clampInteger(source.slaveTeamMaxDepth, 1, 1, 5),
    slaveTeamFallback: source.slaveTeamFallback === 'fail' ? 'fail' : 'inherit',
    slaveTeamPromptHelp: source.slaveTeamPromptHelp !== false,
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

  // Level / SlaveAgentTeams warnings (v0.4).
  if (config.levelsEnabled) {
    const seen = new Map()
    for (const key of Object.keys(config.workspaceLevels ?? {})) {
      if (!isAbsoluteWorkspacePath(key)) {
        warnings.push(`workspaceLevels key ${JSON.stringify(key)} is not an absolute workspace path; the override will never match and the default level is used`)
        continue
      }
      const comparable = key.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      if (seen.has(comparable)) {
        warnings.push(`workspaceLevels has multiple keys for the same workspace (${JSON.stringify(seen.get(comparable))} and ${JSON.stringify(key)}); only one override can apply`)
      } else {
        seen.set(comparable, key)
      }
    }
  }
  const slaveNodes = Array.isArray(config.slaveNodes) ? config.slaveNodes : []
  if (config.slaveTeamsEnabled) {
    const explicitPool = slaveNodes.filter((node) => node && node.provider && node.model)
    const implicitModel = config.workerRouteModel || config.endpoint.model
    const implicitPool = slaveNodes.length === 0 && config.workerRouteProvider && implicitModel
    if (slaveNodes.length > 0 && explicitPool.length === 0) {
      warnings.push('slaveTeamsEnabled is on but none of the configured slaveNodes has both a provider and a model')
    } else if (slaveNodes.length === 0 && config.slaveTeamAutoDiscover === false && !implicitPool) {
      warnings.push(
        'slaveTeamsEnabled is on, automatic discovery is off, and no usable slave node is available: set slaveNodes[].model (and provider) or endpoint.model',
      )
    }
  }
  const autoPool = slaveNodes.length === 0 && config.slaveTeamAutoDiscover !== false
  const nodeNames = slaveNodes.length === 0 ? ['local'] : slaveNodes.map((node) => node?.name).filter(Boolean)
  if (!autoPool && config.slaveTeamDefaultNode && !nodeNames.includes(config.slaveTeamDefaultNode)) {
    warnings.push(`slaveTeamDefaultNode ${JSON.stringify(config.slaveTeamDefaultNode)} is not in the slave node pool (${nodeNames.length > 0 ? nodeNames.map((name) => JSON.stringify(name)).join(', ') : 'empty'})`)
  }
  const nameCounts = new Map()
  for (const name of slaveNodes.map((node) => node?.name).filter(Boolean)) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
  for (const [name, count] of nameCounts) {
    if (count > 1) warnings.push(`slaveNodes has ${count} nodes named ${JSON.stringify(name)}; duplicate names are ambiguous`)
  }
  return warnings
}

function isAbsoluteWorkspacePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  const candidate = value.trim()
  return /^[a-zA-Z]:[\\/]/.test(candidate) || /^\\\\[^\\]/.test(candidate) || candidate.startsWith('/')
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
  const perTask = typeof override === 'string' && override.trim() ? override.trim() : ''
  const model = String(perTask || endpoint.model || config.endpoint.model || '').trim()
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
    levelsEnabled: config.levelsEnabled,
    defaultLevel: config.defaultLevel,
    workspaceLevels: { ...(config.workspaceLevels ?? {}) },
    workerProvider: config.workerProvider,
    workerPreset: config.workerPreset,
    workerRouteProvider: config.workerRouteProvider,
    workerRouteModel: config.workerRouteModel,
    workerMaxDepth: config.workerMaxDepth,
    lightMinChars: config.lightMinChars,
    lightMinFiles: config.lightMinFiles,
    highMinChars: config.highMinChars,
    plannerAllowRead: config.plannerAllowRead,
    plannerFallback: config.plannerFallback,
    plannerDenyExtra: [...(config.plannerDenyExtra ?? [])],
    plannerAllowExtra: [...(config.plannerAllowExtra ?? [])],
    applyToLiveAgents: config.applyToLiveAgents,
    composerLevelPicker: config.composerLevelPicker !== false,
    slaveTeamsEnabled: config.slaveTeamsEnabled,
    slaveTeamAutoDiscover: config.slaveTeamAutoDiscover !== false,
    slaveNodes: (config.slaveNodes ?? []).map((node) => ({
      name: node.name,
      kind: node.kind,
      provider: node.provider,
      model: node.model,
      note: node.note,
    })),
    slaveTeamDefaultNode: config.slaveTeamDefaultNode,
    slaveTeamProvider: config.slaveTeamProvider,
    slaveTeamPreset: config.slaveTeamPreset,
    slaveTeamMaxSlaves: config.slaveTeamMaxSlaves,
    slaveTeamMaxDepth: config.slaveTeamMaxDepth,
    slaveTeamFallback: config.slaveTeamFallback,
    slaveTeamPromptHelp: config.slaveTeamPromptHelp,
    allowOutsideCwd: config.allowOutsideCwd,
    allowRoots: config.allowRoots,
    denyGlobs: config.denyGlobs,
  }
}
