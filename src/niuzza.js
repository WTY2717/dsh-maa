/**
 * 牛杂（`maa_niuzza` 的实现）：MAA GUI 6.20.x「小工具 / 牛杂」页对应的 MaaCore 直连封装。
 *
 * 口径（2026-10-28 真机 + dev-v2 源码查证，详见 docs/plans/maa-plugin-plan.md §25）：
 *  - **MaaCore 6.20.1 只注册 19 个任务类型**（`src/MaaCore/Assistant.cpp` 的
 *    `ASST_ASSISTANT_APPEND_TASK_FROM_STRING_IF_BRANCH`）：Fight / StartUp / CloseDown / Award /
 *    Mall / Infrast / OperProgress / Recruit / Roguelike / Copilot / SSSCopilot / ParadoxCopilot /
 *    SingleStep / VideoRecognition / Depot / OperBox / Reclamation / SwitchTheme / Custom。
 *    GUI 里的「更新数据 / 库存保持 / 活动商店 / 隐秘战线 / 材质合成 / 像素画 / 自动提升潜能」**不是**
 *    core 类型（append 直接返回 0，探针已确认），它们是 GUI 侧组合或 `Custom` 的短任务名。
 *    **「小工具 → 牛杂」页 9 个条目全部是 `Custom` 短任务名**（`AsstProxy.AsstMiniGame` 只发 Custom），
 *    与界面一一对应（详见 NIUZZA_PRESET_TASKS）：
 *      · 黑流树海刷钱   = Custom + task_names ["BlackFlowTemporary@Begin"]（**任务名只在热更资源 cache/resource**）
 *      · 隐秘战线       = Custom + task_names ["MiniGame@SecretFront@Begin@EndingX@事件名"]
 *      · 活动商店       = Custom + task_names ["SS@Store@Begin"] + params.event_shop.blacklist
 *      · 绿票商店       = Custom + task_names ["GreenTicket@Store@Begin"]（Store@Begin 的隐式前缀模板）
 *      · 黄票商店       = Custom + task_names ["YellowTicket@Store@Begin"]（同上）
 *      · 生息演算商店   = Custom + task_names ["RA@Store@Begin"]（RA 资源里显式定义的入口）
 *      · 自动提升潜能   = Custom + task_names ["MiniGame@AutoRaisePotential@Begin"] + params.auto_raise_potential
 *      · 缺口材料合成   = Custom + task_names ["MiniGame@MaterialSynthesis@Begin"]
 *      · 刷傀影皇冠     = Custom + task_names ["MiniGame@CursedRelic@Begin"]
 *      · 像素画         = Custom + task_names ["MiniGame@PixelPaint@Begin"] + params.pixel_paint
 *      · 更新数据       = OperBox / Depot 识别任务（GUI 用它刷新本地缓存）
 *      · 库存保持       = Depot 识别 + 每计划一条 Fight（`drops` 达量即停）
 *
 * **真实消耗**：活动商店花活动代币、库存保持/肉鸽/生息演算/隐秘战线会改游戏进度或花理智，
 * 干员培养花材料与龙门币。所以本工具的 `dryRun` **默认 true**（只 append 校验、不 connect、
 * 不 startTask）：要真跑必须显式 `dryRun:false`，且调用方（模型）必须先用
 * 文档口径向用户确认。代码里不弹确认框，安全边界靠工具描述 + SKILL 约束。
 *
 * **踩过的坑（必须保留）**：
 *  1. 生息演算 `theme=Tales` + `mode=1`（沙洲遗闻有存档刷繁荣点数）时，如果 params 里**没有**
 *     `tools_to_craft` 数组，MaaCore 6.20.1 会在 `ReclamationCraftTaskPlugin::load_params` 里对空
 *     optional 调 `.value()` 抛 C++ 异常，**整个 MaaCore 子进程直接退出**（探针实测 exit 0xE06D7363，
 *     之后同一会话的所有 append 都失败）。所以这里**总是**补齐 `tools_to_craft`（默认 ["荧光棒"]）、
 *     `num_craft_batches`（默认 16）、`increment_mode`（默认 0）。
 *  2. 生息演算 `theme=Fire`（沙中之火）已下线：`is_valid_theme` 只认 Tales / RelaunchAnchor，
 *     传 Fire 会被 core 拒绝（append 返回 0）——旧文档里的 Fire 参数是废弃的。
 *  3. 旧文档的 `tool_to_craft` / `max_craft_count_per_round` 已改名成 `tools_to_craft` /
 *     `num_craft_batches`（GUI 的 AsstReclamationTask 序列化可证）。
 *  4. 干员培养（OperProgress）的 plan 只允许 role / name / elite / skill_level / skill_mastery
 *     五个键（多余键直接拒绝）；`name` 必填；同名的多职业干员（如「阿米娅」）不给 `role` 会被拒。
 *  5. `SwitchTheme` 的参数键是 `themes`（数组），不是 `theme`；空数组合法（core 直接跳过并回
 *     `SwitchThemeSkipped`）。
 *  6. `Custom` 的短任务名解析失败（如任务名写错）才返回 0；但 `SS@Store@Begin` 的黑名单为空 /
 *     不是字符串数组时**不会报错**，只是不注册 EventShop 插件（等于到了商店什么也不买），
 *     所以这里在工具侧先校验黑名单形态。
 *  7. **热更资源在 `<安装目录>\cache\resource`，不在 `resource`**：`BlackFlowTemporary@Begin`
 *     只存在于 `cache\resource\tasks\tasks.json`。MAA GUI 的 `AsstProxy.LoadResource` 会
 *     「先 AsstLoadResource(安装目录) 再 AsstLoadResource(安装目录\cache)」，我们的 worker 也必须这样
 *     加载（`src/core/worker.mjs` 的 open），否则该任务名 append 返回 0（探针 2026-10-28 实测：
 *     不加载 cache = 拒绝，加载后 = 拿到 taskId）。`GreenTicket@Store@Begin` 这类隐式前缀模板
 *     则只依赖 `resource` 里的 `Store@Begin`，不需要 cache。
 *
 * 所有函数都返回对象、不抛未捕获异常；CoreWorker 由 chain.runChain 在 finally 里 close。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runChain } from './chain.js';

/** 工具支持的动作（顺序对齐 MAA「小工具 → 牛杂」页的 9 个条目，后面是通用动作）。 */
export const NIUZZA_ACTIONS = [
  // ── 牛杂页 9 个条目（2026-10-28 用户截图顺序）──
  'blackflow-money', // 1 当期活动 → 黑流树海刷钱
  'secret-front', // 2 常驻活动 → 隐秘战线
  'event-shop', // 3 常驻功能 → 活动商店
  'green-shop', // 4 常驻功能 → 绿票商店
  'yellow-shop', // 5 常驻功能 → 黄票商店
  'reclamation-shop', // 6 常驻功能 → 生息演算商店
  'auto-raise-potential', // 7 常驻功能 → 自动提升潜能
  'material-synthesis', // 8 常驻功能 → 缺口材料合成
  'phantom-crown', // 9 常驻功能 → 刷傀影维多利亚皇冠
  // ── 通用动作 ──
  'custom',
  'single-step',
  'user-data-update',
  'switch-theme',
  'oper-progress',
  'depot-maintain',
  'reclamation',
  'roguelike',
];

