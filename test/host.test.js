import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { apply, readOptions } from '../src/host/index.js'

/**
 * Resolve the installed Session package the way the Host does, so this test
 * exercises the real `appendPluginRecord()` contract instead of a stand-in.
 * @returns {{ packageDir: string, Session: object } | undefined} resolved package facts.
 */
function resolveSessionPackage() {
  const anchor = join(process.env.HOME ?? '', '.dsh', 'profiles', 'web', 'package.json')
  if (!existsSync(anchor)) return undefined
  try {
    const resolved = realpathSync(createRequire(anchor).resolve('@deepseek-ai/dsh-session'))
    let directory = dirname(resolved)
    for (let depth = 0; depth < 5; depth += 1) {
      const manifest = join(directory, 'package.json')
      if (existsSync(manifest)) {
        if (JSON.parse(readFileSync(manifest, 'utf8'))?.name === '@deepseek-ai/dsh-session') {
          return { packageDir: directory, modulePath: resolved }
        }
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
    return undefined
  } catch {
    return undefined
  }
}

const sessionPackage = resolveSessionPackage()
const skip = sessionPackage === undefined ? 'the installed dsh-session package is unavailable' : false

/**
 * Import the Session module exactly as the record writer would.
 * @returns {Promise<object>} module namespace.
 */
async function loadSessionModule() {
  return import(pathToFileURL(sessionPackage.modulePath).href)
}

/**
 * Build a profile directory whose `node_modules` links the installed package, so
 * the record writer resolves the same module instance the Host loads.
 * @returns {string} profile directory.
 */
function makeProfileDir() {
  const directory = mkdtempSync(join(tmpdir(), 'portara-profile-'))
  mkdirSync(join(directory, 'node_modules', '@deepseek-ai'), { recursive: true })
  symlinkSync(sessionPackage.packageDir, join(directory, 'node_modules', '@deepseek-ai', 'dsh-session'), 'dir')
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'portara-test-profile', private: true }))
  writeFileSync(join(directory, 'cordis.yml'), '')
  return directory
}

/**
 * Minimal plugin context exposing only what the host half reads.
 * @param {{ profileDir: string, baseURL: string, apiKeyEnv: string, apiKey: string }} facts - composition.
 * @returns {object} fake context with listener dispatch helpers.
 */
function fakeContext(facts) {
  const listeners = new Map()
  const commands = []
  const agents = new Map()
  const ctx = {
    baseUrl: pathToFileURL(join(facts.profileDir, 'cordis.yml')).href,
    logger: { warn: () => {} },
    agents: { get: id => agents.get(id) },
    llm: {
      listConfigurableProviders: () => [{
        provider: 'gw',
        displayName: 'Gateway',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'gw'],
      }],
    },
    get(key) {
      if (key === 'loader') {
        return {
          resolve: id => (id === 'llm-pi-ai'
            ? { options: { config: { providers: { gw: { baseURL: facts.baseURL, apiKeyEnv: facts.apiKeyEnv } } } } }
            : undefined),
        }
      }
      if (key === 'credentials') {
        return { resolve: async ref => (ref === facts.apiKeyEnv ? { value: facts.apiKey } : undefined) }
      }
      return undefined
    },
    inject(_services, callback) {
      callback({
        effect: (setup) => { setup(); return () => {} },
        commands: {
          register(definition) {
            commands.push(definition)
            return () => {}
          },
        },
      })
      return () => {}
    },
    effect(setup) {
      setup()
      return () => {}
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
  }
  return {
    ctx,
    agents,
    commands,
    /** Dispatch the `llm/stream` waterfall for one fake call. */
    async runStream(request, chunks) {
      const handler = listeners.get('llm/stream')?.[0]
      assert.equal(typeof handler, 'function', 'llm/stream listener was installed')
      const downstream = () => (async function* () { for (const chunk of chunks) yield chunk })()
      for await (const _chunk of handler(request, downstream)) { /* drain */ }
    },
    /** Dispatch the pi-ai header waterfall for one fake call. */
    runHeaders(request) {
      const handler = listeners.get('llm-pi-ai/request-headers')?.[0]
      assert.equal(typeof handler, 'function', 'header listener was installed')
      const headers = new Headers()
      return handler(request, headers, () => headers)
    },
  }
}

/**
 * Wait until a predicate holds, polling the microtask queue.
 * @param {() => boolean} predicate - condition.
 * @param {number} [timeoutMs] - bound.
 * @returns {Promise<void>} fulfillment once true.
 */
async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * Read every committed plugin record from a Session.
 * @param {object} session - Session instance.
 * @returns {object[]} plugin records.
 */
