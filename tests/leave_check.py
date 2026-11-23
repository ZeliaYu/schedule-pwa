"""调休 / 请假的统计口径测试（JS vs 独立 Python 计算）。"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# 复用 gen_expected 的独立实现
import gen_expected as G  # noqa: E402


def build_state():
    st = G.load_state()
    st = json.loads(json.dumps(st))
    st['employees'] = st['employees'][:2]
    st['assignments'] = [a for a in st['assignments'] if a['employee_id'] in (1, 2)]
    st['adjustments'] = []
    st['leaves'] = []
    st['settings']['stats_start_date'] = ''
    return st


def main():
    st = build_state()
    # 乙（id=2）在 11-06（周五）请假，11-05（周四）调休
    st['leaves'] = [
        {'id': 1, 'date': '2026-11-06', 'employee_id': 2, 'kind': 'leave', 'note': ''},
        {'id': 2, 'date': '2026-11-05', 'employee_id': 2, 'kind': 'rest', 'note': ''},
    ]
    with open(os.path.join(HERE, '_leave_state.json'), 'w', encoding='utf-8') as f:
        json.dump(st, f, ensure_ascii=False)

    # Python 侧：仅请假扣应出勤
    py = G.compute(st, "2026-11-01", "2026-11-10")
    emp2 = [e for e in py['employees'] if e['employee_id'] == 2][0]
    print(f"python: 乙 expected={emp2['expected']} actual={emp2['actual']} "
          f"owe={emp2['owe']} leave_days={emp2['leave_days']}")

    # JS 侧跑断言
    js = subprocess.run(
        ['node', os.path.join(HERE, 'leave_check.js')],
        capture_output=True, text=True, encoding='utf-8',
    )
    print(js.stdout.strip())
    if js.returncode != 0:
        print(js.stderr)
        sys.exit(1)

    # 两边结果必须完全一致
    out = subprocess.run(
        ['node', '-e', (
            "const p=require('path'),f=require('fs');"
            "const S=require('./docs/stats.js');"
            "const {migrate}=require('./docs/store.js');"
            "const st=migrate(JSON.parse(f.readFileSync('tests/_leave_state.json','utf8')));"
            "const r=S.computeStats(st,'2026-11-01','2026-11-10',null,{today:'2026-11-30'});"
            "const e=r.employees.find(x=>x.employee_id===2);"
            "console.log(JSON.stringify({expected:e.expected,actual:e.actual,owe:e.owe,"
            "leave_days:e.leave_days,rest_off_days:e.rest_off_days,leave_hours:e.leave_hours}));"
        )],
        capture_output=True, text=True, encoding='utf-8', cwd=os.path.dirname(HERE),
    )
    jsd = json.loads(out.stdout.strip())
    want = {
        'expected': emp2['expected'], 'actual': emp2['actual'], 'owe': emp2['owe'],
        'leave_days': emp2['leave_days'], 'rest_off_days': emp2['rest_off_days'],
        'leave_hours': emp2['leave_hours'],
    }
    same = all(abs(float(jsd[k]) - float(want[k])) < 0.005 for k in want)
    print(f"{'PASS' if same else 'FAIL'} JS 与 Python 结果一致")
    print(f"  JS  : {jsd}")
    print(f"  PY  : {want}")
    if not same:
        sys.exit(1)


if __name__ == '__main__':
    main()
