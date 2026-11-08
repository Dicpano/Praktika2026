"""
Аналітичний дашборд оперативної обстановки — API (FastAPI).
УСІ ДАНІ СИНТЕТИЧНІ. Навчальний проєкт.

Запуск без Docker:  uvicorn backend.app.main:app --port 8000
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from . import config
from .db import pool, writer
from . import snapshot
from .routers import air, artillery, docs, entry, journal, kpi, losses, map as map_router, meta


@asynccontextmanager
async def lifespan(_: FastAPI):
    pool.open(wait=False)
    writer.open(wait=False)
    yield
    writer.close()
    pool.close()


app = FastAPI(
    title="Аналітичний дашборд оперативної обстановки (синтетичні дані)",
    description="Навчальний проєкт. Дані згенеровано, вони не відображають реальних подій. "
                "Час — київський. Фільтри: date_from, date_to, oblast, unit та модульні.",
    version="2.0",
    lifespan=lifespan,
)
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(CORSMiddleware, allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
                   allow_methods=["GET", "POST", "DELETE"], allow_headers=["*"])

for r in (meta, kpi, air, artillery, losses, docs, map_router, journal, entry):
    app.include_router(r.router)


@app.get("/api/snapshot.js", tags=["службові"])
def snapshot_js():
    """Свіжий знімок бази (з внесеними записами) для офлайн-режиму: покладіть у frontend/data/dataset.js."""
    return Response(snapshot.to_js(snapshot.build()), media_type="application/javascript; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="dataset.js"'})


@app.middleware("http")
async def security_headers(request, call_next):
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    # OSM віддає тайли лише з Referer (політика використання тайлів), тому стороннім сайтам передаємо origin без шляху
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    return resp


# Фронтенд роздається тим самим сервером (порт 8000). Монтується останнім.
if config.FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=config.FRONTEND_DIR, html=True), name="frontend")
