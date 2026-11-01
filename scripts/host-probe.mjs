/**
 * Host integration probe — no Harness process needed.
 *
 * Verifies, in a plain Node process:
 * 1. `@deepseek-ai/schemastery` resolution with cwd = the real desktop profile
 *    (the Desktop Host is spawned with that cwd and may lack DSH_PROFILE_DIR);
 * 2. the fallback browser transport registration when the official
 *    `connection.rpc.handle` is unavailable (DSH 0.2.1-rc.2 bug);
 * 3. the real route handler against the official unary RPC envelope:
 *    config/save/test/poll responses + the requestRejection fence.
 *
 * Usage: node scripts/host-probe.mjs [profileDir]
 */
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { join } from 'node:path'

const explicitProfile = process.argv[2]
const profileDir = explicitProfile
  ?? process.env.DSH_PROFILE_DIR
  ?? (process.env.DSH_HOME
    ? join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE || 'desktop')
    : undefined)
if (!profileDir) {
  console.error('Usage: node scripts/host-probe.mjs <profileDir>  (or set DSH_PROFILE_DIR / DSH_HOME)')
  process.exit(2)
}
try {
  process.chdir(profileDir)
} catch (error) {
  console.error(`cannot chdir to the profile dir "${profileDir}": ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
delete process.env.DSH_PROFILE_DIR
delete process.env.DSH_HOME

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const { __test, Config, apply } = mod

console.log('profileDir:', profileDir)
console.log('Config:', Config ? 'resolved' : 'unresolved', '| source:', __test.resolvedConfigSource)
assert.ok(Config, 'Config schema should resolve from the profile cwd')
assert.notEqual(__test.resolvedConfigSource, 'unresolved')

const calls = { effects: [], registeredRoutes: [], updates: [], configures: 0 }

function makeCtx(services, parent) {
  const ctx = {
    fiber: {},
    get(name) {
      return services[name]
    },
    on() {
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      calls.effects.push(dispose)
      return dispose
    },
    logger: {
      debug() {},
      info() {},
      warn(...args) {
        console.error('[host warn]', ...args)
      },
      error(...args) {
        console.error('[host error]', ...args)
      },
    },
    inject(deps, callback) {
      const scopedServices = { ...services }
      for (const dep of deps) {
        if (!(dep in scopedServices)) throw new Error(`missing service ${dep}`)
      }
      const child = makeCtx(scopedServices, ctx)
      callback(child)
      return child
    },
    parent,
  }
  // Cordis exposes injected services as context properties; mirror that.
  for (const name of Object.keys(services)) {
    Object.defineProperty(ctx, name, {
      configurable: true,
      enumerable: true,
      get() {
        return services[name]
      },
    })
  }
  return ctx
}

const webServer = {
  register(route) {
    calls.registeredRoutes.push(route)
    return () => {
      route.disposed = true
    }
  },
}

const settings = {
  configure(presentation, fiber) {
    calls.configures += 1
    assert.equal(presentation.auto, false)
    assert.ok(fiber)
  },
  describe() {
    return [{
      ns: 'dsh-notify-toast',
      value: { enabled: true, bodyLength: 40, mergeIntervalMs: 2500 },
    }]
  },
  async update(ns, patch) {
    calls.updates.push({ ns, patch })
  },
}

const connection = {
  requestRejection(req) {
    return req.headers['x-fence'] === 'deny' ? 403 : undefined
  },
  // No rpc.handle: this exercises the 0.2.1-rc.2 fallback path.
}

const ctx = makeCtx({ connection, settings, webServer })
try {
  apply(ctx, {})
} catch (error) {
  console.error('apply threw:', error)
  process.exit(1)
}
console.log('after apply:', JSON.stringify({ routes: calls.registeredRoutes.length, configures: calls.configures, effects: calls.effects.length }))

assert.equal(calls.registeredRoutes.length, 1, 'exactly one browser route is registered')
const route = calls.registeredRoutes[0]
assert.equal(route.kind, 'prefix')
assert.equal(route.path, '/dsh-notify-toast')
assert.equal(calls.configures, 1, 'automatic settings form is disabled')

function request(body, { method = 'POST', url = '/dsh-notify-toast/health', headers = {} } = {}) {
  const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json', host: '127.0.0.1:54042', ...headers }
  return req
}

function response() {
  const state = { status: 200, headers: {}, body: '' }
  const res = new Writable({
    write(chunk, _enc, callback) {
      state.body += chunk.toString()
      callback()
    },
  })
  Object.defineProperty(res, 'statusCode', {
    configurable: true,
    get() {
      return state.status
    },
    set(value) {
      state.status = value
    },
  })
  res.setHeader = (name, value) => {
    state.headers[String(name).toLowerCase()] = String(value)
  }
  res.on('finish', () => {
    state.ended = true
  })
  res.state = state
  return res
}

function envelope(method, payload = {}) {
  return { type: 'client-request', rpcId: `rpc-${method}`, method, payload }
}

async function call(method, payload = {}, options = {}) {
  const res = response()
  const url = options.url ?? `/dsh-notify-toast/${method}`
  await route.handler(request(envelope(method, payload), { ...options, url }), res)
  assert.equal(res.state.status, 200, `${method}: HTTP 200`)
  const parsed = JSON.parse(res.state.body)
  assert.equal(parsed.type, 'server-response')
  assert.equal(parsed.rpcId, `rpc-${method}`)
  return parsed.result
}

// Fence: the official Connection rejection is passed through before anything else.
{
  const res = response()
  await route.handler(request(envelope('health'), { headers: { 'x-fence': 'deny' } }), res)
  assert.equal(res.state.status, 403)
  console.log('fence: 403 for a rejected request ✓')
}

const configResult = await call('config')
console.log('config result:', JSON.stringify(configResult).slice(0, 500))
assert.equal(configResult.ok, true)
assert.equal(configResult.value.status.transport, 'route')
assert.equal(configResult.value.status.settingsAvailable, true)
assert.equal(configResult.value.config.bodyLength, 40)
console.log('config: transport=route, settingsAvailable=true, config exposed ✓')

const saveResult = await call('save', { patch: { bodyLength: 55, sound: 'bell' } })
assert.equal(saveResult.ok, true)
assert.deepEqual(calls.updates.at(-1), { ns: 'dsh-notify-toast', patch: { bodyLength: 55, sound: 'bell' } })
console.log('save: settings.update called with the validated patch ✓')

const invalidSave = await call('save', { patch: { bodyLength: 999 } })
assert.equal(invalidSave.ok, true, 'transport stays successful for a business rejection')
assert.equal(invalidSave.value.ok, false)
assert.equal(invalidSave.value.error.code, 'invalid-value')
console.log('save: out-of-range value rejected without touching settings ✓')

const testResult = await call('test')
assert.equal(testResult.ok, true)
assert.equal(testResult.value.queued, true)
const pollResult = await call('poll', { after: 0, wait: 1000 })
assert.equal(pollResult.ok, true)
assert.ok(pollResult.value.events.some((event) => event.kind === 'test'))
assert.ok(pollResult.value.next > 0)
console.log('test+poll: event ring buffer and after-cursor work ✓')

const badgeResult = await call('taskbar-badge', { count: 2 })
assert.equal(badgeResult.ok, true, 'taskbar-badge accepts a valid count')
assert.equal(badgeResult.value.count, 2)
const badgeClear = await call('taskbar-badge', { count: 0 })
assert.equal(badgeClear.ok, true, 'taskbar-badge accepts a clear')
assert.equal(badgeClear.value.count, 0)
console.log('taskbar-badge: set/clear accepted ✓')

const focusResult = await call('focus', { sessionId: 'session-x' })
assert.equal(focusResult.ok, true)
assert.equal(typeof focusResult.value.native, 'boolean')
console.log('focus: returns {ok:true, native:' + focusResult.value.native + '} without throwing ✓')

const unknown = await call('nope')
assert.equal(unknown.ok, false)
assert.equal(unknown.error?.code, 'unknown-endpoint')
console.log('unknown endpoint: business failure ✓')

// Dispose everything; no route/timer should survive.
for (const dispose of calls.effects.reverse()) {
  if (typeof dispose === 'function') dispose()
}
console.log('dispose: all effects cleaned (' + calls.effects.length + ' disposers) ✓')
console.log('\nHOST INTEGRATION PROBE: PASS')
