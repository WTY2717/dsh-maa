---
name: maa-arknights
description: 用 maa_* 工具驱动本机 MAA（明日方舟）——日常/刷关/基建/公招/信用商店/肉鸽/生息演算/抽卡/截图，以及到作业站找作业并自动抄（Copilot）。用户提到明日方舟、MAA、抄作业、刷本、看游戏画面时加载。
whenToUse: 用户说 明日方舟 / MAA / 日常 / 打扫卫生 / 刷 1-7 / 打某关 / 基建换班 / 公招 / 信用商店 / 肉鸽 / 生息演算 / 牛牛抽卡 / 抄作业 / 看看现在什么画面 / 理智还剩多少 时。
---

# MAA 明日方舟（`maa_*` 工具）

插件：`@local/dsh-maa`（bundle 目录 `plugins\maa-plugin`；装进 profile 后在 `node_modules` 里，设置页在 **设置 → 插件 → 「MAA 助手」**）。**不要**用 adb 点击或浏览器截图替代；协议里查不到理智/仓库/关卡，别编数字。

## 每次动手前（顺序别跳）

0. 模拟器：插件加载时**已自动**查过 MuMu 开没开，没开就拉起来并等到能连；工具仍报连不上/`adb devices` 没设备时再 `maa_emulator({action:"start"})`，**不要**自己拼 MuMuManager 命令。
1. `maa_health`：`online=false` = MAA 没开或「远程控制」端点没配 → 如实告诉用户，**不要重试、不要换方案瞎试**。
2. 第一次用 / 任何异常 → `maa_doctor`：看 `problems`（必修为空）、MAA 版本、能力表、练度解析（N 行 / 拥有 M）、adb 设备。
3. 抄作业前：游戏必须停在**目标关卡的详情页或编队页**（Copilot 不会导航；到不了就用 `maa_swipe` 自己滑过去），**代理指挥必须关**（开着会锁死队伍）。
4. 滑动前确认没有 MAA 任务在跑（有任务时 `maa_swipe` 会拒绝）；滑动起点必须落在空白处，压在按钮上会真的点进去。

## 怎么走到目标关卡（首次必读；Copilot 不做导航）

`maa_copilot_run` 要求游戏**已经停在目标关卡的详情页/编队页**。按这张表走，不要瞎点：

| 要找什么 | 怎么走 |
|---|---|
| 主线关卡 | 终端 → **曲谱** → **乐章收录** → 章节选择列表（**上下滑动**挑章节，右下角 `EPxx` = 第 xx 章）→ 点进章节 → **在地图内左右滑动**找关卡 → 点关卡节点 → 详情页 |
| 往期活动 | 同一个章节列表里，活动章节一般排在**所有主线章节下方**，封面用**艺术字**写活动名 → 点封面进活动 → 活动页右下角通常有 2~3 个按钮切**普通关 / EX 关 / 特殊关** |
| 当期活动 | **终端页面左侧**的活动海报（同样艺术字标名）→ 点进去即可。活动结束会显示「**作战已结束**」，其余逻辑与往期活动相同 |
| H 关（主线高难） | 关卡选择界面有**难度切换**：切到**最高难度**（如「磨难」）后 H 关才出现在**地图最右侧**（如 12 章 → H12-1/2/3/4），再用 `maa_swipe` 滑到最右端 |

不熟悉当前在哪一屏 → 先 `maa_screenshot`（1280×720 坐标）再按坐标 `maa_click` / `maa_swipe`；滑动起点选空白处，别压在按钮或关卡节点上。

## 工具选择

| 用户要什么 | 用什么 |
|---|---|
| 跑日常 / 打扫卫生 | `maa_run(type="LinkStart")`（按 MAA 里勾选的队列） |
| 刷某关 | `maa_set(name="Stage1", value="1-7")` → `maa_run(type="LinkStart-Combat")` |
| 基建 / 公招 / 领奖 / 信用商店 | `LinkStart-Base` / `-Recruiting` / `-Mission` / `-Mall` |
| 肉鸽 / 生息演算 | `LinkStart-AutoRoguelike` / `-Reclamation`（需 MAA 里已有配置） |
| 牛牛抽卡 | `Toolbox-GachaOnce` / `GachaTenTimes`（**先问用户**） |
| 看画面 | `maa_screenshot` → `read_image`（桥离线会自动退回 adb 截图） |
| 抄作业 | `maa_copilot_find(stage)` → `maa_copilot_run({file, background:true})` → 盯生命值 → 看截图验收 |
| 盯/停抄作业 | `maa_copilot_status()` / `maa_copilot_stop()`（掉血时立刻停，再去点退出关卡） |
| 点掉游戏弹窗 | `maa_click({x,y})`（**1280×720** 坐标，独立核心会话） |
| 走到要滑动的关卡 / 列表翻页 | `maa_swipe({from,to})`（**1280×720**，起点选空白，不消耗理智） |
| 模拟器没开 / 连不上模拟器 | `maa_emulator({action:"start"})`（会等到能连上；插件启动时已自动做一次） |
| 停 | `maa_stop` → `maa_current` / 截图确认（无回执） |
| 自检 / 路径不对 / 练度没解析出来 | `maa_doctor` |

