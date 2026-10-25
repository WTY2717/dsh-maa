# @local/dsh-maa —— MAA 插件（DSH）

把 MAA（MaaAssistantArknights）接到 DSH 里的**正式插件**：13 个原生工具，两条后端并存。

| 能力 | 后端 | 工具 |
|---|---|---|
| 日常 / 刷关 / 基建 / 公招 / 截图 / 改配置 | **远程控制协议**（MAA 主动轮询本机桥） | `maa_health` `maa_run` `maa_tasks` `maa_wait` `maa_screenshot` `maa_current` `maa_stop` `maa_set` |
| 到作业站找作业并自动抄（含练度容差） | **MaaCore 直连**（koffi + 子进程） | `maa_copilot_find` `maa_copilot_run` `maa_copilot_verify` `maa_click` |
| 自检 | 纯读本地文件 + PE 导出表 | `maa_doctor` |

**为什么两条后端**：MAA 的远程控制协议里**没有 Copilot 任务**（只有 `LinkStart*` / `CaptureImage` / `StopTask` / `HeartBeat` / `Toolbox-*` / `Settings-*`），抄作业只能直连 `MaaCore.dll`。这是协议事实，不是实现偷懒。

## 安装

插件是一个 bundle 包（`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`）：

```
plugins\maa-plugin\
├─ package.json        # dsh.bundle.patch + 依赖（koffi / schemastery）
├─ cordis.patch.yml    # 唯一的 Loader 行：id=maa-plugin
├─ index.js            # apply(ctx, config)：起桥 + 注册 13 个工具
├─ src\ ...            # 实现（见下）
├─ locale\{zh,en}.json # 插件管理界面里的标题/描述
├─ icon.svg
└─ test\selftest.mjs   # 不装插件、不消耗理智的自测
```

装进当前 profile（走插件管理器，不要手改 profile）：

```
plugin_manager(action="install_bundle", target="<workspace>\plugins\maa-plugin")
```

装好后在**插件管理界面**能看到「MAA 明日方舟助手」，禁用后工具立即消失。

## 在插件管理器的安装框里安装（包名 / GitHub / 本地路径）

DSH 的安装框直接吃 pnpm 的 spec，宿主 `parseInstallSpec` 支持四类（源码里逐个正则核对过）：

| 你填什么 | 判定 | 例子 |
|---|---|---|
| **本地目录（必须绝对路径）** | `path` | `C:\tools\maa-plugin` / `link:C:\tools\maa-plugin` |
| **本地/远程 tarball** | `tarball` | `C:\tools\local-dsh-maa-1.2.1.tgz` / `https://…/x.tar.gz` |
| **Git 仓库** | `git` | `github:you/dsh-maa` / `https://github.com/you/dsh-maa` / `git+https://…git#v1.2.1` / `git@github.com:you/dsh-maa.git` |
| **npm 包名** | `registry` | `@you/dsh-maa` / `@you/dsh-maa@1.2.1` |

**会被拒的**：相对路径（`plugins\maa-plugin` → “a local path must be absolute”）、非 git 也非 tgz 的 URL（比如 `.zip` 直链 → “a URL must point at a git repository or a tarball”）。

所以「填包名 / GitHub 地址就能装」这件事，插件这边不需要改代码——**前提是这个包在 npm 上、或在 GitHub 上**。本目录已经 `git init` 并提交（34 个文件，`.gitignore` 排除了 `node_modules/`、`data/`、`dist/`），你只差推送：

```powershell
# 1) 先在 GitHub 建一个空仓库（不要勾 README），然后
cd plugins\maa-plugin
git remote add origin https://github.com/<你的用户名>/dsh-maa.git
git branch -M main
git push -u origin main

# 2) 之后任何人（包括你自己换台机器）在安装框里填：
#    github:<你的用户名>/dsh-maa
#    或 https://github.com/<你的用户名>/dsh-maa
```

发布到 npm 才有「只填包名」：改两行再 `npm publish`。

