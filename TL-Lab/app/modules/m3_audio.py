"""Модуль 3. Звуки середовища: ембеддинги YAMNet + LogisticRegression, zero-shot як базовий рівень (ФВ-3.1…3.5)."""
from __future__ import annotations

from functools import lru_cache
from math import gcd
from pathlib import Path
from typing import Protocol

import joblib
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
from sklearn.linear_model import LogisticRegression

from core import cache, config, data, experiment, metrics
from core.jobs import reporter

CLASSES = ["shahed", "jet_shahed", "helicopter", "airplane", "engine", "chainsaw", "siren", "background"]
LABELS_UA = {"shahed": "Шахед (поршневий)", "jet_shahed": "Шахед реактивний", "helicopter": "Вертоліт",
             "airplane": "Літак", "engine": "Двигун техніки", "chainsaw": "Бензопила / мопед",
             "siren": "Сирена", "background": "Фон (дощ, вітер, грім…)"}
MIN_PER_CLASS = 4      # менше — клас не бере участі в навчанні
LOW_DATA = 10          # менше — клас позначається «мало даних»
DATA_DIR = config.DATA / "audio"
MODEL_FILE = config.MODELS / "m3_logreg.joblib"
SR = 16000

# Відображення класів AudioSet на наші три класи (редагується у вкладці)
ZERO_SHOT_MAP = {
    "shahed": ["Propeller, airscrew", "Light engine (high frequency)", "Motorcycle", "Aircraft engine", "Buzz"],
    "jet_shahed": ["Jet engine", "Whoosh, swoosh, swish", "Aircraft"],
    "helicopter": ["Helicopter"],
    "airplane": ["Fixed-wing aircraft, airplane", "Aircraft", "Airplane"],
    "engine": ["Engine", "Vehicle", "Motor vehicle (road)", "Car", "Truck", "Idling",
               "Accelerating, revving, vroom", "Medium engine (mid frequency)",
               "Heavy engine (low frequency)", "Engine starting"],
    "chainsaw": ["Chainsaw", "Power tool", "Lawn mower", "Sawing"],
    "siren": ["Siren", "Civil defense siren", "Police car (siren)", "Ambulance (siren)",
              "Fire engine, fire truck (siren)", "Emergency vehicle"],
    "background": ["Rain", "Raindrop", "Rain on surface", "Wind", "Thunder", "Thunderstorm", "Train",
                   "Fireworks", "Vehicle horn, car horn, honking", "Silence", "Outside, rural or natural"],
}


class Embedder(Protocol):
    class_names: list[str]

    def __call__(self, wave: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]: ...


