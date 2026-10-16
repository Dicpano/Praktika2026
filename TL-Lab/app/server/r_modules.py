"""Маршрути шести модулів: дані, запуск адаптації (фонова задача), результати, демонстрація."""
from __future__ import annotations

import io
import json
from functools import lru_cache
from pathlib import Path

import numpy as np
from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import Response

from core import config, data, experiment, settings
from modules import explain
from server.common import card, clean, job_result, latest, need, png_b64, start, url

r = APIRouter()
IMG_EXT = data.IMG_EXT


def _counts(paths_labels, classes, labels_ua):
    _, labels = paths_labels
    return [{"key": c, "label": labels_ua[c], "count": labels.count(c)} for c in classes]


# ======================================================================= M1
@r.get("/api/m1/data")
def m1_data():
    from modules import m1_vision as m  # імпорт torch відбувається тут, а не при відкритті сторінки
    paths, labels = m.dataset()
    cls = []
    for c in m.CLASSES:
        ps = [p for p, lb in zip(paths, labels) if lb == c]
        cls.append({"key": c, "label": m.LABELS_UA.get(c, c), "count": len(ps), "samples": [url(p) for p in ps[:4]]})
    return {"card": card("m1"), "classes": cls, "min": m.MIN_PER_CLASS, "total": len(paths)}


@r.post("/api/m1/train")
def m1_train(body: dict):
    from modules import m1_vision as m
    return start("m1", "Адаптація ResNet18", lambda job, **kw: m.run_experiment(job=job, **kw),
                 epochs=int(body.get("epochs", 10)), lr=float(body.get("lr", 1e-3)), unfreeze=bool(body.get("unfreeze")))


@lru_cache(maxsize=96)
def _m1_cam(path: str, weights_mtime: float, raw: bytes | None = None) -> dict:
    from PIL import Image

    from modules import m1_vision as m
    img = Image.open(io.BytesIO(raw)).convert("RGB") if raw else m.load_image(path)
    model = m.load()
    pr = m.predict_proba(model, [img])[0]
    cam, _ = m.gradcam(model, img)
    thumb = img.copy()
    thumb.thumbnail((360, 360))
    return {"image": png_b64(thumb), "cam": png_b64(m.overlay(img, cam)),
            "probs": {c: float(p) for c, p in zip(model.classes, pr)},
            "labels": {c: m.LABELS_UA.get(c, c) for c in model.classes}}


def _m1_verdict(res: dict) -> dict:
    top = max(res["probs"], key=res["probs"].get)
    thr = float(settings.get("uncertain"))
    return {**res, "top": top, "conf": res["probs"][top], "threshold": thr,
            "verdict": "Невизначено" if res["probs"][top] < thr else res["labels"][top]}


def _wm() -> float:
    from modules import m1_vision as m
    return m.WEIGHTS_FILE.stat().st_mtime if m.WEIGHTS_FILE.exists() else 0.0


@r.get("/api/m1/eval")
def m1_eval():
    from modules import m1_vision as m
    e, res = latest("m1"), experiment.load_extra("m1")
    errors = []
    if res and m.WEIGHTS_FILE.exists():
        for err in res.get("errors", [])[:8]:
            if Path(err["file"]).exists():
                errors.append({**err, "true_ua": m.LABELS_UA.get(err["true"], err["true"]), "pred_ua": m.LABELS_UA.get(err["pred"], err["pred"]),
                               "url": url(err["file"])})
    why = (explain.m1(e["metrics"], m.LABELS_UA, e.get("params")) + explain.m1_loss((res or {}).get("loss"))) if e else []
    return clean({"entry": e, "loss": (res or {}).get("loss"), "errors": errors, "why": why,
                  "labels": {c: m.LABELS_UA.get(c, c) for c in (res or {}).get("classes", m.CLASSES)}})


@r.get("/api/m1/cam")
def m1_cam(file: str):
    from modules import m1_vision as m
    need(m.WEIGHTS_FILE.exists(), "Спершу виконайте адаптацію")
    p = (config.ROOT / file).resolve() if not Path(file).is_absolute() else Path(file)
    need(p.exists(), "файл не знайдено")
    return _m1_verdict(_m1_cam(str(p), _wm()))


@r.get("/api/m1/demo")
def m1_demo():
    d = config.DEMO / "images"
    files = sorted(p for p in d.glob("*") if p.suffix.lower() in IMG_EXT) if d.exists() else []
    return [{"name": p.name, "file": str(p.relative_to(config.ROOT)), "url": url(p)} for p in files]


