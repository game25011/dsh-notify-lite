# 轻量原生通知（Windows）

**轻量 · 原生 · 可扩展 · 不打扰**

中文 | [English](./README.en.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/game25011/dsh-notify-toast/actions/workflows/ci.yml/badge.svg)](https://github.com/game25011/dsh-notify-toast/actions/workflows/ci.yml)
![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-blue)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4)

> dsh-notify-toast 是一款适用于 Windows 10/11 的非官方 DSH 插件（MIT 协议）。它提供聚焦不打扰的后台提醒，通过 Windows 原生通知提示提问、授权与根会话完成；任务栏未读角标按不同根会话计数，同一会话多次完成算一个，1–3 显示数字，超过 3 显示红点。主要代码由 AI 编程助手生成，人类维护者负责需求、调试、测试与发布。

- 源码/本地包名：`dsh-notify-toast` · 版本：`0.4.1` · 许可：MIT · 仓库：https://github.com/game25011/dsh-notify-toast
- npm 状态：**尚未发布**；不要执行 `npm install dsh-notify-toast`（该名称在 npm 上属于另一个项目）
- 适用：DeepSeek Harness Desktop `0.2.1-rc.2`（Electron 壳，profile `desktop`），Windows 10/11
- 形态：DSH 官方 bundle（Host + Web Client 两半），通过官方插件管理器安装/卸载
- 状态：0.4.1 修复审批通知漏发；0.4.0 新增任务栏未读角标（方案 B：不同根会话计数）；0.3.0 原生进度 toast、bar-only 样式、自动收回、点击回会话与 Goal 汇总已在本机简单实测；Goal 边界场景仍待补测；「全部完成后改写标题」为可选功能（默认关）
- 截图：![Windows 原生进度通知](docs/assets/native-toast.png)

## 0.4.1 更新

修复审批通知可能不出现的问题：DSH 的 `approval/request` 是 waterfall，UI 审批应答器可能先处理并短路；插件观察者已改为 `prepend + global`，发布通知后始终 `next()` 委托，不改变审批结果。

## 维护方向

目标是把插件做成**轻量、原生、可自我拓展、不打扰**的 Windows 通知层，并长期保持更新。

- **轻量**：不常驻托盘或后台服务，helper 按需启动。
- **原生**：使用 Windows 原生 toast 和任务栏 overlay API。
- **可自我拓展**：MIT 许可，Host/Client/原生 helper 分层，配置和 `docs/INTERFACE.md` 开放；使用者可以调整设置、自行 fork，或按接口增加通知类型、声音和路由。当前没有在线脚本或第三方运行时扩展 API，深度定制需要改代码。
- **持续更新**：优先兼容性、安装可靠性和真实反馈，不追求功能堆叠。

## 特色

轻量级 DSH 通知插件，无常驻后台，helper 按需启动。联动提示音、Windows 原生通知与任务栏未读角标，依实际使用经验覆盖约 90% 日常提示场景（经验估测，非绝对保证）。采用 MIT 协议与 Host/Client/原生 helper 分层架构，支持修改配置与 fork 扩展（暂无在线脚本 API，深度定制需修改代码）。主体代码由 AI 辅助生成，人类维护者负责需求把控、调试、测试与发布维护，并以持续跟进 DSH 兼容为目标。
## AI 参与说明

本项目的主要代码（Host、Web Client、PowerShell/C# 原生 helper 及多数测试/文档）由 AI 编程助手生成；人类维护者负责需求、调试、测试、发布和维护。AI 生成内容可能存在错误，欢迎提交 issue 或 pull request。本项目采用 MIT License，AI 工具不是作者、版权持有者或责任主体，本说明不构成法律意见。详见 [AI-DISCLOSURE.md](AI-DISCLOSURE.md)。

> 命名说明：中文显示名仅用于界面展示；npm 包名、目录、Host 行 id、settings 命名空间与 RPC 前缀保留 ASCII `dsh-notify-toast`；插件清单公共 id 为 `dsh.notify-toast`。

---

## 功能

