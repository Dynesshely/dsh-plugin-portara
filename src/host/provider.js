/**
 * Discover which configured model routes are Portara gateways, resolve their
 * credentials, and decide when the harness session id becomes the gateway
 * session key.
 *
 * The provider profile is read from the live Loader entry that declares it, so
 * a configuration change is picked up without touching this plugin; nothing is
 * hard-coded and an unreadable profile simply yields no gateway.
 *
 * @module dsh-plugin-portara/host/provider
 */

import { fetchRouteInfo, routeInfoUrl } from './gateway.js'

/** Probe session key; never collides with a real harness session id. */
const PROBE_SESSION = 'dsh-plugin-portara-discovery'

/**
 * Find the live Loader entry that declares one settings namespace.
 *
 * `Loader.resolve()` only accepts a *tree-path* id, and a profile whose rows sit
 * under an `include` entry nests them (`include:llm-pi-ai`), while a provider
 * directory reports the local option id. Both spellings are accepted, and a
 * profile without the Loader seam simply yields no entry.
 *
 * @param {object} ctx - plugin context.
 * @param {string} settingsNs - namespace (local entry id) reported by the directory.
 * @returns {object | undefined} the entry, or undefined.
 */
function loaderEntry(ctx, settingsNs) {
  const loader = ctx.get?.('loader')
  if (loader === undefined) return undefined
  try {
    const direct = loader.resolve?.(settingsNs)
    if (direct !== undefined) return direct
  } catch { /* nested tree id: fall through to the scan */ }
  try {
    const entries = typeof loader.entries === 'function' ? loader.entries() : []
    for (const entry of entries) {
      const options = entry?.options
      if (options?.id === settingsNs) return entry
      if (typeof entry?.id === 'string' && (entry.id === settingsNs || entry.id.endsWith(`:${settingsNs}`))) {
        return entry
      }
    }
  } catch { /* no scan seam: no profile */ }
  return undefined
}

/**
 * Read one configured provider profile from the Loader entry that owns it.
 * @param {object} ctx - plugin context.
 * @param {{ provider: string, settingsNs: string, settingsPath: readonly string[] }} entry - directory row.
 * @returns {Record<string, unknown> | undefined} resolved profile object.
 */
function profileOf(ctx, entry) {
  const owner = loaderEntry(ctx, entry.settingsNs)
  let node = owner?.options?.config
  if (node === null || typeof node !== 'object') return undefined
  for (const segment of entry.settingsPath) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[segment]
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined
  return /** @type {Record<string, unknown>} */ (node)
}

/**
 * List configured provider routes that name an endpoint and a credential.
 * @param {object} ctx - plugin context.
 * @returns {Array<{ provider: string, baseURL?: string, apiKeyEnv?: string }>} candidates.
 */
export function providerProfiles(ctx) {
  let directory
  try {
    directory = ctx.llm?.listConfigurableProviders?.()
  } catch {
    return []
  }
  if (!Array.isArray(directory)) return []
  const profiles = []
  for (const entry of directory) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.provider !== 'string' || typeof entry.settingsNs !== 'string') continue
    const settingsPath = Array.isArray(entry.settingsPath) ? entry.settingsPath : []
    const profile = profileOf(ctx, {
      provider: entry.provider,
      settingsNs: entry.settingsNs,
      settingsPath,
    })
    if (profile === undefined) continue
    const baseURL = typeof profile.baseURL === 'string' ? profile.baseURL.trim() : ''
    const apiKeyEnv = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv.trim() : ''
    profiles.push({
      provider: entry.provider,
      ...(baseURL === '' ? {} : { baseURL }),
      ...(apiKeyEnv === '' ? {} : { apiKeyEnv }),
    })
  }
  return profiles
}

/**
 * Resolve one credential reference through the credential service, falling
 * back to the process environment when that seam is absent.
 * @param {object} ctx - plugin context.
 * @param {string} ref - credential reference (an environment-style name).
 * @returns {Promise<string | undefined>} the secret, or undefined when unset.
 */
export async function resolveCredential(ctx, ref) {
  if (typeof ref !== 'string' || ref === '') return undefined
  const credentials = ctx.get?.('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(ref)
      const value = hit?.value
      if (typeof value === 'string' && value !== '') return value
    } catch { /* fall through to the environment */ }
  }
  const ambient = process.env[ref]
  return typeof ambient === 'string' && ambient !== '' ? ambient : undefined
}

/**
 * Decide whether one request should carry the explicit gateway session header.
 * Only a gateway whose endpoint was confirmed supports it, so no other provider
 * receives extra transport metadata.
 * @param {{ sessionId?: unknown, baseURL?: unknown }} request - pi-ai header context.
 * @param {ReadonlySet<string>} gateways - confirmed gateway base URLs.
 * @returns {string | undefined} the header value, or undefined to leave headers alone.
 */
export function sessionHeaderValue(request, gateways) {
  if (request === null || typeof request !== 'object') return undefined
  const sessionId = request.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const baseURL = request.baseURL
  if (typeof baseURL !== 'string' || baseURL === '') return undefined
  return gateways.has(baseURL.trim()) ? sessionId : undefined
}

/**
 * Probe every configured provider once and remember the endpoints that answer
 * as a Portara route-info data-plane endpoint.
 *
 * An endpoint answers with an empty but structurally valid `route.info` body
 * even when routing exposure is off, so discovery does not depend on the
 * privacy setting (and reveals nothing when it is off).
 *
 * @param {object} ctx - plugin context.
 * @param {{ signal: AbortSignal, timeoutMs: number, logger?: { warn(message: string): void } }} options - lifetime and timing.
 * @returns {Promise<Map<string, string>>} confirmed gateway base URL to resolved API key.
 */
export async function discoverGateways(ctx, options) {
  /** @type {Map<string, string>} */
  const gateways = new Map()
  const profiles = providerProfiles(ctx)
  const queue = profiles.filter(row => row.baseURL !== undefined && row.apiKeyEnv !== undefined)
  const attempted = new Set()
  for (const row of queue) {
    const baseURL = row.baseURL
    if (baseURL === undefined || attempted.has(baseURL)) continue
    attempted.add(baseURL)
    if (options.signal.aborted) break
    if (routeInfoUrl(baseURL) === undefined) continue
    const apiKey = await resolveCredential(ctx, row.apiKeyEnv ?? '')
    if (apiKey === undefined) continue
    const body = await fetchRouteInfo({
      baseURL,
      apiKey,
      sessionKey: PROBE_SESSION,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    })
    if (body === null || typeof body !== 'object') continue
    if (/** @type {{ object?: unknown }} */ (body).object !== 'route.info') continue
    gateways.set(baseURL.replace(/\/+$/u, ''), apiKey)
  }
  return gateways
}
