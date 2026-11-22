# dsh-notify-lite 0.1.0 — 测试与验收报告（历史）

> 0.3.0 注：本文件是 0.1.0 的历史报告，不应作为当前验收结论。0.3.0 当前自动测试为 `npm test` 94/94、client smoke 25/25（goal 汇总与原生生命周期），并已完成原生进度 toast、点击回调和真实 DSH 点击回会话验证；详见 README、CHANGELOG 与 0.3.0 维护记录。

> 环境：Windows 10/11 · DeepSeek Harness Desktop `0.2.1-rc.2`（Electron 壳）· profile `desktop` · 页面 origin `dsh-app://app`
> 记录时间：2026-10-18（Asia/Shanghai）
> 结论：见文末「验收结论」。

## 0. 验证手段与边界

| 层 | 手段 | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| 文本/配置/合并/路由 | `npm test`（5 个测试文件，68 项） | 清洗、截断、根会话判定、合并、配置校验、RPC 信封/栅栏/断开清理 | 真实事件负载到达 UI |
| Client 加载/行为 | `npm run smoke`（23 项，Node `vm` 模拟 `__ModuleLoader__`/Notification/AudioContext） | factory/apply、双语字典、toast/声音/点击/焦点/设置保存/降级/清理 | 真实浏览器里 React 渲染外观 |
| Host 集成 | `npm run probe`（假 Cordis ctx + 真实 profile cwd） | schemastery 解析、回退路由注册、官方 RPC 信封、settings 读写、环形缓冲、清理 | 真实 host 进程内的完整事件流 |
| 插件安装/激活 | 官方 `plugin_manager` + Host `Config.listConfigs` | bundle 安装、Host 行激活、Config schema 注册 | toast 是否真的弹出 |
| 浏览器路由 | `curl http://127.0.0.1:<port>/dsh-notify-lite/health` | 路由已挂载、`connection.requestRejection` 栅栏生效（401） | 带签名的页面请求是否成功 |
| 设置页注册 | Client Inspect `Slots.listSubTree settings.section` | 客户端 bundle 已加载、设置页 occupant 出现（id/order 正确） | 页面外观/交互手感 |
| 端到端通知 | 用户前台试用（聚焦/失焦/提问/审批/完成/点击/声音） | 真实 Windows toast、声音、点击回窗 | 本机无 GUI 眼动/通知中心读取能力 |

> 说明：本机为无 GUI 眼动的自动化环境，无法替用户点击界面或读取 Windows 通知中心；端到端 toast 由第 5 节手工验收清单覆盖，并已在第 4 节记录所有可自动观察的环境证据。

## 1. 单元测试（68/68 通过）

```
npm test
  test/text.test.mjs        19 passed / 0 failed
  test/config.test.mjs      17 passed / 0 failed   （含真实 profile schemastery 的 schema 校验）
  test/merge.test.mjs       11 passed / 0 failed
  test/rpc-route.test.mjs   12 passed / 0 failed   （信封/栅栏/缺失 requestRejection 的 fail-closed/405/404/415/400/413/业务失败/断开 Abort）
  test/all-done.test.mjs     9 passed / 0 failed   （单会话不触发、多会话 arm、最后会话改名、非 completed 不触发、开关/标题配置、dispose）
```

覆盖：Markdown/代码围栏清洗、首段提取、码点截断与省略号、默认值与范围校验、volatile Config schema、
完成合并窗口（count/最新正文/去重/dispose 清计时器）、RPC 路径解析、官方 server-response 信封、
`requestRejection` 栅栏透传、长轮询客户端断开时 AbortSignal 生效。

## 2. Client 冒烟（23/23 通过）

```
npm run smoke
  client smoke test: 23 passed, 0 failed
```

覆盖：factory/inject/apply；zh+en 字典一致；正文长度/隐私/审批/完成回退；焦点计算；
`settings.section` 注册（id `dsh-notify-lite`、order 42、label、locale、inject）；config/poll 载荷
`{after:0,wait:25000}`；首次手势请求通知权限 + 解锁音频（仅一次）；未聚焦时 `silent:true` toast + 风铃振荡器；
审批正文「工具名 · 目的」+ 点击后 focus RPC/window.focus/openSession；聚焦时完全跳过；开关与防抖保存；
Host 业务拒绝显示保存失败；dispose（abort、关闭 AudioContext、释放 leader 租约、移除监听、无未处理 rejection）；
重复加载/重复 apply 与畸形 RPC 响应不崩溃。

## 3. 安装与激活（真实设备）