| 能力 | 行为 |
|---|---|
| 需要回答/确认 | `user-questions/request` 触发；标题「DeepSeek 想问你一个问题」，正文为问题原文前 N 字 |
| 需要授权（审批） | `approval/request` 触发；标题「DeepSeek 需要你的授权」，正文为「工具名 · 简短目的」 |
| 本轮回复结束 | `session/event` 的 `turn/end(completed)` 触发；仅根会话，子代理默认不触发；单步标题「DeepSeek 搞定了一小步」，2–4 步「DeepSeek 一口气推进了 N 步」，5 步及以上「DeepSeek 火力全开，连推了 N 步」；正文取最后一条助手回复首段有效文字，取不到写「点击查看」 |
| 目标模式汇总 | goal `active + armed` 期间不逐轮提醒；在 `complete` / `paused` / `blocked` / Round 上限 / `disarmed` 后按 `roundsStarted` 增量只发一条；暂停/受阻使用中性标题；提问/授权仍即时 |
| 只在未聚焦时提醒 | 事件到达时实时判断 `document.hasFocus()` / `visibilityState`；聚焦时不弹、不响 |
| 任务栏未读角标 | DSH 在后台时，在 DSH 任务栏图标上显示有完成结果的**不同根会话数**（方案 B）；同一会话完成多次只计 1 个。1–3 显示深灰底、白字、蓝色细环的数字角标，超过 3 个显示红点；回到 DSH 后自动清除；设置页可关闭 |
| Windows 原生进度 toast | Host 通过 PowerShell/C#/WinRT 创建 Windows 系统通知；通知内含动态 `<progress>` 进度条；到达近似时间后停止更新，短暂缓冲后收回横幅；通知中心保留由 ExpirationTime 约束，不写自绘窗口 |
| 兼容降级 | 原生 helper 不可用或启动失败时自动退回 Web Notification；两条路径都 `silent`，声音由插件统一播放一次 |
| 正文长度 | 默认 40 字（Unicode 码点），可配 20–60；超出截断加「…」 |
| 隐私模式 | 只显示标题，正文留空 |
| 提示音 | Web Audio 合成 4 种（叮咚/风铃/清铃/轻点）+ 1 个 CC0 开源音效「弹一下」，音量 0–100，可关闭、可试听；首次用户手势后解锁；失败静默降级 |
| 点击回窗 | 先由 Host 用 Windows `SetForegroundWindow` 把 DSH 窗口置前，再尽力打开对应会话；koffi 不可用时降级 `window.focus()` |
| 合并 | 默认 2.5 s 内的多个「完成」合并为一条，避免连环弹 |
| 全部完成后改写标题 | 可选（默认关）：多个会话同时运行时，等全部会话都成功结束，把最后结束的会话标题改为指定文案；只有一个会话运行时不生效 |
| 设置页 | DSH 设置 →「通知」：启用/提问/授权/本轮回复/任务栏未读角标/目标模式结束后汇总开关、通知显示方式（原生进度/兼容）、自动移除时间、正文长度、隐私模式、提示音（可试听）、音量、合并间隔、测试通知/测试系统通知、状态诊断 |
| 持久化 | 官方 `ctx.settings`（插件 Config 的 volatile 字段 → profile patch），重启 DSH 后保留；不写自建配置文件 |
| 降级 | 通知权限拒绝 / 环境不支持 / Host 不可用 / `settings` 缺失 / koffi 加载失败：不崩溃，设置页显示状态 |

### 明确不做

常驻托盘/后台服务、任务栏进度条/闪烁动画；任务栏角标只在任务栏 helper 的一次性调用中更新，不增加常驻进程。不访问外部网络、不修改 DSH 核心、不遥测、不调用模型。

---

## 安装

> 本插件只通过 **官方插件管理器** 或 GitHub Release 安装；不要手改 profile 的 `package.json` 或 `cordis.patch.yml`。
>
> npm 状态：**尚未发布**；请勿使用 `npm install dsh-notify-toast`，也不要把它和 npm 上的同名旧包混淆。

> 插件清单说明：`dsh-plugin.json` 只声明 Host facet（`facets.host`）；Web Client 半由 `package.json` 的 `dsh.client` 声明（同类第三方插件也采用该结构），因此未声明 `facets.client`。DSH 0.2.1-rc.2 的官方插件加载以 `package.json` 的 `dsh.bundle` / `dsh.client` 为准。

### 方式 A：应用内插件管理器（推荐）

1. 把交付的 `dsh-notify-toast-0.4.1.tgz` 放到本机任意目录（路径不要含空格）。
2. 在 DSH 里让 Agent 用官方插件管理器安装，或使用插件管理界面：
   - Agent 工具：`plugin_manager` → `action: install_bundle`，`target: <tgz 绝对路径>`
   - 命令行：**仅适用于自管 profile（web/headless）**；官方 Desktop 的 desktop profile 由 Electron 应用的插件管理器管理，请用上面的界面或 Agent 方式。
