# Практична робота 4.10 — Виявлення аномалій у показах датчиків (autoencoder)

**Тема 4. Заняття 10.** Практичне використання методів глибокого навчання в межах виконання індивідуальних (групових) проектів.
Формат: **індивідуальний проект**, **Варіант 4 — Anomaly detection**.

## 1. Problem contract

- **Input:** вікно 6 годин (36 точок, крок 10 хв) з трьох каналів датчика: `temperature`, `vibration`, `pressure`.
- **Target:** чи містить вікно аномалію (бінарна мітка; для навчання моделі мітки **не використовуються** — лише для оцінки).
- **Користувач:** черговий оператор моніторингу, який отримує сигнал «перевір обладнання».
- **Цінність:** раннє виявлення збоїв, у тому числі неочевидних — коли значення в нормі, але порушений фізичний зв'язок між каналами.
- **Критерій успіху:** F1 на test вищий за статистичний baseline, і хибних тривог **≤ 2 на добу**.
- **Чому DL:** аномалія `decorrelation` (тиск перестає слідувати за температурою) не видна за амплітудою. Autoencoder вчиться відновлювати **спільну структуру** нормальних сигналів без ручних правил, тому помилка відновлення росте саме на таких порушеннях.

## 2. Дані

Synthetic, генеруються відтворювано (`seed=42`) функцією `src/pipeline.py::generate_sensor_data`. Деталі — у [data/README.md](data/README.md).

- 120 діб × 144 точки = 17 280 записів; 8.1% аномальних точок;
- 4 типи аномалій: `spike`, `level_shift`, `vib_oscillation`, `decorrelation`;
- у test-періоді доданий дрейф температури (+1 °C) для перевірки стійкості.

## 3. Протокол

| Крок | Рішення |
|---|---|
| Split | **часовий** 60/20/20 (train → validation → test), без перемішування |
| Scaler | mean/σ по каналах — лише на нормальних точках train |
| Навчання AE | лише на **нормальних** вікнах train; EarlyStopping за val loss на нормальних вікнах validation |
| Поріг | підбирається на validation за max F1 (однаково для baseline і DL) |
| Вибір моделі | лише за validation F1 |
| Test | один раз, після вибору моделі |

## 4. Результати

### Таблиця експериментів (validation)

| Run | Гіпотеза | Модель | Train loss | Val loss | Gap | Val F1 | Val FA/добу | Decision |
|---|---|---|---:|---:|---:|---:|---:|---|
| B0 | baseline | max \|z\| поріг | — | — | — | 0.663 | 2.82 | reference |
| D1 | DL вловить спільну структуру каналів | Dense AE 108→64→16→64→108 | 0.177 | 0.184 | 0.008 | **0.830** | **0.55** | **SELECTED** |
| D2 | регуляризація зменшить overfit | D1 + Dropout 0.2 + L2 1e-4 | 0.298 | 0.262 | −0.036 | 0.809 | 1.22 | rejected |
| D3 | згортки краще врахують форму сигналу | Conv1D AE | 0.046 | 0.049 | 0.003 | 0.721 | 1.47 | rejected |

Повна таблиця: [results/experiments.csv](results/experiments.csv).

### Фінальна оцінка на test

| Модель | Precision | Recall | F1 | PR-AUC | Хибних тривог / добу |
|---|---:|---:|---:|---:|---:|
| B0 baseline | 0.311 | 0.452 | 0.369 | 0.433 | 4.83 |
| **D1 Dense AE** | **0.689** | **0.713** | **0.701** | **0.785** | **1.56** |

[results/metrics.csv](results/metrics.csv) · аналіз помилок: [results/error_analysis.md](results/error_analysis.md)

**Критерій успіху виконано:** F1 на test 0.70 проти 0.37 у baseline; хибних тривог 1.56 на добу (≤ 2).

## 5. Висновок, обмеження, next step

- Autoencoder має реальну перевагу над пороговим правилом саме там, де DL і мав допомогти: recall для `decorrelation` зріс з 0.20 до 0.59, для `level_shift` — з 0.33 до 0.67.
- Baseline погано переносить дрейф: 87 із 115 його хибних тривог припадають на другу половину test, де дрейф сильніший.
- **Обмеження:** дані синтетичні, тож на реальних датчиках результат треба перевіряти заново. Train loss ще знижувався на 60-й епосі, тобто EarlyStopping не спрацював. Близько 40% аномалій `decorrelation` модель пропускає. Поріг підібрано на validation з іншою часткою аномалій (32% вікон проти 20% у test).
- **Next step:** більше епох або lr-schedule; адаптивний поріг або перенавчання scaler на ковзному вікні проти дрейфу; окремий score кореляції каналів для `decorrelation`; перевірка на відкритому наборі (наприклад, NAB або SKAB).

## 6. Структура та запуск

```text
practice4_10/
├── README.md
├── config.json              # seed, параметри даних, вікон і навчання
├── requirements.txt
├── data/
│   ├── README.md            # data card / provenance
│   └── sensor_data.csv      # генерується notebook 01
├── notebooks/
│   ├── 01_data.ipynb        # генерація, data card, split, leakage checks
│   ├── 02_baseline.ipynb    # статистичний baseline (validation)
│   └── 03_dl_experiment.ipynb  # D1–D3, вибір моделі, test, error analysis
├── src/pipeline.py          # спільні функції: дані, вікна, split, метрики
└── results/
    ├── experiments.csv
    ├── metrics.csv
    ├── recall_by_type.csv
    └── error_analysis.md
```

```bash
python -m venv .venv
.venv\Scripts\activate          # Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt
cd notebooks
jupyter nbconvert --to notebook --execute --inplace 01_data.ipynb 02_baseline.ipynb 03_dl_experiment.ipynb
```

Відтворюваність: `seed=42` для даних і `tf.keras.utils.set_random_seed(42)` для моделей. Перевірено на Python 3.12.10, TensorFlow 2.21.0, scikit-learn 1.9.1 (CPU). Через oneDNN на CPU метрики можуть відрізнятися в третьому знаку.

## 7. Peer-review checklist (самоперевірка)

| # | Питання | Відповідь |
|---|---|---|
| 1 | Зрозуміле аналітичне питання? | так — розділ 1 |
| 2 | Відтворюваний split? | так — `temporal_split`, частки в `config.json` |
| 3 | Baseline на тому самому протоколі? | так — ті самі вікна, scaler, підбір порогу на validation |
| 4 | Test не використовувався для tuning? | так — поріг і модель обрані на validation |
| 5 | Архітектура обґрунтована? | так — AE для задачі без розмітки; порівняно Dense і Conv1D |
| 6 | Є evidence over/underfit? | криві loss, gap у таблиці; gap ≈ 0, але є ознаки underfit (loss ще падає) |
| 7 | Показані failure cases? | так — notebook 03, розділи 5.1–5.2, error_analysis.md |
| 8 | Seeds, версії, гіперпараметри? | так — `config.json`, розділ 6 |
| 9 | Немає credentials/чутливих даних? | так — лише synthetic дані |
| 10 | Висновок не перебільшує? | обмеження наведено явно |
