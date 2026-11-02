/**
 * Endpoint client for dsh-local-delegate.
 *
 * Speaks two wire protocols out of one config surface:
 *  - `ollama-native`:      POST {baseURL}/api/chat        (think / keep_alive / num_ctx / num_predict)
 *  - `openai-compatible`:  POST {baseURL}/v1/chat/completions (any OpenAI-compatible gateway)
 *
 * Nothing here logs request or response bodies; callers own payload policy.
 */

const DEFAULT_PATHS = Object.freeze({
  'ollama-native': '/api/chat',
  'openai-compatible': '/v1/chat/completions',
})

/** Join a base URL and an absolute endpoint path without doubling slashes. */
export function joinURL(baseURL, suffix) {
  const base = String(baseURL || '').replace(/\/+$/, '')
  const rest = String(suffix || '')
  return rest.startsWith('/') ? base + rest : base + '/' + rest
}

/**
 * Resolve the OpenAI-compatible chat path against the two conventional base URL
 * shapes: `http://host:port` (append `/v1/chat/completions`) and
 * `http://host:port/v1` (append `/chat/completions`).
 */
function openaiPath(baseURL) {
  const base = String(baseURL || '').replace(/\/+$/, '')
  return /\/v\d+$/.test(base) ? '/chat/completions' : '/v1/chat/completions'
}

function openaiModelsPath(baseURL) {
  const base = String(baseURL || '').replace(/\/+$/, '')
  return /\/v\d+$/.test(base) ? '/models' : '/v1/models'
}

/** Resolve the effective protocol and chat path for one endpoint config. */
export function endpointTarget(endpoint) {
  const kind = endpoint.kind === 'openai-compatible' ? 'openai-compatible' : 'ollama-native'
  const explicit = endpoint.path && endpoint.path.trim() ? endpoint.path.trim() : ''
  if (explicit) return { kind, url: joinURL(endpoint.baseURL, explicit) }
  if (kind === 'ollama-native') return { kind, url: joinURL(endpoint.baseURL, DEFAULT_PATHS['ollama-native']) }
  const base = String(endpoint.baseURL || '').replace(/\/+$/, '')
  return { kind, url: base + openaiPath(base) }
}

/** Combined caller signal + deadline without nesting AbortSignal.any incidents. */
function deadlineSignal(signal, timeoutMs) {
  const controller = new AbortController()
  const forward = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', forward, { once: true })
  }
  const timer = setTimeout(() => {
    const error = new Error(`local model request timed out after ${timeoutMs}ms`)
    error.code = 'LOCAL_TIMEOUT'
    controller.abort(error)
  }, Math.max(1, timeoutMs))
  timer.unref?.()
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forward)
    },
  }
}

function abortReason(signal) {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  const error = new Error(typeof reason === 'string' && reason ? reason : 'request aborted')
  error.code = 'LOCAL_ABORTED'
  return error
}

async function readJson(response) {
  const text = await response.text()
  try {
    return { json: JSON.parse(text), text }
  } catch {
    return { json: undefined, text }
  }
}

function firstText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('')
  }
  return ''
}

/**
 * One non-streaming completion.
 * @param {object} request
 * @param {object} request.endpoint resolved endpoint config.
 * @param {string} request.model exact model id.
 * @param {string} request.system system instruction.
 * @param {string} request.user user payload.
 * @param {number} [request.maxOutputTokens] per-call output cap.
 * @param {AbortSignal} [request.signal] caller cancellation.
 * @returns {Promise<{text:string, promptTokens:number, completionTokens:number, durationMs:number}>}
 */
