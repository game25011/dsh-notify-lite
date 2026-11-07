#!/usr/bin/env node
/**
 * dsh-notify-toast — client bundle smoke test.
 *
 * Loads lib/client.js inside a Node `vm` sandbox that only provides browser
 * globals (window/__ModuleLoader__, document, Notification, localStorage,
 * AudioContext, fetch) and asserts that:
 *   - the bundle registers one module definition with a working factory;
 *   - the factory returns { inject, apply } plus the non-enumerable __test hook;
 *   - the pure helpers (truncation, body rules, config sanitizing, focus,
 *     leader lease) behave per docs/INTERFACE.md §3;
 *   - apply() with fake client services does not throw, registers zh/en locale
 *     dictionaries, the settings.section entry, focus/gesture/leader effects,
 *     and starts config + long-poll RPC calls with the contract payloads;
 *   - test events show a native toast, focused events are skipped, disabled
 *     kinds are skipped, the notification body follows the configured rules,
 *     clicking a toast calls focus + window.focus + openSession, and the sound
 *     path synthesizes oscillators;
 *   - disposal aborts the poll, closes the AudioContext, releases the leader
 *     lease, removes listeners and leaves no unhandled rejections.
 *
 * Run: node scripts/client-smoke.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_PATH = path.join(ROOT, 'lib', 'client.js')
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8')

const PKG_ID = 'dsh-notify-toast'
const NS = 'dsh-notify-toast'
const RPC_CHANNEL = '/dsh-notify-toast'
const LEADER_KEY = 'dsh-notify-toast:leader'

const unhandledRejections = []
process.on('unhandledRejection', (reason) => {
  unhandledRejections.push(reason)
})

// A hung event loop would mean a leaked timer/listener: fail loudly.
const watchdog = setTimeout(() => {
  console.error('not ok - smoke test watchdog fired (leaked timer or unresolved promise)')
  process.exitCode = 1
  process.exit()
}, 15000)
watchdog.unref()

const results = { passed: 0, failed: 0 }
/** Contexts created by the test; anything left over is disposed in main()'s finally. */
const trackedContexts = []

function sameJson(actual, expected, message) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message)
}

async function run(name, fn) {
  try {
    await fn()
    results.passed += 1
    console.log('ok - ' + name)
  } catch (error) {
    results.failed += 1
    console.error('not ok - ' + name)
    console.error(error && error.stack ? error.stack : error)
  }
}

/** Let queued microtasks and one macrotask turn complete. */
async function settle(rounds = 25) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

// ---------------------------------------------------------------------------
// Browser environment stubs
// ---------------------------------------------------------------------------

