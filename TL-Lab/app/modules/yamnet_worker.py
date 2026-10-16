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


# ---------------------------------------------------------------- розморожування (експериментально)
_ft: dict = {}


def _layer_no(v) -> int | None:
    import re
    m = re.search(r"layer(\d+)", v.name)
    return int(m.group(1)) if m else None


def _all_vars(tf) -> list:
    """Ваги завантаженої моделі: з атрибутів об'єкта, а якщо їх немає — з функції виклику (захоплені змінні)."""
    for attr in ("trainable_variables", "variables"):
        try:
            vs = list(getattr(_model, attr, None) or [])
        except Exception:  # noqa: BLE001
            vs = []
        if vs:
            return [v for v in vs if getattr(v, "trainable", True)]
    try:
        fn = _model.__call__.get_concrete_function(tf.TensorSpec([None], tf.float32))
        vs = list(fn.trainable_variables or fn.variables or [])
    except Exception:  # noqa: BLE001
        vs = []
    return vs


def ft_start(url: str, train: list, ytr: list, layers: int, w0, b0, lr: float, seed: int = 42) -> dict:
    """Готує розморожування верхніх `layers` блоків YAMNet + лінійна голова (старт — з логістичної регресії).

    Кидає RuntimeError, якщо ця версія моделі не дає змінювати ваги або рахувати градієнти.
    """
    import numpy as np
    import tensorflow as tf
    _ensure(url)
    ft_end()
    tf.random.set_seed(seed)
    vars_ = _all_vars(tf)
    if not vars_:
        raise RuntimeError("ця версія YAMNet не відкриває свої ваги для навчання")
    nums = sorted({n for v in vars_ if (n := _layer_no(v)) is not None})
    if not nums:
        raise RuntimeError("не вдалося визначити шари YAMNet за назвами ваг")
    top = set(nums[-max(1, layers):])
    tv = [v for v in vars_ if _layer_no(v) in top]
    W = tf.Variable(np.asarray(w0, np.float32))
    B = tf.Variable(np.asarray(b0, np.float32))
    _ft.update(tv=tv, saved=[v.numpy().copy() for v in tv], W=W, B=B, lr=lr, step=0,
               mom={id(v): (tf.zeros_like(v), tf.zeros_like(v)) for v in tv + [W, B]},
               train=[np.asarray(x, np.float32) for x in train], ytr=list(ytr), rng=np.random.default_rng(seed))
    total = int(sum(int(np.prod(v.shape)) for v in vars_))
    trainable = int(sum(int(np.prod(v.shape)) for v in tv)) + int(np.prod(W.shape)) + int(np.prod(B.shape))
    return {"layers": sorted(top), "of_layers": len(nums), "trainable": trainable, "total": total + trainable - int(
        sum(int(np.prod(v.shape)) for v in tv))}


def _feat(wave):
    import tensorflow as tf
    _, emb, _ = _model(wave)
    return tf.concat([tf.reduce_mean(emb, 0), tf.reduce_max(emb, 0)], 0)


def _adam(v, g, lr, t, b1=0.9, b2=0.999, eps=1e-7):
    import tensorflow as tf
    m, s = _ft["mom"][id(v)]
    m = b1 * m + (1 - b1) * g
    s = b2 * s + (1 - b2) * tf.square(g)
    _ft["mom"][id(v)] = (m, s)
    v.assign_sub(lr * (m / (1 - b1 ** t)) / (tf.sqrt(s / (1 - b2 ** t)) + eps))


def ft_epoch() -> float:
    """Одна епоха (оновлення після кожного запису). -> середні втрати."""
    import numpy as np
    import tensorflow as tf
    tv, W, B = _ft["tv"], _ft["W"], _ft["B"]
    losses = []
    for i in _ft["rng"].permutation(len(_ft["train"])):
        with tf.GradientTape() as tape:
            logits = tf.linalg.matvec(W, _feat(_ft["train"][i]), transpose_a=True) + B
            loss = tf.nn.sparse_softmax_cross_entropy_with_logits(labels=[_ft["ytr"][i]], logits=logits[None])[0]
        grads = tape.gradient(loss, tv + [W, B])
        if not _ft.get("body_grad") and any(g is not None and float(tf.reduce_sum(tf.abs(tf.convert_to_tensor(g)))) > 0
                                            for g in grads[:len(tv)]):
            _ft["body_grad"] = True
        _ft["step"] += 1
        body = {id(v) for v in tv}   # tf.Variable не можна порівнювати через «in» (поелементне ==)
        for v, g in zip(tv + [W, B], grads):
            if g is not None:
                _adam(v, tf.convert_to_tensor(g), _ft["lr"] if id(v) in body else 1e-3, _ft["step"])
        losses.append(float(loss.numpy()))
    if not _ft.get("body_grad"):
        raise RuntimeError("градієнти не проходять крізь збережену модель YAMNet — розморожування неможливе")
    return float(np.mean(losses))


def ft_predict(waves: list) -> list[int]:
    import tensorflow as tf
    W, B = _ft["W"], _ft["B"]
    return [int(tf.argmax(tf.linalg.matvec(W, _feat(w), transpose_a=True) + B).numpy()) for w in waves]


def ft_end() -> None:
    """Повертає YAMNet оригінальні ваги (щоб звичайний режим і демонстрація працювали як раніше)."""
    if _ft.get("tv"):
        for v, s in zip(_ft["tv"], _ft["saved"]):
            v.assign(s)
    _ft.clear()
