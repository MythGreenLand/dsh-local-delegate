/**
 * Same-origin HTTP API for the GUI configuration page.
 *
 * Routes (mounted by index.js under /api/local-delegate):
 *   GET  /status  – version, redacted live config, endpoint health, stats
 *   GET  /levels  – intervention levels per workspace + slave-team node summary
 *   GET  /slaves  – auto-detected LLM routes/models and the resolved slave pool
 *   POST /probe   – probe the saved endpoint or a draft candidate + list models
 *   GET  /models  – list models the saved endpoint advertises
 *
 * Every request passes lib/trust.js first; probe targets are restricted to
 * loopback/private hosts unless probeAllowPublic is enabled.
 */
import { probeEndpoint, endpointLabel } from './endpoint.js'
import { normalizeEndpoint, publicConfig } from './config.js'
import { LEVELS, findLevelKey, resolveLevel } from './levels.js'
import { requestRejection } from './trust.js'
import { statsSnapshot } from './stats.js'

const MAX_BODY_BYTES = 64 * 1024
const PROBE_TIMEOUT_MS = 12_000

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body too large')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('request body is not valid JSON')
    error.status = 400
    throw error
  }
}

function isPrivateIPv4(host) {
  const parts = host.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

function isPrivateIPv6(host) {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (value === '::1') return true
  if (/^f[cd][0-9a-f]{2}:/.test(value)) return true
  if (/^fe[89ab][0-9a-f]:/.test(value)) return true
  return false
}

/** Whether a probe target is loopback/private (the only allowed default). */
export function isPrivateProbeHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1') return true
  if (host.includes(':')) return isPrivateIPv6(host)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIPv4(host)
  // Single-label names are LAN hostnames; dotted names must be a known local zone.
  if (!host.includes('.')) return true
  return host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal') || host.endsWith('.home.arpa')
}

