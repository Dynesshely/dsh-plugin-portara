/**
 * Durable payload shape for one `plugin:portara/route` record, plus the pure
 * normalization used before it enters the Session log.
 *
 * The record is written with `appendPluginRecord()`, so every stored event has
 * `ignorable: true`: a reader that does not know the type retains it and moves
 * on, and an older Harness never refuses to reopen the Session. The payload is
 * plain JSON and carries no provider secret — only the routing facts the
 * gateway already chose to expose.
 *
 * @module dsh-plugin-portara/payload
 */

/** Plugin record type; `plugin:` records are the reload-safe log-only namespace. */
export const RECORD_TYPE = 'plugin:portara/route'

/** Payload schema version, bumped when fields change meaning. */
export const PAYLOAD_VERSION = 1

/** Longest string kept from the gateway response. */
const MAX_TEXT = 256

/** Longest history window kept from the gateway response. */
const MAX_HISTORY = 50

/**
 * Read a trimmed bounded string.
 * @param {unknown} value - candidate field.
 * @param {number} [limit] - maximum length.
 * @returns {string | undefined} the string, or undefined when absent or empty.
 */
export function text(value, limit = MAX_TEXT) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed
}

/**
 * Read a nullable trimmed string, keeping the gateway's explicit null.
 * @param {unknown} value - candidate field.
 * @returns {string | null | undefined} the string, null, or undefined when malformed.
 */
function nullableText(value) {
  if (value === null) return null
  return text(value)
}

/**
 * Read a finite non-negative integer.
 * @param {unknown} value - candidate field.
 * @returns {number | null | undefined} the integer, null, or undefined when malformed.
 */
function nullableCount(value) {
  if (value === null) return null
  return Number.isSafeInteger(value) && value >= 0 ? /** @type {number} */ (value) : undefined
}

/**
 * Normalize one route-info history entry.
 * @param {unknown} entry - candidate entry.
 * @param {number} index - position, used when the gateway omits `attempt`.
 * @returns {object | undefined} normalized entry, or undefined when unusable.
 */
function normalizeHistoryEntry(entry, index) {
  if (entry === null || typeof entry !== 'object') return undefined
  const record = /** @type {Record<string, unknown>} */ (entry)
  const at = text(record.at, 64)
  if (at === undefined) return undefined
  const outcome = text(record.outcome, 64)
  if (outcome === undefined) return undefined
  const attempt = nullableCount(record.attempt)
  const statusCode = nullableCount(record.statusCode)
  return {
    attempt: typeof attempt === 'number' && attempt > 0 ? attempt : index + 1,
    channel: nullableText(record.channel) ?? null,
    account: nullableText(record.account) ?? null,
    outcome,
    statusCode: typeof statusCode === 'number' ? statusCode : null,
    reason: text(record.reason, 128) ?? '',
    at,
  }
}

/**
 * Normalize one `/v1/route-info` response into a durable payload.
 *
 * An empty answer (routing info disabled, no route recorded yet, or a gateway
 * that does not implement the endpoint) yields `undefined`, so the caller
 * writes nothing and the chat shows nothing — the documented silent path.
 *
 * @param {unknown} raw - parsed JSON response body.
 * @param {{ turn?: number, step?: number, anchorSeq?: number }} [coordinates] - Session placement.
 * @returns {object | undefined} payload for `plugin:portara/route`, or undefined.
 */
export function normalizeRouteInfo(raw, coordinates = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const body = /** @type {Record<string, unknown>} */ (raw)
  if (body.object !== 'route.info') return undefined
  const sessionKey = text(body.sessionKey, 128)
  if (sessionKey === undefined) return undefined
  const routeRaw = body.route
  if (routeRaw === null || typeof routeRaw !== 'object' || Array.isArray(routeRaw)) return undefined
  const routeRecord = /** @type {Record<string, unknown>} */ (routeRaw)
  const route = {
    alias: nullableText(routeRecord.alias) ?? null,
    channel: nullableText(routeRecord.channel) ?? null,
    account: nullableText(routeRecord.account) ?? null,
    upstreamModel: nullableText(routeRecord.upstreamModel) ?? null,
  }
  const updatedAt = text(body.updatedAt, 64) ?? null
  const historyRaw = Array.isArray(body.history) ? body.history : []
  const history = []
  for (const [index, entry] of historyRaw.slice(0, MAX_HISTORY).entries()) {
    const normalized = normalizeHistoryEntry(entry, index)
    if (normalized !== undefined) history.push(normalized)
  }
  const hasRoute = route.alias !== null || route.channel !== null || route.account !== null
    || route.upstreamModel !== null
  if (!hasRoute && history.length === 0) return undefined
  const turn = Number.isSafeInteger(coordinates.turn) && /** @type {number} */ (coordinates.turn) >= 0
    ? /** @type {number} */ (coordinates.turn)
    : undefined
  const step = Number.isSafeInteger(coordinates.step) && /** @type {number} */ (coordinates.step) >= 0
    ? /** @type {number} */ (coordinates.step)
    : undefined
  const anchorSeq = Number.isSafeInteger(coordinates.anchorSeq) && /** @type {number} */ (coordinates.anchorSeq) >= 0
    ? /** @type {number} */ (coordinates.anchorSeq)
    : undefined
  return {
    version: PAYLOAD_VERSION,
    sessionKey,
    updatedAt,
    route,
    history,
    ...(turn === undefined ? {} : { turn }),
    ...(turn === undefined || step === undefined ? {} : { step }),
    ...(anchorSeq === undefined ? {} : { anchorSeq }),
  }
}

/**
 * Stable dedupe signature for one payload; the same routing facts produce the
 * same signature so a repeated poll never writes a second record.
 * @param {object} payload - normalized payload.
 * @returns {string} signature.
 */
export function recordSignature(payload) {
  return JSON.stringify([
    payload.sessionKey,
    payload.updatedAt,
    payload.route?.alias ?? null,
    payload.route?.channel ?? null,
    payload.route?.account ?? null,
    payload.route?.upstreamModel ?? null,
    payload.history?.length ?? 0,
    payload.history?.map(entry => [entry.attempt, entry.outcome, entry.statusCode, entry.at]) ?? [],
  ])
}
