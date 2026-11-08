"""Знімок бази для офлайн-режиму (відкриття index.html без сервера, з будь-якого комп'ютера).

Формує JS-файл `window.DATASET = {...}` з довідниками та таблицями фактів у стовпцевому вигляді.
Час — «київський настінний» у секундах від 1970-01-01 (тобто вже переведений у Europe/Kyiv),
тому браузер рахує години/дні через UTC-методи без часових поясів. Рядкові колонки з малою
кількістю значень кодуються словником: {"d": [значення], "i": [індекси]}.
"""
import json
from datetime import date, datetime

from .db import all_rows
from .labels import LABELS, NO_DATA

KYIV_MIN = "FLOOR(EXTRACT(EPOCH FROM ({c} AT TIME ZONE 'Europe/Kyiv')))::bigint"


def _m(col: str) -> str:
    return KYIV_MIN.format(c=col)


TABLES = {
    "strikes": f"""SELECT id, {_m('occurred_at')} AS t, oblast_id AS ob, weapon_type_id AS w, wave_id AS wave,
                   target_category_id AS tg, launched AS l, intercepted AS i, suppressed AS s, hits AS h,
                   damage_level AS dmg, info_source AS src, reliability AS rel,
                   ROUND(lat, 4)::float AS lat, ROUND(lon, 4)::float AS lon, origin AS o
                   FROM strike_events ORDER BY occurred_at, id""",
    "alerts": f"""SELECT id, oblast_id AS ob, alert_type AS ty, {_m('started_at')} AS t0, {_m('ended_at')} AS t1,
                  origin AS o FROM air_alerts ORDER BY started_at, id""",
    "artillery": f"""SELECT id, {_m('occurred_at')} AS t, direction AS dir, system_type AS sys, caliber_class AS cls,
                     caliber_mm AS mm, rounds AS r, oblast_id AS ob, unit_id AS u, target_category_id AS tg,
                     result AS res, info_source AS src, reliability AS rel,
                     ROUND(lat, 4)::float AS lat, ROUND(lon, 4)::float AS lon, origin AS o
                     FROM artillery_fire ORDER BY occurred_at, id""",
    "losses": """SELECT id, (report_date - DATE '1970-01-01') AS d, unit_id AS u, cause AS c, killed AS k,
                 wounded AS w, missing AS m, returned_to_duty AS r, origin AS o
                 FROM personnel_losses ORDER BY report_date, unit_id, id""",
    "cb": f"""SELECT id, {_m('detected_at')} AS t, detected_by AS by, enemy_system AS sys, caliber_mm AS mm,
              oblast_id AS ob, unit_id AS u, {_m('responded_at')} AS tr, reaction_min AS rm, rounds AS r,
              result AS res, info_source AS src, reliability AS rel,
              ROUND(lat, 4)::float AS lat, ROUND(lon, 4)::float AS lon, origin AS o
              FROM counter_battery ORDER BY detected_at, id""",
    "ammo": """SELECT id, (report_date - DATE '1970-01-01') AS d, unit_id AS u, ammo_type AS a, expended AS e,
               received AS rc, stock AS s, origin AS o FROM ammo_supply ORDER BY report_date, unit_id, id""",
    "equip": """SELECT id, (report_date - DATE '1970-01-01') AS d, unit_id AS u, model AS m, system_type AS sys,
                caliber_mm AS mm, total AS tot, operational AS op, in_repair AS rep, lost, origin AS o
                FROM artillery_equipment ORDER BY report_date, unit_id, id""",
    "strength": """SELECT id, (report_date - DATE '1970-01-01') AS d, unit_id AS u, authorized AS au, present AS pr,
                   replenished AS rp, origin AS o FROM unit_strength ORDER BY report_date, unit_id, id""",
    "docs": f"""SELECT id, reg_number AS reg, doc_type AS ty, urgency AS urg, special_mark AS mark,
                access_level AS acc, channel AS ch, sender_unit_id AS s, recipient_unit_id AS rc,
                {_m('received_at')} AS t, {_m('due_at')} AS due, {_m('completed_at')} AS done, status AS st,
                origin AS o FROM incoming_documents ORDER BY received_at, id""",
}

DICTS = {
    "oblasts": "SELECT id, iso_code, name_ua, name_en, center_lat::float AS lat, center_lon::float AS lon, "
               "is_frontline, is_occupied FROM oblasts ORDER BY id",
    "units": "SELECT id, short_name, name_ua, echelon, branch, parent_id, oblast_id, lat::float AS lat, "
             "lon::float AS lon, sidc, is_rear, is_command_post, origin FROM units ORDER BY id",
    "weapon_types": "SELECT id, code, name_ua, category, sidc, color_hex, map_label FROM weapon_types ORDER BY id",
    "target_categories": "SELECT id, code, name_ua FROM target_categories ORDER BY id",
    "info_sources": "SELECT code, name_ua FROM info_sources ORDER BY code",
    "doc_norms": "SELECT urgency, name_ua, norm_min, sort_order, is_conditional FROM doc_sla_norms ORDER BY sort_order",
    "attack_waves": f"SELECT id, {_m('started_at')} AS t0, {_m('ended_at')} AS t1, title FROM attack_waves ORDER BY id",
    "enemy_units": "SELECT id, name_ua, label, branch, echelon, sidc, lat::float AS lat, lon::float AS lon, "
                   "source, as_of FROM enemy_units ORDER BY id",
    "contact_line": "SELECT segment, lat::float AS lat, lon::float AS lon, e_lat::float AS e_lat, "
                    "e_lon::float AS e_lon FROM contact_line ORDER BY seq",
}


def _columnar(rows: list[dict]) -> dict:
    if not rows:
        return {"n": 0, "cols": {}}
    cols = {}
    for k in rows[0]:
        vals = [r[k] for r in rows]
        strs = {v for v in vals if isinstance(v, str)}
        if strs and len(strs) <= 64 and all(v is None or isinstance(v, str) for v in vals):
            d = sorted(strs)
            ix = {v: i for i, v in enumerate(d)}
            cols[k] = {"d": d, "i": [-1 if v is None else ix[v] for v in vals]}
        else:
            cols[k] = vals
    return {"n": len(rows), "cols": cols}


def _default(o):
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    return float(o)


def build() -> dict:
    from .routers.entry import spec  # уникнення циклічного імпорту

    meta = {r["key"]: r["value"] for r in all_rows("SELECT key, value FROM dataset_meta")}
    asof = all_rows(f"SELECT as_of, {_m('as_of')} AS as_of_min FROM v_as_of")[0]
    meta.update(data_as_of=asof["as_of"], as_of_sec=asof["as_of_min"],
                snapshot_at=datetime.now().astimezone().isoformat(timespec="seconds"))
    return {
        "version": 1,
        "meta": meta,
        "labels": LABELS,
        "no_data": NO_DATA,
        "entry_spec": spec(),
        "dicts": {k: all_rows(q) for k, q in DICTS.items()},
        "tables": {k: _columnar(all_rows(q)) for k, q in TABLES.items()},
    }


def to_js(data: dict) -> str:
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"), default=_default)
    return ("/* Знімок бази дашборду для офлайн-режиму. Згенеровано автоматично; УСІ ДАНІ СИНТЕТИЧНІ. */\n"
            f"window.DATASET={body};\n")
