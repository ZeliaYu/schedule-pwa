"""Excel 排班表解析。

支持三种常见版式，自动识别：

1. 矩阵-人员行：行=人员，列=日期（月历表最常见）
      工号 | 姓名 | 1日 | 2日 | 3日 ...
       001 | 张三 | 白班 | 夜班 | 休

2. 矩阵-人员列：列=人员，行=日期（另一种常见写法）
      日期 | 张三 | 李四
      2026-11-01 | 白班 | 夜班

3. 长表：每行一条排班记录（系统导出常见）
      日期 | 姓名 | 班次

4. 按日分块：每天一个小表，日期只在块首行，班次写时间段（现场班表常见）
      2026.11.05 | 周四 | 姓名 | 班次          | 工作内容
                       | 凌丽 | 08：00-生产结束 | 理瓶
                       | 倪财豪 | 请假         | /
"""
from __future__ import annotations

import datetime as dt
import io
import re
from collections import Counter

import openpyxl

# 视为「休息 / 无排班」的单元格文本
REST_WORDS = {
    "休", "休息", "休班", "放假", "公休", "例休", "空", "无", "-", "—", "--", "/",
    "×", "x", "X", "0", "OFF", "off", "Off", "公休日", "外出", "年假", "事假",
}
NAME_KEYS = {"姓名", "名字", "员工", "员工姓名", "人员", "人员姓名"}
DATE_KEYS = {"日期", "date", "日期(日)", "日", "天"}
SHIFT_KEYS = {"班次", "班型", "班别", "shift", "班"}
NO_KEYS = {"工号", "编号", "员工编号", "员工号", "序号", "employee_no"}
TEAM_KEYS = {"班组", "部门", "组别", "team", "车间"}

DAY_HEADER_RE = re.compile(
    r"^(?:(\d{1,2})[日号]?"
    r"|(\d{1,2})/(\d{1,2})"
    r"|(\d{4})[-/.](\d{1,2})[-/.](\d{1,2}))$"
)
SKIP_NAME_RE = re.compile(r"合计|总计|小计|统计|备注|说明")


def _clean(v) -> str:
    if v is None:
        return ""
    if isinstance(v, dt.datetime):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, dt.date):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, dt.time):
        return v.strftime("%H:%M")
    return str(v).strip()


def _norm(v) -> str:
    return _clean(v).replace(" ", "").replace("　", "").lower()


def _is_rest(text: str) -> bool:
    t = text.strip()
    if not t:
        return True
    if t in REST_WORDS or t.lower() in {w.lower() for w in REST_WORDS}:
        return True
    # 只由休/假/空 组成的标记，如「休1」「公休」
    return bool(re.fullmatch(r"(休|假|公休|例休|空)+", t))


def _split_tokens(val: str) -> list[str]:
    """单元格内可能写多个班次：'白班/夜班'、'白+中'。"""
    parts = [p.strip() for p in re.split(r"[/、,，+＋\s]+", val) if p.strip()]
    return parts or [val]


def _find_month_context(rows: list[list], default_year: int, default_month: int) -> tuple[int, int]:
    """从表格前若干行嗅探 '2026年11月' / '2026-11' 之类的年月。"""
    for row in rows[:8]:
        for cell in row:
            t = _clean(cell)
            if not t:
                continue
            m = re.search(r"(20\d{2})\s*[年\-/.]\s*(\d{1,2})", t)
            if m and 1 <= int(m.group(2)) <= 12:
                return int(m.group(1)), int(m.group(2))
    return default_year, default_month


def _parse_date(cell, year: int, month: int) -> str | None:
    """把单元格解析成 ISO 日期；解析不了返回 None。"""
    if isinstance(cell, (dt.datetime, dt.date)):
        return cell.strftime("%Y-%m-%d")
    t = _clean(cell).replace(" ", "")
    if not t:
        return None
    m = DAY_HEADER_RE.match(t)
    if not m:
        return None
    try:
        if m.group(4):
            return dt.date(int(m.group(4)), int(m.group(5)), int(m.group(6))).isoformat()
        if m.group(2):
            return dt.date(year, int(m.group(2)), int(m.group(3))).isoformat()
        if m.group(1):
            return dt.date(year, month, int(m.group(1))).isoformat()
    except ValueError:
        return None
    return None


