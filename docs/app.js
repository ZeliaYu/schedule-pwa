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
  shifts: [],
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
};

const shiftByCode = () => Object.fromEntries(state.shifts.map((s) => [s.code, s]));
const empById = () => Object.fromEntries(state.employees.map((e) => [e.id, e]));
const shiftColor = (code) => (shiftByCode()[code] || {}).color || 'var(--text-muted)';

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
        <div class="tip-row"><span>加班</span><b>${fmtNum(row.overtime)} 班</b></div>
        <div class="tip-row"><span>欠班</span><b>${fmtNum(row.owe)} 班</b></div>
        <div class="tip-row"><span>应出勤</span><b>${fmtNum(row.expected)} 班</b></div>
        <div class="tip-row"><span>已出勤</span><b>${fmtNum(row.actual)} 班</b></div>`, e);
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
  for (const c of data.cells) cellMap[c.employee_id + '|' + c.date] = c.shifts;

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
      const codes = cellMap[e.id + '|' + d.date] || [];
      const r = { x: x + gap / 2, y: y + gap / 2, width: cellW - gap, height: cellH - gap };

      if (!codes.length) {
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
        // 多班次上下堆叠，段间留 2px 空隙
        const segH = (r.height - (codes.length - 1) * gap) / codes.length;
        codes.forEach((code, k) => {
          svg.appendChild(svgEl('rect', {
            x: r.x, y: r.y + k * (segH + gap),
            width: r.width, height: Math.max(2, segH), rx: 2,
            fill: shiftColor(code),
          }));
        });
      }

      const hit = svgEl('rect', { x, y, width: cellW, height: cellH, fill: 'transparent' });
      hit.addEventListener('mousemove', (ev) => {
        const names = codes.map((c) => (shiftByCode()[c] || {}).name || c).join('、');
        showTip(`<div class="tip-title">${esc(e.name)} · ${d.date.slice(5)} ${weekdayCN(parseISO(d.date))}</div>
          <div class="tip-row"><span>班次</span><b>${esc(names || (d.is_workday ? '未排班' : '休息'))}</b></div>`, ev);
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
  state.shifts = data.shifts;
  state.settings = data.settings;
  const org = $('#orgName');
  if (org) org.textContent = data.settings.org_name || '排班管理';
  document.title = (data.settings.org_name || '排班管理');
}

async function loadDashboard() {
  const { from, to } = state.range;
  const [stats, monthly] = await Promise.all([
    api(`/stats?date_from=${from}&date_to=${to}`),
    api(`/stats/monthly?date_from=${from}&date_to=${to}`),
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
  const [schedule, stats] = await Promise.all([
    api(`/schedule?date_from=${d}&date_to=${d}`),
    api(`/stats?date_from=${d}&date_to=${d}`),
  ]);
  state.schedule = schedule;
  state.dayStats = stats;
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
  const peopleOT = emps.filter((e) => e.overtime > 0).length;
  const peopleOWE = emps.filter((e) => e.owe > 0).length;

  main.innerHTML = `
    <div class="range-bar">
      <div class="segmented" role="group" aria-label="时间范围">
        ${[['month', '本月'], ['last30', '近30天'], ['quarter', '本季度'], ['year', '今年']].map(([k, lb]) => `
          <button data-preset="${k}" aria-pressed="${state.rangePreset === k}">${lb}</button>`).join('')}
      </div>
      <span class="chip">${esc(currentRangeLabel())} · 工作日 <b style="margin-left:4px">${t.workdays}</b> 天</span>
    </div>

    <div class="kpi-row">
      <div class="kpi hero-kpi">
        <div class="label">累计加班</div>
        <div class="value">${fmtNum(t.overtime)}<span class="unit">班</span></div>
        <div class="meta">${peopleOT} 人存在加班 · 人均 ${fmtNum(peopleOT ? t.overtime / peopleOT : 0)} 班</div>
      </div>
      <div class="kpi">
        <div class="label">累计欠班</div>
        <div class="value">${fmtNum(t.owe)}<span class="unit">班</span></div>
        <div class="meta">${peopleOWE} 人存在欠班</div>
      </div>
      <div class="kpi">
        <div class="label">已出勤</div>
        <div class="value">${fmtNum(stats.historical ? t.period_actual : t.actual)}<span class="unit">人班</span></div>
        <div class="meta">应出勤 ${fmtNum(t.expected)} 人班${stats.historical ? ` · 历史另计 ${fmtNum(t.historical_actual)}` : ''}</div>
      </div>
      <div class="kpi">
        <div class="label">综合净额</div>
        <div class="value ${netSum > 0 ? 'num-pos' : netSum < 0 ? 'num-neg' : ''}">${netSum > 0 ? '+' : ''}${fmtNum(netSum)}<span class="unit">班</span></div>
        <div class="meta">加班 − 欠班（全员合计）</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head">
        <h2>每人加班 / 欠班</h2>
        <span class="sub">以应出勤为基准，向右为加班，向左为欠班</span>
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
          { name: state.trendMetric === 'net' ? '加班（班）' : '欠班（班）', color: state.trendMetric === 'net' ? 'var(--series-1)' : 'var(--series-8)' },
        ])}
        <div id="trendChart" class="chart-wrap"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>排班密度</h2>
        <span class="sub">人员 × 日期</span>
        <div class="spacer"></div>
      </div>
      <div class="card-body">
        ${legendHtml(state.shifts.map((s) => ({ name: s.name, color: s.color })))}
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
            <td class="num">${fmtNum(e.expected)}</td>
            <td class="num">${fmtNum(historical ? e.period_actual : e.actual)}</td>
            ${historical ? `<td class="num" style="color:var(--text-muted)">${fmtNum(e.actual)}</td>` : ''}
            <td class="num ${e.overtime > 0 ? 'num-pos' : 'num-zero'}">${e.overtime > 0 ? '+' + fmtNum(e.overtime) : '0'}</td>
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
  openModal({
    title: e.name,
    sub: `${state.range.from} 至 ${state.range.to}`,
    body: `
      <div class="summary-grid">
        <div class="summary-item"><div class="k">应出勤</div><div class="v">${fmtNum(e.expected)}</div></div>
        <div class="summary-item"><div class="k">已出勤</div><div class="v">${fmtNum(e.actual)}</div></div>
        <div class="summary-item"><div class="k">加班</div><div class="v num-pos">${e.overtime > 0 ? '+' + fmtNum(e.overtime) : '0'}</div></div>
        <div class="summary-item"><div class="k">欠班</div><div class="v num-neg">${e.owe > 0 ? fmtNum(e.owe) : '0'}</div></div>
      </div>
      <div class="hint-box" style="margin-bottom:14px">
        自动差额 <b>${e.net > 0 ? '+' : ''}${fmtNum(e.net)}</b> 班（排班 ${fmtNum(e.scheduled)} + 补出勤 ${fmtNum(e.manual_attend)} − 应出勤 ${fmtNum(e.expected)}）<br>
        手工调整：加班 +${fmtNum(e.manual_overtime)}，欠班 −${fmtNum(e.manual_owe)}
      </div>
      <h4 style="font-size:13px;margin-bottom:8px">手工调整记录</h4>
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
          <label>数量（班）</label>
          <input class="input" id="adjAmount" type="number" step="0.5" value="1" min="0">
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
        「补出勤」计入已出勤，可直接抵消欠班；「加班」「欠班」直接加减最终净值。
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
  const { employees, shifts } = state;
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
  const codeColor = shiftByCode();

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
        <button class="btn sm ghost" id="copyPrev">复制上周</button>
      </div>
      ${state.bulkMode ? `
        <div class="sched-toolbar" style="background:var(--accent-soft);border-bottom:1px solid var(--border)">
          <span class="chip" id="selCount">已选 ${state.selected.size} 格</span>
          <span style="color:var(--text-muted);font-size:12.5px">选中后点班次应用到全部：</span>
          ${shifts.map((s) => `<button class="btn sm" data-bulk-shift="${s.code}">
            <span style="width:9px;height:9px;border-radius:2px;background:${s.color};display:inline-block"></span>${esc(s.name)}
          </button>`).join('')}
          <button class="btn sm danger" data-bulk-shift="__clear">清除</button>
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
              <tr>
                <td class="name-col"><span class="name-cell"><span class="avatar">${esc(initials(emp.name))}</span>${esc(emp.name)}</span></td>
                ${dayList.map((d) => {
                  const list = assigns[d.date + '|' + emp.id] || [];
                  const selKey = d.date + '|' + emp.id;
                  return `<td class="${d.isWork ? '' : 'weekend'}">
                    <div class="cell ${list.length ? 'filled' : ''} ${state.selected.has(selKey) ? 'sel' : ''}"
                         data-date="${d.date}" data-emp="${emp.id}"
                         title="${esc(list.map((a) => (codeColor[a.shift_code] || {}).name || a.shift_code).join('、') || '未排班')}">
                      ${list.length
                        ? list.map((a) => `<span class="shift-tag" style="background:${shiftColor(a.shift_code)}">${esc((codeColor[a.shift_code] || {}).name || a.shift_code)}</span>`).join('')
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
  $$('[data-bulk-shift]', main).forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.selected.size) { toast('先选择格子', true); return; }
      const code = btn.dataset.bulkShift;
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
            body: code === '__clear'
              ? { action: 'clear', dates: [date], employee_ids: ids }
              : { action: 'set', dates: [date], employee_ids: ids, shift_code: code, replace: true },
          });
        }
        toast(code === '__clear' ? `已清除 ${groups.length} 格` : `已排班 ${groups.length} 格`);
        state.selected.clear();
        renderMonth();
      } catch (e) { toast(e.message, true); }
    });
  });

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

function openShiftPicker(date, empId) {
  const emp = empById()[empId];
  const list = (state.schedule.assignments || []).filter(
    (a) => a.date === date && a.employee_id === empId);
  const d = parseISO(date);
  openModal({
    title: `${emp ? emp.name : ''} · ${date.slice(5)} ${weekdayCN(d)}`,
    sub: '选择班次',
    body: `
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${state.shifts.map((s) => `
          <button class="btn" data-pick="${s.code}" style="height:44px;min-width:96px;justify-content:flex-start">
            <span style="width:10px;height:10px;border-radius:3px;background:${s.color};display:inline-block"></span>
            ${esc(s.name)}${Number(s.weight) !== 1 ? `<span style="color:var(--text-muted);font-size:11.5px">×${fmtNum(s.weight)}</span>` : ''}
            ${list.some((a) => a.shift_code === s.code) ? '<span style="margin-left:6px;color:var(--accent)">✓</span>' : ''}
          </button>`).join('')}
        <button class="btn" data-pick="__clear" style="height:44px;min-width:96px;justify-content:flex-start;color:var(--critical)">清除</button>
      </div>
      <div class="hint-box" style="margin-top:16px">
        同一天可以排多个班次（如白班 + 中班），每个班次按权重计入出勤。
      </div>
    `,
    footer: `<button class="btn" data-close>关闭</button>`,
    onMount: (root, close) => {
      $$('[data-pick]', root).forEach((btn) => btn.addEventListener('click', async () => {
        const code = btn.dataset.pick;
        try {
          if (code === '__clear') {
            await api(`/schedule?date=${date}&employee_id=${empId}`, { method: 'DELETE' });
          } else {
            const exists = list.some((a) => a.shift_code === code);
            if (exists) {
              await api(`/schedule?date=${date}&employee_id=${empId}&shift_code=${code}`, { method: 'DELETE' });
            } else {
              await api('/schedule', { method: 'POST', body: { date, employee_id: empId, shift_code: code } });
            }
          }
          close();
          renderMonth();
        } catch (e) { toast(e.message, true); }
      }));
    },
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
              await api('/schedule', { method: 'POST', body: { date, employee_id: a.employee_id, shift_code: a.shift_code, source: 'copy' } });
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
  const assigns = state.schedule.assignments.filter((a) => a.date === target);
  const byShift = {};
  for (const s of state.shifts) byShift[s.code] = [];
  for (const a of assigns) (byShift[a.shift_code] = byShift[a.shift_code] || []).push(a);
  const stats = state.dayStats;

  main.innerHTML = `
    <div class="range-bar" style="justify-content:space-between">
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
      <span class="chip">出勤 <b style="margin-left:4px">${assigns.length}</b> 人次</span>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head">
        <h2>${isToday ? '今日排班' : '当日排班'}</h2>
        <span class="sub">${target} ${weekdayCN(d)}</span>
        <div class="spacer"></div>
      </div>
      <div class="card-body">
        <div class="shift-columns">
          ${state.shifts.map((s) => {
            const list = byShift[s.code] || [];
            return `
            <div class="shift-col">
              <div class="shift-col-head">
                <span style="width:10px;height:10px;border-radius:3px;background:${s.color}"></span>
                ${esc(s.name)}
                <span class="count">${list.length} 人</span>
              </div>
              <div class="person-list">
                ${list.length ? list.map((a) => {
                  const e = empById()[a.employee_id] || { name: a.name };
                  return `<div class="person-item" data-go-emp="${a.employee_id}">
                    <span class="avatar">${esc(initials(e.name))}</span>
                    <span>${esc(e.name)}</span>
                    ${a.note ? `<span class="meta">${esc(a.note)}</span>` : ''}
                  </div>`;
                }).join('') : '<div class="person-empty">无人排班</div>'}
                <button class="btn sm ghost" data-add-shift="${s.code}" style="margin-top:4px">+ 添加人员</button>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>当日出勤核对</h2><span class="sub">相对应出勤的实时差额</span></div>
      <div class="card-body">
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>姓名</th><th>今日班次</th><th class="num">今日班数</th><th class="num">当月加班</th><th class="num">当月欠班</th></tr></thead>
            <tbody>
              ${state.employees.map((e) => {
                const mine = assigns.filter((a) => a.employee_id === e.id);
                const st = (stats?.employees || []).find((s) => s.employee_id === e.id) || {};
                return `<tr>
                  <td><div class="name-cell"><span class="avatar">${esc(initials(e.name))}</span>${esc(e.name)}</div></td>
                  <td>${mine.length ? mine.map((a) => `<span class="shift-tag" style="background:${shiftColor(a.shift_code)}">${esc((shiftByCode()[a.shift_code] || {}).name || a.shift_code)}</span>`).join(' ') : '<span class="num-zero">休息</span>'}</td>
                  <td class="num">${fmtNum(mine.reduce((s, a) => s + Number((shiftByCode()[a.shift_code] || {}).weight || 1), 0))}</td>
                  <td class="num ${st.overtime > 0 ? 'num-pos' : 'num-zero'}">${st.overtime > 0 ? '+' + fmtNum(st.overtime) : '0'}</td>
                  <td class="num ${st.owe > 0 ? 'num-neg' : 'num-zero'}">${st.owe > 0 ? '−' + fmtNum(st.owe) : '0'}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  $('#prevDay').addEventListener('click', () => { state.dayCursor = addDays(state.dayCursor, -1); renderDay(); });
  $('#nextDay').addEventListener('click', () => { state.dayCursor = addDays(state.dayCursor, 1); renderDay(); });
  $('#todayBtn').addEventListener('click', () => { state.dayCursor = new Date(); renderDay(); });
  $$('[data-add-shift]').forEach((btn) => btn.addEventListener('click', () => {
    openAddPersonToShift(target, btn.dataset.addShift);
  }));
}

function openAddPersonToShift(date, shiftCode) {
  const assigned = new Set((state.schedule.assignments || [])
    .filter((a) => a.date === date && a.shift_code === shiftCode).map((a) => a.employee_id));
  openModal({
    title: `添加人员 · ${(shiftByCode()[shiftCode] || {}).name || shiftCode}`,
    sub: date,
    body: `<div style="display:flex;flex-wrap:wrap;gap:8px">
      ${state.employees.map((e) => `
        <button class="btn" data-add-emp="${e.id}" style="${assigned.has(e.id) ? 'border-color:var(--accent);color:var(--accent)' : ''}">
          ${assigned.has(e.id) ? '✓ ' : ''}${esc(e.name)}
        </button>`).join('')}
    </div>`,
    footer: `<button class="btn" data-close>完成</button>`,
    onMount: (root, close) => {
      $$('[data-add-emp]', root).forEach((btn) => btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.addEmp);
        try {
          if (assigned.has(id)) {
            await api(`/schedule?date=${date}&employee_id=${id}&shift_code=${shiftCode}`, { method: 'DELETE' });
            assigned.delete(id);
            btn.style.borderColor = ''; btn.style.color = ''; btn.textContent = empById()[id].name;
          } else {
            await api('/schedule', { method: 'POST', body: { date, employee_id: id, shift_code: shiftCode } });
            assigned.add(id);
            btn.style.borderColor = 'var(--accent)'; btn.style.color = 'var(--accent)';
            btn.textContent = '✓ ' + empById()[id].name;
          }
        } catch (e) { toast(e.message, true); }
      }));
      // 关闭弹窗后刷新今日视图
      root.querySelector('.modal-foot [data-close]')?.addEventListener('click', () => {
        setTimeout(() => renderDay(), 0);
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
                    ? `<span class="chip">固定 ${fmtNum(e.monthly_quota ?? 0)} 班/月</span>`
                    : '<span class="chip">跟随工作日历</span>'}</td>
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
        <div class="card-head">
          <h2>班次</h2>
          <div class="spacer"></div>
          <button class="btn sm" id="addShift">+ 班次</button>
        </div>
        <div class="card-body">
          ${state.shifts.map((s) => `
            <div class="adjust-item">
              <span class="legend-swatch" style="background:${s.color};width:12px;height:12px;border-radius:3px"></span>
              <span style="font-weight:600">${esc(s.name)}</span>
              <span class="note">记 ${fmtNum(s.weight)} 班</span>
              <button class="btn sm ghost del" data-edit-shift="${s.code}">编辑</button>
            </div>`).join('')}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>统计口径</h2></div>
        <div class="card-body">
          <div class="field" style="margin-bottom:14px">
            <label>统计起点</label>
            <input class="input" type="date" id="statsStart" value="${esc(state.settings.stats_start_date || '')}">
            <span style="font-size:12px;color:var(--text-muted)">
              此日之前的记录只累计「已上多少班」，不计应出勤和欠班。清洗历史表后从某天起用本 App 排班时设置。
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
          <button class="btn sm" id="saveStatsStart">保存统计起点</button>
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
  $('#addShift').addEventListener('click', () => openShiftModal(null));
  $$('[data-edit-shift]').forEach((b) => b.addEventListener('click', () => {
    openShiftModal(state.shifts.find((s) => s.code === b.dataset.editShift));
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
      state.settings = await api('/settings', {
        method: 'PUT', body: { stats_start_date: $('#statsStart').value || '' },
      });
      toast($('#statsStart').value ? '统计起点已保存' : '已清除统计起点');
    } catch (e) { toast(e.message, true); }
  });

  $('#btnBackup').addEventListener('click', downloadBackup);
  $('#btnRestore').addEventListener('click', openRestore);
  $('#btnImport2').addEventListener('click', openImportWizard);
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
            <option value="auto" ${emp?.expect_mode !== 'fixed' ? 'selected' : ''}>跟随工作日历（每天 1 班）</option>
            <option value="fixed" ${emp?.expect_mode === 'fixed' ? 'selected' : ''}>固定月度定额</option>
          </select>
        </div>
        <div class="field full" id="quotaField" style="display:${emp?.expect_mode === 'fixed' ? 'flex' : 'none'}">
          <label>每月应出勤班数</label>
          <input class="input" type="number" step="0.5" id="eQuota" value="${emp?.monthly_quota ?? 26}">
        </div>
        <div class="field full"><label>备注</label><input class="input" id="eNote" value="${esc(emp?.note || '')}"></div>
      </div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn primary" id="eSave">保存</button>`,
    onMount: (root, close) => {
      $('#eMode', root).addEventListener('change', (e) => {
        $('#quotaField', root).style.display = e.target.value === 'fixed' ? 'flex' : 'none';
      });
      $('#eSave', root).addEventListener('click', async () => {
        const body = {
          name: $('#eName', root).value.trim(),
          employee_no: $('#eNo', root).value.trim(),
          team: $('#eTeam', root).value.trim(),
          expect_mode: $('#eMode', root).value,
          monthly_quota: $('#eMode', root).value === 'fixed' ? Number($('#eQuota', root).value) : null,
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

function openShiftModal(shift) {
  const isNew = !shift;
  const palette = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
  openModal({
    title: isNew ? '新增班次' : '编辑班次',
    body: `
      <div class="form-grid">
        <div class="field"><label>班次代码 *</label>
          <input class="input" id="sCode" value="${esc(shift?.code || '')}" ${isNew ? '' : 'disabled'} placeholder="如 morning"></div>
        <div class="field"><label>显示名称 *</label>
          <input class="input" id="sName" value="${esc(shift?.name || '')}" placeholder="如 白班"></div>
        <div class="field"><label>记班系数</label>
          <input class="input" type="number" step="0.5" id="sWeight" value="${shift?.weight ?? 1}"></div>
        <div class="field"><label>颜色</label>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            ${palette.map((c) => `<button class="btn sm" data-color="${c}" style="width:30px;height:30px;padding:0;background:${c};border-color:${shift?.color === c ? 'var(--text-primary)' : 'transparent'}"></button>`).join('')}
          </div>
          <input type="hidden" id="sColor" value="${esc(shift?.color || palette[0])}">
        </div>
      </div>`,
    footer: `${isNew ? '' : '<button class="btn danger left" id="sDisable">停用班次</button>'}
      <button class="btn" data-close>取消</button><button class="btn primary" id="sSave">保存</button>`,
    onMount: (root, close) => {
      $$('[data-color]', root).forEach((b) => b.addEventListener('click', () => {
        $('#sColor', root).value = b.dataset.color;
        $$('[data-color]', root).forEach((x) => x.style.borderColor = 'transparent');
        b.style.borderColor = 'var(--text-primary)';
      }));
      $('#sSave', root).addEventListener('click', async () => {
        const body = {
          name: $('#sName', root).value.trim(),
          weight: Number($('#sWeight', root).value) || 1,
          color: $('#sColor', root).value,
        };
        if (!body.name) { toast('名称不能为空', true); return; }
        try {
          if (isNew) {
            body.code = $('#sCode', root).value.trim();
            if (!body.code) { toast('班次代码不能为空', true); return; }
            await api('/shifts', { method: 'POST', body });
          } else {
            await api(`/shifts/${shift.code}`, { method: 'PUT', body });
          }
          close();
          await loadBootstrap();
          renderPeople();
          toast('已保存');
        } catch (e) { toast(e.message, true); }
      });
      $('#sDisable', root)?.addEventListener('click', async () => {
        try {
          await api(`/shifts/${shift.code}`, { method: 'PUT', body: { active: 0 } });
          close();
          await loadBootstrap();
          renderPeople();
          toast('已停用');
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
        const shiftOpts = (selected) => `
          <option value="${ExcelParse.AUTO_HOURS}"${selected === ExcelParse.AUTO_HOURS ? ' selected' : ''}>按工时自动折算（8 小时 = 1 班）</option>
          ${state.shifts.map((sh) =>
            `<option value="${esc(sh.code)}"${sh.code === selected ? ' selected' : ''}>${esc(sh.name)}${Number(sh.weight) !== 1 ? `（${fmtNum(sh.weight)} 班）` : ''}</option>`
          ).join('')}`;
        wizBody.innerHTML = `
          <div class="summary-grid">
            <div class="summary-item"><div class="k">文件</div><div class="v" style="font-size:13px;word-break:break-all">${esc(s.filename || '—')}</div></div>
            <div class="summary-item"><div class="k">识别版式</div><div class="v" style="font-size:13px">${s.layouts.map((l) => ({ matrix_rows: '人员行', matrix_cols: '人员列', long: '长表', date_blocks: '按日分块' }[l.layout] || l.layout)).join('、')}</div></div>
            <div class="summary-item"><div class="k">日期跨度</div><div class="v" style="font-size:13px">${s.summary.dates.join(' ~ ') || '—'}</div></div>
            <div class="summary-item"><div class="k">人数</div><div class="v">${s.summary.people}</div></div>
            <div class="summary-item"><div class="k">记录数</div><div class="v">${s.summary.entries}</div></div>
          </div>

          <h4 style="font-size:13px;margin:0 0 4px">班次映射</h4>
          <p style="font-size:12.5px;color:var(--text-muted);margin:0 0 10px">
            左边是 Excel 里出现的原始标记，右边选择对应的班次。选「忽略」则不导入该标记。
          </p>
          <div id="mapList">
            ${s.tokens.map((t) => {
              const m = (s.token_meta || {})[t.token] || {};
              const auto = typeof ExcelParse !== 'undefined' ? ExcelParse.autoShiftForToken(t.token) : null;
              const hint = m.kind === 'work' && m.hours != null
                ? `${fmtNum(m.hours)} 小时${auto ? ` → ${fmtNum(auto.weight)} 班` : ''}`
                : m.kind === 'open' ? `${m.start || ''} 起到生产结束${auto ? ` → ${fmtNum(auto.weight)} 班` : ''}`
                : m.kind === 'other' ? '未能识别时间段'
                : m.note ? m.note : '';
              return `
              <div class="map-row">
                <div class="map-token">${esc(t.token)}<span class="cnt">${t.count} 次</span>
                  ${hint ? `<span class="cnt" style="color:var(--text-muted)">· ${esc(hint)}</span>` : ''}
                </div>
                <svg class="map-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>
                <select class="input map-select" data-token="${esc(t.token)}">
                  <option value="__skip__">— 忽略 —</option>
                  ${shiftOpts(s.mapping[t.token])}
                </select>
              </div>`;
            }).join('')}
          </div>

          <h4 style="font-size:13px;margin:20px 0 8px">人员匹配</h4>
          <div class="name-map-list">
            ${s.names.map((n) => `
              <div class="name-row">
                <span class="src">${esc(n.name)}</span>
                <span class="${n.exists ? 'badge-old' : 'badge-new'}">${n.exists ? '已存在' : '将新建'}</span>
              </div>`).join('')}
          </div>

          <div style="display:flex;flex-direction:column;gap:10px;margin-top:18px">
            <label class="switch"><input type="checkbox" id="optReplace" checked> 覆盖这些人这些日期已有的排班</label>
            <label class="switch"><input type="checkbox" id="optAutoCreate" checked> 自动创建未匹配的人员</label>
            <label class="switch"><input type="checkbox" id="optCreateShift"> 自动创建未映射的新班次</label>
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
      };

      // 进入步骤 3 前先收集选项（renderDone 会清空 DOM）
      let commitOptions = null;

      // ---- 步骤 3：完成
      const renderDone = async () => {
        const mapping = {};
        $$('.map-select', wizBody).forEach((sel) => { mapping[sel.dataset.token] = sel.value; });
        const opts = commitOptions || {
          replace: $('#optReplace')?.checked ?? true,
          auto_create: $('#optAutoCreate')?.checked ?? true,
          create_missing_shifts: $('#optCreateShift')?.checked ?? false,
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
                写入 ${res.inserted} 条排班 · 新建 ${res.employees_created} 人 · 新建 ${res.shifts_created} 个班次
                ${res.deleted ? ` · 覆盖 ${res.deleted} 条旧记录` : ''}${res.skipped ? ` · 跳过 ${res.skipped} 条` : ''}
              </p>
            </div>`;
          nextBtn.textContent = '完成';
          nextBtn.disabled = false;
          await loadBootstrap();
          toast('导入完成');
          setTimeout(() => {
            close();
            if (state.view === 'dashboard') renderDashboard();
            else if (state.view === 'month') renderMonth();
            else if (state.view === 'day') renderDay();
            else renderPeople();
          }, 900);
        } catch (e) {
          wizBody.innerHTML = `<div class="empty"><h3>导入失败</h3><p>${esc(e.message)}</p></div>`;
          nextBtn.disabled = false;
        }
      };

      nextBtn.addEventListener('click', () => {
        if (step === 0) { renderMapping(); setStep(1); }
        else if (step === 1) {
          commitOptions = {
            replace: $('#optReplace', wizBody)?.checked ?? true,
            auto_create: $('#optAutoCreate', wizBody)?.checked ?? true,
            create_missing_shifts: $('#optCreateShift', wizBody)?.checked ?? false,
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
          setTimeout(() => { close(); renderPeople(); }, 700);
        } catch (e) {
          status.innerHTML = `<span style="color:var(--critical)">${esc(e.message)}</span>`;
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
  const header = ['姓名', '班组', '应出勤', hist ? '本期出勤' : '已出勤'];
  if (hist) header.push('累计已上');
  header.push('加班', '欠班', '净值');
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
