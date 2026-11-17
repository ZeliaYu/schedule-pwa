/* ===================================================================
   统计计算（与 Python 版口径一致）
   应出勤   统计起点之后、今天之前的工作日天数（或固定月度定额）
   已出勤   Σ 排班记班系数 + 手工补出勤
   本期差额 = （已出勤 − 统计起点前的出勤）− 应出勤
   最终净值 = 本期差额 + 手工加班 + 手工欠班
   =================================================================== */
'use strict';

(function (root) {
  const DAY = 86400000;

  const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const parseISO = (s) => {
    const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const todayISO = () => isoOf(new Date());

  function eachDay(fromISO, toISO) {
    const out = [];
    let cur = parseISO(fromISO);
    const end = parseISO(toISO);
    while (cur <= end) { out.push(isoOf(cur)); cur = addDays(cur, 1); }
    return out;
  }

  function workWeekdays(settings) {
    const raw = String((settings && settings.work_weekdays) || '1,2,3,4,5');
    return new Set(raw.split(',').map((x) => x.trim()).filter((x) => x !== '').map(Number));
  }

  /** 日期 -> 是否工作日；单日覆盖优先 */
  function workdayMap(state, fromISO, toISO) {
    const weekdays = workWeekdays(state.settings);
    const map = {};
    for (const d of eachDay(fromISO, toISO)) {
      map[d] = weekdays.has(parseISO(d).getDay());
    }
    for (const [d, ov] of Object.entries(state.calendarDays || {})) {
      if (d >= fromISO && d <= toISO && ov && ov.is_workday !== null && ov.is_workday !== undefined) {
        map[d] = !!ov.is_workday;
      }
    }
    return map;
  }

  function activeShifts(state) {
    const all = state.shifts || [];
    const active = all.filter((s) => s.active !== 0);
    return active.length ? active : all;
  }

  /** 被屏蔽（不显示）的人员 id 集合 */
  function hiddenIds(state) {
    const raw = String((state.settings && state.settings.hidden_employee_ids) || '');
    return new Set(raw.split(',').map((x) => x.trim()).filter(Boolean).map(Number));
  }

  /** 可按需包含/排除被屏蔽人员 */
  function visibleEmployees(state, includeHidden) {
    const hidden = includeHidden ? new Set() : hiddenIds(state);
    return (state.employees || []).filter((e) => !hidden.has(e.id));
  }

  function shiftWeight(state, code) {
    const s = (state.shifts || []).find((x) => x.code === code);
    return s && Number.isFinite(Number(s.weight)) ? Number(s.weight) : 1;
  }

  /** 区间统计 */
  function computeStats(state, fromISO, toISO, employeeIds, opts) {
    opts = opts || {};
    let start = fromISO, end = toISO;
    if (end < start) { const t = start; start = end; end = t; }

    const days = workdayMap(state, start, end);
    const today = todayISO();
    const isPast = (d) => d <= today;

    // 统计起点
    const markerRaw = String((state.settings && state.settings.stats_start_date) || '').trim();
    let countedFrom = start;
    if (markerRaw && markerRaw > start) {
      countedFrom = markerRaw < end ? markerRaw : isoOf(addDays(parseISO(end), 1));
    }
    const historical = countedFrom > start;

    const employees = (state.employees || []).filter((e) =>
      (opts.includeInactive || e.active !== 0) &&
      (opts.includeHidden || !hiddenIds(state).has(e.id)) &&
      (!employeeIds || !employeeIds.length || employeeIds.includes(e.id)));

    const shiftRows = (state.shifts || []);
    const shiftMap = {};
    for (const s of shiftRows) shiftMap[s.code] = s;

    // 月初/月末跨越的自然月数（固定定额折算）
    const s0 = parseISO(start), e0 = parseISO(end);
    const monthSpan = (e0.getFullYear() - s0.getFullYear()) * 12 + (e0.getMonth() - s0.getMonth()) + 1;

    const perEmp = new Map();
    for (const e of employees) {
      perEmp.set(e.id, {
        employee_id: e.id,
        name: e.name,
        employee_no: e.employee_no || '',
        team: e.team || '',
        expect_mode: e.expect_mode || 'auto',
        actual: 0,
        by_shift: {},
        worked_days: new Set(),
        historical_actual: 0,
        historical_days: new Set(),
        manual_ot: 0,
        manual_owe: 0,
        manual_attend: 0,
        adjustments: [],
      });
    }

    for (const a of state.assignments || []) {
      if (a.date < start || a.date > end) continue;
      const agg = perEmp.get(a.employee_id);
      if (!agg) continue;
      const w = shiftMap[a.shift_code] ? Number(shiftMap[a.shift_code].weight) : 1;
      agg.actual += Number.isFinite(w) ? w : 1;
      agg.by_shift[a.shift_code] = (agg.by_shift[a.shift_code] || 0) + (Number.isFinite(w) ? w : 1);
      agg.worked_days.add(a.date);
      if (a.date < countedFrom) {
        agg.historical_actual += Number.isFinite(w) ? w : 1;
        agg.historical_days.add(a.date);
      }
    }

    for (const adj of state.adjustments || []) {
      if (adj.date < start || adj.date > end) continue;
      const agg = perEmp.get(adj.employee_id);
      if (!agg) continue;
      const amount = Number(adj.amount) || 0;
      if (adj.kind === 'overtime') agg.manual_ot += amount;
      else if (adj.kind === 'owe') agg.manual_owe += amount;
      else if (adj.kind === 'attend') agg.manual_attend += amount;
      agg.adjustments.push({
        id: adj.id, date: adj.date, kind: adj.kind, amount, note: adj.note || '',
      });
    }
    for (const agg of perEmp.values()) {
      agg.adjustments.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
    }

    const workdayCount = (fromBound) => Object.entries(days)
      .filter(([d, v]) => v && d >= fromBound && isPast(d)).length;

    const totalWorkdays = workdayCount(countedFrom);
    const r2 = (x) => Math.round(x * 100) / 100;

    const out = [];
    for (const e of employees) {
      const agg = perEmp.get(e.id);
      let expected;
      if (e.expect_mode === 'fixed' && e.monthly_quota !== null && e.monthly_quota !== undefined && e.monthly_quota !== '') {
        expected = Number(e.monthly_quota) * monthSpan;
      } else {
        expected = totalWorkdays;
      }
      const actual = agg.actual + agg.manual_attend;
      const periodActual = actual - agg.historical_actual;
      const net = periodActual - expected;
      const netFinal = net + agg.manual_ot + agg.manual_owe;
      out.push({
        employee_id: e.id,
        name: e.name,
        employee_no: e.employee_no || '',
        team: e.team || '',
        expect_mode: e.expect_mode || 'auto',
        expected: r2(expected),
        actual: r2(actual),
        period_actual: r2(periodActual),
        historical_actual: r2(agg.historical_actual),
        historical_days: agg.historical_days.size,
        scheduled: r2(agg.actual),
        manual_attend: r2(agg.manual_attend),
        worked_days: agg.worked_days.size,
        net: r2(net),
        net_final: r2(netFinal),
        auto_overtime: r2(Math.max(0, net)),
        auto_owe: r2(Math.max(0, -net)),
        manual_overtime: r2(agg.manual_ot),
        manual_owe: r2(Math.abs(agg.manual_owe)),
        overtime: r2(Math.max(0, netFinal)),
        owe: r2(Math.max(0, -netFinal)),
        by_shift: Object.fromEntries(Object.entries(agg.by_shift).map(([k, v]) => [k, r2(v)])),
        adjustments: agg.adjustments,
      });
    }

    out.sort((a, b) => {
      const ea = (state.employees.find((x) => x.id === a.employee_id) || {});
      const eb = (state.employees.find((x) => x.id === b.employee_id) || {});
      return (ea.sort_order || 0) - (eb.sort_order || 0) || a.employee_id - b.employee_id;
    });

    const sum = (k) => r2(out.reduce((acc, x) => acc + x[k], 0));
    return {
      range: { from: start, to: end },
      counted_from: countedFrom,
      historical,
      workdays: totalWorkdays,
      days: Object.entries(days).map(([date, is_workday]) => ({ date, is_workday })),
      employees: out,
      totals: {
        expected: sum('expected'),
        actual: sum('actual'),
        period_actual: sum('period_actual'),
        historical_actual: sum('historical_actual'),
        overtime: sum('overtime'),
        owe: sum('owe'),
        people: out.length,
        workdays: totalWorkdays,
      },
      shifts: shiftMap,
    };
  }

  /** 按月拆分，用于趋势图 */
  function monthlySeries(state, fromISO, toISO, employeeIds, opts) {
    opts = opts || {};
    const out = [];
    let cur = new Date(parseISO(fromISO).getFullYear(), parseISO(fromISO).getMonth(), 1);
    const end = parseISO(toISO);
    while (cur <= end) {
      const y = cur.getFullYear(), m = cur.getMonth();
      const mStart = new Date(y, m, 1);
      const mEnd = new Date(y, m + 1, 0);
      const from = isoOf(mStart) < fromISO ? fromISO : isoOf(mStart);
      const to = isoOf(mEnd) > toISO ? toISO : isoOf(mEnd);
      const res = computeStats(state, from, to, employeeIds, opts);
      out.push({
        month: `${y}-${String(m + 1).padStart(2, '0')}`,
        from, to,
        totals: res.totals,
        employees: res.employees,
      });
      cur = new Date(y, m + 1, 1);
    }
    return out;
  }

  /** 每日：人数与班次分布 */
  function dailySeries(state, fromISO, toISO) {
    const days = workdayMap(state, fromISO, toISO);
    const shiftMap = {};
    for (const s of state.shifts || []) shiftMap[s.code] = s;
    const perDay = {};
    for (const d of Object.keys(days)) perDay[d] = { date: d, is_workday: days[d], people: 0, shifts: {} };
    const seen = {};
    for (const a of state.assignments || []) {
      if (!perDay[a.date]) continue;
      const w = shiftMap[a.shift_code] ? Number(shiftMap[a.shift_code].weight) : 1;
      perDay[a.date].shifts[a.shift_code] = (perDay[a.date].shifts[a.shift_code] || 0) + w;
      (seen[a.date] = seen[a.date] || new Set()).add(a.employee_id);
    }
    return Object.keys(perDay).sort().map((d) => {
      perDay[d].people = seen[d] ? seen[d].size : 0;
      return perDay[d];
    });
  }

  /** 人员 × 日期 班次矩阵 */
  function heatmap(state, fromISO, toISO) {
    const hidden = hiddenIds(state);
    const emps = (state.employees || [])
      .filter((e) => e.active !== 0 && !hidden.has(e.id))
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id)
      .map((e) => ({ id: e.id, name: e.name }));
    const days = workdayMap(state, fromISO, toISO);
    const cellsMap = {};
    for (const a of state.assignments || []) {
      if (a.date < fromISO || a.date > toISO) continue;
      const k = a.employee_id + '|' + a.date;
      (cellsMap[k] = cellsMap[k] || []).push(a.shift_code);
    }
    const shiftMap = {};
    for (const s of state.shifts || []) shiftMap[s.code] = s;
    return {
      employees: emps,
      shifts: shiftMap,
      days: Object.entries(days).map(([date, is_workday]) => ({ date, is_workday })),
      cells: Object.entries(cellsMap).map(([k, shifts]) => {
        const [e, d] = k.split('|');
        return { employee_id: Number(e), date: d, shifts };
      }),
    };
  }

  const api = {
    computeStats, monthlySeries, dailySeries, heatmap,
    workdayMap, eachDay, isoOf, parseISO, addDays, todayISO, activeShifts, shiftWeight,
    hiddenIds, visibleEmployees,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Stats = api;
})(typeof self !== 'undefined' ? self : this);
