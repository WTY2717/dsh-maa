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
├─ package.json        # dsh.bundle.patch / dsh.client + 依赖（koffi / schemastery）
├─ cordis.patch.yml    # 唯一的 Loader 行：id=maa-plugin
├─ index.js            # apply(ctx, config)：起桥 + 设置页路由 + 注册 13 个工具
├─ client.js           # Web 客户端半：设置页（settings.plugins.tab）
├─ src\                # 实现：config / maa / pe / doctor / roster / stages / copilot / adb
│  ├─ prts\            #   作业站查询与练度容差匹配
│  ├─ remote\          #   远程控制桥（MAA 反向轮询）
│  └─ core\            #   MaaCore 子进程驱动（koffi 绑定 + 回调语义表）
├─ locale\{zh,en}.json # 插件管理界面里的标题/描述
├─ icon.svg
├─ skill\SKILL.md      # 模型侧技能（复制到 ~\.dsh\skills\ 后所有会话可见）
├─ scripts\recover.ps1 # 插件把 DSH 搞挂时的自救脚本
└─ test\               # selftest.mjs（功能）/ hardening.test.mjs（崩溃回归）
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

本仓库已发布在 GitHub（私有）：`https://github.com/WTY2717/dsh-maa`。安装框里填以下任一即可：

```
github:WTY2717/dsh-maa
https://github.com/WTY2717/dsh-maa
git+https://github.com/WTY2717/dsh-maa.git#v1.2.2     （钉 tag/commit）
```

私有库的安装端需要有该仓库读权限（本机 Git Credential Manager 登录一次即可）。

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
