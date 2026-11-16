"""生成用于测试 / 演示的排班 Excel（三种版式各一个）。"""
from __future__ import annotations

import calendar
import datetime as dt
import io
import os
import random

import openpyxl

NAMES = ["张伟", "王芳", "李强", "刘洋", "陈静", "赵磊", "孙悦", "周涛"]
SHIFTS = ["白班", "中班", "夜班"]


def _workdays(year: int, month: int) -> list[dt.date]:
    n = calendar.monthrange(year, month)[1]
    return [dt.date(year, month, d) for d in range(1, n + 1)]


def make_matrix_rows(year: int, month: int, seed: int = 7) -> bytes:
    """版式一：行=人员，列=日期。"""
    rnd = random.Random(seed)
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "11月排班"
    ws.append([f"{year}年{month}月 排班表"])
    ws.append([])
    days = _workdays(year, month)
    ws.append(["工号", "姓名", "班组"] + [f"{d.day}日" for d in days])
    for i, name in enumerate(NAMES):
        row = [f"{i + 1:03d}", name, "一班" if i < 4 else "二班"]
        for d in days:
            wd = d.weekday()
            if wd == 6:  # 周日休息
                row.append("休")
            else:
                row.append(SHIFTS[(i + d.day) % 3])
        ws.append(row)
    ws.column_dimensions["B"].width = 12
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def make_long(year: int, month: int, seed: int = 7) -> bytes:
    """版式二：长表，每行一条记录，含加班/欠班的原始标记。"""
    rnd = random.Random(seed)
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "明细"
    ws.append(["日期", "工号", "姓名", "班组", "班次"])
    for d in _workdays(year, month):
        if d.weekday() == 6:
            continue
        for i, name in enumerate(NAMES):
            r = rnd.random()
            if r < 0.1:
                continue  # 休息
            ws.append([d, f"{i + 1:03d}", name, "一班" if i < 4 else "二班",
                       SHIFTS[(i + d.day) % 3]])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def make_matrix_cols(year: int, month: int, seed: int = 7) -> bytes:
    """版式三：行=日期，列=人员。"""
    rnd = random.Random(seed)
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "排班"
    ws.append([f"{year}年{month}月"])
    ws.append(["日期"] + NAMES)
    for d in _workdays(year, month):
        row = [d]
        for i, _ in enumerate(NAMES):
            row.append("休" if d.weekday() == 6 else SHIFTS[(i + d.day) % 3])
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "samples")
    os.makedirs(out, exist_ok=True)
    files = {
        "示例-人员行矩阵.xlsx": make_matrix_rows(2026, 11),
        "示例-长表明细.xlsx": make_long(2026, 11),
        "示例-人员列矩阵.xlsx": make_matrix_cols(2026, 11),
    }
    for fn, data in files.items():
        with open(os.path.join(out, fn), "wb") as fh:
            fh.write(data)
        print("wrote", fn, len(data), "bytes")
