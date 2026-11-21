/* 对照测试：JS 解析/导入 vs Python 后端基准 */
'use strict';
const path = require('path');
const fs = require('fs');
const XLSX = require(path.join(__dirname, '..', 'docs', 'xlsx.full.min.js'));
global.XLSX = XLSX;
const EP = require(path.join(__dirname, '..', 'docs', 'excel_parse.js'));
const Importer = require(path.join(__dirname, '..', 'docs', 'importer.js'));
const { migrate, EMPTY_STATE, DEFAULT_SHIFTS } = require(path.join(__dirname, '..', 'docs', 'store.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); c ? pass++ : fail++; };

const base = path.join(__dirname, '..');
const files = [
  ['samples/示例-人员行矩阵.xlsx', 'matrix_rows'],
  ['samples/示例-人员列矩阵.xlsx', 'matrix_cols'],
  ['samples/示例-长表明细.xlsx', 'long'],
  ['冻干排班.xlsx', 'date_blocks'],
];

for (const [rel, layout] of files) {
  const full = path.join(base, rel);
  if (!fs.existsSync(full)) { console.log('SKIP ' + rel); continue; }
  const buf = fs.readFileSync(full);
  const parsed = EP.parseWorkbook(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), rel);
  const layouts = parsed.layouts.map((l) => l.layout);
  ok(layouts.includes(layout) && parsed.entries.length > 0,
    `${path.basename(rel)} -> ${layouts.join(',')} 条目=${parsed.entries.length} 人数=${parsed.names.length}`);
  // 首个条目非空
  ok(parsed.entries[0] && parsed.entries[0].date && parsed.entries[0].name,
    `  首条 ${parsed.entries[0].date} ${parsed.entries[0].name} ${parsed.entries[0].raw}`);
  // 名称去重
  ok(new Set(parsed.names).size === parsed.names.length, '  姓名去重');
}

// 工时折算
const conv = (t) => EP.autoShiftForToken(t);
ok(conv('08:00-16:00').weight === 1, '8 小时 -> 1 班（旧口径保留）');
ok(conv('16:00-08:00').weight === 2, '16 小时跨夜 -> 2 班（旧口径保留）');
ok(conv('08:00-12:00').weight === 0.5, '4 小时 -> 0.5 班（旧口径保留）');
ok(conv('08:00-生产结束').weight === 1, '到生产结束 -> 1 班（旧口径保留）');
ok(conv('08:00-17:00').weight === 1, '9 小时 -> 取整 1 班（旧口径保留）');
ok(conv('请假') === null && EP.parseTimeToken('请假').kind === 'rest', '请假 -> 休息');
ok(EP.parseTimeToken('08：00-16：00').kind === 'work', '全角冒号识别');
ok(EP.parseTimeToken('16:00-24:00').hours === 8, '16:00-24:00 -> 8 小时');

// 建议工时（新口径：直接算小时）
ok(EP.suggestedHours('08:00-16:00') === 8, '08:00-16:00 -> 8 小时');
ok(EP.suggestedHours('16:00-08:00') === 16, '跨夜 16 小时');
ok(EP.suggestedHours('白班') === 8, '白班 -> 8 小时');
ok(EP.suggestedHours('半班') === 4, '半班 -> 4 小时');
ok(EP.suggestedHours('08:00-生产结束') === 8, '到生产结束 -> 8 小时');
ok(EP.suggestedHours('随便什么') === 0, '认不出 -> 0（需手填）');
ok(EP.parseTimeToken('08:00-16:00').end === '16:00', '解析出结束时间');

// 导入：文件名/映射规则与旧版一致，但数据改成工时
const state = migrate(JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8')));
state.employees = [];
state.assignments = [];
state.adjustments = [];
state.nextIds = { employee: 1, assignment: 1, adjustment: 1 };
state.calendarDays = {};
state.settings.stats_start_date = '';

(async () => {
  const full = path.join(base, 'samples/示例-长表明细.xlsx');
  const buf = fs.readFileSync(full);
  const staged = Importer.preview(state, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 'a.xlsx');
  ok(staged.summary.entries === 175, `预览条目 ${staged.summary.entries} == 175`);
  ok(Object.values(staged.mapping).every((v) => v === '__skip__' || Number(v) > 0),
    `映射均为工时或跳过（${Object.entries(staged.mapping).map(([k, v]) => k + '=' + v).join(',')}）`);
  const stats = await Importer.commit(state, staged, {
    mapping: staged.mapping, replace: true, auto_create: true,
  });
  ok(stats.inserted === 175, `导入 ${stats.inserted} 条 == 175`);
  ok(stats.employees_created === 8, `新建人员 ${stats.employees_created} == 8`);
  ok(state.assignments.every((a) => Number(a.hours) > 0 && !('shift_code' in a)), '排班记录只含工时，无班次字段');

  // 真实班表：按工时折算
  const st2 = migrate(EMPTY_STATE());
  const buf2 = fs.readFileSync(path.join(base, '冻干排班.xlsx'));
  const staged2 = Importer.preview(st2, buf2.buffer.slice(buf2.byteOffset, buf2.byteOffset + buf2.byteLength), 'a.xlsx');
  const autoCount = Object.values(staged2.mapping).filter((v) => Number(v) > 0).length;
  ok(autoCount > 100, `真实班表可折算工时标记 ${autoCount} 种`);
  const stats2 = await Importer.commit(st2, staged2, {
    mapping: staged2.mapping, replace: true, auto_create: true,
  });
  ok(stats2.inserted > 4800 && stats2.inserted < 5000, `真实班表导入 ${stats2.inserted} 条`);
  ok(stats2.employees_created === 34, `真实班表人员 ${stats2.employees_created} == 34`);
  const hoursSet = [...new Set(st2.assignments.map((a) => a.hours))].sort((a, b) => a - b);
  ok(hoursSet.every((h) => h > 0 && h <= 24) && hoursSet.length > 1,
    `工时档位 ${hoursSet.map((h) => h + 'h').join('/')}`);

  // 备份往返
  const backup = Importer.exportBackup(st2);
  const restored = Importer.importBackup(backup);
  ok(restored.employees.length === st2.employees.length && restored.assignments.length === st2.assignments.length,
    '备份导出/导入往返一致');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
