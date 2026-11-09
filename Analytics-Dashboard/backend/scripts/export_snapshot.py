"""Експорт знімка бази у frontend/data/dataset.js (офлайн-режим дашборду).

Запуск з кореня проєкту:  python -m backend.scripts.export_snapshot  [шлях]
Параметри підключення — з .env (DB_HOST, DB_PORT, DB_NAME, DB_RO_USER, DB_RO_PASSWORD).
"""
import sys
from pathlib import Path

from ..app import config, snapshot
from ..app.db import pool


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else config.FRONTEND_DIR / "data" / "dataset.js"
    pool.open(wait=True)
    try:
        js = snapshot.to_js(snapshot.build())
    finally:
        pool.close()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(js, encoding="utf-8")
    print(f"{out}: {len(js.encode('utf-8')) / 1e6:.1f} МБ")


if __name__ == "__main__":
    main()
