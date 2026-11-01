/**
 * dsh-notify-toast — Host configuration: defaults, patch validation, read
 * helpers, the volatile schemastery Config builder, and the pure completion
 * merge scheduler.
 *
 * Contract: docs/INTERFACE.md §2.4. Everything here is side-effect free and
 * unit-testable; the only platform-dependent step (resolving the profile copy
 * of `@deepseek-ai/schemastery`) lives in lib/index.js.
 */

/** package.json name / client module id / loader row id / settings namespace. */
export const PKG_ID = 'dsh-notify-toast'
/** Plugin version reported by every RPC endpoint. */
export const VERSION = '0.4.0'
/** Official Connection RPC channel (registered by the Host half). */
export const RPC_CHANNEL = '/dsh-notify-toast'
/** Settings namespace: the profile patch row id, which is also the package id. */
export const SETTINGS_NS = PKG_ID
/** Client locale namespace (client-owned; repeated here for completeness). */
export const LOCALE_NS = PKG_ID

/** Shipped defaults; also the fallback when neither settings nor Config exist. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  questionEnabled: true,
  approvalEnabled: true,
  completionEnabled: true,
  taskbarBadgeEnabled: true,
  titleOnly: false,
  bodyLength: 40,
  sound: 'ding',
  volume: 60,
  mergeIntervalMs: 2500,
  allDoneTitleEnabled: false,
  allDoneTitle: '所有任务均已完成',
  goalSummaryEnabled: true,
  notificationMode: 'native-progress',
  nativeDurationMs: 8000,
})

/**
 * Whitelist of editable fields with the validation rules from INTERFACE §2.4.
 * Only these keys may be read from a settings patch or written through RPC.
 */
export const CONFIG_FIELDS = Object.freeze({
  enabled: { type: 'boolean' },
  questionEnabled: { type: 'boolean' },
  approvalEnabled: { type: 'boolean' },
  completionEnabled: { type: 'boolean' },
  taskbarBadgeEnabled: { type: 'boolean' },
  titleOnly: { type: 'boolean' },
  bodyLength: { type: 'number', min: 20, max: 60, integer: true },
  sound: { type: 'enum', values: Object.freeze(['ding', 'chime', 'bell', 'soft', 'bubble', 'none']) },
  volume: { type: 'number', min: 0, max: 100, integer: true },
  mergeIntervalMs: { type: 'number', min: 0, max: 10000, integer: true },
  allDoneTitleEnabled: { type: 'boolean' },
  allDoneTitle: { type: 'string', minBytes: 1, maxBytes: 96 },
  goalSummaryEnabled: { type: 'boolean' },
  notificationMode: { type: 'enum', values: Object.freeze(['native', 'native-progress', 'native-and-inapp']) },
  nativeDurationMs: { type: 'number', min: 3000, max: 30000, integer: true },
})

/** Field order used when building the schemastery object. */
export const CONFIG_KEYS = Object.freeze(Object.keys(CONFIG_FIELDS))

/**
 * Unwrap one schemastery `.volatile()` reference (`{ get(): value }`) when a
 * Loader-validated Config object is read outside the form projection.
 *
 * @param {unknown} value candidate value.
 * @returns {unknown} the snapshot value, or `undefined` for a broken reference.
 */
export function unwrapVolatileValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/**
 * Read a Loader-validated config object (volatile refs) into plain values.
 *
 * @param {unknown} config `(ctx, config)` config object or a settings value.
 * @returns {Record<string, unknown>} only known keys that were present.
 */
export function unwrapConfigObject(config) {
  const result = {}
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return result
  for (const key of CONFIG_KEYS) {
    if (!Object.hasOwn(config, key)) continue
    const value = unwrapVolatileValue(config[key])
    if (value !== undefined) result[key] = value
  }
  return result
}

/**
 * UTF-8 byte length without depending on TextEncoder/Buffer.
 *
 * @param {string} text candidate text.
 * @returns {number} byte length.
 */
