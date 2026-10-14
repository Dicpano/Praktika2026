"""Підготовка даних для дашборду 5.5.

Джерело: відкритий набір «2022 Russia Ukraine War» (Kaggle, P. Ivaniuk), що агрегує
щоденні зведення Генерального штабу ЗСУ. CSV лежать у репозиторії в
Thema_3/practike_3_3/archive (використовувались у практичних 3.3, 3.5, 4.3).

Скрипт рахує агрегати і записує їх у data/data.js як JS-змінну, щоб дашборд
відкривався просто з файлу (file://) без сервера і без fetch().

Запуск:  python prepare_data.py
"""
import json
import re
from collections import Counter
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
SRC = HERE.parents[1] / "Thema_3" / "practike_3_3" / "archive"
OUT = HERE / "data"

EQUIP = {  # колонка -> українська назва
    "tank": "Танки", "APC": "ББМ", "field artillery": "Артсистеми", "MRL": "РСЗВ",
    "anti-aircraft warfare": "Засоби ППО", "aircraft": "Літаки", "helicopter": "Гелікоптери",
    "drone": "БпЛА опер.-такт. рівня", "cruise missiles": "Крилаті ракети", "naval ship": "Кораблі / катери",
    "vehicles and fuel tanks": "Автотехніка та цистерни", "special equipment": "Спецтехніка",
}

# Координати населених пунктів, що фігурують у колонці "greatest losses direction"
DIRECTION_COORDS = {
    "Bakhmut": ("Бахмутський", 48.595, 38.000), "Donetsk": ("Донецький", 48.015, 37.802),
    "Kramatorsk": ("Краматорський", 48.738, 37.584), "Avdiivka": ("Авдіївський", 48.139, 37.742),
    "Lyman": ("Лиманський", 48.989, 37.802), "Kryvyi Rih": ("Криворізький", 47.910, 33.392),
    "Kurakhove": ("Курахівський", 47.983, 37.283), "Zaporizhzhia": ("Запорізький", 47.838, 35.139),
    "Sloviansk": ("Слов'янський", 48.853, 37.605), "Kharkiv": ("Харківський", 49.993, 36.230),
    "Sievierodonetsk": ("Сєвєродонецький", 48.948, 38.491), "Izyum": ("Ізюмський", 49.212, 37.256),
    "Mykolaiv": ("Миколаївський", 46.975, 31.994), "Kupiansk": ("Куп'янський", 49.711, 37.616),
    "Novopavlivsk": ("Новопавлівський", 48.130, 36.740), "Slobozhanskyi": ("Слобожанський", 50.150, 36.700),
    "Popasna": ("Попаснянський", 48.633, 38.383),
}


