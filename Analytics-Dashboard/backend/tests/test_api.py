"""Тести API (pytest + httpx). Потрібна розгорнута БД (docker compose up db або локальний PostgreSQL)."""
import pytest
from fastapi.testclient import TestClient

from backend.app.main import app

P = {"date_from": "2026-10-01", "date_to": "2026-10-31"}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        if c.get("/api/health").status_code != 200:
            pytest.skip("БД недоступна")
        yield c


def test_health(client):
    assert client.get("/api/health").json()["status"] == "ok"


def test_meta(client):
    m = client.get("/api/meta").json()
    assert m["synthetic"] == "true" and m["period_to"] >= "2026-10-31" and m["deepstate_as_of"]


@pytest.mark.parametrize("name", ["oblasts", "units", "weapon-types", "target-categories", "info-sources",
                                  "doc-norms"])
def test_dicts(client, name):
    r = client.get(f"/api/dict/{name}")
    assert r.status_code == 200 and len(r.json()) > 0


def test_dict_unknown(client):
    assert client.get("/api/dict/nope").status_code == 404


@pytest.mark.parametrize("module,n", [("overview", 8), ("air", 2), ("artillery", 4), ("losses", 3), ("docs", 3)])
def test_kpi(client, module, n):
    r = client.get("/api/kpi", params={**P, "module": module})
    assert r.status_code == 200
    assert len(r.json()["items"]) == n


ENDPOINTS = [
    "/api/air/timeline", "/api/air/intercept-rate", "/api/air/by-oblast",
    "/api/alerts/stats", "/api/alerts/active",
    "/api/artillery/timeline", "/api/artillery/by-system", "/api/artillery/heatmap", "/api/artillery/by-oblast",
    "/api/artillery/geojson",
    "/api/losses/timeline", "/api/losses/by-cause", "/api/losses/by-unit", "/api/losses/correlation",
    "/api/docs/flow", "/api/docs/sla", "/api/docs/overdue", "/api/docs/by-type", "/api/docs/queue",
    "/api/map/units", "/api/map/contact-line", "/api/map/choropleth", "/api/dict-labels",
    "/api/air/impacts", "/api/map/enemy-units", "/api/map/flows", "/api/map/areas", "/api/entry/spec",
    "/api/artillery/counter-battery", "/api/artillery/cb-geojson", "/api/artillery/ammo", "/api/artillery/ammo-timeline",
    "/api/artillery/equipment", "/api/losses/strength", "/api/losses/strength-by-unit",
]


@pytest.mark.parametrize("url", ENDPOINTS)
def test_endpoints(client, url):
    r = client.get(url, params=P)
    assert r.status_code == 200, r.text
    assert r.json() is not None


def test_timeline_daily_series_has_no_gaps(client):
    rows = client.get("/api/artillery/timeline", params=P).json()["rows"]
    assert len(rows) == 31 * 2


def test_heatmap_24x7(client):
    assert len(client.get("/api/artillery/heatmap", params=P).json()) == 24 * 7


def test_filters_oblast(client):
    all_ = client.get("/api/air/by-oblast", params=P).json()
    one = client.get("/api/air/by-oblast", params={**P, "oblast": "UA-63"}).json()
    assert sum(r["launched"] for r in one) == next(r["launched"] for r in all_ if r["iso_code"] == "UA-63")


def test_period_limit(client):
    assert client.get("/api/air/by-oblast", params={"date_from": "2025-01-01", "date_to": "2026-10-31"}).status_code == 422
    assert client.get("/api/air/by-oblast", params={"date_from": "2026-10-10", "date_to": "2026-10-01"}).status_code == 422


def test_limit_cap(client):
    assert client.get("/api/air/impacts", params={**P, "limit": 5000}).status_code == 422


def test_sql_injection_is_parameter(client):
    r = client.get("/api/air/by-oblast", params={**P, "oblast": "UA-63' OR 1=1 --"})
    assert r.status_code == 200
    assert sum(x["launched"] for x in r.json()) == 0


@pytest.mark.parametrize("module", ["air", "alerts", "artillery", "counter_battery", "ammo", "equipment", "losses",
                                    "strength", "docs"])
