"""Smoke test: запити до /health, /filters, /kpi, /trend і перевірка ключів відповіді.

Використання:  python scripts/smoke_test.py [http://localhost:8000]
"""
import json
import sys
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000").rstrip("/")

CHECKS = [
    ("/health", lambda d: d.get("status") == "ok"),
    ("/filters", lambda d: {"sectors", "directions", "event_types", "min_date", "max_date"} <= d.keys()),
    ("/kpi", lambda d: {"total_incidents", "total_intensity", "avg_intensity", "top_direction"} <= d.keys()),
    ("/trend", lambda d: isinstance(d, list) and (not d or {"t", "value"} <= d[0].keys())),
]

failed = 0
for path, check in CHECKS:
    try:
        with urllib.request.urlopen(BASE + path, timeout=10) as r:
            ok = r.status == 200 and check(json.load(r))
    except Exception as e:  # noqa: BLE001 — для smoke-тесту достатньо повідомити про помилку
        ok, path = False, f"{path} ({e})"
    print(f"{'OK  ' if ok else 'FAIL'} {path}")
    failed += not ok

print("OK" if not failed else f"FAILED: {failed} перевірок")
sys.exit(1 if failed else 0)
