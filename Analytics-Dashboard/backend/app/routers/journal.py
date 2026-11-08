"""Журнал записів модулів (пошук, сортування, сторінки) та експорт CSV (UTF-8 BOM, «;»)."""
import csv
import io

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from ..db import all_rows, one_row
from ..filters import get_filters, where
from ..labels import LABELS, NO_DATA
from ..routers.losses import mask_small
from ..schemas import Filters

router = APIRouter(prefix="/api", tags=["Журнал і експорт"])

T = "'HH24.MI DD.MM.YYYY'"  # формат часу за п. 2.1.1 Порядку

# Колонка: (ключ, заголовок у називному відмінку однини, SQL-вираз, словник підписів або None)
MODULES = {
    "air": {
        "title": "ПЕРЕЛІК повітряних ударів",
        "from": ("FROM strike_events s JOIN weapon_types w ON w.id = s.weapon_type_id "
                 "JOIN oblasts o ON o.id = s.oblast_id LEFT JOIN target_categories t ON t.id = s.target_category_id"),
        "where": lambda f: where(f, ts="s.occurred_at", oblast="s.oblast_id", extra={"w.code": f.weapon}),
        "cols": [("time", "Час", f"to_char(s.occurred_at, {T})", None, "s.occurred_at"),
                 ("oblast", "Область", "o.name_ua", None, None),
                 ("weapon", "Засіб", "w.name_ua", None, None),
                 ("launched", "Запущено, од.", "s.launched", None, None),
                 ("intercepted", "Збито, од.", "s.intercepted", None, None),
                 ("suppressed", "Подавлено РЕБ, од.", "s.suppressed", None, None),
                 ("hits", "Влучання, од.", "s.hits", None, None),
                 ("target", "Категорія цілі", "t.name_ua", None, None),
                 ("source", "Джерело", "s.info_source", None, None),
                 ("reliability", "Достовірність", "s.reliability", None, None),
                 ("origin", "Походження запису", "s.origin", "origin", None)],
        "search": ["o.name_ua", "w.name_ua", "t.name_ua"],
        "default": "s.occurred_at DESC",
        "pk": "s.id",
    },
    "alerts": {
        "title": "ПЕРЕЛІК повітряних тривог",
        "from": "FROM air_alerts a JOIN oblasts o ON o.id = a.oblast_id",
        "where": lambda f: where(f, ts="a.started_at", oblast="a.oblast_id"),
        "cols": [("start", "Початок", f"to_char(a.started_at, {T})", None, "a.started_at"),
                 ("end", "Кінець", f"to_char(a.ended_at, {T})", None, "a.ended_at"),
                 ("oblast", "Область", "o.name_ua", None, None),
                 ("type", "Тип тривоги", "a.alert_type", "alert_type", None),
                 ("duration", "Тривалість, хв", "a.duration_min", None, None),
                 ("origin", "Походження запису", "a.origin", "origin", None)],
        "search": ["o.name_ua"],
        "default": "a.started_at DESC",
        "pk": "a.id",
    },
    "artillery": {
        "title": "ПЕРЕЛІК артилерійських обстрілів",
        "from": ("FROM artillery_fire a JOIN oblasts o ON o.id = a.oblast_id LEFT JOIN units u ON u.id = a.unit_id"),
        "where": lambda f: where(f, ts="a.occurred_at", oblast="a.oblast_id", unit="a.unit_id",
                                 extra={"a.system_type": f.system, "a.direction": f.direction}),
        "cols": [("time", "Час", f"to_char(a.occurred_at, {T})", None, "a.occurred_at"),
                 ("direction", "Напрямок вогню", "a.direction", "direction", None),
                 ("system", "Система", "a.system_type", "system_type", None),
                 ("caliber", "Калібр, мм", "a.caliber_mm", None, None),
                 ("class", "Клас калібру", "a.caliber_class", "caliber_class", None),
                 ("rounds", "Кількість пострілів", "a.rounds", None, None),
                 ("oblast", "Область", "o.name_ua", None, None),
                 ("unit", "Підрозділ", "u.short_name", None, None),
                 ("result", "Результат ураження", "a.result", "result", None),
                 ("source", "Джерело", "a.info_source", None, None),
                 ("reliability", "Достовірність", "a.reliability", None, None),
                 ("origin", "Походження запису", "a.origin", "origin", None)],
        "search": ["o.name_ua", "u.short_name"],
        "default": "a.occurred_at DESC",
        "pk": "a.id",
    },
    "losses": {
        "title": "ЗВЕДЕННЯ втрат особового складу за підрозділами і добами",
        "from": "FROM personnel_losses l JOIN units u ON u.id = l.unit_id",
        "where": lambda f: where(f, day="l.report_date", oblast="u.oblast_id", unit="l.unit_id",
                                 extra={"l.cause": f.cause}),
        "cols": [("date", "Дата", "to_char(l.report_date, 'DD.MM.YYYY')", None, "l.report_date"),
                 ("unit", "Підрозділ", "u.short_name", None, None),
                 ("cause", "Причина", "l.cause", "cause", None),
                 ("killed", "Безповоротні, осіб", "l.killed", None, None),
                 ("wounded", "Санітарні, осіб", "l.wounded", None, None),
                 ("missing", "Зниклі безвісти, осіб", "l.missing", None, None),
                 ("returned", "Повернуто до строю, осіб", "l.returned_to_duty", None, None),
                 ("origin", "Походження запису", "l.origin", "origin", None)],
        "mask": ["killed", "wounded", "missing", "returned"],
        "search": ["u.short_name"],
        "default": "l.report_date DESC, u.short_name",
        "pk": "l.id",
    },
    "counter_battery": {
        "title": "ПЕРЕЛІК виявлених вогневих позицій противника (контрбатарейна боротьба)",
        "from": ("FROM counter_battery c JOIN oblasts o ON o.id = c.oblast_id LEFT JOIN units u ON u.id = c.unit_id"),
        "where": lambda f: where(f, ts="c.detected_at", oblast="c.oblast_id", unit="c.unit_id",
                                 extra={"c.enemy_system": f.system}),
        "cols": [("time", "Виявлено", f"to_char(c.detected_at, {T})", None, "c.detected_at"),
                 ("means", "Засіб виявлення", "c.detected_by", "detected_by", None),
                 ("system", "Система противника", "c.enemy_system", "system_type", None),
                 ("caliber", "Калібр, мм", "c.caliber_mm", None, None),
                 ("oblast", "Область", "o.name_ua", None, None),
                 ("unit", "Підрозділ, що відкрив вогонь", "u.short_name", None, None),
                 ("responded", "Відкрито вогонь", f"to_char(c.responded_at, {T})", None, "c.responded_at"),
                 ("reaction", "Час реакції, хв", "c.reaction_min", None, None),
                 ("rounds", "Пострілів у відповідь", "c.rounds", None, None),
                 ("result", "Результат", "c.result", "result", None),
                 ("source", "Джерело", "c.info_source", None, None),
                 ("reliability", "Достовірність", "c.reliability", None, None),
                 ("origin", "Походження запису", "c.origin", "origin", None)],
        "search": ["o.name_ua", "u.short_name"],
        "default": "c.detected_at DESC",
        "pk": "c.id",
    },
    "ammo": {
        "title": "ВІДОМІСТЬ руху боєприпасів за підрозділами і добами",
        "from": "FROM ammo_supply a JOIN units u ON u.id = a.unit_id",
        "where": lambda f: where(f, day="a.report_date", oblast="u.oblast_id", unit="a.unit_id"),
        "cols": [("date", "Дата", "to_char(a.report_date, 'DD.MM.YYYY')", None, "a.report_date"),
                 ("unit", "Підрозділ", "u.short_name", None, None),
                 ("ammo", "Вид боєприпасів", "a.ammo_type", "ammo_type", None),
                 ("expended", "Витрачено, шт.", "a.expended", None, None),
                 ("received", "Надійшло, шт.", "a.received", None, None),
                 ("stock", "Залишок на кінець доби, шт.", "a.stock", None, None),
                 ("origin", "Походження запису", "a.origin", "origin", None)],
        "search": ["u.short_name"],
        "default": 'a.report_date DESC, u.short_name COLLATE "C", a.ammo_type COLLATE "C"',
        "pk": "a.id",
    },
    "equipment": {
        "title": "ВІДОМІСТЬ стану артилерійського озброєння (щотижневі донесення)",
        "from": "FROM artillery_equipment e JOIN units u ON u.id = e.unit_id",
        "where": lambda f: where(f, day="e.report_date", oblast="u.oblast_id", unit="e.unit_id",
                                 extra={"e.system_type": f.system}),
        "cols": [("date", "Дата донесення", "to_char(e.report_date, 'DD.MM.YYYY')", None, "e.report_date"),
                 ("unit", "Підрозділ", "u.short_name", None, None),
                 ("model", "Зразок озброєння", "e.model", None, None),
                 ("system", "Тип системи", "e.system_type", "system_type", None),
                 ("caliber", "Калібр, мм", "e.caliber_mm", None, None),
                 ("total", "У наявності, од.", "e.total", None, None),
                 ("operational", "Справні, од.", "e.operational", None, None),
                 ("repair", "У ремонті, од.", "e.in_repair", None, None),
                 ("lost", "Втрачено за тиждень, од.", "e.lost", None, None),
                 ("origin", "Походження запису", "e.origin", "origin", None)],
        "search": ["u.short_name", "e.model"],
        "default": 'e.report_date DESC, u.short_name COLLATE "C", e.model COLLATE "C"',
        "pk": "e.id",
    },
    "strength": {
        "title": "ВІДОМІСТЬ укомплектованості підрозділів особовим складом",
        "from": "FROM unit_strength s JOIN units u ON u.id = s.unit_id",
        "where": lambda f: where(f, day="s.report_date", oblast="u.oblast_id", unit="s.unit_id"),
        "cols": [("date", "Дата", "to_char(s.report_date, 'DD.MM.YYYY')", None, "s.report_date"),
                 ("unit", "Підрозділ", "u.short_name", None, None),
                 ("authorized", "За штатом, осіб", "s.authorized", None, None),
                 ("present", "У наявності, осіб", "s.present", None, None),
                 ("manning", "Укомплектованість, %",
                  "ROUND(100.0 * s.present / s.authorized, 1)::float", None, None),
                 ("replenished", "Прибуло поповнення, осіб", "s.replenished", None, None),
                 ("origin", "Походження запису", "s.origin", "origin", None)],
        "search": ["u.short_name"],
        "default": 's.report_date DESC, u.short_name COLLATE "C"',
        "pk": "s.id",
    },
    "docs": {
        "title": "ПЕРЕЛІК вхідних документів ОКП",
        "from": ("FROM incoming_documents d JOIN units u ON u.id = d.sender_unit_id "
                 "JOIN units r ON r.id = d.recipient_unit_id JOIN doc_sla_norms n ON n.urgency = d.urgency"),
        "where": lambda f: where(f, ts="d.received_at", oblast="u.oblast_id", unit="d.sender_unit_id",
                                 extra={"d.urgency": f.urgency, "d.doc_type": f.doc_type}),
        "cols": [("reg", "Обліковий номер", "d.reg_number", None, None),
                 ("received", "Надходження", f"to_char(d.received_at, {T})", None, "d.received_at"),
                 ("type", "Вид документа", "d.doc_type", "doc_type", None),
                 ("urgency", "Категорія терміновості", "d.urgency", "urgency", "n.sort_order"),
                 ("access", "Гриф (синт.)", "d.access_level", "access_level", None),
                 ("channel", "Канал", "d.channel", "channel", None),
                 ("sender", "Відправник", "u.short_name", None, None),
                 ("status", "Стан", "d.status", "status", None),
                 ("processing", "Час обробки, хв", "d.processing_min", None, None),
                 ("overdue", "Прострочено",
                  "CASE WHEN d.due_at < COALESCE(d.completed_at, (SELECT as_of FROM v_as_of)) "
                  "THEN 'так' ELSE 'ні' END", None, None),
                 ("recipient", "Отримувач", "r.short_name", None, None),
                 ("origin", "Походження запису", "d.origin", "origin", None)],
        "search": ["d.reg_number", "u.short_name"],
        "default": "d.received_at DESC",
        "pk": "d.id",
    },
}


