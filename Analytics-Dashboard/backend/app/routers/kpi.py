"""KPI модулів + зміна до попереднього періоду такої самої довжини."""
from fastapi import APIRouter, Depends, HTTPException, Query

from ..db import one_row
from ..filters import get_filters, pct, where
from ..schemas import Filters, Kpi, KpiResponse

router = APIRouter(prefix="/api", tags=["KPI"])


def _air(f: Filters) -> dict:
    w, p = where(f, ts="s.occurred_at", oblast="s.oblast_id", extra={"w.code": f.weapon})
    r = one_row(f"""SELECT COALESCE(SUM(s.launched),0) AS launched,
                           SUM(s.launched) FILTER (WHERE w.category <> 'guided_bomb') AS l_air,
                           SUM(s.intercepted + s.suppressed) FILTER (WHERE w.category <> 'guided_bomb') AS i_air
                    FROM strike_events s JOIN weapon_types w ON w.id = s.weapon_type_id {w}""", p)
    return {"air_launched": r["launched"], "air_rate": pct(r["i_air"] or 0, r["l_air"])}


def _art(f: Filters) -> dict:
    w, p = where(f, ts="a.occurred_at", oblast="a.oblast_id", unit="a.unit_id",
                 extra={"a.system_type": f.system}, base=["a.direction = 'incoming'"])
    r = one_row(f"SELECT COUNT(*) AS n, COALESCE(SUM(a.rounds),0) AS rounds FROM artillery_fire a {w}", p)
    wc, pc = where(f, ts="c.detected_at", oblast="c.oblast_id", unit="c.unit_id", extra={"c.enemy_system": f.system})
    cb = one_row(f"SELECT COUNT(*) AS n, COUNT(c.responded_at) AS r FROM counter_battery c {wc}", pc)
    we, pe = where(f, day="e.report_date", oblast="u.oblast_id", unit="e.unit_id", extra={"e.system_type": f.system})
    eq = one_row(f"""WITH l AS (SELECT DISTINCT ON (e.unit_id, e.model) e.total, e.operational
                                FROM artillery_equipment e JOIN units u ON u.id = e.unit_id {we}
                                ORDER BY e.unit_id, e.model, e.report_date DESC)
                     SELECT SUM(operational) AS op, SUM(total) AS total FROM l""", pe)
    return {"art_shellings": r["n"], "art_rounds": r["rounds"], "art_cb_response": pct(cb["r"], cb["n"]),
            "art_eq_ready": pct(eq["op"] or 0, eq["total"])}


def _loss(f: Filters) -> dict:
    w, p = where(f, day="l.report_date", oblast="u.oblast_id", unit="l.unit_id", extra={"l.cause": f.cause})
    r = one_row(f"""SELECT COALESCE(SUM(l.wounded),0) AS wounded, COALESCE(SUM(l.killed),0) AS killed
                    FROM personnel_losses l JOIN units u ON u.id = l.unit_id {w}""", p)
    ws, ps = where(f, day="s.report_date", oblast="u.oblast_id", unit="s.unit_id")
    s = one_row(f"""WITH s AS (SELECT s.* FROM unit_strength s JOIN units u ON u.id = s.unit_id {ws})
                    SELECT SUM(present) AS present, SUM(authorized) AS authorized FROM s
                    WHERE report_date = (SELECT MAX(report_date) FROM s)""", ps)
    return {"loss_wounded": r["wounded"], "loss_killed": r["killed"],
            "loss_manning": pct(s["present"] or 0, s["authorized"])}


def _docs(f: Filters) -> dict:
    w, p = where(f, ts="d.received_at", oblast="u.oblast_id", unit="d.sender_unit_id",
                 extra={"d.urgency": f.urgency, "d.doc_type": f.doc_type})
    r = one_row(f"""SELECT COUNT(*) AS n,
                           AVG(CASE WHEN d.due_at < COALESCE(d.completed_at,
                               (SELECT as_of FROM v_as_of)) THEN 1 ELSE 0 END) AS od,
                           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY d.processing_min)
                               FILTER (WHERE d.urgency IN ('horizon','efir')) AS med
                    FROM incoming_documents d JOIN units u ON u.id = d.sender_unit_id {w}""", p)
    return {"docs_per_day": round(r["n"] / f.days, 1),
            "docs_overdue": None if r["od"] is None else round(float(r["od"]) * 100, 1),
            "docs_median_urgent": None if r["med"] is None else round(float(r["med"]), 1)}


SPEC = {  # key: (module, label, unit, better, note)
    "air_launched": ("air", "Засобів повітряного нападу", "од.", "down", None),
    "air_rate": ("air", "Збито та подавлено", "%", "up", "без КАБ"),
    "art_shellings": ("artillery", "Обстрілів по наших військах", "од.", "down", None),
    "art_rounds": ("artillery", "Пострілів противника", "пострілів", "down", None),
    "art_cb_response": ("artillery", "Відповідь на виявлені позиції", "%", "up", "контрбатарейна боротьба"),
    "art_eq_ready": ("artillery", "Справних артсистем", "%", "up", "за останнім донесенням"),
    "loss_wounded": ("losses", "Санітарні втрати", "осіб", "down", "останні 7 діб періоду"),
    "loss_killed": ("losses", "Безповоротні втрати", "осіб", "down", "останні 7 діб періоду"),
    "loss_manning": ("losses", "Укомплектованість", "%", "up", "на кінець періоду"),
    "docs_per_day": ("docs", "Документів за добу", "од.", "down", "середнє"),
    "docs_overdue": ("docs", "Прострочено", "%", "down", None),
    "docs_median_urgent": ("docs", "Медіана обробки ГОРИЗОНТ/ЕФІР", "хв", "down", None),
}
CALC = {"air": [_air], "artillery": [_art], "losses": [_loss], "docs": [_docs]}
OVERVIEW = ["air_launched", "air_rate", "art_shellings", "art_rounds", "loss_wounded", "loss_killed",
            "docs_per_day", "docs_overdue"]


def _compute(module: str, f: Filters) -> dict:
    out = {}
    for fn in CALC[module]:
        ff = f.last_days(min(7, f.days)) if module == "losses" else f
        out.update(fn(ff))
    return out


@router.get("/kpi", response_model=KpiResponse)
def kpi(module: str = Query("overview", pattern="^(overview|air|artillery|losses|docs)$"),
        f: Filters = Depends(get_filters)):
    modules = ["air", "artillery", "losses", "docs"] if module == "overview" else [module]
    cur, prev = {}, {}
    for m in modules:
        cur.update(_compute(m, f))
        try:
            prev.update(_compute(m, f.previous()))
        except Exception:  # noqa: BLE001 — попередній період може виходити за межі даних
            pass
    keys = OVERVIEW if module == "overview" else [k for k, s in SPEC.items() if s[0] == module]
    items = []
    for k in keys:
        if k not in cur:
            raise HTTPException(500, k)
        m, label, unit, better, note = SPEC[k]
        v, pv = cur[k], prev.get(k)
        v = None if v is None else float(v)
        pv = None if pv is None else float(pv)
        delta = None if (pv in (None, 0) or v is None) else round(100.0 * (v - pv) / pv, 1)
        items.append(Kpi(key=k, module=m, label=label, value=v, unit=unit, previous=pv, delta_pct=delta,
                         better=better, note=note))
    return KpiResponse(module=module, date_from=f.date_from, date_to=f.date_to, items=items)
