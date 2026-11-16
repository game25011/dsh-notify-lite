import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { request } from 'node:http'

import { createNativeToastManager } from '../lib/native-toast.js'

function fakeSpawn() {
  const spawned = []
  function spawnImpl(command, args) {
    const child = new EventEmitter()
    child.args = args
    child.killed = false
    child.payload = null
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = {
      on() {},
      end(buffer) {
        child.payload = Buffer.from(buffer.toString(), 'base64').toString('utf8')
        process.nextTick(() => child.stdout.emit('data', 'submitted'))
      },
    }
    child.kill = () => {
      if (child.killed) return
      child.killed = true
      child.emit('exit', 0)
    }
    spawned.push(child)
    process.nextTick(() => {
      if (args.includes('-WarmOnly')) child.stdout.emit('data', 'warm')
    })
    return child
  }
  return { spawnImpl, spawned }
}

function createManager(overrides = {}) {
  const { spawnImpl, spawned } = fakeSpawn()
  const activated = []
  const manager = createNativeToastManager({
    scriptPath: 'C:\\fake\\native-toast.ps1',
    spawnProcess: spawnImpl,
    onActivate: (sessionId, notificationId) => activated.push({ sessionId, notificationId }),
    ...overrides,
  })
  return { manager, spawned, activated }
}

function postActivation(url, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length } }, (res) => {
      res.resume()
      res.on('end', resolve)
    })
    req.on('error', reject)
    req.end(payload)
  })
}

test('warm compiles without showing a toast', async () => {
  const { manager, spawned } = createManager()
  try {
    assert.equal(await manager.warm(), true)
    assert.equal(spawned.length, 1)
    assert.ok(spawned[0].args.includes('-WarmOnly'))
    assert.equal(spawned[0].payload, null)
  } finally {
    manager.dispose()
  }
})

test('same-kind notifications use unique tags and do not kill the previous helper', async () => {
  const { manager, spawned } = createManager()
  try {
    const first = await manager.show({ kind: 'complete', title: 'one', body: 'a', durationMs: 3000 })
    const second = await manager.show({ kind: 'complete', title: 'two', body: 'b', durationMs: 3000 })
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.notEqual(first.id, second.id)
    const firstShow = spawned.find((child) => child.payload && child.payload.includes('"title":"one"'))
    const secondShow = spawned.find((child) => child.payload && child.payload.includes('"title":"two"'))
    assert.ok(firstShow && secondShow)
    const firstPayload = JSON.parse(firstShow.payload)
    const secondPayload = JSON.parse(secondShow.payload)
    assert.notEqual(firstPayload.tag, secondPayload.tag)
    assert.equal(firstShow.killed, false, 'old helper must be allowed to exit naturally')
  } finally {
    manager.dispose()
  }
})

test('activation callback is validated and delivered once', async () => {
  const { manager, spawned, activated } = createManager()
  try {
    const shown = await manager.show({ kind: 'question', title: 'q', body: 'body', sessionId: 's1', durationMs: 3000 })
    assert.equal(shown.ok, true)
    const showChild = spawned.find((child) => child.payload && child.payload.includes('"sessionId":"s1"'))
    assert.ok(showChild)
    const payload = JSON.parse(showChild.payload)
    await postActivation(payload.callbackUrl, {
      token: payload.token,
      sessionId: 's1',
      notificationId: payload.notificationId,
    })
    await postActivation(payload.callbackUrl, {
      token: payload.token,
      sessionId: 's1',
      notificationId: payload.notificationId,
    })
    assert.deepEqual(activated, [{ sessionId: 's1', notificationId: shown.id }])
  } finally {
    manager.dispose()
  }
})

test('dispose during callback-server startup settles show()', async () => {
  const { manager } = createManager()
  const pending = manager.show({ kind: 'test', title: 'startup race', body: 'body', durationMs: 3000 })
  manager.dispose()
  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ ok: 'timeout' }), 1000)),
  ])
  assert.notEqual(result.ok, 'timeout', 'show() must not stay pending after dispose')
  assert.equal(result.ok, false)
})

test('activation rejects a bad token', async () => {
  const { manager, spawned, activated } = createManager()
  try {
    const shown = await manager.show({ kind: 'approval', title: 'a', body: 'b', sessionId: 's2', durationMs: 3000 })
    assert.equal(shown.ok, true)
    const showChild = spawned.find((child) => child.payload && child.payload.includes('"sessionId":"s2"'))
    const payload = JSON.parse(showChild.payload)
    await postActivation(payload.callbackUrl, {
      token: 'wrong',
      sessionId: 's2',
      notificationId: payload.notificationId,
    })
    assert.equal(activated.length, 0)
  } finally {
    manager.dispose()
  }
})

test('warm spawns nothing when the helper DLL for this source is cached', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createHash } = await import('node:crypto')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notify-warm-'))
  try {
    const source = join(dir, 'native-toast-helper.cs')
    writeFileSync(source, 'class X {}')
    const hash = createHash('sha256').update('class X {}').digest('hex')
    const { manager, spawned } = createManager({ helperSourcePath: source, cacheRoot: dir })
    try {
      // Cache miss: compile once.
      assert.equal(await manager.warm(), true)
      assert.equal(spawned.length, 1)
    } finally {
      manager.dispose()
    }
    writeFileSync(join(dir, hash + '.dll'), 'compiled')
    const cached = createManager({ helperSourcePath: source, cacheRoot: dir })
    try {
      assert.equal(await cached.manager.warm(), true)
      assert.equal(cached.spawned.length, 0, 'a cached DLL needs no PowerShell warm-up')
    } finally {
      cached.manager.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('show waits for an in-flight warm-up instead of compiling in parallel', async () => {
  const { spawnImpl, spawned } = fakeSpawn()
  let releaseWarm = null
  const slowSpawn = (command, args) => {
    const child = spawnImpl(command, args)
    if (args.includes('-WarmOnly')) {
      // Hold the warm-up until the test releases it.
      child.stdout.emit = ((emit) => (event, ...rest) => {
        if (event === 'data' && releaseWarm === null) {
          releaseWarm = () => emit.call(child.stdout, event, ...rest)
          return true
        }
        return emit.call(child.stdout, event, ...rest)
      })(child.stdout.emit)
    }
    return child
  }
  const manager = createNativeToastManager({
    scriptPath: 'C:\\fake\\native-toast.ps1',
    spawnProcess: slowSpawn,
    onActivate: () => {},
  })
  try {
    const warming = manager.warm()
    const showing = manager.show({ kind: 'complete', title: 't', body: 'b', durationMs: 3000 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(spawned.length, 1, 'no toast helper starts while the warm-up compiles')
    releaseWarm()
    assert.equal(await warming, true)
    const shown = await showing
    assert.equal(shown.ok, true)
    assert.equal(spawned.length, 2)
  } finally {
    manager.dispose()
  }
})