def test_journal_and_csv(client, module):
    j = client.get(f"/api/journal/{module}", params={**P, "limit": 5}).json()
    assert j["total"] > 0 and len(j["rows"]) <= 5
    assert all(v is not None and v != "" for row in j["rows"] for v in row.values())  # без порожніх клітинок
    c = client.get(f"/api/export/{module}.csv", params=P)
    assert c.status_code == 200 and c.content.startswith(b"\xef\xbb\xbf")
    assert "№ з/п" in c.content.decode("utf-8-sig").splitlines()[1]


def test_losses_small_values_masked(client):
    rows = client.get("/api/journal/losses", params={**P, "limit": 200}).json()["rows"]
    vals = [r["wounded"] for r in rows]
    assert "<5" in vals
    assert not any(isinstance(v, int) and 1 <= v <= 4 for v in vals)


def test_docs_sla_norms_conditional(client):
    rows = client.get("/api/docs/sla", params=P).json()
    assert [r["urgency"] for r in rows] == ["horizon", "efir", "buran", "zlit", "none"]
    assert all(r["is_conditional"] for r in rows)


def test_units_readiness(client):
    rows = client.get("/api/map/units", params=P).json()
    assert {r["readiness"] for r in rows} <= {"green", "yellow", "red", "black"}
    assert any(r["echelon"] == "command" for r in rows)


def test_frontend_served(client):
    r = client.get("/")
    assert r.status_code == 200 and "<html" in r.text.lower()


def test_impacts_only_hits(client):
    fc = client.get("/api/air/impacts", params=P).json()
    assert fc["features"] and all(f["properties"]["hits"] > 0 for f in fc["features"])
    assert {f["properties"]["sidc"] for f in fc["features"]} == {"OHVPE----------"}  # п. 6.12 наказу № 140


def test_enemy_units_from_deepstate(client):
    d = client.get("/api/map/enemy-units").json()
    assert d["source"].startswith("DeepState") and len(d["rows"]) > 100
    assert all(r["sidc"][1] == "H" for r in d["rows"])


def test_flows_follow_command_chain(client):
    d = client.get("/api/map/flows", params=P).json()
    units = {u["id"]: u for u in client.get("/api/dict/units").json()}
    assert d["edges"] and all(units[e["from_id"]]["parent_id"] == e["to_id"] for e in d["edges"])
    assert {e["level"] for e in d["edges"]} <= {1, 2, 3, 4}


def test_entry_validation_and_delete(client):
    bad = client.post("/api/entry/strike", json={"occurred_at": "2026-10-20 10:00", "weapon": "КАБ",
                                                 "launched": 1, "hits": 2, "lat": 47.85, "lon": 35.15})
    assert bad.status_code == 422 and bad.json()["detail"]["errors"][0]["field"] == "hits"
    ok = client.post("/api/entry/strike", json={"occurred_at": "2026-10-20 10:00", "weapon": "КАБ",
                                                "launched": 1, "hits": 1, "lat": 47.85, "lon": 35.15})
    assert ok.status_code == 200, ok.text
    rid = ok.json()["ids"][0]
    rec = client.get("/api/entry/strike/records").json()
    assert any(r["id"] == rid and r["origin"] == "manual" for r in rec)
    assert client.delete(f"/api/entry/strike/{rid}").status_code == 200
    assert client.delete("/api/entry/strike/1").status_code == 404  # синтетичні не видаляються


def test_import_all_or_nothing(client):
    csv = ("oblast;alert_type;started_at;ended_at\n"
           "UA-63;Повітряна тривога;2026-10-20 10:00;2026-10-20 11:00\n"
           "UA-63;air_raid;2026-10-20 12:00;2026-10-20 11:00\n")
    r = client.post("/api/import/alert", content=csv.encode(), headers={"Content-Type": "text/csv"})
    assert r.status_code == 422 and r.json()["detail"]["errors"][0]["row"] == 2
    assert client.get("/api/entry/alert/records").json() == [] or all(
        x["at"][:10] != "2026-10-20" for x in client.get("/api/entry/alert/records").json())


def test_snapshot_js(client):
    r = client.get("/api/snapshot.js")
    assert r.status_code == 200 and r.text.startswith("/*") and "window.DATASET=" in r.text


def test_counter_battery_consistent(client):
    rows = client.get("/api/artillery/counter-battery", params=P).json()
    assert [r["detected_by"] for r in rows] == ["radar", "uav", "sound", "visual"]
    for r in rows:
        assert r["detected"] == sum(r[k] for k in ("destroyed", "damaged", "suppressed", "no_effect", "unknown",
                                                   "no_response"))
        assert r["responded"] == r["detected"] - r["no_response"]
    radar = rows[0]["median_min"]
    assert radar is not None and radar < rows[2]["median_min"]   # РЛС реагує швидше за звукометрію


