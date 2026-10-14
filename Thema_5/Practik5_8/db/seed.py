"""Генерація тестових (умовних) даних для таблиці incidents.

500 записів за останні 90 днів: 5 секторів, 6 напрямків, 5 типів подій,
intensity 1..50. Дані синтетичні та навчальні, реальних подій не відображають.

Запуск:  python db/seed.py   (DATABASE_URL береться з .env або змінної середовища)
"""
import os
import random
from datetime import datetime, timedelta
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

N_RECORDS = 500
DAYS = 90
SEED = 42

SECTORS = ["Сектор А", "Сектор Б", "Сектор В", "Сектор Г", "Сектор Д"]
# напрямок -> вага (частота подій)
DIRECTIONS = {"Північний": 1.0, "Північно-Східний": 1.6, "Східний": 2.6,
              "Південно-Східний": 2.0, "Південний": 1.2, "Західний": 0.4}
# тип події -> (вага, середня інтенсивність)
EVENT_TYPES = {"Обстріл": (3.0, 22), "Атака БпЛА": (2.6, 18), "Розвідка": (2.0, 8),
               "Штурмові дії": (1.2, 35), "Логістика": (1.0, 6)}
SOURCES = ["Спостережний пост", "Аеророзвідка", "Радіоперехоплення", "Звіт підрозділу", "ОСІНТ"]
SUMMARY = {
    "Обстріл": "Зафіксовано обстріл позицій, {sector}.",
    "Атака БпЛА": "Виявлено застосування ударних БпЛА, {direction} напрямок.",
    "Розвідка": "Активність розвідувальних груп противника, {sector}.",
    "Штурмові дії": "Спроба штурмових дій, {direction} напрямок; бій триває.",
    "Логістика": "Помічено рух логістичних колон противника, {sector}.",
}


def generate(now=None):
    rng = random.Random(SEED)
    now = (now or datetime.now()).replace(second=0, microsecond=0)
    start = now - timedelta(days=DAYS)
    rows = []
    for _ in range(N_RECORDS):
        # активність повільно зростає до кінця періоду + менше подій уночі
        day = DAYS * (rng.random() ** 0.8)
        ts = start + timedelta(days=day)
        hour = int(rng.triangular(0, 24, 14)) % 24
        ts = ts.replace(hour=hour, minute=rng.randrange(60))
        if ts > now:
            ts = now - timedelta(minutes=rng.randrange(1, 600))
        sector = rng.choice(SECTORS)
        direction = rng.choices(list(DIRECTIONS), weights=DIRECTIONS.values())[0]
        etype = rng.choices(list(EVENT_TYPES), weights=[w for w, _ in EVENT_TYPES.values()])[0]
        mean = EVENT_TYPES[etype][1]
        intensity = max(1, min(50, int(rng.gauss(mean, mean * 0.35))))
        rows.append((ts, sector, direction, etype, intensity, rng.choice(SOURCES),
                     SUMMARY[etype].format(sector=sector, direction=direction.lower())))
    return rows


def main():
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL не задано (див. .env.example)")
    rows = generate()
    with psycopg2.connect(url) as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE incidents RESTART IDENTITY")
        cur.executemany(
            "INSERT INTO incidents (occurred_at, sector, direction, event_type, intensity, source, summary) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)", rows)
    print(f"Додано {len(rows)} записів у incidents")


if __name__ == "__main__":
    main()
