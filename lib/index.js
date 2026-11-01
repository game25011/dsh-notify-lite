/**
 * dsh-notify-toast — Host half.
 *
 * Detects "user attention needed" events in the DeepSeek Harness Host process,
 * cleans/merges them into a small ring buffer, and serves them to the browser
 * half over a same-origin long-poll route `/dsh-notify-toast` fenced by the
 * official Connection Host/Origin + signed-cookie check. It also implements the
 * Windows window-raise used when a toast is clicked, and persists its Config
 * through the official settings service.
 *
 * Contract: docs/INTERFACE.md §2. Optional services are injected one at a
 * time so a missing `connection`/`settings` degrades the feature instead of
 * preventing the plugin from mounting.
 *
 * Imports are Node builtins only; `@deepseek-ai/schemastery` is resolved from
 * the active profile at load time (see `resolveConfigSchema`).
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PKG_ID,
  RPC_CHANNEL,
  SETTINGS_NS,
  VERSION,
  buildConfigSchema,
  createMergeScheduler,
  normalizeConfig,
  unwrapConfigObject,
  validatePatch,
} from './config.js'
import { createAllDoneTitleTracker } from './all-done.js'
import { createGoalSummaryTracker } from './goal-summary.js'
import { createNativeToastManager } from './native-toast.js'
import { createTaskbarBadgeManager } from './taskbar-badge.js'
import { extractFirstTextParagraph, toSingleLine, truncateCodepoints } from './text.js'
import { focusDesktopWindow, nativeFocusAvailable } from './native-focus.js'

export const name = PKG_ID
export const inject = []

/** Event ring buffer size (INTERFACE §2.3). */
const EVENT_BUFFER_MAX = 200
/** Maximum events returned by one poll response. */
const POLL_BATCH_LIMIT = 100
/** Long-poll wait clamp (INTERFACE §2.3). */
const POLL_WAIT_MIN = 1000
const POLL_WAIT_MAX = 25000
const POLL_WAIT_DEFAULT = 25000
/** Runtime config cache lifetime; invalidated by settings/document-updated. */
const CONFIG_CACHE_MS = 500
/** Duplicate-event window for approval/question/completion (INTERFACE §2.5). */
const DEDUPE_WINDOW_MS = 5000
const DEDUPE_LIMIT = 200
/** How many events to scan backwards for the completion text. */
const COMPLETION_SCAN = 200
/** Completion body cap (cleaned code points, ellipsis included). */
const COMPLETION_TEXT_LIMIT = 400
/** Question text cap; the Host sends the raw question, the client truncates. */
const QUESTION_TEXT_LIMIT = 2000
/** Approval purpose cap (code points). */
const PURPOSE_LIMIT = 120
const TOOL_NAME_LIMIT = 120
/** Session-title scan window (head and tail of the log). */
const TITLE_SCAN = 200
const TITLE_CACHE_LIMIT = 300
/** Fixed body for `kind:'test'` (INTERFACE §2.3); the client may localize instead. */
const TEST_TEXT = 'Test notification'
/** Pure route prefix (the client calls `<channel>/<endpoint>` relatively). */
const RPC_PATH = RPC_CHANNEL
/** Maximum accepted JSON request body for one RPC call (bytes). */
const RPC_BODY_LIMIT = 64 * 1024
/** Endpoint segment grammar expected by the official Connection client. */
const RPC_ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/**
 * Candidate directories that may anchor the profile's `@deepseek-ai/schemastery`
 * resolution. The Desktop Host process is spawned with `cwd` = the active
 * profile directory and does not always receive `DSH_PROFILE_DIR`, so the cwd,
 * its parent layout and the well-known home layouts are all considered.
 *
 * @returns {Array<{dir: string, source: string}>} ordered anchors.
 */
function profileDirCandidates() {
  const profile = (() => {
    try {
      return process.env.DSH_PROFILE || 'desktop'
    } catch {
      return 'desktop'
    }
  })()
  const candidates = []
  const seen = new Set()
  const push = (dir, source) => {
    if (typeof dir !== 'string' || dir.length === 0 || seen.has(dir)) return
    seen.add(dir)
    candidates.push({ dir, source })
  }
  try {
    push(process.env.DSH_PROFILE_DIR, 'env-profile-dir')
  } catch {
    /* ignore */
  }
  try {
    const cwd = process.cwd()
    push(cwd, 'cwd')
    push(join(cwd, 'profiles', profile), 'cwd-profiles')
    const home = dirname(dirname(cwd))
    push(join(home, 'profiles', profile), 'cwd-home')
    push(join(cwd, '..', '..'), 'cwd-home-raw')
  } catch {
    /* ignore */
  }
  try {
    const home = process.env.DSH_HOME
    if (home) push(join(home, 'profiles', profile), 'env-profile-home')
    push(join(homedir(), '.dsh', 'profiles', profile), 'homedir-profile')
  } catch {
    /* ignore */
  }
  try {
    push(dirname(fileURLToPath(import.meta.url)), 'plugin-dir')
  } catch {
    /* ignore */
  }
  return candidates
}

/**
 * Resolve the profile's `@deepseek-ai/schemastery` and build the all-volatile
 * Config schema. The profile's own copy is preferred because the loader's
 * Config validation uses the `~standard` vendor tag rather than an instanceof
 * check, so cross-instance schemas are accepted. The DSH installation's copy
 * inside `app.asar` is the last resort.
 *
 * @returns {{Config: unknown, source: string}} schema and its provenance.
 */
