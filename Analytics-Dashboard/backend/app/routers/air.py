"""Модуль A: повітряні удари і тривоги."""
from fastapi import APIRouter, Depends, Query

from ..db import all_rows
from ..filters import bucket, get_filters, where
from ..schemas import Filters
from .common import SERIES, feature_collection

router = APIRouter(prefix="/api", tags=["A. Повітряні удари"])

FROM_S = "FROM strike_events s JOIN weapon_types w ON w.id = s.weapon_type_id"


def _w(f: Filters, **kw):
    return where(f, ts="s.occurred_at", oblast="s.oblast_id", extra={"w.code": f.weapon}, **kw)


@router.get("/air/timeline")
def timeline(f: Filters = Depends(get_filters), bucket_: str | None = Query(None, alias="bucket")):
    """A1: динаміка за типами засобів + масовані атаки для анотацій."""
    b = bucket(f, bucket_)
    w, p = _w(f)
    rows = all_rows(f"""
        WITH g AS ({SERIES}),
        x AS (SELECT date_trunc(%(b)s, s.occurred_at)::date AS period, s.weapon_type_id,
                     SUM(s.launched) AS launched, SUM(s.intercepted) AS intercepted,
                     SUM(s.suppressed) AS suppressed, SUM(s.hits) AS hits
              {FROM_S} {w} GROUP BY 1, 2)
        SELECT g.period, wt.code AS weapon, wt.name_ua, wt.color_hex,
               COALESCE(x.launched,0) AS launched, COALESCE(x.intercepted,0) AS intercepted,
               COALESCE(x.suppressed,0) AS suppressed, COALESCE(x.hits,0) AS hits
        FROM g CROSS JOIN weapon_types wt
        LEFT JOIN x ON x.period = g.period AND x.weapon_type_id = wt.id
        ORDER BY 1, wt.id""", {**p, "b": b})
    if f.weapon:
        rows = [r for r in rows if r["weapon"] in f.weapon]
    waves = all_rows("""SELECT id, started_at, ended_at, title FROM attack_waves
                        WHERE started_at >= %(df)s::date AND started_at < %(dt)s::date + 1 ORDER BY started_at""",
                     {"df": f.date_from, "dt": f.date_to})
    return {"bucket": b, "rows": rows, "waves": waves}


@router.get("/air/intercept-rate")
def intercept_rate(f: Filters = Depends(get_filters), bucket_: str | None = Query(None, alias="bucket")):
    """A2: запущено vs знешкоджено; частка без КАБ (КАБ засобами ППО не перехоплюються)."""
    b = bucket(f, bucket_)
    w, p = _w(f, base=["w.category <> 'guided_bomb'"])
    return {"bucket": b, "rows": all_rows(f"""
        WITH g AS ({SERIES}),
        x AS (SELECT date_trunc(%(b)s, s.occurred_at)::date AS period, SUM(s.launched) AS launched,
                     SUM(s.intercepted) AS intercepted, SUM(s.suppressed) AS suppressed
              {FROM_S} {w} GROUP BY 1)
        SELECT g.period, COALESCE(x.launched,0) AS launched, COALESCE(x.intercepted,0) AS intercepted,
               COALESCE(x.suppressed,0) AS suppressed,
               CASE WHEN x.launched > 0 THEN ROUND(100.0*(x.intercepted + x.suppressed)/x.launched, 1) END AS rate
        FROM g LEFT JOIN x USING (period) ORDER BY 1""", {**p, "b": b})}


@router.get("/air/by-oblast")
def by_oblast(f: Filters = Depends(get_filters)):
    """A3 і хороплет."""
    w, p = _w(f)
    return all_rows(f"""
        WITH x AS (SELECT s.oblast_id, COUNT(*) AS events, SUM(s.launched) AS launched,
                          SUM(s.intercepted) AS intercepted, SUM(s.hits) AS hits {FROM_S} {w} GROUP BY 1)
        SELECT o.iso_code, o.name_ua, COALESCE(x.events,0) AS events, COALESCE(x.launched,0) AS launched,
               COALESCE(x.intercepted,0) AS intercepted, COALESCE(x.hits,0) AS hits
        FROM oblasts o LEFT JOIN x ON x.oblast_id = o.id
        ORDER BY launched DESC, o.name_ua""", p)


@router.get("/air/impacts")
def impacts(f: Filters = Depends(get_filters), limit: int = Query(1000, ge=1, le=1000)):
    """Місця уражень (влучань) для карти — лише події з hits > 0. Траєкторії польоту не відображаються.
    Знак — «Вибух, підрив» (наказ № 140, п. 6.12) з власним підписом засобу (БпЛА, КрР, БалР, КАБ; п. 2.2.16)."""
    w, p = _w(f, base=["s.hits > 0"])
    rows = all_rows(f"""
        SELECT s.id, s.occurred_at, w.code AS weapon, w.name_ua AS weapon_name, w.sidc, w.map_label,
               w.category, s.launched, s.hits, s.damage_level, t.name_ua AS target, s.info_source, s.reliability,
               s.origin, o.name_ua AS oblast, s.lat::float AS lat, s.lon::float AS lon
        {FROM_S} JOIN oblasts o ON o.id = s.oblast_id
        LEFT JOIN target_categories t ON t.id = s.target_category_id {w}
        ORDER BY s.occurred_at DESC, s.id DESC LIMIT %(lim)s""", {**p, "lim": limit})
    return feature_collection(rows)


@router.get("/alerts/stats")
def alerts_stats(f: Filters = Depends(get_filters)):
    """A4: тривоги за областями; тривалість обрізано межами періоду, год."""
    w, p = where(f, oblast="a.oblast_id",
                 base=["a.started_at < %(dt)s::date + 1", "COALESCE(a.ended_at, 'infinity') > %(df)s::date"])
    return all_rows(f"""
        SELECT o.iso_code, o.name_ua, COUNT(a.id) AS alerts,
               ROUND((SUM(EXTRACT(EPOCH FROM LEAST(COALESCE(a.ended_at, now()), (%(dt)s::date + 1)::timestamptz)
                                  - GREATEST(a.started_at, %(df)s::date::timestamptz))) / 3600)::numeric, 1) AS hours
        FROM air_alerts a JOIN oblasts o ON o.id = a.oblast_id {w}
        GROUP BY o.iso_code, o.name_ua ORDER BY hours DESC""", {**p, "df": f.date_from, "dt": f.date_to})


@router.get("/alerts/active")
def alerts_active():
    """Тривоги, що не завершилися на момент кінця даних («тривоги зараз»)."""
    return all_rows("""SELECT a.id, o.iso_code, o.name_ua, a.alert_type, a.started_at
                       FROM air_alerts a JOIN oblasts o ON o.id = a.oblast_id
                       WHERE a.ended_at IS NULL ORDER BY a.started_at""")
