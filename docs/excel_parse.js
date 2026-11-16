/* ===================================================================
   Excel 排班表解析（浏览器端，基于 SheetJS）
   与 Python 版 excel_parse.py 同一套规则，支持 4 种版式：
     1. 人员行矩阵   工号 | 姓名 | 班组 | 1日 | 2日 …
     2. 人员列矩阵   日期 | 张三 | 李四 …
     3. 明细长表     日期 | 姓名 | 班次
     4. 按日分块     每天一个小表，日期只在块首
   =================================================================== */
'use strict';

(function (root) {
  const REST_WORDS = new Set([
    '休', '休息', '休班', '放假', '公休', '例休', '空', '无', '-', '—', '--', '/',
    '×', 'x', 'X', '0', 'OFF', 'off', 'Off', '公休日', '外出', '年假', '事假',
  ]);
  const NAME_KEYS = ['姓名', '名字', '员工', '员工姓名', '人员', '人员姓名'];
  const DATE_KEYS = ['日期', 'date', '日期(日)', '日', '天'];
  const SHIFT_KEYS = ['班次', '班型', '班别', 'shift', '班'];
  const NO_KEYS = ['工号', '编号', '员工编号', '员工号', '序号', 'employee_no'];
  const TEAM_KEYS = ['班组', '部门', '组别', 'team', '车间'];

  const FULL_DATE_RE = /^\s*(\d{4})[.\-/年]\s*(\d{1,2})[.\-/月]\s*(\d{1,2})\s*[日号]?\s*$/;
  const DAY_HEADER_RE = /^(?:(\d{1,2})[日号]?|(\d{1,2})\/(\d{1,2})|(\d{4})[-/.](\d{1,2})[-/.](\d{1,2}))$/;
  const TIME_RANGE_RE = /^\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*[-–—~至]\s*(.+)$/;
  const OPEN_END_WORDS = ['生产结束', '结束', '完', '下班', '过滤结束', '清洗结束'];
  const SKIP_NAME_RE = /合计|总计|小计|统计|备注|说明/;

  const AUTO_HOURS = '__auto_hours__';
  const HOURS_PER_SHIFT = 8;
  const WEIGHT_SHIFT_NAMES = {
    0.5: { code: 'half', name: '半班', color: '#1baf7a' },
    1.0: { code: 'morning', name: '白班', color: '#2a78d6' },
    1.5: { code: 'long15', name: '一点五班', color: '#eda100' },
    2.0: { code: 'double', name: '连班', color: '#4a3aa7' },
  };

  // ------------------------------------------------------------ 基础工具
  function clean(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date && !isNaN(v)) {
      const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    if (typeof v === 'number' && Number.isInteger(v)) return String(v);
    return String(v).trim();
  }
  const norm = (v) => clean(v).replace(/[ 　]/g, '').toLowerCase();
  const lowerSet = (keys) => new Set(keys.map((k) => norm(k)));

  function isRest(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    if (REST_WORDS.has(t) || REST_WORDS.has(t.toLowerCase())) return true;
    return /^(休|假|公休|例休|空)+$/.test(t);
  }

  function splitTokens(val) {
    const parts = String(val || '').split(/[/、,，+＋\s]+/).map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : [String(val || '')];
  }

  function isoDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function parseDate(cell, year, month) {
    if (cell instanceof Date && !isNaN(cell)) return clean(cell);
    const t = clean(cell).replace(/\s/g, '');
    if (!t) return null;
    const m = DAY_HEADER_RE.exec(t);
    if (!m) return null;
    if (m[4]) return isoDate(+m[4], +m[5], +m[6]);
    if (m[2]) return isoDate(year, +m[2], +m[3]);
    if (m[1]) return isoDate(year, month, +m[1]);
    return null;
  }

  function findMonthContext(rows, defYear, defMonth) {
    for (const row of rows.slice(0, 8)) {
      for (const cell of row) {
        const t = clean(cell);
        if (!t) continue;
        const m = /(20\d{2})\s*[年\-/.]\s*(\d{1,2})/.exec(t);
        if (m && +m[2] >= 1 && +m[2] <= 12) return [+m[1], +m[2]];
      }
    }
    return [defYear, defMonth];
  }

  // ------------------------------------------------------------ 班次标记
  /** 解析班次标记：work / open / rest / other */
  function parseTimeToken(token) {
    const raw = String(token === null || token === undefined ? '' : token).trim();
    let t = raw.replace(/：/g, ':').replace(/；/g, ';').replace(/[－—–]/g, '-')
      .replace(/~/g, '-').replace(/至/g, '-').replace(/[\s　]/g, '').replace(/\n/g, '');
    t = t.replace(/-+$/, '');
    if (['', '/', '\\', '-', '休', '休息', '公休', '例休', '空白'].includes(t)) {
      return { kind: 'rest', hours: 0, start: null, label: raw };
    }
    for (const w of ['请假', '调休', '年假', '事假', '病假', '退休', '外出', '出差', '旷工']) {
      if (t.includes(w)) return { kind: 'rest', hours: 0, start: null, label: raw, note: w };
    }
    const m = TIME_RANGE_RE.exec(t);
    if (m) {
      const start = `${String(+m[1]).padStart(2, '0')}:${m[2]}`;
      const endRaw = m[3];
      if (OPEN_END_WORDS.some((w) => endRaw.includes(w))) {
        return { kind: 'open', hours: null, start, label: raw };
      }
      const m2 = /^(\d{1,2}):(\d{2})/.exec(endRaw);
      if (m2) {
        let a = +m[1] * 60 + +m[2];
        let b = +m2[1] * 60 + +m2[2];
        if (b <= a) b += 24 * 60;
        return { kind: 'work', hours: Math.round((b - a) / 60 * 100) / 100, start, label: raw };
      }
    }
    return { kind: 'other', hours: null, start: null, label: raw };
  }

  /** 按工时折算班次：8 小时 = 1 班，四舍五入到 0.5 班 */
  function autoShiftForToken(token) {
    const info = parseTimeToken(token);
    let weight;
    if (info.kind === 'work' && info.hours) weight = Math.round((info.hours / HOURS_PER_SHIFT) * 2) / 2;
    else if (info.kind === 'open') weight = 1;
    else return null;
    weight = Math.max(0.5, Math.min(weight, 4));
    const preset = WEIGHT_SHIFT_NAMES[weight];
    if (preset) return { ...preset, weight };
    return { code: 'w' + String(weight).replace('.', '_'), name: `${weight}班`, weight, color: '#898781' };
  }

  function tokenMeta(tokens) {
    const out = {};
    for (const t of tokens) {
      const i = parseTimeToken(t);
      out[t] = { kind: i.kind, hours: i.hours, start: i.start, note: i.note || '' };
    }
    return out;
  }

  /** token -> 班次代码 的建议映射 */
  function suggestMapping(tokens, shifts) {
    const byName = {};
    for (const s of shifts) {
      byName[norm(s.name)] = s.code;
      byName[norm(s.code)] = s.code;
    }
    const out = {};
    for (const t of tokens) {
      const key = norm(t);
      if (byName[key] !== undefined) { out[t] = byName[key]; continue; }
      const info = parseTimeToken(t);
      if (info.kind === 'rest') { out[t] = '__skip__'; continue; }
      if (autoShiftForToken(t)) { out[t] = AUTO_HOURS; continue; }
      let hit = null;
      for (const [name, code] of Object.entries(byName)) {
        if (name.length >= 2 && (key.includes(name) || name.includes(key))) { hit = code; break; }
      }
      out[t] = hit;
    }
    return out;
  }

  // ------------------------------------------------------------ 版式识别
  function parseSheet(rows, year, month) {
    // 0) 按日分块
    const blocks = findDateBlocks(rows);
    if (blocks.length) return parseDateBlocks(rows, blocks);

    // 1) 长表
    for (let hi = 0; hi < Math.min(rows.length, 15); hi++) {
      const keys = new Set((rows[hi] || []).map(norm));
      const hasDate = [...lowerSet(DATE_KEYS)].some((k) => keys.has(k));
      const hasShift = [...lowerSet(SHIFT_KEYS)].some((k) => keys.has(k));
      const hasName = [...lowerSet(NAME_KEYS)].some((k) => keys.has(k));
      if (hasDate && hasShift && hasName) return parseLong(rows, hi, year, month);
    }

    // 2) 人员行矩阵：某行 >=3 个日期表头
    let best = null;
    for (let hi = 0; hi < Math.min(rows.length, 15); hi++) {
      const dateCols = {};
      (rows[hi] || []).forEach((cell, ci) => {
        const iso = parseDate(cell, year, month);
        if (iso) dateCols[ci] = iso;
      });
      const n = Object.keys(dateCols).length;
      if (n >= 3 && (!best || n > Object.keys(best.dateCols).length)) best = { hi, dateCols };
    }
    if (best) return parseMatrixRows(rows, best.hi, best.dateCols);

    // 3) 人员列矩阵：表头是多个姓名，下面是日期
    for (let hi = 0; hi < Math.min(rows.length, 15); hi++) {
      const row = rows[hi] || [];
      const persons = [];
      row.forEach((cell, ci) => {
        if (ci === 0) return;
        const n = clean(cell);
        if (!n || parseDate(n, year, month)) return;
        persons.push([ci, n]);
      });
      if (persons.length >= 2 && hi + 1 < rows.length) {
        const next = rows[hi + 1] || [];
        if (next[0] && parseDate(next[0], year, month)) return parseMatrixCols(rows, hi, year, month);
      }
    }

    return { entries: [], names: [], tokens: [], layout: 'unrecognized' };
  }

  function findDateBlocks(rows) {
    const blocks = [];
    rows.forEach((row, i) => {
      if (!row || !row[0]) return;
      const m = FULL_DATE_RE.exec(clean(row[0]));
      if (!m) return;
      const keys = new Set(row.slice(1, 8).map(norm));
      const hasName = keys.has('姓名');
      const hasShift = [...lowerSet(SHIFT_KEYS)].some((k) => keys.has(k));
      if (!hasName || !hasShift) return;
      const iso = isoDate(+m[1], +m[2], +m[3]);
      if (iso) blocks.push([i, iso]);
    });
    return blocks;
  }

  function parseDateBlocks(rows, blocks) {
    const entries = [], names = [], tokenCount = {};
    const seen = new Set();
    for (let bi = 0; bi < blocks.length; bi++) {
      const [start, iso] = blocks[bi];
      const end = bi + 1 < blocks.length ? blocks[bi + 1][0] : rows.length;
      const header = (rows[start] || []).map(norm);
      const colOf = (keys, def) => {
        const targets = lowerSet(keys);
        for (let ci = 0; ci < header.length; ci++) if (targets.has(header[ci])) return ci;
        return def;
      };
      const iName = colOf(NAME_KEYS, 2);
      const iShift = colOf(SHIFT_KEYS, 3);
      const iNote = colOf(['工作内容', '内容', '备注'], iShift + 1);

      for (let r = start + 1; r < end; r++) {
        const row = rows[r];
        if (!row) continue;
        const name = clean(row[iName]);
        if (!name || ['姓名', '合计', '总计'].includes(name) || FULL_DATE_RE.test(name)) continue;
        const raw = clean(row[iShift]);
        const note = iNote !== null && iNote < row.length ? clean(row[iNote]) : '';
        const info = parseTimeToken(raw);
        if (info.kind === 'rest') continue;
        const key = `${iso}|${name}|${raw}|${note}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({
          date: iso, name, raw, employee_no: '', team: '',
          kind: info.kind, hours: info.hours, note,
        });
        tokenCount[raw] = (tokenCount[raw] || 0) + 1;
        if (!names.includes(name)) names.push(name);
      }
    }
    return { entries, names, tokens: Object.keys(tokenCount), layout: 'date_blocks' };
  }

  function parseLong(rows, hi, year, month) {
    const header = (rows[hi] || []).map(norm);
    const colOf = (keys) => {
      const targets = lowerSet(keys);
      for (let i = 0; i < header.length; i++) if (targets.has(header[i])) return i;
      return null;
    };
    const iDate = colOf(DATE_KEYS), iShift = colOf(SHIFT_KEYS), iName = colOf(NAME_KEYS);
    const iNo = colOf(NO_KEYS), iTeam = colOf(TEAM_KEYS);
    const entries = [], names = [], tokenCount = {};
    const cell = (row, i) => (i !== null && i < row.length ? clean(row[i]) : '');

    for (let r = hi + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const iso = parseDate(cell(row, iDate), year, month);
      const name = cell(row, iName);
      const shift = cell(row, iShift);
      if (!iso || !name || isRest(shift) || SKIP_NAME_RE.test(name)) continue;
      for (const part of splitTokens(shift)) {
        entries.push({ date: iso, name, raw: part, employee_no: cell(row, iNo), team: cell(row, iTeam) });
        tokenCount[part] = (tokenCount[part] || 0) + 1;
      }
      if (!names.includes(name)) names.push(name);
    }
    return { entries, names, tokens: Object.keys(tokenCount), layout: 'long' };
  }

  function parseMatrixRows(rows, hi, dateCols) {
    const header = rows[hi] || [];
    let nameCol = null;
    const nameKeys = lowerSet(NAME_KEYS);
    header.forEach((cell, ci) => {
      if (ci in dateCols) return;
      if (nameKeys.has(norm(cell)) && nameCol === null) nameCol = ci;
    });
    if (nameCol === null) {
      nameCol = header.findIndex((cell, ci) => !(ci in dateCols) && clean(cell)) ?? 0;
      if (nameCol < 0) nameCol = 0;
    }
    let noCol = null, teamCol = null;
    header.forEach((cell, ci) => {
      if (ci in dateCols) return;
      const k = norm(cell);
      if (lowerSet(NO_KEYS).has(k)) noCol = ci;
      else if (lowerSet(TEAM_KEYS).has(k)) teamCol = ci;
    });

    const entries = [], names = [], tokenCount = {};
    for (let r = hi + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      if (nameCol >= row.length) continue;
      const name = clean(row[nameCol]);
      if (!name || SKIP_NAME_RE.test(name)) continue;
      if (lowerSet([...NAME_KEYS, ...DATE_KEYS]).has(norm(name))) continue;
      let added = false;
      for (const [ci, iso] of Object.entries(dateCols)) {
        const c = Number(ci);
        if (c >= row.length) continue;
        const val = clean(row[c]);
        if (isRest(val)) continue;
        for (const part of splitTokens(val)) {
          entries.push({
            date: iso, name, raw: part,
            employee_no: noCol !== null && noCol < row.length ? clean(row[noCol]) : '',
            team: teamCol !== null && teamCol < row.length ? clean(row[teamCol]) : '',
          });
          tokenCount[part] = (tokenCount[part] || 0) + 1;
          added = true;
        }
      }
      if (added && !names.includes(name)) names.push(name);
    }
    return { entries, names, tokens: Object.keys(tokenCount), layout: 'matrix_rows' };
  }

  function parseMatrixCols(rows, hi, year, month) {
    const row = rows[hi] || [];
    const persons = [];
    row.forEach((cell, ci) => {
      if (ci === 0) return;
      const n = clean(cell);
      if (n && !parseDate(n, year, month)) persons.push([ci, n]);
    });
    const entries = [], tokenCount = {};
    for (let r = hi + 1; r < rows.length; r++) {
      const line = rows[r] || [];
      if (!line.length) continue;
      const iso = parseDate(line[0], year, month);
      if (!iso) continue;
      for (const [ci, name] of persons) {
        if (ci >= line.length) continue;
        const val = clean(line[ci]);
        if (isRest(val)) continue;
        for (const part of splitTokens(val)) {
          entries.push({ date: iso, name, raw: part, employee_no: '', team: '' });
          tokenCount[part] = (tokenCount[part] || 0) + 1;
        }
      }
    }
    return { entries, names: persons.map((p) => p[1]), tokens: Object.keys(tokenCount), layout: 'matrix_cols' };
  }

  // ------------------------------------------------------------ 入口
  /**
   * 解析工作簿
   * @param {ArrayBuffer} buffer
   * @param {string} filename
   * @param {number} defYear
   * @param {number} defMonth
   */
  function parseWorkbook(buffer, filename, defYear, defMonth) {
    if (typeof XLSX === 'undefined') throw new Error('SheetJS 未加载');
    const now = new Date();
    defYear = defYear || now.getFullYear();
    defMonth = defMonth || now.getMonth() + 1;

    let wb;
    try {
      wb = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true });
    } catch (e) {
      throw new Error('无法读取 Excel 文件：' + (e && e.message ? e.message : e));
    }

    const sheets = [];
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      let rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: false });
      rows = rows.filter((r) => Array.isArray(r) && r.some((c) => clean(c)));
      if (!rows.length) continue;
      const [year, month] = findMonthContext(rows, defYear, defMonth);
      const parsed = parseSheet(rows, year, month);
      if (parsed.entries.length) {
        parsed.sheet = name;
        parsed.year = year;
        parsed.month = month;
        sheets.push(parsed);
      }
    }

    if (!sheets.length) throw new Error('没能从文件中识别出排班数据。请确认表中有「姓名」列和日期列。');

    const entries = [], names = [], tokenCount = {}, layouts = [], dateSet = new Set();
    const seen = new Set();
    for (const s of sheets) {
      for (const e of s.entries) {
        const key = `${e.date}|${e.name}|${e.raw}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(e);
        dateSet.add(e.date);
        tokenCount[e.raw] = (tokenCount[e.raw] || 0) + 1;
        if (!names.includes(e.name)) names.push(e.name);
      }
      layouts.push({
        sheet: s.sheet, layout: s.layout, count: s.entries.length,
        month: `${s.year}-${String(s.month).padStart(2, '0')}`,
      });
    }

    entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name < b.name ? -1 : 1));
    const dates = [...dateSet].sort();
    const tokens = Object.entries(tokenCount)
      .sort((a, b) => b[1] - a[1])
      .map(([token, count]) => ({ token, count }));

    return {
      filename: filename || '',
      layouts,
      dates,
      names,
      tokens,
      entries,
      token_meta: tokenMeta(tokens.map((t) => t.token)),
      preview: entries.slice(0, 300),
    };
  }

  const api = {
    parseWorkbook, parseTimeToken, autoShiftForToken, tokenMeta, suggestMapping,
    isRest, splitTokens, clean, AUTO_HOURS, HOURS_PER_SHIFT, WEIGHT_SHIFT_NAMES,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ExcelParse = api;
})(typeof self !== 'undefined' ? self : this);