def _query(module: str, f: Filters, q: str | None, sort: str | None, desc: bool, limit: int | None, offset: int):
    if module not in MODULES:
        raise HTTPException(404, "Невідомий модуль")
    m = MODULES[module]
    w, p = m["where"](f)
    if q:
        cond = " OR ".join(f"{c} ILIKE %(q)s" for c in m["search"])
        w = (w + " AND " if w else " WHERE ") + f"({cond})"
        p["q"] = f"%{q}%"
    order = m["default"]
    if sort:
        col = next((c for c in m["cols"] if c[0] == sort), None)
        if col is None:
            raise HTTPException(422, "Невідома колонка сортування")
        order = f"{col[4] or col[2]} {'DESC' if desc else 'ASC'} NULLS LAST, {m['default']}"
    select = ", ".join([f"{m['pk']} AS _id"] + [f"{c[2]} AS {c[0]}" for c in m["cols"]])
    total = one_row(f"SELECT COUNT(*) AS n {m['from']} {w}", p)["n"]
    sql = f"SELECT {select} {m['from']} {w} ORDER BY {order}, {m['pk']} DESC"
    if limit is not None:
        sql += " LIMIT %(lim)s OFFSET %(off)s"
        p.update(lim=limit, off=offset)
    rows = all_rows(sql, p)
    for r in rows:
        for key, _, _, dic, _ in m["cols"]:
            v = r[key]
            if module == "losses" and key in m.get("mask", []):
                v = mask_small(v)
            if dic and v is not None:
                v = LABELS[dic].get(v, v)
            r[key] = NO_DATA if v is None else v
    return m, total, rows


