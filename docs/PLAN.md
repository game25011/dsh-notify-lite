# dsh-notify-lite — 实现方案（历史，0.1 时代）

> **历史文档**：这份开工方案保留作记录，不再维护，也不会进入 npm 包。当前实现、配置和限制以 `README.md` 与 `docs/INTERFACE.md` 为准。
> 文中「非目标」「提示音 3 种」「0.1.0」等表述已被 0.3.0 实现取代；不要据此判断当前行为。

## 1. 目标与边界

- DSH 窗口未聚焦时，用 Windows 原生 toast 提醒：①需要回答/确认 ②需要授权 ③根会话任务完成（子代理不触发）。
- 聚焦时完全不打扰（不弹、不响）；点击通知回到 DSH，能定位会话就定位。
- 提示音由插件用 Web Audio 合成，通知 `silent: true`，避免系统音叠加。
- 非目标：任务栏角标/托盘/常驻进程/PowerShell·Win32 助手/改核心/联网/遥测/模型调用。
- 持久化只用官方 settings（插件 Config 的 volatile 字段 → profile patch），不自建配置文件。

## 2. 已确认的本机 API（0.2.1-rc.2，来自运行时 inspect + 安装包源码）

### 2.1 触发事件（Host，`cordis_inspect_query` Event/Service 实证）

| 需求 | 事件/服务 | 契约 |
|---|---|---|
| 需要授权 | `approval/request`（waterfall） | `(req: ApprovalRequestEvent, next)`；`req.agent.id`、`toolName`、`reason?`、`displayReason?`；监听器必须 `return next()` |
| 需要回答/确认 | `user-questions/request`（waterfall） | `(request: AskUserQuestionRequestEvent, next)`；`request.questions[0].question`、`intent.kind==='plan-review'`；必须 `return next()` |
| 根会话完成 | `session/event`（emit）+ `Session` | `(session, event)`；`event.type==='turn/end' && event.data.reason.kind==='completed'`；`session.header.origin!=='subagent' && !session.header.parentSession` 判根会话 |
| 回复正文 | `Session.eventAt(seq)` / `snapshotEvents()` | 从 `turn/end.seq` 往前找最近的 `assistant/message`，取 `data.message.content` 的 `text` 块（纯读日志，不调模型） |
| Host 路由 | `ctx.webServer.register({kind:'exact',path,handler})` | `handler(req,res)`；`ctx.connection.requestRejection(req)` 做信任栅栏 |
| 设置持久化 | `ctx.settings`（`describe/update`） | `describe()` 返回 `{ns, value, revision, ...}`；`update(ns, patch)` 只接受 Config 里 `.volatile()` 的字段，写入 profile patch；`configure({auto:false}, ctx.fiber)` 隐藏自动表单 |
| 配置 schema | `@deepseek-ai/schemastery`（profile 内 3.18.5，`createRequire(DSH_PROFILE_DIR/package.json)` 解析） | 用 `.volatile()` 声明可热写字段；loader 只依赖 `schema['~standard'].vendor==='schemastery'`，跨实例安全 |
| 窗口置前 | `koffi` 原生 `.node`（`resources/app.asar.unpacked/dsh/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node`） | 直接 `createRequire(...)(path)` 加载，`user32` EnumWindows / ShowWindow / SetForegroundWindow / AttachThreadInput + ALT 轻敲；失败降级 `window.focus()` |

### 2.2 客户端（静态 Web 插件）

- 格式：`window.__ModuleLoader__.load({ id:'dsh-notify-lite', factory(require){ const React=require('react'); return {inject:[...], apply(ctx){...}} } })`；`dsh.client = { platform:'web', immediately:true, inject:[...] }`（必须在页面启动时立即挂载，后台监听才能工作）。
- 设置页：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id:'dsh-notify-lite', order:42, label:()=>t('nav'), locale:NS, inject:()=>({t}) }, Component))`。
- Client 服务：`slots`、`locale`（`register/bind/getLocale/subscribe`）、`uiWorkspace.openSession(sessionId)`。
- Toast：`new Notification(title,{body,silent:true})`（Electron 下即 Windows 原生 toast）；`Notification.permission` 做降级；`onclick` → 先 `POST /focus`（Host 置前）再 `window.focus()` 并 `openSession`。
- 焦点：`document.hasFocus()` + `visibilityState` + `window` focus/blur + `visibilitychange`。
- 声音：Web Audio 合成 3 种预设（风铃/清铃/轻点），音量 0–100，首次用户手势后 `resume()`；失败静默降级。
- 页面 origin 是 `dsh-app://app`，同源相对 `fetch('/api/notify-toast/...')` 由 Electron 自定义协议转发到 Host 并自动带认证 cookie（`forwardWebRequest` 保留流式、改写 cookie），因此插件不需要知道端口/令牌。

### 2.3 安装（官方插件管理器）