function recordsOf(session) {
  const records = []
  for (let seq = 0; seq < Number(session.seq); seq += 1) {
    const event = session.eventAt(seq)
    if (event?.type === 'plugin:portara/route') records.push(event)
  }
  return records
}

test('options default to observation on, with bounded timing', () => {
  assert.deepEqual(readOptions(undefined), {
    enabled: true,
    timeoutMs: 1500,
    pollIntervalMs: 2000,
    injectSessionHeader: true,
    gateways: [],
  })
  const configured = readOptions({
    enabled: false,
    timeoutMs: 99_999,
    pollIntervalMs: 1,
    injectSessionHeader: false,
    gateways: [{ baseURL: 'https://gw.example/v1/', apiKeyEnv: 'GW_KEY' }, { baseURL: 'not-a-url' }, 'junk'],
  })
  assert.equal(configured.enabled, false)
  assert.equal(configured.timeoutMs, 10_000)
  assert.equal(configured.pollIntervalMs, 1)
  assert.equal(configured.injectSessionHeader, false)
  assert.deepEqual(configured.gateways, [{ baseURL: 'https://gw.example/v1', apiKeyEnv: 'GW_KEY' }])
})

test('an unknown config object still activates with defaults', () => {
  assert.deepEqual(readOptions({ future: true }), readOptions({}))
  assert.equal(readOptions(null).enabled, true)
})

