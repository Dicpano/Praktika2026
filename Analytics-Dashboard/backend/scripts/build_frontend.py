"""Збірка фронтенду для відкриття з будь-якого комп'ютера (у т. ч. як файл, без сервера).

Браузери не завантажують ES-модулі зі сторінки, відкритої як file://, тому:
  1. src/*.js (ES-модулі, вихідний код) → js/bundle.js і js/print.bundle.js (класичні скрипти);
  2. межі областей + окупована/«сіра» зони DeepState → data/geo.js (window.GEO);
     офлайн-підкладка Natural Earth (backend/database/sources/basemap.json) → data/basemap.js (window.BASEMAP);
  3. шрифти Volja → css/fonts.css з data:-URI (без окремих запитів до файлів).

Запуск з кореня проєкту:  python -m backend.scripts.build_frontend
Знімок бази для офлайн-режиму формується окремо:  python -m backend.scripts.export_snapshot
"""
import base64
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FE = ROOT / "frontend"
JS_SRC = FE / "src"                      # вихідні ES-модулі
SRC = ROOT / "backend" / "database" / "sources"

IMPORT_RE = re.compile(r"^import\s+(?:\{([^}]*)\}|\*\s+as\s+(\w+))\s+from\s+'([^']+)';\s*$", re.M)
EXPORT_RE = re.compile(r"^export\s+(?:(async\s+)?function\s+(\w+)|class\s+(\w+)|const\s+(\w+)|let\s+(\w+))", re.M)


def module_id(path: Path) -> str:
    return path.relative_to(JS_SRC).as_posix()


def bundle(entry: Path) -> str:
    order: list[Path] = []
    seen: set[Path] = set()

    def visit(p: Path, stack: tuple = ()):
        if p in stack:
            raise SystemExit(f"Циклічний імпорт: {' -> '.join(map(str, stack + (p,)))}")
        if p in seen:
            return
        for m in IMPORT_RE.finditer(p.read_text(encoding="utf-8")):
            visit((p.parent / m.group(3)).resolve(), stack + (p,))
        seen.add(p)
        order.append(p)

    visit(entry.resolve())
    parts = ["/* Зібрано backend/scripts/build_frontend.py з модулів frontend/src/*.js. Не редагувати вручну. */",
             "(function () {", "'use strict';", "const __M = {};"]
    for p in order:
        code = p.read_text(encoding="utf-8")
        names = []

        def imp(m, here=p):
            target = module_id((here.parent / m.group(3)).resolve())
            if m.group(2):
                return f"const {m.group(2)} = __M[{json.dumps(target)}];"
            items = [x.strip() for x in m.group(1).split(",") if x.strip()]
            spec = ", ".join(f"{a.split(' as ')[0].strip()}: {a.split(' as ')[1].strip()}" if " as " in a else a
                             for a in items)
            return f"const {{ {spec} }} = __M[{json.dumps(target)}];"

        code = IMPORT_RE.sub(imp, code)
        for m in EXPORT_RE.finditer(code):
            names.append(next(g for g in m.groups()[1:] if g))
        code = re.sub(r"^export\s+", "", code, flags=re.M)
        if re.search(r"^\s*(import|export)\s", code, re.M):
            raise SystemExit(f"Непідтримуваний import/export у {p}")
        parts.append(f"// ---- {module_id(p)} ----")
        parts.append(f"__M[{json.dumps(module_id(p))}] = (function () {{\n{code}\nreturn {{ {', '.join(names)} }};\n}})();")
    parts.append("})();")
    return "\n".join(parts) + "\n"


def round_coords(obj, nd=4):
    if isinstance(obj, list):
        if obj and isinstance(obj[0], (int, float)):
            return [round(x, nd) for x in obj]
        return [round_coords(x, nd) for x in obj]
    return obj


def _dp(pts: list, tol: float) -> list:
    """Спрощення ламаної (Дуглас — Пекер, ітеративно). tol — у градусах."""
    if len(pts) < 5:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = pts[a][:2], pts[b][:2]
        dx, dy = x2 - x1, y2 - y1
        norm = (dx * dx + dy * dy) ** 0.5
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i][0], pts[i][1]
            # кінці збігаються (замкнене кільце) — відстань до точки, інакше — до прямої
            d = (abs(dy * px - dx * py + x2 * y1 - y2 * x1) / norm if norm
                 else ((px - x1) ** 2 + (py - y1) ** 2) ** 0.5)
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def simplify(coords, tol: float):
    """Спрощує всі кільця (Polygon / MultiPolygon / список кілець); кільце лишається замкненим і ≥ 4 точок."""
    if coords and isinstance(coords[0][0], (int, float)):
        out = _dp(coords, tol)
        return out if len(out) >= 4 else coords
    return [simplify(c, tol) for c in coords]