def parse_workbook(content: bytes, filename: str = "",
                   default_year: int | None = None,
                   default_month: int | None = None) -> dict:
    """解析 Excel，返回识别结果 + 待确认的班次映射。不做任何写库操作。"""
    today = dt.date.today()
    default_year = default_year or today.year
    default_month = default_month or today.month

    try:
        wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"无法读取 Excel 文件：{exc}") from exc

    sheets_out = []
    for ws in wb.worksheets:
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
        rows = [r for r in rows if any(_clean(c) for c in r)]
        if not rows:
            continue
        year, month = _find_month_context(rows, default_year, default_month)
        parsed = _parse_sheet(rows, year, month)
        if parsed["entries"]:
            parsed["sheet"] = ws.title
            parsed["year"], parsed["month"] = year, month
            sheets_out.append(parsed)

    if not sheets_out:
        raise ValueError("没能从文件中识别出排班数据。请确认表中有「姓名」列和日期列。")

    entries, names, tokens = [], [], Counter()
    layouts = []
    date_set = set()
    seen = set()
    for s in sheets_out:
        for e in s["entries"]:
            key = (e["date"], e["name"], e["raw"])
            if key in seen:
                continue
            seen.add(key)
            entries.append(e)
            date_set.add(e["date"])
            tokens[e["raw"]] += 1
            if e["name"] not in names:
                names.append(e["name"])
        layouts.append({"sheet": s["sheet"], "layout": s["layout"],
                        "count": len(s["entries"]), "month": f"{s['year']:04d}-{s['month']:02d}"})

    entries.sort(key=lambda e: (e["date"], e["name"]))
    return {
        "filename": filename,
        "layouts": layouts,
        "dates": sorted(date_set),
        "names": names,
        "tokens": [{"token": t, "count": c} for t, c in tokens.most_common()],
        "entries": entries,
    }


def _parse_sheet(rows: list[list], year: int, month: int) -> dict:
    # 0) 按日分块：首列是完整日期、整行含「姓名/班次」表头
    blocks = _find_date_blocks(rows)
    if blocks:
        return _parse_date_blocks(rows, blocks)

    # 1) 长表：表头行同时含 日期 + 姓名 + 班次
    for hi, row in enumerate(rows[:15]):
        keys = {_norm(c) for c in row}
        has_date = bool(keys & {_norm(k) for k in DATE_KEYS})
        has_shift = bool(keys & {_norm(k) for k in SHIFT_KEYS})
        has_name = bool(keys & {_norm(k) for k in NAME_KEYS})
        if has_date and has_shift and has_name:
            return _parse_long(rows, hi, year, month)

    # 2) 矩阵-人员行：某一行里出现 >=3 个日期表头
    best = None
    for hi, row in enumerate(rows[:15]):
        date_cols = {}
        for ci, cell in enumerate(row):
            iso = _parse_date(cell, year, month)
            if iso:
                date_cols[ci] = iso
        if len(date_cols) >= 3 and (best is None or len(date_cols) > len(best[1])):
            best = (hi, date_cols)
    if best:
        return _parse_matrix_rows(rows, best[0], best[1])

    # 3) 矩阵-人员列：表头是多个姓名，下面是日期
    for hi, row in enumerate(rows[:15]):
        persons = []
        for ci, cell in enumerate(row):
            if ci == 0:
                continue
            n = _clean(cell)
            if not n or _parse_date(n, year, month):
                continue
            persons.append((ci, n))
        if len(persons) >= 2 and hi + 1 < len(rows):
            nxt = rows[hi + 1]
            if nxt and _parse_date(nxt[0], year, month):
                return _parse_matrix_cols(rows, hi, year, month)

    return {"entries": [], "tokens": [], "names": [], "layout": "unrecognized"}


