"""Завантаження даних і стратифікований поділ (ЗФ-2, ЗФ-3)."""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import pandas as pd
from sklearn.model_selection import train_test_split

from core import config

IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
AUDIO_EXT = {".wav", ".mp3", ".flac", ".ogg"}


def read_csv(path: Path, required: list[str]) -> pd.DataFrame:
    df = pd.read_csv(path, encoding="utf-8")
    miss = [c for c in required if c not in df.columns]
    if miss:
        raise ValueError(f"У файлі {Path(path).name} бракує стовпців: {', '.join(miss)}")
    return df.dropna(subset=required).reset_index(drop=True)


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    for i, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        if line.strip():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise ValueError(f"Рядок {i}: некоректний JSON ({e})") from e
    return rows


def folder_dataset(root: Path, classes: list[str], exts: set[str]) -> tuple[list[Path], list[str]]:
    """Файли з підпапок root/<клас>/. Повертає шляхи й мітки."""
    paths, labels = [], []
    for c in classes:
        d = Path(root) / c
        if d.exists():
            for p in sorted(d.iterdir()):
                if p.suffix.lower() in exts:
                    paths.append(p)
                    labels.append(c)
    return paths, labels


def class_stats(labels: list[str]) -> pd.DataFrame:
    c = Counter(labels)
    return pd.DataFrame({"клас": list(c), "кількість": list(c.values())})


def split(items: list, labels: list[str], test_size: float = 0.3, seed: int = config.SEED):
    """Стратифікований поділ train/test."""
    return train_test_split(items, labels, test_size=test_size, random_state=seed, stratify=labels)
