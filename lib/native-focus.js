/**
 * dsh-notify-lite — best-effort Windows window raise for the Host half.
 *
 * Contract: docs/INTERFACE.md §2.6. The DSH desktop shell runs this plugin in
 * an Electron-as-Node Host process, so the window belongs to the parent
 * Electron main process (`process.ppid`). koffi is not a plugin dependency; we
 * load the native binding that ships inside the installed app:
 *
 *   resources/app.asar.unpacked/dsh/node_modules/@koromix/koffi-win32-x64/
 *     win32_x64/koffi.node
 *
 * Nothing here may throw: every entry point catches and falls back to a
 * boolean. `focusDesktopWindow()` is synchronous (the user32 calls are cheap)
 * and safe to call from an RPC request.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Native binding locations relative to a resources root (most specific first). */
const BINDING_RELATIVES = [
  ['app.asar.unpacked', 'dsh', 'node_modules', '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node'],
  [
    'app.asar.unpacked',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-desktop-host',
    'node_modules',
    '@koromix',
    'koffi-win32-x64',
    'win32_x64',
    'koffi.node',
  ],
]

/** SW_RESTORE — un-minimize without changing the window size. */
const SW_RESTORE = 9
/** Virtual key code for ALT; the key tap satisfies SetForegroundWindow's focus rules. */
const VK_MENU = 0x12
const KEYEVENTF_KEYUP = 0x0002

/** Cached loaded API, or null when native focus is unavailable. */
let api = null
/** Whether loading was attempted (success or failure). Cached to avoid retries. */
let loadAttempted = false
/** Last load failure, exposed through nativeFocusInfo() for diagnostics. */
let loadError = null
/** Path of the loaded native binding. */
let bindingPath = null

/**
 * Candidate resources roots for the running app.
 * @returns {string[]} existing-looking roots (no I/O besides the env/execPath reads).
 */
function resourcesRoots() {
  const roots = []
  try {
    if (typeof process.resourcesPath === 'string' && process.resourcesPath) roots.push(process.resourcesPath)
  } catch {
    /* not Electron */
  }
  try {
    roots.push(join(dirname(process.execPath), 'resources'))
  } catch {
    /* no execPath */
  }
  // A dev/checkout run of the desktop app may keep the unpacked tree here.
  try {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) roots.push(join(localAppData, 'Programs', 'DeepSeek Harness', 'resources'))
  } catch {
    /* ignore */
  }
  return roots
}

/**
 * Locate the packaged koffi binding.
 * @returns {string|null} absolute path or null.
 */
function resolveBindingPath() {
  for (const root of resourcesRoots()) {
    for (const relative of BINDING_RELATIVES) {
      try {
        const candidate = join(root, ...relative)
        if (existsSync(candidate)) return candidate
      } catch {
        /* ignore a malformed candidate */
      }
    }
  }
  return null
}

/**
 * Load koffi and declare the user32/kernel32 functions once.
 * @returns {object|null} the function table, or null when unavailable.
 */
function loadNativeApi() {
  if (loadAttempted) return api
  loadAttempted = true
  if (process.platform !== 'win32') {
    loadError = 'native focus is only implemented on win32'
    return null
  }
  try {
    bindingPath = resolveBindingPath()
    if (!bindingPath) {
      loadError = 'koffi native binding not found under the app resources'
      return null
    }
    // koffi's package directory is the parent of win32_x64; createRequire only
    // uses its dirname as a resolution base, so any filename in that dir works.
    const requireNative = createRequire(join(dirname(bindingPath), 'index.cjs'))
    const koffi = requireNative(bindingPath)
    if (!koffi || typeof koffi.load !== 'function' || typeof koffi.proto !== 'function') {
      loadError = 'koffi module has an unexpected shape'
      return null
    }
    const user32 = koffi.load('user32.dll')
    const kernel32 = koffi.load('kernel32.dll')

    // koffi 3 requires the callback prototype to be declared up front and the
    // function signature to reference it as `WNDENUMPROC *`.
    koffi.proto('bool __stdcall WNDENUMPROC(void *hWnd, intptr_t lParam)')
    api = {
      koffi,
      EnumWindows: user32.func('bool __stdcall EnumWindows(WNDENUMPROC *cb, intptr_t param)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *h)'),
      IsIconic: user32.func('int __stdcall IsIconic(void *h)'),
      GetWindowTextLengthW: user32.func('int __stdcall GetWindowTextLengthW(void *h)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void *h, _Out_ uint16 *buf, int max)'),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(void *h, _Out_ uint16 *buf, int max)'),
      GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(void *h, _Out_ uint32 *pid)'),
      ShowWindow: user32.func('bool __stdcall ShowWindow(void *h, int cmd)'),
      BringWindowToTop: user32.func('bool __stdcall BringWindowToTop(void *h)'),
      SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(void *h)'),
      GetForegroundWindow: user32.func('void * __stdcall GetForegroundWindow()'),
      AttachThreadInput: user32.func('bool __stdcall AttachThreadInput(uint32 attach, uint32 attachTo, bool attachFlag)'),
      keybd_event: user32.func('void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr_t extra)'),
      GetCurrentThreadId: kernel32.func('uint32 __stdcall GetCurrentThreadId()'),
    }
    loadError = null
    return api
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error)
    api = null
    return null
  }
}

