"""独立实现：按「工时」口径重算基准值，生成 tests/expected.json。

与 docs/stats.js 的实现完全独立（Python 重写一遍），
用来保证移植后的 JS 计算没有偏差。

用法：python tests/gen_expected.py
固定 today=2026-11-30，使基准稳定（不受运行日期影响）。
"""
import json, os
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
LEGACY_HOURS_PER_SHIFT = 8
TODAY = date(2026, 11, 30)


def parse_iso(s):
    y, m, d = [int(x) for x in str(s)[:10].split('-')]
    return date(y, m, d)


def load_state():
    with open(os.path.join(HERE, 'state.json'), encoding='utf-8') as f:
        raw = json.load(f)
    # v1 -> v2：班次权重 × 8 = 工时
    weights = {s['code']: float(s.get('weight', 1)) for s in raw.get('shifts', [])}
    for a in raw['assignments']:
        if 'hours' not in a or not a['hours']:
            a['hours'] = weights.get(a.get('shift_code'), 1) * LEGACY_HOURS_PER_SHIFT
    for adj in raw['adjustments']:
        adj['amount'] = float(adj.get('amount', 0)) * LEGACY_HOURS_PER_SHIFT
    for e in raw['employees']:
        q = e.get('monthly_quota')
        if q not in (None, ''):
            e['monthly_quota'] = float(q) * LEGACY_HOURS_PER_SHIFT
    raw.setdefault('settings', {})['daily_hours'] = LEGACY_HOURS_PER_SHIFT
    return raw


def each_day(a, b):
    cur = a
    while cur <= b:
        yield cur
        cur += timedelta(days=1)


def workday_map(state, start, end):
    raw = str(state.get('settings', {}).get('work_weekdays') or '1,2,3,4,5')
    weekdays = {int(x) for x in raw.split(',') if x.strip() != ''}
    m = {}
    for d in each_day(start, end):
        m[d] = ((d.weekday() + 1) % 7) in weekdays   # JS getDay(): 周日=0
    for k, ov in (state.get('calendarDays') or {}).items():
        kd = parse_iso(k)
        if start <= kd <= end and ov and ov.get('is_workday') is not None:
            m[kd] = bool(ov['is_workday'])
    return m


def r2(x):
    return round(x * 100) / 100


def compute(state, frm, to, today=TODAY):
    start, end = parse_iso(frm), parse_iso(to)
    if end < start:
        start, end = end, start
    days = workday_map(state, start, end)

    marker = str(state.get('settings', {}).get('stats_start_date') or '').strip()
    counted_from = start
    if marker and parse_iso(marker) > start:
        counted_from = parse_iso(marker) if parse_iso(marker) < end else end + timedelta(days=1)
    historical = counted_from > start

    std = float(state.get('settings', {}).get('daily_hours') or 8)
    month_span = (end.year - start.year) * 12 + (end.month - start.month) + 1

    emps = [e for e in state['employees'] if e.get('active', 1) != 0]

    agg = {}
    for e in emps:
        agg[e['id']] = {
            'actual': 0.0, 'hist': 0.0, 'hist_days': set(), 'worked': set(),
            'manual_ot': 0.0, 'manual_owe': 0.0, 'manual_attend': 0.0,
            'rest_ot': 0.0, 'rest_days': set(), 'entries': [], 'adjustments': [],
            'leave_days': set(), 'rest_off_days': set(),
        }

    for a in state['assignments']:
        d = parse_iso(a['date'])
        if d < start or d > end or a['employee_id'] not in agg:
            continue
        g = agg[a['employee_id']]
        h = float(a['hours'])
        g['worked'].add(d)
        is_rest = not days.get(d, False)
        g['entries'].append({
            'date': a['date'], 'start': a.get('start', ''), 'end': a.get('end', ''),
            'hours': r2(h), 'content': a.get('content', ''), 'rest': is_rest,
        })
        if d < counted_from:
            g['actual'] += h
            g['hist'] += h
            g['hist_days'].add(d)
        elif is_rest:
            g['rest_ot'] += h
            g['rest_days'].add(d)
        else:
            g['actual'] += h

    for lv in state.get('leaves') or []:
        d = parse_iso(lv['date'])
        if d < start or d > end or d < counted_from:
            continue
        if not days.get(d, False):
            continue
        g = agg.get(lv['employee_id'])
        if not g:
            continue
        if lv.get('kind') == 'leave':
            g['leave_days'].add(d)
        else:
            g['rest_off_days'].add(d)

    for adj in state['adjustments']:
        d = parse_iso(adj['date'])
        if d < start or d > end or adj['employee_id'] not in agg:
            continue
        g = agg[adj['employee_id']]
        amt = float(adj['amount'])
        if adj['kind'] == 'overtime':
            g['manual_ot'] += amt
        elif adj['kind'] == 'owe':
            g['manual_owe'] += amt
        elif adj['kind'] == 'attend':
            g['manual_attend'] += amt
        g['adjustments'].append({
            'id': adj['id'], 'date': adj['date'], 'kind': adj['kind'],
            'amount': amt, 'note': adj.get('note', ''),
        })

    workdays = sum(1 for d, v in days.items() if v and d >= counted_from and d <= today)

    out = []
    for e in emps:
        g = agg[e['id']]
        own_std = float(e.get('daily_hours') or 0)
        if not (own_std > 0):
            own_std = std
        q = e.get('monthly_quota')
        leave_hours = len(g['leave_days']) * own_std
        if e.get('expect_mode') == 'fixed' and q not in (None, ''):
            expected = float(q) * month_span - leave_hours
        else:
            expected = workdays * own_std - leave_hours

        period_actual = g['actual'] - g['hist'] + g['manual_attend']
        actual = g['actual'] + g['rest_ot'] + g['manual_attend']
        net = period_actual - expected
        net_final = net + g['rest_ot'] + g['manual_ot'] + g['manual_owe']

        out.append({
            'employee_id': e['id'], 'name': e['name'], 'team': e.get('team', ''),
            'expect_mode': e.get('expect_mode', 'auto'), 'daily_hours': own_std,
            'expected': r2(expected), 'actual': r2(actual),
            'period_actual': r2(period_actual), 'historical_actual': r2(g['hist']),
            'historical_days': len(g['hist_days']), 'scheduled': r2(g['actual']),
            'manual_attend': r2(g['manual_attend']), 'worked_days': len(g['worked']),
            'rest_overtime': r2(g['rest_ot']), 'rest_days': len(g['rest_days']),
            'leave_days': len(g['leave_days']), 'rest_off_days': len(g['rest_off_days']),
            'leave_hours': r2(len(g['leave_days']) * own_std),
            'net': r2(net), 'net_final': r2(net_final),
            'auto_overtime': r2(max(0, net)), 'auto_owe': r2(max(0, -net)),
            'manual_overtime': r2(g['manual_ot']), 'manual_owe': r2(abs(g['manual_owe'])),
            'overtime': r2(max(0, net_final)), 'owe': r2(max(0, -net_final)),
        })

    order = {e['id']: (e.get('sort_order', 0), e['id']) for e in state['employees']}
    out.sort(key=lambda x: order[x['employee_id']])

    def total(k):
        return r2(sum(x[k] for x in out))

    return {
        'range': {'from': str(start), 'to': str(end)},
        'counted_from': str(counted_from), 'historical': historical,
        'workdays': workdays, 'daily_hours': std,
        'days': [{'date': str(d), 'is_workday': v} for d, v in sorted(days.items())],
        'employees': out,
        'totals': {
            'expected': total('expected'), 'actual': total('actual'),
            'period_actual': total('period_actual'), 'historical_actual': total('historical_actual'),
            'overtime': total('overtime'), 'owe': total('owe'),
            'people': len(out), 'workdays': workdays,
        },
    }