| 项 | 结果 |
|---|---|
| 安装方式 | `plugin_manager install_bundle` → `target: <插件目录绝对路径>` |
| 安装结果 | `application: applied`，`enabled: true`，`warnings: []` |
| profile 记录 | `desktop/package.json`：`"dsh-notify-lite": "link:<plugin-dir>"`，bundles 末尾含 `dsh-notify-lite` |
| 实体 | `profiles/desktop/node_modules/dsh-notify-lite` 为 link；改代码 + 插件开关触发的 recomposition 即可生效 |
| Host 行 | `plugin_manager list_plugins`：`include:dsh-notify-lite`，`fiberPhase: active`，`enabled: true` |
| Config schema | `cordis_inspect_query Config.listConfigs name=dsh-notify-lite` → `status: "schema"`（schemastery 解析成功，settings 可持久化） |
| 设置页 | Client Inspect `settings.section` occupants 含 `{id:"dsh-notify-lite", order:42, active:true}`（客户端 bundle 已加载） |
| Host 代码生效 | 通过官方插件开关触发的 profile recomposition 载入最终 Host 代码（无需整机重启）；路由探针由修复前的 `405` 变为 `401`（已挂载 + 栅栏生效） |

## 4. 运行时证据

运行中实例：`DeepSeek Harness.exe`（host PID `<pid>`，2026-10-18 12:25 启动），HTTP 监听 `127.0.0.1:<port>`。

Host 路由探针（不带浏览器 cookie，验证「路由已注册 + 认证栅栏生效」）：

| 请求 | 结果 | 解读 |
|---|---|---|
| `POST /dsh-notify-lite/health`（无 Origin） | **401** | 路由存在，`requestRejection` 认证栅栏生效 |
| `GET /dsh-notify-lite/health` | **401** | 同上（栅栏先于方法检查） |
| `POST /random-xyz/health`（对照） | **405** | 未注册路由；说明 401 并非全局默认 |

- **Host 集成探针**（`npm run probe`，真实 profile cwd）：
  - `Config: resolved | source: cwd`（Host 进程 cwd = profile 目录，修复了 `DSH_PROFILE_DIR` 缺失时的 schema 解析）；
  - 回退路由 `prefix /dsh-notify-lite` 注册 1 条；`requestRejection` 拒绝 → 403；
  - `config`：`transport: "route"`、`settingsAvailable: true`、默认配置完整；
  - `save`：`settings.update("dsh-notify-lite", {bodyLength:55,sound:"bell"})` 被调用；越界值被业务拒绝且不写 settings；
  - `test` + `poll`：事件入环形缓冲、`after` 游标返回、`next` 递增；
  - `focus`：返回 `{ok:true,native:true}` 且不抛错；
  - 卸载清理：3 个 effect disposer 全部执行。
- **koffi 置前**：独立 Electron-as-Node 探针（`resources/app.asar.unpacked/.../koffi.node`，koffi 3.1.1），
  按 `process.ppid` 匹配 DSH 主窗口并执行 `ShowWindow/BringWindowToTop/ALT 轻敲/AttachThreadInput/SetForegroundWindow`，
  `GetForegroundWindow() === target` 返回 `true`；Host 探针 `nativeFocus: true`。
- **页面 ↔ Host 连接**：Host 端口存在多条来自 Electron 主进程的 ESTABLISHED 连接（页面请求经 `dsh-app://app` 代理 + undici 连接池），
  说明页面仍在持续访问 Host；长轮询的具体状态需在设置页「Host 连接」上人工确认。
- **诊断日志（已删除）**：修复前 `.host-debug.log` 记录过 0.2.1-rc.2 官方 `connection.rpc.handle` 抛
  `cannot get property "webServer" without inject`；当前代码的回退分支与 401 探针结果一致。

## 5. 手工验收清单（用户试用）

打开 **设置 →「通知」**，先点一次页面（解锁音频），然后：

