"""Transfer Learning-лабораторія 3.1 — сервер (FastAPI). Запуск: python -m server  (робить TL-Lab.bat).

Інтерфейс — односторінковий вебзастосунок у папці web/: сторінки перемикаються в браузері миттєво,
а сервер лише віддає дані й виконує навчання у фонових задачах. Прогрес задач надходить потоком подій.
"""
from __future__ import annotations

import faulthandler
import os
import sys
import threading
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
PID_FILE = ROOT / "logs" / "server.pid"


def _stop_workers() -> None:
    """Закрити дочірні процеси TensorFlow (модуль 3) і Qwen (модуль 5), якщо вони запущені."""
    for mod in ("modules.m3_audio", "modules.m5_llm"):
        m = sys.modules.get(mod)
        pool = getattr(m, "_POOL", None) if m else None
        if pool is not None:
            try:
                for pr in list(getattr(pool, "_processes", {}).values()):
                    pr.kill()
                pool.shutdown(wait=False, cancel_futures=True)
            except Exception:  # noqa: BLE001
                pass


def _bye() -> None:
    _stop_workers()
    PID_FILE.unlink(missing_ok=True)
    os._exit(0)


def _watchdog(minutes: int) -> None:
    """Сервер працює без вікна, тож сам вимикається, коли вікно програми закрите `minutes` хв і задач немає."""
    import time
    while True:
        time.sleep(30)
        c = r_core.CLIENTS
        if c["n"] == 0 and time.time() - c["seen"] > minutes * 60 and not MANAGER.running():
            _bye()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        faulthandler.enable()   # аварія бібліотеки → трасування в журнал сервера
    except (RuntimeError, ValueError, AttributeError):
        pass
    PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    PID_FILE.write_text(str(os.getpid()), encoding="ascii")   # для TL-Lab-Stop.bat
    MANAGER.set_workers(settings.get("workers"))
    if os.environ.get("TL_AUTOSTOP"):
        threading.Thread(target=_watchdog, args=(int(os.environ["TL_AUTOSTOP"]),), daemon=True).start()
    if settings.get("warmup"):
        warmup.start()          # важкі бібліотеки вантажаться у фоні — інтерфейс доступний одразу
    yield
    PID_FILE.unlink(missing_ok=True)


app = FastAPI(title="Transfer Learning-лабораторія", lifespan=lifespan, docs_url=None, redoc_url=None)
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


@app.post("/api/shutdown")
def shutdown():
    """Кнопка «Вимкнути програму»: сервер завершується через пів секунди (встигає відповісти браузеру)."""
    threading.Timer(0.5, _bye).start()
    return {"ok": True}


@app.get("/health")  # перевірка з TL-Lab.bat: відрізняє цей сервер від будь-якого іншого на тому ж порту
def health():
    return {"app": "tl-lab-3", "ok": True}


@app.get("/")
def index():
    return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-cache"})
