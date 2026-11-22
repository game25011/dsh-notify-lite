/**
 * dsh-notify-lite — all-done title marker tests.
 *
 * Runs the pure tracker without Cordis or a real session.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAllDoneTitleTracker } from '../lib/all-done.js'

function session(id) {
  return { id, header: { parentSession: undefined, origin: 'user' } }
}

function event(reason = 'completed') {
  return { type: 'turn/end', data: { reason: { kind: reason } } }
}

function harness(options = {}) {
  const calls = []
  let config = { allDoneTitleEnabled: true, allDoneTitle: '所有任务均已完成', ...options.config }
  const tracker = createAllDoneTitleTracker({
    getConfig: () => config,
    renameTitle: (target, title) => {
      calls.push({ target, title })
      return true
    },
    onError: (error) => { throw error },
  })
  return { tracker, calls, setConfig: (next) => { config = { ...config, ...next } }, config: () => config }
}

test('a single session never triggers the marker', () => {
  const h = harness()
  const a = session('s1')
  h.tracker.onTurnStart(a)
  h.tracker.onTurnEnd(a, event())
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.tracker.snapshot(), { running: 0, armed: false, dirty: false })
})

test('two overlapping completed sessions rename the last one', () => {
  const h = harness()
  const a = session('a')
  const b = session('b')
  h.tracker.onTurnStart(a)
  h.tracker.onTurnStart(b)
  h.tracker.onTurnEnd(a, event())
  assert.deepEqual(h.calls, [])
  h.tracker.onTurnEnd(b, event())
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].target, b)
  assert.equal(h.calls[0].title, '所有任务均已完成')
  assert.deepEqual(h.tracker.snapshot(), { running: 0, armed: false, dirty: false })
})

test('the marker uses the configured title and the session that ended last', () => {
  const h = harness({ config: { allDoneTitle: '全部结束' } })
  const a = session('a')
  const b = session('b')
  h.tracker.onTurnStart(a)
  h.tracker.onTurnStart(b)
  h.tracker.onTurnEnd(b, event())
  h.tracker.onTurnEnd(a, event())
  assert.equal(h.calls[0].target, a)
  assert.equal(h.calls[0].title, '全部结束')
})

test('a non-completed end prevents the rename', () => {
  const h = harness()
  const a = session('a')
  const b = session('b')
  h.tracker.onTurnStart(a)
  h.tracker.onTurnStart(b)
  h.tracker.onTurnEnd(a, event('error'))
  h.tracker.onTurnEnd(b, event())
  assert.deepEqual(h.calls, [])
})

test('the feature must be enabled when the batch runs', () => {
  const h = harness({ config: { allDoneTitleEnabled: false } })
  const a = session('a')
  const b = session('b')
  h.tracker.onTurnStart(a)
  h.tracker.onTurnStart(b)
  h.tracker.onTurnEnd(a, event())
  h.tracker.onTurnEnd(b, event())
  assert.deepEqual(h.calls, [])
})

test('enabling while two sessions are already running still arms on the next end', () => {
  const h = harness({ config: { allDoneTitleEnabled: false } })
  const a = session('a')
  const b = session('b')
  h.tracker.onTurnStart(a)
  h.tracker.onTurnStart(b)
  h.setConfig({ allDoneTitleEnabled: true })
  h.tracker.onTurnEnd(a, event())
  h.tracker.onTurnEnd(b, event())
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].target, b)
})

test('sequential sessions (never overlapping) never trigger the marker', () => {
  const h = harness()
  const a = session('a')
  const b = session('b')
  h.tracker.onTurnStart(a)
  h.tracker.onTurnEnd(a, event())
  h.tracker.onTurnStart(b)
  h.tracker.onTurnEnd(b, event())
  assert.deepEqual(h.calls, [])
})

test('a new overlapping session joins the current batch', () => {
  const h = harness()
  const a = session('a')
  const b = session('b')
  const c = session('c')
  h.tracker.onTurnStart(a)
  h.tracker.onTurnStart(b)
  h.tracker.onTurnEnd(a, event())
  h.tracker.onTurnStart(c)
  h.tracker.onTurnEnd(b, event())
  h.tracker.onTurnEnd(c, event())
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].target, c)
})

test('dispose clears state and stops callbacks', () => {
  const h = harness()
  const a = session('a')
  const b = session('b')
  h.tracker.onTurnStart(a)
  h.tracker.onTurnStart(b)
  h.tracker.dispose()
  h.tracker.onTurnEnd(a, event())
  h.tracker.onTurnEnd(b, event())
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.tracker.snapshot(), { running: 0, armed: false, dirty: false })
})
