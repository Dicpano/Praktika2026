"""Димові тести: кожен модуль проходить увесь конвеєр на мінімальних даних без завантаження великих моделей.

Готові моделі (MiniLM, YAMNet, Qwen) підміняються легкими замінниками з тим самим інтерфейсом,
тож тести перевіряють логіку програми, поділ даних, метрики й журнал, а не якість моделей.
Запуск:  pytest -q
"""
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import config, experiment  # noqa: E402

has = lambda m: importlib.util.find_spec(m) is not None  # noqa: E731


@pytest.fixture(autouse=True)
def tmp_results(tmp_path, monkeypatch):
    monkeypatch.setattr(experiment, "RESULTS_FILE", tmp_path / "results.json")
    monkeypatch.setattr(config, "MODELS", tmp_path)
    monkeypatch.setattr(config, "RESULTS", tmp_path)
    yield tmp_path


def fake_text_encoder():
    """Замінник MiniLM: TF-IDF за символьними n-грамами + SVD, L2-нормалізація."""
    from sklearn.decomposition import TruncatedSVD
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.preprocessing import normalize
    corpus = []
    for f in ["docs/documents.csv", "messages/messages.csv"]:
        import pandas as pd
        corpus += pd.read_csv(config.DATA / f).text.tolist()
    vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5)).fit(corpus)
    svd = TruncatedSVD(48, random_state=0).fit(vec.transform(corpus))
    return lambda texts: normalize(svd.transform(vec.transform(texts))).astype(np.float32)


def test_experiment_log():
    experiment.log_result("mX", {"a": 1}, {"adapted": {"f1_macro": np.float32(0.5)}})
    assert experiment.latest("mX")["metrics"]["adapted"]["f1_macro"] == 0.5


def test_data_files_present():
    from core import data
    docs = data.read_csv(config.DATA / "docs/documents.csv", ["text", "label"])
    assert len(docs) == 156 and docs.label.nunique() == 6
    assert len(data.read_csv(config.DATA / "messages/messages.csv", ["text", "ref_label"])) == 60
    assert len(data.read_jsonl(config.DATA / "quiz/quiz.jsonl")) == 80
    for c in ["helicopter", "airplane", "engine", "chainsaw", "siren", "background"]:
        assert len([p for p in (config.DATA / "audio" / c).iterdir() if p.suffix in (".wav", ".flac")]) >= 13


def test_m2_docs(tmp_path, monkeypatch):
    from modules import m2_docs as m
    monkeypatch.setattr(m, "MODEL_FILE", tmp_path / "m2.joblib")
    enc = fake_text_encoder()
    r = m.run_experiment(encode=enc)
    assert 0 <= r["adapted"]["f1_macro"] <= 1 and r["params"]["cv_folds"] == 5
    p = m.predict("Наказую призначити відповідального за чергування.", encode=enc)
    assert p["label"] in m.CLASSES and len(p["neighbors"]) == 3


def test_m4_cluster(tmp_path, monkeypatch):
    from modules import m4_cluster as m
    monkeypatch.setattr(m, "MODEL_FILE", tmp_path / "m4.joblib")
    enc = fake_text_encoder()
    r = m.run_experiment(6, encode=enc)
    assert len(set(r["labels"])) == 6 and "ari" in r["adapted"]
    assert m.project(r["emb"], "t-SNE", 7).shape == (60, 2)
    assert m.assign("Завтра сильний снігопад", encode=enc)["cluster"] in range(6)
    assert set(r["elbow_k"]) and len(r["names"]) == 6 and all(" · " in n for n in r["names"].values())