@r.post("/api/m1/predict")
async def m1_predict(file: UploadFile = File(...)):
    from modules import m1_vision as m
    need(m.WEIGHTS_FILE.exists(), "Спершу виконайте адаптацію")
    raw = await file.read()
    return _m1_verdict(_m1_cam(file.filename or "upload", _wm(), raw))


# ======================================================================= M2
@r.get("/api/m2/data")
def m2_data():
    from modules import m2_docs as m
    try:
        texts, labels = m.load_data()
        err = None
    except ValueError as e:
        texts, labels, err = [], [], str(e)
    return {"card": card("m2"), "error": err,
            "classes": [{"key": c, "label": m.LABELS_UA.get(c, c), "about": m.DESCRIPTIONS[c], "count": labels.count(c)}
                        for c in m.CLASSES],
            "texts": [{"text": t, "label": m.LABELS_UA.get(lb, lb)} for t, lb in zip(texts, labels)]}


@r.post("/api/m2/train")
def m2_train(body: dict | None = None):
    from modules import m2_docs as m
    b = body or {}
    kw = {"unfreeze_layers": int(b.get("unfreeze_layers") or 0), "epochs": int(b.get("epochs") or 4),
          "lr": float(b.get("lr") or 3e-5)}
    title = "MiniLM + LogisticRegression" + (" + розморожування" if kw["unfreeze_layers"] else "")
    return start("m2", title, lambda job, **k: m.run_experiment(job=job, **k), **kw)


@r.get("/api/m2/eval")
def m2_eval():
    from modules import m2_docs as m
    res = experiment.load_extra("m2") or {}
    e = latest("m2")
    why = explain.m2(e["metrics"], m.LABELS_UA, res.get("freeze")) if e else []
    return clean({"entry": e, "short": m.LABELS_SHORT, "labels": m.LABELS_UA, "freeze": res.get("freeze"), "why": why,
                  "errors": [{"text": e["text"], "true": m.LABELS_UA.get(e["true"], e["true"]),
                              "pred": m.LABELS_UA.get(e["pred"], e["pred"]),
                              "why": explain._hint(explain.M2_HINTS, e["true"], e["pred"]) or
                              "у тексті мало характерних ознак свого типу або є слова, типові для іншого"} for e in res.get("errors", [])]})


@r.get("/api/m2/demo")
def m2_demo():
    import pandas as pd

    from modules import m2_docs as m
    df = pd.read_csv(config.DEMO / "documents_demo.csv")
    return [{"text": t, "label": m.LABELS_UA.get(lb, lb)} for t, lb in zip(df.text, df.label)]


@r.post("/api/m2/predict")
def m2_predict(body: dict):
    from modules import m2_docs as m
    need(m.MODEL_FILE.exists(), "Спершу виконайте адаптацію")
    text = (body.get("text") or "").strip()
    need(bool(text), "порожній текст")
    res = m.predict(text)
    return clean({**res, "label_ua": m.LABELS_UA.get(res["label"], res["label"]), "labels": m.LABELS_UA,
                  "neighbors": [{**n, "label": m.LABELS_UA.get(n["label"], n["label"])} for n in res["neighbors"]]})


# ======================================================================= M3
@r.get("/api/m3/data")
def m3_data():
    from modules import m3_audio as m
    paths, labels = data.folder_dataset(m.DATA_DIR, m.CLASSES, data.AUDIO_EXT)
    cls = []
    for c in m.CLASSES:
        ps = [p for p, lb in zip(paths, labels) if lb == c]
        cls.append({"key": c, "label": m.LABELS_UA.get(c, c), "count": len(ps), "sample": url(ps[0]) if ps else None,
                    "low": len(ps) < m.LOW_DATA, "skip": len(ps) < m.MIN_PER_CLASS})
    return {"card": card("m3"), "classes": cls, "mapping": m.ZERO_SHOT_MAP, "low": m.LOW_DATA, "min": m.MIN_PER_CLASS}


@r.post("/api/m3/train")
def m3_train(body: dict):
    from modules import m3_audio as m
    mapping = body.get("mapping") or m.ZERO_SHOT_MAP
    kw = {"unfreeze_layers": int(body.get("unfreeze_layers") or 0), "epochs": int(body.get("epochs") or 4),
          "lr": float(body.get("lr") or 1e-4)}
    title = "YAMNet + LogisticRegression" + (" + розморожування" if kw["unfreeze_layers"] else "")
    return start("m3", title, lambda job, mapping, **k: m.run_experiment(mapping=mapping, job=job, **k),
                 mapping=mapping, **kw)


