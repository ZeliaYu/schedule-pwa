"""排班统计：应出勤、已上、加班、欠班。

口径
----
应出勤 expected  区间内工作日天数（自动模式）或月度定额按区间折算（固定模式）
已上   actual    区间内排班的记班系数之和 + 手工「补出勤」
自动差额 net     actual - expected
自动加班/欠班    net > 0 记加班，net < 0 记欠班
手工调整         加班 / 欠班 可正可负，直接叠加
最终             最终加班 = 自动加班 + 手工加班；最终欠班 = 自动欠班 + 手工欠班
"""
from __future__ import annotations

import datetime as dt
import sqlite3
from collections import defaultdict


def _parse(d: str) -> dt.date:
    return dt.date.fromisoformat(d[:10])


def daterange(start: dt.date, end: dt.date):
    cur = start
    while cur <= end:
        yield cur
        cur += dt.timedelta(days=1)


def load_work_weekdays(settings: dict) -> set[int]:
    raw = settings.get("work_weekdays", "0,1,2,3,4,5,6")
    try:
        return {int(x) for x in raw.split(",") if x.strip() != ""}
    except ValueError:
        return set(range(7))


def _weekday_sun0(d: dt.date) -> int:
    """统一为「周日=0 … 周六=6」的编号，与前端 JS 的 getDay() 一致。

    Python 的 date.weekday() 是周一=0，必须转换，否则周日会被当成工作日。
    """
    return (d.weekday() + 1) % 7


def workday_map(con: sqlite3.Connection, start: dt.date, end: dt.date, settings: dict) -> dict[str, bool]:
    """日期 -> 是否工作日。calendar_days 的显式覆盖优先于周几默认。"""
    weekdays = load_work_weekdays(settings)
    result = {d.isoformat(): _weekday_sun0(d) in weekdays for d in daterange(start, end)}
    for row in con.execute(
        "SELECT date,is_workday FROM calendar_days WHERE date BETWEEN ? AND ?",
        (start.isoformat(), end.isoformat()),
    ):
        result[row["date"]] = bool(row["is_workday"])
    return result


def compute_stats(
    con: sqlite3.Connection,
    date_from: str,
    date_to: str,
    settings: dict,
    employee_ids: list[int] | None = None,
    include_inactive: bool = False,
) -> dict:
    start, end = _parse(date_from), _parse(date_to)
    if end < start:
        start, end = end, start

    days = workday_map(con, start, end, settings)
    # 未来日期还未发生，不应算作应出勤（查本月时不会一上来就全员欠班）
    today = dt.date.today()
    total_workdays = sum(
        1 for d, v in days.items() if v and dt.date.fromisoformat(d) <= today
    )

    # 统计起点之前的日期只累计「已上」，不计应出勤（历史表常只记录上班人员）
    start_marker = (settings.get("stats_start_date") or "").strip()
    counted_from = start
    if start_marker:
        try:
            marker = dt.date.fromisoformat(start_marker[:10])
            if marker > start:
                counted_from = min(marker, end + dt.timedelta(days=1))
                total_workdays = sum(
                    1 for d, v in days.items()
                    if v and d >= counted_from.isoformat() and dt.date.fromisoformat(d) <= today
                )
        except ValueError:
            pass
    historical = counted_from > start

    # 区间覆盖的自然月个数（用于 fixed 模式折算）
    month_span = (end.year - start.year) * 12 + (end.month - start.month) + 1

    emp_rows = con.execute(
        "SELECT * FROM employees WHERE active=1 OR ? ORDER BY sort_order, id",
        (1 if include_inactive else 0,),
    ).fetchall()
    employees = [dict(r) for r in emp_rows]
    if employee_ids:
        wanted = set(employee_ids)
        employees = [e for e in employees if e["id"] in wanted]

    shift_rows = con.execute("SELECT * FROM shifts ORDER BY sort_order, code").fetchall()
    shifts = {r["code"]: dict(r) for r in shift_rows}

    per_emp = {
        e["id"]: {
            "employee_id": e["id"],
            "name": e["name"],
            "employee_no": e["employee_no"],
            "team": e["team"],
            "expect_mode": e["expect_mode"],
            "expected": 0.0,
            "actual": 0.0,
            "by_shift": defaultdict(float),
            "worked_days": set(),
            "historical_actual": 0.0,
            "historical_days": set(),
            "manual_ot": 0.0,
            "manual_owe": 0.0,
            "manual_attend": 0.0,
            "adjustments": [],
        }
        for e in employees
    }

    for row in con.execute(
        "SELECT a.date, a.employee_id, a.shift_code, a.note FROM assignments a "
        "WHERE a.date BETWEEN ? AND ?",
        (start.isoformat(), end.isoformat()),
    ):
        agg = per_emp.get(row["employee_id"])
        if agg is None:
            continue
        weight = (shifts.get(row["shift_code"]) or {}).get("weight")
        weight = 1.0 if weight is None else float(weight)
        agg["actual"] += weight
        agg["by_shift"][row["shift_code"]] += weight
        agg["worked_days"].add(row["date"])
        # 历史段（统计起点之前）只计入累计出勤，不参与应出勤/加班/欠班
        if row["date"] < counted_from.isoformat():
            agg["historical_actual"] += weight
            agg["historical_days"].add(row["date"])

    for row in con.execute(
        "SELECT * FROM adjustments WHERE date BETWEEN ? AND ?",
        (start.isoformat(), end.isoformat()),
    ):
        agg = per_emp.get(row["employee_id"])
        if agg is None:
            continue
        amount = float(row["amount"])
        if row["kind"] == "overtime":
            agg["manual_ot"] += amount
        elif row["kind"] == "owe":
            agg["manual_owe"] += amount
        elif row["kind"] == "attend":
            agg["manual_attend"] += amount
        agg["adjustments"].append(
            {
                "id": row["id"],
                "date": row["date"],
                "kind": row["kind"],
                "amount": amount,
                "note": row["note"],
            }
        )

    out = []
    for e in employees:
        agg = per_emp[e["id"]]
        if e["expect_mode"] == "fixed" and e["monthly_quota"] is not None:
            expected = float(e["monthly_quota"]) * month_span
        else:
            expected = float(total_workdays)
        actual = agg["actual"] + agg["manual_attend"]
        period_actual = actual - agg["historical_actual"]   # 只算统计区间内的出勤
        net = period_actual - expected
        net_final = net + agg["manual_ot"] + agg["manual_owe"]
        out.append(
            {
                "employee_id": e["id"],
                "name": e["name"],
                "employee_no": e["employee_no"],
                "team": e["team"],
                "expect_mode": e["expect_mode"],
                "expected": round(expected, 2),
                "actual": round(actual, 2),
                "period_actual": round(period_actual, 2),
                "historical_actual": round(agg["historical_actual"], 2),
                "historical_days": len(agg["historical_days"]),
                "scheduled": round(agg["actual"], 2),
                "manual_attend": round(agg["manual_attend"], 2),
                "worked_days": len(agg["worked_days"]),
                "net": round(net, 2),
                "net_final": round(net_final, 2),
                "auto_overtime": round(max(0.0, net), 2),
                "auto_owe": round(max(0.0, -net), 2),
                "manual_overtime": round(agg["manual_ot"], 2),
                "manual_owe": round(abs(agg["manual_owe"]), 2),
                "overtime": round(max(0.0, net_final), 2),
                "owe": round(max(0.0, -net_final), 2),
                "by_shift": {k: round(v, 2) for k, v in agg["by_shift"].items()},
                "adjustments": agg["adjustments"],
            }
        )

    totals = {
        "expected": round(sum(x["expected"] for x in out), 2),
        "actual": round(sum(x["actual"] for x in out), 2),
        "period_actual": round(sum(x["period_actual"] for x in out), 2),
        "historical_actual": round(sum(x["historical_actual"] for x in out), 2),
        "overtime": round(sum(x["overtime"] for x in out), 2),
        "owe": round(sum(x["owe"] for x in out), 2),
        "people": len(out),
        "workdays": total_workdays,
    }

    return {
        "range": {"from": start.isoformat(), "to": end.isoformat()},
        "counted_from": counted_from.isoformat(),
        "historical": historical,
        "workdays": total_workdays,
        "days": [{"date": d, "is_workday": v} for d, v in days.items()],
        "employees": out,
        "totals": totals,
        "shifts": shifts,
    }


