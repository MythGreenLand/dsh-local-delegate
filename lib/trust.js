/**
 * Request trust fence for the plugin's HTTP surface.
 *
 * dsh-host-webserver has no server-wide authentication: every route owner
 * enforces its own policy. These routes serve the same-origin Web GUI, so they
 * first ask the composition's `connection` service for the exact admission
 * decision the kernel applies to `/api` (Host/Origin fence plus browser auth),
 * and fall back to a structural replica only when no connection service exists.
 *
 * The replica is deliberately narrow: loopback Host only, no cross-site fetch,
 * and an Origin/Referer that matches the request Host authority.
 */

const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

function authorityOf(value, defaultScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.includes('://') ? value.trim() : `${defaultScheme ?? 'http'}://${value.trim()}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port }
}

/** Only the owned desktop application page, never arbitrary custom protocols. */
function isDesktopRelayReferer(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'dsh-app:' && url.hostname === 'app' && url.port === '' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

function structuralReason(req) {
  const host = authorityOf(req.headers.host, 'http')
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 'host-not-loopback'
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return 'cross-site'
  for (const header of ['origin', 'referer']) {
    const raw = req.headers[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    if (header === 'referer' && isDesktopRelayReferer(raw)) {
      if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) return 'desktop-relay-markers'
      continue
    }
    const authority = authorityOf(raw.trim())
    if (authority === null) return `${header}-invalid`
    if (authority.scheme !== host.scheme || authority.hostname !== host.hostname || authority.port !== host.port) return `${header}-mismatch`
  }
  return undefined
}

/**
 * Decide one request.
 * @param {import('node:http').IncomingMessage} req
 * @param {object|undefined} connection harness connection service, when mounted
 * @returns {number|undefined} HTTP status to reject with, or undefined to allow
 */
export function requestRejection(req, connection) {
  let decision
  try {
    const admit = connection?.admit
    if (typeof admit === 'function') {
      const admission = admit.call(connection, req)
      const status = admission && typeof admission === 'object' ? admission.rejection : undefined
      if (status === undefined) return undefined
      decision = { status }
    } else {
      const reject = connection?.requestRejection
      if (typeof reject === 'function') {
        const status = reject.call(connection, req)
        if (status === undefined) return undefined
        decision = { status }
      }
    }
  } catch {
    // Never bypass browser authentication when a mounted Host service fails.
    decision = { status: 503 }
  }
  if (decision === undefined) {
    const reason = structuralReason(req)
    if (reason !== undefined) decision = { status: 403 }
  }
  return decision?.status
}
