/**
 * Host event pipeline: queue epoch resync, completion dedupe/body boundaries
 * and waterfall observer registration (docs/INTERFACE.md §2.3/§2.5).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { __test, apply } from '../lib/index.js'

const { createEventQueue, createHostState } = __test

function fakeCtx() {
  const listeners = []
  return {
    listeners,
    get() {
      return undefined
    },
    on(eventName, listener, options) {
      listeners.push({ eventName, listener, options })
      return () => {}
    },
    effect() {},
    inject() {},
  }
}

/** A root session whose log is `events` (index = seq). */
function fakeSession(id, events) {
  return {
    id,
    header: {},
    seq: events.length,
    eventAt: (seq) => events[seq],
    snapshotEvents: (from, to) => events.slice(from, to),
  }
}

const reply = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
const turnEnd = (seq, extra = {}) => ({ type: 'turn/end', seq, data: { reason: { kind: 'completed' }, ...extra } })

async function drain(state) {
  const response = await state.handleRpc('poll', { after: 0, wait: 1000 })
  return response.value.events
}

test('a poll from another queue epoch restarts at cursor 0 instead of skipping events', async () => {
  const queue = createEventQueue({ epoch: 'host-b' })
  queue.publish({ kind: 'question' })
  queue.publish({ kind: 'approval' })
  // Same cursor, same epoch: nothing new.
  const same = await queue.poll(2, 0, undefined, 'host-b')
  assert.equal(same.events.length, 0)
  assert.equal(same.epoch, 'host-b')
  // A client that last saw cursor 2 on the previous Host must still get 1..2.
  const restarted = await queue.poll(2, 0, undefined, 'host-a')
  assert.deepEqual(restarted.events.map((event) => event.id), [1, 2])
  // Old clients without an epoch keep the clamp behaviour.
  const legacy = await queue.poll(50, 0)
  assert.equal(legacy.events.length, 0)
  assert.equal(legacy.next, 2)
  queue.dispose()
})

test('every queue gets its own epoch', () => {
  const left = createEventQueue()
  const right = createEventQueue()
  assert.equal(typeof left.epoch(), 'string')
  assert.notEqual(left.epoch(), right.epoch())
  left.dispose()
  right.dispose()
})

test('completions without a turn number are not swallowed as duplicates', async () => {
  const state = createHostState(fakeCtx(), { mergeIntervalMs: 0 })
  try {
    const log = [{ type: 'turn/start' }, reply('first reply'), { type: 'turn/start' }, reply('second reply')]
    const session = fakeSession('s1', log)
    state.onSessionEvent(session, { type: 'turn/start' })
    state.onSessionEvent(session, turnEnd(2))
    state.onSessionEvent(session, { type: 'turn/start' })
    state.onSessionEvent(session, turnEnd(4))
    // The very same turn/end delivered twice is still deduped.
    state.onSessionEvent(session, turnEnd(4))
    const events = await drain(state)
    assert.deepEqual(events.map((event) => event.text), ['first reply', 'second reply'])
  } finally {
    state.dispose()
  }
})

test('the completion body never borrows the previous turn reply', async () => {
  const state = createHostState(fakeCtx(), { mergeIntervalMs: 0 })
  try {
    const log = [{ type: 'turn/start' }, reply('old answer'), { type: 'turn/start' }, { type: 'tool/result' }]
    const session = fakeSession('s2', log)
    state.onSessionEvent(session, { type: 'turn/start' })
    state.onSessionEvent(session, turnEnd(4, { turn: 2 }))
    const events = await drain(state)
    assert.equal(events.length, 1)
    assert.equal(events[0].kind, 'complete')
    assert.equal(events[0].text, null)
  } finally {
    state.dispose()
  }
})

test('approval and question observers are prepended, global, and always delegate', () => {
  const ctx = fakeCtx()
  apply(ctx, {})
  for (const eventName of ['approval/request', 'user-questions/request']) {
    const registration = ctx.listeners.find((entry) => entry.eventName === eventName)
    assert.ok(registration, eventName + ' observed')
    assert.equal(registration.options && registration.options.prepend, true, eventName + ' prepended')
    assert.equal(registration.options && registration.options.global, true, eventName + ' global')
    let delegated = 0
    const result = registration.listener({ agent: { id: 'a' } }, () => {
      delegated += 1
      return 'answer'
    })
    assert.equal(result, 'answer')
    assert.equal(delegated, 1)
  }
})
