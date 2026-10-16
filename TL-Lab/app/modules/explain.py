"""«Чому так вийшло»: пояснення результатів простими словами, складені з цифр останнього запуску.

Кожна функція повертає список пунктів {"t": рівень, "md": текст (markdown)}.
Рівні: ok — добре, wr — увага, info — пояснення, tip — що спробувати.
"""
from __future__ import annotations

import math


def _p(v: float) -> str:
    return f"{round(v * 100)} %"


def plural(n: int, one: str, few: str, many: str) -> str:
    """1 раз, 2 рази, 5 разів."""
    n = abs(int(n))
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def times(n: int) -> str:
    return f"{n} {plural(n, 'раз', 'рази', 'разів')}"


def noise(p: float, n: int) -> int:
    """Скільки прикладів може «гуляти» просто через випадковий поділ (≈2 стандартні похибки)."""
    return max(1, round(2 * math.sqrt(max(p * (1 - p), 0.01) * n)))


def _it(t: str, md: str) -> dict:
    return {"t": t, "md": md}


def _recalls(conf):
    return [(row[i] / s if (s := sum(row)) else None) for i, row in enumerate(conf)]


def _pairs(conf, top=3):
    cells = [(conf[i][j], i, j) for i in range(len(conf)) for j in range(len(conf)) if i != j and conf[i][j] > 0]
    return [(i, j, c) for c, i, j in sorted(cells, reverse=True)[:top]]


def _hint(hints: dict, a: str, b: str) -> str:
    return hints.get((a, b)) or hints.get((b, a)) or ""


def classification(m: dict, names: dict, *, base_name: str, adapt_name: str, unit=("приклад", "приклади", "прикладів"),
                   hints: dict | None = None, why_base: str = "", low: list | None = None, tips: list | None = None) -> list:
    """Пояснення для класифікації: базовий рівень проти адаптованої моделі, плутанина класів, мало даних."""
    hints = hints or {}
    b, a = m.get("baseline") or {}, m.get("adapted") or {}
    if not a.get("confusion"):
        return []
    keys = a.get("labels") or list(names)
    lab = [names.get(k, k) for k in keys]
    conf = a["confusion"]
    n = int(a.get("n") or sum(map(sum, conf)))
    u = lambda k: f"{k} {plural(k, *unit)}"
    out = []

    # 1. Головний висновок з урахуванням випадковості
    if b.get("confusion"):
        diff = round((a["accuracy"] - b["accuracy"]) * n)
        nz = noise(a["accuracy"], n)
        if abs(diff) <= nz:
            out.append(_it("info", f"**{base_name}** і **{adapt_name}** відповіли майже однаково: різниця — {u(abs(diff))} з {n} "
                       f"(точність {_p(b['accuracy'])} → {_p(a['accuracy'])}). На тесті такого розміру випадковий поділ даних "
                       f"сам по собі дає розкид ±{nz}, тож це **не покращення і не погіршення**, а нічия."))
        elif diff > 0:
            out.append(_it("ok", f"**{adapt_name}** правильно розпізнала на **{u(diff)} більше** з {n} "
                       f"(точність {_p(b['accuracy'])} → {_p(a['accuracy'])}). Це більше за випадковий розкид (±{nz}) — "
                       "ефект адаптації справжній."))
        else:
            out.append(_it("wr", f"**{adapt_name}** помилилась на {u(-diff)} більше з {n}, ніж {base_name.lower()} "
                       f"({_p(b['accuracy'])} → {_p(a['accuracy'])}). Це більше за випадковий розкид (±{nz}) — "
                       "адаптація цього разу не допомогла (причини — нижче)."))
        if why_base:
            out.append(_it("info", why_base))
        # базовий рівень «звалює» все в один клас
        bc = b["confusion"]
        cols = [sum(r[j] for r in bc) for j in range(len(bc))]
        tot = sum(cols) or 1
        jmax = max(range(len(cols)), key=cols.__getitem__)
        if len(cols) > 2 and cols[jmax] / tot >= 0.4:
            out.append(_it("info", f"{base_name} відніс **{_p(cols[jmax] / tot)} усіх прикладів** до класу «{lab[jmax]}» — "
                       "звідси високий стовпчик у його матриці. Без навчання на наших даних модель тягнеться до найширшої, "
                       "«загальної» категорії."))

    # 2. Які класи вдаються, а які ні
    rec = _recalls(conf)
    good = [lab[i] for i, r in enumerate(rec) if r is not None and r >= 0.999 and sum(conf[i]) >= 3]
    if good:
        out.append(_it("ok", "Без жодної помилки: " + ", ".join(f"«{x}»" for x in good) + "."))
    worst = sorted([(r, i) for i, r in enumerate(rec) if r is not None and r < 0.7], key=lambda x: x[0])[:2]
    for r, i in worst:
        out.append(_it("wr", f"«{lab[i]}» розпізнано лише в {_p(r)} випадків ({conf[i][i]} з {sum(conf[i])})."))

    # 3. Найчастіша плутанина і її причина
    for i, j, c in _pairs(conf):
        why = _hint(hints, keys[i], keys[j])
        out.append(_it("info", f"**«{lab[i]}» → прийнято за «{lab[j]}»** — {times(c)}." + (f" Чому: {why}" if why else "")))

    # 4. F1 проти точності
    if a.get("f1_macro") is not None and a["accuracy"] - a["f1_macro"] > 0.08:
        out.append(_it("info", f"F1-macro ({a['f1_macro']:.2f}) помітно нижчий за точність ({_p(a['accuracy'])}): "
                   "великі класи розпізнаються добре й «тягнуть» точність угору, а малі — гірше. F1-macro рахує всі класи "
                   "порівну, тому чесніше показує слабкі місця."))

    # 5. Мало даних
    if low:
        out.append(_it("wr", "Мало даних у класах " + ", ".join(f"«{names.get(c, c)}»" for c in low) +
                   ": у тесті по 1–3 приклади, тож кожна помилка змінює результат класу на десятки відсотків."))
    for t in tips or []:
        out.append(_it("tip", t))
    return out


