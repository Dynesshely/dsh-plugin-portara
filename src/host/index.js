/**
 * dsh-plugin-portara host half: observe the Portara gateway's load-balancing
 * route for each model call and record it in the Session stream.
 *
 * Three seams, all public:
 * - `llm/stream` wraps each conversation call, so one query runs when it
 *   settles (`request.purpose` skips titles, subagents, and other auxiliaries).
 * - `llm-pi-ai/request-headers` stamps the harness session id as the gateway's
 *   explicit session key, so a request and its later route query hash to the
 *   same key. Only confirmed gateway endpoints receive the header.
 * - `appendPluginRecord()` writes `plugin:portara/route`, an ignorable log-only
 *   record that older readers retain and skip.
 *
 * Observability must never degrade a request: every failure path is silent, the
 * query is time-boxed, and nothing here throws into the model call.
 *
 * @module dsh-plugin-portara
 */

import { RECORD_TYPE, normalizeRouteInfo, recordSignature } from '../payload.js'
import { fetchRouteInfo, routeInfoUrl } from './gateway.js'
import { discoverGateways, providerProfiles, resolveCredential, sessionHeaderValue } from './provider.js'
import { createRecordWriter, sessionCoordinates } from './records.js'

export const name = 'portara-route'

/** The Session registry and the provider directory are the only hard needs. */
export const inject = ['agents', 'llm']

/** Default query timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 1500

/** Default request-time polling cadence in milliseconds (0 disables polling). */
const DEFAULT_POLL_INTERVAL_MS = 2000

/** Gateway header that carries the explicit session key. */
const SESSION_HEADER = 'x-portara-client-session'

/** Session key used once by endpoint discovery; never a real harness session id. */
const PROBE_SESSION = 'dsh-plugin-portara-discovery'

/**
 * Validate and normalize the plugin config. Unknown keys are ignored so a
 * newer patch file never breaks activation.
 * @param {unknown} config - raw Loader config.
 * @returns {{ enabled: boolean, timeoutMs: number, pollIntervalMs: number,
 *   injectSessionHeader: boolean, gateways: ReadonlyArray<{ baseURL: string, apiKeyEnv?: string }> }} options.
 */
export function readOptions(config) {
  const source = config !== null && typeof config === 'object' ? /** @type {Record<string, unknown>} */ (config) : {}
  const enabled = source.enabled !== false
  const timeoutMs = Number.isFinite(source.timeoutMs) && /** @type {number} */ (source.timeoutMs) >= 100
    ? Math.min(/** @type {number} */ (source.timeoutMs), 10_000)
    : DEFAULT_TIMEOUT_MS
  const pollIntervalMs = Number.isFinite(source.pollIntervalMs) && /** @type {number} */ (source.pollIntervalMs) >= 0
    ? Math.min(/** @type {number} */ (source.pollIntervalMs), 30_000)
    : DEFAULT_POLL_INTERVAL_MS
  const injectSessionHeader = source.injectSessionHeader !== false
  const gateways = []
  if (Array.isArray(source.gateways)) {
    for (const entry of source.gateways) {
      if (entry === null || typeof entry !== 'object') continue
      const baseURL = entry.baseURL
      if (typeof baseURL !== 'string' || routeInfoUrl(baseURL) === undefined) continue
      const apiKeyEnv = typeof entry.apiKeyEnv === 'string' && entry.apiKeyEnv !== '' ? entry.apiKeyEnv : undefined
      gateways.push({ baseURL: baseURL.trim().replace(/\/+$/u, ''), ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }) })
    }
  }
  return { enabled, timeoutMs, pollIntervalMs, injectSessionHeader, gateways }
}

