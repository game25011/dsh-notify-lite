#!/usr/bin/env node
/**
 * dsh-notify-lite — Host RPC probe (developer tool, not shipped behaviour).
 *
 * The plugin does NOT open its own HTTP port: it registers the generic
 * Connection RPC channel `/dsh-notify-lite` on the official Host web server.
 * That channel sits behind Connection's Host/Origin fence AND the signed
 * browser cookie (`Connection.admit`), so an ordinary command-line request
 * without the page's cookie is expected to be rejected with 401/403.
 *
 * Therefore this script offers:
 *
 *   --help        what you are reading (default when no argument is given)
 *   --self-check  pure-function checks of lib/config.js and lib/text.js
 *                 (safe everywhere; this is the sandbox-friendly probe)
 *   --url <base>  really POST a `health` RPC envelope to a loopback Host and
 *                 report the HTTP verdict. Without --cookie the expected
 *                 answer is 401/403 ("the auth fence is active"); that is
 *                 probe evidence, not a failed run.
 *   --cookie <v>  optional, with --url: explicitly paste the page's cookie
 *                 (DevTools → Application → Cookies → dsh-auth-…). Never read
 *                 from disk by this script.
 *
 * The GUI page's own probe path is the settings section's "运行状态" block,
 * which shows settingsAvailable/nativeFocus/clients/stats from this Host.
 *
 * Usage examples:
 *   node scripts/probe-rpc.mjs --help
 *   node scripts/probe-rpc.mjs --self-check
 *   node scripts/probe-rpc.mjs --url http://127.0.0.1:54677
 *   node scripts/probe-rpc.mjs --url http://127.0.0.1:54677 --cookie "dsh-auth-…=…"
 */

import { randomUUID } from 'node:crypto'

import {
  DEFAULTS,
  RPC_CHANNEL,
  VERSION,
  validatePatch,
} from '../lib/config.js'
import { cleanMarkdownText, truncateCodepoints } from '../lib/text.js'

const HELP = `dsh-notify-lite RPC probe (v${VERSION})

The Host registers the official Connection RPC channel ${RPC_CHANNEL}.
Endpoints (POST JSON, envelope {type:'client-request', rpcId, method, payload}):
  ${RPC_CHANNEL}/config   payload {}                                  -> config + status
  ${RPC_CHANNEL}/save     payload {patch}                             -> config + status
  ${RPC_CHANNEL}/poll     payload {after, wait}  (wait 1000..25000)   -> events + next
  ${RPC_CHANNEL}/health   payload {}                                  -> version/ns/status
  ${RPC_CHANNEL}/test     payload {}                                  -> queue a test event
  ${RPC_CHANNEL}/focus    payload {sessionId?}                        -> {ok,native}

Why a plain CLI request usually fails: the route is admitted only for the
signed browser cookie minted by the official Connection layer. Without that
cookie the Host answers 401/403 *before* the plugin handler runs — the expected
result, not a plugin bug. Browser page DevTools (same origin) or the settings
section are the supported ways to call the channel authenticated.

Commands:
  --help                 show this help (default)
  --self-check           run pure config/text checks; exit 1 on a failed check
  --url <base>           POST a health envelope to <base>${RPC_CHANNEL}/health
                         (loopback only; default $DSH_WEB_URL or
                         http://127.0.0.1:54677)
  --cookie <value>       optional Cookie header value for --url

Exit codes: 0 help/self-check ok or auth fence observed; 1 self-check failure;
2 network/transport failure; 3 unexpected HTTP response.`

const DEFAULT_URL = process.env.DSH_WEB_URL || 'http://127.0.0.1:54677'

function parseArgs(argv) {
  const options = { command: 'help', url: DEFAULT_URL, cookie: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') options.command = 'help'
    else if (argument === '--self-check') options.command = 'self-check'
    else if (argument === '--url') {
      options.command = 'probe'
      index += 1
      if (index >= argv.length) throw new Error('--url requires a value')
      options.url = argv[index]
    } else if (argument === '--cookie') {
      index += 1
      if (index >= argv.length) throw new Error('--cookie requires a value')
      options.cookie = argv[index]
    } else if (argument.startsWith('-')) {
      throw new Error(`unknown option ${argument}`)
    } else {
      throw new Error(`unexpected argument ${argument}`)
    }
  }
  return options
}

/** @returns {string|null} an error message, or null when the base URL is loopback HTTP(S). */
function assertLoopbackUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return `not a URL: ${raw}`
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `unsupported protocol: ${url.protocol}`
  const hostname = url.hostname
  const loopback =
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  if (!loopback) return `refusing to probe non-loopback host ${hostname} (the DSH Host is local)`
  return null
}

