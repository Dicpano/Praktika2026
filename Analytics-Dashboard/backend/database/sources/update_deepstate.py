"""
Оновлення відкритих даних DeepStateMap (https://deepstatemap.live): окуповані території, сіра зона,
позиції підрозділів РФ. Результат — backend/database/sources/deepstate.json (обрізаний, лише територія України
та прикордоння). Його використовують генератор (лінія зіткнення, сторони) і шар карти «Противник».

Запуск:  python backend/database/sources/update_deepstate.py            (завантажити свіжий знімок)
         python backend/database/sources/update_deepstate.py --file x.json  (з раніше збереженого файлу)
Дані DeepState — відкриті OSINT-дані; при використанні обов'язкове посилання на джерело.
"""
from __future__ import annotations

import argparse
import json
import re
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "deepstate.json"
URL = "https://deepstatemap.live/api/history/last"
BBOX = (22.0, 44.0, 41.5, 53.0)  # lon0, lat0, lon1, lat1: Україна + прикордоння

UNIT_RE = re.compile(r"(бригад|полк|дивізі|батальйон|армі|корпус|загін|загони|БАРС|Ахмат|шторм|росгвард)", re.I)
SKIP_RE = re.compile(r"(Напрямок удару|Крейсер|військова база|клоун|Африканськ|Місця зосереджень)", re.I)


def ua_name(props: dict) -> str:
    return (props.get("name") or "").split("///")[0].strip().replace("\xa0", " ")


def en_name(props: dict) -> str:
    parts = (props.get("name") or "").split("///")
    return parts[1].strip().replace("\xa0", " ") if len(parts) > 1 else ""


def in_bbox(lon: float, lat: float) -> bool:
    return BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]


def ring2d(ring):
    return [[round(p[0], 4), round(p[1], 4)] for p in ring]


def classify(name: str) -> tuple[str, str]:
    """(branch, echelon) за назвою формування."""
    n = name.lower()
    if "армі" in n and "армійськ" not in n:
        ech = "army"
    elif "корпус" in n:
        ech = "corps"
    elif "дивізі" in n:
        ech = "division"
    elif "бригад" in n or "дршбр" in n:
        ech = "brigade"
    elif "полк" in n:
        ech = "regiment"
    elif "батальйон" in n or "загін" in n or "барс" in n:
        ech = "battalion"
    else:
        ech = "unknown"
    if "танков" in n:
        br = "tank"
    elif "артилер" in n:
        br = "artillery"
    elif "десант" in n or "повітрянодесант" in n:
        br = "airborne"
    elif "морської піхоти" in n:
        br = "marine"
    elif "спеціального призначення" in n or "розвідуваль" in n:
        br = "recon"
    elif "інженерно" in n:
        br = "engineer"
    elif "мотостріл" in n:
        br = "mech"
    else:
        br = "infantry"
    return br, ech


ABBR = [
    ("окрема мотострілецька бригада", "омсбр"), ("мотострілецька бригада", "мсбр"),
    ("мотострілецький полк територіальних військ", "мсп ТВ"), ("мотострілецький полк", "мсп"),
    ("мотострілковий полк", "мсп"), ("мотострілецька дивізія", "мсд"), ("танкова дивізія", "тд"),
    ("танковий полк", "тп"), ("десантно-штурмова бригада", "дшбр"), ("парашутно-десантний полк", "пдп"),
    ("повітрянодесантна бригада", "пдбр"), ("артилерійська бригада", "абр"),
    ("самохідний артилерійський полк", "сап"), ("загальновійськова армія", "ЗВА"), ("армійський корпус", "АК"),
    ("бригада спеціального призначення", "бр СпП"), ("мотострілецький батальйон", "мсб"),
    ("полк морської піхоти", "п МП"), ("інженерно-саперний полк", "іср"),
]


def short_label(name: str) -> str:
    n = re.sub(r"\(.*?\)", "", name)
    n = re.sub(r"\s(зі складу|у складі|колишня).*$", "", n)
    n = re.sub(r"гвардійськ\w*\s*", "", n, flags=re.I).strip()
    num = re.match(r"^(\d+)", n)
    low = n.lower().replace("мотострілков", "мотострілецьк")
    for full, ab in ABBR:
        if full in low:
            return f"{num.group(1)} {ab}" if num else ab
    if num:  # «7-й окремий розвідувальний батальйон» → «7 орб»
        words = [w for w in re.sub(r"^\d+[-\w]*\s*", "", n).split() if w[:1].isalpha()]
        return f"{num.group(1)} {''.join(w[0].lower() for w in words)[:5]}"
    return n[:14]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", help="локальний JSON замість завантаження")
    a = ap.parse_args()
    if a.file:
        raw = json.loads(Path(a.file).read_text(encoding="utf-8"))
    else:
        req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0 (educational dashboard)"})
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = json.loads(r.read().decode("utf-8"))

    occupied, grey, units = [], [], []
    for f in raw["map"]["features"]:
        g, p = f["geometry"], f["properties"]
        name, en = ua_name(p), en_name(p)
        if g["type"] == "Point":
            lon, lat = g["coordinates"][:2]
            if in_bbox(lon, lat) and UNIT_RE.search(name) and not SKIP_RE.search(name):
                br, ech = classify(name)
                units.append({"name": name, "label": short_label(name), "branch": br, "echelon": ech,
                              "lat": round(lat, 5), "lon": round(lon, 5)})
            continue
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"] if g["type"] == "MultiPolygon" else []
        for poly in polys:
            outer = poly[0]
            if not any(in_bbox(x[0], x[1]) for x in outer[:: max(1, len(outer) // 20)]):
                continue
            rings = [ring2d(r) for r in poly]
            if re.search(r"Occupied|CADR|Окупован", en + name, re.I) and not re.search(r"Transnistria|Abkhaz|Ossetia|Придністров", en + name, re.I):
                occupied.append(rings)
            elif re.search(r"Unknown status", en, re.I):
                grey.append(rings)

    out = {"source": "DeepStateMap (deepstatemap.live)", "datetime": raw.get("datetime"), "id": raw.get("id"),
           "occupied": occupied, "grey": grey, "units": units}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{out['datetime']}: окуповано полігонів {len(occupied)}, сіра зона {len(grey)}, підрозділів РФ {len(units)}")


if __name__ == "__main__":
    main()
