"""Внесення даних: форма дашборду (один запис) та імпорт CSV/Excel (пакет рядків, «все або нічого»).

Записи позначаються origin = 'manual' (форма) або 'import' (файл). Видаляти можна лише їх — синтетичні
дані захищені. Запис виконується окремою роллю dashboard_rw (INSERT/DELETE), решта API — лише читання.
Excel (.xlsx) розбирається у браузері (SheetJS) і надходить сюди як JSON-рядки; CSV можна надіслати
і напряму (Content-Type: text/csv, роздільник «;» або «,»).
"""
import csv
import io
import re
import secrets
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from psycopg import errors as pg_errors

from .. import config
from ..db import all_rows, writer
from ..geo import find_oblast
from ..labels import LABELS
from ..sidc import caliber_class, unit_sidc

router = APIRouter(prefix="/api", tags=["Внесення даних"])


def require_entry_token(request: Request) -> None:
    """Захист запису: якщо в .env задано ENTRY_TOKEN, POST/DELETE приймаються лише із заголовком X-Entry-Token."""
    if not config.ENTRY_TOKEN:
        return
    got = request.headers.get("X-Entry-Token", "")
    if not secrets.compare_digest(got.encode("utf-8"), config.ENTRY_TOKEN.encode("utf-8")):
        raise HTTPException(401, "Потрібен код доступу для внесення даних (ENTRY_TOKEN)")


WRITE = [Depends(require_entry_token)]

E = LABELS  # скорочення
RESULT_FIRE = ["destroyed", "damaged", "suppressed", "no_effect", "unknown"]  # без «вогонь не відкривався»

