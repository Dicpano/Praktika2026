#!/usr/bin/env bash
# Застосувати db/schema.sql до бази з DATABASE_URL (.env або змінна середовища)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && export $(grep -v '^#' .env | xargs)
: "${DATABASE_URL:?DATABASE_URL не задано (див. .env.example)}"
psql -v ON_ERROR_STOP=1 -d "$DATABASE_URL" -f db/schema.sql
echo "Схему застосовано"