/** Pure checks: the values the plugin validates/serves. */
function runSelfCheck() {
  const checks = []
  const check = (name, fn) => {
    try {
      fn()
      checks.push({ name, ok: true })
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }

  check('DEFAULTS.bodyLength is 40', () => assert(DEFAULTS.bodyLength === 40, 'unexpected default'))
  check('DEFAULTS.mergeIntervalMs is 2500', () => assert(DEFAULTS.mergeIntervalMs === 2500, 'unexpected default'))
  check('validatePatch accepts a valid patch', () => {
    const result = validatePatch({ bodyLength: 30, sound: 'bell' })
    assert(result.ok === true, 'valid patch rejected')
    assert(result.patch.bodyLength === 30, 'patch value lost')
  })
  check('validatePatch rejects an out-of-range value', () => {
    assert(validatePatch({ bodyLength: 99 }).ok === false, 'range not enforced')
  })
  check('validatePatch rejects an unknown field', () => {
    assert(validatePatch({ nope: 1 }).ok === false, 'whitelist not enforced')
  })
  check('cleanMarkdownText strips markup and code fences', () => {
    const cleaned = cleanMarkdownText('**Hi** `there`\n\n```js\nignored()\n```')
    assert(cleaned === 'Hi there', `unexpected cleanup: ${JSON.stringify(cleaned)}`)
  })
  check('truncateCodepoints respects the code-point budget', () => {
    const truncated = truncateCodepoints('abcdef', 4)
    assert(truncated === 'abc…', `unexpected truncation: ${JSON.stringify(truncated)}`)
    assert(Array.from(truncated).length === 4, 'budget exceeded')
  })

  for (const result of checks) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : ` — ${result.detail}`}`)
  }
  const failed = checks.filter((result) => !result.ok).length
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
  return failed === 0
}

/**
 * Send one real RPC envelope and report the HTTP verdict.
 * Never invents a success: only a parsed JSON body (with an explicit cookie)
 * counts as an authenticated response.
 */
async function runProbe(options) {
  const urlError = assertLoopbackUrl(options.url)
  if (urlError) {
    console.error(`[probe] ${urlError}`)
    return 2
  }
  const base = options.url.replace(/\/+$/, '')
  const endpoint = `${base}${RPC_CHANNEL}/health`
  const envelope = {
    type: 'client-request',
    rpcId: randomUUID(),
    method: 'health',
    payload: {},
  }
  const headers = { 'content-type': 'application/json' }
  if (options.cookie) headers.cookie = options.cookie
  console.log(`[probe] POST ${endpoint}`)
  if (!options.cookie) {
    console.log('[probe] no --cookie supplied: the signed browser-cookie fence should answer 401/403.')
  }
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(5000),
    })
  } catch (error) {
    console.error(`[probe] transport failure: ${error instanceof Error ? error.message : String(error)}`)
    console.error('[probe] is the DSH host running and is its URL correct?')
    return 2
  }
  console.log(`[probe] HTTP ${response.status} ${response.statusText}`)
  const text = await response.text()
  if (response.status === 401 || response.status === 403) {
    console.log('[probe] auth fence replied as expected for an unauthenticated caller.')
    console.log('[probe] this proves the official Connection route is mounted; to inspect the value,')
    console.log('[probe] retry with --cookie or use the GUI settings section / page DevTools.')
    return 0
  }
  if (response.status === 404 || response.status === 405) {
    console.error(`[probe] the RPC channel is not mounted on this Host (HTTP ${response.status}).`)
    console.error('[probe] install/enable dsh-notify-lite in the desktop profile, restart DSH, then retry.')
    return 3
  }
  if (!response.ok) {
    console.error(`[probe] unexpected HTTP status: ${text.slice(0, 400)}`)
    return 3
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    console.error(`[probe] non-JSON response: ${text.slice(0, 400)}`)
    return 3
  }
  const result = parsed && parsed.type === 'server-response' ? parsed.result : undefined
  if (!result || result.ok !== true) {
    console.error(`[probe] unexpected RPC envelope: ${text.slice(0, 400)}`)
    return 3
  }
  console.log('[probe] authenticated RPC result:')
  console.log(JSON.stringify(result.value, null, 2))
  return 0
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[probe] ${error instanceof Error ? error.message : String(error)}`)
    console.error('')
    console.log(HELP)
    return 2
  }
  if (options.command === 'help') {
    console.log(HELP)
    return 0
  }
  if (options.command === 'self-check') return runSelfCheck() ? 0 : 1
  return runProbe(options)
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error(`[probe] unexpected failure: ${error instanceof Error ? error.stack : String(error)}`)
    process.exitCode = 1
  },
)
