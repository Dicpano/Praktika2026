"""Службові ендпоінти та довідники."""
from fastapi import APIRouter, HTTPException

from ..db import all_rows, one_row
from ..filters import dataset_period
from ..schemas import Health

router = APIRouter(prefix="/api", tags=["службові"])


@router.get("/health", response_model=Health)
def health():
    try:
        one_row("SELECT 1 AS ok")
        return Health(status="ok", db="ok")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"БД недоступна: {type(e).__name__}") from e


@router.get("/meta")
def meta():
    rows = {r["key"]: r["value"] for r in all_rows("SELECT key, value FROM dataset_meta")}
    p_from, p_to = dataset_period()
    data_as_of = one_row("SELECT as_of AS t FROM v_as_of")["t"]
    return {**rows, "period_from": p_from, "period_to": p_to, "data_as_of": data_as_of}


DICTS = {
    "oblasts": "SELECT id, iso_code, name_ua, name_en, center_lat::float AS lat, center_lon::float AS lon, "
               "is_frontline, is_occupied FROM oblasts ORDER BY name_ua",
    "units": "SELECT u.id, u.short_name, u.name_ua, u.echelon, u.branch, u.parent_id, p.short_name AS parent, "
             "o.iso_code AS oblast, u.lat::float AS lat, u.lon::float AS lon, u.sidc, u.is_rear, "
             "u.is_command_post, u.origin "
             "FROM units u JOIN oblasts o ON o.id = u.oblast_id LEFT JOIN units p ON p.id = u.parent_id ORDER BY u.id",
    "weapon-types": "SELECT id, code, name_ua, category, sidc, color_hex, map_label FROM weapon_types ORDER BY id",
    "target-categories": "SELECT id, code, name_ua FROM target_categories ORDER BY id",
    "info-sources": "SELECT code, name_ua FROM info_sources ORDER BY code",
    "doc-norms": "SELECT urgency, name_ua, norm_min, sort_order, is_conditional FROM doc_sla_norms ORDER BY sort_order",
}


@router.get("/dict/{name}")
def dictionary(name: str):
    if name not in DICTS:
        raise HTTPException(404, "Невідомий довідник")
    return all_rows(DICTS[name])
