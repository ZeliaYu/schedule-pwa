"""SQLite 数据层：员工、班次、排班、手工调整、工作日历、设置。"""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager

DB_PATH = os.environ.get(
    "SCHEDULE_DB",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "schedule.db"),
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS employees (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    employee_no   TEXT NOT NULL DEFAULT '',
    team          TEXT NOT NULL DEFAULT '',
    expect_mode   TEXT NOT NULL DEFAULT 'auto',      -- auto: 跟随工作日历 | fixed: 月度定额
    monthly_quota REAL,                              -- fixed 模式下的应出勤班次
    active        INTEGER NOT NULL DEFAULT 1,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    note          TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS shifts (
    code       TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    weight     REAL NOT NULL DEFAULT 1,
    color      TEXT NOT NULL DEFAULT '#2a78d6',
    sort_order INTEGER NOT NULL DEFAULT 0,
    active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS assignments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL,                       -- YYYY-MM-DD
    employee_id INTEGER NOT NULL,
    shift_code  TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'manual',
    UNIQUE(date, employee_id, shift_code),
    FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_assign_date ON assignments(date);
CREATE INDEX IF NOT EXISTS idx_assign_emp  ON assignments(employee_id);

CREATE TABLE IF NOT EXISTS adjustments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL,
    employee_id INTEGER NOT NULL,
    kind        TEXT NOT NULL,                       -- overtime: 加班 | owe: 欠班 | attend: 补出勤
    amount      REAL NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_adj_emp ON adjustments(employee_id, date);

CREATE TABLE IF NOT EXISTS calendar_days (
    date       TEXT PRIMARY KEY,
    is_workday INTEGER NOT NULL,
    note       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

DEFAULT_SHIFTS = [
    # code, 名称, 记班系数, 颜色, 排序
    ("morning", "白班", 1.0, "#2a78d6", 10),
    ("evening", "中班", 1.0, "#eb6834", 20),
    ("night", "夜班", 1.0, "#4a3aa7", 30),
    ("half", "半班", 0.5, "#1baf7a", 40),
]

DEFAULT_SETTINGS = {
    "work_weekdays": "1,2,3,4,5,6",   # 周一~周六为工作日（0=周日 … 6=周六）
    "day_view_shifts": "morning,evening,night",
    "org_name": "排班管理",
    "stats_start_date": "",           # 统计起点；此日之前的记录只累计已上，不计应出勤
}


def _migrate(con: sqlite3.Connection) -> None:
    """轻量迁移：给旧库补齐新增列。"""
    cols = {r["name"] for r in con.execute("PRAGMA table_info(employees)")}
    if "employee_no" not in cols:
        con.execute("ALTER TABLE employees ADD COLUMN employee_no TEXT NOT NULL DEFAULT ''")


@contextmanager
def connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def init_db() -> None:
    with connect() as con:
        con.executescript(SCHEMA)
        _migrate(con)
        if con.execute("SELECT COUNT(*) FROM shifts").fetchone()[0] == 0:
            con.executemany(
                "INSERT INTO shifts(code,name,weight,color,sort_order) VALUES(?,?,?,?,?)",
                DEFAULT_SHIFTS,
            )
        for k, v in DEFAULT_SETTINGS.items():
            con.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (k, v))


def get_settings(con: sqlite3.Connection) -> dict:
    return {r["key"]: r["value"] for r in con.execute("SELECT key,value FROM settings")}


def set_settings(con: sqlite3.Connection, data: dict) -> None:
    for k, v in data.items():
        con.execute(
            "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (k, "" if v is None else str(v)),
        )
