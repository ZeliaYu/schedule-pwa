/* ===================================================================
   排班管理 — 前端应用（无构建步骤，原生 ES2020）
   =================================================================== */
'use strict';

/* ------------------------------------------------------------ 工具 */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const pad2 = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseISO = (s) => {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const fmtNum = (n) => {
  const v = Math.round(Number(n) * 100) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, '');
};
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const weekdayCN = (d) => '周' + WEEKDAYS[d.getDay()];
const todayISO = () => iso(new Date());

function monthRange(year, month) { // month: 0-based
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  return { from: iso(first), to: iso(last), days: last.getDate() };
}

function initials(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  if (!/[一-龥]/.test(s)) return s.slice(0, 2).toUpperCase();
  // 中文：三字及以上取后两字，两字取首字，避免头像与姓名完全重复
  return s.length >= 3 ? s.slice(-2) : s[0];
}

/* ------------------------------------------------------------ API
   纯前端模式：所有请求走本地 API 层（IndexedDB），无网络往返。
   接口形状与原先的 FastAPI 后端一致，便于迁移与测试。
*/
let localApi = null;

async function api(path, opts = {}) {
  if (!localApi) throw new Error('本地存储尚未就绪');
  try {
    return await localApi(path, opts);
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/* ------------------------------------------------------------ 状态 */
let store = null;   // Store 实例（IndexedDB）

const state = {
  employees: [],
  settings: {},
  view: 'dashboard',
  rangePreset: 'month',
  range: null,           // {from, to}
  stats: null,
  daily: null,
  monthly: null,
  schedule: null,
  cursor: new Date(),    // 月视图当前月
  dayCursor: new Date(), // 今日视图
  bulkMode: false,
  selected: new Set(),   // "date|empId"
  calendarEdit: false,
  showTable: false,
  trendMetric: 'net',
  showHidden: false,     // 月排班/统计是否显示被屏蔽人员
  showCheck: false,      // 今日页是否展开出勤核对
  rowDrag: null,         // 拖动排序中的行
};

const empById = () => Object.fromEntries(state.employees.map((e) => [e.id, e]));

/** 紧凑时段：08:00-16:00 → 8-16，跨整点不够精确时保留到半小时 */
function slotShort(a) {
  if (!(a.start && a.end)) return fmtNum(a.hours) + 'h';
  const hm = (v) => {
    const [hh, mm] = String(v).split(':');
    return mm && mm !== '00' ? `${+hh}:${mm}` : String(+hh);
  };
  return `${hm(a.start)}-${hm(a.end)}`;
}
/** 单条排班的悬停提示 */
function slotTitle(a) {
  const parts = [];
  parts.push(a.start && a.end ? `${a.start}-${a.end}（${fmtNum(a.hours)} 小时）` : `${fmtNum(a.hours)} 小时`);
  if (a.content) parts.push(a.content);
  return parts.join(' · ');
}
/** 当天排班合计工时 */
const dayHours = (list) => (list || []).reduce((s, a) => s + (Number(a.hours) || 0), 0);

/* ------------------------------------------------------------ 工作内容预设
   统一存在 settings.content_options（逗号分隔）。留空则从历史排班里自动汇总。
*/
function splitOptions(raw) {
  return String(raw || '')
    .split(/[,，、\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 可选的工作内容：预设优先，没有预设时汇总已有排班 */
function contentOptions() {
  const preset = splitOptions(state.settings?.content_options);
  if (preset.length) {
    // 去重并保持顺序
    return [...new Set(preset)];
  }
  const seen = new Map();
  for (const a of store?.state?.assignments || []) {
    const c = String(a.content || '').trim();
    if (c) seen.set(c, (seen.get(c) || 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

/** 把工作内容加进预设（已有则忽略） */
async function rememberContent(content) {
  const c = String(content || '').trim();
  if (!c) return;
  const list = splitOptions(state.settings?.content_options);
  if (list.includes(c)) return;
  list.push(c);
  try {
    state.settings = await api('/settings', { method: 'PUT', body: { content_options: list.join(',') } });
  } catch { /* 失败不阻断排班 */ }
}

/**
 * 简易输入对话框（替代 prompt，手机上也好看）
 * 独立浮层，不占用 #modalRoot，因此可以在别的弹窗上面再开一层。
 * @returns {Promise<string|null>} 取消返回 null
 */
function askText(title, defaultValue = '', placeholder = '') {
  return new Promise((resolve) => {
    let settled = false;
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop ask-overlay';
    wrap.innerHTML = `
      <div class="modal ask-modal" role="dialog" aria-modal="true">
        <div class="modal-head"><div><h3>${esc(title)}</h3></div></div>
        <div class="modal-body">
          <input class="input" id="askTextInput" value="${esc(defaultValue)}"
                 placeholder="${esc(placeholder)}" autocomplete="off">
        </div>
        <div class="modal-foot">
          <button class="btn" data-ask-cancel>取消</button>
          <button class="btn primary" data-ask-ok>确定</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const input = $('#askTextInput', wrap);
    const finish = (v) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      wrap.remove();
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    document.addEventListener('keydown', onKey);

    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) finish(null);
    });
    $('[data-ask-cancel]', wrap).addEventListener('click', () => finish(null));
    $('[data-ask-ok]', wrap).addEventListener('click', () => finish(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(input.value); }
    });
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

/** 工作内容选择器（多选胶囊 + 输入框，用「、」分隔多个内容） */
function contentPickerHtml(id, current, extraClass = '') {
  const opts = contentOptions();
  const picked = splitContents(current);
  // 已选但不在预设里的也显示出来
  const all = [...opts];
  for (const c of picked) if (!all.includes(c)) all.push(c);
  return `
    <div class="content-picker ${extraClass}">
      <div class="content-chips" data-content-chips="${id}">
        ${all.map((c) => `
          <button type="button" class="content-chip${picked.includes(c) ? ' active' : ''}" data-content-value="${esc(c)}">${esc(c)}</button>`).join('')}
        <button type="button" class="content-chip add" data-content-add="${id}" title="新增工作内容">+ 新增</button>
      </div>
      <input class="input content-input" id="${id}" value="${esc(current || '')}"
             placeholder="可多选；也能直接输入，回车存为常用" autocomplete="off">
    </div>`;
}

/** 「理瓶、灌装」→ ['理瓶','灌装'] */
function splitContents(raw) {
  return String(raw || '').split(/[、,，]+/).map((s) => s.trim()).filter(Boolean);
}

/** 绑定工作内容选择器的事件（点胶囊 = 加入/移出，多选） */
function bindContentPicker(root, id, onChange) {
  const input = $(`#${id}`, root);
  const chips = $(`[data-content-chips="${id}"]`, root);
  if (!input || !chips) return;

  // 按输入框内容刷新胶囊高亮
  const markActive = () => {
    const picked = splitContents(input.value);
    $$('.content-chip', chips).forEach((b) => {
      if (b.dataset.contentValue !== undefined) {
        b.classList.toggle('active', picked.includes(b.dataset.contentValue));
      }
    });
  };

  const toggle = (name) => {
    const picked = splitContents(input.value);
    const i = picked.indexOf(name);
    if (i >= 0) picked.splice(i, 1);
    else picked.push(name);
    input.value = picked.join('、');
    markActive();
    if (onChange) onChange(input.value);
  };

  chips.addEventListener('click', async (e) => {
    const btn = e.target.closest('.content-chip');
    if (!btn) return;
    if (btn.dataset.contentAdd !== undefined) {
      const v = await askText('新增工作内容', '', '如：巡检 / 清洗设备');
      const name = String(v || '').trim();
      if (!name) return;
      await rememberContent(name);
      const addBtn = $('[data-content-add]', chips);
      if (!$$(`[data-content-value="${CSS.escape(name)}"]`, chips).length) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'content-chip';
        chip.dataset.contentValue = name;
        chip.textContent = name;
        chips.insertBefore(chip, addBtn);
      }
      // 新增后直接选中
      if (!splitContents(input.value).includes(name)) toggle(name);
      else markActive();
      toast(`已把「${name}」加入常用并选中`);
      return;
    }
    if (btn.dataset.contentValue !== undefined) toggle(btn.dataset.contentValue);
  });

  input.addEventListener('input', markActive);
  input.addEventListener('change', () => { if (onChange) onChange(input.value); });
  // 回车：把输入框里还没存过的内容存为常用
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const picked = splitContents(input.value);
    if (!picked.length) return;
    for (const c of picked) await rememberContent(c);
    // 补上新出现的胶囊
    const addBtn = $('[data-content-add]', chips);
    for (const c of picked) {
      if (!$$(`[data-content-value="${CSS.escape(c)}"]`, chips).length) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'content-chip';
        chip.dataset.contentValue = c;
        chip.textContent = c;
        chips.insertBefore(chip, addBtn);
      }
    }
    markActive();
    if (onChange) onChange(input.value);
  });
  markActive();
}

/* ------------------------------------------------------------ 提示 & 模态 */
let toastTimer = null;
let barObserver = null;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, isErr ? 4200 : 2200);
}

function openModal({ title, sub = '', body, footer = '', wide = false, onMount }) {
  const root = $('#modalRoot');
  // 同一时刻只保留一个对话框，避免重复点击叠加
  root.innerHTML = '';
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head">
        <div>
          <h3>${esc(title)}</h3>
          ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
        </div>
        <button class="icon-btn" data-close aria-label="关闭">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  root.appendChild(backdrop);
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.closest('[data-close]')) close(); });
  if (onMount) onMount(backdrop, close);
  return { root: backdrop, close };
}

/* ------------------------------------------------------------ 图表基元 */
const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  return el;
}
/** 只在数据端做圆角、基线端方角的横向条 */
function hBarPath(x, y, w, h, r, dir) {
  // dir=1 从基线向右，dir=-1 向左
  r = Math.min(r, Math.abs(w), h / 2);
  if (Math.abs(w) < 0.4) return `M${x},${y}h0`;
  if (dir > 0) {
    return `M${x},${y} h${w - r} a${r},${r} 0 0 1 ${r},${r} v${h - 2 * r} a${r},${r} 0 0 1 ${-r},${r} h${-(w - r)} z`;
  }
  return `M${x},${y} h${-(w - r)} a${r},${r} 0 0 0 ${-r},${r} v${h - 2 * r} a${r},${r} 0 0 0 ${r},${r} h${w - r} z`;
}
function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks = [0];
  // 保证最大刻度覆盖最大值，否则条形会溢出绘图区
  for (let v = step; v < max - step * 0.001; v += step) ticks.push(Math.round(v * 100) / 100);
  ticks.push(Math.round(Math.ceil(max / step) * step * 100) / 100);
  return ticks;
}

let tipEl = null;
function ensureTip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'chart-tip';
    document.body.appendChild(tipEl);
  }
  return tipEl;
}
function showTip(html, evt) {
  const t = ensureTip();
  t.innerHTML = html;
  t.classList.add('show');
  const r = t.getBoundingClientRect();
  let x = evt.clientX;
  let y = evt.clientY - 12;
  x = Math.max(r.width / 2 + 8, Math.min(window.innerWidth - r.width / 2 - 8, x));
  y = Math.max(r.height + 12, y);
  t.style.left = x + 'px';
  t.style.top = y + 'px';
}
function hideTip() { if (tipEl) tipEl.classList.remove('show'); }

/** 横向发散条形图：加班（右，正） / 欠班（左，负） */
function divergingBar(container, rows, opts = {}) {
  if (!container) return;
  container.innerHTML = '';
  const width = Math.max(container.clientWidth || 320, 240);
  const narrow = width < 520;
  const rowH = opts.rowH || (narrow ? 24 : 26);
  const gap = opts.gap || 10;
  const labelW = opts.labelW || (narrow ? 52 : 88);
  const padR = narrow ? 36 : 52;
  const padT = 22;
  const padB = 26;
  const plotW = Math.max(80, width - labelW - padR);
  const height = padT + rows.length * (rowH + gap) + padB;
  const svg = svgEl('svg', { class: 'chart-svg', viewBox: `0 0 ${width} ${height}`, width, height });
  svg.style.height = height + 'px';

  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  const ticks = niceTicks(maxAbs, narrow ? 2 : 3).filter((t) => t > 0);
  const scaleMax = Math.max(...ticks);
  const x0 = labelW + plotW / 2;
  const half = plotW / 2 - 4;
  const sx = (v) => (v / scaleMax) * half;

  // 网格（两侧对称，但刻度值只标一次）
  for (const t of ticks) {
    if (t <= 0) continue;
    for (const s of [-1, 1]) {
      const x = x0 + s * sx(t);
      svg.appendChild(svgEl('line', { x1: x, x2: x, y1: padT - 6, y2: height - padB, class: 'gridline' }));
    }
  }
  ticks.forEach((t) => {
    const x = x0 + sx(t);
    const lbl = svgEl('text', { x, y: padT - 10, class: 'tick-label', 'text-anchor': 'middle' });
    lbl.textContent = fmtNum(t);
    svg.appendChild(lbl);
  });
  // 中轴
  svg.appendChild(svgEl('line', { x1: x0, x2: x0, y1: padT - 6, y2: height - padB, class: 'baseline' }));

  // 轴标题
  const axL = svgEl('text', { x: labelW - 4, y: height - 8, class: 'axis-title' });
  axL.textContent = '← 欠班';
  svg.appendChild(axL);
  const axR = svgEl('text', { x: width - 4, y: height - 8, class: 'axis-title', 'text-anchor': 'end' });
  axR.textContent = '加班 →';
  svg.appendChild(axR);

  rows.forEach((row, i) => {
    const y = padT + i * (rowH + gap) + gap / 2;
    const color = row.value >= 0 ? 'var(--series-1)' : 'var(--series-8)';
    const w = Math.abs(sx(row.value));

    // 姓名（文本色，不着数据色）
    const name = svgEl('text', {
      x: labelW - 8, y: y + rowH / 2 + 4, class: 'bar-label strong', 'text-anchor': 'end',
    });
    name.textContent = row.label;
    svg.appendChild(name);

    const hit = svgEl('rect', {
      x: labelW, y: y - gap / 2, width: plotW, height: rowH + gap,
      fill: 'transparent', style: 'cursor:pointer',
    });
    hit.addEventListener('mousemove', (e) => {
      showTip(`<div class="tip-title">${esc(row.label)}</div>
        <div class="tip-row"><span>加班</span><b>${fmtNum(row.overtime)} 小时</b></div>
        ${row.rest_overtime > 0 ? `<div class="tip-row"><span>└ 休息日</span><b>${fmtNum(row.rest_overtime)} 小时</b></div>` : ''}
        <div class="tip-row"><span>欠班</span><b>${fmtNum(row.owe)} 小时</b></div>
        <div class="tip-row"><span>应出勤</span><b>${fmtNum(row.expected)} 小时</b></div>
        <div class="tip-row"><span>已出勤</span><b>${fmtNum(row.actual)} 小时</b></div>`, e);
    });
    hit.addEventListener('mouseleave', hideTip);
    svg.appendChild(hit);

    if (w > 0.5) {
      const path = svgEl('path', {
        d: row.value >= 0 ? hBarPath(x0, y, w, rowH, 4, 1) : hBarPath(x0, y, w, rowH, 4, -1),
        fill: color,
      });
      svg.appendChild(path);
      if (typeof row.onClick === 'function') {
        path.style.cursor = 'pointer';
        path.addEventListener('click', row.onClick);
      }
      // 数值标签：放在条内部靠端头（避免溢出右边缘被截断）
      const inside = w > 28;
      const val = svgEl('text', {
        x: row.value >= 0
          ? (inside ? x0 + w - 6 : Math.min(x0 + w + 5, width - 2))
          : (inside ? x0 - w + 6 : Math.max(x0 - w - 5, labelW + 2)),
        y: y + rowH / 2 + 4,
        class: 'bar-label strong',
        'text-anchor': row.value >= 0
          ? (inside ? 'end' : 'start')
          : (inside ? 'start' : 'end'),
        fill: inside ? '#fff' : 'var(--text-secondary)',
      });
      val.textContent = (row.value > 0 ? '+' : '−') + fmtNum(Math.abs(row.value));
      svg.appendChild(val);
    } else {
      // 净值恰为 0：在中轴上画一小段中性刻度
      svg.appendChild(svgEl('line', {
        x1: x0 - 5, x2: x0 + 5, y1: y + rowH / 2, y2: y + rowH / 2,
        stroke: 'var(--axis)', 'stroke-width': 2, 'stroke-linecap': 'round',
      }));
    }
  });

  container.appendChild(svg);
}

