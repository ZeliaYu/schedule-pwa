"""回归测试：解析器 4 种版式 + 工时折算 + 统计口径 + 备份恢复。

用法（项目根目录）：
    D:/Anaconda3/envs/NAFNet/python.exe backend/test_regress.py
"""
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

os.environ["SCHEDULE_DB"] = os.path.join(BASE, "data", "_regress.db")
if os.path.exists(os.environ["SCHEDULE_DB"]):
    os.remove(os.environ["SCHEDULE_DB"])

from fastapi.testclient import TestClient  # noqa: E402

import app as A  # noqa: E402
import excel_parse  # noqa: E402

c = TestClient(A.app)
results = []


def ok(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    results.append(bool(cond))
    return cond


def sample(*parts):
    return os.path.join(BASE, "samples", *parts)


# ---------------------------------------------------------------- 1) 四种版式
CASES = [
    (sample("示例-人员行矩阵.xlsx"), "matrix_rows"),
    (sample("示例-人员列矩阵.xlsx"), "matrix_cols"),
    (sample("示例-长表明细.xlsx"), "long"),
]
# 真实班表含员工姓名，不入库；本地有才测
real = os.path.join(BASE, "冻干排班.xlsx")
if os.path.exists(real):
    CASES.append((real, "date_blocks"))
else:
    print("SKIP 冻干排班.xlsx（真实班表未随仓库分发）")

for path, expect in CASES:
    with open(path, "rb") as fh:
        r = excel_parse.parse_workbook(fh.read(), path)
    layouts = {l["layout"] for l in r["layouts"]}
    ok(expect in layouts and len(r["entries"]) > 0,
       f"{os.path.basename(path)} -> {sorted(layouts)} 条目={len(r['entries'])} 人数={len(r['names'])}")

# ---------------------------------------------------------------- 2) 工时折算
conv = excel_parse.auto_shift_for_token
rest = excel_parse.parse_time_token
ok(conv("08:00-16:00")["weight"] == 1.0, "8 小时 -> 1 班")
ok(conv("16:00-08:00")["weight"] == 2.0, "16 小时跨夜 -> 2 班")
ok(conv("08:00-12:00")["weight"] == 0.5, "4 小时 -> 0.5 班")
ok(conv("08:00-生产结束")["weight"] == 1.0, "到生产结束 -> 1 班")
ok(conv("08:00-17:00")["weight"] == 1.0, "9 小时 -> 取整 1 班")
ok(conv("请假") is None and rest("请假")["kind"] == "rest", "请假 -> 休息")

# ---------------------------------------------------------------- 3) 导入 + 统计
with open(sample("示例-长表明细.xlsx"), "rb") as fh:
    p = c.post("/api/import/preview",
               files={"file": ("a.xlsx", fh.read(), "application/octet-stream")}).json()
commit = c.post("/api/import/commit", json={"token": p["token"], "mapping": p["mapping"]}).json()
ok(commit["inserted"] == p["summary"]["entries"], f"导入 {commit['inserted']} 条")

s = c.get("/api/stats", params={"date_from": "2026-11-01", "date_to": "2026-11-30"}).json()
emp = s["employees"][0]
ok(abs(emp["net_final"] - (emp["net"] + emp["manual_overtime"])) < 1e-6,
   "净值 = 本期差额 + 手工调整")
ok(emp["overtime"] >= 0 and emp["owe"] >= 0 and not (emp["overtime"] > 0 and emp["owe"] > 0),
   "加班与欠班互斥")

# ---------------------------------------------------------------- 4) 手工调整
eid = emp["employee_id"]
c.post("/api/adjustments", json={"date": "2026-11-10", "employee_id": eid,
                                "kind": "overtime", "amount": 2})
c.post("/api/adjustments", json={"date": "2026-11-11", "employee_id": eid,
                                "kind": "owe", "amount": 1.5})
s2 = c.get("/api/stats", params={"date_from": "2026-11-01", "date_to": "2026-11-30"}).json()
e2 = next(x for x in s2["employees"] if x["employee_id"] == eid)
ok(abs(e2["net_final"] - (e2["net"] + 0.5)) < 1e-6, f"加班 +2、欠班 -1.5 -> 净值 {e2['net_final']}")

# ---------------------------------------------------------------- 5) 未来日期
s3 = c.get("/api/stats", params={"date_from": "2026-11-01", "date_to": "2030-12-31"}).json()
ok(s3["workdays"] <= 30, f"未来日期不计入应出勤（应出勤天数 {s3['workdays']}）")

# ---------------------------------------------------------------- 6) 统计起点
c.put("/api/settings", json={"stats_start_date": "2026-11-20"})
s4 = c.get("/api/stats", params={"date_from": "2026-11-01", "date_to": "2026-11-30"}).json()
ok(s4["historical"] and s4["counted_from"] == "2026-11-20", "统计起点生效")
c.put("/api/settings", json={"stats_start_date": ""})

# ---------------------------------------------------------------- 7) 备份 / 恢复
backup = c.get("/api/backup").json()
n_before = len(c.get("/api/employees").json())
c.post("/api/restore", json={"confirm": True, "data": backup})
ok(len(c.get("/api/employees").json()) == n_before, "备份/恢复后人员数一致")

# ---------------------------------------------------------------- 8) 工作日
cal = c.get("/api/calendar", params={"date_from": "2026-11-01", "date_to": "2026-11-08"}).json()
d = {x["date"]: x["is_workday"] for x in cal["days"]}
ok(d["2026-11-01"] is False and d["2026-11-02"] is True and d["2026-11-08"] is False,
   "周日休息、周一上班")

try:
    os.remove(os.environ["SCHEDULE_DB"])
except OSError:
    pass

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