def daily_series(
    con: sqlite3.Connection,
    date_from: str,
    date_to: str,
    settings: dict,
) -> list[dict]:
    """每日：排班人数、班次分布、当日加班/欠班净额（按人累计的变动）。"""
    start, end = _parse(date_from), _parse(date_to)
    days = workday_map(con, start, end, settings)
    shift_rows = con.execute("SELECT * FROM shifts ORDER BY sort_order, code").fetchall()
    shifts = {r["code"]: dict(r) for r in shift_rows}

    per_day: dict[str, dict] = {
        d.isoformat(): {"date": d.isoformat(), "is_workday": days[d.isoformat()], "people": 0,
                        "headcount": defaultdict(float), "shifts": defaultdict(float)}
        for d in daterange(start, end)
    }
    seen: dict[str, set] = defaultdict(set)

    for row in con.execute(
        "SELECT date, employee_id, shift_code FROM assignments WHERE date BETWEEN ? AND ?",
        (start.isoformat(), end.isoformat()),
    ):
        d = per_day.get(row["date"])
        if d is None:
            continue
        w = float((shifts.get(row["shift_code"]) or {}).get("weight", 1) or 0)
        d["shifts"][row["shift_code"]] += w
        seen[row["date"]].add(row["employee_id"])

    for day, rec in per_day.items():
        rec["people"] = len(seen[day])
        rec["headcount"] = dict(rec["headcount"])
        rec["shifts"] = dict(rec["shifts"])

    return [per_day[d] for d in sorted(per_day)]


def monthly_series(
    con: sqlite3.Connection,
    date_from: str,
    date_to: str,
    settings: dict,
    employee_ids: list[int] | None = None,
) -> list[dict]:
    """按月拆分统计，用于趋势图。"""
    start, end = _parse(date_from), _parse(date_to)
    out = []
    cur = dt.date(start.year, start.month, 1)
    while cur <= end:
        ny, nm = (cur.year + 1, 1) if cur.month == 12 else (cur.year, cur.month + 1)
        m_start = max(cur, start)
        m_end = min(dt.date(ny, nm, 1) - dt.timedelta(days=1), end)
        res = compute_stats(con, m_start.isoformat(), m_end.isoformat(), settings, employee_ids)
        out.append(
            {
                "month": f"{cur.year:04d}-{cur.month:02d}",
                "from": m_start.isoformat(),
                "to": m_end.isoformat(),
                "totals": res["totals"],
                "employees": res["employees"],
            }
        )
        cur = dt.date(ny, nm, 1)
    return out
