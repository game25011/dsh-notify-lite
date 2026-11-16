# dsh-notify-toast 0.5.2 交接说明

> 状态：**已发布**（2026-11-17 随 0.5.2 合并进主仓库并发布 npm/GitHub）。本文件保留为交接记录；下文「未发布」相关描述为交接时点状态。`AI-DISCLOSURE.md` 保留不变。

## 一、改了什么、为什么

### 设置页（`lib/client.js`）

| 改动 | 原因 |
|---|---|
| 折叠区（高级设置 / 诊断与状态）直接承载各行，不再在带框容器里再套一层卡片；诊断拆成「状态 / 系统通知 / 运行状态」三组，用分隔线区分 | 0.5.1 是框中套框，层级比 DSH 原生设置页多一层 |
| 总开关关闭时，提问/授权/完成/角标子开关禁用变灰；完成提醒关闭时，角标与目标汇总也禁用；「只显示标题」开启时正文长度禁用 | 让依赖关系一眼可见，避免「开着却不生效」 |
| 诊断中的异常值（Host 未连接、权限被拒绝、置前/持久化不可用、链路异常）标红；通知错误与置前错误分开标注 | 原先两条错误同名「最近错误」，无法区分 |
| 「测试系统通知」结果文案本地化（zh/en） | 原先硬编码中文，英文界面也显示中文 |
| 控件统一 32px 高度；「发送测试通知」改为次要按钮；提示文字统一放在标签下方（原先滑杆的提示在滑杆下方）；试听按钮换成与导航铃铛同笔画的扬声器 SVG，提示音关闭时禁用 | 统一视觉节奏，不引入新的视觉语言 |
| 作用域样式表补上 `:focus-visible` 焦点描边与悬停底色 | 文本框原先 `outline: none`，键盘用户看不到焦点 |
| 折叠动效：三角改为 SVG；收起后用延迟的 `visibility: hidden` 替代 `inert=""`；减少动态效果改为 CSS `@media (prefers-reduced-motion)`；外层去掉 `overflow: hidden` | 见下方「动效问题」 |
| 「全部完成后改写标题」输入框改为本地草稿 | 原先每次按键都被裁剪，词间空格打不进去，清空后立即弹回旧值 |
| 「测试系统通知」的点击只计一次 | Electron 同时触发 `onclick` 和 `click` 事件时，原先会发两次置前请求 |

**0.5.1 动效问题（已核实并修复）**
- 用真实 React 19 渲染 0.5.1 时，React 会警告 `inert=""` 被**当作 false 处理**：收起的折叠区里的控件仍可被 Tab 聚焦，同时又是 `aria-hidden`。现在改用「高度/透明度过渡结束后再切换 `visibility: hidden`」，在 React 18/19 下行为一致。
- 文字字形 `▸` 旋转时中心偏移，会轻微晃动；改为对称的 12px SVG，绕真实中心旋转。
- 原先只在渲染时读取一次 `matchMedia`，系统设置变化不会实时生效；现在由 CSS 媒体查询处理（`!important` 覆盖内联 transition）。
- 外层 `overflow: hidden` 会裁掉标题按钮的焦点环，已移除。
- 时长/曲线统一为 200ms `cubic-bezier(.2,0,0,1)`，没有新增其他动效。

### Host 与原生 helper

