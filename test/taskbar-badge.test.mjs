/**
 * Taskbar badge manager: serialized updates and bounded retries.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'

import { createTaskbarBadgeManager } from '../lib/taskbar-badge.js'

function fakeSpawn(exitCode) {
  const spawned = []
  function spawnImpl(command, args) {
    const child = new EventEmitter()
    child.args = args
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    spawned.push(child)
    setImmediate(() => child.emit('close', typeof exitCode === 'function' ? exitCode(args) : exitCode))
    return child
  }
  return { spawnImpl, spawned }
}

function manager(spawnImpl) {
  return createTaskbarBadgeManager({
    spawnProcess: spawnImpl,
    platform: 'win32',
    listWindows: () => [{ handle: '4242' }],
    cscPath: '/nonexistent/csc.exe',
    scriptPath: 'C:\\fake\\taskbar-badge.ps1',
    debounceMs: 5,
  })
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a failing helper is tried once per requested change, not in a loop', async () => {
  const { spawnImpl, spawned } = fakeSpawn(1)
  const badge = manager(spawnImpl)
  try {
    badge.setCount(2)
    await wait(200)
    assert.equal(spawned.length, 1, 'one attempt for one request')
    // The next user-visible change is a fresh attempt.
    badge.setCount(0)
    await wait(100)
    assert.equal(spawned.length, 2)
  } finally {
    badge.dispose()
  }
})

test('the latest count wins and an applied count is not rewritten', async () => {
  const { spawnImpl, spawned } = fakeSpawn(0)
  const badge = manager(spawnImpl)
  try {
    badge.setCount(1)
    badge.setCount(3)
    await wait(100)
    assert.equal(spawned.length, 1, 'debounced into one write')
    assert.ok(spawned[0].args.includes('3'))
    badge.setCount(3)
    await wait(100)
    assert.equal(spawned.length, 1, 'same count is not rewritten')
  } finally {
    badge.dispose()
  }
})

test('nothing is spawned off Windows', async () => {
  const { spawnImpl, spawned } = fakeSpawn(0)
  const badge = createTaskbarBadgeManager({ spawnProcess: spawnImpl, platform: 'linux', debounceMs: 5 })
  badge.setCount(2)
  badge.warm()
  await wait(50)
  badge.dispose()
  assert.equal(spawned.length, 0)
})