function resolveConfigSchema() {
  for (const attempt of profileDirCandidates()) {
    try {
      const requireFrom = createRequire(join(attempt.dir, 'package.json'))
      const schemastery = requireFrom('@deepseek-ai/schemastery')
      const Schema = schemastery?.default ?? schemastery
      return { Config: buildConfigSchema(Schema), source: attempt.source }
    } catch {
      /* try the next anchor */
    }
  }
  try {
    const resources = typeof process.resourcesPath === 'string' && process.resourcesPath
      ? process.resourcesPath
      : join(dirname(process.execPath), 'resources')
    const archiveAnchor = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'package.json')
    const requireFrom = createRequire(archiveAnchor)
    const schemastery = requireFrom('@deepseek-ai/schemastery')
    return { Config: buildConfigSchema(schemastery?.default ?? schemastery), source: 'dsh-archive' }
  } catch {
    return { Config: undefined, source: 'unresolved' }
  }
}


const resolvedSchema = resolveConfigSchema()

/**
 * The all-volatile Config schema, or undefined when no schemastery copy could
 * be resolved (the plugin then runs with in-memory defaults and the settings
 * form is unavailable — docs/INTERFACE.md §2.1).
 *
 * @type {unknown}
 */
const Config = resolvedSchema.Config
export { Config }


/**
 * Read an optional Cordis service without a hard inject requirement.
 *
 * @param {any} ctx plugin context.
 * @param {string} serviceName service key.
 * @returns {any} the service or undefined.
 */
function getService(ctx, serviceName) {
  try {
    return ctx.get(serviceName)
  } catch {
    return undefined
  }
}

/** @returns {string} a short, safe error message. */
function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 500 ? `${message.slice(0, 500)}…` : message
}

/**
 * Log a warning through the Cordis logger; never throws.
 *
 * @param {any} ctx plugin context.
 * @param {string} message message.
 * @param {unknown} [error] optional cause.
 */
function logWarn(ctx, message, error) {
  try {
    const logger = ctx.logger
    if (!logger || typeof logger.warn !== 'function') return
    const detail = error === undefined ? '' : `: ${errorMessage(error)}`
    logger.warn(`[${PKG_ID}] ${message}${detail}`)
  } catch {
    /* logging must never break the plugin */
  }
}

/**
 * Clamp a long-poll wait into the contract range.
 *
 * @param {unknown} value requested wait in ms.
 * @returns {number} wait in [POLL_WAIT_MIN, POLL_WAIT_MAX].
 */
function clampWait(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return POLL_WAIT_DEFAULT
  return Math.min(POLL_WAIT_MAX, Math.max(POLL_WAIT_MIN, Math.round(number)))
}

/**
 * Ring-buffered event queue with long-poll waiters.
 *
 * - ids are monotonically increasing across the Host process lifetime;
 * - only the last `max` events are retained, and a stale cursor is clamped so
 *   a Host restart resynchronizes instead of replaying history;
 * - a waiter resolves immediately when an event with a larger id lands, or on
 *   its timeout / AbortSignal / queue disposal.
 *
 * @param {object} [options]
 * @param {number} [options.max] ring size.
 * @param {() => number} [options.now] clock.
 * @returns {object} queue API.
 */
function createEventQueue(options = {}) {
  const max = typeof options.max === 'number' && options.max > 0 ? options.max : EVENT_BUFFER_MAX
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const buffer = []
  const waiters = new Set()
  let nextId = 1
  let disposed = false

  const lastId = () => nextId - 1

  const collect = (after) => {
    const events = []
    for (const event of buffer) {
      if (event.id <= after) continue
      events.push(event)
      if (events.length >= POLL_BATCH_LIMIT) break
    }
    return events
  }

  const result = (events, cursor) => ({
    ok: true,
    events,
    next: events.length > 0 ? events[events.length - 1].id : cursor,
    serverTime: now(),
  })

  const wake = () => {
    for (const waiter of Array.from(waiters)) {
      try {
        const events = collect(waiter.after)
        if (events.length > 0) waiter.finish(events)
      } catch {
        waiter.finish([])
      }
    }
  }

  return {
    /**
     * Append one event and wake matching waiters.
     * @param {object} payload event body without id/at.
     * @returns {object|null} the stored event, or null after disposal.
     */
    publish(payload) {
      if (disposed) return null
      const event = { id: nextId, at: now(), ...payload }
      nextId += 1
      buffer.push(event)
      if (buffer.length > max) buffer.splice(0, buffer.length - max)
      wake()
      return event
    },
    /**
     * Return events after `after` immediately, or wait for the next one.
     * @param {number} after exclusive cursor.
     * @param {number} wait maximum hold time in ms.
     * @param {AbortSignal} [signal] client-disconnect signal.
     * @returns {Promise<object>} `{ok, events, next, serverTime}`.
     */
    poll(after, wait, signal) {
      if (disposed) return Promise.resolve(result([], lastId()))
      let cursor = typeof after === 'number' && Number.isFinite(after) ? Math.max(0, Math.floor(after)) : 0
      if (cursor > lastId()) cursor = lastId()
      const pending = collect(cursor)
      if (pending.length > 0) return Promise.resolve(result(pending, cursor))
      if (!Number.isFinite(wait) || wait <= 0) return Promise.resolve(result([], cursor))
      if (signal && signal.aborted) return Promise.resolve(result([], cursor))
      return new Promise((resolve) => {
        let timer = null
        let onAbort = null
        let finished = false
        const waiter = {
          after: cursor,
          finish(events) {
            if (finished) return
            finished = true
            waiters.delete(waiter)
            if (timer !== null) {
              try {
                clearTimeout(timer)
              } catch {
                /* ignore */
              }
              timer = null
            }
            if (onAbort && signal) {
              try {
                signal.removeEventListener('abort', onAbort)
              } catch {
                /* ignore */
              }
              onAbort = null
            }
            resolve(result(events, cursor))
          },
        }
        waiters.add(waiter)
        try {
          timer = setTimeout(() => waiter.finish([]), wait)
        } catch {
          waiter.finish([])
          return
        }
        if (signal) {
          onAbort = () => waiter.finish([])
          try {
            signal.addEventListener('abort', onAbort, { once: true })
          } catch {
            onAbort = null
          }
        }
      })
    },
    /** Number of currently held long-poll requests (≈ connected clients). */
    waiterCount() {
      return waiters.size
    },
    /** Current cursor value (id of the last published event). */
    lastId,
    /** Number of retained events. */
    size() {
      return buffer.length
    },
    /** Resolve every waiter with an empty result and drop buffered events. */
    dispose() {
      if (disposed) return
      disposed = true
      for (const waiter of Array.from(waiters)) {
        try {
          waiter.finish([])
        } catch {
          /* ignore */
        }
      }
      waiters.clear()
      buffer.length = 0
    },
  }
}

