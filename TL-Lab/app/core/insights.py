"""Готові тексти для звіту і слайдів: «Чому так вийшло», дані, кроки адаптації, автоматичний висновок.

Те саме, що показують вкладки «Оцінювання», — щоб звіт не був порожнім, навіть якщо поля не заповнені вручну.
"""
from __future__ import annotations

import re

from core import config, data, experiment


# ---------------------------------------------------------------- «Чому так вийшло»
def why_for(key: str, entry: dict | None = None, extra=None) -> list[dict]:
    from modules import explain
    entry = entry if entry is not None else experiment.latest(key)
    if not entry:
        return []
    extra = extra if extra is not None else (experiment.load_extra(key) or {})
    m = entry.get("metrics") or {}
    if key == "m1":
        from modules import m1_vision as mod
        return explain.m1(m, mod.LABELS_UA, entry.get("params")) + explain.m1_loss(extra.get("loss"))
    if key == "m2":
        from modules import m2_docs as mod
        return explain.m2(m, mod.LABELS_UA, extra.get("freeze"))
    if key == "m3":
        from modules import m3_audio as mod
        return explain.m3(m, mod.LABELS_UA, (extra.get("params") or {}).get("low_data", []), extra.get("freeze"))
    if key == "m4":
        return explain.m4(extra) if extra else []
    if key == "m5":
        from modules import m5_llm as mod
        return explain.m5(m.get("by_mode") or {}, mod.MODES)
    if key == "m6":
        from modules import m6_rl as mod
        p = extra.get("params") or entry.get("params") or {}
        env = p.get("env", "cartpole")
        return explain.m6(m, p, extra.get("curve"), mod.ENVS[env]["range"], mod.ENVS[env]["labels"], m.get("frozen"))
    return []


def plain(md: str) -> str:
    """Markdown/LaTeX -> простий текст для слайдів."""
    s = re.sub(r"\$\$[\s\S]+?\$\$", "", md)
    s = re.sub(r"\$([^$]+)\$", r"\1", s)
    s = s.replace("**", "").replace("\\pm", "±").replace("\\sqrt", "√")
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)
    return re.sub(r"[ \t]+", " ", s).strip()


# ---------------------------------------------------------------- дані
def data_summary(key: str) -> dict:
    """{'unit': 'фото', 'rows': [(назва, кількість)], 'note': '...'}"""
    try:
        if key == "m1":
            from modules import m1_vision as mod
            _, labels = mod.dataset()
            return {"unit": "фото", "rows": [(mod.LABELS_UA[c], labels.count(c)) for c in mod.CLASSES],
                    "note": "Відкриті фото Wikimedia Commons (автори й ліцензії — data/SOURCES_images.md)."}
        if key == "m2":
            from modules import m2_docs as mod
            _, labels = mod.load_data()
            return {"unit": "текстів", "rows": [(mod.LABELS_UA[c], labels.count(c)) for c in mod.CLASSES],
                    "note": "Синтетичні навчальні документи (не справжні службові)."}
        if key == "m3":
            from modules import m3_audio as mod
            _, labels = data.folder_dataset(mod.DATA_DIR, mod.CLASSES, data.AUDIO_EXT)
            return {"unit": "записів", "rows": [(mod.LABELS_UA[c], labels.count(c)) for c in mod.CLASSES],
                    "note": "Відкриті записи: ESC-50 і Wikimedia Commons (data/SOURCES_audio.md)."}
        if key == "m4":
            from modules import m4_cluster as mod
            texts, ref = mod.load_data()
            rows = [(t, (ref or []).count(t)) for t in sorted(set(ref or []))] or [("повідомлень", len(texts))]
            return {"unit": "повідомлень", "rows": rows,
                    "note": f"{len(texts)} синтетичних повідомлень; теми приховані від алгоритму — лише для перевірки."}
        if key == "m5":
            from modules import m5_llm as mod
            train, test = mod.load_data()
            allr = train + test
            return {"unit": "прикладів", "rows": [("Навчальні", len(train)), ("Тестові", len(test)),
                                                   ("3 варіанти", sum(r.get("type") == "mc" for r in allr)),
                                                   ("Правда / неправда", sum(r.get("type") == "tf" for r in allr))],
                    "note": "Приклади «навчальний текст → тестове запитання» (синтетичні)."}
        if key == "m6":
            from modules import m6_rl as mod
            return {"unit": "", "rows": [], "note": "Симулятори Gymnasium: " + "; ".join(v["title"] for v in mod.ENVS.values()) +
                    ". Дані агент збирає сам, граючи в середовищі."}
    except Exception as e:  # noqa: BLE001 — звіт має сформуватися навіть без даних
        return {"unit": "", "rows": [], "note": f"Дані недоступні: {e}"}
    return {"unit": "", "rows": [], "note": ""}