```powershell
# package.json: "name": "@yourname/dsh-maa"  "/private": false
npm publish --access public
# 安装框填：@yourname/dsh-maa
```

**换来源前先卸掉现有的链接安装**，否则同名两份：

```
plugin_manager(action="remove_bundle", target="@local/dsh-maa")
# 再用上面的地址装一次
```

**git 安装的更新语义**：跟着分支走 → 重新安装即更新；要钉版本就在地址后加 `#v1.2.1`（tag）或 `#<commit>`。

## 发给别人（三种方式）

**对方需要的前提**：Windows + DSH ≥ `0.2.1-rc.3`（manifest 里已声明 `dsh.engines.dsh`）+ **完整版 MAA**（任何版本，只要 `MaaCore.dll` 和 `resource\` 在）+ MuMu/adb。**不要**同时启用旧的 `mcp-maa`（抢 18764 端口）。

### A. 给 tarball（推荐，约 64 KB）

```powershell
# 打包方（在本机）
pnpm pack --pack-destination <workspace>\dist        # → dist\local-dsh-maa-<ver>.tgz
# 接收方
plugin_manager(action="install_bundle", target="file:C:\path\to\local-dsh-maa-1.2.1.tgz")
```
`pnpm add file:…tgz` 这条路已实测可用；依赖（koffi / schemastery / cosmokit）由对方的 pnpm 自己装，**不需要**联网以外的准备。

### B. 给 zip（对方不想敲命令时最省事）

1. 打包方：把插件目录压缩，**排除** `node_modules\` 和 `data\`（后者是本机截图/作业/设置，16–19 MB）。
   ```powershell
   $src='plugins\maa-plugin'; $dst='tmp\dsh-maa-1.2.1'
   robocopy $src $dst /E /XD node_modules data .git /NFL /NDL /NJH /NJS
   Compress-Archive -Path "$dst\*" -DestinationPath dist\dsh-maa-1.2.1.zip -Force
   ```
2. 接收方：解压到任意目录 → `plugin_manager(action="install_bundle", target="<解压后的目录>")`（目录里的 `node_modules` 会由对方的 pnpm 现装）。

### C. 发布到 npm（长期/多人用）

```powershell
# package.json 里改两处：name 换成自己的 scope（@local 不是你能发的），private 改 false
#   "name": "@yourname/dsh-maa", "private": false
npm publish --access public
# 接收方
plugin_manager(action="install_bundle", target="@yourname/dsh-maa")
```

### 对方装完之后

1. `maa_doctor` → `problems` 为空；重点看 MAA 版本、练度解析（N 行 / 拥有 M）。
2. **装上技能**（让模型在每条对话里都会主动按规范调用；不装也能用工具，但模型得自己摸索顺序）：
   ```powershell
   New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\skills\maa-arknights" | Out-Null
   Copy-Item "<插件目录>\skill\SKILL.md" "$env:USERPROFILE\.dsh\skills\maa-arknights\SKILL.md" -Force
   ```
   放用户级目录 = 该机器**所有 profile / 所有工作区**的会话都能看到技能 `maa-arknights`（新会话的技能目录里会直接列出来）。
3. 设置 → 插件 → **「MAA 助手」** → 填自己的 MAA 目录 / 练度文件 / adb（都能留空自动探测）。
4. 用 `maa_copilot_find 1-7` + `maa_copilot_run({file, dryRun:true})` 先做零消耗验证，再真跑。

### 分发时的三个坑

- **别把 `data\` 发出去**：里面有本机截图（16 MB+）、落盘作业、`core-user` 缓存和自己的 `settings.json`。`files` 字段已经排除它，`pnpm pack` 产出的 tarball 里核实过没有。
- **npm 安装形态下 `data\` 会落在 `node_modules` 里**，升级/重装就丢。让对方在设置里把 `dataDir` 指到包外（例如 `%USERPROFILE%\.dsh\data\maa-plugin`）。
- **`koffi` 必须留在 2.x**：3.x 在 pnpm 的 junction 布局下找不到原生模块（见崩溃/依赖那节）。

## 让模型在所有对话里正确调用（技能）

工具是**全局注册**的：插件一旦启用，该 profile 下每条会话（含子 agent）都能看到 13 个 `maa_*` 工具。但「怎么按顺序用、什么代价、什么禁止」需要一份稳定的说明书，否则模型会瞎试。

所以内容分两层：

| 层 | 位置 | 作用 |
|---|---|---|
| 工具描述 | `src/tools.js` 的 `description` | 每个工具怎么用、代价、坑（模型每次都能看到） |
| **技能** | `~\.dsh\skills\maa-arknights\SKILL.md`（用户级根） | 触发词 + 六步 SOP + 验收 + 禁则 + 手册索引；**所有会话的技能目录里都会列出**，提到明日方舟时自动加载 |
| 手册 | `docs\tools\maa*.md` | 详细用法与「现象 → 原因 → 做法」故障库 |

技能文件在包里有一份 `skill\SKILL.md`（与用户级那份内容一致，改的时候以包内为准再复制过去）。技能不是插件自动安装的——它落在用户目录，属于「这台机器的模型行为」，由用户显式复制一次。

## 配置（设置页可直接改，改完不用重启）

| 字段 | 默认 | 说明 |
|---|---|---|
| `maaInstallPath` | 空=自动探测 | 必须同时有 `MaaCore.dll` 与 `resource\stages.json` |
| `rosterPath` | 空=自动探测 | 用户导出表（`.md`）或 `{own_opers:[…]}` 的 `.json` |
| `adbPath` | 空=自动探测 | MuMu 为 `<实例>\shell\adb.exe` |
| `adbAddress` | `127.0.0.1:16384` | 模拟器 adb 地址 |
| `adbConfig` | `MuMuEmulator12` | MaaCore 连接配置名 |
| `formationIndex` | `0` | 自动编队栏位，0=当前编队 |
| `bridgePort` | `18764` | MAA 的「远程控制」端点必须填同一端口 |
| `dataDir` | 空=`<插件>\data` | 作业 JSON、截图、核心用户目录、日志都在这下面。**按 registry 包安装时务必指到包外**（包目录会被升级覆盖） |
| `nodePath` | 空=自动 | 跑 MaaCore 子进程的 node；默认用 Electron 的 `ELECTRON_RUN_AS_NODE`。改了立即生效（缓存按该值分键） |
| `connectExtras` | 空=自动 | 留空按 `adbPath` 推导 MuMu 实例目录（`{path,touch:false,client_type:Official}`） |
| `popupGuard` | `false` | 开打后自动补点画面中央，绕过「干员等级过低」弹窗（主任务结束就不再点） |
| `copilotTimeoutSeconds` | `900` | 单次抄作业最长等待 |

**稳定契约清单**（R2 的口径）：`Asst*` C ABI、`resource\stages.json`、`resource\version.json`、Copilot JSON schema、远程控制 HTTP 协议。
`config\gui.new.json` 是 **best-effort**：读它只为拿到用户配好的 adb/实例目录，读不到就回退自动探测——它不在稳定契约里，不要在这条路上加“读不到就报错”。

MAA 侧还要做一件事：MAA GUI 的 **设置 → 连接设置 → 远程控制** 填 `http://127.0.0.1:18764`（端口与 `bridgePort` 一致）。