# Поле: (ключ, підпис, тип, обов'язкове, довідка/параметри)
# Типи: ts (дата й час, Київ), date, int, num, enum:<LABELS-ключ>, oblast, unit, cp (пункт управління),
#       weapon, target, source, rel (достовірність A1–F6), text, bool, lat, lon
SPEC: dict[str, dict] = {
    "strike": {
        "title": "Повітряний удар (місце ураження)", "table": "strike_events",
        "fields": [
            ("occurred_at", "Дата і час", "ts", True, None),
            ("weapon", "Засіб ураження", "weapon", True, None),
            ("launched", "Запущено, од.", "int", True, {"min": 1}),
            ("intercepted", "Збито, од.", "int", False, {"min": 0}),
            ("suppressed", "Подавлено РЕБ, од.", "int", False, {"min": 0}),
            ("hits", "Влучань, од.", "int", False, {"min": 0}),
            ("damage_level", "Ступінь руйнувань (0–3)", "int", False, {"min": 0, "max": 3}),
            ("target", "Категорія об'єкта", "target", False, None),
            ("lat", "Широта", "lat", True, None),
            ("lon", "Довгота", "lon", True, None),
            ("oblast", "Область (якщо порожньо — за координатами)", "oblast", False, None),
            ("info_source", "Джерело інформації", "source", False, None),
            ("reliability", "Достовірність (A1–F6)", "rel", False, None),
        ]},
    "alert": {
        "title": "Повітряна тривога", "table": "air_alerts",
        "fields": [
            ("oblast", "Область", "oblast", True, None),
            ("alert_type", "Тип тривоги", "enum:alert_type", True, None),
            ("started_at", "Початок", "ts", True, None),
            ("ended_at", "Відбій (порожньо — триває)", "ts", False, None),
        ]},
    "artillery": {
        "title": "Артилерійський обстріл / вогневе ураження", "table": "artillery_fire",
        "fields": [
            ("occurred_at", "Дата і час", "ts", True, None),
            ("direction", "Напрям вогню", "enum:direction", True, None),
            ("system_type", "Тип системи", "enum:system_type", True, None),
            ("caliber_mm", "Калібр, мм", "int", False, {"min": 20, "max": 400}),
            ("caliber_class", "Клас калібру (порожньо — за калібром)", "enum:caliber_class", False, None),
            ("rounds", "Пострілів", "int", True, {"min": 1}),
            ("unit", "Підрозділ (по якому / який вів вогонь)", "unit", False, None),
            ("target", "Категорія об'єкта", "target", False, None),
            ("result", "Результат", "enum:result", False, {"only": RESULT_FIRE}),
            ("lat", "Широта", "lat", True, None),
            ("lon", "Довгота", "lon", True, None),
            ("oblast", "Область (якщо порожньо — за координатами)", "oblast", False, None),
            ("info_source", "Джерело інформації", "source", False, None),
            ("reliability", "Достовірність (A1–F6)", "rel", False, None),
        ]},
    "counter_battery": {
        "title": "Контрбатарейна боротьба (виявлена вогнева позиція)", "table": "counter_battery",
        "fields": [
            ("detected_at", "Виявлено (дата і час)", "ts", True, None),
            ("detected_by", "Засіб виявлення", "enum:detected_by", True, None),
            ("enemy_system", "Система противника", "enum:system_type", True, None),
            ("caliber_mm", "Калібр, мм", "int", False, {"min": 20, "max": 400}),
            ("lat", "Широта позиції", "lat", True, None),
            ("lon", "Довгота позиції", "lon", True, None),
            ("oblast", "Область (якщо порожньо — за координатами)", "oblast", False, None),
            ("unit", "Підрозділ, що відкрив вогонь у відповідь", "unit", False, None),
            ("responded_at", "Відкрито вогонь (порожньо — не відкривався)", "ts", False, None),
            ("rounds", "Пострілів у відповідь", "int", False, {"min": 1}),
            ("result", "Результат", "enum:result", False, None),
            ("info_source", "Джерело інформації", "source", False, None),
            ("reliability", "Достовірність (A1–F6)", "rel", False, None),
        ]},
    "ammo": {
        "title": "Рух боєприпасів (добове донесення)", "table": "ammo_supply",
        "fields": [
            ("report_date", "Дата донесення", "date", True, None),
            ("unit", "Підрозділ", "unit", True, None),
            ("ammo_type", "Вид боєприпасів", "enum:ammo_type", True, None),
            ("expended", "Витрачено за добу, шт.", "int", False, {"min": 0}),
            ("received", "Надійшло за добу, шт.", "int", False, {"min": 0}),
            ("stock", "Залишок на кінець доби, шт.", "int", True, {"min": 0}),
        ]},
    "equipment": {
        "title": "Стан артилерійського озброєння (донесення)", "table": "artillery_equipment",
        "fields": [
            ("report_date", "Дата донесення", "date", True, None),
            ("unit", "Підрозділ", "unit", True, None),
            ("model", "Зразок озброєння (напр. Д-30, М777)", "text", True, {"max": 32}),
            ("system_type", "Тип системи", "enum:system_type", True, {"only": ["mortar", "howitzer", "gun", "mlrs"]}),
            ("caliber_mm", "Калібр, мм", "int", False, {"min": 20, "max": 400}),
            ("operational", "Справні, од.", "int", True, {"min": 0}),
            ("in_repair", "У ремонті, од.", "int", False, {"min": 0}),
            ("lost", "Втрачено за період донесення, од.", "int", False, {"min": 0}),
        ]},
    "strength": {
        "title": "Укомплектованість особовим складом (добове донесення)", "table": "unit_strength",
        "fields": [
            ("report_date", "Дата донесення", "date", True, None),
            ("unit", "Підрозділ", "unit", True, None),
            ("authorized", "За штатом, осіб", "int", True, {"min": 1}),
            ("present", "У наявності, осіб", "int", True, {"min": 0}),
            ("replenished", "Прибуло поповнення, осіб", "int", False, {"min": 0}),
        ]},
    "losses": {
        "title": "Втрати особового складу (агрегат за добу)", "table": "personnel_losses",
        "fields": [
            ("report_date", "Дата донесення", "date", True, None),
            ("unit", "Підрозділ", "unit", True, None),
            ("cause", "Причина", "enum:cause", True, None),
            ("killed", "Безповоротні, осіб", "int", False, {"min": 0}),
            ("wounded", "Санітарні, осіб", "int", False, {"min": 0}),
            ("missing", "Зниклі безвісти, осіб", "int", False, {"min": 0}),
            ("returned_to_duty", "Повернуто до строю, осіб", "int", False, {"min": 0}),
        ]},
    "document": {
        "title": "Вхідний документ ОКП", "table": "incoming_documents",
        "fields": [
            ("reg_number", "Реєстраційний номер (порожньо — автоматично)", "text", False, {"max": 16}),
            ("doc_type", "Вид документа", "enum:doc_type", True, None),
            ("urgency", "Терміновість", "enum:urgency", True, None),
            ("special_mark", "Особлива відмітка", "enum:special_mark", False, None),
            ("access_level", "Гриф (синт.)", "enum:access_level", False, None),
            ("channel", "Канал надходження", "enum:channel", True, None),
            ("sender", "Відправник", "unit", True, None),
            ("recipient", "Отримувач (ОКП / КП)", "cp", True, None),
            ("received_at", "Надійшов", "ts", True, None),
            ("completed_at", "Опрацьовано (порожньо — в роботі)", "ts", False, None),
            ("status", "Стан (порожньо — за датою опрацювання)", "enum:status", False, None),
        ]},
    "unit": {
        "title": "Підрозділ / орган управління (умовний)", "table": "units",
        "fields": [
            ("short_name", "Скорочена назва", "text", True, {"max": 32}),
            ("name_ua", "Повна назва", "text", True, {"max": 128}),
            ("echelon", "Ланка", "enum:echelon", True, {"only": ["command", "corps", "brigade", "regiment",
                                                                  "battalion", "company"]}),
            ("branch", "Рід військ", "enum:branch", True, {"only": ["mech", "tank", "artillery", "air_defense",
                                                                      "airborne", "support", "hq", "recon",
                                                                      "marine", "training", "signal",
                                                                      "engineer", "maintenance", "medical"]}),
            ("parent", "Старший начальник", "unit", False, None),
            ("lat", "Широта", "lat", True, None),
            ("lon", "Довгота", "lon", True, None),
            ("oblast", "Область (якщо порожньо — за координатами)", "oblast", False, None),
            ("is_command_post", "Пункт управління, що приймає документи (так/ні)", "bool", False, None),
            ("is_rear", "Тиловий (так/ні)", "bool", False, None),
        ]},
}