test('a routed reply becomes exactly one durable card record', { skip }, async () => {
  const { Session } = await loadSessionModule()
  const profileDir = makeProfileDir()
  const body = {
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
  const server = createServer((request, response) => {
    if (request.url !== '/v1/route-info' || request.headers.authorization !== 'Bearer secret') {
      response.writeHead(401)
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const baseURL = `http://127.0.0.1:${port}/v1`
  try {
    const harness = fakeContext({ profileDir, baseURL, apiKeyEnv: 'GW_KEY', apiKey: 'secret' })
    apply(harness.ctx, { timeoutMs: 500, pollIntervalMs: 0 })
    await until(() => harness.ctx !== undefined)
    // Discovery runs once at activation; wait for that single probe to report.
    await new Promise(resolve => setTimeout(resolve, 200))

    const session = Session.create('portara-test-session')
    harness.agents.set('portara-test-session', { session })

    const headers = harness.runHeaders({ sessionId: 'portara-test-session', provider: 'gw', baseURL })
    assert.equal(headers.get('x-portara-client-session'), 'portara-test-session')

    await harness.runStream(
      { sessionId: 'portara-test-session', provider: 'gw', purpose: undefined },
      [{ type: 'finish', reason: { kind: 'stop' } }],
    )
    await until(() => recordsOf(session).length === 1)

    const records = recordsOf(session)
    assert.equal(records.length, 1)
    assert.equal(records[0].ignorable, true)
    assert.equal(records[0].data.sessionKey, '8ff4d582')
    assert.equal(records[0].data.route.channel, 'OpenDesign')

    // The same facts must never stack a second card.
    await harness.runStream(
      { sessionId: 'portara-test-session', provider: 'gw', purpose: undefined },
      [{ type: 'finish', reason: { kind: 'stop' } }],
    )
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(recordsOf(session).length, 1)
  } finally {
    await new Promise(resolve => server.close(() => resolve()))
  }
})

test('auxiliary calls, missing sessions, and unreachable gateways write nothing', { skip }, async () => {
  const { Session } = await loadSessionModule()
  const profileDir = makeProfileDir()
  const server = createServer((_request, response) => {
    response.writeHead(500)
    response.end('down')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const harness = fakeContext({
      profileDir,
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKeyEnv: 'GW_KEY',
      apiKey: 'secret',
    })
    apply(harness.ctx, { timeoutMs: 200, pollIntervalMs: 0 })
    const session = Session.create('portara-quiet-session')
    harness.agents.set('portara-quiet-session', { session })

    await harness.runStream(
      { sessionId: 'portara-quiet-session', provider: 'gw', purpose: 'session-title' },
      [{ type: 'finish', reason: { kind: 'stop' } }],
    )
    await harness.runStream(
      { provider: 'gw' },
      [{ type: 'finish', reason: { kind: 'stop' } }],
    )
    await harness.runStream(
      { sessionId: 'missing-session', provider: 'gw' },
      [{ type: 'finish', reason: { kind: 'stop' } }],
    )
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.deepEqual(recordsOf(session), [])
  } finally {
    await new Promise(resolve => server.close(() => resolve()))
  }
})

/**
 * Start one local gateway that answers route-info with fixed facts.
 * @param {object} body - response payload.
 * @param {Array<object>} [seen] - collector for request headers.
 * @returns {Promise<{ baseURL: string, close: () => Promise<void> }>} server facts.
 */
async function routeGateway(body, seen = []) {
  const server = createServer((request, response) => {
    seen.push({ url: request.url, session: request.headers['x-portara-client-session'] })
    if (request.url !== '/v1/route-info' || request.headers.authorization !== 'Bearer secret') {
      response.writeHead(401)
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

test('session coordinates carry the Turn opening sequence', async () => {
  const { sessionCoordinates } = await import('../src/host/records.js')
  const events = {
    0: { type: 'turn/start', data: { turn: 7 } },
    1: { type: 'user/message', data: { turn: 7 } },
    2: { type: 'step/start', data: { turn: 7, step: 1 } },
    3: { type: 'assistant/message', data: { turn: 7, step: 1 } },
    4: { type: 'step/end', data: { turn: 7, step: 1 } },
    5: { type: 'step/start', data: { turn: 7, step: 2 } },
    6: { type: 'plugin:portara/route', data: { turn: 7, step: 2 } },
  }
  const session = { seq: 7, eventAt: (seq) => events[seq] }
  const coordinates = sessionCoordinates(session)
  assert.equal(coordinates.turn, 7)
  assert.equal(coordinates.step, 2)
  // The first step of the Turn, not the newest one.
  assert.equal(coordinates.anchorSeq, 2)
})

test('the /portara command registers with the route predicate', { skip }, async () => {
  const harness = fakeContext({ profileDir: makeProfileDir(), baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'K', apiKey: 'k' })
  apply(harness.ctx, { timeoutMs: 200, pollIntervalMs: 0 })
  const definition = harness.commands[0]
  assert.equal(definition.name, 'portara')
  assert.deepEqual(definition.input, { hint: 'route' })
  assert.match(definition.description, /gateway route/u)
})

test('/portara route prints channel, account, and model, then refreshes the card', { skip }, async () => {
  const { Session } = await loadSessionModule()
  const harness = fakeContext({ profileDir: makeProfileDir(), baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'K', apiKey: 'secret' })
  const seen = []
  const gateway = await routeGateway({
    object: 'route.info',
    sessionKey: 'k',
    updatedAt: '2026-11-14T14:06:48.010Z',
    route: {
      alias: 'balance/deepseek-flash',
      channel: 'OpenDesign',
      account: 'ACP-003',
      upstreamModel: 'deepseek-v4.1-flash',
    },
    history: [{
      attempt: 1, channel: 'CommandCode', account: 'ACP-002',
      outcome: 'quota_cooldown', statusCode: 429, reason: 'switched', at: '2026-11-14T14:06:31.000Z',
    }],
  }, seen)
  // Point the profile at the live gateway for this test.
  const originalGet = harness.ctx.get.bind(harness.ctx)
  harness.ctx.get = key => (key === 'loader'
    ? { resolve: () => ({ options: { config: { providers: { gw: { baseURL: gateway.baseURL, apiKeyEnv: 'K' } } } } }) }
    : originalGet(key))
  try {
    apply(harness.ctx, { timeoutMs: 500, pollIntervalMs: 0 })
    const session = Session.create('portara-command-session')
    harness.agents.set('portara-command-session', { session })
    const definition = harness.commands[0]
    const result = await definition.handler({ rawInput: ' route', agent: { session } })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /Routed to OpenDesign \/ ACP-003 · deepseek-v4\.1-flash/u)
    assert.match(result.text, /alias balance\/deepseek-flash/u)
    assert.match(result.text, /1\. CommandCode \/ ACP-002 · quota_cooldown · HTTP 429/u)
    await until(() => recordsOf(session).length === 1)
    const record = recordsOf(session)[0]
    assert.equal(record.data.route.channel, 'OpenDesign')
    assert.equal(seen.at(-1).session, 'portara-command-session')
  } finally {
    await gateway.close()
  }
})

test('/portara answers help, unknown verbs, and an answering gateway without a route', { skip }, async () => {
  const { Session } = await loadSessionModule()
  const harness = fakeContext({ profileDir: makeProfileDir(), baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'K', apiKey: 'secret' })
  const gateway = await routeGateway({
    object: 'route.info',
    sessionKey: 'k',
    updatedAt: null,
    route: { alias: null, channel: null, account: null, upstreamModel: null },
    history: [],
  })
  const originalGet = harness.ctx.get.bind(harness.ctx)
  harness.ctx.get = key => (key === 'loader'
    ? { resolve: () => ({ options: { config: { providers: { gw: { baseURL: gateway.baseURL, apiKeyEnv: 'K' } } } } }) }
    : originalGet(key))
  try {
    apply(harness.ctx, { timeoutMs: 500, pollIntervalMs: 0 })
    const session = Session.create('portara-command-quiet')
    harness.agents.set('portara-command-quiet', { session })
    const definition = harness.commands[0]

    const help = await definition.handler({ rawInput: '', agent: { session } })
    assert.equal(help.kind, 'success')
    assert.match(help.text, /Usage: \/portara route/u)

    const unknown = await definition.handler({ rawInput: 'nope', agent: { session } })
    assert.equal(unknown.kind, 'error')
    assert.match(unknown.text, /Unknown verb "nope"/u)

    const empty = await definition.handler({ rawInput: 'route', agent: { session } })
    assert.equal(empty.kind, 'success')
    assert.match(empty.text, /answered without routing information/u)
    assert.match(empty.text, /exposeRoutingInfo/u)
    assert.deepEqual(recordsOf(session), [])
  } finally {
    await gateway.close()
  }
})

test('/portara route falls back to the session\'s last recorded route', { skip }, async () => {
  const { Session, appendPluginRecord } = await loadSessionModule()
  const harness = fakeContext({ profileDir: makeProfileDir(), baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'K', apiKey: 'secret' })
  const gateway = await routeGateway({
    object: 'route.info',
    sessionKey: 'k',
    updatedAt: null,
    route: { alias: null, channel: null, account: null, upstreamModel: null },
    history: [],
  })
  const originalGet = harness.ctx.get.bind(harness.ctx)
  harness.ctx.get = key => (key === 'loader'
    ? { resolve: () => ({ options: { config: { providers: { gw: { baseURL: gateway.baseURL, apiKeyEnv: 'K' } } } } }) }
    : originalGet(key))
  try {
    apply(harness.ctx, { timeoutMs: 500, pollIntervalMs: 0 })
    const session = Session.create('portara-recorded-session')
    harness.agents.set('portara-recorded-session', { session })
    appendPluginRecord(session, 'plugin:portara/route', {
      version: 1,
      sessionKey: 'k',
      updatedAt: '2026-11-14T14:26:23.335Z',
      route: {
        alias: 'balance/deepseek-flash',
        channel: 'OpenDesign',
        account: 'ACP-003',
        upstreamModel: 'deepseek/deepseek-v4.1-flash',
      },
      history: [{
        attempt: 1, channel: 'CommandCode', account: 'ACP-002',
        outcome: 'quota_cooldown', statusCode: 429, reason: 'switched', at: '2026-11-14T14:26:01.000Z',
      }],
      turn: 3,
      step: 1,
    })
    const definition = harness.commands[0]
    const result = await definition.handler({ rawInput: 'route', agent: { session } })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /Routed to OpenDesign \/ ACP-003 · deepseek\/deepseek-v4\.1-flash/u)
    assert.match(result.text, /1\. CommandCode \/ ACP-002 · quota_cooldown · HTTP 429/u)
    assert.match(result.text, /Last recorded route/u)
  } finally {
    await gateway.close()
  }
})

test('/portara route prefers live data over the recorded fallback', { skip }, async () => {
  const { Session, appendPluginRecord } = await loadSessionModule()
  const harness = fakeContext({ profileDir: makeProfileDir(), baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'K', apiKey: 'secret' })
  const gateway = await routeGateway({
    object: 'route.info',
    sessionKey: 'k',
    updatedAt: '2026-11-15T00:00:00.000Z',
    route: {
      alias: 'balance/deepseek-flash',
      channel: 'CommandCode',
      account: 'ACP-004',
      upstreamModel: 'deepseek/deepseek-v4.1-flash',
    },
    history: [],
  })
  const originalGet = harness.ctx.get.bind(harness.ctx)
  harness.ctx.get = key => (key === 'loader'
    ? { resolve: () => ({ options: { config: { providers: { gw: { baseURL: gateway.baseURL, apiKeyEnv: 'K' } } } } }) }
    : originalGet(key))
  try {
    apply(harness.ctx, { timeoutMs: 500, pollIntervalMs: 0 })
    const session = Session.create('portara-live-priority')
    harness.agents.set('portara-live-priority', { session })
    appendPluginRecord(session, 'plugin:portara/route', {
      version: 1,
      sessionKey: 'k',
      updatedAt: '2026-11-01T00:00:00.000Z',
      route: { alias: 'old', channel: 'OldChannel', account: 'OLD', upstreamModel: 'old/model' },
      history: [],
    })
    const result = await harness.commands[0].handler({ rawInput: 'route', agent: { session } })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /Routed to CommandCode \/ ACP-004/u)
    assert.doesNotMatch(result.text, /Last recorded route/u)
    assert.doesNotMatch(result.text, /old\/model/u)
  } finally {
    await gateway.close()
  }
})
