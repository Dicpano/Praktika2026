"""Модуль B: артилерійські обстріли."""
from fastapi import APIRouter, Depends, Query

from ..db import all_rows
from ..filters import bucket, get_filters, pct, where
from ..schemas import Filters
from ..sidc import artillery_sidc, caliber_class
from .common import SERIES, feature_collection

router = APIRouter(prefix="/api/artillery", tags=["B. Артилерія"])


def _w(f: Filters, **kw):
    return where(f, ts="a.occurred_at", oblast="a.oblast_id", unit="a.unit_id",
                 extra={"a.system_type": f.system, "a.direction": f.direction}, **kw)


@router.get("/timeline")
def timeline(f: Filters = Depends(get_filters), bucket_: str | None = Query(None, alias="bucket")):
    """B1: обстріли по періодах, вхідні vs вихідні."""
    b = bucket(f, bucket_)
    w, p = _w(f)
    return {"bucket": b, "rows": all_rows(f"""
        WITH g AS ({SERIES}), d AS (SELECT unnest(ARRAY['incoming','outgoing']) AS direction),
        x AS (SELECT date_trunc(%(b)s, a.occurred_at)::date AS period, a.direction,
                     COUNT(*) AS shellings, SUM(a.rounds) AS rounds
              FROM artillery_fire a {w} GROUP BY 1, 2)
        SELECT g.period, d.direction, COALESCE(x.shellings,0) AS shellings, COALESCE(x.rounds,0) AS rounds
        FROM g CROSS JOIN d LEFT JOIN x ON x.period = g.period AND x.direction = d.direction
        ORDER BY 1, 2""", {**p, "b": b})}


@router.get("/by-system")
def by_system(f: Filters = Depends(get_filters)):
    """B2: постріли за системами."""
    w, p = _w(f)
    return all_rows(f"""SELECT a.system_type, a.direction, COUNT(*) AS shellings, SUM(a.rounds) AS rounds
                        FROM artillery_fire a {w} GROUP BY 1, 2 ORDER BY rounds DESC""", p)


@router.get("/heatmap")
def heatmap(f: Filters = Depends(get_filters)):
    """B3: година × день тижня, лише вхідний вогонь (1 = понеділок)."""
    w, p = _w(f, base=["a.direction = 'incoming'"])
    return all_rows(f"""
        WITH g AS (SELECT wd, h FROM generate_series(1,7) wd CROSS JOIN generate_series(0,23) h),
        x AS (SELECT EXTRACT(ISODOW FROM a.occurred_at)::int AS wd, EXTRACT(HOUR FROM a.occurred_at)::int AS h,
                     COUNT(*) AS shellings, SUM(a.rounds) AS rounds FROM artillery_fire a {w} GROUP BY 1, 2)
        SELECT g.wd AS weekday, g.h AS hour, COALESCE(x.shellings,0) AS shellings, COALESCE(x.rounds,0) AS rounds
        FROM g LEFT JOIN x USING (wd, h) ORDER BY 1, 2""", p)


@router.get("/by-oblast")
def by_oblast(f: Filters = Depends(get_filters)):
    w, p = _w(f, base=["a.direction = 'incoming'"])
    return all_rows(f"""
        WITH x AS (SELECT a.oblast_id, COUNT(*) AS shellings, SUM(a.rounds) AS rounds
                   FROM artillery_fire a {w} GROUP BY 1)
        SELECT o.iso_code, o.name_ua, COALESCE(x.shellings,0) AS shellings, COALESCE(x.rounds,0) AS rounds
        FROM oblasts o LEFT JOIN x ON x.oblast_id = o.id ORDER BY rounds DESC, o.id""", p)


