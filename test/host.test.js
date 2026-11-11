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