def build_geo() -> str:
    # Спрощення для карти: межі областей ±0,003° (≈ 300 м; 26,7 → 14,8 тис. точок), зони DeepState ±0,0008° (≈ 80 м) —
    # на масштабах дашборду різниці не видно, а карта масштабується помітно швидше.
    obl = json.loads((SRC / "ukraine-oblasts.geojson").read_text(encoding="utf-8"))
    for f in obl["features"]:
        f["geometry"]["coordinates"] = round_coords(simplify(f["geometry"]["coordinates"], 0.003), 4)
    ds = json.loads((SRC / "deepstate.json").read_text(encoding="utf-8"))
    geo = {"oblasts": obl, "occupied": round_coords(simplify(ds["occupied"], 0.0008)),
           "grey": round_coords(simplify(ds["grey"], 0.0008)),
           "deepstate": {"source": ds["source"], "as_of": ds["datetime"]}}
    return ("/* Межі областей (geoBoundaries, CC BY 4.0) і зони DeepStateMap. Зібрано build_frontend.py. */\n"
            f"window.GEO={json.dumps(geo, ensure_ascii=False, separators=(',', ':'))};\n")


def build_basemap() -> str:
    # Офлайн-підкладка (Natural Earth) — готується скриптом backend/database/sources/update_basemap.py
    data = (SRC / "basemap.json").read_text(encoding="utf-8")
    return ("/* Підкладка карти без інтернету: Natural Earth 1:10m (суспільне надбання). Зібрано build_frontend.py. */\n"
            f"window.BASEMAP={data};\n")


FONT_CSS = """/*
 * Шрифти дашборду (зібрано build_frontend.py: файли з frontend/fonts/ вбудовано як data:-URI,
 * щоб шрифт працював і тоді, коли сторінку відкрито як файл).
 * Volja — фірмовий шрифт ЗСУ («UAF Sans»): заголовки, вкладки, кнопки, KPI, графіки; довгий текст — системним шрифтом.
 * Обмеження файлів: у Regular немає гліфів % + ʼ; у Black ще й - ( ) / « » №.
 * Тому стек завжди закінчується системним шрифтом: браузер підставляє відсутні символи з нього.
 */

@font-face {
  font-family: "Volja";
  src: url("data:font/woff2;base64,{regular}") format("woff2");
  font-weight: 100 600;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: "Volja";
  src: url("data:font/ttf;base64,{black}") format("truetype");
  font-weight: 700 900;
  font-style: normal;
  font-display: swap;
}

:root {
  /* Volja — фірмовий шрифт для заголовків, вкладок, кнопок, KPI, підписів знаків і графіків.
     Volja має лише великі літери, тому довгий текст (описи, легенда, таблиці, форми, спливні вікна)
     набирається системним шрифтом — інакше абзаци з великих літер важко читати. */
  --font-ui: "Volja", "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif;
  --font-text: "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-display: var(--font-ui);
  --font-body: var(--font-text);
  --font-print: "Times New Roman", Times, serif;
}

body { font-family: var(--font-body); }
h1, h2, h3, .page-title, .kpi-value, .kpi-label, .chart-title, header.top, nav.tabs, .btn, .filters label,
table.t th, .map-panel legend, .seg button, .imp-tag { font-family: var(--font-display); }
"""


def b64(name: str) -> str:
    return base64.b64encode((FE / "fonts" / name).read_bytes()).decode()


def main() -> None:
    out = {
        FE / "js" / "bundle.js": bundle(JS_SRC / "app.js"),
        FE / "js" / "print.bundle.js": bundle(JS_SRC / "print.js"),
        FE / "data" / "geo.js": build_geo(),
        FE / "data" / "basemap.js": build_basemap(),
        FE / "css" / "fonts.css": FONT_CSS.replace("{regular}", b64("Volja-Regular.woff2"))
                                          .replace("{black}", b64("Volja-Black.ttf")),
    }
    for path, text in out.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        print(f"{path.relative_to(ROOT)}: {len(text.encode('utf-8')) / 1024:.0f} КБ")


if __name__ == "__main__":
    main()