| # | 场景 | 期望 | 结果 |
|---|---|---|---|
| 1 | DSH 聚焦时触发提问/授权/完成 | 无 toast、无声音 | ✅ 用户确认（聚焦静默） |
| 2 | DSH 失焦时提问 | 原生 toast「DSH 想问你一个问题」+ 问题前 40 字 + 叮咚 | ✅ 用户确认（原生 toast 通道） |
| 3 | DSH 失焦时授权 | toast「DSH 需要你的授权」+「工具名 · 目的」 | ✅ 用户确认（原生 toast 通道） |
| 4 | DSH 失焦时根会话完成 | toast「DSH 完成了一项任务」+ 最后回复首段 | ✅ 用户确认（原生 toast 通道） |
| 5 | 设置页「发送测试通知」 | 立即出现测试 toast + 可闻提示音（测试不受聚焦限制） | ✅ 用户确认 |
| 6 | 正文长度 20/40/60 | 截断位置正确、超出有「…」 | ⚠️ 单元/冒烟覆盖；未逐档人工目测 |
| 7 | 隐私模式开启 | 只有标题、正文空 | ⚠️ 单元/冒烟覆盖；未人工目测 |
| 8 | 2.5 s 内两次完成 | 只出现一条合并 toast | ⚠️ 合并调度单测覆盖；未人工制造并发 |
| 9 | 点击 toast（含 DSH 最小化） | 从最小化恢复、置前并打开对应会话 | ✅ 用户确认（最终验收点） |
| 10 | 子代理完成 | 不提醒 | ⚠️ 代码按 `origin==='subagent'` 过滤；未人工构造子代理完成 |
| 11 | 提示音切换/音量 0/关闭 | 即时生效，0/关闭无声 | ⚠️ 冒烟覆盖；用户确认基本音效可用 |
| 12 | 重启 DSH | 设置页「设置持久化：官方设置」，配置保留 | ⚠️ 多次重启后插件/设置正常；未逐字段核对 |
| 13 | 卸载插件 | 不再提醒、设置页条目消失 | ⚠️ 按官方卸载步骤，未在本轮执行（见 README） |
| 14 | 通知权限拒绝 | 不崩溃、设置页显示状态 | ⚠️ 冒烟覆盖拒绝路径；未在系统层复验 |

## 6. 已知限制复核

- 页面必须打开：设置页与长轮询都依赖页面，符合设计。
- 首次声音需一次用户手势：client 冒烟已验证一次性解锁逻辑；真实环境需点一次页面。
- koffi 不可用降级 `window.focus()`：`status.nativeFocus` 已暴露给设置页。
- 多窗口 leader：client 冒烟覆盖租约与 storage 竞争解析。
- 0.2.1-rc.2 官方 `connection.rpc.handle` bug 已由同路径回退路由绕过（见 CHANGELOG）。
- 单条正文 ≥40 字截断、隐私模式、完成合并等规则已在单元/冒烟测试中覆盖。

## 6.1 试用反馈迭代（2026-10-18 13:xx）

用户先反馈「只有声音、几乎听不到提示音，且不喜欢默认风铃」；随后更正为**声音一直正常，真正的问题是看不到右下角弹出提示**（期望像 Codex：几秒自动消失、点击回到对应会话）。本轮改动：

- **无声根因加固**：旧实现只有 `resume()` 成功后才排程音符；当 AudioContext 因自动播放策略处于 suspended 且 `resume()` 被拒/未决时，声音会被静默丢弃。
  现改为：**先排程、再 resume**；测试按钮点击（用户手势）先同步 `unlockAudioContext()`；首次手势用 20ms 近静音振荡器 prime；master gain 0.35→0.5 并加 DynamicsCompressor。
- **新增默认提示音「叮咚」（ding）**，保留 风铃/清铃/轻点/关闭；设置页提示音旁新增「试听」按钮，切音效即时试听。
- **新增「提示音引擎」状态行**（已就绪/待解锁/未初始化）用于诊断无声。
- Host Config 枚举/默认值同步更新（已通过插件开关触发重新组合；schema 实测 `sound.default = "ding"` 且枚举含 `ding`）。
- 回归：单元测试 68/68、Client 冒烟 23/23 全通过；RPC 路由 401 对照 405 栅栏仍生效。

## 6.2 原生 toast 诊断（2026-10-18 13:xx，第二轮反馈）

用户确认声音正常，缺的是**屏幕右下角 Windows 原生 toast 弹窗**（像 Codex 那样在 DSH 之外可见），并明确**不接受应用内弹框**（窗口内的方框在切换到其它应用时不可见，因此无用）。

- **定位**：Windows 注册表里存在 `electron.app.DeepSeek Harness` 通知条目且 `LastNotificationAddedTime` 为最近时间；全局 `ToastEnabled=1`。
  说明 DSH/Electron 已经把通知交给 Windows（至少在通知中心层），弹不弹横幅取决于 Windows 通知横幅/专注助手等系统设置。
- **修复「测试系统通知」误报**：先前诊断按钮误传 3 个构造参数，Electron 将第二个字符串参数按 `NotificationOptions` 校验并抛
  `Failed to construct 'Notification': The provided value is not of type 'NotificationOptions'`；正常通知路径使用的是 2 参数，不受影响。
  现已改为 `new Ctor(title, { body, silent: true })`。
