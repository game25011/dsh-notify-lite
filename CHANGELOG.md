# Changelog

## 0.4.0 — 2026-11-01

- 新增 Windows 任务栏未读角标：DSH 在后台且有完成结果时，在 DSH 任务栏图标上显示未读根会话数；设置页可关闭。
- 计数采用方案 B：不同根会话各算 1 个，同一会话完成多次只算 1 个；合并完成事件携带 `sessionIds`，避免多会话被合并后少计。
- 角标显示上限为 3：1–3 显示深灰底、白字、蓝色细环的数字角标，超过 3 显示红色圆点；回到 DSH（窗口聚焦/点击任务栏）后清除。
- Host 新增 `taskbar-badge` RPC 与一次性 PowerShell/C# helper（`ITaskbarList3::SetOverlayIcon`）；不增加常驻后台进程，不联网。
- 配置新增 `taskbarBadgeEnabled`（默认开启）；测试补充 badge 计数/聚焦清除，合并测试覆盖 `sessionIds`。

## 0.3.0 — 2026-10-20

- 原生进度条底部只保留一条 bar + 单个静态「自动关闭」说明，不再显示百分比、剩余秒数或重复标签；声音改为 native helper 提交成功后再播放，改善弹窗与提示音同步；移除 toast 的 `dsh://open` 协议启动，避免点击通知另起 DSH 实例。
- Goal 模式汇总：goal active+armed 期间不逐轮发完成通知；在 complete/paused/blocked/round-limit/disarmed 后按 `roundsStarted` 增量只发一条汇总；新增默认开启的“目标模式结束后汇总”设置；完成用进度标题，暂停/受阻用中性标题；提问/授权仍即时提醒。
- 新增 AI 参与说明（`AI-DISCLOSURE.md` 与 README 双语声明）：说明大部分代码由 AI 编程助手生成，人类维护者负责需求、调试、测试、验收和发布。
- 提示音新增可选「弹一下」：来自 uisfx 0.4.0 的 CC0 音频（rubber/notification），内嵌到 Client，无需联网或新增依赖；默认仍是「叮咚」；源文件与许可见 `THIRD_PARTY_NOTICES.md`。
- 标题改为自动场景文案：单步「DeepSeek 搞定了一小步」、2–4 步「DeepSeek 一口气推进了 N 步」、≥5 步「DeepSeek 火力全开，连推了 N 步」、提问「DeepSeek 想问你一个问题」、授权「DeepSeek 需要你的授权」、全部根会话完成「所有任务均已完成」；删除自定义完成标题输入。
- 删除 DSH 内应用内倒计时卡片及相关设置；改为 Windows 原生通知：Host 通过 PowerShell/C#/WinRT helper 显示真实 Windows toast，带动态 `<progress>` 进度条；到期停止更新，短暂缓冲后 `Hide()` 收回横幅（`ExpirationTime` 继续约束通知中心保留），时间只作近似；helper 不可用时自动回退 Web Notification。
- Host 新增 `native-notify` RPC、loopback 激活回调 server、`activate` 事件；点击原生通知尽量回到对应会话；回调失败时不承诺 session 定位。
- 新增 native helper 编译缓存（`%LOCALAPPDATA%\\dsh-notify-toast\\native-cache`）与版本 0.3.0；启动预热减少首条通知延迟；同 kind 通知改用唯一 tag，旧 helper 允许自然退出；移除旧 in-app overlay/`native-and-inapp` 主路径死代码，同时保留旧配置到 `native-progress` 的迁移；测试更新为 94 项单测 + 25 项 client smoke。

## 0.2.0 — 2026-10-19

- 完成通知标题改为中性文案「DSH 有新的回复」/「DSH has a new reply」，不再对每轮回复声称「完成了一项任务」；多轮合并时显示「DSH 有 N 轮新回复」。新增可配置的「本轮回复通知标题」（留空使用默认文案），并保留「全部完成后改写标题」的独立语义。
- 新增可选「系统通知 + 应用内卡片」显示方式：应用内卡片支持 3–60 秒可调显示时长、底部倒计时进度条（默认开）、悬停/键盘暂停（默认开）、多条堆叠与手动关闭；设置页提供预览按钮。
- 明确能力边界：Windows 原生 toast 的显示时长由系统控制，插件不能自定义任意时长或内嵌进度条；这些设置仅作用于应用内卡片。
- 测试：新增完成标题/配置字段与应用内卡片测试；`npm test` 74/74、client smoke 24/24 通过。
- 审核修复：应用内卡片点击不再误删原生通知记录；页面隐藏/恢复时显式暂停计时；标题输入保留末尾空格；卡片支持 Enter/Space；旧 Host（<0.2.0）隐藏新设置并提示重启。

## 0.1.1 — 2026-10-19

- 设置导航新增铃铛图标：宿主 `settings.section` 不投影 icon 字段，客户端像插件市场一样按本地化 label 认领自己的导航行，隐藏宿主齿轮并用 CSS mask 画 16px 单色铃铛；locale 切换重新认领，`ctx.effect` 卸载时清理标记与样式。
- 新增 `test/nav-icon.test.mjs`（5 项）：`node --test test/*.test.mjs` 现为 **73/73**；client smoke **23/23**；Host 半未改，host probe 未重跑。
- 2026-10-19 本人重启桌面验收：设置导航行显示铃铛，确认合格。

