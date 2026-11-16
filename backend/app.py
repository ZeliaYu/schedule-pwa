"""排班 PWA 后端：FastAPI + SQLite。

所有接口都在 /api 下；前端静态文件由同一进程提供（/static 与根路径）。
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
from collections import defaultdict
from typing import Optional

from fastapi import Body, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import calc
import db
import excel_parse

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")
STAGING_DIR = os.path.join(BASE_DIR, "data", "staging")
os.makedirs(STAGING_DIR, exist_ok=True)

app = FastAPI(title="排班管理", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

db.init_db()


def _settings() -> dict:
    with db.connect() as con:
        return db.get_settings(con)


# ---------------------------------------------------------------- 元信息
@app.get("/api/bootstrap")
def bootstrap():
    """前端启动时一次性拿到人员、班次、设置。"""
    with db.connect() as con:
        emps = [dict(r) for r in con.execute(
            "SELECT * FROM employees WHERE active=1 ORDER BY sort_order, id")]
        shifts = [dict(r) for r in con.execute(
            "SELECT * FROM shifts WHERE active=1 ORDER BY sort_order, code")]
        settings = db.get_settings(con)
    return {"employees": emps, "shifts": shifts, "settings": settings}


@app.get("/api/settings")
def get_settings():
    return _settings()


@app.put("/api/settings")
def put_settings(payload: dict = Body(...)):
    allowed = {"work_weekdays", "day_view_shifts", "org_name", "stats_start_date"}
    data = {k: v for k, v in payload.items() if k in allowed}
    with db.connect() as con:
        db.set_settings(con, data)
    return _settings()


# ---------------------------------------------------------------- 员工
@app.get("/api/employees")
def list_employees(include_inactive: bool = False):
    sql = "SELECT * FROM employees" + ("" if include_inactive else " WHERE active=1")
    with db.connect() as con:
        rows = [dict(r) for r in con.execute(sql + " ORDER BY sort_order, id")]
    return rows


@app.post("/api/employees")
def create_employee(payload: dict = Body(...)):
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "姓名不能为空")
    try:
        with db.connect() as con:
            cur = con.execute(
                "INSERT INTO employees(name,employee_no,team,expect_mode,monthly_quota,sort_order,note) "
                "VALUES(?,?,?,?,?,?,?)",
                (name, payload.get("employee_no", ""), payload.get("team", ""),
                 payload.get("expect_mode", "auto"), payload.get("monthly_quota"),
                 payload.get("sort_order", 0), payload.get("note", "")),
            )
            emp = dict(con.execute("SELECT * FROM employees WHERE id=?", (cur.lastrowid,)).fetchone())
    except db.sqlite3.IntegrityError:
        raise HTTPException(400, f"员工「{name}」已存在") from None
    return emp


@app.put("/api/employees/{emp_id}")
def update_employee(emp_id: int, payload: dict = Body(...)):
    fields = ["name", "employee_no", "team", "expect_mode", "monthly_quota", "active", "sort_order", "note"]
    updates = {k: payload[k] for k in fields if k in payload}
    if "name" in updates and not str(updates["name"]).strip():
        raise HTTPException(400, "姓名不能为空")
    if not updates:
        raise HTTPException(400, "没有可更新的字段")
    sets = ", ".join(f"{k}=?" for k in updates)
    try:
        with db.connect() as con:
            con.execute(f"UPDATE employees SET {sets} WHERE id=?", (*updates.values(), emp_id))
            row = con.execute("SELECT * FROM employees WHERE id=?", (emp_id,)).fetchone()
    except db.sqlite3.IntegrityError:
        raise HTTPException(400, "该姓名已存在") from None
    if not row:
        raise HTTPException(404, "员工不存在")
    return dict(row)


@app.delete("/api/employees/{emp_id}")
def delete_employee(emp_id: int, hard: bool = False):
    with db.connect() as con:
        if hard:
            con.execute("DELETE FROM employees WHERE id=?", (emp_id,))
        else:
            con.execute("UPDATE employees SET active=0 WHERE id=?", (emp_id,))
    return {"ok": True}


# ---------------------------------------------------------------- 班次
@app.get("/api/shifts")
def list_shifts(include_inactive: bool = False):
    sql = "SELECT * FROM shifts" + ("" if include_inactive else " WHERE active=1")
    with db.connect() as con:
        return [dict(r) for r in con.execute(sql + " ORDER BY sort_order, code")]


@app.post("/api/shifts")
def create_shift(payload: dict = Body(...)):
    code = (payload.get("code") or "").strip()
    name = (payload.get("name") or "").strip()
    if not code or not name:
        raise HTTPException(400, "班次代码和名称不能为空")
    try:
        with db.connect() as con:
            con.execute(
                "INSERT INTO shifts(code,name,weight,color,sort_order) VALUES(?,?,?,?,?)",
                (code, name, float(payload.get("weight", 1)), payload.get("color", "#2a78d6"),
                 int(payload.get("sort_order", 100))),
            )
    except db.sqlite3.IntegrityError:
        raise HTTPException(400, f"班次代码「{code}」已存在") from None
    return list_shifts(True)


@app.put("/api/shifts/{code}")
def update_shift(code: str, payload: dict = Body(...)):
    fields = ["name", "weight", "color", "sort_order", "active"]
    updates = {k: payload[k] for k in fields if k in payload}
    if not updates:
        raise HTTPException(400, "没有可更新的字段")
    if "weight" in updates:
        updates["weight"] = float(updates["weight"])
    sets = ", ".join(f"{k}=?" for k in updates)
    with db.connect() as con:
        con.execute(f"UPDATE shifts SET {sets} WHERE code=?", (*updates.values(), code))
        row = con.execute("SELECT * FROM shifts WHERE code=?", (code,)).fetchone()
    if not row:
        raise HTTPException(404, "班次不存在")
    return dict(row)


# ---------------------------------------------------------------- 排班
@app.get("/api/schedule")
def get_schedule(date_from: str = Query(...), date_to: str = Query(...)):
    with db.connect() as con:
        rows = [dict(r) for r in con.execute(
            "SELECT a.id,a.date,a.employee_id,a.shift_code,a.note,a.source,e.name "
            "FROM assignments a JOIN employees e ON e.id=a.employee_id "
            "WHERE a.date BETWEEN ? AND ? ORDER BY a.date, e.sort_order, e.id",
            (date_from, date_to),
        )]
        settings = db.get_settings(con)
    return {"from": date_from, "to": date_to, "assignments": rows,
            "settings": settings}


@app.post("/api/schedule")
def set_assignment(payload: dict = Body(...)):
    """单条设置：同一天同一人同一班次 存在则更新备注，不存在则新增。"""
    date = pick_date(payload)
    emp_id = payload.get("employee_id")
    shift_code = payload.get("shift_code")
    if not emp_id or not shift_code:
        raise HTTPException(400, "需要 employee_id 和 shift_code")
    with db.connect() as con:
        con.execute(
            "INSERT INTO assignments(date,employee_id,shift_code,note,source) VALUES(?,?,?,?,?) "
            "ON CONFLICT(date,employee_id,shift_code) DO UPDATE SET note=excluded.note",
            (date, int(emp_id), shift_code, payload.get("note", ""), payload.get("source", "manual")),
        )
        row = con.execute(
            "SELECT * FROM assignments WHERE date=? AND employee_id=? AND shift_code=?",
            (date, int(emp_id), shift_code),
        ).fetchone()
    return dict(row)


@app.delete("/api/schedule")
def clear_assignment(date: str = Query(...), employee_id: int = Query(...),
                     shift_code: Optional[str] = Query(None)):
    with db.connect() as con:
        if shift_code:
            con.execute("DELETE FROM assignments WHERE date=? AND employee_id=? AND shift_code=?",
                        (date, employee_id, shift_code))
        else:
            con.execute("DELETE FROM assignments WHERE date=? AND employee_id=?",
                        (date, employee_id))
    return {"ok": True}


@app.post("/api/schedule/bulk")
def bulk_schedule(payload: dict = Body(...)):
    """批量操作：设置/清空 一个日期区间内的排班。

    payload: {action: "set"|"clear", dates: [...], employee_ids: [...],
              shift_code: "...", note: "", replace: bool}
    """
    action = payload.get("action", "set")
    dates = payload.get("dates") or ([pick_date(payload)] if payload.get("date") else [])
    emp_ids = payload.get("employee_ids") or ([payload["employee_id"]] if payload.get("employee_id") else [])
    if not dates or not emp_ids:
        raise HTTPException(400, "需要 dates 和 employee_ids")
    shift_code = payload.get("shift_code")
    replace = bool(payload.get("replace", True))
    changed = 0
    with db.connect() as con:
        for d in dates:
            for eid in emp_ids:
                if action == "clear":
                    con.execute("DELETE FROM assignments WHERE date=? AND employee_id=?", (d, int(eid)))
                    changed += 1
                    continue
                if not shift_code:
                    raise HTTPException(400, "设置排班需要 shift_code")
                if replace:
                    con.execute("DELETE FROM assignments WHERE date=? AND employee_id=?", (d, int(eid)))
                con.execute(
                    "INSERT INTO assignments(date,employee_id,shift_code,note,source) VALUES(?,?,?,?,?) "
                    "ON CONFLICT(date,employee_id,shift_code) DO UPDATE SET note=excluded.note",
                    (d, int(eid), shift_code, payload.get("note", ""), payload.get("source", "manual")),
                )
                changed += 1
    return {"ok": True, "changed": changed}


def pick_date(payload: dict) -> str:
    date = payload.get("date")
    if not date:
        raise HTTPException(400, "缺少 date")
    try:
        return dt.date.fromisoformat(str(date)[:10]).isoformat()
    except ValueError:
        raise HTTPException(400, f"日期格式不正确：{date}") from None


# ---------------------------------------------------------------- 手工调整
@app.get("/api/adjustments")
def list_adjustments(date_from: Optional[str] = None, date_to: Optional[str] = None,
                     employee_id: Optional[int] = None):
    sql = ("SELECT a.*, e.name FROM adjustments a JOIN employees e ON e.id=a.employee_id WHERE 1=1")
    args = []
    if date_from:
        sql += " AND a.date>=?"
        args.append(date_from)
    if date_to:
        sql += " AND a.date<=?"
        args.append(date_to)
    if employee_id:
        sql += " AND a.employee_id=?"
        args.append(employee_id)
    sql += " ORDER BY a.date DESC, a.id DESC"
    with db.connect() as con:
        return [dict(r) for r in con.execute(sql, args)]


@app.post("/api/adjustments")
def create_adjustment(payload: dict = Body(...)):
    kind = payload.get("kind")
    if kind not in {"overtime", "owe", "attend"}:
        raise HTTPException(400, "kind 必须是 overtime / owe / attend")
    try:
        amount = float(payload.get("amount", 0))
    except (TypeError, ValueError):
        raise HTTPException(400, "amount 必须是数字") from None
    if kind == "owe" and amount > 0:
        amount = -abs(amount)  # 欠班统一存负数便于相加
    with db.connect() as con:
        cur = con.execute(
            "INSERT INTO adjustments(date,employee_id,kind,amount,note) VALUES(?,?,?,?,?)",
            (pick_date(payload), int(payload["employee_id"]), kind, amount, payload.get("note", "")),
        )
        row = dict(con.execute("SELECT * FROM adjustments WHERE id=?", (cur.lastrowid,)).fetchone())
    return row


@app.delete("/api/adjustments/{adj_id}")
def delete_adjustment(adj_id: int):
    with db.connect() as con:
        con.execute("DELETE FROM adjustments WHERE id=?", (adj_id,))
    return {"ok": True}


# ---------------------------------------------------------------- 统计
@app.get("/api/stats")
def stats(date_from: str = Query(...), date_to: str = Query(...),
          employee_id: Optional[str] = None, include_inactive: bool = False):
    ids = [int(x) for x in employee_id.split(",") if x.strip().isdigit()] if employee_id else None
    settings = _settings()
    with db.connect() as con:
        return calc.compute_stats(con, date_from, date_to, settings, ids, include_inactive)


@app.get("/api/stats/monthly")
def stats_monthly(date_from: str = Query(...), date_to: str = Query(...),
                  employee_id: Optional[str] = None):
    ids = [int(x) for x in employee_id.split(",") if x.strip().isdigit()] if employee_id else None
    settings = _settings()
    with db.connect() as con:
        return calc.monthly_series(con, date_from, date_to, settings, ids)


@app.get("/api/stats/daily")
def stats_daily(date_from: str = Query(...), date_to: str = Query(...)):
    settings = _settings()
    with db.connect() as con:
        return calc.daily_series(con, date_from, date_to, settings)


@app.get("/api/stats/heatmap")
def stats_heatmap(date_from: str = Query(...), date_to: str = Query(...)):
    """人员 x 日期 的班次矩阵，供热力图。"""
    settings = _settings()
    with db.connect() as con:
        emps = [dict(r) for r in con.execute(
            "SELECT id,name FROM employees WHERE active=1 ORDER BY sort_order, id")]
        shifts = {r["code"]: dict(r) for r in con.execute("SELECT * FROM shifts")}
        rows = [dict(r) for r in con.execute(
            "SELECT date,employee_id,shift_code FROM assignments WHERE date BETWEEN ? AND ?",
            (date_from, date_to))]
        days = calc.workday_map(con, dt.date.fromisoformat(date_from),
                                dt.date.fromisoformat(date_to), settings)
    cells = defaultdict(list)
    for r in rows:
        cells[(r["employee_id"], r["date"])].append(r["shift_code"])
    return {
        "employees": emps,
        "shifts": shifts,
        "days": [{"date": d, "is_workday": v} for d, v in sorted(days.items())],
        "cells": [{"employee_id": e, "date": d, "shifts": s} for (e, d), s in cells.items()],
    }


# ---------------------------------------------------------------- 工作日历
@app.get("/api/calendar")
def get_calendar(date_from: str = Query(...), date_to: str = Query(...)):
    settings = _settings()
    with db.connect() as con:
        days = calc.workday_map(con, dt.date.fromisoformat(date_from),
                                dt.date.fromisoformat(date_to), settings)
        overrides = {r["date"]: {"is_workday": bool(r["is_workday"]), "note": r["note"]}
                     for r in con.execute(
                         "SELECT * FROM calendar_days WHERE date BETWEEN ? AND ?",
                         (date_from, date_to))}
    return {
        "work_weekdays": settings.get("work_weekdays", "0,1,2,3,4,5,6"),
        "days": [{"date": d, "is_workday": v, "override": overrides.get(d)} for d, v in sorted(days.items())],
    }


@app.put("/api/calendar")
def set_calendar(payload: dict = Body(...)):
    """payload: {dates: [...], is_workday: bool, note: ""} 或 {date: "...", is_workday: bool}
    is_workday 为 null 表示清除覆盖。"""
    dates = payload.get("dates") or ([pick_date(payload)] if payload.get("date") else [])
    if not dates:
        raise HTTPException(400, "需要 dates")
    is_workday = payload.get("is_workday")
    with db.connect() as con:
        for d in dates:
            if is_workday is None:
                con.execute("DELETE FROM calendar_days WHERE date=?", (d,))
            else:
                con.execute(
                    "INSERT INTO calendar_days(date,is_workday,note) VALUES(?,?,?) "
                    "ON CONFLICT(date) DO UPDATE SET is_workday=excluded.is_workday, note=excluded.note",
                    (d, 1 if is_workday else 0, payload.get("note", "")),
                )
    return {"ok": True}


# ---------------------------------------------------------------- Excel 导入
@app.post("/api/import/preview")
async def import_preview(file: UploadFile = File(...),
                         year: Optional[int] = None, month: Optional[int] = None):
    """上传 Excel -> 返回识别到的条目与建议映射，不写库。"""
    content = await file.read()
    if not content:
        raise HTTPException(400, "文件为空")
    try:
        parsed = excel_parse.parse_workbook(content, file.filename or "", year, month)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    with db.connect() as con:
        shifts = [dict(r) for r in con.execute(
            "SELECT * FROM shifts WHERE active=1 ORDER BY sort_order, code")]
        employees = [dict(r) for r in con.execute(
            "SELECT id,name,employee_no FROM employees ORDER BY sort_order, id")]

    tokens = [t["token"] for t in parsed["tokens"]]
    mapping = excel_parse.suggest_mapping(tokens, shifts)
    meta = excel_parse.token_meta(tokens)

    # 已知人员/新人员匹配
    by_name = {e["name"].strip(): e for e in employees}
    by_no = {e["employee_no"].strip(): e for e in employees if e["employee_no"].strip()}
    name_status = []
    for n in parsed["names"]:
        hit = by_name.get(n.strip())
        name_status.append({"name": n, "employee_id": hit["id"] if hit else None,
                            "exists": bool(hit)})

    # 暂存解析结果，提交时按 token 复用
    token = hashlib.sha1(content).hexdigest()[:16]
    stage_path = os.path.join(STAGING_DIR, f"{token}.json")
    with open(stage_path, "w", encoding="utf-8") as fh:
        json.dump({"entries": parsed["entries"], "filename": parsed["filename"]}, fh, ensure_ascii=False)
    _prune_staging()

    return {
        "token": token,
        "filename": parsed["filename"],
        "layouts": parsed["layouts"],
        "summary": {
            "dates": [parsed["dates"][0], parsed["dates"][-1]] if parsed["dates"] else [],
            "date_count": len(parsed["dates"]),
            "people": len(parsed["names"]),
            "entries": len(parsed["entries"]),
            "token_count": len(tokens),
        },
        "tokens": parsed["tokens"],
        "token_meta": meta,
        "mapping": mapping,
        "names": name_status,
        "employees": employees,
        "shifts": shifts,
        "preview": parsed["entries"][:300],
    }


@app.post("/api/import/commit")
def import_commit(payload: dict = Body(...)):
    """提交导入。

    payload: {
      token, mapping: {raw_token: shift_code | null | "__skip__"},
      new_employees: [names...] 或 auto_create: true,
      create_missing_shifts: bool,
      replace: bool  -- 是否先清空这些日期+人员的已有排班
    }
    """
    token = payload.get("token")
    if not token or not re.fullmatch(r"[0-9a-f]{16}", str(token)):
        raise HTTPException(400, "token 无效，请重新上传文件")
    stage_path = os.path.join(STAGING_DIR, f"{token}.json")
    if not os.path.exists(stage_path):
        raise HTTPException(404, "上传的解析结果已过期，请重新上传")

    with open(stage_path, encoding="utf-8") as fh:
        staged = json.load(fh)
    entries = staged["entries"]

    mapping: dict = payload.get("mapping") or {}
    create_missing_shifts = bool(payload.get("create_missing_shifts", False))
    auto_create = bool(payload.get("auto_create", True))
    replace = bool(payload.get("replace", True))
    name_map_input: dict = payload.get("name_map") or {}

    stats = {"inserted": 0, "skipped": 0, "employees_created": 0,
             "shifts_created": 0, "employees": [], "deleted": 0}

    with db.connect() as con:
        shifts = {r["code"]: dict(r) for r in con.execute("SELECT * FROM shifts")}

        # 时间段标记 -> 按工时折算成班次（8 小时 = 1 班）
        token_shift: dict[str, str] = {}
        for raw, code in mapping.items():
            if code != excel_parse.AUTO_HOURS:
                continue
            spec = excel_parse.auto_shift_for_token(raw)
            if not spec:
                mapping[raw] = "__skip__"
                continue
            token_shift[raw] = spec["code"]
            if spec["code"] not in shifts:
                con.execute(
                    "INSERT INTO shifts(code,name,weight,color,sort_order) VALUES(?,?,?,?,?) "
                    "ON CONFLICT(code) DO NOTHING",
                    (spec["code"], spec["name"], spec["weight"], spec["color"], 60 + int(spec["weight"] * 10)),
                )
                shifts[spec["code"]] = spec
                stats["shifts_created"] += 1
        for raw, code in token_shift.items():
            mapping[raw] = code

        # 按需创建新班次（未映射 token 但勾选了 create_missing_shifts）
        for raw, code in mapping.items():
            if code in ("__skip__", None, excel_parse.AUTO_HOURS):
                continue
            if code not in shifts:
                if create_missing_shifts:
                    con.execute(
                        "INSERT INTO shifts(code,name,weight,color,sort_order) VALUES(?,?,?,?,?)",
                        (code, raw, 1.0, "#898781", 500),
                    )
                    shifts[code] = {"code": code, "name": raw, "weight": 1.0}
                    stats["shifts_created"] += 1
                else:
                    raise HTTPException(400, f"班次代码「{code}」不存在，请先创建或勾选自动创建")

        emps = {r["name"].strip(): dict(r) for r in con.execute("SELECT * FROM employees")}
        by_no = {e["employee_no"].strip(): e for e in emps.values() if e["employee_no"].strip()}

        def resolve_employee(raw_name: str, emp_no: str, team: str) -> int | None:
            mapped = name_map_input.get(raw_name)
            if mapped == "__skip__":
                return None
            target_name = (mapped or raw_name).strip()
            if target_name == "":
                return None
            if target_name in emps:
                return emps[target_name]["id"]
            if emp_no and emp_no in by_no:
                e = by_no[emp_no]
                emps[target_name] = e
                return e["id"]
            if not auto_create:
                return None
            cur = con.execute(
                "INSERT INTO employees(name,employee_no,team,expect_mode,sort_order) VALUES(?,?,?,?,?)",
                (target_name, emp_no, team, "auto", 999),
            )
            emp = dict(con.execute("SELECT * FROM employees WHERE id=?", (cur.lastrowid,)).fetchone())
            emps[target_name] = emp
            if emp_no:
                by_no[emp_no] = emp
            stats["employees_created"] += 1
            stats["employees"].append(target_name)
            return emp["id"]

        touched = set()
        for e in entries:
            code = mapping.get(e["raw"])
            if code is None or code == "__skip__":
                stats["skipped"] += 1
                continue
            eid = resolve_employee(e["name"], e.get("employee_no", ""), e.get("team", ""))
            if eid is None:
                stats["skipped"] += 1
                continue
            touched.add((e["date"], eid))

        if replace and touched:
            for d, eid in touched:
                cur = con.execute("DELETE FROM assignments WHERE date=? AND employee_id=?", (d, eid))
                stats["deleted"] += cur.rowcount

        for e in entries:
            code = mapping.get(e["raw"])
            if code is None or code == "__skip__":
                continue
            eid = resolve_employee(e["name"], e.get("employee_no", ""), e.get("team", ""))
            if eid is None:
                continue
            cur = con.execute(
                "INSERT INTO assignments(date,employee_id,shift_code,note,source) VALUES(?,?,?,?,?) "
                "ON CONFLICT(date,employee_id,shift_code) DO NOTHING",
                (e["date"], eid, code, "", "import"),
            )
            stats["inserted"] += cur.rowcount

    try:
        os.remove(stage_path)
    except OSError:
        pass

    stats.pop("employees", None)
    return {"ok": True, **stats}


def _prune_staging(max_age_hours: int = 24) -> None:
    cutoff = dt.datetime.now().timestamp() - max_age_hours * 3600
    for fn in os.listdir(STAGING_DIR):
        p = os.path.join(STAGING_DIR, fn)
        try:
            if os.path.getmtime(p) < cutoff:
                os.remove(p)
        except OSError:
            pass


# ---------------------------------------------------------------- 备份
@app.get("/api/backup")
def backup():
    """导出完整数据 JSON。"""
    with db.connect() as con:
        data = {
            "exported_at": dt.datetime.now().isoformat(timespec="seconds"),
            "version": 1,
            "employees": [dict(r) for r in con.execute("SELECT * FROM employees")],
            "shifts": [dict(r) for r in con.execute("SELECT * FROM shifts")],
            "assignments": [dict(r) for r in con.execute("SELECT * FROM assignments")],
            "adjustments": [dict(r) for r in con.execute("SELECT * FROM adjustments")],
            "calendar_days": [dict(r) for r in con.execute("SELECT * FROM calendar_days")],
            "settings": db.get_settings(con),
        }
    return JSONResponse(data, headers={
        "Content-Disposition": f'attachment; filename="schedule-backup-{dt.date.today().isoformat()}.json"'
    })


@app.post("/api/restore")
def restore(payload: dict = Body(...)):
    """从备份 JSON 恢复（覆盖全部数据，需 confirm=true）。"""
    if not payload.get("confirm"):
        raise HTTPException(400, "需要 confirm=true 才会覆盖数据")
    data = payload.get("data") or payload
    with db.connect() as con:
        con.execute("DELETE FROM assignments")
        con.execute("DELETE FROM adjustments")
        con.execute("DELETE FROM calendar_days")
        con.execute("DELETE FROM employees")
        con.execute("DELETE FROM shifts")
        con.execute("DELETE FROM settings")
        for e in data.get("employees", []):
            con.execute(
                "INSERT INTO employees(id,name,employee_no,team,expect_mode,monthly_quota,active,sort_order,note) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                (e["id"], e["name"], e.get("employee_no", ""), e.get("team", ""),
                 e.get("expect_mode", "auto"), e.get("monthly_quota"),
                 e.get("active", 1), e.get("sort_order", 0), e.get("note", "")))
        for s in data.get("shifts", []):
            con.execute(
                "INSERT INTO shifts(code,name,weight,color,sort_order,active) VALUES(?,?,?,?,?,?)",
                (s["code"], s["name"], s.get("weight", 1), s.get("color", "#2a78d6"),
                 s.get("sort_order", 0), s.get("active", 1)))
        for a in data.get("assignments", []):
            con.execute(
                "INSERT INTO assignments(date,employee_id,shift_code,note,source) VALUES(?,?,?,?,?)",
                (a["date"], a["employee_id"], a["shift_code"], a.get("note", ""), a.get("source", "manual")))
        for a in data.get("adjustments", []):
            con.execute(
                "INSERT INTO adjustments(date,employee_id,kind,amount,note) VALUES(?,?,?,?,?)",
                (a["date"], a["employee_id"], a["kind"], a["amount"], a.get("note", "")))
        for c in data.get("calendar_days", []):
            con.execute("INSERT INTO calendar_days(date,is_workday,note) VALUES(?,?,?)",
                        (c["date"], c["is_workday"], c.get("note", "")))
        for k, v in (data.get("settings") or {}).items():
            con.execute("INSERT INTO settings(key,value) VALUES(?,?)", (k, str(v)))
    return {"ok": True}


# ---------------------------------------------------------------- 静态资源
@app.get("/")
def index():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))


@app.get("/sw.js")
def service_worker():
    return FileResponse(os.path.join(FRONTEND_DIR, "sw.js"),
                        media_type="application/javascript",
                        headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(os.path.join(FRONTEND_DIR, "manifest.webmanifest"),
                        media_type="application/manifest+json")


app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("SCHEDULE_HOST", "0.0.0.0")
    port = int(os.environ.get("SCHEDULE_PORT", "8765"))
    uvicorn.run(app, host=host, port=port)