/** Read a window's title (empty string when it has none). */
function windowTitle(functions, handle) {
  try {
    const length = functions.GetWindowTextLengthW(handle)
    if (length <= 0) return ''
    const buffer = new Uint16Array(length + 1)
    functions.GetWindowTextW(handle, buffer, length + 1)
    return Buffer.from(buffer.buffer, 0, (length + 1) * 2)
      .toString('utf16le')
      .replace(/\0.*$/s, '')
  } catch {
    return ''
  }
}

/** Read a window's class name (empty string on failure). */
function windowClass(functions, handle) {
  try {
    const buffer = new Uint16Array(256)
    const written = functions.GetClassNameW(handle, buffer, 256)
    if (!written) return ''
    return Buffer.from(buffer.buffer, 0, written * 2).toString('utf16le').replace(/\0.*$/s, '')
  } catch {
    return ''
  }
}

/**
 * Windows that belong to Electron's chrome but are never the app window. A
 * PID match alone is not enough: the main process also owns visible top-level
 * windows such as `OleDdeWndClass` / `DDE Server Window`, `MSCTFIME UI` and
 * `Default IME`, and raising one of those leaves the real window where it was.
 */
const NON_APP_CLASSES = new Set(['OleDdeWndClass', 'MSCTFIME UI', 'IME', 'Default IME', 'DDE Server Window'])

/** Window class of the actual Electron browser window. */
const APP_WINDOW_CLASS = /^Chrome_WidgetWin/i
/** The desktop shell's own window title. */
const APP_TITLE = /deepseek\s*harness/i

/**
 * Narrow scored window entries to the ones that can be the DSH window.
 *
 * Every Electron/Chromium app (browsers, VS Code, chat clients) uses the
 * `Chrome_WidgetWin*` class, and a browser tab may be titled "DeepSeek", so
 * class or a loose title alone must never qualify another app's window:
 * raising it on a toast click, or badging its taskbar button, is worse than
 * doing nothing. Windows owned by the parent Electron process win outright;
 * without a PID match, only Chromium-class windows titled "DeepSeek Harness"
 * qualify, then (last resort) Chromium-class windows titled "DeepSeek".
 *
 * @param {Array<{title: string, pid: number, cls: string, score: number}>} entries scored windows.
 * @param {number} ownPid parent (Electron main) process id.
 * @returns {Array<object>} candidates, highest score first.
 */
export function selectDesktopWindows(entries, ownPid) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry === 'object') : []
  const byScore = (left, right) => right.score - left.score
  if (Number.isInteger(ownPid) && ownPid > 0) {
    const owned = list.filter((entry) => entry.pid === ownPid)
    if (owned.length > 0) return owned.sort(byScore)
  }
  const chromium = list.filter((entry) => APP_WINDOW_CLASS.test(String(entry.cls || '')))
  const named = chromium.filter((entry) => APP_TITLE.test(String(entry.title || '')))
  if (named.length > 0) return named.sort(byScore)
  return chromium.filter((entry) => /deepseek/i.test(String(entry.title || ''))).sort(byScore)
}

/**
 * List candidate main windows with a score; the highest score is tried first.
 * Score: app title > browser-window class > parent-process PID; non-app window
 * classes are filtered out entirely and `selectDesktopWindows` drops windows
 * of other applications.
 *
 * @param {object} functions native function table.
 * @returns {Array<{handle: any, title: string, pid: number, cls: string, score: number}>}
 */
