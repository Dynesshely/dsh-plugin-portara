/**
 * Pure formatting and grammar for the `/portara` command.
 *
 * The command never reaches the model: its handler answers the dispatching UI
 * directly with text, so the reader sees the gateway route without spending a
 * token. Everything here is a pure function over the parsed `/v1/route-info`
 * body, which keeps the copy and the verb grammar unit-testable.
 *
 * @module dsh-plugin-portara/host/command
 */

/** Registered command name, without the leading slash. */
export const COMMAND_NAME = 'portara'

/** The one accepted verb. */
export const ROUTE_VERB = 'route'

/**
 * Parse the text after `/portara`.
 * @param {unknown} rawInput - verbatim text following the command name.
 * @returns {{ kind: 'route' } | { kind: 'help' } | { kind: 'unknown', verb: string }} the parsed verb.
 */
export function parseCommandInput(rawInput) {
  const verb = typeof rawInput === 'string' ? rawInput.trim().toLowerCase() : ''
  if (verb === '') return { kind: 'help' }
  if (verb === ROUTE_VERB) return { kind: 'route' }
  return { kind: 'unknown', verb }
}

/**
 * Render one local clock time.
 * @param {string} at - ISO timestamp.
 * @returns {string} `HH:MM:SS`, or the raw value when unparsable.
 */
function clock(at) {
  const time = new Date(at)
  if (Number.isNaN(time.getTime())) return at
  return time.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * Render one gateway location, collapsing a withheld channel and account.
 * @param {string | null} channel - channel name, when disclosed.
 * @param {string | null} account - upstream account name, when disclosed.
 * @param {string | null} alias - model alias, when known.
 * @returns {string} the best available target description.
 */
function targetOf(channel, account, alias) {
  if (channel !== null && account !== null) return `${channel} / ${account}`
  if (channel !== null) return channel
  if (account !== null) return account
  if (alias !== null) return alias
  return 'unknown route'
}

/** Note appended when the answer comes from the durable record instead of a live query. */
export const RECORDED_ROUTE_NOTE =
  'Last recorded route — the gateway keeps live route information for 15 minutes.'

/**
 * Convert one durable `plugin:portara/route` payload back into the
 * `/v1/route-info` body shape so both paths render through one formatter.
 *
 * @param {unknown} payload - stored record payload.
 * @returns {Record<string, unknown> | undefined} route-info-shaped body.
 */
export function recordedRouteInfo(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const stored = /** @type {Record<string, unknown>} */ (payload)
  const route = stored.route
  if (route === null || typeof route !== 'object' || Array.isArray(route)) return undefined
  const source = /** @type {Record<string, unknown>} */ (route)
  return {
    object: 'route.info',
    sessionKey: stored.sessionKey,
    updatedAt: stored.updatedAt ?? null,
    route: {
      alias: source.alias ?? null,
      channel: source.channel ?? null,
      account: source.account ?? null,
      upstreamModel: source.upstreamModel ?? null,
    },
    history: Array.isArray(stored.history) ? stored.history : [],
  }
}

/**
 * Format the answer to `/portara route`.
 *
 * An empty but valid body means the gateway answered without disclosing
 * anything: the reader gets an explanation instead of a misleading route.
 *
 * @param {unknown} raw - parsed `/v1/route-info` body.
 * @param {{ note?: string }} [options] - optional trailing explanation.
 * @returns {string} text for the command card.
 */
export function formatRouteInfo(raw, options = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'Portara: the gateway did not answer with routing information.'
  }
  const body = /** @type {Record<string, unknown>} */ (raw)
  if (body.object !== 'route.info') {
    return 'Portara: the endpoint is not a route-info data plane.'
  }
  const route = body.route !== null && typeof body.route === 'object' && !Array.isArray(body.route)
    ? /** @type {Record<string, unknown>} */ (body.route)
    : {}
  const text = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
  const alias = text(route.alias)
  const channel = text(route.channel)
  const account = text(route.account)
  const upstreamModel = text(route.upstreamModel)
  const history = Array.isArray(body.history) ? body.history : []
  const hasRoute = alias !== null || channel !== null || account !== null || upstreamModel !== null
  if (!hasRoute) {
    return 'Portara: the gateway answered without routing information. '
      + 'Turn on routing disclosure (exposeRoutingInfo) to see the route.'
  }
  const lines = [`⚡ Routed to ${targetOf(channel, account, alias)}${upstreamModel === null ? '' : ` · ${upstreamModel}`}`]
  const aliasLine = alias === null ? null : `alias ${alias}`
  const updatedAt = text(body.updatedAt)
  const when = updatedAt === null ? null : `updated ${clock(updatedAt)}`
  if (aliasLine !== null || when !== null) lines.push([aliasLine, when].filter(part => part !== null).join(' · '))
  if (channel === null && account === null) {
    lines.push('the gateway withheld channel and account (exposeRoutingDetail)')
  }
  for (const [index, entry] of history.entries()) {
    if (entry === null || typeof entry !== 'object') continue
    const record = /** @type {Record<string, unknown>} */ (entry)
    const attempt = Number.isSafeInteger(record.attempt) ? /** @type {number} */ (record.attempt) : index + 1
    const where = targetOf(text(record.channel), text(record.account), null)
    const outcome = text(record.outcome) ?? 'unknown'
    const status = Number.isSafeInteger(record.statusCode) ? ` · HTTP ${/** @type {number} */ (record.statusCode)}` : ''
    const at = text(record.at)
    lines.push(`   ${attempt}. ${where} · ${outcome}${status}${at === null ? '' : ` · ${clock(at)}`}`)
  }
  if (typeof options.note === 'string' && options.note !== '') lines.push(options.note)
  return lines.join('\n')
}

/** Usage text shown by the bare command and by an unknown verb. */
export const COMMAND_USAGE = 'Usage: /portara route — print this session’s gateway route once.'
