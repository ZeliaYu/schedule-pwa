/* ===================================================================
   本地存储层
   - 浏览器：IndexedDB（单库单表，整份状态一次读写）
   - 测试环境：内存实现（同样接口）
   所有数据只存在于当前浏览器，换设备/清缓存即消失，靠「导出备份」迁移。
   =================================================================== */
'use strict';

const DB_NAME = 'schedule-pwa';
const DB_VERSION = 1;
const STORE = 'state';

const EMPTY_STATE = () => ({
  version: 1,
  employees: [],
  shifts: [],
  assignments: [],
  adjustments: [],
  calendarDays: {},   // "YYYY-MM-DD" -> { is_workday, note }
  settings: {
    work_weekdays: '1,2,3,4,5,6',
    stats_start_date: '',
    org_name: '排班管理',
  },
  nextIds: { employee: 1, assignment: 1, adjustment: 1 },
});

class MemoryBackend {
  constructor() { this.data = null; }
  async load() { return this.data ? JSON.parse(JSON.stringify(this.data)) : null; }
  async save(state) { this.data = JSON.parse(JSON.stringify(state)); }
  async clear() { this.data = null; }
}

class IdbBackend {
  constructor() { this.db = null; }
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => { this.db = req.result; resolve(this.db); };
      req.onerror = () => reject(req.error);
    });
  }
  async _tx(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let out;
      try { out = fn(store); } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  load() {
    return this._tx('readonly', (store) => {
      const box = { value: null };
      store.get('root').onsuccess = (e) => { box.value = e.target.result || null; };
      return box;
    }).then((box) => box.value);
  }
  save(state) {
    const snapshot = JSON.parse(JSON.stringify(state));
    return this._tx('readwrite', (store) => { store.put(snapshot, 'root'); });
  }
  clear() {
    return this._tx('readwrite', (store) => { store.delete('root'); });
  }
}

/** 存储门面：内存缓存 + 落盘 */
class Store {
  constructor(backend) {
    this.backend = backend;
    this.state = EMPTY_STATE();
    this._saving = null;
    this._dirty = false;
    this.listeners = new Set();
  }

  async init() {
    const loaded = await this.backend.load();
    this.state = migrate(loaded);
    if (!loaded) {
      // 全新安装：建默认班次
      this.state.shifts = DEFAULT_SHIFTS.map((s) => ({ ...s }));
      await this.save();
    }
    return this.state;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.listeners.forEach((fn) => { try { fn(this.state); } catch { /* ignore */ } }); }

  /** 立即落盘（合并并发写） */
  save() {
    this._dirty = true;
    if (this._saving) return this._saving;
    this._saving = (async () => {
      while (this._dirty) {
        this._dirty = false;
        await this.backend.save(this.state);
      }
      this._saving = null;
    })();
    return this._saving;
  }

  /** 修改后自动保存并通知订阅者 */
  async mutate(fn) {
    const result = fn(this.state);
    this.emit();
    await this.save();
    return result;
  }

  async replaceAll(state) {
    this.state = migrate(state);
    this.emit();
    await this.save();
    return this.state;
  }

  async reset() {
    await this.backend.clear();
    this.state = EMPTY_STATE();
    this.state.shifts = DEFAULT_SHIFTS.map((s) => ({ ...s }));
    this.emit();
    await this.save();
    return this.state;
  }
}

const DEFAULT_SHIFTS = [
  { code: 'morning', name: '白班', weight: 1, color: '#2a78d6', sort_order: 10, active: 1 },
  { code: 'evening', name: '中班', weight: 1, color: '#eb6834', sort_order: 20, active: 1 },
  { code: 'night', name: '夜班', weight: 1, color: '#4a3aa7', sort_order: 30, active: 1 },
  { code: 'half', name: '半班', weight: 0.5, color: '#1baf7a', sort_order: 40, active: 1 },
];

/** 兼容旧备份：补默认字段 */
function migrate(loaded) {
  const base = EMPTY_STATE();
  if (!loaded || typeof loaded !== 'object') return base;
  const st = {
    ...base,
    ...loaded,
    settings: { ...base.settings, ...(loaded.settings || {}) },
    nextIds: { ...base.nextIds, ...(loaded.nextIds || {}) },
    employees: Array.isArray(loaded.employees) ? loaded.employees : [],
    shifts: Array.isArray(loaded.shifts) && loaded.shifts.length ? loaded.shifts : DEFAULT_SHIFTS.map((s) => ({ ...s })),
    assignments: Array.isArray(loaded.assignments) ? loaded.assignments : [],
    adjustments: Array.isArray(loaded.adjustments) ? loaded.adjustments : [],
    calendarDays: loaded.calendarDays && typeof loaded.calendarDays === 'object' ? loaded.calendarDays : {},
  };
  // 统一班组/工号字段
  st.employees = st.employees.map((e) => ({
    expect_mode: 'auto', monthly_quota: null, sort_order: 0, note: '',
    employee_no: '', team: '', active: 1, ...e,
  }));
  st.shifts = st.shifts.map((s) => ({ active: 1, ...s }));
  // 修正 nextIds，防止与既有数据冲突
  const maxId = (arr) => arr.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
  st.nextIds.employee = Math.max(st.nextIds.employee || 1, maxId(st.employees) + 1);
  st.nextIds.assignment = Math.max(st.nextIds.assignment || 1, maxId(st.assignments) + 1);
  st.nextIds.adjustment = Math.max(st.nextIds.adjustment || 1, maxId(st.adjustments) + 1);
  return st;
}

/* 自检：Node 环境下导出，便于测试 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Store, MemoryBackend, EMPTY_STATE, migrate, DEFAULT_SHIFTS };
}