def freeze(f: dict | None, unit: str = "F1-macro") -> list:
    """Порівняння «заморожена / розморожена»."""
    if not f or len(f.get("rows", [])) < 2:
        return []
    fr, un = f["rows"][0], f["rows"][1]
    d = un["score"] - fr["score"]
    share = un["trainable"] / max(1, un["total"])
    num = lambda v: f"{int(v):,}".replace(",", " ")
    pc = f"{share * 100:.1f}".replace(".", ",")
    msg = (f"Розморожування: навчалось **{num(un['trainable'])}** параметрів замість {num(fr['trainable'])} "
           f"({pc} % усієї моделі), час {fr['seconds']:.0f} с → {un['seconds']:.0f} с. ")
    if abs(d) < 0.02:
        return [_it("info", msg + f"Результат майже той самий ({unit} {fr['score']:.3f} → {un['score']:.3f}). "
                    "Для малого набору це типово: готові ознаки вже добрі, а розмороженим шарам не вистачає прикладів, "
                    "щоб навчитись чогось нового. Розморожування окупається, коли даних сотні–тисячі або вони дуже "
                    "відрізняються від тих, на яких модель навчали.")]
    if d > 0:
        return [_it("ok", msg + f"{unit}: {fr['score']:.3f} → **{un['score']:.3f}**. Верхні шари підлаштувались під "
                    "наші дані — модель почала помічати ознаки, важливі саме для наших класів.")]
    return [_it("wr", msg + f"{unit}: {fr['score']:.3f} → {un['score']:.3f} — гірше. Найімовірніше, перенавчання: "
                "розморожених параметрів набагато більше, ніж прикладів, і модель «завчила» навчальні дані. "
                "Спробуйте менше шарів, менше епох або менший learning rate.")]


# ------------------------------------------------------------------ модулі

