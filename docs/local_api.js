/* ===================================================================
   本地 API 层
   与 FastAPI 后端接口同形，把请求转成本地状态读写。
   这样界面代码不需要关心数据存在哪里。
   v2：班次概念取消，排班直接记「工时」（hours）与可选时间段/工作内容。
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

    const err = (msg) => { throw new Error(msg); };

    /** 一条排班的工时：显式 hours 优先，否则按起止时间推算，最后退回日标准工时 */
    const slotHours = (src) => {
      const h = Number(src && src.hours);
      if (Number.isFinite(h) && h > 0) return Math.round(h * 100) / 100;
      const byTime = Stats.hoursBetween(src && src.start, src && src.end);
      if (byTime > 0) return byTime;
      return Number(store.state.settings.daily_hours) || Stats.DEFAULT_DAILY_HOURS;
    };

    const activeEmps = () => (store.state.employees || [])
      .filter((e) => e.active !== 0)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
    /** 全部在职人员（含被屏蔽的），带 hidden 标记 */
    const allActiveEmps = () => {
      const hidden = Stats.hiddenIds(store.state);
      return activeEmps().map((e) => ({ ...e, hidden: hidden.has(e.id) }));
    };

    const slotOf = (body) => ({
      start: String((body && body.start) || '').trim(),
      end: String((body && body.end) || '').trim(),
      hours: slotHours(body),
      content: String((body && body.content) || '').trim(),
    });

    const publicSlot = (a) => {
      const e = store.state.employees.find((x) => x.id === a.employee_id);
      return {
        id: a.id, date: a.date, employee_id: a.employee_id,
        start: a.start || '', end: a.end || '',
        hours: Stats.assignmentHours(a),
        content: a.content || '', note: a.note || '',
        source: a.source || 'manual', name: e ? e.name : '',
      };
    };

    async function handle(path, opts) {
      opts = opts || {};
      const method = (opts.method || 'GET').toUpperCase();
      const [route, q] = qs(path);
      const body = opts.body && !(opts.body instanceof FormData) ? opts.body : null;

      /* ---------------------------------------------------- 元信息 */
      if (route === '/bootstrap') {
        return {
          employees: allActiveEmps(),
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
              daily_hours: Number(body.daily_hours) > 0 ? Number(body.daily_hours) : null,
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
            for (const k of ['name', 'employee_no', 'team', 'expect_mode', 'monthly_quota', 'daily_hours', 'active', 'sort_order', 'note']) {
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
              st.leaves = (st.leaves || []).filter((l) => l.employee_id !== id);
            } else {
              emp.active = 0;
            }
            return { ok: true };
          });
        }
      }

      /* ---------------------------------------------------- 排班（按工时） */
      if (route === '/schedule') {
        if (method === 'GET') {
          const from = q.date_from, to = q.date_to;
          const rows = store.state.assignments
            .filter((a) => a.date >= from && a.date <= to)
            .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.start || '').localeCompare(b.start || '')))
            .map(publicSlot);
          return { from, to, assignments: rows, settings: { ...store.state.settings } };
        }
        if (method === 'POST') {
          const { date, employee_id } = body || {};
          if (!date || !employee_id) err('需要 date 和 employee_id');
          const slot = slotOf(body);
          if (!(slot.hours > 0)) err('工时需大于 0');
          return store.mutate((st) => {
            // 同一天同一人同一时间段视为同一格，重复提交则覆盖
            let row = st.assignments.find((a) =>
              a.date === date && a.employee_id === Number(employee_id) &&
              (a.start || '') === slot.start && (a.end || '') === slot.end);
            if (row) {
              row.hours = slot.hours;
              row.content = slot.content;
              row.note = String((body && body.note) || '');
            } else {
              row = {
                id: Importer.nextId(st, 'assignment'),
                date, employee_id: Number(employee_id),
                start: slot.start, end: slot.end, hours: slot.hours,
                content: slot.content, note: String((body && body.note) || ''),
                source: (body && body.source) || 'manual',
              };
              st.assignments.push(row);
            }
            // 排了班就不该再有调休 / 请假标记
            st.leaves = (st.leaves || []).filter((l) => !(l.date === date && l.employee_id === Number(employee_id)));
            return { ...row };
          });
        }
        if (method === 'DELETE') {
          const { date, employee_id, id, start } = q;
          return store.mutate((st) => {
            st.assignments = st.assignments.filter((a) => {
              if (date && a.date !== date) return true;
              if (employee_id && a.employee_id !== Number(employee_id)) return true;
              if (id && a.id !== Number(id)) return true;
              if (start !== undefined && (a.start || '') !== start) return true;
              return false;
            });
            return { ok: true };
          });
        }
      }
      const slotMatch = /^\/schedule\/(\d+)$/.exec(route);
      if (slotMatch) {
        const id = Number(slotMatch[1]);
        const row = store.state.assignments.find((a) => a.id === id);
        if (!row) err('排班记录不存在');
        if (method === 'PUT') {
          const slot = slotOf({ ...row, ...(body || {}) });
          if (!(slot.hours > 0)) err('工时需大于 0');
          return store.mutate(() => {
            row.start = slot.start;
            row.end = slot.end;
            row.hours = slot.hours;
            row.content = slot.content;
            if (body && 'note' in body) row.note = String(body.note || '');
            return publicSlot(row);
          });
        }
        if (method === 'DELETE') {
          return store.mutate((st) => {
            st.assignments = st.assignments.filter((a) => a.id !== id);
            return { ok: true };
          });
        }
      }
      if (route === '/schedule/bulk') {
        const { action = 'set', dates = [], employee_ids = [], hours, start = '', end = '', content = '' } = body || {};
        if (!dates.length || !employee_ids.length) err('需要 dates 和 employee_ids');
        const h = Number(hours) > 0 ? Number(hours) : Stats.hoursBetween(start, end);
        if (action === 'set' && !(h > 0)) err('设置排班需要工时');
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
              st.assignments.push({
                id: Importer.nextId(st, 'assignment'),
                date: d, employee_id: id,
                start, end, hours: Math.round(h * 100) / 100, content,
                note: '', source: 'manual',
              });
              changed++;
            }
          }
          return { ok: true, changed };
        });
      }

      /* ---------------------------------------------------- 调休 / 请假 */
      if (route === '/leaves') {
        if (method === 'GET') {
          let rows = store.state.leaves.slice();
          if (q.date_from) rows = rows.filter((a) => a.date >= q.date_from);
          if (q.date_to) rows = rows.filter((a) => a.date <= q.date_to);
          if (q.employee_id) rows = rows.filter((a) => a.employee_id === Number(q.employee_id));
          rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
          return rows.map((a) => {
            const e = store.state.employees.find((x) => x.id === a.employee_id);
            return { ...a, name: e ? e.name : '' };
          });
        }
        if (method === 'POST') {
          const { date, employee_id } = body || {};
          const kind = body && body.kind === 'leave' ? 'leave' : 'rest';
          if (!date || !employee_id) err('需要 date 和 employee_id');
          return store.mutate((st) => {
            const id = Number(employee_id);
            // 同一人同一天只保留一种状态：先清掉旧的，再写入
            st.leaves = st.leaves.filter((l) => !(l.date === date && l.employee_id === id));
            // 标了调休/请假就不再算那天上班
            st.assignments = st.assignments.filter((a) => !(a.date === date && a.employee_id === id));
            const row = {
              id: Importer.nextId(st, 'leave'),
              date, employee_id: id, kind,
              note: String((body && body.note) || ''),
            };
            st.leaves.push(row);
            return { ...row };
          });
        }
      }
      if (route === '/leaves/clear') {
        // 批量：把某些人某些日期的调休/请假取消（恢复成「未排班」）
        const { dates = [], employee_ids = [] } = body || {};
        return store.mutate((st) => {
          const before = st.leaves.length;
          st.leaves = st.leaves.filter((l) =>
            !(dates.includes(l.date) && employee_ids.map(Number).includes(l.employee_id)));
          return { ok: true, removed: before - st.leaves.length };
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
      if (route === '/reset') {
        if (method !== 'POST') err('请使用 POST');
        if (!body || body.confirm !== true) err('需要 confirm=true 才会清除数据');
        store.lastPreview = null;   // 清除后旧的解析结果作废
        await store.reset();
        return { ok: true };
      }

      err('未实现的接口：' + route);
    }

    return handle;
  }

  root.createLocalApi = createApi;
  if (typeof module !== 'undefined' && module.exports) module.exports = createApi;
})(typeof self !== 'undefined' ? self : this);
