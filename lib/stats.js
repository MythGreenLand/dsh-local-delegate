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
  return lines.join('\n')
}