/**
 * 牛杂页 9 个条目 → GUI 实际下发的 `Custom` 短任务名。
 *
 * 来源（2026-10-28 查证，别凭记忆改）：
 *  - `src/MaaWpfGui/Services/StageManager.cs` 的 `InitializeDefaultMiniGameEntries()`（常驻功能 7 条写死 Value）
 *  - `src/MaaWpfGui/ViewModels/UI/ToolboxViewModel.cs` 的 `GetMiniGameTask()`（只有隐秘战线在任务名里编码结局/事件）
 *  - `src/MaaWpfGui/Main/AsstProxy.cs` 的 `AsstMiniGame(taskName, eventShopBlackList)`：**统一走 `Custom{task_names:[...]}`**
 *  - 当期活动的「黑流树海刷钱」来自 API 下发的 `StageActivityV2.json` 的 miniGame[].Value
 *
 * 注意 `GreenTicket@Store@Begin` / `YellowTicket@Store@Begin` / `RA@Store@Begin` **在 tasks.json 里没有同名条目**：
 * core 的 `TaskData::generate_raw_task_and_base` 会用「`@` 前缀模板」隐式生成（base = `Store@Begin`），
 * 这类前缀任务只有拼写完全正确时才存在（探针已确认 append 成功）。
 */
export const NIUZZA_PRESET_TASKS = {
  'blackflow-money': 'BlackFlowTemporary@Begin',
  'secret-front': 'MiniGame@SecretFront@Begin',
  'event-shop': 'SS@Store@Begin',
  'green-shop': 'GreenTicket@Store@Begin',
  'yellow-shop': 'YellowTicket@Store@Begin',
  'reclamation-shop': 'RA@Store@Begin',
  'auto-raise-potential': 'MiniGame@AutoRaisePotential@Begin',
  'material-synthesis': 'MiniGame@MaterialSynthesis@Begin',
  'phantom-crown': 'MiniGame@CursedRelic@Begin',
};

/**
 * 每个动作的**前置界面**（抄 GUI 右侧提示 / MAA 手册；插件只负责跑、不导航）。
 * 界面不对时 core 只会卡在识别上或走错分支，所以 hint 里必须带这句。
 */
export const NIUZZA_PREREQ = {
  'blackflow-money': '游戏停在**黑流树海肉鸽主界面**：右下角有「开始探索」（GUI 提示原文：在右下角有开始探索的界面开始）',
  'secret-front': '游戏停在隐秘战线**「选小队」界面**；有存档先手动删除，第一次打自己看完教程并关掉',
  'event-shop': '游戏停在**活动商店页面**（GUI：请在活动商店页面开始；不买无限池）',
  'green-shop': '游戏在主界面即可（core 自己走 终端 → 凭证交易所 → 资质凭证区）；1 层全买、2 层只买寻访凭证与招聘许可',
  'yellow-shop': '游戏在主界面即可（core 自己走 凭证交易所 → 高级凭证区）；只买单抽/十连寻访凭证，建议 ≥258 张黄票',
  'reclamation-shop': '游戏停在**生息演算商店页面**（GUI：请在活动商店页面开始）',
  'auto-raise-potential': '游戏停在**干员列表界面**（顶部潜能标记数量可读）；core 从列表第一屏开始逐个翻档案',
  'material-synthesis': '游戏停在**加工站合成页**：从培养页（精英化/专精/模组升级）缺材料弹窗点进去，再启动',
  'phantom-crown': '游戏停在**傀影肉鸽主菜单**：右下角「探索」按钮可见（GUI 提示原文）',
  custom: '取决于任务名（GUI 右侧提示为准）；本工具不导航',
  'single-step': '取决于 subtype：stage/start/action 都要先停在目标关卡的详情页或编队页',
  'user-data-update': '游戏在主界面（识别类必须从主界面开始，否则只扫第一屏）',
  'switch-theme': '游戏在主界面（core 自己进 设置 → 主题）',
  'oper-progress': '游戏在主界面（core 自己进干员档案）',
  'depot-maintain': '游戏在主界面（core 自己进仓库/关卡）',
  reclamation: '沙洲遗闻「有存档刷点数」= 进大地图后能看到驻扎地；「无存档」= 主界面右下角有「开始演算」；重启锚点 = 大地图打开 RA-1/RA-4/RA-15，右下角有「开启建设」',
  roguelike: '游戏在肉鸽主界面（右下角「开始探索」）或主界面（core 自己导航）',
};

/** 等待时间：默认 900 秒，范围 30~7200（生息演算/隐秘战线可以跑很久）。 */
export const NIUZZA_TIMEOUT = { default: 900, min: 30, max: 7200 };

/** 每个动作真实执行时的代价（dryRun 时只作为提示）。 */
export const NIUZZA_COSTS = {
  custom: '按 tasks 里的短任务名执行：可能是抽卡（GachaOnce/GachaTenTimes，花合成玉/凭证）、小游戏（改游戏进度）等',
  'single-step': '单步自动战斗：会真的进关卡/点技能（可能消耗理智，取决于当前停在哪一屏）',
  'user-data-update': '只跑 OperBox / Depot 识别，**不花资源**；但会改写 MAA 本地的干员/仓库缓存（下一次识别前别拿旧数据当真）',
  'switch-theme': '会真的切换游戏主界面主题（可再切回来，不改存档进度）',
  'oper-progress': '会真的消耗养成材料 / 龙门币 / 经验卡，双芯片还可能占用制造站；**不可撤销**',
  'depot-maintain': '每条计划都会下发 Fight：**消耗理智**（药/石头按计划里的开关），刷到 drops 目标数量才停',
  'event-shop': '**花活动代币兑换商品**（黑名单之外的都买，直到代币不足/商品买完）',
  'secret-front': '**会真的玩隐秘战线小游戏**并改变游戏内进度/存档（结局 A~E 不可回退）',
  'blackflow-money': '**会真的打黑流树海肉鸽刷钱**：长时间挂机（一把十几分钟起）、推进肉鸽进度；要求开局带「结构性原理」跳节点（精二机械师卖出 10 个零件解锁「招募精通 II → 效果提升 II」），否则只会正常打',
  'green-shop': '**花资质凭证（绿票）**：1 层全买、2 层买寻访凭证与招聘许可，直到票不足/买完',
  'yellow-shop': '**花高级凭证（黄票）**：买单抽/十连寻访凭证，直到票不足/买完（建议 ≥258 张）',
  'reclamation-shop': '**花生息演算代币**兑换商店商品，直到代币不足/买完',
  'auto-raise-potential': '**改写干员养成**：消耗中坚信物（勾 useNormalToken 时不足会改用普通信物）提升潜能，**不可撤销**',
  'material-synthesis': '**消耗材料 / 龙门币**在加工站递归合成下级材料；材料不足或到处理上限时停',
  'phantom-crown': '**反复开局→检查首个收藏品→不是就放弃**，直到刷出「维多利亚王冠」：耗时（每次放弃要等结算）、推进/重置傀影肉鸽进度',
  reclamation: '**会真的玩生息演算并改存档进度**（刷繁荣点数/制造支援道具/重启锚点）；耗时可能几十分钟',
  roguelike: '**会真的打肉鸽**：消耗时间，可能投资源石锭（游戏内货币），并改变肉鸽进度',
};

