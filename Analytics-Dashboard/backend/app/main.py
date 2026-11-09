"""
Аналітичний дашборд оперативної обстановки — сервер FastAPI.
УСІ ДАНІ СИНТЕТИЧНІ. Навчальний проєкт.

Запуск (з кореня проєкту, в активованому віртуальному оточенні .venv):
    uvicorn backend.app.main:app --reload
Далі відкрити http://localhost:8000 (документація API — http://localhost:8000/docs).

Один процес FastAPI роздає і API (/api/...), і сторінки фронтенду (/ і /print).
"""
import logging
from contextlib import asynccontextmanager

import psycopg

from fastapi import FastAPI
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from . import config
from .db import pool, writer
from . import snapshot
from .routers import air, artillery, docs, entry, journal, kpi, losses, map as map_router, meta


log = logging.getLogger("uvicorn.error")


def check_database() -> None:
    """Під час старту пише в термінал, чи доступна база (сайт працює і без неї — на знімку бази)."""
    try:
        with psycopg.connect(config.CONNINFO, connect_timeout=3) as c:
            c.execute("SELECT 1")
        log.info("База даних: PostgreSQL %s:%s/%s — підключено.", config.DB_HOST, config.DB_PORT, config.DB_NAME)
    except Exception as e:  # noqa: BLE001
        log.warning("База даних %s:%s недоступна (%s). Сайт працюватиме на знімку бази (офлайн-режим). "
                    "Запустіть базу: docker compose up -d db", config.DB_HOST, config.DB_PORT, type(e).__name__)
    if not (config.ROOT / ".env").exists():
        log.warning("Файл .env не знайдено — використано налаштування за замовчуванням. "
                    "Створіть його: copy .env.example .env")
    log.info("Дашборд: http://localhost:8000   API: http://localhost:8000/docs")


@asynccontextmanager
async def lifespan(_: FastAPI):
    check_database()
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


# ---- Фронтенд: роздається тим самим сервером FastAPI (порт 8000) ----
FRONT = config.FRONTEND_DIR


@app.get("/", include_in_schema=False)
def index_page():
    """Головна сторінка дашборду."""
    return FileResponse(FRONT / "index.html")


@app.get("/print", include_in_schema=False)
def print_page():
    """Друкована довідка (PDF/друк). Фільтри передаються в рядку запиту."""
    return FileResponse(FRONT / "print.html")


@app.get("/index.html", include_in_schema=False)
def index_alias():
    return RedirectResponse("/")


# Статичні файли: стилі, зібрані скрипти, знімок бази й геодані, шрифти, бібліотеки.
# Монтується останнім, щоб не перекривати /api і /docs.
if FRONT.exists():
    app.mount("/", StaticFiles(directory=FRONT, html=True), name="frontend")
