"""Налаштування з оточення (.env). Секрети в git не зберігаються."""
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]          # корінь проєкту
BACKEND_DIR = ROOT / "backend"
DATABASE_DIR = BACKEND_DIR / "database"            # SQL, генератор, джерела геоданих
SOURCES_DIR = DATABASE_DIR / "sources"
load_dotenv(ROOT / ".env")

DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = int(os.getenv("DB_PORT", "5433"))   # 5433 — порт контейнера db на цьому ПК (docker-compose.yml)
DB_NAME = os.getenv("DB_NAME", "dashboard")
DB_USER = os.getenv("DB_RO_USER", "dashboard_ro")
DB_PASSWORD = os.getenv("DB_RO_PASSWORD", "dashboard_ro_local")
DB_RW_USER = os.getenv("DB_RW_USER", "dashboard_rw")
DB_RW_PASSWORD = os.getenv("DB_RW_PASSWORD", "dashboard_rw_local")
FRONTEND_DIR = Path(os.getenv("FRONTEND_DIR", str(ROOT / "frontend")))
# Код доступу для внесення/видалення записів (заголовок X-Entry-Token). Порожньо — без коду (локальний стенд).
ENTRY_TOKEN = os.getenv("ENTRY_TOKEN", "").strip()
TZ = "Europe/Kyiv"
MAX_PERIOD_DAYS = 366
MAX_LIMIT = 1000

CONNINFO = (
    f"host={DB_HOST} port={DB_PORT} dbname={DB_NAME} user={DB_USER} password={DB_PASSWORD} "
    f"options='-c timezone={TZ} -c default_transaction_read_only=on -c statement_timeout=5000'"
)
# Окрема роль лише для внесення записів (INSERT/DELETE таблиць фактів)
CONNINFO_RW = (
    f"host={DB_HOST} port={DB_PORT} dbname={DB_NAME} user={DB_RW_USER} password={DB_RW_PASSWORD} "
    f"options='-c timezone={TZ} -c statement_timeout=15000'"
)
