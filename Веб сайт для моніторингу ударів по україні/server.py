"""
Локальний сервер для сайту моніторингу повітряних загроз України.

Робить, використовуючи лише стандартну бібліотеку Python
(жодних зовнішніх залежностей, npm тощо):
  1. Роздає статичні файли проєкту (index.html, css/, js/, data/).
  2. Проксує запити до RSS-стрічок новин (GET /api/rss?id=...),
     бо браузер не може напряму читати чужі RSS через CORS.
     Проксі приймає лише id зі списку data/rss-sources.json —
     довільний зовнішній URL з клієнта не приймається (щоб сервер
     не перетворився на відкритий проксі для будь-яких адрес).
  3. Проксує GET /api/alerts до офіційного API alerts.in.ua
     (реальний стан повітряних тривог по областях). Потребує
     API-токена — див. README.md, розділ "Реальні тривоги".
     Токен не передається клієнту: сервер додає його сам,
     фронтенд ходить лише на свій же /api/alerts.

Запуск:  python server.py [порт]     (за замовчуванням порт 8000)
"""

import json
import os
import sys
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.utils import parsedate_to_datetime
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parent
SOURCES_FILE = ROOT / "data" / "rss-sources.json"
CONFIG_FILE = ROOT / "config.local.json"
FETCH_TIMEOUT = 8
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

ATOM_NS = "{http://www.w3.org/2005/Atom}"

ALERTS_API_URL = "https://api.alerts.in.ua/v1/alerts/active.json"


def get_alerts_token():
    """Токен беремо з env ALERTS_API_TOKEN, або з config.local.json
    (цей файл — у .gitignore, у git не потрапляє)."""
    env_token = os.environ.get("ALERTS_API_TOKEN", "").strip()
    if env_token:
        return env_token
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, encoding="utf-8") as f:
                cfg = json.load(f)
            token = (cfg.get("alerts_api_token") or "").strip()
            return token or None
        except (json.JSONDecodeError, OSError):
            return None
    return None


def load_sources():
    with open(SOURCES_FILE, encoding="utf-8") as f:
        return {s["id"]: s for s in json.load(f)}


def normalize_date(raw):
    if not raw:
        return None
    raw = raw.strip()
    try:
        return parsedate_to_datetime(raw).isoformat()
    except (TypeError, ValueError):
        pass
    try:
        return raw.replace("Z", "+00:00")
    except Exception:
        return raw


def parse_feed(xml_bytes):
    root = ElementTree.fromstring(xml_bytes)
    items = []

    channel_items = root.findall("./channel/item")
    if channel_items:
        for item in channel_items:
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            pub_date = normalize_date(item.findtext("pubDate"))
            if title and link:
                items.append({"title": title, "link": link, "pubDate": pub_date})
        return items

    # Atom fallback
    entries = root.findall(f"./{ATOM_NS}entry")
    for entry in entries:
        title = (entry.findtext(f"{ATOM_NS}title") or "").strip()
        link_el = entry.find(f"{ATOM_NS}link")
        link = link_el.get("href") if link_el is not None else ""
        pub_date = normalize_date(
            entry.findtext(f"{ATOM_NS}updated") or entry.findtext(f"{ATOM_NS}published")
        )
        if title and link:
            items.append({"title": title, "link": link, "pubDate": pub_date})
    return items


def fetch_source(source, limit=15):
    result = {
        "id": source["id"],
        "name": source["name"],
        "scope": source["scope"],
        "oblastIso": source["oblastIso"],
        "items": [],
        "error": None,
    }
    try:
        req = urllib.request.Request(source["url"], headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            raw = resp.read()
        items = parse_feed(raw)
        for item in items:
            item["source"] = source["name"]
            item["scope"] = source["scope"]
            item["oblastIso"] = source["oblastIso"]
        result["items"] = items[:limit]
    except (urllib.error.URLError, ElementTree.ParseError, TimeoutError) as exc:
        result["error"] = str(exc)
    return result


def fetch_alerts():
    token = get_alerts_token()
    if not token:
        return {
            "configured": False,
            "reason": "no_token",
            "message": (
                "API-токен alerts.in.ua не налаштовано. Отримайте токен на "
                "https://alerts.in.ua/api-request і додайте його у config.local.json "
                "(див. config.example.json) або в змінну середовища ALERTS_API_TOKEN."
            ),
            "alerts": [],
        }

    req = urllib.request.Request(
        ALERTS_API_URL,
        headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            return {
                "configured": False,
                "reason": "invalid_token",
                "message": "Токен alerts.in.ua недійсний. Перевірте значення в config.local.json.",
                "alerts": [],
            }
        return {
            "configured": False,
            "reason": "upstream_error",
            "message": f"alerts.in.ua повернув помилку: HTTP {exc.code}",
            "alerts": [],
        }
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        return {
            "configured": False,
            "reason": "network_error",
            "message": f"Не вдалося звернутись до alerts.in.ua: {exc}",
            "alerts": [],
        }

    # Очікувана форма відповіді: {"alerts": [...]}. Про всяк випадок
    # приймаємо і "голий" список, якщо API поверне саме так.
    if isinstance(raw, dict):
        alerts = raw.get("alerts", [])
    elif isinstance(raw, list):
        alerts = raw
    else:
        alerts = []

    return {"configured": True, "reason": None, "message": None, "alerts": alerts}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/rss":
            self._handle_rss(parse_qs(parsed.query))
            return

        if parsed.path == "/api/rss/all":
            self._handle_rss_all()
            return

        if parsed.path == "/api/alerts":
            self._send_json(fetch_alerts())
            return

        super().do_GET()

    def _handle_rss(self, query):
        sources = load_sources()
        source_id = (query.get("id") or [None])[0]
        source = sources.get(source_id)
        if not source:
            self._send_json({"error": "unknown source id"}, status=404)
            return
        self._send_json(fetch_source(source))

    def _handle_rss_all(self):
        sources = list(load_sources().values())
        results = []
        with ThreadPoolExecutor(max_workers=min(8, len(sources)) or 1) as pool:
            futures = [pool.submit(fetch_source, s) for s in sources]
            for future in as_completed(futures):
                results.append(future.result())
        order = {s["id"]: i for i, s in enumerate(sources)}
        results.sort(key=lambda r: order.get(r["id"], 0))
        self._send_json(results)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Сервер запущено: http://127.0.0.1:{port}")
    print("Зупинити: Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nЗупинено.")


if __name__ == "__main__":
    main()
