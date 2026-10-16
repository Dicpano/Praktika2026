"""Формування звіту для доповіді (ЗФ-7): Markdown з метриками і висновком за шаблоном."""
from __future__ import annotations

from core import config
from core.registry import CARDS

METRIC_NAMES = {
    "accuracy": "Accuracy", "f1_macro": "F1-macro", "silhouette": "Silhouette",
    "ari": "ARI", "nmi": "NMI", "valid_json": "Валідний JSON, частка",
    "key_in_options": "Ключ серед варіантів, частка", "mean_reward": "Середня винагорода",
    "std_reward": "СКВ винагороди",
}


def _fmt(v) -> str:
    return f"{v:.3f}" if isinstance(v, float) else str(v)


def compare_rows(metrics: dict) -> list[tuple[str, str, str]]:
    """metrics = {"baseline": {...}, "adapted": {...}} -> рядки (метрика, базовий, адаптований)."""
    base, adapt = metrics.get("baseline", {}), metrics.get("adapted", {})
    rows = []
    for k in METRIC_NAMES:
        if k in base or k in adapt:
            rows.append((METRIC_NAMES[k], _fmt(base.get(k, "—")), _fmt(adapt.get(k, "—"))))
    return rows


def build_markdown(key: str, entry: dict | None, errors: str, limits: str, conclusion: str) -> str:
    c = CARDS[key]
    lines = [
        f"# {c.title}", "",
        f"**Модель:** {c.model}  ", f"**Джерело:** {c.source}  ", f"**Ліцензія:** {c.license}  ",
        f"**Що адаптовано:** {c.adapted}  ", f"**Базовий рівень:** {c.baseline}", "",
    ]
    if entry:
        lines += [f"## Результати (запуск {entry['time']}, seed {entry['seed']})", "",
                  "| Метрика | Базовий рівень | Адаптована модель |", "| --- | --- | --- |"]
        lines += [f"| {a} | {b} | {d} |" for a, b, d in compare_rows(entry["metrics"])]
        if entry.get("params"):
            lines += ["", "Параметри: " + ", ".join(f"{k} = {v}" for k, v in entry["params"].items())]
        figs = sorted(config.FIGS.glob(f"{key}_*.png"))
        if figs:
            lines += ["", "## Графіки", ""] + [f"![{f.stem}](figs/{f.name})" for f in figs]
    else:
        lines += ["_Запусків ще не було — виконайте адаптацію у вкладці модуля._"]
    lines += ["", "## Типові помилки", "", errors or "—", "",
              "## Обмеження", "", limits or "—", "",
              "## Висновок", "", conclusion or "—", "",
              "Код: https://github.com/Dicpano/Praktika2026", ""]
    return "\n".join(lines)
