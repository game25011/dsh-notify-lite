# dsh-notify-toast — Host/Client 接口契约（开发用）

> 实现时严格遵守本契约；改动契约先改本文件并在提交说明里写明。
> 单位：字符数按 Unicode 码点（`Array.from(text).length`）计。

## 0. 常量

```
PKG_ID    = 'dsh-notify-toast'      // package.json name / 客户端 ModuleLoader id / 行 id / settings ns
VERSION   = '0.4.0'
RPC_CHANNEL = '/dsh-notify-toast'   // 官方 Connection RPC 频道（Host rpc.handle）
LOCALE_NS = 'dsh-notify-toast'      // 客户端 locale 命名空间
```

传输层结论（已核实 DSH 安装包内 `@deepseek-ai/dsh-client-connection` 源码与运行日志）：

- 首选官方 `ctx.connection.rpc.handle('/dsh-notify-toast', handler)`：由 Connection 包负责注册前缀路由、Host/Origin 栅栏与签名 cookie 认证。
- **DSH 0.2.1-rc.2 实测该 API 有 bug**：其内部 `HostConnectionService.rpc.handle` 在自己的 fiber 上读取 `webServer`，抛
  `cannot get property "webServer" without inject`（`dsh-client-connection/lib/index.js:871`），路由未注册。
- 因此插件实现**同路径回退路由**：用 `ctx.webServer.register({kind:'prefix', path:'/dsh-notify-toast', handler})` 注册同样的前缀路径，
  handler 内先调 `ctx.connection.requestRejection(req)` 复用官方 Host/Origin + 浏览器签名 cookie 栅栏，再按官方一元 RPC 信封
  `{type:'client-request', rpcId, method, payload}` → `{type:'server-response', rpcId, result}` 应答。
  这条回退链路与官方客户端 `connection.rpc.call` 完全兼容，客户端代码不变。
- Client：`ctx.connection.rpc.call('/dsh-notify-toast', endpoint, payload, signal)`（相对 URL，经页面同源/`dsh-app://app` 代理到 Host），
  返回 `{ok:true,value} | {ok:false,error}`（transport 信封）→ Host 业务值再见一层 `{ok:true,...}` / `{ok:false,error}`。
- 桌面壳与普通浏览器页面都适用，无需知道端口/令牌，也无需 EventSource。


## 1. 文件所有权（并行开发，勿越界写）

| 文件 | 负责人 | 说明 |
|---|---|---|
| `lib/index.js`, `lib/text.js`, `lib/config.js`, `lib/native-focus.js`, `lib/native-toast.js`, `lib/taskbar-badge.js` | host-dev | Host 半 |
| `lib/client.js` | client-dev | Client 半（单文件，CJS 包装，无 import） |
| `test/config.test.mjs`, `test/merge.test.mjs`, `test/text.test.mjs`, `test/rpc-route.test.mjs`, `test/goal-summary.test.mjs` | host-dev/lead | 单元/路由/goal 状态机探针 |
| `scripts/client-smoke.mjs` | client-dev | 用 Node 模拟 `window/__ModuleLoader__` 做加载冒烟 |
| `scripts/host-probe.mjs` | lead | 假 Cordis ctx + 真实 profile cwd 的 Host 集成探针 |
| `package.json`, `cordis.patch.yml`, `locale/*`, `icon.svg`, `README.md`, `docs/*`, `CHANGELOG.md`, `LICENSE` | lead | 不动 |

## 2. Host 半（lib/index.js）

### 2.1 导出

```js
export const name = 'dsh-notify-toast'
export const inject = []                    // 全部用 ctx.inject([...]) 可选注入
export const Config = <schemastery object>  // 见 §2.4；解析失败时导出 undefined
export function apply(ctx, config) { ... }  // 注册事件/路由/清理；无全局副作用
```

### 2.2 依赖注入（都用可选注入，缺失时降级而不是让插件不挂载）

- `ctx.inject(['connection', 'settings', 'sessions'], (child) => {...})` 里注册 RPC 频道与 settings 策略。
- 事件监听 `ctx.on('approval/request', ...)`、`ctx.on('user-questions/request', ...)`、`ctx.on('session/event', ...)` 挂在 apply 自己的 ctx 上（插件卸载自动清理）。
- 所有计时器必须用 `ctx.effect`/`ctx.timeout` 或显式清理；卸载后不得留 listener/timer。