def test_ammo_balance(client):
    rows = client.get("/api/artillery/ammo", params=P).json()
    assert rows and all(r["stock"] >= 0 and r["expended"] > 0 for r in rows)
    # витрата боєприпасів не може бути меншою за вихідний вогонь артпідрозділів зі свого парку — перевіряємо порядок
    tl = client.get("/api/artillery/ammo-timeline", params=P).json()
    assert sum(r["expended"] for r in tl["rows"]) == sum(r["expended"] for r in rows)


def test_equipment_and_strength(client):
    eq = client.get("/api/artillery/equipment", params=P).json()
    assert eq and all(r["operational"] + r["in_repair"] == r["total"] for r in eq)
    st = client.get("/api/losses/strength", params=P).json()
    assert len(st) == 31 and all(50 <= r["manning_pct"] <= 102 for r in st)
    k = {i["key"]: i["value"] for i in client.get("/api/kpi", params={**P, "module": "losses"}).json()["items"]}
    assert k["loss_manning"] == st[-1]["manning_pct"]


def test_rear_oblasts_have_strength(client):
    # тилові частини (навчальні центри, частини забезпечення): дані про особовий склад є в кожній
    # підконтрольній області, зокрема в тих, де немає фронтових підрозділів
    for iso in ("UA-68", "UA-46", "UA-21", "UA-30", "UA-05"):
        st = client.get("/api/losses/strength", params={**P, "oblast": iso}).json()
        assert len(st) == 31 and all(60 <= r["manning_pct"] <= 102 for r in st), iso


@pytest.mark.parametrize("kind,body", [
    ("counter_battery", {"detected_at": "2026-10-20 10:00", "detected_by": "radar", "enemy_system": "howitzer",
                         "caliber_mm": 152, "lat": 48.62, "lon": 38.12, "responded_at": "2026-10-20 10:07",
                         "rounds": 6, "result": "suppressed"}),
    ("ammo", {"report_date": "2026-10-20", "unit": 1, "ammo_type": "how_152", "expended": 10, "received": 0,
              "stock": 50}),
    ("equipment", {"report_date": "2026-10-19", "unit": 1, "model": "Тест-1", "system_type": "howitzer",
                   "operational": 4, "in_repair": 1}),
    ("strength", {"report_date": "2026-10-20", "unit": 1, "authorized": 100, "present": 80}),
])
def test_entry_new_kinds(client, kind, body):
    r = client.post(f"/api/entry/{kind}", json=body)
    if kind == "strength":   # на кожну добу вже є синтетичне донесення — дублікат має відхилятися
        assert r.status_code == 422 and "дублікат" in r.json()["detail"]["errors"][0]["message"]
        return
    assert r.status_code == 200, r.text
    assert client.delete(f"/api/entry/{kind}/{r.json()['ids'][0]}").status_code == 200


def test_counter_battery_rules(client):
    bad = client.post("/api/entry/counter_battery", json={
        "detected_at": "2026-10-20 10:00", "detected_by": "radar", "enemy_system": "howitzer", "lat": 48.62,
        "lon": 38.12, "responded_at": "2026-10-20 09:50"})
    assert bad.status_code == 422 and bad.json()["detail"]["errors"][0]["field"] == "responded_at"


def test_entry_token_required(client, monkeypatch):
    """Якщо задано ENTRY_TOKEN, запис без коду або з неправильним кодом відхиляється (401)."""
    from backend.app import config
    monkeypatch.setattr(config, "ENTRY_TOKEN", "secret-140")
    assert client.post("/api/entry/strike", json={}).status_code == 401
    assert client.post("/api/entry/strike", json={}, headers={"X-Entry-Token": "wrong"}).status_code == 401
    assert client.delete("/api/entry/strike/1", headers={"X-Entry-Token": "wrong"}).status_code == 401
    # з правильним кодом запит доходить до перевірки полів (422 — порожня форма)
    assert client.post("/api/entry/strike", json={}, headers={"X-Entry-Token": "secret-140"}).status_code == 422
    assert client.get("/api/entry/spec").json()["_auth"]["token_required"] is True


def test_pages_served(client):
    assert client.get("/print").status_code == 200
    assert client.get("/js/bundle.js").status_code == 200
