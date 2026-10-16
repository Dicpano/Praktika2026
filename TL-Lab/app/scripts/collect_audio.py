"""Збір відкритих аудіозаписів для модуля 3 (потрібен Інтернет).

* Шахед (поршневий) і реактивний Шахед — пошук аудіо й відео на Wikimedia Commons (вільні ліцензії),
  зі звукової доріжки вирізаються 5-секундні фрагменти зі сталим гулом (вибухи й постріли відкидаються).
* Інші класи — докачування з відкритого набору ESC-50 (GitHub), кожен запис з окремого вихідного звуку.

Автори, ліцензії та посилання дописуються в data/SOURCES_audio.md. Записи обов'язково прослухати вручну
(«Центр даних → Аудіо») і видалити невідповідні. Записів реактивного Шахеда у відкритому доступі дуже мало.
"""
from __future__ import annotations

import argparse
import io
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.collect_images import ALLOWED, API, HEADERS, _Print, check_online, strip_html  # noqa: E402

AUDIO = ROOT / "data" / "audio"
SR, CLIP = 16000, 5.0
COMMONS = {
    "shahed": ["Shahed-136", "Shahed 136 drone", "Geran-2 drone", "Shahed drone attack", "Шахед дрон",
               "Shahed drone sound", "Shahed kamikaze drone"],
    "jet_shahed": ["Shahed-238", "Geran-3", "jet-powered Shahed", "Shahed 238 jet drone"],
}
ESC = {  # клас програми -> категорії ESC-50
    "helicopter": ["helicopter"], "airplane": ["airplane"], "chainsaw": ["chainsaw"], "engine": ["engine"],
    "siren": ["siren"], "background": ["rain", "wind", "thunderstorm", "train", "fireworks", "car_horn"],
}
ESC_RAW = "https://raw.githubusercontent.com/karolpiczak/ESC-50/master"


def ffmpeg() -> str:
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


def decode(path: Path) -> np.ndarray:
    """Будь-яке аудіо чи відео -> 16 кГц моно float32."""
    r = subprocess.run([ffmpeg(), "-loglevel", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(SR),
                        "-f", "f32le", "-"], capture_output=True, timeout=600)
    if r.returncode:
        raise RuntimeError(r.stderr.decode("utf-8", "ignore")[:200])
    return np.frombuffer(r.stdout, dtype=np.float32)


def steady_clips(wave: np.ndarray, k: int = 6) -> list[np.ndarray]:
    """Фрагменти по 5 с зі сталим звуком: висока гучність і низький пік-фактор (вибухи мають різкі піки)."""
    n, hop = int(SR * CLIP), int(SR * CLIP / 2)
    cands = []
    for s in range(0, max(1, len(wave) - n + 1), hop):
        w = wave[s:s + n]
        if len(w) < n:
            break
        rms = float(np.sqrt(np.mean(w ** 2)) + 1e-9)
        crest = float(np.abs(w).max() / rms)
        if rms > 0.01 and crest < 8:
            cands.append((rms / crest, s))
    cands.sort(reverse=True)
    out, taken = [], []
    for _, s in cands:
        if all(abs(s - t) >= n for t in taken):
            taken.append(s)
            out.append(wave[s:s + n])
        if len(out) >= k:
            break
    return out


def search_media(query: str, limit: int = 40) -> list[dict]:
    out = []
    for kind in ("audio", "video"):
        params = {"action": "query", "format": "json", "generator": "search", "gsrnamespace": 6,
                  "gsrsearch": f"{query} filetype:{kind}", "gsrlimit": limit,
                  "prop": "imageinfo", "iiprop": "url|extmetadata|mime|size"}
        r = requests.get(API, params=params, headers=HEADERS, timeout=30)
        r.raise_for_status()
        for p in r.json().get("query", {}).get("pages", {}).values():
            ii = (p.get("imageinfo") or [{}])[0]
            meta = ii.get("extmetadata", {})
            lic = meta.get("LicenseShortName", {}).get("value", "")
            if not ALLOWED.search(lic) or ii.get("size", 0) > 150_000_000:
                continue
            out.append({"title": p["title"], "url": ii.get("url"), "page": ii.get("descriptionurl", ""),
                        "author": strip_html(meta.get("Artist", {}).get("value", "невідомо"))[:120], "license": lic})
    return out


def _sources() -> Path:
    f = ROOT / "data" / "SOURCES_audio.md"
    if not f.exists():
        f.write_text("# Джерела аудіо, зібраних автоматично\n\n| Клас | Файл | Автор | Ліцензія | Джерело |\n"
                     "| --- | --- | --- | --- | --- |\n", encoding="utf-8")
    return f


def count(cls: str) -> int:
    d = AUDIO / cls
    return sum(1 for p in d.glob("*") if p.suffix.lower() in {".wav", ".flac", ".ogg", ".mp3"}) if d.exists() else 0


