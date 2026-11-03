/**
 * In-memory delegation statistics. Counters reset when the plugin reloads;
 * they exist to answer "is this saving tokens", not to be an accounting ledger.
 */

/** Create one fresh counter set. */
export function createStats() {
  return {
    startedAt: Date.now(),
    calls: 0,
    chunkCalls: 0,
    failed: 0,
    charsIn: 0,
    charsOut: 0,
    localPromptTokens: 0,
    localCompletionTokens: 0,
    byTask: Object.create(null),
    byEndpoint: Object.create(null),
    lastError: null,
    // v0.4: worker (local_worker) and SlaveAgentTeams counters. Purely
    // additive; the v0.3 fields above keep their exact meaning.
    workersStarted: 0,
    workersFailed: 0,
    slavesStarted: 0,
    slavesSettled: 0,
    slavesFailed: 0,
    byNode: Object.create(null),
  }
}

function taskBucket(stats, task) {
  const key = String(task || 'unknown')
  if (!stats.byTask[key]) {
    stats.byTask[key] = { calls: 0, chunkCalls: 0, charsIn: 0, charsOut: 0 }
  }
  return stats.byTask[key]
}

/** Record one successful transform/batch call. */
export function recordSuccess(stats, { task, charsIn, charsOut, chunkCalls, promptTokens, completionTokens, endpoint }) {
  stats.calls += 1
  stats.chunkCalls += chunkCalls
  stats.charsIn += charsIn
  stats.charsOut += charsOut
  stats.localPromptTokens += promptTokens
  stats.localCompletionTokens += completionTokens
  const bucket = taskBucket(stats, task)
  bucket.calls += 1
  bucket.chunkCalls += chunkCalls
  bucket.charsIn += charsIn
  bucket.charsOut += charsOut
  if (endpoint) {
    const key = String(endpoint)
    stats.byEndpoint[key] = (stats.byEndpoint[key] ?? 0) + 1
  }
}

/** Record one failed call so `/localstats` can show degradation. */
export function recordFailure(stats, task, message) {
  stats.failed += 1
  stats.lastError = `${task || 'unknown'}: ${String(message ?? '').slice(0, 200)}`
}

/**
 * v0.4 counters may be missing on a stats object created before this version
 * (or synthesized by a test/mock), so every recorder tolerates that shape and
 * fills the fields in place instead of throwing mid-delegation.
 */
function mutableStats(stats) {
  if (!stats || typeof stats !== 'object') return null
  if (typeof stats.workersStarted !== 'number') stats.workersStarted = 0
  if (typeof stats.workersFailed !== 'number') stats.workersFailed = 0
  if (typeof stats.slavesStarted !== 'number') stats.slavesStarted = 0
  if (typeof stats.slavesSettled !== 'number') stats.slavesSettled = 0
  if (typeof stats.slavesFailed !== 'number') stats.slavesFailed = 0
  if (!stats.byNode || typeof stats.byNode !== 'object') stats.byNode = Object.create(null)
  return stats
}

/** One per-node bucket keyed by node name (falls back to its provider). */
function nodeBucket(stats, node) {
  const name =
    typeof node === 'string'
      ? node
      : String(node?.name || node?.provider || node?.model || 'unknown')
  const key = name.trim() || 'unknown'
  if (!stats.byNode[key]) stats.byNode[key] = { started: 0, settled: 0, failed: 0 }
  return stats.byNode[key]
}

/** Record one local_worker activation start (v0.4). */
export function recordWorkerStart(stats, node) {
  const target = mutableStats(stats)
  if (!target) return
  target.workersStarted += 1
  nodeBucket(target, node).started += 1
}

/** Record one local_worker activation failure (v0.4). */
export function recordWorkerFailure(stats, message) {
  const target = mutableStats(stats)
  if (!target) return
  target.workersFailed += 1
  target.lastError = `worker: ${String(message ?? '').slice(0, 200)}`
}

/** Record one slave activation start (v0.4 SlaveAgentTeams). */
export function recordSlaveStart(stats, node) {
  const target = mutableStats(stats)
  if (!target) return
  target.slavesStarted += 1
  nodeBucket(target, node).started += 1
}

/**
 * Record one slave settlement (v0.4). `slavesSettled` counts every terminal
 * settlement; `slavesFailed` is the failure subset (including start failures
 * recorded through recordSlaveFailure).
 */
export function recordSlaveSettled(stats, { node, ok } = {}) {
  const target = mutableStats(stats)
  if (!target) return
  target.slavesSettled += 1
  const bucket = nodeBucket(target, node)
  bucket.settled += 1
  if (!ok) {
    target.slavesFailed += 1
    bucket.failed += 1
  }
}

/** Record one slave activation that never started (v0.4). */
export function recordSlaveFailure(stats, { node, message } = {}) {
  const target = mutableStats(stats)
  if (!target) return
  target.slavesFailed += 1
  nodeBucket(target, node).failed += 1
  target.lastError = `slave: ${String(message ?? '').slice(0, 200)}`
}

