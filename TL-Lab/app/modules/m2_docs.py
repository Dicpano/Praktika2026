"""Модуль 2. Сортування документів: ембеддинги MiniLM + LogisticRegression (ФВ-2.1…2.5)."""
from __future__ import annotations

from typing import Callable

import joblib
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.pipeline import make_pipeline

from core import cache, config, data, experiment, metrics
from core.jobs import reporter

CLASSES = ["combat", "info", "analytic", "order", "report", "request"]
LABELS_UA = {"combat": "Бойове донесення", "info": "Інформаційне повідомлення", "analytic": "Аналітична довідка",
             "order": "Наказ / розпорядження", "report": "Рапорт", "request": "Заявка на забезпечення"}
LABELS_SHORT = {"combat": "Донес.", "info": "Інформ.", "analytic": "Аналіт.", "order": "Наказ",
                "report": "Рапорт", "request": "Заявка"}
DESCRIPTIONS = {
    "combat": "доповідь про обстановку й дії підрозділу на певний час («станом на…», сили, втрати, потреби)",
    "info": "факт або подія без оцінок («повідомляємо», «інформуємо»)",
    "analytic": "порівняння, тенденції, оцінки, висновки, прогноз",
    "order": "вказівка до виконання: «наказую», «затвердити», «розпорядження», виконавці й терміни",
    "report": "особисте звернення військовослужбовця до командира: «прошу…», «доповідаю…», підпис",
    "request": "потреба в матеріальних засобах: що, скільки, для кого і до якого терміну",
}
DATA_FILE = config.DATA / "docs" / "documents.csv"
MODEL_FILE = config.MODELS / "m2_logreg.joblib"

Encoder = Callable[[list[str]], np.ndarray]


def default_encoder() -> Encoder:
    from modules.text_encoder import encode
    return encode


def load_data(path=DATA_FILE):
    df = data.read_csv(path, ["text", "label"])
    bad = set(df.label) - set(CLASSES)
    if bad:
        raise ValueError(f"Невідомі категорії: {bad}. Допустимі: {CLASSES}")
    return df.text.tolist(), df.label.tolist()


def _cv(n_min: int) -> StratifiedKFold:
    return StratifiedKFold(n_splits=min(5, n_min), shuffle=True, random_state=config.SEED)


def run_experiment(encode: Encoder | None = None, path=DATA_FILE, job=None) -> dict:
    """5-кратна крос-валідація: TF-IDF+LR (базовий) проти MiniLM+LR (адаптований)."""
    j = reporter(job)
    encode = encode or default_encoder()
    texts, labels = load_data(path)
    cv = _cv(min(labels.count(c) for c in CLASSES))
    j.log(f"текстів: {len(texts)} · {cv.n_splits}-кратна стратифікована крос-валідація")
    j.set(0.1, "базовий рівень TF-IDF")
    base_pipe = make_pipeline(TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True),
                              LogisticRegression(max_iter=2000))
    base_pred = cross_val_predict(base_pipe, texts, labels, cv=cv)
    j.log("базовий рівень: TF-IDF (1–2-грами) + LogisticRegression — готово")
    j.set(0.35, "ембеддинги MiniLM")
    j.log("ембеддинги MiniLM-L12 (384 виміри, ваги заморожені)…")
    emb = encode(texts)
    j.set(0.8, "логістична регресія")
    clf = LogisticRegression(max_iter=2000, C=4.0)
    pred = cross_val_predict(clf, emb, labels, cv=cv)
    base, adapt = metrics.classification(labels, base_pred, CLASSES), metrics.classification(labels, pred, CLASSES)
    errors = [{"text": t, "true": y, "pred": p} for t, y, p in zip(texts, labels, pred) if y != p]
    clf.fit(emb, labels)
    joblib.dump({"clf": clf, "emb": emb, "texts": texts, "labels": labels}, MODEL_FILE)
    params = {"n_texts": len(texts), "cv_folds": cv.n_splits, "classifier": "LogisticRegression(C=4)"}
    experiment.log_result("m2", params, {"baseline": base, "adapted": adapt})
    res = {"baseline": base, "adapted": adapt, "errors": errors, "params": params}
    experiment.save_extra("m2", res)
    j.ok(f"F1-macro: TF-IDF {base['f1_macro']:.3f} → MiniLM {adapt['f1_macro']:.3f} · хибних: {len(errors)}")
    return res


def predict(text: str, encode: Encoder | None = None) -> dict:
    """Категорія, ймовірності і 3 найближчі навчальні приклади (пояснення рішення)."""
    encode = encode or default_encoder()
    st = cache.joblib_load(MODEL_FILE)
    v = encode([text])
    probs = st["clf"].predict_proba(v)[0]
    order = list(st["clf"].classes_)
    sims = st["emb"] @ v[0]
    nn = np.argsort(-sims)[:3]
    return {
        "label": order[int(probs.argmax())],
        "probs": {c: float(probs[order.index(c)]) for c in CLASSES},
        "neighbors": [{"text": st["texts"][i], "label": st["labels"][i], "sim": float(sims[i])} for i in nn],
    }


if __name__ == "__main__":
    r = run_experiment()
    print("TF-IDF F1", r["baseline"]["f1_macro"], "MiniLM F1", r["adapted"]["f1_macro"])
