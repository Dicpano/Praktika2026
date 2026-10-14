"""FastAPI (sync) для «Оперативного Дашборду». Raw SQL через psycopg2.

Запуск:  uvicorn api.main:app --reload
"""
from datetime import date, timedelta
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from api.db import fetch_all, fetch_one

app = FastAPI(title="Оперативний Дашборд API", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

SORTABLE = {"occurred_at", "intensity", "sector", "direction", "event_type", "id"}


# ------------------------------------------------------------------ фільтри
def _parse_date(value: Optional[str], name: str) -> Optional[date]:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Параметр '{name}' має бути у форматі YYYY-MM-DD")


class Filters:
    """Спільні query-параметри для всіх аналітичних ендпоїнтів → WHERE + params."""

    def __init__(
        self,
        date_from: Optional[str] = Query(None, alias="from", description="YYYY-MM-DD"),
        date_to: Optional[str] = Query(None, alias="to", description="YYYY-MM-DD"),
        sector: Optional[str] = None,
        direction: Optional[str] = None,
        event_type: Optional[str] = None,
        min_intensity: Optional[int] = Query(None, ge=1, le=50),
    ):
        d_from, d_to = _parse_date(date_from, "from"), _parse_date(date_to, "to")
        if d_from and d_to and d_from > d_to:
            raise HTTPException(status_code=400, detail="'from' не може бути пізніше за 'to'")
        clauses, params = [], []
        if d_from:
            clauses.append("occurred_at >= %s"); params.append(d_from)
        if d_to:  # включно з усім днем 'to'
            clauses.append("occurred_at < %s"); params.append(d_to + timedelta(days=1))
        for col, val in (("sector", sector), ("direction", direction), ("event_type", event_type)):
            if val:
                clauses.append(f"{col} = %s"); params.append(val)
        if min_intensity is not None:
            clauses.append("intensity >= %s"); params.append(min_intensity)
        self.where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        self.params = params


# ------------------------------------------------------------------ ендпоїнти
@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/filters")
def filters():
    def distinct(col):
        return [r[col] for r in fetch_all(f"SELECT DISTINCT {col} FROM incidents ORDER BY {col}")]

    rng = fetch_one("SELECT MIN(occurred_at)::date AS min_date, MAX(occurred_at)::date AS max_date FROM incidents")
    return {
        "sectors": distinct("sector"),
        "directions": distinct("direction"),
        "event_types": distinct("event_type"),
        "min_date": rng["min_date"].isoformat() if rng["min_date"] else "",
        "max_date": rng["max_date"].isoformat() if rng["max_date"] else "",
    }


@app.get("/kpi")
def kpi(f: Filters = Depends()):
    row = fetch_one(
        f"SELECT COUNT(*) AS total_incidents, COALESCE(SUM(intensity), 0) AS total_intensity, "
        f"COALESCE(ROUND(AVG(intensity), 1), 0) AS avg_intensity FROM incidents {f.where}", f.params)
    top = fetch_one(
        f"SELECT direction FROM incidents {f.where} GROUP BY direction "
        f"ORDER BY COUNT(*) DESC, SUM(intensity) DESC LIMIT 1", f.params)
    return {
        "total_incidents": row["total_incidents"],
        "total_intensity": int(row["total_intensity"]),
        "avg_intensity": float(row["avg_intensity"]),
        "top_direction": top["direction"] if top else None,
    }


@app.get("/trend")
def trend(group: str = Query("day", pattern="^(day|week)$"), f: Filters = Depends()):
    rows = fetch_all(
        f"SELECT date_trunc('{group}', occurred_at)::date AS t, COUNT(*) AS value "
        f"FROM incidents {f.where} GROUP BY 1 ORDER BY 1", f.params)
    return [{"t": r["t"].isoformat(), "value": r["value"]} for r in rows]


def _distribution(col, f):
    rows = fetch_all(
        f"SELECT {col} AS label, COUNT(*) AS value FROM incidents {f.where} GROUP BY 1 ORDER BY 2 DESC", f.params)
    return [{"label": r["label"], "value": r["value"]} for r in rows]


@app.get("/distribution/directions")
def distribution_directions(f: Filters = Depends()):
    return _distribution("direction", f)


@app.get("/distribution/types")
def distribution_types(f: Filters = Depends()):
    return _distribution("event_type", f)


@app.get("/heatmap")
def heatmap(f: Filters = Depends()):
    """Сектор × тиждень (кількість інцидентів). Тиждень позначається датою понеділка."""
    rows = fetch_all(
        f"SELECT sector, date_trunc('week', occurred_at)::date AS week, COUNT(*) AS value "
        f"FROM incidents {f.where} GROUP BY 1, 2 ORDER BY 1, 2", f.params)
    weeks = sorted({r["week"] for r in rows})
    sectors = sorted({r["sector"] for r in rows})
    cell = {(r["sector"], r["week"]): r["value"] for r in rows}
    return {
        "columns": [w.isoformat() for w in weeks],
        "rows": [{"sector": s, "values": [cell.get((s, w), 0) for w in weeks]} for s in sectors],
    }


@app.get("/incidents")
def incidents(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=5, le=100),
    sort: str = "occurred_at",
    order: str = Query("desc", pattern="^(asc|desc)$"),
    f: Filters = Depends(),
):
    if sort not in SORTABLE:  # whitelist: назва колонки не може прийти в SQL з запиту напряму
        raise HTTPException(status_code=400, detail=f"sort має бути одним із: {sorted(SORTABLE)}")
    total = fetch_one(f"SELECT COUNT(*) AS n FROM incidents {f.where}", f.params)["n"]
    rows = fetch_all(
        f"SELECT id, occurred_at, sector, direction, event_type, intensity, source FROM incidents {f.where} "
        f"ORDER BY {sort} {order.upper()}, id {order.upper()} LIMIT %s OFFSET %s",
        f.params + [page_size, (page - 1) * page_size])
    for r in rows:
        r["occurred_at"] = r["occurred_at"].isoformat(timespec="minutes")
    return {"total": total, "page": page, "page_size": page_size, "items": rows}


@app.get("/incidents/{incident_id}")
def incident(incident_id: int):
    row = fetch_one("SELECT * FROM incidents WHERE id = %s", [incident_id])
    if not row:
        raise HTTPException(status_code=404, detail="Інцидент не знайдено")
    row["occurred_at"] = row["occurred_at"].isoformat(timespec="minutes")
    return row
