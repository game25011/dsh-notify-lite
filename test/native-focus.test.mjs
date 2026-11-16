/**
 * Window selection for click-to-focus and the taskbar badge
 * (docs/INTERFACE.md §2.6): another Chromium app must never be chosen.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { selectDesktopWindows } from '../lib/native-focus.js'

const DSH = { handle: '1', title: 'DeepSeek Harness', cls: 'Chrome_WidgetWin_1', pid: 100, score: 170 }
const CODE = { handle: '2', title: 'index.js - Visual Studio Code', cls: 'Chrome_WidgetWin_1', pid: 200, score: 50 }
const TAB = { handle: '3', title: 'DeepSeek - Chat - Google Chrome', cls: 'Chrome_WidgetWin_1', pid: 300, score: 150 }
const NOTEPAD = { handle: '4', title: 'deepseek.txt - Notepad', cls: 'Notepad', pid: 400, score: 100 }

test('windows of the parent Electron process win outright', () => {
  const picked = selectDesktopWindows([CODE, TAB, DSH, NOTEPAD], 100)
  assert.deepEqual(picked.map((entry) => entry.handle), ['1'])
})

test('without a PID match, only a DeepSeek Harness Chromium window qualifies', () => {
  const picked = selectDesktopWindows([CODE, TAB, { ...DSH, pid: 999, score: 150 }, NOTEPAD], 100)
  assert.deepEqual(picked.map((entry) => entry.handle), ['1'])
})

test('class-only and non-Chromium title matches are never raised', () => {
  assert.deepEqual(selectDesktopWindows([CODE, NOTEPAD], 100), [])
  // Last resort: a Chromium window titled "DeepSeek" (an unusual shell title).
  assert.deepEqual(selectDesktopWindows([CODE, TAB], 100).map((entry) => entry.handle), ['3'])
})

test('selection tolerates junk input', () => {
  assert.deepEqual(selectDesktopWindows(null, 1), [])
  assert.deepEqual(selectDesktopWindows([null, 3, DSH], undefined).map((entry) => entry.handle), ['1'])
})