/**
 * Small time-windowed dedupe set.
 *
 * @param {object} [options]
 * @param {number} [options.windowMs] duplicate window.
 * @param {number} [options.limit] maximum tracked keys.
 * @param {() => number} [options.now] clock.
 * @returns {{seen: Function, clear: Function}} dedupe API.
 */
function createDedupe(options = {}) {
  const windowMs = typeof options.windowMs === 'number' ? options.windowMs : DEDUPE_WINDOW_MS
  const limit = typeof options.limit === 'number' ? options.limit : DEDUPE_LIMIT
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const entries = new Map()
  return {
    /**
     * @param {string} kind event kind.
     * @param {string} key stable identity.
     * @returns {boolean} true when this identity was seen inside the window.
     */
    seen(kind, key) {
      const stamp = now()
      const composite = `${kind}\u0000${key}`
      const previous = entries.get(composite)
      if (previous !== undefined && stamp - previous < windowMs) return true
      entries.set(composite, stamp)
      if (entries.size > limit) {
        for (const [entryKey, at] of entries) {
          if (stamp - at >= windowMs) entries.delete(entryKey)
        }
        while (entries.size > limit) {
          const oldest = entries.keys().next().value
          if (oldest === undefined) break
          entries.delete(oldest)
        }
      }
      return false
    },
    clear() {
      entries.clear()
    },
  }
}

/** @returns {boolean} true for a root (non-subagent, non-fork) session header. */
function isRootSession(session) {
  const header = session && typeof session === 'object' ? session.header : undefined
  if (!header || typeof header !== 'object') return false
  if (header.parentSession) return false
  if (header.origin === 'subagent') return false
  return true
}

/** @returns {string|undefined} the value when it is a non-empty string. */
function asString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** @returns {string|undefined} the latest `session/title` text inside an event array. */
function lastTitleIn(events) {
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event || event.type !== 'session/title') continue
    const title = event.data && event.data.title
    if (typeof title === 'string' && title.trim()) return title.trim()
  }
  return undefined
}

/**
 * Build the whole per-instance Host state: config cache, counters, queues,
 * title cache, dedupe and event handlers.
 *
 * @param {any} ctx plugin context.
 * @param {unknown} config Loader-validated Config (volatile references).
 * @returns {object} state API consumed by `apply`.
 */