def monthly(state, frm, to, today=TODAY):
    cur = parse_iso(frm).replace(day=1)
    end = parse_iso(to)
    out = []
    while cur <= end:
        if cur.month == 12:
            nxt = date(cur.year + 1, 1, 1)
        else:
            nxt = date(cur.year, cur.month + 1, 1)
        m_end = nxt - timedelta(days=1)
        f = max(cur, parse_iso(frm))
        t = min(m_end, end)
        res = compute(state, str(f), str(t), today)
        out.append({
            'month': f'{cur.year}-{cur.month:02d}', 'from': str(f), 'to': str(t),
            'totals': res['totals'],
        })
        cur = nxt
    return out


def daily(state, frm, to):
    start, end = parse_iso(frm), parse_iso(to)
    days = workday_map(state, start, end)
    per = {d: {'date': str(d), 'is_workday': v, 'people': set(), 'hours': 0.0}
           for d, v in days.items()}
    for a in state['assignments']:
        d = parse_iso(a['date'])
        row = per.get(d)
        if not row:
            continue
        row['hours'] += float(a['hours'])
        row['people'].add(a['employee_id'])
    return [{
        'date': per[d]['date'], 'is_workday': per[d]['is_workday'],
        'people': len(per[d]['people']), 'hours': r2(per[d]['hours']),
    } for d in sorted(per)]


def main():
    state = load_state()
    expected = {}
    for frm, to, key in [('2026-11-01', '2026-11-30', 'nov'),
                         ('2026-11-05', '2026-11-20', 'mid'),
                         ('2026-10-01', '2026-12-31', 'q4')]:
        expected[key] = compute(state, frm, to)
    expected['monthly'] = monthly(state, '2026-09-01', '2026-12-31')
    expected['daily'] = daily(state, '2026-11-01', '2026-11-10')
    with open(os.path.join(HERE, 'expected.json'), 'w', encoding='utf-8') as f:
        json.dump(expected, f, ensure_ascii=False, indent=2)
    print('expected.json 已生成')
    for k in ['nov', 'mid', 'q4']:
        t = expected[k]['totals']
        print(f"  {k}: workdays={t['workdays']} expected={t['expected']} "
              f"overtime={t['overtime']} owe={t['owe']}")


if __name__ == '__main__':
    main()