### 设置页在哪、值存在哪

**主入口（两步）**：设置 → 插件 → 顶部分页 **「MAA 助手」**。顶部三行状态卡（MAA 版本+路径 / 练度解析 / adb+桥端口），下面 12 个字段。
**次入口（深链）**：设置 → 插件 → 已安装 → `@local/dsh-maa` → 包页 → `maa-plugin` 行「配置」。

- 快捷入口注册在 `settings.plugins.tab`（`id: 'maa'`, `order: 20`, `label: 'MAA 助手'`，与内置「已安装」并列）；深链注册在 `plugins.row.config`（key `@local/dsh-maa#maa-plugin`）。两处共用同一个 `ConfigPanel`。
- 样式只用官方主题 token（`--dsw-alias-*`，取自 `Theme.listTokens` 的 14 个），不发明颜色，明暗主题跟手；注意 **没有** `label-tertiary` / `border-l3/l4` 这类 token，用了会掉到 fallback。
- 值存在 `data/settings.json`（只收白名单字段、类型不合法就丢弃），**优先级高于** `cordis.patch.yml` 里那条 Loader 行 config；保存后下一次工具调用即生效。
- 宿主侧通道：`GET/POST /maa/api/config`（实现见 `src/ui-config.js`）。

### 崩溃红线（2026-10-25 事故）

