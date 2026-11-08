"""Пул з'єднань psycopg 3. API працює під роллю dashboard_ro (лише SELECT)."""
from contextlib import contextmanager

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from . import config

pool = ConnectionPool(config.CONNINFO, min_size=1, max_size=8, open=False,
                      kwargs={"row_factory": dict_row, "autocommit": True})
writer = ConnectionPool(config.CONNINFO_RW, min_size=0, max_size=2, open=False,
                        kwargs={"row_factory": dict_row})


@contextmanager
def conn():
    with pool.connection() as c:
        yield c


def all_rows(sql: str, params: dict | None = None) -> list[dict]:
    with conn() as c:
        return c.execute(sql, params or {}).fetchall()


def one_row(sql: str, params: dict | None = None) -> dict | None:
    with conn() as c:
        return c.execute(sql, params or {}).fetchone()
