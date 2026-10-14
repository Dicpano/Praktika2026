#!/usr/bin/env bash
# Мінімальна перевірка працездатності API (API має бути запущено)
set -euo pipefail
cd "$(dirname "$0")/.."
python scripts/smoke_test.py "${1:-http://localhost:8000}"
