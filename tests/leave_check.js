/* 调休 / 请假：JS 统计与 Python 基准对照 */
'use strict';
const path = require('path');
const fs = require('fs');
const Stats = require(path.join(__dirname, '..', 'docs', 'stats.js'));
const { migrate } = require(path.join(__dirname, '..', 'docs', 'store.js'));

const TODAY = '2026-11-30';
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '_leave_state.json'), 'utf8'));
// _leave_state.json 已经是「工时」口径（由 leave_check.py 生成）
const state = migrate(raw);

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); c ? pass++ : fail++; };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

const res = Stats.computeStats(state, '2026-11-01', '2026-11-10', null, { today: TODAY });
const e2 = res.employees.find((e) => e.employee_id === 2);

console.log(`乙: expected=${e2.expected} actual=${e2.actual} owe=${e2.owe} leave_days=${e2.leave_days} rest_off=${e2.rest_off_days}`);

ok(e2.leave_days === 1, `请假天数 ${e2.leave_days} == 1`);
ok(e2.rest_off_days === 1, `调休天数 ${e2.rest_off_days} == 1`);
ok(near(e2.leave_hours, 8), `请假扣减 ${e2.leave_hours} 小时 == 8`);
ok(near(e2.expected, res.workdays * 8 - 8),
  `应出勤 = 工作日 ${res.workdays} × 8 − 请假 8（实际 ${e2.expected}）`);

// 和不设请假相比，应出勤应少 8 小时、欠班少 8 小时
const noLeave = migrate({ ...raw, leaves: [] });
const base = Stats.computeStats(noLeave, '2026-11-01', '2026-11-10', null, { today: TODAY });
const b2 = base.employees.find((e) => e.employee_id === 2);
ok(near(b2.expected - e2.expected, 8), `请假让应出勤减少 8 小时（${b2.expected} → ${e2.expected}）`);
ok(e2.owe <= b2.owe, `请假后欠班不增加（${b2.owe} → ${e2.owe}）`);
ok(near(e2.net - b2.net, 8), `请假让净值提高 8 小时（${b2.net} → ${e2.net}）`);

// 调休不扣应出勤
const onlyRest = migrate({ ...raw, leaves: raw.leaves.filter((l) => l.kind === 'rest') });
const r3 = Stats.computeStats(onlyRest, '2026-11-01', '2026-11-10', null, { today: TODAY });
const r2e = r3.employees.find((e) => e.employee_id === 2);
ok(near(r2e.expected, b2.expected), `只标调休时应出勤不变（${r2e.expected} == ${b2.expected}）`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