/** `custom` 的短任务名别名（GUI 里的按钮名 → tasks.json 里的任务名）。 */
export const NIUZZA_TASK_ALIASES = {
  'event-shop': 'SS@Store@Begin',
  'secret-front': 'MiniGame@SecretFront@Begin',
  'material-synthesis': 'MiniGame@MaterialSynthesis@Begin',
  'auto-raise-potential': 'MiniGame@AutoRaisePotential@Begin',
  'pixel-paint': 'MiniGame@PixelPaint@Begin',
  'gacha-once': 'GachaOnce',
  'gacha-ten': 'GachaTenTimes',
  // 牛杂页其余条目（v2.3.0 补全；别名与 action 同名，方便 custom 直接透传）
  'blackflow-money': 'BlackFlowTemporary@Begin',
  'green-shop': 'GreenTicket@Store@Begin',
  'yellow-shop': 'YellowTicket@Store@Begin',
  'reclamation-shop': 'RA@Store@Begin',
  'phantom-crown': 'MiniGame@CursedRelic@Begin',
};

/** 肉鸽主题（core 只认这 6 个）。 */
export const ROGUELIKE_THEMES = ['Phantom', 'Mizuki', 'Sami', 'Sarkaz', 'JieGarden', 'BlackFlow'];

/** 肉鸽模式：0/1 常用，4~7 特殊，10001/20001/30001/30003 专题；2/3 已被 core 移除/未开放。 */
export const ROGUELIKE_MODES = [0, 1, 4, 5, 6, 7, 10001, 20001, 30001, 30003];
export const ROGUELIKE_REMOVED_MODES = { 2: 'v5 起已移除（原兼顾模式 0 与 1），core 会拒绝', 3: '未开放，core 会拒绝' };

/** 生息演算：主题与模式编码（`src/MaaCore/Task/Reclamation/ReclamationConfig.h`）。 */
export const RECLAMATION_THEMES = ['Tales', 'RelaunchAnchor'];
export const RECLAMATION_THEME_ALIASES = {
  沙洲遗闻: 'Tales',
   tales: 'Tales',
  重启锚点: 'RelaunchAnchor',
  relaunchanchor: 'RelaunchAnchor',
  沙中之火: 'Fire',
  fire: 'Fire',
};
export const RECLAMATION_TALES_MODES = { 0: '无存档刷繁荣点数', 1: '有存档刷繁荣点数（可制造支援道具）' };
export const RECLAMATION_ANCHOR_MODES = { 'RA-1': 16, 'RA-4': 48, 'RA-15': 32 };

/** 隐秘战线结局：A~E（core 由任务名后缀判定；不带后缀 = 资源里的默认入口，等同结局 E）。 */
export const SECRET_FRONT_ENDINGS = ['A', 'B', 'C', 'D', 'E'];
export const SECRET_FRONT_EVENTS = ['支援作战平台', '游侠', '诡影迷踪'];

/** 干员培养 plan 允许的键（core 会严格校验，多余键直接拒绝）。 */
export const OPER_PROGRESS_PLAN_KEYS = ['role', 'name', 'elite', 'skill_level', 'skill_mastery'];

/** `Fight` 的 times 用满（库存保持靠 drops 达量停，不靠次数）。 */
const FIGHT_MAX_TIMES = 2147483647;

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const toStr = (v) => (typeof v === 'string' ? v.trim() : '');

/** 秒数钳制：默认 900，范围 30~7200。 */
export function clampNiuzzaTimeout(value, def = NIUZZA_TIMEOUT.default) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.max(Math.round(n), NIUZZA_TIMEOUT.min), NIUZZA_TIMEOUT.max);
}

/** 校验结果：失败统一带 error + advice，绝不抛。 */
const fail = (error, advice = null, extra = {}) => ({ ok: false, error, advice, ...extra });

/** 字符串数组归一化；返回 {ok, list} 或 {ok:false,error}。 */
function stringList(value, field, { min = 1, max = 64 } = {}) {
  if (!Array.isArray(value)) return { ok: false, error: `${field} 必须是字符串数组（收到 ${JSON.stringify(value)}）` };
  if (value.length < min) return { ok: false, error: `${field} 至少 ${min} 项（收到 ${value.length} 项）` };
  if (value.length > max) return { ok: false, error: `${field} 最多 ${max} 项（收到 ${value.length} 项）` };
  const list = [];
  for (let i = 0; i < value.length; i += 1) {
    const s = toStr(value[i]);
    if (!s) return { ok: false, error: `${field}[${i}] 必须是非空字符串（收到 ${JSON.stringify(value[i])}）` };
    list.push(s);
  }
  return { ok: true, list };
}

/** 布尔归一：undefined 走默认值，非布尔但形似字符串也兼容（"true"/"false"）。 */
function boolOr(value, def) {
  if (value === undefined || value === null) return def;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return Boolean(value);
}

/**
 * 把「牛杂」的一个动作翻译成 core 任务数组（纯函数，不接触 MaaCore，方便单测）。
 *
 * @param {object} args
 * @param {string} args.action NIUZZA_ACTIONS 之一
 * @param {object} [args.call] 动作参数（工具入参去掉 action/dryRun/background/timeoutSeconds）
 * @param {object} [args.cfg] 已解析配置（只有 oper-progress 读文件时需要 jobsDir 提示）
 * @returns {{ok:true, tasks:Array<{type:string,params:object}>, plan:object, dangers:Array<{type:string,note:string}>}
 *          | {ok:false, error:string, advice:string|null}}
 */
export function buildNiuzzaPlan({ action, call = {}, cfg = null } = {}) {
  const a = toStr(action);
  if (!NIUZZA_ACTIONS.includes(a)) {
    return fail(`action 不认识: ${JSON.stringify(action)}（可用：${NIUZZA_ACTIONS.join(' / ')}）`);
  }
  const args = isPlainObject(call) ? call : {};

  let built;
  switch (a) {
    case 'custom':
      built = buildCustom(args);
      break;
    case 'single-step':
      built = buildSingleStep(args);
      break;
    case 'user-data-update':
      built = buildUserDataUpdate(args);
      break;
    case 'switch-theme':
      built = buildSwitchTheme(args);
      break;
    case 'oper-progress':
      built = buildOperProgress(args, cfg);
      break;
    case 'depot-maintain':
      built = buildDepotMaintain(args);
      break;
    case 'event-shop':
      built = buildEventShop(args);
      break;
    case 'secret-front':
      built = buildSecretFront(args);
      break;
    case 'blackflow-money':
      built = buildBlackflowMoney(args);
      break;
    case 'green-shop':
      built = buildTicketShop('green-shop', args);
      break;
    case 'yellow-shop':
      built = buildTicketShop('yellow-shop', args);
      break;
    case 'reclamation-shop':
      built = buildTicketShop('reclamation-shop', args);
      break;
    case 'auto-raise-potential':
      built = buildAutoRaisePotential(args);
      break;
    case 'material-synthesis':
      built = buildMaterialSynthesis(args);
      break;
    case 'phantom-crown':
      built = buildPhantomCrown(args);
      break;
    case 'reclamation':
      built = buildReclamation(args);
      break;
    case 'roguelike':
      built = buildRoguelike(args);
      break;
    default:
      return fail(`action 不认识: ${a}`);
  }

  // 统一补「本动作的代价」与「前置界面」：
  //  - dangersOf 需要 action 才能把 Custom 的代价说明指到具体条目（Custom 类型同名，靠 action 区分）；
  //  - prereq 每个动作都要给（插件不导航，界面不对 core 会卡住）。
  if (built?.ok) {
    built.dangers = dangersOf(built.tasks, a);
    if (built.plan) {
      if (!built.plan.prereq && NIUZZA_PREREQ[a]) built.plan.prereq = NIUZZA_PREREQ[a];
      if (NIUZZA_PRESET_TASKS[a] && !built.plan.taskName) built.plan.taskName = NIUZZA_PRESET_TASKS[a];
    }
  }
  return built;
}