# ---------------------------------------------------------------- як адаптували (для схеми на слайді)
ADAPT = {
    "m1": {"frozen": "ResNet18: 11,7 млн ваг\n(ImageNet, заморожено)", "trained": "Новий шар fc\n512 → 6 класів",
           "input": "Фото 224×224", "output": "Клас + Grad-CAM",
           "steps": ["Фото діляться на навчальні (70 %) і тестові (30 %).",
                     "Останній шар ResNet18 (1000 класів ImageNet) замінюється новим — на наші 6 класів.",
                     "Решта мережі заморожена: вона вже вміє бачити краї, текстури, форми.",
                     "Базовий варіант — без аугментації; адаптований — з поворотами, віддзеркаленням, зміною яскравості."]},
    "m2": {"frozen": "MiniLM: 118 млн ваг\n(50+ мов, заморожено)", "trained": "Логістична регресія\n384 → 6 типів",
           "input": "Текст документа", "output": "Тип + 3 схожі приклади",
           "steps": ["Кожен текст MiniLM перетворює на ембеддинг — 384 числа, що описують зміст.",
                     "Поверх ембеддингів навчається логістична регресія (2 310 чисел).",
                     "Базовий рівень — TF-IDF: лише збіг слів, без розуміння змісту.",
                     "Оцінка — 5-кратна крос-валідація; опційно — розморожування останніх шарів MiniLM."]},
    "m3": {"frozen": "YAMNet: 3,7 млн ваг\n(AudioSet, заморожено)", "trained": "Логістична регресія\n2048 → 8 класів",
           "input": "Звук 16 кГц", "output": "Клас звуку",
           "steps": ["Запис ріжеться на шматки по 0,96 с; YAMNet дає ембеддинг кожного (1024 числа).",
                     "Середнє і максимум по шматках → 2048 ознак на файл.",
                     "Базовий рівень — zero-shot: власні класи AudioSet, переведені в наші за таблицею.",
                     "Адаптація — логістична регресія на наших записах; опційно — розморожування верхніх блоків."]},
    "m4": {"frozen": "MiniLM: 118 млн ваг\n(заморожено)", "trained": "KMeans\n(k центрів, без міток)",
           "input": "Повідомлення", "output": "Групи + ключові слова",
           "steps": ["Повідомлення перетворюються на ембеддинги MiniLM (зміст → 384 числа).",
                     "KMeans ділить їх на k груп без жодних міток (навчання без учителя).",
                     "Назви груп — автоматично з характерних слів (c-TF-IDF).",
                     "k обирається за silhouette і методом «ліктя»; базовий рівень — KMeans на TF-IDF."]},
    "m5": {"frozen": "Qwen3: 0,6 млрд ваг\n(заморожено)", "trained": "Приклади в запиті (few-shot / RAG)\nабо LoRA-адаптер",
           "input": "Навчальний текст", "output": "Запитання JSON → Word / Moodle",
           "steps": ["Zero-shot: лише інструкція, без прикладів — базовий рівень.",
                     "Few-shot: 2–3 готові приклади в запиті; RAG: найближчі за змістом приклади (пошук MiniLM).",
                     "LoRA: донавчаються лише малі додаткові матриці (≈0,1–1 % ваг).",
                     "Перевірка: чи правильний JSON і чи ключ є серед варіантів."]},
    "m6": {"frozen": "Готовий агент PPO\n(навчений у стандартних умовах)", "trained": "Донавчання в змінених умовах\n(уся мережа або лише останній шар)",
           "input": "Стан середовища", "output": "Дія агента",
           "steps": ["Готовий агент перевіряється в зміненому середовищі (довша жердина, вітер, шум) — «до».",
                     "Донавчання PPO вже в нових умовах: агент підлаштовує готові навички, а не вчиться з нуля.",
                     "Перевірка «після» на тих самих 20 стартах.",
                     "Контроль забування: чи вміє агент ще діяти в стандартних умовах."]},
}