M1_HINTS = {
    ("uav", "none"): "дрон на фото маленький, а більшу частину кадру займає небо чи поле — мережа бачить переважно фон.",
    ("armor", "artillery"): "схожі силуети: гусениці, корпус, ствол. Самохідна гармата майже як танк.",
    ("camo", "none"): "замаскована позиція навмисно схожа на звичайну місцевість — це найважча пара.",
    ("armor", "truck"): "колісна бронетехніка схожа на вантажівку за формою і розміром.",
    ("artillery", "truck"): "буксирувана гармата часто на фото разом із тягачем-вантажівкою.",
    ("camo", "armor"): "маскувальна сітка поверх техніки — на фото є ознаки обох класів.",
    ("camo", "artillery"): "гармати часто фотографують під маскувальною сіткою.",
    ("uav", "artillery"): "довгі тонкі деталі (крила, ствол) на однотонному тлі.",
    ("artillery", "none"): "гармата в укритті чи на дальньому плані займає малу частину кадру — мережа бачить переважно місцевість.",
    ("armor", "none"): "техніка далеко або частково схована — більшу частину кадру займає місцевість.",
    ("truck", "none"): "вантажівка на дальньому плані серед дороги й поля.",
    ("uav", "truck"): "на фото наземного комплексу БПЛА часто є автомобіль.",
    ("uav", "armor"): "дрон сфотографовано поруч із технікою.",
}
M2_HINTS = {
    ("combat", "info"): "обидва описують обстановку; відрізняє лише «станом на…», сили й потреби підрозділу.",
    ("analytic", "info"): "аналітична довідка теж повідомляє факти — відрізняють оцінки, порівняння й прогноз.",
    ("report", "request"): "обидва містять «прошу…»: рапорт — особисте прохання, заявка — матеріальні засоби.",
    ("order", "request"): "обидва містять перелік і терміни виконання.",
    ("combat", "analytic"): "в обох є цифри й опис ситуації.",
    ("combat", "report"): "в обох «доповідаю».",
}
M3_HINTS = {
    ("shahed", "jet_shahed"): "обидва — рівний гул у небі, а записів реактивного Шахеда у відкритому доступі дуже мало.",
    ("shahed", "engine"): "поршневий двигун Шахеда звучить як мопед чи легкий двигун — звідси його прізвисько «мопед».",
    ("shahed", "chainsaw"): "поршневий двигун Шахеда звучить як мопед чи бензопила — звідси його прізвисько «мопед».",
    ("helicopter", "engine"): "обидва — низькочастотне ритмічне гудіння.",
    ("airplane", "background"): "далекий літак — тихий рівний гул, схожий на вітер чи шум дороги.",
    ("airplane", "jet_shahed"): "реактивний двигун звучить схоже незалежно від розміру апарата.",
    ("airplane", "engine"): "гул двигуна без характерних деталей.",
    ("engine", "chainsaw"): "обидва — двигуни внутрішнього згоряння.",
    ("engine", "background"): "шум дороги й техніки на фоні часто є і в «фонових» записах.",
    ("helicopter", "background"): "далекий вертоліт на записі ледь чутно.",
}


def m1(m: dict, names: dict, params: dict | None = None) -> list:
    p = params or {}
    why = ("Що тут порівнюється: **обидві моделі — ResNet18 з новим останнім шаром**, різниця лише в **аугментації** "
           "(випадкові повороти, віддзеркалення, зміна яскравості під час навчання). Аугментація вчить не зважати на ракурс і "
           "освітлення. Якщо тестові фото зняті так само, як навчальні, вона майже нічого не додає — і результати близькі.")
    tips = ["Щоб поліпшити: додайте фото найгірших класів (особливо з різних ракурсів) у «Центрі даних»"
            + ("" if p.get("unfreeze_layer4") else ", або увімкніть «Розморозити layer4»") + ".",
            "Подивіться нижче помилки з Grad-CAM: якщо підсвічено фон, а не об'єкт — бракує різноманітних фото."]
    return classification(m, names, base_name="Модель без аугментації", adapt_name="Модель з аугментацією",
                          unit=("фото", "фото", "фото"), hints=M1_HINTS, why_base=why, tips=tips)


