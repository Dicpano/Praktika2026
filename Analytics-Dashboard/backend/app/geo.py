"""Визначення області за координатами (point-in-polygon по межах geoBoundaries, без PostGIS)."""
import json
from functools import lru_cache

from . import config

GEOJSON = config.ROOT / "db" / "sources" / "ukraine-oblasts.geojson"


def _in_ring(x: float, y: float, ring) -> bool:
    inside, j = False, len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


@lru_cache(maxsize=1)
def _regions():
    data = json.loads(GEOJSON.read_text(encoding="utf-8"))
    out = []
    for f in data["features"]:
        g = f["geometry"]
        parts = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        xs = [p[0] for part in parts for p in part[0]]
        ys = [p[1] for part in parts for p in part[0]]
        out.append((f["properties"]["iso"], parts, (min(xs), min(ys), max(xs), max(ys))))
    # м. Київ і Севастополь — всередині інших областей, тому перевіряються першими
    out.sort(key=lambda r: r[0] not in ("UA-30", "UA-40"))
    return out


def find_oblast(lat: float, lon: float) -> str | None:
    for iso, parts, (x0, y0, x1, y1) in _regions():
        if x0 <= lon <= x1 and y0 <= lat <= y1:
            for part in parts:
                if _in_ring(lon, lat, part[0]) and not any(_in_ring(lon, lat, h) for h in part[1:]):
                    return iso
    return None
