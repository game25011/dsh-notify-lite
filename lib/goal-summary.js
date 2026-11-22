/**
 * dsh-notify-lite — goal-mode completion aggregation.
 *
 * Goal mode can run many automatic Goal Rounds. Per-turn completion toasts
 * would be noisy and would make the "N steps" title meaningless. This pure
 * tracker observes the goal lifecycle independently of delivery settings,
 * suppresses only completions belonging to a tracked goal run, and emits one
 * summary when that run segment stops.
 *
 * It is intentionally side-effect free apart from injected callbacks/timers so
 * the state machine can be unit-tested without a DSH process.
 */

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sessionIdOf(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function normalizedKey(value) {
  if (typeof value === 'string' && value.length > 0) return value
  if (Number.isSafeInteger(value)) return String(value)
  return undefined
}

/**
 * @param {object} [options]
 * @param {() => boolean} [options.enabled] live delivery setting.
 * @param {(payload: object) => unknown} [options.onSummary] publishes one summary completion.
 * @param {() => number} [options.getIntervalMs] settle/merge delay.
 * @param {() => number} [options.now]
 * @param {(callback: () => void, ms: number) => unknown} [options.setTimer]
 * @param {(timer: unknown) => void} [options.clearTimer]
 */
export function createGoalSummaryTracker(options = {}) {
  const {
    enabled = () => true,
    onSummary = () => {},
    getIntervalMs = () => 2500,
    now = () => Date.now(),
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (timer) => clearTimeout(timer),
  } = options

  /** @type {Map<string, any>} */
  const runs = new Map()
  const activeTurns = new Set()
  const timers = new Set()

  function deliveryEnabled() {
    try {
      return enabled() !== false
    } catch {
      return false
    }
  }

  function cancelTimer(state) {
    if (!state || state.timer === null || state.timer === undefined) return
    try {
      clearTimer(state.timer)
    } catch {
      // ignore
    }
    timers.delete(state.timer)
    state.timer = null
  }

  function close(state, accountedTurn) {
    if (!state) return
    cancelTimer(state)
    state.closed = true
    state.terminal = true
    state.active = false
    state.armed = false
    state.pending = null
    state.accountedTurn = normalizedKey(accountedTurn) ?? null
  }

  function runCount(state) {
    const baseline = nonNegativeInteger(state.baselineRounds) ?? 0
    const last = nonNegativeInteger(state.lastRounds)
    // Never invent a round from a turn count. A missing/zero authoritative
    // counter means there is no reportable Goal Round progress.
    return last === undefined ? 0 : Math.max(0, last - baseline)
  }

  function emitSummary(sessionId, state) {
    const count = runCount(state)
    if (count < 1) return false
    const pending = state.pending || {}
    const payload = {
      kind: 'complete',
      sessionId,
      text: typeof pending.text === 'string' && pending.text.length > 0 ? pending.text : null,
      count,
      goalOutcome:
        state.phase === 'complete' ? 'complete' : state.phase === 'paused' ? 'paused' : 'blocked',
      allDone: false,
    }
    if (typeof pending.sessionTitle === 'string' && pending.sessionTitle.length > 0) {
      payload.sessionTitle = pending.sessionTitle
    }
    try {
      onSummary(payload)
    } catch {
      // Notification delivery must never break the host event loop.
    }
    return true
  }

  function finalize(sessionId, state) {
    if (!state || state.closed) return
    cancelTimer(state)
    if (deliveryEnabled()) emitSummary(sessionId, state)
    close(state, state.pending && state.pending.turnKey)
  }

  function flush(sessionId) {
    const state = runs.get(sessionId)
    if (!state || state.closed) return
    state.timer = null
    if (!deliveryEnabled()) {
      close(state, state.pending && state.pending.turnKey)
      return
    }
    emitSummary(sessionId, state)
    close(state, state.pending && state.pending.turnKey)
  }

  function schedule(sessionId, state) {
    if (!state || state.closed) return
    if (state.timer !== null && state.timer !== undefined) return
    if (!deliveryEnabled()) {
      close(state, state.pending && state.pending.turnKey)
      return
    }
    let delay = 0
    try {
      const value = Number(getIntervalMs())
      if (Number.isFinite(value)) delay = Math.max(0, Math.floor(value))
    } catch {
      delay = 0
    }
    const timer = setTimer(() => {
      timers.delete(timer)
      flush(sessionId)
    }, delay)
    state.timer = timer
    timers.add(timer)
  }

  function start(sessionId, goal, rounds) {
    const existing = runs.get(sessionId)
    const previousTurnActive = Boolean((existing && existing.turnActive) || activeTurns.has(sessionId))
    if (existing && !existing.closed && (existing.terminal || existing.timer !== null || existing.pending)) {
      // A pause followed by a quick resume must finalize the old segment before
      // the new one starts; otherwise the old round delta is lost or mixed in.
      finalize(sessionId, existing)
    } else if (existing) {
      cancelTimer(existing)
    }
    const baseline = nonNegativeInteger(rounds)
    const state = {
      goalId: sessionIdOf(goal && goal.id),
      revision: nonNegativeInteger(goal && goal.revision),
      phase: typeof goal?.phase === 'string' ? goal.phase : 'active',
      active: true,
      armed: true,
      baselineRounds: baseline === undefined ? 0 : baseline,
      lastRounds: baseline,
      pending: null,
      timer: null,
      closed: false,
      terminal: false,
      turnActive: previousTurnActive,
      awaitingTurnEnd: false,
      accountedTurn: null,
      deliveryOff: !deliveryEnabled(),
    }
    runs.set(sessionId, state)
  }

  /** Process one persisted goal/change event. */
  function onGoalChange(sessionId, change) {
    if (!sessionId || !isRecord(change) || change.kind !== 'goal/change') return false
    const operation = typeof change.operation === 'string' ? change.operation : ''
    const state = runs.get(sessionId)
    const goal = isRecord(change.goal) ? change.goal : null

    if (operation === 'clear') {
      const cleared = isRecord(change.cleared) ? change.cleared : null
      if (state && cleared && typeof cleared.id === 'string' && state.goalId && cleared.id !== state.goalId) {
        return false // stale tombstone for a previous goal
      }
      if (state) cancelTimer(state)
      runs.delete(sessionId)
      return true
    }
    if (!goal || typeof goal.id !== 'string') return false
    const revision = nonNegativeInteger(goal.revision)
    const rounds = nonNegativeInteger(change.roundsStarted)
    const phase = typeof goal.phase === 'string' ? goal.phase : 'active'

    if (operation === 'create' || operation === 'resume') {
      if (
        state &&
        !state.closed &&
        state.goalId === goal.id &&
        revision !== undefined &&
        state.revision !== undefined &&
        revision < state.revision
      ) {
        return false
      }
      start(sessionId, goal, rounds)
      return true
    }

    if (!state) return false
    if (state.goalId && goal.id !== state.goalId) return false
    if (revision !== undefined && state.revision !== undefined && revision < state.revision) {
      return false // stale transition
    }
    if (state.closed) {
      // Duplicate/late terminal event for an already finalized segment.
      return true
    }
    state.revision = revision ?? state.revision
    state.phase = phase
    if (rounds !== undefined) state.lastRounds = Math.max(nonNegativeInteger(state.lastRounds) ?? 0, rounds)
    if (operation === 'edit') return true
    if (operation === 'pause' || operation === 'complete' || operation === 'block') {
      if (state.terminal) return true // duplicate terminal before flush
      state.active = false
      state.armed = false
      state.terminal = true
      // A goal may terminate inside its final turn (DSH commits completion and
      // then supplies the wrap-up turn). Do not settle before that turn ends,
      // or the final text is missed and the final turn is notified separately.
      if (state.turnActive) {
        state.awaitingTurnEnd = true
      } else {
        schedule(sessionId, state)
      }
      return true
    }
    return true
  }

  /**
   * Observe admission of the next Goal Round. The durable goal/change counter
   * is also advanced by these user/message events; tracking them keeps the
   * count correct when a run ends by activation disarm rather than a terminal
   * goal/change snapshot.
   */
  function onGoalRound(sessionId, source) {
    if (!sessionId || !isRecord(source) || source.kind !== 'goal') return false
    const round = nonNegativeInteger(source.round)
    const goalId = sessionIdOf(source.goalId)
    if (round === undefined || round < 1 || !goalId) return false
    let state = runs.get(sessionId)
    const revision = nonNegativeInteger(source.revision)
    if (!state) {
      // Plugin loaded mid-goal: start from the previous round so only this
      // segment's admitted rounds are counted.
      state = {
        goalId,
        revision,
        phase: 'active',
        active: true,
        armed: true,
        baselineRounds: Math.max(0, round - 1),
        lastRounds: round,
        pending: null,
        timer: null,
        closed: false,
        terminal: false,
        turnActive: activeTurns.has(sessionId),
        awaitingTurnEnd: false,
        accountedTurn: null,
        deliveryOff: !deliveryEnabled(),
      }
      runs.set(sessionId, state)
      return true
    }
    if (state.closed) return false
    if (state.goalId && state.goalId !== goalId) return false
    if (revision !== undefined && state.revision !== undefined && revision < state.revision) return false
    state.goalId = goalId
    state.revision = revision ?? state.revision
    state.turnActive = state.turnActive || activeTurns.has(sessionId)
    state.lastRounds = Math.max(nonNegativeInteger(state.lastRounds) ?? 0, round)
    if (state.deliveryOff && deliveryEnabled()) {
      state.deliveryOff = false
      state.pending = null
      state.baselineRounds = Math.max(0, round - 1)
    }
    return true
  }

  /** Track the beginning of a root turn, so a terminal goal event can wait for its final turn. */
  function onTurnStart(sessionId) {
    if (!sessionId) return false
    activeTurns.add(sessionId)
    const state = runs.get(sessionId)
    if (state && !state.closed) state.turnActive = true
    return true
  }

  /** A failed/aborted turn is not buffered, but it must release a terminal wait. */
  function onTurnAbort(sessionId) {
    if (!sessionId) return false
    activeTurns.delete(sessionId)
    const state = runs.get(sessionId)
    if (!state) return false
    state.turnActive = false
    if (state.terminal && !state.closed) {
      state.awaitingTurnEnd = false
      schedule(sessionId, state)
    }
    return true
  }

  /** Process goal/activation-changed (e.g. session resume disarms an active goal). */
  function onActivation(payload) {
    if (!isRecord(payload)) return false
    const sessionId = sessionIdOf(payload.sessionId)
    if (!sessionId) return false
    const state = runs.get(sessionId)
    if (!state || state.closed) return false
    const goal = isRecord(payload.goal) ? payload.goal : null
    if (goal && typeof goal.id === 'string' && state.goalId && goal.id !== state.goalId) {
      return false
    }
    const activation = goal && typeof goal.activation === 'string' ? goal.activation : ''
    if (activation === 'armed') {
      state.armed = true
      if (state.phase === 'active' && !state.terminal) state.active = true
      return true
    }
    if (activation === 'disarmed' && state.active && !state.terminal) {
      state.active = false
      state.armed = false
      state.terminal = true
      if (state.phase === 'active') state.phase = 'paused'
      if (state.turnActive) {
        state.awaitingTurnEnd = true
      } else {
        schedule(sessionId, state)
      }
      return true
    }
    return true
  }

  /**
   * Buffer or release one completed root turn.
   *
   * @returns {boolean} true when the caller must not publish a per-turn completion.
   */
  function onTurnEnd(sessionId, completion = {}) {
    if (!sessionId) return false
    activeTurns.delete(sessionId)
    const state = runs.get(sessionId)
    if (!state) return false
    const turnKey = normalizedKey(completion.turnKey)
    state.turnActive = false

    // Observation continues while delivery is disabled, but a disabled run is
    // never retroactively summarized. Re-enabling starts a new accounting
    // segment at the current round, not at its completion.
    if (!deliveryEnabled()) {
      if (state.timer !== null) cancelTimer(state)
      state.deliveryOff = true
      state.pending = null
      if (state.lastRounds !== undefined) state.baselineRounds = state.lastRounds
      if (state.terminal) close(state, null)
      return false
    }

    if (state.deliveryOff) {
      state.deliveryOff = false
      state.pending = null
      state.baselineRounds =
        state.lastRounds === undefined ? state.baselineRounds : Math.max(0, state.lastRounds - 1)
    }

    if (state.closed) {
      // Suppress only a duplicate of the exact turn already accounted for.
      if (turnKey !== undefined && state.accountedTurn === turnKey) return true
      runs.delete(sessionId)
      return false
    }
    if (!state.active && state.timer === null && !state.terminal) return false

    state.pending = {
      text: typeof completion.text === 'string' && completion.text.length > 0 ? completion.text : null,
      sessionTitle: typeof completion.sessionTitle === 'string' ? completion.sessionTitle : undefined,
      turnKey: turnKey ?? null,
      at: now(),
    }
    if (!state.active) {
      state.awaitingTurnEnd = false
      schedule(sessionId, state)
    }
    return true
  }

  function dispose() {
    for (const state of runs.values()) cancelTimer(state)
    runs.clear()
    activeTurns.clear()
  }

  return {
    onGoalChange,
    onGoalRound,
    onTurnStart,
    onTurnAbort,
    onActivation,
    onTurnEnd,
    dispose,
    snapshot() {
      return Array.from(runs.entries()).map(([sessionId, state]) => ({
        sessionId,
        ...state,
        pending: state.pending ? { ...state.pending } : null,
      }))
    },
  }
}
