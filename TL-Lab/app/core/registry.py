"""Картки моделей (ЗФ-1) і перевірка готовності модулів."""
from __future__ import annotations

import importlib.util
from dataclasses import dataclass, field

from core import config


@dataclass
class ModelCard:
    key: str
    title: str
    model: str
    source: str
    license: str
    params: str
    pretrained_on: str
    adapted: str
    baseline: str
    deps: list[str] = field(default_factory=list)
    needs_gpu: bool = False


CARDS: dict[str, ModelCard] = {
    "m1": ModelCard(
        "m1", "1. Класифікатор техніки й позицій на фото", "ResNet18 (torchvision, IMAGENET1K_V1)",
        "https://pytorch.org/vision/stable/models/generated/torchvision.models.resnet18.html",
        "BSD-3-Clause", "11,7 млн", "ImageNet-1k (1,28 млн фото, 1000 класів)",
        "Замінено фінальний шар fc 512→6 (БПЛА / бронетехніка / артилерія / вантажівка / замасковані позиції / "
        "немає цілі); основа заморожена, опційно розморожується layer4",
        "Той самий класифікатор без аугментації; випадкове вгадування ≈ 17 %",
        ["torch", "torchvision", "PIL"]),
    "m2": ModelCard(
        "m2", "2. Інтелектуальне сортування документів", "paraphrase-multilingual-MiniLM-L12-v2",
        "https://huggingface.co/" + config.MINILM_ID, "Apache-2.0", "118 млн",
        "Парафрази 50+ мов, зокрема українська",
        "Ваги MiniLM заморожені; поверх ембеддингів (384) навчено LogisticRegression на 6 типів документів",
        "TF-IDF + LogisticRegression", ["sentence_transformers", "sklearn"]),
    "m3": ModelCard(
        "m3", "3. Розпізнавання звуків: Шахеди, авіація, техніка", "YAMNet (TensorFlow Hub)",
        config.YAMNET_URL, "Apache-2.0", "3,7 млн", "AudioSet (2 млн записів, 521 клас)",
        "Ембеддинги YAMNet (1024 на фрейм) → середнє + максимум по файлу; навчено LogisticRegression на 8 класів",
        "Zero-shot YAMNet: найближчі класи AudioSet (Propeller, Jet engine, Helicopter, Siren…)", ["tensorflow", "tensorflow_hub", "soundfile", "scipy"]),
    "m4": ModelCard(
        "m4", "4. Кластеризація інформаційних повідомлень", "paraphrase-multilingual-MiniLM-L12-v2 + KMeans",
        "https://huggingface.co/" + config.MINILM_ID, "Apache-2.0", "118 млн",
        "Парафрази 50+ мов", "Ваги не змінюються: готові ембеддинги + KMeans (k = 6, вибір методами silhouette і «ліктя»)",
        "KMeans на TF-IDF", ["sentence_transformers", "sklearn"]),
    "m5": ModelCard(
        "m5", "5. Міні-LLM для створення навчальних тестів", "Qwen3-0.6B",
        "https://huggingface.co/" + config.QWEN_ID, "Apache-2.0", "0,6 млрд",
        "Загальний корпус текстів, багатомовна",
        "LoRA-адаптер (r = 8, q_proj/v_proj) на ~70 прикладах (3 варіанти і «правда/неправда»); без донавчання — few-shot і RAG",
        "Zero-shot тієї ж моделі", ["transformers", "torch"], needs_gpu=True),
    "m6": ModelCard(
        "m6", "6. Донавчання RL-агента у зміненому середовищі", "PPO для CartPole-v1 і Acrobot-v1 (Stable-Baselines3, rl-zoo)",
        "https://huggingface.co/" + config.SB3_REPO, "MIT", "≈ 9 тис.", "CartPole-v1 зі стандартними параметрами",
        "Змінено фізику, додано вітер або шум датчиків; навчання PPO продовжено в нових умовах",
        "Готовий агент у зміненому середовищі", ["stable_baselines3", "gymnasium", "imageio"]),
}


def missing_deps(key: str) -> list[str]:
    return [d for d in CARDS[key].deps if importlib.util.find_spec(d) is None]


def gpu_available() -> bool | None:
    """True/False, або None, якщо PyTorch ще не завантажено (не блокуємо сторінку імпортом)."""
    import sys
    if "torch" in sys.modules:
        return bool(sys.modules["torch"].cuda.is_available())
    if importlib.util.find_spec("torch") is None:
        return False
    from core import warmup
    return warmup.STATE.get("gpu")


def model_cached(key: str) -> bool:
    if key == "m1":
        return any((config.MODELS / "torch").rglob("resnet18*.pth"))
    if key in ("m2", "m4"):
        return (config.MINILM_DIR / "config.json").exists()
    if key == "m3":
        return (config.MODELS / "tfhub").exists() and any((config.MODELS / "tfhub").iterdir())
    if key == "m5":
        return (config.QWEN_DIR / "config.json").exists()
    if key == "m6":
        m = config.MODELS
        return all((m / "sb3" / f"ppo-{n}-v1.zip").exists() or (m / f"m6_ppo_{e}_local.zip").exists()
                   for e, n in (("cartpole", "CartPole"), ("acrobot", "Acrobot")))
    return False
