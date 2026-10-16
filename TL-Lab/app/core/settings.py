"""Налаштування програми: зберігаються в settings.json і переживають перезапуск."""
from __future__ import annotations

import json
import threading

from core import config

FILE = config.ROOT / "settings.json"
DEFAULTS = {
    "bg_mode": "matrix",        # matrix | radar | off
    "bg_k": 0.5,                # інтенсивність фону 0.1…1
    "present_mode": False,      # режим «Доповідь»
    "workers": 1,               # скільки задач навчання виконувати одночасно
    "warmup": True,             # прогрівати бібліотеки й моделі після запуску
    "uncertain": 0.6,           # поріг «невизначено» у модулі 1
    "rl_steps": 50_000,         # кроків донавчання за замовчуванням у модулі 6
    "animations": True,         # плавні переходи інтерфейсу
    "bg_pause_jobs": True,      # зупиняти анімацію фону, поки йде навчання (процесор — моделям)
}
_lock = threading.Lock()
_cache: dict | None = None


def load() -> dict:
    global _cache
    if _cache is None:
        data = dict(DEFAULTS)
        try:
            data.update({k: v for k, v in json.loads(FILE.read_text(encoding="utf-8")).items() if k in DEFAULTS})
        except (OSError, json.JSONDecodeError):
            pass
        _cache = data
    return _cache


def get(key: str):
    return load().get(key, DEFAULTS.get(key))


def set(key: str, value) -> None:  # noqa: A001
    with _lock:
        s = load()
        if s.get(key) == value:
            return
        s[key] = value
        FILE.write_text(json.dumps(s, ensure_ascii=False, indent=1), encoding="utf-8")


def reset() -> None:
    global _cache
    with _lock:
        _cache = dict(DEFAULTS)
        FILE.write_text(json.dumps(_cache, ensure_ascii=False, indent=1), encoding="utf-8")
