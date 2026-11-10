# dsh-notify-toast 发布手册

> 适用版本：`0.3.0`（首个公开版本）。面向维护者，所有命令默认在仓库根目录执行。
> 本项目的 CI 只做检查：**不会自动发布**。打 tag、GitHub Release、`npm publish` 都是人工步骤。

## 0. 发布边界

- `.github/workflows/ci.yml` 只在 `push`（main）、`pull_request`、`workflow_dispatch` 时运行测试与 `npm pack --dry-run`；没有 publish/release/deploy job，也没有任何 secrets。
- 本插件零运行时依赖，发布流程不需要 `npm install` / `npm ci`，也不需要联网安装工具（npm 登录和发布除外）。
- 发布前先读完本手册的「发布前自检」；所有占位符见最后一节。

## 1. 前置条件

| 项 | 要求 | 检查命令 |
|---|---|---|
| Node.js | `>= 20`（`engines.node` 的运行时下限）；测试与 CI 只在 22 / 24 上验证过，发布验证使用 24.19.0，建议用 22+ 执行本手册 | `node --version` |
| npm | 随 Node 安装（发布验证使用 11.17.0） | `npm --version` |
| npm 账号 | 已注册，并已开启 2FA（Two-Factor Authentication） | `npm whoami --registry https://registry.npmjs.org` |
| git | `>= 2.28`（需要 `git init -b main`） | `git --version` |
| GitHub | 对 `<github-owner>` 有建仓 / 发布 Release 权限 | - |
| gh CLI（可选） | 用于建仓和创建 Release | `gh auth status` |

### 1.1 registry：本机默认不是官方源

本机 npm 默认 registry 可能是只读镜像（实测为 `https://registry.npmmirror.com`），**不能直接用来发布**。发布相关命令必须显式指定官方源：

    npm config get registry
    npm login --registry https://registry.npmjs.org
    npm whoami --registry https://registry.npmjs.org
    npm publish --access public --registry https://registry.npmjs.org
    npm view dsh-notify-toast version --registry https://registry.npmjs.org

不建议依赖全局 `npm config set registry ...` 的临时切换；如果切换过，发布后要改回并再次确认。所有发布命令带上 `--registry https://registry.npmjs.org` 最稳妥。

### 1.2 2FA、OTP 与密钥

- 推荐交互式 `npm login`，publish 时由 npm 提示输入一次性验证码（OTP）。
- 如使用 `npm publish --otp <code>`，OTP 会留在 shell 历史；发布后自行清理历史，不要把 OTP 写进任何文件。
- 仓库、Release 附件、CI 配置中不得出现 npm token、GitHub token、证书或私钥。本项目的 CI 不读取 secrets。

## 2. 发布前自检

在**源码仓库根目录**执行（不要在 tgz 解包目录里跑：tgz 按 `files` 白名单打包，不包含 `test/` 和 `scripts/`）：

    node --version
    npm config get registry
    npm test
    npm run smoke
    node scripts/probe-rpc.mjs --self-check
    npm pack --dry-run

0.3.0 在 Node 24（实测 24.19.0 / npm 11.17.0）的预期：

| 命令 | 预期输出 / 结果 |
|---|---|
| `npm test` | 94 项；0 failed、退出码 0（本机 profile 下 94 passed；无 profile 时个别 profile 相关测试会 skip） |
| `npm run smoke` | `client smoke test: 25 passed, 0 failed` |
| `node scripts/probe-rpc.mjs --self-check` | `7/7 checks passed` |
| `npm pack --dry-run` | `entryCount: 27`，共 27 个文件（含原生 helper、Bubble 音效与 README 截图；以实际输出为准，见 2.2） |

- `npm test` 必须使用 `package.json` 里的命令（`node --test "test/*.test.mjs"`）。**不要**在 Node 24 Windows 上把它改成 `node --test test/`：实测会把目录当模块加载并报 `Cannot find module ...\test`（退出码 1）。CI 同样固定使用 `npm test`。
- 2 项 skip 是预期的：`test/config.test.mjs` 里两项「真实 profile schemastery」测试在找不到 DSH profile 时会自动跳过（GitHub Actions 上没有 DSH）；退出码仍为 0。
- `npm pack --dry-run` 只预览，不写 tgz、不发布。

### 2.1 干净临时目录复验（推荐）

用于确认测试不依赖工作区残留。零依赖、无需 `npm install`。任选 Git Bash / WSL / macOS / Linux 执行：

    rm -rf /tmp/dsh-notify-toast-preflight
    mkdir -p /tmp/dsh-notify-toast-preflight
    tar -czf /tmp/dsh-notify-toast-preflight.tar.gz --exclude='./.git' --exclude='./release' --exclude='*.tgz' .
    tar -xzf /tmp/dsh-notify-toast-preflight.tar.gz -C /tmp/dsh-notify-toast-preflight
    cd /tmp/dsh-notify-toast-preflight
    npm test
    npm run smoke
    node scripts/probe-rpc.mjs --self-check