@router.get("/journal/{module}")
def journal(module: str, f: Filters = Depends(get_filters), q: str | None = Query(None, max_length=64),
            sort: str | None = None, desc: bool = True, limit: int = Query(50, ge=1, le=1000),
            offset: int = Query(0, ge=0)):
    m, total, rows = _query(module, f, q, sort, desc, limit, offset)
    return {"title": m["title"], "columns": [{"key": c[0], "title": c[1]} for c in m["cols"]],
            "total": total, "limit": limit, "offset": offset, "rows": rows}


@router.get("/export/{module}.csv")
def export_csv(module: str, f: Filters = Depends(get_filters), q: str | None = Query(None, max_length=64)):
    m, _, rows = _query(module, f, q, None, True, 100_000, 0)
    buf = io.StringIO()
    buf.write("﻿")
    wr = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    wr.writerow([f"{m['title']} за {f.date_from:%d.%m.%Y}–{f.date_to:%d.%m.%Y}. Синтетичні дані. По навчанню."])
    wr.writerow(["№ з/п"] + [c[1] for c in m["cols"]])
    for i, r in enumerate(rows, 1):
        wr.writerow([i] + [r[c[0]] for c in m["cols"]])  # службовий _id у CSV не виводиться
    name = f"{module}_{f.date_from:%Y%m%d}-{f.date_to:%Y%m%d}.csv"
    return StreamingResponse(iter([buf.getvalue().encode("utf-8")]), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/dict-labels")
def labels():
    return LABELS
