import assert from 'node:assert/strict'
import { test } from 'node:test'

/** Captured Client module registration. */
let loaded

/**
 * Stub `react` for the pure helpers the client half exports for tests.
 * @returns {object} minimal React surface.
 */
function fakeReact() {
  return {
    createElement: () => null,
    useMemo: value => value,
    useState: initial => [initial, () => {}],
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useCallback: value => value,
  }
}

globalThis.window = { __ModuleLoader__: { load: config => { loaded = config } } }
await import('../client.js')

const moduleNamespace = loaded.factory(name => {
  if (name === 'react') return fakeReact()
  throw new Error(`unexpected client module: ${name}`)
})
const { readPayload, summaryOf, historyRows, formatTime, DICTS } = moduleNamespace.__test

/** Translator over the shipped English copy. */
const t = (key, params = {}) => {
  const template = DICTS.en[key] ?? key
  return template.replace(/\{(\w+)\}/gu, (_match, name) => String(params[name] ?? `{${name}}`))
}

const SWITCHED = {
  sessionKey: '8ff4d582',
  updatedAt: '2026-11-11T16:22:39.250Z',
  route: {
    alias: 'balance/deepseek-flash',
    channel: 'OpenDesign',
    account: 'ACP-003',
    upstreamModel: 'deepseek-v4.1-flash',
  },
  history: [
    {
      attempt: 1,
      channel: 'CommandCode',
      account: 'ACP-002',
      outcome: 'quota_cooldown',
      statusCode: 429,
      reason: 'switched',
      at: '2026-11-11T16:22:31.000Z',
    },
  ],
}

test('the client module registers under the bundle id', () => {
  assert.equal(loaded.id, 'dsh-plugin-portara')
})

test('a well-formed payload narrows to the renderer shape', () => {
  const payload = readPayload(SWITCHED)
  assert.equal(payload.sessionKey, '8ff4d582')
  assert.equal(payload.route.channel, 'OpenDesign')
  assert.equal(payload.history.length, 1)
})

test('a malformed payload renders nothing rather than throwing', () => {
  assert.equal(readPayload(undefined), undefined)
  assert.equal(readPayload({}), undefined)
  assert.equal(readPayload({ sessionKey: '', route: {} }), undefined)
  assert.equal(readPayload({ sessionKey: 'x', route: null }), undefined)
  assert.deepEqual(readPayload({ sessionKey: 'x', route: {}, history: 'nope' }).history, [])
})

test('a first-hit route reads as routed with channel, account, and model', () => {
  const summary = summaryOf(readPayload({ ...SWITCHED, history: [] }), t)
  assert.equal(summary.text, 'Routed to OpenDesign / ACP-003 · deepseek-v4.1-flash')
  assert.equal(summary.switched, false)
  assert.equal(summary.details, false)
})

test('a failover route reads as switched with its attempt count', () => {
  const summary = summaryOf(readPayload(SWITCHED), t)
  assert.equal(summary.text, 'Switched to OpenDesign / ACP-003 (attempt 2) · deepseek-v4.1-flash')
  assert.equal(summary.switched, true)
  assert.equal(summary.attempt, 2)
  assert.equal(summary.details, true)
})

test('a redacted route keeps the alias and says why', () => {
  const redacted = {
    ...SWITCHED,
    route: { alias: 'balance/deepseek-flash', channel: null, account: null, upstreamModel: null },
  }
  const summary = summaryOf(readPayload(redacted), t)
  assert.equal(summary.text, 'Switched to balance/deepseek-flash (attempt 2) · Gateway did not disclose the upstream channel')
})

test('history rows carry where, outcome, status, and time', () => {
  const rows = historyRows(readPayload(SWITCHED), t)
  assert.equal(rows.length, 1)
  assert.match(rows[0].text, /^Attempt 1 · CommandCode \/ ACP-002 · quota cooldown · HTTP 429 · /u)
})

test('an unknown outcome falls back to its raw gateway value', () => {
  const rows = historyRows(readPayload({
    ...SWITCHED,
    history: [{ attempt: 1, outcome: 'upstream_tantrum', at: '2026-11-11T16:22:31.000Z' }],
  }), t)
  assert.match(rows[0].text, /upstream_tantrum/u)
})

test('timestamps render in the reader clock and survive garbage', () => {
  assert.notEqual(formatTime('2026-11-11T16:22:31.000Z'), '2026-11-11T16:22:31.000Z')
  assert.equal(formatTime('not-a-date'), 'not-a-date')
})

test('both shipped languages cover every card key', () => {
  const english = Object.keys(DICTS.en).sort()
  assert.deepEqual(Object.keys(DICTS.zh).sort(), english)
  for (const key of english) {
    assert.equal(typeof DICTS.zh[key], 'string')
    assert.notEqual(DICTS.zh[key], '')
  }
})
