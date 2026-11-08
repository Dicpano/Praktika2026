"""
Офлайн-підкладка карти з Natural Earth (https://www.naturalearthdata.com, суспільне надбання):
суходіл, озера, державні кордони, річки, міста з українськими назвами. Усе обрізано до району
України й прикордоння і спрощено. Результат — db/sources/basemap.json; tools/build.py робить
з нього frontend/data/basemap.js (window.BASEMAP). Карта показує цю підкладку, коли немає інтернету
або коли користувач обрав «Схема (без інтернету)».

Запуск:  python db/sources/update_basemap.py            (завантажити з GitHub-дзеркала Natural Earth)
         python db/sources/update_basemap.py --dir ne/   (з раніше завантажених *.geojson)
"""
from __future__ import annotations

import argparse
import json
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "basemap.json"
URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/{}.geojson"
BBOX = (16.0, 41.0, 46.0, 56.0)   # lon0, lat0, lon1, lat1 — межі прокрутки карти з запасом
FILES = ["ne_10m_land", "ne_10m_lakes", "ne_10m_admin_0_boundary_lines_land",
         "ne_10m_rivers_lake_centerlines", "ne_10m_populated_places"]


def load(name: str, src: Path | None) -> dict:
    if src:
        return json.loads((src / f"{name}.geojson").read_text(encoding="utf-8"))
    with urllib.request.urlopen(URL.format(name), timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


# ---- геометрія без сторонніх бібліотек ----
def clip_ring(ring: list) -> list:
    """Сазерленд — Ходжмен: обрізання кільця полігона прямокутником BBOX."""
    x0, y0, x1, y1 = BBOX
    edges = [(lambda p: p[0] >= x0, lambda a, b: (x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0]))),
             (lambda p: p[0] <= x1, lambda a, b: (x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0]))),
             (lambda p: p[1] >= y0, lambda a, b: (a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0)),
             (lambda p: p[1] <= y1, lambda a, b: (a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1))]
    pts = [tuple(p[:2]) for p in ring]
    for inside, cross in edges:
        if not pts:
            break
        out, prev = [], pts[-1]
        for cur in pts:
            if inside(cur):
                if not inside(prev):
                    out.append(cross(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(cross(prev, cur))
            prev = cur
        pts = out
    if len(pts) < 3:
        return []
    return pts + [pts[0]]


def clip_line(line: list) -> list:
    """Розбиває ламану на частини всередині BBOX (точки поза рамкою відкидаються, край — з однією точкою запасу)."""
    x0, y0, x1, y1 = BBOX
    ins = lambda p: x0 <= p[0] <= x1 and y0 <= p[1] <= y1
    parts, cur = [], []
    for i, p in enumerate(line):
        near = ins(p) or (i > 0 and ins(line[i - 1])) or (i + 1 < len(line) and ins(line[i + 1]))
        if near:
            cur.append(tuple(p[:2]))
        elif cur:
            parts.append(cur)
            cur = []
    if cur:
        parts.append(cur)
    return [c for c in parts if len(c) >= 2]


def dp(pts: list, tol: float) -> list:
    """Дуглас — Пекер (ітеративно); для кілець з однаковими кінцями — відстань до точки."""
    if len(pts) < 5:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (xa, ya), (xb, yb) = pts[a], pts[b]
        dx, dy = xb - xa, yb - ya
        n = (dx * dx + dy * dy) ** 0.5
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dy * px - dx * py + xb * ya - yb * xa) / n if n else ((px - xa) ** 2 + (py - ya) ** 2) ** 0.5
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def rnd(pts: list) -> list:
    out = []
    for x, y in pts:
        q = [round(x, 3), round(y, 3)]
        if not out or out[-1] != q:
            out.append(q)
    return out


def polys(geom: dict) -> list:
    return [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]


def lines(geom: dict) -> list:
    return [geom["coordinates"]] if geom["type"] == "LineString" else geom["coordinates"]


def area_polys(fc: dict, tol: float, min_pts: int = 4) -> list:
    out = []
    for f in fc["features"]:
        for poly in polys(f["geometry"]):
            rings = [rnd(dp(clip_ring(r), tol)) for r in poly]
            if rings and len(rings[0]) >= min_pts:
                out.append([r for r in rings if len(r) >= min_pts])
    return out


def line_parts(fc: dict, tol: float, keep=lambda p: True) -> list:
    out = []
    for f in fc["features"]:
        if not keep(f["properties"]):
            continue
        for ln in lines(f["geometry"]):
            for part in clip_line(ln):
                part = rnd(dp(part, tol))
                if len(part) >= 2:
                    out.append(part)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", type=Path, help="тека з уже завантаженими ne_10m_*.geojson")
    args = ap.parse_args()
    d = {n: load(n, args.dir) for n in FILES}
    x0, y0, x1, y1 = BBOX

    cities = []
    for f in d["ne_10m_populated_places"]["features"]:
        p, (lon, lat) = f["properties"], f["geometry"]["coordinates"][:2]
        if not (x0 <= lon <= x1 and y0 <= lat <= y1):
            continue
        rank = p.get("SCALERANK", 10)
        if rank > 8:
            continue
        name = p.get("NAME_UK") or p.get("NAME")
        cities.append({"n": name, "ll": [round(lat, 3), round(lon, 3)], "r": rank,
                       "cap": 1 if p.get("FEATURECLA", "").startswith("Admin-0 capital") else 0})
    cities.sort(key=lambda c: (c["r"], c["n"]))

    basemap = {
        "source": "Natural Earth 1:10m (public domain), naturalearthdata.com",
        "bbox": BBOX,
        "land": area_polys(d["ne_10m_land"], 0.01),
        "lakes": area_polys(d["ne_10m_lakes"], 0.005),
        "borders": line_parts(d["ne_10m_admin_0_boundary_lines_land"], 0.005),
        # річки: scalerank ≤ 8 — великі й середні (Дніпро, Дністер, Десна, Сіверський Донець…)
        "rivers": line_parts(d["ne_10m_rivers_lake_centerlines"], 0.005,
                             lambda p: (p.get("scalerank") or 99) <= 8 and p.get("featurecla") != "Lake Centerline"),
        "cities": cities,
    }
    OUT.write_text(json.dumps(basemap, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    cnt = lambda c: 1 if isinstance(c[0], (int, float)) else sum(cnt(x) for x in c)
    print(f"{OUT.name}: {OUT.stat().st_size / 1024:.0f} КБ; суходіл {cnt(basemap['land'])} т., озера {cnt(basemap['lakes'])}, "
          f"кордони {cnt(basemap['borders'])}, річки {cnt(basemap['rivers'])}, міст {len(cities)}")


if __name__ == "__main__":
    main()
