/**
 * Unit tests for lib/config.js: defaults, patch validation, read helpers and
 * the schemastery Config builder (docs/INTERFACE.md §2.4).
 *
 * Run with: node --test test/   (sandboxed Windows: add --test-isolation=none)
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CONFIG_FIELDS,
  CONFIG_KEYS,
  DEFAULTS,
  LOCALE_NS,
  PKG_ID,
  RPC_CHANNEL,
  SETTINGS_NS,
  VERSION,
  buildConfigSchema,
  checkConfigValue,
  mergeConfig,
  normalizeConfig,
  unwrapConfigObject,
  unwrapVolatileValue,
  validatePatch,
} from '../lib/config.js'

test('constants match docs/INTERFACE.md §0', () => {
  assert.equal(PKG_ID, 'dsh-notify-toast')
  assert.equal(VERSION, '0.4.0')
  assert.equal(RPC_CHANNEL, '/dsh-notify-toast')
  assert.equal(SETTINGS_NS, 'dsh-notify-toast')
  assert.equal(LOCALE_NS, 'dsh-notify-toast')
})

test('DEFAULTS match docs/INTERFACE.md §2.4', () => {
  assert.deepEqual(DEFAULTS, {
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
  assert.ok(Object.isFrozen(DEFAULTS))
})

test('the field whitelist covers exactly the defaults and the documented ranges', () => {
  assert.deepEqual(CONFIG_KEYS, Object.keys(DEFAULTS))
  assert.equal(CONFIG_FIELDS.bodyLength.min, 20)
  assert.equal(CONFIG_FIELDS.bodyLength.max, 60)
  assert.deepEqual([...CONFIG_FIELDS.sound.values], ['ding', 'chime', 'bell', 'soft', 'bubble', 'none'])
  assert.equal(CONFIG_FIELDS.volume.min, 0)
  assert.equal(CONFIG_FIELDS.volume.max, 100)
  assert.equal(CONFIG_FIELDS.mergeIntervalMs.min, 0)
  assert.equal(CONFIG_FIELDS.mergeIntervalMs.max, 10000)
  assert.equal(CONFIG_FIELDS.allDoneTitle.type, 'string')
  assert.equal(CONFIG_FIELDS.allDoneTitle.maxBytes, 96)
  assert.equal(CONFIG_FIELDS.goalSummaryEnabled.type, 'boolean')
  assert.deepEqual([...CONFIG_FIELDS.notificationMode.values], ['native', 'native-progress', 'native-and-inapp'])
  assert.equal(CONFIG_FIELDS.nativeDurationMs.min, 3000)
  assert.equal(CONFIG_FIELDS.nativeDurationMs.max, 30000)
})

test('native progress mode and duration validate; removed fields are rejected', () => {
  assert.equal(checkConfigValue(CONFIG_FIELDS.allDoneTitle, '').ok, false)
  assert.equal(checkConfigValue(CONFIG_FIELDS.notificationMode, 'native-progress').ok, true)
  assert.equal(checkConfigValue(CONFIG_FIELDS.notificationMode, 'native').ok, true)
  assert.equal(checkConfigValue(CONFIG_FIELDS.notificationMode, 'both').ok, false)
  assert.equal(validatePatch({ notificationMode: 'native-progress', nativeDurationMs: 8000 }).ok, true)
  assert.equal(validatePatch({ nativeDurationMs: 1000 }).ok, false)
  assert.equal(normalizeConfig({}).nativeDurationMs, 8000)
  assert.equal(normalizeConfig({}).notificationMode, 'native-progress')
  assert.equal(validatePatch({ completionTitle: '' }).ok, false)
  assert.equal(validatePatch({ inAppDurationMs: 5000 }).ok, false)
})

test('validatePatch accepts a full valid patch and returns a clean copy', () => {
  const patch = {
    enabled: false,
    questionEnabled: false,
    approvalEnabled: false,
    completionEnabled: false,
    titleOnly: true,
    bodyLength: 60,
    sound: 'none',
    volume: 0,
    mergeIntervalMs: 10000,
  }
  const result = validatePatch(patch)
  assert.equal(result.ok, true)
  assert.deepEqual(result.patch, patch)
  assert.notEqual(result.patch, patch)
})

test('validatePatch accepts a partial patch and an empty patch', () => {
  assert.deepEqual(validatePatch({ bodyLength: 30 }), { ok: true, patch: { bodyLength: 30 } })
  assert.deepEqual(validatePatch({}), { ok: true, patch: {} })
})

test('validatePatch rejects non-objects', () => {
  for (const bad of [undefined, null, 'x', 42, [], ['bodyLength']]) {
    const result = validatePatch(bad)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'invalid-patch')
    assert.equal(typeof result.error.message, 'string')
  }
})

test('validatePatch rejects unknown fields instead of silently dropping them', () => {
  const result = validatePatch({ bodyLength: 30, somethingElse: true })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'unknown-field')
  assert.match(result.error.message, /somethingElse/)
})

test('validatePatch enforces types, ranges and enum values', () => {
  const cases = [
    [{ enabled: 'yes' }, /"enabled" expected a boolean/],
    [{ bodyLength: 19 }, /"bodyLength" must be >= 20/],
    [{ bodyLength: 61 }, /"bodyLength" must be <= 60/],
    [{ bodyLength: 40.5 }, /"bodyLength" expected an integer/],
    [{ bodyLength: '40' }, /"bodyLength" expected a finite number/],
    [{ volume: -1 }, /"volume" must be >= 0/],
    [{ volume: 101 }, /"volume" must be <= 100/],
    [{ mergeIntervalMs: 10001 }, /"mergeIntervalMs" must be <= 10000/],
    [{ sound: 'beep' }, /"sound" expected one of/],
    [{ titleOnly: null }, /"titleOnly" expected a boolean/],
    [{ allDoneTitleEnabled: 'yes' }, /"allDoneTitleEnabled" expected a boolean/],
    [{ allDoneTitle: 42 }, /"allDoneTitle" expected a string/],
    [{ allDoneTitle: '' }, /"allDoneTitle" must not be empty/],
    [{ allDoneTitle: 'x'.repeat(97) }, /"allDoneTitle" must be at most 96 bytes/],
  ]
  for (const [patch, expected] of cases) {
    const result = validatePatch(patch)
    assert.equal(result.ok, false, JSON.stringify(patch))
    assert.equal(result.error.code, 'invalid-value')
    assert.match(result.error.message, expected)
  }
})

test('checkConfigValue reports the individual rule that failed', () => {
  assert.deepEqual(checkConfigValue(CONFIG_FIELDS.enabled, true), { ok: true })
  assert.equal(checkConfigValue(CONFIG_FIELDS.enabled, 1).ok, false)
  assert.equal(checkConfigValue(CONFIG_FIELDS.sound, 'soft').ok, true)
  assert.equal(checkConfigValue(CONFIG_FIELDS.sound, 'Soft').ok, false)
  assert.equal(checkConfigValue(CONFIG_FIELDS.volume, Number.NaN).ok, false)
  assert.equal(checkConfigValue(CONFIG_FIELDS.volume, Infinity).ok, false)
  assert.equal(checkConfigValue(CONFIG_FIELDS.mergeIntervalMs, 0).ok, true)
  assert.equal(checkConfigValue(CONFIG_FIELDS.allDoneTitle, '所有任务均已完成').ok, true)
  assert.equal(checkConfigValue(CONFIG_FIELDS.allDoneTitle, '').ok, false)
  assert.equal(checkConfigValue(CONFIG_FIELDS.allDoneTitle, 'x'.repeat(97)).ok, false)
})

test('unwrapVolatileValue handles schemastery volatile references', () => {
  assert.equal(unwrapVolatileValue({ get: () => 40 }), 40)
  assert.equal(unwrapVolatileValue({ get: () => undefined }), undefined)
  assert.equal(
    unwrapVolatileValue({
      get() {
        throw new Error('broken ref')
      },
    }),
    undefined,
  )
  assert.equal(unwrapVolatileValue('plain'), 'plain')
  assert.equal(unwrapVolatileValue(7), 7)
  assert.equal(unwrapVolatileValue(null), null)
  assert.equal(unwrapVolatileValue(undefined), undefined)
})

test('unwrapConfigObject unwraps volatile refs and ignores unknown keys', () => {
  const config = {
    enabled: { get: () => false },
    bodyLength: { get: () => 55 },
    unknown: 'ignored',
  }
  assert.deepEqual(unwrapConfigObject(config), { enabled: false, bodyLength: 55 })
  assert.deepEqual(unwrapConfigObject(null), {})
  assert.deepEqual(unwrapConfigObject('x'), {})
  assert.deepEqual(unwrapConfigObject([1, 2]), {})
})

test('normalizeConfig fills defaults and ignores invalid or unknown values', () => {
  assert.deepEqual(normalizeConfig(undefined), { ...DEFAULTS })
  assert.deepEqual(normalizeConfig(null), { ...DEFAULTS })
  assert.deepEqual(normalizeConfig({ bodyLength: 60, sound: 'bell' }), {
    ...DEFAULTS,
    bodyLength: 60,
    sound: 'bell',
  })
  assert.deepEqual(normalizeConfig({ bodyLength: 5, sound: 'nope', enabled: 'no', junk: 1 }), { ...DEFAULTS })
  assert.deepEqual(normalizeConfig({ bodyLength: { get: () => 21 } }).bodyLength, 21)
  // A returned config is always a fresh object.
  assert.notEqual(normalizeConfig(undefined), DEFAULTS)
})

test('mergeConfig applies only valid known fields over the normalized base', () => {
  const merged = mergeConfig({ bodyLength: 30, sound: 'bell' }, { bodyLength: 45, sound: 'beep', volume: 80 })
  assert.equal(merged.bodyLength, 45)
  assert.equal(merged.sound, 'bell') // invalid patch value ignored
  assert.equal(merged.volume, 80)
  assert.equal(merged.enabled, true)
  assert.deepEqual(DEFAULTS, { ...DEFAULTS }) // base not mutated
})

/**
 * Minimal stand-in for the schemastery default export: records every builder
 * call so the Config shape can be asserted without loading the real module.
 */
