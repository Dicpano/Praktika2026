"""Окремий процес для TensorFlow / YAMNet (модуль 3).

TensorFlow і PyTorch в одному процесі можуть аварійно завершити програму, тому YAMNet
завантажується лише тут — у дочірньому процесі. Модель тримається в пам'яті між викликами.
"""
from __future__ import annotations

import os

os.environ["TL_TF_WORKER"] = "1"
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

_model = None
_names: list[str] | None = None


def _ensure(url: str) -> None:
    global _model, _names
    if _model is not None:
        return
    import csv

    import tensorflow_hub as hub
    _model = hub.load(url)
    path = _model.class_map_path().numpy().decode()
    with open(path, encoding="utf-8") as f:
        _names = [r["display_name"] for r in csv.DictReader(f)]


def names(url: str) -> list[str]:
    _ensure(url)
    return list(_names)


def run(url: str, wave):
    """Хвиля 16 кГц float32 -> (scores N×521, embeddings N×1024, log-mel спектрограма)."""
    _ensure(url)
    scores, emb, spec = _model(wave)
    return scores.numpy(), emb.numpy(), spec.numpy()


def tf_version() -> str:
    import tensorflow as tf
    return tf.__version__
