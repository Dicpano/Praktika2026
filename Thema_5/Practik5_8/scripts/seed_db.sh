#!/usr/bin/env bash
# Заповнити таблицю incidents тестовими даними (500 записів)
set -euo pipefail
cd "$(dirname "$0")/.."
python db/seed.py