function createRecordingSchema() {
  const calls = []
  const makeNode = (type, state = {}) => {
    const node = {
      type,
      state,
      default(value) {
        calls.push([type, 'default', value])
        return makeNode(type, { ...state, default: value })
      },
      min(value) {
        calls.push([type, 'min', value])
        return makeNode(type, { ...state, min: value })
      },
      max(value) {
        calls.push([type, 'max', value])
        return makeNode(type, { ...state, max: value })
      },
      step(value) {
        calls.push([type, 'step', value])
        return makeNode(type, { ...state, step: value })
      },
      volatile() {
        calls.push([type, 'volatile'])
        return makeNode(type, { ...state, volatile: true })
      },
    }
    return node
  }
  const Schema = {
    boolean: () => makeNode('boolean'),
    number: () => makeNode('number'),
    string: () => makeNode('string'),
    union: (list) => {
      calls.push(['union', 'list', [...list]])
      return makeNode('union', { list: [...list] })
    },
    object: (dict) => {
      calls.push(['object', 'dict', Object.keys(dict)])
      return { type: 'object', dict }
    },
  }
  return { Schema, calls }
}

test('buildConfigSchema declares every field volatile with the documented defaults', () => {
  const { Schema, calls } = createRecordingSchema()
  const schema = buildConfigSchema(Schema)
  assert.equal(schema.type, 'object')
  assert.deepEqual(Object.keys(schema.dict), CONFIG_KEYS)
  assert.deepEqual(
    calls.find((call) => call[0] === 'object')[2],
    CONFIG_KEYS,
  )
  for (const key of CONFIG_KEYS) {
    const node = schema.dict[key]
    assert.equal(node.state.volatile, true, `${key} must be volatile`)
    assert.equal(node.state.default, DEFAULTS[key], `${key} default`)
    assert.equal(typeof node.state.default, typeof DEFAULTS[key], `${key} default type`)
  }
  assert.equal(schema.dict.bodyLength.state.min, 20)
  assert.equal(schema.dict.bodyLength.state.max, 60)
  assert.equal(schema.dict.volume.state.min, 0)
  assert.equal(schema.dict.volume.state.max, 100)
  assert.equal(schema.dict.mergeIntervalMs.state.max, 10000)
  assert.deepEqual(schema.dict.sound.state.list, ['ding', 'chime', 'bell', 'soft', 'bubble', 'none'])
  assert.equal(schema.dict.mergeIntervalMs.state.default, 2500)
})