/** 折线图：月度趋势（加班 / 欠班） */
function lineChart(container, series, labels, opts = {}) {
  container.innerHTML = '';
  const padL = 40, padR = 56, padT = 20, padB = 34;
  const width = Math.max(container.clientWidth || 640, 320);
  const height = opts.height || 240;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const svg = svgEl('svg', { class: 'chart-svg', viewBox: `0 0 ${width} ${height}`, width, height });
  svg.style.height = height + 'px';

  const allVals = series.flatMap((s) => s.values).map((v) => Math.max(0, v));
  const maxV = Math.max(0.5, ...allVals);
  const ticks = niceTicks(maxV, 4);
  const top = Math.max(...ticks, maxV);
  const sx = (i) => padL + (labels.length <= 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW);
  const sy = (v) => padT + plotH - (v / top) * plotH;

  for (const t of ticks) {
    const y = sy(t);
    svg.appendChild(svgEl('line', { x1: padL, x2: padL + plotW, y1: y, y2: y, class: t === 0 ? 'baseline' : 'gridline' }));
    const lbl = svgEl('text', { x: padL - 8, y: y + 4, class: 'tick-label', 'text-anchor': 'end' });
    lbl.textContent = fmtNum(t);
    svg.appendChild(lbl);
  }
  labels.forEach((lb, i) => {
    const x = sx(i);
    const lbl = svgEl('text', { x, y: height - 12, class: 'tick-label', 'text-anchor': 'middle' });
    lbl.textContent = lb;
    svg.appendChild(lbl);
  });

  const paths = [];
  series.forEach((s) => {
    const d = s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${sx(i)},${sy(Math.max(0, v))}`).join(' ');
    const path = svgEl('path', {
      d, fill: 'none', stroke: s.color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    });
    svg.appendChild(path);
    paths.push(path);
    // 端点
    const lastI = s.values.length - 1;
    if (lastI >= 0) {
      svg.appendChild(svgEl('circle', {
        cx: sx(lastI), cy: sy(Math.max(0, s.values[lastI])), r: 4.5,
        fill: s.color, stroke: 'var(--surface-1)', 'stroke-width': 2,
      }));
    }
  });

  // 端点直接标注（≤4 系列且端点分离时）
  series.forEach((s) => {
    const i = s.values.length - 1;
    if (i < 0) return;
    const v = s.values[i];
    const lbl = svgEl('text', {
      x: sx(i) + 10, y: sy(Math.max(0, v)) + 4, class: 'bar-label strong', 'text-anchor': 'start',
    });
    lbl.textContent = fmtNum(v);
    svg.appendChild(lbl);
  });

  // 悬停十字线
  const cross = svgEl('line', { x1: 0, x2: 0, y1: padT, y2: padT + plotH, class: 'baseline', opacity: 0 });
  svg.appendChild(cross);
  const overlay = svgEl('rect', { x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent' });
  svg.appendChild(overlay);
  overlay.addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    const rel = ((e.clientX - box.left) / box.width) * width;
    const i = Math.max(0, Math.min(labels.length - 1, Math.round(((rel - padL) / plotW) * (labels.length - 1))));
    cross.setAttribute('x1', sx(i));
    cross.setAttribute('x2', sx(i));
    cross.setAttribute('opacity', 1);
    const rowsHtml = series.map((s) => `<div class="tip-row"><span>${esc(s.name)}</span><b>${fmtNum(s.values[i] ?? 0)} 班</b></div>`).join('');
    showTip(`<div class="tip-title">${esc(labels[i])}</div>${rowsHtml}`, e);
  });
  overlay.addEventListener('mouseleave', () => { cross.setAttribute('opacity', 0); hideTip(); });

  container.appendChild(svg);
}

/** 热力图：人员 × 日期，单元格按班次着色（堆叠） */
function heatmap(container, data) {
  container.innerHTML = '';
  const emps = data.employees;
  const days = data.days;
  if (!emps.length || !days.length) { container.innerHTML = '<div class="empty">暂无数据</div>'; return; }

  const cellW = 22, cellH = 26, gap = 2;
  const nameW = 104;
  const headH = 38;
  const width = nameW + days.length * cellW + 8;
  const height = headH + emps.length * cellH + 8;
  const svg = svgEl('svg', { class: 'chart-svg', viewBox: `0 0 ${width} ${height}`, width, height });
  svg.style.height = height + 'px';

  const cellMap = {};
  for (const c of data.cells) cellMap[c.employee_id + '|' + c.date] = c;

  // 表头日期
  days.forEach((d, i) => {
    const dt = parseISO(d.date);
    const x = nameW + i * cellW + cellW / 2;
    const t = svgEl('text', { x, y: 14, class: 'tick-label', 'text-anchor': 'middle', 'font-weight': dt.getDate() === 1 ? 600 : 400 });
    t.textContent = dt.getDate();
    svg.appendChild(t);
    const w = svgEl('text', { x, y: 27, class: 'tick-label', 'text-anchor': 'middle', 'font-size': 9.5 });
    w.textContent = WEEKDAYS[dt.getDay()];
    svg.appendChild(w);
  });

  emps.forEach((e, ri) => {
    const y = headH + ri * cellH;
    const t = svgEl('text', { x: nameW - 10, y: y + cellH / 2 + 4, class: 'bar-label', 'text-anchor': 'end' });
    t.textContent = e.name;
    svg.appendChild(t);

    days.forEach((d, ci) => {
      const x = nameW + ci * cellW;
      const cell = cellMap[e.id + '|' + d.date];
      const slots = cell ? cell.slots : [];
      const hours = cell ? cell.hours : 0;
      const r = { x: x + gap / 2, y: y + gap / 2, width: cellW - gap, height: cellH - gap };

      if (!slots.length) {
        // 空单元格：工作日画虚线框（缺勤待补），休息日画浅底
        if (d.is_workday) {
          svg.appendChild(svgEl('rect', {
            ...r, rx: 3, fill: 'var(--surface-1)',
            stroke: 'var(--grid)', 'stroke-width': 1, 'stroke-dasharray': '2 2',
          }));
        } else {
          svg.appendChild(svgEl('rect', { ...r, rx: 3, fill: 'var(--surface-2)', opacity: 0.65 }));
        }
      } else {
        // 按工时着色：标准工时 = 满色，超出加深，不足变浅
        const std = data.daily_hours || 8;
        const ratio = Math.max(0, hours / std);
        svg.appendChild(svgEl('rect', {
          ...r, rx: 3,
          fill: 'var(--series-1)',
          'fill-opacity': Math.min(1, 0.28 + ratio * 0.62).toFixed(2),
        }));
      }

      const hit = svgEl('rect', { x, y, width: cellW, height: cellH, fill: 'transparent' });
      hit.addEventListener('mousemove', (ev) => {
        const detail = slots.map((s) => {
          const t = s.start && s.end ? `${s.start}-${s.end} ` : '';
          return `${t}${fmtNum(s.hours)}h${s.content ? ' · ' + esc(s.content) : ''}`;
        }).join('<br>');
        showTip(`<div class="tip-title">${esc(e.name)} · ${d.date.slice(5)} ${weekdayCN(parseISO(d.date))}</div>
          <div class="tip-row"><span>工时</span><b>${slots.length ? fmtNum(hours) + ' 小时' : (d.is_workday ? '未排班' : '休息')}</b></div>
          ${detail ? `<div class="tip-row" style="display:block"><span style="display:block;line-height:1.6">${detail}</span></div>` : ''}`, ev);
      });
      hit.addEventListener('mouseleave', hideTip);
      svg.appendChild(hit);
    });
  });

  const wrap = document.createElement('div');
  wrap.style.overflowX = 'auto';
  wrap.appendChild(svg);
  container.appendChild(wrap);
}

function legendHtml(items) {
  return `<div class="legend">${items.map((it) => `
    <span class="legend-item"><span class="legend-swatch" style="background:${it.color}"></span>${esc(it.name)}</span>
  `).join('')}</div>`;
}

/* ------------------------------------------------------------ 数据加载 */
function currentRangeLabel() {
  const { from, to } = state.range;
  const a = parseISO(from), b = parseISO(to);
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) {
    return `${a.getFullYear()}年${a.getMonth() + 1}月`;
  }
  return `${from.slice(5)} – ${to.slice(5)}`;
}

function setPreset(preset) {
  state.rangePreset = preset;
  const now = new Date();
  if (preset === 'month') {
    const r = monthRange(state.cursor.getFullYear(), state.cursor.getMonth());
    state.range = { from: r.from, to: r.to };
  } else if (preset === 'last30') {
    state.range = { from: iso(addDays(now, -29)), to: iso(now) };
  } else if (preset === 'quarter') {
    const q = Math.floor(now.getMonth() / 3) * 3;
    state.range = {
      from: iso(new Date(now.getFullYear(), q, 1)),
      to: iso(new Date(now.getFullYear(), q + 3, 0)),
    };
  } else if (preset === 'year') {
    state.range = {
      from: iso(new Date(now.getFullYear(), 0, 1)),
      to: iso(new Date(now.getFullYear(), 11, 31)),
    };
  } else {
    const r = monthRange(state.cursor.getFullYear(), state.cursor.getMonth());
    state.range = { from: r.from, to: r.to };
  }
}

async function loadBootstrap() {
  const data = await api('/bootstrap');
  state.employees = data.employees;
  state.settings = data.settings;
  const org = $('#orgName');
  if (org) org.textContent = data.settings.org_name || '排班管理';
  document.title = (data.settings.org_name || '排班管理');
}

async function loadDashboard() {
  const { from, to } = state.range;
  const inc = state.showHidden ? '&include_hidden=true' : '';
  const [stats, monthly] = await Promise.all([
    api(`/stats?date_from=${from}&date_to=${to}${inc}`),
    api(`/stats/monthly?date_from=${from}&date_to=${to}${inc}`),
  ]);
  state.stats = stats;
  state.monthly = monthly;
}

async function loadMonth() {
  const r = monthRange(state.cursor.getFullYear(), state.cursor.getMonth());
  const [schedule, cal] = await Promise.all([
    api(`/schedule?date_from=${r.from}&date_to=${r.to}`),
    api(`/calendar?date_from=${r.from}&date_to=${r.to}`),
  ]);
  state.schedule = schedule;
  state.calendar = cal;
}

async function loadDay() {
  const d = iso(state.dayCursor);
  // 当月区间用于「当月加班/欠班」列
  const r = monthRange(state.dayCursor.getFullYear(), state.dayCursor.getMonth());
  const [schedule, stats, leaves] = await Promise.all([
    api(`/schedule?date_from=${d}&date_to=${d}`),
    api(`/stats?date_from=${r.from}&date_to=${r.to}`),
    api(`/leaves?date_from=${d}&date_to=${d}`),
  ]);
  state.schedule = schedule;
  state.dayStats = stats;
  state.dayLeaves = leaves;
}

/* ------------------------------------------------------------ 视图：统计 */
async function renderDashboard() {
  const main = $('#main');
  if (!state.employees.length) {
    main.innerHTML = emptyStateHtml();
    bindEmptyState();
    return;
  }
  main.innerHTML = `<div class="loading"><span class="spin"></span></div>`;
  try {
    if (!state.range) setPreset(state.rangePreset);
    await loadDashboard();
  } catch (e) {
    main.innerHTML = `<div class="empty"><h3>加载失败</h3><p>${esc(e.message)}</p></div>`;
    return;
  }
  const { stats, monthly } = state;
  const t = stats.totals;
  const emps = stats.employees;
  const netSum = emps.reduce((a, e) => a + e.net_final, 0);
  const restOTtotal = emps.reduce((a, e) => a + e.rest_overtime, 0);
  const peopleOT = emps.filter((e) => e.overtime > 0).length;
  const peopleOWE = emps.filter((e) => e.owe > 0).length;
  const hiddenTotal = state.employees.filter((e) => e.hidden).length;

  main.innerHTML = `
    <div class="range-bar">
      <div class="segmented" role="group" aria-label="时间范围">
        ${[['month', '本月'], ['last30', '近30天'], ['quarter', '本季度'], ['year', '今年']].map(([k, lb]) => `
          <button data-preset="${k}" aria-pressed="${state.rangePreset === k}">${lb}</button>`).join('')}
      </div>
      <span class="chip">${esc(currentRangeLabel())} · 工作日 <b style="margin-left:4px">${t.workdays}</b> 天</span>
      ${hiddenTotal ? `
        <button class="btn sm ghost" id="toggleHidden">
          ${state.showHidden ? '排除已隐藏人员' : `包含已隐藏 (${hiddenTotal})`}
        </button>` : ''}
    </div>

    <div class="kpi-row">
      <div class="kpi hero-kpi">
        <div class="label">累计加班</div>
        <div class="value">${fmtNum(t.overtime)}<span class="unit">小时</span></div>
        <div class="meta">${peopleOT} 人存在加班 · 人均 ${fmtNum(peopleOT ? t.overtime / peopleOT : 0)} 小时${restOTtotal > 0 ? ` · 含休息日 ${fmtNum(restOTtotal)}` : ''}</div>
      </div>
      <div class="kpi">
        <div class="label">累计欠班</div>
        <div class="value">${fmtNum(t.owe)}<span class="unit">小时</span></div>
        <div class="meta">${peopleOWE} 人存在欠班</div>
      </div>
      <div class="kpi">
        <div class="label">已出勤</div>
        <div class="value">${fmtNum(stats.historical ? t.period_actual : t.actual)}<span class="unit">小时</span></div>
        <div class="meta">应出勤 ${fmtNum(t.expected)} 小时${stats.historical ? ` · 历史另计 ${fmtNum(t.historical_actual)}` : ''}</div>
      </div>
      <div class="kpi">
        <div class="label">综合净额</div>
        <div class="value ${netSum > 0 ? 'num-pos' : netSum < 0 ? 'num-neg' : ''}">${netSum > 0 ? '+' : ''}${fmtNum(netSum)}<span class="unit">小时</span></div>
        <div class="meta">加班 − 欠班（全员合计）</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head">
        <h2>每人加班 / 欠班</h2>
        <span class="sub">以应出勤为基准，向右为加班，向左为欠班（单位：小时）</span>
        <div class="spacer"></div>
        <div class="chart-toggle">
          <button data-export-csv="1" aria-pressed="false" title="导出当前区间统计为 CSV">导出</button>
          <button data-toggle-table="${state.showTable}" aria-pressed="${state.showTable}">${state.showTable ? '图表' : '表格'}</button>
        </div>
      </div>
      <div class="card-body">
        ${state.showTable ? tableHtml(emps) : `<div id="barChart" class="chart-wrap"></div>${emps.length > 20 ? '<p style="font-size:12px;color:var(--text-muted);margin:10px 0 0">人员较多，可切换到「表格」按净值排序查看</p>' : ''}`}
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head">
        <h2>月度趋势</h2>
        <span class="sub">按自然月拆分</span>
        <div class="spacer"></div>
        <div class="chart-toggle">
          <button data-metric="net" aria-pressed="${state.trendMetric === 'net'}">加班</button>
          <button data-metric="owe" aria-pressed="${state.trendMetric === 'owe'}">欠班</button>
        </div>
      </div>
        <div class="card-body">
        ${legendHtml([
          { name: state.trendMetric === 'net' ? '加班（小时）' : '欠班（小时）', color: state.trendMetric === 'net' ? 'var(--series-1)' : 'var(--series-8)' },
        ])}
        <div id="trendChart" class="chart-wrap"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>排班密度</h2>
        <span class="sub">人员 × 日期 · 颜色越深工时越多</span>
        <div class="spacer"></div>
      </div>
      <div class="card-body">
        ${legendHtml([
          { name: `不足 ${fmtNum((stats.daily_hours || 8) * 0.5)} 小时`, color: 'color-mix(in srgb, var(--series-1) 40%, transparent)' },
          { name: `约 ${fmtNum(stats.daily_hours || 8)} 小时`, color: 'color-mix(in srgb, var(--series-1) 70%, transparent)' },
          { name: '超时', color: 'var(--series-1)' },
        ])}
        <div id="heatmap" class="chart-wrap"></div>
      </div>
    </div>
  `;

  // 图表
  if (!state.showTable) {
    const rows = [...emps]
      .sort((a, b) => b.net_final - a.net_final)
      .map((e) => ({
        label: e.name, value: e.net_final, name: e.name,
        expected: e.expected, actual: e.actual, overtime: e.overtime, owe: e.owe,
        rest_overtime: e.rest_overtime || 0,
        onClick: () => openEmployeeStats(e),
      }));
    const barEl = $('#barChart');
    divergingBar(barEl, rows);
    if (typeof ResizeObserver !== 'undefined') {
      if (barObserver) barObserver.disconnect();
      barObserver = new ResizeObserver(() => {
        const el = $('#barChart');
        if (el) divergingBar(el, rows);
      });
      barObserver.observe(barEl);
    }
  }

  const metric = state.trendMetric;
  lineChart($('#trendChart'),
    [{
      name: metric === 'net' ? '加班' : '欠班',
      color: metric === 'net' ? 'var(--series-1)' : 'var(--series-8)',
      values: monthly.map((m) => (metric === 'net' ? m.totals.overtime : m.totals.owe)),
    }],
    monthly.map((m) => m.month.replace('-', '/')));

  // 热力图数据
  try {
    const hm = await api(`/stats/heatmap?date_from=${stats.range.from}&date_to=${stats.range.to}`);
    if ($('#heatmap')) heatmap($('#heatmap'), hm);
  } catch { /* ignore */ }

  // 事件
  $$('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    setPreset(b.dataset.preset);
    renderDashboard();
  }));
  $$('[data-toggle-table]').forEach((b) => b.addEventListener('click', () => {
    state.showTable = !state.showTable;
    renderDashboard();
  }));
  $$('[data-export-csv]').forEach((b) => b.addEventListener('click', exportStatsCsv));
  $('#toggleHidden')?.addEventListener('click', () => {
    state.showHidden = !state.showHidden;
    renderDashboard();
  });
  $$('[data-metric]').forEach((b) => b.addEventListener('click', () => {
    state.trendMetric = b.dataset.metric;
    renderDashboard();
  }));
  $$('#main [data-adj-emp]').forEach((b) => b.addEventListener('click', () => {
    const id = Number(b.dataset.adjEmp);
    openAdjustModal(empById()[id]);
  }));
}

function tableHtml(emps) {
  const rows = [...emps].sort((a, b) => b.net_final - a.net_final);
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.net_final)));
  const historical = !!state.stats?.historical;
  return `
  <div class="hint-box" style="margin-bottom:10px">下表数值单位均为<b>小时</b>。</div>
  <div class="table-wrap">
    <table class="data">
      <thead>
        <tr>
          <th>姓名</th><th>班组</th>
          <th class="num">应出勤</th>
          <th class="num">${historical ? '本期出勤' : '已出勤'}</th>
          ${historical ? '<th class="num">累计已上</th>' : ''}
          <th class="num">加班</th><th class="num">欠班</th>
          <th style="min-width:150px">净值</th><th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((e) => `
          <tr>
            <td><div class="name-cell"><span class="avatar">${esc(initials(e.name))}</span><span class="name">${esc(e.name)}</span></div></td>
            <td>${esc(e.team || '—')}</td>
            <td class="num">${fmtNum(e.expected)}
              ${e.leave_days > 0 ? `<div class="cell-sub">已扣请假 ${e.leave_days} 天</div>` : ''}
            </td>
            <td class="num">${fmtNum(historical ? e.period_actual : e.actual)}</td>
            ${historical ? `<td class="num" style="color:var(--text-muted)">${fmtNum(e.actual)}</td>` : ''}
            <td class="num ${e.overtime > 0 ? 'num-pos' : 'num-zero'}">
              ${e.overtime > 0 ? '+' + fmtNum(e.overtime) : '0'}
              ${e.rest_overtime > 0 ? `<div class="cell-sub">含休息日 ${fmtNum(e.rest_overtime)}h</div>` : ''}
            </td>
            <td class="num ${e.owe > 0 ? 'num-neg' : 'num-zero'}">${e.owe > 0 ? '−' + fmtNum(e.owe) : '0'}</td>
            <td>
              <div class="mini-bar">
                <span class="track">
                  ${e.net_final >= 0
                    ? `<span class="fill pos" style="width:${(Math.abs(e.net_final) / maxAbs) * 50}%"></span>`
                    : `<span class="fill neg" style="width:${(Math.abs(e.net_final) / maxAbs) * 50}%"></span>`}
                </span>
                <span style="font-variant-numeric:tabular-nums;min-width:44px;text-align:right">${e.net_final > 0 ? '+' : ''}${fmtNum(e.net_final)}</span>
              </div>
            </td>
            <td><button class="btn sm ghost" data-adj-emp="${e.employee_id}">调整</button></td>
          </tr>
        `).join('')}
      </tbody>
      <tfoot>
        <tr>
          <td>合计</td><td></td>
          <td class="num">${fmtNum(emps.reduce((a, e) => a + e.expected, 0))}</td>
          <td class="num">${fmtNum(emps.reduce((a, e) => a + (historical ? e.period_actual : e.actual), 0))}</td>
          ${historical ? `<td class="num">${fmtNum(emps.reduce((a, e) => a + e.actual, 0))}</td>` : ''}
          <td class="num">${fmtNum(emps.reduce((a, e) => a + e.overtime, 0))}</td>
          <td class="num">${fmtNum(emps.reduce((a, e) => a + e.owe, 0))}</td>
          <td colspan="2"></td>
        </tr>
      </tfoot>
    </table>
  </div>`;
}

function openEmployeeStats(e) {
  const entries = e.entries || [];
  openModal({
    title: e.name,
    sub: `${state.range.from} 至 ${state.range.to} · 单位：小时`,
    body: `
      <div class="summary-grid">
        <div class="summary-item"><div class="k">应出勤</div><div class="v">${fmtNum(e.expected)}</div></div>
        <div class="summary-item"><div class="k">已出勤</div><div class="v">${fmtNum(e.actual)}</div></div>
        <div class="summary-item"><div class="k">加班</div><div class="v num-pos">${e.overtime > 0 ? '+' + fmtNum(e.overtime) : '0'}</div></div>
        <div class="summary-item"><div class="k">欠班</div><div class="v num-neg">${e.owe > 0 ? fmtNum(e.owe) : '0'}</div></div>
      </div>
      <div class="hint-box" style="margin-bottom:14px">
        自动差额 <b>${e.net > 0 ? '+' : ''}${fmtNum(e.net)}</b> 小时（工作日排班 ${fmtNum(e.scheduled)} + 补出勤 ${fmtNum(e.manual_attend)} − 应出勤 ${fmtNum(e.expected)}）<br>
        ${e.rest_overtime > 0 ? `休息日上班 <b class="num-pos">+${fmtNum(e.rest_overtime)}</b> 小时（${e.rest_days} 天）<br>` : ''}
        ${e.leave_days > 0 ? `请假 <b>${e.leave_days}</b> 天，应出勤已扣 ${fmtNum(e.leave_hours)} 小时（不计欠班）<br>` : ''}
        ${e.rest_off_days > 0 ? `调休 <b>${e.rest_off_days}</b> 天<br>` : ''}
        手工调整：加班 +${fmtNum(e.manual_overtime)}，欠班 −${fmtNum(e.manual_owe)}<br>
        每天标准工时 ${fmtNum(e.daily_hours)} 小时
      </div>
      <h4 style="font-size:13px;margin-bottom:8px">排班明细（共 ${entries.length} 条）</h4>
      <div class="table-wrap" style="max-height:240px;overflow-y:auto">
        <table class="data">
          <thead><tr><th>日期</th><th>时间段</th><th class="num">工时</th><th>工作内容</th></tr></thead>
          <tbody>
            ${entries.length ? entries.map((a) => `
              <tr>
                <td>${a.date.slice(5)}${a.rest ? ' <span class="row-badge">休息日</span>' : ''}</td>
                <td>${a.start && a.end ? `${a.start}-${a.end}` : '—'}</td>
                <td class="num">${fmtNum(a.hours)}</td>
                <td style="color:var(--text-secondary)">${esc(a.content || '')}</td>
              </tr>`).join('') : '<tr><td colspan="4" class="person-empty">区间内没有排班</td></tr>'}
          </tbody>
        </table>
      </div>
      <h4 style="font-size:13px;margin:16px 0 8px">手工调整记录</h4>
      ${e.adjustments.length ? e.adjustments.map((a) => `
        <div class="adjust-item">
          <span class="kind ${a.kind}">${{ overtime: '加班', owe: '欠班', attend: '补出勤' }[a.kind] || a.kind}</span>
          <span class="amount">${a.amount > 0 ? '+' : ''}${fmtNum(a.amount)}</span>
          <span class="date">${a.date}</span>
          <span class="note">${esc(a.note || '')}</span>
        </div>`).join('') : '<div class="person-empty">暂无手工调整</div>'}
    `,
    footer: `<button class="btn" data-close>关闭</button>
             <button class="btn primary" id="mAdjust">新增调整</button>`,
    onMount: (root, close) => {
      $('#mAdjust', root).addEventListener('click', () => { close(); openAdjustModal(e); });
    },
  });
}

function openAdjustModal(emp) {
  if (!emp) return;
  const today = todayISO();
  openModal({
    title: '手工调整加班 / 欠班',
    sub: emp.name,
    body: `
      <div class="form-grid">
        <div class="field">
          <label>类型</label>
          <select class="input" id="adjKind">
            <option value="overtime">加班（顶班、延时）</option>
            <option value="owe">欠班（早退、临时调休）</option>
            <option value="attend">补出勤（补上未排的班）</option>
          </select>
        </div>
        <div class="field">
          <label>数量（小时）</label>
          <input class="input" id="adjAmount" type="number" step="0.5" value="8" min="0">
        </div>
        <div class="field full">
          <label>日期</label>
          <input class="input" id="adjDate" type="date" value="${today}">
        </div>
        <div class="field full">
          <label>备注</label>
          <input class="input" id="adjNote" placeholder="如：替班 / 早退两小时">
        </div>
      </div>
      <div class="hint-box" style="margin-top:14px">
        「补出勤」计入已出勤，可直接抵消欠班；「加班」「欠班」直接加减最终净值。单位为小时。
      </div>
    `,
    footer: `<button class="btn" data-close>取消</button><button class="btn primary" id="adjSave">保存</button>`,
    onMount: (root, close) => {
      $('#adjSave', root).addEventListener('click', async () => {
        const kind = $('#adjKind', root).value;
        const amount = Number($('#adjAmount', root).value);
        if (!(amount > 0)) { toast('数量需大于 0', true); return; }
        try {
          await api('/adjustments', {
            method: 'POST',
            body: {
              employee_id: emp.employee_id ?? emp.id,
              kind, amount, date: $('#adjDate', root).value,
              note: $('#adjNote', root).value.trim(),
            },
          });
          close();
          toast('已保存');
          if (state.view === 'dashboard') renderDashboard();
          if (state.view === 'people') renderPeople();
        } catch (e) { toast(e.message, true); }
      });
    },
  });
}

/* ------------------------------------------------------------ 视图：月排班 */
async function renderMonth() {
  const main = $('#main');
  if (!state.employees.length) {
    main.innerHTML = emptyStateHtml();
    bindEmptyState();
    return;
  }
  await loadMonth();
  // 被屏蔽人员默认不显示，可选择显示
  const hiddenCount = state.employees.filter((e) => e.hidden).length;
  const employees = state.showHidden
    ? state.employees
    : state.employees.filter((e) => !e.hidden);
  const year = state.cursor.getFullYear();
  const month = state.cursor.getMonth();
  const r = monthRange(year, month);
  const dayList = [...Array(r.days).keys()].map((i) => {
    const d = new Date(year, month, i + 1);
    return { date: iso(d), day: i + 1, weekday: d.getDay(), isWork: state.calendar.days.find((x) => x.date === iso(d))?.is_workday ?? true };
  });
  const assigns = {};
  for (const a of state.schedule.assignments) {
    const k = a.date + '|' + a.employee_id;
    (assigns[k] = assigns[k] || []).push(a);
  }

  main.innerHTML = `
    <div class="card">
      <div class="sched-toolbar">
        <div class="month-nav">
          <button class="icon-btn" id="prevMonth" aria-label="上个月">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </button>
          <span class="label">${year}年${month + 1}月</span>
          <button class="icon-btn" id="nextMonth" aria-label="下个月">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
          </button>
          <button class="btn sm ghost" id="thisMonth">今天</button>
        </div>
        <div class="spacer" style="margin-left:auto"></div>
        <button class="btn sm" id="toggleBulk" aria-pressed="${state.bulkMode}">
          ${state.bulkMode ? '退出批量' : '批量选择'}
        </button>
        <button class="btn sm" id="toggleCal" aria-pressed="${state.calendarEdit}">
          ${state.calendarEdit ? '完成日历编辑' : '编辑工作日'}
        </button>
        <button class="btn sm" id="pickPeople">
          人员${hiddenCount ? ` (${employees.length}/${state.employees.length})` : ''}
        </button>
        <button class="btn sm ghost" id="copyPrev">复制上周</button>
      </div>
      ${state.bulkMode ? `
        <div class="sched-toolbar" style="background:var(--accent-soft);border-bottom:1px solid var(--border)">
          <span class="chip" id="selCount">已选 ${state.selected.size} 格</span>
          <span style="color:var(--text-muted);font-size:12.5px">批量填入工时（小时）：</span>
          <input class="input" id="bulkHours" type="number" step="0.5" min="0.5" value="${fmtNum(state.settings.daily_hours || 8)}"
                 style="width:80px;height:32px">
          <button class="btn sm" id="bulkApply">应用到选中</button>
          <button class="btn sm danger" data-bulk="__clear">清除</button>
          <button class="btn sm ghost" id="clearSel">取消选择</button>
        </div>` : ''}
      <div class="grid-scroll">
        <table class="sched">
          <thead>
            <tr>
              <th class="name-col">姓名</th>
              ${dayList.map((d) => `
                <th class="${d.isWork ? '' : 'offday'} ${d.weekday === 0 || d.weekday === 6 ? 'weekend' : ''} ${state.calendarEdit ? 'cal-edit' : ''}"
                    data-cal-date="${d.date}" title="${d.isWork ? '工作日' : '休息日'}">
                  <div class="sched-day"><span class="d">${d.day}</span><span class="w">${WEEKDAYS[d.weekday]}</span></div>
                </th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${employees.map((emp) => `
              <tr data-emp-row="${emp.id}" class="${emp.hidden ? 'row-hidden' : ''}">
                <td class="name-col">
                  <span class="name-cell">
                    <span class="row-grip" title="拖动调整顺序" aria-label="拖动调整顺序">⠿</span>
                    <span class="avatar">${esc(initials(emp.name))}</span>
                    <span class="row-name">${esc(emp.name)}</span>
                    ${emp.hidden ? '<span class="row-badge">隐藏</span>' : ''}
                  </span>
                </td>
                ${dayList.map((d) => {
                  const list = assigns[d.date + '|' + emp.id] || [];
                  const selKey = d.date + '|' + emp.id;
                  const h = dayHours(list);
                  return `<td class="${d.isWork ? '' : 'weekend'}">
                    <div class="cell ${list.length ? 'filled' : ''} ${state.selected.has(selKey) ? 'sel' : ''}"
                         data-date="${d.date}" data-emp="${emp.id}"
                         title="${esc(list.map(slotTitle).join('\n') || '未排班')}">
                      ${list.length === 1
                        ? `<span class="slot-tag">${esc(slotShort(list[0]))}</span><span class="cell-hours">${fmtNum(h)}h</span>`
                        : list.length > 1
                          ? `<span class="slot-tag">${list.length} 段</span><span class="cell-hours">${fmtNum(h)}h</span>`
                          : `<span class="cell-rest">${d.isWork ? '' : '休'}</span>`}
                    </div>
                  </td>`;
                }).join('')}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="sched-foot">
        <span>人员 <b>${employees.length}</b></span>
        <span>本月排班 <b>${state.schedule.assignments.length}</b> 条</span>
        <span>工作日 <b>${state.calendar.days.filter((d) => d.is_workday).length}</b> 天</span>
        <span style="margin-left:auto;color:var(--text-muted)">
          ${state.bulkMode || state.calendarEdit ? '编辑模式已开启' : '点格子排班 · 点日期可标记休息日'}
        </span>
      </div>
    </div>
  `;

  // 导航
  $('#prevMonth').addEventListener('click', () => {
    state.cursor = addMonths(state.cursor, -1);
    state.selected.clear();
    renderMonth();
  });
  $('#nextMonth').addEventListener('click', () => {
    state.cursor = addMonths(state.cursor, 1);
    state.selected.clear();
    renderMonth();
  });
  $('#thisMonth').addEventListener('click', () => {
    state.cursor = new Date();
    state.selected.clear();
    renderMonth();
  });
  $('#toggleBulk').addEventListener('click', () => {
    state.bulkMode = !state.bulkMode;
    state.selected.clear();
    renderMonth();
  });
  $('#toggleCal').addEventListener('click', () => {
    state.calendarEdit = !state.calendarEdit;
    renderMonth();
  });
  $('#copyPrev')?.addEventListener('click', copyPreviousWeek);
  $('#pickPeople')?.addEventListener('click', openPeoplePicker);
  bindRowDrag(main);
  $('#clearSel')?.addEventListener('click', () => { state.selected.clear(); renderMonth(); });

  // 单元格交互
  $$('.cell', main).forEach((cell) => {
    cell.addEventListener('click', async () => {
      const date = cell.dataset.date;
      const empId = Number(cell.dataset.emp);
      if (state.bulkMode) {
        const k = date + '|' + empId;
        if (state.selected.has(k)) state.selected.delete(k); else state.selected.add(k);
        cell.classList.toggle('sel');
        const c = $('#selCount');
        if (c) c.textContent = `已选 ${state.selected.size} 格`;
        return;
      }
      openShiftPicker(date, empId);
    });
  });

  // 批量应用
  const doBulk = async (clear) => {
    if (!state.selected.size) { toast('先选择格子', true); return; }
    const hours = clear ? 0 : Number($('#bulkHours', main)?.value);
    if (!clear && !(hours > 0)) { toast('工时需大于 0', true); return; }
    const groups = [...state.selected].map((k) => {
      const [date, emp] = k.split('|');
      return { date, employee_id: Number(emp) };
    });
    try {
      // 按日期分组批量提交
      const byDate = {};
      for (const g of groups) (byDate[g.date] = byDate[g.date] || []).push(g.employee_id);
      for (const [date, ids] of Object.entries(byDate)) {
        await api('/schedule/bulk', {
          method: 'POST',
          body: clear
            ? { action: 'clear', dates: [date], employee_ids: ids }
            : { action: 'set', dates: [date], employee_ids: ids, hours },
        });
      }
      toast(clear ? `已清除 ${groups.length} 格` : `已排班 ${groups.length} 格`);
      state.selected.clear();
      renderMonth();
    } catch (e) { toast(e.message, true); }
  };
  $('#bulkApply', main)?.addEventListener('click', () => doBulk(false));
  $('[data-bulk="__clear"]', main)?.addEventListener('click', () => doBulk(true));

  // 工作日历编辑
  if (state.calendarEdit) {
    $$('[data-cal-date]', main).forEach((th) => {
      th.style.cursor = 'pointer';
      th.addEventListener('click', async () => {
        const date = th.dataset.calDate;
        const cur = dayList.find((d) => d.date === date).isWork;
        try {
          await api('/calendar', { method: 'PUT', body: { date, is_workday: !cur } });
          renderMonth();
        } catch (e) { toast(e.message, true); }
      });
    });
  }
}

/**
 * 单元格编辑：安排时间段、工时与工作内容。
 * 同一天可以有多条（例如上午一班、晚上又顶一班）。
 */
function openShiftPicker(date, empId) {
  const emp = empById()[empId];
  const list = (state.schedule.assignments || [])
    .filter((a) => a.date === date && a.employee_id === empId)
    .sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  const d = parseISO(date);
  const isWork = state.calendar?.days?.find?.((x) => x.date === date)?.is_workday ?? true;
  const std = Number(state.settings.daily_hours) || 8;

  const slotRows = () => list.map((a) => `
    <div class="slot-row" data-slot-id="${a.id}">
      <div class="slot-times">
        <input class="input" type="time" data-slot-start value="${esc(a.start || '')}">
        <span class="dash">–</span>
        <input class="input" type="time" data-slot-end value="${esc(a.end || '')}">
      </div>
      <div class="slot-hours">
        <input class="input" type="number" step="0.5" min="0.5" data-slot-hours value="${fmtNum(a.hours)}">
        <span class="unit">小时</span>
      </div>
      <div class="slot-content-wrap">${contentPickerHtml(`slotc-${a.id}`, a.content || '', 'compact')}</div>
      <button class="icon-btn slot-del" data-slot-del title="删除这条" aria-label="删除">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>`).join('');

  const totalHours = () => list.reduce((s, a) => s + (Number(a.hours) || 0), 0);

  openModal({
    title: `${emp ? emp.name : ''} · ${date.slice(5)} ${weekdayCN(d)}`,
    sub: `${isWork ? '工作日' : '休息日（上班算加班）'} · 标准 ${fmtNum(std)} 小时`,
    wide: true,
    body: `
      <div id="slotList">${slotRows() || '<div class="person-empty">这天还没有排班</div>'}</div>
      <div class="slot-total" id="slotTotal">合计 <b>${fmtNum(totalHours())}</b> 小时</div>

      <div class="slot-add">
        <h4 style="font-size:13px;margin:18px 0 8px">新增一条</h4>
        <div class="slot-add-grid">
          <div class="field"><label>开始</label><input class="input" type="time" id="newStart" value="08:00"></div>
          <div class="field"><label>结束</label><input class="input" type="time" id="newEnd" value="16:00"></div>
          <div class="field"><label>工时</label><input class="input" type="number" step="0.5" min="0.5" id="newHours" value="8"></div>
          <div class="field slot-add-content"><label>工作内容</label>${contentPickerHtml('newContent', '')}</div>
        </div>
        <div class="hint-box" style="margin-top:10px">
          改了起止时间，工时会自动按时间差算；也可以直接手改工时（比如中间休息要扣掉）。
          <div style="margin-top:8px">
            常用时段：
            ${[['08:00', '16:00'], ['16:00', '24:00'], ['08:00', '12:00'], ['08:00', '20:00']].map(([s, e]) => {
              const h = hoursBetweenStr(s, e);
              return `<button class="btn sm ghost" data-quick="${s}-${e}">${s}-${e}（${fmtNum(h)}h）</button>`;
            }).join('')}
          </div>
        </div>
      </div>
    `,
    footer: `<button class="btn danger left" id="slotClear">清空这天</button>
      <button class="btn" data-close>关闭</button>
      <button class="btn primary" id="slotAdd">添加</button>`,
    onMount: (root, close) => {
      const startEl = $('#newStart', root), endEl = $('#newEnd', root), hoursEl = $('#newHours', root);
      const syncHours = () => {
        const h = hoursBetweenStr(startEl.value, endEl.value);
        if (h > 0) hoursEl.value = fmtNum(h);
      };
      startEl.addEventListener('change', syncHours);
      endEl.addEventListener('change', syncHours);

      // 快捷时段
      $$('[data-quick]', root).forEach((b) => b.addEventListener('click', () => {
        const [s, e] = b.dataset.quick.split('-');
        startEl.value = s; endEl.value = e; syncHours();
      }));

      // 编辑已有条目（失焦即保存）
      const bindSlot = (row) => {
        const id = Number(row.dataset.slotId);
        const save = async () => {
          const s = $('[data-slot-start]', row).value;
          const e = $('[data-slot-end]', row).value;
          const h = Number($('[data-slot-hours]', row).value);
          const content = ($('.content-input', row).value || '').trim();
          if (!(h > 0)) { toast('工时需大于 0', true); return; }
          try {
            await api(`/schedule/${id}`, { method: 'PUT', body: { start: s, end: e, hours: h, content } });
            const idx = list.findIndex((x) => x.id === id);
            if (idx >= 0) Object.assign(list[idx], { start: s, end: e, hours: h, content });
            $('#slotTotal', root).innerHTML = `合计 <b>${fmtNum(totalHours())}</b> 小时`;
            toast('已保存');
          } catch (err) { toast(err.message, true); }
        };
        $('[data-slot-start]', row).addEventListener('change', save);
        $('[data-slot-end]', row).addEventListener('change', save);
        $('[data-slot-hours]', row).addEventListener('change', save);
        bindContentPicker(row, `slotc-${id}`, () => save());
        $('[data-slot-del]', row).addEventListener('click', async () => {
          try {
            await api(`/schedule/${id}`, { method: 'DELETE' });
            const idx = list.findIndex((x) => x.id === id);
            if (idx >= 0) list.splice(idx, 1);
            row.remove();
            if (!list.length) $('#slotList', root).innerHTML = '<div class="person-empty">这天还没有排班</div>';
            $('#slotTotal', root).innerHTML = `合计 <b>${fmtNum(totalHours())}</b> 小时`;
            toast('已删除');
          } catch (err) { toast(err.message, true); }
        });
      };
      $$('.slot-row', root).forEach(bindSlot);

      $('#slotAdd', root).addEventListener('click', async () => {
        const s = startEl.value, e = endEl.value;
        const h = Number(hoursEl.value) || hoursBetweenStr(s, e);
        if (!(h > 0)) { toast('请填写工时或时间段', true); return; }
        try {
          const row = await api('/schedule', {
            method: 'POST',
            body: { date, employee_id: empId, start: s, end: e, hours: h, content: ($('#newContent', root)?.value || '').trim() },
          });
          list.push(row);
          const nc = $('#newContent', root);
          if (nc) nc.value = '';
          renderList();
          toast('已添加');
        } catch (err) { toast(err.message, true); }
      });

      $('#slotClear', root).addEventListener('click', async () => {
        if (!list.length) return;
        if (!confirm(`清空 ${date}「${emp ? emp.name : ''}」的全部排班？`)) return;
        try {
          await api(`/schedule?date=${date}&employee_id=${empId}`, { method: 'DELETE' });
          list.length = 0;
          renderList();
          toast('已清空');
        } catch (err) { toast(err.message, true); }
      });

      function renderList() {
        const wrap = $('#slotList', root);
        wrap.innerHTML = slotRows() || '<div class="person-empty">这天还没有排班</div>';
        $$('.slot-row', root).forEach(bindSlot);
        $('#slotTotal', root).innerHTML = `合计 <b>${fmtNum(totalHours())}</b> 小时`;
      }

      // 「新增一条」里的工作内容选择器
      bindContentPicker(root, 'newContent');

      // 关闭后刷新当前所在的页面（月排班 / 今日 / …），不要一律跳回月排班
      const refreshAfterClose = () => setTimeout(() => renderCurrentView(), 0);
      $('.modal-foot [data-close]', root)?.addEventListener('click', refreshAfterClose);
      $('.modal-head [data-close]', root)?.addEventListener('click', refreshAfterClose);
    },
    });
}

/** "08:00" + "16:00" → 小时数（跨夜自动 +24） */
function hoursBetweenStr(start, end) {
  const m = (v) => {
    const r = /^(\d{1,2}):(\d{2})$/.exec(String(v || ''));
    return r ? +r[1] * 60 + +r[2] : null;
  };
  const a = m(start), b = m(end);
  if (a === null || b === null) return 0;
  let mins = b - a;
  if (mins <= 0) mins += 24 * 60;
  return Math.round(mins / 60 * 100) / 100;
}

/* ------------------------------------------------------------ 人员显示与排序 */

/** 人员选择弹窗：勾选显示/隐藏，拖动或用上下按钮调整顺序 */
function openPeoplePicker() {
  const all = state.employees.slice();
  const draft = {
    hidden: new Set(all.filter((e) => e.hidden).map((e) => e.id)),
    order: all.map((e) => e.id),
  };

  const renderList = () => {
    const byId = Object.fromEntries(all.map((e) => [e.id, e]));
    return draft.order.map((id, i) => {
      const e = byId[id];
      const hidden = draft.hidden.has(id);
      return `
        <div class="pp-row ${hidden ? 'is-hidden' : ''}" draggable="true" data-pp-id="${id}">
          <span class="pp-grip" aria-hidden="true">⠿</span>
          <label class="pp-check">
            <input type="checkbox" data-pp-toggle="${id}" ${hidden ? '' : 'checked'}>
            <span>${esc(e.name)}</span>
          </label>
          ${e.team ? `<span class="pp-team">${esc(e.team)}</span>` : ''}
          <span class="pp-actions">
            <button class="icon-btn pp-up" data-pp-up="${i}" title="上移" ${i === 0 ? 'disabled' : ''} aria-label="上移">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>
            </button>
            <button class="icon-btn pp-down" data-pp-down="${i}" title="下移" ${i === draft.order.length - 1 ? 'disabled' : ''} aria-label="下移">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </button>
          </span>
        </div>`;
    }).join('');
  };

  const m = openModal({
    title: '人员显示与顺序',
    sub: '取消勾选可隐藏已离职人员；拖动 ⠿ 或用箭头调整顺序',
    body: `
      <div class="pp-toolbar">
        <button class="btn sm ghost" id="ppAll">全部显示</button>
        <button class="btn sm ghost" id="ppNone">全部隐藏</button>
        <span class="pp-count" id="ppCount"></span>
      </div>
      <div class="pp-list" id="ppList">${renderList()}</div>
      <div class="hint-box" style="margin-top:14px">
        隐藏只是不显示，排班记录仍然保留，随时可以重新勾选显示。
      </div>`,
    footer: `<span class="left" style="font-size:12.5px;color:var(--text-muted)">顺序对所有视图生效</span>
             <button class="btn" data-close>取消</button>
             <button class="btn primary" id="ppSave">保存</button>`,
    onMount: (root, close) => {
      const listEl = $('#ppList', root);
      const countEl = $('#ppCount', root);

      const refreshCount = () => {
        const visible = draft.order.length - draft.hidden.size;
        countEl.textContent = `显示 ${visible} / ${draft.order.length}`;
      };

      const rerender = () => {
        listEl.innerHTML = renderList();
        bindListEvents();
        refreshCount();
      };

      const move = (from, to) => {
        if (to < 0 || to >= draft.order.length) return;
        const [id] = draft.order.splice(from, 1);
        draft.order.splice(to, 0, id);
        rerender();
      };

      function bindListEvents() {
        $$('[data-pp-toggle]', listEl).forEach((cb) => {
          cb.addEventListener('change', () => {
            const id = Number(cb.dataset.ppToggle);
            if (cb.checked) draft.hidden.delete(id); else draft.hidden.add(id);
            const row = cb.closest('.pp-row');
            if (row) row.classList.toggle('is-hidden', !cb.checked);
            refreshCount();
          });
        });
        $$('[data-pp-up]', listEl).forEach((b) => b.addEventListener('click', () => {
          move(Number(b.dataset.ppUp), Number(b.dataset.ppUp) - 1);
        }));
        $$('[data-pp-down]', listEl).forEach((b) => b.addEventListener('click', () => {
          move(Number(b.dataset.ppDown), Number(b.dataset.ppDown) + 1);
        }));
        bindPeopleDrag(listEl, draft, rerender);
      }

      $('#ppAll', root).addEventListener('click', () => { draft.hidden.clear(); rerender(); });
      $('#ppNone', root).addEventListener('click', () => {
        draft.order.forEach((id) => draft.hidden.add(id));
        rerender();
      });
      $('#ppSave', root).addEventListener('click', async () => {
        try {
          await savePeoplePrefs(draft.order, draft.hidden);
          close();
          toast('已保存');
          renderMonth();
        } catch (e) { toast(e.message, true); }
      });

      bindListEvents();
      refreshCount();
    },
  });
  return m;
}

/** 保存隐藏名单与排序 */
async function savePeoplePrefs(order, hiddenSet) {
  await api('/settings', {
    method: 'PUT',
    body: { hidden_employee_ids: [...hiddenSet].join(',') },
  });
  // 按拖动结果重写 sort_order
  await Promise.all(order.map((id, i) => api(`/employees/${id}`, {
    method: 'PUT', body: { sort_order: i * 10 },
  })));
  await loadBootstrap();
}

/** 弹窗内拖动排序（HTML5 drag） */
function bindPeopleDrag(listEl, draft, rerender) {
  let from = null;
  $$('.pp-row', listEl).forEach((row) => {
    row.addEventListener('dragstart', (e) => {
      from = Number(row.dataset.ppId);
      row.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(from));
      }
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      from = null;
      $$('.pp-row', listEl).forEach((r) => r.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const toId = Number(row.dataset.ppId);
      if (from === null || from === toId) return;
      const fromIdx = draft.order.indexOf(from);
      const toIdx = draft.order.indexOf(toId);
      if (fromIdx < 0 || toIdx < 0) return;
      draft.order.splice(fromIdx, 1);
      draft.order.splice(toIdx, 0, from);
      rerender();
    });
  });
}

/** 月排班表格内拖动姓名行调整顺序（触屏用长按） */
function bindRowDrag(main) {
  const rows = $$('tr[data-emp-row]', main);
  if (!rows.length) return;
  let dragId = null;

  rows.forEach((tr) => {
    const grip = $('.row-grip', tr);
    if (!grip) return;

    // 只在按住手柄时允许拖动，避免误触排班格
    grip.addEventListener('mousedown', () => { tr.draggable = true; });
    grip.addEventListener('touchstart', () => { tr.draggable = true; }, { passive: true });
    tr.addEventListener('dragend', () => {
      tr.draggable = false;
      tr.classList.remove('dragging');
      rows.forEach((r) => r.classList.remove('drag-over'));
      dragId = null;
    });
    tr.addEventListener('dragstart', (e) => {
      dragId = Number(tr.dataset.empRow);
      tr.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(dragId));
      }
    });
    tr.addEventListener('dragover', (e) => {
      if (dragId === null) return;
      e.preventDefault();
      tr.classList.add('drag-over');
    });
    tr.addEventListener('dragleave', () => tr.classList.remove('drag-over'));
    tr.addEventListener('drop', async (e) => {
      e.preventDefault();
      tr.classList.remove('drag-over');
      const targetId = Number(tr.dataset.empRow);
      if (dragId === null || dragId === targetId) return;
      const order = rows.map((r) => Number(r.dataset.empRow));
      const fromIdx = order.indexOf(dragId);
      const toIdx = order.indexOf(targetId);
      if (fromIdx < 0 || toIdx < 0) return;
      order.splice(fromIdx, 1);
      order.splice(toIdx, 0, dragId);
      try {
        await Promise.all(order.map((id, i) => api(`/employees/${id}`, {
          method: 'PUT', body: { sort_order: i * 10 },
        })));
        await loadBootstrap();
        renderMonth();
      } catch (err) { toast(err.message, true); }
    });
  });
}

async function copyPreviousWeek() {
  // 把上月最后一周 / 本月的上一周排班复制到本周
  const year = state.cursor.getFullYear();
  const month = state.cursor.getMonth();
  openModal({
    title: '复制排班',
    sub: '从一段日期复制到另一段',
    body: `
      <div class="form-grid">
        <div class="field"><label>源开始</label><input class="input" type="date" id="cpFrom" value="${iso(addDays(parseISO(monthRange(year, month).from), -7))}"></div>
        <div class="field"><label>源结束</label><input class="input" type="date" id="cpTo" value="${iso(addDays(parseISO(monthRange(year, month).from), -1))}"></div>
        <div class="field"><label>目标开始</label><input class="input" type="date" id="cpToFrom" value="${monthRange(year, month).from}"></div>
        <div class="field"><label>目标结束</label><input class="input" type="date" id="cpToTo" value="${monthRange(year, month).to}"></div>
      </div>
      <div class="hint-box" style="margin-top:14px">
        目标区间内同一人的已有排班将被覆盖。按「源第 N 天 → 目标第 N 天」逐日对应复制。
      </div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn primary" id="cpGo">开始复制</button>`,
    onMount: (root, close) => {
      $('#cpGo', root).addEventListener('click', async () => {
        const srcFrom = parseISO($('#cpFrom', root).value);
        const srcTo = parseISO($('#cpTo', root).value);
        const dstFrom = parseISO($('#cpToFrom', root).value);
        const dstTo = parseISO($('#cpToTo', root).value);
        const srcN = Math.round((srcTo - srcFrom) / 86400000) + 1;
        const dstN = Math.round((dstTo - dstFrom) / 86400000) + 1;
        const n = Math.min(srcN, dstN);
        if (n <= 0) { toast('日期范围不正确', true); return; }
        try {
          const src = await api(`/schedule?date_from=${iso(srcFrom)}&date_to=${iso(srcTo)}`);
          const map = {};
          for (const a of src.assignments) {
            const offset = Math.round((parseISO(a.date) - srcFrom) / 86400000);
            if (offset < 0 || offset >= n) continue;
            const target = iso(addDays(dstFrom, offset));
            (map[target] = map[target] || []).push(a);
          }
          let count = 0;
          for (const [date, items] of Object.entries(map)) {
            const ids = [...new Set(items.map((a) => a.employee_id))];
            // 先清空目标日这些人的班次，再写入
            await api('/schedule/bulk', { method: 'POST', body: { action: 'clear', dates: [date], employee_ids: ids } });
            for (const a of items) {
              await api('/schedule', {
                method: 'POST',
                body: {
                  date, employee_id: a.employee_id,
                  start: a.start, end: a.end, hours: a.hours, content: a.content,
                  source: 'copy',
                },
              });
              count++;
            }
          }
          close();
          toast(`已复制 ${count} 条排班`);
          renderMonth();
        } catch (e) { toast(e.message, true); }
      });
    },
  });
}

/* ------------------------------------------------------------ 视图：今日 */
async function renderDay() {
  const main = $('#main');
  if (!state.employees.length) {
    main.innerHTML = emptyStateHtml();
    bindEmptyState();
    return;
  }
  await loadDay();
  const target = iso(state.dayCursor);
  const d = parseISO(target);
  const isToday = target === todayISO();
  const dayCol = state.calendar?.days?.find?.((x) => x.date === target);
  const isRest = dayCol ? dayCol.is_workday === false : false;
  const assigns = state.schedule.assignments
    .filter((a) => a.date === target)
    .sort((a, b) => (a.start || '99').localeCompare(b.start || '99'));
  const stats = state.dayStats;
  const totalHours = dayHours(assigns);
  const peopleCount = new Set(assigns.map((a) => a.employee_id)).size;
  const orgName = state.settings.org_name || '排班管理';
  // 按时间段分组（没有起止时间的归到「时间待定」）
  const groups = groupBySlot(assigns);
  const assignedEmpIds = new Set(assigns.map((a) => a.employee_id));
  const leaves = state.dayLeaves || [];
  const leaveOf = {};   // empId -> 'rest' | 'leave'
  for (const lv of leaves) leaveOf[lv.employee_id] = lv.kind;
  // 没排班的人默认算调休，标了请假的单独列出
  const onLeave = state.employees.filter((e) => !assignedEmpIds.has(e.id) && leaveOf[e.id] === 'leave');
  const restOff = state.employees.filter((e) => !assignedEmpIds.has(e.id) && leaveOf[e.id] !== 'leave');

  main.innerHTML = `
    <div class="range-bar no-print" style="justify-content:space-between">
      <div class="month-nav">
        <button class="icon-btn" id="prevDay" aria-label="前一天">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <span class="label" style="min-width:150px">${target.slice(5)} ${weekdayCN(d)}</span>
        <button class="icon-btn" id="nextDay" aria-label="后一天">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
        </button>
        <button class="btn sm ghost" id="todayBtn">回到今天</button>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span class="chip no-print">出勤 <b style="margin-left:4px">${peopleCount}</b> 人</span>
        <span class="chip no-print">合计 <b style="margin-left:4px">${fmtNum(totalHours)}</b> 小时</span>
        <button class="btn sm" id="exportDayImg" title="生成图片，可直接发到群里">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="margin-right:2px"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
          导出图片
        </button>
        <button class="btn sm primary" id="addShiftBtn">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="margin-right:2px"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/></svg>
          批量排班
        </button>
      </div>
    </div>

    <!-- 可截图的排班看板 -->
    <div class="card day-sheet" id="daySheet">
      <div class="sheet-head">
        <div class="sheet-title-row">
          <div>
            <div class="sheet-org">${esc(orgName)}</div>
            <div class="sheet-title">${monthDayCN(d)}<span class="sheet-week">${weekdayCN(d)}</span></div>
          </div>
          ${isRest ? '<span class="sheet-badge">休息日</span>' : ''}
        </div>
        <div class="sheet-meta">
          <span>出勤 <b>${peopleCount}</b> 人</span>
          <span>合计 <b>${fmtNum(totalHours)}</b> 小时</span>
          <span>共 <b>${groups.length}</b> 个时段</span>
        </div>
      </div>

      <div class="sheet-body">
        ${groups.length ? groups.map((g) => `
          <div class="slot-group">
            <div class="slot-group-head">
              <span class="slot-group-time">${g.start && g.end ? `${g.start} – ${g.end}` : '时间待定'}</span>
              <span class="slot-group-sub">
                ${g.start && g.end ? `${fmtNum(g.hours)} 小时` : ''}
                <span class="slot-group-count">${g.items.length} 人</span>
              </span>
            </div>
            <div class="slot-group-people">
              ${g.items.map((a) => {
                const e = empById()[a.employee_id] || { name: a.name };
                return `<div class="slot-person" data-sheet-emp="${a.employee_id}" title="点击编辑">
                  <span class="slot-person-name">${esc(e.name)}</span>
                  ${a.content ? `<span class="slot-person-work">${esc(a.content)}</span>` : '<span class="slot-person-work muted">—</span>'}
                </div>`;
              }).join('')}
            </div>
          </div>`).join('') : `
          <div class="sheet-empty">
            <div class="sheet-empty-icon">☕</div>
            <div>这天还没有排班</div>
          </div>`}
      </div>

      ${(restOff.length || onLeave.length) && assigns.length ? `
        ${restOff.length ? `
        <div class="sheet-rest">
          <span class="sheet-rest-label">调休</span>
          <span class="sheet-rest-names">${restOff.map((e) => `<span class="rest-name" data-rest-emp="${e.id}" title="点击改为请假">${esc(e.name)}</span>`).join('、')}</span>
        </div>` : ''}
        ${onLeave.length ? `
        <div class="sheet-rest">
          <span class="sheet-rest-label leave">请假</span>
          <span class="sheet-rest-names">${onLeave.map((e) => `<span class="rest-name" data-rest-emp="${e.id}" title="点击改回调休">${esc(e.name)}</span>`).join('、')}</span>
        </div>` : ''}` : ''}

      <div class="sheet-foot">
        <span>${esc(orgName)}</span>
        <span>${target}</span>
      </div>
    </div>

    <!-- 出勤核对（仅屏幕显示） -->
    <div class="card no-print">
      <div class="card-head">
        <h2>出勤核对</h2>
        <span class="sub">相对应出勤的实时差额（单位：小时）</span>
        <div class="spacer"></div>
        <button class="btn sm ghost" id="toggleCheck" aria-pressed="${state.showCheck}">${state.showCheck ? '收起' : '展开'}</button>
      </div>
      ${state.showCheck ? `
      <div class="card-body">
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>姓名</th><th>今日时间段</th><th class="num">今日工时</th><th class="num">当月加班</th><th class="num">当月欠班</th></tr></thead>
            <tbody>
              ${state.employees.map((e) => {
                const mine = assigns.filter((a) => a.employee_id === e.id);
                const st = (stats?.employees || []).find((s) => s.employee_id === e.id) || {};
                return `<tr>
                  <td><div class="name-cell"><span class="avatar">${esc(initials(e.name))}</span><span>${esc(e.name)}</span></div></td>
                  <td>${mine.length
                    ? mine.map((a) => `<span class="slot-tag" title="${esc(slotTitle(a))}">${esc(a.start && a.end ? `${a.start}-${a.end}` : fmtNum(a.hours) + 'h')}</span>`).join(' ')
                    : '<span class="num-zero">休息</span>'}</td>
                  <td class="num">${fmtNum(dayHours(mine))}</td>
                  <td class="num ${st.overtime > 0 ? 'num-pos' : 'num-zero'}">${st.overtime > 0 ? '+' + fmtNum(st.overtime) : '0'}</td>
                  <td class="num ${st.owe > 0 ? 'num-neg' : 'num-zero'}">${st.owe > 0 ? '−' + fmtNum(st.owe) : '0'}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>` : ''}
    </div>
  `;

  $('#prevDay').addEventListener('click', () => { state.dayCursor = addDays(state.dayCursor, -1); renderDay(); });
  $('#nextDay').addEventListener('click', () => { state.dayCursor = addDays(state.dayCursor, 1); renderDay(); });
  $('#todayBtn').addEventListener('click', () => { state.dayCursor = new Date(); renderDay(); });
  $('#addShiftBtn').addEventListener('click', () => openAddPersonToDay(target));
  $('#toggleCheck')?.addEventListener('click', () => {
    state.showCheck = !state.showCheck;
    renderDay();
  });
  $('#exportDayImg')?.addEventListener('click', () => exportDayImage(target));
  // 看板里点某个人 → 直接编辑那条
  $$('[data-sheet-emp]').forEach((el) => el.addEventListener('click', () => {
    openShiftPicker(target, Number(el.dataset.sheetEmp));
  }));
  // 点调休/请假的人名 → 切换状态
  $$('[data-rest-emp]').forEach((el) => el.addEventListener('click', () => {
    toggleLeave(target, Number(el.dataset.restEmp));
  }));
}

/** 切换某天的调休 / 请假 */
async function toggleLeave(date, empId) {
  const cur = (state.dayLeaves || []).find((l) => l.employee_id === empId);
  const next = (cur && cur.kind === 'leave') ? 'rest' : 'leave';
  try {
    await api('/leaves', { method: 'POST', body: { date, employee_id: empId, kind: next } });
    toast(next === 'leave' ? '已标为请假（不计欠班）' : '已改回调休');
    renderDay();
  } catch (e) { toast(e.message, true); }
}

/** 把当天排班按时段分组，用于看板展示 */
function groupBySlot(assigns) {
  const map = new Map();
  for (const a of assigns) {
    const key = `${a.start || ''}|${a.end || ''}`;
    if (!map.has(key)) {
      map.set(key, { start: a.start || '', end: a.end || '', hours: Number(a.hours) || 0, items: [] });
    }
    map.get(key).items.push(a);
  }
  const groups = [...map.values()];
  groups.sort((a, b) => {
    if (!a.start && b.start) return 1;
    if (a.start && !b.start) return -1;
    return (a.start || '').localeCompare(b.start || '');
  });
  // 同组工时取众数（同一时段的人通常相同）
  for (const g of groups) {
    const counts = {};
    for (const it of g.items) counts[it.hours] = (counts[it.hours] || 0) + 1;
    let best = g.hours, n = 0;
    for (const [h, c] of Object.entries(counts)) {
      if (c > n) { n = c; best = Number(h); }
    }
    g.hours = best;
  }
  return groups;
}

/** 2026-11-03 → 11月3日 */
function monthDayCN(d) {
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/* ------------------------------------------------------------ 导出排班图片
   Chrome 不允许把含 foreignObject 的 SVG 画进 canvas（canvas 会被污染），
   所以这里直接在 canvas 上绘制，输出 2 倍清晰度的 PNG。
*/
const IMG_FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 文字按宽度折行 */
function wrapText(ctx, text, maxWidth) {
  const out = [];
  let line = '';
  for (const ch of String(text)) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      out.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/**
 * 把当天排班画成一张适合发群的图片
 * @returns {HTMLCanvasElement}
 */
function drawDaySheetCanvas(target, d, assigns, groups, restOff, onLeave, orgName, isRest) {
  const W = 900;
  const PAD = 40;
  const INNER = W - PAD * 2;
  const scale = 2;

  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = (weight, size) => `${weight} ${size}px ${IMG_FONT}`;

  // ---- 先量高度（用临时 canvas 测量）
  let y = 0;
  const peopleCols = 2;
  const cardGap = 12;
  const cardH = 54;
  const cardW = (INNER - cardGap * (peopleCols - 1)) / peopleCols;

  const headerH = 118;
  let bodyH = 0;
  for (const g of groups) {
    bodyH += 34;                                   // 时段标题行
    bodyH += Math.ceil(g.items.length / peopleCols) * (cardH + cardGap) + 6;
    bodyH += 18;                                   // 组分隔间距
  }
  if (!groups.length) bodyH = 96;

  // 调休 / 请假名单折行
  ctx.font = font(500, 17);
  const measure = (list) => (list.length && assigns.length)
    ? wrapText(ctx, list.map((e) => e.name).join('、'), INNER - 90) : [];
  const restLines = measure(restOff);
  const leaveLines = measure(onLeave);
  const lineH = 26;
  const restH = (restLines.length ? (40 + restLines.length * lineH) : 0)
              + (leaveLines.length ? (40 + leaveLines.length * lineH) : 0);

  const footerH = 40;
  const H = PAD + headerH + bodyH + restH + footerH + 24;

  c.width = W * scale;
  c.height = H * scale;
  ctx.scale(scale, scale);

  // 背景
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // 外框
  ctx.strokeStyle = '#e4e3dd';
  ctx.lineWidth = 1;
  roundRectPath(ctx, 12, 12, W - 24, H - 24, 14);
  ctx.stroke();

  y = PAD;

  // ---- 头部
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#7a7873';
  ctx.font = font(500, 12.5);
  ctx.fillText(orgName, PAD, y + 4);

  // 日期
  const title = monthDayCN(d);
  ctx.fillStyle = '#1a1a19';
  ctx.font = font(700, 32);
  ctx.fillText(title, PAD, y + 40);
  const titleW = ctx.measureText(title).width;
  ctx.fillStyle = '#6b6b66';
  ctx.font = font(500, 16);
  ctx.fillText(weekdayCN(d), PAD + titleW + 12, y + 38);

  // 休息日徽标
  if (isRest) {
    ctx.font = font(600, 12);
    const bw = ctx.measureText('休息日').width + 22;
    ctx.fillStyle = '#f0efea';
    roundRectPath(ctx, W - PAD - bw, y + 14, bw, 26, 13);
    ctx.fill();
    ctx.fillStyle = '#6b6b66';
    ctx.fillText('休息日', W - PAD - bw + 11, y + 31);
  }

  // meta
  const peopleCount = new Set(assigns.map((a) => a.employee_id)).size;
  const totalHours = dayHours(assigns);
  let mx = PAD;
  const my = y + 74;
  const meta = [
    ['出勤 ', String(peopleCount), ' 人'],
    ['合计 ', fmtNum(totalHours), ' 小时'],
    ['共 ', String(groups.length), ' 个时段'],
  ];
  for (const [pre, val, post] of meta) {
    ctx.font = font(400, 13.5);
    ctx.fillStyle = '#6b6b66';
    ctx.fillText(pre, mx, my);
    mx += ctx.measureText(pre).width;
    ctx.font = font(700, 17);
    ctx.fillStyle = '#1a1a19';
    ctx.fillText(val, mx, my);
    mx += ctx.measureText(val).width;
    ctx.font = font(400, 13.5);
    ctx.fillStyle = '#6b6b66';
    ctx.fillText(post, mx, my);
    mx += ctx.measureText(post).width + 26;
  }

  // 分隔线
  y += headerH;
  ctx.strokeStyle = '#e9e8e2';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, y);
  ctx.lineTo(W - PAD, y);
  ctx.stroke();

  // ---- 各时段
  y += 12;
  if (!groups.length) {
    ctx.fillStyle = '#9a9893';
    ctx.font = font(400, 15);
    const t = '这天还没有排班';
    ctx.fillText(t, (W - ctx.measureText(t).width) / 2, y + 48);
    y += 96;
  }

  for (const g of groups) {
    // 时段标题
    const timeText = g.start && g.end ? `${g.start} – ${g.end}` : '时间待定';
    ctx.fillStyle = '#1a1a19';
    ctx.font = font(700, 21);
    ctx.fillText(timeText, PAD, y + 22);
    const tw = ctx.measureText(timeText).width;

    ctx.fillStyle = '#8a8883';
    ctx.font = font(400, 13);
    if (g.start && g.end) ctx.fillText(`${fmtNum(g.hours)} 小时`, PAD + tw + 14, y + 21);

    // 人数徽标（右侧）
    const badge = `${g.items.length} 人`;
    ctx.font = font(600, 12.5);
    const bw = ctx.measureText(badge).width + 24;
    ctx.fillStyle = '#e8f0fc';
    roundRectPath(ctx, W - PAD - bw, y + 2, bw, 26, 13);
    ctx.fill();
    ctx.fillStyle = '#2a6fd0';
    ctx.fillText(badge, W - PAD - bw + 12, y + 20);

    y += 34;
    // 人员卡片
    g.items.forEach((a, idx) => {
      const col = idx % peopleCols;
      const row = Math.floor(idx / peopleCols);
      const x = PAD + col * (cardW + cardGap);
      const cy = y + row * (cardH + cardGap);

      ctx.fillStyle = '#f5f4f0';
      roundRectPath(ctx, x, cy, cardW, cardH, 9);
      ctx.fill();

      const e = empById()[a.employee_id] || { name: a.name };

      // 姓名
      ctx.fillStyle = '#1a1a19';
      ctx.font = font(700, 19);
      const pad = 16;
      const nameW = ctx.measureText(e.name).width;
      ctx.fillText(e.name, x + pad, cy + cardH / 2 + 7);

      // 工作内容（靠右，大字；超长才省略）
      const work = a.content || '';
      if (work) {
        ctx.font = font(600, 17);
        const avail = cardW - pad * 2 - nameW - 14;
        let txt = work;
        if (ctx.measureText(txt).width > avail) {
          while (txt.length && ctx.measureText(txt + '…').width > avail) txt = txt.slice(0, -1);
          txt += '…';
        }
        ctx.fillStyle = '#3a3a37';
        ctx.fillText(txt, x + cardW - pad - ctx.measureText(txt).width, cy + cardH / 2 + 6);
      }
    });
    y += Math.ceil(g.items.length / peopleCols) * (cardH + cardGap) + 6;

    // 组间虚线
    if (g !== groups[groups.length - 1]) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#e4e3dd';
      ctx.beginPath();
      ctx.moveTo(PAD, y + 4);
      ctx.lineTo(W - PAD, y + 4);
      ctx.stroke();
      ctx.restore();
    }
    y += 18;
  }

  // ---- 调休 / 请假名单
  const drawNameBlock = (label, lines, labelBg, labelFg) => {
    if (!lines.length) return;
    ctx.strokeStyle = '#ecebe5';
    ctx.beginPath();
    ctx.moveTo(PAD, y);
    ctx.lineTo(W - PAD, y);
    ctx.stroke();
    y += 22;

    ctx.fillStyle = labelBg;
    ctx.font = font(700, 15);
    const lw = ctx.measureText(label).width + 26;
    roundRectPath(ctx, PAD, y, lw, 30, 15);
    ctx.fill();
    ctx.fillStyle = labelFg;
    ctx.fillText(label, PAD + 13, y + 21);

    ctx.font = font(500, 17);
    ctx.fillStyle = '#52514e';
    lines.forEach((ln, i) => {
      ctx.fillText(ln, PAD + 78, y + 21 + i * lineH);
    });
    y += lines.length * lineH + 10;
  };
  drawNameBlock('调休', restLines, '#f0efea', '#6b6b66');
  drawNameBlock('请假', leaveLines, '#fdf0e4', '#b4701e');

  // ---- 页脚
  const fy = H - 40;
  ctx.strokeStyle = '#ecebe5';
  ctx.beginPath();
  ctx.moveTo(PAD, fy);
  ctx.lineTo(W - PAD, fy);
  ctx.stroke();
  ctx.fillStyle = '#a3a19b';
  ctx.font = font(400, 11.5);
  ctx.fillText(orgName, PAD, fy + 18);
  ctx.fillText(target, W - PAD - ctx.measureText(target).width, fy + 18);

  return c;
}

/** 导出当天排班看板为 PNG，可直接发到群里 */
async function exportDayImage(date) {
  const target = date;
  const d = parseISO(target);
  const assigns = (state.schedule?.assignments || [])
    .filter((a) => a.date === target)
    .sort((a, b) => (a.start || '99').localeCompare(b.start || '99'));
  const groups = groupBySlot(assigns);
  const assignedIds = new Set(assigns.map((a) => a.employee_id));
  const leaves = await api(`/leaves?date_from=${target}&date_to=${target}`).catch(() => []);
  const leaveIds = new Set(leaves.filter((l) => l.kind === 'leave').map((l) => l.employee_id));
  const restOff = state.employees.filter((e) => !assignedIds.has(e.id) && !leaveIds.has(e.id));
  const onLeave = state.employees.filter((e) => !assignedIds.has(e.id) && leaveIds.has(e.id));
  const dayCol = state.calendar?.days?.find?.((x) => x.date === target);
  const isRest = dayCol ? dayCol.is_workday === false : false;
  const orgName = state.settings.org_name || '排班管理';

  try {
    const canvas = drawDaySheetCanvas(target, d, assigns, groups, restOff, onLeave, orgName, isRest);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('无法生成图片');
    downloadBlob(blob, `排班-${target}.png`, 'image/png');
    toast('图片已生成，可直接发到群里（手机在「文件/下载」里）');
  } catch (e) {
    toast('图片导出失败：' + e.message, true);
  }
}

/**
 * 批量排班：一次选择多人，统一设置时段 / 工时 / 工作内容；
 * 也可以给选中的人单独指定不同的工作内容。
 */
function openAddPersonToDay(date) {
  const d = parseISO(date);
  const isWork = state.calendar?.days?.find?.((x) => x.date === date)?.is_workday ?? true;
  const std = Number(state.settings.daily_hours) || 8;
  const existing = (state.schedule.assignments || []).filter((a) => a.date === date);
  const assignedIds = new Set(existing.map((a) => a.employee_id));
  const hidden = new Set(state.employees.filter((e) => e.hidden).map((e) => e.id));
  const people = state.employees.filter((e) => !hidden.has(e.id));

  // 预选：当天还没有排班的人
  const picked = new Set(people.filter((e) => !assignedIds.has(e.id)).map((e) => e.id));
  // 每人单独填写的工作内容
  const batchOwn = {};

  openModal({
    title: '批量排班',
    sub: `${date} ${weekdayCN(d)} · ${isWork ? '工作日' : '休息日（上班算加班）'}`,
    wide: true,
    body: `
      <h4 class="batch-h">1. 选择人员</h4>
      <div class="pp-toolbar" style="margin-bottom:8px">
        <button class="btn sm ghost" id="batchAll">全选</button>
        <button class="btn sm ghost" id="batchNone">全不选</button>
        <button class="btn sm ghost" id="batchUnassigned">只选还没排的</button>
        <span class="pp-count" id="batchCount"></span>
      </div>
      <div class="batch-people" id="batchPeople">
        ${people.map((e) => `
          <label class="batch-person${assignedIds.has(e.id) ? ' has-slot' : ''}">
            <input type="checkbox" data-batch-check="${e.id}" ${picked.has(e.id) ? 'checked' : ''}>
            <span class="bp-name">${esc(e.name)}</span>
            ${assignedIds.has(e.id) ? '<span class="bp-flag">已有</span>' : ''}
          </label>`).join('')}
      </div>

      <h4 class="batch-h" style="margin-top:18px">2. 时段与工作内容</h4>
      <div class="slot-add-grid">
        <div class="field"><label>开始</label><input class="input" type="time" id="batchStart" value="08:00"></div>
        <div class="field"><label>结束</label><input class="input" type="time" id="batchEnd" value="16:00"></div>
        <div class="field"><label>工时</label><input class="input" type="number" step="0.5" min="0.5" id="batchHours" value="${fmtNum(std)}"></div>
        <div class="field slot-add-content"><label>工作内容</label>${contentPickerHtml('batchContent', '')}</div>
      </div>
      <div class="hint-box" style="margin-top:10px">
        <div>常用时段：
          ${[['08:00', '16:00'], ['16:00', '24:00'], ['08:00', '12:00'], ['08:00', '20:00']].map(([st, en]) => {
            const h = hoursBetweenStr(st, en);
            return `<button class="btn sm ghost" data-batch-quick="${st}-${en}">${st}-${en}（${fmtNum(h)}h）</button>`;
          }).join('')}
        </div>
        <label class="switch" style="margin-top:8px">
          <input type="checkbox" id="batchReplace" checked> 覆盖当天已有排班（同一个人先清空再写入）
        </label>
      </div>

      <div class="batch-extra" id="batchExtra"></div>
    `,
    footer: `<button class="btn left" id="batchRestOff" title="选中的人标为调休">标记调休</button>
      <button class="btn left" id="batchLeave" title="选中的人标为请假（不计欠班）">标记请假</button>
      <button class="btn" data-close>取消</button>
      <button class="btn primary" id="batchApply">排班</button>`,
    onMount: (root, close) => {
      const startEl = $('#batchStart', root), endEl = $('#batchEnd', root), hoursEl = $('#batchHours', root);
      const syncHours = () => {
        const h = hoursBetweenStr(startEl.value, endEl.value);
        if (h > 0) hoursEl.value = fmtNum(h);
      };
      startEl.addEventListener('change', syncHours);
      endEl.addEventListener('change', syncHours);
      $$('[data-batch-quick]', root).forEach((b) => b.addEventListener('click', () => {
        const [st, en] = b.dataset.batchQuick.split('-');
        startEl.value = st; endEl.value = en; syncHours();
      }));

      bindContentPicker(root, 'batchContent');

      const checks = () => $$('[data-batch-check]', root);
      const selectedIds = () => checks().filter((c) => c.checked).map((c) => Number(c.dataset.batchCheck));
      const byId = empById();

      // 「分别指定」区域：给已选的人单独填工作内容
      function renderExtra() {
        const ids = selectedIds();
        const box = $('#batchExtra', root);
        if (!box) return;
        if (!ids.length) { box.innerHTML = ''; return; }
        box.innerHTML = `
          <h4 class="batch-h" style="margin-top:18px">3. 分别指定（可留空，用上面的统一内容）</h4>
          <div class="batch-extra-list">
            ${ids.map((id) => `
              <div class="batch-extra-row">
                <span class="be-name">${esc(byId[id]?.name || '')}</span>
                <input class="input be-content" data-batch-own="${id}" placeholder="留空 = 用统一内容"
                       list="contentOptionsList" value="${esc(batchOwn[id] || '')}">
              </div>`).join('')}
          </div>
          <datalist id="contentOptionsList">
            ${contentOptions().map((c) => `<option value="${esc(c)}"></option>`).join('')}
          </datalist>`;
        $$('[data-batch-own]', box).forEach((inp) => {
          inp.addEventListener('input', () => { batchOwn[Number(inp.dataset.batchOwn)] = inp.value; });
        });
      }

      const refreshCount = () => {
        const all = checks();
        const n = all.filter((c) => c.checked).length;
        const el = $('#batchCount', root);
        if (el) el.textContent = `已选 ${n} / ${all.length} 人`;
        renderExtra();
      };

      $('#batchAll', root).addEventListener('click', () => {
        checks().forEach((c) => { c.checked = true; }); refreshCount();
      });
      $('#batchNone', root).addEventListener('click', () => {
        checks().forEach((c) => { c.checked = false; }); refreshCount();
      });
      $('#batchUnassigned', root).addEventListener('click', () => {
        checks().forEach((c) => { c.checked = !assignedIds.has(Number(c.dataset.batchCheck)); });
        refreshCount();
      });
      checks().forEach((c) => c.addEventListener('change', refreshCount));
      refreshCount();

      // 一键把选中的人标为调休 / 请假（清掉当天已有排班）
      const markLeave = async (kind) => {
        const ids = selectedIds();
        if (!ids.length) { toast('先选择人员', true); return; }
        try {
          for (const id of ids) {
            await api('/leaves', { method: 'POST', body: { date, employee_id: id, kind } });
          }
          close();
          toast(kind === 'leave' ? `已标记 ${ids.length} 人请假` : `已标记 ${ids.length} 人调休`);
          setTimeout(() => renderCurrentView(), 0);
        } catch (err) { toast(err.message, true); }
      };
      $('#batchRestOff', root).addEventListener('click', () => markLeave('rest'));
      $('#batchLeave', root).addEventListener('click', () => markLeave('leave'));

      $('#batchApply', root).addEventListener('click', async () => {
        const ids = selectedIds();
        if (!ids.length) { toast('先选择人员', true); return; }
        const st = startEl.value, en = endEl.value;
        const h = Number(hoursEl.value) || hoursBetweenStr(st, en);
        if (!(h > 0)) { toast('请填写工时或时间段', true); return; }
        const common = ($('#batchContent', root)?.value || '').trim();
        const replace = $('#batchReplace', root).checked;
        const btn = $('#batchApply', root);
        btn.disabled = true;
        btn.textContent = '正在写入…';
        try {
          let count = 0;
          for (const id of ids) {
            if (replace) {
              await api(`/schedule?date=${date}&employee_id=${id}`, { method: 'DELETE' });
            }
            const own = batchOwn[id];
            const content = (own !== undefined && own.trim()) ? own.trim() : common;
            await api('/schedule', {
              method: 'POST',
              body: { date, employee_id: id, start: st, end: en, hours: h, content },
            });
            count++;
            if (content) await rememberContent(content);
          }
          close();
          toast(`已为 ${count} 人排班`);
          setTimeout(() => renderCurrentView(), 0);
        } catch (err) {
          btn.disabled = false;
          btn.textContent = '排班';
          toast(err.message, true);
        }
      });
    },
  });
}

/* ------------------------------------------------------------ 视图：人员 */
async function renderPeople() {
  const main = $('#main');
  main.innerHTML = `<div class="people-layout">
    <div class="card">
      <div class="card-head">
        <h2>人员</h2>
        <span class="sub">应出勤口径、工号、班组</span>
        <div class="spacer"></div>
        <button class="btn primary sm" id="addEmp">+ 新增人员</button>
      </div>
      <div class="card-body">
        ${state.employees.length ? `
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>姓名</th><th>工号</th><th>班组</th><th>应出勤口径</th><th></th></tr></thead>
            <tbody>
              ${state.employees.map((e) => `
                <tr>
                  <td><div class="name-cell"><span class="avatar">${esc(initials(e.name))}</span>${esc(e.name)}</div></td>
                  <td>${esc(e.employee_no || '—')}</td>
                  <td>${esc(e.team || '—')}</td>
                  <td>${e.expect_mode === 'fixed'
                    ? `<span class="chip">固定 ${fmtNum(e.monthly_quota ?? 0)} 小时/月</span>`
                    : `<span class="chip">跟随工作日历${Number(e.daily_hours) > 0 ? ` · ${fmtNum(e.daily_hours)}h/天` : ''}</span>`}</td>
                  <td style="text-align:right;white-space:nowrap">
                    <button class="btn sm ghost" data-edit-emp="${e.id}">编辑</button>
                    <button class="btn sm danger" data-del-emp="${e.id}">移除</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<div class="empty"><h3>还没有人员</h3><p>导入 Excel 或手动新增</p></div>'}
      </div>
    </div>

    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="card">
        <div class="card-head"><h2>统计口径</h2></div>
        <div class="card-body">
          <div class="field" style="margin-bottom:14px">
            <label>每人每天标准工时</label>
            <div style="display:flex;gap:8px;align-items:center">
              <input class="input" type="number" step="0.5" min="0.5" id="dailyHours"
                     value="${fmtNum(state.settings.daily_hours ?? 8)}" style="max-width:110px">
              <span style="font-size:12.5px;color:var(--text-muted)">小时 / 天</span>
            </div>
            <span style="font-size:12px;color:var(--text-muted)">
              应出勤 = 工作日天数 × 这个值；也可以单独给某人设不同的标准。
            </span>
          </div>
          <div class="field" style="margin-bottom:14px">
            <label>统计起点</label>
            <input class="input" type="date" id="statsStart" value="${esc(state.settings.stats_start_date || '')}">
            <span style="font-size:12px;color:var(--text-muted)">
              此日之前的记录只累计「已上多少小时」，不计应出勤和欠班。清洗历史表后从某天起用本 App 排班时设置。
            </span>
          </div>
          <div class="field" style="margin-bottom:12px">
            <label>默认上班日（高亮 = 工作日）</label>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((w, i) => {
                const isWork = (state.settings.work_weekdays || '').split(',').includes(String(i));
                return `<button class="btn sm ${isWork ? 'primary' : ''}" data-weekday="${i}"
                  title="${isWork ? '点击设为休息日' : '点击设为工作日'}">${w}</button>`;
              }).join('')}
            </div>
            <span style="font-size:12px;color:var(--text-muted)">用于自动计算「应出勤」；月视图中「编辑工作日」的单日设置优先</span>
          </div>
          <button class="btn sm" id="saveStatsStart">保存统计口径</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>工作内容</h2>
          <span class="sub">排班时可直接选</span>
        </div>
        <div class="card-body">
          <div class="content-chips" id="contentOptList" style="margin-bottom:10px">
            ${contentOptions().map((c) => `
              <span class="content-chip active" style="cursor:default">
                ${esc(c)}
                <button class="icon-btn" data-del-content="${esc(c)}" title="删除"
                        style="width:16px;height:16px;margin-left:4px;color:rgba(255,255,255,.85)" aria-label="删除">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
                </button>
              </span>`).join('') || '<span style="font-size:12.5px;color:var(--text-muted)">还没有常用内容</span>'}
          </div>
          <div style="display:flex;gap:8px">
            <input class="input" id="newContentOpt" placeholder="如：理瓶 / 灌装" style="height:34px">
            <button class="btn sm primary" id="addContentOpt" style="height:34px">添加</button>
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:8px">
            这里的内容会出现在排班时的选项里；没设置时自动用历史排班里出现过的内容。
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>数据</h2></div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:8px">
          <button class="btn" id="btnBackup">导出备份（JSON）</button>
          <button class="btn" id="btnRestore">从备份恢复</button>
          <button class="btn" id="btnImport2">导入 Excel 排班表</button>
          <div class="hint-box" style="margin-top:4px">
            数据只保存在<b>当前浏览器</b>。换设备或清理浏览器数据前，请先导出备份。
          </div>
          <button class="btn danger" id="btnClearAll" style="margin-top:8px">清除所有记录</button>
          <div style="font-size:12px;color:var(--text-muted)">
            删除全部人员、排班、手工调整与设置，恢复到初始状态。不可撤销。
          </div>
        </div>
      </div>
    </div>
  </div>`;

  $('#addEmp').addEventListener('click', () => openEmployeeModal(null));
  $$('[data-edit-emp]').forEach((b) => b.addEventListener('click', () => {
    openEmployeeModal(state.employees.find((e) => e.id === Number(b.dataset.editEmp)));
  }));
  $$('[data-del-emp]').forEach((b) => b.addEventListener('click', async () => {
    const e = state.employees.find((x) => x.id === Number(b.dataset.delEmp));
    if (!confirm(`移除「${e.name}」？历史排班数据会保留但不再统计。`)) return;
    try {
      await api(`/employees/${e.id}`, { method: 'DELETE' });
      await loadBootstrap();
      renderPeople();
      toast('已移除');
    } catch (err) { toast(err.message, true); }
  }));

  $$('[data-weekday]').forEach((btn) => btn.addEventListener('click', async () => {
    const i = Number(btn.dataset.weekday);
    const set = new Set((state.settings.work_weekdays || '').split(',').filter((x) => x !== ''));
    if (set.has(String(i))) set.delete(String(i)); else set.add(String(i));
    const val = [...set].sort().join(',');
    try {
      state.settings = await api('/settings', { method: 'PUT', body: { work_weekdays: val } });
      renderPeople();
    } catch (e) { toast(e.message, true); }
  }));

  $('#saveStatsStart')?.addEventListener('click', async () => {
    try {
      const dh = Number($('#dailyHours').value);
      if (!(dh > 0)) { toast('标准工时需大于 0', true); return; }
      state.settings = await api('/settings', {
        method: 'PUT',
        body: {
          stats_start_date: $('#statsStart').value || '',
          daily_hours: dh,
        },
      });
      toast('统计口径已保存');
    } catch (e) { toast(e.message, true); }
  });

  // 工作内容预设：添加 / 删除
  const saveOptions = async (list) => {
    state.settings = await api('/settings', { method: 'PUT', body: { content_options: list.join(',') } });
    renderPeople();
  };
  $('#addContentOpt')?.addEventListener('click', async () => {
    const input = $('#newContentOpt');
    const v = input.value.trim();
    if (!v) { input.focus(); return; }
    const list = contentOptions();
    if (list.includes(v)) { toast('已经有了', true); return; }
    list.push(v);
    try {
      await saveOptions(list);
      toast(`已添加「${v}」`);
    } catch (e) { toast(e.message, true); }
  });
  $('#newContentOpt')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#addContentOpt').click(); }
  });
  $$('[data-del-content]').forEach((b) => b.addEventListener('click', async () => {
    const v = b.dataset.delContent;
    const list = contentOptions().filter((c) => c !== v);
    try {
      await saveOptions(list);
      toast(`已删除「${v}」`);
    } catch (e) { toast(e.message, true); }
  }));

  $('#btnBackup').addEventListener('click', downloadBackup);
  $('#btnRestore').addEventListener('click', openRestore);
  $('#btnImport2').addEventListener('click', openImportWizard);
  $('#btnClearAll').addEventListener('click', openClearAll);
}

function openEmployeeModal(emp) {
  const isNew = !emp;
  openModal({
    title: isNew ? '新增人员' : '编辑人员',
    body: `
      <div class="form-grid">
        <div class="field"><label>姓名 *</label><input class="input" id="eName" value="${esc(emp?.name || '')}"></div>
        <div class="field"><label>工号</label><input class="input" id="eNo" value="${esc(emp?.employee_no || '')}"></div>
        <div class="field"><label>班组</label><input class="input" id="eTeam" value="${esc(emp?.team || '')}"></div>
        <div class="field"><label>排序</label><input class="input" type="number" id="eSort" value="${emp?.sort_order ?? 0}"></div>
        <div class="field full">
          <label>应出勤口径</label>
          <select class="input" id="eMode">
            <option value="auto" ${emp?.expect_mode !== 'fixed' ? 'selected' : ''}>跟随工作日历（每天标准工时）</option>
            <option value="fixed" ${emp?.expect_mode === 'fixed' ? 'selected' : ''}>固定月度工时定额</option>
          </select>
        </div>
        <div class="field full" id="perDayField" style="display:${emp?.expect_mode === 'fixed' ? 'none' : 'flex'}">
          <label>每人每天标准工时（留空 = 用全局）</label>
          <input class="input" type="number" step="0.5" min="0.5" id="eDaily"
                 value="${emp?.daily_hours ?? ''}" placeholder="${fmtNum(state.settings.daily_hours ?? 8)}">
        </div>
        <div class="field full" id="quotaField" style="display:${emp?.expect_mode === 'fixed' ? 'flex' : 'none'}">
          <label>每月应出勤工时</label>
          <input class="input" type="number" step="0.5" id="eQuota" value="${emp?.monthly_quota ?? 174}">
        </div>
        <div class="field full"><label>备注</label><input class="input" id="eNote" value="${esc(emp?.note || '')}"></div>
      </div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn primary" id="eSave">保存</button>`,
    onMount: (root, close) => {
      $('#eMode', root).addEventListener('change', (e) => {
        const fixed = e.target.value === 'fixed';
        $('#quotaField', root).style.display = fixed ? 'flex' : 'none';
        $('#perDayField', root).style.display = fixed ? 'none' : 'flex';
      });
      $('#eSave', root).addEventListener('click', async () => {
        const perDayRaw = $('#eDaily', root).value.trim();
        const body = {
          name: $('#eName', root).value.trim(),
          employee_no: $('#eNo', root).value.trim(),
          team: $('#eTeam', root).value.trim(),
          expect_mode: $('#eMode', root).value,
          monthly_quota: $('#eMode', root).value === 'fixed' ? Number($('#eQuota', root).value) : null,
          daily_hours: perDayRaw === '' ? null : Number(perDayRaw),
          sort_order: Number($('#eSort', root).value) || 0,
          note: $('#eNote', root).value.trim(),
        };
        if (!body.name) { toast('姓名不能为空', true); return; }
        try {
          if (isNew) await api('/employees', { method: 'POST', body });
          else await api(`/employees/${emp.id}`, { method: 'PUT', body });
          close();
          await loadBootstrap();
          renderPeople();
          toast('已保存');
        } catch (e) { toast(e.message, true); }
      });
    },
  });
}

/* ------------------------------------------------------------ 导入向导 */
function openImportWizard() {
  let staged = null;

  const modal = openModal({
    title: '导入 Excel 排班表',
    sub: '支持月历矩阵表、人员列矩阵表、明细长表',
    wide: true,
    body: `<div class="wizard-steps"><span class="step active"></span><span class="step"></span><span class="step"></span></div>
      <div id="wizBody"></div>`,
    footer: `<button class="btn" data-close>取消</button>
      <button class="btn primary" id="wizNext" disabled>下一步</button>`,
    onMount: (root, close) => {
      const wizBody = $('#wizBody', root);
      const nextBtn = $('#wizNext', root);
      const steps = $$('.wizard-steps .step', root);
      let step = 0;

      const setStep = (n) => {
        step = n;
        steps.forEach((s, i) => {
          s.className = 'step' + (i < n ? ' done' : i === n ? ' active' : '');
        });
        nextBtn.textContent = n === 2 ? '确认导入' : '下一步';
        nextBtn.disabled = n === 0 ? !staged : false;
      };

      // ---- 步骤 1：上传
      const renderUpload = () => {
        wizBody.innerHTML = `
          <label class="dropzone" id="dz">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
            <div class="big">点击选择或拖入 Excel 文件</div>
            <div class="hint">.xlsx / .xlsm · 自动识别表头与日期列</div>
            <input type="file" id="fileInput" accept=".xlsx,.xlsm" hidden>
          </label>
          <div class="hint-box" style="margin-top:16px">
            能识别的版式：<br>
            · <b>人员行矩阵</b>：第一列姓名，后面是 1日、2日…（最常见）<br>
            · <b>人员列矩阵</b>：第一列日期，表头是姓名<br>
            · <b>明细长表</b>：每行「日期 / 姓名 / 班次」<br>
            休息类标记（休、休息、公休、空白）会自动跳过。
          </div>
          <div id="upStatus" style="margin-top:14px"></div>`;
        const dz = $('#dz', wizBody);
        const input = $('#fileInput', wizBody);
        dz.addEventListener('click', (e) => { if (e.target !== input) input.click(); });
        input.addEventListener('change', () => input.files[0] && upload(input.files[0]));
        ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
          e.preventDefault(); dz.classList.add('drag');
        }));
        ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
          e.preventDefault(); dz.classList.remove('drag');
        }));
        dz.addEventListener('drop', (e) => {
          const f = e.dataTransfer.files[0];
          if (f) upload(f);
        });
      };

      const upload = async (file) => {
        if (!file) return;
        const status = $('#upStatus', wizBody);
        if (!status) return;
        status.innerHTML = '<span class="spin"></span> 正在解析…';
        nextBtn.disabled = true;
        try {
          const fd = new FormData();
          fd.append('file', file);
          staged = await api('/import/preview', { method: 'POST', body: fd });
          if (staged && staged._entries) store.lastPreview = staged;
          status.innerHTML = `<span style="color:var(--good-text);font-weight:600">✓ 解析成功</span>`;
          toast('解析完成，请确认班次映射');
          // 解析成功后自动进入映射步骤
          renderMapping();
          setStep(1);
        } catch (e) {
          if (status.isConnected) {
            status.innerHTML = `<span style="color:var(--critical)">${esc(e.message)}</span>`;
          }
          staged = null;
          nextBtn.disabled = true;
        }
      };

      // ---- 步骤 2：映射
      const renderMapping = () => {
        const s = staged;
        wizBody.innerHTML = `
          <div class="summary-grid">
            <div class="summary-item"><div class="k">文件</div><div class="v" style="font-size:13px;word-break:break-all">${esc(s.filename || '—')}</div></div>
            <div class="summary-item"><div class="k">识别版式</div><div class="v" style="font-size:13px">${s.layouts.map((l) => ({ matrix_rows: '人员行', matrix_cols: '人员列', long: '长表', date_blocks: '按日分块' }[l.layout] || l.layout)).join('、')}</div></div>
            <div class="summary-item"><div class="k">日期跨度</div><div class="v" style="font-size:13px">${s.summary.dates.join(' ~ ') || '—'}</div></div>
            <div class="summary-item"><div class="k">人数</div><div class="v">${s.summary.people}</div></div>
            <div class="summary-item"><div class="k">记录数</div><div class="v">${s.summary.entries}</div></div>
          </div>

          <h4 style="font-size:13px;margin:0 0 4px">标记 → 工时</h4>
          <p style="font-size:12.5px;color:var(--text-muted);margin:0 0 10px">
            左边是 Excel 里出现的原始标记，右边填这个标记算几小时。已经能识别时间段的会按起止时间自动算出。
            选「忽略」则不导入该标记。
          </p>
          <div id="mapList">
            ${s.tokens.map((t) => {
              const m = (s.token_meta || {})[t.token] || {};
              const cur = s.mapping[t.token];
              const hh = ExcelParse.suggestedHours ? ExcelParse.suggestedHours(t.token) : 0;
              const hint = m.kind === 'work' && m.hours != null
                ? `${m.start || ''}-${m.end || ''} → ${fmtNum(m.hours)} 小时`
                : m.kind === 'open' ? `${m.start || ''} 起到生产结束（暂按 8 小时，可改）`
                : m.kind === 'other' ? (hh > 0 ? `按班次名估算 ${fmtNum(hh)} 小时，可改` : '未能识别，请手填工时')
                : m.note ? m.note : '';
              return `
              <div class="map-row">
                <div class="map-token">${esc(t.token)}<span class="cnt">${t.count} 次</span>
                  ${hint ? `<span class="cnt" style="color:var(--text-muted)">· ${esc(hint)}</span>` : ''}
                </div>
                <svg class="map-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>
                <div class="map-hours">
                  <input class="input map-hours-input" type="number" step="0.5" min="0" data-token="${esc(t.token)}"
                         value="${cur === '__skip__' || cur === undefined ? '' : fmtNum(cur)}"
                         placeholder="小时" ${cur === '__skip__' ? 'disabled' : ''} style="width:90px">
                  <span class="unit">小时</span>
                  <label class="switch" style="margin-left:8px">
                    <input type="checkbox" class="map-skip" data-token="${esc(t.token)}" ${cur === '__skip__' ? 'checked' : ''}> 忽略
                  </label>
                </div>
              </div>`;
            }).join('')}
          </div>

          <h4 style="font-size:13px;margin:20px 0 8px">人员匹配</h4>
          <div class="pp-toolbar" style="margin-bottom:8px">
            <button class="btn sm ghost" id="impAllPeople">全选</button>
            <button class="btn sm ghost" id="impNoPeople">全不选</button>
            <span class="pp-count" id="impPeopleCount"></span>
          </div>
          <div class="name-map-list" id="impPeopleList">
            ${s.names.map((n) => `
              <div class="name-row" data-imp-name="${esc(n.name)}">
                <label class="pp-check">
                  <input type="checkbox" data-imp-toggle="${esc(n.name)}" checked>
                  <span class="src">${esc(n.name)}</span>
                </label>
                <span class="${n.exists ? 'badge-old' : 'badge-new'}">${n.exists ? '已存在' : '将新建'}</span>
              </div>`).join('')}
          </div>
          <p style="font-size:12.5px;color:var(--text-muted);margin:8px 0 0">
            取消勾选的人不会导入（表里很多人已离职时用这个）。
          </p>

          <div style="display:flex;flex-direction:column;gap:10px;margin-top:18px">
            <label class="switch"><input type="checkbox" id="optReplace" checked> 覆盖这些人这些日期已有的排班</label>
            <label class="switch"><input type="checkbox" id="optAutoCreate" checked> 自动创建未匹配的人员</label>
          </div>

          <h4 style="font-size:13px;margin:20px 0 8px">数据预览（前 12 条）</h4>
          <div class="table-wrap preview-table">
            <table class="data">
              <thead><tr><th>日期</th><th>姓名</th><th>原始标记</th><th>工号</th><th>班组</th></tr></thead>
              <tbody>
                ${s.preview.slice(0, 12).map((p) => `
                  <tr><td>${p.date}</td><td>${esc(p.name)}</td><td>${esc(p.raw)}</td><td>${esc(p.employee_no || '')}</td><td>${esc(p.team || '')}</td></tr>`).join('')}
              </tbody>
            </table>
          </div>`;

        // 人员勾选：全选 / 全不选
        const refreshImpCount = () => {
          const all = $$('[data-imp-toggle]', wizBody);
          const checked = all.filter((c) => c.checked).length;
          const el = $('#impPeopleCount', wizBody);
          if (el) el.textContent = `导入 ${checked} / ${all.length} 人`;
        };
        $('#impAllPeople', wizBody)?.addEventListener('click', () => {
          $$('[data-imp-toggle]', wizBody).forEach((c) => { c.checked = true; });
          refreshImpCount();
        });
        $('#impNoPeople', wizBody)?.addEventListener('click', () => {
          $$('[data-imp-toggle]', wizBody).forEach((c) => { c.checked = false; });
          refreshImpCount();
        });
        $$('[data-imp-toggle]', wizBody).forEach((c) => c.addEventListener('change', refreshImpCount));
        refreshImpCount();

        // 「忽略」勾选切换工时输入可用性
        $$('.map-skip', wizBody).forEach((cb) => cb.addEventListener('change', () => {
          const input = $(`.map-hours-input[data-token="${CSS.escape(cb.dataset.token)}"]`, wizBody);
          if (input) {
            input.disabled = cb.checked;
            if (cb.checked) input.value = '';
          }
        }));
      };

      // 进入步骤 3 前先收集选项（renderDone 会清空 DOM）
      let commitOptions = null;

      // ---- 步骤 3：完成
      const renderDone = async () => {
        const mapping = {};
        $$('.map-hours-input', wizBody).forEach((el) => {
          const skip = $(`.map-skip[data-token="${CSS.escape(el.dataset.token)}"]`, wizBody);
          if (skip && skip.checked) {
            mapping[el.dataset.token] = '__skip__';
            return;
          }
          const v = Number(el.value);
          mapping[el.dataset.token] = Number.isFinite(v) && v > 0 ? v : '__skip__';
        });
        const opts = commitOptions || {
          replace: $('#optReplace')?.checked ?? true,
          auto_create: $('#optAutoCreate')?.checked ?? true,
        };
        wizBody.innerHTML = `<div style="text-align:center;padding:40px 0"><span class="spin"></span><p style="color:var(--text-muted)">正在写入…</p></div>`;
        nextBtn.disabled = true;
        try {
          const res = await api('/import/commit', {
            method: 'POST',
            body: { token: staged.token, mapping, ...opts },
          });
          wizBody.innerHTML = `
            <div style="text-align:center;padding:28px 0">
              <div style="width:56px;height:56px;border-radius:50%;background:var(--accent-soft);display:grid;place-items:center;margin:0 auto 16px">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>
              </div>
              <h3 style="font-size:17px;margin-bottom:6px">导入完成</h3>
              <p style="color:var(--text-muted);font-size:13px">
                写入 ${res.inserted} 条排班 · 新建 ${res.employees_created} 人
                ${res.deleted ? ` · 覆盖 ${res.deleted} 条旧记录` : ''}${res.skipped ? ` · 跳过 ${res.skipped} 条` : ''}
              </p>
            </div>`;
          nextBtn.textContent = '完成';
          nextBtn.disabled = false;
          await loadBootstrap();
          toast('导入完成');
          setTimeout(() => { close(); renderCurrentView(); }, 900);
        } catch (e) {
          wizBody.innerHTML = `<div class="empty"><h3>导入失败</h3><p>${esc(e.message)}</p></div>`;
          nextBtn.disabled = false;
        }
      };

      nextBtn.addEventListener('click', () => {
        if (step === 0) { renderMapping(); setStep(1); }
        else if (step === 1) {
          // 未勾选的人员标记为跳过
          const nameMap = {};
          $$('[data-imp-toggle]', wizBody).forEach((cb) => {
            if (!cb.checked) nameMap[cb.dataset.impToggle] = '__skip__';
          });
          commitOptions = {
            replace: $('#optReplace', wizBody)?.checked ?? true,
            auto_create: $('#optAutoCreate', wizBody)?.checked ?? true,
            name_map: nameMap,
          };
          setStep(2);
          renderDone();
        }
      });

      renderUpload();
      setStep(0);
    },
  });
  return modal;
}

