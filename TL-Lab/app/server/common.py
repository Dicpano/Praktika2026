"""Спільне для API: шляхи до файлів, фонові задачі, серіалізація результатів."""
from __future__ import annotations

import base64
import io
import math
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

import numpy as np
from fastapi import HTTPException

from core import config, experiment, registry
from core.jobs import MANAGER, Job

SERVE_ROOTS = [config.DATA, config.RESULTS, config.MODELS / "cache"]


def url(path: str | Path) -> str:
    """URL файлу з папки програми (дані, результати) для показу в браузері."""
    p = Path(path).resolve()
    try:
        rel = p.relative_to(config.ROOT.resolve())
    except ValueError:
        return ""
    return "/files/" + quote(rel.as_posix()) + f"?v={int(p.stat().st_mtime) if p.exists() else 0}"


def resolve(rel: str) -> Path:
    p = (config.ROOT / rel).resolve()
    if not any(str(p).startswith(str(r.resolve())) for r in SERVE_ROOTS) or not p.is_file():
        raise HTTPException(404, "файл не знайдено")
    return p


def png_b64(img) -> str:
    """PIL.Image або масив -> data:image/png;base64,…"""
    from PIL import Image
    if not isinstance(img, Image.Image):
        img = Image.fromarray(np.asarray(img).astype(np.uint8))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def clean(o: Any) -> Any:
    """Готує результати до JSON: numpy -> списки, NaN -> None, ключі -> рядки."""
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return clean(o.tolist())
    if isinstance(o, np.generic):
        return clean(o.item())
    if isinstance(o, float) and (math.isnan(o) or math.isinf(o)):
        return None
    if isinstance(o, Path):
        return str(o)
    return o


def job_dict(j: Job | None, lines: int = 60) -> dict | None:
    if j is None:
        return None
    return {"id": j.id, "module": j.module, "title": j.title, "status": j.status, "progress": round(j.progress, 4),
            "message": j.message, "error": j.error, "elapsed": round(j.elapsed, 1), "active": j.active,
            "lines": [list(x) for x in j.lines[-lines:]]}


def start(module: str, title: str, fn: Callable, **kwargs) -> dict:
    j = MANAGER.submit(module, title, fn, **kwargs)
    return {"job": job_dict(j), "already": j.title != title}


def job_result(module: str, key: str | None = None) -> Any:
    """Результат останньої успішної задачі модуля (опційно — лише якщо в ньому є ключ key)."""
    j = MANAGER.latest(module)
    if j and j.status == "done" and isinstance(j.result, dict) and (key is None or key in j.result):
        return j.result
    return None


def card(key: str) -> dict:
    c = registry.CARDS[key]
    return {"key": key, "title": c.title, "model": c.model, "source": c.source, "license": c.license,
            "params": c.params, "pretrained_on": c.pretrained_on, "adapted": c.adapted, "baseline": c.baseline,
            "missing": registry.missing_deps(key), "cached": registry.model_cached(key), "needs_gpu": c.needs_gpu}


def latest(key: str) -> dict | None:
    return clean(experiment.latest(key))


def need(cond: bool, msg: str) -> None:
    if not cond:
        raise HTTPException(400, msg)
