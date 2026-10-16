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


def _head_from_lr(emb, y, n_cls):
    """Стартові ваги лінійної «голови» = логістична регресія на заморожених ембеддингах (LP-FT)."""
    import torch
    lr = LogisticRegression(max_iter=2000, C=4.0).fit(emb, y)
    w, b = np.zeros((n_cls, emb.shape[1]), np.float32), np.full(n_cls, -10.0, np.float32)
    for k, c in enumerate(lr.classes_):
        w[CLASSES.index(c)], b[CLASSES.index(c)] = lr.coef_[k], lr.intercept_[k]   # у наборі завжди всі 6 класів
    head = torch.nn.Linear(emb.shape[1], n_cls)
    with torch.no_grad():
        head.weight.copy_(torch.from_numpy(w))
        head.bias.copy_(torch.from_numpy(b))
    return head


def unfreeze(st, layers: int) -> tuple[int, int]:
    """Заморозити всю MiniLM, розморозити останні `layers` шарів трансформера. -> (навчуваних, усього)."""
    auto = st[0].auto_model
    for prm in st.parameters():
        prm.requires_grad = False
    blocks = auto.encoder.layer
    for blk in blocks[len(blocks) - layers:]:
        for prm in blk.parameters():
            prm.requires_grad = True
    total = sum(p.numel() for p in st.parameters())
    return sum(p.numel() for p in st.parameters() if p.requires_grad), total


def finetune_cv(texts, labels, emb, cv, layers=2, epochs=4, lr=3e-5, batch=16, job=None, lo=0.8, hi=0.97):
    """Крос-валідація для розмороженої MiniLM: ті самі фолди, що й для замороженої (чесне порівняння)."""
    import copy

    import torch
    import torch.nn.functional as F

    from modules.text_encoder import _model
    j = reporter(job)
    torch.manual_seed(config.SEED)
    base = _model()
    n_layers = len(base[0].auto_model.encoder.layer)
    layers = max(1, min(layers, n_layers))
    y_all = np.array([CLASSES.index(c) for c in labels])
    preds = np.empty(len(texts), dtype=object)
    folds = list(cv.split(texts, labels))
    steps_total, step = len(folds) * epochs, 0
    trainable = total = 0
    for fi, (tr, te) in enumerate(folds):
        st = copy.deepcopy(base)
        trainable, total = unfreeze(st, layers)
        head = _head_from_lr(emb[tr], [labels[i] for i in tr], len(CLASSES))
        opt = torch.optim.AdamW([{"params": [p for p in st.parameters() if p.requires_grad], "lr": lr},
                                 {"params": head.parameters(), "lr": 1e-3}], weight_decay=0.01)
        rng = np.random.default_rng(config.SEED + fi)
        for ep in range(epochs):
            st.train()
            order, losses = rng.permutation(tr), []
            for b0 in range(0, len(order), batch):
                idx = order[b0:b0 + batch]
                feats = st.tokenize([texts[i] for i in idx])
                v = F.normalize(st(feats)["sentence_embedding"], dim=-1)
                loss = F.cross_entropy(head(v), torch.from_numpy(y_all[idx]))
                opt.zero_grad()
                loss.backward()
                opt.step()
                losses.append(loss.item())
                j.check()
            step += 1
            j.set(lo + (hi - lo) * step / steps_total, f"розморожена MiniLM: фолд {fi + 1}/{len(folds)}, епоха {ep + 1}/{epochs}")
        st.eval()
        with torch.no_grad():
            for b0 in range(0, len(te), 32):
                idx = te[b0:b0 + 32]
                v = F.normalize(st(st.tokenize([texts[i] for i in idx]))["sentence_embedding"], dim=-1)
                for i, k in zip(idx, head(v).argmax(-1).tolist()):
                    preds[i] = CLASSES[k]
        j.log(f"фолд {fi + 1}/{len(folds)}: втрати останньої епохи {np.mean(losses):.3f}")
        del st, opt
    return preds.tolist(), {"layers": layers, "of_layers": n_layers, "trainable": int(trainable + len(CLASSES) * (emb.shape[1] + 1)),
                            "total": int(total)}


def run_experiment(encode: Encoder | None = None, path=DATA_FILE, job=None, unfreeze_layers: int = 0,
                   epochs: int = 4, lr: float = 3e-5) -> dict:
    """5-кратна крос-валідація: TF-IDF+LR (базовий) проти MiniLM+LR (адаптований).

    unfreeze_layers > 0 — додатково: розморожені останні шари MiniLM (на тих самих фолдах).
    """
    import time
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
    t0 = time.time()
    emb = encode(texts)
    j.set(0.75 if unfreeze_layers else 0.8, "логістична регресія")
    clf = LogisticRegression(max_iter=2000, C=4.0)
    pred = cross_val_predict(clf, emb, labels, cv=cv)
    frozen_s = time.time() - t0
    base, adapt = metrics.classification(labels, base_pred, CLASSES), metrics.classification(labels, pred, CLASSES)
    errors = [{"text": t, "true": y, "pred": p} for t, y, p in zip(texts, labels, pred) if y != p]
    mets = {"baseline": base, "adapted": adapt}
    freeze = None
    if unfreeze_layers:
        j.log(f"розморожування: останні {unfreeze_layers} шар(и) MiniLM + лінійна голова · епох {epochs} · lr {lr:g}")
        j.log("старт голови — з логістичної регресії (LP-FT), тож розморожена модель починає з рівня замороженої")
        t0 = time.time()
        ft_pred, info = finetune_cv(texts, labels, emb, cv, unfreeze_layers, epochs, lr, job=job)
        mets["finetuned"] = metrics.classification(labels, ft_pred, CLASSES)
        freeze = {"metric": "f1_macro", "rows": [
            {"variant": "Заморожена MiniLM + LR", "trainable": len(CLASSES) * (emb.shape[1] + 1), "total": info["total"],
             "score": adapt["f1_macro"], "accuracy": adapt["accuracy"], "seconds": round(frozen_s, 1)},
            {"variant": f"Розморожено {info['layers']} з {info['of_layers']} шарів", "trainable": info["trainable"],
             "total": info["total"], "score": mets["finetuned"]["f1_macro"], "accuracy": mets["finetuned"]["accuracy"],
             "seconds": round(time.time() - t0, 1)}]}
        j.log(f"F1-macro: заморожена {adapt['f1_macro']:.3f} → розморожена {mets['finetuned']['f1_macro']:.3f}",
              "ok" if mets["finetuned"]["f1_macro"] >= adapt["f1_macro"] else "wr")
    clf.fit(emb, labels)
    joblib.dump({"clf": clf, "emb": emb, "texts": texts, "labels": labels}, MODEL_FILE)
    params = {"n_texts": len(texts), "cv_folds": cv.n_splits, "classifier": "LogisticRegression(C=4)"}
    if unfreeze_layers:
        params.update(unfreeze_layers=unfreeze_layers, ft_epochs=epochs, ft_lr=lr)
    experiment.log_result("m2", params, mets)
    res = {"baseline": base, "adapted": adapt, "errors": errors, "params": params, "freeze": freeze}
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
