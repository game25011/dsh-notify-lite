# Contributing to dsh-notify-lite

Thanks for your interest in improving `dsh-notify-lite`. This is a small, dependency-free DSH plugin, and focused contributions are welcome.

## Before you start

- Search existing issues and pull requests first; someone may already be working on the same thing.
- Use the bug report form for reproducible problems and the feature request form for proposals.
- For behavior changes or new features, open a feature request and wait for agreement before writing substantial code. Small fixes, tests, and documentation corrections can go straight to a pull request.
- Never report security vulnerabilities in a public issue. See [SECURITY.md](SECURITY.md) for the private reporting channel.
- All participation is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Development environment

- **Node.js >= 20** for the plugin runtime (declared in `engines.node`). The test suite and CI are verified on Node.js 22 and 24; use Node.js 22+ for development, since the `npm test` glob form has only been exercised there.
- **Windows 10/11** for end-to-end and native-toast testing. Unit and smoke tests run on any operating system.
- **DSH Desktop 0.2.1-rc.2** for manual verification of the Host/Client integration.
- **No `npm install` required**: the package has no runtime or development dependencies, and the tests use Node built-ins (`node:test`, `node:vm`, `node:assert`). Do not add dependencies without prior discussion.

## Getting started

1. Fork the repository and create a topic branch from `main`.
2. Make the change and add or update tests.
3. Run the full test set locally (see below).
4. Open a pull request using the pull request template.

## Tests

Run these from the repository root:

| Command | What it covers |
|---|---|
| `npm test` | Unit tests for text cleanup/truncation, configuration, completion merging, RPC routing, automatic titles, goal aggregation, native lifecycle and the all-done feature (94 tests). |
| `npm run smoke` | Client smoke test that simulates `window.__ModuleLoader__`, `Notification`, and `AudioContext` to exercise loading, focus, toasts, sound, settings save, and cleanup (25 tests). |
| `node scripts/probe-rpc.mjs --self-check` | Pure-function checks for defaults, config validation, and text cleanup (7 checks). |

Optional integration checks:

| Command | What it covers |
|---|---|
| `npm run probe` | Host integration probe using a fake Cordis context and the real profile working directory. |
| `node scripts/host-probe.mjs <profileDir>` | Host integration probe against a real profile directory. |
| `npm pack` | Builds the delivery `.tgz`; useful to verify the published file set. |

All commands exit non-zero on failure. A pull request must pass `npm test`, `npm run smoke`, and the RPC self-check at minimum.

## Code structure

- `lib/index.js` — Host half: event listeners, browser route, settings, completion merging, cleanup.
- `lib/text.js` — pure Markdown cleanup and code-point truncation helpers (unit-tested).
- `lib/config.js` — defaults, settings patch validation, merge logic, and the volatile Config schema.
- `lib/native-focus.js` — koffi `user32` window-focus helper used by click-to-return.
- `lib/client.js` — Web client half: focus detection, native toast, Web Audio sound, settings page, long polling, locale dictionaries.
- `locale/zh.json`, `locale/en.json` — plugin marketplace display metadata.
- `test/*.test.mjs` — `node:test` unit tests.
- `scripts/client-smoke.mjs`, `scripts/probe-rpc.mjs`, `scripts/host-probe.mjs` — smoke tests and integration probes.
- `docs/` — implementation plan, Host/Client contract, acceptance report, and release manual.

## Pull request requirements

- Keep the change focused; avoid unrelated refactors in the same pull request.
- Add or update tests for behavior changes. Bug fixes should include a regression test where practical.
- Run the full test set and paste the commands you ran in the pull request template.
- Update [README.md](README.md) and [README.en.md](README.en.md) when user-facing behavior, configuration, or compatibility changes.
- Add a user-visible entry to [CHANGELOG.md](CHANGELOG.md) under the unreleased section.
- Do not add runtime dependencies. Keep the plugin self-contained and free of network calls, telemetry, and model calls.
- Keep both locale files in sync (`locale/zh.json` and `locale/en.json`) **and** the embedded Chinese/English dictionaries in `lib/client.js`. Every new user-facing string must exist in both languages.
- Keep Windows-specific code defensive: missing permissions, unavailable native modules, and unsupported environments must degrade without crashing. Keep the RPC route fail-closed when the official same-origin fence is unavailable.
- Use clear, imperative commit messages and reference the related issue when applicable.

## What not to commit

- `node_modules/`, `*.tgz`, `coverage/`, `dist/`, build output, and other generated artifacts.
- Logs, editor configuration, or OS-specific clutter that is not part of the project.
- Secrets of any kind: API keys, access tokens, cookies, credentials, or private session data.
- Personal information: email addresses, real names, local absolute paths, or machine-specific configuration.

The repository `.gitignore` covers the common cases; do not force-add ignored files.

## Continuous integration

The GitHub Actions workflow in `.github/workflows/ci.yml` runs on pushes to `main` and on pull requests. It checks source syntax, runs `npm test`, `npm run smoke`, and `npm pack --dry-run` on Windows and Ubuntu with Node.js 22 and 24. It does not install dependencies, make network calls, or publish anything. Pull requests must be green before merge.

## License

By contributing, you agree that your contribution is licensed under the MIT License, the same license as this project (see [LICENSE](LICENSE)). No separate contributor license agreement is required.
