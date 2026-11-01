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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listDesktopWindowCandidates } from './native-focus.js'

const UPDATE_DEBOUNCE_MS = 120
const HELPER_TIMEOUT_MS = 12000
const COMPILE_TIMEOUT_MS = 20000
const MAX_BADGE_COUNT = 99
const CACHE_KEEP = 8

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
    sourcePath = join(dirname(fileURLToPath(import.meta.url)), 'taskbar-badge-helper.cs'),
    mainSourcePath = join(dirname(fileURLToPath(import.meta.url)), 'taskbar-badge-main.cs'),
    powershellPath = join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    cscPath = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    cacheRoot = join(process.env.LOCALAPPDATA || '', 'dsh-notify-toast', 'native-cache'),
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
  let executablePath = null
  let executablePromise = null

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

  function pruneCache(keepPath) {
    try {
      const names = readdirSync(cacheRoot).filter((name) => /^[a-f0-9]+\.badge\.(exe|dll)$/i.test(name))
      if (names.length <= CACHE_KEEP) return
      const entries = names.map((name) => {
        const path = join(cacheRoot, name)
        let mtime = 0
        try { mtime = statSync(path).mtimeMs } catch { /* ignore */ }
        return { path, mtime }
      }).sort((left, right) => right.mtime - left.mtime)
      for (const entry of entries) {
        if (entry.path === keepPath) continue
        try { rmSync(entry.path, { force: true }) } catch { /* ignore */ }
        if (entries.filter((candidate) => existsSync(candidate.path)).length <= CACHE_KEEP) break
      }
    } catch {
      /* cache pruning is best-effort */
    }
  }

  /**
   * Compile the tiny C# badge writer once into a cached standalone EXE. This
   * removes Windows PowerShell (~50 MB transient) from the hot path. If the
   * compiler or EXE is unavailable, runHelper() remains the PowerShell
   * fallback and the feature still works.
   */
  function ensureExecutable() {
    if (executablePromise) return executablePromise
    executablePromise = (async () => {
      try {
        if (!existsSync(sourcePath) || !existsSync(mainSourcePath) || !existsSync(cscPath)) return null
        const hash = createHash('sha256')
          .update(readFileSync(sourcePath))
          .update(readFileSync(mainSourcePath))
          .digest('hex')
          .slice(0, 32)
        const exe = join(cacheRoot, hash + '.badge.exe')
        if (existsSync(exe)) {
          executablePath = exe
          return exe
        }
        mkdirSync(cacheRoot, { recursive: true })
        const framework = dirname(cscPath)
        const temp = exe + '.tmp-' + process.pid + '-' + Date.now()
        const refs = ['System.dll', 'System.Drawing.dll', 'System.Runtime.dll']
          .map((name) => join(framework, name))
        const result = await runProcess(cscPath, [
          '/nologo', '/target:exe', '/out:' + temp,
          ...refs.map((ref) => '/r:' + ref),
          sourcePath, mainSourcePath,
        ], COMPILE_TIMEOUT_MS, true)
        if (!result.ok || !existsSync(temp)) {
          try { rmSync(temp, { force: true }) } catch { /* ignore */ }
          logWarn('taskbar badge exe compilation failed', result.error)
          return null
        }
        try {
          renameSync(temp, exe)
        } catch (error) {
          try { rmSync(temp, { force: true }) } catch { /* ignore */ }
          if (!existsSync(exe)) {
            logWarn('taskbar badge exe rename failed', error)
            return null
          }
        }
        pruneCache(exe)
        executablePath = exe
        return exe
      } catch (error) {
        logWarn('taskbar badge exe setup failed', error)
        return null
      }
    })()
    return executablePromise
  }

  function runProcess(file, args, timeoutMs, collectStderr) {
    return new Promise((resolve) => {
      let settled = false
      let proc = null
      let deadline = null
      let stderr = ''
      const finish = (ok, error) => {
        if (settled) return
        settled = true
        if (deadline) {
          try { clearTimeout(deadline) } catch { /* ignore */ }
        }
        resolve({ ok, error: error || '' })
      }
      try {
        proc = spawnProcess(file, args, { windowsHide: true, stdio: ['ignore', 'ignore', collectStderr ? 'pipe' : 'ignore'] })
      } catch (error) {
        finish(false, error)
        return
      }
      try {
        if (collectStderr) {
          proc.stderr?.on?.('data', (chunk) => {
            stderr += String(chunk || '')
            if (stderr.length > 4000) stderr = stderr.slice(-4000)
          })
        }
        proc.on?.('error', (error) => finish(false, error))
        proc.on?.('close', (code) => finish(code === 0, code === 0 ? '' : (stderr || ('exit ' + code))))
      } catch (error) {
        finish(false, error)
        return
      }
      deadline = setTimeout(() => {
        try { proc.kill() } catch { /* ignore */ }
        finish(false, new Error('taskbar badge process timed out'))
      }, timeoutMs)
    })
  }

  async function runBadge(hwnd, count) {
    const exe = await ensureExecutable()
    if (exe) {
      const result = await runProcess(exe, ['-Hwnd', String(hwnd), '-Count', String(count)], HELPER_TIMEOUT_MS, true)
      if (result.ok) return true
      logWarn('standalone taskbar badge helper failed; falling back to PowerShell', result.error)
    }
    return runHelper(hwnd, count)
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
        const ok = await runBadge(hwnd, count)
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
    void ensureExecutable().then((exe) => {
      if (!exe && !warmChild) void runHelper(0, 0, true)
    })
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
