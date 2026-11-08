"""Спільні фільтри та побудова параметризованого WHERE (без конкатенації значень)."""
from datetime import date, timedelta

from fastapi import HTTPException, Query

from . import config
from .db import one_row
from .schemas import Filters

def dataset_period() -> tuple[date, date]:
    """Період даних: від початку синтетичного набору до «станом на» (з урахуванням внесених записів)."""
    r = one_row("SELECT (SELECT value FROM dataset_meta WHERE key='period_from')::date AS f, "
                "(SELECT as_of FROM v_as_of)::date AS t")
    return r["f"], r["t"]


def get_filters(
    date_from: date | None = Query(None, description="Початок періоду (включно), київський час"),
    date_to: date | None = Query(None, description="Кінець періоду (включно)"),
    oblast: list[str] = Query([], description="ISO-код області, можна кілька"),
    unit: list[int] = Query([], description="id підрозділу, можна кілька"),
    weapon: list[str] = Query([]),
    system: list[str] = Query([]),
    direction: list[str] = Query([]),
    cause: list[str] = Query([]),
    urgency: list[str] = Query([]),
    doc_type: list[str] = Query([]),
) -> Filters:
    _, p_to = dataset_period()
    d_to = date_to or p_to
    d_from = date_from or (d_to - timedelta(days=29))
    if d_from > d_to:
        raise HTTPException(422, "date_from пізніше за date_to")
    if (d_to - d_from).days + 1 > config.MAX_PERIOD_DAYS:
        raise HTTPException(422, f"Період не може перевищувати {config.MAX_PERIOD_DAYS} днів")
    return Filters(date_from=d_from, date_to=d_to, oblast=oblast, unit=unit, weapon=weapon, system=system,
                   direction=direction, cause=cause, urgency=urgency, doc_type=doc_type)


def where(f: Filters, *, ts: str | None = None, day: str | None = None, oblast: str | None = None,
          unit: str | None = None, extra: dict[str, list] | None = None, base: list[str] | None = None):
    """Повертає (' WHERE ...', params). ts — колонка timestamptz, day — колонка date."""
    cl, p = list(base or []), {}
    if ts:
        cl.append(f"{ts} >= %(df)s::date AND {ts} < (%(dt)s::date + 1)")
    if day:
        cl.append(f"{day} BETWEEN %(df)s AND %(dt)s")
    if ts or day:
        p.update(df=f.date_from, dt=f.date_to)
    if oblast and f.oblast:
        cl.append(f"{oblast} IN (SELECT id FROM oblasts WHERE iso_code = ANY(%(obl)s))")
        p["obl"] = f.oblast
    if unit and f.unit:
        cl.append(f"{unit} = ANY(%(units)s)")
        p["units"] = f.unit
    for i, (col, values) in enumerate((extra or {}).items()):
        if values:
            cl.append(f"{col} = ANY(%(x{i})s)")
            p[f"x{i}"] = values
    return (" WHERE " + " AND ".join(cl)) if cl else "", p


def bucket(f: Filters, override: str | None = None) -> str:
    if override in ("day", "week"):
        return override
    return "day" if f.days <= 92 else "week"


def pct(a, b) -> float | None:
    return None if not b else round(100.0 * float(a) / float(b), 1)