3. 安装完成后在 设置 → 插件 的列表里确认 `dsh-notify-toast` 已启用。
   - **首次安装/升级后需要重启一次 DSH**：官方插件管理器可热插入 Host 行，但已加载的 Host JavaScript 模块要重启才会换成新代码（客户端 bundle 会热更新）。本插件不会自行重启应用。
4. 打开 设置 →「通知」，点「发送测试通知」验证；「运行状态」块会显示 Host 连接、transport、设置持久化与最近提醒计数。

### 方式 B：开发期目录安装（link）

```text
plugin_manager → install_bundle → target: <插件目录绝对路径>
```

本地目录安装为 link，代码改动可被 DSH 的 HMR 感知；Host 侧 JavaScript 变更若未热更新，需要重启 DSH。

### 方式 C：插件市场索引

本仓库自带 `market-index.json`。在 DSH 的插件市场/发现页添加自定义索引：

```text
https://raw.githubusercontent.com/game25011/dsh-notify-toast/4a3c83e5634cf9dcac005ec2e9bbd4c4dd828596/market-index.json
```

添加后搜索 `dsh-notify-toast` 即可看到本插件，并从市场安装固定版本的 Git 源。  
这是**自托管索引**；DSH 官方默认索引不会自动收录本插件，其他用户需要添加同一索引或由官方目录收录。

### 升级

- 新版本 tgz：再次 `install_bundle`（应用内会提示重启以加载新的 JS 模块）。
- 开发目录：直接更新代码；必要时重启 DSH。

### 卸载

- 应用内：插件管理界面禁用/移除 `dsh-notify-toast`；
- Agent 工具：`plugin_manager` → `action: remove_bundle`，`target: dsh-notify-toast`；
- 卸载后：Host 路由/事件监听/计时器随插件 fiber 释放，客户端 bundle 不再加载；设置页条目消失。
  已写入 profile patch 的配置项会随插件移除而不再生效（不会留下后台进程或临时文件）。

---

## 配置

设置位置：**设置 →「通知」**（`settings.section`，id `dsh-notify-toast`）。

| 设置 | 范围/选项 | 默认 | 说明 |
|---|---|---|---|
| 启用通知 | 开/关 | 开 | 总开关；关闭后不弹也不响（测试通知除外） |
| 提问与方案确认 | 开/关 | 开 | `user-questions/request` |
| 授权（审批） | 开/关 | 开 | `approval/request` |
| 本轮回复结束 | 开/关 | 开 | 子代理完成始终不提醒；只表示这一轮回复结束，不代表整个任务完成 |
| 任务栏未读角标 | 开/关 | 开 | DSH 后台时显示有完成结果的不同根会话数；同一会话多次完成只计 1；1–3 显示深灰底、白字、蓝色细环的数字角标，超过 3 显示红点；聚焦/点击任务栏后清除；仅 Windows |
| 目标模式结束后汇总 | 开/关 | 开 | goal 自动推进期间不逐轮提醒；结束/暂停/受阻/Round 上限后按 Goal Round 增量汇总为一条；提问/授权仍即时 |
| 正文长度 | 20–60 字 | 40 | 按 Unicode 码点截断，超出加「…」 |
| 隐私模式（只显示标题） | 开/关 | 关 | 正文留空 |
| 提示音 | 叮咚 / 风铃 / 清铃 / 轻点 / 弹一下（开源音效） / 关闭 | 叮咚 | 前 4 种由 Web Audio 合成；「弹一下」是 uisfx CC0 音频（内嵌，不联网）；设置页有「试听」按钮 |
| 音量 | 0–100 | 60 | 0 等同静音 |
| 合并间隔 | 0–10000 ms | 2500 | 该窗口内的多个「完成」合并为一条 |
| 全部完成后改写标题 | 开/关 | 关 | 至少两个根会话同时运行、且全部成功结束后才生效；只有一个会话运行时不触发 |
| 标题文案 | 1–96 字节 | 所有任务均已完成 | 最后结束的会话将改成该标题（仅「全部完成后改写标题」功能） |
| 通知显示方式 | Windows 原生进度通知 / Windows 兼容通知 | 原生进度 | 原生模式显示系统通知进度条；helper 不可用时自动回退兼容通知 |
| 通知自动移除时间（近似） | 3–30 秒 | 8 秒 | 控制进度更新停止时间与通知中心保留窗口；实际退场由 Windows 控制，可能提前或延后 |