/** 把任务数组里出现的类型汇总成 dangers（供 hint 用）。action 用于区分 Custom 的具体条目。 */
function dangersOf(tasks, action = null) {
  const seen = new Map();
  const actionByType = {
    Fight: 'depot-maintain（Fight 消耗理智）',
    Roguelike: 'roguelike',
    Reclamation: 'reclamation',
    OperProgress: 'oper-progress',
    SwitchTheme: 'switch-theme',
    Depot: 'user-data-update（会刷新 MAA 本地仓库缓存）',
    OperBox: 'user-data-update（会刷新 MAA 本地干员缓存）',
    Custom: 'custom / event-shop / secret-front',
    SingleStep: 'single-step',
  };
  for (const t of tasks) {
    if (seen.has(t.type)) continue;
    // Custom 的任务名各不相同，代价要按 action 取（event-shop / green-shop / blackflow-money…）
    const owner = t.type === 'Custom' && action ? action : actionByType[t.type];
    const key = owner?.split('（')[0] ?? t.type;
    const note = NIUZZA_COSTS[key] ?? NIUZZA_COSTS[actionByType[t.type]?.split('（')[0]] ?? NIUZZA_COSTS[t.type] ?? null;
    if (note) seen.set(t.type, { type: t.type, note });
  }
  return [...seen.values()];
}

/* ────────────────────── 各动作 ────────────────────── */

/** 自定任务：`Custom` + task_names（可选 params 原样透传）。 */
function buildCustom(args) {
  const raw = args.taskNames ?? args.tasks ?? args.task_names;
  const names = stringList(raw, 'taskNames', { min: 1, max: 32 });
  if (!names.ok) {
    return fail(names.error, 'taskNames 是 tasks.json 里的任务名数组，例如 ["Award","Mall"]；牛杂小游戏用简短别名（event-shop / secret-front / material-synthesis / auto-raise-potential / pixel-paint / gacha-once / gacha-ten）或完整任务名。');
  }
  const resolved = [];
  const aliased = {};
  for (const n of names.list) {
    const key = n.toLowerCase();
    const target = NIUZZA_TASK_ALIASES[key] ?? NIUZZA_TASK_ALIASES[n] ?? n;
    resolved.push(target);
    if (target !== n) aliased[n] = target;
  }
  let params;
  if (args.params !== undefined && args.params !== null) {
    if (!isPlainObject(args.params)) return fail(`params 必须是对象（收到 ${Array.isArray(args.params) ? 'array' : typeof args.params}）`);
    params = args.params;
  }
  const payload = { task_names: resolved };
  if (params) payload.params = params;
  const tasks = [{ type: 'Custom', params: payload }];
  return {
    ok: true,
    tasks,
    plan: { action: 'custom', taskNames: resolved, ...(Object.keys(aliased).length ? { aliased } : {}), hasParams: Boolean(params) },
    dangers: dangersOf(tasks),
  };
}

/** 单步任务（自动战斗逐步）：`SingleStep` = {type:"copilot", subtype:"stage"|"start"|"action", details?}。 */
function buildSingleStep(args) {
  const subtype = toStr(args.subtype ?? args.step ?? '');
  if (!['stage', 'start', 'action'].includes(subtype)) {
    return fail(
      `subtype 必须是 stage / start / action（收到 ${JSON.stringify(args.subtype)}）`,
      'stage=只设置关卡名（details.stage_name）；start=点「开始行动」；action=按作业动作逐步执行（details 是自动战斗协议的动作对象）。',
    );
  }
  const params = { type: 'copilot', subtype };
  if (subtype === 'stage') {
    const stageName = toStr(args.stageName ?? args.stage_name ?? args.stage);
    if (!stageName) return fail('subtype=stage 时必须给 stageName（如 "1-7"）');
    params.details = { ...(isPlainObject(args.details) ? args.details : {}), stage_name: stageName };
  } else if (subtype === 'action') {
    if (!isPlainObject(args.details)) return fail('subtype=action 时必须给 details（自动战斗协议对象，含 actions 数组）');
    if (!Array.isArray(args.details.actions) || args.details.actions.length === 0) {
      return fail('details.actions 必须是非空数组（自动战斗协议里的 actions）');
    }
    params.details = args.details;
  } else if (isPlainObject(args.details)) {
    // subtype=start 时 core 不看 details，但允许带上做记录
    params.details = args.details;
  }
  const tasks = [{ type: 'SingleStep', params }];
  return {
    ok: true,
    tasks,
    plan: { action: 'single-step', subtype, ...(params.details?.stage_name ? { stageName: params.details.stage_name } : {}), actions: Array.isArray(params.details?.actions) ? params.details.actions.length : 0 },
    dangers: dangersOf(tasks),
  };
}

/** 更新数据：OperBox / Depot 识别（GUI 用它刷新干员/仓库缓存，不花资源）。 */
function buildUserDataUpdate(args) {
  const updateOperBox = boolOr(args.updateOperBox ?? args.operbox, true);
  const updateDepot = boolOr(args.updateDepot ?? args.depot, true);
  if (!updateOperBox && !updateDepot) return fail('updateOperBox 与 updateDepot 不能同时为 false（那样没有任何任务）');
  const tasks = [];
  if (updateOperBox) tasks.push({ type: 'OperBox', params: {} });
  if (updateDepot) tasks.push({ type: 'Depot', params: {} });
  return {
    ok: true,
    tasks,
    plan: { action: 'user-data-update', updateOperBox, updateDepot, order: tasks.map((t) => t.type) },
    dangers: dangersOf(tasks),
  };
}

/** 更换主题：`SwitchTheme` = {themes:[...]}（键是 themes，不是 theme）。 */
function buildSwitchTheme(args) {
  let raw = args.themes ?? args.theme;
  if (typeof raw === 'string') raw = [raw];
  if (raw === undefined) return fail('必须给 themes（字符串数组，如 ["夜间","银凇"]；多个时每次随机选一个）');
  const list = stringList(raw, 'themes', { min: 1, max: 32 });
  if (!list.ok) return fail(list.error, '主题名要与游戏内「主题列表」显示的一致；写错时 core 仍会接受参数，运行时回 SwitchThemeNotFound。');
  const tasks = [{ type: 'SwitchTheme', params: { themes: list.list } }];
  return { ok: true, tasks, plan: { action: 'switch-theme', themes: list.list }, dangers: dangersOf(tasks) };
}

/** 读干员培养计划：支持 plans 数组，或 file（JSON：{plans:[...]} 或 [...]）。 */
function readOperProgressPlan(args, cfg) {
  let plans = args.plans ?? args.plan;
  let sourceFile = null;
  if (plans === undefined && args.file) {
    const raw = toStr(args.file);
    if (!raw) return { ok: false, error: 'file 必须是非空路径' };
    const abs = path.isAbsolute(raw) ? raw : path.resolve(raw);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e) {
      return { ok: false, error: `读不到/解析不了计划文件 ${abs}: ${e?.message || e}` };
    }
    sourceFile = abs;
    plans = Array.isArray(parsed) ? parsed : parsed?.plans;
    if (!Array.isArray(plans)) return { ok: false, error: `${abs} 里没有 plans 数组（需要 {plans:[...]} 或直接是数组）` };
  }
  if (!Array.isArray(plans)) return { ok: false, error: '必须给 plans 数组（或 file 指向计划 JSON）' };
  return { ok: true, plans, sourceFile, cfg };
}

