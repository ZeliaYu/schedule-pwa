/* ===================================================================
   统计计算（工时口径）
   应出勤   统计起点之后、今天之前的工作日天数 × 每人每天标准工时
            （或该人的固定月度工时定额）
   已出勤   Σ 工作日排班工时 + 手工补出勤
   本期差额 = （本期已出勤）− 应出勤
   最终净值 = 本期差额 + 休息日工时 + 手工加班 + 手工欠班
   单位统一为「小时」
   =================================================================== */
'use strict';

(function (root) {
  const DEFAULT_DAILY_HOURS = 8;

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

  /** 每人每天标准工时 */
  function dailyHours(settings) {
    const v = Number(settings && settings.daily_hours);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_DAILY_HOURS;
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

  /** 单条排班的工时（优先用记录上的 hours，其次按时段推算） */
  function assignmentHours(a) {
    const h = Number(a && a.hours);
    if (Number.isFinite(h) && h > 0) return h;
    return hoursBetween(a && a.start, a && a.end);
  }

  /** 由 "HH:MM" 起止时间算工时，跨夜自动 +24h；算不出返回 0 */
  function hoursBetween(start, end) {
    const a = parseHHMM(start);
    const b = parseHHMM(end);
    if (a === null || b === null) return 0;
    let mins = b - a;
    if (mins <= 0) mins += 24 * 60;
    return Math.round((mins / 60) * 100) / 100;
  }

  function parseHHMM(v) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 24 || mi > 59) return null;
    return h * 60 + mi;
  }

  /** 区间统计 */
  function computeStats(state, fromISO, toISO, employeeIds, opts) {
    opts = opts || {};
    let start = fromISO, end = toISO;
    if (end < start) { const t = start; start = end; end = t; }

    const days = workdayMap(state, start, end);
    // 今天之后的日子不计入应出勤；测试可注入固定日期
    const today = opts.today || todayISO();
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

    const std = dailyHours(state.settings);

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
        actual: 0,            // 工作日工时（含起点前）
        by_day: {},           // 日期 -> 工时（全部排班）
        worked_days: new Set(),
        historical_actual: 0,
        historical_days: new Set(),
        manual_ot: 0,
        manual_owe: 0,
        manual_attend: 0,
        rest_overtime: 0,     // 休息日排班的工时（额外加班）
        rest_scheduled: 0,    // 同上，用于「累计已上」显示
        rest_days: new Set(),
        entries: [],          // 明细：{ date, start, end, hours, content }
        adjustments: [],
      });
    }

    for (const a of state.assignments || []) {
      if (a.date < start || a.date > end) continue;
      const agg = perEmp.get(a.employee_id);
      if (!agg) continue;
      const hours = assignmentHours(a);
      agg.by_day[a.date] = (agg.by_day[a.date] || 0) + hours;
      agg.worked_days.add(a.date);
      agg.entries.push({
        date: a.date,
        start: a.start || '',
        end: a.end || '',
        hours: Math.round(hours * 100) / 100,
        content: a.content || '',
        rest: !days[a.date],
      });

      if (a.date < countedFrom) {
        // 统计起点之前：只累计已上，不参与应出勤比较
        agg.actual += hours;
        agg.historical_actual += hours;
        agg.historical_days.add(a.date);
      } else if (!days[a.date]) {
        // 休息日上班：单独算加班，不计入「已出勤」以免重复计算
        agg.rest_overtime += hours;
        agg.rest_days.add(a.date);
        agg.rest_scheduled += hours;
      } else {
        agg.actual += hours;
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
      agg.entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }

    const workdayCount = (fromBound) => Object.entries(days)
      .filter(([d, v]) => v && d >= fromBound && isPast(d)).length;

    const totalWorkdays = workdayCount(countedFrom);
    const r2 = (x) => Math.round(x * 100) / 100;

    const out = [];
    for (const e of employees) {
      const agg = perEmp.get(e.id);
      const ownStd = Number(e.daily_hours) > 0 ? Number(e.daily_hours) : std;
      let expected;
      if (e.expect_mode === 'fixed' && e.monthly_quota !== null && e.monthly_quota !== undefined && e.monthly_quota !== '') {
        expected = Number(e.monthly_quota) * monthSpan;
      } else {
        expected = totalWorkdays * ownStd;
      }
      // agg.actual = 统计起点后工作日工时 + 起点前全部工时
      const periodActual = agg.actual - agg.historical_actual + agg.manual_attend;
      const actual = agg.actual + agg.rest_scheduled + agg.manual_attend;  // 累计已上（含休息日）
      const net = periodActual - expected;
      // 休息日上班单独算加班，再叠加到手工调整
      const restOT = agg.rest_overtime;
      const netFinal = net + restOT + agg.manual_ot + agg.manual_owe;
      out.push({
        employee_id: e.id,
        name: e.name,
        employee_no: e.employee_no || '',
        team: e.team || '',
        expect_mode: e.expect_mode || 'auto',
        daily_hours: ownStd,
        expected: r2(expected),
        actual: r2(actual),
        period_actual: r2(periodActual),
        historical_actual: r2(agg.historical_actual),
        historical_days: agg.historical_days.size,
        scheduled: r2(agg.actual),
        manual_attend: r2(agg.manual_attend),
        worked_days: agg.worked_days.size,
        rest_overtime: r2(restOT),
        rest_days: agg.rest_days.size,
        net: r2(net),
        net_final: r2(netFinal),
        auto_overtime: r2(Math.max(0, net)),
        auto_owe: r2(Math.max(0, -net)),
        manual_overtime: r2(agg.manual_ot),
        manual_owe: r2(Math.abs(agg.manual_owe)),
        overtime: r2(Math.max(0, netFinal)),
        owe: r2(Math.max(0, -netFinal)),
        by_day: Object.fromEntries(Object.entries(agg.by_day).map(([k, v]) => [k, r2(v)])),
        entries: agg.entries,
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
      daily_hours: std,
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

  /** 每日：人数与工时 */
  function dailySeries(state, fromISO, toISO) {
    const days = workdayMap(state, fromISO, toISO);
    const perDay = {};
    for (const d of Object.keys(days)) perDay[d] = { date: d, is_workday: days[d], people: 0, hours: 0 };
    const seen = {};
    for (const a of state.assignments || []) {
      const row = perDay[a.date];
      if (!row) continue;
      row.hours += assignmentHours(a);
      (seen[a.date] = seen[a.date] || new Set()).add(a.employee_id);
    }
    return Object.keys(perDay).sort().map((d) => {
      perDay[d].people = seen[d] ? seen[d].size : 0;
      perDay[d].hours = Math.round(perDay[d].hours * 100) / 100;
      return perDay[d];
    });
  }

  /** 人员 × 日期 工时矩阵 */
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
      const c = cellsMap[k] || (cellsMap[k] = { hours: 0, slots: [] });
      c.hours += assignmentHours(a);
      c.slots.push({
        start: a.start || '', end: a.end || '',
        hours: Math.round(assignmentHours(a) * 100) / 100,
        content: a.content || '',
      });
    }
    return {
      employees: emps,
      daily_hours: dailyHours(state.settings),
      days: Object.entries(days).map(([date, is_workday]) => ({ date, is_workday })),
      cells: Object.entries(cellsMap).map(([k, c]) => {
        const [e, d] = k.split('|');
        return {
          employee_id: Number(e), date: d,
          hours: Math.round(c.hours * 100) / 100, slots: c.slots,
        };
      }),
    };
  }

  const api = {
    computeStats, monthlySeries, dailySeries, heatmap,
    workdayMap, eachDay, isoOf, parseISO, addDays, todayISO,
    hiddenIds, visibleEmployees, dailyHours, assignmentHours, hoursBetween, parseHHMM,
    DEFAULT_DAILY_HOURS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Stats = api;
})(typeof self !== 'undefined' ? self : this);
