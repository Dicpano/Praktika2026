"""Одноразове завантаження готових моделей у папку models/ (потрібен Інтернет).

Приклад:  python scripts/download_models.py            # усі моделі
          python scripts/download_models.py --only m2 m4 m6
Після цього програма працює без мережі.
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import config  # noqa: E402  (встановлює шляхи кешу)


def m1() -> None:
    from torchvision.models import ResNet18_Weights, resnet18
    resnet18(weights=ResNet18_Weights.IMAGENET1K_V1)
    print("ResNet18 -> models/torch")


def m2() -> None:
    from sentence_transformers import SentenceTransformer
    m = SentenceTransformer(config.MINILM_ID)
    m.save(str(config.MINILM_DIR))
    print("MiniLM ->", config.MINILM_DIR)


def m5() -> None:
    from huggingface_hub import snapshot_download
    snapshot_download(config.QWEN_ID, local_dir=str(config.QWEN_DIR))
    print("Qwen3-0.6B ->", config.QWEN_DIR)


def m6() -> None:
    """Готові агенти PPO з rl-zoo: CartPole і Acrobot. Якщо Hub недоступний — навчаємо резервних локально."""
    from modules import m6_rl
    for env, e in m6_rl.ENVS.items():
        dest = m6_rl.hub_file(env)
        if dest.exists():
            continue
        try:
            from huggingface_sb3 import load_from_hub
            p = load_from_hub(e["repo"], e["file"])
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(p, dest)
            print(f"PPO {e['id']} ->", dest)
        except Exception as ex:  # noqa: BLE001
            print(f"[m6] {e['repo']} недоступний ({ex}) — навчаю резервного агента локально (2–5 хв)")
            from core.jobs import NullJob
            m6_rl.train_local_pretrained(job=NullJob(verbose=True), env=env)


STEPS = {"m1": m1, "m2": m2, "m3": None, "m5": m5, "m6": m6}

if __name__ == "__main__":
    from core import registry
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", default=list(STEPS))
    ap.add_argument("--force", action="store_true", help="завантажити повторно навіть наявні")
    a = ap.parse_args()
    failed = []
    for key in a.only:
        key = "m2" if key == "m4" else key
        if not a.force and registry.model_cached(key):
            print(f"[{key}] уже є — пропускаю")
            continue
        try:
            if key == "m3":  # TensorFlow — в окремому процесі, як і в програмі
                import subprocess
                r = subprocess.run([sys.executable, "-c", "import sys; sys.path.insert(0, '.'); "
                                    "import os; os.environ['TL_TF_WORKER']='1'; "
                                    "from core import config; import tensorflow_hub as hub; hub.load(config.YAMNET_URL); "
                                    "print('YAMNet -> models/tfhub')"], cwd=str(config.ROOT))
                if r.returncode:
                    raise RuntimeError("помилка завантаження YAMNet")
            else:
                STEPS[key]()
        except Exception as e:  # модуль без залежностей не зупиняє інші
            failed.append(key)
            print(f"[{key}] не завантажено: {e}")
    sys.exit(1 if failed else 0)