function utf8ByteLength(text) {
  let bytes = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

/**
 * Validate one value against its field spec.
 *
 * @param {{type: string, min?: number, max?: number, integer?: boolean, values?: readonly string[]}} spec field spec.
 * @param {unknown} value candidate.
 * @returns {{ok: true} | {ok: false, message: string}} result.
 */
export function checkConfigValue(spec, value) {
  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') return { ok: false, message: 'expected a boolean' }
    return { ok: true }
  }
  if (spec.type === 'string') {
    if (typeof value !== 'string') return { ok: false, message: 'expected a string' }
    const trimmed = value.trim()
    if (trimmed.length === 0) {
      if (spec.allowEmpty === true) return { ok: true }
      return { ok: false, message: 'must not be empty' }
    }
    if (typeof spec.minBytes === 'number' || typeof spec.maxBytes === 'number') {
      const bytes = utf8ByteLength(trimmed)
      if (typeof spec.minBytes === 'number' && bytes < spec.minBytes) return { ok: false, message: `must be at least ${spec.minBytes} bytes` }
      if (typeof spec.maxBytes === 'number' && bytes > spec.maxBytes) return { ok: false, message: `must be at most ${spec.maxBytes} bytes` }
    }
    return { ok: true }
  }
  if (spec.type === 'enum') {
    if (typeof value !== 'string' || !spec.values.includes(value)) {
      return { ok: false, message: `expected one of ${spec.values.map((v) => `"${v}"`).join(', ')}` }
    }
    return { ok: true }
  }
  // number
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, message: 'expected a finite number' }
  if (spec.integer && !Number.isInteger(value)) return { ok: false, message: 'expected an integer' }
  if (typeof spec.min === 'number' && value < spec.min) return { ok: false, message: `must be >= ${spec.min}` }
  if (typeof spec.max === 'number' && value > spec.max) return { ok: false, message: `must be <= ${spec.max}` }
  return { ok: true }
}

/**
 * Validate an RPC `save` patch: whitelist + type + range/enum checks only.
 *
 * Unknown keys are rejected (no silent drops) so a stale client cannot write a
 * field this Host version does not understand.
 *
 * @param {unknown} patch candidate patch object.
 * @returns {{ok: true, patch: object} | {ok: false, error: {code: string, message: string}}} result.
 */
export function validatePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: { code: 'invalid-patch', message: 'patch must be a plain object' } }
  }
  const clean = {}
  for (const key of Object.keys(patch)) {
    const spec = CONFIG_FIELDS[key]
    if (!spec) {
      return { ok: false, error: { code: 'unknown-field', message: `unknown config field "${key}"` } }
    }
    const value = patch[key]
    const checked = checkConfigValue(spec, value)
    if (!checked.ok) {
      return { ok: false, error: { code: 'invalid-value', message: `config field "${key}" ${checked.message}` } }
    }
    clean[key] = value
  }
  return { ok: true, patch: clean }
}

/**
 * Normalize any config-shaped value (defaults + only valid known fields).
 *
 * Invalid or unknown values are ignored rather than thrown: this is the read
 * path, which must keep the plugin usable even when the settings document was
 * edited by hand.
 *
 * @param {unknown} raw defaults base, Loader config object or settings value.
 * @returns {typeof DEFAULTS} a fresh plain config object.
 */
export function normalizeConfig(raw) {
  const result = { ...DEFAULTS }
  const plain = unwrapConfigObject(raw)
  for (const key of CONFIG_KEYS) {
    if (!Object.hasOwn(plain, key)) continue
    const value = plain[key]
    if (checkConfigValue(CONFIG_FIELDS[key], value).ok) result[key] = value
  }
  return result
}

/**
 * Merge a validated patch over a base config.
 *
 * @param {unknown} base current config (normalized first).
 * @param {unknown} patch patch object; invalid fields are ignored.
 * @returns {typeof DEFAULTS} merged plain config.
 */