MIN_DATE = date(2022, 2, 24)
TS_FORMATS = ("%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S",
              "%d.%m.%Y %H:%M", "%d.%m.%Y %H:%M:%S", "%d.%m.%y %H:%M")
DATE_FORMATS = ("%Y-%m-%d", "%d.%m.%Y", "%d.%m.%y")
TRUE = {"так", "true", "1", "yes", "y", "+", "т"}
FALSE = {"ні", "false", "0", "no", "n", "-", "н", ""}


class RowError(Exception):
    def __init__(self, field: str, message: str):
        super().__init__(message)
        self.field, self.message = field, message


def _refs() -> dict:
    """Довідники для перетворення значень (код, назва або скорочення → id)."""
    def idx(rows, keys):
        m = {}
        for r in rows:
            for k in keys:
                if r.get(k) is not None:
                    m[str(r[k]).strip().lower()] = r
        return m
    return {
        "oblast": idx(all_rows("SELECT id, iso_code, name_ua, name_en FROM oblasts"), ["iso_code", "name_ua", "name_en"]),
        "unit": idx(all_rows("SELECT id, short_name, name_ua, echelon, is_command_post FROM units"),
                    ["id", "short_name", "name_ua"]),
        "weapon": idx(all_rows("SELECT id, code, name_ua, map_label FROM weapon_types w WHERE (SELECT COUNT(*) "
                               "FROM weapon_types x WHERE x.map_label = w.map_label) = 1"), ["map_label"])
                  | idx(all_rows("SELECT id, code, name_ua, map_label FROM weapon_types"), ["code", "name_ua"]),
        "target": idx(all_rows("SELECT id, code, name_ua FROM target_categories"), ["code", "name_ua"]),
        "source": idx(all_rows("SELECT code, name_ua FROM info_sources"), ["code", "name_ua"]),
        "norms": {r["urgency"]: r["norm_min"] for r in all_rows("SELECT urgency, norm_min FROM doc_sla_norms")},
    }


