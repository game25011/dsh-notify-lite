/**
 * dsh-notify-lite — Host browser-transport tests.
 *
 * Drives the webServer-route fallback used when the official
 * `connection.rpc.handle` throws inside DSH 0.2.1-rc.2, with fake Node
 * request/response objects. No network, no Harness process.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { Writable } from 'node:stream'

const { __test } = await import('../lib/index.js')
const {
  endpointFromPathname,
  handleRpcRoute,
  readJsonBody,
} = __test

/** Build a fake IncomingMessage with a JSON body. */
function fakeRequest({ method = 'POST', url = '/dsh-notify-lite/health', body, headers = {}, aborted = false } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json', host: '127.0.0.1:54042', ...headers }
  req.aborted = aborted
  return req
}

/** Build a fake ServerResponse that captures status/headers/body. */
function fakeResponse() {
  const captured = { statusCode: 200, headers: {}, body: '', ended: false }
  const res = new Writable({
    write(chunk, _encoding, callback) {
      captured.body += chunk.toString()
      callback()
    },
  })
  res.statusCode = captured.statusCode
  res.setHeader = (name, value) => {
    captured.headers[String(name).toLowerCase()] = String(value)
  }
  res.on('finish', () => {
    captured.ended = true
  })
  res.capture = captured
  return res
}

const allowAll = { requestRejection: () => undefined }
const denyAll = { requestRejection: () => 403 }

function fakeState(handler) {
  return {
    handleRpc: handler ?? (async (endpoint, payload) => ({ ok: true, value: { endpoint, payload } })),
  }
}

function envelope(overrides = {}) {
  return { type: 'client-request', rpcId: 'rpc-1', method: 'health', payload: {}, ...overrides }
}

test('endpointFromPathname accepts the exact channel prefix only', () => {
  assert.equal(endpointFromPathname('/dsh-notify-lite/health'), 'health')
  assert.equal(endpointFromPathname('/dsh-notify-lite/poll'), 'poll')
  assert.equal(endpointFromPathname('/dsh-notify-lite'), undefined)
  assert.equal(endpointFromPathname('/dsh-notify-lite/'), undefined)
  assert.equal(endpointFromPathname('/dsh-notify-lite/a/b'), undefined)
  assert.equal(endpointFromPathname('/dsh-notify-lite/../secret'), undefined)
  assert.equal(endpointFromPathname('/other/health'), undefined)
})

test('a denied request is fenced with the official rejection status', async () => {
  const res = fakeResponse()
  await handleRpcRoute(fakeRequest({ body: envelope() }), res, fakeState(), denyAll)
  assert.equal(res.statusCode, 403)
  assert.equal(res.capture.body, 'forbidden')
})

test('a connection without requestRejection is fenced fail-closed', async () => {
  const res = fakeResponse()
  await handleRpcRoute(fakeRequest({ body: envelope() }), res, fakeState(), {})
  assert.equal(res.statusCode, 403)
  assert.equal(res.capture.body, 'forbidden')
})

test('non-POST requests are rejected with 405 and an allow header', async () => {
  const res = fakeResponse()
  await handleRpcRoute(fakeRequest({ method: 'GET', body: envelope() }), res, fakeState(), allowAll)
  assert.equal(res.statusCode, 405)
  assert.equal(res.capture.headers.allow, 'POST')
})

test('unknown paths under the prefix return 404', async () => {
  const res = fakeResponse()
  await handleRpcRoute(fakeRequest({ url: '/dsh-notify-lite/a/b', body: envelope() }), res, fakeState(), allowAll)
  assert.equal(res.statusCode, 404)
})

test('a non-JSON content type returns 415', async () => {
  const res = fakeResponse()
  await handleRpcRoute(fakeRequest({ body: envelope(), headers: { 'content-type': 'text/plain' } }), res, fakeState(), allowAll)
  assert.equal(res.statusCode, 415)
})

test('an invalid envelope returns 400', async () => {
  const res = fakeResponse()
  await handleRpcRoute(fakeRequest({ body: { hello: 'world' } }), res, fakeState(), allowAll)
  assert.equal(res.statusCode, 400)
})

test('a valid request is answered with the official server-response envelope', async () => {
  const res = fakeResponse()
  await handleRpcRoute(fakeRequest({ body: envelope() }), res, fakeState(), allowAll)
  assert.equal(res.statusCode, 200)
  const parsed = JSON.parse(res.capture.body)
  assert.equal(parsed.type, 'server-response')
  assert.equal(parsed.rpcId, 'rpc-1')
  assert.deepEqual(parsed.result, { ok: true, value: { endpoint: 'health', payload: {} } })
})

test('an endpoint/method mismatch is a gateway/bad-request business failure', async () => {
  const res = fakeResponse()
  await handleRpcRoute(
    fakeRequest({ url: '/dsh-notify-lite/health', body: envelope({ method: 'config' }) }),
    res,
    fakeState(),
    allowAll,
  )
  assert.equal(res.statusCode, 200)
  const parsed = JSON.parse(res.capture.body)
  assert.equal(parsed.result.ok, false)
  assert.equal(parsed.result.error.code, 'gateway/bad-request')
})

test('a handler throw becomes an internal-error business failure', async () => {
  const res = fakeResponse()
  const state = fakeState(async () => {
    throw new Error('boom')
  })
  await handleRpcRoute(fakeRequest({ body: envelope() }), res, state, allowAll)
  const parsed = JSON.parse(res.capture.body)
  assert.equal(parsed.result.ok, false)
  assert.equal(parsed.result.error.code, 'internal-error')
})

test('a client disconnect aborts the long-poll signal', async () => {
  const res = fakeResponse()
  let observed = null
  const state = fakeState((endpoint, payload, signal) => new Promise((resolve) => {
    observed = signal
    if (signal.aborted) {
      resolve({ ok: true, value: { events: [], next: 0 } })
      return
    }
    signal.addEventListener('abort', () => resolve({ ok: true, value: { events: [], next: 0 } }), { once: true })
  }))
  const req = fakeRequest({ url: '/dsh-notify-lite/poll', body: envelope({ method: 'poll', payload: { after: 0, wait: 25000 } }) })
  const pending = handleRpcRoute(req, res, state, allowAll)
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(observed, 'handler received the abort signal')
  assert.equal(observed.aborted, false)
  req.emit('aborted')
  await pending
  assert.equal(observed.aborted, true)
  const parsed = JSON.parse(res.capture.body)
  assert.equal(parsed.result.ok, true)
})

test('readJsonBody caps oversized bodies', async () => {
  const req = fakeRequest({ body: 'x'.repeat(70 * 1024) })
  const result = await readJsonBody(req, 64 * 1024)
  assert.equal(result.ok, false)
  assert.equal(result.status, 413)
})
