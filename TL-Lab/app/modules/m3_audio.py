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


def run_experiment(embedder: Embedder | None = None, test_size=0.3, mapping=ZERO_SHOT_MAP, job=None) -> dict:
    j = reporter(job)
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
    base, adapt = metrics.classification(te_y, base_pred, use), metrics.classification(te_y, pred, use)
    errors = [{"file": str(p), "true": t, "pred": q, "zero_shot": b}
              for p, t, q, b in zip(te_p, te_y, pred, base_pred) if t != q or t != b]
    clf.fit(np.stack([feats[p]["feat"] for p in paths]), labels)  # фінальна модель на всіх даних
    joblib.dump(clf, MODEL_FILE)
    params = {"train_files": len(tr_p), "test_files": len(te_p), "features": "mean+max 2048", "classes": use,
              "low_data": low}
    experiment.log_result("m3", params, {"baseline": base, "adapted": adapt},
                          notes="baseline = zero-shot YAMNet за відображенням класів AudioSet")
    res = {"baseline": base, "adapted": adapt, "errors": errors, "params": params, "classes": use}
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
