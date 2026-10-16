"""Спільний кодувальник MiniLM для вкладок 2, 4 і RAG у вкладці 5 (одна модель у пам'яті)."""
from __future__ import annotations

import hashlib
from functools import lru_cache

import numpy as np

from core import config

CACHE = config.MODELS / "cache"
CACHE.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def _model():
    from sentence_transformers import SentenceTransformer
    src = str(config.MINILM_DIR) if (config.MINILM_DIR / "config.json").exists() else config.MINILM_ID
    return SentenceTransformer(src, device="cpu")


def encode(texts: list[str]) -> np.ndarray:
    """L2-нормалізовані ембеддинги 384; кеш на диску за хешем текстів."""
    key = hashlib.sha1("\n".join(texts).encode("utf-8")).hexdigest()[:16]
    f = CACHE / f"minilm_{key}.npy"
    if f.exists():
        return np.load(f)
    emb = _model().encode(texts, batch_size=32, normalize_embeddings=True, show_progress_bar=False)
    emb = np.asarray(emb, dtype=np.float32)
    np.save(f, emb)
    return emb
