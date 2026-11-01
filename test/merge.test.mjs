/**
 * Unit tests for the pure completion merge scheduler exported by lib/config.js
 * (docs/INTERFACE.md §2.5 item 5: batch completions for mergeIntervalMs).
 *
 * Timer dependencies are injected, so no test ever waits on real time.
 *
 * Run with: node --test test/   (sandboxed Windows: add --test-isolation=none)
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULTS, createMergeScheduler } from '../lib/config.js'

/**
 * Deterministic fake timer host: records scheduled callbacks and lets tests
 * fire them explicitly.
 */
function createFakeClock() {
  let nextId = 1
  const scheduled = new Map()
  return {
    setTimer(callback, ms) {
      const id = nextId
      nextId += 1
      scheduled.set(id, { callback, ms })
      return id
    },
    clearTimer(id) {
      scheduled.delete(id)
    },
    /** Run the oldest scheduled timer (FIFO, like a single-threaded event loop). */
    runNext() {
      const first = scheduled.entries().next()
      if (first.done) throw new Error('no timer scheduled')
      const [id, entry] = first.value
      scheduled.delete(id)
      entry.callback()
      return entry
    },
    runAll() {
      while (scheduled.size > 0) this.runNext()
    },
    pending() {
      return scheduled.size
    },
    delays() {
      return [...scheduled.values()].map((entry) => entry.ms)
    },
  }
}

/** Create a scheduler wired to a fake clock, a publish spy and a configurable interval. */
function createHarness(overrides = {}) {
  const clock = createFakeClock()
  const published = []
  const duplicates = new Set()
  const interval = { value: overrides.interval ?? DEFAULTS.mergeIntervalMs }
  const scheduler = createMergeScheduler({
    publish: (payload) => published.push(payload),
    setTimer: (callback, ms) => clock.setTimer(callback, ms),
    clearTimer: (id) => clock.clearTimer(id),
    getIntervalMs: () => interval.value,
    isDuplicate: (sessionId, turn) => duplicates.has(`${sessionId}:${turn}`),
    ...(overrides.scheduler || {}),
  })
  return { clock, published, duplicates, interval, scheduler }
}

test('a single completion publishes once after the merge interval', () => {
  const { clock, published, scheduler } = createHarness()
  assert.equal(scheduler.queue({ sessionId: 's1', sessionTitle: 'Title', text: 'All done.', turn: 1 }), true)
  assert.deepEqual(published, [], 'nothing published before the timer fires')
  assert.deepEqual(clock.delays(), [DEFAULTS.mergeIntervalMs])
  assert.deepEqual(scheduler.pending(), {
    sessionId: 's1',
    sessionTitle: 'Title',
    text: 'All done.',
    count: 1,
    openedAt: scheduler.pending().openedAt,
  })
  clock.runNext()
  assert.deepEqual(published, [
    { kind: 'complete', text: 'All done.', sessionId: 's1', sessionTitle: 'Title' },
  ])
  assert.equal(clock.pending(), 0)
  assert.equal(scheduler.pending(), null)
})

test('two completions inside the window merge into one count=2 event', () => {
  const { clock, published, scheduler } = createHarness()
  scheduler.queue({ sessionId: 's1', sessionTitle: 'First task', text: 'First answer.', turn: 1 })
  scheduler.queue({ sessionId: 's2', sessionTitle: 'Second task', text: 'Second answer.', turn: 2 })
  assert.equal(clock.pending(), 1, 'only one timer for the whole batch')
  assert.equal(scheduler.stats().merged, 1)
  clock.runNext()
  assert.equal(published.length, 1)
  assert.equal(published[0].kind, 'complete')
  assert.equal(published[0].count, 2)
  assert.equal(published[0].text, 'Second answer.', 'latest text wins')
  assert.equal(published[0].sessionId, 's2')
  assert.deepEqual(published[0].sessionIds, ['s1', 's2'])
  assert.equal(published[0].sessionTitle, 'Second task')
})

test('a merged total above two keeps incrementing count', () => {
  const { clock, published, scheduler } = createHarness()
  scheduler.queue({ sessionId: 's1', text: 'a', turn: 1 })
  scheduler.queue({ sessionId: 's1', text: 'b', turn: 2 })
  scheduler.queue({ sessionId: 's1', text: 'c', turn: 3 })
  assert.equal(scheduler.stats().merged, 2)
  clock.runNext()
  assert.equal(published.length, 1)
  assert.equal(published[0].count, 3)
  assert.equal(published[0].text, 'c')
})

