"""Збір відкритих фото для модуля 1 з Wikimedia Commons (потрібен Інтернет).

Викликається інсталятором і кнопкою в «Центрі даних». Для кожного класу шукає файли за кількома
запитами, завантажує мініатюри 640 px і дописує автора та ліцензію в data/SOURCES_images.md.
Після збору фото обов'язково переглядають вручну.
"""
from __future__ import annotations

import argparse
import html
import re
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
API = "https://commons.wikimedia.org/w/api.php"
HEADERS = {"User-Agent": "TL-Lab-educational/2.0 (NUOU coursework; https://github.com/Dicpano/Praktika2026)"}

QUERIES = {
    "uav": ["unmanned aerial vehicle", "quadcopter drone flying", "military UAV drone", "fixed-wing drone"],
    "armor": ["main battle tank", "armoured personnel carrier", "infantry fighting vehicle", "armored vehicle military"],
    "artillery": ["howitzer firing", "self-propelled howitzer", "towed howitzer", "field artillery gun",
                  "multiple rocket launcher", "artillery exercise"],
    "truck": ["military cargo truck", "army truck", "heavy truck lorry", "6x6 truck"],
    "camo": ["camouflage net military", "camouflage netting vehicle", "camouflaged position exercise",
             "military camouflage field", "camouflaged tank exercise", "camouflaged command post"],
    "none": ["forest landscape", "agricultural field landscape", "meadow summer", "empty country road",
             "winter field landscape", "steppe landscape"],
}
# Класи, що збираються з навчань і пейзажів: фото обов'язково переглядати вручну
REVIEW = {"camo": "замасковані позиції — лише навчання/музеї; знімки реальних позицій видаляйте",
          "none": "немає цілі — на фото не має бути техніки чи людей"}
ALLOWED = re.compile(r"(CC0|CC BY|CC-BY|Public domain|PD|Attribution)", re.I)
BANNED = re.compile(r"(toy|model kit|diagram|drawing|logo|scale model|lego|map|scheme|insignia|patch)", re.I)
IMG = {".jpg", ".jpeg", ".png", ".webp"}


class _Print:
    def log(self, t, level=""):
        print(t)

    ok = warn = log

    def set(self, progress=None, message=None):
        pass


def strip_html(s: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


def search(query: str, limit: int = 50) -> list[dict]:
    params = {"action": "query", "format": "json", "generator": "search", "gsrnamespace": 6,
              "gsrsearch": f"{query} filetype:bitmap", "gsrlimit": limit,
              "prop": "imageinfo", "iiprop": "url|extmetadata|mime", "iiurlwidth": 640}
    r = requests.get(API, params=params, headers=HEADERS, timeout=30)
    r.raise_for_status()
    out = []
    for p in r.json().get("query", {}).get("pages", {}).values():
        ii = (p.get("imageinfo") or [{}])[0]
        meta = ii.get("extmetadata", {})
        lic = meta.get("LicenseShortName", {}).get("value", "")
        if ii.get("mime") not in ("image/jpeg", "image/png") or not ALLOWED.search(lic) or BANNED.search(p.get("title", "")):
            continue
        out.append({"title": p["title"], "thumb": ii.get("thumburl") or ii.get("url"), "page": ii.get("descriptionurl", ""),
                    "author": strip_html(meta.get("Artist", {}).get("value", "невідомо"))[:120], "license": lic})
    return out


def check_online(url: str = API) -> None:
    """Швидка перевірка зв'язку, щоб не чекати тайм-аутів на кожному запиті."""
    try:
        requests.get(url, params={"action": "query", "format": "json", "meta": "siteinfo"}, headers=HEADERS, timeout=12)
    except requests.RequestException as e:
        raise RuntimeError("Немає зв'язку з Wikimedia Commons — перевірте Інтернет і спробуйте ще раз "
                           f"({type(e).__name__})") from None


def count(cls: str) -> int:
    d = ROOT / "data" / "vehicles" / cls
    return sum(1 for p in d.glob("*") if p.suffix.lower() in IMG) if d.exists() else 0


def collect(per_class: int = 30, demo: int = 2, job=None) -> dict[str, int]:
    """Докачує фото, доки в кожному класі не буде per_class (наявні не чіпає). Повертає кількість нових."""
    j = job or _Print()
    check_online()
    src = ROOT / "data" / "SOURCES_images.md"
    if not src.exists():
        src.write_text("# Джерела зображень (Wikimedia Commons)\n\n| Клас | Файл | Автор | Ліцензія | Сторінка |\n"
                       "| --- | --- | --- | --- | --- |\n", encoding="utf-8")
    known = src.read_text(encoding="utf-8")
    added: dict[str, int] = {}
    demo_dir = ROOT / "data" / "demo" / "images"
    demo_dir.mkdir(parents=True, exist_ok=True)
    for ci, (cls, queries) in enumerate(QUERIES.items()):
        train_dir = ROOT / "data" / "vehicles" / cls
        train_dir.mkdir(parents=True, exist_ok=True)
        have, have_demo = count(cls), len(list(demo_dir.glob(f"{cls}_*")))
        need_train, need_demo = max(0, per_class - have), max(0, demo - have_demo)
        added[cls] = 0
        if need_train + need_demo == 0:
            j.log(f"{cls}: уже {have} фото — пропускаю")
            continue
        items, seen = [], set()
        for q in queries:
            try:
                for it in search(q):
                    if it["title"] not in seen and it["title"] not in known:
                        seen.add(it["title"])
                        items.append(it)
            except requests.RequestException as e:
                j.warn(f"пошук «{q}»: {e}")
            time.sleep(1)
        j.log(f"{cls}: знайдено {len(items)} нових, потрібно {need_train} + {need_demo} демо")
        rows, n = [], 0
        for it in items:
            if n >= need_train + need_demo:
                break
            to_demo = n >= need_train
            ext = ".png" if it["thumb"].lower().endswith(".png") else ".jpg"
            idx = (have_demo if to_demo else have) + (n - need_train if to_demo else n)
            name = f"{cls}_{idx:03d}{ext}"
            dest = (demo_dir if to_demo else train_dir) / name
            try:
                img = requests.get(it["thumb"], headers=HEADERS, timeout=60)
                img.raise_for_status()
                dest.write_bytes(img.content)
            except requests.RequestException as e:
                j.warn(f"пропущено {it['title']}: {e}")
                continue
            rows.append(f"| {cls} | {'demo/' if to_demo else ''}{name} | {it['author']} | {it['license']} | {it['page']} |")
            n += 1
            j.set((ci + n / max(1, need_train + need_demo)) / len(QUERIES), f"{cls}: {n}/{need_train + need_demo}")
            time.sleep(0.4)
        with open(src, "a", encoding="utf-8") as f:
            f.write("\n".join(rows) + ("\n" if rows else ""))
        added[cls] = n
        j.ok(f"{cls}: збережено {n} фото (усього в класі {count(cls)})")
    j.log("Перегляньте фото в «Центрі даних» і видаліть невідповідні (іграшки, схеми, реальні позиції ЗСУ).")
    return added


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-class", type=int, default=30)
    ap.add_argument("--demo", type=int, default=2)
    a = ap.parse_args()
    collect(a.per_class, a.demo)