function openRestore() {
  openModal({
    title: '从备份恢复',
    sub: '会覆盖当前全部数据',
    body: `<label class="dropzone" id="rdz">
        <div class="big">选择备份 JSON 文件</div>
        <div class="hint">由「导出备份」生成</div>
        <input type="file" id="rfile" accept=".json,application/json" hidden>
      </label>
      <div id="rStatus" style="margin-top:14px"></div>`,
    footer: `<button class="btn" data-close>取消</button>`,
    onMount: (root, close) => {
      const dz = $('#rdz', root), input = $('#rfile', root);
      dz.addEventListener('click', (e) => { if (e.target !== input) input.click(); });
      input.addEventListener('change', async () => {
        const f = input.files[0];
        if (!f) return;
        const status = $('#rStatus', root);
        try {
          const data = JSON.parse(await f.text());
          if (!confirm('确定用该备份覆盖当前全部数据？此操作不可撤销。')) return;
          await api('/restore', { method: 'POST', body: { confirm: true, data } });
          status.innerHTML = '<span style="color:var(--good-text);font-weight:600">✓ 恢复完成</span>';
          await loadBootstrap();
          setTimeout(() => { close(); renderCurrentView(); }, 700);
        } catch (e) {
          status.innerHTML = `<span style="color:var(--critical)">${esc(e.message)}</span>`;
        }
      });
    },
  });
}