/** Validate one probe/draft endpoint and reject unsafe targets. */
function assertProbeAllowed(endpoint, allowPublic) {
  let url
  try {
    url = new URL(endpoint.baseURL)
  } catch {
    throw new Error('endpoint.baseURL is not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('endpoint.baseURL must use http:// or https://')
  if (!allowPublic && !isPrivateProbeHost(url.hostname)) {
    throw new Error(
      'LOCAL_PROBE_BLOCKED: the GUI probe only allows loopback/LAN targets by default. ' +
        'Set probeAllowPublic: true in the local-delegate config to probe public addresses.',
    )
  }
  if (endpoint.kind !== 'ollama-native' && endpoint.kind !== 'openai-compatible') {
    throw new Error('endpoint.kind must be "ollama-native" or "openai-compatible"')
  }
  if (!endpoint.model) throw new Error('endpoint.model is empty')
  return endpoint
}

/** Apply the resolved api key / environment reference to one endpoint copy. */
export function withResolvedKey(endpoint) {
  if (endpoint.apiKey) return endpoint
  const name = String(endpoint.apiKeyEnv || '').trim()
  if (!name) return endpoint
  const value = process.env[name]
  return value ? { ...endpoint, apiKey: value } : endpoint
}

/**
 * Create the prefix-route handler.
 * @param {object} deps
 * @param {() => object} deps.getRuntime live runtime (config/health/stats)
 * @param {() => object|undefined} deps.getConnection connection service lookup
 * @param {() => object} deps.refresh recompute runtime config and return it
 * @param {() => object|undefined} [deps.getWorkspaceRegistry] workspace registry lookup (ctx.get('workspaceRegistry'))
 * @param {() => Promise<object>} [deps.discoverSlaves] auto-detection snapshot (lib/slaves.js discover()).
 * @param {() => Promise<object>} [deps.refreshHealth] probe the endpoint chain (index.js refreshHealth()).
 * @param {string} deps.version plugin version
 * @param {(level: string, message: string) => void} deps.log logger
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApiHandler({ getRuntime, getConnection, getWorkspaceRegistry, discoverSlaves, refresh, refreshHealth, version, log }) {
  return async function handler(req, res) {
    try {
      const rejection = requestRejection(req, getConnection())
      if (rejection !== undefined) {
        json(res, rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : rejection === 503 ? 'admission unavailable' : 'forbidden' })
        return
      }
      const url = new URL(req.url, 'http://localhost')
      const route = url.pathname.replace(/^\/api\/local-delegate\/?/, '').replace(/\/+$/, '')
      const runtime = getRuntime()

      if (route === '' || route === 'status') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        // Normal page loads read the cached probe result. `?probe=1` (the
        // HealthCard refresh button) re-probes every endpoint, including all
        // fallbacks, so their online/offline state is current.
        if (url.searchParams.get('probe') === '1' && typeof refreshHealth === 'function') {
          await refreshHealth()
        }
        const config = refresh()
        return json(res, 200, {
          ok: true,
          version,
          config: publicConfig(config),
          health: healthView(runtime.health),
          stats: statsSnapshot(runtime.stats),
        })
      }

      if (route === 'levels') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        const config = refresh()
        const registryView = workspaceRegistryView(config, getWorkspaceRegistry)
        return json(res, 200, {
          ok: true,
          version,
          levels: [...LEVELS],
          levelsEnabled: config.levelsEnabled !== false,
          defaultLevel: config.defaultLevel,
          workspaces: registryView.workspaces,
          slaveTeam: slaveTeamView(config),
          ...(registryView.unavailable ? { unavailable: registryView.unavailable } : {}),
        })
      }

      if (route === 'slaves') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        refresh()
        let view
        try {
          view = typeof discoverSlaves === 'function' ? await discoverSlaves() : { mode: 'unavailable', nodes: [], issues: ['discovery is unavailable'] }
        } catch (error) {
          view = { mode: 'error', nodes: [], issues: [`discovery failed: ${String(error?.message ?? error).slice(0, 200)}`] }
        }
        return json(res, 200, { ok: true, version, ...view })
      }

      if (route === 'models') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        const config = refresh()
        const endpoint = withResolvedKey(config.endpoint)
        const result = await probeWithTimeout(endpoint, endpoint.model || '')
        return json(res, 200, {
          ok: result.ok,
          models: result.models || [],
          error: result.error || null,
          latencyMs: result.latencyMs,
        })
      }

      if (route === 'probe') {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
        const body = await readJsonBody(req)
        const config = refresh()
        const candidate = body && typeof body.endpoint === 'object' && body.endpoint !== null
          ? normalizeEndpoint({ ...config.endpoint, ...body.endpoint })
          : config.endpoint
        assertProbeAllowed(candidate, config.probeAllowPublic)
        const result = await probeWithTimeout(withResolvedKey(candidate), candidate.model)
        return json(res, 200, {
          ok: result.ok,
          latencyMs: result.latencyMs,
          modelFound: result.modelFound,
          models: (result.models || []).slice(0, 60),
          error: result.error || null,
          endpoint: endpointLabel(candidate, candidate.model),
        })
      }

      return json(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      const status = Number(error?.status) || 400
      log?.('warn', `settings API: ${String(error?.message ?? error).slice(0, 240)}`)
      json(res, status, { ok: false, error: String(error?.message ?? error).slice(0, 300) })
    }
  }
}

/** Resolve the optional workspace registry without ever throwing. */
function lookupWorkspaceRegistry(getWorkspaceRegistry) {
  const unavailable = 'workspaceRegistry is not mounted; workspace levels cannot be listed'
  if (typeof getWorkspaceRegistry !== 'function') return { registry: undefined, unavailable }
  let registry
  try {
    registry = getWorkspaceRegistry()
  } catch (error) {
    return { registry: undefined, unavailable: `workspaceRegistry lookup failed: ${String(error?.message ?? error).slice(0, 200)}` }
  }
  if (!registry || typeof registry.list !== 'function') return { registry: undefined, unavailable }
  return { registry, unavailable: undefined }
}

/** Build the per-workspace level view for GET /levels (empty + unavailable when unmounted). */
function workspaceRegistryView(config, getWorkspaceRegistry) {
  const { registry, unavailable } = lookupWorkspaceRegistry(getWorkspaceRegistry)
  if (!registry) return { workspaces: [], unavailable }
  let entities
  try {
    entities = registry.list()
  } catch (error) {
    return { workspaces: [], unavailable: `workspaceRegistry.list() failed: ${String(error?.message ?? error).slice(0, 200)}` }
  }
  if (!Array.isArray(entities)) return { workspaces: [], unavailable: 'workspaceRegistry.list() did not return an array' }
  const workspaces = entities
    .filter((entity) => entity && typeof entity === 'object')
    .map((entity, index) => {
      const workspacePath = typeof entity.path === 'string' ? entity.path : ''
      const key = config.levelsEnabled !== false ? findLevelKey(config.workspaceLevels, workspacePath) : null
      const title = typeof entity.title === 'string' && entity.title.trim() !== '' ? entity.title.trim() : (workspacePath || `Workspace ${index + 1}`)
      return {
        id: typeof entity.id === 'string' ? entity.id : String(entity.id ?? ''),
        title,
        path: workspacePath,
        level: resolveLevel(config, workspacePath),
        source: key === null ? 'default' : 'override',
      }
    })
  return { workspaces, unavailable: undefined }
}

function slaveTeamNode(node) {
  return {
    name: typeof node?.name === 'string' ? node.name : '',
    kind: node?.kind === 'cloud' ? 'cloud' : 'local',
    provider: typeof node?.provider === 'string' ? node.provider : '',
    model: typeof node?.model === 'string' ? node.model : '',
  }
}

/** Stable, JSON-safe SlaveAgentTeams summary for GET /levels. */
function slaveTeamView(config) {
  const explicit = Array.isArray(config.slaveNodes) ? config.slaveNodes : []
  const hasExplicit = explicit.length > 0
  const nodes = hasExplicit
    ? explicit.map(slaveTeamNode)
    : [slaveTeamNode({
        name: 'local',
        kind: 'local',
        provider: config.workerRouteProvider || 'local-delegate',
        model: config.workerRouteModel || config.endpoint?.model || '',
      })]
  const issues = []
  const seen = new Set()
  for (const [index, node] of nodes.entries()) {
    if (!node.name) {
      if (hasExplicit) issues.push(`slaveNodes[${index}] has an empty name`)
      continue
    }
    if (seen.has(node.name)) {
      issues.push(`duplicate slave node name "${node.name}"`)
      continue
    }
    seen.add(node.name)
    if (hasExplicit && !node.model) issues.push(`slave node "${node.name}" has an empty model and cannot be used`)
  }
  const defaultNode = config.slaveTeamDefaultNode || ''
  if (defaultNode && !seen.has(defaultNode)) issues.push(`slaveTeamDefaultNode "${defaultNode}" is not in the node pool`)
  if (config.slaveTeamsEnabled === true && nodes.every((node) => !node.provider || !node.model)) {
    issues.push('no usable slave node: set slaveNodes[].model or endpoint.model')
  }
  return {
    enabled: config.slaveTeamsEnabled === true,
    mode: hasExplicit ? 'explicit' : config.slaveTeamAutoDiscover !== false ? 'auto' : 'implicit',
    autoDiscover: config.slaveTeamAutoDiscover !== false,
    defaultNode,
    maxSlaves: config.slaveTeamMaxSlaves,
    nodes,
    issues,
  }
}

async function probeWithTimeout(endpoint, model) {
  const timeoutMs = Math.min(PROBE_TIMEOUT_MS, Math.max(1_000, Number(endpoint.timeoutMs) || PROBE_TIMEOUT_MS))
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, latencyMs: timeoutMs, modelFound: false, models: [], error: `probe timed out after ${timeoutMs}ms` }), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([probeEndpoint({ endpoint, model }), timeout])
  } finally {
    clearTimeout(timer)
  }
}

function healthView(health) {
  if (!health) return { status: 'unknown', checkedAt: 0 }
  const summarize = (entry) =>
    entry && entry.endpoint
      ? {
          kind: entry.endpoint.kind,
          baseURL: entry.endpoint.baseURL,
          model: entry.model || entry.endpoint.model || '',
          reachable: entry.probe?.ok === true,
          modelFound: entry.probe?.modelFound === true,
          latencyMs: entry.probe?.latencyMs ?? null,
          error: entry.probe?.error ?? null,
        }
      : null
  return {
    status: health.status,
    checkedAt: health.checkedAt,
    primary: summarize(health.primary),
    fallbacks: (health.fallbacks ?? []).map(summarize),
    effective: summarize(health.effective),
    error: health.error ?? null,
  }
}