test('buildConfigSchema rejects a module that is not schemastery', () => {
  assert.throws(() => buildConfigSchema(undefined), TypeError)
  assert.throws(() => buildConfigSchema({}), TypeError)
  assert.throws(() => buildConfigSchema({ object: 'nope' }), TypeError)
})

/** Resolve the profile copy of schemastery when this machine has one. */
function resolveProfileSchemastery() {
  const candidates = []
  if (process.env.DSH_PROFILE_DIR) candidates.push(process.env.DSH_PROFILE_DIR)
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  candidates.push(join(home, 'profiles', process.env.DSH_PROFILE || 'desktop'))
  for (const directory of candidates) {
    try {
      if (!existsSync(join(directory, 'package.json'))) continue
      const module = createRequire(join(directory, 'package.json'))('@deepseek-ai/schemastery')
      const Schema = module && module.default ? module.default : module
      if (Schema && typeof Schema.object === 'function') return Schema
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

const RealSchema = resolveProfileSchemastery()

test('built Config validates defaults through the real profile schemastery', { skip: RealSchema === undefined }, () => {
  const schema = buildConfigSchema(RealSchema)
  const result = schema['~standard'].validate({})
  assert.equal(result.issues, undefined)
  const value = result.value
  assert.equal(typeof value, 'object')
  for (const key of CONFIG_KEYS) {
    assert.equal(typeof value[key], 'object', `${key} must be a volatile reference`)
    assert.equal(typeof value[key].get, 'function', `${key}.get()`)
    assert.equal(value[key].get(), DEFAULTS[key], `${key} default through schemastery`)
  }
})

test('the real Config schema rejects out-of-contract values', { skip: RealSchema === undefined }, () => {
  const schema = buildConfigSchema(RealSchema)
  assert.ok(schema['~standard'].validate({ bodyLength: 10 }).issues)
  assert.ok(schema['~standard'].validate({ bodyLength: 61 }).issues)
  assert.ok(schema['~standard'].validate({ sound: 'beep' }).issues)
  assert.ok(schema['~standard'].validate({ enabled: 'yes' }).issues)
  assert.equal(schema['~standard'].validate({ bodyLength: 60, sound: 'bell', volume: 0 }).issues, undefined)
})