@router.get("/geojson")
def geojson(f: Filters = Depends(get_filters), limit: int = Query(1000, ge=1, le=1000)):
    w, p = _w(f)
    rows = all_rows(f"""
        SELECT a.id, a.occurred_at, a.direction, a.system_type, a.caliber_class, a.caliber_mm, a.rounds, a.result,
               u.short_name AS unit, o.name_ua AS oblast, a.info_source, a.reliability,
               a.lat::float AS lat, a.lon::float AS lon
        FROM artillery_fire a JOIN oblasts o ON o.id = a.oblast_id LEFT JOIN units u ON u.id = a.unit_id {w}
        ORDER BY a.occurred_at DESC, a.id DESC LIMIT %(lim)s""", {**p, "lim": limit})
    for r in rows:
        r["sidc"] = artillery_sidc(r["system_type"], r["caliber_class"])
    return feature_collection(rows)


# ---------------- Контрбатарейна боротьба ----------------
DETECT_ORDER = ["radar", "uav", "sound", "visual"]
RESULTS = ["destroyed", "damaged", "suppressed", "no_effect", "unknown", "no_response"]


def _wcb(f: Filters, **kw):
    return where(f, ts="c.detected_at", oblast="c.oblast_id", unit="c.unit_id",
                 extra={"c.enemy_system": f.system}, **kw)


@router.get("/counter-battery")
def counter_battery(f: Filters = Depends(get_filters)):
    """B6: виявлені вогневі позиції противника за засобами виявлення: частка відповідей, час реакції, результат."""
    w, p = _wcb(f)
    res = ", ".join(f"COUNT(*) FILTER (WHERE c.result = '{r}') AS {r}" for r in RESULTS)
    rows = all_rows(f"""
        WITH m AS (SELECT * FROM unnest(%(ord)s::text[]) WITH ORDINALITY AS t(detected_by, ord)),
        x AS (SELECT c.detected_by, COUNT(*) AS detected, COUNT(c.responded_at) AS responded,
                     PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY c.reaction_min) AS med, {res}
              FROM counter_battery c {w} GROUP BY 1)
        SELECT m.detected_by, COALESCE(x.detected,0) AS detected, COALESCE(x.responded,0) AS responded,
               ROUND(x.med::numeric, 1)::float AS median_min,
               {", ".join(f"COALESCE(x.{r},0) AS {r}" for r in RESULTS)}
        FROM m LEFT JOIN x USING (detected_by) ORDER BY m.ord""", {**p, "ord": DETECT_ORDER})
    for r in rows:
        r["response_pct"] = pct(r["responded"], r["detected"])
    return rows


@router.get("/cb-geojson")
def cb_geojson(f: Filters = Depends(get_filters), limit: int = Query(1000, ge=1, le=1000)):
    """Виявлені вогневі позиції противника для карти."""
    w, p = _wcb(f)
    rows = all_rows(f"""
        SELECT c.id, c.detected_at, c.detected_by, c.enemy_system, c.caliber_mm, u.short_name AS unit,
               c.responded_at, c.reaction_min, c.rounds, c.result, o.name_ua AS oblast, c.info_source, c.reliability,
               c.origin, c.lat::float AS lat, c.lon::float AS lon
        FROM counter_battery c JOIN oblasts o ON o.id = c.oblast_id LEFT JOIN units u ON u.id = c.unit_id {w}
        ORDER BY c.detected_at DESC, c.id DESC LIMIT %(lim)s""", {**p, "lim": limit})
    for r in rows:
        r["sidc"] = artillery_sidc(r["enemy_system"], caliber_class(r["enemy_system"], r["caliber_mm"] or 0))
    return feature_collection(rows)


# ---------------- Боєприпаси ----------------
AMMO_ORDER = ["mortar_120", "how_122", "how_152", "how_155", "how_203", "mlrs_122", "mlrs_220", "mlrs_300"]
FAMILY = "CASE split_part(a.ammo_type, '_', 1) WHEN 'how' THEN 'howitzer' ELSE split_part(a.ammo_type, '_', 1) END"


def _wa(f: Filters):
    return where(f, day="a.report_date", oblast="u.oblast_id", unit="a.unit_id")