FULL_DATE_RE = re.compile(r"^\s*(\d{4})[.\-/年]\s*(\d{1,2})[.\-/月]\s*(\d{1,2})\s*[日号]?\s*$")
TIME_RANGE_RE = re.compile(r"^\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*[-–—~至]\s*(.+)$")
OPEN_END_WORDS = ("生产结束", "结束", "完", "下班", "过滤结束", "清洗结束")


def parse_time_token(token: str) -> dict:
    """解析班次标记。

    返回 {kind, hours, start, label}：
      kind  work   固定时段（hours 为小时数）
            open   开始时间固定、结束时间开放（到生产结束）
            rest   休息 / 请假 / 调休
            other  无法解析，需人工映射
    """
    raw = str(token or "").strip()
    t = (raw.replace("：", ":").replace("；", ";").replace("－", "-")
         .replace("—", "-").replace("–", "-").replace("~", "-")
         .replace("至", "-").replace(" ", "").replace("\n", ""))
    t = t.rstrip("-")
    if t in ("", "/", "\\", "-", "休", "休息", "公休", "例休", "空白"):
        return {"kind": "rest", "hours": 0.0, "start": None, "label": raw}

    for word in ("请假", "调休", "年假", "事假", "病假", "退休", "外出", "出差", "旷工"):
        if word in t:
            return {"kind": "rest", "hours": 0.0, "start": None, "label": raw, "note": word}

    m = TIME_RANGE_RE.match(t)
    if m:
        start = f"{int(m.group(1)):02d}:{m.group(2)}"
        end_raw = m.group(3)
        if any(w in end_raw for w in OPEN_END_WORDS):
            return {"kind": "open", "hours": None, "start": start, "label": raw}
        m2 = re.match(r"^(\d{1,2}):(\d{2})", end_raw)
        if m2:
            a = int(m.group(1)) * 60 + int(m.group(2))
            b = int(m2.group(1)) * 60 + int(m2.group(2))
            if b <= a:
                b += 24 * 60  # 跨夜
            return {"kind": "work", "hours": round((b - a) / 60, 2), "start": start, "label": raw}

    return {"kind": "other", "hours": None, "start": None, "label": raw}


def _find_date_blocks(rows: list[list]) -> list[tuple[int, str]]:
    """找出「按日分块」版式中每个日期块的首行索引与日期。

    判定：首列是完整日期，且该行后面有「姓名」和「班次」表头。
    """
    blocks = []
    for i, row in enumerate(rows):
        if not row:
            continue
        m = FULL_DATE_RE.match(_clean(row[0]))
        if not m:
            continue
        keys = {_norm(c) for c in row[1:8]}
        if any(k == "姓名" for k in keys) and any(k in {_norm(x) for x in SHIFT_KEYS} for k in keys):
            try:
                iso = dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
            except ValueError:
                continue
            blocks.append((i, iso))
    return blocks


