/**
 * 工具定义（14 个）：远程控制 8 个 + 抄作业 3 个 + 自检 1 个 + 点击 1 个 + 滑动 1 个。
 *
 * 这里是**唯一**把能力暴露给模型的地方；实现都在 src/ 下，工具只做参数校验与调度。
 * 描述里的口径与禁则是踩过坑的结论，改之前先读 docs/tools/maa*.md。
 */
import { doctor } from './doctor.js';
import { findJobs, runCopilot, verifyScreenshot, clickScreen } from './copilot.js';
import { resolveConfig } from './config.js';
import { swipe } from './input/index.js';

/* ────────────────────── JSON Schema 小工具 ────────────────────── */

const obj = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });

/** 1280×720 系的点。 */
const point = (description) => ({
  type: 'object',
  description,
  properties: { x: num('0 ≤ x < 1280'), y: num('0 ≤ y < 720') },
  required: ['x', 'y'],
  additionalProperties: false,
});

/** 输出统一成「一段可读 JSON」，卡片不折腾。 */
const textOut = (title) => ({
  schema: {},
  render: (_args, value) => [{ type: 'text', text: `${title}\n${JSON.stringify(value, null, 2)}` }],
});

const clampSec = (v, def, max) => Math.min(Math.max(Number(v) || def, 1), max);

/* ────────────────────── 工具工厂 ────────────────────── */

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig 取当前插件配置（每次调用重新解析，改设置立即生效）
 * @param {string} deps.pkgDir 插件包目录
 * @param {() => Promise<object|null>} deps.getBridge 取（必要时启动）bridge 实例
 * @param {string} deps.pkgVersion 插件版本
 */