所有改动即时生效；持久化走 DSH 官方 settings（写入当前 profile 的 patch 层），重启后保留。

---

## 工作原理

```
Host (lib/index.js)                                  Client (lib/client.js)
─────────────────────────────────────────────        ─────────────────────────────────────
approval/request ───────────┐                        settings.section 设置页（React，纯 HTML）
user-questions/request ─────┼─ 清洗/截断/合并 ──┐    ├─ 焦点判断（hasFocus + visibilityState）
session/event turn/end ─────┘                    │    ├─ native toast RPC / Web Notification 回退 + 点击回窗
                                                 ▼    ├─ Web Audio 合成提示音 + 内嵌 CC0「弹一下」音效
                                 事件环形缓冲 + 长轮询 ┘
Host 浏览器路由 /dsh-notify-toast（官方 RPC 信封 + 同源栅栏）
  config / save / poll / health / test / focus / taskbar-badge
Host: native-toast.ps1 → WinRT Toast；taskbar-badge EXE → ITaskbarList3
Host: ctx.settings（volatile Config）← save
Host: koffi user32 SetForegroundWindow ← focus
```

- **Host 检测**：直接监听 DSH 的权威事件（审批、提问、`turn/end`），只读会话日志提取正文，不调用模型、不访问外部网络。
- **传输**：走 `/dsh-notify-toast` 前缀长轮询。优先使用官方 `connection.rpc.handle`；在 DSH 0.2.1-rc.2 上该 API 有 bug
  （内部读 `webServer` 抛 `cannot get property "webServer" without inject`），插件自动回退为同路径 `webServer` 路由，
  并在入口调用官方 `connection.requestRejection` 复用 Host/Origin 同源栅栏 + 浏览器签名 cookie 认证；
  请求/响应用官方一元 RPC 信封，所以客户端 `connection.rpc.call` 代码不变。设置页「Host 连接 / transport」可看到当前链路。
- **客户端只负责展示**：事件到达时才判断窗口是否聚焦；聚焦则直接丢弃（不弹不响）。
- **根会话判定**：`SessionHeader.parentSession === undefined && origin !== 'subagent'`。
- **正文提取**：
  - 提问：`request.questions[0].question` 原文；
  - 授权：工具名 + `displayReason`/`reason` 简短目的；
  - 完成：从 `turn/end` 事件往前找最近一条 `assistant/message`，取文本块，清洗 Markdown/代码围栏/行内代码/链接/标题符号等，压缩空白，取第一段；无有效文字 → 「点击查看」。
- **点击回窗**：客户端 `POST`（RPC）`focus` → Host 用 DSH 自带 koffi（`resources/app.asar.unpacked/.../koffi.node`）调用 user32 `ShowWindow/SetForegroundWindow/AttachThreadInput` 把 Electron 主窗口置前；随后客户端 `window.focus()` 并打开对应会话。
- **配置持久化**：`Config` 全字段 `.volatile()`；Host 从 profile 解析 `@deepseek-ai/schemastery`（优先 `DSH_PROFILE_DIR`，其次 Host 进程 cwd 即 profile 目录，再次 DSH 安装包内副本），
  通过 `ctx.settings.describe()/update()` 读写当前 profile patch。设置页「设置持久化 / configSource」可见状态。

### 实现与资源占用