def _ts(v: str, key: str) -> datetime:
    for fmt in TS_FORMATS:
        try:
            d = datetime.strptime(v, fmt)
            break
        except ValueError:
            continue
    else:
        raise RowError(key, f"дата і час «{v}» не розпізнані (очікується РРРР-ММ-ДД ГГ:ХХ або ДД.ММ.РРРР ГГ:ХХ)")
    if d.date() < MIN_DATE or d > datetime.now() + timedelta(days=1):
        raise RowError(key, "дата поза допустимим діапазоном (з 24.02.2022 до сьогодні)")
    return d


def _date(v: str, key: str) -> date:
    for fmt in DATE_FORMATS:
        try:
            d = datetime.strptime(v, fmt).date()
            break
        except ValueError:
            continue
    else:
        raise RowError(key, f"дата «{v}» не розпізнана (очікується РРРР-ММ-ДД або ДД.ММ.РРРР)")
    if d < MIN_DATE or d > date.today() + timedelta(days=1):
        raise RowError(key, "дата поза допустимим діапазоном")
    return d


def _num(v: str, key: str) -> float:
    try:
        return float(v.replace(",", ".").replace(" ", ""))
    except ValueError:
        raise RowError(key, f"«{v}» — не число") from None


def _parse(kind: str, v, key: str, opts: dict | None, refs: dict):
    if v is None or (isinstance(v, str) and v.strip() == ""):
        return None
    if isinstance(v, bool):
        v = "так" if v else "ні"
    v = str(v).strip()
    opts = opts or {}
    if kind == "ts":
        return _ts(v, key)
    if kind == "date":
        return _date(v, key)
    if kind == "int":
        n = _num(v, key)
        if n != int(n):
            raise RowError(key, "потрібне ціле число")
        n = int(n)
        if "min" in opts and n < opts["min"] or "max" in opts and n > opts["max"]:
            raise RowError(key, f"значення поза межами {opts.get('min', '…')}–{opts.get('max', '…')}")
        return n
    if kind == "lat":
        n = _num(v, key)
        if not 44.0 <= n <= 52.5:
            raise RowError(key, "широта поза межами України (44–52,5)")
        return round(n, 5)
    if kind == "lon":
        n = _num(v, key)
        if not 22.0 <= n <= 40.5:
            raise RowError(key, "довгота поза межами України (22–40,5)")
        return round(n, 5)
    if kind == "bool":
        lv = v.lower()
        if lv in TRUE:
            return True
        if lv in FALSE:
            return False
        raise RowError(key, "очікується «так» або «ні»")
    if kind == "text":
        if len(v) > opts.get("max", 200):
            raise RowError(key, f"задовго (до {opts.get('max', 200)} символів)")
        return v
    if kind == "rel":
        v = v.upper()
        if not re.fullmatch(r"[A-F][1-6]", v):
            raise RowError(key, "достовірність у форматі A1–F6 (літера — джерело, цифра — інформація)")
        return v
    if kind.startswith("enum:"):
        labels = E[kind[5:]]
        allowed = opts.get("only", list(labels))
        lv = v.lower()
        for code in allowed:
            if lv == code or lv == labels.get(code, "").lower():
                return code
        raise RowError(key, f"«{v}» — немає в переліку: " + ", ".join(labels.get(c, c) for c in allowed))
    ref = refs["unit" if kind == "cp" else kind].get(v.lower())
    if ref is None:
        raise RowError(key, f"«{v}» не знайдено в довіднику")
    if kind == "cp" and not ref["is_command_post"]:
        raise RowError(key, f"«{ref['short_name']}» не є пунктом управління, що приймає документи")
    return ref


