"""Центр даних: фото, аудіо, таблиці текстів — перегляд, додавання, видалення, автоматичний збір, дублікати."""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, File, Form, UploadFile

from core import config
from core.data import AUDIO_EXT, IMG_EXT
from server.common import need, start, url

r = APIRouter()


def _img_classes() -> dict[str, str]:
    from modules.m1_vision import CLASSES, LABELS_UA
    return {**{c: LABELS_UA[c] for c in CLASSES}, "demo": "Демо (для показу)"}


def _aud_classes() -> dict[str, str]:
    from modules.m3_audio import CLASSES, LABELS_UA
    return {**{c: LABELS_UA[c] for c in CLASSES}, "demo": "Демо (для показу)"}


def _dir(kind: str, cls: str) -> Path:
    if cls == "demo":
        return config.DEMO / ("images" if kind == "img" else "audio")
    return config.DATA / ("vehicles" if kind == "img" else "audio") / cls


def _files(d: Path, exts) -> list[Path]:
    return sorted(p for p in d.glob("*") if p.suffix.lower() in exts) if d.exists() else []


def _safe_name(name: str) -> str:
    import re
    stem, ext = Path(name).stem, Path(name).suffix.lower()
    return (re.sub(r"[^\w.-]+", "_", stem)[:60] or "file") + ext


# ---------------- фото ----------------
@r.get("/api/data/images")
def images(cls: str = "uav"):
    classes = _img_classes()
    need(cls in classes, "невідомий клас")
    counts = {c: len(_files(_dir("img", c), IMG_EXT)) for c in classes}
    return {"classes": classes, "counts": counts, "cls": cls,
            "files": [{"name": p.name, "url": url(p)} for p in _files(_dir("img", cls), IMG_EXT)]}


@r.post("/api/data/images/upload")
async def images_upload(cls: str = Form(...), files: list[UploadFile] = File(...)):
    need(cls in _img_classes(), "невідомий клас")
    d = _dir("img", cls)
    d.mkdir(parents=True, exist_ok=True)
    names = []
    for f in files:
        if Path(f.filename or "").suffix.lower() in IMG_EXT:
            n = _safe_name(f.filename)
            (d / n).write_bytes(await f.read())
            names.append(n)
    with open(config.DATA / "SOURCES_images.md", "a", encoding="utf-8") as fh:
        fh.write("".join(f"| {cls} | {n} | додано вручну | вказати | — |\n" for n in names))
    return {"added": len(names)}


@r.post("/api/data/{kind}/delete")
def delete_files(kind: str, body: dict):
    need(kind in ("images", "audio"), "невідомий тип")
    k = "img" if kind == "images" else "aud"
    d = _dir(k, body.get("cls", ""))
    n = 0
    for name in body.get("files", []):
        p = (d / Path(name).name)
        if p.exists():
            p.unlink()
            n += 1
    return {"deleted": n}


def _dup_groups() -> list[list[Path]]:
    from modules import m1_vision as m
    paths, _ = m.dataset()
    pairs = m.find_duplicates(paths)
    by = {p.name: p for p in paths}
    parent: dict[str, str] = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for a, b in pairs:
        parent[find(a)] = find(b)
    groups: dict[str, list[Path]] = {}
    for a, b in pairs:
        for n in (a, b):
            groups.setdefault(find(n), [])
            if by[n] not in groups[find(n)]:
                groups[find(n)].append(by[n])
    return [sorted(g, key=lambda p: (str(p.parent), p.name)) for g in groups.values()]


@r.get("/api/data/images/duplicates")
def duplicates():
    from modules.m1_vision import LABELS_UA
    groups = _dup_groups()
    return {"groups": [[{"name": p.name, "cls": p.parent.name, "cls_ua": LABELS_UA.get(p.parent.name, p.parent.name),
                         "url": url(p)} for p in g] for g in groups]}


@r.post("/api/data/images/dedupe")
def dedupe():
    """Видаляє дублікати: у кожній групі майже однакових фото лишає перше, решту видаляє."""
    removed = []
    for g in _dup_groups():
        for p in g[1:]:
            if p.exists():
                p.unlink()
                removed.append(f"{p.parent.name}/{p.name}")
    return {"removed": removed}


@r.post("/api/data/images/collect")
def images_collect(body: dict):
    from scripts.collect_images import collect
    per = max(5, min(80, int(body.get("per_class", 30))))
    return start("data", "Збір фото з Wikimedia Commons", lambda job, p: collect(p, 2, job=job), p=per)