- **移除应用内兜底卡片**：按用户反馈，事件只走 Windows 原生 toast，不再在 DSH 窗口内弹卡片。
- **保留诊断**：设置页「系统通知」块（尝试/创建/显示/失败 + 最近错误）与「测试系统通知」按钮，便于判断是权限、构造还是系统横幅问题。
  原生 toast 自动关闭时间 15s → **6s**；`permission==='default'` 时构造前再请求一次权限。
- 回归：`node --check` 通过；单元测试 68/68；Client 冒烟 23/23；Host schema 已通过插件开关重新组合为最终版（`sound.default="ding"`，无多余字段）。

## 6.3 点击回窗修复（2026-10-18 14:xx，第三轮反馈：最小化时点通知不拉起）

用户确认 toast 已正常弹出；问题变为**DSH 最小化时点击通知不会把窗口拉起来**。

- **真实窗口探测**（Electron-as-Node，对真实 DSH 窗口）：
  - Electron 主进程名下存在多个同 PID 可见顶层窗口：`Chrome_WidgetWin_1`（真正主窗口）、`OleDdeWndClass / DDE Server Window`、
    `MSCTFIME UI`、`Default IME`。旧实现按 PID 取“第一个可见且有标题”的窗口，可能命中 DDE/IME 窗口，
    于是 `ShowWindow/SetForegroundWindow` 打到了错误窗口，看起来就是“点了没反应”。
  - 修正后的匹配：过滤非应用类窗口，按 `Chrome_WidgetWin*` 类（+50）与「DeepSeek Harness」标题（+100）、父 PID（+20）打分，
    逐个候选执行 `ShowWindow(SW_RESTORE)` → `ALT 轻敲` → `AttachThreadInput` + `SetForegroundWindow` → 验证前台窗口。
  - 探针实测（最小化后调用修正版 `focusDesktopWindow()`）：`iconic=false`、`GetForegroundWindow()===目标窗口`，恢复成功；
    候选打分输出示例：DSH 主窗口 150 分，浏览器 Chrome 窗口仅 50 分（被主窗口优先）。
- **点击链路**：toast 不再 6 秒后主动 `close()`（关闭会同时从通知中心移除，稍后点击就无事件）；
  点击同时挂 `onclick` 与 `addEventListener('click')`（去重），focus RPC 失败/`native=false` 自动重试 3 次；
  设置页「系统通知」新增 `点击 / 置前成功 / 置前失败` 计数 + 最近错误，便于确认点击事件是否到达页面。
- **注意**：Host 侧窗口定位代码属于模块级修复，需重启 DSH 一次才能加载（客户端部分可热更新）。
- 回归：`node --check` 通过；单元测试 68/68；Client 冒烟 23/23；本轮不再使用应用内卡片。

## 6.4 用户最终试用（2026-10-18 15:05）

重启 DSH 加载修正后的 Host 窗口定位代码后，用户回复 **「试用成功」**：Windows 右下角原生 toast 正常弹出，
**DSH 最小化时点击通知可将其恢复并置前**（最终验收点通过）。

## 7. 验收结论

**验收通过** —— 自动化（单元 68/68、Client 冒烟 23/23、Host 集成探针、真实窗口 focus 探针）+ 真实设备端到端试用均通过：

- Windows 原生 toast：右下角弹出、Windows 自动收起进通知中心、点击回窗（含最小化恢复）——用户确认；
- 触发时机、聚焦静默、声音（叮咚默认，可试听/切换/调音量/关闭）、正文截取与合并、设置页持久化——自动化覆盖，核心行为用户确认；
- 安装方式：官方 `plugin_manager install_bundle`（本地目录 link），Host 行 active、Config schema 正常、RPC 路由 401/405 探针正常。

未逐项人工复验的次要项（正文长度 20/60 档位、隐私模式外观、并发完成合并、子代理完成过滤、卸载清理、权限拒绝外观）已在单元/冒烟测试中覆盖，
如需可在后续试用中继续确认；这些不影响核心交付。

已知限制与环境依赖见 README「已知限制」：页面需打开、Windows 通知横幅/专注助手会决定是否显示横幅、首次声音需一次用户手势、
点击置前依赖 DSH 自带 koffi（失败降级 `window.focus()`）、0.2.1-rc.2 官方 `connection.rpc.handle` bug 已由同源回退路由绕过。