### 2.3 浏览器传输（官方 channel 优先，同路径 webServer 路由回退）

- 路径：`/dsh-notify-toast`（前缀）。官方 `connection.rpc.handle` 可用时由它注册并认证；0.2.1-rc.2 上它会抛
  `cannot get property "webServer" without inject`，此时插件用 `webServer.register` 注册同一路径，并在 handler 最前面调用
  `connection.requestRejection(req)`（官方 Host/Origin + 签名 cookie 栅栏）——即同源校验仍由官方 Connection 层完成。
- 请求/响应信封（与官方一元 RPC 一致）：
  `{type:'client-request', rpcId, method, payload}` →
  `{type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error:{code,message,details}}}`。
- 端点（endpoint 字符集 `[A-Za-z0-9_$.-]+`，仅 POST + `application/json`）：

| endpoint | payload | 返回 value |
|---|---|---|
| `config` | `{}` | `{ok:true, version, ns, config, status:{settingsAvailable, nativeFocus, platform, clients, transport, configSource, stats, lastEvent}}` |
| `save` | `{patch:{...}}` | `{ok:true, config, status}`；非法字段/越界 `{ok:false,error:{code,message}}` |
| `poll` | `{after:number, wait:number}` | `{ok:true, events:[EventPayload...], next:number, serverTime:number}`；无事件时最多挂起 wait ms（夹 1000–25000） |
| `health` | `{}` | `{ok:true, version, ns, settingsAvailable, platform, nativeFocus, clients, status}` |
| `test` | `{}` | `{ok:true, queued:boolean}`；向事件队列发布 `kind:'test'` |
| `focus` | `{sessionId?:string}` | `{ok:true, native:boolean}`；尽力置前，绝不抛错 |
| `taskbar-badge` | `{count:number}`（0–99） | `{ok:true, count}`；0 清除，1–3 数字，>3 红点；未启用时返回 `{count:0,disabled:true}` |

- 事件队列：环形缓冲（最多 200 条）；`poll` 用 `after` 游标增量取；等待者由新事件立即唤醒；客户端断开由 AbortSignal 清理；插件卸载时全部 resolve 空结果并清理计时器。

`EventPayload`（JSON，Host 只发送**未截断的清洗后原文**，截断由 Client 按配置执行）：

```js
{
  id: number,                  // 单调递增，供 after 游标
  kind: 'question'|'approval'|'complete'|'test',
  at: number,                  // Date.now()
  sessionId?: string,
  sessionTitle?: string,       // 能取到就带（完成通知的备选正文）
  text?: string|null,          // question: 首个问题原文；complete: 最后回复首段（清洗后，≤400 字）；test: 固定文案
  toolName?: string,           // approval
  purpose?: string,            // approval: displayReason/ reason 的简短目的（已选语言，≤120 字）
  count?: number,              // complete 合并条数，默认 1
  sessionIds?: string[],       // count>1 且来自多个根会话时去重后的会话列表
  goalOutcome?: 'complete'|'paused'|'blocked' // goal 汇总结果
}
```

### 2.4 Config（schemastery，全部 `.volatile()`）

```js
{
  enabled: true,
  questionEnabled: true,
  approvalEnabled: true,
  completionEnabled: true,
  taskbarBadgeEnabled: true,  // 任务栏未读角标；方案 B，默认开
  titleOnly: false,
  bodyLength: 40,            // 20..60
  sound: 'ding',             // ding|chime|bell|soft|bubble|none
  volume: 60,                // 0..100
  mergeIntervalMs: 2500,     // 0..10000
  allDoneTitleEnabled: false,
  allDoneTitle: '所有任务均已完成', // 1..96 bytes
  goalSummaryEnabled: true   // goal 结束后汇总，默认开
}
```

- 用 `createRequire(join(process.env.DSH_PROFILE_DIR,'package.json'))('@deepseek-ai/schemastery')` 解析（顶层 await，失败则 `Config=undefined`）。
- `ctx.inject(['settings'], c => c.effect(() => c.settings.configure({auto:false}, ctx.fiber)))`。
- 运行期读配置：优先 `ctx.settings.describe().find(d=>d.ns===NS)?.value` 与默认值合并（缓存 ≤500ms + `settings/document-updated` 失效）；无 settings 时用 apply 收到的 config 合并默认值。
- 写配置：白名单 key + 类型/范围校验 → `await settings.update(NS, patch)` → 失效缓存 → `describe()` 回读；失败返回 400。