| 文件 | 问题 → 修复 |
|---|---|
| `lib/taskbar-badge.js` | **重启风暴**：helper 写入失败时，`while (desired !== applied)` 会立即再次拉起进程；缓存 EXE 和 PowerShell 都失败时会持续 spawn。现在失败一次就停，等下一次计数变化或聚焦清除时再试。卸载时的最终清除优先使用缓存 EXE，不再启动 PowerShell |
| `lib/native-focus.js` | **置前/角标误中其他窗口**：原先只要类名是 `Chrome_WidgetWin*` 就会进入候选（VS Code、浏览器、各种 Electron 应用都是），PID 没对上时可能把别的应用置前，或给它的任务栏按钮挂角标。现在父进程 PID 命中优先；否则只接受 Chromium 类且标题含「DeepSeek Harness」的窗口，最后才退到标题含「DeepSeek」的 Chromium 窗口 |
| `lib/index.js`（长轮询） | **Host 重启后漏提醒**：新 Host 的事件 id 从 1 重新开始，客户端的旧游标会被夹到新队列末尾，把新 Host 已经发布的前几条事件跳过。现在队列带随机 `epoch`，客户端回传，不一致就从 0 重新取（客户端原有的 120 秒新鲜度窗口防止回放旧事件）。旧客户端不带 epoch 时行为不变。激活事件的去重键也带上 epoch |
| `lib/index.js`（完成去重） | **完成被吞**：DSH 不提供 `turn` 编号时，去重键是 `sessionId:-`，同一会话 5 秒内的第二次完成会被当作重复丢弃。现在退到 `seq`，两者都没有就不去重 |
| `lib/index.js`（完成正文） | 向前扫描遇到本轮 `turn/start` 即停，不再借用上一轮的回复 |
| `lib/text.js` | 正文提取：跳过 `## 总结`、单行 `**总结**` 这类纯标题段；「改动如下：」这类冒号引导句与下一段拼接；行内代码原样保留（`Vec<String>`、`__init__` 不再被删掉）；只删除标签形态的 `<...>`（`a < b > c` 保留） |
| `lib/index.js`（提问观察者） | `user-questions/request` 与 0.4.1 的审批修复保持一致，改为 `{prepend:true, global:true}`，仍然总是调用 `next()`。⚠️ 这一条基于与审批相同的 waterfall 结构推断，**需要在 DSH 中实测确认** |
| `lib/native-toast.js` | **首次编译 / 预热**：Node 侧用与 `native-toast.ps1` 相同的 SHA-256 检查缓存 DLL，已缓存就不再启动 PowerShell 预热（之前每次 DSH 启动都要拉起一次 PowerShell）；`show()` 遇到进行中的预热会等待（最多 8 秒），不再并行再跑一次 csc；非 Windows 不预热。没有常驻进程 |
| `lib/taskbar-badge-helper.cs` | **角标清晰度**：原先固定画 32px 位图，再由 Windows 缩到 16/20/24px，会发糊。现在按任务栏 DPI 的小图标尺寸直接绘制（`GetDpiForWindow(Shell_TrayWnd)` + `GetSystemMetricsForDpi(SM_CXSMICON)`，旧系统退回 16px），开启半像素偏移，数字字形缩放到整数像素高度并对齐像素网格；蓝环改为「外圆填充 + 内圆填充」，避免描边发虚。含义不变：1–3 深灰底白字蓝环数字，>3 红点白晕 |

已核实、**无需重做**的历史问题：0.4.1 审批 waterfall（`prepend + global` + `next()` 仍在）、0.4.3 设置图标重复（原生 `settings.section.icon` slot 优先，DOM 方案仅作旧版回退）、`rpc.handle` 抛 `webServer without inject` 时的 webServer 同路径回退（仍在，且有路由测试覆盖）。

角标仍是方案 B：DSH 未聚焦时，按有完成结果的不同根会话计数；1–3 显示数字，超过 3 显示红点；聚焦或点击任务栏时清除。

## 二、在 DSH 中如何审查（link 安装本目录）

1. 在 DSH 中执行 `plugin_manager → install_bundle → target: <本仓库目录的绝对路径>`（目录安装为 link）。Host 侧有改动，装好后**重启一次 DSH**。
2. 设置 →「通知」：
   - 关闭「启用通知」，确认下面 4 个子开关变灰且点不动；关闭「本轮完成」，确认角标开关变灰。
   - 只用键盘 Tab 遍历：每个控件都应有蓝色焦点描边；**折叠区收起时 Tab 不应进入其中的控件**。
   - 展开/收起「高级设置」「诊断与状态」：三角平滑旋转、高度过渡无跳动；在 Windows「设置 → 辅助功能 → 视觉效果」关闭动画效果后，无需刷新即变为瞬时切换。
   - 打开「全部完成后改写标题」，在输入框输入 `All done`（含空格）、全部删除后再输入，确认都正常。
   - 诊断 →「测试系统通知」→ 点击通知：「点击」计数只加 1。