function listDesktopWindows(functions) {
  const ownPid = Number(process.ppid)
  const found = []
  try {
    functions.EnumWindows((handle) => {
      try {
        if (!functions.IsWindowVisible(handle)) return true
        const cls = windowClass(functions, handle)
        if (NON_APP_CLASSES.has(cls)) return true
        const title = windowTitle(functions, handle)
        if (!title) return true
        const pidBuffer = new Uint32Array(1)
        functions.GetWindowThreadProcessId(handle, pidBuffer)
        const pid = pidBuffer[0]
        const titleMatch = /deepseek/i.test(title)
        const classMatch = APP_WINDOW_CLASS.test(cls)
        if (!titleMatch && !classMatch) return true
        let score = 0
        if (titleMatch) score += 100
        if (classMatch) score += 50
        if (Number.isInteger(ownPid) && ownPid > 0 && pid === ownPid) score += 20
        found.push({ handle, title, pid, cls, score })
        return true
      } catch {
        return true
      }
    }, 0)
  } catch {
    /* enumeration failed: return whatever was captured */
  }
  return selectDesktopWindows(found, ownPid)
}

/** Window candidates, highest score first (diagnostics/tests). */
export function listDesktopWindowCandidates() {
  const functions = loadNativeApi()
  if (!functions) return []
  return listDesktopWindows(functions).map((entry) => ({ ...entry, handle: String(entry.handle) }))
}

/** Attach to the foreground thread, raise the window, then detach. */
function activateWindow(functions, handle) {
  const foreground = functions.GetForegroundWindow()
  let foregroundThread = 0
  try {
    if (foreground !== null && foreground !== undefined) {
      foregroundThread = functions.GetWindowThreadProcessId(foreground, new Uint32Array(1))
    }
  } catch {
    foregroundThread = 0
  }
  const ownThread = functions.GetCurrentThreadId()
  let attached = false
  try {
    if (foregroundThread !== 0 && foregroundThread !== ownThread) {
      attached = Boolean(functions.AttachThreadInput(foregroundThread, ownThread, true))
    }
    functions.SetForegroundWindow(handle)
    functions.BringWindowToTop(handle)
  } catch {
    /* best effort */
  } finally {
    if (attached) {
      try {
        functions.AttachThreadInput(foregroundThread, ownThread, false)
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Whether the native window-raise path can work in this process (win32 + the
 * bundled koffi binding loads). Never throws; loading is attempted once.
 *
 * @returns {boolean} true when `focusDesktopWindow()` can attempt a raise.
 */
export function nativeFocusAvailable() {
  try {
    return loadNativeApi() !== null
  } catch {
    return false
  }
}

/**
 * Best-effort: restore, raise and foreground the DSH desktop window.
 *
 * @returns {boolean} true only when the target window ended up foreground.
 *   Never throws; every failure (non-win32, missing binding, no window, denied
 *   SetForegroundWindow) returns false so callers can fall back to
 *   `window.focus()` on the page.
 */
export function focusDesktopWindow() {
  try {
    const functions = loadNativeApi()
    if (!functions) return false
    const candidates = listDesktopWindows(functions)
    if (candidates.length === 0) return false
    for (const target of candidates) {
      const handle = target.handle
      try {
        functions.ShowWindow(handle, SW_RESTORE)
        functions.BringWindowToTop(handle)
        // A harmless ALT tap: Windows grants foreground rights to processes that
        // received the last input event, which is what SetForegroundWindow needs.
        functions.keybd_event(VK_MENU, 0, 0, 0)
        functions.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
      } catch {
        /* still try the activation below */
      }
      activateWindow(functions, handle)
      if (String(functions.GetForegroundWindow()) === String(handle)) return true
      // One retry: the first activation can lose the race with a just-focused
      // foreground window (for example the page that received the click).
      activateWindow(functions, handle)
      if (String(functions.GetForegroundWindow()) === String(handle)) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Diagnostics for the RPC health/probe output (not part of the client contract).
 *
 * @returns {{available: boolean, modulePath: string|null, error: string|null, platform: string}}
 */
export function nativeFocusInfo() {
  try {
    const available = nativeFocusAvailable()
    return {
      available,
      modulePath: bindingPath,
      error: available ? null : loadError,
      platform: process.platform,
      candidates: available ? listDesktopWindowCandidates() : [],
    }
  } catch (error) {
    return {
      available: false,
      modulePath: null,
      error: error instanceof Error ? error.message : String(error),
      platform: 'unknown',
      candidates: [],
    }
  }
}
