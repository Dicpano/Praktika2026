"""Шари карти: підрозділи з боєздатністю, противник (DeepState), лінія зіткнення, потоки ОКП, хороплет."""
import json
from functools import lru_cache

from fastapi import APIRouter, Depends, Query

from .. import config
from ..db import all_rows
from ..filters import get_filters, where
from ..schemas import Filters
from .docs import OVERDUE

router = APIRouter(prefix="/api/map", tags=["Карта"])

DEEPSTATE = config.ROOT / "db" / "sources" / "deepstate.json"

# Умовна штатна чисельність для розрахунку рівня боєздатності (синтетичні значення)
NOMINAL = {"command": 200, "corps": 300, "brigade": 400, "regiment": 800, "battalion": 450, "company": 100}


def readiness(loss: int, echelon: str) -> str:
    """Колір поля AL (табл. 13 Порядку): green / yellow / red / black за часткою втрат за період."""
    r = loss / NOMINAL.get(echelon, 400)
    return "green" if r < 0.05 else "yellow" if r < 0.12 else "red" if r < 0.25 else "black"


@router.get("/units")
def units(f: Filters = Depends(get_filters)):
    w, p = where(f, day="l.report_date")
    rows = all_rows(f"""
        WITH l AS (SELECT l.unit_id, SUM(l.killed) AS killed, SUM(l.wounded) AS wounded, SUM(l.missing) AS missing
                   FROM personnel_losses l {w} GROUP BY 1)
        SELECT u.id, u.short_name, u.name_ua, u.echelon, u.branch, u.sidc, u.is_rear, u.is_command_post,
               u.origin, u.parent_id, p.short_name AS parent, o.iso_code AS oblast, o.name_ua AS oblast_ua,
               u.lat::float AS lat, u.lon::float AS lon,
               COALESCE(l.killed,0) AS killed, COALESCE(l.wounded,0) AS wounded, COALESCE(l.missing,0) AS missing
        FROM units u JOIN oblasts o ON o.id = u.oblast_id LEFT JOIN units p ON p.id = u.parent_id
        LEFT JOIN l ON l.unit_id = u.id ORDER BY u.id""", p)
    for r in rows:
        r["readiness"] = readiness(r["killed"] + r["wounded"] + r["missing"], r["echelon"])
        r["selected"] = not f.unit or r["id"] in f.unit
    return rows


@lru_cache(maxsize=1)
def _deepstate() -> dict:
    return json.loads(DEEPSTATE.read_text(encoding="utf-8"))


@router.get("/enemy-units")
def enemy_units():
    """Підрозділи противника — відкриті дані DeepStateMap (OSINT), без змін координат."""
    rows = all_rows("SELECT id, name_ua, label, branch, echelon, sidc, lat::float AS lat, lon::float AS lon, "
                    "source, as_of FROM enemy_units ORDER BY id")
    src = rows[0] if rows else {"source": "DeepStateMap", "as_of": ""}
    return {"source": src["source"], "as_of": src["as_of"], "rows": rows}


@router.get("/contact-line")
def contact_line():
    """Лінія зіткнення (межа окупованої території за DeepState): сегменти; e_* — лінія противника."""
    segs: dict[int, list] = {}
    for r in all_rows("SELECT segment, lat::float AS lat, lon::float AS lon, e_lat::float AS e_lat, "
                      "e_lon::float AS e_lon FROM contact_line ORDER BY seq"):
        segs.setdefault(r["segment"], []).append([r["lat"], r["lon"], r["e_lat"], r["e_lon"]])
    ds = _deepstate()
    return {"source": ds["source"], "as_of": ds["datetime"],
            "note": "Положення лінії — за відкритими даними DeepStateMap; не є офіційними даними.",
            "segments": list(segs.values())}


@router.get("/areas")
def areas():
    """Окупована та «сіра» зони (полігони [lon, lat]) — DeepStateMap."""
    ds = _deepstate()
    return {"source": ds["source"], "as_of": ds["datetime"], "occupied": ds["occupied"], "grey": ds["grey"]}


# Ланка, на якій потік стає видимим (поріг масштабу на фронтенді)
FLOW_LEVEL = {"corps": 1, "brigade": 2, "regiment": 2, "battalion": 3, "company": 4}


