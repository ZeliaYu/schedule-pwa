/* ===================================================================
   导入 / 备份 / 恢复（浏览器端）
   =================================================================== */
'use strict';

(function (root) {
  // 浏览器用全局对象，Node 测试里用 require
  const ids = () => (root.ExcelParse || (typeof require === 'function' ? require('./excel_parse.js') : null));
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function nextId(state, kind) {
    state.nextIds = state.nextIds || {};
    const v = Number(state.nextIds[kind]) || 1;
    state.nextIds[kind] = v + 1;
    return v;
  }

  /** 预览：解析 + 人员匹配情况 */
  function preview(state, buffer, filename) {
    const EP = ids();
    const parsed = EP.parseWorkbook(buffer, filename);
    const tokens = parsed.tokens.map((t) => t.token);
    const mapping = EP.suggestMapping(tokens, state.shifts.filter((s) => s.active !== 0));
    const meta = EP.tokenMeta(tokens);

    const byName = new Map();
    const byNo = new Map();
    for (const e of state.employees) {
      byName.set(String(e.name).trim(), e);
      if (e.employee_no) byNo.set(String(e.employee_no).trim(), e);
    }
    const names = parsed.names.map((n) => {
      const hit = byName.get(String(n).trim());
      return { name: n, employee_id: hit ? hit.id : null, exists: !!hit };
    });

    return {
      token: 'local',
      filename: parsed.filename,
      layouts: parsed.layouts,
      summary: {
        dates: parsed.dates.length ? [parsed.dates[0], parsed.dates[parsed.dates.length - 1]] : [],
        date_count: parsed.dates.length,
        people: parsed.names.length,
        entries: parsed.entries.length,
        token_count: tokens.length,
      },
      tokens: parsed.tokens,
      token_meta: meta,
      mapping,
      names,
      preview: parsed.preview,
      _entries: parsed.entries,
    };
  }

  /**
   * 提交导入
   * opts: { mapping, replace, auto_create, create_missing_shifts, name_map }
   */
  /** 同步提交（本地 API 在 mutate 内调用；不等待落盘） */
  function commitSync(state, staged, opts) {
    const EP = ids();
    const mapping = { ...(opts.mapping || {}) };
    const stats = {
      inserted: 0, skipped: 0, employees_created: 0, shifts_created: 0, deleted: 0,
    };

    // 1) 时间段标记 -> 按工时折算的新班次
    const tokenShift = {};
    for (const [raw, code] of Object.entries(mapping)) {
      if (code !== EP.AUTO_HOURS) continue;
      const spec = EP.autoShiftForToken(raw);
      if (!spec) { mapping[raw] = '__skip__'; continue; }
      tokenShift[raw] = spec.code;
      if (!state.shifts.some((s) => s.code === spec.code)) {
        state.shifts.push({
          code: spec.code, name: spec.name, weight: spec.weight, color: spec.color,
          sort_order: 60 + Math.round(spec.weight * 10), active: 1,
        });
        stats.shifts_created++;
      }
    }
    for (const [raw, code] of Object.entries(tokenShift)) mapping[raw] = code;

    // 2) 未映射但勾选自动创建 -> 用原始标记当名称
    for (const [raw, code] of Object.entries(mapping)) {
      if (code === '__skip__' || code === null || code === EP.AUTO_HOURS) continue;
      if (state.shifts.some((s) => s.code === code)) continue;
      if (!opts.create_missing_shifts) {
        throw new Error(`班次代码「${code}」不存在，请先创建或勾选自动创建`);
      }
      state.shifts.push({
        code, name: raw, weight: 1, color: '#898781', sort_order: 500, active: 1,
      });
      stats.shifts_created++;
    }

    // 3) 人员解析
    const empsByName = new Map();
    const empsByNo = new Map();
    for (const e of state.employees) {
      empsByName.set(String(e.name).trim(), e);
      if (e.employee_no) empsByNo.set(String(e.employee_no).trim(), e);
    }
    const nameMap = opts.name_map || {};

    const resolveEmployee = (rawName, empNo, team) => {
      const mapped = nameMap[rawName];
      if (mapped === '__skip__') return null;
      const target = String(mapped || rawName).trim();
      if (!target) return null;
      if (empsByName.has(target)) return empsByName.get(target).id;
      if (empNo && empsByNo.has(empNo)) {
        const e = empsByNo.get(empNo);
        empsByName.set(target, e);
        return e.id;
      }
      if (!opts.auto_create) return null;
      const emp = {
        id: nextId(state, 'employee'),
        name: target,
        employee_no: empNo || '',
        team: team || '',
        expect_mode: 'auto',
        monthly_quota: null,
        active: 1,
        sort_order: 999,
        note: '',
      };
      state.employees.push(emp);
      empsByName.set(target, emp);
      if (empNo) empsByNo.set(empNo, emp);
      stats.employees_created++;
      return emp.id;
    };

    // 4) 先确定将被覆盖的 (日期, 人员)
    const touched = new Set();
    for (const e of staged._entries) {
      const code = mapping[e.raw];
      if (code === null || code === undefined || code === '__skip__') continue;
      const eid = resolveEmployee(e.name, e.employee_no || '', e.team || '');
      if (eid === null) continue;
      touched.add(`${e.date}|${eid}`);
    }

    if (opts.replace !== false && touched.size) {
      const before = state.assignments.length;
      state.assignments = state.assignments.filter((a) => !touched.has(`${a.date}|${a.employee_id}`));
      stats.deleted = before - state.assignments.length;
    }

    // 5) 写入
    const exists = new Set(state.assignments.map((a) => `${a.date}|${a.employee_id}|${a.shift_code}`));
    for (const e of staged._entries) {
      const code = mapping[e.raw];
      if (code === null || code === undefined || code === '__skip__') { stats.skipped++; continue; }
      const eid = resolveEmployee(e.name, e.employee_no || '', e.team || '');
      if (eid === null) { stats.skipped++; continue; }
      const key = `${e.date}|${eid}|${code}`;
      if (exists.has(key)) { stats.skipped++; continue; }
      exists.add(key);
      state.assignments.push({
        id: nextId(state, 'assignment'),
        date: e.date,
        employee_id: eid,
        shift_code: code,
        note: '',
        source: 'import',
      });
      stats.inserted++;
    }

    return stats;
  }

  /** 导出完整备份 */
  function exportBackup(state) {
    return JSON.stringify({
      exported_at: new Date().toISOString().slice(0, 19),
      version: 1,
      employees: state.employees,
      shifts: state.shifts,
      assignments: state.assignments,
      adjustments: state.adjustments,
      calendarDays: state.calendarDays,
      settings: state.settings,
      nextIds: state.nextIds,
    }, null, 2);
  }

  /** 导入备份（校验基本结构） */
  function importBackup(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('文件不是有效的 JSON 备份');
    }
    if (!data || !Array.isArray(data.employees) || !Array.isArray(data.assignments)) {
      throw new Error('备份文件缺少必要字段（employees / assignments）');
    }
    return data;
  }

  /** 导出当前视图为 CSV（Excel 可打开） */
  function toCsv(rows) {
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
  }

  const api = { preview, commit: commitSync, commitSync, exportBackup, importBackup, toCsv, todayISO, nextId };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Importer = api;
})(typeof self !== 'undefined' ? self : this);