@router.get("/ammo")
def ammo(f: Filters = Depends(get_filters)):
    """B4: рух боєприпасів за видами: витрачено, надійшло, залишок на кінець періоду і запас у добах вогню
    (залишок ÷ середньодобова витрата за останні 7 діб періоду)."""
    w, p = _wa(f)
    n = min(7, f.days)
    rows = all_rows(f"""
        WITH a AS (SELECT a.* FROM ammo_supply a JOIN units u ON u.id = a.unit_id {w}),
        l AS (SELECT DISTINCT ON (unit_id, ammo_type) unit_id, ammo_type, stock FROM a
              ORDER BY unit_id, ammo_type, report_date DESC),
        s AS (SELECT ammo_type, SUM(expended) AS expended, SUM(received) AS received,
                     SUM(expended) FILTER (WHERE report_date > %(dt)s::date - %(n)s) AS exp_n FROM a GROUP BY 1),
        st AS (SELECT ammo_type, SUM(stock) AS stock FROM l GROUP BY 1)
        SELECT s.ammo_type, s.expended, s.received, st.stock,
               ROUND(COALESCE(s.exp_n,0)::numeric / %(n)s, 1)::float AS avg_daily,
               CASE WHEN COALESCE(s.exp_n,0) > 0 THEN ROUND(st.stock::numeric * %(n)s / s.exp_n, 1)::float END
                 AS days_of_fire
        FROM s JOIN st USING (ammo_type)
        ORDER BY array_position(%(ord)s::text[], s.ammo_type::text)""", {**p, "n": n, "ord": AMMO_ORDER})
    return rows


@router.get("/ammo-timeline")
def ammo_timeline(f: Filters = Depends(get_filters), bucket_: str | None = Query(None, alias="bucket")):
    """B5: витрата боєприпасів за родами (міни, артилерійські, реактивні снаряди) по днях/тижнях."""
    b = bucket(f, bucket_)
    w, p = _wa(f)
    return {"bucket": b, "rows": all_rows(f"""
        WITH g AS ({SERIES}),
        fm AS (SELECT * FROM unnest(ARRAY['mortar','howitzer','mlrs']) WITH ORDINALITY AS t(family, ord)),
        x AS (SELECT date_trunc(%(b)s, a.report_date)::date AS period, {FAMILY} AS family,
                     SUM(a.expended) AS expended
              FROM ammo_supply a JOIN units u ON u.id = a.unit_id {w} GROUP BY 1, 2)
        SELECT g.period, fm.family, COALESCE(x.expended,0) AS expended
        FROM g CROSS JOIN fm LEFT JOIN x ON x.period = g.period AND x.family = fm.family
        ORDER BY 1, fm.ord""", {**p, "b": b})}


# ---------------- Стан озброєння ----------------
@router.get("/equipment")
def equipment(f: Filters = Depends(get_filters)):
    """B7: стан артилерійського озброєння за зразками — за останнім щотижневим донесенням у періоді;
    втрачено — сума за всі донесення періоду."""
    w, p = where(f, day="e.report_date", oblast="u.oblast_id", unit="e.unit_id", extra={"e.system_type": f.system})
    return all_rows(f"""
        WITH e AS (SELECT e.* FROM artillery_equipment e JOIN units u ON u.id = e.unit_id {w}),
        l AS (SELECT DISTINCT ON (unit_id, model) * FROM e ORDER BY unit_id, model, report_date DESC),
        lost AS (SELECT model, SUM(lost) AS lost FROM e GROUP BY 1)
        SELECT l.model, MIN(l.system_type) AS system_type, MIN(l.caliber_mm) AS caliber_mm, SUM(l.total) AS total,
               SUM(l.operational) AS operational, SUM(l.in_repair) AS in_repair, MAX(lost.lost) AS lost,
               ROUND(100.0 * SUM(l.operational) / NULLIF(SUM(l.total), 0), 1)::float AS ready_pct
        FROM l JOIN lost USING (model)
        GROUP BY l.model ORDER BY total DESC, l.model COLLATE "C" """, p)