function createHostState(ctx, config) {
  const configCache = { at: 0, value: normalizeConfig(unwrapConfigObject(config)) }
  const counters = { questions: 0, approvals: 0, completions: 0, lastEventAt: 0 }
  /** Root-session overlap tracking for the all-done notification (independent of title rename). */
  const rootRunning = new Set()
  let rootFailed = false
  let rootOverlapped = false
  /** Observable transport/config provenance shown by the settings page. */
  const diagnostics = { transport: 'none', configSource: resolvedSchema.source }
  let lastEvent = null
  const titleCache = new Map()
  const dedupe = createDedupe()
  const queue = createEventQueue()

  const publishEvent = (payload) => {
    const event = queue.publish(payload)
    if (event) {
      counters.lastEventAt = event.at
      lastEvent = { kind: event.kind, at: event.at }
    }
    return event
  }

  const merger = createMergeScheduler({
    publish: (payload) => publishEvent(payload),
    getIntervalMs: () => readConfig().mergeIntervalMs,
    isDuplicate: (sessionId, turn) => dedupe.seen('complete', `${sessionId ?? '-'}:${turn ?? '-'}`),
  })

  const goalSummary = createGoalSummaryTracker({
    enabled: () => {
      const value = readConfig()
      return value.enabled !== false && value.completionEnabled !== false && value.goalSummaryEnabled !== false
    },
    getIntervalMs: () => readConfig().mergeIntervalMs,
    onSummary: (payload) => publishEvent(payload),
  })

  const nativeToast = createNativeToastManager({
    scriptPath: join(dirname(fileURLToPath(import.meta.url)), 'native-toast.ps1'),
    onActivate: (sessionId) => {
      try {
        focusDesktopWindow()
      } catch {
        /* focus is best-effort */
      }
      if (sessionId) publishEvent({ kind: 'activate', sessionId, at: Date.now() })
    },
    logWarn: (message, error) => logWarn(ctx, message, error),
  })

  const taskbarBadge = createTaskbarBadgeManager({
    scriptPath: join(dirname(fileURLToPath(import.meta.url)), 'taskbar-badge.ps1'),
    logWarn: (message, error) => logWarn(ctx, message, error),
  })

  /** Multi-session "all done" title marker (opt-in; see lib/all-done.js). */
  const allDoneTitle = createAllDoneTitleTracker({
    getConfig: () => readConfig(),
    renameTitle: (session, title) => {
      const titles = getService(ctx, 'sessionTitle')
      if (!titles || typeof titles.rename !== 'function') return false
      titles.rename(session, title)
      return true
    },
    onError: (error) => logWarn(ctx, 'all-done title marker failed', error),
  })

  /**
   * Read the live config: Loader references first, the settings descriptor on
   * top (it is the authoritative persisted form). Cached for 500 ms and
   * invalidated by `settings/document-updated`.
   *
   * @returns {typeof DEFAULTS} plain config.
   */
  function readConfig() {
    const stamp = Date.now()
    if (stamp - configCache.at < CONFIG_CACHE_MS) return configCache.value
    let value = normalizeConfig(unwrapConfigObject(config))
    const settings = getService(ctx, 'settings')
    if (settings && typeof settings.describe === 'function') {
      try {
        const descriptor = settings.describe().find((row) => row && row.ns === SETTINGS_NS)
        if (descriptor) value = normalizeConfig({ ...value, ...unwrapConfigObject(descriptor.value) })
      } catch {
        /* keep the Loader-provided values */
      }
    }
    configCache.at = stamp
    configCache.value = value
    return value
  }

  function invalidateConfig() {
    configCache.at = 0
  }

  function settingsAvailable() {
    if (!Config) return false
    const settings = getService(ctx, 'settings')
    return Boolean(settings && typeof settings.update === 'function')
  }

  function rememberTitle(sessionId, title) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    if (typeof title !== 'string' || title.trim() === '') return
    if (titleCache.size >= TITLE_CACHE_LIMIT && !titleCache.has(sessionId)) {
      const oldest = titleCache.keys().next().value
      if (oldest !== undefined) titleCache.delete(oldest)
    }
    titleCache.set(sessionId, title.trim())
  }

  /**
   * Fold the latest durable title out of a session log (head first, then the
   * tail), without loading the log into the client.
   *
   * @param {any} session Session API object.
   * @param {number} seq exclusive end position.
   * @returns {string|undefined} title text.
   */
  function readTitle(session, seq) {
    try {
      const end = typeof seq === 'number' && Number.isFinite(seq) ? Math.floor(seq) : Number(session?.seq)
      if (!Number.isFinite(end) || end <= 0 || typeof session.snapshotEvents !== 'function') return undefined
      const head = session.snapshotEvents(0, Math.min(end, TITLE_SCAN))
      const headTitle = lastTitleIn(head)
      if (headTitle !== undefined) return headTitle
      const from = Math.max(0, end - TITLE_SCAN)
      return lastTitleIn(session.snapshotEvents(from, end))
    } catch {
      return undefined
    }
  }

  function titleForSessionId(sessionId) {
    try {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
      const cached = titleCache.get(sessionId)
      if (typeof cached === 'string') return cached
      const sessions = getService(ctx, 'sessions')
      const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
      if (!session) return undefined
      const title = readTitle(session, session.seq)
      rememberTitle(sessionId, title)
      return title
    } catch {
      return undefined
    }
  }

  function titleOf(session, event) {
    try {
      const sessionId = asString(session && session.id)
      if (!sessionId) return undefined
      const cached = titleCache.get(sessionId)
      if (typeof cached === 'string') return cached
      const title = readTitle(session, event && event.seq)
      rememberTitle(sessionId, title)
      return title
    } catch {
      return undefined
    }
  }

  /** Pick the approval purpose in the user's locale (fallback: any language). */
  function preferredLocale() {
    try {
      const settings = getService(ctx, 'settings')
      if (settings && typeof settings.describe === 'function') {
        const descriptor = settings.describe().find((row) => row && row.ns === 'locale')
        const preference = descriptor && descriptor.value && descriptor.value.preference
        if (typeof preference === 'string' && /^[A-Za-z]{2,8}/.test(preference)) return preference
      }
    } catch {
      /* fall through */
    }
    return 'zh'
  }

  /** @returns {string} a short single-line purpose for an approval request. */
  function approvalPurpose(request) {
    try {
      const display = request && request.displayReason
      if (display && typeof display === 'object') {
        for (const key of [preferredLocale(), 'zh', 'en']) {
          const candidate = display[key]
          if (typeof candidate === 'string' && candidate.trim()) return toSingleLine(candidate)
        }
        for (const candidate of Object.values(display)) {
          if (typeof candidate === 'string' && candidate.trim()) return toSingleLine(candidate)
        }
      }
      const reason = request && request.reason
      return typeof reason === 'string' ? toSingleLine(reason) : ''
    } catch {
      return ''
    }
  }

  /**
   * Extract the completion body: the nearest `assistant/message` at or before
   * `turn/end`, scanning at most COMPLETION_SCAN events backwards.
   *
   * @returns {string|null} cleaned first paragraph capped at 400 code points.
   */
  function completionText(session, event) {
    try {
      const end = Number(event && event.seq)
      if (!Number.isFinite(end) || typeof session.eventAt !== 'function') return null
      const from = Math.max(0, end - COMPLETION_SCAN)
      for (let seq = end - 1; seq >= from; seq -= 1) {
        const sibling = session.eventAt(seq)
        if (!sibling || sibling.type !== 'assistant/message') continue
        // The nearest assistant message decides the body: if it has no text
        // block (tool-only step), the contract says the body is null.
        const paragraph = extractFirstTextParagraph(sibling.data && sibling.data.message && sibling.data.message.content)
        return paragraph ? truncateCodepoints(paragraph, COMPLETION_TEXT_LIMIT) : null
      }
    } catch {
      /* treat a broken log read as "no text" */
    }
    return null
  }

  function onApprovalRequest(request) {
    try {
      counters.approvals += 1
      const value = readConfig()
      if (!value.enabled || !value.approvalEnabled) return
      const agentId = asString(request && request.agent && request.agent.id)
      const toolName = asString(request && request.toolName)
      const callId = asString(request && request.callId)
      if (dedupe.seen('approval', `${agentId ?? '-'}|${callId ?? toolName ?? '-'}`)) return
      const body = { kind: 'approval' }
      if (agentId) body.sessionId = agentId
      const sessionTitle = titleForSessionId(agentId)
      if (sessionTitle) body.sessionTitle = sessionTitle
      if (toolName) body.toolName = truncateCodepoints(toSingleLine(toolName), TOOL_NAME_LIMIT)
      const purpose = truncateCodepoints(approvalPurpose(request), PURPOSE_LIMIT)
      if (purpose) body.purpose = purpose
      publishEvent(body)
    } catch {
      /* an approval must never be blocked by a notification bug */
    }
  }

  function onUserQuestion(request) {
    try {
      counters.questions += 1
      const value = readConfig()
      if (!value.enabled || !value.questionEnabled) return
      const agentId = asString(request && request.agent && request.agent.id)
      const questions = Array.isArray(request && request.questions) ? request.questions : []
      const first = questions[0] && typeof questions[0] === 'object' ? questions[0] : undefined
      const waitCallId = request && request.wait ? asString(request.wait.callId) : undefined
      const intentCallId = first && first.intent ? asString(first.intent.callId) : undefined
      const callId = waitCallId ?? intentCallId
      const identity = callId ?? asString(first && first.id) ?? asString(first && first.question)
      if (dedupe.seen('question', `${agentId ?? '-'}|${identity ?? '-'}`)) return
      const body = { kind: 'question' }
      if (agentId) body.sessionId = agentId
      const sessionTitle = titleForSessionId(agentId)
      if (sessionTitle) body.sessionTitle = sessionTitle
      const questionText = asString(first && first.question)
      body.text = questionText ? truncateCodepoints(questionText.trim(), QUESTION_TEXT_LIMIT) : null
      publishEvent(body)
    } catch {
      /* a question must never be blocked by a notification bug */
    }
  }

  function onSessionEvent(session, event) {
    try {
      if (!event || typeof event.type !== 'string') return
      if (event.type === 'goal/change') {
        const sessionId = asString(session && session.id)
        if (sessionId) goalSummary.onGoalChange(sessionId, event.data || event)
        return
      }
      if (event.type === 'user/message') {
        const source = event.data && event.data.source
        if (source && source.kind === 'goal') {
          const sessionId = asString(session && session.id)
          if (sessionId) goalSummary.onGoalRound(sessionId, source)
          return
        }
      }
      if (event.type === 'session/title') {
        const sessionId = asString(session && session.id)
        const title = event.data && event.data.title
        if (sessionId && typeof title === 'string' && title.trim()) rememberTitle(sessionId, title)
        return
      }
      if (event.type === 'turn/start') {
        if (isRootSession(session)) {
          const goalSessionId = asString(session && session.id)
          if (goalSessionId) goalSummary.onTurnStart(goalSessionId)
          if (rootRunning.size === 0) {
            rootFailed = false
            rootOverlapped = false
          }
          const id = asString(session && session.id)
          if (id) rootRunning.add(id)
          if (rootRunning.size >= 2) rootOverlapped = true
          allDoneTitle.onTurnStart(session)
        }
        return
      }
      if (event.type === 'turn/end') {
        const rootSession = isRootSession(session)
        const reasonKind = event.data && event.data.reason && event.data.reason.kind
        const rootId = rootSession ? asString(session && session.id) : ''
        if (rootSession) {
          if (reasonKind !== 'completed') rootFailed = true
          if (rootId) rootRunning.delete(rootId)
          allDoneTitle.onTurnEnd(session, event)
        }
        const allDone = Boolean(
          rootSession &&
          rootRunning.size === 0 &&
          rootOverlapped &&
          reasonKind === 'completed' &&
          !rootFailed,
        )
        if (rootRunning.size === 0) {
          rootFailed = false
          rootOverlapped = false
        }
        if (reasonKind !== 'completed') {
          if (rootSession && rootId) goalSummary.onTurnAbort(rootId)
          return
        }
        if (!rootSession) return
        counters.completions += 1
        const value = readConfig()
        const sessionId = asString(session.id)
        const turn = typeof event.data.turn === 'number' ? event.data.turn : undefined
        const turnKey =
          turn !== undefined
            ? String(turn)
            : Number.isSafeInteger(event.seq)
              ? 'seq:' + String(event.seq)
              : undefined
        const text = completionText(session, event)
        const sessionTitle = titleOf(session, event)
        // Observe goal state even when completion delivery is disabled. The
        // tracker uses this to keep its terminal cleanup and re-enable baseline
        // consistent; it returns false when delivery is disabled.
        if (goalSummary.onTurnEnd(sessionId, { text, sessionTitle, turnKey })) return
        if (!value.enabled || !value.completionEnabled) return
        merger.queue({ sessionId, sessionTitle, text, turn, allDone })
        return
      }
    } catch {
      /* turn endings must never fail because of the notifier */
    }
  }

  function status() {
    return {
      settingsAvailable: settingsAvailable(),
      nativeFocus: nativeFocusAvailable(),
      platform: process.platform,
      clients: queue.waiterCount(),
      transport: diagnostics.transport,
      configSource: diagnostics.configSource,
      stats: {
        questions: counters.questions,
        approvals: counters.approvals,
        completions: counters.completions,
        merged: merger.stats().merged,
        lastEventAt: counters.lastEventAt,
      },
      lastEvent: lastEvent === null ? null : { kind: lastEvent.kind, at: lastEvent.at },
    }
  }

  function failure(code, message) {
    return { ok: false, error: { code, message, details: {} } }
  }

  function configPayload() {
    return { ok: true, version: VERSION, ns: SETTINGS_NS, config: readConfig(), status: status() }
  }

  function healthPayload() {
    const current = status()
    return {
      ok: true,
      version: VERSION,
      ns: SETTINGS_NS,
      settingsAvailable: current.settingsAvailable,
      platform: current.platform,
      nativeFocus: current.nativeFocus,
      clients: current.clients,
      status: current,
    }
  }

  function testPayload() {
    const event = publishEvent({ kind: 'test', text: TEST_TEXT })
    return { ok: true, queued: Boolean(event) }
  }

  function focusPayload() {
    let native = false
    try {
      native = focusDesktopWindow()
    } catch {
      native = false
    }
    return { ok: true, native: Boolean(native) }
  }

  function nativeNotifyPayload(payload) {
    if (!payload || typeof payload !== 'object') return null
    const kind = typeof payload.kind === 'string' ? payload.kind : ''
    if (kind !== 'question' && kind !== 'approval' && kind !== 'complete' && kind !== 'test') return null
    const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 256) : ''
    if (!title) return null
    const body = typeof payload.body === 'string' ? payload.body.slice(0, 2048) : ''
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.slice(0, 256) : ''
    const durationMs = Number(payload.durationMs)
    const progressLabel = typeof payload.progressLabel === 'string' ? payload.progressLabel.slice(0, 32) : ''
    return { kind, title, body, sessionId, durationMs, progressLabel }
  }

  async function savePayload(payload) {
    const patch = payload && typeof payload === 'object' ? payload.patch : undefined
    const validation = validatePatch(patch)
    if (!validation.ok) return { ok: false, error: validation.error }
    if (Object.keys(validation.patch).length === 0) {
      return { ok: true, config: readConfig(), status: status() }
    }
    const settings = getService(ctx, 'settings')
    if (!Config || !settings || typeof settings.update !== 'function') {
      return {
        ok: false,
        error: { code: 'settings-unavailable', message: 'settings persistence is unavailable; configuration is read-only' },
      }
    }
    try {
      await settings.update(SETTINGS_NS, validation.patch)
    } catch (error) {
      return { ok: false, error: { code: 'settings-write-failed', message: errorMessage(error) } }
    }
    invalidateConfig()
    return { ok: true, config: readConfig(), status: status() }
  }

  function pollPayload(payload, signal) {
    const after = payload && typeof payload === 'object' ? payload.after : 0
    const wait = payload && typeof payload === 'object' ? payload.wait : POLL_WAIT_DEFAULT
    return queue.poll(after, clampWait(wait), signal)
  }

  async function handleRpc(endpoint, payload, signal) {
    try {
      switch (endpoint) {
        case 'config':
          return { ok: true, value: configPayload() }
        case 'save':
          return { ok: true, value: await savePayload(payload) }
        case 'poll':
          return { ok: true, value: await pollPayload(payload, signal) }
        case 'health':
          return { ok: true, value: healthPayload() }
        case 'test':
          return { ok: true, value: testPayload() }
        case 'focus':
          return { ok: true, value: focusPayload() }
        case 'native-notify': {
          const input = nativeNotifyPayload(payload)
          if (!input) return failure('invalid-request', 'invalid native notification payload')
          return { ok: true, value: await nativeToast.show(input) }
        }
        case 'taskbar-badge': {
          const count = payload && typeof payload === 'object' ? Number(payload.count) : NaN
          if (!Number.isInteger(count) || count < 0 || count > 99) {
            return failure('invalid-request', 'taskbar badge count must be an integer from 0 to 99')
          }
          if (readConfig().taskbarBadgeEnabled !== true && count > 0) {
            taskbarBadge.setCount(0)
            return { ok: true, value: { ok: true, count: 0, disabled: true } }
          }
          taskbarBadge.setCount(count)
          return { ok: true, value: { ok: true, count } }
        }
        default:
          return failure('unknown-endpoint', `unknown RPC endpoint "${String(endpoint)}"`)
      }
    } catch (error) {
      return failure('internal-error', errorMessage(error))
    }
  }

  function onGoalActivation(payload) {
    try {
      goalSummary.onActivation(payload)
    } catch {
      /* goal activation must never break the notifier */
    }
  }

  function warmNativeToast() {
    try {
      const value = readConfig()
      if (value.taskbarBadgeEnabled === true) taskbarBadge.warm()
      if (value.notificationMode !== 'native-progress') return
      void nativeToast.warm()
    } catch {
      /* prewarm is best-effort */
    }
  }

  function dispose() {
    try {
      goalSummary.dispose()
    } catch {
      /* ignore */
    }
    try {
      merger.dispose()
    } catch {
      /* ignore */
    }
    try {
      nativeToast.dispose()
    } catch {
      /* ignore */
    }
    try {
      taskbarBadge.dispose()
    } catch {
      /* ignore */
    }
    try {
      queue.dispose()
    } catch {
      /* ignore */
    }
    try {
      allDoneTitle.dispose()
    } catch {
      /* ignore */
    }
    titleCache.clear()
    dedupe.clear()
  }

  return {
    handleRpc,
    onApprovalRequest,
    onUserQuestion,
    onSessionEvent,
    onGoalActivation,
    warmNativeToast,
    invalidateConfig,
    readConfig,
    setTransport(transport) {
      diagnostics.transport = transport
    },
    dispose,
    // exposed for tests/diagnostics
    status,
  }
}

