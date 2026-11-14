import assert from 'node:assert/strict'
import { test } from 'node:test'

/** Captured Client module registration. */
let loaded

/** Hook slots for the stub React runtime, reset before each render. */
let hookSlots = []
let hookIndex = 0

/**
 * Stub `react` for the headless render checks below.
 * @returns {object} minimal React surface.
 */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useMemo: compute => compute(),
    useState: (initial) => {
      const slot = hookIndex
      hookIndex += 1
      if (!(slot in hookSlots)) hookSlots[slot] = initial
      return [hookSlots[slot], value => {
        hookSlots[slot] = typeof value === 'function' ? value(hookSlots[slot]) : value
      }]
    },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useCallback: value => value,
  }
}

/**
 * Reset the hook runtime between renders.
 * @returns {void}
 */
function resetHooks() {
  hookIndex = 0
  hookSlots = []
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

test('every registration is owned by a disposer', () => {
  const disposals = []
  const { ctx } = createClientContext()
  ctx.effect = (setup) => {
    const dispose = setup()
    disposals.push(dispose)
    return () => { if (typeof dispose === 'function') dispose() }
  }
  moduleNamespace.apply(ctx)
  // Two locale dictionaries and the Conversation Definition; the slot injection owns its registration.
  assert.equal(disposals.length, 3)
  for (const dispose of disposals) {
    assert.equal(typeof dispose, 'function')
    assert.doesNotThrow(() => dispose())
  }
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

test('a fully redacted switch still reports the attempt count', () => {
  const blind = {
    ...SWITCHED,
    route: { alias: null, channel: null, account: null, upstreamModel: null },
  }
  const summary = summaryOf(readPayload(blind), t)
  assert.equal(summary.text, 'Switched (attempt 2)')
  assert.equal(summary.switched, true)
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

/**
 * Minimal hook runtime so the component can be rendered without React DOM.
 * @returns {{ React: object, resetHooks: () => void, resetAll: () => void }} fake runtime.
 */
function createHookRuntime() {
  let states = []
  let index = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useMemo: compute => compute(),
    useState: (initial) => {
      const slot = index
      index += 1
      if (!(slot in states)) states[slot] = initial
      return [states[slot], value => { states[slot] = typeof value === 'function' ? value(states[slot]) : value }]
    },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
  return {
    React,
    resetHooks: () => { index = 0 },
    resetAll: () => { index = 0; states = [] },
  }
}

/**
 * Collect every text fragment of a rendered element tree.
 * @param {unknown} tree - rendered element or text.
 * @returns {string[]} text fragments in order.
 */
function textsOf(tree) {
  if (tree === null || tree === undefined) return []
  if (typeof tree === 'string') return [tree]
  if (Array.isArray(tree)) return tree.flatMap(textsOf)
  return textsOf(tree.children)
}

/**
 * Find the first element of one type in a rendered tree.
 * @param {unknown} tree - rendered element.
 * @param {string} type - element type to find.
 * @returns {object | undefined} matching element.
 */
function findElement(tree, type) {
  if (tree === null || typeof tree !== 'object') return undefined
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const found = findElement(child, type)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (tree.type === type) return tree
  return findElement(tree.children, type)
}

/**
 * Build the fake Client context the browser half registers against.
 * @returns {{ ctx: object, registrations: object }} context and captured registrations.
 */
function createClientContext() {
  const definitions = []
  const slots = []
  const registered = new Map()
  const ctx = {
    effect(setup) {
      const dispose = setup()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    locale: {
      register(ns, localeId, dict) {
        registered.set(`${ns}:${localeId}`, dict)
        return () => {}
      },
      bind() {
        return t
      },
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'en' }),
    },
    uiConversation: {
      events: {
        register(definition) {
          definitions.push(definition)
          return () => {}
        },
      },
    },
    slots: {
      inject(_key, callback) {
        callback()
        return () => {}
      },
      register(options, component) {
        slots.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, registrations: { definitions, slots, registered } }
}

test('apply registers one Chat definition, one keyed renderer, and the status label', () => {
  const { ctx, registrations } = createClientContext()
  moduleNamespace.apply(ctx)
  assert.equal(registrations.definitions.length, 1)
  const definition = registrations.definitions[0]
  assert.equal(definition.kind, 'portara-route')
  assert.equal(definition.target, 'chat')
  assert.equal(typeof definition.buildViewNode, 'function')
  assert.equal(registrations.slots.length, 2)
  assert.deepEqual(registrations.slots[0].options, {
    name: 'conversation.chat.node',
    key: 'portara-route',
  })
  assert.deepEqual(registrations.slots[1].options, {
    name: 'conversation.chat.assistant-actions',
    id: 'portara-route-model',
    order: 50,
  })
  assert.equal(typeof registrations.slots[0].component, 'function')
  assert.equal(typeof registrations.slots[1].component, 'function')
  assert.ok(registrations.registered.has('portara-route:en'))
  assert.ok(registrations.registered.has('portara-route:zh'))
})

test('the status row appends the routed model after the host-owned clock', () => {
  const { ctx, registrations } = createClientContext()
  moduleNamespace.apply(ctx)
  const label = registrations.slots.find(slot => slot.options.id === 'portara-route-model')
  const payload = readPayload(SWITCHED)
  const tree = label.component({
    useChat: selector => selector({ nodes: { values: () => [{ kind: 'portara-route', data: payload }] } }),
  })
  assert.equal(tree.type, 'span')
  assert.equal(tree.props.style.order, 1)
  assert.equal(tree.props.title, 'deepseek-v4.1-flash · OpenDesign · ACP-003')
  assert.match(textsOf(tree).join(''), /deepseek-v4\.1-flash/u)
  assert.doesNotMatch(textsOf(tree).join(''), /deepseek\/deepseek-v4\.1-flash/u)
})

test('the row keeps the routed model id whole and draws an outline glyph', () => {
  const { ctx, registrations } = createClientContext()
  moduleNamespace.apply(ctx)
  const label = registrations.slots.find(slot => slot.options.id === 'portara-route-model')
  const payload = readPayload({
    ...SWITCHED,
    route: { ...SWITCHED.route, upstreamModel: 'deepseek/deepseek-v4.1-flash' },
  })
  const tree = label.component({
    useChat: selector => selector({ nodes: { values: () => [{ kind: 'portara-route', data: payload }] } }),
  })
  const texts = textsOf(tree).join(' | ')
  assert.match(texts, /deepseek\/deepseek-v4\.1-flash/u)
  assert.doesNotMatch(texts, /⚡/u)
  const icon = findElement(tree, 'svg')
  assert.ok(icon !== undefined)
  assert.equal(icon.props.viewBox, '0 0 16 16')
  assert.equal(icon.props.stroke, 'currentColor')
  assert.equal(icon.props['aria-hidden'], 'true')
  assert.ok(findElement(icon, 'path') !== undefined)
  assert.equal(tree.props.title, 'deepseek/deepseek-v4.1-flash · OpenDesign · ACP-003')
})

test('the status label stays silent without a route and falls back to the alias', () => {
  const { ctx, registrations } = createClientContext()
  moduleNamespace.apply(ctx)
  const label = registrations.slots.find(slot => slot.options.id === 'portara-route-model')
  assert.equal(label.component({ useChat: selector => selector({ nodes: { values: () => [] } }) }), null)
  const redacted = readPayload({
    ...SWITCHED,
    route: { alias: 'balance/deepseek-flash', channel: null, account: null, upstreamModel: null },
  })
  const tree = label.component({
    useChat: selector => selector({ nodes: { values: () => [{ kind: 'portara-route', data: redacted }] } }),
  })
  assert.match(textsOf(tree).join(''), /deepseek-flash/u)
  assert.equal(tree.props.title, 'balance/deepseek-flash')
})

test('the definition matches only its own record type and keys by session', () => {
  const { ctx, registrations } = createClientContext()
  moduleNamespace.apply(ctx)
  const definition = registrations.definitions[0]
  const match = definition.match['plugin:portara/route']
  assert.deepEqual(
    match({ type: 'plugin:portara/route', data: { ...SWITCHED, sessionKey: 'abc' } }),
    { id: 'abc', role: 'start' },
  )
  assert.equal(match({ type: 'assistant/message', data: {} }), null)
  assert.equal(match({ type: 'plugin:portara/route', data: { sessionKey: '   ' } }), null)
  assert.equal(match({ type: 'plugin:portara/route', data: null }), null)
})

test('a view node carries the engine key, the anchor, and the payload', () => {
  const { ctx, registrations } = createClientContext()
  moduleNamespace.apply(ctx)
  const definition = registrations.definitions[0]
  const data = readPayload(SWITCHED)
  const node = definition.buildViewNode({
    key: 'portara-route:8ff4d582',
    kind: 'portara-route',
    id: '8ff4d582',
    state: data,
    start: { event: { seq: 42 }, location: { kind: 'step', turn: { turn: 3 }, step: { step: 1 } } },
    matches: [],
  })
  assert.deepEqual(node, {
    key: 'portara-route:8ff4d582',
    kind: 'portara-route',
    id: '8ff4d582',
    target: 'chat',
    anchorSeq: 42,
    location: { kind: 'step', turn: { turn: 3 }, step: { step: 1 } },
    visibility: 'visible',
    data,
  })
  assert.equal(definition.buildViewNode({ key: 'k', kind: 'portara-route', id: 'i', state: undefined, matches: [] }), null)
})

test('the rendered row shows the route summary and keeps details collapsed', () => {
  const { ctx, registrations } = createClientContext()
  moduleNamespace.apply(ctx)
  resetHooks()
  const tree = registrations.slots[0].component({ node: { data: readPayload(SWITCHED) } })
  const texts = textsOf(tree).join(' | ')
  assert.match(texts, /Switched to OpenDesign \/ ACP-003 \(attempt 2\) · deepseek-v4\.1-flash/u)
  assert.doesNotMatch(texts, /Attempt 1/u)
  const button = findElement(tree, 'button')
  assert.equal(button?.props['aria-expanded'], 'false')
  assert.equal(button?.props.type, 'button')
})

test('a non-routing payload renders nothing at all', () => {
  const { ctx, registrations } = createClientContext()
  moduleNamespace.apply(ctx)
  resetHooks()
  assert.equal(registrations.slots[0].component({ node: { data: {} } }), null)
})

test('expanding the row lists every failover attempt', () => {
  const { ctx, registrations } = createClientContext()
  moduleNamespace.apply(ctx)
  resetHooks()
  const node = { data: readPayload(SWITCHED) }
  const first = registrations.slots[0].component({ node })
  const button = findElement(first, 'button')
  button.props.onClick()
  // Re-render the same instance: hook slots persist, only the read cursor resets.
  hookIndex = 0
  const second = registrations.slots[0].component({ node })
  const texts = textsOf(second).join(' | ')
  assert.match(texts, /Attempt 1 · CommandCode \/ ACP-002 · quota cooldown · HTTP 429/u)
  assert.equal(findElement(second, 'button')?.props['aria-expanded'], 'true')
  hookIntact()
})

/**
 * Assert the hook runtime was actually exercised by the component.
 * @returns {void}
 */
function hookIntact() {
  assert.ok(hookSlots.length > 0)
}