/** 干员培养：`OperProgress` = {plans:[{role?,name,elite?,skill_level?,skill_mastery?}]}。 */
function buildOperProgress(args, cfg) {
  const read = readOperProgressPlan(args, cfg);
  if (!read.ok) {
    return fail(read.error, 'plans 每项形如 {"role":"Sniper","name":"能天使","elite":2,"skill_level":7,"skill_mastery":[3,3,0]}；只允许 role/name/elite/skill_level/skill_mastery 五个键。');
  }
  if (read.plans.length === 0) return fail('plans 不能为空数组（core 接受空数组但等于什么也不做）');
  const out = [];
  const problems = [];
  read.plans.forEach((p, i) => {
    if (!isPlainObject(p)) { problems.push(`plans[${i}] 必须是对象`); return; }
    const name = toStr(p.name ?? p.oper ?? p.char);
    if (!name) { problems.push(`plans[${i}].name 必填（干员中文名）`); return; }
    const plan = { name };
    if (p.role !== undefined && p.role !== null && String(p.role).trim()) plan.role = String(p.role).trim();
    const elite = p.elite ?? p.eliteLevel ?? p.elite_level;
    if (elite !== undefined && elite !== null && elite !== 0) {
      const n = Number(elite);
      if (!Number.isInteger(n) || n < 1 || n > 2) { problems.push(`plans[${i}].elite 只能是 1 或 2（收到 ${JSON.stringify(elite)}）`); return; }
      plan.elite = n;
    }
    const skillLevel = p.skillLevel ?? p.skill_level;
    if (skillLevel !== undefined && skillLevel !== null) {
      const n = Number(skillLevel);
      if (!Number.isInteger(n) || n < 2 || n > 7) { problems.push(`plans[${i}].skillLevel 只能是 2~7（收到 ${JSON.stringify(skillLevel)}）`); return; }
      plan.skill_level = n;
    }
    const mastery = p.skillMastery ?? p.skill_mastery;
    if (mastery !== undefined && mastery !== null) {
      if (!Array.isArray(mastery) || mastery.length !== 3) { problems.push(`plans[${i}].skillMastery 必须是 3 个整数的数组（三个技能的专精等级，0~3）`); return; }
      const arr = mastery.map((v) => Number(v));
      if (arr.some((v) => !Number.isInteger(v) || v < 0 || v > 3)) { problems.push(`plans[${i}].skillMastery 每项只能是 0~3（收到 ${JSON.stringify(mastery)}）`); return; }
      plan.skill_mastery = arr;
    }
    const extra = Object.keys(p).filter((k) => ![
      'name', 'oper', 'char', 'role', 'elite', 'eliteLevel', 'elite_level', 'skillLevel', 'skill_level', 'skillMastery', 'skill_mastery',
    ].includes(k));
    if (extra.length) problems.push(`plans[${i}] 有 core 不认识的键: ${extra.join(', ')}（会被 core 拒绝，先删掉）`);
    out.push(plan);
  });
  if (problems.length) return fail(problems.join('；'), 'core 对 plan 的键做白名单校验：只允许 role/name/elite/skill_level/skill_mastery。');
  const tasks = [{ type: 'OperProgress', params: { plans: out } }];
  return {
    ok: true,
    tasks,
    plan: { action: 'oper-progress', plans: out.length, ...(read.sourceFile ? { sourceFile: read.sourceFile } : {}), detail: out },
    dangers: dangersOf(tasks),
    warnings: out.some((p) => !p.role) ? ['有 plan 没给 role：core 会按干员名反查职业，多职业干员（如阿米娅）会被拒绝；报错就给 role 补上。'] : undefined,
  };
}

/** 库存保持：Depot 识别 + 每计划一条 Fight（drops 达量即停）。 */
function buildDepotMaintain(args) {
  const updateDepot = boolOr(args.updateDepot, true);
  const plans = args.plans ?? args.plan;
  if (!Array.isArray(plans) || plans.length === 0) {
    return fail(
      '必须给非空 plans（库存保持计划），例如 [{"stage":"1-7","dropId":"30011","dropCount":10}]',
      'GUI 会先跑 Depot 识别、按当前库存算缺口；这里直接把 dropCount 当目标数量（drops 达量即停），缺口请先 maa_toolbox({action:"depot"}) 自己算。',
    );
  }
  const out = [];
  const problems = [];
  plans.forEach((p, i) => {
    if (!isPlainObject(p)) { problems.push(`plans[${i}] 必须是对象`); return; }
    const stage = toStr(p.stage ?? p.stageName);
    if (!stage) { problems.push(`plans[${i}].stage 必填（如 "1-7" / "CE-6"）`); return; }
    const dropId = toStr(p.dropId ?? p.drop_id ?? p.drop) || String(p.dropId ?? p.drop_id ?? p.drop ?? '');
    if (!dropId) { problems.push(`plans[${i}].dropId 必填（item_index.json 里的物品 id，如 "30011"）`); return; }
    const dropCount = Number(p.dropCount ?? p.drop_count ?? p.count);
    if (!Number.isInteger(dropCount) || dropCount <= 0) { problems.push(`plans[${i}].dropCount 必须是正整数（收到 ${JSON.stringify(p.dropCount ?? p.count)}）`); return; }
    const medicine = Number(p.medicineCount ?? p.medicine_count ?? (p.useMedicine ? 1 : 0));
    const stone = Number(p.stoneCount ?? p.stone_count ?? (p.useStone ? 1 : 0));
    out.push({
      stage,
      dropId,
      dropCount,
      medicine: Number.isInteger(medicine) && medicine > 0 ? medicine : 0,
      stone: Number.isInteger(stone) && stone > 0 ? stone : 0,
      times: Number.isInteger(Number(p.times)) && Number(p.times) > 0 ? Number(p.times) : FIGHT_MAX_TIMES,
      series: Number.isInteger(Number(p.series)) ? Number(p.series) : 1,
    });
  });
  if (problems.length) return fail(problems.join('；'), '计划字段：stage / dropId / dropCount 必填，medicineCount / stoneCount / times / series 可选。');
  const tasks = [];
  if (updateDepot) tasks.push({ type: 'Depot', params: {} });
  for (const p of out) {
    tasks.push({
      type: 'Fight',
      params: {
        stage: p.stage,
        medicine: p.medicine,
        stone: p.stone,
        times: p.times,
        series: p.series,
        drops: { [p.dropId]: p.dropCount },
      },
    });
  }
  return {
    ok: true,
    tasks,
    plan: { action: 'depot-maintain', updateDepot, plans: out.length, detail: out },
    dangers: dangersOf(tasks),
  };
}