def m1_loss(loss: list | None) -> list:
    if not loss or len(loss) < 2:
        return []
    a, z, mn = loss[0], loss[-1], min(loss)
    out = [_it("info", f"Крива втрат: помилка на навчальних фото впала з {a:.2f} до {z:.2f}. "
               "Втрати — це «наскільки модель помиляється» під час навчання; що нижче, то краще.")]
    if z > mn * 1.15 and len(loss) > 3:
        out.append(_it("wr", "Під кінець втрати знову зросли — learning rate, імовірно, завеликий. Спробуйте менший."))
    elif loss[-2] - z > 0.05 * a:
        out.append(_it("tip", "Крива ще падає — модель не дійшла до межі. Можна додати епох."))
    else:
        out.append(_it("ok", "Крива вийшла на «полицю» — епох достатньо."))
    return out


def m2(m: dict, names: dict, f: dict | None = None) -> list:
    why = ("**TF-IDF** бачить лише збіг слів: «наказую» → наказ. **MiniLM** розуміє зміст, навіть якщо слова інші "
           "(«доповідаю про стан» ≈ «станом на 06:00»). Наші тексти синтетичні й шаблонні — у кожного типу є свої "
           "ключові слова, тому TF-IDF тут теж працює непогано. На справжніх, різних за стилем документах перевага "
           "MiniLM зазвичай більша.")
    out = classification(m, names, base_name="TF-IDF", adapt_name="MiniLM", unit=("текст", "тексти", "текстів"),
                         hints=M2_HINTS, why_base=why,
                         tips=["Щоб поліпшити: додайте по 5–10 текстів для найгіршого типу в «Центрі даних» → «Документи»."])
    return out + freeze(f)


def m3(m: dict, names: dict, low: list | None, f: dict | None = None) -> list:
    why = ("**Zero-shot** не навчається на наших записах: він бере готові 521 категорію AudioSet і зіставляє їх із нашими "
           "класами за назвою. Категорії на кшталт «Engine» дуже широкі, тож багато звуків потрапляє туди. "
           "**YAMNet + LR** навчається саме на наших записах і розрізняє тонші відмінності.")
    used = (m.get("adapted") or {}).get("labels") or []
    weak = [c for c in ("shahed", "jet_shahed") if c in (low or []) or c not in used]
    tips = (["Щоб поліпшити: зберіть більше записів " + ("Шахедів" if len(weak) == 2 else names.get(weak[0], weak[0])) +
             " у «Центрі даних» → «Аудіо»" + (" — без них клас не бере участі в навчанні." if any(c not in used for c in weak)
                                              else " — зараз це найслабше місце.")] if weak else
            ["Щоб поліпшити: додайте записи класів з найбільшою плутаниною (див. вище) у «Центрі даних» → «Аудіо»."])
    out = classification(m, names, base_name="Zero-shot", adapt_name="YAMNet + LR", unit=("запис", "записи", "записів"),
                         hints=M3_HINTS, why_base=why, low=low, tips=tips)
    return out + freeze(f)


