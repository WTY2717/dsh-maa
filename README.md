# @local/dsh-maa —— MAA 插件（DSH）

把 MAA（MaaAssistantArknights）接到 DSH 里的**正式插件**：22 个原生工具，三条通道并存；**启动时先检查 MuMu 模拟器，没开就自动拉起**；`maa_wakeup` 复用 MAA「开始唤醒」直接进主界面（实测可单独调用，不用自己点登录）；抄作业带**中途生命值守则**（掉血立刻停、退出关卡返还理智）；**多用户换号 / 新用户登录**（本地账号簿 + 动态账号切换 + 手机号验证码 / 扫码登录）；**任务状态文件**（给外部排队用，QQ 机器人 `/liw` 联动）。

| 能力 | 后端 | 工具 |
|---|---|---|
| 日常 / 刷关 / 基建 / 公招 / 截图 / 改配置 | **远程控制协议**（MAA 主动轮询本机桥） | `maa_health` `maa_run` `maa_tasks` `maa_wait` `maa_screenshot` `maa_current` `maa_stop` `maa_set` |
| 唤醒到主界面（= MAA「开始唤醒」，可单独调用） | 远程控制协议 | `maa_wakeup` |
| 到作业站找作业并自动抄（含练度容差） | **MaaCore 直连**（koffi + 子进程） | `maa_copilot_find` `maa_copilot_run` `maa_copilot_verify` `maa_click` |
| 抄作业中途盯防（后台跑 / 看进度 / 掉血止损） | 同上（后台子进程 + adb 截图） | `maa_copilot_status` `maa_copilot_stop` |
| 导航（拖地图 / 翻关卡列表，不消耗理智） | **adb `input`**（1280×720 换算成设备坐标） | `maa_swipe` |
| 模拟器自启（查状态 / 没开就拉起并等到能连） | `MuMuManager.exe` | `maa_emulator` |
| 多用户换号 / 新用户登录（本地账号簿、动态切号、输入手机号/验证码） | adb `input text` + MaaCore `StartUp` | `maa_account_book` `maa_input_text` `maa_account_switch` |
| 任务状态（给外部排队 / 其它插件读「MAA 闲不闲」） | 原子写 `data\task-state.json`（MAA 写、外部只读） | `maa_task_state` |
| 自检 | 纯读本地文件 + PE 导出表 | `maa_doctor` |

**防非三星（v1.6.0）**：三星要求**目标生命值不掉**。正式抄作业用 `background:true` 起跑，每 ~10 秒 `maa_copilot_status` + 截图盯生命值；一旦掉血 → `maa_copilot_stop` → 点「暂停 → 退出行动」（结算前退出**返还全部理智**）。所有作业都掉血就如实告诉用户「没有能三星通关的作业」。

**为什么三条通道**：MAA 的远程控制协议里**没有 Copilot 任务**（只有 `LinkStart*` / `CaptureImage` / `StopTask` / `HeartBeat` / `Toolbox-*` / `Settings-*`），抄作业只能直连 `MaaCore.dll`；而 Copilot 不做导航、MaaCore 也没有 swipe 导出接口，所以滑动走 adb `input swipe`。都是协议事实，不是实现偷懒。**账号切换同理**：远程控制没有独立的「切号」类型、`LinkStart-WakeUp` 也不接受参数，所以动态切号只能直连 MaaCore 下发 `StartUp + account_name`。

**多用户 / 换号（v2.1.0）**：一台电脑多人用时，本地账号簿 `data\accounts.json` 记「**掩码登录名** ↔ 昵称」（官服 11 位手机号入库自动转成前三后四 `173****8245`，**本地不留完整手机号**；只存本地、不联网、`list` 打码、验证码从不落盘）。老用户 `maa_account_switch({phone:"<掩码>"})` 动态切号（MaaCore 直连 `StartUp + account_name`；MAA 只认游戏登录页显示的掩码形态，完整手机号匹配不上；只支持官服/B服/繁中/韩服，且只能切本机登录记录里已有的号）；切不过去/登录过期 = 新用户，走手动登录：手机号+验证码 或 扫码（`maa_click` + `maa_input_text`，二维码截图发给用户、过期刷新；要发验证码时向用户要完整手机号，账号簿里没有）。切号任务链可能「实际切成功但报表 FAILED」（ExceededLimit）——先截图核对医生名，别直接让人重登。流程与坐标见 `docs\tools\maa-accounts.md`，模型侧规则在 `skill/SKILL.md`「多用户：换号 / 新用户登录」。

**任务状态文件（v2.1.0，给外部排队用）**：插件把「当前有没有任务在跑」原子写到 `data\task-state.json`（tmp + rename），并注册只读工具 `maa_task_state`（`waitMs` 可长轮询下一次变化）。字段：`epoch`（每次插件加载都变）、`running`、`taskType`、`sequence`、`lastFinishedSeq`、`lastFinished{type,status,at}`、`active[]`、`coverage` 等。口径：**只统计经本插件下发的有意义任务**（`LinkStart*` / 抄作业 / 账号切换 / 唤醒），截图/心跳/StopTask/Settings/Toolbox 不算；**MAA 界面里手点的任务看不到**（`coverage:"plugin-observable"`）；`AccountSwitch` 与 `LinkStart-WakeUp` 是交接任务，**它们的结束不算用户服务结束**。跨插件契约见 `docs\plans\qqbot-side-integration-spec.md` §3；MAA 侧不读 QQ 队列、不发 QQ 消息。