/* ------------------------------------------------------------ 清除所有记录 */
function openClearAll() {
  const empCount = state.employees.length;
  const assignCount = store.state.assignments.length;
  const adjCount = store.state.adjustments.length;
  const leaveCount = (store.state.leaves || []).length;
  const KEY = '清除';

  openModal({
    title: '清除所有记录',
    sub: '此操作不可撤销',
    body: `
      <div class="hint-box" style="border-left:3px solid var(--critical)">
        <b style="color:var(--critical)">将永久删除本机保存的全部数据：</b>
        <div style="margin-top:6px">
          · 人员 <b>${empCount}</b> 人<br>
          · 排班记录 <b>${assignCount}</b> 条<br>
          · 手工调整 <b>${adjCount}</b> 条<br>
          · 调休 / 请假 <b>${leaveCount}</b> 条<br>
          · 统计起点、工作日设置、隐藏人员等设置一并清空
        </div>
      </div>
      <div style="margin-top:16px">
        <button class="btn sm" id="clearBackupFirst">先导出备份</button>
        <span style="font-size:12px;color:var(--text-muted);margin-left:8px">
          想保留数据，先导出备份，清除后再从备份恢复
        </span>
      </div>
      <div class="field" style="margin-top:18px">
        <label>确认操作，请输入「${KEY}」</label>
        <input class="input" id="clearConfirmInput" placeholder="${KEY}" autocomplete="off">
      </div>`,
    footer: `<button class="btn" data-close>取消</button>
      <button class="btn danger" id="clearDo" disabled>永久清除</button>`,
    onMount: (root, close) => {
      const input = $('#clearConfirmInput', root);
      const btn = $('#clearDo', root);

      $('#clearBackupFirst', root).addEventListener('click', downloadBackup);

      const refresh = () => {
        const ok = input.value.trim() === KEY;
        btn.disabled = !ok;
      };
      input.addEventListener('input', refresh);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btn.disabled) btn.click(); });
      refresh();
      setTimeout(() => input.focus(), 50);

      btn.addEventListener('click', async () => {
        if (input.value.trim() !== KEY) return;
        btn.disabled = true;
        btn.textContent = '正在清除…';
        try {
          await api('/reset', { method: 'POST', body: { confirm: true } });
          await loadBootstrap();
          state.stats = null;
          state.monthly = null;
          state.daily = null;
          state.schedule = null;
          state.calendar = null;
          state.selected.clear();
          state.bulkMode = false;
          state.calendarEdit = false;
          state.showHidden = false;
          state.rowDrag = null;
          state.cursor = new Date();
          state.dayCursor = new Date();
          setPreset(state.rangePreset);
          close();
          setView(state.view);
          toast('已清除所有记录');
        } catch (e) {
          btn.disabled = false;
          btn.textContent = '永久清除';
          toast(e.message, true);
        }
      });
    },
  });
}