@r.get("/api/m3/eval")
def m3_eval():
    from modules import m3_audio as m
    res = experiment.load_extra("m3") or {}
    errs = [{"url": url(e["file"]), "name": Path(e["file"]).name, "true": m.LABELS_UA.get(e["true"], e["true"]),
             "pred": m.LABELS_UA.get(e["pred"], e["pred"]), "zero_shot": m.LABELS_UA.get(e["zero_shot"], e["zero_shot"]),
             "why": (explain._hint(explain.M3_HINTS, e["true"], e["pred"]) or
                     "схожий тембр або сторонній шум у записі — послухайте, що в ньому чути найголосніше")
             if e["true"] != e["pred"] else
             "zero-shot помилився, адаптована модель — ні"}
            for e in res.get("errors", []) if Path(e["file"]).exists()]
    e = latest("m3")
    low = res.get("params", {}).get("low_data", [])
    why = explain.m3(e["metrics"], m.LABELS_UA, low, res.get("freeze")) if e else []
    return clean({"entry": e, "labels": m.LABELS_UA, "errors": errs, "low": low, "freeze": res.get("freeze"), "why": why})


@r.get("/api/m3/demo")
def m3_demo():
    d = config.DEMO / "audio"
    files = sorted(p for p in d.glob("*") if p.suffix.lower() in data.AUDIO_EXT) if d.exists() else []
    return [{"name": p.name, "file": str(p.relative_to(config.ROOT)), "url": url(p)} for p in files]