Windows 建议在 Git Bash 中执行；`rm -rf` 前先确认目标就是上述临时目录。注意：临时目录本身不会改变测试结果；结果取决于是否存在 DSH profile——本机 profile 下 94 passed；无 profile 时个别 profile 相关测试会 skip，0 failed。

### 2.2 `npm pack` 文件清单（0.3.0 实测 27 个）

    8  lib/*.js（all-done.js、client.js、config.js、goal-summary.js、index.js、native-focus.js、native-toast.js、text.js）
    2  lib/native-toast.ps1、lib/native-toast-helper.cs
    2  locale/*.json（en.json、zh.json）
    3  docs/*.md（INTERFACE.md、TEST-REPORT.md、RELEASING.md）
    1  docs/assets/native-toast.png（README 截图）
    9  根/资源文件（files 白名单）：cordis.patch.yml、dsh-plugin.json、icon.svg、README.md、AI-DISCLOSURE.md、LICENSE、CHANGELOG.md、assets/sounds/bubble.ogg、THIRD_PARTY_NOTICES.md
    1  package.json
    1  README.en.md（npm 始终收录 README*，即使不在 files 白名单）
    --
    27

说明：`files` 白名单与 `npm pack` 实际输出以命令结果为准；0.3.0 实测为 27 个（含 native-toast helper、goal-summary、Bubble 音效、第三方声明、AI 参与说明与 README 截图）。若未来增删 `docs/`、`lib/` 或 README* 文件，以 `npm pack --dry-run` 的实际输出为准并回填本节与 7.2 / 7.4。

## 3. 本地 git init 与首次 commit

    git init -b main
    git add --all
    git status --short
    git config --local user.name "<github-owner>"
    git config --local user.email "<maintainer-email>"
    git commit -m "chore: initial public release of dsh-notify-toast 0.3.0"

- 首次 commit 前用 `git status --short` 确认没有把 `*.tgz`、`release/`、`node_modules/`、日志、`.npmrc` 或截图原图加入暂存区（仓库的 `.gitignore` 已排除常见构建产物）。
- **git 邮箱会公开**：commit 的 author/committer 邮箱会出现在 GitHub 历史中。建议使用 GitHub noreply 邮箱（形如 `12345678+<github-owner>@users.noreply.github.com`，其中数字是 GitHub 用户 ID），或使用愿意公开的维护者邮箱；不要把私人邮箱写进仓库文件。
- 如果本机已有全局 git 身份，可只用 `--local` 覆盖本仓库。
- 发布 tag 必须指向实际发布的 commit；commit 后不要再无意义地改写历史。

## 4. 创建 GitHub 仓库并 push

先把 `<github-owner>`、`<repo>` 替换成真实值，并确认仓库名与 npm 包名策略一致。

方式 A：GitHub CLI（可选）

    gh auth status
    gh repo create <github-owner>/<repo> --public --source=. --remote=origin --push

方式 B：网页建仓

1. 打开 `https://github.com/new`，创建空仓库 `<repo>`；不要勾选自动生成 README / LICENSE / .gitignore。
2. 关联并推送：

       git remote add origin https://github.com/<github-owner>/<repo>.git
       git push -u origin main

- 认证使用本机凭据管理器、`gh auth login` 或 GitHub PAT；不要把 token 写进命令历史、`.git/config` 或仓库文件。
- push 后确认默认分支为 `main`，并确认 CI 已在 push 上运行（仓库 Settings → Actions 需允许工作流）。

## 5. 打 tag v0.3.0

tag 指向已验证的发布 commit：

    git tag -a v0.3.0 -m "dsh-notify-toast 0.3.0"
    git show --stat v0.3.0
    git push origin v0.3.0

也可以推送全部本地 tag（会推送所有 tag，执行前先 `git tag -l` 检查）：

    git push --tags

核对远端：

    git ls-remote --tags origin

## 6. 创建 GitHub Release（不会自动发布到 npm）

1. 打开仓库 → Releases → Draft a new release。
2. Tag 选择 `v0.3.0`，标题为 `dsh-notify-toast 0.3.0`。
3. 发布说明从 `CHANGELOG.md` 的 `0.3.0 — 2026-10-18` 段落生成；把「未发布（0.3.0 发布前修正）」中的用户可见项并入 0.3.0 说明，不要保留「未发布」措辞。以 CHANGELOG 为唯一来源，不改代码。
4. 可选附件：在仓库根目录执行 `npm pack`，把生成的 `dsh-notify-toast-0.3.0.tgz` 上传到 Release。0.3.0 的 DSH 插件管理器安装仍以 tgz / 本地目录 link 为主，附上 tgz 便于用户直接安装。
5. 点击 Publish release。

- GitHub Release 只是版本节点和附件，**不会触发 npm 发布**；npm 仍需按第 7 节手动 publish。
- 可选 `gh` 命令（先把发布说明保存为 `release-notes.md`）：

      gh release create v0.3.0 dsh-notify-toast-0.3.0.tgz --title "dsh-notify-toast 0.3.0" --notes-file release-notes.md

- 不要为了「自动发布」给 CI 增加 token 或 publish 步骤；本项目的发布是人工、可审计的。

## 7. 发布到 npm（人工）

### 7.1 发布前最后确认

    npm view dsh-notify-toast version --registry https://registry.npmjs.org
    npm whoami --registry https://registry.npmjs.org

未发布时 `npm view` 返回 404（预期）；如果返回了版本号，说明包名已被占用或该版本已发布，先停下来，见 9.3。

### 7.2 登录与发布

    npm login --registry https://registry.npmjs.org
    npm publish --access public --registry https://registry.npmjs.org

- 本机默认 registry 是镜像时，**不带 `--registry` 的 `npm publish` 不会发到 npm 官方源**；必须显式指定。
- `--access public`：本包是 unscoped 包，该参数用于显式声明公开；不要使用 `--access restricted`。
- 开启 2FA 的账号会在 publish 时提示 OTP；也可以 `--otp <code>`，但不要把 OTP 写进仓库或文档。
- 在仓库根目录执行；npm 按 `files` 白名单打包，并会自动收录 README*，当前共 27 个文件。项目没有 `prepublishOnly` / `prepare` 等生命周期脚本，不会额外执行命令。
- 如果 npm 返回 403 / 404 表示包名不可用，不要反复重试；按 9.3 处理。

### 7.3 发布后立即校验

    npm view dsh-notify-toast version --registry https://registry.npmjs.org
    npm view dsh-notify-toast dist.integrity dist.tarball --registry https://registry.npmjs.org

`version` 应为 `0.3.0`。

### 7.4 从 registry 重新下载并复验

    rm -rf /tmp/dsh-notify-toast-registry-check
    mkdir -p /tmp/dsh-notify-toast-registry-check
    cd /tmp/dsh-notify-toast-registry-check
    npm pack dsh-notify-toast@0.3.0 --registry https://registry.npmjs.org
    tar -xzf dsh-notify-toast-0.3.0.tgz
    node -e "const p=require('./package/package.json'); console.log(p.name, p.version, p.license, p.type)"
    node --check package/lib/index.js
    node --check package/lib/client.js
    tar -tzf dsh-notify-toast-0.3.0.tgz
    tar -tzf dsh-notify-toast-0.3.0.tgz | grep -vc '/$'

预期：`package.json` 输出 `dsh-notify-toast 0.3.0 MIT module`；最后一条命令输出 `27`（tar 列表去掉目录条目后的文件数；不包含 `test/` 与 `scripts/`）。

## 8. 发布后验证

- npm 包页面 `https://www.npmjs.com/package/dsh-notify-toast` 显示 0.3.0、README、LICENSE 与版本列表。
- GitHub Release `https://github.com/<github-owner>/<repo>/releases/tag/v0.3.0` 可访问，附件（可选）可下载。
- CI `https://github.com/<github-owner>/<repo>/actions` 最近一次运行绿色；矩阵为 windows-latest / ubuntu-latest × Node 22 / 24，共 4 个组合。
- DSH 插件管理器：0.3.0 仍按 tgz 交付——用 `plugin_manager` 的 `install_bundle` 指向 Release 附件 `dsh-notify-toast-0.3.0.tgz`（或本地 `npm pack` 产物）；首次安装/升级后重启 DSH。**从 npm registry 直接安装的体验尚未在 0.3.0 上验证，不要写入安装文档宣称已验证。**
- 回填文档：README、README.en.md、SECURITY 已写入本仓库真实地址 `https://github.com/game25011/dsh-notify-lite`；Code of Conduct 使用 SECURITY.md 的私密渠道。发布前只需确认 README/README.en.md 的截图已补，且本手册示例中的 `<github-owner>` / `<repo>` / `<maintainer-email>` 已按实际替换；如果这些改动影响已发布的 tgz，按 9.1 发 patch，而不是改已发布的 0.3.0。

## 9. 回滚与撤销

### 9.1 npm：优先 deprecate + patch，不要轻易 unpublish

npm 的撤销政策要点（以 npm 官方文档为准）：

- 发布后 **72 小时内**可申请整包撤销（`npm unpublish <package> --force`），限制很严；
- 可单独撤销某个版本（`npm unpublish <package>@<version>`），但**同一版本号通常不能原样重发**；
- 一旦有其他包依赖该版本，不能删除；
- 超过 72 小时后一般不再允许整包删除，只有安全/恶意内容等特殊情况可联系 npm support。

推荐流程（内容有问题但包仍可用）：

    npm deprecate dsh-notify-toast@0.3.0 "Deprecated: use a newer release" --registry https://registry.npmjs.org

修复问题、提升版本号后发布 patch：

    npm publish --access public --registry https://registry.npmjs.org

只有在刚发布且确认无人依赖时才考虑单版本撤销：

    npm unpublish dsh-notify-toast@0.3.0 --registry https://registry.npmjs.org --force

整包撤销（危险，仅 72 小时内）：

    npm unpublish dsh-notify-toast --force --registry https://registry.npmjs.org

- 撤销/弃用不会影响本地 tgz 与 GitHub Release；需要同步更新 Release 说明和文档。
- `npm deprecate` 后可用 `npm view dsh-notify-toast deprecated --registry https://registry.npmjs.org` 核对弃用说明。

### 9.2 git tag 与 GitHub Release

删除并重打**尚未公开**的 tag：

    git tag -d v0.3.0
    git push origin :refs/tags/v0.3.0
    git tag -a v0.3.0 -m "dsh-notify-toast 0.3.0"
    git push origin v0.3.0

- **已经公开或被引用的 tag 不要 force push 重写**；正确做法是发布新版本、新 tag。tag 一旦被用户下载，删除会让历史不可复现。
- GitHub Release 撤回：编辑 Release → 取消 Publish 或删除。删除 Release 默认不会删除 git tag（tag 需按上面的命令单独删）。
- 如果 npm 版本已发布，GitHub tag、Release 与 npm 版本号要保持对应；撤销 npm 版本后不要复用 `0.3.0` 版本号。

### 9.3 包名被占用时的备选

如果 `dsh-notify-toast` 已被他人占用（`npm view` 返回了版本），不要抢注、覆盖或发布到镜像：

1. 首选改为 scope 包：`@<github-owner>/dsh-notify-toast`；
2. 需要同步修改 `package.json` 的 `name` 以及代码、文档、DSH 安装说明中的包名——**本手册不负责改代码**，需另开变更并完整回归；
3. scope 包发布同样使用 `npm publish --access public --registry https://registry.npmjs.org`（scope 包默认 restricted，必须显式 public）；
4. 改名前先跑 `npm test`、`npm run smoke`、`npm pack --dry-run`，并确认 DSH 插件管理器能安装 scope 包；
5. 不要在同一个 tag 上改名后继续复用；重新打 tag、更新 Release。

## 10. 发布前必须替换的占位符

| 占位符 | 出现位置（需人工替换） | 替换为 |
|---|---|---|
| `<github-owner>` | 本手册的 GitHub URL / `gh repo create` / `git remote` 示例 | GitHub 用户名或组织名 |
| `<repo>` | 本手册的 GitHub URL / `gh repo create` 示例 | 仓库名（建议 `dsh-notify-toast`） |
| `<maintainer-email>` | 本手册的 git 身份示例 | 公开维护者邮箱，建议 GitHub noreply 邮箱 |
| `<github-user-id>` | 采用 noreply 邮箱时的 `12345678+<github-owner>@users.noreply.github.com` 前缀 | GitHub 数字用户 ID |
| 截图 | README / README.en.md 的截图待补说明 | 一张真实 Windows 右下角 toast 截图（PNG，不伪造） |

> 本仓库实际地址为 `https://github.com/game25011/dsh-notify-lite`，已写入 `package.json`、`README.md`、`README.en.md` 与 `SECURITY.md`；上表中的占位符只保留在本手册的命令示例里，首次执行时按实际替换即可。

发布前检查仓库中是否还有未替换的占位符和本机信息：

    git grep -n "<github-owner>"
    git grep -n "<repo>"
    git grep -n "<maintainer-email>"
    git grep -n -E "(^|[^A-Za-z])[A-Za-z]:[\\\\/]|/(Users|home)/|sk-|npm_[A-Za-z0-9]{20,}"

命中项逐条确认：文档示例中刻意保留的通用路径可以保留；真实本机绝对路径、个人邮箱、token/密钥必须删除。本手册自身包含上述检查模式，`git grep` 命中本文件属于预期。
