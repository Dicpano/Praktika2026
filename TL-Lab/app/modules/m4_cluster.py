"""Модуль 4. Кластеризація повідомлень: готові ембеддинги MiniLM + KMeans (ФВ-4.1…4.6).
Ваги мережі не змінюються — це використання готових ознак, а не донавчання."""
from __future__ import annotations

import re
from typing import Callable

import joblib
import numpy as np
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.manifold import TSNE
from sklearn.metrics import silhouette_score

from core import cache, config, data, experiment, metrics
from core.jobs import reporter

DATA_FILE = config.DATA / "messages" / "messages.csv"
MODEL_FILE = config.MODELS / "m4_kmeans.joblib"
TOKEN = r"(?u)\b[^\W\d_]{2,}(?:['’ʼ][^\W\d_]+)*"  # зберігає апостроф: зв'язок
STOP = set("і й та в у на з із до для по під про що це як не а але від за о об при їх його її є був буде вже також чи".split())

Encoder = Callable[[list[str]], np.ndarray]


def default_encoder() -> Encoder:
    from modules.text_encoder import encode
    return encode


def load_data(path=DATA_FILE):
    df = data.read_csv(path, ["text"])
    ref = df["ref_label"].tolist() if "ref_label" in df.columns else None
    return df.text.tolist(), ref


def kmeans(x: np.ndarray, k: int) -> KMeans:
    return KMeans(n_clusters=k, n_init=10, random_state=config.SEED).fit(x)


def silhouette_curve(x: np.ndarray, ks=range(2, 10)) -> dict[int, float]:
    return {k: float(silhouette_score(x, kmeans(x, k).labels_, metric="cosine")) for k in ks if k < len(x)}


def elbow_curve(x: np.ndarray, ks=range(1, 10)) -> dict[int, float]:
    """Метод «ліктя»: сума квадратів відстаней до центрів (inertia); злам кривої підказує k."""
    return {k: float(kmeans(x, k).inertia_) for k in ks if k < len(x)}


def cluster_names(keywords_: dict[int, list[str]]) -> dict[int, str]:
    """Автоматична назва кластера з трьох найвагоміших слів (c-TF-IDF) — без підглядання в приховані теми."""
    return {c: " · ".join(kw[:3]) for c, kw in keywords_.items()}


def cluster_topics(labels: list[int], ref: list[str] | None) -> dict[int, str]:
    """Для оцінки: яка прихована тема переважає в кожному кластері (у самій кластеризації не використовується)."""
    if not ref:
        return {}
    out = {}
    for c in sorted(set(labels)):
        topics = [r for r, l in zip(ref, labels) if l == c and isinstance(r, str)]
        if topics:
            top = max(set(topics), key=topics.count)
            out[c] = f"{top} ({topics.count(top)}/{len(topics)})"
    return out


def keywords(texts: list[str], labels, top=5) -> dict[int, list[str]]:
    """c-TF-IDF: тексти кластера об'єднуються в один документ, беруться найвагоміші слова."""
    groups = sorted(set(labels))
    docs = [" ".join(t for t, l in zip(texts, labels) if l == g) for g in groups]
    vec = TfidfVectorizer(token_pattern=TOKEN, stop_words=list(STOP), lowercase=True)
    m = vec.fit_transform(docs).toarray()
    terms = vec.get_feature_names_out()
    return {g: [terms[i] for i in np.argsort(-m[n])[:top]] for n, g in enumerate(groups)}


def project(x: np.ndarray, method="PCA", perplexity=7) -> np.ndarray:
    if method == "t-SNE":
        return TSNE(n_components=2, perplexity=min(perplexity, len(x) - 1), random_state=config.SEED,
                    init="pca", metric="cosine").fit_transform(x)
    return PCA(n_components=2, random_state=config.SEED).fit_transform(x)


def run_experiment(k=6, encode: Encoder | None = None, path=DATA_FILE, job=None) -> dict:
    j = reporter(job)
    encode = encode or default_encoder()
    texts, ref = load_data(path)
    j.set(0.1, "ембеддинги MiniLM")
    j.log(f"повідомлень: {len(texts)} · ембеддинги MiniLM (ваги не змінюються), L2-нормалізація")
    emb = encode(texts)
    j.set(0.5, "KMeans")
    km = kmeans(emb, k)
    tfidf = TfidfVectorizer(token_pattern=TOKEN).fit_transform(texts).toarray()
    base_km = kmeans(tfidf, k)
    base = metrics.clustering(tfidf, base_km.labels_, ref)
    adapt = metrics.clustering(emb, km.labels_, ref)
    labels = km.labels_.tolist()
    center_idx = {c: int(np.argmax(emb[np.array(labels) == c] @ km.cluster_centers_[c]))
                  for c in range(k)}
    representative = {c: [t for t, l in zip(texts, labels) if l == c][i] for c, i in center_idx.items()}
    pca = PCA(n_components=2, random_state=config.SEED).fit(emb)
    joblib.dump({"km": km, "pca": pca}, MODEL_FILE)
    params = {"k": k, "n_texts": len(texts)}
    experiment.log_result("m4", params, {"baseline": base, "adapted": adapt},
                          notes="baseline = KMeans на TF-IDF; ARI/NMI — порівняння з прихованими еталонними темами")
    j.set(0.8, "вибір k: silhouette і метод «ліктя»")
    kw = keywords(texts, labels)
    res = {"baseline": base, "adapted": adapt, "emb": emb, "texts": texts, "labels": labels, "ref": ref,
           "silhouette_k": silhouette_curve(emb), "elbow_k": elbow_curve(emb), "keywords": kw,
           "names": cluster_names(kw), "topics": cluster_topics(labels, ref), "representative": representative, "params": params}
    experiment.save_extra("m4", res)
    j.log("silhouette для k=2…6: " + ", ".join(f"{a}:{b:.2f}" for a, b in res["silhouette_k"].items()))
    j.ok(f"k={k} · silhouette {adapt['silhouette']:.3f}" + (f" · ARI {adapt['ari']:.3f}" if "ari" in adapt else ""))
    return res


def assign(text: str, encode: Encoder | None = None) -> dict:
    encode = encode or default_encoder()
    st = cache.joblib_load(MODEL_FILE)
    v = encode([text])
    d = st["km"].transform(v)[0]
    return {"cluster": int(d.argmin()), "dist": d.tolist(), "xy": st["pca"].transform(v)[0].tolist()}


def short(t: str, n=70) -> str:
    return t if len(t) <= n else re.sub(r"\s+\S*$", "", t[:n]) + "…"


if __name__ == "__main__":
    r = run_experiment()
    print("TF-IDF", r["baseline"], "MiniLM", r["adapted"])
    print(r["keywords"])
