/**
 * Read-only client for the gateway's `GET <baseURL>/route-info` data-plane
 * endpoint.
 *
 * Observability must never harm the request path: every failure (unreachable,
 * timeout, non-200, oversized body, malformed JSON) resolves to `undefined`.
 * Nothing here throws, logs a secret, or retries.
 *
 * @module dsh-plugin-portara/host/gateway
 */

/** Default query timeout; routing facts are cosmetic and must not linger. */
export const DEFAULT_TIMEOUT_MS = 1500

/** Largest response body accepted, in characters. */
const MAX_BODY_CHARS = 64 * 1024

/**
 * Compose the route-info endpoint from a provider base URL.
 * @param {unknown} baseURL - configured provider base URL, e.g. `https://gateway.example/v1`.
 * @returns {string | undefined} absolute endpoint URL, or undefined for a non-http value.
 */
export function routeInfoUrl(baseURL) {
  if (typeof baseURL !== 'string') return undefined
  const trimmed = baseURL.trim()
  if (trimmed === '') return undefined
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  return `${trimmed.replace(/\/+$/u, '')}/route-info`
}

/**
 * Query one Session's current route.
 * @param {{ baseURL: string, apiKey: string, sessionKey: string, timeoutMs?: number,
 *   signal?: AbortSignal, fetchImpl?: typeof fetch }} options - query facts.
 * @returns {Promise<unknown | undefined>} parsed body, or undefined on any failure.
 */
export async function fetchRouteInfo(options) {
  const url = routeInfoUrl(options.baseURL)
  if (url === undefined) return undefined
  if (typeof options.apiKey !== 'string' || options.apiKey === '') return undefined
  if (typeof options.sessionKey !== 'string' || options.sessionKey === '') return undefined
  const timeoutMs = Number.isFinite(options.timeoutMs) && /** @type {number} */ (options.timeoutMs) > 0
    ? /** @type {number} */ (options.timeoutMs)
    : DEFAULT_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return undefined
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (options.signal !== undefined) signals.push(options.signal)
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${options.apiKey}`,
        'x-portara-client-session': options.sessionKey,
      },
      signal: AbortSignal.any(signals),
    })
  } catch {
    return undefined
  }
  if (response.ok !== true) {
    // Drain a refused body so the socket can be reused; the content is unused.
    try {
      await response.body?.cancel()
    } catch { /* nothing to release */ }
    return undefined
  }
  let body
  try {
    body = await response.text()
  } catch {
    return undefined
  }
  if (body.length > MAX_BODY_CHARS) return undefined
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}