- **不要给 Config 字段加 `.volatile()`**：本机 DSH 里它 resolve 出来是 cosmokit 的 Volatile 包装对象，当字符串用会 `TypeError`；若这个异常发生在「发出去不管」的异步调用里，就是未捕获 Promise 拒绝 → Node 直接退出 → 整个 DSH 崩掉。
- 插件里**任何** `void asyncFn()` 都必须 `.catch(...)`；`apply` / HTTP handler / 定时器全部包 `try/catch`。
- 配置值一律类型清洗后再用（`typeof x === 'string' ? x : fallback`）。
- 自测里专门有一组 `test/hardening.test.mjs` 覆盖这些点，改动配置/入口后先跑它。

### 起不来时的自救

```powershell
powershell -ExecutionPolicy Bypass -File "plugins\maa-plugin\scripts\recover.ps1"
```
它只做一件事：把 `@local/dsh-maa` 从 profile 的 `dsh.profile.bundles` 里移除（先备份 `package.json`），重启 DSH 即恢复。不需要 DSH 能启动。

## 用法口径（踩过坑的结论，别省略）

1. **先 `maa_doctor`**：路径 / 版本 / 能力表 / 练度解析 / adb 一次看全。`problems` 是必须修的。
2. 远程控制：`maa_health` → `maa_run` 拿 taskId → `maa_wait` **循环**（单次 ≤55 秒），中间夹 `maa_screenshot`。
   `SUCCESS` 只代表任务结束，**不代表跑完了**。
3. 抄作业：
   - 游戏停在**目标关卡的详情页或编队页**（Copilot 不会自己导航到关卡）；
   - **代理指挥要关**（开着会锁死队伍，MAA 选不上人；Copilot 任务链不带 `NotUsePrts`）；
   - `maa_copilot_find 1-7` → 拿 `jobs[].file` → `maa_copilot_run {file, dryRun:true}` 先验证 core 能解析（不消耗理智）→ 去掉 `dryRun` 真跑；
   - **跑完必须看 `screenshot` 判断三星**（`read_image`）。`done=true` 不等于三星。
4. 练度口径（用户定，实现见 `src/prts/match.js`）：
   - 作业要专精（`skill_level>7`）→ 按 7 级技能代替，不再降；
   - 精二等级允许下浮 30，但不低于精二 60；
   - 模组原样交给 MAA 用游戏内数据复验；
   - **练度不够就换作业，不提练度**；导出表是唯一事实来源（表里没有技能等级/模组，所以"表里匹配通过"不等于 MAA 放行）。
5. 涉及真实消耗（理智、抽卡、碎石、吃药、`StopTask` 打断正在跑的长草）**先问用户**。

## 实现要点（给以后改代码的人）

