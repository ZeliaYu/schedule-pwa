/* ===================================================================
   本地 API 层
   与 FastAPI 后端接口同形，把请求转成本地状态读写。
   这样界面代码不需要关心数据存在哪里。
   =================================================================== */
'use strict';

(function (root) {
  const qs = (path) => {
    const i = path.indexOf('?');
    return i < 0 ? [path, {}] : [path.slice(0, i), Object.fromEntries(new URLSearchParams(path.slice(i + 1)))];
  };

  function createApi(store) {
    const Stats = root.Stats;
    const Importer = root.Importer;

    const activeShifts = () => (store.state.shifts || [])
      .filter((s) => s.active !== 0)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const allShifts = () => (store.state.shifts || [])
      .slice()
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const activeEmps = () => (store.state.employees || [])
      .filter((e) => e.active !== 0)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
    /** 全部在职人员（含被屏蔽的），带 hidden 标记 */
    const allActiveEmps = () => {
      const hidden = Stats.hiddenIds(store.state);
      return activeEmps().map((e) => ({ ...e, hidden: hidden.has(e.id) }));
    };

    const err = (msg) => { throw new Error(msg); };

    async function handle(path, opts) {
      opts = opts || {};
      const method = (opts.method || 'GET').toUpperCase();
      const [route, q] = qs(path);
      const body = opts.body && !(opts.body instanceof FormData) ? opts.body : null;

      /* ---------------------------------------------------- 元信息 */
      if (route === '/bootstrap') {
        return {
          employees: allActiveEmps(),
          shifts: activeShifts(),
          settings: { ...store.state.settings },
          storage: { local: true },
        };
      }
      if (route === '/settings') {
        if (method === 'PUT') {
          await store.mutate((st) => {
            for (const [k, v] of Object.entries(body || {})) st.settings[k] = v === null ? '' : String(v);
          });
        }
        return { ...store.state.settings };
      }

      /* ---------------------------------------------------- 员工 */
      if (route === '/employees') {
        if (method === 'POST') {
          const name = String((body && body.name) || '').trim();
          if (!name) err('姓名不能为空');
          if (store.state.employees.some((e) => e.name === name)) err(`员工「${name}」已存在`);
          return store.mutate((st) => {
            const emp = {
              id: Importer.nextId(st, 'employee'),
              name,
              employee_no: (body.employee_no || '').trim(),
              team: (body.team || '').trim(),
              expect_mode: body.expect_mode || 'auto',
              monthly_quota: body.monthly_quota === undefined ? null : body.monthly_quota,
              active: 1,
              sort_order: Number(body.sort_order) || 0,
              note: (body.note || '').trim(),
            };
            st.employees.push(emp);
            return emp;
          });
        }
        const list = q.include_inactive ? store.state.employees.slice() : activeEmps();
        return JSON.parse(JSON.stringify(list));
      }
      const empMatch = /^\/employees\/(\d+)$/.exec(route);
      if (empMatch) {
        const id = Number(empMatch[1]);
        const emp = store.state.employees.find((e) => e.id === id);
        if (!emp) err('员工不存在');
        if (method === 'PUT') {
          if (body && 'name' in body && !String(body.name).trim()) err('姓名不能为空');
          if (body && body.name) {
            const dup = store.state.employees.find((e) => e.name === body.name && e.id !== id);
            if (dup) err('该姓名已存在');
          }
          return store.mutate(() => {
            for (const k of ['name', 'employee_no', 'team', 'expect_mode', 'monthly_quota', 'active', 'sort_order', 'note']) {
              if (k in body) emp[k] = body[k];
            }
            return JSON.parse(JSON.stringify(emp));
          });
        }
        if (method === 'DELETE') {
          const hard = q.hard === 'true';
          return store.mutate((st) => {
            if (hard) {
              st.employees = st.employees.filter((e) => e.id !== id);
              st.assignments = st.assignments.filter((a) => a.employee_id !== id);
              st.adjustments = st.adjustments.filter((a) => a.employee_id !== id);
            } else {
              emp.active = 0;
            }
            return { ok: true };
          });
        }
      }

      /* ---------------------------------------------------- 班次 */
      if (route === '/shifts') {
        if (method === 'POST') {
          const code = String((body && body.code) || '').trim();
          const name = String((body && body.name) || '').trim();
          if (!code || !name) err('班次代码和名称不能为空');
          if (store.state.shifts.some((s) => s.code === code)) err(`班次代码「${code}」已存在`);
          await store.mutate((st) => {
            st.shifts.push({
              code, name,
              weight: Number(body.weight) || 1,
              color: body.color || '#2a78d6',
              sort_order: Number(body.sort_order) || 100,
              active: 1,
            });
          });
          return JSON.parse(JSON.stringify(allShifts()));
        }
        if (q.include_inactive) return JSON.parse(JSON.stringify(allShifts()));
        return JSON.parse(JSON.stringify(activeShifts()));
      }
      const shiftMatch = /^\/shifts\/([^/]+)$/.exec(route);
      if (shiftMatch) {
        const code = decodeURIComponent(shiftMatch[1]);
        const shift = store.state.shifts.find((s) => s.code === code);
        if (!shift) err('班次不存在');
        if (method === 'PUT') {
          return store.mutate(() => {
            for (const k of ['name', 'weight', 'color', 'sort_order', 'active']) {
              if (k in body) shift[k] = k === 'weight' ? Number(body[k]) : body[k];
            }
            return JSON.parse(JSON.stringify(shift));
          });
        }
      }

      /* ---------------------------------------------------- 排班 */
      if (route === '/schedule') {
        if (method === 'GET') {
          const from = q.date_from, to = q.date_to;
          const rows = store.state.assignments
            .filter((a) => a.date >= from && a.date <= to)
            .map((a) => {
              const e = store.state.employees.find((x) => x.id === a.employee_id);
              return {
                id: a.id, date: a.date, employee_id: a.employee_id,
                shift_code: a.shift_code, note: a.note || '',
                source: a.source || 'manual', name: e ? e.name : '',
              };
            });
          return { from, to, assignments: rows, settings: { ...store.state.settings } };
        }
        if (method === 'POST') {
          const { date, employee_id, shift_code, note = '', source = 'manual' } = body || {};
          if (!date || !employee_id || !shift_code) err('需要 employee_id 和 shift_code');
          return store.mutate((st) => {
            let row = st.assignments.find((a) => a.date === date && a.employee_id === Number(employee_id) && a.shift_code === shift_code);
            if (row) {
              row.note = note;
            } else {
              row = {
                id: Importer.nextId(st, 'assignment'),
                date, employee_id: Number(employee_id), shift_code, note, source,
              };
              st.assignments.push(row);
            }
            return { ...row };
          });
        }
        if (method === 'DELETE') {
          const { date, employee_id, shift_code } = q;
          return store.mutate((st) => {
            st.assignments = st.assignments.filter((a) =>
              !(a.date === date && a.employee_id === Number(employee_id) &&
                (!shift_code || a.shift_code === shift_code)));
            return { ok: true };
          });
        }
      }
      if (route === '/schedule/bulk') {
        const { action = 'set', dates = [], employee_ids = [], shift_code, note = '', replace = true } = body || {};
        if (!dates.length || !employee_ids.length) err('需要 dates 和 employee_ids');
        if (action === 'set' && !shift_code) err('设置排班需要 shift_code');
        return store.mutate((st) => {
          let changed = 0;
          for (const d of dates) {
            for (const eid of employee_ids) {
              const id = Number(eid);
              if (action === 'clear') {
                const before = st.assignments.length;
                st.assignments = st.assignments.filter((a) => !(a.date === d && a.employee_id === id));
                changed += before - st.assignments.length;
                continue;
              }
              if (replace) {
                st.assignments = st.assignments.filter((a) => !(a.date === d && a.employee_id === id));
              }
              if (!st.assignments.some((a) => a.date === d && a.employee_id === id && a.shift_code === shift_code)) {
                st.assignments.push({
                  id: Importer.nextId(st, 'assignment'),
                  date: d, employee_id: id, shift_code, note, source: 'manual',
                });
              }
              changed++;
            }
          }
          return { ok: true, changed };
        });
      }

      /* ---------------------------------------------------- 手工调整 */
      if (route === '/adjustments') {
        if (method === 'GET') {
          let rows = store.state.adjustments.slice();
          if (q.date_from) rows = rows.filter((a) => a.date >= q.date_from);
          if (q.date_to) rows = rows.filter((a) => a.date <= q.date_to);
          if (q.employee_id) rows = rows.filter((a) => a.employee_id === Number(q.employee_id));
          rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
          return rows.map((a) => {
            const e = store.state.employees.find((x) => x.id === a.employee_id);
            return { ...a, name: e ? e.name : '' };
          });
        }
        if (method === 'POST') {
          const { date, employee_id, kind, note = '' } = body || {};
          if (!['overtime', 'owe', 'attend'].includes(kind)) err('kind 必须是 overtime / owe / attend');
          let amount = Number(body.amount);
          if (!Number.isFinite(amount)) err('amount 必须是数字');
          if (kind === 'owe' && amount > 0) amount = -Math.abs(amount);
          if (!date) err('缺少 date');
          return store.mutate((st) => {
            const row = {
              id: Importer.nextId(st, 'adjustment'),
              date, employee_id: Number(employee_id), kind, amount, note,
            };
            st.adjustments.push(row);
            return { ...row };
          });
        }
      }
      const adjMatch = /^\/adjustments\/(\d+)$/.exec(route);
      if (adjMatch && method === 'DELETE') {
        const id = Number(adjMatch[1]);
        return store.mutate((st) => {
          st.adjustments = st.adjustments.filter((a) => a.id !== id);
          return { ok: true };
        });
      }

      /* ---------------------------------------------------- 统计 */
      if (route === '/stats') {
        const ids = q.employee_id ? String(q.employee_id).split(',').map(Number).filter(Boolean) : null;
        return Stats.computeStats(store.state, q.date_from, q.date_to, ids, {
          includeInactive: q.include_inactive === 'true',
          includeHidden: q.include_hidden === 'true',
        });
      }
      if (route === '/stats/monthly') {
        const ids = q.employee_id ? String(q.employee_id).split(',').map(Number).filter(Boolean) : null;
        return Stats.monthlySeries(store.state, q.date_from, q.date_to, ids, {
          includeHidden: q.include_hidden === 'true',
        });
      }
      if (route === '/stats/daily') {
        return Stats.dailySeries(store.state, q.date_from, q.date_to);
      }
      if (route === '/stats/heatmap') {
        return Stats.heatmap(store.state, q.date_from, q.date_to);
      }

      /* ---------------------------------------------------- 工作日历 */
      if (route === '/calendar') {
        if (method === 'GET') {
          const map = Stats.workdayMap(store.state, q.date_from, q.date_to);
          return {
            work_weekdays: store.state.settings.work_weekdays,
            days: Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, is_workday]) => ({
              date, is_workday,
              override: store.state.calendarDays[date] || null,
            })),
          };
        }
        if (method === 'PUT') {
          const dates = (body && body.dates) || (body && body.date ? [body.date] : []);
          if (!dates.length) err('需要 dates');
          const isWorkday = body.is_workday;
          await store.mutate((st) => {
            for (const d of dates) {
              if (isWorkday === null || isWorkday === undefined) delete st.calendarDays[d];
              else st.calendarDays[d] = { is_workday: !!isWorkday, note: body.note || '' };
            }
          });
          return { ok: true };
        }
      }

      /* ---------------------------------------------------- 导入 */
      if (route === '/import/preview') {
        const fd = opts.body;
        const file = fd && fd.get ? fd.get('file') : null;
        if (!file) err('未收到文件');
        const buffer = await file.arrayBuffer();
        return Importer.preview(store.state, buffer, file.name);
      }
      if (route === '/import/commit') {
        const staged = store.lastPreview;
        if (!staged) err('上传的解析结果已过期，请重新上传');
        return store.mutate(() => Importer.commitSync(store.state, staged, body || {}));
      }

      /* ---------------------------------------------------- 备份 */
      if (route === '/backup') {
        return JSON.parse(Importer.exportBackup(store.state));
      }
      if (route === '/restore') {
        if (!body || !body.confirm) err('需要 confirm=true 才会覆盖数据');
        await store.replaceAll(body.data);
        return { ok: true };
      }

      err('未实现的接口：' + route);
    }

    return handle;
  }

  root.createLocalApi = createApi;
  if (typeof module !== 'undefined' && module.exports) module.exports = createApi;
})(typeof self !== 'undefined' ? self : this);