- **Host** 在 DSH 进程内运行，只监听事件、维护 200 条内存环形缓冲、长轮询和 settings；空闲时没有额外常驻进程。
- **客户端** 是约 159 KB 的 Web bundle；空闲时只有一条 25 秒长轮询和 5 秒一次的 localStorage leader 心跳。
- **Windows toast** 由一次性 PowerShell/C# helper 调 WinRT 创建；一个 toast 对应一个 helper，toast 结束后退出，同时最多 8 个。
- **任务栏角标** 优先使用首次编译并缓存的小型独立 C# EXE，直接调用 \`ITaskbarList3::SetOverlayIcon\`；热路径实测约 55–85 ms、约 14 MB 瞬时内存。首次使用需要编译，之后命中缓存；编译或 EXE 不可用时回退 PowerShell helper。
- **缓存** 位于 \`%LOCALAPPDATA%\\dsh-notify-toast\\native-cache\`；任务栏 helper 缓存只保留最近 8 个，避免旧 hash 文件无限积累。
- 不访问外部网络、不调用模型、不采集；点击回调只使用本机 loopback。

### 隐私

- 不访问外部网络、不上报、不采集；仅本机 loopback 激活回调；无模型调用；通知正文只来自本机会话日志的已有内容。
- 不写自建配置文件；配置由 DSH 官方 settings 持久化到 profile patch。
- 通知内容可能包含回复摘要：介意时开启「隐私模式（只显示标题）」。

---

## 兼容性

| 项目 | 说明 |
|---|---|
| DSH | `0.2.1-rc.2`（`engines.dsh: >=0.2.1-rc.2 <0.3.0`）；依赖的 Host 事件/RPC/settings 契约在本版本实测 |
| 操作系统 | Windows 10/11（原生 toast + koffi user32 置前）；macOS/Linux 未验证（本插件目标为 Windows） |
| 运行形态 | DSH Desktop（Electron，页面 origin `dsh-app://app`）。普通浏览器 Web profile 下 toast 可用，但"置前 Windows 窗口"会降级为浏览器自身聚焦 |
| 通知权限 | Windows 通知中心需允许应用通知；Electron Desktop 默认放行非媒体权限，若被系统/组策略禁用则只降级不崩溃 |
| 聚焦助手 | Windows 专注助手/勿扰模式可能静默 toast（系统行为，插件无法绕过） |
| 插件格式 | `dsh-plugin.json`（Host facet）+ `package.json` 的 `dsh.bundle` / `dsh.client`；未使用 `facets.client`，理由见「安装」小节的插件清单说明 |

---

## 已知限制

1. 页面必须处于打开状态（DSH 窗口最小化可以，但页面进程不能退出）；浏览器关闭则没有通知。
2. 通知权限被拒绝 / 系统不支持 Web Notification 时：设置页显示状态，原生 toast 不可用（保留声音与点击回窗能力），不崩溃。
3. Windows 关闭了通知横幅、或开启了专注助手时，原生 toast 可能只进通知中心不弹横幅；设置页「系统通知」计数与「测试系统通知」可用于确认，请在 Windows 设置中允许该应用通知并关闭专注助手。
4. 首次提示音需要页面上发生过一次用户手势（Chromium 自动播放策略）；未解锁前声音静默，通知照常。
5. 点击回窗的置前依赖 DSH 自带 koffi 原生模块；模块路径变化/加载失败时降级为 `window.focus()`，可能不置前但仍会打开会话。
6. 多窗口/多标签页时用 localStorage 租约（5 s 心跳、15 s 过期）只让一个窗口弹 toast/出声；租约竞争极端情况下可能短暂重复。
7. 子代理完成始终不提醒；对子代理的提问/审批仍会提醒（它们同样阻塞任务）。
8. 「完成」正文取最后一条助手回复的首段；若回复只有代码/工具调用，正文回退为「点击查看」。
9. 合并只针对「完成」；提问/授权不合并（需要你尽快处理）。
10. **Windows 原生 toast 的退场动画和横幅停留时间由 Windows 控制**（Windows 设置/专注助手）；「通知自动移除时间（近似）」控制进度更新停止与通知中心保留窗口，不保证横幅精确停留 N 秒。到期后插件会短暂缓冲再调用 `Hide()` 收回横幅；`Hide()` 的视觉过渡仍由 Windows 决定。
11. 原生进度通知的点击回会话依赖 C# helper 的本地激活回调；回调失败时可能只关闭通知、无法定位会话。提示条不再使用 `dsh://open` 协议唤起，避免点击时另起 DSH 实例/会话。
12. 原生 helper 首次运行会在 `%LOCALAPPDATA%\dsh-notify-toast\native-cache` 编译/缓存一个 C# DLL；编译失败或 PowerShell/C# 不可用时自动回退兼容通知。
13. 插件不修改 DSH 核心；DSH 升级若改动上述事件/RPC/settings 契约，插件可能需要同步升级。
14. DSH 0.2.1-rc.2 的官方 `connection.rpc.handle` 自身有 bug（`cannot get property "webServer" without inject`），
    插件已自动回退为同路径 + `connection.requestRejection` 的官方栅栏路由；这不改变客户端行为，但 DSH 修复该 API 后插件会优先走官方 channel。