## 长任务节奏

`maa_run` 只拿 `taskId`，不阻塞；`maa_wait` 每次 ≤55s 循环；每 3–5 轮插一张 `maa_screenshot` 确认没卡在登录/弹窗。`LinkStart` 整轮可能 30–60 分钟；`pending` / `lost` 都**不等于**失败。

## 抄作业（防非三星版；**生命值守则优先级最高**）

0. 前置：模拟器在跑、游戏停在目标关卡详情页/编队页、**代理指挥关**；`maa_doctor` 四项都对（MAA 版本 / 练度解析 / adb 设备 / 无 problems）。
1. `maa_copilot_find({stage})` → 先看 `matchMode`（`strict` = 有完全达标的作业，首选；`relaxed` = 全是放宽出来的），取 `jobs[]` 里 `views` 最高的一条的 `file`。
2. `maa_copilot_run({file, dryRun:true})` 零消耗验证 core 能解析。
3. `maa_copilot_run({file, background:true})` 真跑（**真实理智，跑前先问用户**）→ 拿到 `runId`。
4. **盯生命值（不能省）**：每约 10 秒 `maa_copilot_status()` 看进度 + `maa_screenshot` 后 `read_image` 看画面。重点是**目标生命值**：一旦掉血（生命值右侧出现红色负值 / 生命图标变红），马上进第 5 步。
5. **掉血立刻止损**：`maa_copilot_stop()` 停掉 MAA 任务 → `maa_screenshot` 看画面 → `maa_click` 点「暂停」→ 点「退出行动」→ 确认。**结算前退出关卡会返还全部理智**；掉过血还打到底 = 花了理智还拿不满奖励。
6. 换下一条作业重来（**同一条不重跑**）。如果所有作业都掉血/都失败 → 如实告诉用户：**没有能三星通关的作业**。
7. 正常跑完后 `maa_screenshot` + `read_image` 确认三星；`maa_copilot_status().result.advice` 是给用户的口径，照它说。

**练度口径（用户定，不许自行放宽）**：**先找完全达标的作业**；只有当这一关**所有候选都做不到完全达标**时，才按容差放宽（专精要求按 7 级技能代替；精二等级下浮 30 但不低于 60；模组原样交给 MAA 复验）。`matchMode` 说明用了哪一档，`relaxedBecause` 写明差在哪。**练度不够就换作业，不要提示提升练度**。

**失败口径**：**放宽档作业跑失败 → 直接告诉用户「没有找到这个账号可以抄的作业」**（不重试、不建议提升练度）；严格档失败才换下一条。这条 sidecar 会带到 `maa_copilot_run` 的 `advice` 里，照它说。练度文件路径在 **设置 → 插件 → 「MAA 助手」** 里改。

## 验收（`SUCCESS` / `ok` 都不算数）

至少看两样：`debug\gui.log` 的 `开始任务:` / `完成任务:` 行（最硬）；`maa_screenshot` 有真实游戏画面；抄作业额外看三星截图。

## 禁则

- 抽卡 / 碎石 / 吃药 / `StopTask` 打断正在跑的长草 → **先征得用户同意**。
- 一次只排一个长任务；**同一个 `LinkStart` 绝不重发**（会抢占、从头重开）。
- 任务跑着时 `maa_set` 会排在它后面，别以为立刻生效。
- 抄作业：**不许起跑后不管生命值**（阻塞模式只用于已验证过的作业）；掉血必须立刻退，别赌能三星。
- 抄作业失败换下一条，**不重试同一条**；放宽档失败就下「没有可抄作业」的结论。

## 手册（详细版与故障库）

- 用法/环境事实/验收：`docs\tools\maa.md`
- 抄作业细节与故障：`docs\tools\maa-copilot.md`
- 「现象 → 原因 → 做法」故障库：`docs\tools\maa-errors.md`（桥端口冲突、一直 offline、秒回 SUCCESS、MuMu 多开取错实例、练度解析不出、改代码不生效、**滑动没反应**）
