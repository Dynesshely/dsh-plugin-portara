import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { fetchRouteInfo, routeInfoUrl } from '../src/host/gateway.js'

/**
 * Start one local server for a test case.
 * @param {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void} handler - route handler.
 * @returns {Promise<{ baseURL: string, close: () => Promise<void> }>} server facts.
 */
async function serverFor(handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

test('route-info URL joins the configured base URL', () => {
  assert.equal(routeInfoUrl('https://gateway.example/v1'), 'https://gateway.example/v1/route-info')
  assert.equal(routeInfoUrl('https://gateway.example/v1/'), 'https://gateway.example/v1/route-info')
  assert.equal(routeInfoUrl('ftp://gateway.example/v1'), undefined)
  assert.equal(routeInfoUrl(''), undefined)
  assert.equal(routeInfoUrl(undefined), undefined)
})

test('a reachable endpoint yields the parsed body and sends the session header', async () => {
  let seen
  const server = await serverFor((request, response) => {
    seen = {
      url: request.url,
      authorization: request.headers.authorization,
      session: request.headers['x-portara-client-session'],
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ object: 'route.info', sessionKey: 'abc' }))
  })
  try {
    const body = await fetchRouteInfo({ ...server, apiKey: 'secret', sessionKey: 'session-1' })
    assert.equal(body.object, 'route.info')
    assert.equal(seen.url, '/v1/route-info')
    assert.equal(seen.authorization, 'Bearer secret')
    assert.equal(seen.session, 'session-1')
  } finally {
    await server.close()
  }
})

test('a non-200 answer is silent', async () => {
  const server = await serverFor((_request, response) => {
    response.writeHead(404)
    response.end('missing')
  })
  try {
    assert.equal(await fetchRouteInfo({ ...server, apiKey: 'secret', sessionKey: 'session-1' }), undefined)
  } finally {
    await server.close()
  }
})

test('malformed JSON and oversized bodies are silent', async () => {
  const malformed = await serverFor((_request, response) => {
    response.writeHead(200)
    response.end('{not json')
  })
  try {
    assert.equal(await fetchRouteInfo({ ...malformed, apiKey: 'secret', sessionKey: 's' }), undefined)
  } finally {
    await malformed.close()
  }

  const oversized = await serverFor((_request, response) => {
    response.writeHead(200)
    response.end('x'.repeat(70 * 1024))
  })
  try {
    assert.equal(await fetchRouteInfo({ ...oversized, apiKey: 'secret', sessionKey: 's' }), undefined)
  } finally {
    await oversized.close()
  }
})

test('an unreachable endpoint and a timeout are silent', async () => {
  assert.equal(await fetchRouteInfo({
    baseURL: 'http://127.0.0.1:1/v1', apiKey: 'secret', sessionKey: 's', timeoutMs: 300,
  }), undefined)

  const slow = await serverFor((_request, response) => {
    setTimeout(() => {
      response.writeHead(200)
      response.end('{"object":"route.info"}')
    }, 500)
  })
  try {
    assert.equal(await fetchRouteInfo({ ...slow, apiKey: 'secret', sessionKey: 's', timeoutMs: 100 }), undefined)
  } finally {
    await slow.close()
  }
})

test('the answer is dropped when routing data is missing entirely', async () => {
  const server = await serverFor((_request, response) => {
    response.writeHead(200)
    response.end(JSON.stringify({ items: [] }))
  })
  try {
    const body = await fetchRouteInfo({ ...server, apiKey: 'secret', sessionKey: 's' })
    assert.deepEqual(body, { items: [] })
  } finally {
    await server.close()
  }
})