/** 活动商店：`Custom` + `SS@Store@Begin` + params.event_shop.blacklist。 */
function buildEventShop(args) {
  let raw = args.blacklist;
  if (raw === undefined && args.keywords !== undefined) raw = args.keywords;
  if (raw === undefined) raw = [];
  const list = stringList(raw, 'blacklist', { min: 0, max: 64 });
  if (!list.ok) return fail(list.error, 'blacklist 是「不买什么」的商品名关键词数组（如 ["家具零件","碳"]）；空数组时 core 不会注册兑换插件，等于到商店不买东西。');
  const payload = { task_names: ['SS@Store@Begin'] };
  const warnings = [];
  if (list.list.length) payload.params = { event_shop: { blacklist: list.list } };
  else warnings.push('blacklist 为空：core 不会注册 EventShop 插件，真跑也只会走到商店入口、不买任何东西（要「全买」请至少放一个不会出现的占位词）。');
  const tasks = [{ type: 'Custom', params: payload }];
  return {
    ok: true,
    tasks,
    plan: { action: 'event-shop', blacklist: list.list, buysEverythingExceptBlacklist: list.list.length > 0 },
    dangers: dangersOf(tasks),
    warnings: warnings.length ? warnings : undefined,
  };
}

/* ── 牛杂页其余 7 个条目：GUI 的 `AsstMiniGame(taskName)` 一律只发 `Custom{task_names:[短任务名]}`，
 *    没有 core 独立类型；参数只有「自动提升潜能」有一个 use_normal_token 开关。
 *    任务名来源见 NIUZZA_PRESET_TASKS 的注释（StageManager / ToolboxViewModel / StageActivityV2.json）。── */

/** 把「一个固定 Custom 短任务名 + 可选 params」做成统一返回结构。 */
function customTaskResult(action, taskName, { params = null, extraPlan = {}, warnings = [] } = {}) {
  const payload = { task_names: [taskName] };
  if (params && Object.keys(params).length) payload.params = params;
  const tasks = [{ type: 'Custom', params: payload }];
  return {
    ok: true,
    tasks,
    plan: { action, taskName, prereq: NIUZZA_PREREQ[action] ?? null, ...extraPlan },
    dangers: dangersOf(tasks, action),
    warnings: warnings.length ? warnings : undefined,
  };
}

/** 这些条目在 GUI 里没有可调项：多给的参数直接拒绝，避免「传了但没生效」。 */
function rejectForeignArgs(action, args, allowed = []) {
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (!extra.length) return null;
  return fail(
    `${action} 不接受这些参数: ${extra.join(', ')}（该条目在 GUI 里没有可调项，只下发固定任务名）`,
    allowed.length ? `可用参数只有 ${allowed.join(' / ')}。` : '该条目没有参数，把这些键删掉再调用。',
  );
}

/** 1. 黑流树海刷钱：`Custom` + `BlackFlowTemporary@Begin`（**任务名只在 MAA 热更资源 cache/resource 里**）。 */
function buildBlackflowMoney(args) {
  const bad = rejectForeignArgs('blackflow-money', args);
  if (bad) return bad;
  return customTaskResult('blackflow-money', NIUZZA_PRESET_TASKS['blackflow-money'], {
    extraPlan: { needsHotfixResource: true },
    warnings: [
      '**任务名来自 MAA 热更资源**（`<安装目录>\\cache\\resource\\tasks\\tasks.json` 的 BlackFlowTemporary@*）：worker 现在按 GUI 的顺序「先 resource 再 cache/resource」加载，缺后者 append 会返回 0。',
      '开局要求：特勤分队 + 稳扎稳打 + 精二机械师；跳节点靠「开局携带的结构性原理」（解锁「招募精通 II → 效果提升 II」= 精二后累计卖出 10 个零件），没解锁只会正常打、不会飞。',
      '这条是牛杂页的旧刷钱任务；新版自动肉鸽的「刷源石锭」策略请用 `roguelike({theme:"BlackFlow", mode:1, …})`（那是肉鸽页配置，不是牛杂页）。',
    ],
  });
}

/** 4/5/6. 三个票种商店：`GreenTicket@Store@Begin` / `YellowTicket@Store@Begin` / `RA@Store@Begin`。 */
function buildTicketShop(action, args) {
  const bad = rejectForeignArgs(action, args);
  if (bad) return bad;
  const taskName = NIUZZA_PRESET_TASKS[action];
  const extraPlan = { viaImplicitPrefixTask: action !== 'reclamation-shop' };
  const warnings = [];
  if (action === 'green-shop') {
    extraPlan.buys = ['一层：全部商品', '二层：寻访凭证（单抽）、招聘许可'];
  } else if (action === 'yellow-shop') {
    extraPlan.buys = ['寻访凭证（单抽）', '十连寻访凭证'];
    extraPlan.recommendedTickets = 258;
    warnings.push('GUI 提示：请确保至少有 258 张高级凭证（黄票），否则买不全。');
  } else {
    extraPlan.buys = ['生息演算商店内商品（core 按内置顺序买）'];
    delete extraPlan.viaImplicitPrefixTask;
  }
  if (action !== 'reclamation-shop') {
    warnings.push(`\`${taskName}\` 在 tasks.json 里没有同名条目，是 core 用「@ 前缀模板」从 \`Store@Begin\` 隐式生成的（探针已确认 append 成功）；名字写错就没了。`);
  }
  return customTaskResult(action, taskName, { extraPlan, warnings });
}

/** 7. 自动提升潜能：`Custom` + `MiniGame@AutoRaisePotential@Begin` + params.auto_raise_potential.use_normal_token。 */
function buildAutoRaisePotential(args) {
  const bad = rejectForeignArgs('auto-raise-potential', args, ['useNormalToken', 'use_normal_token']);
  if (bad) return bad;
  const useNormalToken = boolOr(args.useNormalToken ?? args.use_normal_token, false);
  return customTaskResult('auto-raise-potential', NIUZZA_PRESET_TASKS['auto-raise-potential'], {
    params: useNormalToken ? { auto_raise_potential: { use_normal_token: true } } : null,
    extraPlan: { useNormalToken },
    warnings: [
      '`useNormalToken` 对应 GUI 的「中坚信物不足时使用普通信物」：不传/false = 弹窗点 × 跳过该次提升；true = 点 √ 消耗普通信物（用掉普通信物，不可撤销）。',
    ],
  });
}

/** 8. 缺口材料合成：`Custom` + `MiniGame@MaterialSynthesis@Begin`（递归补下级，材料不足即停）。 */
function buildMaterialSynthesis(args) {
  const bad = rejectForeignArgs('material-synthesis', args);
  if (bad) return bad;
  return customTaskResult('material-synthesis', NIUZZA_PRESET_TASKS['material-synthesis'], {
    warnings: ['core 只认「当前停在加工站合成页」的状态：从培养页缺材料弹窗点进去再启动；它会递归合成可加工的下级材料。'],
  });
}

/** 9. 刷傀影维多利亚皇冠：`Custom` + `MiniGame@CursedRelic@Begin`（反复开局→查首个收藏品→不是就放弃）。 */
function buildPhantomCrown(args) {
  const bad = rejectForeignArgs('phantom-crown', args);
  if (bad) return bad;
  return customTaskResult('phantom-crown', NIUZZA_PRESET_TASKS['phantom-crown'], {
    warnings: [
      '`MiniGame@CursedRelic@*` 的流程是：点「开始探索」→ OCR 首个收藏品是不是「维多利亚王冠」→ 不是就退出并放弃本局 → 重来；每次放弃要等结算，属于长时间循环。',
    ],
  });
}