/* ------------------------------------------------------------ 导出文件 */
function downloadBlob(content, filename, mime = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadBackup() {
  try {
    const json = Importer.exportBackup(store.state);
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
    downloadBlob(json, `排班备份-${stamp}.json`, 'application/json');
    toast('备份已导出');
  } catch (e) {
    toast(e.message, true);
  }
}

/** 导出统计表为 CSV（Excel 可直接打开） */
function exportStatsCsv() {
  if (!state.stats) return;
  const hist = !!state.stats.historical;
  const header = ['姓名', '班组', '应出勤(小时)', hist ? '本期出勤(小时)' : '已出勤(小时)'];
  if (hist) header.push('累计已上(小时)');
  header.push('加班(小时)', '欠班(小时)', '净值(小时)');
  const rows = [header];
  for (const e of state.stats.employees) {
    const row = [e.name, e.team || '', e.expected, hist ? e.period_actual : e.actual];
    if (hist) row.push(e.actual);
    row.push(e.overtime, e.owe, e.net_final);
    rows.push(row);
  }
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  downloadBlob(Importer.toCsv(rows), `排班统计-${stamp}.csv`, 'text/csv;charset=utf-8');
  toast('统计表已导出');
}

/* ------------------------------------------------------------ 空状态 */
function emptyStateHtml() {
  return `<div class="card"><div class="empty" style="padding:64px 24px">
    <h3 style="font-size:17px;margin-bottom:8px">开始使用</h3>
    <p>导入一份 Excel 排班表，系统会自动识别人员与班次，<br>并累计每人的已出勤、加班与欠班。</p>
    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
      <button class="btn primary" id="emptyImport">导入 Excel</button>
      <button class="btn" id="emptyAddEmp">手动添加人员</button>
    </div>
    <div class="hint-box" style="max-width:500px;margin:28px auto 0;text-align:left">
      支持的表格版式：<br>
      · 行=人员、列=日期的月历表<br>
      · 行=日期、列=人员<br>
      · 每行一条「日期 / 姓名 / 班次」的明细表<br>
      · 按日分块的小表（日期只在每天块首）<br>
      <span style="color:var(--text-muted)">数据只保存在本机浏览器，可在「人员 → 导出备份」迁移到其他设备。</span>
    </div>
  </div></div>`;
}
function bindEmptyState() {
  $('#emptyImport')?.addEventListener('click', openImportWizard);
  $('#emptyAddEmp')?.addEventListener('click', async () => {
    try {
      await api('/employees', { method: 'POST', body: { name: '示例员工' } });
      await loadBootstrap();
      renderPeople();
    } catch (e) { toast(e.message, true); }
  });
}

/* ------------------------------------------------------------ 导航 & 主题 */
function setView(view) {
  state.view = view;
  state.selected.clear();
  state.bulkMode = false;
  state.calendarEdit = false;
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === view)));
  if (location.hash !== '#' + view) location.hash = view;
  renderCurrentView();
}