def _row(kind: str, raw: dict, refs: dict, n: int) -> dict:
    """Перевіряє один рядок і повертає значення для INSERT (колонки таблиці)."""
    vals = {}
    for key, label, t, req, opts in SPEC[kind]["fields"]:
        v = _parse(t, raw.get(key, raw.get(label)), key, opts, refs)
        if v is None and req:
            raise RowError(key, f"обов'язкове поле «{label}» не заповнене")
        vals[key] = v
    out: dict = {}
    if "lat" in vals:
        if vals["oblast"] is None:
            iso = find_oblast(vals["lat"], vals["lon"])
            if iso is None:
                raise RowError("lat", "координати поза територією України")
            vals["oblast"] = refs["oblast"][iso.lower()]
        out.update(lat=vals["lat"], lon=vals["lon"])
    if vals.get("oblast") is not None:
        out["oblast_id"] = vals["oblast"]["id"]
    if kind == "strike":
        i, s, h = vals["intercepted"] or 0, vals["suppressed"] or 0, vals["hits"] or 0
        if i + s + h > vals["launched"]:
            raise RowError("hits", "збито + подавлено + влучань більше, ніж запущено")
        out.update(occurred_at=vals["occurred_at"], weapon_type_id=vals["weapon"]["id"], launched=vals["launched"],
                   intercepted=i, suppressed=s, hits=h, damage_level=vals["damage_level"] or 0,
                   target_category_id=vals["target"]["id"] if vals["target"] else None,
                   info_source=vals["info_source"]["code"] if vals["info_source"] else None,
                   reliability=vals["reliability"])
    elif kind == "alert":
        if vals["ended_at"] and vals["ended_at"] <= vals["started_at"]:
            raise RowError("ended_at", "відбій має бути пізніше початку")
        out.update(alert_type=vals["alert_type"], started_at=vals["started_at"], ended_at=vals["ended_at"])
    elif kind == "artillery":
        cls = vals["caliber_class"]
        if cls is None:
            if vals["caliber_mm"] is None:
                raise RowError("caliber_mm", "вкажіть калібр або клас калібру")
            cls = caliber_class(vals["system_type"], vals["caliber_mm"])
        out.update(occurred_at=vals["occurred_at"], direction=vals["direction"], system_type=vals["system_type"],
                   caliber_class=cls, caliber_mm=vals["caliber_mm"], rounds=vals["rounds"],
                   unit_id=vals["unit"]["id"] if vals["unit"] else None,
                   target_category_id=vals["target"]["id"] if vals["target"] else None,
                   result=vals["result"] or "unknown",
                   info_source=vals["info_source"]["code"] if vals["info_source"] else None,
                   reliability=vals["reliability"])
    elif kind == "counter_battery":
        det, resp, res = vals["detected_at"], vals["responded_at"], vals["result"]
        if resp is None:
            if res not in (None, "no_response"):
                raise RowError("responded_at", "результат вогню вказано, а час відкриття вогню — ні")
            res = "no_response"
        else:
            if resp < det:
                raise RowError("responded_at", "вогонь відкрито раніше, ніж виявлено позицію")
            if res == "no_response":
                raise RowError("result", "вказано час відкриття вогню — результат не може бути «вогонь не відкривався»")
            res = res or "unknown"
        out.update(detected_at=det, detected_by=vals["detected_by"], enemy_system=vals["enemy_system"],
                   caliber_mm=vals["caliber_mm"], unit_id=vals["unit"]["id"] if vals["unit"] and resp else None,
                   responded_at=resp, rounds=vals["rounds"] if resp else None, result=res,
                   info_source=vals["info_source"]["code"] if vals["info_source"] else None,
                   reliability=vals["reliability"])
    elif kind == "ammo":
        out.update(report_date=vals["report_date"], unit_id=vals["unit"]["id"], ammo_type=vals["ammo_type"],
                   expended=vals["expended"] or 0, received=vals["received"] or 0, stock=vals["stock"])
    elif kind == "equipment":
        op, rep = vals["operational"], vals["in_repair"] or 0
        out.update(report_date=vals["report_date"], unit_id=vals["unit"]["id"], model=vals["model"],
                   system_type=vals["system_type"], caliber_mm=vals["caliber_mm"], total=op + rep, operational=op,
                   in_repair=rep, lost=vals["lost"] or 0)
    elif kind == "strength":
        if vals["present"] > vals["authorized"] * 1.5:
            raise RowError("present", "у наявності більше ніж півтора штату — перевірте значення")
        out.update(report_date=vals["report_date"], unit_id=vals["unit"]["id"], authorized=vals["authorized"],
                   present=vals["present"], replenished=vals["replenished"] or 0)
    elif kind == "losses":
        nums = {k: vals[k] or 0 for k in ("killed", "wounded", "missing", "returned_to_duty")}
        if not any(nums.values()):
            raise RowError("killed", "усі показники нульові — запис не має сенсу")
        out.update(report_date=vals["report_date"], unit_id=vals["unit"]["id"], cause=vals["cause"], **nums)
    elif kind == "document":
        rec, comp = vals["received_at"], vals["completed_at"]
        if comp and comp < rec:
            raise RowError("completed_at", "опрацьовано раніше, ніж надійшов")
        status = vals["status"] or ("done" if comp else "new")
        if (status in ("done", "returned")) != (comp is not None):
            raise RowError("status", "стан «Виконано/Повернуто» потребує дати опрацювання, інші — ні")
        if vals["sender"]["id"] == vals["recipient"]["id"]:
            raise RowError("recipient", "відправник і отримувач збігаються")
        reg = vals["reg_number"] or f"M{datetime.now():%y%m%d%H%M%S}{n % 1000:03d}"
        out.update(reg_number=reg, doc_type=vals["doc_type"], urgency=vals["urgency"],
                   special_mark=vals["special_mark"], access_level=vals["access_level"] or "open",
                   channel=vals["channel"], sender_unit_id=vals["sender"]["id"],
                   recipient_unit_id=vals["recipient"]["id"], received_at=rec, registered_at=rec,
                   due_at=rec + timedelta(minutes=refs["norms"][vals["urgency"]]), completed_at=comp, status=status)
    elif kind == "unit":
        out.update(short_name=vals["short_name"], name_ua=vals["name_ua"], echelon=vals["echelon"],
                   branch=vals["branch"], parent_id=vals["parent"]["id"] if vals["parent"] else None,
                   sidc=unit_sidc(vals["branch"], vals["echelon"]),
                   is_command_post=bool(vals["is_command_post"]), is_rear=bool(vals["is_rear"]))
    if kind != "unit":
        out["is_synthetic"] = False
    return out