/** 隐秘战线：任务名里编码结局与事件（`MiniGame@SecretFront@Begin@EndingX[@事件名]`）。 */
function buildSecretFront(args) {
  let ending = toStr(args.ending ?? args.end ?? '');
  if (!ending) ending = 'E'; // 资源里的默认入口 = 结局 E（SecretFront.json 的 doc）
  ending = ending.replace(/^ending/i, '').toUpperCase();
  if (!SECRET_FRONT_ENDINGS.includes(ending)) {
    return fail(`ending 只能是 A~E（收到 ${JSON.stringify(args.ending)}）`, 'core 用任务名后缀判定结局：EndingA~EndingE；不带后缀时走资源默认入口（结局 E）。');
  }
  const event = toStr(args.event ?? args.eventName ?? '');
  if (event && event.includes('@')) return fail('event 里不能有 @（它会拼进任务名，@ 是分隔符）');
  const taskName = `MiniGame@SecretFront@Begin@Ending${ending}${event ? `@${event}` : ''}`;
  const tasks = [{ type: 'Custom', params: { task_names: [taskName] } }];
  return {
    ok: true,
    tasks,
    plan: {
      action: 'secret-front',
      ending,
      event: event || null,
      taskName,
      knownEvents: SECRET_FRONT_EVENTS,
    },
    dangers: dangersOf(tasks),
    warnings: event && !SECRET_FRONT_EVENTS.includes(event)
      ? [`event="${event}" 不在内置事件表（${SECRET_FRONT_EVENTS.join(' / ')}）里：core 按 OCR 文本匹配，写错会走默认分支。`]
      : undefined,
  };
}

/** 生息演算：`Reclamation` = {theme, mode, difficulty?, clear_store?, tools_to_craft, num_craft_batches, increment_mode}。 */
function buildReclamation(args) {
  const rawTheme = args.theme ?? 'Tales';
  const themeKey = String(rawTheme).trim();
  const theme = RECLAMATION_THEME_ALIASES[themeKey] ?? RECLAMATION_THEME_ALIASES[themeKey.toLowerCase()] ?? themeKey;
  if (theme === 'Fire') {
    return fail(
      'theme=Fire（沙中之火）已下线：core 的 is_valid_theme 只认 Tales / RelaunchAnchor，传 Fire 会被拒绝（append 返回 0）',
      '要刷「沙洲遗闻」用 theme:"Tales"；要刷「重启锚点」用 theme:"RelaunchAnchor" + mode:16/48/32。',
    );
  }
  if (!RECLAMATION_THEMES.includes(theme)) {
    return fail(`theme 只能是 Tales（沙洲遗闻）或 RelaunchAnchor（重启锚点）（收到 ${JSON.stringify(args.theme)}）`);
  }

  const rawMode = args.mode;
  let mode;
  if (theme === 'RelaunchAnchor') {
    const anchor = typeof rawMode === 'string' ? RECLAMATION_ANCHOR_MODES[rawMode.trim().toUpperCase()] : undefined;
    if (anchor !== undefined) mode = anchor;
    else if (rawMode === undefined || rawMode === null) mode = RECLAMATION_ANCHOR_MODES['RA-1'];
    else mode = Number(rawMode);
    if (![16, 32, 48].includes(mode)) {
      return fail(
        `RebootAnchor 的 mode 只能是 RA-1(16) / RA-4(48) / RA-15(32)（收到 ${JSON.stringify(args.mode)}）`,
        '重启锚点用 flags 风格编码：RA-1 = 16、RA-15 = 32、RA-4 = 48；不传默认 RA-1。',
      );
    }
  } else {
    mode = rawMode === undefined || rawMode === null ? 0 : Number(rawMode);
    if (mode !== 0 && mode !== 1) {
      return fail(`Tales（沙洲遗闻）的 mode 只能是 0（无存档刷繁荣点数）或 1（有存档刷繁荣点数）（收到 ${JSON.stringify(args.mode)}）`);
    }
  }

  const params = { theme, mode };
  const difficultyRaw = args.difficulty;
  if (difficultyRaw !== undefined && difficultyRaw !== null && difficultyRaw !== '') {
    const d = Number(difficultyRaw);
    if (![0, 1, 2].includes(d)) return fail(`difficulty 只能是 0（休养）/ 1（标准）/ 2（挑战）（收到 ${JSON.stringify(difficultyRaw)}）`);
    params.difficulty = d;
  }
  if (theme === 'Tales' && args.clearStore !== undefined) params.clear_store = boolOr(args.clearStore, false);

  // ⚠️ 必须始终带上 tools_to_craft / num_craft_batches / increment_mode：
  //    Tales + mode=1 时缺 tools_to_craft 会让 MaaCore 6.20.1 直接崩（空 optional 取 value）。
  let tools = args.toolsToCraft ?? args.tools_to_craft ?? args.toolToCraft;
  if (typeof tools === 'string') tools = [tools];
  if (tools === undefined) tools = ['荧光棒'];
  const toolList = stringList(tools, 'toolsToCraft', { min: 0, max: 16 });
  if (!toolList.ok) return fail(toolList.error, '要组装的支援道具名数组，例如 ["荧光棒"]；空数组 = 不制造道具。');
  params.tools_to_craft = toolList.list;
  const batches = Number(args.numCraftBatches ?? args.num_craft_batches ?? args.maxCraftCountPerRound ?? 16);
  if (!Number.isInteger(batches) || batches < 0 || batches > 999) {
    return fail(`numCraftBatches 必须是 0~999 的整数（收到 ${JSON.stringify(args.numCraftBatches)}）`, '每批组装 99 个；默认 16 是 MAA 按「荧光棒至少消耗 3000 木头」算的。');
  }
  params.num_craft_batches = batches;
  const incrementMode = Number(args.incrementMode ?? args.increment_mode ?? 0);
  if (![0, 1].includes(incrementMode)) return fail(`incrementMode 只能是 0（连点）或 1（长按）（收到 ${JSON.stringify(args.incrementMode)}）`);
  params.increment_mode = incrementMode;

  const tasks = [{ type: 'Reclamation', params }];
  return {
    ok: true,
    tasks,
    plan: {
      action: 'reclamation',
      theme,
      mode,
      modeLabel: theme === 'RelaunchAnchor'
        ? Object.entries(RECLAMATION_ANCHOR_MODES).find(([, v]) => v === mode)?.[0]
        : RECLAMATION_TALES_MODES[mode],
      difficulty: params.difficulty ?? null,
      clearStore: params.clear_store ?? null,
      toolsToCraft: toolList.list,
      numCraftBatches: batches,
      incrementMode,
    },
    dangers: dangersOf(tasks),
  };
}