- 开发期：`plugin_manager action=install_bundle target=<绝对目录>`（本地目录为 link）。
- 交付：`npm pack` 生成 tgz，用 `plugin_manager install_bundle target=<tgz 绝对路径>` 或 `dsh plugin --profile desktop add <tgz>` 安装/升级；`remove_bundle` 卸载。
- 不手改 profile 的 `package.json` / `cordis.patch.yml`；插件自己的 `cordis.patch.yml` 只 insert 一行 `id: dsh-notify-lite`。

## 3. 架构（Host 检测 + Client 展示，长轮询传输）

```
Host (lib/index.js)                          Client (lib/client.js)
approval/request ─┐                          ┌─ settings.section 设置页
user-questions/request ─┼─ 清洗/截断/合并 ─→ 事件环形队列 ←─ RPC poll(after, wait=25s)（聚焦/未聚焦由 Client 判断）
session/event(turn/end, root) ─┘             ├─ new Notification({silent:true})
ctx.settings (volatile Config) ←─ RPC save    └─ Web Audio 提示音
浏览器路由 /dsh-notify-lite：config / save / poll / health / test / focus
同源栅栏：connection.requestRejection（官方 Host/Origin + 签名 cookie）
koffi user32 window focus ← RPC focus
```

> 实施备注：DSH 0.2.1-rc.2 的官方 `connection.rpc.handle` 自身抛 `cannot get property "webServer" without inject`，
> 故实际实现为「官方 channel 优先 + 同路径 webServer 前缀路由回退」，信封与栅栏仍用官方实现；详见 `docs/INTERFACE.md` §2.3。

- **为什么 Host 检测**：`approval/request`、`user-questions/request`、`session/event` 是权威事件，覆盖任意会话（含后台会话），且不需要客户端已经 retain 该会话；客户端只负责「未聚焦时展示」。
- **为什么长轮询**：页面 origin 是 `dsh-app://app`，自定义协议转发保留流式但 SSE 行为未验证；长轮询是普通请求/响应，穿透代理与后台节流都稳定，且 Host 端可被 `curl` 直接验收。空闲时每 25 s 一次请求，事件到达即刻返回。
- **根会话判定**：`SessionHeader.parentSession === undefined && origin !== 'subagent'`。
- **合并**：Host 对完成事件按 `mergeIntervalMs`（默认 2500 ms）聚合成一条，正文取最后一条有效回复，带 `count`。
- **隐私模式**：`titleOnly=true` 时正文留空，只发标题。

## 4. 设置项（v0.1.0 全部可配、即时生效、官方持久化）

| key | 类型/范围 | 默认 |
|---|---|---|
| enabled | boolean | true |
| questionEnabled / approvalEnabled / completionEnabled | boolean | true |
| bodyLength | 20–60 | 40 |
| titleOnly | boolean | false |
| sound | ding / chime / bell / soft / none | ding |
| volume | 0–100 | 60 |
| mergeIntervalMs | 0–10000 | 2500 |

## 5. 验收场景

1. 聚焦时提问/审批/完成：无 toast、无声音。
2. 失焦时提问/审批/完成各一次原生 toast；正文截断到 N 字（20/40/60 各测一次）+ 省略号；审批正文为「工具名 + 短目的」；完成正文为最后回复首段。
3. 点击通知：窗口置前 + 打开对应会话。
4. 2.5 s 内两次完成只出一条。
5. 子代理完成不提醒；根会话完成提醒。
6. 设置页改动即时生效；重启 DSH 后仍保留。
7. 通知权限拒绝时：设置页显示状态、不崩溃；声音失败静默降级。
8. 卸载后：不再提醒、Host 路由 404、无计时器/监听残留。
9. 文本清洗/截断有单元测试（node --test）。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| `dsh-app://` 代理下自定义路由行为未知 | 用普通 JSON 长轮询而非 SSE；先用 `curl` 直连 Host 验收路由，再在页面验收 |
| Electron 后台节流影响轮询 | 长轮询由 Promise 链驱动，不使用 `setInterval`；错误退避才用定时器 |
| 通知权限 / Windows 通知中心策略 | `Notification.permission` 状态展示 + 请求按钮；拒绝时声音/标题仍可用；不崩溃 |
| koffi 路径/版本变化 | 多候选路径探测；加载失败只降级 `window.focus()`，不影响 toast |
| 聚焦判定在多窗口/遮挡下失真 | `hasFocus() + visibilityState` + blur/focus 事件；事件到达时才算焦点，不缓存 |
| 官方 settings 实现要求 `.volatile()` | Config 全字段 volatile；`describe()` 读实时值；`settings` 缺失时内存默认值降级 |
| 插件 HMR/重启边界 | 安装后如未生效，明确告知用户需重启 DSH，不擅自重启 |

## 7. 交付物

- 源码：`<插件源码目录>`
- 安装包：`dsh-notify-lite-0.1.0.tgz`（`npm pack`）
- 文档：`README.md`（功能/配置/兼容/已知限制）、`CHANGELOG.md`、本方案、`docs/TEST-REPORT.md`
- 安装/升级/卸载命令与验收记录。
