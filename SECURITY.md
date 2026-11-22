# Security Policy

## Supported versions

This project is currently in the `0.3.x` series. Security fixes are provided for the latest `0.3.x` release.

| Version | Supported |
|---|---|
| `0.3.x` | Yes |
| `< 0.3.0` | No |

## Reporting a vulnerability

**Please do not report security vulnerabilities in public issues, pull requests, or discussions.**

Use GitHub Security Advisories to report privately:

```text
https://github.com/game25011/dsh-notify-lite/security/advisories/new
```

If Security Advisories are not available, contact the maintainers through a private channel listed on the repository profile. Do not include exploit details in a public issue.

Please include as much of the following as you can:

- the affected plugin version (or commit) and how it was installed;
- the DSH version, Windows version, and runtime form (Desktop or browser Web profile);
- a description of the issue and its potential impact;
- reproduction steps or a minimal proof of concept;
- relevant logs or diagnostics with secrets, tokens, cookies, and personal paths removed.

## Scope

Security-relevant areas of this plugin include:

- **RPC same-origin fence and fail-closed behavior.** The browser route under `/dsh-notify-lite` reuses the official `connection.requestRejection` Host/Origin and signed-cookie checks. If that fence is missing or rejects a request, the route must fail closed (403) rather than serve data. Bypassing the fence, or a regression that serves requests without it, is in scope.
- **Native window focus through koffi/user32.** The Host loads the koffi native binding bundled with DSH to call `user32` functions (`ShowWindow`, `SetForegroundWindow`, `AttachThreadInput`, and related calls) only to raise the DSH window when a toast is clicked. Unexpected code execution, unsafe native-module path resolution, or calls that could affect windows other than the intended DSH window are in scope.
- **Native toast helper (PowerShell/C#/WinRT) and loopback activation.** The Host spawns a helper without a shell, passes payload via stdin, uses a random per-Host loopback token, and keeps a source-hash compile cache under the local app-data directory; any command injection, arbitrary callback URL, token leakage, unauthorized notification manipulation, or cross-notification navigation is in scope.
- **No external network access and no telemetry.** The plugin is designed to make no outbound internet requests, collect no telemetry, and call no models. The only network path is a loopback activation callback (`127.0.0.1`) used to return from a native toast; any external request, data exfiltration, or hidden collection is in scope.
- **Notification content from local session logs.** Toast bodies are derived from local session logs only (question text, tool name/purpose, and the last assistant reply paragraph). Access to session data beyond that purpose, or sending it anywhere, is in scope.
- **Settings and RPC input handling.** Bypassing the `save` endpoint's field whitelist, type checks, or range limits; injecting content into the settings UI; or leaving listeners, timers, or buffers behind after unload are in scope.

Out of scope: issues that require a compromised operating system or a tampered DSH/Electron installation, Windows notification policy or Focus Assist behavior, and vulnerabilities in DSH itself (report those to the DSH project through its own security process).

## Response

This is a volunteer project. We aim to acknowledge security reports on a best-effort basis, typically within a few days, and will keep you informed of the investigation and fix progress. We may ask for clarification or a minimal reproduction. Please allow reasonable time for a fix before public disclosure.

## Coordinated disclosure

We will coordinate a disclosure timeline with you. When a fix is released, we will publish an advisory and credit the reporter in the release notes unless you prefer to remain anonymous. Please do not publish details of an unfixed vulnerability before we have agreed on a disclosure date.

## Do not post sensitive information publicly

Do not paste access tokens, cookies, API keys, credentials, personal paths, session contents, or other sensitive data into public issues, pull requests, or discussions. If a report requires such data, use the private advisory instead and redact anything that is not strictly necessary.