def _parse_date_blocks(rows: list[list], blocks: list[tuple[int, str]]) -> dict:
    entries, names, tokens = [], [], Counter()
    seen = set()
    for bi, (start, iso) in enumerate(blocks):
        end = blocks[bi + 1][0] if bi + 1 < len(blocks) else len(rows)
        header = rows[start]
        keys = [_norm(c) for c in header]
        def col_of(target_keys, default):
            targets = {_norm(k) for k in target_keys}
            for ci, k in enumerate(keys):
                if k in targets:
                    return ci
            return default
        i_name = col_of(NAME_KEYS, 2)
        i_shift = col_of(SHIFT_KEYS, 3)
        i_note = col_of({"工作内容", "内容", "备注"}, i_shift + 1)

        for row in rows[start + 1:end]:
            if not row:
                continue
            name = _clean(row[i_name]) if i_name < len(row) else ""
            if not name or name in ("姓名", "合计", "总计") or FULL_DATE_RE.match(name):
                continue
            raw = _clean(row[i_shift]) if i_shift < len(row) else ""
            note = _clean(row[i_note]) if i_note is not None and i_note < len(row) else ""
            parsed = parse_time_token(raw)
            if parsed["kind"] == "rest":
                continue
            # 同一天同一人同一标记的去重（原始表常整块重复粘贴）
            key = (iso, name, raw, note)
            if key in seen:
                continue
            seen.add(key)
            entries.append({
                "date": iso, "name": name, "raw": raw,
                "employee_no": "", "team": "",
                "kind": parsed["kind"], "hours": parsed["hours"],
                "note": note,
            })
            tokens[raw] += 1
            if name not in names:
                names.append(name)
    return {"entries": entries, "names": names, "tokens": list(tokens),
            "layout": "date_blocks"}


def _parse_long(rows, hi, year, month) -> dict:
    header = [_norm(c) for c in rows[hi]]

    def col_of(keys):
        targets = {_norm(k) for k in keys}
        for i, h in enumerate(header):
            if h in targets:
                return i
        return None

    i_date = col_of(DATE_KEYS)
    i_shift = col_of(SHIFT_KEYS)
    i_name = col_of(NAME_KEYS)
    i_no = col_of(NO_KEYS)
    i_team = col_of(TEAM_KEYS)

    entries, names, tokens = [], [], Counter()
    for row in rows[hi + 1:]:
        def cell(i):
            return _clean(row[i]) if i is not None and i < len(row) else ""
        iso = _parse_date(cell(i_date), year, month)
        name = cell(i_name)
        shift = cell(i_shift)
        if not iso or not name or _is_rest(shift) or SKIP_NAME_RE.search(name):
            continue
        for part in _split_tokens(shift):
            entries.append({"date": iso, "name": name, "raw": part,
                            "employee_no": cell(i_no), "team": cell(i_team)})
            tokens[part] += 1
        if name not in names:
            names.append(name)
    return {"entries": entries, "names": names, "tokens": list(tokens), "layout": "long"}


def _parse_matrix_rows(rows, hi, date_cols) -> dict:
    """行=人员，列=日期。"""
    header = rows[hi]
    name_col = None
    for ci, cell in enumerate(header):
        if ci in date_cols:
            continue
        if _norm(cell) in {_norm(k) for k in NAME_KEYS}:
            name_col = ci
            break
    if name_col is None:
        name_col = next((ci for ci in range(len(header)) if ci not in date_cols and _clean(header[ci])), 0)

    # 非日期列里找 工号 / 班组（可能在姓名左右任意一侧）
    no_col = team_col = None
    for ci, cell in enumerate(header):
        if ci in date_cols:
            continue
        k = _norm(cell)
        if k in {_norm(x) for x in NO_KEYS}:
            no_col = ci
        elif k in {_norm(x) for x in TEAM_KEYS}:
            team_col = ci

    entries, names, tokens = [], [], Counter()
    for row in rows[hi + 1:]:
        if name_col >= len(row):
            continue
        name = _clean(row[name_col])
        if not name or SKIP_NAME_RE.search(name):
            continue
        if _norm(name) in {_norm(k) for k in NAME_KEYS | DATE_KEYS}:
            continue
        added = False
        for c, iso in date_cols.items():
            if c >= len(row):
                continue
            val = _clean(row[c])
            if _is_rest(val):
                continue
            for part in _split_tokens(val):
                entries.append({
                    "date": iso, "name": name, "raw": part,
                    "employee_no": _clean(row[no_col]) if no_col is not None and no_col < len(row) else "",
                    "team": _clean(row[team_col]) if team_col is not None and team_col < len(row) else "",
                })
                tokens[part] += 1
                added = True
        if added and name not in names:
            names.append(name)
    return {"entries": entries, "names": names, "tokens": list(tokens), "layout": "matrix_rows"}