/**
 * Estimated main-model tokens avoided by doing the work locally. The estimate
 * compares "main model reads the source and writes the output" with the two
 * tool-call turns this delegation actually costs.
 */
export function estimatedSavedTokens(stats) {
  const mainModelEquivalent = Math.ceil(stats.charsIn / 3.2) + Math.ceil(stats.charsOut / 3.2)
  const overhead = 450 * stats.calls
  return Math.max(0, Math.round(mainModelEquivalent - overhead))
}

/** JSON-safe stats for the GUI status card. */
export function statsSnapshot(stats) {
  return {
    startedAt: stats.startedAt,
    calls: stats.calls,
    chunkCalls: stats.chunkCalls,
    failed: stats.failed,
    charsIn: stats.charsIn,
    charsOut: stats.charsOut,
    localPromptTokens: stats.localPromptTokens,
    localCompletionTokens: stats.localCompletionTokens,
    estimatedSavedTokens: estimatedSavedTokens(stats),
    byTask: Object.fromEntries(Object.entries(stats.byTask).map(([task, bucket]) => [task, { ...bucket }])),
    byEndpoint: { ...stats.byEndpoint },
    workersStarted: stats.workersStarted ?? 0,
    workersFailed: stats.workersFailed ?? 0,
    slavesStarted: stats.slavesStarted ?? 0,
    slavesSettled: stats.slavesSettled ?? 0,
    slavesFailed: stats.slavesFailed ?? 0,
    byNode: Object.fromEntries(
      Object.entries(stats.byNode ?? {}).map(([node, bucket]) => [node, { ...bucket }]),
    ),
    lastError: stats.lastError,
  }
}

/** Render the `/localstats` report. */
export function renderStats(stats, endpoint, health) {
  const lines = []
  lines.push(`Local delegate: ${endpoint.kind} ${endpoint.baseURL} model=${endpoint.model || '(unset)'}`)
  const status =
    health?.status === 'available'
      ? 'available'
      : health?.status === 'degraded'
        ? `degraded (primary unavailable; fallback ${health.effective?.baseURL ?? 'unknown'} is available)`
        : health?.status === 'unavailable'
          ? `unavailable (${health.primary?.error ?? health.error ?? 'probe failed'})`
          : 'not probed'
  lines.push(`Endpoint: ${status}`)
  lines.push(
    `Calls: ${stats.calls} ok, ${stats.failed} failed, ${stats.chunkCalls} model requests` +
      (stats.calls + stats.failed > 0
        ? `; local tokens: prompt ${stats.localPromptTokens}, completion ${stats.localCompletionTokens}`
        : ''),
  )
  lines.push(`Text processed locally: in ${stats.charsIn} chars, out ${stats.charsOut} chars`)
  lines.push(`Estimated main-model tokens avoided: ~${estimatedSavedTokens(stats)}`)
  const endpoints = Object.keys(stats.byEndpoint)
  if (endpoints.length > 0) {
    lines.push('Endpoint usage:')
    for (const key of endpoints.sort()) lines.push(`  - ${key}: ${stats.byEndpoint[key]} call(s)`)
  }
  const tasks = Object.keys(stats.byTask)
  if (tasks.length > 0) {
    lines.push('By task:')
    for (const task of tasks.sort()) {
      const bucket = stats.byTask[task]
      lines.push(`  - ${task}: ${bucket.calls} calls, ${bucket.chunkCalls} requests, ${bucket.charsIn} chars in`)
    }
  }
  if (stats.lastError) lines.push(`Last error: ${stats.lastError}`)
  lines.push(`Since: ${new Date(stats.startedAt).toISOString()}`)
  // v0.4 additions are appended so the v0.3 report lines stay byte-compatible.
  const workersStarted = stats.workersStarted ?? 0
  const workersFailed = stats.workersFailed ?? 0
  const slavesStarted = stats.slavesStarted ?? 0
  const slavesSettled = stats.slavesSettled ?? 0
  const slavesFailed = stats.slavesFailed ?? 0
  if (workersStarted + workersFailed > 0) {
    lines.push(`Workers: ${workersStarted} started, ${workersFailed} failed`)
  }
  if (slavesStarted + slavesFailed > 0) {
    lines.push(`Slaves: ${slavesStarted} started, ${slavesSettled} settled, ${slavesFailed} failed`)
  }
  const nodes = Object.keys(stats.byNode ?? {})
  if (nodes.length > 0) {
    lines.push('Delegation by node:')
    for (const node of nodes.sort()) {
      const bucket = stats.byNode[node]
      lines.push(
        `  - ${node}: ${bucket.started} started, ${bucket.settled} settled, ${bucket.failed} failed`,
      )
    }
  }
  return lines.join('\n')
}