LIMITS = {
    "m1": "20–80 відкритих фото на клас, переважно денні; немає нічних і тепловізійних знімків; тест малий.",
    "m2": "Синтетичні шаблонні тексти; на справжніх документах точність може бути нижчою.",
    "m3": "Мало відкритих записів Шахедів (особливо реактивних); записи різної якості й гучності.",
    "m4": "60 коротких синтетичних повідомлень; кількість кластерів k задає людина.",
    "m5": "Мала модель (0,6 млрд параметрів) слабше володіє українською; ~70 прикладів; тест перевіряє людина.",
    "m6": "Спрощена фізика симулятора; одна зміна середовища за раз; RL-навчання нестабільне.",
}


def _fmt(v, pct=False):
    if not isinstance(v, (int, float)):
        return "—"
    return f"{round(v * 100)} %" if pct else (f"{v:.0f}" if abs(v) >= 10 else f"{v:.2f}".replace(".", ","))


def headline(key: str, entry: dict | None) -> tuple[str, str, str] | None:
    """(назва метрики, до, після) — головна цифра модуля."""
    if not entry:
        return None
    m = entry.get("metrics") or {}
    b, a = m.get("baseline") or {}, m.get("adapted") or {}
    if key in ("m1", "m2", "m3"):
        return "F1-macro", _fmt(b.get("f1_macro")), _fmt(a.get("f1_macro"))
    if key == "m4":
        k = "ari" if "ari" in a else "silhouette"
        return k.upper() if k == "ari" else "Silhouette", _fmt(b.get(k)), _fmt(a.get(k))
    if key == "m5":
        return "Ключ серед варіантів", _fmt(b.get("key_in_options"), True), _fmt(a.get("key_in_options"), True)
    if key == "m6":
        return "Винагорода (змінене)", _fmt(b.get("mean_reward")), _fmt(a.get("mean_reward"))
    return None


def auto_text(key: str, entry: dict | None, why: list[dict]) -> dict:
    """Автоматичні «Помилки», «Обмеження», «Висновок» — з цифр і пояснень останнього запуску."""
    from core.registry import CARDS
    c = CARDS[key]
    errs = [plain(w["md"]) for w in why if w["t"] in ("wr", "info") and ("→ прийнято за" in w["md"] or "розпізнано лише" in w["md"]
                                                                       or "Змішані" in w["md"] or "JSON" in w["md"] or "забув" in w["md"])]
    errors = " ".join(errs[:3]) or ("Помилок, вартих уваги, немає." if entry else "Ще немає запуску.")
    low = (entry or {}).get("params", {}).get("low_data") if entry else None
    limits = LIMITS[key] + (" Мало даних у класах: " + ", ".join(low) + "." if low else "")
    hl = headline(key, entry)
    if not entry or not hl:
        concl = (f"Готова модель {c.model} дозволяє розв'язати задачу на кількох десятках прикладів замість тисяч. "
                 "Запустіть адаптацію, щоб отримати цифри.")
    else:
        name, b, a = hl
        verdict = next((plain(w["md"]) for w in why if w["t"] in ("ok", "wr") and ("більше" in w["md"] or "нічия" in w["md"]
                                                                                    or "гірше" in w["md"] or "→" in w["md"])), "")
        tip = next((plain(w["md"]) for w in why if w["t"] == "tip"), "")
        concl = (f"Готова модель {c.model} після адаптації: {name} {b} → {a}. Модель не навчали з нуля — "
                 f"навчалась лише мала частина, тому вистачило наших кількох десятків прикладів і хвилин роботи. "
                 f"{verdict} {tip}").strip()
    return {"errors": errors, "limits": limits, "conclusion": re.sub(r"\s+", " ", concl)}


def theory_text(key: str, title: str) -> str:
    from modules.theory import THEORY
    for t, body in THEORY[key]:
        if t == title:
            return plain(body)
    return ""


def summary_rows() -> list[dict]:
    """Підсумок по всіх модулях — для загальної доповіді."""
    from core.registry import CARDS
    out = []
    for key in ("m1", "m2", "m3", "m4", "m5", "m6"):
        e = experiment.latest(key)
        hl = headline(key, e)
        out.append({"key": key, "title": CARDS[key].title.split(". ", 1)[-1], "model": CARDS[key].model,
                    "metric": hl[0] if hl else "—", "before": hl[1] if hl else "—", "after": hl[2] if hl else "—",
                    "done": bool(e)})
    return out


REPO = "https://github.com/Dicpano/Praktika2026"
_ = config  # шляхи можуть знадобитися для графіків