@router.get("/flows")
def flows(f: Filters = Depends(get_filters)):
    """Потоки документів ієрархічно: кожен документ іде від відправника вгору по ланці управління
    до отримувача (ОКП). Ребро «підлеглий → старший» має вагу = кількість документів, що через нього пройшли."""
    w, p = where(f, ts="d.received_at", oblast="u.oblast_id", unit="d.sender_unit_id",
                 extra={"d.urgency": f.urgency, "d.doc_type": f.doc_type})
    pairs = all_rows(f"""
        SELECT d.sender_unit_id AS s, d.recipient_unit_id AS r, COUNT(*) AS docs,
               SUM(CASE WHEN {OVERDUE} THEN 1 ELSE 0 END) AS overdue
        FROM incoming_documents d JOIN units u ON u.id = d.sender_unit_id {w} GROUP BY 1, 2""", p)
    us = {u["id"]: u for u in all_rows("SELECT id, short_name, echelon, parent_id, lat::float AS lat, "
                                         "lon::float AS lon, is_command_post FROM units")}
    edges: dict[tuple[int, int], dict] = {}
    received: dict[int, dict] = {}
    for x in pairs:
        cur = x["s"]
        rc = received.setdefault(x["r"], {"docs": 0, "overdue": 0})
        rc["docs"] += x["docs"]
        rc["overdue"] += x["overdue"]
        guard = 0
        while cur != x["r"] and us[cur]["parent_id"] is not None and guard < 8:
            par = us[cur]["parent_id"]
            e = edges.setdefault((cur, par), {"docs": 0, "overdue": 0})
            e["docs"] += x["docs"]
            e["overdue"] += x["overdue"]
            cur, guard = par, guard + 1
    out = []
    for (a, b), e in edges.items():
        ua, ub = us[a], us[b]
        out.append({"from_id": a, "to_id": b, "from": ua["short_name"], "to": ub["short_name"],
                    "level": FLOW_LEVEL.get(ua["echelon"], 4), "echelon": ua["echelon"],
                    "from_lat": ua["lat"], "from_lon": ua["lon"], "to_lat": ub["lat"], "to_lon": ub["lon"],
                    "docs": e["docs"], "overdue": e["overdue"],
                    "overdue_pct": round(100.0 * e["overdue"] / e["docs"], 1) if e["docs"] else 0.0})
    out.sort(key=lambda r: (r["level"], -r["docs"], r["from_id"]))
    posts = [{"id": k, "name": us[k]["short_name"], "lat": us[k]["lat"], "lon": us[k]["lon"], **v,
              "overdue_pct": round(100.0 * v["overdue"] / v["docs"], 1) if v["docs"] else 0.0}
             for k, v in sorted(received.items())]
    return {"edges": out, "posts": posts}


@router.get("/choropleth")
def choropleth(module: str = Query("air", pattern="^(air|artillery|losses|docs|alerts)$"),
               f: Filters = Depends(get_filters)):
    if module == "air":
        w, p = where(f, ts="s.occurred_at")
        sql, label = f"SELECT oblast_id AS id, SUM(launched) AS v FROM strike_events s {w} GROUP BY 1", \
            "Засобів повітряного нападу, од."
    elif module == "artillery":
        w, p = where(f, ts="a.occurred_at", base=["a.direction = 'incoming'"])
        sql, label = f"SELECT oblast_id AS id, SUM(rounds) AS v FROM artillery_fire a {w} GROUP BY 1", \
            "Пострілів противника"
    elif module == "losses":
        w, p = where(f, day="l.report_date")
        sql, label = (f"SELECT u.oblast_id AS id, SUM(l.killed + l.wounded + l.missing) AS v "
                      f"FROM personnel_losses l JOIN units u ON u.id = l.unit_id {w} GROUP BY 1"), "Втрати, осіб"
    elif module == "docs":
        w, p = where(f, ts="d.received_at")
        sql, label = (f"SELECT u.oblast_id AS id, COUNT(*) AS v FROM incoming_documents d "
                      f"JOIN units u ON u.id = d.sender_unit_id {w} GROUP BY 1"), "Документів від підрозділів, од."
    else:
        w, p = where(f, ts="a.started_at")
        sql, label = (f"SELECT oblast_id AS id, ROUND(SUM(COALESCE(duration_min,0))/60.0, 1) AS v "
                      f"FROM air_alerts a {w} GROUP BY 1"), "Тривалість тривог, год"
    rows = all_rows(f"SELECT o.iso_code, o.name_ua, COALESCE(x.v,0)::float AS value FROM oblasts o "
                    f"LEFT JOIN ({sql}) x ON x.id = o.id", p)
    return {"module": module, "label": label, "values": rows}