function createEnvironment(options = {}) {
  const state = {
    definitions: [],
    notifications: [],
    permission: options.permission || 'default',
    permissionRequests: 0,
    audioContexts: [],
    audioResumes: 0,
    audioCloses: 0,
    oscillatorStarts: 0,
    windowListeners: new Map(),
    documentListeners: new Map(),
    focused: options.focused !== undefined ? options.focused : true,
    visibility: 'visible',
    windowFocusCalls: 0,
    storage: new Map(),
    fetchCalls: [],
    warnings: [],
    registrationErrors: [],
    uiWorkspaceOpens: [],
  }

  function addListener(registry, type, handler) {
    if (typeof handler !== 'function') return
    if (!registry.has(type)) registry.set(type, [])
    registry.get(type).push(handler)
  }

  function removeListener(registry, type, handler) {
    const list = registry.get(type)
    if (!list) return
    const index = list.indexOf(handler)
    if (index >= 0) list.splice(index, 1)
  }

  function dispatch(registry, type, event) {
    const list = (registry.get(type) || []).slice()
    for (const handler of list) handler(event || {})
  }

  const NotificationCtor = function Notification(title, notificationOptions) {
    this.title = String(title)
    this.options = notificationOptions && typeof notificationOptions === 'object' ? Object.assign({}, notificationOptions) : {}
    this.closed = false
    this.closeCalls = 0
    this.onclick = null
    this.onclose = null
    this.onerror = null
    state.notifications.push(this)
  }
  Object.defineProperty(NotificationCtor, 'permission', {
    configurable: true,
    get() {
      return state.permission
    },
    set(value) {
      state.permission = value
    },
  })
  NotificationCtor.requestPermission = () => {
    state.permissionRequests += 1
    state.permission = 'granted'
    return Promise.resolve('granted')
  }
  NotificationCtor.prototype.close = function close() {
    if (this.closed) return
    this.closed = true
    this.closeCalls += 1
    if (typeof this.onclose === 'function') this.onclose()
  }

  class FakeGainNode {
    constructor(context) {
      this.context = context
      this.connectedTo = []
      const gainParam = {
        value: 0,
        setValueAtTime: (value) => {
          gainParam.value = value
        },
        linearRampToValueAtTime: (value) => {
          gainParam.value = value
        },
        exponentialRampToValueAtTime: (value) => {
          gainParam.value = value
        },
      }
      this.gain = gainParam
    }
    connect(node) {
      this.connectedTo.push(node)
      return node
    }
  }

  class FakeOscillator {
    constructor(context) {
      this.context = context
      this.type = ''
      this.started = false
      this.stopped = false
      const frequencyParam = {
        value: 0,
        setValueAtTime: (value) => {
          frequencyParam.value = value
        },
      }
      this.frequency = frequencyParam
    }
    connect(node) {
      this.connectedTo = node
      return node
    }
    start() {
      this.started = true
      state.oscillatorStarts += 1
    }
    stop() {
      this.stopped = true
    }
  }

  class FakeAudioContext {
    constructor() {
      this.state = 'running'
      this.currentTime = 0
      this.destination = { name: 'destination' }
      state.audioContexts.push(this)
    }
    createGain() {
      return new FakeGainNode(this)
    }
    createOscillator() {
      return new FakeOscillator(this)
    }
    resume() {
      this.state = 'running'
      state.audioResumes += 1
      return Promise.resolve()
    }
    close() {
      this.state = 'closed'
      state.audioCloses += 1
      return Promise.resolve()
    }
  }

  const storage = {
    getItem(key) {
      return state.storage.has(key) ? state.storage.get(key) : null
    },
    setItem(key, value) {
      state.storage.set(key, String(value))
    },
    removeItem(key) {
      state.storage.delete(key)
    },
  }

  const windowStub = {
    __ModuleLoader__: {
      load(definition) {
        state.definitions.push(definition)
      },
    },
    localStorage: storage,
    Notification: NotificationCtor,
    AudioContext: FakeAudioContext,
    addEventListener(type, handler) {
      addListener(state.windowListeners, type, handler)
    },
    removeEventListener(type, handler) {
      removeListener(state.windowListeners, type, handler)
    },
    focus() {
      state.windowFocusCalls += 1
    },
    listenerCount(type) {
      return (state.windowListeners.get(type) || []).length
    },
  }

  const documentStub = {
    hasFocus() {
      return state.focused
    },
    get visibilityState() {
      return state.visibility
    },
    addEventListener(type, handler) {
      addListener(state.documentListeners, type, handler)
    },
    removeEventListener(type, handler) {
      removeListener(state.documentListeners, type, handler)
    },
  }

  const sandbox = {
    window: windowStub,
    document: documentStub,
    Notification: NotificationCtor,
    localStorage: storage,
    AudioContext: FakeAudioContext,
    fetch: (...args) => {
      state.fetchCalls.push(args)
      return Promise.reject(new Error('network disabled in the smoke test'))
    },
    console: {
      log() {},
      info() {},
      debug() {},
      warn: (...args) => state.warnings.push(args),
      error: (...args) => state.warnings.push(args),
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
  }

  const context = vm.createContext(sandbox)
  vm.runInContext(SOURCE, context, { filename: CLIENT_PATH })

  return {
    state,
    window: windowStub,
    document: documentStub,
    sandbox,
    context,
    dispatchWindow: (type, event) => dispatch(state.windowListeners, type, event),
    windowListenerCount: (type) => (state.windowListeners.get(type) || []).length,
    documentListenerCount: (type) => (state.documentListeners.get(type) || []).length,
  }
}

// ---------------------------------------------------------------------------
// Minimal React stub (createElement + hooks for a manual settings render)
// ---------------------------------------------------------------------------

function createReactStub() {
  const hooks = { index: 0, values: [] }
  const React = {
    createElement(type, props, ...children) {
      const nextProps = props && typeof props === 'object' ? Object.assign({}, props) : {}
      if (children.length === 1) nextProps.children = children[0]
      else if (children.length > 1) nextProps.children = children
      return { type, props: nextProps }
    },
    useState(initial) {
      const index = hooks.index
      hooks.index += 1
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial
      return [
        hooks.values[index],
        (next) => {
          hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next
        },
      ]
    },
    useEffect() {
      hooks.index += 1
    },
    useRef(initial) {
      const index = hooks.index
      hooks.index += 1
      if (!(index in hooks.values)) hooks.values[index] = { current: initial }
      return hooks.values[index]
    },
    useMemo(factory) {
      const index = hooks.index
      hooks.index += 1
      if (!(index in hooks.values)) hooks.values[index] = factory()
      return hooks.values[index]
    },
    useCallback(callback) {
      hooks.index += 1
      return callback
    },
    Fragment: 'Fragment',
  }
  hooks.reset = () => {
    hooks.index = 0
    hooks.values = []
  }
  return { React, hooks }
}

// ---------------------------------------------------------------------------
// Fake client context (slots / locale / connection / effects / timers / get)
// ---------------------------------------------------------------------------

function createFakeContext(env, options = {}) {
  const api = {
    effects: [],
    rpcCalls: [],
    polls: [],
    registrations: [],
    injections: [],
    localeDictionaries: {},
    localeListeners: new Set(),
    localeSnapshot: { active: 'zh', revision: 0, locales: [] },
    timers: [],
    hostConfig: Object.assign(
      {
        enabled: true,
        questionEnabled: true,
        approvalEnabled: true,
        completionEnabled: true,
        taskbarBadgeEnabled: true,
        titleOnly: false,
        bodyLength: 40,
        sound: 'chime',
        volume: 60,
        mergeIntervalMs: 2500,
        notificationMode: 'native',
        nativeDurationMs: 8000,
        nativeToast: true,
      },
      options.config || {},
    ),
    hostStatus: Object.assign(
      {
        settingsAvailable: true,
        nativeFocus: true,
        platform: 'win32',
        clients: 2,
        stats: { questions: 3, approvals: 1, completions: 5, merged: 2, lastEventAt: 1700000000000 },
        lastEvent: { kind: 'complete', at: 1700000000000 },
      },
      options.status || {},
    ),
    disposedEffects: 0,
    disposeErrors: [],
    uiWorkspaceOpens: [],
  }

  function statusValue() {
    return Object.assign({}, api.hostStatus)
  }

  function handleRpc(request) {
    const { channel, endpoint, payload } = request
    api.rpcCalls.push({ channel, endpoint, payload })
    if (options.offline === true && (endpoint === 'config' || endpoint === 'poll' || endpoint === 'save' || endpoint === 'test')) {
      return Promise.reject(new Error('host offline'))
    }
    if (endpoint === 'config') {
      return Promise.resolve({
        ok: true,
        value: { ok: true, version: '0.4.2', ns: NS, config: Object.assign({}, api.hostConfig), status: statusValue() },
      })
    }
    if (endpoint === 'save') {
      if (options.rejectSave === true) {
        // Business failures ride inside a transport success: {ok:true, value:{ok:false,error}}.
        return Promise.resolve({
          ok: true,
          value: { ok: false, error: { code: 'settings-unavailable', message: 'settings service unavailable' } },
        })
      }
      api.hostConfig = Object.assign({}, api.hostConfig, payload && payload.patch ? payload.patch : {})
      return Promise.resolve({ ok: true, value: { ok: true, config: Object.assign({}, api.hostConfig), status: statusValue() } })
    }
    if (endpoint === 'test') {
      return Promise.resolve({ ok: true, value: { ok: true, queued: true } })
    }
    if (endpoint === 'focus') {
      return Promise.resolve({ ok: true, value: { ok: true, native: true } })
    }
    if (endpoint === 'taskbar-badge') {
      return Promise.resolve({ ok: true, value: { ok: true, count: payload && payload.count } })
    }
    if (endpoint === 'native-notify') {
      if (options.nativeNotifyFailure === true) {
        return Promise.resolve({ ok: true, value: { ok: false, reason: 'helper-failed' } })
      }
      return Promise.resolve({ ok: true, value: { ok: true, id: 'native-test', durationMs: payload && payload.durationMs } })
    }
    if (endpoint === 'poll') {
      return new Promise((resolve, reject) => {
        const record = { resolve, reject, signal: request.signal, payload }
        api.polls.push(record)
        if (request.signal && typeof request.signal.addEventListener === 'function') {
          request.signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('poll aborted'), { name: 'AbortError' })),
            { once: true },
          )
        }
      })
    }
    return Promise.resolve({ ok: false, error: { code: 'unknown-endpoint', message: 'unknown endpoint ' + String(endpoint) } })
  }

  const slots = {
    inject(name, callback) {
      api.injections.push({ name, callback })
      try {
        const disposer = callback()
        if (typeof disposer === 'function') api.effects.push({ disposer, label: 'slot:' + name })
      } catch (error) {
        env.state.registrationErrors.push(error)
      }
      return () => {}
    },
    register(registrationOptions, component) {
      api.registrations.push({ options: registrationOptions, component })
      return () => {
        const index = api.registrations.findIndex((entry) => entry.options === registrationOptions)
        if (index >= 0) api.registrations.splice(index, 1)
      }
    },
    subscribe() {
      return () => {}
    },
    entries() {
      return api.registrations
    },
    getVersion() {
      return 0
    },
  }

  const locale = {
    register(namespace, dictionaries) {
      api.localeDictionaries[namespace] = dictionaries
      api.localeSnapshot = { active: 'zh', revision: api.localeSnapshot.revision + 1, locales: [] }
      for (const listener of Array.from(api.localeListeners)) listener()
      return () => {
        delete api.localeDictionaries[namespace]
      }
    },
    bind(namespace) {
      return (key, params) => {
        const dictionaries = api.localeDictionaries[namespace]
        const dictionary = dictionaries && dictionaries.zh ? dictionaries.zh : null
        let text = dictionary && typeof dictionary[key] === 'string' ? dictionary[key] : key
        if (params && typeof text === 'string') {
          text = text.replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match))
        }
        return text
      }
    },
    getLocale() {
      return api.localeSnapshot
    },
    getSnapshot() {
      return api.localeSnapshot
    },
    subscribe(listener) {
      api.localeListeners.add(listener)
      return () => api.localeListeners.delete(listener)
    },
  }

  const connection = {
    rpc: {
      call(channel, endpoint, payload, signal) {
        return handleRpc({ channel, endpoint, payload, signal })
      },
    },
  }

  const ctx = {
    effect(callback, label) {
      const disposer = callback()
      if (typeof disposer === 'function') api.effects.push({ disposer, label })
      return () => {}
    },
    on() {
      return () => {}
    },
    get(name) {
      if (name === 'uiWorkspace' && options.uiWorkspace) return options.uiWorkspace
      return undefined
    },
    timeout(callback, delay) {
      const handle = setTimeout(callback, delay)
      const cancel = () => clearTimeout(handle)
      api.timers.push(cancel)
      return cancel
    },
    interval(callback, delay) {
      const handle = setInterval(callback, delay)
      const cancel = () => clearInterval(handle)
      api.timers.push(cancel)
      return cancel
    },
    slots,
    locale,
    connection,
  }

  if (options.uiWorkspace) {
    api.uiWorkspace = options.uiWorkspace
  }

  trackedContexts.push(api)
  return { ctx, api }
}

