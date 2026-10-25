---
name: maa-arknights
description: 用 maa_* 工具驱动本机 MAA（明日方舟）——日常/刷关/基建/公招/信用商店/肉鸽/生息演算/抽卡/截图，以及到作业站找作业并自动抄（Copilot）。用户提到明日方舟、MAA、抄作业、刷本、看游戏画面时加载。
whenToUse: 用户说 明日方舟 / MAA / 日常 / 打扫卫生 / 刷 1-7 / 打某关 / 基建换班 / 公招 / 信用商店 / 肉鸽 / 生息演算 / 牛牛抽卡 / 抄作业 / 看看现在什么画面 / 理智还剩多少 时。
---

# MAA 明日方舟（`maa_*` 工具）

插件：`@local/dsh-maa`（bundle 目录 `plugins\maa-plugin`；装进 profile 后在 `node_modules` 里，设置页在 **设置 → 插件 → 「MAA 助手」**）。**不要**用 adb 点击或浏览器截图替代；协议里查不到理智/仓库/关卡，别编数字。

## 每次动手前（顺序别跳）

1. `maa_health`：`online=false` = MAA 没开或「远程控制」端点没配 → 如实告诉用户，**不要重试、不要换方案瞎试**。
2. 第一次用 / 任何异常 → `maa_doctor`：看 `problems`（必修为空）、MAA 版本、能力表、练度解析（N 行 / 拥有 M）、adb 设备。
3. 抄作业前：游戏必须停在**目标关卡的详情页或编队页**（Copilot 不会导航；到不了就用 `maa_swipe` 自己滑过去），**代理指挥必须关**（开着会锁死队伍）。
4. 滑动前确认没有 MAA 任务在跑（有任务时 `maa_swipe` 会拒绝）；滑动起点必须落在空白处，压在按钮上会真的点进去。

## 工具选择

| 用户要什么 | 用什么 |
|---|---|
| 跑日常 / 打扫卫生 | `maa_run(type="LinkStart")`（按 MAA 里勾选的队列） |
| 刷某关 | `maa_set(name="Stage1", value="1-7")` → `maa_run(type="LinkStart-Combat")` |
| 基建 / 公招 / 领奖 / 信用商店 | `LinkStart-Base` / `-Recruiting` / `-Mission` / `-Mall` |
| 肉鸽 / 生息演算 | `LinkStart-AutoRoguelike` / `-Reclamation`（需 MAA 里已有配置） |
| 牛牛抽卡 | `Toolbox-GachaOnce` / `GachaTenTimes`（**先问用户**） |
| 看画面 | `maa_screenshot` → `read_image`（桥离线会自动退回 adb 截图） |
| 抄作业 | `maa_copilot_find(stage)` → `maa_copilot_run({file})` → 看截图验收 |
| 点掉游戏弹窗 | `maa_click({x,y})`（**1280×720** 坐标，独立核心会话） |
| 走到要滑动的关卡 / 列表翻页 | `maa_swipe({from,to})`（**1280×720**，起点选空白，不消耗理智） |
| 停 | `maa_stop` → `maa_current` / 截图确认（无回执） |
| 自检 / 路径不对 / 练度没解析出来 | `maa_doctor` |

## 长任务节奏

`maa_run` 只拿 `taskId`，不阻塞；`maa_wait` 每次 ≤55s 循环；每 3–5 轮插一张 `maa_screenshot` 确认没卡在登录/弹窗。`LinkStart` 整轮可能 30–60 分钟；`pending` / `lost` 都**不等于**失败。

## 抄作业（六步）

1. `maa_doctor` 四项都对（MAA 版本 / 练度解析 / adb 设备 / 无 problems）。
2. `maa_copilot_find({stage:"1-7"})` → 取 `jobs[]` 里 `views` 最高的一条的 `file`。
3. `maa_copilot_run({file, dryRun:true})` 零消耗验证 core 能解析。
4. `maa_copilot_run({file})` 真跑（**真实理智**，跑前先跟用户确认）。
5. `read_image` 看返回的 `screenshot` 确认**三星**；不是三星就换作业（同一条不重跑）。
6. 失败看返回的 `progress` 与 `logFile`（`data\logs\core-*.log`）；`status` 为 `idle-exit(unknown)` 说明可能压根没开打（先查游戏是否停在关卡页）。

**练度口径（用户定，不许自行放宽）**：专精要求按 7 级技能代替；精二等级下浮 30 但不低于 60；模组原样交给 MAA 复验；**练度不够就换作业，不要提示提升练度**。练度文件路径在 **设置 → 插件 → 「MAA 助手」** 里改。

## 验收（`SUCCESS` / `ok` 都不算数）

至少看两样：`debug\gui.log` 的 `开始任务:` / `完成任务:` 行（最硬）；`maa_screenshot` 有真实游戏画面；抄作业额外看三星截图。

## 禁则

- 抽卡 / 碎石 / 吃药 / `StopTask` 打断正在跑的长草 → **先征得用户同意**。
- 一次只排一个长任务；**同一个 `LinkStart` 绝不重发**（会抢占、从头重开）。
- 任务跑着时 `maa_set` 会排在它后面，别以为立刻生效。
- 抄作业失败换下一条，不重试同一条。

## 手册（详细版与故障库）

- 用法/环境事实/验收：`docs\tools\maa.md`
- 抄作业细节与故障：`docs\tools\maa-copilot.md`
- 「现象 → 原因 → 做法」故障库：`docs\tools\maa-errors.md`（桥端口冲突、一直 offline、秒回 SUCCESS、MuMu 多开取错实例、练度解析不出、改代码不生效、**滑动没反应**）
