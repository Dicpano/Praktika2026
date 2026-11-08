"""Спільні шматки SQL для роутерів."""

# Ряд періодів (день/тиждень) для заповнення пропусків нулями
SERIES = """SELECT generate_series(date_trunc(%(b)s, %(df)s::timestamp)::date, %(dt)s::date,
                                  ('1 ' || %(b)s)::interval)::date AS period"""


def feature_collection(rows: list[dict]) -> dict:
    feats = []
    for r in rows:
        lat, lon = r.pop("lat"), r.pop("lon")
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
                      "properties": r})
    return {"type": "FeatureCollection", "features": feats}
