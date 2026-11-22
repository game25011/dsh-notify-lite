#!/usr/bin/env node
/**
 * dsh-notify-lite — settings-nav icon tests.
 *
 * The settings shell projects no icon field for a `settings.section`, so the
 * client claims its own nav row and swaps the fallback gear for a mask-drawn
 * bell. These tests run the bundle's exported test hook against a minimal fake
 * document — no jsdom dependency — and cover the pure mark/CSS helpers, row
 * ownership, locale switches and effect disposal.
 *
 * Run: node --test test/nav-icon.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')

/** Load the client bundle and return its vm sandbox plus the __test hook. */
function loadBundle() {
  const definitions = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          definitions.push(definition)
        },
      },
    },
    console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
    queueMicrotask,
  }
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'lib/client.js' })
  assert.equal(definitions.length, 1, 'the bundle registers exactly one module definition')
  const React = {
    createElement(type, props, ...children) {
      return { type, props, children }
    },
    useState(value) {
      return [typeof value === 'function' ? value() : value, () => {}]
    },
    useEffect() {},
    useRef(value) {
      return { current: value }
    },
  }
  const moduleExports = definitions[0].factory((id) => {
    if (id === 'react') return React
    throw new Error('unexpected module request: ' + id)
  })
  return { sandbox, exports: moduleExports, test: moduleExports.__test }
}

/** Minimal document: a head, a body, a mutable nav-row list and style tags. */
function createDocument(marker) {
  const state = { styleTags: [], rows: [] }
  const doc = {
    head: {
      appendChild(node) {
        node.parentNode = doc.head
        state.styleTags.push(node)
      },
      removeChild(node) {
        const index = state.styleTags.indexOf(node)
        if (index >= 0) state.styleTags.splice(index, 1)
        node.parentNode = null
      },
    },
    body: { nodeType: 1 },
    createElement(tag) {
      const node = {
        tagName: tag,
        dataset: {},
        textContent: '',
        parentNode: null,
        remove() {
          if (node.parentNode) node.parentNode.removeChild(node)
        },
      }
      return node
    },
    querySelectorAll(selector) {
      if (selector === '[role="dialog"] nav button') return state.rows.slice()
      if (selector === '[' + marker + ']') return state.rows.filter((row) => row.hasAttribute(marker))
      return []
    },
  }
  function makeRow(text) {
    const attributes = new Map()
    return {
      textContent: text,
      setAttribute(name) {
        attributes.set(name, '')
      },
      removeAttribute(name) {
        attributes.delete(name)
      },
      hasAttribute(name) {
        return attributes.has(name)
      },
    }
  }
  return {
    doc,
    state,
    addRow(text) {
      const row = makeRow(text)
      state.rows.push(row)
      return row
    },
  }
}

/** Install a MutationObserver stub and return the created instances. */
function installObserver(sandbox) {
  const observers = []
  function FakeMutationObserver(callback) {
    this.callback = callback
    this.disconnected = false
    observers.push(this)
  }
  FakeMutationObserver.prototype.observe = function observe() {}
  FakeMutationObserver.prototype.disconnect = function disconnect() {
    this.disconnected = true
  }
  FakeMutationObserver.prototype.trigger = function trigger() {
    if (!this.disconnected) this.callback([])
  }
  sandbox.MutationObserver = FakeMutationObserver
  return observers
}

/** Let the install helper's queued microtask run. */
async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

test('the mark is a standalone 16px bell with no external references', () => {
  const { test: api } = loadBundle()
  const svg = api.navMarkSvg()
  assert.match(svg, /^<svg /)
  assert.match(svg, /viewBox="0 0 16 16"/)
  assert.match(svg, /stroke="#000"/)
  assert.match(svg, /<\/svg>$/)
  assert.equal(api.NAV_ICON_SIZE, 16)
  assert.equal(api.NAV_ROW_SELECTOR, '[role="dialog"] nav button')
})

test('the mask URL encodes the SVG and the CSS hides the shell glyph', () => {
  const { test: api } = loadBundle()
  const url = api.navMaskUrl()
  assert.match(url, /^data:image\/svg\+xml,/)
  assert.equal(decodeURIComponent(url.slice('data:image/svg+xml,'.length)), api.navMarkSvg())
  const css = api.navIconCss(url)
  assert.match(css, new RegExp('\\[' + api.NAV_ICON_MARKER + '\\] > svg'))
  assert.match(css, /width: 16px/)
  assert.match(css, /mask-image: url\("data:image\/svg\+xml,/)
  assert.match(css, /background-color: currentColor/)
})

test('row ownership is exact after trimming; an empty label matches nothing', () => {
  const { test: api } = loadBundle()
  assert.equal(api.isOwnNavRow('通知', '通知'), true)
  assert.equal(api.isOwnNavRow('  通知  ', ' 通知 '), true)
  assert.equal(api.isOwnNavRow('通知', '插件市场'), false)
  assert.equal(api.isOwnNavRow('通知', ''), false)
  assert.equal(api.isOwnNavRow('通知', undefined), false)
  assert.equal(api.isOwnNavRow('通知', null), false)
  assert.equal(api.isOwnNavRow(null, '通知'), false)
})

test('install claims only its own row and follows a label change', async () => {
  const { sandbox, test: api } = loadBundle()
  const fake = createDocument(api.NAV_ICON_MARKER)
  const observers = installObserver(sandbox)
  sandbox.document = fake.doc

  const ownRow = fake.addRow('通知')
  const marketRow = fake.addRow('插件市场')
  let label = '通知'
  const disposers = []
  const ctx = {
    effect(callback) {
      const dispose = callback()
      disposers.push(dispose)
      return dispose
    },
  }

  api.installSettingsNavIcon(ctx, () => label)

  assert.equal(fake.state.styleTags.length, 1, 'one stylesheet is injected')
  assert.match(fake.state.styleTags[0].textContent, /mask-image/)
  assert.equal(fake.state.styleTags[0].dataset.pluginCss, 'dsh-notify-lite/settings-nav-icon')
  assert.equal(ownRow.hasAttribute(api.NAV_ICON_MARKER), true)
  assert.equal(marketRow.hasAttribute(api.NAV_ICON_MARKER), false)
  assert.equal(observers.length, 1, 'one observer watches the dialog')

  // A locale switch re-labels the row; the observer must re-claim it.
  label = 'Notifications'
  ownRow.textContent = 'Notifications'
  observers[0].trigger()
  await settle()
  assert.equal(ownRow.hasAttribute(api.NAV_ICON_MARKER), true)
  assert.equal(marketRow.hasAttribute(api.NAV_ICON_MARKER), false)

  // An unresolved (empty) label must not claim any row at all.
  label = ''
  observers[0].trigger()
  await settle()
  assert.equal(ownRow.hasAttribute(api.NAV_ICON_MARKER), false)

  // Disposal removes the marker, the stylesheet and the observer.
  assert.equal(typeof disposers[0], 'function')
  disposers[0]()
  assert.equal(ownRow.hasAttribute(api.NAV_ICON_MARKER), false)
  assert.equal(fake.state.styleTags.length, 0)
  assert.equal(observers[0].disconnected, true)
})

test('install is a safe no-op without a document (host/SSR path)', () => {
  const { test: api } = loadBundle()
  const calls = []
  const ctx = {
    effect(callback) {
      calls.push('effect')
      callback()
    },
  }
  assert.doesNotThrow(() => api.installSettingsNavIcon(ctx, () => '通知'))
  assert.equal(calls.length, 0)
})