**给模型的通用引导**（首次使用也能找到关卡）：主线 = 终端 → 曲谱 → 乐章收录（章节列表上下滑，右下角 `EPxx` = 第 xx 章）；往期活动在同一个章节列表的最下方（艺术字封面 + 普通/EX/特殊关切换）；当期活动是终端页左侧海报（结束后显示「作战已结束」）；H 关要先切到最高难度才出现在地图最右侧。这段话同时写在 `skill/SKILL.md`（「怎么走到目标关卡」）和 `maa_swipe` 的工具描述里。

## 安装

插件是一个 bundle 包（`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`）：

```
plugins\maa-plugin\
├─ package.json        # dsh.bundle.patch / dsh.client + 依赖（koffi / schemastery）
├─ cordis.patch.yml    # 唯一的 Loader 行：id=maa-plugin
├─ index.js            # apply(ctx, config)：模拟器自启 + 起桥 + 设置页路由 + 任务状态文件 + 注册 22 个工具
├─ client.js           # Web 客户端半：设置页（settings.plugins.tab）
├─ src\                # 实现：config / maa / pe / doctor / roster / stages / stages-hard / copilot / adb / emulator / wakeup / account-book / switch-account / task-state
│  ├─ input\           #   滑动手势：coords（换算）/ adb-input（注入）/ backend（后端探测）
│  ├─ prts\            #   作业站查询、练度容差匹配、严格优先的作业挑选
│  ├─ remote\          #   远程控制桥（MAA 反向轮询）
│  └─ core\            #   MaaCore 子进程驱动（koffi 绑定 + 回调语义表）
├─ locale\{zh,en}.json # 插件管理界面里的标题/描述
├─ icon.svg
├─ skill\SKILL.md      # 模型侧技能（复制到 ~\.dsh\skills\ 后所有会话可见）
├─ scripts\recover.ps1 # 插件把 DSH 搞挂时的自救脚本
└─ test\               # 11 份自测：selftest / hardening / swipe / match / emulator / copilot-runner / wakeup / account-book / switch-account / input-text / task-state
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

所以「填包名 / GitHub 地址就能装」这件事，插件这边不需要改代码——**前提是这个包在 npm 上、或在 GitHub 上**。

本仓库已开源在 GitHub（**公开**，无需登录或授权）：`https://github.com/WTY2717/dsh-maa`。安装框里填以下任一即可：

```
github:WTY2717/dsh-maa
https://github.com/WTY2717/dsh-maa
git+https://github.com/WTY2717/dsh-maa.git#v2.0.0     （钉 tag/commit）
```

公开库不用任何凭证；只有装私有 fork 时，安装端才需要有该仓库读权限（本机 Git Credential Manager 登录一次即可）。

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

**git 安装的更新语义**：跟着分支走 → 重新安装即更新；要钉版本就在地址后加 `#v2.0.0`（tag）或 `#<commit>`。

## 开发（改代码 / 跑测试 / 重载）

本工作区里 `plugins\maa-plugin` 已经用 `link:` 装进 desktop profile，改完代码不用重装，重载即可。

**跑自测**（11 份 / 187 项，全绿才算可发；除 `selftest` 外都不碰 MAA 和模拟器）：

```powershell
node test/selftest.mjs          # 需要本机装了 MAA（自动探测；只读文件、不连接、不消耗理智）
node test/hardening.test.mjs
node test/swipe.test.mjs
node test/match.test.mjs
node test/emulator.test.mjs
node test/copilot-runner.test.mjs
node test/wakeup.test.mjs
node test/account-book.test.mjs  # 本地账号簿（掩码登录名）
node test/switch-account.test.mjs # 动态切号（假 CoreWorker）
node test/input-text.test.mjs    # 手机号/验证码输入
node test/task-state.test.mjs    # 任务状态文件（跨插件契约 v1）
# 有 npm 的机器也可以直接：npm test
```

**改了代码不会自动生效**（ESM 已缓存）：`plugin_manager(set_plugin, target="include:maa-plugin", enabled:false)` → 再 `enabled:true` → 调一次 `maa_doctor` 确认 `problems` 为空（新工具 / 新字段才会出现）。

**改了 `skill/SKILL.md`**：插件目录里的副本不会自动同步到全局技能目录，要手动拷（两份必须逐字节一致）：

```powershell
Copy-Item skill\SKILL.md "$env:USERPROFILE\.dsh\skills\maa-arknights\SKILL.md"
```

**发版**：功能改动 → 改 `package.json` 版本 → 打包出 `dist\local-dsh-maa-<版本>.tgz`（`pnpm pack`，本机没有 pnpm 可用 `npm.cmd pack`）→ 打 tag `v<版本>` → 建 GitHub Release（标题「dsh-maa v<版本>」，正文只写用户能感知的新增/优化/修复，不写代码细节）；只改文档或规则 → 直接提交推送，不新发版本。