/**
 * Register the three Host event listeners (approval + question + turn end).
 * Waterfall listeners always delegate with `next()` even when publishing fails.
 */
function registerEventListeners(ctx, state) {
  const listen = (eventName, listener) => {
    try {
      ctx.on(eventName, listener)
    } catch (error) {
      logWarn(ctx, `failed to listen for ${eventName}`, error)
    }
  }
  listen('approval/request', (request, next) => {
    try {
      state.onApprovalRequest(request)
    } catch {
      /* never break the approval waterfall */
    }
    return typeof next === 'function' ? next() : undefined
  })
  listen('user-questions/request', (request, next) => {
    try {
      state.onUserQuestion(request)
    } catch {
      /* never break the question waterfall */
    }
    return typeof next === 'function' ? next() : undefined
  })
  listen('session/event', (session, event) => {
    try {
      state.onSessionEvent(session, event)
    } catch {
      /* never break the session event feed */
    }
  })
}

/** Hide the automatic settings form; the client ships its own section. */
function installSettingsPolicy(ctx) {
  try {
    ctx.inject(['settings'], (child) => {
      try {
        child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
      } catch (error) {
        logWarn(ctx, 'failed to hide the automatic settings form', error)
      }
    })
  } catch (error) {
    logWarn(ctx, 'settings service injection failed', error)
  }
}

