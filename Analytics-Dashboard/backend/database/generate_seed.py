"""
Генератор СИНТЕТИЧНИХ даних для аналітичного дашборду (навчальний проєкт).

Дані правдоподібні за структурою, але не відображають реальних подій, втрат,
документів, підрозділів чи координат. Лінія зіткнення і підрозділи умовні.

Запуск:
    python backend/database/generate_seed.py --seed 140 --from 2025-11-01 --to 2026-10-31
Результат: backend/database/init/03_seed.sql (COPY-блоки, виконується psql / docker-entrypoint).
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from oblasts_ref import OBLASTS  # noqa: E402

GEN_VERSION = "1.1"
GEOJSON = HERE / "sources" / "ukraine-oblasts.geojson"
DEEPSTATE = HERE / "sources" / "deepstate.json"
OUT = HERE / "init" / "03_seed.sql"

# ---------------------------------------------------------------------------
# Час: генеруємо київський місцевий час і пишемо зі зміщенням +02/+03.
# ---------------------------------------------------------------------------

def _last_sunday(year: int, month: int) -> date:
    d = date(year, month + 1, 1) - timedelta(days=1) if month < 12 else date(year, 12, 31)
    return d - timedelta(days=(d.weekday() + 1) % 7)


def kyiv_offset(local: datetime) -> int:
    """EEST (+3) з останньої неділі березня 03:00 до останньої неділі жовтня 04:00."""
    start = datetime.combine(_last_sunday(local.year, 3), datetime.min.time()).replace(hour=3)
    end = datetime.combine(_last_sunday(local.year, 10), datetime.min.time()).replace(hour=4)
    return 3 if start <= local < end else 2


def to_utc(local: datetime) -> datetime:
    return local - timedelta(hours=kyiv_offset(local))


def ts(local: datetime | None) -> str:
    """Місцевий київський час → рядок UTC для COPY."""
    if local is None:
        return r"\N"
    return f"{to_utc(local):%Y-%m-%d %H:%M:%S}+00"


def not_before(a: datetime, b: datetime, strict: bool = False) -> datetime:
    """Гарантує, що b не раніше a в абсолютному часі (потрібно на переході на літній час)."""
    while to_utc(b) < to_utc(a) or (strict and to_utc(b) == to_utc(a)):
        b += timedelta(hours=1)
    return b


# ---------------------------------------------------------------------------
# Геометрія (без PostGIS): точка в полігоні, умовна лінія зіткнення.
# ---------------------------------------------------------------------------

def _point_in_ring(x: float, y: float, ring) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


class Regions:
    def __init__(self, path: Path):
        data = json.loads(path.read_text(encoding="utf-8"))
        self.polys: dict[str, list] = {}
        self.bbox: dict[str, tuple] = {}
        for f in data["features"]:
            iso = f["properties"]["iso"]
            g = f["geometry"]
            parts = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
            self.polys[iso] = parts
            xs = [p[0] for part in parts for p in part[0]]
            ys = [p[1] for part in parts for p in part[0]]
            self.bbox[iso] = (min(xs), min(ys), max(xs), max(ys))
        # м. Київ і Севастополь перевіряються першими (вони всередині інших областей)
        self.order = sorted(self.polys, key=lambda k: k not in ("UA-30", "UA-40"))

    def contains(self, iso: str, lat: float, lon: float) -> bool:
        x0, y0, x1, y1 = self.bbox[iso]
        if not (x0 <= lon <= x1 and y0 <= lat <= y1):
            return False
        for part in self.polys[iso]:
            if _point_in_ring(lon, lat, part[0]) and not any(
                _point_in_ring(lon, lat, hole) for hole in part[1:]
            ):
                return True
        return False

    def find(self, lat: float, lon: float) -> str | None:
        for iso in self.order:
            if self.contains(iso, lat, lon):
                return iso
        return None

    def random_point(self, rnd: random.Random, iso: str) -> tuple[float, float]:
        x0, y0, x1, y1 = self.bbox[iso]
        for _ in range(500):
            lon, lat = rnd.uniform(x0, x1), rnd.uniform(y0, y1)
            if self.find(lat, lon) == iso:
                return lat, lon
        raise RuntimeError(iso)

    def center(self, iso: str) -> tuple[float, float]:
        ring = max((p[0] for p in self.polys[iso]), key=len)
        a = cx = cy = 0.0
        for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
            c = x0 * y1 - x1 * y0
            a += c
            cx += (x0 + x1) * c
            cy += (y0 + y1) * c
        a *= 0.5
        return cy / (6 * a), cx / (6 * a)


def km_to_deg(lat: float) -> tuple[float, float]:
    """(градусів широти на 1 км, градусів довготи на 1 км)."""
    return 1 / 110.57, 1 / (111.32 * math.cos(math.radians(lat)))


class Occupied:
    """Окуповані території за DeepState (backend/database/sources/deepstate.json)."""

    def __init__(self, polys):
        self.polys = []
        for rings in polys:
            xs = [p[0] for p in rings[0]]
            ys = [p[1] for p in rings[0]]
            self.polys.append((rings, (min(xs), min(ys), max(xs), max(ys))))

    def contains(self, lat: float, lon: float) -> bool:
        for rings, (x0, y0, x1, y1) in self.polys:
            if x0 <= lon <= x1 and y0 <= lat <= y1 and _point_in_ring(lon, lat, rings[0]) \
                    and not any(_point_in_ring(lon, lat, h) for h in rings[1:]):
                return True
        return False


DIRS = [(math.cos(a), math.sin(a)) for a in (i * math.pi / 8 for i in range(16))]


class FrontLine:
    """
    Лінія зіткнення = ділянки межі окупованої території, поруч із якими є підконтрольна Україні територія
    (узбережжя та кордон з РФ відкидаються). Точки впорядковано з півночі на південь і проріджено до ~3 км.
    Для кожної точки обчислено напрямок у бік противника. t ∈ [0,1] — положення вздовж основної ділянки.
    """

    def __init__(self, reg: "Regions", occ: Occupied, step_km: float = 3.0):
        self.reg, self.occ = reg, occ
        cand = []
        for rings, _ in occ.polys:
            for lon, lat in rings[0]:
                if reg.find(lat, lon) is None:
                    continue
                dlat, dlon = km_to_deg(lat)
                # вільна територія має бути на 5, 9 і 20 км (відсікає вузькі смужки й розриви між полігонами)
                if any(self.free(lat + dy * 5 * dlat, lon + dx * 5 * dlon) and self.free(lat + dy * 9 * dlat, lon + dx * 9 * dlon)
                       and self.free(lat + dy * 20 * dlat, lon + dx * 20 * dlon)
                       for dx, dy in DIRS[::2]):
                    cand.append((lat, lon))
        cand = list(dict.fromkeys(cand))
        # ланцюжки найближчих сусідів (розрив > 20 км — нова ділянка)
        left = set(range(len(cand)))
        segments = []
        while left:
            cur = max(left, key=lambda i: cand[i][0])  # найпівнічніша з решти
            seg = [cur]
            left.remove(cur)
            while left:
                la, lo = cand[seg[-1]]
                nxt = min(left, key=lambda i: (cand[i][0] - la) ** 2 + ((cand[i][1] - lo) * 0.66) ** 2)
                if self.km(cand[nxt], (la, lo)) > 20:
                    break
                seg.append(nxt)
                left.remove(nxt)
            if len(seg) > 3:
                segments.append([cand[i] for i in seg])
        segs = [self.resample(sg, step_km) for sg in segments]
        segs = [sg for sg in segs if self.length(sg) > 15]
        segs.sort(key=self.length, reverse=True)
        self.segments = segs
        main = list(segs[0])
        if main[0][0] < main[-1][0]:
            main.reverse()
        # зшиваємо ділянки, що продовжують основну (напр. Запоріжжя → Дніпро на Херсонщині), розрив < 40 км
        rest = segs[1:]
        joined = True
        while joined:
            joined = False
            for sg in rest:
                for cand in (sg, sg[::-1]):
                    if self.km(main[-1], cand[0]) < 40 and self.length(cand) > 50:
                        main.extend(cand)
                        rest.remove(sg)
                        joined = True
                        break
                if joined:
                    break
        self.main = [q for q in main if not (q[1] < 32.45 and q[0] < 46.75)]
        self.cum = [0.0]
        for x, y in zip(self.main, self.main[1:]):
            self.cum.append(self.cum[-1] + self.km(x, y))
        self.total = self.cum[-1]
        self.enemy_dir = [self.enemy_direction(la, lo) for la, lo in self.main]

    def free(self, lat: float, lon: float) -> bool:
        """Підконтрольна Україні суша. Полігони geoBoundaries частково захоплюють Азовське море, тому
        південніше 47,05° і східніше 34,9° (там уся суша окупована) «вільних» точок немає."""
        if lat < 47.05 and lon > 34.9:
            return False
        iso = self.reg.find(lat, lon)
        return iso is not None and iso not in ("UA-43", "UA-40") and not self.occ.contains(lat, lon)

    @staticmethod
    def km(a, b) -> float:
        kx = 111.32 * math.cos(math.radians((a[0] + b[0]) / 2))
        return math.hypot((b[1] - a[1]) * kx, (b[0] - a[0]) * 110.57)

    def length(self, seg) -> float:
        return sum(self.km(x, y) for x, y in zip(seg, seg[1:]))

    def resample(self, seg, step):
        out = [seg[0]]
        acc = 0.0
        for x, y in zip(seg, seg[1:]):
            acc += self.km(x, y)
            if acc >= step:
                out.append(y)
                acc = 0.0
        if out[-1] != seg[-1]:
            out.append(seg[-1])
        # згладжування ковзним середнім (3 точки)
        sm = [out[0]] + [tuple((out[i - 1][k] + out[i][k] + out[i + 1][k]) / 3 for k in range(2))
                         for i in range(1, len(out) - 1)] + [out[-1]]
        return sm

    def enemy_direction(self, lat: float, lon: float) -> tuple[float, float]:
        """Одиничний вектор (dx на схід, dy на північ) у бік окупованої території."""
        dlat, dlon = km_to_deg(lat)
        sx = sy = 0.0
        for dx, dy in DIRS:
            if self.occ.contains(lat + dy * 4 * dlat, lon + dx * 4 * dlon):
                sx += dx
                sy += dy
        n = math.hypot(sx, sy)
        return (sx / n, sy / n) if n else (1.0, 0.0)

    def point(self, t: float) -> tuple[int, float, float]:
        target = max(0.0, min(1.0, t)) * self.total
        i = max(0, min(len(self.main) - 2, next((k for k, c in enumerate(self.cum) if c >= target), len(self.cum) - 1) - 1))
        a, b = self.main[i], self.main[i + 1]
        seg = (self.cum[i + 1] - self.cum[i]) or 1e-9
        f = (target - self.cum[i]) / seg
        return i, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f

    def offset(self, t: float, dist_km: float, enemy_side: bool) -> tuple[float, float]:
        i, lat, lon = self.point(t)
        dx, dy = self.enemy_dir[i]
        if not enemy_side:
            dx, dy = -dx, -dy
        dlat, dlon = km_to_deg(lat)
        return lat + dy * dist_km * dlat, lon + dx * dist_km * dlon

    def side_ok(self, lat: float, lon: float, enemy_side: bool) -> bool:
        if enemy_side:
            return self.reg.find(lat, lon) is not None and self.occ.contains(lat, lon)
        return self.free(lat, lon)

    def place(self, rnd, t: float, dist: tuple[float, float], enemy_side: bool, tries: int = 25):
        """Точка на потрібній стороні на відстані dist км від лінії біля положення t (з невеликим зсувом)."""
        for k in range(tries * 2):
            spread = 0.01 + 0.004 * k  # якщо поруч море/кордон — шукаємо далі вздовж лінії
            tt = min(1.0, max(0.0, t + (rnd.uniform(-spread, spread) if k else 0)))
            lat, lon = self.offset(tt, rnd.uniform(*dist), enemy_side)
            if self.side_ok(lat, lon, enemy_side):
                return lat, lon
        return None


# ---------------------------------------------------------------------------
# Допоміжне
# ---------------------------------------------------------------------------

def wchoice(rnd: random.Random, weights: dict):
    return rnd.choices(list(weights), weights=list(weights.values()))[0]


def poisson(rnd: random.Random, lam: float) -> int:
    if lam <= 0:
        return 0
    if lam > 30:
        return max(0, int(rnd.gauss(lam, math.sqrt(lam)) + 0.5))
    l, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= rnd.random()
        if p <= l:
            return k
        k += 1


def reliability(rnd: random.Random) -> str:
    letter = wchoice(rnd, {"A": 3, "B": 40, "C": 42, "D": 10, "E": 3, "F": 2})
    digit = wchoice(rnd, {"1": 4, "2": 45, "3": 46, "4": 3, "5": 1.5, "6": 0.5})
    return letter + digit


def cell(v) -> str:
    if v is None or v == r"\N":
        return r"\N"
    if isinstance(v, bool):
        return "t" if v else "f"
    if isinstance(v, float):
        return f"{v:.5f}"
    return str(v).replace("\\", "\\\\").replace("\t", " ").replace("\n", " ")


class SqlWriter:
    def __init__(self):
        self.parts: list[str] = []
        self.counts: dict[str, int] = {}

    def copy(self, table: str, cols: list[str], rows: list[tuple]):
        self.counts[table] = len(rows)
        self.parts.append(f"COPY {table} ({', '.join(cols)}) FROM stdin;\n")
        self.parts.extend("\t".join(cell(v) for v in r) + "\n" for r in rows)
        self.parts.append("\\.\n\n")

    def raw(self, s: str):
        self.parts.append(s)


# ---------------------------------------------------------------------------
# Довідники
# ---------------------------------------------------------------------------

# Засоби повітряного нападу. На карті показується лише МІСЦЕ УРАЖЕННЯ знаком наказу № 140, п. 6.12
# «Вибух, підрив, терористичний акт» (2525C O-V-E, ворожа діяльність) з підписом засобу (власні скорочення,
# пояснюються в таблиці «УМОВНІ ПОЗНАЧЕННЯ», п. 2.2.16). «БР»/«КР» не вживаються — у п. 2.2.15 це джерела розвідки.
IMPACT_SIDC = "OHVPE----------"
WEAPONS = [  # code, name, category, sidc, color (брендбук §9.1), map_label
    ("uav_attack", "Ударний БпЛА", "uav", IMPACT_SIDC, "#F39200", "БпЛА"),
    ("cruise_missile", "Крилата ракета", "cruise_missile", IMPACT_SIDC, "#293757", "КрР"),
    ("ballistic_missile", "Балістична ракета", "ballistic_missile", IMPACT_SIDC, "#671318", "БалР"),
    ("guided_bomb", "Керована авіабомба (КАБ)", "guided_bomb", IMPACT_SIDC, "#6A653A", "КАБ"),
]
TARGETS = [
    ("energy", "Енергетика"), ("residential", "Житловий сектор"), ("transport", "Транспорт"),
    ("industry", "Промисловість"), ("military", "Військові об'єкти"), ("other", "Інше"),
]
# Скорочення джерел інформації — повний перелік за п. 2.2.15 Порядку (наказ № 140)
SOURCES = [
    ("ВК", "від вищого командування"), ("АДж", "агентурне джерело"), ("С", "спостереження"),
    ("П", "зізнання полоненого"), ("ДП", "документи противника"), ("ВР", "військова розвідка"),
    ("ГАР", "гідроакустична розвідка"), ("НЗР", "наземна розвідка"), ("ПвР", "повітряна розвідка"),
    ("КсР", "космічна розвідка"), ("ОЕР", "оптико-електронна розвідка"), ("РР", "радіорозвідка"),
    ("РЛР", "радіолокаційна розвідка"), ("РТР", "радіотехнічна розвідка"), ("РЕР", "радіоелектронна розвідка"),
    ("АР", "артилерійська розвідка"), ("ГМР", "гідрометеорологічна розвідка"), ("ІР", "інженерна розвідка"),
    ("ХБРЯр", "хімічна, біологічна, радіологічна та ядерна розвідка"), ("БР", "бактеріологічна (біологічна) розвідка"),
    ("КР", "морська розвідка"), ("АгР", "агентурна розвідка"), ("МЖ", "свідчення місцевих жителів"),
    ("Пртз", "донесення (інформація) партизан"), ("РГСпП", "донесення розвідгрупи спеціального призначення"),
    ("ПвФ", "повітряне фотографування"), ("НазФ", "наземне фотографування"),
]
NORMS = [  # urgency, name, norm_min (УМОВНІ), sort
    ("horizon", "ГОРИЗОНТ", 10, 1), ("efir", "ЕФІР", 30, 2), ("buran", "БУРАН", 60, 3),
    ("zlit", "ЗЛІТ", 180, 4), ("none", "Безкатегорійний", 480, 5),
]
ECHELON_CHAR = {"company": "E", "battalion": "F", "regiment": "G", "brigade": "H", "division": "I",
                "corps": "J", "army": "K", "command": "K", "unknown": "-"}
BRANCH_FN = {  # функція 2525C (позиції 5–10)
    "mech": "UCIZ--", "tank": "UCA---", "artillery": "UCF---", "air_defense": "UCD---",
    "airborne": "UCIA--", "support": "USS---", "hq": "UH----", "recon": "UCR---", "marine": "UCIN--",
    "infantry": "UCI---", "engineer": "UCE---",
    "training": "UCI---", "signal": "UUS---", "maintenance": "USX---", "medical": "USM---",
}


def unit_sidc(branch: str, echelon: str, hostile: bool = False) -> str:
    hq = "A" if branch == "hq" else "-"
    return f"S{'H' if hostile else 'F'}GP{BRANCH_FN[branch]}{hq}{ECHELON_CHAR[echelon]}---"


# ---------------------------------------------------------------------------
# Генерація
# ---------------------------------------------------------------------------

def build(seed: int, d_from: date, d_to: date) -> SqlWriter:
    rnd = random.Random(seed)
    reg = Regions(GEOJSON)
    ds = json.loads(DEEPSTATE.read_text(encoding="utf-8"))
    occ = Occupied(ds["occupied"])
    line = FrontLine(reg, occ)
    w = SqlWriter()
    days = [d_from + timedelta(days=i) for i in range((d_to - d_from).days + 1)]
    period_end = datetime.combine(d_to, datetime.min.time()) + timedelta(hours=23, minutes=59, seconds=59)

    # --- області
    iso_list = sorted(OBLASTS)
    oid = {iso: i + 1 for i, iso in enumerate(iso_list)}
    rows = []
    for iso in iso_list:
        ua, en, fr, occ = OBLASTS[iso]
        clat, clon = reg.center(iso)
        rows.append((oid[iso], iso, ua, en, round(clat, 5), round(clon, 5), fr, occ))
    w.copy("oblasts", ["id", "iso_code", "name_ua", "name_en", "center_lat", "center_lon",
                       "is_frontline", "is_occupied"], rows)

    w.copy("weapon_types", ["id", "code", "name_ua", "category", "sidc", "color_hex", "map_label"],
           [(i + 1, *x) for i, x in enumerate(WEAPONS)])
    w.copy("target_categories", ["id", "code", "name_ua"], [(i + 1, *x) for i, x in enumerate(TARGETS)])
    tid = {c: i + 1 for i, (c, _) in enumerate(TARGETS)}
    w.copy("info_sources", ["code", "name_ua"], SOURCES)
    w.copy("doc_sla_norms", ["urgency", "name_ua", "norm_min", "sort_order", "is_conditional"],
           [(*n, True) for n in NORMS])
    norm_min = {n[0]: n[2] for n in NORMS}
    cl_rows, seq = [], 0
    for si, sg in enumerate(line.segments, start=1):
        for la, lo in sg:
            dx, dy = line.enemy_direction(la, lo)
            dlat, dlon = km_to_deg(la)
            seq += 1
            cl_rows.append((seq, si, round(la, 5), round(lo, 5), round(la + dy * 2.5 * dlat, 5), round(lo + dx * 2.5 * dlon, 5)))
    w.copy("contact_line", ["seq", "segment", "lat", "lon", "e_lat", "e_lon"], cl_rows)
    w.copy("enemy_units", ["name_ua", "label", "branch", "echelon", "sidc", "lat", "lon", "source", "as_of"],
           [(u["name"][:160], u["label"][:24], u["branch"], u["echelon"], unit_sidc(u["branch"], u["echelon"], True),
             u["lat"], u["lon"], "DeepStateMap", ds["datetime"]) for u in ds["units"]])

    # --- умовні підрозділи (назви вигадані; положення — на підконтрольній території біля реальної лінії)
    units: list[dict] = []

    def add_unit(short, name, echelon, branch, parent, pos, rear=False, t=None, cp=False):
        if pos is None:
            raise RuntimeError(f"не вдалося розмістити {short}")
        lat, lon = pos
        iso = reg.find(lat, lon)
        u = dict(id=len(units) + 1, short=short, name=name, echelon=echelon, branch=branch, parent=parent,
                 iso=iso, lat=lat, lon=lon, rear=rear, t=t, cp=cp, sidc=unit_sidc(branch, echelon))
        units.append(u)
        return u

    N_OTU, BR_PER_OTU = 4, 4
    n_br = N_OTU * BR_PER_OTU
    osuv = add_unit("ОСУВ (умовне)", "Оперативно-стратегічне угруповання військ (умовне), ОКП", "command", "hq",
                    None, line.place(rnd, 0.45, (85, 110), False), rear=True, t=0.45, cp=True)
    brig_cycle = ["mech", "mech", "tank", "airborne", "mech", "artillery", "mech", "airborne",
                  "mech", "tank", "mech", "artillery", "mech", "airborne", "marine", "mech"]
    brig_abbr = {"mech": "омбр", "tank": "отбр", "artillery": "оабр", "airborne": "одшбр", "marine": "обрмп"}
    brig_name = {"mech": "окрема механізована бригада", "tank": "окрема танкова бригада",
                 "artillery": "окрема артилерійська бригада", "airborne": "окрема десантно-штурмова бригада",
                 "marine": "окрема бригада морської піхоти"}
    bn_plan = {"mech": [("mech", "мб"), ("mech", "мб"), ("artillery", "адн")],
               "tank": [("tank", "тб"), ("tank", "тб"), ("mech", "мб")],
               "artillery": [("artillery", "адн"), ("artillery", "адн"), ("artillery", "реадн")],
               "airborne": [("airborne", "дшб"), ("airborne", "дшб"), ("artillery", "адн")],
               "marine": [("marine", "бмп"), ("marine", "бмп"), ("artillery", "адн")]}
    bn_name = {"мб": "механізований батальйон", "тб": "танковий батальйон", "адн": "артилерійський дивізіон",
               "реадн": "реактивний артилерійський дивізіон", "дшб": "десантно-штурмовий батальйон",
               "бмп": "батальйон морської піхоти"}
    front_units = []
    sectors = []
    for k in range(N_OTU):
        t_otu = (k * BR_PER_OTU + BR_PER_OTU / 2) / n_br
        otu = add_unit(f"ОТУ-{k + 1} (умовне)", f"Оперативно-тактичне угруповання № {k + 1} (умовне), КП", "corps",
                       "hq", osuv["id"], line.place(rnd, t_otu, (40, 55), False), t=t_otu, cp=True)
        otu["higher"] = "ОСУВ"
        for j in range(BR_PER_OTU):
            n = k * BR_PER_OTU + j + 1
            t = (n - 0.5) / n_br
            sectors.append(t)
            bt = brig_cycle[n - 1]
            ab = brig_abbr[bt]
            b = add_unit(f"{n} {ab} (умовна)", f"{n} {brig_name[bt]} (умовна)", "brigade", bt, otu["id"],
                         line.place(rnd, t, (13, 20), False), t=t)
            b["higher"] = f"ОТУ-{k + 1}"
            counters = defaultdict(int)
            for q, (br, abbr) in enumerate(bn_plan[bt]):
                counters[abbr] += 1
                dt_ = (q - 1) * 0.012
                depth = (8, 13) if br == "artillery" else (3, 6)
                bn = add_unit(f"{counters[abbr]} {abbr}/{n} {ab} (ум.)",
                              f"{counters[abbr]} {bn_name[abbr]} {n} {brig_name[bt]} (умовний)",
                              "battalion", br, b["id"], line.place(rnd, t + dt_, depth, False), t=t + dt_)
                bn["higher"] = f"{n} {ab}"
                front_units.append(bn)
                if q == 0:
                    co = add_unit(f"1 р/1 {abbr}/{n} {ab} (ум.)", f"1 рота {bn_name[abbr]} {n} {ab} (умовна)",
                                  "company", br, bn["id"], line.place(rnd, t + dt_ + 0.004, (1.2, 2.5), False),
                                  t=t + dt_ + 0.004)
                    co["higher"] = f"1 {abbr}/{n} {ab}"
                    front_units.append(co)
            front_units.append(b)
    ad = add_unit("7 зрп (умовний)", "7 зенітний ракетний полк (умовний)", "regiment", "air_defense",
                  osuv["id"], line.place(rnd, 0.5, (65, 80), False), rear=True, t=0.5)
    ad["higher"] = "ОСУВ"
    sup = add_unit("8 бмз (умовний)", "8 батальйон матеріального забезпечення (умовний)", "battalion",
                   "support", osuv["id"], line.place(rnd, 0.38, (90, 110), False), rear=True, t=0.38)
    sup["higher"] = "ОСУВ"

    # Тилові частини: навчальні центри й частини забезпечення в областях, де немає фронтових підрозділів.
    # Свій генератор випадкових чисел, щоб не змінювати решту синтетичних даних. Підпорядковані
    # командуванням видів/родів (поза ОСУВ), тому документів на ОКП ОСУВ не надсилають.
    rr = random.Random(seed * 7919 + 1)
    REAR_KINDS = [  # скорочення, назва, ланка, рід, штат
        ("нц", "навчальний центр", "regiment", "training", 1400),
        ("обмз", "окремий батальйон матеріального забезпечення", "battalion", "support", 420),
        ("орвб", "окремий ремонтно-відновлювальний батальйон", "battalion", "maintenance", 380),
        ("обз", "окремий батальйон зв'язку", "battalion", "signal", 350),
        ("оінжб", "окремий інженерний батальйон", "battalion", "engineer", 400),
        ("вмг", "військовий мобільний госпіталь", "battalion", "medical", 260),
    ]
    has_units = {u["iso"] for u in units}
    rear_isos = [iso for iso in iso_list if iso not in has_units and not OBLASTS[iso][3]]
    for k, iso in enumerate(rear_isos):
        # великі області отримують навчальний центр і ще одну частину забезпечення
        kinds = [REAR_KINDS[k % len(REAR_KINDS)]]
        if iso in ("UA-46", "UA-18", "UA-32", "UA-56", "UA-61") and kinds[0][0] != "нц":
            kinds.append(REAR_KINDS[0])
        for abbr, name, ech, br, auth in kinds:
            num_ = 100 + len([u for u in units if u.get("deep")]) + 1
            clat, clon = reg.center(iso)
            pos = None
            for _ in range(60):  # біля центру області, але всередині її меж
                la, lo = clat + rr.uniform(-0.35, 0.35), clon + rr.uniform(-0.5, 0.5)
                if reg.find(la, lo) == iso:
                    pos = (la, lo)
                    break
            pos = pos or reg.random_point(rr, iso)
            ru = add_unit(f"{num_} {abbr} (умовний)", f"{num_} {name} (умовний)", ech, br, None, pos, rear=True)
            ru.update(deep=True, auth=auth, higher="КСП" if br != "training" else "КСВ")
    command_posts = [u for u in units if u["cp"]]

    w.copy("units", ["id", "short_name", "name_ua", "echelon", "branch", "parent_id", "oblast_id",
                     "lat", "lon", "sidc", "is_rear", "is_command_post"],
           [(u["id"], u["short"], u["name"], u["echelon"], u["branch"], u["parent"], oid[u["iso"]],
             round(u["lat"], 5), round(u["lon"], 5), u["sidc"], u["rear"], u["cp"]) for u in units])
    by_id = {u["id"]: u for u in units}

    def nearest_front_unit(t: float, pool=None):
        pool = pool or front_units
        return min(pool, key=lambda u: abs(u["t"] - t) + rnd.random() * 0.01)

    # --- «бої»: періоди підвищеної інтенсивності на ділянках
    battles = []
    for _ in range(9):
        start = rnd.choice(days[10:-10])
        battles.append((start, start + timedelta(days=rnd.randint(4, 12)), rnd.choice(sectors)))

    def battle_factor(d: date, t: float) -> float:
        f = 1.0
        for s, e, bt in battles:
            if s <= d <= e and abs(bt - t) < 0.09:
                f += 1.3
        return f

    # =================== Модуль A ===================
    frontline_iso = [i for i in iso_list if OBLASTS[i][2] and not OBLASTS[i][3]]
    rear_iso = [i for i in iso_list if not OBLASTS[i][2] and not OBLASTS[i][3]]
    alertable = frontline_iso + rear_iso

    waves = []
    d = d_from + timedelta(days=rnd.randint(0, 4))
    while d <= d_to:
        start = datetime.combine(d, datetime.min.time()) + timedelta(hours=rnd.choice([21, 22, 23, 24, 25]),
                                                                       minutes=rnd.randint(0, 59))
        end = not_before(start, start + timedelta(hours=rnd.uniform(4, 8.5)), strict=True)
        if end <= period_end:
            waves.append((len(waves) + 1, start, end))
        d += timedelta(days=rnd.choice([3, 4, 4, 5, 6]))
    w.copy("attack_waves", ["id", "started_at", "ended_at", "title"],
           [(i, ts(s), ts(e), f"Масована атака № {i} (умовна)") for i, s, e in waves])
    wave_days = {s.date() for _, s, _ in waves} | {e.date() for _, _, e in waves}

    wid = {c[0]: i + 1 for i, c in enumerate(WEAPONS)}
    rates = {"uav_attack": (0.75, 0.92), "cruise_missile": (0.65, 0.85),
             "ballistic_missile": (0.20, 0.50), "guided_bomb": (0.0, 0.0)}
    strikes = []

    def winter(dd: date) -> bool:
        return dd.month in (11, 12, 1, 2, 3)

    def target_for(dd: date, weapon: str) -> str:
        if weapon == "guided_bomb":
            return wchoice(rnd, {"military": 45, "residential": 30, "industry": 10, "transport": 8, "other": 7})
        return wchoice(rnd, {"energy": 38 if winter(dd) else 14, "residential": 22, "transport": 12,
                             "industry": 14, "military": 12, "other": 6})

    def add_strike(when: datetime, iso: str, weapon: str, launched: int, wave=None, point=None):
        lo, hi = rates[weapon]
        intercepted = sum(1 for _ in range(launched) if rnd.random() < rnd.uniform(lo, hi))
        rest = launched - intercepted
        suppressed = sum(1 for _ in range(rest) if rnd.random() < (0.18 if weapon == "uav_attack" else 0.03))
        rest -= suppressed
        hits = sum(1 for _ in range(rest) if rnd.random() < 0.75)
        if point:
            lat, lon = point
        else:  # влучання — лише на підконтрольній Україні території
            for _ in range(60):
                lat, lon = reg.random_point(rnd, iso)
                if line.free(lat, lon):
                    break
        dmg = 0 if hits == 0 else min(3, 1 + hits // 3 + (rnd.random() < 0.25))
        src = wchoice(rnd, {"РЛР": 45, "С": 20, "ПвР": 10, "РР": 8, "ОЕР": 7, "МЖ": 6, "ВК": 4})
        strikes.append((when, oid[iso], wid[weapon], wave, tid[target_for(when.date(), weapon)], launched,
                        intercepted, suppressed, hits, dmg, src, reliability(rnd), round(lat, 5), round(lon, 5)))

    # Тилові області неоднакові як цілі: столиця і Київщина уражаються частіше за інші (v1.1).
    rear_weight = {"UA-30": 4.0, "UA-32": 2.5}

    def obl_pick(front_share=0.65) -> str:
        if rnd.random() < front_share:
            return rnd.choice(frontline_iso)
        return rnd.choices(rear_iso, weights=[rear_weight.get(i, 1.0) for i in rear_iso])[0]

    # Балістичні ракети б'ють переважно по великих містах (умовні точки навколо центру міста, ±4 км).
    # Вага — відносна частота; прифронтові міста в зоні досяжності — частіше.
    ballistic_cities = [  # (місто, lat, lon, вага)
        ("Харків", 49.993, 36.231, 16), ("Дніпро", 48.464, 35.046, 10), ("Запоріжжя", 47.838, 35.139, 10),
        ("Суми", 50.907, 34.798, 9), ("Одеса", 46.482, 30.723, 8), ("Миколаїв", 46.975, 31.995, 7),
        ("Кривий Ріг", 47.910, 33.392, 7), ("Краматорськ", 48.723, 37.556, 6), ("Київ", 50.450, 30.523, 6),
        ("Полтава", 49.588, 34.551, 4), ("Чернігів", 51.494, 31.289, 3), ("Херсон", 46.636, 32.617, 3),
        ("Павлоград", 48.533, 35.871, 3), ("Ізмаїл", 45.351, 28.837, 2),
    ]

    def ballistic(when: datetime, launched: int, wave=None):
        name, la, lo, _ = rnd.choices(ballistic_cities, weights=[c[3] for c in ballistic_cities])[0]
        for _ in range(30):
            lat, lon = la + rnd.uniform(-0.036, 0.036), lo + rnd.uniform(-0.055, 0.055)
            iso = reg.find(lat, lon)
            if iso in oid and line.free(lat, lon):
                add_strike(when, iso, "ballistic_missile", launched, wave=wave, point=(lat, lon))
                return

    for wv, start, end in waves:
        span = (end - start).total_seconds()
        for weapon, n_ev, size in (("uav_attack", rnd.randint(12, 22), (2, 9)),
                                   ("cruise_missile", rnd.choice([0, 0, 4, 7, 10]), (1, 5))):
            for _ in range(n_ev):
                when = start + timedelta(seconds=rnd.uniform(0, span))
                add_strike(when, obl_pick(0.45), weapon, rnd.randint(*size), wave=wv)
        for _ in range(rnd.choice([2, 4, 5, 7, 9])):  # балістика в масованій атаці — пакетами по 1–4
            ballistic(start + timedelta(seconds=rnd.uniform(0, span)), rnd.randint(1, 4), wave=wv)

    for dd in days:
        base = datetime.combine(dd, datetime.min.time())
        for _ in range(poisson(rnd, 4.5)):  # нічні БпЛА поза хвилями
            h = wchoice(rnd, {0: 6, 1: 6, 2: 6, 3: 5, 4: 4, 5: 2, 20: 2, 21: 3, 22: 5, 23: 6, 12: 1, 15: 1})
            add_strike(base + timedelta(hours=h, minutes=rnd.randint(0, 59)), obl_pick(0.75), "uav_attack",
                       rnd.randint(1, 5))
        for _ in range(poisson(rnd, 1.6)):  # одиночні балістичні удари поза хвилями, будь-коли доби
            ballistic(base + timedelta(hours=rnd.randint(0, 23), minutes=rnd.randint(0, 59)), rnd.randint(1, 2))
        for _ in range(poisson(rnd, 5)):  # КАБ: денні, у прифронтовій смузі
            pos = line.place(rnd, rnd.uniform(0.0, 1.0), (3, 38), False)
            if pos is None:
                continue
            lat, lon = pos
            iso = reg.find(lat, lon)
            if iso not in frontline_iso:
                continue
            h = rnd.randint(7, 19)
            add_strike(base + timedelta(hours=h, minutes=rnd.randint(0, 59)), iso, "guided_bomb",
                       rnd.randint(1, 4), point=(lat, lon))

    strikes.sort(key=lambda r: r[0])
    w.copy("strike_events", ["occurred_at", "oblast_id", "weapon_type_id", "wave_id", "target_category_id",
                             "launched", "intercepted", "suppressed", "hits", "damage_level", "info_source",
                             "reliability", "lat", "lon"],
           [(ts(r[0]), *r[1:]) for r in strikes])

    # --- тривоги: інтервали по області, перекриття зливаються
    intervals = defaultdict(list)
    for iso in alertable:
        fr = iso in frontline_iso
        for dd in days:
            base = datetime.combine(dd, datetime.min.time())
            for _ in range(poisson(rnd, 4.2 if fr else 1.1)):
                s = base + timedelta(minutes=rnd.randint(0, 1439))
                typ = "artillery_shelling" if fr and rnd.random() < 0.22 else "air_raid"
                if fr and rnd.random() < 0.003:
                    typ = "urban_fights"
                intervals[(iso, typ)].append([s, s + timedelta(minutes=int(rnd.lognormvariate(3.6, 0.6)) + 8)])
    for _, start, end in waves:
        for iso in alertable:
            if rnd.random() < 0.85:
                s = start + timedelta(minutes=rnd.randint(-30, 60))
                intervals[(iso, "air_raid")].append([s, end + timedelta(minutes=rnd.randint(-20, 40))])
    # Активні тривоги на кінець періоду: в 3 прифронтових областях
    active = {iso: period_end - timedelta(minutes=rnd.randint(5, 50)) for iso in rnd.sample(frontline_iso, 3)}
    alert_rows = []
    for (iso, typ), lst in intervals.items():
        lst.sort()
        merged = []
        for s, e in lst:
            if merged and s <= merged[-1][1] + timedelta(minutes=2):
                merged[-1][1] = max(merged[-1][1], e)
            else:
                merged.append([s, e])
        for s, e in merged:
            e = min(e, period_end)
            if s >= e:
                continue
            e = not_before(s, e, strict=True)
            if typ == "air_raid" and iso in active and e >= active[iso] - timedelta(minutes=1):
                continue
            alert_rows.append((s, oid[iso], typ, e))
    alert_rows += [(s, oid[iso], "air_raid", None) for iso, s in active.items()]
    alert_rows.sort(key=lambda r: r[0])
    alert_rows = [(o, t, ts(s), ts(e)) for s, o, t, e in alert_rows]
    w.copy("air_alerts", ["oblast_id", "alert_type", "started_at", "ended_at"], alert_rows)

    # =================== Модуль B ===================
    art_units = [u for u in front_units if u["branch"] == "artillery"]
    # Класи калібру за табл. 16 Порядку: ствольна артилерія до 120 / 120–160 / понад 160 мм;
    # міномети до 60 / 60–107 / понад 107 мм; РСЗВ: «Град» — середній, «Ураган»/«Смерч» — великий (рис. 20).
    caliber = {"mortar": [(82, "medium"), (120, "heavy")],
               "howitzer": [(122, "medium"), (152, "medium"), (203, "heavy")],
               "gun": [(100, "light"), (152, "medium")],
               "mlrs": [(122, "medium"), (220, "heavy"), (300, "heavy")],
               "tank": [(125, "medium")]}
    depth = {"mortar": (2, 6), "tank": (2, 5), "gun": (6, 15), "howitzer": (8, 22), "mlrs": (10, 32)}
    rounds_rng = {"mortar": (3, 20), "howitzer": (2, 14), "gun": (2, 10), "mlrs": (6, 40), "tank": (2, 8)}
    hour_w = {h: (1 if h < 5 or h > 21 else 3 if h in (5, 6, 20, 21) else 6) for h in range(24)}

    # Парк артпідрозділів (умовний): зразок, тип системи, калібр, вид боєприпасу, кількість у підрозділі
    PARKS = {
        "адн": [[("Д-30", "howitzer", 122, "how_122")], [("2С1 «Гвоздика»", "howitzer", 122, "how_122")],
                [("2С3 «Акація»", "howitzer", 152, "how_152")], [("М777", "howitzer", 155, "how_155")],
                [("Д-30", "howitzer", 122, "how_122"), ("Д-20", "howitzer", 152, "how_152")]],
        "реадн": [[("БМ-21 «Град»", "mlrs", 122, "mlrs_122")],
                  [("БМ-21 «Град»", "mlrs", 122, "mlrs_122"), ("9П140 «Ураган»", "mlrs", 220, "mlrs_220")]],
        "company": [[("2Б11", "mortar", 120, "mortar_120")]],
        "brigade": [[("2С7 «Піон»", "howitzer", 203, "how_203"), ("9А52 «Смерч»", "mlrs", 300, "mlrs_300")]],
    }
    CAL_CLASS = {("mortar", 120): "heavy", ("howitzer", 122): "medium", ("howitzer", 152): "medium",
                 ("howitzer", 155): "medium", ("howitzer", 203): "heavy", ("mlrs", 122): "medium",
                 ("mlrs", 220): "heavy", ("mlrs", 300): "heavy"}
    park = {}  # unit_id → [dict(model, system, mm, ammo, n)]
    for u in art_units:
        kind = "реадн" if "реадн" in u["short"] else u["echelon"] if u["echelon"] in ("company", "brigade") else "адн"
        models = rnd.choice(PARKS[kind])
        size = {"адн": 18, "реадн": 12, "company": 8, "brigade": 12}[kind]
        park[u["id"]] = [dict(model=m, system=s, mm=mm, ammo=a, n=size // len(models) + rnd.randint(-2, 1))
                         for m, s, mm, a in models]

    def own_fire(unit):
        """Система своїх засобів: для артпідрозділу — зі свого парку."""
        if unit["id"] in park:
            p = rnd.choices(park[unit["id"]], weights=[x["n"] for x in park[unit["id"]]])[0]
            return p["system"], p["mm"], CAL_CLASS[(p["system"], p["mm"])]
        system = wchoice(rnd, {"mortar": 50, "tank": 30, "gun": 20})
        cal, cls = rnd.choice(caliber[system])
        return system, cal, cls

    def nearest_art(lat, lon):
        return min(art_units, key=lambda x: (x["lat"] - lat) ** 2 + (x["lon"] - lon) ** 2 + rnd.random() * 0.002)

    art = []
    cb_rows = []
    incoming_by_unit_day = defaultdict(int)
    # Імовірність виявлення вогневої позиції: РЛС контрбатарейної боротьби краще бачить траєкторні цілі
    detect_p = {"mortar": 0.25, "howitzer": 0.5, "gun": 0.4, "mlrs": 0.6, "tank": 0.12}
    react_med = {"radar": 6, "uav": 11, "sound": 14, "visual": 18}  # медіана часу реакції, хв

    def counter_battery(when, system, cal, lat, lon, iso):
        if rnd.random() >= detect_p[system]:
            return
        means = wchoice(rnd, {"radar": 45, "uav": 35, "sound": 12, "visual": 8})
        det = when + timedelta(seconds=rnd.randint(20, 240))
        if det > period_end:
            return
        src = {"radar": "РЛР", "uav": "ПвР", "sound": "АР", "visual": "С"}[means]
        r_at = det + timedelta(minutes=max(1.0, rnd.lognormvariate(math.log(react_med[means]), 0.55)))
        if rnd.random() < 0.72 and r_at <= period_end:
            resp = nearest_art(lat, lon)
            r_sys, r_mm, r_cls = own_fire(resp)
            rounds = rnd.randint(*rounds_rng[r_sys])
            res = wchoice(rnd, {"destroyed": 10, "damaged": 17, "suppressed": 33, "no_effect": 15, "unknown": 25})
            # вогонь у відповідь — це й запис вихідного вогню модуля B
            art.append((r_at, "outgoing", r_sys, r_cls, r_mm, rounds, oid[iso], resp["id"], tid["military"], res,
                        src, reliability(rnd), round(lat, 5), round(lon, 5)))
            cb_rows.append((det, means, system, cal, oid[iso], round(lat, 5), round(lon, 5), resp["id"], r_at,
                            rounds, res, src, reliability(rnd)))
        else:
            cb_rows.append((det, means, system, cal, oid[iso], round(lat, 5), round(lon, 5), None, None, None,
                            "no_response", src, reliability(rnd)))
    for idx, dd in enumerate(days):
        week = idx // 7
        share_in = min(0.8, max(0.35, 0.58 + 0.14 * math.sin(week / 3.1) + rnd.uniform(-0.05, 0.05)))
        n = poisson(rnd, 70)
        base = datetime.combine(dd, datetime.min.time())
        for _ in range(n):
            t = rnd.uniform(0.0, 1.0)
            incoming = rnd.random() < share_in
            system = wchoice(rnd, {"mortar": 34, "howitzer": 30, "gun": 8, "mlrs": 10, "tank": 18} if incoming
                             else {"mortar": 28, "howitzer": 42, "gun": 6, "mlrs": 16, "tank": 8})
            cal, cls = rnd.choice(caliber[system])
            pos = line.place(rnd, t, depth[system], True, tries=8)
            if pos is None:
                continue
            lat, lon = pos
            iso = reg.find(lat, lon)
            when = base + timedelta(hours=wchoice(rnd, hour_w), minutes=rnd.randint(0, 59))
            if incoming:
                unit = nearest_front_unit(t)
                res = wchoice(rnd, {"destroyed": 3, "damaged": 10, "suppressed": 5, "no_effect": 52, "unknown": 30})
                tgt = wchoice(rnd, {"military": 72, "residential": 12, "transport": 6, "energy": 4, "other": 6})
                src = wchoice(rnd, {"АР": 45, "РЛР": 25, "С": 20, "ПвР": 10})
            else:
                unit = nearest_front_unit(t, art_units) if rnd.random() < 0.7 else nearest_front_unit(t)
                system, cal, cls = own_fire(unit)
                res = wchoice(rnd, {"destroyed": 12, "damaged": 18, "suppressed": 25, "no_effect": 20, "unknown": 25})
                tgt = "military"
                src = wchoice(rnd, {"ПвР": 50, "С": 30, "АР": 20})
            rounds = rnd.randint(*rounds_rng[system])
            if incoming:
                incoming_by_unit_day[(unit["id"], dd)] += rounds
                counter_battery(when, system, cal, lat, lon, iso)
            art.append((when, "incoming" if incoming else "outgoing", system, cls, cal, rounds, oid[iso],
                        unit["id"], tid[tgt], res, src, reliability(rnd), round(lat, 5), round(lon, 5)))
        # бої: додаткові події по ділянці
        for s, e, bt in battles:
            if s <= dd <= e:
                for _ in range(poisson(rnd, 25)):
                    t = bt + rnd.uniform(-0.06, 0.06)
                    pos = line.place(rnd, t, (2, 15), True, tries=6)
                    if pos is None:
                        continue
                    lat, lon = pos
                    iso = reg.find(lat, lon)
                    unit = nearest_front_unit(t)
                    system = wchoice(rnd, {"mortar": 40, "howitzer": 25, "tank": 20, "mlrs": 15})
                    cal, cls = rnd.choice(caliber[system])
                    rounds = rnd.randint(*rounds_rng[system])
                    incoming_by_unit_day[(unit["id"], dd)] += rounds
                    when = base + timedelta(hours=wchoice(rnd, hour_w), minutes=rnd.randint(0, 59))
                    counter_battery(when, system, cal, lat, lon, iso)
                    art.append((when, "incoming", system, cls, cal, rounds, oid[iso], unit["id"], tid["military"],
                                wchoice(rnd, {"destroyed": 4, "damaged": 12, "no_effect": 50, "unknown": 34}),
                                wchoice(rnd, {"АР": 50, "РЛР": 30, "С": 20}), reliability(rnd),
                                round(lat, 5), round(lon, 5)))
    art.sort(key=lambda r: r[0])
    w.copy("artillery_fire", ["occurred_at", "direction", "system_type", "caliber_class", "caliber_mm", "rounds",
                              "oblast_id", "unit_id", "target_category_id", "result", "info_source", "reliability",
                              "lat", "lon"],
           [(ts(r[0]), *r[1:]) for r in art])

    # --- контрбатарейна боротьба
    cb_rows.sort(key=lambda r: r[0])
    w.copy("counter_battery", ["detected_at", "detected_by", "enemy_system", "caliber_mm", "oblast_id", "lat", "lon",
                               "unit_id", "responded_at", "rounds", "result", "info_source", "reliability"],
           [(ts(r[0]), *r[1:8], ts(r[8]), *r[9:]) for r in cb_rows])

    # --- боєприпаси: витрата = вихідний вогонь артпідрозділу; підвезення раз на 3–6 діб; один період «снарядного голоду»
    ammo_of = {(p["system"], p["mm"]): p["ammo"] for ps in park.values() for p in ps}
    expended = defaultdict(int)
    for r in art:
        if r[1] == "outgoing" and r[7] in park:
            a = ammo_of.get((r[2], r[4]))
            if a:
                expended[(r[7], a, r[0].date())] += r[5]
    hunger_from = days[rnd.randint(60, max(61, len(days) - 60))]
    hunger = (hunger_from, hunger_from + timedelta(days=42))
    ammo_rows = []
    for uid in sorted(park):
        for a in sorted({p["ammo"] for p in park[uid]}):
            daily = [expended.get((uid, a, dd), 0) for dd in days]
            avg = max(1.0, sum(daily) / len(days))
            stock = int(avg * rnd.uniform(8, 14))
            nxt = rnd.randint(1, 5)
            for i, dd in enumerate(days):
                e, rec = daily[i], 0
                if i == nxt:
                    interval = rnd.randint(3, 6)
                    k = 0.55 if hunger[0] <= dd <= hunger[1] else 1.0
                    rec = max(0, int(k * (avg * interval * rnd.uniform(0.75, 1.2) + 0.3 * (avg * 10 - stock))))
                    nxt = i + interval
                if stock + rec < e:  # термінове підвезення, щоб виконати вогневе завдання
                    rec = e - stock + int(avg * rnd.uniform(1, 2.5))
                stock += rec - e
                ammo_rows.append((dd.isoformat(), uid, a, e, rec, stock))
    w.copy("ammo_supply", ["report_date", "unit_id", "ammo_type", "expended", "received", "stock"], ammo_rows)

    # --- стан артилерійського озброєння: щотижневе донесення (понеділок)
    eq_rows = []
    for uid in sorted(park):
        u = by_id[uid]
        for p in park[uid]:
            total, repair = p["n"], rnd.randint(0, 2)
            for wk in (dd for dd in days if dd.weekday() == 0):
                bf = max(battle_factor(wk + timedelta(days=k), u["t"]) for k in range(7))
                lost = sum(1 for _ in range(total - repair) if rnd.random() < 0.012 * bf)
                damaged = sum(1 for _ in range(total - repair - lost) if rnd.random() < 0.05 * bf)
                fixed = sum(1 for _ in range(repair) if rnd.random() < 0.45)
                total -= lost
                repair += damaged - fixed
                if total < p["n"] * 0.8 and rnd.random() < 0.35:  # надходження зразків на заміну
                    total += rnd.randint(1, 3)
                eq_rows.append((wk.isoformat(), uid, p["model"], p["system"], p["mm"], total, total - repair,
                                repair, lost))
    w.copy("artillery_equipment", ["report_date", "unit_id", "model", "system_type", "caliber_mm", "total",
                                   "operational", "in_repair", "lost"], eq_rows)

    # =================== Модуль C ===================
    # КАБ-влучання поблизу підрозділу теж додають експозицію
    kab_by_unit_day = defaultdict(int)
    for r in strikes:
        if r[2] == wid["guided_bomb"] and r[8] > 0:
            lat, lon = r[12], r[13]
            u = min(front_units, key=lambda x: (x["lat"] - lat) ** 2 + (x["lon"] - lon) ** 2)
            if (u["lat"] - lat) ** 2 + (u["lon"] - lon) ** 2 < 0.04:
                kab_by_unit_day[(u["id"], r[0].date())] += r[8]
    cause_share = {"artillery": 0.42, "uav": 0.27, "air_strike": 0.08, "mine": 0.08, "small_arms": 0.11,
                   "accident": 0.02, "other": 0.02}
    loss_rows = []
    for u in units:
        if u.get("deep"):
            # глибокий тил: нещасні випадки, хвороби та інше, зрідка — удари ударних БпЛА по тилових об'єктах (КАБ сюди не дістають)
            share = {"accident": 0.45, "other": 0.4, "uav": 0.15}
            lam_d = 0.012 * u["auth"] / 100
            for dd in days:
                for cause, sh in share.items():
                    wounded = poisson(rr, lam_d * sh)
                    killed = poisson(rr, lam_d * sh / (6 if cause != "uav" else 3))
                    if wounded + killed:
                        rtd = sum(1 for _ in range(wounded) if rr.random() < 0.4)
                        loss_rows.append((dd.isoformat(), u["id"], cause, killed, wounded, 0, rtd))
            continue
        rear = u["rear"]
        scale = {"brigade": 0.4, "battalion": 0.8, "company": 0.6, "regiment": 0.3, "corps": 0.05,
                 "command": 0.05}[u["echelon"]]
        for i, dd in enumerate(days):
            if rear:
                lam_w = 0.03 * scale + 0.0
                exp_art = exp_air = 0.0
            else:
                exp_art = 0.6 * incoming_by_unit_day.get((u["id"], dd), 0) + \
                    0.4 * incoming_by_unit_day.get((u["id"], dd - timedelta(days=1)), 0)
                exp_air = 0.6 * kab_by_unit_day.get((u["id"], dd), 0) + \
                    0.4 * kab_by_unit_day.get((u["id"], dd - timedelta(days=1)), 0)
                lam_w = scale * (0.1 + 0.07 * exp_art) * battle_factor(dd, u["t"])
            in_battle = not rear and battle_factor(dd, u["t"]) > 1
            for cause, share in cause_share.items():
                lam = lam_w * share
                if cause == "air_strike" and not rear:
                    lam += scale * 0.25 * exp_air
                if rear and cause not in ("accident", "other", "uav"):
                    continue
                wounded = poisson(rnd, lam)
                killed = poisson(rnd, lam / 3.5)
                missing = poisson(rnd, 0.35) if in_battle and cause in ("small_arms", "artillery") else 0
                if wounded + killed + missing == 0:
                    continue
                rtd = sum(1 for _ in range(wounded) if rnd.random() < 0.25)
                loss_rows.append((dd.isoformat(), u["id"], cause, killed, wounded, missing, rtd))
    w.copy("personnel_losses", ["report_date", "unit_id", "cause", "killed", "wounded", "missing",
                                "returned_to_duty"], loss_rows)

    # --- укомплектованість: наявність = попередня − втрати + повернуті до строю + поповнення
    def authorized(u) -> int:
        if u["echelon"] == "battalion":
            return {"tank": 260, "artillery": 300, "support": 420}.get(u["branch"], 450)
        return {"command": 320, "corps": 240, "brigade": 600, "regiment": 900, "company": 110}[u["echelon"]]

    out_by = defaultdict(int)
    back_by = defaultdict(int)
    for day_iso, uid, _cause, k, wd, m, rtd in loss_rows:
        d0 = date.fromisoformat(day_iso)
        out_by[(uid, d0)] += k + wd + m
        back_by[(uid, d0)] += rtd
        g = rr if by_id[uid].get("deep") else rnd
        for _ in range(wd - rtd):  # частина поранених повертається після лікування (2–6 тижнів)
            if g.random() < 0.5:
                back_by[(uid, d0 + timedelta(days=g.randint(14, 45)))] += 1
    str_rows = []
    for u in units:
        if u.get("deep"):
            # тил: укомплектованість висока; навчальний центр «дихає» — набір і випуск курсантів хвилями
            auth = u["auth"]
            training = u["branch"] == "training"
            present = int(auth * rr.uniform(0.82, 0.97))
            phase = rr.uniform(0, 2 * math.pi)
            for i, dd in enumerate(days):
                rep = 0
                if training:
                    cyc = math.sin(2 * math.pi * i / 45 + phase)   # курс ≈ 45 діб
                    want = auth * (0.78 + 0.18 * cyc)
                    if present < want:
                        rep = int(min(want - present + rr.randint(0, 15), auth * 0.08))
                    else:  # випуск: частина курсантів вибуває до бойових частин
                        present -= int(min(present - want, auth * rr.uniform(0.01, 0.05)))
                elif i % rr.randint(25, 40) == 0:
                    gap = auth * rr.uniform(0.93, 0.99) - present
                    rep = max(0, int(gap))
                present = max(0, min(int(auth * 1.02), present - out_by[(u["id"], dd)] + back_by[(u["id"], dd)] + rep))
                str_rows.append((dd.isoformat(), u["id"], auth, present, rep))
            continue
        auth = authorized(u)
        rear = u["rear"]
        present = int(auth * (rnd.uniform(0.9, 0.98) if rear else rnd.uniform(0.72, 0.9)))
        target = rnd.uniform(0.92, 0.99) if rear else rnd.uniform(0.66, 0.93)  # пріоритет поповнення різний
        nxt = rnd.randint(2, 14)
        for i, dd in enumerate(days):
            rep = 0
            if i >= nxt:
                # хвилі мобілізації: поповнення то інтенсивніше, то слабше (період ≈ 4 міс.)
                wave = 0.55 + 0.45 * math.sin(2 * math.pi * i / 120 + 0.8)
                gap = target * auth - present
                if gap > auth * 0.02:
                    rep = int(min(gap, auth * rnd.uniform(0.03, 0.12) * (0.3 + wave)))
                nxt = i + (rnd.randint(20, 40) if rear else rnd.randint(7, 18))
            present = max(0, min(int(auth * 1.02), present - out_by[(u["id"], dd)] + back_by[(u["id"], dd)] + rep))
            str_rows.append((dd.isoformat(), u["id"], auth, present, rep))
    w.copy("unit_strength", ["report_date", "unit_id", "authorized", "present", "replenished"], str_rows)

    # =================== Модуль D ===================
    # Відправник → отримувач (ОКП ОСУВ або КП ОТУ свого підпорядкування)
    senders = [u for u in units if u["id"] != osuv["id"] and not u.get("deep")]
    sender_w = [{"corps": 8, "brigade": 6, "battalion": 2, "company": 0.5, "regiment": 3}.get(u["echelon"], 2)
                for u in senders]

    def otu_of(u):
        while u and u["echelon"] != "corps":
            u = by_id.get(u["parent"])
        return u

    def recipient_for(u) -> int:
        otu = otu_of(u)
        if otu is None or otu["id"] == u["id"]:
            return osuv["id"]
        return otu["id"] if rnd.random() < 0.75 else osuv["id"]
    doc_hour_w = {h: (0.4 if h < 5 else 3.6 if h in (6, 7, 18, 19) else 2.0 if h in (5, 8, 17, 20) else 1.0)
                  for h in range(24)}
    urg_w = {"horizon": 2, "efir": 8, "buran": 20, "zlit": 30, "none": 40}
    type_by_urg = {
        "horizon": {"combat_report": 55, "combat_order": 30, "intel_summary": 15},
        "efir": {"combat_report": 40, "combat_order": 20, "preliminary_order": 15, "intel_summary": 25},
        "buran": {"combat_report": 30, "preliminary_order": 15, "request": 20, "intel_summary": 20, "directive": 15},
        "zlit": {"combat_report": 25, "request": 25, "info_report": 20, "logistics_request": 20, "directive": 10},
        "none": {"info_report": 35, "request": 25, "logistics_request": 25, "directive": 10, "combat_report": 5},
    }
    docs = []
    for dd in days:
        mult = 1.4 if dd in wave_days else 1.0
        if any(s <= dd <= e for s, e, _ in battles):
            mult += 0.12
        base = datetime.combine(dd, datetime.min.time())
        for _ in range(poisson(rnd, 112 * mult)):
            rec = base + timedelta(hours=wchoice(rnd, doc_hour_w), minutes=rnd.randint(0, 59),
                                   seconds=rnd.randint(0, 59))
            urg = wchoice(rnd, urg_w)
            norm = norm_min[urg]
            reg_delay = rnd.uniform(0, 2) if urg == "horizon" else rnd.uniform(1, min(15, norm * 0.15))
            registered = not_before(rec, rec + timedelta(minutes=reg_delay))
            proc = norm * rnd.lognormvariate(math.log(0.42), 0.5)
            completed = not_before(registered, max(rec + timedelta(minutes=proc), registered + timedelta(minutes=1)))
            status = "returned" if rnd.random() < 0.015 else "done"
            stuck = (period_end - rec) < timedelta(hours=72) and rnd.random() < 0.06  # черга на кінець періоду
            if completed > period_end or stuck:
                completed = None
                status = "new" if (period_end - registered) < timedelta(minutes=20) else "in_work"
            ch = wchoice(rnd, {"asu": 40, "radio": 35, "sys002": 25} if urg == "horizon" else
                         {"asu": 35, "sedo": 30, "sys002": 12, "sys001": 5, "courier": 5, "radio": 13})
            mark = None
            r = rnd.random()
            if urg in ("horizon", "efir") and r < 0.08:
                mark = "reverse_check"
            elif r < 0.06:
                mark = "control"
            elif r < 0.07:
                mark = "personal"
            elif r < 0.075:
                mark = "training"
            docs.append([rec, wchoice(rnd, type_by_urg[urg]), urg, mark,
                         wchoice(rnd, {"open": 55, "dsk": 40, "secret": 5}), ch,
                         rnd.choices(senders, weights=sender_w)[0]["id"], registered,
                         rec + timedelta(minutes=norm), completed, status])
            docs[-1].append(recipient_for(by_id[docs[-1][6]]))
    docs.sort(key=lambda r: r[0])
    seq_by_year = defaultdict(int)
    doc_rows = []
    for r in docs:
        yy = r[0].year % 100
        seq_by_year[yy] += 1
        doc_rows.append((f"ВХ-{seq_by_year[yy]:06d}/{yy:02d}", r[1], r[2], r[3], r[4], r[5], r[6],
                         ts(r[0]), ts(r[7]), ts(r[8]), ts(r[9]), r[10], r[11]))
    w.copy("incoming_documents", ["reg_number", "doc_type", "urgency", "special_mark", "access_level", "channel",
                                  "sender_unit_id", "received_at", "registered_at", "due_at", "completed_at",
                                  "status", "recipient_unit_id"], doc_rows)

    # --- метадані
    w.copy("dataset_meta", ["key", "value"], [
        ("generator_version", GEN_VERSION), ("seed", str(seed)),
        ("period_from", d_from.isoformat()), ("period_to", d_to.isoformat()),
        ("data_as_of", ts(period_end)), ("synthetic", "true"),
        ("disclaimer", "Синтетичні дані. Навчальний проєкт. Не відображають реальних подій."),
        ("deepstate_as_of", ds["datetime"] or ""),
    ])

    for tbl, col in (("oblasts", "id"), ("units", "id"), ("enemy_units", "id"), ("weapon_types", "id"), ("target_categories", "id"),
                     ("attack_waves", "id"), ("strike_events", "id"), ("air_alerts", "id"),
                     ("artillery_fire", "id"), ("personnel_losses", "id"), ("incoming_documents", "id"),
                     ("counter_battery", "id"), ("ammo_supply", "id"), ("artillery_equipment", "id"),
                     ("unit_strength", "id")):
        w.raw(f"SELECT setval(pg_get_serial_sequence('{tbl}', '{col}'), COALESCE((SELECT MAX({col}) FROM {tbl}), 1));\n")
    w.raw("ANALYZE;\n")
    return w


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", type=int, default=140)
    ap.add_argument("--from", dest="d_from", default="2025-11-01")
    ap.add_argument("--to", dest="d_to", default="2026-10-31")
    ap.add_argument("--out", default=str(OUT))
    a = ap.parse_args()
    w = build(a.seed, date.fromisoformat(a.d_from), date.fromisoformat(a.d_to))
    header = (
        "-- =====================================================================\n"
        f"-- СИНТЕТИЧНІ ДАНІ. Згенеровано backend/database/generate_seed.py v{GEN_VERSION}, seed={a.seed},\n"
        f"-- період {a.d_from} – {a.d_to}. Не редагувати вручну.\n"
        "-- =====================================================================\n"
        "SET client_encoding = 'UTF8';\nSET timezone = 'Europe/Kyiv';\n\n"
    )
    Path(a.out).write_text(header + "".join(w.parts), encoding="utf-8", newline="\n")
    for k, v in w.counts.items():
        print(f"{k:22s} {v:>7}")


if __name__ == "__main__":
    main()