export function createTools({ getConfig, pkgDir, getBridge, pkgVersion, getUiState = () => null }) {
  /** 每次调用都重新解析配置：路径、端口、开关都立即生效。 */
  const cfgOf = async () => resolveConfig(getConfig() ?? {}, pkgDir);

  /**
   * 取（必要时启动）远程控制桥。桥可能因为端口被旧插件占用而启动失败，
   * 所以这里按需求懒启动一次：旧插件禁用后不用重启本插件。
   */
  const bridgeOf = async () => {
    const bridge = await getBridge();
    if (!bridge) {
      throw new Error('远程控制桥未启动：看 maa_doctor 的 bridge 段（端口被占用就改 bridgePort，或禁用仍占着端口的旧插件）');
    }
    return bridge;
  };

  return [
    /* ───────────── 自检 ───────────── */
    {
      name: 'maa_doctor',
      description:
        'MAA 自检：输出 MAA 安装路径与版本、MaaCore 能力表（Asst* 符号）、关卡表、练度文件解析结果（解析 N 个 / 拥有 M）、adb 路径与设备、MaaCore 直连后端（koffi/node）、远程控制桥状态、目录可写性。' +
        '第一次使用或任何工具报错时先跑它；problems 是要修的，warnings 是降级提示。改完插件设置直接重跑，不需要重启。',
      parameters: obj(),
      output: textOut('MAA 自检'),
      async execute() {
        const cfg = await cfgOf();
        let bridge = null;
        let bridgeError = null;
        try { bridge = await getBridge(); } catch (e) { bridgeError = String(e?.message || e); }
        return doctor({ cfg, bridge, bridgeError, pkgVersion, ui: getUiState() });
      },
    },

    /* ───────────── 远程控制（后端 A）───────────── */
    {
      name: 'maa_health',
      description: '检查 MAA 是否在轮询本机桥（最近 5 秒内有没有来取任务）、队列里还挂着什么。每次远程控制操作前先看一眼。online=false 说明 MAA 没启动或「远程控制」端点没配成这个地址，如实告诉用户，不要反复重试。',
      parameters: obj(),
      output: textOut('MAA 桥状态'),
      async execute() {
        const bridge = await bridgeOf();
        return bridge.health();
      },
    },
    {
      name: 'maa_run',
      description:
        '向 MAA 下发一个排队任务，立即返回 taskId，不等待执行完成（配合 maa_wait 轮询）。' +
        '可用 type：LinkStart（一键长草，按 MAA 里勾选的队列）、LinkStart-Base/WakeUp/Combat/Recruiting/Mall/Mission/AutoRoguelike/Reclamation（单跑一个子功能）、CaptureImage（排队截图）、Toolbox-GachaOnce/GachaTenTimes（抽卡）、Settings-ConnectAddress/Settings-Stage1（改 MAA 配置，需 params）。' +
        '抽卡/碎石/吃药/打断正在跑的长草有真实代价，先问用户。',
      parameters: obj(
        {
          type: str('任务类型，见描述里的清单'),
          params: str('Settings-* 的值，例如 Stage1 传 "1-7"、ConnectAddress 传 "127.0.0.1:5555"'),
        },
        ['type'],
      ),
      output: textOut('已下发'),
      async execute(args) {
        const bridge = await bridgeOf();
        const task = bridge.enqueue(args.type, args.params);
        return { taskId: task.id, type: task.type, immediate: /^(CaptureImageNow|StopTask|HeartBeat)$/.test(task.type) };
      },
    },
    {
      name: 'maa_tasks',
      description: '列出最近 30 个任务及其状态（queued/dispatched/done/lost）、结果 SUCCESS/FAILED、截图文件。',
      parameters: obj(),
      output: textOut('任务列表'),
      async execute() {
        const bridge = await bridgeOf();
        return { tasks: bridge.list(30) };
      },
    },
    {
      name: 'maa_wait',
      description: '等某个任务被 MAA 执行完，单次最多 55 秒；超时返回 pending，可再次调用继续等。长任务（一键长草）循环调用，中间夹 maa_screenshot 确认没卡在登录/弹窗。',
      parameters: obj({ taskId: str('maa_run 返回的 taskId'), timeoutSeconds: num('1-55，默认 30') }, ['taskId']),
      output: textOut('等待结果'),
      async execute(args) {
        const bridge = await bridgeOf();
        const task = bridge.get(args.taskId);
        if (!task) throw new Error(`未知 taskId: ${args.taskId}`);
        const r = await bridge.waitFor(task, clampSec(args.timeoutSeconds, 30, 55) * 1000);
        if (r.state === 'done') return { status: 'done', result: r.status, file: r.file, type: r.type };
        const silent = Date.now() - bridge.lastPollAt;
        if (!bridge.lastPollAt || silent > 60_000) {
          return { status: 'offline', taskId: r.id, type: r.type, note: 'MAA 已超过 60 秒没有轮询，可能崩溃或被关掉' };
        }
        return { status: r.state, taskId: r.id, type: r.type, note: r.note };
      },
    },
    {
      name: 'maa_screenshot',
      description:
        '立刻截一张当前模拟器画面并返回 PNG 路径（用 read_image 看）。这是观察游戏状态的唯一手段（协议没有查理智/仓库/关卡的接口）。' +
        '桥在线时让 MAA 截（CaptureImageNow）；桥离线时自动退回 adb screencap，所以 MAA GUI 没开也能看画面。',
      parameters: obj({ timeoutSeconds: num('1-55，默认 20') }),
      output: textOut('截图'),
      async execute(args) {
        const cfg = await cfgOf();
        const bridge = await getBridge().catch(() => null);
        if (bridge?.health().online) {
          const task = bridge.enqueue('CaptureImageNow');
          const r = await bridge.waitFor(task, clampSec(args.timeoutSeconds, 20, 55) * 1000);
          if (r.state === 'done' && r.file) return { via: 'maa-remote', file: r.file, bytes: r.payloadLen };
          if (r.state === 'lost') return { via: 'maa-remote', ok: false, note: r.note };
        }
        const shot = await verifyScreenshot({ cfg });
        if (!shot.ok) return { via: 'adb', ok: false, error: shot.error, hint: '先用 maa_doctor 看 adb 与设备状态' };
        return { via: 'adb', file: shot.file, bytes: shot.bytes };
      },
    },
    {
      name: 'maa_current',
      description: '心跳：问 MAA 现在正在执行哪个任务。running 为空表示空闲。',
      parameters: obj({ timeoutSeconds: num('1-30，默认 8') }),
      output: textOut('当前任务'),
      async execute(args) {
        const bridge = await bridgeOf();
        const task = bridge.enqueue('HeartBeat');
        const r = await bridge.waitFor(task, clampSec(args.timeoutSeconds, 8, 30) * 1000);
        if (r.state !== 'done') return { running: null, status: r.state, note: 'MAA 无响应' };
        return { running: r.note || null, idle: !r.note };
      },
    },
    {
      name: 'maa_stop',
      description: '叫停 MAA 当前任务（StopTask）。协议没有回执：停完用 maa_current 或 maa_screenshot 确认。打断正在跑的长草有代价，先问用户。',
      parameters: obj(),
      output: textOut('已下发停止'),
      async execute() {
        const bridge = await bridgeOf();
        return { taskId: bridge.enqueue('StopTask').id };
      },
    },
    {
      name: 'maa_set',
      description: '改 MAA 配置：只支持 ConnectAddress（模拟器 adb 地址，如 127.0.0.1:5555）和 Stage1（关卡名，如 1-7）。Settings 是排队任务，前面有任务时会等它跑完；改关卡后配合 maa_run(LinkStart-Combat) 生效。',
      parameters: obj({ name: { type: 'string', enum: ['ConnectAddress', 'Stage1'], description: '配置项' }, value: str('新值') }, ['name', 'value']),
      output: textOut('已下发配置'),
      async execute(args) {
        const bridge = await bridgeOf();
        const task = bridge.enqueue(`Settings-${args.name}`, args.value);
        return { taskId: task.id, note: 'Settings 任务按队列执行，前面有任务时会等它跑完' };
      },
    },

    /* ───────────── 抄作业（后端 B：MaaCore 直连）───────────── */
    {
      name: 'maa_copilot_find',
      description:
        '按关卡到作业站（prts.plus）找本号能抄的作业，并把作业全文落盘成可直接执行的 JSON。' +
        '练度口径（用户定，不要自行放宽）：专精要求按 7 级技能代替；精二等级允许下浮 30 但不低于 60；模组原样交给 MAA 复验；练度不够就换作业，不要提示提升练度。' +
        '不消耗理智。返回的 jobs[].file 就是 maa_copilot_run 的入参。',
      parameters: obj(
        {
          stage: str('关卡代号，如 1-7、PR-D-2（也可直接给内部 stageId 如 main_01-07）'),
          limit: num('最多返回几条，默认 8'),
        },
        ['stage'],
      ),
      output: textOut('可抄作业'),
      async execute(args) {
        const cfg = await cfgOf();
        return findJobs({ stage: args.stage, cfg, limit: Number(args.limit) || 8 });
      },
    },
    {
      name: 'maa_copilot_run',
      description:
        '用 MaaCore 直连跑一条作业（不经过 MAA GUI）。三选一给作业：file（maa_copilot_find 落盘的文件）/ stage（自动挑播放量最高的一条）/ id（作业站 id）。' +
        '前置：模拟器在跑、游戏已登录、**停在目标关卡的详情页或编队页**（Copilot 不会自己导航）、**代理指挥要关**（否则队伍锁死选不上人）。' +
        'dryRun=true 只让 core 解析作业，不连模拟器、不消耗理智。跑完必看返回的 screenshot 判断是否三星：任务返回 done 不代表三星。' +
        '涉及真实理智消耗，动手前先跟用户确认。',
      parameters: obj(
        {
          file: str('作业 JSON 的绝对路径（maa_copilot_find 返回的 jobs[].file）'),
          stage: str('关卡代号；给这个就自动挑播放量最高的一条作业'),
          id: num('作业站作业 id'),
          dryRun: bool('只校验 core 能解析作业，不连接、不消耗。默认 false'),
          formation: bool('自动编队（按作业干员选人）。默认 true'),
          formationIndex: num('用哪个编队栏位，0=当前编队。默认取插件设置'),
          timeoutSeconds: num('最长等待秒数，默认取插件设置（900）'),
          popupGuard: bool('开打后自动补点画面中央，绕过「干员等级过低」弹窗（人少作业才需要）。默认取插件设置'),
        },
        [],
      ),
      output: textOut('抄作业结果'),
      async execute(args) {
        const cfg = await cfgOf();
        let file = args.file ? String(args.file) : '';
        let picked = null;
        if (!file) {
          // id 只接受正整数：它会被拼进落盘文件名，不能把任意字符串（含 ../）带进路径
          const jobId = args.id === undefined ? null : Number(args.id);
          if (jobId !== null && (!Number.isInteger(jobId) || jobId <= 0)) {
            throw new Error(`id 必须是正整数（收到 ${JSON.stringify(args.id)}）`);
          }
          if (jobId !== null) {
            const { fetchJob } = await import('./prts/api.js');
            const job = await fetchJob(jobId);
            if (!(job.actions ?? []).length) throw new Error(`作业 ${jobId} 没有 actions（列表接口的元数据）；换一条`);
            const fs = await import('node:fs');
            const path = await import('node:path');
            fs.mkdirSync(cfg.jobsDir, { recursive: true });
            file = path.join(cfg.jobsDir, `job_${jobId}.json`);
            fs.writeFileSync(file, JSON.stringify(job));
          } else if (args.stage) {
            const found = await findJobs({ stage: args.stage, cfg, limit: 1 });
            if (!found.ok) return found;
            picked = found.jobs?.[0] ?? null;
            if (!picked?.file) return { ok: false, error: `没有找到可抄作业（${args.stage}）：${JSON.stringify(found.scanned)}`, find: found };
            file = picked.file;
          } else {
            throw new Error('必须给 file / stage / id 之一');
          }
        }
        const onEvent = () => {};
        const result = await runCopilot({
          jobFile: file,
          cfg,
          dryRun: Boolean(args.dryRun),
          formation: args.formation === undefined ? true : Boolean(args.formation),
          formationIndex: args.formationIndex ?? cfg.formationIndex,
          timeoutSeconds: Number(args.timeoutSeconds) || cfg.copilotTimeoutSeconds,
          popupGuard: args.popupGuard === undefined ? cfg.popupGuard : Boolean(args.popupGuard),
          onEvent,
        });
        return picked ? { ...result, pickedFromFind: picked } : result;
      },
    },
    {
      name: 'maa_copilot_verify',
      description: '截图验收：直接 adb 截一张当前画面并返回路径（用 read_image 判断是否三星、有没有停在弹窗）。不需要 MAA GUI。',
      parameters: obj(),
      output: textOut('验收截图'),
      async execute() {
        const cfg = await cfgOf();
        return verifyScreenshot({ cfg });
      },
    },
    {
      name: 'maa_click',
      description:
        '用独立 MaaCore 会话点一下屏幕（坐标是 1280×720 系，不是设备 1920×1080）。用途：点掉 MAA 不认识的游戏弹窗（如「干员等级过低」点 (640,360)）、点掉「点击画面以继续」。' +
        '必须是独立会话：同一会话里 AsstAsyncClick 会排在任务链之后，等于没点。' +
        '（旧说法「adb input tap 对这个 Unity 游戏无效」已推翻：adb 也能点，只是要吃设备坐标；滑动见 maa_swipe。）',
      parameters: obj({ x: num('1280 系 x'), y: num('1280 系 y') }, ['x', 'y']),
      output: textOut('点击结果'),
      async execute(args) {
        const cfg = await cfgOf();
        return clickScreen({ x: Number(args.x), y: Number(args.y), cfg });
      },
    },
    {
      name: 'maa_swipe',
      description:
        '滑动手势（**不消耗理智**）：拖动/甩动游戏画面，用来自己走到 Copilot 到不了的关卡。' +
        '为什么需要它：Copilot 不负责导航，必须先把游戏停在目标关卡的详情页/编队页；' +
        '像「主题曲 → 第十二章 → 磨难险地 → 关卡列表滑到最右端 → H12-2」这种必须先滑动才能到的关卡，没有它永远到不了。' +
        '坐标是 1280×720 系（与 maa_click 一致），不是设备 1920×1080 —— 换算和注入由本工具内部按当前旋转/分辨率完成。' +
        '**起点必须落在空白处**（地图空地、列表间隙）：按下即触发，压在按钮或关卡节点上会直接点进去（可能是「开始行动 / 使用源石 / 抽卡」）。' +
        'durationMs < 150 近似「甩」，有惯性会多翻一段；慢拖大约只移动 |dx|。地图翻页建议 180~260px / 120~180ms，抬起后 settleMs 至少 300。' +
        '抬起 + settle 后自动截一张图，**验收只看截图**（ok 只代表 adb 注入成功，不代表画面真的动了）。' +
        'backend 目前只有 adb-input 可用（实测 adb input 能拖动本机 Unity 游戏）；maatouch/minitouch 只留了拒绝理由。' +
        'MAA 正在跑任务时会被拒绝（两路触摸会打架）：先 maa_stop 或等它跑完。',
      parameters: obj(
        {
          from: point('1280×720 系起点（放在空白处：按下即触发）'),
          to: point('1280×720 系终点'),
          durationMs: num('按下→抬起总时长 ms，默认 200，范围 50~3000；<150 近似甩动（有惯性）'),
          steps: num('中间 MOVE 次数，默认 8（只在 holdMs>0 时生效；默认的 input swipe 由系统自己插值）'),
          holdMs: num('按下后先停多久再移动 ms，默认 0，范围 0~3000；>0 时改用 input motionevent 序列（长按拖动）'),
          settleMs: num('抬起后等多久再截图 ms，默认 400，范围 0~5000；地图惯性大就用 500'),
          backend: { type: 'string', enum: ['auto', 'adb-input', 'maatouch', 'minitouch'], description: '默认 auto（= adb-input）' },
        },
        ['from', 'to'],
      ),
      output: textOut('滑动结果'),
      async execute(args) {
        try {
          const cfg = await cfgOf();
          const bridge = await getBridge().catch(() => null);
          return await swipe({
            cfg,
            bridge,
            from: args.from,
            to: args.to,
            durationMs: args.durationMs,
            steps: args.steps,
            holdMs: args.holdMs,
            settleMs: args.settleMs,
            backend: args.backend ?? 'auto',
          });
        } catch (e) {
          return { ok: false, error: `滑动手势执行失败: ${e?.message || e}` };
        }
      },
    },
  ];
}