def m4(res: dict) -> list:
    b, a = res.get("baseline") or {}, res.get("adapted") or {}
    out = []
    s = a.get("silhouette")
    if s is not None:
        lvl = ("кластери чітко відокремлені" if s > 0.25 else
               "структура є, але групи частково перекриваються — для текстів це нормально" if s > 0.08 else
               "групи сильно перекриваються")
        out.append(_it("info", f"**Silhouette = {s:.2f}** (шкала від −1 до 1): {lvl}. Silhouette показує, наскільки кожне "
                       "повідомлення ближче до «свого» кластера, ніж до сусіднього."))
    if "ari" in a and "ari" in b:
        d = a["ari"] - b["ari"]
        lvl = "майже збігаються з темами" if a["ari"] > 0.7 else "значною мірою збігаються" if a["ari"] > 0.4 else "збігаються слабко"
        out.append(_it("ok" if d > 0.05 else "info" if d > -0.05 else "wr",
                       f"**ARI: TF-IDF {b['ari']:.2f} → MiniLM {a['ari']:.2f}.** ARI порівнює знайдені кластери з "
                       f"прихованими еталонними темами (0 — випадково, 1 — ідеально): кластери MiniLM {lvl}. "
                       + ("MiniLM групує за змістом, тому повідомлення про те саме різними словами опиняються разом."
                          if d > 0.05 else "Тут обидва методи близькі — повідомлення однієї теми мають спільні слова.")))
    out.append(_it("info", "Silhouette TF-IDF і MiniLM прямо не порівнюйте: вони рахуються в різних просторах ознак. "
                   "Для порівняння методів дивіться ARI/NMI."))
    sil, el, k = res.get("silhouette_k") or {}, res.get("elbow_k") or {}, (res.get("params") or {}).get("k")
    if sil:
        kb = max(sil, key=sil.get)
        out.append(_it("info" if str(kb) == str(k) else "tip",
                       f"Графік silhouette найвищий при **k = {kb}**" + (f", ви обрали k = {k}" if k else "") + ". "
                       + ("Вибір збігається." if str(kb) == str(k) else
                          f"Спробуйте k = {kb} — або залиште {k}, якщо вам потрібна саме така кількість груп для звіту.")))
    if el:
        out.append(_it("info", "Метод «ліктя»: inertia завжди зменшується зі зростанням k. Шукайте точку, після якої "
                       "крива стає пологою, — далі нові кластери вже майже нічого не дають."))
    ref, lab = res.get("ref"), res.get("labels")
    if ref and lab is not None:
        from collections import Counter
        mixed = []
        for c in sorted(set(lab)):
            cnt = Counter(t for t, lb in zip(ref, lab) if lb == c)
            top, n = cnt.most_common(1)[0] if cnt else ("", 0)
            tot = sum(cnt.values())
            if tot and n / tot < 0.6:
                mixed.append(f"К{c + 1} ({n}/{tot} — «{top}»)")
        if mixed:
            out.append(_it("info", "Змішані кластери: " + ", ".join(mixed) + ". Тут повідомлення різних тем схожі за "
                           "словами або змістом; у перехресній таблиці це рядок з кількома світлими клітинками."))
        else:
            out.append(_it("ok", "Кожен кластер складається переважно з однієї теми (≥ 60 %) — у перехресній таблиці "
                           "по одній яскравій клітинці в рядку."))
    return out


def m5(by_mode: dict, names: dict) -> list:
    if not by_mode:
        return []
    out = []
    n = max((v.get("n", 0) for v in by_mode.values()), default=0)
    if n:
        out.append(_it("info", f"У тесті {n} текстів, тож **кожен текст — це {round(100 / n)} п.п.** Різниця на 1–2 тексти "
                       "між режимами — ще не висновок."))
    best = max(by_mode, key=lambda k: (by_mode[k].get("key_in_options", 0), by_mode[k].get("valid_json", 0)))
    for k, v in by_mode.items():
        vj, ko = v.get("valid_json", 0), v.get("key_in_options", 0)
        nm = names.get(k, k)
        if vj < 0.7:
            out.append(_it("wr", f"**{nm}**: лише {_p(vj)} відповідей — правильний JSON. Модель на 0,6 млрд параметрів без "
                           "прикладів часто відповідає «своїми словами» замість заданого формату."))
        elif ko < vj - 0.15:
            out.append(_it("info", f"**{nm}**: формат правильний ({_p(vj)}), але в {_p(vj - ko)} випадків ключ відповіді не "
                           "збігся з варіантами — модель «забуває», що вказала правильною."))
    why = {"zero": "модель бачить лише інструкцію, без жодного прикладу.",
           "few": "у запит додано готові приклади з навчальної вибірки — модель копіює їхній формат і стиль.",
           "rag": "у запит додано найближчі за змістом приклади (пошук MiniLM) — вони підказують і формат, і тему.",
           "lora": "модель донавчена на наших прикладах — формат «вшитий» у ваги, підказки в запиті не потрібні."}
    out.append(_it("ok", f"Найкращий режим — **{names.get(best, best)}**: {why.get(best, '')}"))
    out.append(_it("tip", "Автоматичні метрики перевіряють лише формат. Чи правильне саме запитання — оцінює людина в "
                   "таблиці нижче (1–5)."))
    return out


