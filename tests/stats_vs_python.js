/* 对照测试：JS 统计实现 vs Python 独立实现基准值（tests/gen_expected.py）
   基准固定 today=2026-11-30，避免随运行日期漂移。 */
'use strict';
const path = require('path');
const fs = require('fs');
const Stats = require(path.join(__dirname, '..', 'docs', 'stats.js'));
const { migrate, EMPTY_STATE } = require(path.join(__dirname, '..', 'docs', 'store.js'));

const TODAY = '2026-11-30';
const state = migrate(JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8')));
const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'expected.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, actual, want) {
  const ok = Math.abs(Number(actual) - Number(want)) < 0.005;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got=${actual} want=${want}`);
  ok ? pass++ : fail++;
}
function deepEq(name, a, b) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  const ok = sa === sb;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) console.log('  got :', sa.slice(0, 300), '\n  want:', sb.slice(0, 300));
  ok ? pass++ : fail++;
}

const ranges = [['2026-11-01', '2026-11-30', 'nov'], ['2026-11-05', '2026-11-20', 'mid'], ['2026-10-01', '2026-12-31', 'q4']];
for (const [from, to, key] of ranges) {
  const got = Stats.computeStats(state, from, to, null, { today: TODAY });
  const want = expected[key];
  console.log(`\n== ${key} ${from}..${to} ==`);
  check('workdays', got.workdays, want.workdays);
  for (const k of ['expected', 'actual', 'period_actual', 'historical_actual', 'overtime', 'owe']) {
    check(`totals.${k}`, got.totals[k], want.totals[k]);
  }
  const order = (arr) => [...arr].sort((a, b) => a.employee_id - b.employee_id);
  const g = order(got.employees), w = order(want.employees);
  let mismatch = 0;
  for (let i = 0; i < w.length; i++) {
    for (const k of ['expected', 'actual', 'net', 'net_final', 'overtime', 'owe', 'scheduled', 'manual_attend', 'worked_days']) {
      if (Math.abs(Number(g[i][k]) - Number(w[i][k])) > 0.005) {
        console.log(`  MISMATCH ${w[i].name}.${k}: got=${g[i][k]} want=${w[i][k]}`);
        mismatch++;
      }
    }
  }
  mismatch === 0 ? (console.log('PASS per-employee values'), pass++) : fail++;
}

console.log('\n== monthly ==');
const gotM = Stats.monthlySeries(state, '2026-09-01', '2026-12-31', null, { today: TODAY });
deepEq('monthly months', gotM.map((m) => m.month), expected.monthly.map((m) => m.month));
for (let i = 0; i < expected.monthly.length; i++) {
  check(`monthly[${i}].expected`, gotM[i].totals.expected, expected.monthly[i].totals.expected);
  check(`monthly[${i}].owe`, gotM[i].totals.owe, expected.monthly[i].totals.owe);
}

console.log('\n== daily ==');
const gotD = Stats.dailySeries(state, '2026-11-01', '2026-11-10');
deepEq('daily dates', gotD.map((d) => d.date), expected.daily.map((d) => d.date));
deepEq('daily people', gotD.map((d) => d.people), expected.daily.map((d) => d.people));
deepEq('daily workday flags', gotD.map((d) => d.is_workday), expected.daily.map((d) => d.is_workday));
deepEq('daily hours', gotD.map((d) => d.hours), expected.daily.map((d) => d.hours));

console.log('\n== heatmap ==');
const hm = Stats.heatmap(state, '2026-11-01', '2026-11-30');
deepEq('heatmap employees', hm.employees.map((e) => e.name), ['甲', '乙', '丙', '丁']);
deepEq('heatmap day count', hm.days.length, 30);
const hmCell = hm.cells.find((c) => c.employee_id === 1 && c.date === '2026-11-03');
deepEq('heatmap cell 甲@11-03 有工时', hmCell.hours > 0, true);
console.log(`heatmap cells=${hm.cells.length}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
