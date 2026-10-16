"""Загальні маршрути: стан, фонові задачі (потік подій), налаштування, теорія, словник, історія, звіт, файли."""
from __future__ import annotations

import asyncio
import json
import platform
import sys
import time

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, Response, StreamingResponse

from core import config, experiment, registry, settings, warmup
from core.jobs import MANAGER
from server.common import card, clean, job_dict, latest, need, resolve

r = APIRouter()
MAIN = {"m1": "f1_macro", "m2": "f1_macro", "m3": "f1_macro", "m4": "silhouette", "m5": "valid_json", "m6": "mean_reward"}


@r.get("/api/status")
def status():
    mods = {}
    for k in registry.CARDS:
        e = experiment.latest(k)
        m = MAIN[k]
        mods[k] = {**card(k), "metric": m, "last_time": e["time"] if e else None,
                   "m_base": (e or {}).get("metrics", {}).get("baseline", {}).get(m),
                   "m_adapt": (e or {}).get("metrics", {}).get("adapted", {}).get(m),
                   "job": job_dict(MANAGER.active(k), 0)}
    return clean({"modules": mods, "warmup": {**warmup.STATE, "status": warmup.STATUS},
                  "gpu": registry.gpu_available(), "runs": len(experiment.load_results()),
                  "python": sys.version.split()[0], "os": platform.platform(), "root": str(config.ROOT)})


# ---------------- фонові задачі ----------------
@r.get("/api/jobs")
def jobs():
    return [job_dict(j, 0) for j in reversed(MANAGER.all())]


@r.get("/api/jobs/{module}")
def job_latest(module: str):
    return job_dict(MANAGER.latest(module), 200)


@r.post("/api/jobs/{job_id}/cancel")
def job_cancel(job_id: str):
    for j in MANAGER.all():
        if j.id == job_id:
            j.cancel()
            return {"ok": True}
    return {"ok": False}


@r.get("/api/events")
async def events(request: Request):
    """Потік подій (Server-Sent Events): стан активних і щойно завершених задач.
    Браузер отримує оновлення сам — без опитування сторінки."""
    async def gen():
        last, idle = None, 0
        while not await request.is_disconnected():
            recent = [j for j in MANAGER.all() if j.active or (j.finished and time.time() - j.finished < 5)]
            snap = json.dumps([job_dict(j, 40) for j in recent], ensure_ascii=False)
            if snap != last or idle > 15:
                yield f"data: {snap}\n\n"
                last, idle = snap, 0
            else:
                idle += 1
            await asyncio.sleep(0.5 if recent else 1.0)
    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


# ---------------- налаштування ----------------
@r.get("/api/settings")
def get_settings():
    return settings.load()


@r.post("/api/settings")
def set_settings(body: dict):
    for k, v in body.items():
        if k in settings.DEFAULTS:
            settings.set(k, v)
    if "workers" in body:
        MANAGER.set_workers(settings.get("workers"))
    return settings.load()


@r.post("/api/settings/reset")
def reset_settings():
    settings.reset()
    return settings.load()


@r.get("/api/system")
def system():
    import importlib.metadata as md
    libs = ["fastapi", "uvicorn", "torch", "torchvision", "tensorflow", "tensorflow-hub", "sentence-transformers",
            "transformers", "peft", "stable-baselines3", "gymnasium", "scikit-learn", "numpy", "pandas", "python-pptx"]
    vers = {}
    for n in libs:
        try:
            vers[n] = md.version(n)
        except md.PackageNotFoundError:
            vers[n] = None

    def size(p):
        return round(sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) / 1024 ** 2, 1) if p.exists() else 0
    folders = {"Моделі": size(config.MODELS), "Дані": size(config.DATA), "Результати": size(config.RESULTS),
               "Кеш ембеддингів": size(config.MODELS / "cache")}
    return {"libs": vers, "folders": folders, "cards": [card(k) for k in registry.CARDS],
            "warmup": {**warmup.STATE, "status": warmup.STATUS}, "gpu": registry.gpu_available()}


@r.post("/api/system/clear/{what}")
def clear(what: str):
    import shutil
    if what == "cache":
        shutil.rmtree(config.MODELS / "cache", ignore_errors=True)
        (config.MODELS / "cache").mkdir(exist_ok=True)
    elif what == "figs":
        shutil.rmtree(config.FIGS, ignore_errors=True)
        config.FIGS.mkdir(exist_ok=True)
    elif what == "results":
        experiment.RESULTS_FILE.unlink(missing_ok=True)
        for f in config.RESULTS.glob("m*_last.joblib"):
            f.unlink()
    else:
        need(False, "невідома дія")
    return {"ok": True}


# ---------------- теорія і словник ----------------
@r.get("/api/theory/{key}")
def theory(key: str):
    from modules.theory import THEORY
    return [{"title": t, "md": b} for t, b in THEORY.get(key, [])]


@r.get("/api/glossary")
def glossary():
    from modules.glossary import TERMS
    return TERMS


# ---------------- історія ----------------
@r.get("/api/history")
def history():
    rows = []
    for i, e in enumerate(experiment.load_results()):
        k = MAIN.get(e["module"], "")
        b = e["metrics"].get("baseline", {}).get(k)
        a = e["metrics"].get("adapted", {}).get(k)
        rows.append({"i": i, "module": e["module"], "time": e["time"], "metric": k, "baseline": b, "adapted": a,
                     "params": e.get("params", {}), "notes": e.get("notes", "")})
    return clean(rows)


@r.post("/api/history/delete")
def history_delete(body: dict):
    experiment.delete_runs([int(i) for i in body.get("ids", [])])
    return {"ok": True}


@r.get("/api/history.csv")
def history_csv():
    import pandas as pd
    df = pd.DataFrame(history())
    return Response(df.to_csv(index=False).encode("utf-8-sig"), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="experiments.csv"'})


# ---------------- звіт і слайди ----------------
@r.get("/api/report/{key}")
def report_info(key: str):
    from core.report import compare_rows
    e = experiment.latest(key)
    return clean({"card": card(key), "entry": e, "rows": compare_rows(e["metrics"]) if e else []})


@r.post("/api/report/{key}/{fmt}")
def report_build(key: str, fmt: str, body: dict):
    from core import slides
    from core.report import build_markdown
    e = experiment.latest(key)
    errors, limits, concl = body.get("errors", ""), body.get("limits", ""), body.get("conclusion", "")
    if fmt == "md":
        md = build_markdown(key, e, errors, limits, concl)
        if body.get("save"):
            (config.RESULTS / f"report_{key}.md").write_text(md, encoding="utf-8")
        return Response(md.encode("utf-8"), media_type="text/markdown",
                        headers={"Content-Disposition": f'attachment; filename="report_{key}.md"'})
    data = slides.build(key, e, experiment.load_extra(key), errors, limits, concl,
                        body.get("repo", "https://github.com/Dicpano/Praktika2026"))
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                    headers={"Content-Disposition": f'attachment; filename="TL-Lab_{key}_slides.pptx"'})


# ---------------- файли (фото, аудіо, анімації) ----------------
@r.get("/files/{rel:path}")
def files(rel: str):
    return FileResponse(resolve(rel), headers={"Cache-Control": "max-age=3600"})