export function mergeConfig(base, patch) {
  const merged = normalizeConfig(base)
  const plain = unwrapConfigObject(patch)
  for (const key of CONFIG_KEYS) {
    if (!Object.hasOwn(plain, key)) continue
    const value = plain[key]
    if (checkConfigValue(CONFIG_FIELDS[key], value).ok) merged[key] = value
  }
  return merged
}

/**
 * Build the all-volatile schemastery Config object.
 *
 * Every field is `.volatile()`: the official settings layer only persists and
 * hot-applies volatile fields (docs/INTERFACE.md), and the Loader then updates
 * the stable config references in place without remounting the plugin.
 *
 * @param {{object: Function, boolean: Function, number: Function, union: Function}} Schema
 *   the schemastery default export (resolved from the profile in lib/index.js).
 * @returns {unknown} a schemastery schema object.
 * @throws {TypeError} when the supplied module does not look like schemastery.
 */
export function buildConfigSchema(Schema) {
  if (!Schema || typeof Schema.object !== 'function' || typeof Schema.boolean !== 'function') {
    throw new TypeError('schemastery module is missing Schema.object/boolean')
  }
  return Schema.object({
    enabled: Schema.boolean().default(DEFAULTS.enabled).volatile(),
    questionEnabled: Schema.boolean().default(DEFAULTS.questionEnabled).volatile(),
    approvalEnabled: Schema.boolean().default(DEFAULTS.approvalEnabled).volatile(),
    completionEnabled: Schema.boolean().default(DEFAULTS.completionEnabled).volatile(),
    taskbarBadgeEnabled: Schema.boolean().default(DEFAULTS.taskbarBadgeEnabled).volatile(),
    titleOnly: Schema.boolean().default(DEFAULTS.titleOnly).volatile(),
    bodyLength: Schema.number().min(20).max(60).step(1).default(DEFAULTS.bodyLength).volatile(),
    sound: Schema.union(['ding', 'chime', 'bell', 'soft', 'bubble', 'none']).default(DEFAULTS.sound).volatile(),
    volume: Schema.number().min(0).max(100).step(1).default(DEFAULTS.volume).volatile(),
    mergeIntervalMs: Schema.number().min(0).max(10000).step(100).default(DEFAULTS.mergeIntervalMs).volatile(),
    allDoneTitleEnabled: Schema.boolean().default(DEFAULTS.allDoneTitleEnabled).volatile(),
    allDoneTitle: Schema.string().default(DEFAULTS.allDoneTitle).volatile(),
    goalSummaryEnabled: Schema.boolean().default(DEFAULTS.goalSummaryEnabled).volatile(),
    notificationMode: Schema.union(['native', 'native-progress', 'native-and-inapp']).default(DEFAULTS.notificationMode).volatile(),
    nativeDurationMs: Schema.number().min(3000).max(30000).step(100).default(DEFAULTS.nativeDurationMs).volatile(),
  })
}

/**
 * Create the completion merge scheduler (INTERFACE §2.5 item 5).
 *
 * The scheduler batches completion events for `mergeIntervalMs`: the first
 * event opens a batch and schedules one timer; later events inside the window
 * update the batch (latest text/session, count++) instead of publishing. The
 * timer is the only stateful dependency, so tests inject fake timer functions.
 *
 * Semantics:
 * - a duplicate (sessionId+turn) is rejected before entering the batch;
 * - `count` is published only when it is greater than 1 (default is 1);
 * - a later completion without text keeps the last non-empty text;
 * - `dispose()` drops a pending batch without publishing (the plugin is
 *   unloading, so the event queue is going away too).
 *
 * @param {object} [options]
 * @param {(payload: object) => unknown} [options.publish] receives the merged
 *   `kind:'complete'` payload (without id/at; the queue adds those).
 * @param {() => number} [options.now] clock (unused placeholders for callers).
 * @param {(callback: () => void, ms: number) => unknown} [options.setTimer] timer factory.
 * @param {(timer: unknown) => void} [options.clearTimer] timer canceller.
 * @param {() => number} [options.getIntervalMs] reads the current merge window.
 * @param {(sessionId: string|undefined, turn: number|undefined) => boolean} [options.isDuplicate]
 *   dedupe predicate consulted for every queued completion.
 * @returns {{queue: Function, flushNow: Function, pending: Function, stats: Function, dispose: Function}}
 */