def _db_message(e: Exception) -> str:
    if isinstance(e, pg_errors.UniqueViolation):
        return "такий запис уже існує (дублікат)"
    if isinstance(e, pg_errors.CheckViolation):
        return "порушено правило перевірки даних у БД"
    if isinstance(e, pg_errors.ForeignKeyViolation):
        return "посилання на неіснуючий або використаний запис"
    return f"помилка БД: {type(e).__name__}"


def _insert(kind: str, rows: list[dict], origin: str) -> dict:
    if kind not in SPEC:
        raise HTTPException(404, "Невідомий тип запису")
    if not rows:
        raise HTTPException(422, {"errors": [{"row": 0, "field": None, "message": "немає рядків для внесення"}]})
    if len(rows) > 5000:
        raise HTTPException(413, "За один раз — не більше 5000 рядків")
    refs = _refs()
    prepared, errors = [], []
    for n, raw in enumerate(rows, start=1):
        try:
            prepared.append(_row(kind, raw, refs, n))
        except RowError as e:
            errors.append({"row": n, "field": e.field, "message": e.message})
    if errors:
        raise HTTPException(422, {"errors": errors[:200], "total_errors": len(errors)})
    table = SPEC[kind]["table"]
    ids = []
    with writer.connection() as c:
        try:
            with c.transaction():
                for n, r in enumerate(prepared, start=1):
                    r = {**r, "origin": origin}
                    cols = ", ".join(r)
                    ph = ", ".join(f"%({k})s" for k in r)
                    try:
                        with c.transaction():
                            ids.append(c.execute(f"INSERT INTO {table} ({cols}) VALUES ({ph}) RETURNING id",
                                                 r).fetchone()["id"])
                    except pg_errors.Error as e:
                        errors.append({"row": n, "field": None, "message": _db_message(e)})
                if errors:
                    raise _Rollback
        except _Rollback:
            raise HTTPException(422, {"errors": errors[:200], "total_errors": len(errors)}) from None
    return {"inserted": len(ids), "ids": ids, "origin": origin}


