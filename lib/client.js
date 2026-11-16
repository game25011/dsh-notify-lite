/**
 * dsh-notify-toast — Client half (browser bundle).
 *
 * Wraps a single self-contained CJS factory for the DSH module loader. Only
 * `require('react')` is resolved from the host module table; everything else
 * (locale dictionaries, native toast handling, Web Audio synthesis, settings
 * page, multi-window leader election and the Connection RPC long-poll) lives
 * inside this file.
 *
 * Contract: docs/INTERFACE.md §3. The Host half (lib/index.js) serves the
 * `/dsh-notify-toast` Connection RPC channel; this side only ever calls
 * `ctx.connection.rpc.call('/dsh-notify-toast', endpoint, payload, signal)`
 * (relative URL through the page's own origin/proxy — never absolute URLs,
 * ports, tokens or cookies).
 *
 * The bundle is defensive on purpose: a throw inside a client plugin's factory
 * sits on the host's boot path, so every host-facing registration is contained
 * and every event/notification/audio failure degrades silently.
 */
;(function loadClientBundle() {
  const loader = typeof window !== 'undefined' && window ? window.__ModuleLoader__ : undefined
  if (!loader || typeof loader.load !== 'function') return
  try {
    loader.load({
      id: 'dsh-notify-toast',
      factory(require) {
        const React = require('react')
        const h = React.createElement
        const useState = React.useState
        const useEffect = React.useEffect

        // ------------------------------------------------------------------
        // Constants (kept in sync with docs/INTERFACE.md §0/§2.4)
        // ------------------------------------------------------------------

        const PKG_ID = 'dsh-notify-toast'
        /** Locale namespace / settings namespace / client module id. */
        const NS = 'dsh-notify-toast'
        const RPC_CHANNEL = '/dsh-notify-toast'
        const VERSION = '0.5.2'

        /** Multi-window leadership lease (localStorage, cross-tab visible). */
        const LEADER_STORAGE_KEY = 'dsh-notify-toast:leader'
        const LEADER_HEARTBEAT_MS = 5000
        const LEADER_STALE_MS = 15000

        /** Long-poll hold time; the Host clamps payload.wait to 1000–25000. */
        const POLL_WAIT_MS = 25000
        const BACKOFF_MIN_MS = 1000
        const BACKOFF_MAX_MS = 15000
        /**
         * Banner auto-hide is owned by Windows (~5 s) and the clickable entry
         * lives on in the Action Center. Closing the toast programmatically
         * would remove that entry and lose later clicks, so never auto-close.
         */
        const TOAST_AUTO_CLOSE_MS = 0
        const SAVE_DEBOUNCE_MS = 250
        /** Queued events older than this are treated as stale on page load. */
        const EVENT_MAX_AGE_MS = 120000

        const DEFAULT_CONFIG = Object.freeze({
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

        const BOOLEAN_CONFIG_KEYS = Object.freeze([
          'enabled',
          'questionEnabled',
          'approvalEnabled',
          'completionEnabled',
          'taskbarBadgeEnabled',
          'goalSummaryEnabled',
          'titleOnly',
          'allDoneTitleEnabled',
        ])
        const SOUND_IDS = Object.freeze(['ding', 'chime', 'bell', 'soft', 'bubble', 'none'])
        const NOTIFICATION_MODES = Object.freeze(['native', 'native-progress'])
        const NATIVE_DURATION_MIN_MS = 3000
        const NATIVE_DURATION_MAX_MS = 30000
        const ADVANCED_CONFIG_KEYS = Object.freeze(['taskbarBadgeEnabled', 'notificationMode', 'nativeDurationMs'])
        const SOUND_LABEL_KEYS = Object.freeze({
          ding: 'soundDing',
          chime: 'soundChime',
          bell: 'soundBell',
          soft: 'soundSoft',
          bubble: 'soundBubble',
          none: 'soundNone',
        })

        /**
         * Web Audio presets. Every note schedules sine partials with a short
         * linear attack and an exponential tail; `ding` is the default because
         * it is short, warm and clearly audible on laptop speakers.
         */
        const SOUND_PRESETS = Object.freeze({
          // 叮咚 — descending B5 → F#5 bell dyad, warm partials, ~0.9 s.
          ding: {
            notes: [
              { frequency: 987.77, at: 0, duration: 0.7, peak: 0.62, partials: [[1, 1], [2, 0.28], [3, 0.08]] },
              { frequency: 739.99, at: 0.14, duration: 0.85, peak: 0.52, partials: [[1, 1], [2, 0.32], [3, 0.1]] },
            ],
          },
          // 风铃 — E6 + B6, bell-like upper partials, ~1 s, soft attack/decay.
          chime: {
            notes: [
              { frequency: 1318.51, at: 0, duration: 0.95, peak: 0.55, partials: [[1, 1], [2, 0.34], [2.76, 0.14], [4, 0.06]] },
              { frequency: 1975.53, at: 0.07, duration: 0.9, peak: 0.4, partials: [[1, 1], [2, 0.28], [3, 0.1]] },
            ],
          },
          // 清铃 — C6 + G6 with octave partials.
          bell: {
            notes: [
              { frequency: 1046.5, at: 0, duration: 1.05, peak: 0.5, partials: [[1, 1], [2, 0.42], [3, 0.16], [4, 0.07]] },
              { frequency: 1567.98, at: 0.035, duration: 0.98, peak: 0.36, partials: [[1, 1], [2, 0.3], [3, 0.12]] },
            ],
          },
          // 轻点 — single short 523 Hz blip, ~0.25 s.
          soft: {
            notes: [
              { frequency: 523.25, at: 0, duration: 0.24, peak: 0.6, partials: [[1, 1], [2, 0.12]] },
            ],
          },
          // 弹一下 — synthesized fallback until the CC0 bubble OGG decodes.
          bubble: {
            notes: [
              { frequency: 740, at: 0, duration: 0.12, peak: 0.58, partials: [[1, 1], [2, 0.18]] },
              { frequency: 1046.5, at: 0.045, duration: 0.16, peak: 0.32, partials: [[1, 1], [2, 0.2]] },
            ],
          },
        })

        // CC0 audio asset: uisfx 0.4.0 sounds/rubber/notification.ogg.
        // The source .ogg lives in assets/sounds/ for provenance; the browser
        // bundle embeds it so playback needs no asset route or network request.
        const SOUND_ASSETS = Object.freeze({
          bubble: 'T2dnUwACAAAAAAAAAAAAAAAAAAAAAAIotXIBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAAAAAAABAAAASZW+VAEuT3B1c1RhZ3MGAAAAZmZtcGVnAQAAABQAAABlbmNvZGVyPUxhdmMgbGlib3B1c09nZ1MABIldAAAAAAAAAAAAAAIAAAD/TX+uGcZylY2ghZqQ6J+TlaCmpJ6hoZaAbZIDAwP4tLKUmvYOAVw487W/WTpOx6n6F+lfMvmfuDUFoextKv4B5yTWZq5byB0CvEWNbS6iPDlz8nF5OZwJwhkm5Mjpsupr09AXo6B/Ati1wqGy8rYzGVOceNQzyZqZcU6cAGbuSG2p3PZ4oGNM07fw7bb8EfG+ZxgfYD4F/PmwURGaPzIPYtx20ERfFUaIIBqn2mGgH5XiI6RBpmNcHLtJ5jJGkGIXKLVoEtCxXW9q+nqJSHMlBljESYJxTPoMBJTBvTEScWcHfWv4r+o61ezK7MMwZcX49rXi2rgeDdHcxM2IJksPLy0Xt48b6n0u1fNHx0sAEIlEe6UEmCThkjbscSJKO6EVzGuIQaKVAMs84lkgX8JTP2r6lNwiJzZxuwgydG5419PwpjQTb53bx6vbGhK/Axs7sV2PR234rWjr/KkH9NyqxLJQ0PgjC8wTr5nJpuL6Y/Duh4NjZzqx//WODBkzE/OVOD1Whuhm/kKmyxoBg9RYKvKw9oGpGVVIHSk3tdpOc6tzySs2o95I7zHL8TW18i4zfSQLMK+blS3L6kqOpJD33yIrJoPUrBuw0Zm3lkuoH009rMFJLys124wvWwBtamNpNpFmIuitO9IfbviwTbKVw1lqWYXNCuHnCiTfsp78BL5/KwFCug4Ub24Le9YlN6kcuTdFaLBUZUafYcYCdkQLeAog9fNwm7jlBjswuqgNZEG08tZEA8NU1fu0yPABn6gPq4Aog1zM51jAExAmPHt4FdemmBxMiCWjUw/wW9wHuxGn29dU8d+iYAMGegLn/puQWH5HzqcbbfixoTnccOLkCYvqU9/37BIOK+NWPQz1X4qstsqaHXovqdNPVAn37YhIz3Emu5eJjGFq6Saq5LfFC7vY2xXCum5ItROdnoOEcTKSQyYW5CFtbg57G4QlfPV+wH2yl132HzeHTBNz06/P88baV2h2ntcfulzOOVUjV+jfGCIWD+952b2jw693u7oady30kL9Dk0RdCn86npm7IY/tjT96/Wz4t/K218uOVzuIdNLGXY3uud3c4rTt3gafpyj+heJtSVrSKZbea8AxMBFFgjpPp34HVMxrWq9PeQi/IGKPVpDVOjZbtO7M9edBiyfkOwLxQ+jNejcYFKRB/1EnhtismmOKk5fu3Lb0FA2knQJ2pGC1/fqWPviY7bHRZ/22km2nImoY/MNt+L1ACqbzRm5lVTFFU6dQ1Mt4OBcfWFJeR2SUT3wdSH5IjqC9GLJ7TuveVJpfqPAGHt/bS09Gkw85tyaRFxCNHlT0WPBDsWJlU1pF/XWtm07lA+WNhu00/R0QdTUoP/3UlBAz+0EjgxPe8K0H9VNFO1uCZzaig4/wf5tH/QXdGnejpdM3jIwUbpBK5vVzW/bYzcD9M4nx8+oFbfi+I1zkCSFDfjuTs/CVP9bk7qjuCg1PjMs7umM/QMFUhJeLZebn+PN5ih1Q9p2UsVQiFatPrd97GCVkQTvIoOOZGjBcmRSV617Gmg5RVLk8+wGILHZjb063AgoaitYOCYRu8AC6NVNs9SJuM+kttekm3rEofInqTWK5EPOt+ct77XCZXtNe65TST+REmIS9bfh+hFCCkgvUCYPtdJGeiDlC6wP5xPJDEI0FTAPP+xCe5hnVAbgQgsJwENsNlAhy1ImhqcEOkls7zy8Kj4TUYR1ZumiGacKCLM4LhtdXPQxzsSg/GJXQzAqb0VVau0PEC4/bu3jauNbBD1tOXsoAZ/OXh3z/mshuF5sntvWPbWpv2TivKxiTLaQfb5G1IH9Gw9LvTeF+0mIHYYjWDxZYM/HP11G5H2oKrjnBctuFW0VYlbgZe01dznQmuuqAKBvylgqcEaMM7vWorEyCtfOU/aH1+XU3nIeRU5WR4LNM3kP+tLuBCtwCjzz4vXsIg+ywe7e/oq6+ICwr0jHJtzr6g85n96nPW/UPptpcY8WMlhBoFfZirU3f536OPWuHmTBIuPLECC6r16qvccApxzMqd5GGgZ68DcSXbNTeD1PeXjY6voq5XU3JIhLttxYOZ5nfz2luyOyeCAkHl8zwjgjAxSF1F8Ciwi3U1i3E0SyaOTLqYoVIDtZM7vb4GVcaEfaXlByt7lqUyVD4vUmGB7G1Zbqi8w7k9p2zH3+Sc0icQNHeFa8Xn4padzhMC4xVmjrDY7J7ZRB+UWlmLLdFDwDAmoN9gblDWXMGL/i6iDbsCtfKavLYcwC9bWyrk8bQxCq3UvYGLXfqQ8KlObRfs827HloBJDxr+chsgpWVvSbACrIGHID4KbDebdEG+xiRyef40ykE4zmuIpNjxVH4vXr15t4YgVnONLSWQqm09qk/MmP8p08cxxH8O7N7WY+h1h0hltmYXOtHkedcawbsK/jmuPLR8B4sDjsdRYj5NTuSVr3lut1RcZgQ2TU+Hpafom9PZlvqEGcq/NpId3OCqZdDNNsD6z6jSDs3FxgJwnzQboMzCJ+bz14+sBdx1KK/QJfOcBUstgHrIASSps1F+LpXUfi+JYHa7W7FecCqm0eDxR0gbrtZAg+EvdSE2I4Y5+khSMWmF13zBNGPxigM9n5PPOWlbrU5Lckrv2yRS9UKbh4G52XcUG3JY73sJKJJs/RLYWey0pxFWr7N5N8ahIbP2D0LFtM/d9e5vPvQHHnY55r2cLCNG6aVyq9e/EEJF0m5CMU1uwFCAGVGGrD6B4kxbt+8PuoGRrWcEF6QMMNEH1D4vhmdF4dTd+IvxSOMicpMhE2+kmQmYC0J7HXZ4edmEHsParI8okGxvAoOORu1h5hTh9LCZBGNfLb0htUW74869yhbhTX1PmByzAz7HIxKS6qHOL1KyGYMbYEWu7idSMKSR+F1p1wIpcUUXHgxU4OevvlCrK8UWCV9iqp/o0kSy3UkSo/zpEbRsCsFP2XyXeaM7P7SffMFqVTekrW268Si5/87Q0NR+L4rbajykwKCTK7aFhVbxS4DH1SuJof4XFoM+pLmKefFj7lk3F3WSscMcIHFYZqwN5mL3W1pJqGNgmNlOoBMn2ThNZ/f/szNq8zMJWjWBG+N8GXBEj2vEbiSLV6v8wOYYkgr4bYZwaOieSfia5hZkZpSaNa/3OLVVcyMliNme/52C1ETP4gRLvBLOG6adVA9NVaOwNHmo7tm1G4SSf8o1QdA/1H4viUhlPrx7QAsq9u95qxKN1bi3yWAElaNP+oTGcHwghjFWEKH2DngHYCb5j7QLR9WhCH6ELWy2Gg7ktPpN+lHfr7QhTFn18RRI/zn9iEfrubNGiyOQ3E/nlQrjJB2TIvxCHcn7GKLQwauKyEFNtE4JyUQyAGI2VFdIK8em+e6w9WYXxguh2/Kf+6YpM4crjeUXp2DWXa5WksodGDpUfi+DObYmjT1fVtHdlPHJHgUTV5LhGAS+vQ2Kn4ZrIS3lkIQgrlimTYbkRWwnmm3ynvjkNs+BoVaJRUxBSlzdxKmWDCvwPVVj4O7CWRaMcDuho8s9xAGCtNKtYVpWzvCpX9wY7LELK9STj/EU/p7a0Wm4utUxTB5jDSwA35DG5ElVeKs2fRe4vHam0YDNcnDsJSOHEowNgtkpNN/r9NeGc1R+L5qHP6H1RHEAStSkgeoondCYIFMj6cEa1pWbgrfItIb2yievL0DIUXdV2qMKX6HLNOgquRAUXLm0Frg2l4i+D1XajSXk+O/Q791QZWaq0bhlEF6kERFBUBlk8ggx+7HgBQqzs43514klaHC4l1pvbQUbMty2nLCVeBrXdrYq2Vicbi6bhZX1xDzENPMPjGBNCPEtKK1nViAolCixyd6J1H4vpjx2BxcVV5uFcBiQXojtEV0P5Ru3WHloBjlIiMg8MYJOlTwsXJtZsLO2yPG0N++nTGxj58b7cq/BLvYYwgqCzCjfbzY26aJLrHM9WYR48zU5HXgl5nZrGAmjnDxEvtAVF/akL/XVvM5rKGE4jN4J6ZaMrRREBnPjF1vQcqt2iGUR1eMbl9dmPNjkrS1t+4xLJmn4VH4vrkm1kOdckdLlYYICI9UT2EJqMSzCUoeiSlKstyrq8mGqsUXeXvVRCJGKXPdHTmXX1WDDs6DV1Qhirf824CgUdOfoTEXqyMBNGyZF7zACSEy4KmLOP1u5FyljXQ3OvuZ4fwCFv1iQm9RCA/hQylLpynzF4n+rs0zn5+sDhao0fhhi5xSiQb50OsKPr+k/TczP/4tdrNXlbNXvz8/Mj8cKtmr+0GO1cIRXkOc48cqIXiy/y+dpCcQ9CifPeKdMwM6rjuvSHqxlVsyE7eT5NrwdD3ncZyISr8P5mPlphoa0DF2yV8tazdzjkospTH4fe1lhdwCq+9sN+k1i2YkxNMnqKAOhDXLMJU4nFEy73a+h42OE1hs7GIKv/wIC/CJpaD/DtEF2GlVRyMHhm7Afy3gpkXkAgAf2ObMSA/sJFCFi5U+tj6CFwR0LNdQbtiq1awZbEnivNAu74BBz93gzwl1/OAAeOevrksAQkAEdoGggB7j4wQABpoDP6uW4Z8Fjvj//vj//vj//g==',
        })

        // ------------------------------------------------------------------
        // Locale dictionaries (zh default, en fallback). Same key set in both.
        // ------------------------------------------------------------------

        const zh = {
          nav: '通知',
          pageTitle: '通知',
          sectionAlerts: '提醒内容',
          sectionDelivery: '提醒方式',
          advancedSettings: '高级设置',
          diagnostics: '诊断与状态',
          statusRunning: '运行中',
          statusOff: '已关闭',
          statusConnectionIssue: '连接异常',
          diagHostConnected: 'Host 已连接',
          diagHostDisconnected: 'Host 未连接',
          mergeOff: '不合并',

          pageIntro: 'DSH 在后台时提醒你；窗口聚焦时不打扰。',
          loading: '正在加载设置…',
          hostDegraded: 'Host 暂时未连接，设置会先保存在本页，连接恢复后自动写入。',
          enable: '启用通知',
          enableHint: '关闭后仅测试通知可用。',
          questionEnabled: '提问与方案确认',
          questionEnabledHint: '需要回答或确认方案时提醒。',
          approvalEnabled: '授权请求',
          approvalEnabledHint: '需要批准工具调用时提醒。',
          completionEnabled: '本轮完成',
          completionEnabledHint: '每轮回复结束时提醒；子代理任务不提醒。',
          taskbarBadge: '任务栏未读角标',
          taskbarBadgeHint: '按根会话计数，回到 DSH 后清除。',
          goalSummaryEnabled: '目标模式结束后汇总',
          goalSummaryEnabledHint: '目标模式期间不逐轮提醒；结束、暂停或受阻后汇总一条。',
          bodyLength: '正文长度',
          bodyLengthHint: '通知正文最多显示的字符数。',
          characters: '字符',
          titleOnly: '只显示标题',
          titleOnlyHint: '通知正文留空，适合公共场合。',
          nativeToastSetting: '同时发送 Windows 原生通知',
          sound: '提示音',
          soundDing: '叮咚',
          soundChime: '风铃',
          soundBell: '清铃',
          soundSoft: '轻点',
          soundBubble: '弹一下（开源音效）',
          soundNone: '关闭',
          previewSound: '试听',
          volume: '音量',
          volumeHint: '0–100；听不到时先点试听。',
          percent: '%',
          mergeInterval: '合并间隔',
          mergeIntervalHint: '该时间窗口内的完成提醒合并为一条。',
          milliseconds: '毫秒',
          allDoneTitleEnabled: '全部完成后改写标题',
          allDoneTitleEnabledHint: '多个会话全部结束后，把最后结束的会话标题改为下方文案。',
          allDoneTitle: '标题文案',
          allDoneTitleHint: '默认「所有任务均已完成」，最多 96 字节。',
          testButton: '发送测试通知',
          testing: '发送中…',
          testSent: '测试通知已发送。',
          testFailed: '测试通知发送失败。',
          testLocalFallback: 'Host 未响应，已在本窗口直接显示测试通知。',
          saving: '保存中…',
          saved: '已保存',
          saveFailed: '保存失败，连接恢复后会重试。',
          statusTitle: '状态',
          statusPermission: '通知权限',
          statusFocus: '窗口焦点',
          statusHost: 'Host 连接',
          statusTransport: '通信链路',
          statusNativeFocus: '窗口置前',
          statusSettings: '设置持久化',
          statusAudio: '提示音引擎',
          statusNativeToast: '系统通知',
          nativeToastCounts: '尝试 {attempts} · 创建 {created} · 显示 {shown} · 失败 {failed}',
          nativeClicksCounts: '点击 {clicks} · 置前成功 {focusOk} · 置前失败 {focusFailed}',
          nativeToastLastError: '最近通知错误',
          nativeClickLastError: '最近置前错误',
          nativeToastHint: '事件提醒走 Windows 系统通知；看不到横幅时检查系统通知与专注助手设置。',
          systemTestButton: '测试系统通知',
          systemTestTitle: 'DSH 系统通知测试',
          systemTestBody: '这条通知由插件直接创建；点击可回到 DSH。',
          systemTestUnavailable: '此环境不支持系统通知（Notification API 不可用）。',
          systemTestCreated: '已创建（通知权限：{permission}）。看不到横幅时见下方说明。',
          systemTestBlocked: '系统报告失败（通知权限：{permission}），可能被 Windows 通知设置拦截。',
          systemTestFailed: '创建失败（通知权限：{permission}）：{error}',
          version: '版本',
          valueGranted: '已允许',
          valueDefault: '待授权',
          valueDenied: '已拒绝',
          valueUnsupported: '不支持',
          valueFocused: '已聚焦（不打扰）',
          valueUnfocused: '未聚焦（会提醒）',
          valueConnected: '已连接',
          valueDisconnected: '未连接',
          valueTransportChannel: '官方 channel',
          valueTransportRoute: '同源路由',
          valueTransportNone: '未挂载',
          valueAvailable: '可用',
          valueUnavailable: '不可用',
          valueAudioReady: '已就绪',
          valueAudioSuspended: '待解锁（点一下页面）',
          valueAudioUninitialized: '未初始化',
          valueUnknown: '未知',
          runtimeTitle: '运行状态',
          statsQuestions: '提问',
          statsApprovals: '授权',
          statsCompletions: '完成',
          statsMerged: '合并',
          statsClients: '在线页面',
          statsLast: '最近',
          kindQuestion: '提问',
          kindApproval: '授权',
          kindComplete: '完成',
          kindTest: '测试',
          permissionAskHint: '尚未授予通知权限，点击页面任意处或下方按钮请求授权。',
          permissionDeniedHint: '通知权限已被拒绝，请在系统或浏览器设置中允许通知。',
          requestPermission: '请求通知权限',
          notifyQuestionTitle: 'DeepSeek 想问你一个问题',
          notifyApprovalTitle: 'DeepSeek 需要你的授权',
          notifyCompleteTitle: 'DeepSeek 搞定了一小步',
          notifyGoalPausedTitle: 'DeepSeek 推进了 {count} 步，目标暂停',
          notifyGoalBlockedTitle: 'DeepSeek 推进了 {count} 步，目标受阻',
          notifyCompleteMergedTitle: 'DeepSeek 一口气推进了 {count} 步',
          notifyCompleteManyTitle: 'DeepSeek 火力全开，连推了 {count} 步',
          notifyAllDoneTitle: '所有任务均已完成',
          notificationMode: '通知显示方式',
          notificationModeHint: '原生进度不可用时自动回退。',
          notificationModeNative: 'Windows 通知（兼容模式）',
          notificationModeNativeProgress: 'Windows 通知（带进度条）',
          nativeProgressCaption: '自动关闭',
          nativeDuration: '自动移除时间（近似）',
          nativeDurationHint: '3–30 秒；实际退场由 Windows 控制。',
          notificationDurationNotice: '进度条由插件更新；横幅实际停留时间仍受 Windows 控制',
          restartForNewSettings: '当前运行的是旧版通知 Host；重启 DSH 后可使用新增设置',
          seconds: '秒',
          notifyTestTitle: 'DSH 通知测试',
          notifyTestBody: '这是一条测试通知，点击可回到 DSH。',
          fallbackBody: '点击查看',
          fallbackApprovalBody: '需要批准工具调用',
        }

        const en = {
          nav: 'Notifications',
          pageTitle: 'Notifications',
          sectionAlerts: 'Alerts',
          sectionDelivery: 'Delivery',
          advancedSettings: 'Advanced',
          diagnostics: 'Diagnostics',
          statusRunning: 'Running',
          statusOff: 'Off',
          statusConnectionIssue: 'Connection issue',
          diagHostConnected: 'Host connected',
          diagHostDisconnected: 'Host disconnected',
          mergeOff: 'No merging',

          pageIntro: 'Get notified while DSH is in the background; nothing is shown while it is focused.',
          loading: 'Loading settings…',
          hostDegraded: 'The Host is unreachable; changes stay on this page and are saved once the connection recovers.',
          enable: 'Enable notifications',
          enableHint: 'When off, only test notifications are shown.',
          questionEnabled: 'Questions & plan confirmation',
          questionEnabledHint: 'Notify when an answer or a plan confirmation is needed.',
          approvalEnabled: 'Approval requests',
          approvalEnabledHint: 'Notify when a tool call needs approval.',
          completionEnabled: 'Turn finished',
          completionEnabledHint: 'Notify when a root-session reply ends; subagent tasks are ignored.',
          taskbarBadge: 'Taskbar unread badge',
          taskbarBadgeHint: 'Counts root sessions; clears when you return to DSH.',
          goalSummaryEnabled: 'Summarize when a goal run ends',
          goalSummaryEnabledHint: 'Skip per-turn alerts during a goal; send one summary when it ends, pauses, or is blocked.',
          bodyLength: 'Body length',
          bodyLengthHint: 'Maximum number of characters shown in the notification body.',
          characters: 'chars',
          titleOnly: 'Title only',
          titleOnlyHint: 'Leave the body empty; useful in public.',
          nativeToastSetting: 'Also send a Windows system toast',
          sound: 'Sound',
          soundDing: 'Ding-dong',
          soundChime: 'Chime',
          soundBell: 'Bell',
          soundSoft: 'Soft',
          soundBubble: 'Bubble (open-source)',
          soundNone: 'Off',
          previewSound: 'Preview',
          volume: 'Volume',
          volumeHint: '0–100; use Preview if you cannot hear it.',
          percent: '%',
          mergeInterval: 'Merge interval',
          mergeIntervalHint: 'Completion alerts inside this window are merged.',
          milliseconds: 'ms',
          allDoneTitleEnabled: 'Rename the last session when all finish',
          allDoneTitleEnabledHint: 'When every session finishes, rename the last one with the text below.',
          allDoneTitle: 'Title text',
          allDoneTitleHint: 'Defaults to “所有任务均已完成”; at most 96 bytes.',
          testButton: 'Send test notification',
          testing: 'Sending…',
          testSent: 'Test notification sent.',
          testFailed: 'Could not send the test notification.',
          testLocalFallback: 'The Host did not respond; the test notification was shown locally.',
          saving: 'Saving…',
          saved: 'Saved',
          saveFailed: 'Save failed; it will be retried when the connection recovers.',
          statusTitle: 'Status',
          statusPermission: 'Notification permission',
          statusFocus: 'Window focus',
          statusHost: 'Host connection',
          statusTransport: 'Transport',
          statusNativeFocus: 'Window activation',
          statusSettings: 'Settings persistence',
          statusAudio: 'Sound engine',
          statusNativeToast: 'System toast',
          nativeToastCounts: 'attempts {attempts} · created {created} · shown {shown} · failed {failed}',
          nativeClicksCounts: 'clicks {clicks} · focused {focusOk} · failed {focusFailed}',
          nativeToastLastError: 'Last toast error',
          nativeClickLastError: 'Last activation error',
          nativeToastHint: 'Alerts use Windows toasts; if banners are missing, check Windows notifications and Focus Assist.',
          systemTestButton: 'Test system toast',
          systemTestTitle: 'DSH system toast test',
          systemTestBody: 'Created directly by the plugin; click to return to DSH.',
          systemTestUnavailable: 'System notifications are not supported here (no Notification API).',
          systemTestCreated: 'Created (permission: {permission}). If no banner appears, see the note below.',
          systemTestBlocked: 'Windows reported a failure (permission: {permission}); notification settings may be blocking it.',
          systemTestFailed: 'Could not create it (permission: {permission}): {error}',
          version: 'Version',
          valueGranted: 'Granted',
          valueDefault: 'Not requested',
          valueDenied: 'Denied',
          valueUnsupported: 'Unsupported',
          valueFocused: 'Focused (silent)',
          valueUnfocused: 'Unfocused (notify)',
          valueConnected: 'Connected',
          valueDisconnected: 'Disconnected',
          valueTransportChannel: 'Official channel',
          valueTransportRoute: 'Same-origin route',
          valueTransportNone: 'Not mounted',
          valueAvailable: 'Available',
          valueUnavailable: 'Unavailable',
          valueAudioReady: 'Ready',
          valueAudioSuspended: 'Locked (click the page once)',
          valueAudioUninitialized: 'Not started',
          valueUnknown: 'Unknown',
          runtimeTitle: 'Runtime',
          statsQuestions: 'Questions',
          statsApprovals: 'Approvals',
          statsCompletions: 'Completions',
          statsMerged: 'merged',
          statsClients: 'Online pages',
          statsLast: 'Last',
          kindQuestion: 'Question',
          kindApproval: 'Approval',
          kindComplete: 'Completion',
          kindTest: 'Test',
          permissionAskHint: 'Notification permission has not been granted yet. Click anywhere on the page or the button below to request it.',
          permissionDeniedHint: 'Notification permission was denied. Allow notifications in the system or browser settings.',
          requestPermission: 'Request notification permission',
          notifyQuestionTitle: 'DeepSeek has a question for you',
          notifyApprovalTitle: 'DeepSeek needs your approval',
          notifyCompleteTitle: 'DeepSeek finished a step',
          notifyGoalPausedTitle: 'DeepSeek advanced {count} steps; goal paused',
          notifyGoalBlockedTitle: 'DeepSeek advanced {count} steps; goal blocked',
          notifyCompleteMergedTitle: 'DeepSeek pushed {count} steps in one go',
          notifyCompleteManyTitle: 'DeepSeek went all out and pushed {count} steps',
          notifyAllDoneTitle: 'All tasks are done',
          notificationMode: 'Notification display',
          notificationModeHint: 'Falls back when native progress is unavailable.',
          notificationModeNative: 'Windows notification (compatibility mode)',
          notificationModeNativeProgress: 'Windows notification (progress bar)',
          nativeProgressCaption: 'Auto close',
          nativeDuration: 'Auto-remove after (approx.)',
          nativeDurationHint: '3–30 s; Windows controls the actual dismissal.',
          notificationDurationNotice: 'The progress bar is updated by the plugin; Windows controls the actual banner lifetime',
          restartForNewSettings: 'The notification host is older; restart DSH to use the new settings',
          seconds: 'sec',
          notifyTestTitle: 'DSH notification test',
          notifyTestBody: 'This is a test notification. Click to return to DSH.',
          fallbackBody: 'Click to view',
          fallbackApprovalBody: 'A tool call needs approval',
        }

        // ------------------------------------------------------------------
        // Pure helpers (exported through __test for the Node smoke test)
        // ------------------------------------------------------------------

        function warn(message, error) {
          try {
            if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
              console.warn('[dsh-notify-toast] ' + message, error === undefined ? '' : error)
            }
          } catch (ignored) {
            // Logging must never be the reason a notification fails.
          }
        }

        function isRecord(value) {
          return typeof value === 'object' && value !== null && !Array.isArray(value)
        }

        function numberOr(value, fallback) {
          const parsed = typeof value === 'number' ? value : Number(value)
          return Number.isFinite(parsed) ? parsed : fallback
        }

        function clampInteger(value, min, max, fallback) {
          const parsed = numberOr(value, NaN)
          if (!Number.isFinite(parsed)) return fallback
          return Math.min(max, Math.max(min, Math.round(parsed)))
        }

        /** Collapse any run of whitespace (incl. newlines) to a single space. */
        function collapseWhitespace(value) {
          if (typeof value !== 'string') return ''
          return value.replace(/\s+/g, ' ').trim()
        }

        /**
         * Truncate to `maxLength` Unicode code points (surrogate pairs count as
         * one) after collapsing whitespace, appending '…' when cut.
         */
        function truncateText(value, maxLength) {
          const text = collapseWhitespace(value)
          const limit = clampInteger(maxLength, 20, 60, DEFAULT_CONFIG.bodyLength)
          const codePoints = Array.from(text)
          if (codePoints.length <= limit) return text
          return codePoints.slice(0, limit).join('') + '…'
        }

        function pickBoolean(source, key, fallback) {
          if (isRecord(source) && typeof source[key] === 'boolean') return source[key]
          return fallback
        }

        function pickSound(source, fallback) {
          if (isRecord(source) && typeof source.sound === 'string' && SOUND_IDS.indexOf(source.sound) >= 0) return source.sound
          return fallback
        }

        /** UTF-8 byte length without TextEncoder (the smoke vm has no DOM globals). */
        function utf8ByteLength(text) {
          let bytes = 0
          for (const ch of String(text)) {
            const code = ch.codePointAt(0)
            if (code <= 0x7f) bytes += 1
            else if (code <= 0x7ff) bytes += 2
            else if (code <= 0xffff) bytes += 3
            else bytes += 4
          }
          return bytes
        }

        /** Clamp a user-supplied all-done title to the Host's 96-byte limit. */
        function sanitizeAllDoneTitle(value) {
          if (typeof value !== 'string') return undefined
          const collapsed = value.replace(/\s+/g, ' ').trim()
          if (collapsed.length === 0) return undefined
          let out = ''
          let bytes = 0
          for (const ch of collapsed) {
            const size = utf8ByteLength(ch)
            if (bytes + size > 96) break
            out += ch
            bytes += size
          }
          return out.length > 0 ? out : undefined
        }

        /** Parse the host semver prefix, or null when it is not semver-shaped. */
        function parseHostVersion(version) {
          if (typeof version !== 'string') return null
          const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
          return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
        }

        /** New client settings need the 0.3.0 Host schema. */
        function hostSupportsAdvancedSettings(version) {
          const parts = parseHostVersion(version)
          if (!parts) return true
          return parts[0] > 0 || (parts[0] === 0 && parts[1] >= 3)
        }

        /** Map the 0.2 in-app mode to the 0.3 native-progress backend. */
        function normalizeNotificationMode(value) {
          if (value === 'native') return 'native'
          if (value === 'native-progress' || value === 'native-and-inapp') return 'native-progress'
          return undefined
        }

        /** Merge a (possibly partial / hostile) config object over a base. */
        function sanitizeConfig(raw, base) {
          const source = isRecord(raw) ? raw : {}
          const fallback = isRecord(base) ? base : DEFAULT_CONFIG
          const config = {}
          for (const key of BOOLEAN_CONFIG_KEYS) {
            config[key] = pickBoolean(source, key, typeof fallback[key] === 'boolean' ? fallback[key] : DEFAULT_CONFIG[key])
          }
          config.bodyLength = clampInteger(source.bodyLength, 20, 60, clampInteger(fallback.bodyLength, 20, 60, DEFAULT_CONFIG.bodyLength))
          config.sound = pickSound(source, typeof fallback.sound === 'string' ? fallback.sound : DEFAULT_CONFIG.sound)
          config.volume = clampInteger(source.volume, 0, 100, clampInteger(fallback.volume, 0, 100, DEFAULT_CONFIG.volume))
          config.mergeIntervalMs = clampInteger(source.mergeIntervalMs, 0, 10000, clampInteger(fallback.mergeIntervalMs, 0, 10000, DEFAULT_CONFIG.mergeIntervalMs))
          config.allDoneTitle = sanitizeAllDoneTitle(source.allDoneTitle)
            ?? sanitizeAllDoneTitle(fallback.allDoneTitle)
            ?? DEFAULT_CONFIG.allDoneTitle
          config.notificationMode = normalizeNotificationMode(source.notificationMode)
            || normalizeNotificationMode(fallback.notificationMode)
            || DEFAULT_CONFIG.notificationMode
          config.nativeDurationMs = clampInteger(
            source.nativeDurationMs,
            NATIVE_DURATION_MIN_MS,
            NATIVE_DURATION_MAX_MS,
            clampInteger(fallback.nativeDurationMs, NATIVE_DURATION_MIN_MS, NATIVE_DURATION_MAX_MS, DEFAULT_CONFIG.nativeDurationMs),
          )
          return config
        }

        /** Whitelist + clamp a settings patch before it is sent to the Host. */
        function sanitizePatch(raw) {
          const patch = {}
          if (!isRecord(raw)) return patch
          for (const key of BOOLEAN_CONFIG_KEYS) {
            if (typeof raw[key] === 'boolean') patch[key] = raw[key]
          }
          if (raw.bodyLength !== undefined) {
            const value = numberOr(raw.bodyLength, NaN)
            if (Number.isFinite(value)) patch.bodyLength = clampInteger(value, 20, 60, DEFAULT_CONFIG.bodyLength)
          }
          if (raw.sound !== undefined && typeof raw.sound === 'string' && SOUND_IDS.indexOf(raw.sound) >= 0) patch.sound = raw.sound
          if (raw.volume !== undefined) {
            const value = numberOr(raw.volume, NaN)
            if (Number.isFinite(value)) patch.volume = clampInteger(value, 0, 100, DEFAULT_CONFIG.volume)
          }
          if (raw.mergeIntervalMs !== undefined) {
            const value = numberOr(raw.mergeIntervalMs, NaN)
            if (Number.isFinite(value)) patch.mergeIntervalMs = clampInteger(value, 0, 10000, DEFAULT_CONFIG.mergeIntervalMs)
          }
          if (raw.allDoneTitle !== undefined) {
            const title = sanitizeAllDoneTitle(raw.allDoneTitle)
            if (title !== undefined) patch.allDoneTitle = title
          }
          if (raw.notificationMode !== undefined) {
            const mode = normalizeNotificationMode(raw.notificationMode)
            if (mode) patch.notificationMode = mode
          }
          if (raw.nativeDurationMs !== undefined) {
            const value = numberOr(raw.nativeDurationMs, NaN)
            if (Number.isFinite(value)) patch.nativeDurationMs = clampInteger(value, NATIVE_DURATION_MIN_MS, NATIVE_DURATION_MAX_MS, DEFAULT_CONFIG.nativeDurationMs)
          }
          return patch
        }

        function notificationTitleKey(kind) {
          if (kind === 'question') return 'notifyQuestionTitle'
          if (kind === 'approval') return 'notifyApprovalTitle'
          if (kind === 'complete') return 'notifyCompleteTitle'
          if (kind === 'test') return 'notifyTestTitle'
          return 'notifyTestTitle'
        }

        function buildNotificationTitle(kind, event, config, translate) {
          // Backward-compatible signature: buildNotificationTitle(kind, t).
          let ev = event
          let cfg = config
          let tr = translate
          if (typeof event === 'function') {
            tr = event
            ev = undefined
            cfg = DEFAULT_CONFIG
          }
          const t = typeof tr === 'function' ? tr : (key) => key
          if (kind === 'complete') {
            const count = ev && Number.isFinite(ev.count) ? Math.max(1, Math.floor(ev.count)) : 1
            if (ev && ev.goalOutcome === 'paused') {
              return formatTemplate(t('notifyGoalPausedTitle'), { count: String(count) })
            }
            if (ev && ev.goalOutcome === 'blocked') {
              return formatTemplate(t('notifyGoalBlockedTitle'), { count: String(count) })
            }
            if (ev && ev.allDone === true) return t('notifyAllDoneTitle')
            if (count >= 5) return formatTemplate(t('notifyCompleteManyTitle'), { count: String(count) })
            if (count > 1) return formatTemplate(t('notifyCompleteMergedTitle'), { count: String(count) })
          }
          return t(notificationTitleKey(kind))
        }

        function buildApprovalBody(event, translate) {
          const t = typeof translate === 'function' ? translate : (key) => key
          const toolName = collapseWhitespace(isRecord(event) ? event.toolName : '')
          const purpose = collapseWhitespace(isRecord(event) ? event.purpose : '')
          const joined = [toolName, purpose].filter(Boolean).join(' · ')
          return joined || t('fallbackApprovalBody')
        }

        /**
         * Body rules from the contract:
         *  - titleOnly wins over everything (empty body);
         *  - approval = "toolName · purpose" (locale fallback when empty);
         *  - complete = truncated last reply, or the locale fallback;
         *  - question = truncated question text; test = fixed copy.
         */
        function buildNotificationBody(kind, event, config, translate) {
          const t = typeof translate === 'function' ? translate : (key) => key
          const settings = isRecord(config) ? config : DEFAULT_CONFIG
          if (settings.titleOnly === true) return ''
          if (kind === 'test') return t('notifyTestBody')
          if (kind === 'approval') return buildApprovalBody(event, t)
          if (kind === 'complete') {
            const text = collapseWhitespace(isRecord(event) ? event.text : '')
            return text ? truncateText(text, settings.bodyLength) : t('fallbackBody')
          }
          if (kind === 'question') return truncateText(isRecord(event) ? event.text : '', settings.bodyLength)
          return ''
        }

        /** `document.hasFocus() && visibilityState !== 'hidden'`, computed now. */
        function computeFocused(doc) {
          try {
            if (!doc) return true
            const hasFocus = typeof doc.hasFocus === 'function' ? doc.hasFocus() : true
            const visibility = typeof doc.visibilityState === 'string' ? doc.visibilityState : 'visible'
            return hasFocus !== false && visibility !== 'hidden'
          } catch (error) {
            // Without a trustworthy answer, stay silent rather than nag.
            return true
          }
        }

        function parseLeaderLease(raw) {
          try {
            const value = JSON.parse(raw)
            if (!isRecord(value)) return null
            if (typeof value.id !== 'string' || value.id.length === 0) return null
            if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return null
            return { id: value.id, at: value.at }
          } catch (error) {
            return null
          }
        }

        function isFreshLease(lease, now) {
          if (!lease) return false
          const stamp = typeof now === 'number' ? now : Date.now()
          return stamp - lease.at < LEADER_STALE_MS
        }

        function describeRpcFailure(result) {
          if (!isRecord(result)) return 'no response'
          const error = result.error
          if (isRecord(error)) {
            if (typeof error.message === 'string' && error.message) return error.message
            if (typeof error.code === 'string' && error.code) return error.code
          }
          if (typeof error === 'string' && error) return error
          return 'request failed'
        }

        /**
         * A Connection RPC reply is doubly flagged: the transport resolves
         * `{ok:true, value}` and the Host endpoint's own value is again
         * `{ok:true, ...}` or `{ok:false, error}` (docs/INTERFACE.md §2.3).
         * These helpers unwrap that business layer.
         */
        function businessValue(response) {
          if (!isRecord(response) || response.ok !== true) return null
          const value = response.value
          if (!isRecord(value)) return null
          if (value.ok === false) return null
          return value
        }

        function businessFailure(response) {
          if (!isRecord(response) || response.ok !== true) return null
          const value = response.value
          if (isRecord(value) && value.ok === false) return value
          return null
        }

        function getWindow() {
          try {
            if (typeof window !== 'undefined' && window) return window
          } catch (error) {
            // ignored
          }
          return undefined
        }

        function getDocument() {
          try {
            if (typeof document !== 'undefined' && document) return document
          } catch (error) {
            // ignored
          }
          return undefined
        }

        function getNotificationCtor() {
          try {
            if (typeof Notification !== 'undefined' && Notification) return Notification
          } catch (error) {
            // ignored
          }
          try {
            const target = getWindow()
            if (target && target.Notification) return target.Notification
          } catch (error) {
            // ignored
          }
          return null
        }

        function readNotificationPermission() {
          const Ctor = getNotificationCtor()
          if (!Ctor) return 'unsupported'
          try {
            return typeof Ctor.permission === 'string' && Ctor.permission ? Ctor.permission : 'default'
          } catch (error) {
            return 'unknown'
          }
        }

        function getAudioConstructor() {
          const target = getWindow()
          const candidates = []
          try {
            if (typeof AudioContext !== 'undefined') candidates.push(AudioContext)
          } catch (error) {
            // ignored
          }
          try {
            if (typeof webkitAudioContext !== 'undefined') candidates.push(webkitAudioContext)
          } catch (error) {
            // ignored
          }
          if (target) {
            candidates.push(target.AudioContext, target.webkitAudioContext)
          }
          for (const candidate of candidates) {
            if (typeof candidate === 'function') return candidate
          }
          return null
        }

        function getLocalStorage() {
          try {
            if (typeof localStorage !== 'undefined' && localStorage) return localStorage
          } catch (error) {
            // Access can throw under hardened privacy settings; fall through.
          }
          try {
            const target = getWindow()
            if (target && target.localStorage) return target.localStorage
          } catch (error) {
            // ignored
          }
          return null
        }

        function createLeaderId() {
          try {
            const globalCrypto = typeof crypto !== 'undefined' ? crypto : undefined
            if (globalCrypto && typeof globalCrypto.randomUUID === 'function') return globalCrypto.randomUUID()
            const target = getWindow()
            if (target && target.crypto && typeof target.crypto.randomUUID === 'function') return target.crypto.randomUUID()
          } catch (error) {
            // ignored
          }
          return 'w' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
        }

        function createAbortController() {
          try {
            if (typeof AbortController === 'function') return new AbortController()
          } catch (error) {
            // ignored
          }
          return null
        }

        function formatWithUnit(value, unit) {
          if (!unit) return String(value)
          return String(value) + ' ' + unit
        }

        /** Replace `{name}` placeholders with values (missing keys stay literal). */
        function formatTemplate(template, values) {
          if (typeof template !== 'string') return ''
          if (!values || typeof values !== 'object') return template
          return template.replace(/\{(\w+)\}/g, (match, key) => (Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match))
        }

        /** HH:mm:ss in the page's local time zone ('' for invalid input). */
        function formatClockTime(value) {
          const stamp = typeof value === 'number' ? value : Number(value)
          if (!Number.isFinite(stamp)) return ''
          try {
            const date = new Date(stamp)
            if (!Number.isFinite(date.getTime())) return ''
            const pad = (part) => (part < 10 ? '0' + part : String(part))
            return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
          } catch (error) {
            return ''
          }
        }

        // ------------------------------------------------------------------
        // Inline styles — theme tokens with safe fallbacks (dark mode ready).
        // ------------------------------------------------------------------

        const TOKEN = {
          labelPrimary: 'var(--dsw-alias-label-primary, #1b1b1b)',
          labelTertiary: 'var(--dsw-alias-label-tertiary, #666)',
          border: 'var(--dsw-alias-border-l2, rgba(0,0,0,.12))',
          bgLayer: 'var(--dsw-alias-bg-layer-1, #fff)',
          primary: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
          danger: 'var(--dsw-alias-state-error-primary, #d92d20)',
        }

        /** Shared motion: one curve and duration for every disclosure. */
        const MOTION_MS = 200
        const MOTION_EASE = 'cubic-bezier(.2,0,0,1)'
        /** Neutral hover wash that reads on both light and dark themes. */
        const HOVER_WASH = 'rgba(127,127,127,.08)'

        const styles = {
          page: {
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
            padding: '4px 2px 24px',
            color: TOKEN.labelPrimary,
            fontSize: '13px',
            lineHeight: '18px',
          },
          header: {
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '16px',
            flexWrap: 'wrap',
          },
          title: { margin: 0, fontSize: '18px', lineHeight: '24px', fontWeight: 600, color: TOKEN.labelPrimary },
          intro: { margin: 0, fontSize: '13px', lineHeight: '18px', color: TOKEN.labelTertiary },
          notice: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '8px 12px',
            padding: '10px 14px',
            borderRadius: '10px',
            fontSize: '12px',
            lineHeight: '18px',
            color: TOKEN.labelPrimary,
            background: TOKEN.bgLayer,
            border: '1px solid ' + TOKEN.border,
          },
          noticeError: { color: TOKEN.danger, borderColor: TOKEN.danger },
          card: {
            display: 'flex',
            flexDirection: 'column',
            padding: '0 14px',
            borderRadius: '10px',
            background: TOKEN.bgLayer,
            border: '1px solid ' + TOKEN.border,
          },
          row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', padding: '10px 0', minHeight: '40px', boxSizing: 'border-box' },
          rowColumn: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 0' },
          rowHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' },
          rowDisabled: { opacity: 0.5 },
          rowText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
          rowLabel: { fontSize: '13px', lineHeight: '18px', fontWeight: 500, color: TOKEN.labelPrimary },
          rowHint: { fontSize: '12px', lineHeight: '16px', color: TOKEN.labelTertiary },
          rowValue: { fontSize: '13px', lineHeight: '18px', color: TOKEN.labelTertiary, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
          textInput: {
            width: '220px',
            maxWidth: '100%',
            boxSizing: 'border-box',
            padding: '6px 8px',
            borderRadius: '8px',
            border: '1px solid ' + TOKEN.border,
            background: TOKEN.bgLayer,
            color: TOKEN.labelPrimary,
            fontFamily: 'inherit',
            fontSize: '13px',
            lineHeight: '18px',
          },
          divider: { height: '1px', margin: 0, border: 'none', background: TOKEN.border, flex: '0 0 auto' },
          switchBase: {
            position: 'relative',
            flex: '0 0 auto',
            width: '38px',
            height: '22px',
            padding: 0,
            border: 'none',
            borderRadius: '11px',
            cursor: 'pointer',
            transition: 'background-color 120ms ease',
          },
          knobBase: {
            position: 'absolute',
            top: '2px',
            left: '2px',
            width: '18px',
            height: '18px',
            borderRadius: '9px',
            background: '#fff',
            boxShadow: '0 1px 2px rgba(0,0,0,.24)',
            transition: 'transform 120ms ease',
          },
          range: { width: '100%', margin: 0, accentColor: TOKEN.primary, cursor: 'pointer' },
          select: {
            minWidth: '140px',
            height: '32px',
            boxSizing: 'border-box',
            padding: '0 8px',
            borderRadius: '8px',
            border: '1px solid ' + TOKEN.border,
            background: TOKEN.bgLayer,
            color: TOKEN.labelPrimary,
            fontFamily: 'inherit',
            fontSize: '13px',
            lineHeight: '18px',
          },
          button: {
            display: 'inline-flex',
            alignItems: 'center',
            height: '32px',
            boxSizing: 'border-box',
            padding: '0 12px',
            borderRadius: '8px',
            border: '1px solid ' + TOKEN.border,
            background: TOKEN.bgLayer,
            color: TOKEN.labelPrimary,
            fontFamily: 'inherit',
            fontSize: '13px',
            lineHeight: '18px',
            fontWeight: 500,
            whiteSpace: 'nowrap',
            cursor: 'pointer',
          },
          statusRow: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: '16px',
            padding: '4px 0',
            fontSize: '12px',
            lineHeight: '18px',
          },
          statusLabel: { color: TOKEN.labelTertiary },
          statusValue: { color: TOKEN.labelPrimary, fontVariantNumeric: 'tabular-nums', textAlign: 'right', overflowWrap: 'anywhere' },
          okText: { fontSize: '12px', lineHeight: '18px', color: TOKEN.primary },
          errorText: { fontSize: '12px', lineHeight: '18px', color: TOKEN.danger, overflowWrap: 'anywhere' },
          hint: { fontSize: '12px', lineHeight: '18px', color: TOKEN.labelTertiary },
          actions: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
          headerText: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
          headerMeta: { display: 'flex', alignItems: 'center', gap: '12px', minHeight: '24px', whiteSpace: 'nowrap', flex: '0 0 auto' },
          chip: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '3px 9px',
            borderRadius: '999px',
            border: '1px solid ' + TOKEN.border,
            color: TOKEN.labelTertiary,
            fontSize: '12px',
            lineHeight: '16px',
          },
          chipDot: { width: '6px', height: '6px', borderRadius: '50%', background: 'currentColor', flex: '0 0 auto' },
          chipOn: { color: TOKEN.primary, borderColor: TOKEN.primary },
          chipWarn: { color: TOKEN.danger, borderColor: TOKEN.danger },
          headerLink: {
            padding: 0,
            border: 0,
            background: 'transparent',
            color: TOKEN.primary,
            fontFamily: 'inherit',
            fontSize: '12px',
            lineHeight: '16px',
            cursor: 'pointer',
          },
          section: { display: 'flex', flexDirection: 'column', gap: '8px' },
          sectionLabel: {
            margin: '0 2px',
            color: TOKEN.labelTertiary,
            fontSize: '12px',
            lineHeight: '16px',
            fontWeight: 600,
          },
          selectGroup: { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' },
          iconButton: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '32px',
            height: '32px',
            boxSizing: 'border-box',
            padding: 0,
            border: '1px solid ' + TOKEN.border,
            borderRadius: '8px',
            background: TOKEN.bgLayer,
            color: TOKEN.labelPrimary,
            cursor: 'pointer',
          },
          disclosure: {
            border: '1px solid ' + TOKEN.border,
            borderRadius: '10px',
            background: TOKEN.bgLayer,
          },
          disclosureHeader: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            width: '100%',
            minHeight: '44px',
            boxSizing: 'border-box',
            padding: '0 14px',
            border: 0,
            borderRadius: '9px',
            background: 'transparent',
            color: TOKEN.labelPrimary,
            fontFamily: 'inherit',
            fontSize: '13px',
            lineHeight: '18px',
            fontWeight: 500,
            textAlign: 'left',
            cursor: 'pointer',
          },
          summaryMeta: { color: TOKEN.labelTertiary, fontSize: '12px', fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          summaryRight: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
          summaryChevron: {
            display: 'block',
            flex: '0 0 auto',
            color: TOKEN.labelTertiary,
            transformOrigin: '50% 50%',
            transition: 'transform ' + MOTION_MS + 'ms ' + MOTION_EASE,
          },
          // Height animates through grid rows 0fr -> 1fr; `visibility` flips
          // only after the collapse finishes, which also removes the hidden
          // controls from the tab order and the accessibility tree without
          // relying on `inert` (whose React prop semantics differ by version).
          disclosureClip: { display: 'grid' },
          disclosureClipOpen: {
            gridTemplateRows: '1fr',
            opacity: 1,
            visibility: 'visible',
            transition:
              'grid-template-rows ' + MOTION_MS + 'ms ' + MOTION_EASE + ', opacity 160ms ease, visibility 0s linear 0s',
          },
          disclosureClipClosed: {
            gridTemplateRows: '0fr',
            opacity: 0,
            visibility: 'hidden',
            transition:
              'grid-template-rows ' + MOTION_MS + 'ms ' + MOTION_EASE + ', opacity 120ms ease, visibility 0s linear ' + MOTION_MS + 'ms',
          },
          disclosureInner: { overflow: 'hidden', minHeight: 0 },
          disclosureBody: { display: 'flex', flexDirection: 'column', padding: '0 14px 4px' },
          group: { display: 'flex', flexDirection: 'column', padding: '10px 0' },
          groupTitle: { margin: '0 0 2px', color: TOKEN.labelPrimary, fontSize: '12px', lineHeight: '18px', fontWeight: 600 },
          groupLine: { fontSize: '12px', lineHeight: '18px', color: TOKEN.labelTertiary, fontVariantNumeric: 'tabular-nums' },
        }

        /** Root class for the scoped settings stylesheet. */
        const SETTINGS_ROOT_CLASS = 'dsh-notify-toast-settings'

        /**
         * Pseudo-class states inline styles cannot express: keyboard focus
         * rings, hover washes and a reduced-motion override. `!important` is
         * needed only to beat inline transition declarations.
         */
        function settingsCss() {
          const root = '.' + SETTINGS_ROOT_CLASS
          return [
            root + ' button:focus-visible,' + root + ' select:focus-visible,' + root + ' input:focus-visible {',
            '  outline: 2px solid ' + TOKEN.primary + ';',
            '  outline-offset: 2px;',
            '}',
            root + ' input[type="text"]:focus { border-color: ' + TOKEN.primary + '; outline-offset: 0; }',
            root + ' [data-dnt-hover]:hover:not(:disabled) { background-color: ' + HOVER_WASH + '; }',
            root + ' [data-dnt-link]:hover { text-decoration: underline; }',
            root + ' button:disabled { cursor: default; }',
            '@media (prefers-reduced-motion: reduce) {',
            '  ' + root + ' *,' + root + ' *::before,' + root + ' *::after {',
            '    transition-duration: 0s !important;',
            '    transition-delay: 0s !important;',
            '    animation: none !important;',
            '  }',
            '}',
          ].join('\n')
        }

        /** 12px disclosure chevron; a symmetric SVG rotates about its true centre. */
        function Chevron(props) {
          return h(
            'svg',
            {
              width: 12,
              height: 12,
              viewBox: '0 0 12 12',
              fill: 'none',
              'aria-hidden': 'true',
              style: Object.assign({}, styles.summaryChevron, { transform: props.open ? 'rotate(90deg)' : 'rotate(0deg)' }),
            },
            h('path', {
              d: 'M4.5 2.5 8 6l-3.5 3.5',
              stroke: 'currentColor',
              strokeWidth: 1.5,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }),
          )
        }

        // ------------------------------------------------------------------
        // Presentational primitives (plain HTML through React.createElement).
        // ------------------------------------------------------------------

        /** Insert a divider between the non-null rows of one settings card. */
        function joinRows(rows) {
          const out = []
          for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index]
            if (!row) continue
            if (out.length > 0) out.push(h('hr', { key: 'divider-' + index, style: styles.divider }))
            out.push(row)
          }
          return out
        }

        function rowStyle(base, disabled) {
          return disabled ? Object.assign({}, base, styles.rowDisabled) : base
        }

        function RowText(props) {
          return h(
            'div',
            { style: styles.rowText },
            props.htmlFor
              ? h('label', { style: styles.rowLabel, htmlFor: props.htmlFor }, props.label)
              : h('span', { style: styles.rowLabel }, props.label),
            props.hint ? h('span', { style: styles.rowHint }, props.hint) : null,
          )
        }

        function SwitchRow(props) {
          const checked = props.checked === true
          const disabled = props.disabled === true
          return h(
            'div',
            { style: rowStyle(styles.row, disabled) },
            h(RowText, { label: props.label, hint: props.hint }),
            h(
              'button',
              {
                type: 'button',
                role: 'switch',
                'aria-checked': checked ? 'true' : 'false',
                'aria-label': props.label,
                disabled: disabled,
                onClick: () => {
                  if (disabled) return
                  if (typeof props.onChange === 'function') props.onChange(!checked)
                },
                style: Object.assign({}, styles.switchBase, { background: checked ? TOKEN.primary : TOKEN.border }),
              },
              h('span', {
                'aria-hidden': 'true',
                style: Object.assign({}, styles.knobBase, { transform: checked ? 'translateX(16px)' : 'translateX(0)' }),
              }),
            ),
          )
        }

        /**
         * Text field with a local draft. The saved value is normalized
         * (trimmed, byte-capped), so binding the input straight to it would
         * eat a space typed between words and snap an emptied field back
         * before the user can retype. The draft follows the saved value only
         * while the field is not being edited.
         */
        function TextRow(props) {
          const inputId = 'dsh-notify-toast-text-' + String(props.idPart || props.label)
          const disabled = props.disabled === true
          const saved = props.value == null ? '' : String(props.value)
          const [draft, setDraft] = useState(saved)
          const [editing, setEditing] = useState(false)
          const shown = editing ? draft : saved
          return h(
            'div',
            { style: rowStyle(styles.row, disabled) },
            h(RowText, { label: props.label, hint: props.hint, htmlFor: inputId }),
            h('input', {
              id: inputId,
              type: 'text',
              value: shown,
              maxLength: props.maxLength || 60,
              disabled: disabled,
              onFocus: () => {
                setDraft(saved)
                setEditing(true)
              },
              onBlur: () => setEditing(false),
              onChange: (event) => {
                const next = event && event.target ? event.target.value : ''
                setDraft(next)
                if (!editing) setEditing(true)
                if (!disabled && typeof props.onChange === 'function') props.onChange(next)
              },
              style: styles.textInput,
            }),
          )
        }

        function RangeRow(props) {
          const inputId = 'dsh-notify-toast-range-' + String(props.idPart || props.label)
          const disabled = props.disabled === true
          return h(
            'div',
            { style: rowStyle(styles.rowColumn, disabled) },
            h(
              'div',
              { style: styles.rowHeader },
              h(RowText, { label: props.label, hint: props.hint, htmlFor: inputId }),
              h('span', { style: styles.rowValue, 'aria-hidden': 'true' }, formatWithUnit(props.value, props.unit)),
            ),
            h('input', {
              id: inputId,
              type: 'range',
              min: String(props.min),
              max: String(props.max),
              step: String(props.step || 1),
              value: String(props.value),
              disabled: disabled,
              'aria-valuetext': formatWithUnit(props.value, props.unit),
              onChange: (event) => {
                const next = Number(event && event.target ? event.target.value : NaN)
                if (Number.isFinite(next) && typeof props.onChange === 'function') props.onChange(next)
              },
              style: styles.range,
            }),
          )
        }

        function SelectRow(props) {
          const selectId = 'dsh-notify-toast-select-' + String(props.idPart || props.label)
          const options = Array.isArray(props.options) ? props.options : []
          return h(
            'div',
            { style: styles.row },
            h(RowText, { label: props.label, hint: props.hint, htmlFor: selectId }),
            h(
              'div',
              { style: styles.selectGroup },
              h(
                'select',
                {
                  id: selectId,
                  value: String(props.value),
                  onChange: (event) => {
                    const next = event && event.target ? event.target.value : undefined
                    if (typeof next === 'string' && typeof props.onChange === 'function') props.onChange(next)
                  },
                  style: styles.select,
                },
                options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
              ),
              props.trailing || null,
            ),
          )
        }

        /** One diagnostic line; `tone: 'error'` marks a value that needs attention. */
        function StatusRow(props) {
          return h(
            'div',
            { style: styles.statusRow },
            h('span', { style: styles.statusLabel }, props.label),
            h(
              'span',
              { style: props.tone === 'error' ? Object.assign({}, styles.statusValue, { color: TOKEN.danger }) : styles.statusValue },
              props.value,
            ),
          )
        }

        /**
         * A collapsible block: a full-width header button and an animated
         * body. Rows render straight into the bordered container, so the
         * section does not nest a second card inside its own frame.
         */
        function Disclosure(props) {
          const open = props.open === true
          const headerId = props.id + '-header'
          const bodyId = props.id + '-body'
          return h(
            'div',
            { id: props.anchorId, style: styles.disclosure },
            h(
              'button',
              {
                type: 'button',
                id: headerId,
                'aria-expanded': open ? 'true' : 'false',
                'aria-controls': bodyId,
                'data-dnt-hover': '',
                style: styles.disclosureHeader,
                onClick: props.onToggle,
              },
              h('span', {}, props.title),
              h(
                'span',
                { style: styles.summaryRight },
                props.meta ? h('span', { style: styles.summaryMeta }, props.meta) : null,
                h(Chevron, { open: open }),
              ),
            ),
            h(
              'div',
              {
                id: bodyId,
                role: 'region',
                'aria-labelledby': headerId,
                'aria-hidden': open ? undefined : 'true',
                style: Object.assign({}, styles.disclosureClip, open ? styles.disclosureClipOpen : styles.disclosureClipClosed),
              },
              h(
                'div',
                { style: styles.disclosureInner },
                h('div', { style: styles.disclosureBody }, h('hr', { style: styles.divider }), props.children),
              ),
            ),
          )
        }

        // ------------------------------------------------------------------
        // Settings nav icon
        //
        // The host projects only id/order/label for a `settings.section`, and
        // its nav glyph is a closed list (`models`, `agent-presets`,
        // `plugins`) with the settings gear as the fallback, so a registrant
        // has no icon field to pass. Like the plugin market, claim this
        // plugin's own nav row once the dialog mounts and draw a mask-based
        // mark in place of the gear. The marker is set only on the row whose
        // visible text equals this plugin's localized label, and the whole
        // thing lives in a ctx.effect so an unload removes marker and style.
        // ------------------------------------------------------------------

        /** Marker attribute on this plugin's settings-nav row. */
        const NAV_ICON_MARKER = 'data-dsh-notify-toast-nav-icon'
        /** Glyph box; matches the shell's nav icon size. */
        const NAV_ICON_SIZE = 16
        /** The settings dialog's nav rows, as the shell renders them. */
        const NAV_ROW_SELECTOR = '[role="dialog"] nav button'

        /** The bell mark as standalone SVG (pure black: a mask reads alpha). */
        function navMarkSvg() {
          return (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" ' +
            'stroke="#000" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">' +
            '<path d="M4.4 6.5C4.4 4.5 5.9 2.9 8 2.9s3.6 1.6 3.6 3.6v2.6l1.05 2.05' +
            'c.18.35-.08.75-.47.75H3.82c-.39 0-.65-.4-.47-.75L4.4 9.1Z"/>' +
            '<path d="M6.55 13.3h2.9"/>' +
            '</svg>'
          )
        }

        /** The mark as a CSS mask URL (encoded at runtime, never hand-escaped). */
        function navMaskUrl(svg) {
          const source = typeof svg === 'string' ? svg : navMarkSvg()
          return 'data:image/svg+xml,' + encodeURIComponent(source)
        }

        /** Whether a nav row's visible text is this plugin's section label. */
        function isOwnNavRow(rowText, wantedLabel) {
          const wanted = String(wantedLabel === undefined || wantedLabel === null ? '' : wantedLabel).trim()
          if (wanted.length === 0) return false
          return String(rowText === undefined || rowText === null ? '' : rowText).trim() === wanted
        }

        /** Stylesheet for a claimed row: hide the shell's gear, draw the mark. */
        function navIconCss(maskUrl) {
          return [
            '[' + NAV_ICON_MARKER + '] > svg { display: none; }',
            '[' + NAV_ICON_MARKER + ']::before {',
            "  content: '';",
            '  flex: none;',
            '  width: ' + NAV_ICON_SIZE + 'px;',
            '  height: ' + NAV_ICON_SIZE + 'px;',
            '  background-color: currentColor;',
            '  -webkit-mask-image: url("' + maskUrl + '");',
            '  mask-image: url("' + maskUrl + '");',
            '  -webkit-mask-repeat: no-repeat;',
            '  mask-repeat: no-repeat;',
            '  -webkit-mask-position: center;',
            '  mask-position: center;',
            '  -webkit-mask-size: ' + NAV_ICON_SIZE + 'px ' + NAV_ICON_SIZE + 'px;',
            '  mask-size: ' + NAV_ICON_SIZE + 'px ' + NAV_ICON_SIZE + 'px;',
            '}',
          ].join('\n')
        }

        /** All nav rows currently mounted; empty while the dialog is closed. */
        function queryNavRows(doc) {
          try {
            return typeof doc.querySelectorAll === 'function' ? doc.querySelectorAll(NAV_ROW_SELECTOR) : []
          } catch (error) {
            return []
          }
        }

        /** Every marked row, for cleanup. */
        function queryMarkedRows(doc) {
          try {
            return typeof doc.querySelectorAll === 'function'
              ? doc.querySelectorAll('[' + NAV_ICON_MARKER + ']')
              : []
          } catch (error) {
            return []
          }
        }

        /** Native settings.section.icon component (DSH 0.2.2+). */
        function SettingsNavIcon(props) {
          const size = props && Number.isFinite(props.size) && props.size > 0 ? props.size : NAV_ICON_SIZE
          return h(
            'svg',
            {
              width: size,
              height: size,
              viewBox: '0 0 16 16',
              fill: 'none',
              'aria-hidden': 'true',
              style: { display: 'block' },
            },
            h('path', {
              d: 'M4.4 6.5C4.4 4.5 5.9 2.9 8 2.9s3.6 1.6 3.6 3.6v2.6l1.05 2.05c.18.35-.08.75-.47.75H3.82c-.39 0-.65-.4-.47-.75L4.4 9.1Z',
              stroke: 'currentColor',
              strokeWidth: 1.4,
              strokeLinejoin: 'round',
              strokeLinecap: 'round',
            }),
            h('path', {
              d: 'M6.55 13.3h2.9',
              stroke: 'currentColor',
              strokeWidth: 1.4,
              strokeLinecap: 'round',
            }),
          )
        }

        /**
         * Register the navigation icon through the native settings slot.
         * DSH 0.2.2 added settings.section.icon; older versions fall back to
         * the DOM claimer below. The slot replaces the shell's default gear
         * instead of adding a second glyph beside it.
         */
        function registerSettingsNavIcon(ctx) {
          if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') return false
          try {
            ctx.slots.inject('settings.section.icon', () => {
              try {
                return ctx.slots.register(
                  { name: 'settings.section.icon', id: PKG_ID },
                  SettingsNavIcon,
                )
              } catch (error) {
                warn('cannot register the native settings nav icon', error)
                return () => {}
              }
            })
            return true
          } catch (error) {
            warn('cannot wait for the native settings nav icon slot', error)
            return false
          }
        }

        /**
         * Older-DSH fallback: replace this plugin's default gear with the bell
         * mark by claiming its own nav row.
         *
         * @param ctx - client context, for effect ownership.
         * @param resolveLabel - current localized section label, re-read on
         *   every sync so a locale switch is picked up without re-registering.
         */
        function installSettingsNavIcon(ctx, resolveLabel) {
          if (typeof document === 'undefined' || !document) return
          try {
            ctx.effect(() => {
              const doc = document
              const host = doc.head || doc.body
              if (!host) return () => {}
              const tag = doc.createElement('style')
              tag.dataset.plugin = PKG_ID
              tag.dataset.pluginCss = PKG_ID + '/settings-nav-icon'
              tag.textContent = navIconCss(navMaskUrl())
              host.appendChild(tag)

              let disposed = false
              let scheduled = false

              const sync = () => {
                scheduled = false
                if (disposed) return
                const rows = queryNavRows(doc)
                if (rows.length === 0) {
                  for (const row of queryMarkedRows(doc)) row.removeAttribute(NAV_ICON_MARKER)
                  return
                }
                let wanted = ''
                try {
                  wanted = resolveLabel()
                } catch (error) {
                  warn('cannot resolve the settings nav label', error)
                }
                for (const row of rows) {
                  if (isOwnNavRow(row.textContent, wanted)) row.setAttribute(NAV_ICON_MARKER, '')
                  else row.removeAttribute(NAV_ICON_MARKER)
                }
              }

              const schedule = () => {
                if (scheduled || disposed) return
                scheduled = true
                if (typeof queueMicrotask === 'function') queueMicrotask(sync)
                else Promise.resolve().then(sync)
              }

              sync()
              let observer = null
              try {
                if (typeof MutationObserver === 'function' && doc.body) {
                  observer = new MutationObserver(schedule)
                  observer.observe(doc.body, { childList: true, subtree: true, characterData: true })
                }
              } catch (error) {
                warn('cannot observe the settings dialog for the nav icon', error)
              }

              return () => {
                disposed = true
                try {
                  if (observer) observer.disconnect()
                } catch (error) {
                  // ignored
                }
                for (const row of queryMarkedRows(doc)) row.removeAttribute(NAV_ICON_MARKER)
                try {
                  if (tag.parentNode) tag.parentNode.removeChild(tag)
                  else if (typeof tag.remove === 'function') tag.remove()
                } catch (error) {
                  // ignored
                }
              }
            }, 'dsh-notify-toast: settings nav icon')
          } catch (error) {
            warn('cannot install the settings nav icon', error)
          }
        }

        // ------------------------------------------------------------------
        // Factory export
        // ------------------------------------------------------------------

        function apply(ctx) {
          if (!ctx || typeof ctx !== 'object' || typeof ctx.effect !== 'function') return

          // ---- 1. Locale dictionaries (duplicate registration degrades to no-op) ----
          try {
            ctx.effect(() => {
              try {
                const disposer = ctx.locale.register(NS, { zh, en })
                return typeof disposer === 'function' ? disposer : () => {}
              } catch (error) {
                warn('locale dictionaries were already registered', error)
                return () => {}
              }
            }, 'dsh-notify-toast: locale dictionaries')
          } catch (error) {
            warn('cannot register locale dictionaries', error)
          }

          let t = (key) => (zh[key] !== undefined ? zh[key] : key)
          try {
            if (ctx.locale && typeof ctx.locale.bind === 'function') t = ctx.locale.bind(NS)
          } catch (error) {
            warn('cannot bind the locale translator', error)
          }

          // ---- 2. Runtime state ----
          let disposed = false
          let abortController = null
          let hostConnected = false
          let configLoaded = false
          let cursor = 0
          /** Host event-queue identity; a change means the Host restarted. */
          let cursorEpoch = null
          let inflightSave = false
          let pendingPatch = {}
          let advancedHostUnsupported = false
          let saveTimerCancel = null
          let savedFeedbackTimerCancel = null
          let permissionRequested = false
          let audioContext = null
          let audioMaster = null
          let audioCompressor = null
          let audioBuffers = Object.create(null)
          let audioState = 'uninitialized'
          let leaderLeaseId = createLeaderId()
          let leaderActive = true
          let config = sanitizeConfig(DEFAULT_CONFIG, DEFAULT_CONFIG)
          /** Root session IDs with completed work the user has not seen yet. */
          const unreadSessions = new Set()
          let badgeSequence = 0
          let badgeLastCount = -1

          const status = {
            hostConnected: false,
            connectionAttempted: false,
            settingsAvailable: null,
            nativeFocus: null,
            platform: null,
            transport: null,
            configSource: null,
            clients: null,
            audio: 'uninitialized',
            nativeToasts: { attempts: 0, created: 0, shown: 0, failed: 0, lastError: null },
            nativeClicks: { clicks: 0, focusOk: 0, focusFailed: 0, lastError: null, lastNative: null },
            systemTest: null,
            stats: null,
            lastEvent: null,
            version: VERSION,
            notificationPermission: readNotificationPermission(),
            focused: true,
            leader: true,
            saveState: 'idle',
            loaded: false,
            testState: 'idle',
          }

          const listeners = new Set()
          const toasts = new Map()
          const activationSeen = new Set()
          const pendingActivations = []
          const ACTIVATION_STORAGE_PREFIX = 'dsh-notify-toast:activation:'

          function activationStorageKey(key) {
            return ACTIVATION_STORAGE_PREFIX + key
          }

          function activationAlreadyClaimed(key) {
            try {
              const raw = localStorage.getItem(activationStorageKey(key))
              if (!raw) return false
              const at = Number(raw)
              if (!Number.isFinite(at) || Date.now() - at > EVENT_MAX_AGE_MS) {
                localStorage.removeItem(activationStorageKey(key))
                return false
              }
              return true
            } catch (error) {
              return false
            }
          }

          function claimActivation(key) {
            try {
              localStorage.setItem(activationStorageKey(key), String(Date.now()))
            } catch (error) {
              // localStorage can be unavailable; leader-local dedupe still applies
            }
          }
          const outstandingTimers = new Set()

          function snapshotState() {
            return { config: config, status: Object.assign({}, status) }
          }

          function emit() {
            if (disposed) return
            const snapshot = snapshotState()
            for (const listener of Array.from(listeners)) {
              try {
                listener(snapshot)
              } catch (error) {
                warn('state listener crashed', error)
              }
            }
          }

          function subscribe(listener) {
            listeners.add(listener)
            return () => {
              listeners.delete(listener)
            }
          }

          function info(message, error) {
            try {
              if (typeof console !== 'undefined' && console && typeof console.info === 'function') console.info('[dsh-notify-toast] ' + message, error === undefined ? '' : error)
            } catch (ignored) {
              // ignored
            }
          }

          // ---- 3. Timer and delay helpers ----

          function runSafely(callback) {
            try {
              callback()
            } catch (error) {
              warn('scheduled callback crashed', error)
            }
          }

          function scheduleWithTimeout(callback, delay) {
            let cancelled = false
            let handle = null
            try {
              handle = setTimeout(() => {
                if (cancelled) return
                runSafely(callback)
              }, delay)
            } catch (error) {
              warn('cannot schedule a timer', error)
              return () => {}
            }
            return () => {
              cancelled = true
              try {
                clearTimeout(handle)
              } catch (error) {
                // ignored
              }
            }
          }

          /** Lifecycle-aware timer; prefers ctx.timeout so the fiber owns it. */
          function schedule(callback, delay) {
            if (disposed) return () => {}
            let cancel = () => {}
            try {
              if (typeof ctx.timeout === 'function') {
                const disposer = ctx.timeout(() => {
                  removeTimer(cancel)
                  runSafely(callback)
                }, delay)
                if (typeof disposer === 'function') {
                  cancel = () => {
                    try {
                      const result = disposer()
                      if (result && typeof result.catch === 'function') result.catch(() => {})
                    } catch (error) {
                      // ignored
                    }
                  }
                } else {
                  cancel = () => {}
                }
              } else {
                cancel = scheduleWithTimeout(callback, delay)
              }
            } catch (error) {
              cancel = scheduleWithTimeout(callback, delay)
            }
            outstandingTimers.add(cancel)
            return () => {
              removeTimer(cancel)
              try {
                cancel()
              } catch (error) {
                // ignored
              }
            }
          }

          function removeTimer(cancel) {
            outstandingTimers.delete(cancel)
          }

          /** Abortable sleep used only by the connection backoff loops. */
          function delay(ms, signal) {
            return new Promise((resolve) => {
              if (disposed || (signal && signal.aborted)) {
                resolve()
                return
              }
              let settled = false
              let handle = null
              const finish = () => {
                if (settled) return
                settled = true
                try {
                  if (handle !== null) clearTimeout(handle)
                } catch (error) {
                  // ignored
                }
                try {
                  if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', finish)
                } catch (error) {
                  // ignored
                }
                resolve()
              }
              try {
                handle = setTimeout(finish, ms)
              } catch (error) {
                finish()
                return
              }
              try {
                if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', finish, { once: true })
              } catch (error) {
                // ignored
              }
            })
          }

          function abortSignal() {
            try {
              return abortController && abortController.signal ? abortController.signal : undefined
            } catch (error) {
              return undefined
            }
          }

          function isAborted() {
            try {
              return disposed || (abortController && abortController.signal && abortController.signal.aborted === true)
            } catch (error) {
              return disposed
            }
          }

          // ---- 4. Focus tracking ----

          function isFocused() {
            return computeFocused(getDocument())
          }

          status.focused = isFocused()

          try {
            ctx.effect(() => {
              const target = getWindow()
              const doc = getDocument()
              const onChange = () => {
                const next = isFocused()
                if (status.focused !== next) {
                  status.focused = next
                  if (next) {
                    // Returning to the window is the acknowledgement that
                    // clears the taskbar's unread-session badge.
                    try {
                      clearTaskbarBadge()
                    } catch (error) {
                      warn('clearing the taskbar badge failed', error)
                    }
                  }
                  emit()
                }
              }
              const cleanups = []
              if (target && typeof target.addEventListener === 'function') {
                target.addEventListener('focus', onChange)
                target.addEventListener('blur', onChange)
                cleanups.push(() => {
                  try {
                    target.removeEventListener('focus', onChange)
                    target.removeEventListener('blur', onChange)
                  } catch (error) {
                    // ignored
                  }
                })
              }
              if (doc && typeof doc.addEventListener === 'function') {
                doc.addEventListener('visibilitychange', onChange)
                cleanups.push(() => {
                  try {
                    doc.removeEventListener('visibilitychange', onChange)
                  } catch (error) {
                    // ignored
                  }
                })
              }
              return () => {
                for (const cleanup of cleanups) {
                  try {
                    cleanup()
                  } catch (error) {
                    // ignored
                  }
                }
              }
            }, 'dsh-notify-toast: focus tracking')
          } catch (error) {
            warn('cannot install focus listeners', error)
          }

          // ---- 5. Notification permission + first-gesture audio unlock ----

          function ensureNotificationPermission() {
            status.notificationPermission = readNotificationPermission()
            if (status.notificationPermission !== 'default') {
              emit()
              return Promise.resolve(status.notificationPermission)
            }
            const Ctor = getNotificationCtor()
            if (!Ctor) {
              status.notificationPermission = 'unsupported'
              emit()
              return Promise.resolve('unsupported')
            }
            if (permissionRequested) return Promise.resolve(status.notificationPermission)
            permissionRequested = true
            let request = null
            try {
              if (typeof Ctor.requestPermission === 'function') request = Ctor.requestPermission()
            } catch (error) {
              warn('notification permission request threw', error)
            }
            if (request && typeof request.then === 'function') {
              return Promise.resolve(request).then(
                (value) => {
                  status.notificationPermission = typeof value === 'string' ? value : readNotificationPermission()
                  emit()
                  return status.notificationPermission
                },
                () => {
                  status.notificationPermission = readNotificationPermission()
                  emit()
                  return status.notificationPermission
                },
              )
            }
            status.notificationPermission = readNotificationPermission()
            emit()
            return Promise.resolve(status.notificationPermission)
          }

          /**
           * Create/resume the audio engine inside a user-gesture handler and
           * prime the pipeline with a tiny silent burst, the reliable Web Audio
           * unlock pattern in Chromium/Electron.
           */
          function unlockAudioContext() {
            const context = ensureAudioContext()
            if (!context) return
            preloadSoundAsset(context, 'bubble')
            try {
              if (typeof context.state === 'string' && context.state === 'suspended' && typeof context.resume === 'function') {
                resumeAudioContext(context)
              } else {
                setAudioState(typeof context.state === 'string' ? context.state : 'running')
              }
              if (audioMaster && typeof context.createOscillator === 'function' && typeof context.currentTime === 'number') {
                const primer = context.createOscillator()
                const silent = context.createGain()
                silent.gain.value = 0.0001
                primer.connect(silent)
                silent.connect(audioMaster)
                const now = context.currentTime
                primer.start(now)
                primer.stop(now + 0.02)
              }
            } catch (error) {
              // Silent: audio is a nicety, never a requirement.
            }
          }

          try {
            ctx.effect(() => {
              const target = getWindow()
              if (!target || typeof target.addEventListener !== 'function') return () => {}
              let removed = false
              const cleanup = () => {
                if (removed) return
                removed = true
                try {
                  target.removeEventListener('pointerdown', onPointerDown, true)
                  target.removeEventListener('keydown', onKeyDown, true)
                } catch (error) {
                  // ignored
                }
              }
              const gesture = () => {
                cleanup()
                void ensureNotificationPermission()
                unlockAudioContext()
              }
              const onPointerDown = () => gesture()
              const onKeyDown = () => gesture()
              target.addEventListener('pointerdown', onPointerDown, true)
              target.addEventListener('keydown', onKeyDown, true)
              return cleanup
            }, 'dsh-notify-toast: first-gesture permission and audio unlock')
          } catch (error) {
            warn('cannot install first-gesture listeners', error)
          }

          // ---- 6. Web Audio synthesis ----

          /** Publish the audio-engine state to the settings page (cheap, deduped). */
          function setAudioState(next) {
            if (audioState === next) return
            audioState = next
            status.audio = next
            try {
              emit()
            } catch (error) {
              // ignored: emitting before mount is harmless
            }
          }

          function ensureAudioContext() {
            if (disposed) return null
            if (audioContext) {
              try {
                if (audioContext.state === 'closed') {
                  audioContext = null
                  audioMaster = null
                  audioCompressor = null
                  audioBuffers = Object.create(null)
                } else {
                  return audioContext
                }
              } catch (error) {
                audioContext = null
                audioMaster = null
                audioCompressor = null
                audioBuffers = Object.create(null)
              }
            }
            const Ctor = getAudioConstructor()
            if (!Ctor) return null
            try {
              audioContext = new Ctor({ latencyHint: 'interactive' })
              audioMaster = audioContext.createGain()
              audioMaster.gain.value = 0
              // A gentle compressor keeps layered partials from clipping on
              // tiny laptop speakers; guarded because some test doubles omit it.
              if (typeof audioContext.createDynamicsCompressor === 'function') {
                try {
                  audioCompressor = audioContext.createDynamicsCompressor()
                  audioCompressor.threshold.value = -18
                  audioCompressor.knee.value = 18
                  audioCompressor.ratio.value = 6
                  audioCompressor.attack.value = 0.003
                  audioCompressor.release.value = 0.25
                  audioMaster.connect(audioCompressor)
                  audioCompressor.connect(audioContext.destination)
                } catch (error) {
                  audioCompressor = null
                  try {
                    audioMaster.connect(audioContext.destination)
                  } catch (nested) {
                    // ignored
                  }
                }
              } else {
                audioMaster.connect(audioContext.destination)
              }
              setAudioState(typeof audioContext.state === 'string' ? audioContext.state : 'running')
              return audioContext
            } catch (error) {
              warn('cannot create AudioContext', error)
              audioContext = null
              audioMaster = null
              audioCompressor = null
              return null
            }
          }

          function closeAudioContext() {
            const context = audioContext
            audioContext = null
            audioMaster = null
            audioCompressor = null
            audioBuffers = Object.create(null)
            if (!context) return
            try {
              const closed = context.close()
              if (closed && typeof closed.catch === 'function') closed.catch(() => {})
            } catch (error) {
              // ignored
            }
          }

          /**
           * Resume or report the audio engine. A suspended context is normal
           * before the first user gesture; the caller still schedules the
           * sound so it plays the moment the context resumes.
           */
          function resumeAudioContext(context) {
            try {
              if (!context || typeof context.resume !== 'function') return
              const resumed = context.resume()
              if (resumed && typeof resumed.then === 'function') {
                resumed.then(
                  () => {
                    if (!disposed) setAudioState(typeof context.state === 'string' ? context.state : 'running')
                  },
                  () => {
                    if (!disposed) setAudioState(typeof context.state === 'string' ? context.state : 'suspended')
                  },
                )
              } else {
                setAudioState(typeof context.state === 'string' ? context.state : 'running')
              }
            } catch (error) {
              // Silent: audio is a nicety, never a requirement.
            }
          }

          /** Schedule every oscillator of a preset; throws are contained by caller. */
          function renderSoundPreset(context, preset) {
            const origin = typeof context.currentTime === 'number' ? context.currentTime : 0
            for (const note of preset.notes) {
              const startAt = origin + (note.at || 0)
              const endAt = startAt + note.duration
              for (const partial of note.partials) {
                const oscillator = context.createOscillator()
                const envelope = context.createGain()
                oscillator.type = 'sine'
                const frequency = note.frequency * partial[0]
                if (oscillator.frequency && typeof oscillator.frequency.setValueAtTime === 'function') {
                  oscillator.frequency.setValueAtTime(frequency, startAt)
                }
                const peak = Math.max(0.0001, (note.peak || 0.4) * partial[1])
                const gain = envelope.gain
                if (gain) {
                  if (typeof gain.setValueAtTime === 'function') gain.setValueAtTime(0.0001, startAt)
                  if (typeof gain.linearRampToValueAtTime === 'function') gain.linearRampToValueAtTime(peak, startAt + 0.012)
                  if (typeof gain.exponentialRampToValueAtTime === 'function') gain.exponentialRampToValueAtTime(0.0001, endAt)
                  else gain.value = peak
                }
                oscillator.connect(envelope)
                envelope.connect(audioMaster)
                oscillator.start(startAt)
                oscillator.stop(endAt + 0.05)
              }
            }
          }

          /** Decode one embedded CC0 asset in the background. */
          function preloadSoundAsset(context, id) {
            const encoded = SOUND_ASSETS[id]
            if (!encoded || audioBuffers[id] || !context) return null
            if (typeof context.decodeAudioData !== 'function' || typeof atob !== 'function') return null
            try {
              const binary = atob(encoded)
              if (!binary) return null
              const bytes = new Uint8Array(binary.length)
              for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
              let settled = false
              return new Promise((resolve) => {
                const finish = (buffer) => {
                  if (audioContext === context && buffer) audioBuffers[id] = buffer
                  if (settled) return
                  settled = true
                  resolve()
                }
                try {
                  const decoded = context.decodeAudioData(bytes.buffer, finish, () => {
                    warn('decoding the embedded notification sound failed')
                    finish(null)
                  })
                  if (decoded && typeof decoded.then === 'function') decoded.then(finish, () => finish(null))
                } catch (error) {
                  warn('preparing the embedded notification sound failed', error)
                  finish(null)
                }
              })
            } catch (error) {
              warn('preparing the embedded notification sound failed', error)
              return null
            }
          }

          /** Play a decoded buffer; false means the caller should use synth fallback. */
          function playSoundAsset(context, id) {
            const buffer = audioBuffers[id]
            if (!buffer || !audioMaster || typeof context.createBufferSource !== 'function') return false
            try {
              const source = context.createBufferSource()
              source.buffer = buffer
              source.connect(audioMaster)
              source.start(0)
              return true
            } catch (error) {
              warn('playing the embedded notification sound failed', error)
              return false
            }
          }

          /**
           * Play the configured notification sound. Always schedules the notes
           * immediately (so a suspended context plays them on resume) and kicks
           * off `resume()` without waiting — a rejected resume no longer drops
           * the sound silently.
           */
          function playNotificationSound() {
            if (disposed) return
            const assetId = typeof SOUND_ASSETS[config.sound] === 'string' ? config.sound : ''
            const preset = SOUND_PRESETS[config.sound]
            if (!preset && !assetId) return
            const volume = clampInteger(config.volume, 0, 100, DEFAULT_CONFIG.volume)
            if (volume <= 0) return
            const context = ensureAudioContext()
            if (!context || !audioMaster) return
            try {
              // Master gain = volume/100 * 0.5: clearly audible at the default
              // 60 %, still leaves headroom for the layered partials.
              audioMaster.gain.value = (volume / 100) * 0.5
              if (assetId) preloadSoundAsset(context, assetId)
              let played = false
              if (assetId) played = playSoundAsset(context, assetId)
              if (!played && preset) {
                try {
                  renderSoundPreset(context, preset)
                } catch (error) {
                  warn('synthesizing the notification sound failed', error)
                }
              }
              if (typeof context.state === 'string' && context.state === 'suspended') {
                resumeAudioContext(context)
              } else {
                setAudioState(typeof context.state === 'string' ? context.state : 'running')
              }
            } catch (error) {
              warn('playing the notification sound failed', error)
            }
          }

          /** Settings-page Preview: must stay inside the click handler. */
          function previewNotificationSound() {
            try {
              unlockAudioContext()
              const assetId = typeof SOUND_ASSETS[config.sound] === 'string' ? config.sound : ''
              const context = assetId ? ensureAudioContext() : null
              const pending = context && !audioBuffers[assetId] ? preloadSoundAsset(context, assetId) : null
              if (pending && typeof pending.then === 'function') {
                pending.then(() => {
                  if (!disposed) playNotificationSound()
                })
                return
              }
              playNotificationSound()
            } catch (error) {
              warn('previewing the notification sound failed', error)
            }
          }

          try {
            ctx.effect(() => () => closeAudioContext(), 'dsh-notify-toast: audio context')
          } catch (error) {
            warn('cannot register the audio cleanup', error)
          }

          // ---- 7. Multi-window leadership lease ----

          function writeLeaderLease(storage) {
            try {
              storage.setItem(LEADER_STORAGE_KEY, JSON.stringify({ id: leaderLeaseId, at: Date.now() }))
              return true
            } catch (error) {
              return false
            }
          }

          function readLeaderLeaseFrom(storage) {
            try {
              return parseLeaderLease(storage.getItem(LEADER_STORAGE_KEY))
            } catch (error) {
              return null
            }
          }

          function setLeaderActive(next, reason) {
            if (leaderActive === next) return
            leaderActive = next
            if (next) {
              const pending = pendingActivations.splice(0)
              for (const activation of pending) {
                if (activationSeen.has(activation.key)) continue
                if (!Number.isFinite(activation.at) || Date.now() - activation.at > EVENT_MAX_AGE_MS) continue
                if (activationAlreadyClaimed(activation.key)) continue
                claimActivation(activation.key)
                activationSeen.add(activation.key)
                try {
                  handleNotificationClick('activate', activation.sessionId)
                } catch (error) {
                  warn('pending activation failed', error)
                }
              }
            }
            status.leader = next
            emit()
            if (!next && reason) info('another window holds the notification lease; staying silent here')
          }

          /**
           * Claim or renew the localStorage lease. Only the lease holder shows
           * toasts and plays sounds, so N open windows do not fire N toasts.
           * Any storage failure degrades to "this window is the leader".
           */
          function refreshLeaderLease() {
            const storage = getLocalStorage()
            if (!storage) {
              setLeaderActive(true)
              return
            }
            try {
              const lease = readLeaderLeaseFrom(storage)
              if (lease && lease.id === leaderLeaseId) {
                writeLeaderLease(storage)
                setLeaderActive(true)
                return
              }
              if (lease && isFreshLease(lease)) {
                setLeaderActive(false)
                return
              }
              // Free or stale lease: take it, then confirm nobody raced us.
              writeLeaderLease(storage)
              const confirmed = readLeaderLeaseFrom(storage)
              setLeaderActive(!confirmed || confirmed.id === leaderLeaseId)
            } catch (error) {
              setLeaderActive(true)
            }
          }

          function releaseLeaderLease() {
            if (!leaderActive) return
            const storage = getLocalStorage()
            if (!storage) return
            try {
              const lease = readLeaderLeaseFrom(storage)
              if (lease && lease.id === leaderLeaseId) storage.removeItem(LEADER_STORAGE_KEY)
            } catch (error) {
              // ignored
            }
          }

          try {
            ctx.effect(() => {
              try {
                refreshLeaderLease()
              } catch (error) {
                warn('cannot read the leader lease', error)
              }
              const target = getWindow()
              const onStorage = (event) => {
                try {
                  const key = event && typeof event.key === 'string' ? event.key : null
                  if (key === null || key === LEADER_STORAGE_KEY) refreshLeaderLease()
                } catch (error) {
                  // ignored
                }
              }
              if (target && typeof target.addEventListener === 'function') target.addEventListener('storage', onStorage)
              const heartbeat = setInterval(() => {
                if (disposed) return
                try {
                  refreshLeaderLease()
                } catch (error) {
                  warn('leader heartbeat failed', error)
                }
              }, LEADER_HEARTBEAT_MS)
              return () => {
                try {
                  if (target && typeof target.removeEventListener === 'function') target.removeEventListener('storage', onStorage)
                } catch (error) {
                  // ignored
                }
                try {
                  clearInterval(heartbeat)
                } catch (error) {
                  // ignored
                }
                releaseLeaderLease()
              }
            }, 'dsh-notify-toast: leader lease')
          } catch (error) {
            warn('cannot install the leader lease', error)
          }

          // ---- 8. Native toast display ----
          //
          // Windows toasts are created with the Web Notification API
          // (Electron routes them to the OS). Two environments can swallow
          // them: a denied/unsupported permission, and Windows itself (banner
          // disabled, Focus Assist). The settings page exposes diagnostics.
          // Events go native by default; notificationMode selects the native
          // progress path or the compatibility path.

          function noteNativeToastFailure(reason) {
            status.nativeToasts.failed += 1
            status.nativeToasts.lastError = String(reason === undefined ? 'unknown' : reason).slice(0, 240)
            try {
              emit()
            } catch (error) {
              // ignored
            }
          }

          function cleanupNotification(kind, notification) {
            const record = toasts.get(kind)
            if (!record || (notification && record.notification !== notification)) return
            toasts.delete(kind)
            if (record.cancelTimer) {
              try {
                record.cancelTimer()
              } catch (error) {
                // ignored
              }
            }
          }

          function closeNotification(kind) {
            const record = toasts.get(kind)
            if (!record) return
            toasts.delete(kind)
            if (record.cancelTimer) {
              try {
                record.cancelTimer()
              } catch (error) {
                // ignored
              }
            }
            try {
              record.notification.close()
            } catch (error) {
              // ignored
            }
          }

          function closeAllNotifications() {
            for (const kind of Array.from(toasts.keys())) closeNotification(kind)
          }

          /**
           * Bring DSH back to the foreground when a toast is clicked. The Host
           * `focus` endpoint raises the Electron window with user32
           * (SetForegroundWindow); this function retries it a few times and
           * records counters in the settings page, because a renderer can
           * otherwise only call `window.focus()` (which does not raise the OS
           * window).
           */
          function handleNotificationClick(kind, sessionId, notification) {
            const payload = {}
            if (typeof sessionId === 'string' && sessionId.length > 0) payload.sessionId = sessionId
            const clicks = status.nativeClicks
            clicks.clicks += 1
            try {
              emit()
            } catch (error) {
              // ignored
            }

            // Page-level focus first; the Host call below owns the OS raise.
            try {
              const target = getWindow()
              if (target && typeof target.focus === 'function') target.focus()
            } catch (error) {
              // ignored
            }

            // Navigate immediately: the window may already be visible.
            if (typeof sessionId === 'string' && sessionId.length > 0) {
              try {
                const workspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
                if (workspace && typeof workspace.openSession === 'function') workspace.openSession(sessionId)
              } catch (error) {
                warn('opening the session failed', error)
              }
            }

            const attemptFocus = (attempt) => {
              let task
              try {
                task = rpcCall('focus', payload)
              } catch (error) {
                clicks.focusFailed += 1
                clicks.lastError = error && error.message ? error.message : String(error)
                try {
                  emit()
                } catch (ignored) {
                  /* ignored */
                }
                return
              }
              Promise.resolve(task).then(
                (response) => {
                  const value = businessValue(response)
                  if (value && value.ok === true) {
                    clicks.focusOk += 1
                    clicks.lastNative = value.native === true
                    try {
                      emit()
                    } catch (ignored) {
                      /* ignored */
                    }
                    if (value.native !== true && attempt < 3) {
                      schedule(() => attemptFocus(attempt + 1), 250)
                    }
                  } else {
                    clicks.focusFailed += 1
                    clicks.lastError = describeRpcFailure(businessFailure(response) || (isRecord(response) ? response.value : response))
                    try {
                      emit()
                    } catch (ignored) {
                      /* ignored */
                    }
                    if (attempt < 3) schedule(() => attemptFocus(attempt + 1), 300)
                  }
                },
                (error) => {
                  clicks.focusFailed += 1
                  clicks.lastError = error && error.message ? error.message : String(error)
                  try {
                    emit()
                  } catch (ignored) {
                    /* ignored */
                  }
                  if (attempt < 3) schedule(() => attemptFocus(attempt + 1), 400)
                },
              )
            }
            attemptFocus(1)

            // The user interacted with a Web Notification fallback: retire its
            // record. Native toast records are owned by the Host manager.
            if (notification) {
              try {
                if (typeof notification.close === 'function') notification.close()
              } catch (error) {
                // ignored
              }
              cleanupNotification(kind, notification)
            }
          }

          /**
           * Show one native toast. Returns false when the environment cannot
           * show one (no Notification API / permission denied / constructor
           * throw); the caller then uses the compatibility Web Notification path. Never passes
           * `tag`: the plugin keeps its own close-previous map so repeated
           * kinds replace each other without platform dedupe surprises.
           */
          /** Ask the Host to show a Windows toast with a native progress bar. */
          async function showNativeProgressNotification(options) {
            try {
              const response = await rpcCall('native-notify', {
                kind: options.kind,
                title: options.title,
                body: options.body,
                sessionId: options.sessionId,
                durationMs: options.durationMs,
                progressLabel: options.progressLabel,
              }, abortSignal())
              const value = businessValue(response)
              if (!value || value.ok !== true) return { ok: false, reason: value && value.reason ? value.reason : 'helper-failed' }
              return { ok: true, superseded: value.superseded === true }
            } catch (error) {
              warn('native progress notification failed; falling back to Web Notification', error)
              return { ok: false, reason: 'rpc-failed' }
            }
          }

          function showNativeNotification(options) {
            status.nativeToasts.attempts += 1
            const Ctor = getNotificationCtor()
            if (!Ctor) {
              noteNativeToastFailure('Notification API unavailable')
              return false
            }
            let permission = 'granted'
            try {
              permission = typeof Ctor.permission === 'string' ? Ctor.permission : 'granted'
            } catch (error) {
              permission = 'granted'
            }
            if (permission === 'denied') {
              noteNativeToastFailure('notification permission denied')
              return false
            }
            if (permission === 'default' && typeof Ctor.requestPermission === 'function') {
              // Electron's desktop shell grants non-media permissions; asking
              // here (best-effort) can turn a 'default' origin into 'granted'.
              try {
                const asked = Ctor.requestPermission()
                if (asked && typeof asked.catch === 'function') asked.catch(() => {})
              } catch (error) {
                // ignored: the constructor attempt below still reports the truth
              }
            }
            closeNotification(options.kind)
            let notification = null
            try {
              notification = new Ctor(options.title, { body: options.body || '', silent: true })
            } catch (error) {
              noteNativeToastFailure(error && error.message ? error.message : error)
              warn('cannot create the native notification', error)
              return false
            }
            status.nativeToasts.created += 1
            const record = { notification: notification, cancelTimer: null }
            toasts.set(options.kind, record)
            if (TOAST_AUTO_CLOSE_MS > 0) {
              record.cancelTimer = schedule(() => {
                closeNotification(options.kind)
              }, TOAST_AUTO_CLOSE_MS)
            }
            let clickHandled = false
            const onClick = () => {
              if (clickHandled) return
              clickHandled = true
              handleNotificationClick(options.kind, options.sessionId, notification)
            }
            try {
              notification.onshow = () => {
                status.nativeToasts.shown += 1
                try {
                  emit()
                } catch (error) {
                  // ignored
                }
              }
              notification.onclick = onClick
              // Electron forwards toast activation through both the property
              // and the event listener; listen to both (deduped above) because
              // only one of them fires depending on the platform path.
              if (typeof notification.addEventListener === 'function') {
                try {
                  notification.addEventListener('click', onClick)
                } catch (error) {
                  // ignored
                }
              }
              notification.onclose = () => cleanupNotification(options.kind, notification)
              notification.onerror = (event) => {
                const message = event && (event.message || (event.error && event.error.message))
                noteNativeToastFailure(message || 'notification error event')
                cleanupNotification(options.kind, notification)
              }
            } catch (error) {
              warn('cannot attach notification handlers', error)
            }
            try {
              emit()
            } catch (error) {
              // ignored
            }
            return true
          }

          /** Direct native-notification probe used by the settings page. */
          function testSystemNotification() {
            const Ctor = getNotificationCtor()
            if (!Ctor) {
              status.systemTest = { tone: 'error', text: t('systemTestUnavailable') }
              emit()
              return
            }
            let permission = 'unknown'
            try {
              permission = typeof Ctor.permission === 'string' ? Ctor.permission : 'unknown'
            } catch (error) {
              permission = 'unknown'
            }
            try {
              const probe = new Ctor(t('systemTestTitle'), {
                body: t('systemTestBody'),
                silent: true,
              })
              try {
                probe.onerror = () => {
                  status.systemTest = { tone: 'error', text: formatTemplate(t('systemTestBlocked'), { permission: permissionLabel(permission) }) }
                  emit()
                }
                // The probe is also a click-to-focus test: clicking it must
                // restore/foreground DSH exactly like a real notification.
                // Electron may fire both onclick and the click event; count once.
                let probeClicked = false
                const probeClick = () => {
                  if (probeClicked) return
                  probeClicked = true
                  handleNotificationClick('test', undefined, probe)
                }
                probe.onclick = probeClick
                if (typeof probe.addEventListener === 'function') {
                  try {
                    probe.addEventListener('click', probeClick)
                  } catch (error) {
                    // ignored
                  }
                }
              } catch (error) {
                // ignored
              }
              status.nativeToasts.attempts += 1
              status.nativeToasts.created += 1
              status.systemTest = { tone: 'ok', text: formatTemplate(t('systemTestCreated'), { permission: permissionLabel(permission) }) }
            } catch (error) {
              noteNativeToastFailure(error && error.message ? error.message : error)
              status.systemTest = {
                tone: 'error',
                text: formatTemplate(t('systemTestFailed'), {
                  permission: permissionLabel(permission),
                  error: error && error.message ? error.message : String(error),
                }),
              }
            }
            emit()
          }

          // ---- 9. Connection RPC ----

          /**
           * Invoke a Connection RPC endpoint. The service resolves through the
           * page's own origin/proxy and returns `{ok:true,value}` or
           * `{ok:false,error}`; a rejected promise means transport failure.
           */
          function rpcCall(endpoint, payload, signal) {
            return new Promise((resolve, reject) => {
              let result = null
              try {
                const connection = ctx.connection
                const rpc = connection && connection.rpc
                if (!rpc || typeof rpc.call !== 'function') {
                  reject(new Error('connection.rpc is unavailable'))
                  return
                }
                result = rpc.call(RPC_CHANNEL, endpoint, payload || {}, signal)
              } catch (error) {
                reject(error)
                return
              }
              Promise.resolve(result).then((value) => {
                if (isRecord(value) && typeof value.ok === 'boolean') resolve(value)
                // Defensive: accept a raw value from a Host that skips the envelope.
                else resolve({ ok: true, value: value })
              }, reject)
            })
          }

          function setHostConnected(connected) {
            const changed = hostConnected !== connected
            hostConnected = connected
            status.hostConnected = connected
            status.connectionAttempted = true
            if (changed && connected) {
              // A recovered connection also flushes settings that failed to save.
              if (status.saveState === 'failed' || Object.keys(pendingPatch).length > 0) {
                if (!inflightSave) scheduleFlushSave(0)
              }
            }
            if (changed) emit()
          }

          /** Absorb a `config` / `save` business value into local state. */
          function absorbHostValue(value, replaceConfig) {
            if (!isRecord(value) || value.ok === false) return
            if (replaceConfig === true && isRecord(value.config)) config = sanitizeConfig(value.config, config)
            const remoteStatus = isRecord(value.status) ? value.status : null
            if (remoteStatus) {
              if (typeof remoteStatus.settingsAvailable === 'boolean') status.settingsAvailable = remoteStatus.settingsAvailable
              if (typeof remoteStatus.nativeFocus === 'boolean') status.nativeFocus = remoteStatus.nativeFocus
              if (typeof remoteStatus.platform === 'string') status.platform = remoteStatus.platform
              if (typeof remoteStatus.transport === 'string') status.transport = remoteStatus.transport
              if (typeof remoteStatus.configSource === 'string') status.configSource = remoteStatus.configSource
              if (typeof remoteStatus.clients === 'number') status.clients = remoteStatus.clients
              // Optional in-process detection counters: display-only, all fields
              // defensive so an older Host without them simply hides the block.
              if (isRecord(remoteStatus.stats)) {
                status.stats = {
                  questions: numberOr(remoteStatus.stats.questions, 0),
                  approvals: numberOr(remoteStatus.stats.approvals, 0),
                  completions: numberOr(remoteStatus.stats.completions, 0),
                  merged: numberOr(remoteStatus.stats.merged, 0),
                  lastEventAt: typeof remoteStatus.stats.lastEventAt === 'number' ? remoteStatus.stats.lastEventAt : null,
                }
              }
              if (remoteStatus.lastEvent === null) {
                status.lastEvent = null
              } else if (isRecord(remoteStatus.lastEvent)) {
                status.lastEvent = {
                  kind: typeof remoteStatus.lastEvent.kind === 'string' ? remoteStatus.lastEvent.kind : '',
                  at: typeof remoteStatus.lastEvent.at === 'number' ? remoteStatus.lastEvent.at : null,
                }
              }
            }
            if (typeof value.version === 'string') status.version = value.version
            status.loaded = true
          }

          /**
           * Re-read `config` when the settings page mounts (and after a save
           * failure) so the displayed runtime counters are current. Never clears
           * optimistic local edits that are still on their way to the Host.
           */
          function refreshConfig() {
            if (disposed) return
            rpcCall('config', {}, abortSignal()).then(
              (response) => {
                if (disposed) return
                const value = businessValue(response)
                if (!value) return
                const canReplaceConfig = !inflightSave && Object.keys(pendingPatch).length === 0
                absorbHostValue(value, canReplaceConfig)
                setHostConnected(true)
                emit()
              },
              (error) => {
                if (!disposed) warn('refreshing the runtime status failed', error)
              },
            )
          }

          async function loadConfigPhase() {
            let backoff = BACKOFF_MIN_MS
            while (!disposed) {
              try {
                const response = await rpcCall('config', {}, abortSignal())
                if (isAborted()) return
                const value = businessValue(response)
                if (!value) {
                  throw new Error('config failed: ' + describeRpcFailure(isRecord(response) ? response.value : response))
                }
                absorbHostValue(value, true)
                configLoaded = true
                setHostConnected(true)
                emit()
                return
              } catch (error) {
                if (isAborted()) return
                setHostConnected(false)
                emit()
                warn('loading the notification config failed; retrying', error)
                await delay(backoff, abortSignal())
                backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
              }
            }
          }

          function applyPollValue(value) {
            if (!isRecord(value)) return
            const events = Array.isArray(value.events) ? value.events : []
            // Remember which Host queue the cursor belongs to; after a Host
            // restart the next poll then starts from that queue's beginning
            // instead of skipping its first events with a stale cursor.
            if (typeof value.epoch === 'string' && value.epoch.length > 0) cursorEpoch = value.epoch
            if (typeof value.next === 'number' && Number.isFinite(value.next)) {
              cursor = value.next
            } else if (events.length > 0) {
              // Defensive cursor advance for a Host that omits `next`: never
              // re-deliver the same batch on the following poll.
              let highestId = null
              for (const event of events) {
                if (isRecord(event) && typeof event.id === 'number' && Number.isFinite(event.id)) {
                  highestId = highestId === null ? event.id : Math.max(highestId, event.id)
                }
              }
              if (highestId !== null) cursor = Math.max(cursor, highestId + 1)
            }
            if (!events.length) return
            for (const event of events) {
              try {
                handleEvent(event)
              } catch (error) {
                warn('handling a notification event failed', error)
              }
            }
          }

          async function pollLoop() {
            let backoff = BACKOFF_MIN_MS
            while (!disposed) {
              try {
                const pollPayload = { after: cursor, wait: POLL_WAIT_MS }
                if (cursorEpoch !== null) pollPayload.epoch = cursorEpoch
                const response = await rpcCall('poll', pollPayload, abortSignal())
                if (isAborted()) return
                const value = businessValue(response)
                if (!value) {
                  throw new Error('poll failed: ' + describeRpcFailure(isRecord(response) ? response.value : response))
                }
                backoff = BACKOFF_MIN_MS
                setHostConnected(true)
                applyPollValue(value)
              } catch (error) {
                if (isAborted()) return
                setHostConnected(false)
                warn('notification poll failed; backing off', error)
                await delay(backoff, abortSignal())
                backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
              }
            }
          }

          async function runConnectionLoop() {
            await loadConfigPhase()
            if (disposed) return
            await pollLoop()
          }

          function startConnection() {
            abortController = createAbortController()
            runConnectionLoop().catch((error) => {
              if (!disposed) warn('connection loop stopped unexpectedly', error)
            })
          }

          // ---- 10. Notification event processing ----

          function isFreshEvent(event) {
            if (!isRecord(event)) return true
            if (typeof event.at !== 'number' || !Number.isFinite(event.at)) return true
            return Date.now() - event.at <= EVENT_MAX_AGE_MS
          }

          function isEventKind(kind) {
            return kind === 'question' || kind === 'approval' || kind === 'complete' || kind === 'test' || kind === 'activate'
          }

          function shouldPlaySound() {
            if (!leaderActive) return false
            if (!config || config.sound === 'none') return false
            return clampInteger(config.volume, 0, 100, 0) > 0
          }

          /**
           * Tell the Host how many distinct root sessions have unread
           * completed work. The Host owns the Windows taskbar overlay; this
           * client only decides *when* the badge is meaningful.
           */
          function postTaskbarBadge(count) {
            const seq = ++badgeSequence
            badgeLastCount = count
            rpcCall('taskbar-badge', { count: count }, abortSignal()).then(
              (response) => {
                if (seq !== badgeSequence || disposed) return
                const value = businessValue(response)
                if (!value) {
                  badgeLastCount = -1
                  return
                }
                if (typeof value.count === 'number') badgeLastCount = value.count
              },
              () => {
                if (seq === badgeSequence) badgeLastCount = -1
              },
            )
          }

          /** Reconcile the taskbar badge with the current config and unread set. */
          function syncTaskbarBadge() {
            if (disposed) return
            if (config.taskbarBadgeEnabled !== true) unreadSessions.clear()
            const count = config.taskbarBadgeEnabled === true ? unreadSessions.size : 0
            if (count === badgeLastCount) return
            postTaskbarBadge(count)
          }

          /** Drop the unread set and clear the badge after focus/click. */
          function clearTaskbarBadge() {
            if (disposed) return
            if (unreadSessions.size === 0 && badgeLastCount === 0) return
            unreadSessions.clear()
            postTaskbarBadge(0)
          }

          /** Returns true when the event was turned into a toast/sound. */
          function handleEvent(event) {
            if (!isRecord(event)) return false
            const kind = typeof event.kind === 'string' ? event.kind : ''
            if (!isEventKind(kind)) return false
            // A page that was closed when the event fired should not replay old
            // toasts/activations from the Host's ring buffer on load.
            if (!isFreshEvent(event)) return false
            if (kind === 'activate') {
              const sessionId = typeof event.sessionId === 'string' && event.sessionId.length > 0 ? event.sessionId : undefined
              if (!sessionId) return false
              // Event ids restart with the Host; scope the key by queue epoch
              // so a later click is not mistaken for an already-handled one.
              const activationKey =
                (cursorEpoch === null ? '' : cursorEpoch + ':') + String(event.id === undefined ? '' : event.id) + '|' + sessionId
              if (activationSeen.has(activationKey)) return true
              if (!leaderActive) {
                // A non-leader window may consume the event first. Keep it
                // until this window acquires the lease, then open once.
                if (!pendingActivations.some((entry) => entry.key === activationKey)) {
                  pendingActivations.push({ key: activationKey, sessionId, at: Date.now() })
                  while (pendingActivations.length > 20) pendingActivations.shift()
                }
                return true
              }
              if (activationAlreadyClaimed(activationKey)) return true
              claimActivation(activationKey)
              activationSeen.add(activationKey)
              while (activationSeen.size > 200) {
                const first = activationSeen.values().next()
                if (first.done) break
                activationSeen.delete(first.value)
              }
              handleNotificationClick('activate', sessionId)
              return true
            }
            const isTest = kind === 'test'

            if (!isTest) {
              if (config.enabled !== true) return false
              if (kind === 'question' && config.questionEnabled !== true) return false
              if (kind === 'approval' && config.approvalEnabled !== true) return false
              if (kind === 'complete' && config.completionEnabled !== true) return false
              // Focus is evaluated at event time, never cached at boot.
              if (isFocused()) return false
            }

            // Only the lease holder speaks for the profile; other windows stay
            // silent so one event never becomes N native toasts.
            if (!leaderActive) return false

            const sessionId = typeof event.sessionId === 'string' && event.sessionId.length > 0 ? event.sessionId : undefined
            if (!isTest && kind === 'complete' && config.taskbarBadgeEnabled === true) {
              // Scheme B: one unread unit per root session, not per turn.
              // A merged completion carries every distinct session in
              // event.sessionIds; a single completion carries sessionId.
              const badgeSessions = Array.isArray(event.sessionIds) && event.sessionIds.length > 0
                ? event.sessionIds
                : [sessionId || ('event:' + String(event.id === undefined ? 'unknown' : event.id))]
              for (const badgeSession of badgeSessions) {
                if (typeof badgeSession === 'string' && badgeSession.length > 0) unreadSessions.add(badgeSession)
              }
              syncTaskbarBadge()
            }
            const title = buildNotificationTitle(kind, event, config, t)
            const body = buildNotificationBody(kind, event, config, t)
            const notificationOptions = { kind: kind, title: title, body: body, sessionId: sessionId }
            const playSoundIfAllowed = () => {
              if (!disposed && shouldPlaySound()) playNotificationSound()
            }
            if (config.notificationMode === 'native-progress') {
              // Play the sound only after the helper reports that Windows
              // accepted the toast, so popup and sound stay together.
              showNativeProgressNotification({
                ...notificationOptions,
                durationMs: config.nativeDurationMs,
                progressLabel: t('nativeProgressCaption'),
              }).then((result) => {
                if (!result || result.superseded) return
                if (result.ok) {
                  playSoundIfAllowed()
                  return
                }
                if (disposed || (!isTest && isFocused()) || !leaderActive) return
                showNativeNotification(notificationOptions)
                playSoundIfAllowed()
              })
            } else {
              showNativeNotification(notificationOptions)
              playSoundIfAllowed()
            }
            return true
          }

          // ---- 11. Settings persistence ----

          function mergePendingPatch(patch) {
            for (const key of Object.keys(patch)) {
              if (!Object.prototype.hasOwnProperty.call(pendingPatch, key)) pendingPatch[key] = patch[key]
            }
          }

          function scheduleFlushSave(delayMs) {
            if (disposed) return
            if (saveTimerCancel) {
              try {
                saveTimerCancel()
              } catch (error) {
                // ignored
              }
              saveTimerCancel = null
            }
            saveTimerCancel = schedule(() => {
              saveTimerCancel = null
              flushSave()
            }, delayMs)
          }

          function updateConfig(patch) {
            if (disposed) return
            const sanitized = sanitizePatch(patch)
            const keys = Object.keys(sanitized)
            if (!keys.length) return
            config = sanitizeConfig(Object.assign({}, config, sanitized), config)
            for (const key of keys) pendingPatch[key] = config[key]
            emit()
            if (Object.prototype.hasOwnProperty.call(sanitized, 'taskbarBadgeEnabled')) {
              if (config.taskbarBadgeEnabled === true) syncTaskbarBadge()
              else clearTaskbarBadge()
            }
            scheduleFlushSave(SAVE_DEBOUNCE_MS)
          }

          function flushSave() {
            if (disposed || inflightSave) return
            const patch = pendingPatch
            pendingPatch = {}
            if (!Object.keys(patch).length) return
            inflightSave = true
            status.saveState = 'saving'
            emit()
            rpcCall('save', { patch: patch }, abortSignal()).then(
              (response) => {
                inflightSave = false
                if (disposed) return
                const value = businessValue(response)
                if (value) {
                  setHostConnected(true)
                  absorbHostValue(value, Object.keys(pendingPatch).length === 0)
                  status.saveState = 'saved'
                  emit()
                  if (savedFeedbackTimerCancel) savedFeedbackTimerCancel()
                  savedFeedbackTimerCancel = schedule(() => {
                    if (status.saveState === 'saved') {
                      status.saveState = 'idle'
                      emit()
                    }
                  }, 4000)
                  if (Object.keys(pendingPatch).length > 0) scheduleFlushSave(SAVE_DEBOUNCE_MS)
                } else {
                  // A Host-side rejection (invalid patch / settings-unavailable)
                  // arrives as a transport success with a failing business value.
                  const failure = businessFailure(response)
                  const errorCode = failure && isRecord(failure.error) && typeof failure.error.code === 'string' ? failure.error.code : ''
                  if (errorCode === 'unknown-field') {
                    // Old Host schema: drop only the new fields, keep old settings
                    // retryable, and hide the new controls behind a restart note.
                    advancedHostUnsupported = true
                    let removedAdvanced = false
                    for (const key of ADVANCED_CONFIG_KEYS) {
                      if (Object.prototype.hasOwnProperty.call(patch, key)) {
                        delete patch[key]
                        removedAdvanced = true
                      }
                    }
                    if (Object.keys(patch).length > 0) {
                      mergePendingPatch(patch)
                      // Retry the old fields on their own; the failed mixed
                      // patch must not strand unrelated settings.
                      if (removedAdvanced) scheduleFlushSave(SAVE_DEBOUNCE_MS)
                    }
                    status.saveState = 'failed'
                    emit()
                    warn('the Host does not support the new notification settings; restart DSH to enable them')
                  } else {
                    mergePendingPatch(patch)
                    status.saveState = 'failed'
                    emit()
                    warn('the Host rejected the settings patch: ' + describeRpcFailure(failure || (isRecord(response) ? response.value : response)))
                  }
                }
              },
              (error) => {
                inflightSave = false
                if (disposed) return
                mergePendingPatch(patch)
                status.saveState = 'failed'
                hostConnected = false
                status.hostConnected = false
                status.connectionAttempted = true
                emit()
                warn('saving settings failed', error)
              },
            )
          }

          // ---- 12. Test notification ----

          function showLocalTestFallback() {
            const title = buildNotificationTitle('test', t)
            const body = config.titleOnly === true ? '' : buildNotificationBody('test', {}, config, t)
            showNativeNotification({ kind: 'test', title: title, body: body, sessionId: undefined })
            if (shouldPlaySound()) playNotificationSound()
          }

          function runTestNotification() {
            ensureNotificationPermission()
            return rpcCall('test', {}, abortSignal()).then(
              (response) => {
                if (disposed) return false
                const value = businessValue(response)
                if (value) {
                  setHostConnected(true)
                  status.testState = 'sent'
                  emit()
                  if (savedFeedbackTimerCancel) savedFeedbackTimerCancel()
                  savedFeedbackTimerCancel = schedule(() => {
                    if (status.testState === 'sent') {
                      status.testState = 'idle'
                      emit()
                    }
                  }, 5000)
                  return true
                }
                throw new Error(describeRpcFailure(businessFailure(response) || (isRecord(response) ? response.value : response)))
              },
              (error) => {
                throw error
              },
            ).catch((error) => {
              if (disposed) return false
              warn('test notification request failed; showing a local fallback', error)
              status.testState = 'failed'
              emit()
              showLocalTestFallback()
              return false
            })
          }

          function triggerTestNotification() {
            if (disposed) return
            if (status.testState === 'sending') return
            // This click is the user gesture: unlock the audio engine now, so
            // the sound that follows the Host round-trip is audible.
            try {
              unlockAudioContext()
            } catch (error) {
              // ignored: audio is best-effort
            }
            status.testState = 'sending'
            emit()
            void runTestNotification()
          }

          // ---- 13. Runtime teardown (registered last so it unwinds first) ----

          try {
            ctx.effect(() => () => {
              try {
                clearTaskbarBadge()
              } catch (error) {
                // best-effort teardown
              }
              disposed = true
              try {
                if (abortController) abortController.abort()
              } catch (error) {
                // ignored
              }
              abortController = null
              if (saveTimerCancel) {
                try {
                  saveTimerCancel()
                } catch (error) {
                  // ignored
                }
                saveTimerCancel = null
              }
              if (savedFeedbackTimerCancel) {
                try {
                  savedFeedbackTimerCancel()
                } catch (error) {
                  // ignored
                }
                savedFeedbackTimerCancel = null
              }
              for (const cancel of Array.from(outstandingTimers)) {
                try {
                  cancel()
                } catch (error) {
                  // ignored
                }
              }
              outstandingTimers.clear()
              closeAllNotifications()
              closeAudioContext()
              releaseLeaderLease()
              listeners.clear()
              pendingPatch = {}
              configLoaded = false
            }, 'dsh-notify-toast: runtime teardown')
          } catch (error) {
            warn('cannot register the runtime teardown', error)
          }

          // ---- 14. Settings page ----

          function useRuntimeSnapshot() {
            const [snapshot, setSnapshot] = useState(snapshotState)
            useEffect(() => {
              let alive = true
              const off = subscribe((next) => {
                if (alive) setSnapshot(next)
              })
              // A locale switch must re-render mounted section copy (the slot
              // shell only re-reads the nav label thunk).
              let offLocale = null
              try {
                if (ctx.locale && typeof ctx.locale.subscribe === 'function') {
                  offLocale = ctx.locale.subscribe(() => {
                    if (alive) setSnapshot(snapshotState())
                  })
                }
              } catch (error) {
                warn('cannot subscribe to locale changes', error)
              }
              // Repair a frame lost between render and subscription.
              setSnapshot(snapshotState())
              return () => {
                alive = false
                try {
                  off()
                } catch (error) {
                  // ignored
                }
                try {
                  if (typeof offLocale === 'function') offLocale()
                } catch (error) {
                  // ignored
                }
              }
            }, [])
            return snapshot
          }

          function permissionLabel(permission) {
            if (permission === 'granted') return t('valueGranted')
            if (permission === 'denied') return t('valueDenied')
            if (permission === 'unsupported') return t('valueUnsupported')
            if (permission === 'default') return t('valueDefault')
            return t('valueUnknown')
          }

          function booleanLabel(value, trueKey, falseKey) {
            if (value === true) return t(trueKey)
            if (value === false) return t(falseKey)
            return t('valueUnknown')
          }

          function renderSettingsView() {
            const view = useRuntimeSnapshot()
            const settings = view.config
            const info = view.status
            const [advancedOpen, setAdvancedOpen] = useState(false)
            const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
            const advancedSupported = hostSupportsAdvancedSettings(info.version) && !advancedHostUnsupported
            const nativeInfo = isRecord(info.nativeToasts)
              ? info.nativeToasts
              : { attempts: 0, created: 0, shown: 0, failed: 0, lastError: null }
            const nativeClicks = isRecord(info.nativeClicks)
              ? info.nativeClicks
              : { clicks: 0, focusOk: 0, focusFailed: 0, lastError: null }
            const nativeMode = normalizeNotificationMode(settings.notificationMode) || 'native-progress'
            const soundEnabled = settings.sound !== 'none'
            const alertsOff = settings.enabled !== true
            const completionsOff = alertsOff || settings.completionEnabled !== true
            const statusLabel = !info.hostConnected
              ? t('statusConnectionIssue')
              : settings.enabled
                ? t('statusRunning')
                : t('statusOff')
            const statusChipStyle = !info.hostConnected
              ? Object.assign({}, styles.chip, styles.chipWarn)
              : settings.enabled
                ? Object.assign({}, styles.chip, styles.chipOn)
                : styles.chip
            const diagnosticsMeta =
              (info.hostConnected ? t('diagHostConnected') : t('diagHostDisconnected')) +
              ' · v' +
              String(info.version || VERSION)

            useEffect(() => {
              refreshConfig()
            }, [])

            function openDiagnostics() {
              try {
                setDiagnosticsOpen(true)
              } catch (error) {
                /* ignore */
              }
              try {
                // Scroll once the expand transition has settled, so the
                // target position is final rather than mid-animation.
                setTimeout(() => {
                  const node = document.getElementById('dsh-notify-toast-diagnostics')
                  if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
                }, MOTION_MS + 20)
              } catch (error) {
                /* ignore */
              }
            }

            const saveText =
              info.saveState === 'saving'
                ? t('saving')
                : info.saveState === 'saved'
                  ? t('saved')
                  : info.saveState === 'failed'
                    ? t('saveFailed')
                    : ''

            const transportLabel =
              info.transport === 'channel'
                ? t('valueTransportChannel')
                : info.transport === 'route'
                  ? t('valueTransportRoute')
                  : t('valueTransportNone')
            const audioLabel =
              info.audio === 'running'
                ? t('valueAudioReady')
                : info.audio === 'suspended'
                  ? t('valueAudioSuspended')
                  : t('valueAudioUninitialized')

            const statusRows = [
              {
                key: 'host',
                label: t('statusHost'),
                value: info.hostConnected ? t('valueConnected') : t('valueDisconnected'),
                tone: info.hostConnected ? null : 'error',
              },
              {
                key: 'permission',
                label: t('statusPermission'),
                value: permissionLabel(info.notificationPermission),
                tone: info.notificationPermission === 'denied' || info.notificationPermission === 'unsupported' ? 'error' : null,
              },
              {
                key: 'native',
                label: t('statusNativeFocus'),
                value: booleanLabel(info.nativeFocus, 'valueAvailable', 'valueUnavailable'),
                tone: info.nativeFocus === false ? 'error' : null,
              },
              {
                key: 'settings',
                label: t('statusSettings'),
                value: booleanLabel(info.settingsAvailable, 'valueAvailable', 'valueUnavailable'),
                tone: info.settingsAvailable === false ? 'error' : null,
              },
              { key: 'audio', label: t('statusAudio'), value: audioLabel },
              {
                key: 'transport',
                label: t('statusTransport'),
                value: transportLabel,
                tone: info.transport === 'channel' || info.transport === 'route' || info.transport === null ? null : 'error',
              },
              { key: 'version', label: t('version'), value: String(info.version || VERSION) },
            ]

            const soundOptions = SOUND_IDS.map((id) => ({ value: id, label: t(SOUND_LABEL_KEYS[id]) }))

            const mergeValue = Math.round(numberOr(settings.mergeIntervalMs, DEFAULT_CONFIG.mergeIntervalMs))
            const mergePresets = [0, 1000, 2500, 5000, 10000]
            const mergeOptions = mergePresets.map((ms) => ({
              value: ms,
              label: ms === 0 ? t('mergeOff') : formatWithUnit(ms / 1000, t('seconds')),
            }))
            if (!mergePresets.includes(mergeValue)) {
              mergeOptions.push({ value: mergeValue, label: formatWithUnit(mergeValue, t('milliseconds')) })
            }

            const runtimeGroup = isRecord(info.stats)
              ? (() => {
                  const stats = info.stats
                  const lastEvent = isRecord(info.lastEvent) ? info.lastEvent : null
                  const lastKindKey =
                    lastEvent && lastEvent.kind === 'question'
                      ? 'kindQuestion'
                      : lastEvent && lastEvent.kind === 'approval'
                        ? 'kindApproval'
                        : lastEvent && lastEvent.kind === 'complete'
                          ? 'kindComplete'
                          : lastEvent && lastEvent.kind === 'test'
                            ? 'kindTest'
                            : ''
                  const lastAt = lastEvent && typeof lastEvent.at === 'number' ? lastEvent.at : stats.lastEventAt
                  const lastValue = lastKindKey
                    ? t(lastKindKey) + (Number.isFinite(lastAt) ? ' ' + formatClockTime(lastAt) : '')
                    : t('valueUnknown')
                  const merged = numberOr(stats.merged, 0)
                  return h(
                    'div',
                    { key: 'runtime', style: styles.group },
                    h('div', { style: styles.groupTitle }, t('runtimeTitle')),
                    h(StatusRow, {
                      label: t('statsQuestions') + ' / ' + t('statsApprovals') + ' / ' + t('statsCompletions'),
                      value:
                        String(numberOr(stats.questions, 0)) +
                        ' / ' +
                        String(numberOr(stats.approvals, 0)) +
                        ' / ' +
                        String(numberOr(stats.completions, 0)) +
                        (merged > 0 ? ' (' + t('statsMerged') + ' ' + String(merged) + ')' : ''),
                    }),
                    h(StatusRow, { label: t('statsClients'), value: String(numberOr(info.clients, 0)) }),
                    h(StatusRow, { label: t('statsLast'), value: lastValue }),
                  )
                })()
              : null

            const systemTest = isRecord(info.systemTest) ? info.systemTest : null
            const nativeGroup = h(
              'div',
              { key: 'native', style: styles.group },
              h('div', { style: styles.groupTitle }, t('statusNativeToast')),
              h('div', { style: styles.groupLine }, formatTemplate(t('nativeToastCounts'), nativeInfo)),
              h('div', { style: styles.groupLine }, formatTemplate(t('nativeClicksCounts'), nativeClicks)),
              nativeInfo.lastError
                ? h('div', { style: styles.errorText }, t('nativeToastLastError') + ': ' + nativeInfo.lastError)
                : null,
              nativeClicks.lastError
                ? h('div', { style: styles.errorText }, t('nativeClickLastError') + ': ' + nativeClicks.lastError)
                : null,
              systemTest
                ? h('div', { style: systemTest.tone === 'error' ? styles.errorText : styles.okText }, systemTest.text)
                : null,
              h('div', { style: Object.assign({}, styles.hint, { marginTop: '4px' }) }, t('nativeToastHint')),
              h(
                'div',
                { style: Object.assign({}, styles.actions, { marginTop: '10px' }) },
                h(
                  'button',
                  {
                    type: 'button',
                    'data-dnt-hover': '',
                    style: styles.button,
                    onClick: () => testSystemNotification(),
                  },
                  t('systemTestButton'),
                ),
              ),
            )

            const permissionHint =
              info.notificationPermission === 'denied'
                ? h('div', { key: 'permission-denied', role: 'status', style: Object.assign({}, styles.notice, styles.noticeError) }, t('permissionDeniedHint'))
                : info.notificationPermission === 'default'
                  ? h(
                      'div',
                      { key: 'permission-request', role: 'status', style: styles.notice },
                      h('span', { style: styles.hint }, t('permissionAskHint')),
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-dnt-hover': '',
                          style: styles.button,
                          onClick: () => {
                            void ensureNotificationPermission()
                          },
                        },
                        t('requestPermission'),
                      ),
                    )
                  : null

            const testFeedback =
              info.testState === 'sent'
                ? h('span', { style: styles.okText }, t('testSent'))
                : info.testState === 'failed'
                  ? h('span', { style: styles.errorText }, t('testFailed') + ' ' + t('testLocalFallback'))
                  : null
            const alertRows = [
              h(SwitchRow, {
                key: 'enabled',
                label: t('enable'),
                hint: t('enableHint'),
                checked: settings.enabled,
                onChange: (next) => updateConfig({ enabled: next }),
              }),
              h(SwitchRow, {
                key: 'question',
                label: t('questionEnabled'),
                hint: t('questionEnabledHint'),
                checked: settings.questionEnabled,
                disabled: alertsOff,
                onChange: (next) => updateConfig({ questionEnabled: next }),
              }),
              h(SwitchRow, {
                key: 'approval',
                label: t('approvalEnabled'),
                hint: t('approvalEnabledHint'),
                checked: settings.approvalEnabled,
                disabled: alertsOff,
                onChange: (next) => updateConfig({ approvalEnabled: next }),
              }),
              h(SwitchRow, {
                key: 'completion',
                label: t('completionEnabled'),
                hint: t('completionEnabledHint'),
                checked: settings.completionEnabled,
                disabled: alertsOff,
                onChange: (next) => updateConfig({ completionEnabled: next }),
              }),
              advancedSupported
                ? h(SwitchRow, {
                    key: 'taskbar',
                    label: t('taskbarBadge'),
                    hint: t('taskbarBadgeHint'),
                    checked: settings.taskbarBadgeEnabled,
                    disabled: completionsOff,
                    onChange: (next) => updateConfig({ taskbarBadgeEnabled: next }),
                  })
                : null,
            ]

            const deliveryRows = [
              h(SelectRow, {
                key: 'sound',
                idPart: 'sound',
                label: t('sound'),
                value: settings.sound,
                options: soundOptions,
                trailing: h(
                  'button',
                  {
                    type: 'button',
                    'data-dnt-hover': '',
                    style: styles.iconButton,
                    title: t('previewSound'),
                    'aria-label': t('previewSound'),
                    disabled: !soundEnabled,
                    onClick: () => previewNotificationSound(),
                  },
                  // Speaker glyph, drawn so it matches the nav icon stroke.
                  h(
                    'svg',
                    { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
                    h('path', {
                      d: 'M2.75 6.25h2.1L8 3.6v8.8L4.85 9.75h-2.1z',
                      stroke: 'currentColor',
                      strokeWidth: 1.3,
                      strokeLinejoin: 'round',
                    }),
                    h('path', {
                      d: 'M10.6 5.6a3.4 3.4 0 0 1 0 4.8M12.3 3.9a5.8 5.8 0 0 1 0 8.2',
                      stroke: 'currentColor',
                      strokeWidth: 1.3,
                      strokeLinecap: 'round',
                    }),
                  ),
                ),
                onChange: (next) => {
                  updateConfig({ sound: next })
                  previewNotificationSound()
                },
              }),
              soundEnabled
                ? h(RangeRow, {
                    key: 'volume',
                    idPart: 'volume',
                    label: t('volume'),
                    hint: t('volumeHint'),
                    value: settings.volume,
                    min: 0,
                    max: 100,
                    step: 1,
                    unit: t('percent'),
                    onChange: (next) => updateConfig({ volume: next }),
                  })
                : null,
              advancedSupported && nativeMode === 'native-progress'
                ? h(RangeRow, {
                    key: 'native-duration',
                    idPart: 'native-duration',
                    label: t('nativeDuration'),
                    hint: t('nativeDurationHint'),
                    value: Math.round(numberOr(settings.nativeDurationMs, DEFAULT_CONFIG.nativeDurationMs) / 1000),
                    min: 3,
                    max: 30,
                    step: 1,
                    unit: t('seconds'),
                    onChange: (next) => updateConfig({ nativeDurationMs: next * 1000 }),
                  })
                : null,
              h(SwitchRow, {
                key: 'title-only',
                label: t('titleOnly'),
                hint: t('titleOnlyHint'),
                checked: settings.titleOnly,
                onChange: (next) => updateConfig({ titleOnly: next }),
              }),
            ]

            const advancedRows = []
            if (!advancedSupported) {
              advancedRows.push(
                h('div', { key: 'advanced-unsupported', style: Object.assign({}, styles.hint, { padding: '10px 0' }) }, t('restartForNewSettings')),
              )
            }
            if (advancedSupported) {
              advancedRows.push(
                h(SelectRow, {
                  key: 'notification-mode',
                  idPart: 'notification-mode',
                  label: t('notificationMode'),
                  hint: t('notificationModeHint'),
                  value: nativeMode,
                  options: [
                    { value: 'native-progress', label: t('notificationModeNativeProgress') },
                    { value: 'native', label: t('notificationModeNative') },
                  ],
                  onChange: (next) => updateConfig({ notificationMode: next }),
                }),
              )
            }
            advancedRows.push(
              h(RangeRow, {
                key: 'body-length',
                idPart: 'body-length',
                label: t('bodyLength'),
                hint: t('bodyLengthHint'),
                value: settings.bodyLength,
                min: 20,
                max: 60,
                step: 1,
                unit: t('characters'),
                disabled: settings.titleOnly === true,
                onChange: (next) => updateConfig({ bodyLength: next }),
              }),
            )
            advancedRows.push(
              h(SelectRow, {
                key: 'merge-interval',
                idPart: 'merge-interval',
                label: t('mergeInterval'),
                hint: t('mergeIntervalHint'),
                value: mergeValue,
                options: mergeOptions,
                onChange: (next) => updateConfig({ mergeIntervalMs: Number(next) }),
              }),
            )
            if (advancedSupported) {
              advancedRows.push(
                h(SwitchRow, {
                  key: 'goal-summary',
                  label: t('goalSummaryEnabled'),
                  hint: t('goalSummaryEnabledHint'),
                  checked: settings.goalSummaryEnabled,
                  disabled: completionsOff,
                  onChange: (next) => updateConfig({ goalSummaryEnabled: next }),
                }),
              )
            }
            advancedRows.push(
              h(SwitchRow, {
                key: 'all-done',
                label: t('allDoneTitleEnabled'),
                hint: t('allDoneTitleEnabledHint'),
                checked: settings.allDoneTitleEnabled,
                onChange: (next) => updateConfig({ allDoneTitleEnabled: next }),
              }),
            )
            if (settings.allDoneTitleEnabled) {
              advancedRows.push(
                h(TextRow, {
                  key: 'all-done-title',
                  idPart: 'all-done-title',
                  label: t('allDoneTitle'),
                  hint: t('allDoneTitleHint'),
                  value: settings.allDoneTitle,
                  maxLength: 60,
                  onChange: (next) => updateConfig({ allDoneTitle: next }),
                }),
              )
            }

            const diagnosticsGroups = [
              h(
                'div',
                { key: 'status', style: styles.group },
                statusRows.map((row) => h(StatusRow, { key: row.key, label: row.label, value: row.value, tone: row.tone })),
              ),
              nativeGroup,
              runtimeGroup,
            ]

            return h(
              'div',
              { className: SETTINGS_ROOT_CLASS, style: styles.page },
              h('style', {}, settingsCss()),
              h(
                'div',
                { style: styles.header },
                h(
                  'div',
                  { style: styles.headerText },
                  h('h2', { style: styles.title }, t('pageTitle')),
                  h('p', { style: styles.intro }, t('pageIntro')),
                ),
                h(
                  'div',
                  { style: styles.headerMeta },
                  h(
                    'span',
                    { style: statusChipStyle, role: 'status' },
                    h('span', { style: styles.chipDot, 'aria-hidden': 'true' }),
                    statusLabel,
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      'data-dnt-link': '',
                      style: styles.headerLink,
                      onClick: openDiagnostics,
                    },
                    t('diagnostics'),
                  ),
                ),
              ),
              !info.hostConnected
                ? h('div', { role: 'status', style: styles.notice }, info.connectionAttempted ? t('hostDegraded') : t('loading'))
                : null,
              permissionHint,
              h(
                'div',
                { style: styles.section },
                h('div', { style: styles.sectionLabel }, t('sectionAlerts')),
                h('div', { style: styles.card }, joinRows(alertRows)),
              ),
              h(
                'div',
                { style: styles.section },
                h('div', { style: styles.sectionLabel }, t('sectionDelivery')),
                h('div', { style: styles.card }, joinRows(deliveryRows)),
              ),
              h(
                'div',
                { style: styles.actions },
                h(
                  'button',
                  {
                    type: 'button',
                    'data-dnt-hover': '',
                    style: styles.button,
                    disabled: info.testState === 'sending',
                    onClick: () => triggerTestNotification(),
                  },
                  info.testState === 'sending' ? t('testing') : t('testButton'),
                ),
                testFeedback,
                saveText
                  ? h(
                      'span',
                      { role: 'status', style: info.saveState === 'failed' ? styles.errorText : styles.hint },
                      saveText,
                    )
                  : null,
              ),
              h(
                Disclosure,
                {
                  id: 'dsh-notify-toast-advanced',
                  title: t('advancedSettings'),
                  meta: advancedSupported ? null : t('restartForNewSettings'),
                  open: advancedOpen,
                  onToggle: () => setAdvancedOpen((open) => !open),
                },
                joinRows(advancedRows),
              ),
              h(
                Disclosure,
                {
                  id: 'dsh-notify-toast-diagnostics',
                  anchorId: 'dsh-notify-toast-diagnostics',
                  title: t('diagnostics'),
                  meta: diagnosticsMeta,
                  open: diagnosticsOpen,
                  onToggle: () => setDiagnosticsOpen((open) => !open),
                },
                joinRows(diagnosticsGroups),
              ),
            )
          }

          // The settings.section entry: id/order/label/locale/inject exactly as
          // the slot contract expects; `inject` hands the component the bound
          // translator, and the component subscribes to locale through the
          // service so a language switch re-renders mounted copy.
          if (ctx.slots && typeof ctx.slots.inject === 'function' && typeof ctx.slots.register === 'function') {
            try {
              ctx.slots.inject('settings.section', () => {
                try {
                  return ctx.slots.register(
                    {
                      name: 'settings.section',
                      id: PKG_ID,
                      order: 42,
                      label: () => t('nav'),
                      locale: NS,
                      inject: () => ({ t }),
                    },
                    function SettingsView() {
                      return renderSettingsView()
                    },
                  )
                } catch (error) {
                  warn('settings section registration failed', error)
                  return () => {}
                }
              })
            } catch (error) {
              warn('cannot wait for the settings.section slot', error)
            }
          }

          // DSH 0.2.2 projects a native settings.section.icon slot; use it
          // first. Only older shells fall back to claiming the rendered row.
          if (!registerSettingsNavIcon(ctx)) installSettingsNavIcon(ctx, () => t('nav'))

          // ---- 15. Start ----
          status.focused = isFocused()
          emit()
          // A previous page instance may have left a badge on the taskbar.
          // Clear it on boot; the next unfocused completion will set it again.
          try {
            clearTaskbarBadge()
          } catch (error) {
            warn('clearing the initial taskbar badge failed', error)
          }
          startConnection()
        }

        // Test hook for test/client-smoke.mjs: pure helpers only, never used by
        // the app itself, and non-enumerable so it stays out of the module's
        // visible surface.
        const injected = ['slots', 'locale', 'connection']
        const exportsObject = {
          inject: injected,
          apply: apply,
        }
        try {
          Object.defineProperty(exportsObject, '__test', {
            enumerable: false,
            configurable: false,
            writable: false,
            value: {
              PKG_ID: PKG_ID,
              NS: NS,
              RPC_CHANNEL: RPC_CHANNEL,
              VERSION: VERSION,
              LEADER_STORAGE_KEY: LEADER_STORAGE_KEY,
              DEFAULT_CONFIG: DEFAULT_CONFIG,
              SOUND_IDS: SOUND_IDS,
              SOUND_PRESETS: SOUND_PRESETS,
              POLL_WAIT_MS: POLL_WAIT_MS,
              collapseWhitespace: collapseWhitespace,
              truncateText: truncateText,
              sanitizeConfig: sanitizeConfig,
              sanitizePatch: sanitizePatch,
              notificationTitleKey: notificationTitleKey,
              buildNotificationTitle: buildNotificationTitle,
              buildNotificationBody: buildNotificationBody,
              computeFocused: computeFocused,
              parseLeaderLease: parseLeaderLease,
              isFreshLease: isFreshLease,
              NAV_ICON_MARKER: NAV_ICON_MARKER,
              NAV_ICON_SIZE: NAV_ICON_SIZE,
              NAV_ROW_SELECTOR: NAV_ROW_SELECTOR,
              navMarkSvg: navMarkSvg,
              navMaskUrl: navMaskUrl,
              isOwnNavRow: isOwnNavRow,
              navIconCss: navIconCss,
              installSettingsNavIcon: installSettingsNavIcon,
              zh: zh,
              en: en,
            },
          })
        } catch (error) {
          warn('cannot define the test hook', error)
        }
        return exportsObject
      },
    })
  } catch (error) {
    try {
      if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
        console.warn('[dsh-notify-toast] client bundle load failed:', error)
      }
    } catch (ignored) {
      // Nothing left to contain.
    }
  }
})()
