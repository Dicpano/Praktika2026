"""Генерація 2 слайдів доповіді (.pptx) у стилі програми: модель і дані → результати й висновок."""
from __future__ import annotations

import io

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from pptx import Presentation  # noqa: E402
from pptx.dml.color import RGBColor  # noqa: E402
from pptx.util import Emu, Pt  # noqa: E402

from core.registry import CARDS  # noqa: E402
from core.report import compare_rows  # noqa: E402

BG, PANEL, CYAN, TEXT, MUTED, GREEN, RED = "05070A", "0B1219", "00E5FF", "E6FDFF", "5F8F99", "39FF9A", "FF3B5C"
FONT = "Consolas"
W, H = Emu(12192000), Emu(6858000)   # 16:9


def _rgb(h):
    return RGBColor.from_string(h)


def _bg(slide):
    f = slide.background.fill
    f.solid()
    f.fore_color.rgb = _rgb(BG)


def _text(slide, x, y, w, h, text, size=14, color=TEXT, bold=False):
    tb = slide.shapes.add_textbox(Emu(x), Emu(y), Emu(w), Emu(h))
    tf = tb.text_frame
    tf.word_wrap = True
    for i, line in enumerate(text.split("\n")):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        r = p.add_run()
        r.text = line
        r.font.size, r.font.bold, r.font.name = Pt(size), bold, FONT
        r.font.color.rgb = _rgb(color)
    return tb


def _box(slide, x, y, w, h, border=CYAN):
    s = slide.shapes.add_shape(1, Emu(x), Emu(y), Emu(w), Emu(h))
    s.fill.solid()
    s.fill.fore_color.rgb = _rgb(PANEL)
    s.line.color.rgb = _rgb(border)
    s.line.width = Pt(1)
    s.shadow.inherit = False
    return s


def _chart(key: str, entry: dict, extra) -> bytes | None:
    """Головний графік модуля, намальований matplotlib у кольорах програми."""
    plt.rcParams.update({"font.family": "DejaVu Sans Mono", "text.color": "#b8f3ff", "axes.labelcolor": "#b8f3ff",
                         "xtick.color": "#5f8f99", "ytick.color": "#5f8f99", "axes.edgecolor": "#12313a"})
    fig, ax = plt.subplots(figsize=(6.2, 4.0), dpi=160)
    fig.patch.set_facecolor("#05070a")
    ax.set_facecolor("#0b1219")
    mt = entry["metrics"]
    if key in ("m1", "m2", "m3"):
        cm = np.array(mt["adapted"]["confusion"])
        short = {"uav": "БПЛА", "armor": "Броня", "truck": "Вантаж.", "info": "Інформ.", "analytic": "Аналіт.",
                 "org": "Організ.", "engine": "Двигун", "siren": "Сирена", "rain": "Дощ"}
        labels = [short.get(x, x) for x in mt["adapted"]["labels"]]
        from matplotlib.colors import LinearSegmentedColormap
        ax.imshow(cm, cmap=LinearSegmentedColormap.from_list("c", ["#05070a", "#063a44", "#00e5ff"]))
        for i in range(cm.shape[0]):
            for jj in range(cm.shape[1]):
                ax.text(jj, i, cm[i, jj], ha="center", va="center", color="#e6fdff", fontsize=14)
        ax.set_xticks(range(len(labels)), labels)
        ax.set_yticks(range(len(labels)), labels)
        ax.set_xlabel("прогноз")
        ax.set_ylabel("істина")
        ax.set_title("Матриця помилок адаптованої моделі", color="#e6fdff", fontsize=11)
    elif key == "m4" and extra:
        ks, vs = zip(*extra["silhouette_k"].items())
        ax.plot(ks, vs, "-o", color="#00e5ff")
        ax.set_xlabel("k")
        ax.set_ylabel("silhouette")
        ax.set_title("Вибір кількості кластерів", color="#e6fdff", fontsize=11)
    elif key == "m5":
        by = mt.get("by_mode", {})
        ax.bar(list(by), [v["valid_json"] for v in by.values()], color="#00e5ff")
        ax.set_ylim(0, 1.05)
        ax.set_ylabel("частка валідного JSON")
        ax.set_title("Режими генерації", color="#e6fdff", fontsize=11)
    elif key == "m6":
        names = ["змін.\nдо", "змін.\nпісля", "станд.\nдо", "станд.\nпісля"]
        keys = ["baseline", "adapted", "original_env_before", "original_env_after"]
        ax.bar(names, [mt[k]["mean_reward"] for k in keys], yerr=[mt[k]["std_reward"] for k in keys],
               color=["#ff3b5c", "#00e5ff", "#1c4a55", "#39ff9a"], ecolor="#b8f3ff")
        ax.set_ylim(0, 520)
        ax.set_ylabel("середня винагорода")
        ax.set_title("До / після донавчання і контроль забування", color="#e6fdff", fontsize=11)
    else:
        plt.close(fig)
        return None
    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor=fig.get_facecolor())
    plt.close(fig)
    return buf.getvalue()