export async function callModel({ endpoint, model, system, user, maxOutputTokens, signal }) {
  const { kind, url } = endpointTarget(endpoint)
  const held = deadlineSignal(signal, endpoint.timeoutMs)
  const started = Date.now()
  try {
    const headers = { 'content-type': 'application/json', ...(endpoint.headers || {}) }
    if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`

    let body
    if (kind === 'ollama-native') {
      body = {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
        think: endpoint.think === true,
        keep_alive: endpoint.keepAlive,
        options: {
          num_ctx: endpoint.numCtx,
          num_predict: maxOutputTokens ?? endpoint.maxOutputTokens,
          temperature: endpoint.temperature,
        },
      }
    } else {
      body = {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
        max_tokens: maxOutputTokens ?? endpoint.maxOutputTokens,
        temperature: endpoint.temperature,
      }
      // Thinking-capable OpenAI-compatible servers (e.g. Ollama's /v1) spend the
      // whole max_tokens budget on reasoning and return empty content unless
      // reasoning is explicitly disabled.
      if (endpoint.think !== true && endpoint.reasoningEffort) {
        body.reasoning_effort = endpoint.reasoningEffort
      }
    }

    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: held.signal,
      })
    } catch (error) {
      if (held.signal.aborted) throw abortReason(held.signal)
      throw new Error(`local model request failed: ${error?.message ?? error}`)
    }

    const { json, text } = await readJson(response)
    if (!response.ok) {
      throw new Error(`local model HTTP ${response.status}: ${text.slice(0, 300)}`)
    }
    if (!json) throw new Error(`local model returned non-JSON body: ${text.slice(0, 200)}`)

    let content
    let promptTokens = 0
    let completionTokens = 0
    if (kind === 'ollama-native') {
      content = firstText(json.message?.content)
      promptTokens = Number(json.prompt_eval_count) || 0
      completionTokens = Number(json.eval_count) || 0
    } else {
      content = firstText(json.choices?.[0]?.message?.content)
      promptTokens = Number(json.usage?.prompt_tokens) || 0
      completionTokens = Number(json.usage?.completion_tokens) || 0
    }

    if (!content || !content.trim()) {
      throw new Error(
        'local model returned empty content (a thinking model may have spent the whole output budget on reasoning; ' +
          'set endpoint.think=false for Ollama-native, or endpoint.reasoningEffort="none" for OpenAI-compatible)',
      )
    }

    return { text: content, promptTokens, completionTokens, durationMs: Date.now() - started }
  } finally {
    held.dispose()
  }
}

/**
 * Probe reachability and model availability without generating tokens.
 * @param {object} request
 * @param {object} request.endpoint resolved endpoint config.
 * @param {string} request.model exact model id.
 * @returns {Promise<{ok:boolean, latencyMs:number, modelFound:boolean, models:string[], error?:string}>}
 */
export async function probeEndpoint({ endpoint, model }) {
  const { kind } = endpointTarget(endpoint)
  const base = String(endpoint.baseURL || '').replace(/\/+$/, '')
  const url =
    kind === 'ollama-native'
      ? joinURL(endpoint.baseURL, '/api/tags')
      : base + openaiModelsPath(base)
  const held = deadlineSignal(undefined, Math.min(10000, endpoint.timeoutMs || 10000))
  const started = Date.now()
  try {
    const headers = { ...(endpoint.headers || {}) }
    if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`
    const response = await fetch(url, { headers, signal: held.signal })
    const { json, text } = await readJson(response)
    if (!response.ok) {
      return { ok: false, latencyMs: Date.now() - started, modelFound: false, models: [], error: `HTTP ${response.status}: ${text.slice(0, 160)}` }
    }
    let models = []
    if (Array.isArray(json?.models)) models = json.models.map((entry) => entry?.name).filter((name) => typeof name === 'string')
    else if (Array.isArray(json?.data)) models = json.data.map((entry) => entry?.id).filter((id) => typeof id === 'string')
    const wanted = String(model || '')
    const modelFound = wanted.length > 0 && models.some((name) => name === wanted || name.startsWith(wanted))
    return { ok: true, latencyMs: Date.now() - started, modelFound, models: models.slice(0, 30) }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      modelFound: false,
      models: [],
      error: held.signal.aborted ? 'probe timed out' : String(error?.message ?? error),
    }
  } finally {
    held.dispose()
  }
}

/** Whether a failed request is worth one more attempt on the same endpoint. */
export function isRetryableEndpointError(error) {
  const message = String(error?.message ?? error)
  if (/\bHTTP 4\d\d\b/.test(message) && !/\bHTTP 429\b/.test(message)) return false
  return /failed|timed out|aborted|HTTP 429|HTTP 5\d\d|ECONNREFUSED|ENOTFOUND|fetch failed|socket|network/i.test(message)
}

/** Short human label used in receipts, diagnostics, and logs. */
export function endpointLabel(endpoint, model) {
  const host = (() => {
    try {
      return new URL(endpoint.baseURL).host
    } catch {
      return String(endpoint.baseURL || 'unknown')
    }
  })()
  const target = model || endpoint.model || ''
  return `${endpoint.kind === 'openai-compatible' ? 'openai' : 'ollama'}://${host}${target ? `/${target}` : ''}`
}