# ---------------- аудіо ----------------
@r.get("/api/data/audio")
def audio(cls: str = "shahed"):
    classes = _aud_classes()
    need(cls in classes, "невідомий клас")
    counts = {c: len(_files(_dir("aud", c), AUDIO_EXT)) for c in classes}
    return {"classes": classes, "counts": counts, "cls": cls,
            "files": [{"name": p.name, "url": url(p)} for p in _files(_dir("aud", cls), AUDIO_EXT)]}


@r.post("/api/data/audio/upload")
async def audio_upload(cls: str = Form(...), files: list[UploadFile] = File(...)):
    need(cls in _aud_classes(), "невідомий клас")
    d = _dir("aud", cls)
    d.mkdir(parents=True, exist_ok=True)
    n = 0
    for f in files:
        if Path(f.filename or "").suffix.lower() in AUDIO_EXT:
            (d / _safe_name(f.filename)).write_bytes(await f.read())
            n += 1
    return {"added": n}


@r.post("/api/data/audio/collect")
def audio_collect(body: dict):
    from scripts.collect_audio import collect
    per = max(5, min(60, int(body.get("per_class", 25))))
    only = body.get("classes") or None
    return start("data", "Збір звуків (Commons, ESC-50)", lambda job, p, only: collect(p, only, job=job), p=per, only=only)


# ---------------- таблиці текстів ----------------
TABLES = {"docs": config.DATA / "docs" / "documents.csv", "messages": config.DATA / "messages" / "messages.csv",
          "quiz": config.DATA / "quiz" / "quiz.jsonl"}


@r.get("/api/data/table/{name}")
def table(name: str):
    need(name in TABLES, "невідома таблиця")
    if name == "quiz":
        rows = [json.loads(x) for x in TABLES[name].read_text(encoding="utf-8").splitlines() if x.strip()]
        return {"rows": [{"type": x.get("type", "mc"), "text": x["text"], "question": x["question"],
                          "options": x["options"], "answer": x["answer"]} for x in rows]}
    import pandas as pd
    df = pd.read_csv(TABLES[name]).fillna("")
    extra = {}
    if name == "docs":
        from modules.m2_docs import CLASSES, LABELS_UA
        extra = {"labels": {c: LABELS_UA[c] for c in CLASSES}}
    return {"rows": df.to_dict("records"), **extra}


@r.post("/api/data/table/{name}")
def table_save(name: str, body: dict):
    need(name in TABLES, "невідома таблиця")
    rows = body.get("rows", [])
    if name == "quiz":
        out = []
        for x in rows:
            opts = [o for o in x.get("options", []) if str(o).strip()]
            if x.get("text") and x.get("question") and x.get("answer") in opts:
                out.append(json.dumps({"type": x.get("type", "mc"), "text": x["text"], "question": x["question"],
                                       "options": opts, "answer": x["answer"]}, ensure_ascii=False))
        TABLES[name].write_text("\n".join(out) + "\n", encoding="utf-8")
        return {"saved": len(out)}
    import pandas as pd
    df = pd.DataFrame(rows)
    df = df[df["text"].astype(str).str.strip() != ""]
    if name == "docs":
        from modules.m2_docs import CLASSES
        df = df[df["label"].isin(CLASSES)]
        low = df["label"].value_counts().reindex(CLASSES, fill_value=0)
        need(low.min() >= 5, "Потрібно щонайменше 5 текстів у кожній категорії (для 5-кратної крос-валідації)")
    df.to_csv(TABLES[name], index=False, encoding="utf-8")
    return {"saved": len(df)}


@r.post("/api/data/docs/import")
async def docs_import(label: str = Form(...), files: list[UploadFile] = File(...)):
    """Імпорт власних (лише навчальних / вигаданих) документів: .txt або .docx — кожен файл = один документ."""
    import io

    import pandas as pd

    from modules.m2_docs import CLASSES
    need(label in CLASSES, "невідома категорія")
    texts = []
    for f in files:
        raw, ext = await f.read(), Path(f.filename or "").suffix.lower()
        if ext == ".docx":
            from docx import Document
            t = " ".join(p.text.strip() for p in Document(io.BytesIO(raw)).paragraphs if p.text.strip())
        elif ext == ".txt":
            t = " ".join(raw.decode("utf-8", "ignore").split())
        else:
            continue
        if t:
            texts.append(t[:2000])
    df = pd.read_csv(TABLES["docs"])
    df = pd.concat([df, pd.DataFrame({"text": texts, "label": label})], ignore_index=True)
    df.to_csv(TABLES["docs"], index=False, encoding="utf-8")
    return {"added": len(texts)}