def main():
    eq = pd.read_csv(SRC / "russia_losses_equipment.csv", parse_dates=["date"]).sort_values("date")
    pe = pd.read_csv(SRC / "russia_losses_personnel.csv", parse_dates=["date"]).sort_values("date")
    corr = pd.read_csv(SRC / "russia_losses_equipment_correction.csv", parse_dates=["date"]).sort_values("date")

    df = pe[["date", "personnel"]].merge(eq, on="date", how="inner")
    cols = ["personnel"] + list(EQUIP)
    df[cols] = df[cols].ffill().fillna(0)
    daily = df[cols].diff().clip(lower=0)          # щоденний приріст (від'ємні корекції → 0)
    daily.iloc[0] = 0
    daily["date"] = df["date"]

    last, prev = df.iloc[-1], df.iloc[-2]

    # 1. Скалярні показники (KPI)
    kpi = {
        "date": f"{last.date:%Y-%m-%d}", "day": int(last.day),
        "personnel": int(last.personnel), "personnel_delta": int(last.personnel - prev.personnel),
        "tank": int(last.tank), "tank_delta": int(last.tank - prev.tank),
        "artillery": int(last["field artillery"]), "artillery_delta": int(last["field artillery"] - prev["field artillery"]),
        "drone": int(last.drone), "drone_delta": int(last.drone - prev.drone),
    }

    # 2. Часовий ряд (щоденні значення)
    series = {
        "dates": [f"{d:%Y-%m-%d}" for d in df.date],
        "personnel_cum": df.personnel.astype(int).tolist(),
        "personnel_daily": daily.personnel.astype(int).tolist(),
        "drone_daily": daily.drone.astype(int).tolist(),
        "artillery_daily": daily["field artillery"].astype(int).tolist(),
        "tank_daily": daily.tank.astype(int).tolist(),
    }

    # 3. Категоріальні дані: структура втрат техніки на останню дату
    structure = sorted(({"label": ua, "value": int(last[c])} for c, ua in EQUIP.items()),
                       key=lambda r: -r["value"])

    # 4. Порівняння періодів: середньодобові втрати за роками (рік неповний → середнє на добу)
    daily["year"] = daily.date.dt.year
    by_year = daily.iloc[1:].groupby("year")[["personnel", "tank", "field artillery", "drone"]].mean().round(1)
    years = {"years": [str(y) for y in by_year.index],
             "personnel": by_year.personnel.tolist(), "tank": by_year.tank.tolist(),
             "artillery": by_year["field artillery"].tolist(), "drone": by_year.drone.tolist()}

    # 5. Матриця: середньодобові втрати особового складу, рік × місяць
    daily["month"] = daily.date.dt.month
    mat = daily.iloc[1:].pivot_table(index="year", columns="month", values="personnel", aggfunc="mean").round(0)
    matrix = {"years": [str(y) for y in mat.index], "months": [int(m) for m in mat.columns],
              "values": [[None if pd.isna(v) else int(v) for v in row] for row in mat.to_numpy()]}

    # 6. Геопросторові дані: напрямки найбільших втрат (кількість діб)
    cnt = Counter()
    for v in eq["greatest losses direction"].dropna():
        for name in re.split(r",| and ", str(v)):
            name = name.strip()
            if name:
                cnt[name] += 1
    dated = eq.dropna(subset=["greatest losses direction"]).date
    geo = {"period": f"{dated.min():%Y-%m-%d} — {dated.max():%Y-%m-%d}",
           "points": [{"name": DIRECTION_COORDS[k][0], "lat": DIRECTION_COORDS[k][1],
                       "lon": DIRECTION_COORDS[k][2], "days": n}
                      for k, n in cnt.most_common() if k in DIRECTION_COORDS]}
    missing = [k for k in cnt if k not in DIRECTION_COORDS]
    assert not missing, f"немає координат для: {missing}"

    # 7. Табличні дані: журнал корекцій даних
    corr_cols = [c for c in corr.columns if c not in ("date", "day")]
    corrections = []
    for _, r in corr.iterrows():
        changes = {EQUIP.get(c, "Особовий склад" if c == "personnel" else c): int(r[c])
                   for c in corr_cols if pd.notna(r[c]) and r[c] != 0}
        if changes:
            corrections.append({"date": f"{r.date:%Y-%m-%d}", "day": int(r.day), "changes": changes})

    data = {"source": "Генштаб ЗСУ (через Kaggle-набір «2022 Russia Ukraine War», P. Ivaniuk)",
            "kpi": kpi, "series": series, "structure": structure, "years": years,
            "matrix": matrix, "geo": geo, "corrections": corrections}

    OUT.mkdir(exist_ok=True)
    (OUT / "data.js").write_text("// Згенеровано prepare_data.py — не редагувати вручну\n"
                                 "window.DATA = " + json.dumps(data, ensure_ascii=False) + ";\n",
                                 encoding="utf-8")
    print(f"data/data.js: {len(series['dates'])} днів, {len(geo['points'])} напрямків, "
          f"{len(corrections)} корекцій; останні дані {kpi['date']}")


if __name__ == "__main__":
    main()
