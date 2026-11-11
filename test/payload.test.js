import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeRouteInfo, recordSignature, RECORD_TYPE, PAYLOAD_VERSION } from '../src/payload.js'

const ROUTED = {
  object: 'route.info',
  sessionKey: '8ff4d582',
  updatedAt: '2026-11-11T16:22:39.250Z',
  route: {
    alias: 'balance/deepseek-flash',
    channel: 'OpenDesign',
    account: 'ACP-003',
    upstreamModel: 'deepseek-v4.1-flash',
  },
  history: [],
}

test('record type is the reload-safe plugin namespace', () => {
  assert.equal(RECORD_TYPE, 'plugin:portara/route')
  assert.match(RECORD_TYPE, /^plugin:[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u)
})

test('a full route becomes one versioned payload', () => {
  const payload = normalizeRouteInfo(ROUTED)
  assert.deepEqual(payload, {
    version: PAYLOAD_VERSION,
    sessionKey: '8ff4d582',
    updatedAt: '2026-11-11T16:22:39.250Z',
    route: {
      alias: 'balance/deepseek-flash',
      channel: 'OpenDesign',
      account: 'ACP-003',
      upstreamModel: 'deepseek-v4.1-flash',
    },
    history: [],
  })
})

test('an empty answer writes nothing', () => {
  const empty = {
    object: 'route.info',
    sessionKey: '8ff4d582',
    updatedAt: null,
    route: { alias: null, channel: null, account: null, upstreamModel: null },
    history: [],
  }
  assert.equal(normalizeRouteInfo(empty), undefined)
})

test('a redacted answer keeps the alias and the switch facts', () => {
  const payload = normalizeRouteInfo({
    ...ROUTED,
    route: { alias: 'balance/deepseek-flash', channel: null, account: null, upstreamModel: null },
    history: [
      {
        attempt: 1,
        channel: null,
        account: null,
        outcome: 'attempt_failed',
        statusCode: 429,
        reason: 'switched',
        at: '2026-11-11T16:22:31.000Z',
      },
      {
        attempt: 2,
        channel: null,
        account: null,
        outcome: 'failover_success',
        statusCode: null,
        reason: 'ok',
        at: '2026-11-11T16:22:39.000Z',
      },
    ],
  })
  assert.equal(payload.route.channel, null)
  assert.equal(payload.history.length, 2)
  assert.equal(payload.history[1].statusCode, null)
  assert.equal(payload.history[0].reason, 'switched')
})

test('coordinates place the row inside a step only when both are known', () => {
  assert.deepEqual(normalizeRouteInfo(ROUTED, { turn: 3, step: 1 }).turn, 3)
  assert.equal(normalizeRouteInfo(ROUTED, { turn: 3, step: 1 }).step, 1)
  assert.equal(normalizeRouteInfo(ROUTED, { turn: 3 }).turn, 3)
  assert.equal('step' in normalizeRouteInfo(ROUTED, { turn: 3 }), false)
  assert.equal('turn' in normalizeRouteInfo(ROUTED, { turn: -1, step: 0 }), false)
})

test('malformed answers are rejected rather than trusted', () => {
  assert.equal(normalizeRouteInfo(undefined), undefined)
  assert.equal(normalizeRouteInfo('route.info'), undefined)
  assert.equal(normalizeRouteInfo({ object: 'other' }), undefined)
  assert.equal(normalizeRouteInfo({ ...ROUTED, sessionKey: '   ' }), undefined)
  assert.equal(normalizeRouteInfo({ ...ROUTED, route: null }), undefined)
  assert.equal(normalizeRouteInfo({ ...ROUTED, route: [] }), undefined)
})

test('history entries without a timestamp or outcome are dropped', () => {
  const payload = normalizeRouteInfo({
    ...ROUTED,
    history: [
      { attempt: 1, outcome: 'attempt_failed', at: '2026-11-11T16:22:31.000Z' },
      { attempt: 2, outcome: 'quota_cooldown' },
      { attempt: 3, at: '2026-11-11T16:22:33.000Z' },
      'not-an-object',
    ],
  })
  assert.equal(payload.history.length, 1)
  assert.equal(payload.history[0].attempt, 1)
  assert.equal(payload.history[0].channel, null)
})

test('history is bounded to the documented window', () => {
  const history = Array.from({ length: 80 }, (_, index) => ({
    attempt: index + 1,
    outcome: 'attempt_failed',
    at: `2026-11-11T16:22:${String(index % 60).padStart(2, '0')}.000Z`,
  }))
  assert.equal(normalizeRouteInfo({ ...ROUTED, history }).history.length, 50)
})

test('the dedupe signature ignores irrelevant rewrites and tracks routing facts', () => {
  const first = normalizeRouteInfo(ROUTED)
  const same = normalizeRouteInfo({ ...ROUTED, route: { ...ROUTED.route } })
  assert.equal(recordSignature(first), recordSignature(same))

  const switched = normalizeRouteInfo({
    ...ROUTED,
    history: [{ attempt: 1, outcome: 'attempt_failed', at: '2026-11-11T16:22:31.000Z' }],
  })
  assert.notEqual(recordSignature(first), recordSignature(switched))

  const rerouted = normalizeRouteInfo({ ...ROUTED, route: { ...ROUTED.route, account: 'ACP-004' } })
  assert.notEqual(recordSignature(first), recordSignature(rerouted))
})

test('overlong gateway strings are bounded', () => {
  const payload = normalizeRouteInfo({ ...ROUTED, sessionKey: 'x'.repeat(400) })
  assert.equal(payload.sessionKey.length, 128)
})
