"""Спільні функції проекту 4.10: генерація даних, вікна, split, baseline, оцінка.

Усі notebooks імпортують цей модуль, щоб data split і метрики були однаковими
для baseline і DL-моделей (той самий evaluation protocol).
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import precision_recall_fscore_support, average_precision_score

ROOT = Path(__file__).resolve().parents[1]
CHANNELS = ["temperature", "vibration", "pressure"]
ANOMALY_TYPES = ["spike", "level_shift", "vib_oscillation", "decorrelation"]


def load_config():
    with open(ROOT / "config.json", encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------- data
def generate_sensor_data(cfg):
    """Синтетичний 3-канальний сигнал датчиків з інжектованими аномаліями.

    Нормальна поведінка:
      * temperature — добовий цикл + шум;
      * pressure    — лінійно залежить від temperature (фізичний зв'язок) + шум;
      * vibration   — низький рівень + шум.
    Аномалії (позначаються в label/atype):
      * spike           — короткий викид 1–3 точки в одному каналі;
      * level_shift     — зсув рівня каналу на 12–36 точок;
      * vib_oscillation — високочастотні коливання вібрації (середнє не змінюється);
      * decorrelation   — pressure перестає слідувати за temperature
                          (значення залишаються в нормальному діапазоні!).
    У тестовому періоді додається слабкий дрейф температури (перевірка drift).
    """
    d = cfg["data"]
    rng = np.random.default_rng(d["seed"])
    n = d["days"] * d["points_per_day"]
    t = np.arange(n)
    day_phase = 2 * np.pi * t / d["points_per_day"]

    temp = 20 + 5 * np.sin(day_phase) + rng.normal(0, 0.4, n)
    drift_start = int(n * (1 - d["test_frac"]))
    temp[drift_start:] += np.linspace(0, d["test_drift"], n - drift_start)
    press = 100 + 0.8 * (temp - 20) + rng.normal(0, 0.3, n)
    vib = 1.0 + 0.1 * np.sin(day_phase * 3) + rng.normal(0, 0.15, n)
    X = np.stack([temp, vib, press], axis=1)

    label = np.zeros(n, dtype=int)
    atype = np.array([""] * n, dtype=object)
    stds = X[:drift_start].std(axis=0)

    n_events = d["n_anomalies"]
    starts = np.sort(rng.choice(np.arange(50, n - 60), size=n_events, replace=False))
    for s in starts:
        kind = ANOMALY_TYPES[rng.integers(len(ANOMALY_TYPES))]
        if kind == "spike":
            L, ch = int(rng.integers(1, 4)), int(rng.integers(3))
            X[s:s + L, ch] += rng.choice([-1, 1]) * rng.uniform(4, 6) * stds[ch]
        elif kind == "level_shift":
            L, ch = int(rng.integers(12, 37)), int(rng.integers(3))
            X[s:s + L, ch] += rng.choice([-1, 1]) * rng.uniform(1.0, 1.6) * stds[ch]
        elif kind == "vib_oscillation":
            L = int(rng.integers(18, 37))
            X[s:s + L, 1] += 0.35 * np.sin(np.arange(L) * 2.5)
        else:  # decorrelation: тиск "застигає" на середньому рівні
            L = int(rng.integers(24, 49))
            X[s:s + L, 2] = 100 + rng.normal(0, 0.3, L)
        label[s:s + L] = 1
        atype[s:s + L] = kind

    df = pd.DataFrame(X, columns=CHANNELS)
    df.insert(0, "timestamp", pd.date_range("2026-01-01", periods=n, freq="10min"))
    df["label"] = label
    df["atype"] = atype
    return df


def load_data():
    return pd.read_csv(ROOT / "data" / "sensor_data.csv", parse_dates=["timestamp"], keep_default_na=False)


# ---------------------------------------------------------------- windows / split
def temporal_split(df, cfg):
    """Часовий split без перемішування: train → validation → test."""
    n = len(df)
    d = cfg["data"]
    i_val = int(n * (1 - d["test_frac"] - d["val_frac"]))
    i_test = int(n * (1 - d["test_frac"]))
    return df.iloc[:i_val], df.iloc[i_val:i_test], df.iloc[i_test:]


def make_windows(part, window, step):
    """Ковзні вікна. Вікно аномальне, якщо містить хоча б одну аномальну точку."""
    values = part[CHANNELS].to_numpy(dtype=np.float32)
    lab = part["label"].to_numpy()
    typ = part["atype"].to_numpy()
    X, y, types = [], [], []
    for s in range(0, len(part) - window + 1, step):
        X.append(values[s:s + window])
        w_lab = lab[s:s + window]
        y.append(int(w_lab.any()))
        kinds = [k for k in typ[s:s + window] if k]
        types.append(kinds[0] if kinds else "normal")
    return np.stack(X), np.array(y), np.array(types)


class ChannelScaler:
    """Стандартизація по каналах; параметри рахуються ЛИШЕ на нормальних train-даних."""

    def fit(self, values):
        self.mean_ = values.mean(axis=0)
        self.std_ = values.std(axis=0)
        return self

    def transform(self, X):
        return (X - self.mean_) / self.std_


# ---------------------------------------------------------------- baseline
def zscore_scores(Xw_scaled):
    """Baseline score: максимальне |z| у вікні по всіх каналах."""
    return np.abs(Xw_scaled).max(axis=(1, 2))


# ---------------------------------------------------------------- evaluation
def best_threshold(y_true, scores):
    """Підбір порогу на VALIDATION за максимумом F1."""
    best_t, best_f1 = None, -1
    for t in np.quantile(scores, np.linspace(0.5, 0.999, 300)):
        _, _, f1, _ = precision_recall_fscore_support(y_true, scores > t, average="binary", zero_division=0)
        if f1 > best_f1:
            best_t, best_f1 = t, f1
    return float(best_t)


def evaluate(y_true, scores, threshold, windows_per_day):
    pred = scores > threshold
    p, r, f1, _ = precision_recall_fscore_support(y_true, pred, average="binary", zero_division=0)
    false_alarms = int(((pred == 1) & (y_true == 0)).sum())
    days = len(y_true) / windows_per_day
    return {"precision": p, "recall": r, "f1": f1,
            "pr_auc": average_precision_score(y_true, scores),
            "false_alarms": false_alarms,
            "false_alarms_per_day": false_alarms / days}


def recall_by_type(y_true, types, scores, threshold):
    pred = scores > threshold
    rows = []
    for k in ANOMALY_TYPES:
        m = types == k
        if m.sum():
            rows.append({"anomaly_type": k, "windows": int(m.sum()), "recall": float(pred[m].mean())})
    return pd.DataFrame(rows)