### 2.5 事件检测

1. `approval/request`：`(req, next) => { try{ publishApproval(req) }catch{} ; return next() }`（必须调用 next）。
2. `user-questions/request`：同上，`publishQuestion(request)`。
3. `session/event`：`goal/change` 更新 goal 状态；`user/message(source.kind=goal)` 记录已准入的 Goal Round；`turn/start` 跟踪 all-done；`turn/end` 在 goal active+armed 时只缓存，不逐轮发布；`goal/change` 的 complete/pause/block/clear、Round 上限或 `goal/activation-changed(disarmed)` 后按 `roundsStarted` 增量汇总一条。`goalSummaryEnabled` 默认开。
   - 全部完成标题（可选，默认关）：根会话 `turn/start` 进入 running 集合；同一时刻 ≥2 个根会话运行才 arm；`turn/end` 全部结束且无 error/aborted 时，用 `ctx.get('sessionTitle').rename(lastSession, allDoneTitle)` 改最后一个结束会话的标题；只有一个会话运行时不触发。
   - `isRoot`：`!session.header.parentSession && session.header.origin !== 'subagent'`。
   - 完成正文：从 `event.seq` 往前至多 200 个事件，找最近 `assistant/message`；取其中 `content[*].type==='text'` 的文本拼接，交给 `lib/text.js` 的 `firstParagraph()`；取不到 → `text:null`。
   - 合并：把完成放进 pending 批（记录最新 text/sessionId/count++），`mergeIntervalMs` 后发布一条 `kind:'complete'`（count>1 时带 count）。计时器必须可清理。
4. 去重：`kind+agentId+callId/toolName` 5 秒内重复同请求忽略；完成按 `sessionId+turn` 去重。
5. 发布到事件队列：环形缓冲最多 200 条；所有 `/poll` 等待者立即收到；无客户端时也缓存（页面稍后连上可取到，但客户端可自行决定不展示）。

### 2.6 窗口置前（lib/native-focus.js）

- 仅 win32；按参考实现从 `app.asar.unpacked` 多候选路径加载 koffi 原生 `.node`（`createRequire(join(dirname(modulePath),'index.cjs'))(modulePath)`）。
- user32：EnumWindows / IsWindowVisible / GetWindowTextW / ShowWindow(SW_RESTORE) / BringWindowToTop / SetForegroundWindow / AttachThreadInput / GetForegroundWindow / GetWindowThreadProcessId / keybd_event / kernel32.GetCurrentThreadId。
- 窗口匹配：优先用 `process.ppid`（Electron 主进程 PID）匹配窗口 PID；否则标题包含 `DeepSeek Harness`。
- 加载失败/调用失败返回 `false`，绝不抛错；导出 `focusDesktopWindow(): boolean` 与 `nativeFocusAvailable(): boolean`。

### 2.7 原生 toast helper（lib/native-toast.js / native-toast.ps1 / native-toast-helper.cs）

- `createNativeToastManager()` 启动 per-Host loopback activation server（随机 token；`/activate` 校验 token、notificationId；点击后发布 `activate`）。
- `show()` 通过 PowerShell 以 stdin 传 base64 JSON；helper 用 WinRT `ToastNotification` 显示 `<progress>`，同 kind 使用唯一 tag，旧 helper 不立即 kill，允许自然退场。
- helper 启动时后台 `warm()` 预编译 source-hash 缓存 DLL；首条通知不显示 toast；预热失败不影响正常展示/Web Notification 回退。
- 到达近似 duration 后停止进度更新，短暂缓冲后调用 `Hide()` 收回横幅；`ExpirationTime` 约束通知中心保留，`History.Remove` 不在到期时立即调用。

## 3. Client 半（lib/client.js）