def collect_commons(cls: str, target: int, j) -> int:
    import soundfile as sf
    src = _sources()
    known = src.read_text(encoding="utf-8")
    d = AUDIO / cls
    d.mkdir(parents=True, exist_ok=True)
    need = max(0, target - count(cls))
    if not need:
        j.log(f"{cls}: уже {count(cls)} записів — пропускаю")
        return 0
    items, seen = [], set()
    for q in COMMONS[cls]:
        try:
            for it in search_media(q):
                if it["title"] not in seen and it["title"] not in known:
                    seen.add(it["title"])
                    items.append(it)
        except requests.RequestException as e:
            j.warn(f"пошук «{q}»: {e}")
        time.sleep(1)
    j.log(f"{cls}: знайдено файлів на Commons: {len(items)}")
    n, rows = 0, []
    for it in items:
        if n >= need:
            break
        try:
            with tempfile.TemporaryDirectory() as tmp:
                f = Path(tmp) / ("src" + Path(it["url"]).suffix)
                r = requests.get(it["url"], headers=HEADERS, timeout=300)
                r.raise_for_status()
                f.write_bytes(r.content)
                clips = steady_clips(decode(f), k=min(6, need - n))
        except Exception as e:  # noqa: BLE001 — один поганий файл не зупиняє збір
            j.warn(f"пропущено {it['title']}: {e}")
            continue
        stem = re.sub(r"[^\w-]+", "_", Path(it["title"]).stem)[:40]
        for i, c in enumerate(clips):
            name = f"commons_{stem}_{i}.flac"
            sf.write(d / name, c, SR)
            rows.append(f"| {cls} | {name} | {it['author']} | {it['license']} | {it['page']} |")
            n += 1
        j.set(None, f"{cls}: {n}/{need}")
        j.log(f"{it['title']}: фрагментів {len(clips)}")
        time.sleep(0.5)
    with open(src, "a", encoding="utf-8") as fh:
        fh.write("\n".join(rows) + ("\n" if rows else ""))
    if count(cls) < 10:
        j.warn(f"{cls}: лише {count(cls)} записів — клас буде позначено «мало даних». "
               "Можна додати власні відкриті записи в «Центрі даних».")
    else:
        j.ok(f"{cls}: усього {count(cls)} записів")
    return n


def collect_esc(cls: str, target: int, j) -> int:
    import pandas as pd
    import soundfile as sf
    d = AUDIO / cls
    d.mkdir(parents=True, exist_ok=True)
    need = max(0, target - count(cls))
    if not need:
        j.log(f"{cls}: уже {count(cls)} записів — пропускаю")
        return 0
    meta = pd.read_csv(io.StringIO(requests.get(f"{ESC_RAW}/meta/esc50.csv", headers=HEADERS, timeout=60).text))
    have = {int(p.name.split("-")[1]) for p in (ROOT / "data").rglob("*-*-*-*.*") if p.name.count("-") >= 3
            and p.name.split("-")[1].isdigit()}
    sub = meta[meta.category.isin(ESC[cls]) & ~meta.src_file.isin(have)].drop_duplicates("src_file")
    rows, n = [], 0
    for r in sub.itertuples():
        if n >= need:
            break
        try:
            raw = requests.get(f"{ESC_RAW}/audio/{r.filename}", headers=HEADERS, timeout=60)
            raw.raise_for_status()
            wav, sr = sf.read(io.BytesIO(raw.content), dtype="float32", always_2d=True)
            from math import gcd

            from scipy.signal import resample_poly
            g = gcd(SR, sr)
            wav = resample_poly(wav.mean(1), SR // g, sr // g).astype(np.float32)
            name = r.filename.replace(".wav", ".flac")
            sf.write(d / name, wav, SR)
        except Exception as e:  # noqa: BLE001
            j.warn(f"пропущено {r.filename}: {e}")
            continue
        rows.append(f"| {cls} | {name} | ESC-50 / Freesound {r.src_file} | CC BY-NC 3.0 | {ESC_RAW}/audio/{r.filename} |")
        n += 1
        j.set(None, f"{cls}: {n}/{need}")
    with open(_sources(), "a", encoding="utf-8") as fh:
        fh.write("\n".join(rows) + ("\n" if rows else ""))
    j.ok(f"{cls}: додано {n}, усього {count(cls)}")
    return n


def collect(per_class: int = 25, classes: list[str] | None = None, job=None) -> dict[str, int]:
    j = job or _Print()
    classes = classes or list(COMMONS) + list(ESC)
    if any(c in COMMONS for c in classes):
        try:
            check_online()
        except RuntimeError as e:
            j.warn(str(e) + " — записи Шахедів пропущено")
            classes = [c for c in classes if c not in COMMONS]
    out = {}
    for i, cls in enumerate(classes):
        j.set(i / len(classes), cls)
        try:
            out[cls] = (collect_commons if cls in COMMONS else collect_esc)(cls, per_class, j)
        except requests.RequestException as e:
            j.warn(f"{cls}: немає зв'язку ({e})")
            out[cls] = 0
    j.log("Прослухайте нові записи в «Центрі даних → Аудіо» і видаліть невідповідні.")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-class", type=int, default=25)
    ap.add_argument("--only", nargs="*")
    a = ap.parse_args()
    collect(a.per_class, a.only)