def build(key: str, entry: dict | None, extra, errors: str, limits: str, conclusion: str, repo: str) -> bytes:
    c = CARDS[key]
    prs = Presentation()
    prs.slide_width, prs.slide_height = W, H
    blank = prs.slide_layouts[6]
    M = 457200  # поле 0,5″

    # ---- слайд 1: модель, дані, адаптація ----
    s = prs.slides.add_slide(blank)
    _bg(s)
    _text(s, M, 300000, 11000000, 300000, f"root@tl-lab:~/modules/{key}$ ./run", 11, MUTED)
    _text(s, M, 560000, 11300000, 700000, f"MOD-{key[1:].zfill(2)} // {c.title.split('. ', 1)[-1]}", 26, CYAN, True)
    rows = [("Готова модель", c.model), ("Джерело", c.source), ("Ліцензія · параметрів", f"{c.license} · {c.params}"),
            ("Навчена на", c.pretrained_on), ("Що адаптовано", c.adapted), ("Базовий рівень", c.baseline)]
    if entry:
        rows.append(("Параметри запуску", ", ".join(f"{k}={v}" for k, v in entry.get("params", {}).items())))
    y = 1500000
    for lbl, val in rows:
        _box(s, M, y, 11277600, 560000, "12313A")
        _text(s, M + 120000, y + 60000, 2900000, 450000, lbl.upper(), 11, MUTED)
        _text(s, M + 3100000, y + 40000, 8100000, 500000, val, 13, TEXT)
        y += 640000
    _text(s, M, 6380000, 11000000, 300000, "Навчальний макет · відкриті/синтетичні дані", 9, "FFB000")

    # ---- слайд 2: результати й висновок ----
    s = prs.slides.add_slide(blank)
    _bg(s)
    _text(s, M, 300000, 11300000, 600000, "Результати: базовий рівень → адаптація", 24, CYAN, True)
    if entry:
        kx = M
        for name, b, a in compare_rows(entry["metrics"])[:3]:
            _box(s, kx, 1050000, 3600000, 1150000)
            _text(s, kx + 150000, 1100000, 3300000, 300000, name.upper(), 11, MUTED)
            _text(s, kx + 150000, 1400000, 3300000, 700000, f"{b} → {a}", 24, TEXT, True)
            kx += 3800000
        png = _chart(key, entry, extra)
        if png:
            s.shapes.add_picture(io.BytesIO(png), Emu(M), Emu(2400000), height=Emu(3900000))
    text = (f"Помилки: {errors or '—'}\n\nОбмеження: {limits or '—'}\n\nВисновок: {conclusion or '—'}")
    _box(s, 6600000, 2400000, 5134000, 3900000, "12313A")
    _text(s, 6750000, 2480000, 4850000, 3750000, text, 12, TEXT)
    _text(s, M, 6380000, 11000000, 300000, f"Код: {repo}", 11, MUTED)

    out = io.BytesIO()
    prs.save(out)
    return out.getvalue()