/** Resolve the newest pending poll with the given events. */
async function deliverEvents(api, events) {
  assert.ok(api.polls.length > 0, 'expected a pending long-poll request')
  const poll = api.polls[api.polls.length - 1]
  const next = events.length > 0 ? events[events.length - 1].id : 0
  poll.resolve({ ok: true, value: { ok: true, events, next, serverTime: Date.now() } })
  await settle()
}

/** Dispose every effect captured by the fake ctx (reverse registration order). */
async function disposeFakeContext(api) {
  if (api.disposed === true) return
  api.disposed = true
  for (let index = api.effects.length - 1; index >= 0; index -= 1) {
    try {
      api.effects[index].disposer()
      api.disposedEffects += 1
    } catch (error) {
      api.disposeErrors.push(error)
    }
  }
  await settle()
}

// ---------------------------------------------------------------------------
// React tree helpers
// ---------------------------------------------------------------------------

function walk(element, visit) {
  if (element === null || element === undefined) return
  if (Array.isArray(element)) {
    for (const child of element) walk(child, visit)
    return
  }
  if (typeof element === 'string' || typeof element === 'number') return
  if (typeof element !== 'object') return
  visit(element)
  // The stub never renders function components itself: invoke presentational
  // components (no hooks) so their plain-HTML subtree is visible to the walk.
  if (typeof element.type === 'function') {
    let rendered = null
    try {
      rendered = element.type(element.props)
    } catch (error) {
      return
    }
    walk(rendered, visit)
    return
  }
  if (element.props && element.props.children !== undefined) walk(element.props.children, visit)
}

