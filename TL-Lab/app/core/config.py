"""Шляхи, ідентифікатори моделей і кеші. Імпортується першим у будь-якому модулі."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
DEMO = DATA / "demo"
MODELS = ROOT / "models"
RESULTS = ROOT / "results"
FIGS = RESULTS / "figs"
LOGS = ROOT / "logs"
for _p in (MODELS, RESULTS, FIGS, LOGS):
    _p.mkdir(parents=True, exist_ok=True)

SEED = 42

# Усі кеші моделей — усередині проєкту, щоб після download_models.py працювати офлайн
os.environ.setdefault("TORCH_HOME", str(MODELS / "torch"))
os.environ.setdefault("HF_HOME", str(MODELS / "hf"))
os.environ.setdefault("TFHUB_CACHE_DIR", str(MODELS / "tfhub"))
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
# Потоки OpenMP не «крутяться» в очікуванні: інакше при зайнятому процесорі (браузер, інша задача)
# навчання сповільнюється в десятки разів (виміряно: PPO 227 с проти 24 с на 4000 кроків)
os.environ.setdefault("OMP_WAIT_POLICY", "PASSIVE")
os.environ.setdefault("KMP_BLOCKTIME", "0")
# TensorFlow і PyTorch в одному процесі конфліктують (аварійне завершення). Тому TensorFlow (YAMNet, модуль 3)
# працює в окремому процесі (modules/yamnet_worker.py), а тут забороняємо непрямий імпорт TF:
os.environ.setdefault("USE_TF", "0")               # transformers / sentence-transformers — лише PyTorch
os.environ.setdefault("USE_TORCH", "1")
os.environ.setdefault("TRANSFORMERS_NO_TF", "1")
if os.environ.get("TL_TF_WORKER") != "1":
    import sys as _sys
    # stable-baselines3 → torch.utils.tensorboard → tensorboard → tensorflow; TensorBoard програмі не потрібен
    _sys.modules.setdefault("tensorboard", None)

# Ідентифікатори готових моделей
MINILM_ID = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
MINILM_DIR = MODELS / "minilm"
YAMNET_URL = "https://tfhub.dev/google/yamnet/1"
QWEN_ID = "Qwen/Qwen3-0.6B"
QWEN_DIR = MODELS / "qwen3-0.6b"
QWEN_LORA_DIR = MODELS / "qwen3-lora"
SB3_REPO = "sb3/ppo-CartPole-v1"
SB3_FILE = "ppo-CartPole-v1.zip"
SB3_LOCAL = MODELS / "sb3" / SB3_FILE