def _m3_out(res: dict) -> dict:
    from modules import m3_audio as m
    wave = np.asarray(res["wave"])
    step = max(1, len(wave) // 1500)
    spec = np.asarray(res["spec"])
    spec = spec[:: max(1, len(spec) // 160)]
    zs = res["zero_shot"]
    return clean({"label": res["label"], "label_ua": m.LABELS_UA.get(res["label"], res["label"]), "probs": res["probs"],
                  "zero_shot": zs, "zs_label": m.LABELS_UA.get(max(zs, key=zs.get), max(zs, key=zs.get)) if zs else "—",
                  "labels": m.LABELS_UA, "top": res["top_audioset"], "wave": wave[::step].round(4),
                  "spec": spec.T.round(2)})


@r.post("/api/m3/predict")
async def m3_predict(file: UploadFile | None = File(None), demo: str = Form("")):
    from modules import m3_audio as m
    need(m.MODEL_FILE.exists(), "Спершу виконайте адаптацію")
    if file is not None:
        tmp = config.MODELS / "cache" / ("upload_" + Path(file.filename or "a.wav").name)
        tmp.write_bytes(await file.read())
        p = tmp
    else:
        p = (config.ROOT / demo).resolve()
        need(p.exists(), "файл не знайдено")
    return _m3_out(m.predict(str(p)))


# ======================================================================= M4
@r.get("/api/m4/data")
def m4_data():
    from modules import m4_cluster as m
    texts, ref = m.load_data()
    return {"card": card("m4"), "texts": texts, "topics": sorted(set(x for x in (ref or []) if isinstance(x, str)))}


@r.post("/api/m4/run")
def m4_run(body: dict):
    from modules import m4_cluster as m
    k = int(body.get("k", 6))
    return start("m4", f"KMeans, k={k}", lambda job, k: m.run_experiment(k, job=job), k=k)


@lru_cache(maxsize=8)
def _m4_proj(run_time: str, method: str, perp: int):
    from modules import m4_cluster as m
    res = experiment.load_extra("m4")
    return m.project(res["emb"], method, perp)


@r.get("/api/m4/result")
def m4_result(method: str = "PCA", perp: int = 7):
    from modules import m4_cluster as m
    res, e = experiment.load_extra("m4"), experiment.latest("m4")
    if not res or not e:
        return {"entry": None}
    xy = _m4_proj(e["time"], method, perp)
    k = res["params"]["k"]
    names = res.get("names") or {c: ", ".join(res["keywords"][c][:3]) for c in range(k)}
    clusters = [{"id": c, "name": names[c], "keywords": res["keywords"][c], "topic": res.get("topics", {}).get(c),
                 "representative": res["representative"][c],
                 "items": [t for t, lb in zip(res["texts"], res["labels"]) if lb == c]} for c in range(k)]
    cross = None
    if res.get("ref"):
        import pandas as pd
        ct = pd.crosstab(pd.Series([f"К{lb + 1}" for lb in res["labels"]], name="кластер"), pd.Series(res["ref"], name="тема"))
        cross = {"index": ct.index.tolist(), "columns": ct.columns.tolist(), "values": ct.values.tolist()}
    return clean({"entry": latest("m4"), "k": k, "points": [{"x": float(a), "y": float(b), "c": int(lb), "t": m.short(t)}
                  for (a, b), lb, t in zip(xy, res["labels"], res["texts"])], "clusters": clusters,
                  "silhouette": res["silhouette_k"], "elbow": res.get("elbow_k"), "cross": cross, "why": explain.m4(res)})


@r.get("/api/m4/demo")
def m4_demo():
    import pandas as pd
    return pd.read_csv(config.DEMO / "messages_demo.csv").text.tolist()


@r.post("/api/m4/assign")
def m4_assign(body: dict):
    from core import cache
    from modules import m4_cluster as m
    res = experiment.load_extra("m4")
    need(m.MODEL_FILE.exists() and res is not None, "Спершу виконайте кластеризацію")
    text = (body.get("text") or "").strip()
    need(bool(text), "порожній текст")
    a = m.assign(text)
    xy = cache.joblib_load(m.MODEL_FILE)["pca"].transform(res["emb"])
    names = res.get("names") or {}
    return clean({**a, "name": names.get(a["cluster"], ""), "keywords": res["keywords"][a["cluster"]],
                  "points": [{"x": float(x), "y": float(y), "c": int(lb), "t": m.short(t)}
                             for (x, y), lb, t in zip(xy, res["labels"], res["texts"])], "names": names})


# ======================================================================= M5
@r.get("/api/m5/data")
def m5_data():
    from modules import m5_llm as m
    train, test = m.load_data()
    return {"card": card("m5"), "train": len(train), "test": len(test), "example": train[0] if train else None,
            "lora": m.lora_available(), "modes": m.MODES, "qtypes": m.QTYPES,
            "by_type": {q: sum(1 for r_ in train + test if r_.get("type", "mc") == q) for q in m.QTYPES}}


@r.post("/api/m5/eval_run")
def m5_eval_run(body: dict):
    from modules import m5_llm as m
    modes = [x for x in body.get("modes", ["zero", "few", "rag"]) if x in m.MODES]
    need(bool(modes), "оберіть режими")
    return start("m5", "Оцінка режимів Qwen3", lambda job, modes: m.run_experiment(tuple(modes), job=job), modes=modes)


@r.post("/api/m5/lora")
def m5_lora(body: dict):
    from modules import m5_llm as m
    r_ = int(body.get("r", 8))
    return start("m5", "LoRA-донавчання", lambda job, **kw: m.train_lora(job=job, **kw),
                 epochs=int(body.get("epochs", 3)), lr=float(body.get("lr", 2e-4)), r=r_, alpha=r_ * 2)


@r.get("/api/m5/eval")
def m5_eval():
    from modules import m5_llm as m
    res = experiment.load_extra("m5") or {}
    rows = []
    for i, t in enumerate(res.get("test", [])):
        rows.append({"text": t["text"], "type": t.get("type", "mc"),
                     "outputs": {md: {"raw": outs[i], "parsed": m.parse(outs[i])} for md, outs in res.get("outputs", {}).items()}})
    e = latest("m5")
    why = explain.m5((e["metrics"] or {}).get("by_mode") or {}, m.MODES) if e else []
    return clean({"entry": e, "modes": m.MODES, "rows": rows, "why": why})


@r.get("/api/m5/demo")
def m5_demo_texts():
    return json.loads((config.DEMO / "quiz_demo.json").read_text(encoding="utf-8"))


@r.post("/api/m5/demo")
def m5_demo(body: dict):
    from modules import m5_llm as m
    text, qtype = (body.get("text") or "").strip(), body.get("qtype", "mc")
    need(bool(text), "порожній текст")
    third = "lora" if m.lora_available() else "rag"
    return start("m5", "Демонстрація генерації", lambda job, text, qtype: m.demo(text, ("zero", "few", third), qtype, job=job),
                 text=text, qtype=qtype)


@r.post("/api/m5/test")
def m5_test(body: dict):
    from modules import m5_llm as m
    texts = [t.strip() for t in body.get("texts", []) if t and t.strip()]
    need(bool(texts), "додайте хоча б один текст")
    mode = body.get("mode", "lora" if m.lora_available() else "rag")
    return start("m5", f"Створення тесту ({len(texts)} запит.)",
                 lambda job, **kw: m.make_test(job=job, **kw), texts=texts[:30], mode=mode, qtype=body.get("qtype", "mc"))


@r.get("/api/m5/job")
def m5_job():
    """Результат останньої демонстрації або створення тесту (з розібраними відповідями)."""
    from modules import m5_llm as m
    res = job_result("m5")
    if res and res.get("demo"):
        return clean({"demo": {**res, "parsed": {k: m.parse(v) for k, v in res["outputs"].items()}, "modes": m.MODES}})
    if res and "test_items" in res:
        return clean({"test": res})
    return {}


@r.post("/api/m5/export/{fmt}")
def m5_export(fmt: str, body: dict):
    from modules import m5_llm as m
    items = body.get("items", [])
    need(bool(items), "немає запитань")
    title = body.get("title") or "Тест Transfer Learning-лабораторії"
    if fmt == "gift":
        return Response(m.to_gift(items, title).encode("utf-8"), media_type="text/plain",
                        headers={"Content-Disposition": 'attachment; filename="test_moodle.gift.txt"'})
    return Response(m.to_docx(items, title),
                    media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    headers={"Content-Disposition": 'attachment; filename="test.docx"'})


# ======================================================================= M6
@r.get("/api/m6/info")
def m6_info(env: str = "cartpole"):
    from modules import m6_rl as m
    try:
        _, source = m.load_pretrained(fresh=False, env=env)
    except FileNotFoundError:
        source = None
    e = m.ENVS[env]
    return {"card": card("m6"), "envs": {k: {"title": v["title"], "about": v["about"]} for k, v in m.ENVS.items()},
            "env": env, "agent": source, "defaults": e["defaults"], "labels": e["labels"], "suggest": e["suggest"],
            "range": e["range"], "steps": settings.get("rl_steps"), "finetuned": m.finetuned_file(env).exists()}


@r.post("/api/m6/backup")
def m6_backup(body: dict):
    from modules import m6_rl as m
    env = body.get("env", "cartpole")
    return start("m6", "Резервний агент PPO", lambda job, env: m.train_local_pretrained(job=job, env=env), env=env)


@r.post("/api/m6/scan")
def m6_scan(body: dict):
    from modules import m6_rl as m
    env, p = body.get("env", "cartpole"), body["param"]
    d = m.ENVS[env]["defaults"][p]
    hi = m.ENVS[env]["suggest"][p] * 2
    vals = [float(v) for v in np.round(np.linspace(d if d else 0.0, hi, 8), 3)]

    def fn(job, env, p, vals):
        return {"scan": m.scan(m.load_pretrained(fresh=False, env=env)[0], p, vals, job=job, env=env),
                "param": p, "env": env, "label": m.ENVS[env]["labels"][p], "range": m.ENVS[env]["range"]}
    return start("m6", f"Пошук параметра {p}", fn, env=env, p=p, vals=vals)


@r.post("/api/m6/train")
def m6_train(body: dict):
    from modules import m6_rl as m
    return start("m6", "Донавчання PPO", lambda job, **kw: m.run_experiment(job=job, **kw),
                 env=body.get("env", "cartpole"), param=body["param"], value=float(body["value"]),
                 timesteps=int(body.get("timesteps", 50_000)), compare_frozen=bool(body.get("compare_frozen")))


@r.get("/api/m6/eval")
def m6_eval():
    res = experiment.load_extra("m6") or {}
    curve = res.get("curve") or []
    from modules import m6_rl as m
    e, p = latest("m6"), res.get("params") or {}
    env = p.get("env", "cartpole")
    why = explain.m6(e["metrics"], p, curve, m.ENVS[env]["range"], m.ENVS[env]["labels"],
                     (e["metrics"] or {}).get("frozen")) if e else []
    return clean({"entry": e, "curve": curve[-3000:], "params": p, "why": why, "freeze": res.get("freeze")})


@r.get("/api/m6/scan")
def m6_scan_result():
    return clean(job_result("m6", "scan") or {})


@r.post("/api/m6/record")
def m6_record(body: dict):
    from modules import m6_rl as m
    env, cfg = body.get("env", "cartpole"), {body["param"]: float(body["value"])}
    need(m.finetuned_file(env).exists(), "Спершу виконайте донавчання в цьому середовищі")

    def rec(job, env, cfg):
        job.set(0.1, "запис епізодів до і після")
        out = config.FIGS / f"m6_{env}_side.gif"
        m.record_side_by_side(m.load_pretrained(env=env)[0], m._ppo(str(m.finetuned_file(env))), cfg, out, env=env)
        job.ok("відео збережено")
        return {"video": str(out)}
    return start("m6", "Запис відео до / після", rec, env=env, cfg=cfg)


@r.get("/api/m6/video")
def m6_video(env: str = "cartpole"):
    f = config.FIGS / f"m6_{env}_side.gif"
    return {"url": url(f) if f.exists() else None}
