"""Модуль C: втрати особового складу (лише агрегати, без персональних даних)."""
from fastapi import APIRouter, Depends

from ..db import all_rows
from ..filters import get_filters, where
from ..schemas import Filters
from .common import SERIES

router = APIRouter(prefix="/api/losses", tags=["C. Втрати"])

FROM_L = "FROM personnel_losses l JOIN units u ON u.id = l.unit_id"


def _w(f: Filters, **kw):
    return where(f, day="l.report_date", oblast="u.oblast_id", unit="l.unit_id",
                 extra={"l.cause": f.cause}, **kw)


def mask_small(v: int | None):
    """Зріз «підрозділ × доба»: значення 1–4 не оприлюднюються (ТЗ §7)."""
    return "<5" if v is not None and 1 <= v <= 4 else v


@router.get("/timeline")
def timeline(f: Filters = Depends(get_filters)):
    """C1: втрати по тижнях."""
    w, p = _w(f)
    return {"bucket": "week", "rows": all_rows(f"""
        WITH g AS ({SERIES}),
        x AS (SELECT date_trunc('week', l.report_date)::date AS period, SUM(l.killed) AS killed,
                     SUM(l.wounded) AS wounded, SUM(l.missing) AS missing {FROM_L} {w} GROUP BY 1)
        SELECT g.period, COALESCE(x.killed,0) AS killed, COALESCE(x.wounded,0) AS wounded,
               COALESCE(x.missing,0) AS missing
        FROM g LEFT JOIN x USING (period) ORDER BY 1""", {**p, "b": "week"})}


@router.get("/by-cause")
def by_cause(f: Filters = Depends(get_filters)):
    """C2: втрати за причинами."""
    w, p = _w(f)
    return all_rows(f"""SELECT l.cause, SUM(l.killed) AS killed, SUM(l.wounded) AS wounded, SUM(l.missing) AS missing,
                               SUM(l.killed + l.wounded + l.missing) AS total
                        {FROM_L} {w} GROUP BY 1 ORDER BY total DESC""", p)


@router.get("/by-unit")
def by_unit(f: Filters = Depends(get_filters)):
    """Сумарно за період по підрозділах (не зріз «підрозділ × доба», тому без маскування)."""
    w, p = _w(f)
    return all_rows(f"""SELECT u.id, u.short_name, u.echelon, SUM(l.killed) AS killed, SUM(l.wounded) AS wounded,
                               SUM(l.missing) AS missing, SUM(l.killed + l.wounded + l.missing) AS total
                        {FROM_L} {w} GROUP BY 1, 2, 3 ORDER BY total DESC, u.id""", p)


@router.get("/correlation")
def correlation(f: Filters = Depends(get_filters)):
    """C3: інтенсивність вхідного вогню (пострілів) vs санітарні втрати, по днях."""
    wl, pl = _w(f)
    wa, pa = where(f, ts="a.occurred_at", oblast="a.oblast_id", unit="a.unit_id",
                   base=["a.direction = 'incoming'"])
    return all_rows(f"""
        WITH g AS ({SERIES}),
        l AS (SELECT l.report_date AS period, SUM(l.wounded) AS wounded, SUM(l.killed) AS killed {FROM_L} {wl} GROUP BY 1),
        a AS (SELECT a.occurred_at::date AS period, SUM(a.rounds) AS rounds FROM artillery_fire a {wa} GROUP BY 1)
        SELECT g.period, COALESCE(a.rounds,0) AS incoming_rounds, COALESCE(l.wounded,0) AS wounded,
               COALESCE(l.killed,0) AS killed
        FROM g LEFT JOIN a USING (period) LEFT JOIN l USING (period) ORDER BY 1""", {**pl, **pa, "b": "day"})


# ---------------- Укомплектованість ----------------
def _ws(f: Filters):
    return where(f, day="s.report_date", oblast="u.oblast_id", unit="s.unit_id")


@router.get("/strength")
def strength(f: Filters = Depends(get_filters)):
    """C4: укомплектованість по днях: за штатом, у наявності, %, поповнення."""
    w, p = _ws(f)
    return all_rows(f"""
        WITH g AS ({SERIES}),
        x AS (SELECT s.report_date AS period, SUM(s.authorized) AS authorized, SUM(s.present) AS present,
                     SUM(s.replenished) AS replenished
              FROM unit_strength s JOIN units u ON u.id = s.unit_id {w} GROUP BY 1)
        SELECT g.period, x.authorized, x.present,
               ROUND(100.0 * x.present / NULLIF(x.authorized, 0), 1)::float AS manning_pct,
               COALESCE(x.replenished, 0) AS replenished
        FROM g LEFT JOIN x USING (period) ORDER BY 1""", {**p, "b": "day"})


@router.get("/strength-by-unit")
def strength_by_unit(f: Filters = Depends(get_filters)):
    """C5: укомплектованість підрозділів на кінець періоду (останнє донесення), поповнення за період."""
    w, p = _ws(f)
    return all_rows(f"""
        WITH s AS (SELECT s.* FROM unit_strength s JOIN units u ON u.id = s.unit_id {w}),
        l AS (SELECT DISTINCT ON (unit_id) unit_id, authorized, present FROM s ORDER BY unit_id, report_date DESC),
        r AS (SELECT unit_id, SUM(replenished) AS replenished FROM s GROUP BY 1)
        SELECT u.id, u.short_name, u.echelon, l.authorized, l.present,
               ROUND(100.0 * l.present / l.authorized, 1)::float AS manning_pct, r.replenished
        FROM l JOIN r USING (unit_id) JOIN units u ON u.id = l.unit_id
        ORDER BY manning_pct, u.id""", p)
