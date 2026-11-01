/**
 * dsh-notify-toast — Windows taskbar overlay badge manager.
 *
 * The badge is a per-window taskbar overlay icon. The Host cannot call
 * Electron's BrowserWindow API from a plugin, so a tiny PowerShell/C# helper
 * calls ITaskbarList3::SetOverlayIcon on the DSH main window. The helper is
 * one-shot: Windows keeps the rendered overlay after the process exits.
 *
 * Updates are debounced and serialized so a late completion cannot overwrite
 * a newer focus-clear.
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listDesktopWindowCandidates } from './native-focus.js'

const UPDATE_DEBOUNCE_MS = 120
const HELPER_TIMEOUT_MS = 12000
const MAX_BADGE_COUNT = 99

/**
 * @param {object} [options]
 * @param {string} [options.scriptPath] absolute path to taskbar-badge.ps1
 * @param {string} [options.powershellPath] Windows PowerShell executable
 * @param {Function} [options.spawnProcess] child_process.spawn-compatible
 * @param {(message: string, error?: unknown) => void} [options.logWarn]
 * @returns {{setCount: (count: number) => void, warm: () => void, dispose: () => void, pendingCount: () => number}}
 */
export function createTaskbarBadgeManager(options = {}) {
  const {
    scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'taskbar-badge.ps1'),
    powershellPath = join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    spawnProcess = spawn,
    logWarn = () => {},
  } = options

  let disposed = false
  let desired = 0
  let applied = -1
  let timer = null
  let running = false
  let rerun = false
  let lastHandle = null
  let child = null
  let warmChild = null

  function normalize(count) {
    const value = Number(count)
    if (!Number.isFinite(value)) return 0
    return Math.max(0, Math.min(MAX_BADGE_COUNT, Math.trunc(value)))
  }

  function findWindowHandle() {
    try {
      const candidates = listDesktopWindowCandidates()
      if (!Array.isArray(candidates) || candidates.length === 0) return null
      const handle = candidates[0] && candidates[0].handle
      if (handle === undefined || handle === null || String(handle) === '0') return null
      lastHandle = String(handle)
      return lastHandle
    } catch (error) {
      logWarn('cannot enumerate the DSH taskbar window', error)
      return lastHandle
    }
  }

  function clearTimer() {
    if (timer === null) return
    try {
      clearTimeout(timer)
    } catch {
      /* already gone */
    }
    timer = null
  }

  function runHelper(hwnd, count, warmOnly = false) {
    return new Promise((resolve) => {
      let settled = false
      let proc = null
      let timerForChild = null
      const finish = (ok, error) => {
        if (settled) return
        settled = true
        try {
          if (timerForChild) clearTimeout(timerForChild)
        } catch {
          /* ignore */
        }
        if (child === proc) child = null
        if (warmChild === proc) warmChild = null
        if (!ok && error && !disposed) logWarn('taskbar badge helper failed', error)
        resolve(ok)
      }
      try {
        const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]
        if (warmOnly) {
          args.push('-WarmOnly')
        } else {
          args.push('-Hwnd', String(hwnd), '-Count', String(count))
        }
        proc = spawnProcess(powershellPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        finish(false, error)
        return
      }
      if (warmOnly) warmChild = proc
      else child = proc
      let stderr = ''
      try {
        proc.stdout?.on?.('data', () => {})
        proc.stderr?.on?.('data', (chunk) => {
          stderr += String(chunk || '')
          if (stderr.length > 4000) stderr = stderr.slice(-4000)
        })
        proc.on?.('error', (error) => finish(false, error))
        proc.on?.('close', (code) => finish(code === 0, code === 0 ? null : stderr || ('exit ' + code)))
      } catch (error) {
        finish(false, error)
        return
      }
      timerForChild = setTimeout(() => {
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
        finish(false, new Error('taskbar badge helper timed out'))
      }, HELPER_TIMEOUT_MS)
    })
  }

  async function applyLatest() {
    if (disposed || running) {
      rerun = true
      return
    }
    if (!process || process.platform !== 'win32') return
    const target = findWindowHandle()
    if (!target) return
    running = true
    try {
      do {
        rerun = false
        const count = desired
        if (count === applied) break
        const hwnd = findWindowHandle() || target
        const ok = await runHelper(hwnd, count)
        if (ok) applied = count
        if (disposed) break
      } while (rerun || desired !== applied)
    } finally {
      running = false
      if (!disposed && (rerun || desired !== applied)) {
        // A newer request arrived while the helper was running.
        scheduleApply()
      }
    }
  }

  function scheduleApply() {
    clearTimer()
    if (disposed) return
    timer = setTimeout(() => {
      timer = null
      void applyLatest()
    }, UPDATE_DEBOUNCE_MS)
  }

  function setCount(count) {
    if (disposed) return
    desired = normalize(count)
    scheduleApply()
  }

  function warm() {
    if (disposed || process.platform !== 'win32') return
    if (warmChild) return
    void runHelper(0, 0, true)
  }

  function dispose() {
    if (disposed) return
    const hadBadge = applied > 0 || desired > 0
    desired = 0
    clearTimer()
    disposed = true
    try {
      if (child) child.kill()
    } catch {
      /* ignore */
    }
    try {
      if (warmChild) warmChild.kill()
    } catch {
      /* ignore */
    }
    if (hadBadge && lastHandle) {
      // Best-effort final clear. Do not wait: the Host may be tearing down.
      void runHelper(lastHandle, 0)
    }
  }

  return {
    setCount,
    warm,
    dispose,
    pendingCount: () => desired,
  }
}