export function createMergeScheduler(options = {}) {
  const {
    publish = () => {},
    now = () => Date.now(),
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (timer) => clearTimeout(timer),
    getIntervalMs = () => DEFAULTS.mergeIntervalMs,
    isDuplicate = () => false,
  } = options

  let batch = null
  let batchSessionIds = new Set()
  let timer = null
  let disposed = false
  let merged = 0

  const clearPendingTimer = () => {
    if (timer === null) return
    try {
      clearTimer(timer)
    } catch {
      /* timer already gone */
    }
    timer = null
  }

  const flush = () => {
    if (batch === null) return null
    const current = batch
    const sessionIds = batchSessionIds
    batch = null
    batchSessionIds = new Set()
    clearPendingTimer()
    const payload = {
      kind: 'complete',
      text: current.text === null ? null : current.text,
    }
    // INTERFACE §2.5: `count` is only carried when a batch actually merged.
    if (current.count > 1) payload.count = current.count
    if (sessionIds.size > 1) payload.sessionIds = Array.from(sessionIds)
    if (current.allDone === true) payload.allDone = true
    if (current.sessionId !== undefined) payload.sessionId = current.sessionId
    if (current.sessionTitle !== undefined) payload.sessionTitle = current.sessionTitle
    try {
      publish(payload)
    } catch {
      /* publishing is the caller's problem; never break the timer chain */
    }
    return payload
  }

  const schedule = () => {
    let interval
    try {
      interval = Number(getIntervalMs())
    } catch {
      interval = DEFAULTS.mergeIntervalMs
    }
    if (!Number.isFinite(interval) || interval <= 0) {
      flush()
      return
    }
    try {
      timer = setTimer(() => {
        timer = null
        flush()
      }, interval)
    } catch {
      timer = null
      flush()
    }
  }

  return {
    /**
     * Queue one completed root turn.
     * @param {{sessionId?: string, sessionTitle?: string, text?: string|null, turn?: number, allDone?: boolean}} entry
     * @returns {boolean} whether the entry was accepted.
     */
    queue(entry) {
      if (disposed) return false
      const current = entry && typeof entry === 'object' ? entry : {}
      try {
        if (isDuplicate(current.sessionId, current.turn)) return false
      } catch {
        /* a broken predicate must not swallow the completion */
      }
      const text = typeof current.text === 'string' && current.text !== '' ? current.text : null
      if (batch !== null) {
        batch.count += 1
        merged += 1
        if (current.allDone === true) batch.allDone = true
        if (current.sessionId !== undefined) {
          batch.sessionId = current.sessionId
          batchSessionIds.add(current.sessionId)
        }
        if (current.sessionTitle !== undefined) batch.sessionTitle = current.sessionTitle
        if (text !== null) batch.text = text
        return true
      }
      batchSessionIds = new Set(current.sessionId !== undefined ? [current.sessionId] : [])
      batch = {
        sessionId: current.sessionId,
        sessionTitle: current.sessionTitle,
        text,
        count: 1,
        openedAt: now(),
      }
      if (current.allDone === true) batch.allDone = true
      schedule()
      return true
    },
    /** Publish the pending batch immediately (used by tests and flush hooks). */
    flushNow() {
      return flush()
    },
    /** Snapshot of the pending batch, or null. */
    pending() {
      return batch === null ? null : { ...batch }
    },
    /** Cumulative merge counters for the settings page. */
    stats() {
      return { merged }
    },
    /** Drop the pending batch and timer; safe to call twice. */
    dispose() {
      disposed = true
      clearPendingTimer()
      batch = null
      batchSessionIds = new Set()
    },
  }
}
