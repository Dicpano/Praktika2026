"""Самоперевірка після установки: бібліотеки, моделі, дані кожного модуля."""
from __future__ import annotations

import importlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from core import config, data, registry  # noqa: E402

ok = True
print(f"Python {sys.version.split()[0]} · {config.ROOT}")
for key, card in registry.CARDS.items():
    miss = [d for d in card.deps if d not in ("tensorflow", "tensorflow_hub")]
    errs = []
    for d in miss:
        try:
            importlib.import_module(d)
        except Exception as e:
            errs.append(f"{d}: {e.__class__.__name__}")
    if key == "m3":  # TensorFlow перевіряємо в окремому процесі, як і в програмі
        r = subprocess.run([sys.executable, "-c", "import tensorflow, tensorflow_hub; print(tensorflow.__version__)"],
                           capture_output=True, text=True)
        if r.returncode:
            errs.append("tensorflow: не імпортується")
    model = registry.model_cached(key) or key == "m6"
    status = "OK" if not errs and model else ("БРАКУЄ МОДЕЛІ" if not errs else "ПОМИЛКА")
    ok &= status == "OK"
    print(f"  {key.upper()}  {status:<14} {card.title}" + (f"  ({'; '.join(errs)})" if errs else ""))
try:
    import fastapi  # noqa: F401
    import uvicorn  # noqa: F401
    from server import main  # noqa: F401
    print("  Сервер інтерфейсу (FastAPI): OK")
except Exception as e:  # noqa: BLE001
    ok = False
    print(f"  Сервер інтерфейсу: ПОМИЛКА ({e})")
from modules.m1_vision import CLASSES as IMG, MIN_PER_CLASS  # noqa: E402
n = {c: len(data.folder_dataset(config.DATA / "vehicles", [c], data.IMG_EXT)[0]) for c in IMG}
print(f"  Фото модуля 1: {n}" + ("" if min(n.values()) >= MIN_PER_CLASS else "  — частину класів доповніть у «Центрі даних»"))
AUD = ["shahed", "jet_shahed", "helicopter", "airplane", "engine", "chainsaw", "siren", "background"]
a = {c: len(data.folder_dataset(config.DATA / "audio", [c], data.AUDIO_EXT)[0]) for c in AUD}
print(f"  Звуки модуля 3: {a}" + ("" if min(a.values()) >= 4 else "  — класи з < 4 записами не навчаються (мало даних)"))
print("Самоперевірка: " + ("УСЕ ГОТОВО" if ok else "є зауваження (див. вище)"))