- 单文件、CJS 包装、无 `import`/`require` 除 `require('react')`；`window.__ModuleLoader__.load({ id:'dsh-notify-toast', factory(require){ ... return {inject, apply} } })`。
- `inject: ['slots','locale','connection']`；`uiWorkspace` 用 `ctx.get('uiWorkspace')` 可选。
- `apply(ctx)`：
  1. `ctx.effect(() => ctx.locale.register(LOCALE_NS, {zh, en}))`；`const t = ctx.locale.bind(LOCALE_NS)`。
  2. 焦点状态：`focus/blur/visibilitychange` 监听（`ctx.on` 或 `ctx.effect` 清理），`isFocused()` 现算：`document.hasFocus() && document.visibilityState !== 'hidden'`。
  3. `call('config')` 拉配置/状态，失败重试；随后启动长轮询循环：`call('poll',{after,wait:25000}, signal)`，`after` 游标，指数退避 1s→15s，`ctx.effect` 清理 `AbortController`。
  4. 处理事件：`config.enabled` 为假则忽略（test 例外）；`kind==='test'` 强制展示+出声；其余 `isFocused()` 为真则跳过（不弹不响）。
  5. 展示：本地化标题（question/approval/complete/test 4 条）+ 正文；`titleOnly` → body=''；正文截断到 `bodyLength` 码点，超长加 '…'；approval 正文 = `toolName + ' · ' + purpose`；complete 无 text → `t('fallbackBody')`。
  6. 通知：`Notification.permission` 检查；`new Notification(...)` 兜异常；`silent:true`；不向平台传 `tag`（自管 map 关闭上一条）；不主动自动关闭（Windows 横幅自动收起，条目留在通知中心供稍后点击）；`onclick` → `call('focus',{sessionId})`（不 await 失败）→ `window.focus()` → `uiWorkspace.openSession(sessionId)`（有 sessionId 时）→ `close()`。
  7. 声音：4 个 Web Audio 合成预设（ding / chime / bell / soft）+ 内嵌的 uisfx CC0「弹一下」+ none 关闭；`volume` 映射 master gain；AudioContext 懒建、播放前 `resume()`、首次 `pointerdown`/`keydown` 解锁；资源解码失败回退合成音；`ctx.effect` 卸载时 `close()`；任何异常静默。
  8. 设置页：`settings.section` 注册（id=`dsh-notify-toast`, order=42, label thunk）；组件用 React hooks + 纯 HTML（`role="switch"` 自绘开关、`input[type=range]`、`select`、`button`），主题 token 用 `var(--dsw-alias-*, fallback)`；改动 250ms 防抖 `call('save',{patch})`；显示保存状态、通知权限、Host 连接、nativeFocus、settingsAvailable 状态；「发送测试通知」按钮 → `call('test')`（Host 无响应时本地直接展示并标注）。
  9. 权限：页面首次 `pointerdown`/`keydown` 且 `Notification.permission==='default'` 时 `Notification.requestPermission()`（一次）；测试按钮点击也可触发。
  10. 多窗口：用 `localStorage` 租约（`dsh-notify-toast:leader`，心跳 5s，15s 过期）+ `storage` 事件竞争，仅 leader 弹 toast/出声（settings 页仍各自可开）。
  11. 任务栏角标：仅 leader 在未聚焦的 `complete` 事件上维护本窗口的未读根会话 `Set`；`taskbarBadgeEnabled` 为真时按不同 `sessionId`（合并事件用 `sessionIds`）计数，`call('taskbar-badge',{count})`；1–3 深灰底白字蓝环数字、>3 红点；窗口聚焦/点击任务栏、关闭设置或卸载时 `call('taskbar-badge',{count:0})`。Host helper 一次性调用 `ITaskbarList3::SetOverlayIcon`，不常驻。
- 卸载清理：所有 `ctx.effect` 返回 disposer；长轮询 Abort、AudioContext close、监听移除、任务栏角标清零。

## 4. 验收命令

```
npm test                                       # text/config/merge/rpc-route/goal-summary/native-toast 单元测试
npm run smoke                                  # scripts/client-smoke.mjs 客户端加载/行为冒烟
npm run probe                                  # scripts/probe-rpc.mjs RPC 探针（--self-check / --url）
node scripts/host-probe.mjs <profileDir>       # Host 集成探针（真实 profile cwd）
npm pack                                       # 交付 tgz
```

## 5. 参考实现（MIT，学习思路，不整段抄）

- chromoany/dsh-notify-me：焦点/权限/设置页/多窗口 leader/通知降级
- BillCx330/dsh-plugin-notify-sounds：koffi user32 置前、`connection.requestRejection` 路由栅栏、volatile Config + configForms
- Laplace-bit/dsh-bell-notify：Web Audio 合成、settings 传输降级
