"""Seed, журнал експериментів results/results.json (ЗФ-7) і логування."""
from __future__ import annotations

import json
import logging
import random
import sys
from datetime import datetime
from typing import Any

import numpy as np

from core import config

RESULTS_FILE = config.RESULTS / "results.json"

logging.basicConfig(
    filename=config.LOGS / "app.log", level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s", encoding="utf-8",
)
log = logging.getLogger("tl_lab")


def set_seed(seed: int = config.SEED) -> None:
    """Фіксує seed для всіх бібліотек, які вже імпортовані."""
    random.seed(seed)
    np.random.seed(seed)
    if "torch" in sys.modules:
        import torch
        torch.manual_seed(seed)
    if "tensorflow" in sys.modules:
        import tensorflow as tf
        tf.random.set_seed(seed)


def _to_jsonable(o: Any) -> Any:
    if isinstance(o, dict):
        return {str(k): _to_jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_to_jsonable(v) for v in o]
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, np.generic):
        return o.item()
    return o


def load_results() -> list[dict]:
    if not RESULTS_FILE.exists():
        return []
    try:
        return json.loads(RESULTS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        log.warning("results.json пошкоджено, починаю новий журнал")
        return []


def log_result(module: str, params: dict, metrics: dict, notes: str = "") -> dict:
    entry = {
        "module": module,
        "time": datetime.now().isoformat(timespec="seconds"),
        "seed": config.SEED,
        "params": _to_jsonable(params),
        "metrics": _to_jsonable(metrics),
        "notes": notes,
    }
    data = load_results()
    data.append(entry)
    RESULTS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    log.info("result %s %s", module, entry["metrics"])
    return entry


def save_extra(module: str, obj: Any) -> None:
    """Деталі останнього запуску (помилки, ембеддинги, криві) для вкладки «Оцінювання»."""
    import joblib
    joblib.dump(obj, config.RESULTS / f"{module}_last.joblib")


def load_extra(module: str) -> Any:
    f = config.RESULTS / f"{module}_last.joblib"
    if not f.exists():
        return None
    import joblib
    try:
        return joblib.load(f)
    except Exception:
        return None


def delete_runs(indices: list[int]) -> None:
    data = [e for i, e in enumerate(load_results()) if i not in set(indices)]
    RESULTS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def latest(module: str) -> dict | None:
    for e in reversed(load_results()):
        if e["module"] == module:
            return e
    return None