test('a later completion without text keeps the last known text', () => {
  const { clock, published, scheduler } = createHarness()
  scheduler.queue({ sessionId: 's1', text: 'Useful body.', turn: 1 })
  scheduler.queue({ sessionId: 's2', text: null, turn: 2 })
  clock.runNext()
  assert.equal(published.length, 1)
  assert.equal(published[0].count, 2)
  assert.equal(published[0].text, 'Useful body.')
  assert.equal(published[0].sessionId, 's2')
})

test('a completion with no text at all publishes text:null', () => {
  const { clock, published, scheduler } = createHarness()
  scheduler.queue({ sessionId: 's1', text: null, turn: 1 })
  clock.runNext()
  assert.deepEqual(published, [{ kind: 'complete', text: null, sessionId: 's1' }])
})

test('duplicates rejected by isDuplicate never enter the batch', () => {
  const { clock, published, scheduler, duplicates } = createHarness()
  duplicates.add('s1:7')
  assert.equal(scheduler.queue({ sessionId: 's1', text: 'x', turn: 7 }), false)
  assert.equal(clock.pending(), 0)
  assert.deepEqual(published, [])
  // The same session/turn for a later batch is fine once it is no longer a duplicate.
  duplicates.clear()
  assert.equal(scheduler.queue({ sessionId: 's1', text: 'x', turn: 7 }), true)
  clock.runNext()
  assert.equal(published.length, 1)
})

test('mergeIntervalMs=0 publishes immediately without scheduling a timer', () => {
  const { clock, published, scheduler } = createHarness({ interval: 0 })
  scheduler.queue({ sessionId: 's1', text: 'instant', turn: 1 })
  assert.equal(clock.pending(), 0)
  assert.deepEqual(published, [{ kind: 'complete', text: 'instant', sessionId: 's1' }])
})

test('the interval is read when a batch opens, not at construction time', () => {
  const { clock, published, scheduler, interval } = createHarness({ interval: 2500 })
  interval.value = 400
  scheduler.queue({ sessionId: 's1', text: 'x', turn: 1 })
  assert.deepEqual(clock.delays(), [400])
  clock.runNext()
  assert.equal(published.length, 1)
})

test('flushNow publishes a pending batch and cancels its timer', () => {
  const { clock, published, scheduler } = createHarness()
  scheduler.queue({ sessionId: 's1', text: 'pending', turn: 1 })
  assert.equal(clock.pending(), 1)
  const payload = scheduler.flushNow()
  assert.equal(payload.kind, 'complete')
  assert.equal(clock.pending(), 0)
  assert.equal(published.length, 1)
  assert.equal(scheduler.pending(), null)
  assert.equal(scheduler.flushNow(), null, 'nothing left to flush')
})

test('dispose drops the pending batch and clears the timer without publishing', () => {
  const { clock, published, scheduler } = createHarness()
  scheduler.queue({ sessionId: 's1', text: 'pending', turn: 1 })
  scheduler.dispose()
  assert.equal(clock.pending(), 0)
  assert.deepEqual(published, [])
  assert.equal(scheduler.queue({ sessionId: 's2', text: 'late', turn: 2 }), false, 'disposed scheduler rejects work')
  scheduler.dispose() // idempotent
})

test('a throwing publish or timer factory never breaks the scheduler', () => {
  const clock = createFakeClock()
  let scheduled = 0
  const scheduler = createMergeScheduler({
    publish() {
      throw new Error('publish exploded')
    },
    setTimer(callback, ms) {
      scheduled += 1
      return clock.setTimer(callback, ms)
    },
    clearTimer: (id) => clock.clearTimer(id),
    getIntervalMs: () => 1000,
  })
  assert.equal(scheduler.queue({ sessionId: 's1', text: 't', turn: 1 }), true)
  assert.equal(scheduled, 1)
  clock.runNext() // must not throw
  assert.equal(scheduler.pending(), null)

  const brokenTimer = createMergeScheduler({
    publish: () => {},
    setTimer() {
      throw new Error('timer exploded')
    },
    clearTimer: () => {},
    getIntervalMs: () => 1000,
  })
  assert.equal(brokenTimer.queue({ sessionId: 's2', text: 't', turn: 2 }), true)
  assert.equal(brokenTimer.pending(), null, 'synchronous fallback publishes immediately')
})

test('the allDone flag is carried into the merged completion payload', () => {
  const published = []
  const scheduler = createMergeScheduler({
    publish: (payload) => published.push(payload),
    setTimer: () => 0,
    clearTimer: () => {},
    getIntervalMs: () => 2500,
  })
  assert.equal(scheduler.queue({ sessionId: 's1', text: 'a', turn: 1 }), true)
  assert.equal(scheduler.queue({ sessionId: 's2', text: 'b', turn: 2, allDone: true }), true)
  scheduler.flushNow()
  assert.equal(published.length, 1)
  assert.equal(published[0].count, 2)
  assert.equal(published[0].allDone, true)
})
