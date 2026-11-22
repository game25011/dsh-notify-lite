/**
 * dsh-notify-lite — "all sessions finished" title marker.
 *
 * Tracks root session turns that are currently running. The marker only arms
 * when at least two sessions overlap (the user asked for a multi-session
 * workflow); when the last of them ends successfully, it renames that last
 * session's title (default: "所有任务均已完成").
 *
 * Pure state machine: no timers, no I/O and no Cordis dependency, so it can be
 * unit-tested with fake sessions. The Host wires the title service and the
 * live config in.
 */

/** @returns {string|undefined} the session id when it is usable. */
function sessionId(session) {
  const value = session && session.id
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** @returns {string|undefined} end reason kind. */
function endReason(event) {
  const data = event && event.data
  const reason = data && data.reason
  return reason && typeof reason.kind === 'string' ? reason.kind : undefined
}

/**
 * Create the all-done title tracker.
 *
 * @param {object} [options]
 * @param {() => {allDoneTitleEnabled?: boolean, allDoneTitle?: string}} [options.getConfig]
 *   reads the live config; called at every observation so settings changes apply live.
 * @param {(session: any, title: string) => unknown} [options.renameTitle]
 *   asks the Host to rename a session; returning false means "unavailable".
 * @param {(error: unknown) => void} [options.onError] fatal-free error sink.
 * @returns {{
 *   onTurnStart: (session: any) => void,
 *   onTurnEnd: (session: any, event: any) => void,
 *   snapshot: () => {running: number, armed: boolean, dirty: boolean},
 *   dispose: () => void,
 * }}
 */
export function createAllDoneTitleTracker(options = {}) {
  const getConfig = typeof options.getConfig === 'function' ? options.getConfig : () => ({})
  const renameTitle = typeof options.renameTitle === 'function' ? options.renameTitle : () => false
  const onError = typeof options.onError === 'function' ? options.onError : () => {}

  /** @type {Map<string, any>} */
  const running = new Map()
  let armed = false
  let dirty = false
  let last = null
  let disposed = false

  function enabled() {
    try {
      return getConfig().allDoneTitleEnabled === true
    } catch (error) {
      onError(error)
      return false
    }
  }

  function title() {
    try {
      const value = getConfig().allDoneTitle
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    } catch (error) {
      onError(error)
    }
    return '所有任务均已完成'
  }

  function armIfNeeded() {
    if (running.size >= 2 && enabled()) armed = true
  }

  function resetBatch() {
    armed = false
    dirty = false
    last = null
  }

  function onTurnStart(session) {
    if (disposed) return
    const id = sessionId(session)
    if (!id) return
    if (running.size === 0) resetBatch()
    running.set(id, session)
    armIfNeeded()
  }

  function onTurnEnd(session, event) {
    if (disposed) return
    const id = sessionId(session)
    if (!id) return
    // A feature enabled while several sessions are already running must arm
    // before this end removes one of them.
    armIfNeeded()
    if (endReason(event) !== 'completed') dirty = true
    running.delete(id)
    last = session
    if (running.size > 0) return
    const shouldRename = armed && !dirty && enabled() && last !== null
    if (shouldRename) {
      try {
        renameTitle(last, title())
      } catch (error) {
        onError(error)
      }
    }
    resetBatch()
  }

  function snapshot() {
    return { running: running.size, armed, dirty }
  }

  function dispose() {
    disposed = true
    running.clear()
    resetBatch()
  }

  return { onTurnStart, onTurnEnd, snapshot, dispose }
}