## 未发布（0.1.0 发布前修正）

- 新增可选「全部完成后改写标题」：多个根会话同时运行、全部成功结束后，把最后结束的会话标题改为可配置文案（默认「所有任务均已完成」）；只有一个会话运行时不生效。
- 安全：RPC 回退路由在 Connection 缺少 `requestRejection` 时改为 fail-closed（403），并补回归测试（当前总计 68/68）。
- 文档：对齐「toast 不主动自动关闭」、4 种提示音、`host-probe` / `probe-rpc` 命令说明；移除作者本机绝对路径。
- 开源准备：新增 `.gitignore`、`.editorconfig`；`package.json` 补 `author` 与 `engines.node`；`host-probe` 支持参数 / `DSH_PROFILE_DIR` / `DSH_HOME`。
- 文案：设置页「系统通知」提示改为如实描述仅走 Windows toast；客户端死代码（应用内兜底卡片）保留并注明未启用。

### 开源仓库准备（0.1.0 发布前）

- `package.json` 补 `repository` / `homepage` / `bugs` / `publishConfig.access=public`；版本保持 `0.1.0`；`files` 白名单、`engines.dsh` 与 `engines.node >= 20` 保持不变。
- `dsh-plugin.json` 公共 id 从个人命名空间改为中性 `dsh.notify-toast`；版本与 `package.json` 同步；仅保留 Host facet（Web Client 半由 `package.json` 的 `dsh.client` 声明）。
- 新增 `README.en.md`、`CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、GitHub Issue/PR 模板、GitHub Actions CI（Windows/Ubuntu × Node 22/24）与 `docs/RELEASING.md` 发布手册。
- README 增加 npm/license/DSH/Windows/CI 徽章、截图待补说明、安装/配置/兼容性/隐私/已知限制/故障排查入口、MIT 归属与非官方声明（Not affiliated with DeepSeek）。
- `.gitignore` 增加 `release/`、`.npmrc` 等；移除过期 `release/` 目录与 tgz 构建产物；清除文档中的本机绝对路径。

## 0.1.0 — 2026-10-18

- 首个版本：Host 侧监听 `approval/request`、`user-questions/request`、根会话 `turn/end(completed)`，
  通过同源长轮询把需要处理的事件推给 Web 客户端。
- Windows 原生 toast（`silent: true`），仅在窗口未聚焦时展示；点击通知经 Host `koffi` user32 置前窗口并定位会话。
- 正文只截取已有日志内容（提问原文 / 工具名+目的 / 最后回复首段），Markdown/代码块清洗，默认 40 字、20–60 可配。
- 完成通知按可配置间隔合并（默认 2500 ms），子代理完成不触发。
- Web Audio 合成 4 种轻提示音（叮咚/风铃/清铃/轻点），默认「叮咚」；音量 0–100，可关闭、可在设置页「试听」；
  首次用户手势解锁，且通知到达时即使 AudioContext 仍挂起也会先排程、再 resume，不再因 resume 被拒而静默丢音。
  设置页新增「提示音引擎」状态行（已就绪/待解锁/未初始化），便于诊断无声问题。
- 设置页（`settings.section`）：启用/提问/授权/完成开关、正文长度、隐私模式、提示音、音量、合并间隔、测试通知；
  配置经官方 `ctx.settings`（volatile Config）持久化，即时生效。
- 原生 toast 可诊断：设置页新增「系统通知」计数（尝试/创建/显示/失败 + 最近错误）、「测试系统通知」按钮与权限提示；
  修复「测试系统通知」误传 3 个参数导致的 `NotificationOptions` TypeError（正常通知路径不受影响）。
  原生 toast 不主动自动关闭（Windows 横幅收起后条目保留在通知中心，稍后点击仍有效）；构造前对 `permission==='default'` 再请求一次权限。
  通知坚持使用 Windows 原生 toast（系统右下角），不做应用内弹框。
- 点击回窗修复（含窗口最小化）：原实现按父进程 PID 取第一个可见顶层窗口，Electron 主进程同时拥有
  `DDE Server Window` / `MSCTFIME UI` / `Default IME` 等同 PID 窗口，可能把 `ShowWindow/SetForegroundWindow`
  作用在错误窗口上。现按窗口类 `Chrome_WidgetWin*` + 标题「DeepSeek Harness」打分并逐个候选尝试
  `ShowWindow(SW_RESTORE)` + `SetForegroundWindow`，每次验证前台窗口；toast 不再主动 `close()`（保留在通知中心可点）；
  点击后 focus RPC 失败自动重试 3 次。设置页「系统通知」新增 `点击 / 置前成功 / 置前失败` 计数与最近错误。
- 降级：通知权限拒绝、Host 路由不可用、`settings` 缺失、koffi 加载失败均不崩溃并在设置页显示状态。
- 兼容修复：DSH 0.2.1-rc.2 的官方 `connection.rpc.handle` 在该版本内部抛 `cannot get property "webServer" without inject`；
  插件自动回退为同路径 `webServer` 前缀路由，并复用官方 `connection.requestRejection` 同源/认证栅栏与一元 RPC 信封。
- 兼容修复：Desktop Host 进程可能没有 `DSH_PROFILE_DIR`；schemastery 解析新增 Host cwd（= profile 目录）、
  `DSH_HOME`/常见 home 布局与 DSH 安装包内副本等多级回退，设置页显示 `configSource`。
