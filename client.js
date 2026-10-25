/**
 * MAA 插件的设置界面（Web Client 半）。
 *
 * 两处入口，共用同一份表单：
 *  1. `settings.plugins.tab` —— **设置 → 插件 → 「MAA 助手」分页**（快捷入口，与内置「已安装」并列）；
 *  2. `plugins.row.config` —— 插件管理页里本插件那一行的「配置」（深链，保留）。
 *
 * 值经宿主 `/maa/api/config` 读写（Host 侧见 src/ui-config.js），存 `data/settings.json`。
 * 样式只用官方主题 token（`--dsw-alias-*`，取自 Theme.listTokens），不发明新颜色，
 * 保证明暗主题跟手；`label-tertiary` / `border-l3` 这些不存在的 token 不要用。
 *
 * 崩溃红线：factory 内所有代码都包在 try/catch 里，任何异常都退化成「不注册任何东西」，
 * 绝不把客户端模块图带塌（那会让整个 Web UI 白屏）。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-maa',
  factory(require) {
    let React = null;
    try { React = require('react'); } catch { /* 没有 React 就什么都不做 */ }
    if (!React || typeof React.createElement !== 'function') {
      return { inject: [], apply() {} };
    }
    const h = React.createElement;

    const BUNDLE = '@local/dsh-maa';
    const ROW_ID = 'maa-plugin';
    const ENDPOINT = '/maa/api/config';

    /** 字段文案（顺序与 Host 的 EDITABLE_FIELDS 对齐；类型以 Host 返回为准）。 */
    const META = {
      rosterPath: { label: '干员练度文件路径', hint: '用户导出表（.md）或 {own_opers:[…]} 的 .json。留空=自动探测。换文件后作业筛选结果会立刻跟着变。' },
      maaInstallPath: { label: 'MAA 安装目录', hint: '含 MaaCore.dll 与 resource\\ 的目录。留空=自动探测。' },
      adbPath: { label: 'adb 路径', hint: '留空=自动（优先用 MAA 自己配置里记的）。' },
      adbAddress: { label: '模拟器 adb 地址', hint: '例如 127.0.0.1:16384。' },
      adbConfig: { label: 'MaaCore 连接配置名', hint: 'MuMu12 用 MuMuEmulator12。' },
      bridgePort: { label: '远程控制桥端口', hint: 'MAA 的「远程控制」两个端点要填同一端口。' },
      formationIndex: { label: '自动编队栏位', hint: '0=当前编队。' },
      copilotTimeoutSeconds: { label: '抄作业最长等待（秒）' },
      dataDir: { label: '数据目录', hint: '截图/作业/日志的根。留空=插件目录下 data。' },
      nodePath: { label: 'node 可执行文件', hint: '跑 MaaCore 子进程用。留空=自动。' },
      connectExtras: { label: '连接 extras（JSON）', hint: '留空=按 adb/MAA 配置自动推导。' },
      popupGuard: { label: '开打后自动点掉「干员等级过低」弹窗', kind: 'boolean' },
    };

    /* 只使用 Theme.listTokens 里真实存在的 token；每个 var() 都带 hex 兜底，
       避免某个 token 在设置面板子树里没定义时变成「透明背景 + 白字」。
       按钮的主色是实色品牌蓝（DSH 的 #4D6BFE），不赌 token。 */
    const BRAND = '#4D6BFE';
    const BRAND_HOVER = '#3F5CE8';
    const CSS = `
.maa-btn {
  padding: 6px 16px; font-size: 13px; font-weight: 500; line-height: 18px;
  border-radius: 8px; border: none; cursor: pointer;
  color: #fff; background: ${BRAND};
  transition: background-color .15s ease, opacity .15s ease;
}
.maa-btn:hover:not(:disabled) { background: ${BRAND_HOVER}; }
.maa-btn:active:not(:disabled) { background: #354fd6; }
.maa-btn:disabled { opacity: .5; cursor: default; }
.maa-btn:focus-visible { outline: 2px solid ${BRAND}; outline-offset: 2px; }
.maa-btn-ghost {
  padding: 6px 14px; font-size: 13px; line-height: 18px; border-radius: 8px; cursor: pointer;
  color: var(--dsw-alias-label-secondary, #5b6270);
  background: transparent;
  border: 0.5px solid var(--dsw-alias-border-l2, #d5d8e0);
  transition: background-color .15s ease;
}
.maa-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, #f2f4f8); }
.maa-btn-ghost:disabled { opacity: .5; cursor: default; }
.maa-input {
  box-sizing: border-box; width: 100%; padding: 7px 10px; font-size: 13px; line-height: 18px;
  color: var(--dsw-alias-label-primary, #1b1f27);
  background: var(--dsw-alias-bg-layer-1, #fff);
  border: 0.5px solid var(--dsw-alias-border-l2, #d5d8e0);
  border-radius: 8px; outline: none;
  transition: border-color .15s ease;
}
.maa-input:focus { border-color: ${BRAND}; }
`;
    const StyleTag = () => h('style', { key: 'maa-css' }, CSS);

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 22, padding: '4px 0 24px', maxWidth: 640 },
      section: { display: 'flex', flexDirection: 'column', gap: 10 },
      title: { fontSize: 14, fontWeight: 600, lineHeight: '20px', color: 'var(--dsw-alias-label-primary, #1b1f27)', margin: 0 },
      hint: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #5b6270)', margin: 0 },
      card: {
        display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-1, #fff)', border: '0.5px solid var(--dsw-alias-border-l1, #e6e8ee)',
      },
      row: { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13, lineHeight: '20px' },
      rowLabel: { flex: '0 0 84px', color: 'var(--dsw-alias-label-secondary, #5b6270)' },
      rowValue: { flex: '1 1 auto', color: 'var(--dsw-alias-label-primary, #1b1f27)', wordBreak: 'break-all' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12 },
      field: { display: 'flex', flexDirection: 'column', gap: 4 },
      fieldLabel: { fontSize: 13, lineHeight: '20px', fontWeight: 500, color: 'var(--dsw-alias-label-primary, #1b1f27)' },
      actions: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 },
      ok: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-success-primary, #16a34a)', margin: 0 },
      err: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary, #dc2626)', margin: 0 },
      dot: (state) => ({
        width: 6, height: 6, borderRadius: 999, flex: '0 0 auto', alignSelf: 'center',
        background: {
          success: 'var(--dsw-alias-state-success-primary, #16a34a)',
          error: 'var(--dsw-alias-state-error-primary, #dc2626)',
          idle: 'var(--dsw-alias-state-idle-primary, #9ca3af)',
          warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
        }[state] || '#9ca3af',
      }),
    };

    const text = (v) => (v === undefined || v === null ? '' : String(v));
    const short = (p, keep = 46) => {
      const s = text(p);
      if (s.length <= keep) return s;
      const parts = s.split(/[\\/]/);
      const tail = parts.slice(-2).join('\\');
      return `…\\${tail.length > keep ? tail.slice(-keep) : tail}`;
    };

    /** 小标题 + 说明 + 内容，跟设置页其它 section 的层级一致。 */
    function Section({ title, hint, children }) {
      return h('section', { style: S.section }, [
        h('h3', { key: 't', style: S.title }, title),
        hint ? h('p', { key: 'h', style: S.hint }, hint) : null,
        ...(Array.isArray(children) ? children : [children]),
      ]);
    }

    function StatusRow({ state, label, value, mono }) {
      return h('div', { style: S.row }, [
        h('span', { key: 'd', style: S.dot(state) }),
        h('span', { key: 'l', style: S.rowLabel }, label),
        h('span', { key: 'v', style: mono ? { ...S.rowValue, ...S.mono } : S.rowValue }, value),
      ]);
    }

    /** 顶部状态卡：MAA / 练度 / adb，一眼看出哪里没配好。 */
    function StatusCard({ data }) {
      const maa = data.maa;
      const roster = data.roster;
      const eff = data.effective || {};
      const problems = Array.isArray(data.problems) ? data.problems : [];
      const maaOk = Boolean(maa && maa.path && maa.version);
      return h('div', { style: S.card }, [
        h(StatusRow, {
          key: 'maa', state: maaOk ? 'success' : 'error', label: 'MAA',
          value: maaOk ? `${maa.version} · ${short(maa.path, 60)}` : '未定位到（在下面填安装目录）', mono: maaOk,
        }),
        h(StatusRow, {
          key: 'roster', state: roster && roster.ok ? 'success' : 'error', label: '练度文件',
          value: roster && roster.ok
            ? `${roster.parsed} 行 / 拥有 ${roster.owned}${roster.format ? ` · ${roster.format}` : ''} · ${short(roster.path, 40)}`
            : `解析失败：${(roster && roster.error) || (roster && roster.path) || '未配置'}`,
        }),
        h(StatusRow, {
          key: 'adb', state: eff.adbPath ? 'success' : 'idle', label: 'adb / 桥',
          value: `${eff.adbPath ? short(eff.adbPath, 40) : '自动探测'} · 端口 ${text(eff.bridgePort)}`, mono: true,
        }),
        problems.length
          ? h('p', { key: 'p', style: S.err }, problems.join('；'))
          : null,
      ]);
    }

    function ConfigPanel() {
      const [state, setState] = React.useState({ status: 'loading' });
      const [draft, setDraft] = React.useState(null);
      const [result, setResult] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      const load = React.useCallback(() => {
        let alive = true;
        setState({ status: 'loading' });
        fetch(ENDPOINT, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          .then((r) => r.json())
          .then((json) => {
            if (!alive) return;
            if (!json || json.ok !== true) setState({ status: 'error', error: (json && json.error) || '读取配置失败' });
            else setState({ status: 'ready', data: json });
          })
          .catch((err) => { if (alive) setState({ status: 'error', error: String((err && err.message) || err) }); });
        return () => { alive = false; };
      }, []);

      React.useEffect(load, []);

      if (state.status === 'loading') return h('div', null, [h(StyleTag, { key: 'css' }), h('p', { key: 'p', style: S.hint }, '正在读取配置…')]);
      if (state.status === 'error') {
        return h('div', { style: S.section }, [
          h(StyleTag, { key: 'css' }),
          h('p', { key: 'e', style: S.err }, `读取配置失败：${state.error}`),
          h('div', { key: 'a', style: S.actions }, h('button', { key: 'r', className: 'maa-btn-ghost', onClick: load }, '重试')),
        ]);
      }

      const data = state.data;
      const values = data.value || {};
      const fields = Array.isArray(data.editable) && data.editable.length
        ? data.editable
        : Object.keys(values).map((key) => ({ key, type: typeof values[key] }));
      const current = draft === null ? values : { ...values, ...draft };

      const edit = (key, value) => {
        setDraft({ ...(draft === null ? {} : draft), [key]: value });
        setResult(null);
      };

      const changed = () => {
        const patch = {};
        for (const field of fields) {
          if (JSON.stringify(current[field.key]) !== JSON.stringify(values[field.key])) patch[field.key] = current[field.key];
        }
        return patch;
      };

      const save = () => {
        const patch = changed();
        if (!Object.keys(patch).length) { setDraft(null); setResult({ ok: true, message: '没有改动' }); return; }
        setBusy(true);
        fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ patch }),
        })
          .then((r) => r.json())
          .then((json) => {
            setBusy(false);
            if (!json || json.ok !== true) { setResult({ ok: false, message: (json && json.error) || '保存失败' }); return; }
            setDraft(null);
            setResult({ ok: true, message: '已保存并生效（下一次工具调用即用新值，不需要重启）' });
            setState({ status: 'ready', data: json });
          })
          .catch((err) => {
            setBusy(false);
            setResult({ ok: false, message: String((err && err.message) || err) });
          });
      };

      const inputs = fields.map((field) => {
        const key = field.key;
        const meta = META[key] || { label: key };
        const kind = meta.kind || field.type || 'string';
        const value = current[key];
        const control = kind === 'boolean'
          ? h('input', { type: 'checkbox', checked: Boolean(value), onChange: (e) => edit(key, e.target.checked) })
          : h('input', {
            type: kind === 'number' ? 'number' : 'text',
            value: text(value),
            onChange: (e) => edit(key, kind === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value),
            className: 'maa-input',
            spellCheck: false,
          });
        return h('label', { key, style: S.field }, [
          h('span', { key: 'l', style: S.fieldLabel }, meta.label),
          control,
          meta.hint ? h('span', { key: 'h', style: S.hint }, meta.hint) : null,
        ]);
      });

      return h('div', { style: S.section }, [
        h(StyleTag, { key: 'css' }),
        h(StatusCard, { key: 'status', data }),
        ...inputs,
        result ? h('p', { key: 'r', style: result.ok ? S.ok : S.err }, result.message) : null,
        h('div', { key: 'act', style: S.actions }, [
          h('button', { key: 's', className: 'maa-btn', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          h('button', {
            key: 'u', className: 'maa-btn-ghost', disabled: busy,
            onClick: () => { setDraft(null); setResult(null); },
          }, '撤销改动'),
        ]),
        data.settingsFile ? h('p', { key: 'f', style: S.hint }, `保存位置：${data.settingsFile}`) : null,
      ]);
    }

    /** 设置 → 插件 → 「MAA 助手」分页（快捷入口）。 */
    function MaaSettingsTab() {
      try {
        return h('div', { style: S.page }, [
          h(Section, {
            key: 'head',
            title: 'MAA 明日方舟助手',
            hint: '在这里直接改配置，保存后下一次工具调用生效。插件本身（启用/禁用/卸载）在「设置 → 插件 → 已安装」里。',
            children: [],
          }),
          h(Section, { key: 'form', title: '配置', hint: '第一项是干员练度文件路径；留空表示自动探测。', children: h(ConfigPanel, null) }),
        ]);
      } catch (e) {
        return h('p', { style: S.err }, `设置页渲染失败：${(e && e.message) || e}`);
      }
    }

    /** 插件管理页里本插件那一行的配置视图（深链）。 */
    function MaaConfigView(props) {
      try {
        if (props && props.view === 'summary') return 'MAA 路径 / 干员练度文件路径 / adb / 抄作业参数';
        return h(ConfigPanel, null);
      } catch (e) {
        return h('p', { style: S.err }, `设置面板渲染失败：${(e && e.message) || e}`);
      }
    }

    try {
      return {
        inject: ['slots'],
        apply(ctx) {
          try {
            if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return;
            // 快捷入口：设置 → 插件 → MAA 助手
            ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
              name: 'settings.plugins.tab',
              id: 'maa',
              order: 20,
              label: 'MAA 助手',
            }, MaaSettingsTab));
            // 深链：插件管理页里本插件那一行的「配置」
            ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
              name: 'plugins.row.config',
              key: `${BUNDLE}#${ROW_ID}`,
            }, MaaConfigView));
          } catch { /* 注册失败只是没有设置页，不能带塌 UI */ }
        },
      };
    } catch {
      return { inject: [], apply() {} };
    }
  },
});
