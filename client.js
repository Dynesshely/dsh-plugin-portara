/**
 * dsh-plugin-portara browser half: one collapsible Chat row per routed Session.
 *
 * The row renders the durable `plugin:portara/route` record the host writes
 * when a reply settles. Its `Conversation` Definition is keyed by the gateway
 * session key, so every later record for the same Session updates this one row
 * instead of stacking another — the Conversation layer owns placement, paging,
 * and incremental assembly.
 *
 * Plain JavaScript on purpose: a profile-installed bundle needs no build step,
 * and React comes from the page's module table.
 *
 * @module dsh-plugin-portara/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-portara',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Client locale namespace owned by this plugin. */
    const NS = 'portara-route'
    /** Conversation Definition kind and Chat renderer key. */
    const KIND = 'portara-route'
    /** Durable record type written by the host half. */
    const RECORD_TYPE = 'plugin:portara/route'

    /** Card copy, duplicated from `locale/*.json` because the JSON files carry display metadata. */
    const DICTS = {
      en: {
        'card.routed': 'Routed to {target}',
        'card.switched': 'Switched to {target} (attempt {attempt})',
        'card.switchedBlind': 'Switched (attempt {attempt})',
        'card.expanded': 'Hide failover details',
        'card.collapsed': 'Show failover details',
        'card.attempt': 'Attempt {attempt}',
        'card.outcome.attempt_failed': 'failed',
        'card.outcome.failover_success': 'failover succeeded',
        'card.outcome.quota_cooldown': 'quota cooldown',
        'card.status': 'HTTP {status}',
        'card.noDetail': 'Gateway did not disclose the upstream channel',
      },
      zh: {
        'card.routed': '已路由 {target}',
        'card.switched': '切换后 {target}（第 {attempt} 次尝试）',
        'card.switchedBlind': '已切换（第 {attempt} 次尝试）',
        'card.expanded': '收起切换细节',
        'card.collapsed': '展开切换细节',
        'card.attempt': '第 {attempt} 次尝试',
        'card.outcome.attempt_failed': '失败',
        'card.outcome.failover_success': '切换成功',
        'card.outcome.quota_cooldown': '额度冷却',
        'card.status': 'HTTP {status}',
        'card.noDetail': '网关照脱敏设置隐藏了上游渠道',
      },
    }

    /**
     * Read a plain string field.
     * @param {unknown} value - candidate.
     * @returns {string | undefined} non-empty string, otherwise undefined.
     */
    function text(value) {
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
    }

    /**
     * Validate and narrow one stored record payload.
     *
     * The client never trusts the log: a record written by a future version may
     * carry fields this build does not know, and a malformed one must render
     * nothing rather than crash the slot entry.
     *
     * @param {unknown} raw - event payload.
     * @returns {object | undefined} narrowed payload.
     */
    function readPayload(raw) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
      const payload = /** @type {Record<string, unknown>} */ (raw)
      const sessionKey = text(payload.sessionKey)
      if (sessionKey === undefined) return undefined
      const routeRaw = payload.route
      if (routeRaw === null || typeof routeRaw !== 'object' || Array.isArray(routeRaw)) return undefined
      const routeRecord = /** @type {Record<string, unknown>} */ (routeRaw)
      const route = {
        alias: text(routeRecord.alias) ?? null,
        channel: text(routeRecord.channel) ?? null,
        account: text(routeRecord.account) ?? null,
        upstreamModel: text(routeRecord.upstreamModel) ?? null,
      }
      const history = []
      if (Array.isArray(payload.history)) {
        for (const entry of payload.history) {
          if (entry === null || typeof entry !== 'object') continue
          const record = /** @type {Record<string, unknown>} */ (entry)
          const at = text(record.at)
          const outcome = text(record.outcome)
          if (at === undefined || outcome === undefined) continue
          history.push({
            attempt: Number.isSafeInteger(record.attempt) ? /** @type {number} */ (record.attempt) : history.length + 1,
            channel: text(record.channel) ?? null,
            account: text(record.account) ?? null,
            outcome,
            statusCode: Number.isSafeInteger(record.statusCode) ? /** @type {number} */ (record.statusCode) : null,
            reason: text(record.reason) ?? '',
            at,
          })
        }
      }
      return {
        sessionKey,
        updatedAt: text(payload.updatedAt) ?? null,
        route,
        history,
      }
    }

    /**
     * Render one history timestamp in the reader's clock.
     * @param {string} at - ISO timestamp.
     * @returns {string} local time, or the raw value when unparsable.
     */
    function formatTime(at) {
      const time = new Date(at)
      if (Number.isNaN(time.getTime())) return at
      return time.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }

    /**
     * Compose the summary line and its disclosure state.
     * @param {object} payload - narrowed payload.
     * @param {(key: string, params?: Record<string, unknown>) => string} t - translator.
     * @returns {{ text: string, switched: boolean, attempt: number | null, details: boolean }} summary.
     */
    function summaryOf(payload, t) {
      const { route, history } = payload
      const channel = route.channel
      const account = route.account
      const target = channel !== null && account !== null
        ? `${channel} / ${account}`
        : channel ?? account ?? route.alias ?? ''
      const switched = history.length > 0
      const attempt = switched ? history.length + 1 : null
      // A redacted gateway may withhold every routing fact; still report the switch.
      if (target === '' && !switched) return { text: '', switched, attempt, details: false }
      const label = target === ''
        ? t('card.switchedBlind', { attempt })
        : switched
          ? t('card.switched', { target, attempt })
          : t('card.routed', { target })
      const withModel = route.upstreamModel !== null && route.upstreamModel !== target
        ? `${label} · ${route.upstreamModel}`
        : label
      return {
        text: channel === null && account === null && route.alias !== null
          ? `${withModel} · ${t('card.noDetail')}`
          : withModel,
        switched,
        attempt,
        details: history.length > 0,
      }
    }

    /**
     * Compose one display row per failover event.
     * @param {object} payload - narrowed payload.
     * @param {(key: string, params?: Record<string, unknown>) => string} t - translator.
     * @returns {Array<{ key: string, text: string }>} rows in gateway order.
     */
    function historyRows(payload, t) {
      return payload.history.map((entry, index) => {
        const where = entry.channel !== null && entry.account !== null
          ? `${entry.channel} / ${entry.account}`
          : entry.channel ?? entry.account ?? '—'
        const outcome = t(`card.outcome.${entry.outcome}`)
        const status = entry.statusCode === null ? '' : ` · ${t('card.status', { status: entry.statusCode })}`
        return {
          key: `${entry.at}:${entry.attempt}:${index}`,
          text: `${t('card.attempt', { attempt: entry.attempt })} · ${where} · ${outcome}${status} · ${formatTime(entry.at)}`,
        }
      })
    }

    /**
     * Build the row component bound to one activation context.
     * @param {object} ctx - Client plugin context.
     * @returns {Function} React component for the keyed Chat seat.
     */
    function createRow(ctx) {
      const subscribe = listener => ctx.locale.subscribe(listener)
      const getLocaleId = () => ctx.locale.getSnapshot().active

      /** One collapsible routing row. */
      function PortaraRouteRow({ node }) {
        const localeId = React.useSyncExternalStore(subscribe, getLocaleId, getLocaleId)
        const t = React.useMemo(() => ctx.locale.bind(NS), [localeId])
        const payload = React.useMemo(() => readPayload(node?.data), [node])
        const [expanded, setExpanded] = React.useState(false)
        if (payload === undefined) return null
        const summary = summaryOf(payload, t)
        const rows = summary.details ? historyRows(payload, t) : []
        const toggle = () => setExpanded(open => !open)
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '2px 0' } }, [
          h('div', {
            key: 'summary',
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              minHeight: '24px',
              fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
              color: 'var(--dsw-alias-label-secondary)',
            },
          }, [
            h('span', { key: 'icon', 'aria-hidden': true, style: { flex: 'none' } }, '⚡'),
            h('span', {
              key: 'text',
              style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, summary.text),
            summary.details
              ? h('button', {
                key: 'toggle',
                type: 'button',
                'aria-expanded': expanded ? 'true' : 'false',
                onClick: toggle,
                title: expanded ? t('card.expanded') : t('card.collapsed'),
                style: {
                  flex: 'none',
                  border: 'none',
                  background: 'transparent',
                  padding: '0 2px',
                  cursor: 'pointer',
                  color: 'var(--dsw-alias-brand-primary)',
                  font: 'inherit',
                },
              }, expanded ? '▾' : '▸')
              : null,
          ]),
          expanded && rows.length > 0
            ? h('ul', {
              key: 'details',
              style: {
                margin: '0 0 4px 18px',
                padding: 0,
                listStyle: 'none',
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
                fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
                color: 'var(--dsw-alias-label-secondary)',
              },
            }, rows.map(row => h('li', { key: row.key }, row.text)))
            : null,
        ])
      }
      return PortaraRouteRow
    }

    /** Conversation Definition: one row per gateway session key. */
    const definition = {
      kind: KIND,
      target: 'chat',
      // Table form routes this definition only the one event type it handles.
      match: {
        [RECORD_TYPE]: event => {
          const payload = readPayload(event?.data)
          if (payload === undefined) return null
          return { id: payload.sessionKey, role: 'start' }
        },
      },
      start: (_context, match) => readPayload(match.event.data),
      update: (context, match) => readPayload(match.event.data) ?? context.state,
      buildViewNode: context => {
        const data = context.state
        const start = context.start
        if (data === undefined || start === undefined) return null
        return {
          key: context.key,
          kind: KIND,
          id: context.id,
          target: 'chat',
          anchorSeq: start.event.seq,
          location: start.location,
          visibility: 'visible',
          data,
        }
      },
    }

    return {
      inject: ['slots', 'uiConversation', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', DICTS.en), 'dsh-plugin-portara: English copy')
        ctx.effect(() => ctx.locale.register(NS, 'zh', DICTS.zh), 'dsh-plugin-portara: Chinese copy')
        ctx.effect(() => ctx.uiConversation.events.register(definition), 'dsh-plugin-portara: routing row definition')
        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
          name: 'conversation.chat.node',
          key: KIND,
        }, createRow(ctx)))
      },
      // Pure helpers for unit tests; the module loader ignores extra keys.
      __test: { readPayload, summaryOf, historyRows, formatTime, DICTS, KIND, RECORD_TYPE },
    }
  },
})