class _Rollback(Exception):
    pass


async def _rows_from_request(request: Request) -> list[dict]:
    ctype = request.headers.get("content-type", "")
    if ctype.startswith("text/csv") or ctype.startswith("text/plain"):
        text = (await request.body()).decode("utf-8-sig")
        dialect = ";" if text.split("\n", 1)[0].count(";") >= text.split("\n", 1)[0].count(",") else ","
        return [dict(r) for r in csv.DictReader(io.StringIO(text), delimiter=dialect)]
    body = await request.json()
    rows = body.get("rows") if isinstance(body, dict) else body
    if isinstance(rows, dict):
        rows = [rows]
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        raise HTTPException(422, "Очікується JSON {rows: [...]} або CSV")
    return rows


@router.get("/entry/spec")
def spec():
    """Опис форм і шаблонів імпорту (поля, підписи, переліки допустимих значень)."""
    out = {}
    for kind, s in SPEC.items():
        fields = []
        for key, label, t, req, opts in s["fields"]:
            f = {"key": key, "label": label, "type": t, "required": req}
            if t.startswith("enum:"):
                lab = E[t[5:]]
                f["options"] = [{"value": c, "label": lab[c]} for c in (opts or {}).get("only", list(lab))]
            if opts and ("min" in opts or "max" in opts):
                f.update({k: opts[k] for k in ("min", "max") if k in opts})
            fields.append(f)
        out[kind] = {"title": s["title"], "fields": fields}
    out["_auth"] = {"token_required": bool(config.ENTRY_TOKEN)}
    return out


@router.post("/entry/{kind}", dependencies=WRITE)
async def add_record(kind: str, request: Request):
    """Один запис із форми дашборду (origin = 'manual')."""
    body = await request.json()
    return _insert(kind, [body], "manual")


@router.post("/import/{kind}", dependencies=WRITE)
async def import_rows(kind: str, request: Request):
    """Пакетний імпорт (CSV або JSON-рядки з Excel). Помилка в будь-якому рядку — не вноситься нічого."""
    return _insert(kind, await _rows_from_request(request), "import")


@router.post("/import/{kind}/check")
async def check_rows(kind: str, request: Request):
    """Перевірка без внесення (попередній перегляд імпорту)."""
    if kind not in SPEC:
        raise HTTPException(404, "Невідомий тип запису")
    rows = await _rows_from_request(request)
    refs, errors = _refs(), []
    for n, raw in enumerate(rows, start=1):
        try:
            _row(kind, raw, refs, n)
        except RowError as e:
            errors.append({"row": n, "field": e.field, "message": e.message})
    return {"rows": len(rows), "valid": len(rows) - len(errors), "errors": errors[:200]}