def _parse_matrix_cols(rows, hi, year, month) -> dict:
    """行=日期，列=人员。"""
    persons = []
    for ci, cell in enumerate(rows[hi]):
        if ci == 0:
            continue
        n = _clean(cell)
        if n and not _parse_date(n, year, month):
            persons.append((ci, n))

    entries, tokens = [], Counter()
    for row in rows[hi + 1:]:
        if not row:
            continue
        iso = _parse_date(row[0], year, month)
        if not iso:
            continue
        for ci, name in persons:
            if ci >= len(row):
                continue
            val = _clean(row[ci])
            if _is_rest(val):
                continue
            for part in _split_tokens(val):
                entries.append({"date": iso, "name": name, "raw": part,
                                "employee_no": "", "team": ""})
                tokens[part] += 1
    return {"entries": entries, "names": [p[1] for p in persons],
            "tokens": list(tokens), "layout": "matrix_cols"}


AUTO_HOURS = "__auto_hours__"
HOURS_PER_SHIFT = 8.0

# 按折算后的班数给标准命名（避免班次类型过多）
WEIGHT_SHIFT_NAMES = {
    0.5: ("half", "半班", "#1baf7a"),
    1.0: ("morning", "白班", "#2a78d6"),
    1.5: ("long15", "一点五班", "#eda100"),
    2.0: ("double", "连班", "#4a3aa7"),
}


def auto_shift_for_token(token: str) -> dict | None:
    """按工时把时间段标记折成班次。

    8 小时 = 1 班；按最近的 0.5 班取整，避免出现 8.5/9.5 小时这类碎片班次。
    「到生产结束」按 1 班。
    """
    info = parse_time_token(token)
    if info["kind"] == "work" and info["hours"]:
        raw = info["hours"] / HOURS_PER_SHIFT
        weight = round(raw * 2) / 2          # 四舍五入到 0.5
    elif info["kind"] == "open":
        weight = 1.0
    else:
        return None
    weight = max(0.5, min(weight, 4.0))

    preset = WEIGHT_SHIFT_NAMES.get(weight)
    if preset:
        code, name, color = preset
    else:
        code = "w" + str(weight).replace(".", "_")
        name = f"{weight:g}班"
        color = "#898781"
    return {"code": code, "name": name, "weight": weight, "color": color}


def suggest_mapping(tokens: list[str], shifts: list[dict]) -> dict[str, str | None]:
    """给出 token -> 班次 code 的初始建议。

    · 与已有班次同名/同代码 -> 直接用
    · 时间段标记 -> "__auto_hours__"（提交时按工时折算）
    · 休息类 -> "__skip__"
    · 其余 -> None（需人工选择）
    """
    by_name = {}
    for s in shifts:
        by_name[s["name"].strip().lower()] = s["code"]
        by_name[s["code"].strip().lower()] = s["code"]

    out = {}
    for t in tokens:
        t_low = t.strip().lower()
        if t_low in by_name:
            out[t] = by_name[t_low]
            continue

        info = parse_time_token(t)
        if info["kind"] == "rest":
            out[t] = "__skip__"
            continue
        if auto_shift_for_token(t):
            out[t] = AUTO_HOURS
            continue

        # 名称包含关系兜底（「白班A」-> 白班）
        hit = None
        for name, code in by_name.items():
            if len(name) >= 2 and (name in t_low or t_low in name):
                hit = code
                break
        out[t] = hit
    return out


def token_meta(tokens: list[str]) -> dict[str, dict]:
    """给前端展示用的标记信息：类型与工时。"""
    meta = {}
    for t in tokens:
        info = parse_time_token(t)
        meta[t] = {
            "kind": info["kind"],
            "hours": info["hours"],
            "start": info.get("start"),
            "note": info.get("note", ""),
        }
    return meta