---

## 故障排查

| 现象 | 检查 |
|---|---|
| 完全没有 toast | 设置 →「通知」看「通知权限 / Host 连接 / 系统通知」状态；点「测试系统通知」：若显示「已创建」却无横幅，去 Windows 设置 → 系统 → 通知 打开横幅/关闭专注助手；也检查 Win+N 通知中心里是否有该通知 |
| 有声音但没弹窗 | 同上；另外确认系统未把该应用通知设为「仅通知中心」 |
| 聚焦时也不弹 | 设计如此（聚焦不打扰）；把焦点切到别的应用或用「发送测试通知」验证 |
| 有 toast 没声音 | 设置 →「通知」点「试听」；看「提示音引擎」是否为「已就绪」（「待解锁」时先点一下页面）；检查 Windows 音量合成器中本应用的音量/静音、系统输出设备；音量是否 0/提示音是否关闭 |
| 点击通知没回到 DSH | 看设置页「窗口置前」是否为可用；不可用时为降级模式 |
| 重启后设置丢失 | 看设置页「设置持久化」是否为「官方设置」；若显示降级，说明 `ctx.settings` 不可用（插件仍按默认值工作） |
| 插件列表里没有条目 | 用官方插件管理器确认 bundle 已安装并启用；必要时重启 DSH |

---

## 开发与测试

```text
命令                          说明
npm test                      文本清洗/截断、配置、合并、goal 汇总与原生生命周期的单元测试（94 项）
npm run smoke                 模拟 __ModuleLoader__ 加载 client.js 的冒烟测试（26 项）
npm run probe                 RPC 探针：--self-check 纯函数校验；--url 探测宿主 RPC 路由（无 cookie 预期 401/403）
node scripts/host-probe.mjs <profileDir>   Host 集成探针（真实 profile cwd）
npm pack                      生成交付用 tgz
```

- 源码结构：
  - `lib/index.js` Host 半（事件、浏览器路由、settings、合并、清理）
  - `lib/text.js` 文本清洗/截断纯函数（有单元测试）
  - `lib/config.js` 默认值/校验/合并/volatile Config schema
  - `lib/native-focus.js` koffi user32 窗口置前
  - `lib/client.js` Web 客户端半（焦点、toast、声音、设置页、长轮询）
  - `locale/zh.json`、`locale/en.json` 插件市场/设置页显示元数据
  - `scripts/client-smoke.mjs`、`scripts/probe-rpc.mjs` 冒烟/探针
  - `dsh-plugin.json` 插件清单（Host facet，公共 id `dsh.notify-toast`）；`package.json` 的 `dsh.client` 声明 Web Client 半；`cordis.patch.yml` 为 bundle patch
  - `docs/PLAN.md` 历史开工方案（不进入 npm 包）；`docs/INTERFACE.md` Host/Client 契约；`docs/TEST-REPORT.md` 验收记录；`docs/RELEASING.md` 发布手册

---

## 开源与贡献

- 仓库：https://github.com/game25011/dsh-notify-toast
- 英文文档：[README.en.md](./README.en.md)
- 贡献指引：[CONTRIBUTING.md](./CONTRIBUTING.md)
- 安全问题：[SECURITY.md](./SECURITY.md)（请走私密 GitHub Security Advisories，不要公开 issue）
- 行为准则：[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- 发布流程：[docs/RELEASING.md](./docs/RELEASING.md)

---

## 致谢

实现思路参考了以下 MIT 开源插件（代码为原创，未整段照抄）：

- [chromoany/dsh-notify-me](https://github.com/chromoany/dsh-notify-me) — 焦点判断、通知降级、设置页、多窗口 leader
- [BillCx330/dsh-plugin-notify-sounds](https://github.com/BillCx330/dsh-plugin-notify-sounds) — koffi user32 窗口置前、Connection 路由栅栏
- [Laplace-bit/dsh-bell-notify](https://github.com/Laplace-bit/dsh-bell-notify) — Web Audio 合成音效
- [uisfx](https://github.com/romainsimon/uisfx) — 「弹一下」使用的 CC0 音效来源，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

## License

MIT，见 [LICENSE](./LICENSE)。

## 非官方声明

本插件是社区第三方插件，与 DeepSeek 官方无隶属关系，未获其背书或赞助（**Not affiliated with DeepSeek**）。DeepSeek、DeepSeek Harness 等名称与商标归其各自所有者。