def m6(metrics: dict, params: dict | None, curve: list | None, rng: tuple, labels: dict | None = None,
       frozen: dict | None = None) -> list:
    if not metrics or "baseline" not in metrics:
        return []
    p = params or {}
    lo, hi = rng
    nz = lambda r: (r - lo) / (hi - lo)
    b, a = metrics["baseline"]["mean_reward"], metrics["adapted"]["mean_reward"]
    ob, oa = metrics.get("original_env_before", {}).get("mean_reward"), metrics.get("original_env_after", {}).get("mean_reward")
    pname = (labels or {}).get(p.get("param"), p.get("param", "параметр"))
    out = []
    if ob is not None:
        drop = nz(ob) - nz(b)
        out.append(_it("info" if drop > 0.3 else "wr",
                       f"Готовий агент у стандартному середовищі набирав **{ob:.0f}**, а після зміни «{pname} = {p.get('value')}» — "
                       f"**{b:.0f}**. " + ("Зміна сильно йому зашкодила — є що виправляти донавчанням." if drop > 0.3 else
                                          "Зміна майже не зашкодила, тож і донавчанню нема чого покращувати. Оберіть "
                                          "сильнішу зміну (вкладка «Модель і дані» → «Знайти»).")))
    d = nz(a) - nz(b)
    if d > 0.1:
        out.append(_it("ok", f"Після донавчання в нових умовах: **{b:.0f} → {a:.0f}**. Агент не вчився з нуля — він "
                       "почав із готових навичок і лише підлаштувався, тому вистачило "
                       + f"{int(p.get('timesteps') or 0):,}".replace(",", " ")
                       + " кроків (з нуля потрібно в кілька разів більше)."))
    elif d > -0.05:
        out.append(_it("wr", f"Донавчання майже нічого не дало ({b:.0f} → {a:.0f}). Спробуйте більше кроків або сильнішу "
                       "зміну середовища."))
    else:
        out.append(_it("wr", f"Після донавчання стало гірше ({b:.0f} → {a:.0f}). RL нестабільне: агент міг «зламати» "
                       "навичку на початку. Повторіть із більшою кількістю кроків."))
    if ob is not None and oa is not None:
        f = nz(ob) - nz(oa)
        out.append(_it("ok" if f < 0.1 else "wr",
                       f"Контроль забування: у стандартному середовищі {ob:.0f} → {oa:.0f}. " +
                       ("Старі навички збереглися." if f < 0.1 else
                        "Агент частково **забув**, як діяти в звичних умовах, — це «катастрофічне забування»: нові дані "
                        "переписали старі ваги. Тому після донавчання завжди перевіряють і старе завдання.")))
    if curve and len(curve) >= 20:
        ys = [r for _, r in curve]
        k = max(5, len(ys) // 5)
        s, e = sum(ys[:k]) / k, sum(ys[-k:]) / k
        out.append(_it("info", f"Крива навчання: середня винагорода на початку {s:.0f}, наприкінці {e:.0f}. Окремі точки "
                       "сильно «скачуть» — кожен епізод починається з випадкового стану; дивіться на згладжену лінію."))
    if frozen:
        fa = frozen.get("mean_reward")
        if fa is not None:
            diff = nz(a) - nz(fa)
            out.append(_it("info", f"Часткове донавчання (лише останній шар, тіло заморожене): **{fa:.0f}** проти "
                           f"{a:.0f} при повному. " + (
                               "Повне донавчання краще: щоб пристосуватись до нової фізики, агенту треба змінити й те, "
                               "як він «сприймає» стан, а не лише рішення." if diff > 0.05 else
                               "Майже однаково — для цієї зміни достатньо перенастроїти лише останній шар; це швидше й "
                               "менше ризикує забуванням." if diff > -0.05 else
                               "Часткове навіть краще: менше параметрів — менше шансів зіпсувати готові навички.")))
    return out