3. 角标：让 DSH 失焦并完成 1、2、3、4 个不同根会话，分别检查数字与红点；在 100% / 125% / 150% 缩放下对比 0.5.1 的清晰度；聚焦后清除。
4. 点击回窗：同时打开 VS Code 或浏览器（标签标题含 DeepSeek），点击通知，应只回到 DSH。
5. 提问通知：触发一次提问（或计划确认），确认通知出现，且 DSH 内的提问 UI 照常可答。
6. 预热：首次启动后，`%LOCALAPPDATA%\dsh-notify-toast\native-cache\` 中应生成 `<sha256>.dll` 与 `<hash>.badge.exe`；第二次启动 DSH 时，任务管理器中不应短暂出现由 DSH 拉起的 PowerShell 预热进程。

## 三、测试结果（本环境：Linux，Node 24）

- `npm test`：112 项，**110 通过、0 失败、2 跳过**（这 2 项需要真实 DSH profile 中的 schemastery，与 0.5.1 相同）。新增 `test/host-events.test.mjs`、`test/native-focus.test.mjs`、`test/taskbar-badge.test.mjs`，并为 `text`、`native-toast` 补充用例。
- `npm run smoke`：**30/30 通过**（新增：poll 回传 epoch、系统通知探针单次计数、标题输入框保留空格）。
- `npm run probe -- --self-check`：**7/7 通过**。
- `node scripts/host-probe.mjs`：本机没有 DSH，用一个替身 profile（公开的 `schemastery` 加 `.volatile()` 垫片，放在仓库外的临时目录）运行，**PASS**，并新增「提问观察者 prepend/global + 委托」检查。**尚未在真实 DSH profile 上运行**。
- 设置页外观：在仓库外用真实 React 19 服务端渲染 + 无头 Chrome 截图，核对了浅色/深色、展开/收起与总开关关闭状态。
- **C# helper 未编译验证**：本环境没有 csc/mono。改动只用到 .NET Framework 4 / C# 5 语法和 `user32` P/Invoke，但仍需要在 Windows 上首次运行确认（缓存键随源码变化，会自动重新编译；编译失败时会回退到 PowerShell，角标功能本身不受影响）。

## 四、刻意没做的事

- 没有改动 Windows 原生 toast 的外观（由系统控制）。
- 没有托盘图标、常驻服务、网络请求、模型调用或遥测；helper 仍然按需启动、用完即退出。
- 没有合并提问/授权通知，只有「完成」会合并；角标计数语义不变。
- 没有重写架构，Host / Client / 原生 helper 的划分不变；RPC 只做向后兼容的扩展（`poll` 可选 `epoch`）。
- 启动时的角标清零（客户端加载时运行一次缓存 EXE，约 60ms）保留：它能清掉 Host 崩溃后残留的角标。
- 没有为字符串形式的消息内容增加支持（现有测试明确要求非数组返回 null）。
- `market-index.json` 未动；README 中的 npm 包版本仍写 0.5.1（0.5.2 尚未发布）。
- README 保留原来的 CRLF 换行，没有顺手统一。

## 五、`git diff --stat`（相对 0.5.1 提交 `ee82f1a`，不含本文件）

```
 CHANGELOG.md                |  24 ++
 README.en.md                |  12 +-
 README.md                   |  12 +-
 docs/INTERFACE.md           |  18 +-
 dsh-plugin.json             |   4 +-
 lib/client.js               | 730 ++++++++++++++++++++++++++------------------
 lib/config.js               |   2 +-
 lib/index.js                |  43 ++-
 lib/native-focus.js         |  36 ++-
 lib/native-toast.js         |  51 +++-
 lib/taskbar-badge-helper.cs | 120 ++++++--
 lib/taskbar-badge.js        |  42 ++-
 lib/text.js                 |  74 ++++-
 package.json                |   2 +-
 scripts/client-smoke.mjs    |  69 ++++-
 scripts/host-probe.mjs      |  11 +
 test/config.test.mjs        |   2 +-
 test/host-events.test.mjs   | 124 ++++++++
 test/native-focus.test.mjs  |  34 +++
 test/native-toast.test.mjs  |  68 +++++
 test/taskbar-badge.test.mjs |  79 +++++
 test/text.test.mjs          |  25 ++
 22 files changed, 1202 insertions(+), 380 deletions(-)
```

## 六、发布前待办（本次未做）

1. 在 Windows + DSH 上按第二节逐项实测，重点是 C# 角标编译与提问观察者。
2. 用真实 profile 运行 `node scripts/host-probe.mjs <profileDir>`。
3. 按 `docs/RELEASING.md` 发布；之后再把 CHANGELOG 中的「未发布」改为日期，更新 README 的 npm 版本，并按需更新 `market-index.json`。