/** Build a transport-level failure result (ConnectionRpcHandlerResult shape). */
function rpcFailure(code, message, details) {
  return { ok: false, error: { code, message, details: details && typeof details === 'object' ? details : {} } }
}

/**
 * Read one JSON request body with a byte cap.
 *
 * @param {import('node:http').IncomingMessage} req request.
 * @param {number} limit byte cap.
 * @returns {Promise<{ok: true, value: unknown} | {ok: false, status: number, message: string}>} body result.
 */
function readJsonBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0
    let settled = false
    const chunks = []
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      req.on('data', (chunk) => {
        if (settled) return
        size += chunk.length
        if (size > limit) {
          finish({ ok: false, status: 413, message: 'request body too large' })
          try {
            req.destroy()
          } catch {
            /* ignore */
          }
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (settled) return
        if (size === 0) {
          finish({ ok: false, status: 400, message: 'empty request body' })
          return
        }
        try {
          finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch {
          finish({ ok: false, status: 400, message: 'body is not JSON' })
        }
      })
      req.on('error', () => {
        finish({ ok: false, status: 400, message: 'request stream failed' })
      })
    } catch {
      finish({ ok: false, status: 400, message: 'request stream failed' })
    }
  })
}

/**
 * Write one Connection-RPC server-response envelope.
 *
 * @param {import('node:http').ServerResponse} res response.
 * @param {string} rpcId correlation id from the client request.
 * @param {object} result `{ok:true,value}` or `{ok:false,error}`.
 */