class FakeYamNet:
    """Замінник YAMNet: прості спектральні ознаки по фреймах 0,96 с."""
    class_names = ["Engine", "Siren", "Rain"] + [f"c{i}" for i in range(518)]

    def __call__(self, wave):
        n = max(1, len(wave) // 15360)
        frames = np.array_split(wave[: n * 15360] if len(wave) >= 15360 else wave, n)
        emb = np.stack([np.log1p(np.abs(np.fft.rfft(f, 2046))[:1024]) for f in frames]).astype(np.float32)
        scores = np.random.default_rng(0).random((n, 521)).astype(np.float32)
        return scores, emb, np.zeros((n * 96, 64), np.float32)


@pytest.mark.skipif(not (has("soundfile") and has("scipy")), reason="немає soundfile/scipy")
def test_m3_audio(tmp_path, monkeypatch):
    from modules import m3_audio as m
    monkeypatch.setattr(m, "MODEL_FILE", tmp_path / "m3.joblib")
    for f in (next((config.DATA / "audio/background").glob("*.wav")), next((config.DATA / "audio/helicopter").glob("*.flac"))):
        w = m.load_wav(f)
        assert w.dtype == np.float32 and abs(len(w) - 5 * 16000) < 10
    r = m.run_experiment(embedder=FakeYamNet())
    assert "shahed" not in r["classes"] and r["params"]["test_files"] > 20   # класи без записів пропускаються
    demo = next((config.DEMO / "audio").glob("*.*"))
    p = m.predict(demo, embedder=FakeYamNet())
    assert p["label"] in r["classes"] and set(p["probs"]) == set(r["classes"])


def test_m5_logic():
    from modules import m5_llm as m
    train, test = m.load_data()
    assert (len(train), len(test)) == (71, 9) and sum(r["type"] == "tf" for r in test) == 3
    good = m.target(test[0])
    assert m.parse("<think>x</think>" + good)["answer"] == test[0]["answer"]
    assert m.parse("не JSON") is None
    s = m.score([good, "сміття", json.dumps({"question": "q", "options": ["a", "b", "c"], "answer": "d"})])
    assert s["valid_json"] == pytest.approx(2 / 3) and s["key_in_options"] == pytest.approx(1 / 3)
    assert len(m.build_messages("few", "текст", train)) == 1 + 6 + 1
    tf = m.build_messages("few", "текст", train, qtype="tf")
    assert "Правда" in tf[0]["content"] and all(json.loads(x["content"])["options"] == ["Правда", "Неправда"]
                                                  for x in tf[1:-1] if x["role"] == "assistant")
    items = [{"type": "mc", "question": "Що: це?", "options": ["a", "b", "c"], "answer": "b"},
             {"type": "tf", "question": "Твердження", "options": ["Правда", "Неправда"], "answer": "Неправда"}]
    assert "=b" in m.to_gift(items) and "{FALSE}" in m.to_gift(items) and len(m.to_docx(items)) > 5000
    # повний цикл оцінки з фіктивним генератором
    fake = lambda with_lora=False: (lambda msgs: good)  # noqa: E731
    r = m.run_experiment(("zero", "few"), gen_factory=fake)
    assert r["metrics"]["baseline"]["valid_json"] == 1.0


@pytest.mark.skipif(not (has("stable_baselines3") and has("gymnasium")), reason="немає SB3")
def test_m6_rl(tmp_path, monkeypatch):
    from modules import m6_rl as m
    monkeypatch.setattr(m, "EVAL_SEEDS", [1, 2])
    env = m.make_env({"length": 1.0})
    assert env.unwrapped.polemass_length == pytest.approx(0.1)
    assert type(m.make_env({"wind": 0.5, "noise": 0.1})).__name__ == "Noise"
    m.train_local_pretrained(2048)
    r = m.run_experiment("length", 1.0, timesteps=1024)
    assert len(m.scan(m.load_pretrained(fresh=False)[0], "wind", [0.0, 1.0], seeds=[1])) == 2
    assert r["metrics"]["baseline"]["n"] == 2 and m.finetuned_file().exists()
    gif = m.record_side_by_side(m.load_pretrained()[0], m._ppo(str(m.finetuned_file())), {"noise": 0.1},
                                tmp_path / "s.gif", max_frames=20)
    assert gif.stat().st_size > 0
    m.train_local_pretrained(2048, env="acrobot")
    ra = m.run_experiment("LINK_MASS_2", 2.5, timesteps=512, env="acrobot")
    assert ra["metrics"]["adapted"]["mean_reward"] <= 0 and m.norm(-250, "acrobot") == pytest.approx(0.5)


@pytest.mark.skipif(not (has("torch") and has("torchvision")), reason="немає PyTorch")
def test_m1_vision(tmp_path, monkeypatch):
    from PIL import Image

    from modules import m1_vision as m
    rng = np.random.default_rng(0)
    paths, labels = [], []
    for i, c in enumerate(m.CLASSES):
        for j in range(3):
            arr = np.full((64, 64, 3), 40 * i, np.uint8) + rng.integers(0, 30, (64, 64, 3), dtype=np.uint8)
            p = tmp_path / f"{c}_{j}.png"
            Image.fromarray(arr).save(p)
            paths.append(p)
            labels.append(c)
    keep = [i for i, lb in enumerate(labels) if lb in m.CLASSES[:3]]
    paths, labels = [paths[i] for i in keep], [labels[i] for i in keep]
    model, hist = m.train(paths, labels, epochs=1, batch=4, pretrained=False, classes=m.CLASSES[:3])
    met, probs = m.evaluate(model, paths, labels)
    assert probs.shape == (9, 3) and len(hist) == 1 and model.classes == m.CLASSES[:3]
    assert m.active_classes(labels) == ([], m.CLASSES)       # по 3 фото — менше мінімуму
    cam, cls = m.gradcam(model, m.load_image(paths[0]))
    assert cam.shape == (224, 224) and cls in range(3)
    assert len(m.find_duplicates(paths[:2])) >= 0


def test_jobs_progress_and_cancel():
    import time

    from core.jobs import Cancelled, JobManager
    mgr = JobManager(workers=1)

    def work(job, n):
        for i in range(n):
            job.set((i + 1) / n, f"{i + 1}/{n}")
            job.log(f"крок {i}")
            time.sleep(0.01)
        return n * 2
    j = mgr.submit("mX", "тест", work, n=5)
    for _ in range(300):
        if not j.active:
            break
        time.sleep(0.01)
    assert j.status == "done" and j.result == 10 and j.progress == 1.0
    assert mgr.submit("mX", "тест 2", work, n=1) is not None

    def slow(job):
        while True:
            job.set(0.5)
            time.sleep(0.01)
    k = mgr.submit("mY", "довга", slow)
    time.sleep(0.05)
    assert mgr.submit("mY", "дубль", slow) is k          # одна активна задача на модуль
    k.cancel()
    for _ in range(300):
        if not k.active:
            break
        time.sleep(0.01)
    assert k.status == "cancelled"

    def bad(job):
        raise ValueError("зламалось")
    e = mgr.submit("mZ", "помилка", bad)
    for _ in range(300):
        if not e.active:
            break
        time.sleep(0.01)
    assert e.status == "error" and "зламалось" in e.error
    assert issubclass(Cancelled, Exception)


def test_settings_roundtrip(tmp_path, monkeypatch):
    from core import settings
    monkeypatch.setattr(settings, "FILE", tmp_path / "s.json")
    monkeypatch.setattr(settings, "_cache", None)
    assert settings.get("bg_mode") == "matrix"
    settings.set("bg_mode", "radar")
    monkeypatch.setattr(settings, "_cache", None)
    assert settings.get("bg_mode") == "radar"


def test_theory_complete():
    from modules.theory import THEORY
    for k in ["m1", "m2", "m3", "m4", "m5", "m6"]:
        titles = [t for t, _ in THEORY[k]]
        assert "Ідея" in titles and "Чому так" in titles and len(titles) >= 4


@pytest.mark.skipif(not has("pptx"), reason="немає python-pptx")
def test_slides_build():
    from core import slides
    entry = {"time": "2026-10-15T10:00:00", "seed": 42, "params": {"k": 3},
             "metrics": {"baseline": {"accuracy": 0.6, "f1_macro": 0.55, "confusion": [[3, 1, 0], [1, 3, 0], [0, 0, 4]],
                                      "labels": ["info", "analytic", "org"]},
                         "adapted": {"accuracy": 0.8, "f1_macro": 0.79, "confusion": [[4, 0, 0], [1, 3, 0], [0, 0, 4]],
                                     "labels": ["info", "analytic", "org"]}}}
    data = slides.build("m2", entry, None, "помилка", "обмеження", "висновок", "https://github.com/x/y")
    from pptx import Presentation
    import io
    assert len(Presentation(io.BytesIO(data)).slides) == 2
    for k, e in [("m6", {"time": "t", "seed": 42, "params": {}, "metrics": {
            kk: {"mean_reward": 100.0, "std_reward": 5.0} for kk in
            ["baseline", "adapted", "original_env_before", "original_env_after"]}})]:
        assert slides.build(k, e, None, "", "", "", "") 


def test_no_tensorflow_in_main_process():
    """TF не має потрапляти в основний процес (конфлікт із PyTorch); SB3 працює без TensorBoard."""
    if not has("stable_baselines3"):
        pytest.skip("немає SB3")
    import gymnasium as gym
    from stable_baselines3 import PPO
    PPO("MlpPolicy", gym.make("CartPole-v1"), n_steps=64, batch_size=32, verbose=0)
    assert "tensorflow" not in sys.modules


@pytest.mark.skipif(not has("tensorflow"), reason="немає TensorFlow")
def test_tensorflow_worker_process():
    """TensorFlow працює в окремому процесі одночасно з PyTorch в основному."""
    import torch  # noqa: F401
    from modules import m3_audio, yamnet_worker
    v = m3_audio.worker_pool().submit(yamnet_worker.tf_version).result(timeout=300)
    assert v.startswith("2.") and "tensorflow" not in sys.modules


def test_glossary():
    from modules.glossary import TERMS
    assert len(TERMS) >= 60
    names = {t["term"] for t in TERMS}
    assert {"KMeans", "Ембеддинг", "LoRA", "PPO", "Softmax", "F1-macro", "Grad-CAM"} <= names
    assert all(t["short"] and t["long"] and t["modules"] for t in TERMS)


def test_api_smoke():
    """Сервер FastAPI: головна сторінка, стан, словник, теорія, дані модулів, таблиці."""
    from fastapi.testclient import TestClient

    from server.main import app
    c = TestClient(app)   # без lifespan: прогрів бібліотек не запускається
    assert "app.js" in c.get("/").text and "tl-lab-3" in c.get("/health").text
    st = c.get("/api/status").json()
    assert set(st["modules"]) == {"m1", "m2", "m3", "m4", "m5", "m6"}
    assert len(c.get("/api/glossary").json()) >= 60
    assert "Ідея" in [x["title"] for x in c.get("/api/theory/m4").json()]
    assert len(c.get("/api/m2/data").json()["classes"]) == 6
    assert len(c.get("/api/m4/data").json()["texts"]) == 60
    assert len(c.get("/api/data/table/quiz").json()["rows"]) == 80
    assert c.get("/files/../server/main.py").status_code == 404     # за межі даних не виходимо
    assert c.get("/static/js/app.js").status_code == 200
