"""Прогрів: важкі бібліотеки імпортуються у фоновому потоці одразу після старту сервера.

Перше відкриття модуля зазвичай гальмує через імпорт PyTorch / TensorFlow (на Windows це 3–10 с).
Після прогріву модулі вже в пам'яті, і сторінки відкриваються миттєво.
"""
from __future__ import annotations

import importlib
import importlib.util
import threading
import time

STATUS: dict[str, str] = {}       # бібліотека -> "ok" | "немає" | "помилка"
STATE = {"started": False, "done": False, "seconds": 0.0, "gpu": None}
ORDER = ["numpy", "pandas", "sklearn", "plotly", "PIL", "torch", "torchvision", "sentence_transformers",
         "stable_baselines3", "gymnasium", "transformers", "peft", "soundfile", "scipy.signal"]
# TensorFlow сюди не входить: він працює в окремому процесі модуля 3 (див. modules/yamnet_worker.py)
_lock = threading.Lock()


def _run() -> None:
    t0 = time.time()
    for name in ORDER:
        root = name.split(".")[0]
        if importlib.util.find_spec(root) is None:
            STATUS[name] = "немає"
            continue
        try:
            importlib.import_module(name)
            STATUS[name] = "ok"
            if name == "torch":
                import torch
                STATE["gpu"] = bool(torch.cuda.is_available())
        except Exception:
            STATUS[name] = "помилка"
    # кодувальник MiniLM використовується трьома модулями — тримаємо його в пам'яті
    try:
        from core import registry
        if registry.model_cached("m2") and STATUS.get("sentence_transformers") == "ok":
            from modules import text_encoder
            text_encoder._model()
            STATUS["MiniLM (модель)"] = "ok"
    except Exception:
        STATUS["MiniLM (модель)"] = "помилка"
    try:  # окремий процес YAMNet піднімається заздалегідь, щоб модуль 3 відповідав швидше
        from core import registry
        if registry.model_cached("m3") and not registry.missing_deps("m3"):
            from modules import m3_audio
            m3_audio.default_embedder()
            STATUS["YAMNet (окремий процес)"] = "ok"
    except Exception:
        STATUS["YAMNet (окремий процес)"] = "помилка"
    STATE["seconds"] = time.time() - t0
    STATE["done"] = True


def start() -> None:
    with _lock:
        if STATE["started"]:
            return
        STATE["started"] = True
    threading.Thread(target=_run, name="tl-warmup", daemon=True).start()