function collectText(element) {
  const parts = []
  walk(element, (node) => {
    if (!node.props) return
    const children = node.props.children
    const list = Array.isArray(children) ? children : [children]
    for (const child of list) {
      if (typeof child === 'string' || typeof child === 'number') parts.push(String(child))
    }
  })
  return parts
}

function findElement(element, predicate) {
  let found = null
  walk(element, (node) => {
    if (!found && predicate(node)) found = node
  })
  return found
}

function textOf(element) {
  return collectText(element).join('|')
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function main() {
  try {
  const reactStub = createReactStub()
  const fakeRequire = (specifier) => {
    if (specifier === 'react') return reactStub.React
    throw new Error('unexpected require: ' + specifier)
  }

  // ---- 1. Bundle load ----
  const env = createEnvironment()

  await run('bundle registers one module definition under the package id', () => {
    assert.equal(env.state.definitions.length, 1)
    const definition = env.state.definitions[0]
    assert.equal(definition.id, PKG_ID)
    assert.equal(typeof definition.factory, 'function')
  })

  const definition = env.state.definitions[0]
  const plugin = definition.factory(fakeRequire)

  await run('factory returns inject/apply and a non-enumerable __test hook', () => {
    assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale', 'connection'])
    assert.equal(typeof plugin.apply, 'function')
    assert.equal(typeof plugin.__test, 'object')
    assert.equal(Object.prototype.propertyIsEnumerable.call(plugin, '__test'), false)
    assert.equal(plugin.__test.RPC_CHANNEL, RPC_CHANNEL)
  })

  // ---- 2. Locale dictionary coverage ----
  await run('zh/en dictionaries exist with identical keys and required copy', () => {
    const { zh, en } = plugin.__test
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
    const required = [
      'nav',
      'pageTitle',
      'pageIntro',
      'enable',
      'questionEnabled',
      'approvalEnabled',
      'completionEnabled',
      'bodyLength',
      'titleOnly',
      'sound',
      'soundChime',
      'soundBell',
      'soundSoft',
      'soundBubble',
      'soundNone',
      'volume',
      'mergeInterval',
      'testButton',
      'statusPermission',
      'statusFocus',
      'statusHost',
      'statusNativeFocus',
      'statusSettings',
      'valueGranted',
      'valueDefault',
      'valueDenied',
      'valueConnected',
      'valueDisconnected',
      'saved',
      'saving',
      'saveFailed',
      'testSent',
      'testFailed',
      'notifyQuestionTitle',
      'notifyApprovalTitle',
      'notifyCompleteTitle',
      'notifyCompleteMergedTitle',
      'notifyCompleteManyTitle',
      'notifyAllDoneTitle',
      'notifyGoalPausedTitle',
      'notifyGoalBlockedTitle',
      'goalSummaryEnabled',
      'notificationMode',
      'notificationModeNativeProgress',
      'nativeDuration',
      'notifyTestTitle',
      'notifyTestBody',
      'fallbackBody',
      'fallbackApprovalBody',
      'permissionDeniedHint',
    ]
    for (const key of required) {
      assert.equal(typeof zh[key], 'string', 'zh missing ' + key)
      assert.equal(typeof en[key], 'string', 'en missing ' + key)
      assert.ok(zh[key].length > 0, 'zh empty ' + key)
      assert.ok(en[key].length > 0, 'en empty ' + key)
    }
    assert.equal(zh.nav, '通知')
    assert.equal(en.nav, 'Notifications')
    assert.equal(zh.notifyQuestionTitle, 'DeepSeek 想问你一个问题')
    assert.equal(zh.fallbackBody, '点击查看')
  })

  // ---- 3. Pure helpers ----
  await run('truncation collapses whitespace and counts Unicode code points', () => {
    const { collapseWhitespace, truncateText, sanitizeConfig, sanitizePatch } = plugin.__test
    assert.equal(collapseWhitespace('  a\n\n b\t\n'), 'a b')
    assert.equal(truncateText('short text', 40), 'short text')
    const han = '字'.repeat(80)
    const cutHan = truncateText(han, 40)
    assert.equal(Array.from(cutHan).length, 41)
    assert.ok(cutHan.endsWith('…'))
    const emoji = '😀'.repeat(30)
    const cutEmoji = truncateText(emoji, 20)
    assert.equal(Array.from(cutEmoji).length, 21)
    assert.ok(cutEmoji.endsWith('…'))
    const clamped = sanitizeConfig(
      { enabled: 'yes', bodyLength: 999, volume: -5, sound: 'thunder', mergeIntervalMs: 999999 },
      plugin.__test.DEFAULT_CONFIG,
    )
    assert.equal(clamped.enabled, true)
    assert.equal(clamped.bodyLength, 60)
    assert.equal(clamped.volume, 0)
    assert.equal(clamped.sound, 'ding')
    assert.equal(clamped.mergeIntervalMs, 10000)
    assert.deepEqual(Object.keys(sanitizePatch({ enabled: 'yes' })), [])
    assert.equal(sanitizePatch({ bodyLength: 10 }).bodyLength, 20)
    assert.equal(sanitizeConfig({ notificationMode: 'native-and-inapp' }, plugin.__test.DEFAULT_CONFIG).notificationMode, 'native-progress')
    assert.equal(sanitizePatch({ nativeDurationMs: 1 }).nativeDurationMs, 3000)
    assert.deepEqual(Object.keys(sanitizePatch({ completionTitle: 'x' })), [])
  })

  await run('notification title/body rules match the contract', () => {
    const { buildNotificationTitle, buildNotificationBody } = plugin.__test
    const t = (key) => 'T:' + key
    const actualT = (key) => ({
      notifyQuestionTitle: 'DeepSeek 想问你一个问题',
      notifyApprovalTitle: 'DeepSeek 需要你的授权',
      notifyCompleteTitle: 'DeepSeek 搞定了一小步',
      notifyCompleteMergedTitle: 'DeepSeek 一口气推进了 {count} 步',
      notifyCompleteManyTitle: 'DeepSeek 火力全开，连推了 {count} 步',
      notifyAllDoneTitle: '所有任务均已完成',
      notifyGoalPausedTitle: 'DeepSeek 推进了 {count} 步，目标暂停',
      notifyGoalBlockedTitle: 'DeepSeek 推进了 {count} 步，目标受阻',
      notifyTestTitle: 'DSH 通知测试',
    }[key] || 'T:' + key)
    assert.equal(buildNotificationTitle('question', actualT), 'DeepSeek 想问你一个问题')
    assert.equal(buildNotificationTitle('approval', actualT), 'DeepSeek 需要你的授权')
    assert.equal(buildNotificationTitle('complete', {}, {}, actualT), 'DeepSeek 搞定了一小步')
    assert.equal(buildNotificationTitle('complete', { count: 3 }, {}, actualT), 'DeepSeek 一口气推进了 3 步')
    assert.equal(buildNotificationTitle('complete', { count: 5 }, {}, actualT), 'DeepSeek 火力全开，连推了 5 步')
    assert.equal(buildNotificationTitle('complete', { allDone: true }, {}, actualT), '所有任务均已完成')
    assert.equal(buildNotificationTitle('complete', { count: 3, goalOutcome: 'paused' }, {}, actualT), 'DeepSeek 推进了 3 步，目标暂停')
    assert.equal(buildNotificationTitle('complete', { count: 5, goalOutcome: 'blocked' }, {}, actualT), 'DeepSeek 推进了 5 步，目标受阻')
    assert.equal(buildNotificationTitle('test', actualT), 'DSH 通知测试')
    assert.equal(buildNotificationBody('test', {}, { titleOnly: false, bodyLength: 40 }, t), 'T:notifyTestBody')
    assert.equal(buildNotificationBody('test', {}, { titleOnly: true, bodyLength: 40 }, t), '')
    assert.equal(buildNotificationBody('approval', { toolName: 'Bash', purpose: '运行命令' }, { titleOnly: false }, t), 'Bash · 运行命令')
    assert.equal(buildNotificationBody('approval', { toolName: 'Bash', purpose: '' }, { titleOnly: false }, t), 'Bash')
    assert.equal(buildNotificationBody('approval', {}, { titleOnly: false }, t), 'T:fallbackApprovalBody')
    assert.equal(buildNotificationBody('complete', { text: '完成内容' }, { titleOnly: false, bodyLength: 40 }, t), '完成内容')
    assert.equal(buildNotificationBody('complete', { text: null }, { titleOnly: false, bodyLength: 40 }, t), 'T:fallbackBody')
    assert.equal(buildNotificationBody('question', { text: '问题？' }, { titleOnly: false, bodyLength: 20 }, t), '问题？')
  })

  await run('focus computation, config sanitizing and leader lease parsing are defensive', () => {
    const { computeFocused, parseLeaderLease, isFreshLease, DEFAULT_CONFIG, sanitizeConfig } = plugin.__test
    assert.equal(computeFocused({ hasFocus: () => false, visibilityState: 'visible' }), false)
    assert.equal(computeFocused({ hasFocus: () => true, visibilityState: 'hidden' }), false)
    assert.equal(computeFocused({ hasFocus: () => true, visibilityState: 'visible' }), true)
    assert.equal(computeFocused(null), true)
    assert.equal(computeFocused({ hasFocus: () => { throw new Error('nope') } }), true)
    const lease = parseLeaderLease(JSON.stringify({ id: 'window-a', at: 1700000000000 }))
    sameJson(lease, { id: 'window-a', at: 1700000000000 })
    assert.equal(parseLeaderLease('not json'), null)
    assert.equal(parseLeaderLease(JSON.stringify({ id: '', at: 1 })), null)
    assert.equal(isFreshLease(lease, lease.at + 1000), true)
    assert.equal(isFreshLease(lease, lease.at + 20000), false)
    assert.equal(sanitizeConfig(null, DEFAULT_CONFIG).bodyLength, 40)
  })

  // ---- 4. apply() with fake services ----
  const main = createFakeContext(env, {
    uiWorkspace: {
      openSession(sessionId) {
        env.state.uiWorkspaceOpens.push(sessionId)
      },
    },
  })
  const uiWorkspaceCalls = env.state.uiWorkspaceOpens

  plugin.apply(main.ctx)
  await settle()

  await run('apply registers locale dictionaries, settings section and lifecycle effects', () => {
    assert.deepEqual(env.state.registrationErrors, [])
    const dictionaries = main.api.localeDictionaries[NS]
    assert.ok(dictionaries, 'locale dictionaries registered under the package namespace')
    assert.equal(dictionaries.zh.nav, '通知')
    assert.equal(dictionaries.en.nav, 'Notifications')
    assert.ok(main.api.injections.some((entry) => entry.name === 'settings.section'), 'settings.section injected')
    assert.ok(!main.api.injections.some((entry) => entry.name === 'shell.overlay'), 'dead in-app overlay not injected')
    assert.equal(main.api.registrations.length, 1)
    const registration = main.api.registrations[0]
    assert.equal(registration.options.name, 'settings.section')
    assert.equal(registration.options.id, PKG_ID)
    assert.equal(registration.options.order, 42)
    assert.equal(registration.options.locale, NS)
    assert.equal(typeof registration.options.label, 'function')
    assert.equal(registration.options.label(), '通知')
    assert.equal(typeof registration.options.inject, 'function')
    assert.equal(typeof registration.options.inject().t, 'function')
    assert.equal(typeof registration.component, 'function')
    assert.ok(main.api.effects.length >= 5, 'expected lifecycle/audio/leader effects')
  })

  await run('config and long-poll start with the contract payloads', () => {
    const configCall = main.api.rpcCalls.find((call) => call.endpoint === 'config')
    assert.ok(configCall, 'config was requested')
    assert.equal(configCall.channel, RPC_CHANNEL)
    sameJson(configCall.payload, {})
    assert.ok(main.api.polls.length >= 1, 'long-poll started')
    sameJson(main.api.polls[0].payload, { after: 0, wait: 25000 })
  })

  // ---- 5. First gesture: permission request + audio unlock ----
  await run('first pointer gesture requests permission once and unlocks audio', async () => {
    env.dispatchWindow('pointerdown', {})
    await settle()
    assert.equal(env.state.permissionRequests, 1)
    assert.equal(env.state.permission, 'granted')
    assert.equal(env.state.audioContexts.length, 1)
    assert.equal(env.windowListenerCount('pointerdown'), 0)
    assert.equal(env.windowListenerCount('keydown'), 0)
    env.dispatchWindow('pointerdown', {})
    await settle()
    assert.equal(env.state.permissionRequests, 1, 'permission requested only once')
  })

  // ---- 6. Settings page renders ----
  await run('settings page renders the required controls, status rows and runtime counters', () => {
    const registration = main.api.registrations[0]
    reactStub.hooks.reset()
    const tree = registration.component({})
    const text = textOf(tree)
    for (const fragment of [
      '通知',
      '启用通知',
      '提问与方案确认',
      '授权（审批）',
      '本轮回复结束',
      '目标模式结束后汇总',
      '通知显示方式',
      'Windows 通知（带进度条）',
      '通知自动移除时间',
      '正文长度',
      '隐私模式（只显示标题）',
      '提示音',
      '风铃',
      '清铃',
      '轻点',
      '音量',
      '合并间隔',
      '发送测试通知',
      '状态',
      '通知权限',
      '窗口焦点',
      'Host 连接',
      '窗口置前',
      '设置持久化',
      '运行状态',
      '在线页面',
      '已允许',
      '已连接',
      '0.4.2',
    ]) {
      assert.ok(text.includes(fragment), 'settings page missing copy: ' + fragment)
    }
    assert.ok(findElement(tree, (node) => node.type === 'button' && node.props.role === 'switch'), 'switch controls exist')
    assert.ok(findElement(tree, (node) => node.type === 'input' && node.props.type === 'range' && node.props.min === '20'), 'body length range exists')
    assert.ok(findElement(tree, (node) => node.type === 'input' && node.props.type === 'range' && node.props.min === '3'), 'native duration range exists')
    assert.ok(findElement(tree, (node) => node.type === 'input' && node.props.type === 'range' && node.props.min === '0'), 'volume range exists')
    assert.ok(findElement(tree, (node) => node.type === 'select'), 'sound select exists')
    assert.ok(
      findElement(
        tree,
        (node) =>
          node.type === 'button' &&
          node.props.disabled !== true &&
          textOf(node).includes('发送测试通知'),
      ),
      'test notification button exists',
    )
  })

  await run('test button calls the Host test endpoint', async () => {
    const registration = main.api.registrations[0]
    reactStub.hooks.reset()
    const tree = registration.component({})
    const button = findElement(tree, (node) => node.type === 'button' && textOf(node).includes('发送测试通知'))
    assert.ok(button, 'test button found')
    button.props.onClick()
    await settle()
    assert.ok(main.api.rpcCalls.some((call) => call.endpoint === 'test'), 'test endpoint called')
  })

  // ---- 7. Event display ----
  await run('unfocused question event shows a silent native toast and plays the chime', async () => {
    env.state.focused = false
    await deliverEvents(main.api, [
      { id: 1, kind: 'question', at: Date.now(), sessionId: 'session-1', text: '需要你的确认' },
    ])
    assert.equal(env.state.notifications.length, 1)
    const notification = env.state.notifications[0]
    assert.equal(notification.title, 'DeepSeek 想问你一个问题')
    assert.equal(notification.options.body, '需要你的确认')
    assert.equal(notification.options.silent, true)
    assert.equal(Object.prototype.hasOwnProperty.call(notification.options, 'tag'), false, 'no platform tag is passed')
    assert.ok(env.state.oscillatorStarts > 0, 'chime oscillators started')
  })

  await run('approval toast body is "toolName · purpose" and clicking it refocuses', async () => {
    await deliverEvents(main.api, [
      { id: 2, kind: 'approval', at: Date.now(), sessionId: 'session-1', toolName: 'Bash', purpose: '运行命令' },
    ])
    assert.equal(env.state.notifications.length, 2)
    const notification = env.state.notifications[1]
    assert.equal(notification.title, 'DeepSeek 需要你的授权')
    assert.equal(notification.options.body, 'Bash · 运行命令')
    notification.onclick()
    await settle()
    const focusCall = main.api.rpcCalls.find((call) => call.endpoint === 'focus')
    assert.ok(focusCall, 'focus endpoint called')
    sameJson(focusCall.payload, { sessionId: 'session-1' })
    assert.equal(env.state.windowFocusCalls, 1)
    assert.deepEqual(uiWorkspaceCalls, ['session-1'])
    assert.equal(notification.closed, true)
  })

  await run('native progress mode submits the approved title to the Host', async () => {
    const cardEnv = createEnvironment({ permission: 'granted', focused: false })
    const cardPlugin = cardEnv.state.definitions[0].factory(fakeRequire)
    const card = createFakeContext(cardEnv, {
      config: {
        notificationMode: 'native-progress',
        nativeDurationMs: 5000,
      },
    })
    cardPlugin.apply(card.ctx)
    await settle()
    await deliverEvents(card.api, [
      { id: 1, kind: 'complete', at: Date.now(), sessionId: 'session-card', text: '完成了一小步' },
    ])
    await settle()
    const call = card.api.rpcCalls.find((entry) => entry.endpoint === 'native-notify')
    assert.ok(call, 'native-notify RPC was sent')
    assert.equal(call.payload.title, 'DeepSeek 搞定了一小步')
    assert.equal(call.payload.body, '完成了一小步')
    assert.equal(call.payload.durationMs, 5000)
    assert.equal(cardEnv.state.notifications.length, 0, 'no Web fallback when the Host accepts the native toast')
    await disposeFakeContext(card.api)
  })

  await run('taskbar badge counts distinct sessions and clears on focus', async () => {
    const badgeEnv = createEnvironment({ permission: 'granted', focused: false })
    const badgePlugin = badgeEnv.state.definitions[0].factory(fakeRequire)
    const badge = createFakeContext(badgeEnv, {
      config: { notificationMode: 'native', taskbarBadgeEnabled: true },
    })
    badgePlugin.apply(badge.ctx)
    await settle()
    await deliverEvents(badge.api, [
      { id: 101, kind: 'complete', at: Date.now(), sessionId: 'session-a', text: 'a' },
      { id: 102, kind: 'complete', at: Date.now(), sessionId: 'session-a', text: 'b' },
      { id: 103, kind: 'complete', at: Date.now(), sessionId: 'session-b', text: 'c' },
    ])
    const badgeCalls = badge.api.rpcCalls.filter((call) => call.endpoint === 'taskbar-badge')
    assert.ok(badgeCalls.length >= 1, 'taskbar badge RPC was sent')
    assert.equal(badgeCalls[badgeCalls.length - 1].payload.count, 2, 'two distinct sessions count twice')
    badgeEnv.state.focused = true
    badgeEnv.dispatchWindow('focus', {})
    await settle()
    const afterFocus = badge.api.rpcCalls.filter((call) => call.endpoint === 'taskbar-badge')
    assert.equal(afterFocus[afterFocus.length - 1].payload.count, 0, 'focus clears the badge')
    await disposeFakeContext(badge.api)
  })

  await run('activation event opens the target session even when focused', async () => {
    env.state.focused = true
    env.dispatchWindow('focus', {})
    await settle()
    const notificationsBefore = env.state.notifications.length
    const soundsBefore = env.state.oscillatorStarts
    await deliverEvents(main.api, [{ id: 77, kind: 'activate', at: Date.now(), sessionId: 'session-1' }])
    assert.equal(env.state.notifications.length, notificationsBefore)
    assert.equal(env.state.oscillatorStarts, soundsBefore)
    assert.ok(uiWorkspaceCalls.includes('session-1'), 'activation opened the session')
  })

  await run('focused sessions skip question/approval/completion entirely', async () => {
    env.state.focused = true
    env.dispatchWindow('focus', {})
    await settle()
    const before = env.state.notifications.length
    const soundsBefore = env.state.oscillatorStarts
    await deliverEvents(main.api, [
      { id: 3, kind: 'complete', at: Date.now(), sessionId: 'session-1', text: '完成了' },
    ])
    assert.equal(env.state.notifications.length, before)
    assert.equal(env.state.oscillatorStarts, soundsBefore)
  })

  await run('disabled notification kinds and the global switch are respected', async () => {
    // Toggle the "启用通知" switch through the rendered settings tree.
    const registration = main.api.registrations[0]
    reactStub.hooks.reset()
    const tree = registration.component({})
    const enableSwitch = findElement(
      tree,
      (node) => node.type === 'button' && node.props.role === 'switch' && node.props['aria-label'] === '启用通知',
    )
    assert.ok(enableSwitch, 'enable switch found')
    enableSwitch.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 320))
    await settle()
    const saveCall = main.api.rpcCalls.find((call) => call.endpoint === 'save')
    assert.ok(saveCall, 'debounced save was sent')
    sameJson(saveCall.payload, { patch: { enabled: false } })
    env.state.focused = false
    const before = env.state.notifications.length
    await deliverEvents(main.api, [{ id: 4, kind: 'approval', at: Date.now(), toolName: 'Bash', purpose: 'x' }])
    assert.equal(env.state.notifications.length, before, 'disabled config suppresses toasts')
  })

  await run('forced test events ignore focus and the global switch', async () => {
    env.state.focused = true
    const before = env.state.notifications.length
    await deliverEvents(main.api, [{ id: 5, kind: 'test', at: Date.now() }])
    assert.equal(env.state.notifications.length, before + 1)
    const notification = env.state.notifications[env.state.notifications.length - 1]
    assert.equal(notification.title, 'DSH 通知测试')
    assert.equal(notification.options.body, '这是一条测试通知，点击可回到 DSH。')
  })

  await run('settings page shows the degraded note when the Host is unreachable', async () => {
    const offlineEnv = createEnvironment({ permission: 'granted' })
    const offlinePlugin = offlineEnv.state.definitions[0].factory(fakeRequire)
    const offline = createFakeContext(offlineEnv, { offline: true })
    offlinePlugin.apply(offline.ctx)
    await settle()
    reactStub.hooks.reset()
    const tree = offline.api.registrations[0].component({})
    const text = textOf(tree)
    assert.ok(text.includes('Host 暂时未连接'), 'degraded note rendered')
    assert.ok(text.includes('发送测试通知'), 'page stays usable while degraded')
    await disposeFakeContext(offline.api)
  })

  // ---- 8. Disposal ----
  const disposeRun = async () => {
    const pendingPolls = main.api.polls.slice()
    await disposeFakeContext(main.api)
    return pendingPolls
  }
  let pendingPolls = []

  await run('dispose aborts the poll, closes audio, releases the lease and removes listeners', async () => {
    pendingPolls = await disposeRun()
    assert.equal(main.api.disposeErrors.length, 0)
    assert.equal(main.api.disposedEffects, main.api.effects.length)
    assert.ok(pendingPolls.length > 0)
    assert.ok(
      pendingPolls.every((poll) => poll.signal && poll.signal.aborted === true),
      'every pending poll signal was aborted',
    )
    assert.ok(env.state.audioCloses >= 1, 'AudioContext closed on dispose')
    assert.equal(env.state.storage.get(LEADER_KEY), undefined, 'leader lease released')
    for (const type of ['pointerdown', 'keydown', 'focus', 'blur', 'storage']) {
      assert.equal(env.windowListenerCount(type), 0, 'window listener removed: ' + type)
    }
    assert.equal(env.documentListenerCount('visibilitychange'), 0)
    assert.equal(main.api.registrations.length, 0, 'settings section registration disposed')
  })

  await run('disposal leaves no unhandled promise rejections', async () => {
    await settle()
    assert.deepEqual(unhandledRejections, [])
  })

  // ---- 8b. Host-side save rejection is surfaced, not treated as saved ----
  await run('a Host-side save rejection shows saveFailed and keeps the change pending', async () => {
    const rejectEnv = createEnvironment({ permission: 'granted' })
    const rejectPlugin = rejectEnv.state.definitions[0].factory(fakeRequire)
    const reject = createFakeContext(rejectEnv, { rejectSave: true })
    rejectPlugin.apply(reject.ctx)
    await settle()
    reactStub.hooks.reset()
    const tree = reject.api.registrations[0].component({})
    const enableSwitch = findElement(
      tree,
      (node) => node.type === 'button' && node.props.role === 'switch' && node.props['aria-label'] === '启用通知',
    )
    assert.ok(enableSwitch, 'enable switch found')
    enableSwitch.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 320))
    await settle()
    assert.ok(reject.api.rpcCalls.some((call) => call.endpoint === 'save'), 'save was attempted')
    reactStub.hooks.reset()
    const after = reject.api.registrations[0].component({})
    assert.ok(textOf(after).includes('保存失败'), 'saveFailed is displayed')
    await disposeFakeContext(reject.api)
  })

  // ---- 9. Permission-denied degrade ----
  await run('denied notification permission degrades without throwing and still plays sound', async () => {
    const deniedEnv = createEnvironment({ permission: 'denied', focused: false })
    const deniedDefinition = deniedEnv.state.definitions[0]
    const deniedPlugin = deniedDefinition.factory(fakeRequire)
    const denied = createFakeContext(deniedEnv)
    deniedPlugin.apply(denied.ctx)
    await settle()
    assert.deepEqual(deniedEnv.state.registrationErrors, [])
    await deliverEvents(denied.api, [
      { id: 1, kind: 'complete', at: Date.now(), sessionId: 'session-9', text: '收尾完成' },
    ])
    assert.equal(deniedEnv.state.notifications.length, 0, 'no toast without permission')
    assert.ok(deniedEnv.state.oscillatorStarts > 0, 'sound still degrades gracefully')
    reactStub.hooks.reset()
    const tree = denied.api.registrations[0].component({})
    assert.ok(textOf(tree).includes('已拒绝'), 'settings page shows the denied state')
    await disposeFakeContext(denied.api)
  })

  // ---- 10. Defensive double-load / double-apply ----
  await run('a second bundle instance and a duplicate apply() stay contained', async () => {
    const secondEnv = createEnvironment({ permission: 'granted' })
    const secondPlugin = secondEnv.state.definitions[0].factory(fakeRequire)
    const firstContext = createFakeContext(secondEnv)
    secondPlugin.apply(firstContext.ctx)
    const secondContext = createFakeContext(secondEnv)
    secondPlugin.apply(secondContext.ctx)
    await settle()
    assert.deepEqual(secondEnv.state.registrationErrors, [])
    assert.deepEqual(secondEnv.state.warnings, [])
    await disposeFakeContext(firstContext.api)
    await disposeFakeContext(secondContext.api)
  })

  // ---- 11. Malformed RPC results are ignored ----
  await run('malformed Host results do not throw or show toasts', async () => {
    const malformedEnv = createEnvironment({ permission: 'granted', focused: false })
    const malformedPlugin = malformedEnv.state.definitions[0].factory(fakeRequire)
    const malformed = createFakeContext(malformedEnv)
    let pollCalls = 0
    // Replace the RPC bridge with garbage but well-formed promises. The first
    // poll resolves with a malformed value; later polls stay parked.
    malformed.ctx.connection = {
      rpc: {
        call(channel, endpoint) {
          if (endpoint === 'poll') {
            pollCalls += 1
            if (pollCalls === 1) return Promise.resolve({ ok: true, value: null })
            return new Promise(() => {})
          }
          if (endpoint === 'config') return Promise.resolve({ ok: true, value: { config: 'garbage', status: 42 } })
          return Promise.resolve({ ok: false, error: { code: 'nope' } })
        },
      },
    }
    malformedPlugin.apply(malformed.ctx)
    await settle()
    assert.deepEqual(malformedEnv.state.registrationErrors, [])
    assert.equal(malformedEnv.state.notifications.length, 0)
    await disposeFakeContext(malformed.api)
    await settle()
    assert.deepEqual(unhandledRejections, [])
  })
  } finally {
    // A failed assertion must not leave a fake window's heartbeat/poll alive.
    for (const api of trackedContexts) {
      if (api.disposed === true) continue
      try {
        await disposeFakeContext(api)
      } catch (error) {
        console.error('cleanup of a fake context failed:', error)
      }
    }
  }
}

main()
  .catch((error) => {
    results.failed += 1
    console.error('not ok - smoke test crashed')
    console.error(error && error.stack ? error.stack : error)
  })
  .finally(() => {
    clearTimeout(watchdog)
    console.log('')
    console.log('client smoke test: ' + String(results.passed) + ' passed, ' + String(results.failed) + ' failed')
    const failed = results.failed > 0 || unhandledRejections.length > 0
    // Deterministic exit: node --test also discovers this file, so never leave
    // the process waiting on a stray timer/handle.
    process.exit(failed ? 1 : 0)
  })