function sendRpcResponse(res, rpcId, result) {
  const body = JSON.stringify({ type: 'server-response', rpcId, result })
  res.statusCode = 200
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** Extract the endpoint from a `<channel>/<endpoint>` pathname. */
function endpointFromPathname(pathname) {
  const prefix = `${RPC_PATH}/`
  if (typeof pathname !== 'string' || !pathname.startsWith(prefix)) return undefined
  const endpoint = pathname.slice(prefix.length)
  if (!RPC_ENDPOINT_PATTERN.test(endpoint)) return undefined
  return endpoint
}

/**
 * The webServer-route transport used when the official
 * `connection.rpc.handle` is unavailable (DSH 0.2.1-rc.2 throws
 * `cannot get property "webServer" without inject` inside its own service).
 * The route reuses the official Connection fence (`requestRejection`: Host /
 * Origin checks plus authenticated browser cookie) and the official unary RPC
 * envelope, so the browser half calls it through `connection.rpc.call`
 * unchanged.
 *
 * @param {import('node:http').IncomingMessage} req request.
 * @param {import('node:http').ServerResponse} res response.
 * @param {object} state host state (`handleRpc`).
 * @param {object} connection Connection service (fence provider).
 */
async function handleRpcRoute(req, res, state, connection) {
  try {
    let rejection
    try {
      // Fail closed: without requestRejection we cannot prove the Host/Origin/cookie fence.
      rejection = typeof connection.requestRejection === 'function' ? connection.requestRejection(req) : 403
    } catch {
      rejection = 403
    }
    if (rejection !== undefined && rejection !== null) {
      res.statusCode = rejection
      res.setHeader('cache-control', 'no-store')
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    } catch {
      res.statusCode = 400
      res.end('invalid request target')
      return
    }
    const endpoint = endpointFromPathname(pathname)
    if (endpoint === undefined) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.end()
      return
    }
    const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      res.statusCode = 415
      res.end('content type must be application/json')
      return
    }
    const body = await readJsonBody(req, RPC_BODY_LIMIT)
    if (!body.ok) {
      res.statusCode = body.status
      res.end(body.message)
      return
    }
    const message = body.value
    if (!message || typeof message !== 'object' || message.type !== 'client-request'
      || typeof message.rpcId !== 'string' || typeof message.method !== 'string') {
      res.statusCode = 400
      res.end('invalid client-request message')
      return
    }
    if (message.method !== endpoint) {
      sendRpcResponse(res, message.rpcId, rpcFailure('gateway/bad-request', `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`))
      return
    }
    const controller = new AbortController()
    try {
      req.once('aborted', () => controller.abort())
      res.once('close', () => {
        if (!res.writableEnded) controller.abort()
      })
    } catch {
      /* ignore */
    }
    let result
    try {
      result = await state.handleRpc(endpoint, message.payload === undefined ? null : message.payload, controller.signal)
    } catch (error) {
      result = rpcFailure('internal-error', errorMessage(error))
    }
    if (!res.writableEnded) sendRpcResponse(res, message.rpcId, result)
  } catch (error) {
    try {
      if (!res.writableEnded) {
        res.statusCode = 500
        res.end('handler failure')
      }
    } catch {
      /* response is gone */
    }
  }
}