RECENT = {
    "strike": "SELECT s.id, s.origin, s.occurred_at AS at, w.name_ua || ', ' || o.name_ua AS summary "
              "FROM strike_events s JOIN weapon_types w ON w.id = s.weapon_type_id JOIN oblasts o ON o.id = s.oblast_id",
    "alert": "SELECT a.id, a.origin, a.started_at AS at, o.name_ua AS summary FROM air_alerts a "
             "JOIN oblasts o ON o.id = a.oblast_id",
    "artillery": "SELECT a.id, a.origin, a.occurred_at AS at, a.system_type || ', ' || a.rounds || ' пострілів' AS summary "
                 "FROM artillery_fire a",
    "losses": "SELECT l.id, l.origin, l.report_date::timestamptz AS at, u.short_name || ', ' || l.cause AS summary "
              "FROM personnel_losses l JOIN units u ON u.id = l.unit_id",
    "document": "SELECT d.id, d.origin, d.received_at AS at, d.reg_number || ', ' || u.short_name AS summary "
                "FROM incoming_documents d JOIN units u ON u.id = d.sender_unit_id",
    "unit": "SELECT u.id, u.origin, NULL::timestamptz AS at, u.short_name || ' — ' || u.name_ua AS summary FROM units u",
    "counter_battery": "SELECT c.id, c.origin, c.detected_at AS at, c.detected_by || ', ' || c.enemy_system || ', ' "
                       "|| c.result AS summary FROM counter_battery c",
    "ammo": "SELECT a.id, a.origin, a.report_date::timestamptz AS at, u.short_name || ', ' || a.ammo_type || ', залишок ' "
            "|| a.stock AS summary FROM ammo_supply a JOIN units u ON u.id = a.unit_id",
    "equipment": "SELECT e.id, e.origin, e.report_date::timestamptz AS at, u.short_name || ', ' || e.model || ', справні ' "
                 "|| e.operational || ' з ' || e.total AS summary FROM artillery_equipment e JOIN units u ON u.id = e.unit_id",
    "strength": "SELECT s.id, s.origin, s.report_date::timestamptz AS at, u.short_name || ', ' || s.present || ' з ' "
                "|| s.authorized AS summary FROM unit_strength s JOIN units u ON u.id = s.unit_id",
}
ALIAS = {"strike": "s", "alert": "a", "artillery": "a", "losses": "l", "document": "d", "unit": "u",
         "counter_battery": "c", "ammo": "a", "equipment": "e", "strength": "s"}


@router.get("/entry/{kind}/records")
def records(kind: str):
    """Останні записи, внесені вручну або імпортом (їх можна видалити)."""
    if kind not in RECENT:
        raise HTTPException(404, "Невідомий тип запису")
    a = ALIAS[kind]
    return all_rows(f"{RECENT[kind]} WHERE {a}.origin <> 'synthetic' ORDER BY {a}.id DESC LIMIT 200")


@router.delete("/entry/{kind}/{rid}", dependencies=WRITE)
def delete_record(kind: str, rid: int):
    if kind not in SPEC:
        raise HTTPException(404, "Невідомий тип запису")
    with writer.connection() as c:
        try:
            with c.transaction():
                r = c.execute(f"DELETE FROM {SPEC[kind]['table']} WHERE id = %(id)s AND origin <> 'synthetic' "
                              f"RETURNING id", {"id": rid}).fetchone()
        except pg_errors.ForeignKeyViolation:
            raise HTTPException(409, "На підрозділ посилаються інші записи — спочатку видаліть їх") from None
    if r is None:
        raise HTTPException(404, "Запис не знайдено або він синтетичний (синтетичні дані не видаляються)")
    return {"deleted": rid}
