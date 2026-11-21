/* ===================================================================
   导入 / 备份 / 恢复（浏览器端）
   班次概念已取消：Excel 里的每个标记折算成「工时」，可逐项修正。
   =================================================================== */
'use strict';

(function (root) {
  // 浏览器用全局对象，Node 测试里用 require
  const ids = () => (root.ExcelParse || (typeof require === 'function' ? require('./excel_parse.js') : null));
  const hoursOf = (token) => {
    const EP = ids();
    if (EP.suggestedHours) return EP.suggestedHours(token);
    const info = EP.parseTimeToken(token);
    return Number.isFinite(info.hours) && info.hours > 0 ? info.hours : 0;
  };
  const toISOToday = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function nextId(state, kind) {
    state.nextIds = state.nextIds || {};
    const v = Number(state.nextIds[kind]) || 1;
    state.nextIds[kind] = v + 1;
    return v;
  }

  /**
   * 预览：解析 + 人员匹配情况
   * 每个原始标记给出建议工时（算不出时间段的为 0，需手动填）
   */
  function preview(state, buffer, filename) {
    const EP = ids();
    const parsed = EP.parseWorkbook(buffer, filename);
    const tokens = parsed.tokens.map((t) => t.token);
    const meta = EP.tokenMeta(tokens);
    const suggest = {};
    for (const t of tokens) {
      const info = meta[t] || {};
      if (info.kind === 'rest') suggest[t] = '__skip__';
      else {
        const h = EP.suggestedHours ? EP.suggestedHours(t) : 0;
        suggest[t] = h > 0 ? h : 0;   // 0 = 认不出，需要用户填
      }
    }

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
      mapping: suggest,
      names,
      preview: parsed.preview,
      _entries: parsed.entries,
    };
  }

  /**
   * 同步提交（本地 API 在 mutate 内调用；不等待落盘）
   * opts: { mapping, replace, auto_create, name_map }
   *   mapping[原始标记] = 工时数字 | '__skip__'
   */
  function commitSync(state, staged, opts) {
    const mapping = { ...(opts.mapping || {}) };
    const stats = {
      inserted: 0, skipped: 0, employees_created: 0, deleted: 0,
    };

    const resolveHours = (raw, entry) => {
      const v = mapping[raw];
      if (v === '__skip__' || v === null || v === undefined || v === '') return null;
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return Math.round(n * 100) / 100;
      // 映射没填时，退回按时间段/班次名自动折算
      const auto = hoursOf(raw);
      return auto > 0 ? auto : null;
    };

    const stepOf = (raw) => {
      const info = ids().parseTimeToken(raw);
      return { start: info.start || '', end: info.end || '' };
    };

    // 人员解析
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

    // 先确定将被覆盖的 (日期, 人员)
    const touched = new Set();
    for (const e of staged._entries) {
      if (resolveHours(e.raw, e) === null) continue;
      const eid = resolveEmployee(e.name, e.employee_no || '', e.team || '');
      if (eid === null) continue;
      touched.add(`${e.date}|${eid}`);
    }

    if (opts.replace !== false && touched.size) {
      const before = state.assignments.length;
      state.assignments = state.assignments.filter((a) => !touched.has(`${a.date}|${a.employee_id}`));
      stats.deleted = before - state.assignments.length;
    }

    // 写入
    for (const e of staged._entries) {
      const hours = resolveHours(e.raw, e);
      if (hours === null) { stats.skipped++; continue; }
      const eid = resolveEmployee(e.name, e.employee_no || '', e.team || '');
      if (eid === null) { stats.skipped++; continue; }
      const step = stepOf(e.raw);
      state.assignments.push({
        id: nextId(state, 'assignment'),
        date: e.date,
        employee_id: eid,
        start: step.start,
        end: step.end,
        hours,
        content: e.note || '',
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
      version: state.version || 2,
      employees: state.employees,
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

  const api = {
    preview, commit: commitSync, commitSync, exportBackup, importBackup, toCsv,
    todayISO: toISOToday, nextId,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Importer = api;
})(typeof self !== 'undefined' ? self : this);
