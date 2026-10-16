"""TL-Лабораторія 3.0 — сервер (FastAPI). Запуск: python -m server  (робить TL-Lab.bat).

Інтерфейс — односторінковий вебзастосунок у папці web/: сторінки перемикаються в браузері миттєво,
а сервер лише віддає дані й виконує навчання у фонових задачах. Прогрес задач надходить потоком подій.
"""
from __future__ import annotations

import faulthandler
import sys
from contextlib import asynccontextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core import config  # noqa: E402,F401  (першим: змінні середовища й шляхи)

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from core import settings, warmup  # noqa: E402
from core.jobs import MANAGER  # noqa: E402
from server import r_core, r_data, r_modules  # noqa: E402

WEB = ROOT / "web"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        faulthandler.enable()   # аварія бібліотеки → трасування в журнал сервера
    except (RuntimeError, ValueError, AttributeError):
        pass
    MANAGER.set_workers(settings.get("workers"))
    if settings.get("warmup"):
        warmup.start()          # важкі бібліотеки вантажаться у фоні — інтерфейс доступний одразу
    yield


app = FastAPI(title="TL-Лабораторія", lifespan=lifespan, docs_url=None, redoc_url=None)
for rt in (r_core.r, r_modules.r, r_data.r):
    app.include_router(rt)
app.mount("/static", StaticFiles(directory=WEB), name="static")


@app.middleware("http")
async def no_stale_ui(request: Request, call_next):
    """Після оновлення програми браузер не має показувати старий інтерфейс із кешу (перевірка — 304, миттєво)."""
    resp = await call_next(request)
    if request.url.path.startswith("/static/") and "/vendor/" not in request.url.path:
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.exception_handler(Exception)
async def errors(_req: Request, exc: Exception):
    from core.experiment import log
    log.exception("API error")
    return JSONResponse({"detail": str(exc)}, status_code=500)


@app.get("/health")  # перевірка з TL-Lab.bat: відрізняє цей сервер від будь-якого іншого на тому ж порту
def health():
    return {"app": "tl-lab-3", "ok": True}


@app.get("/")
def index():
    return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-cache"})
