"""Пояснення «Чому так вийшло» і порівняння заморожена/розморожена."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from modules import explain  # noqa: E402


def test_plural():
    assert explain.times(1) == "1 раз" and explain.times(3) == "3 рази" and explain.times(11) == "11 разів"


def test_classification_tie_and_confusion():
    names = {"a": "А", "b": "Б", "c": "В"}
    base = {"accuracy": 0.9, "f1_macro": 0.9, "confusion": [[9, 1, 0], [0, 10, 0], [1, 1, 8]], "labels": list(names), "n": 30}
    adapt = {"accuracy": 0.9, "f1_macro": 0.89, "confusion": [[10, 0, 0], [0, 10, 0], [0, 3, 7]], "labels": list(names), "n": 30}
    out = explain.classification({"baseline": base, "adapted": adapt}, names, base_name="Без", adapt_name="З",
                                 hints={("c", "b"): "схожі"})
    text = " ".join(i["md"] for i in out)
    assert "нічия" in text and "«В» → прийнято за «Б»" in text and "схожі" in text and "3 рази" in text


def test_freeze_texts():
    rows = [{"variant": "з", "trainable": 2310, "total": 100, "score": 0.9, "seconds": 1},
            {"variant": "р", "trainable": 50, "total": 100, "score": 0.7, "seconds": 9}]
    assert explain.freeze({"rows": rows})[0]["t"] == "wr"


def test_m6_explain():
    m = {"baseline": {"mean_reward": 20}, "adapted": {"mean_reward": 400},
         "original_env_before": {"mean_reward": 480}, "original_env_after": {"mean_reward": 470}}
    out = explain.m6(m, {"param": "length", "value": 1.5}, [(i, i) for i in range(50)], (0, 500))
    assert any(i["t"] == "ok" for i in out)
