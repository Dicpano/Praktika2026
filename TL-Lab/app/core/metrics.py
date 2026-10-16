"""Спільні метрики (ЗФ-5)."""
from __future__ import annotations

import numpy as np
from sklearn.metrics import (accuracy_score, adjusted_rand_score, confusion_matrix, f1_score,
                             normalized_mutual_info_score, silhouette_score)


def classification(y_true, y_pred, labels: list[str]) -> dict:
    return {
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "f1_macro": float(f1_score(y_true, y_pred, labels=labels, average="macro", zero_division=0)),
        "confusion": confusion_matrix(y_true, y_pred, labels=labels).tolist(),
        "labels": labels,
        "n": int(len(y_true)),
    }


def clustering(emb: np.ndarray, pred, ref=None) -> dict:
    out = {"silhouette": float(silhouette_score(emb, pred, metric="cosine")) if len(set(pred)) > 1 else 0.0}
    if ref is not None:
        out["ari"] = float(adjusted_rand_score(ref, pred))
        out["nmi"] = float(normalized_mutual_info_score(ref, pred))
    return out