def load_wav(path) -> np.ndarray:
    """Будь-який WAV/FLAC/OGG -> 16 кГц моно float32 у [-1; 1]."""
    wav, sr = sf.read(str(path), dtype="float32", always_2d=True)
    wav = wav.mean(axis=1)
    if sr != SR:
        g = gcd(SR, sr)
        wav = resample_poly(wav, SR // g, sr // g).astype(np.float32)
    return np.clip(wav, -1.0, 1.0)


_POOL = None


def worker_pool():
    """Один дочірній процес із TensorFlow на весь час роботи програми (spawn — чистий процес без PyTorch)."""
    global _POOL
    if _POOL is None:
        import multiprocessing as mp
        from concurrent.futures import ProcessPoolExecutor
        _POOL = ProcessPoolExecutor(max_workers=1, mp_context=mp.get_context("spawn"))
    return _POOL


class YamNet:
    """YAMNet в окремому процесі. Інтерфейс як у звичайної моделі: embedder(wave) -> (scores, emb, spec)."""

    def __init__(self):
        from modules import yamnet_worker
        self._w = yamnet_worker
        self.class_names = worker_pool().submit(yamnet_worker.names, config.YAMNET_URL).result(timeout=900)

    def __call__(self, wave):
        return worker_pool().submit(self._w.run, config.YAMNET_URL, wave).result(timeout=600)

    # розморожування (експериментально) — усе відбувається в процесі TensorFlow
    def ft_start(self, train, ytr, layers, w0, b0, lr):
        return worker_pool().submit(self._w.ft_start, config.YAMNET_URL, train, ytr, layers, w0, b0, lr,
                                    config.SEED).result(timeout=900)

    def ft_epoch(self):
        return worker_pool().submit(self._w.ft_epoch).result(timeout=3600)

    def ft_predict(self, waves):
        return worker_pool().submit(self._w.ft_predict, waves).result(timeout=900)

    def ft_end(self):
        return worker_pool().submit(self._w.ft_end).result(timeout=300)


@lru_cache(maxsize=1)
def default_embedder() -> YamNet:
    return YamNet()


def features(emb: np.ndarray) -> np.ndarray:
    """Усереднення + максимум по фреймах 0,96 с -> 2048 ознак на файл."""
    return np.concatenate([emb.mean(0), emb.max(0)])


def zero_shot(scores: np.ndarray, class_names: list[str], mapping=ZERO_SHOT_MAP) -> dict[str, float]:
    mean = scores.mean(0)
    idx = {n: i for i, n in enumerate(class_names)}
    # максимум, а не сума: інакше клас з довшим списком назв AudioSet отримував би перевагу
    raw = {c: float(max([mean[idx[n]] for n in names if n in idx], default=0.0)) for c, names in mapping.items()}
    s = sum(raw.values()) or 1.0
    return {c: v / s for c, v in raw.items()}


def top_audioset(scores: np.ndarray, class_names: list[str], k=5) -> list[tuple[str, float]]:
    mean = scores.mean(0)
    return [(class_names[i], float(mean[i])) for i in np.argsort(-mean)[:k]]


def analyze(path, embedder: Embedder) -> dict:
    wave = load_wav(path)
    scores, emb, spec = embedder(wave)
    return {"wave": wave, "scores": scores, "feat": features(emb), "spec": spec}


def finetune(embedder, feats, tr_p, tr_y, te_p, use, clf, layers=2, epochs=4, lr=1e-4, job=None) -> tuple[list, dict]:
    """Експериментально: розморожені верхні блоки YAMNet + голова, що стартує з логістичної регресії."""
    j = reporter(job)
    w0 = np.zeros((2048, len(use)), np.float32)
    b0 = np.full(len(use), -10.0, np.float32)
    coef, icpt = clf.coef_, clf.intercept_
    if coef.shape[0] == 1:   # sklearn для двох класів зберігає один рядок коефіцієнтів
        coef, icpt = np.vstack([-coef / 2, coef / 2]), np.array([-icpt[0] / 2, icpt[0] / 2])
    for k, c in enumerate(clf.classes_):
        w0[:, use.index(c)], b0[use.index(c)] = coef[k], icpt[k]
    info = embedder.ft_start([feats[p]["wave"] for p in tr_p], [use.index(y) for y in tr_y], layers, w0, b0, lr)
    try:
        j.log(f"розморожено блоки YAMNet {info['layers']} з {info['of_layers']} · навчуваних параметрів "
              f"{info['trainable']:,} з {info['total']:,}".replace(",", " "))
        for ep in range(epochs):
            j.check()
            loss = embedder.ft_epoch()
            j.set(0.9 + 0.08 * (ep + 1) / epochs, f"розморожена YAMNet: епоха {ep + 1}/{epochs}")
            j.log(f"епоха {ep + 1}/{epochs}: втрати {loss:.3f}")
        pred = [use[i] for i in embedder.ft_predict([feats[p]["wave"] for p in te_p])]
    finally:
        embedder.ft_end()   # повертаємо оригінальні ваги YAMNet
    return pred, info


def run_experiment(embedder: Embedder | None = None, test_size=0.3, mapping=ZERO_SHOT_MAP, job=None,
                   unfreeze_layers: int = 0, epochs: int = 4, lr: float = 1e-4) -> dict:
    import time
    j = reporter(job)
    t_start = time.time()
    j.set(0.02, "завантаження YAMNet")
    j.log("завантаження YAMNet (TensorFlow Hub)…")
    embedder = embedder or default_embedder()
    paths, labels = data.folder_dataset(DATA_DIR, CLASSES, data.AUDIO_EXT)
    use = [c for c in CLASSES if labels.count(c) >= MIN_PER_CLASS]
    skipped = [c for c in CLASSES if c not in use]
    if len(use) < 2:
        raise ValueError(f"Потрібно щонайменше {MIN_PER_CLASS} записи хоча б у двох класах")
    if skipped:
        j.warn("пропущено (менше %d записів): %s" % (MIN_PER_CLASS, ", ".join(LABELS_UA[c] for c in skipped)))
    low = [c for c in use if labels.count(c) < LOW_DATA]
    if low:
        j.warn("мало даних (< %d записів) — оцінка ненадійна: %s" % (LOW_DATA, ", ".join(LABELS_UA[c] for c in low)))
    keep = [i for i, l in enumerate(labels) if l in use]
    paths, labels = [paths[i] for i in keep], [labels[i] for i in keep]
    mapping = {c: v for c, v in mapping.items() if c in use}
    tr_p, te_p, tr_y, te_y = data.split(paths, labels, test_size)  # поділ за файлами, не за фреймами
    j.log(f"класи: {', '.join(LABELS_UA[c] for c in use)}")
    j.log(f"записів: {len(paths)} · поділ за файлами train {len(tr_p)} / test {len(te_p)}")
    feats = {}
    for i, p in enumerate(paths):
        feats[p] = analyze(p, embedder)
        j.set(0.05 + 0.85 * (i + 1) / len(paths), f"YAMNet: файл {i + 1}/{len(paths)}")
        if (i + 1) % 10 == 0 or i + 1 == len(paths):
            j.log(f"оброблено файлів: {i + 1}/{len(paths)}")
    base_pred = []
    for p in te_p:
        zs = zero_shot(feats[p]["scores"], embedder.class_names, mapping)
        base_pred.append(max(zs, key=zs.get))
    clf = LogisticRegression(max_iter=3000, C=1.0)
    clf.fit(np.stack([feats[p]["feat"] for p in tr_p]), tr_y)
    pred = clf.predict(np.stack([feats[p]["feat"] for p in te_p])).tolist()
    frozen_s = time.time() - t_start
    base, adapt = metrics.classification(te_y, base_pred, use), metrics.classification(te_y, pred, use)
    mets = {"baseline": base, "adapted": adapt}
    freeze = None
    if unfreeze_layers:
        if not hasattr(embedder, "ft_start"):
            j.warn("розморожування недоступне для цього ембеддера — пропущено")
        else:
            j.log(f"ЕКСПЕРИМЕНТ: розморожування {unfreeze_layers} верхніх блоків YAMNet · епох {epochs} · lr {lr:g}")
            t0 = time.time()
            try:
                ft_pred, info = finetune(embedder, feats, tr_p, tr_y, te_p, use, clf, unfreeze_layers, epochs, lr, job)
            except Exception as e:  # noqa: BLE001 — збережена модель може не підтримувати навчання
                if type(e).__name__ == "Cancelled":
                    raise
                j.warn(f"розморожування не вдалося: {e}. Звичайна адаптація (заморожена YAMNet) збережена.")
            else:
                mets["finetuned"] = metrics.classification(te_y, ft_pred, use)
                freeze = {"metric": "f1_macro", "rows": [
                    {"variant": "Заморожена YAMNet + LR", "trainable": len(use) * 2049, "total": info["total"],
                     "score": adapt["f1_macro"], "accuracy": adapt["accuracy"], "seconds": round(frozen_s, 1)},
                    {"variant": f"Розморожено {len(info['layers'])} з {info['of_layers']} блоків",
                     "trainable": info["trainable"], "total": info["total"], "score": mets["finetuned"]["f1_macro"],
                     "accuracy": mets["finetuned"]["accuracy"], "seconds": round(time.time() - t0 + frozen_s, 1)}]}
                j.log(f"F1-macro: заморожена {adapt['f1_macro']:.3f} → розморожена {mets['finetuned']['f1_macro']:.3f}",
                      "ok" if mets["finetuned"]["f1_macro"] >= adapt["f1_macro"] else "wr")
    errors = [{"file": str(p), "true": t, "pred": q, "zero_shot": b}
              for p, t, q, b in zip(te_p, te_y, pred, base_pred) if t != q or t != b]
    clf.fit(np.stack([feats[p]["feat"] for p in paths]), labels)  # фінальна модель на всіх даних
    joblib.dump(clf, MODEL_FILE)
    params = {"train_files": len(tr_p), "test_files": len(te_p), "features": "mean+max 2048", "classes": use,
              "low_data": low}
    if freeze:
        params.update(unfreeze_layers=unfreeze_layers, ft_epochs=epochs, ft_lr=lr)
    experiment.log_result("m3", params, mets,
                          notes="baseline = zero-shot YAMNet за відображенням класів AudioSet")
    res = {"baseline": base, "adapted": adapt, "errors": errors, "params": params, "classes": use, "freeze": freeze}
    experiment.save_extra("m3", res)
    j.ok(f"F1-macro: zero-shot {base['f1_macro']:.3f} → YAMNet+LR {adapt['f1_macro']:.3f}")
    return res


def predict(path, embedder: Embedder | None = None, mapping=ZERO_SHOT_MAP) -> dict:
    embedder = embedder or default_embedder()
    a = analyze(path, embedder)
    clf = cache.joblib_load(MODEL_FILE)
    pr = clf.predict_proba(a["feat"][None])[0]
    order = list(clf.classes_)
    return {
        "label": order[int(pr.argmax())],
        "probs": {c: float(pr[order.index(c)]) for c in CLASSES if c in order},
        "zero_shot": zero_shot(a["scores"], embedder.class_names, {c: v for c, v in mapping.items() if c in order}),
        "top_audioset": top_audioset(a["scores"], embedder.class_names),
        "wave": a["wave"], "spec": a["spec"],
    }


if __name__ == "__main__":
    r = run_experiment()
    print("zero-shot F1", r["baseline"]["f1_macro"], "YAMNet+LR F1", r["adapted"]["f1_macro"])