/** 重新渲染当前页面（不切换视图、不改 hash） */
function renderCurrentView() {
  const view = state.view;
  if (view === 'dashboard') renderDashboard();
  else if (view === 'month') renderMonth();
  else if (view === 'day') renderDay();
  else if (view === 'people') renderPeople();
}

const VIEWS = ['dashboard', 'month', 'day', 'people'];
function viewFromHash() {
  const h = (location.hash || '').replace('#', '');
  return VIEWS.includes(h) ? h : null;
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('schedule-theme', theme);
  const meta = $('meta[name="theme-color"]');
  if (meta) {
    const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    meta.setAttribute('content', dark ? '#1a1a19' : '#fcfcfb');
  }
}

function initTheme() {
  const saved = localStorage.getItem('schedule-theme') || 'auto';
  applyTheme(saved);
  $('#btnTheme').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const cur = document.documentElement.getAttribute('data-theme') || 'auto';
    applyTheme(order[(order.indexOf(cur) + 1) % order.length]);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((document.documentElement.getAttribute('data-theme') || 'auto') === 'auto') applyTheme('auto');
  });
}

async function init() {
  initTheme();
  $$('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
  $('#btnImport').addEventListener('click', openImportWizard);

  // 纯前端模式：初始化本地存储
  try {
    store = new Store(new IdbBackend());
    await store.init();
    localApi = createLocalApi(store);
  } catch (e) {
    $('#main').innerHTML = `<div class="empty"><h3>无法初始化本地存储</h3>
      <p>${esc(e.message)}</p>
      <p style="font-size:12px">若在无痕/隐私模式，浏览器可能禁止 IndexedDB。</p></div>`;
    return;
  }

  try {
    await loadBootstrap();
  } catch (e) {
    $('#main').innerHTML = `<div class="empty"><h3>无法读取本地数据</h3><p>${esc(e.message)}</p></div>`;
    return;
  }

  const hash = (location.hash || '').replace('#', '');
  const view = VIEWS.includes(hash) ? hash : 'dashboard';
  setPreset('month');
  setView(view);

  // 支持浏览器前进/后退与 PWA 快捷方式切换视图
  window.addEventListener('hashchange', () => {
    const v = viewFromHash();
    if (v && v !== state.view) setView(v);
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // 新版本就绪时自动接管并刷新一次，避免长期停留在旧脚本
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            sw.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    }).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