/** 自动肉鸽：`Roguelike`（常用字段 + params 透传给高级字段）。 */
function buildRoguelike(args) {
  const theme = toStr(args.theme ?? 'Phantom');
  if (!ROGUELIKE_THEMES.includes(theme)) {
    return fail(`theme 只能是 ${ROGUELIKE_THEMES.join(' / ')}（收到 ${JSON.stringify(args.theme)}）`);
  }
  const mode = Number(args.mode ?? 0);
  if (!ROGUELIKE_MODES.includes(mode)) {
    const removed = ROGUELIKE_REMOVED_MODES[mode];
    return fail(
      `mode=${JSON.stringify(args.mode)} 不被 core 接受${removed ? `：${removed}` : ''}`,
      `可用：0（刷分）/1（刷源石锭投资）/4（凹开局）/5（刷坍缩范式，仅 Sami）/6（月度小队）/7（深入调查）/10001（Sarkaz 快速一层）/20001（JieGarden 常乐）/30001、30003（BlackFlow）。`,
    );
  }
  const params = { theme, mode };
  const map = [
    ['startsCount', 'starts_count', 'int'],
    ['investmentsCount', 'investments_count', 'int'],
    ['difficulty', 'difficulty', 'int'],
    ['squad', 'squad', 'str'],
    ['roles', 'roles', 'str'],
    ['coreChar', 'core_char', 'str'],
  ];
  for (const [src, dst, kind] of map) {
    const v = args[src] ?? args[dst];
    if (v === undefined || v === null || v === '') continue;
    if (kind === 'int') {
      const n = Number(v);
      if (!Number.isInteger(n)) return fail(`${src} 必须是整数（收到 ${JSON.stringify(v)}）`);
      params[dst] = n;
    } else {
      params[dst] = String(v).trim();
    }
  }
  const boolMap = [
    ['investmentEnabled', 'investment_enabled'],
    ['stopWhenInvestmentFull', 'stop_when_investment_full'],
    ['investmentWithMoreScore', 'investment_with_more_score'],
    ['useSupport', 'use_support'],
    ['useNonfriendSupport', 'use_nonfriend_support'],
    ['stopAtFinalBoss', 'stop_at_final_boss'],
    ['stopAtMaxLevel', 'stop_at_max_level'],
    ['startWithEliteTwo', 'start_with_elite_two'],
    ['onlyStartWithEliteTwo', 'only_start_with_elite_two'],
  ];
  for (const [src, dst] of boolMap) {
    const v = args[src] ?? args[dst];
    if (v === undefined || v === null) continue;
    params[dst] = boolOr(v, false);
  }
  if (args.params !== undefined && args.params !== null) {
    if (!isPlainObject(args.params)) return fail(`params 必须是对象（高级/冷门字段透传，如 expected_collapsal_paradigms）`);
    Object.assign(params, args.params);
  }
  const tasks = [{ type: 'Roguelike', params }];
  return {
    ok: true,
    tasks,
    plan: {
      action: 'roguelike',
      theme,
      mode,
      startsCount: params.starts_count ?? null,
      investmentsCount: params.investments_count ?? null,
      investmentEnabled: params.investment_enabled ?? null,
      squad: params.squad ?? null,
      roles: params.roles ?? null,
      coreChar: params.core_char ?? null,
    },
    dangers: dangersOf(tasks),
  };
}

/* ────────────────────── 执行层 ────────────────────── */

/** 给模型看的 hint（dryRun / 后台 / 阻塞三种口径 + 本动作前置界面与代价）。 */
export function niuzzaHint({ action, plan = {}, dryRun = false, background = false, dangers = [], warnings = [], status = null } = {}) {
  const cost = NIUZZA_COSTS[action] ?? '可能改变游戏状态';
  const prereq = plan.prereq ?? NIUZZA_PREREQ[action] ?? null;
  const lines = [];
  if (dryRun) {
    lines.push(
      `dryRun=true（**默认**）：只把 ${plan.tasks ?? ''}${(plan.tasks ? ' ' : '')}任务 append 给 core 校验（任务名/参数能不能被接受），**没有 connect、没有 startTask，绝不会执行、不消耗任何资源**。`,
    );
    if (action === 'reclamation') lines.push('生息演算参数已按 core 的防崩要求补齐 tools_to_craft / num_craft_batches / increment_mode（缺 tools_to_craft 会让 MaaCore 6.20.1 崩溃）。');
    if (prereq) lines.push(`前置界面（本工具**不导航**，界面不对 core 会卡住或走错分支）：${prereq}`);
    lines.push(`真跑会：${cost}`);
    lines.push('要真跑：先按上面的 plan 跟用户确认代价，再显式传 dryRun:false。');
  } else if (background) {
    lines.push(
      '真实执行 + 后台模式已起跑：用 `maa_copilot_status({runId})` 看进度、`maa_copilot_stop({runId})` 随时取消；中途用 maa_screenshot + read_image 看画面。',
    );
    if (prereq) lines.push(`前置界面（起跑前应已就位）：${prereq}`);
    lines.push(`这次真的会：${cost}`);
  } else {
    lines.push(`真实执行完成（status 只代表 core 任务链走完，不代表游戏内结果对）：用 maa_screenshot + read_image 验收。`);
    if (prereq) lines.push(`前置界面：${prereq}`);
    lines.push(`本次实际执行：${cost}`);
  }
  if (dangers.length) lines.push(`危险动作（真实执行前必须问用户）：${dangers.map((d) => `${d.type}：${d.note}`).join('；')}`);
  if (warnings.length) lines.push(`注意：${warnings.join('；')}`);
  if (status === 'timeout') lines.push('等待超时但任务**可能还在跑**：先 maa_screenshot 看画面 / maa_current，确认卡死再 maa_stop；不要直接重发（会重复花资源）。');
  if (status === 'failed' || status === 'error') lines.push('任务没正常完成：看 progress 尾部与 logFile 定位停在哪一步，先截图确认界面，再决定是否重试（不要自动重试消耗型动作）。');
  return lines.join('\n');
}

/**
 * 执行一个「牛杂」动作。
 *
 * @param {object} args
 * @param {string} args.action 动作名
 * @param {object} [args.call] 动作参数
 * @param {object} args.cfg 已解析配置
 * @param {boolean} [args.dryRun] 默认 true（只 append 校验）
 * @param {number} [args.timeoutSeconds] 默认 900，钳制 30~7200
 * @param {(ev:any)=>void} [args.onEvent] 回调观察者（后台 runner 用）
 * @param {(ctl:object)=>void} [args.onReady] 后台拿 worker/stopTask
 * @param {object} [args.deps] 单测注入 { CoreWorker, resolveAdbPath, connectionExtras }
 * @returns {Promise<object>} 永远 resolve；失败/超时都在返回值里
 */
export async function runNiuzza({ action, call = {}, cfg, dryRun = true, timeoutSeconds, onEvent, onReady, deps = {} } = {}) {
  const built = buildNiuzzaPlan({ action, call, cfg });
  if (!built.ok) {
    return { ok: false, action, status: 'invalid', error: built.error, advice: built.advice ?? null, dryRun: Boolean(dryRun) };
  }
  const timeout = clampNiuzzaTimeout(timeoutSeconds);
  const chained = await runChain({
    tasks: built.tasks,
    dryRun: Boolean(dryRun),
    cfg,
    timeoutSeconds: timeout,
    timeoutMaxSeconds: NIUZZA_TIMEOUT.max,
    onEvent,
    onReady,
    deps,
  });
  const status = chained?.status ?? 'error';
  const out = {
    ...chained,
    action,
    dryRun: Boolean(dryRun),
    plan: built.plan,
    tasks: built.tasks,
    dangers: built.dangers.length ? built.dangers : null,
    ...(built.warnings ? { warnings: built.warnings } : {}),
    timeoutSeconds: timeout,
    hint: niuzzaHint({
      action,
      plan: { ...built.plan, tasks: built.tasks.map((t) => t.type).join(' + ') },
      dryRun: Boolean(dryRun),
      background: false,
      dangers: built.dangers,
      warnings: built.warnings ?? [],
      status,
    }),
  };
  if (dryRun && out.status === 'dry-run') {
    out.hint = niuzzaHint({
      action,
      plan: { ...built.plan, tasks: built.tasks.map((t) => t.type).join(' + ') },
      dryRun: true,
      dangers: built.dangers,
      warnings: built.warnings ?? [],
    });
  }
  return out;
}
