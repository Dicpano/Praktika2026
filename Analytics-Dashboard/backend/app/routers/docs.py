"""Модуль D: документообіг ОКП. Нормативи часу обробки умовні (doc_sla_norms.is_conditional)."""
from fastapi import APIRouter, Depends, Query

from ..db import all_rows
from ..filters import get_filters, where
from ..schemas import Filters
from .common import SERIES

router = APIRouter(prefix="/api/docs", tags=["D. Документообіг ОКП"])

FROM_D = ("FROM incoming_documents d JOIN units u ON u.id = d.sender_unit_id "
          "JOIN units r ON r.id = d.recipient_unit_id JOIN doc_sla_norms n ON n.urgency = d.urgency")
AS_OF = "(SELECT as_of FROM v_as_of)"
OVERDUE = f"(d.due_at < COALESCE(d.completed_at, {AS_OF}))"
OVERDUE_THRESHOLD_PCT = 5.0  # умовний поріг для D3


def _w(f: Filters, ts: str | None = "d.received_at", **kw):
    return where(f, ts=ts, oblast="u.oblast_id", unit="d.sender_unit_id",
                 extra={"d.urgency": f.urgency, "d.doc_type": f.doc_type}, **kw)


@router.get("/flow")
def flow(f: Filters = Depends(get_filters)):
    """D1: надходження по годинах доби × терміновість (середнє за добу)."""
    w, p = _w(f)
    rows = all_rows(f"""
        WITH g AS (SELECT h FROM generate_series(0,23) h), n AS (SELECT urgency, name_ua, sort_order FROM doc_sla_norms),
        x AS (SELECT EXTRACT(HOUR FROM d.received_at)::int AS h, d.urgency, COUNT(*) AS docs {FROM_D} {w} GROUP BY 1, 2)
        SELECT g.h AS hour, n.urgency, n.name_ua, COALESCE(x.docs,0) AS docs,
               ROUND(COALESCE(x.docs,0)::numeric / %(days)s, 2) AS per_day
        FROM g CROSS JOIN n LEFT JOIN x ON x.h = g.h AND x.urgency = n.urgency
        ORDER BY 1, n.sort_order""", {**p, "days": f.days})
    return {"days": f.days, "rows": rows}


@router.get("/sla")
def sla(f: Filters = Depends(get_filters)):
    """D2: медіана і P90 часу обробки за терміновістю vs норматив, частка прострочених."""
    w, p = _w(f)
    return all_rows(f"""
        SELECT n.urgency, n.name_ua, n.norm_min, n.is_conditional, COUNT(d.id) AS docs,
               PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY d.processing_min) AS median_min,
               PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY d.processing_min) AS p90_min,
               ROUND(100.0 * AVG(CASE WHEN {OVERDUE} THEN 1 ELSE 0 END), 2) AS overdue_pct
        {FROM_D} {w} GROUP BY n.urgency, n.name_ua, n.norm_min, n.is_conditional, n.sort_order
        ORDER BY n.sort_order""", p)


@router.get("/overdue")
def overdue(f: Filters = Depends(get_filters)):
    """D3: частка прострочених по днях."""
    w, p = _w(f)
    rows = all_rows(f"""
        WITH g AS ({SERIES}),
        x AS (SELECT d.received_at::date AS period, COUNT(*) AS docs,
                     SUM(CASE WHEN {OVERDUE} THEN 1 ELSE 0 END) AS overdue {FROM_D} {w} GROUP BY 1)
        SELECT g.period, COALESCE(x.docs,0) AS docs, COALESCE(x.overdue,0) AS overdue,
               CASE WHEN x.docs > 0 THEN ROUND(100.0 * x.overdue / x.docs, 2) END AS overdue_pct
        FROM g LEFT JOIN x USING (period) ORDER BY 1""", {**p, "b": "day"})
    return {"threshold_pct": OVERDUE_THRESHOLD_PCT, "rows": rows}


@router.get("/by-type")
def by_type(f: Filters = Depends(get_filters)):
    w, p = _w(f)
    return all_rows(f"""SELECT d.doc_type, COUNT(*) AS docs, SUM(CASE WHEN {OVERDUE} THEN 1 ELSE 0 END) AS overdue
                        {FROM_D} {w} GROUP BY 1 ORDER BY docs DESC""", p)


@router.get("/queue")
def queue(f: Filters = Depends(get_filters), limit: int = Query(200, ge=1, le=1000)):
    """D4: черга необроблених на кінець даних (період не застосовується)."""
    w, p = _w(f, ts=None, base=["d.status IN ('new','in_work')"])
    return all_rows(f"""
        SELECT d.id, d.reg_number, d.doc_type, d.urgency, n.name_ua AS urgency_ua, n.sort_order, d.status,
               d.access_level, d.channel, d.special_mark, u.short_name AS sender, r.short_name AS recipient, d.origin, d.received_at, d.due_at,
               {OVERDUE} AS is_overdue,
               ROUND(EXTRACT(EPOCH FROM {AS_OF} - d.received_at) / 60)::int AS waiting_min
        {FROM_D} {w}
        ORDER BY n.sort_order, d.due_at LIMIT %(lim)s""", {**p, "lim": limit})