/**
 * Register the browser transport. Preferred path: official
 * `connection.rpc.handle` (it owns the route fence and envelope). Fallback
 * (needed on 0.2.1-rc.2): register the exact same prefix path through
 * `webServer` and reuse `connection.requestRejection` + the official unary
 * envelope. Both registrations belong to the injected child fiber, so plugin
 * unload removes the route.
 *
 * @param {any} ctx plugin context.
 * @param {object} state host state.
 */
function installRpcChannel(ctx, state) {
  try {
    ctx.inject(['connection'], (connCtx) => {
      let connection
      try {
        connection = connCtx.connection
      } catch (error) {
        state.setTransport('failed')
        logWarn(ctx, 'connection service is unavailable; the browser half cannot poll', error)
        return
      }
      try {
        const rpc = connection && connection.rpc
        if (rpc && typeof rpc.handle === 'function') {
          const registration = rpc.handle(RPC_CHANNEL, (endpoint, payload, signal) => state.handleRpc(endpoint, payload, signal))
          try {
            if (typeof registration === 'function') {
              connCtx.effect(() => () => {
                try {
                  Promise.resolve(registration()).catch(() => {})
                } catch {
                  /* ignore */
                }
              }, 'dsh-notify-toast: official RPC channel')
            }
          } catch {
            /* cleanup is optional; the route dies with the connection service */
          }
          state.setTransport('channel')
          return
        }
      } catch (error) {
        // DSH 0.2.1-rc.2: the service's own fiber lacks webServer, so
        // rpc.handle throws before registering anything. Fall through.
        logWarn(ctx, 'official connection.rpc.handle is unavailable; using the same-path route fallback', error)
      }
      try {
        connCtx.inject(['webServer'], (webCtx) => {
          try {
            const dispose = webCtx.webServer.register({
              kind: 'prefix',
              path: RPC_PATH,
              handler: (req, res) => handleRpcRoute(req, res, state, connection),
            })
            try {
              webCtx.effect(() => dispose, 'dsh-notify-toast: RPC route')
            } catch {
              /* the disposer also runs when the webServer itself unloads */
            }
            state.setTransport('route')
          } catch (error) {
            state.setTransport('failed')
            logWarn(ctx, 'failed to register the browser RPC route', error)
          }
        })
      } catch (error) {
        state.setTransport('failed')
        logWarn(ctx, 'webServer service injection failed', error)
      }
    })
  } catch (error) {
    state.setTransport('failed')
    logWarn(ctx, 'connection service injection failed', error)
  }
}

/**
 * Cordis plugin entry point.
 *
 * No global side effects: every listener is registered on this context (auto
 * cleanup on unload), every timer is owned by the queue/merger that the single
 * cleanup effect disposes, and the browser route belongs to the injected child.
 *
 * @param {any} ctx plugin context.
 * @param {unknown} config Loader-validated Config.
 */
export function apply(ctx, config) {
  let state
  try {
    state = createHostState(ctx, config)
  } catch (error) {
    logWarn(ctx, 'failed to initialize the notifier host state', error)
    return
  }
  try {
    ctx.effect(() => () => state.dispose(), 'dsh-notify-toast: event queue, merge timer and waiters')
  } catch (error) {
    logWarn(ctx, 'failed to register the cleanup effect', error)
  }
  try {
    ctx.on('settings/document-updated', (ns) => {
      try {
        if (ns === SETTINGS_NS) state.invalidateConfig()
      } catch {
        /* ignore */
      }
    })
  } catch (error) {
    logWarn(ctx, 'failed to listen for settings updates', error)
  }
  registerEventListeners(ctx, state)
  try {
    ctx.on('goal/activation-changed', (payload) => state.onGoalActivation(payload))
  } catch (error) {
    logWarn(ctx, 'failed to listen for goal activation changes', error)
  }
  state.warmNativeToast()
  installSettingsPolicy(ctx)
  installRpcChannel(ctx, state)
  try {
    if (ctx.logger && typeof ctx.logger.debug === 'function') {
      ctx.logger.debug(`[${PKG_ID}] host ready (v${VERSION}); transport=${state.status().transport}; settingsAvailable=${state.status().settingsAvailable}`)
    }
  } catch {
    /* ignore */
  }
}

/**
 * Test-only seam for the transport helpers. Not part of the plugin API; the
 * runtime never reads it.
 */
export const __test = Object.freeze({
  endpointFromPathname,
  readJsonBody,
  sendRpcResponse,
  handleRpcRoute,
  profileDirCandidates,
  resolveConfigSchema,
  resolvedConfigSource: resolvedSchema.source,
})
