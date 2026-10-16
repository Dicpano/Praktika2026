"""Окремий процес для Qwen3-0.6B (модуль 5).

Мовна модель займає ≈ 2,5 ГБ оперативної пам'яті. Якщо пам'яті не вистачить або бібліотека аварійно
завершиться, впаде лише цей дочірній процес — сама програма (сервер) продовжить працювати.
Модель тримається в пам'яті між викликами; LoRA-адаптер підключається до тієї ж копії моделі.
"""
from __future__ import annotations

import faulthandler
import os
import sys
from pathlib import Path

from core import config  # noqa: F401  (змінні середовища: без TensorFlow, кеші моделей)

_state: dict = {}
_log = None


def _crash_log() -> None:
    global _log
    if _log is None:
        config.LOGS.mkdir(parents=True, exist_ok=True)
        _log = open(config.LOGS / "qwen_worker.log", "a", encoding="utf-8")
        faulthandler.enable(_log)


def _ensure(qwen_dir: str, qwen_id: str, lora_dir: str, with_lora: bool):
    _crash_log()
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    if "model" not in _state:
        src = qwen_dir if (Path(qwen_dir) / "config.json").exists() else qwen_id
        dev = "cuda" if torch.cuda.is_available() else "cpu"
        _state["tok"] = AutoTokenizer.from_pretrained(src)
        _state["model"] = AutoModelForCausalLM.from_pretrained(
            src, dtype=torch.float16 if dev == "cuda" else torch.float32, low_cpu_mem_usage=True).to(dev).eval()
        _state["lora"] = False
    if with_lora and not _state["lora"]:
        from peft import PeftModel
        _state["model"] = PeftModel.from_pretrained(_state["model"], lora_dir).eval()
        _state["lora"] = True
    return _state["tok"], _state["model"]


def generate(qwen_dir: str, qwen_id: str, lora_dir: str, with_lora: bool, msgs: list[dict],
             max_new_tokens: int = 200) -> str:
    import contextlib

    import torch
    tok, model = _ensure(qwen_dir, qwen_id, lora_dir, with_lora)
    prompt = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True, enable_thinking=False)
    ids = tok(prompt, return_tensors="pt").to(model.device)
    ids.pop("token_type_ids", None)  # деякі токенізатори додають це поле, а decoder-моделі його не приймають
    # адаптер уже підключено, а потрібна базова модель — тимчасово вимикаємо його (друга копія не потрібна)
    off = model.disable_adapter() if _state["lora"] and not with_lora else contextlib.nullcontext()
    with torch.no_grad(), off:
        out = model.generate(**ids, max_new_tokens=max_new_tokens, do_sample=False, pad_token_id=tok.eos_token_id)
    return tok.decode(out[0, ids["input_ids"].shape[1]:], skip_special_tokens=True).strip()


def ping() -> int:
    return os.getpid()


if __name__ == "__main__":  # ручна перевірка: python -m modules.qwen_worker
    print(generate(str(config.QWEN_DIR), config.QWEN_ID, str(config.QWEN_LORA_DIR), False,
                   [{"role": "user", "content": "Привіт"}], 20), file=sys.stdout)