- **零打包**：不复制 `MaaCore.dll` / `resource\`（267 MB），运行时定位本机 MAA。
- **只依赖稳定契约**：`Asst*` C ABI（koffi 动态符号绑定）、`resource\version.json`、`resource\stages.json`、Copilot JSON schema、远程控制 HTTP 协议。
- **能力探测**：`src/pe.js` 直接读 PE 导出表，缺符号就降级并在 `maa_doctor` 里列出（不崩）。版本号读 `MAA.exe` 的版本资源——`MaaCore.dll` **没有**版本资源（实测）。
- **不解析内部日志**：`debug\asst.log` 只供人看；程序判定只认回调 `what` + `details`（`src/core/callbacks.js` 是数据表，未知 id 忽略）。
- **MaaCore 在子进程里跑**（`src/core/worker.mjs`）：
  - `AsstDestroy` 在「已 Append 未 Start」时会**永久阻塞**（实测），放 Host 里会冻住整个 DSH；
  - 卡死/崩溃可被 kill；
  - 「干员等级过低」弹窗必须由**另一个核心会话**点掉，另起一个 worker 天然满足。
- **坐标一律 1280×720**（不是设备 1920×1080）。`adb shell input tap/swipe` 对这个 Unity 游戏无效。

## 代码地图

| 文件 | 职责 |
|---|---|
| `index.js` | 插件入口：桥的懒启动/重试、工具注册、设置页路由挂载（全部 no-throw + `.catch`） |
| `client.js` | Web 客户端半：`plugins.row.config` 那一格（设置表单） |
| `src/config.js` | schemastery `Config` + 类型清洗后的配置解析（**绝不抛**） |
| `src/settings-store.js` | 设置页持久化：`data/settings.json` 白名单 + 原子写 |
| `src/ui-config.js` | 设置页读写通道 `GET/POST /maa/api/config` |
| `src/maa.js` | MAA 定位（配置 → 常见路径 → 版本/时间排序）、版本、能力表 |
| `src/maa-config.js` | 读 MAA 自己的 `gui.new.json` 拿 adb/地址/实例目录 |
| `src/pe.js` | PE 版本资源 + 导出表解析（纯 JS，无依赖） |
| `src/doctor.js` | `maa_doctor` 的组装 |
| `src/roster.js` | 导出表 Markdown / JSON 解析 + mtime 缓存 |
| `src/stages.js` | 关卡代号 ↔ 内部 stageId |
| `src/prts/api.js` | 作业站 `/copilot/query`、`/copilot/get` |
| `src/prts/match.js` | 练度容差 + 匹配 |
| `src/copilot.js` | 找作业 → 落盘 → 跑 → 截图验收编排 |
| `src/remote/bridge.js` | 远程控制桥（HTTP + 队列 + 回执 + 重发策略） |
| `src/core/callbacks.js` | 回调语义表 |
| `src/core/worker.mjs` | 子进程：koffi 绑定 + MaaCore 操作 + 回调转发 |
| `src/core/driver.js` | 子进程管理：node 解析、JSON 行 RPC、超时、收尸 |
| `src/adb.js` | adb 定位、连设备、直接截图 |
| `scripts/recover.ps1` | 起不来时自救：从 profile bundles 移除本插件 |
| `test/selftest.mjs` | 功能自测（21 项） |
| `test/hardening.test.mjs` | 崩溃回归自测（22 项：类型清洗 / 绝不抛 / 客户端冒烟） |

## 自测

```powershell
# 不联网、不装插件、不消耗理智
node plugins\maa-plugin\test\selftest.mjs
# 加上作业站查询（联网）
node plugins\maa-plugin\test\selftest.mjs --online
```

注意：沙箱里的 shell 无法用管道 spawn（`spawn EPERM`，命名管道被禁），所以自测里的「MaaCore 子进程」两节只能在**非沙箱**环境（如 Host 内工具调用）里跑通；沙箱里会报「找不到可用的 node」。这不是插件缺陷。

## 回滚

- 插件管理界面禁用它 → 工具消失；卸载 → 包移除。
- 旧的 `mcp-maa`（`plugins\maa-mcp\`）与本插件功能重叠且会抢 18764 端口：启用本插件前先在插件管理器里禁用它。旧插件仍留在 workspace 里作参考。
