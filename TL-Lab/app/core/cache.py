"""Кешування збережених моделей у пам'яті: файл читається з диска лише після зміни."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Callable


@lru_cache(maxsize=32)
def _load(path: str, mtime: float, loader: Callable):
    return loader(path)


def load(path: Path, loader: Callable):
    """Повертає об'єкт з кешу; перезавантажує, якщо файл змінився (нове навчання)."""
    p = Path(path)
    return _load(str(p), p.stat().st_mtime, loader)


def joblib_load(path: Path):
    import joblib
    return load(path, joblib.load)