/**
 * Install route observation for this profile.
 * @param {object} ctx - host plugin context.
 * @param {unknown} [config] - Loader row config.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const options = readOptions(config)
  const logger = ctx.logger
  const lifetime = new AbortController()
  const writer = createRecordWriter(ctx, { signal: lifetime.signal, logger })

  /** Confirmed gateway base URL → previously resolved API key (undefined until read). */
  const gateways = new Map()
  /** Provider route → configured base URL. */
  let providerBaseURLs = new Map()
  /** Potential gateway base URL → credential reference. */
  let credentialRefs = new Map()
  /** Base URLs with an in-flight or finished confirmation attempt. */
  const probed = new Set()
  /** Session id → last committed record signature. */
  const signatures = new Map()

  /**
   * Rebuild the provider directory view that places each provider's endpoint.
   * @returns {void}
   */
  function refreshProviders() {
    providerBaseURLs = new Map()
    credentialRefs = new Map()
    for (const row of providerProfiles(ctx)) {
      if (row.baseURL === undefined) continue
      const baseURL = row.baseURL.trim().replace(/\/+$/u, '')
      providerBaseURLs.set(row.provider, baseURL)
      if (row.apiKeyEnv !== undefined) credentialRefs.set(baseURL, row.apiKeyEnv)
    }
    for (const entry of options.gateways) {
      if (entry.apiKeyEnv !== undefined) credentialRefs.set(entry.baseURL, entry.apiKeyEnv)
      gateways.set(entry.baseURL, undefined)
    }
  }

  /**
   * Resolve and cache the API key of one confirmed gateway.
   * @param {string} baseURL - normalized endpoint.
   * @returns {Promise<string | undefined>} the credential, or undefined.
   */
  async function gatewayKey(baseURL) {
    const cached = gateways.get(baseURL)
    if (typeof cached === 'string' && cached !== '') return cached
    const ref = credentialRefs.get(baseURL)
    if (ref === undefined || ref === '') return undefined
    const key = await resolveCredential(ctx, ref)
    if (key !== undefined) gateways.set(baseURL, key)
    return key
  }

  /**
   * Confirm one endpoint as a gateway in the background; idempotent.
   * @param {string} baseURL - normalized endpoint.
   * @returns {void}
   */
  function probeEndpoint(baseURL) {
    if (gateways.has(baseURL) || probed.has(baseURL)) return
    const ref = credentialRefs.get(baseURL)
    if (ref === undefined) return
    probed.add(baseURL)
    void (async () => {
      try {
        const apiKey = await resolveCredential(ctx, ref)
        if (apiKey === undefined) return
        const body = await fetchRouteInfo({
          baseURL,
          apiKey,
          sessionKey: PROBE_SESSION,
          timeoutMs: options.timeoutMs,
          signal: lifetime.signal,
        })
        if (body === null || typeof body !== 'object') return
        if (/** @type {{ object?: unknown }} */ (body).object !== 'route.info') return
        gateways.set(baseURL, apiKey)
      } catch { /* silent by contract */ }
    })()
  }

  /**
   * Commit one query result as a plugin record when its facts changed.
   * @param {string} sessionId - harness session id.
   * @param {unknown} raw - parsed route-info body.
   * @returns {Promise<void>} fulfillment after the write attempt.
   */
  async function commit(sessionId, raw) {
    try {
      const session = ctx.agents?.get?.(sessionId)?.session
      if (session === undefined) return
      const payload = normalizeRouteInfo(raw, sessionCoordinates(session))
      if (payload === undefined) return
      const signature = recordSignature(payload)
      if (signatures.get(sessionId) === signature) return
      signatures.set(sessionId, signature)
      const written = await writer.append(session, RECORD_TYPE, payload)
      if (!written) signatures.delete(sessionId)
    } catch { /* silent by contract */ }
  }

  /**
   * Query one session's route and commit the outcome.
   * @param {string} sessionId - harness session id.
   * @param {string} baseURL - gateway endpoint.
   * @returns {Promise<void>} fulfillment after the attempt.
   */
  async function observe(sessionId, baseURL) {
    try {
      if (!gateways.has(baseURL)) {
        probeEndpoint(baseURL)
        return
      }
      const apiKey = await gatewayKey(baseURL)
      if (apiKey === undefined) return
      const raw = await fetchRouteInfo({
        baseURL,
        apiKey,
        sessionKey: sessionId,
        timeoutMs: options.timeoutMs,
        signal: lifetime.signal,
      })
      if (raw === undefined) return
      await commit(sessionId, raw)
    } catch { /* silent by contract */ }
  }

  ctx.effect(() => () => {
    lifetime.abort(new Error('dsh-plugin-portara was unloaded'))
    signatures.clear()
    gateways.clear()
    probed.clear()
  }, 'portara-route: stop gateway observation')

  if (!options.enabled) return

  refreshProviders()

  // Confirm the configured endpoints once at activation so the very first
  // request can already carry its session key.
  void (async () => {
    try {
      const found = await discoverGateways(ctx, { signal: lifetime.signal, timeoutMs: options.timeoutMs, logger })
      for (const [baseURL, apiKey] of found) gateways.set(baseURL, apiKey)
    } catch { /* silent by contract */ }
  })()

  if (options.injectSessionHeader) {
    ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
      try {
        const baseURL = typeof request?.baseURL === 'string' ? request.baseURL.trim().replace(/\/+$/u, '') : ''
        if (baseURL !== '') {
          if (!gateways.has(baseURL)) probeEndpoint(baseURL)
          const value = sessionHeaderValue({ ...request, baseURL }, new Set(gateways.keys()))
          if (value !== undefined && typeof headers?.set === 'function') headers.set(SESSION_HEADER, value)
        }
      } catch { /* header preparation must never fail a call */ }
      return next()
    })
  }

  ctx.on('llm/stream', (request, next) => {
    if (!options.enabled) return next()
    const sessionId = typeof request?.sessionId === 'string' && request.sessionId !== '' ? request.sessionId : undefined
    if (sessionId === undefined || request.purpose !== undefined) return next()
    const downstream = next()
    return (async function* observeStream() {
      /** @type {undefined | (() => void)} */
      let stopPolling
      try {
        if (options.pollIntervalMs > 0) {
          let polling = false
          const timer = setInterval(() => {
            if (polling) return
            const baseURL = providerBaseURLs.get(request.provider)
            if (baseURL === undefined) return
            polling = true
            void observe(sessionId, baseURL).finally(() => { polling = false })
          }, options.pollIntervalMs)
          timer.unref?.()
          stopPolling = () => { clearInterval(timer) }
        }
        for await (const chunk of downstream) yield chunk
      } finally {
        stopPolling?.()
        const baseURL = providerBaseURLs.get(request.provider)
        if (baseURL !== undefined) void observe(sessionId, baseURL)
      }
    })()
  })
}
