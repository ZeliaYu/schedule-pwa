const path=require('path');
const {migrate}=require(require('path').join(__dirname,'..','docs','store.js'));
const legacy = {
  version: 1,
  employees: [{ id:1, name:'甲', expect_mode:'fixed', monthly_quota: 26 }],
  shifts: [{ code:'morning', name:'白班', weight:1 }, { code:'half', name:'半班', weight:0.5 }],
  assignments: [
    { id:1, date:'2026-11-01', employee_id:1, shift_code:'morning' },
    { id:2, date:'2026-11-02', employee_id:1, shift_code:'half' },
  ],
  adjustments: [{ id:1, date:'2026-11-03', employee_id:1, kind:'overtime', amount:2 }],
  settings: { work_weekdays:'1,2,3,4,5' },
  nextIds: { employee:2, assignment:3, adjustment:2 },
};
const st = migrate(legacy);
const ok=(c,m)=>console.log((c?'PASS ':'FAIL ')+m);
ok(st.version===2, 'version -> 2');
ok(!('shifts' in st), '班次字段已移除');
ok(st.assignments[0].hours===8, `白班 1 班 -> 8h（实际 ${st.assignments[0].hours}）`);
ok(st.assignments[1].hours===4, `半班 0.5 班 -> 4h（实际 ${st.assignments[1].hours}）`);
ok(!('shift_code' in st.assignments[0]), 'shift_code 已剥离');
ok(st.assignments[0].note==='白班', '旧班次名保留在备注');
ok(st.adjustments[0].amount===16, `手工 2 班 -> 16h（实际 ${st.adjustments[0].amount}）`);
ok(st.employees[0].monthly_quota===208, `定额 26 班 -> 208h（实际 ${st.employees[0].monthly_quota}）`);
ok(st.settings.daily_hours===8, 'daily_hours 默认 8');
// 二次 migrate 幂等
const st2 = migrate(st);
ok(st2.assignments[0].hours===8 && st2.version===2, '二次迁移幂等');
// v2 数据不动
const v2 = { version:2, employees:[], assignments:[{ id:1, date:'2026-11-01', employee_id:1, start:'08:00', end:'16:00', hours:8 }], adjustments:[], settings:{daily_hours:7.5} };
const st3 = migrate(v2);
ok(st3.assignments[0].hours===8 && st3.settings.daily_hours===7.5, 'v2 数据原样保留');
