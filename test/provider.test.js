import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import {
  discoverGateways, providerProfiles, resolveCredential, sessionHeaderValue,
} from '../src/host/provider.js'

/**
 * Fake plugin context with one Loader entry and one configurable provider.
 * @param {{ credentials?: { resolve: (ref: string) => Promise<{ value: string } | undefined> } }} [extra] - optional seams.
 * @returns {object} fake context.
 */
function fakeContext(extra = {}) {
  return {
    baseUrl: 'file:///tmp/dsh-plugin-portara-test/cordis.yml',
    llm: {
      listConfigurableProviders: () => [{
        provider: 'gw',
        displayName: 'Gateway',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'gw'],
      }, {
        provider: 'plain',
        displayName: 'Plain',
        settingsNs: 'llm-plain',
        settingsPath: ['providers', 'plain'],
      }],
    },
    get(key) {
      if (key === 'loader') {
        return {
          resolve: id => (id === 'llm-pi-ai'
            ? { options: { config: { providers: { gw: { baseURL: 'https://gw.example/v1/', apiKeyEnv: 'GW_KEY' } } } } }
            : undefined),
        }
      }
      return extra[key]
    },
  }
}

test('provider profiles come from the live Loader entry, not a hard-coded list', () => {
  assert.deepEqual(providerProfiles(fakeContext()), [
    { provider: 'gw', baseURL: 'https://gw.example/v1/', apiKeyEnv: 'GW_KEY' },
  ])
})

test('provider profiles tolerate a missing directory and missing profiles', () => {
  assert.deepEqual(providerProfiles({}), [])
  assert.deepEqual(providerProfiles({ llm: { listConfigurableProviders: () => [{ provider: 'x' }] } }), [])
})

test('a provider nested under an include entry is still found by its local id', () => {
  const nested = {
    llm: {
      listConfigurableProviders: () => [{
        provider: 'gw', displayName: 'Gateway', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'gw'],
      }],
    },
    get(key) {
      if (key !== 'loader') return undefined
      return {
        // Tree-path ids only: the profile root is an include entry.
        resolve: id => { throw new Error(`cannot resolve entry ${id}`) },
        entries: () => [{
          id: 'include:llm-pi-ai',
          options: { id: 'llm-pi-ai', config: { providers: { gw: { baseURL: 'https://gw.example/v1', apiKeyEnv: 'GW_KEY' } } } },
        }],
      }
    },
  }
  assert.deepEqual(providerProfiles(nested), [
    { provider: 'gw', baseURL: 'https://gw.example/v1', apiKeyEnv: 'GW_KEY' },
  ])
})

test('a broken provider directory never throws', () => {
  const broken = {
    llm: { listConfigurableProviders: () => { throw new Error('directory exploded') } },
  }
  assert.deepEqual(providerProfiles(broken), [])
  const throwingLoader = {
    llm: {
      listConfigurableProviders: () => [{
        provider: 'gw', displayName: 'Gateway', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'gw'],
      }],
    },
    get(key) {
      if (key !== 'loader') return undefined
      return {
        resolve: () => { throw new Error('nope') },
        entries: () => { throw new Error('nope') },
      }
    },
  }
  assert.deepEqual(providerProfiles(throwingLoader), [])
})

test('the session header is only sent to a confirmed gateway endpoint', () => {
  const gateways = new Set(['https://gw.example/v1'])
  assert.equal(
    sessionHeaderValue({ sessionId: 'session-1', baseURL: 'https://gw.example/v1' }, gateways),
    'session-1',
  )
  assert.equal(
    sessionHeaderValue({ sessionId: 'session-1', baseURL: 'https://other.example/v1' }, gateways),
    undefined,
  )
  assert.equal(sessionHeaderValue({ sessionId: '', baseURL: 'https://gw.example/v1' }, gateways), undefined)
  assert.equal(sessionHeaderValue({ baseURL: 'https://gw.example/v1' }, gateways), undefined)
  assert.equal(sessionHeaderValue(null, gateways), undefined)
})

test('credentials resolve through the service, then the environment', async () => {
  const ctx = fakeContext({
    credentials: { resolve: async ref => (ref === 'GW_KEY' ? { value: 'from-service' } : undefined) },
  })
  assert.equal(await resolveCredential(ctx, 'GW_KEY'), 'from-service')

  process.env.PORTARA_TEST_KEY = 'from-env'
  try {
    assert.equal(await resolveCredential(fakeContext(), 'PORTARA_TEST_KEY'), 'from-env')
  } finally {
    delete process.env.PORTARA_TEST_KEY
  }
  assert.equal(await resolveCredential(fakeContext(), ''), undefined)
})

test('discovery confirms only endpoints that answer as a route-info data plane', async () => {
  const requests = []
  const server = createServer((request, response) => {
    requests.push({ url: request.url, session: request.headers['x-portara-client-session'] })
    if (request.url === '/v1/route-info') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        object: 'route.info',
        sessionKey: 'probe',
        updatedAt: null,
        route: { alias: null, channel: null, account: null, upstreamModel: null },
        history: [],
      }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const ctx = {
    baseUrl: 'file:///tmp/dsh-plugin-portara-test/cordis.yml',
    llm: {
      listConfigurableProviders: () => [{
        provider: 'gw', displayName: 'Gateway', settingsNs: 'llm-http', settingsPath: ['providers', 'gw'],
      }, {
        provider: 'other', displayName: 'Other', settingsNs: 'llm-http', settingsPath: ['providers', 'other'],
      }],
    },
    get(key) {
      if (key === 'loader') {
        return {
          resolve: () => ({
            options: {
              config: {
                providers: {
                  gw: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'GW_KEY' },
                  other: { baseURL: `http://127.0.0.1:${address.port}/other`, apiKeyEnv: 'GW_KEY' },
                },
              },
            },
          }),
        }
      }
      if (key === 'credentials') return { resolve: async () => ({ value: 'secret' }) }
      return undefined
    },
  }
  const signal = new AbortController().signal
  try {
    const gateways = await discoverGateways(ctx, { signal, timeoutMs: 1000 })
    assert.deepEqual([...gateways.keys()], [`http://127.0.0.1:${address.port}/v1`])
    assert.equal(gateways.get(`http://127.0.0.1:${address.port}/v1`), 'secret')
    assert.ok(requests.every(row => row.url.endsWith('/route-info')))
    assert.ok(requests.every(row => row.session === 'dsh-plugin-portara-discovery'))
  } finally {
    await new Promise(resolve => server.close(() => resolve()))
  }
})
