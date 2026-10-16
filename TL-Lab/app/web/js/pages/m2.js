// Модуль 02 — класифікація службових документів (MiniLM + логістична регресія проти TF-IDF).
import { h, api, mount, panel, alert, btn, loading, kpis, runCaption, confusion, probBars, jobPanel, run, table, termify, select, pct, check, field, slider, why, howto, steps, freezeTable } from '../ui.js';
import { modulePage, modelCard, noResult } from './_module.js';

export const render = (root, ctx) => modulePage(root, ctx, {
  key: 'm2', code: 'MOD-02', title: 'Інтелектуальне сортування документів', path: '~/modules/m2',
  render: { data, adapt, eval: evaluate, demo },
});

async function data(sec) {
  const d = await api('/api/m2/data');
  const intro = h('p', 'Багатомовна модель MiniLM перетворює текст на ембеддинг — 384 числа, що описують зміст. ' +
    'Поверх них навчається логістична регресія. Базовий рівень — TF-IDF, який бачить лише збіг слів.');
  termify(intro);
  mount(sec, intro, d.error ? alert(d.error, 'er') : null,
    h('div.grid.g2', modelCard(d.card), panel('Типи документів',
      table([[r => h('b', r.label), 'Тип'], ['about', 'Ознаки'], ['count', 'Текстів']], d.classes, { scroll: false }))),
    h('h2', `Усі тексти (${d.texts.length}) — синтетичні, навчальні`),
    table([['label', 'Тип'], ['text', 'Текст']], d.texts, { height: '420px' }),
    h('p.small.muted', 'Редагувати набір, додати тексти чи імпортувати .docx/.txt — ', h('a', { href: '#/data/docs' }, '«Центр даних» → «Документи»'),
      '. Справжні службові документи не завантажуйте.'));
}

async function adapt(sec, ctx) {
  const ft = { on: false, layers: 2, epochs: 4, lr: 3e-5 };
  const lrs = [1e-5, 3e-5, 1e-4];
  const opts = h('div.grid.g3', { style: { display: 'none' } },
    field('Скільки останніх шарів MiniLM розморозити (з 12)', slider(1, 4, 1, 2, v => { ft.layers = v; })),
    field('Епохи', slider(2, 8, 1, 4, v => { ft.epochs = v; })),
    field('Learning rate (для розморожених шарів)', slider(0, 2, 1, 1, v => { ft.lr = lrs[v]; }, v => lrs[v])));
  mount(sec, 
    h('div.panel.param', h('p', 'Обидва методи оцінюються 5-кратною стратифікованою крос-валідацією на тих самих текстах. ' +
      'Ваги MiniLM не змінюються — навчається лише логістична регресія поверх ембеддингів (6 × 384 + 6 = 2 310 параметрів).'),
    h('div.f', check('Також розморозити останні шари MiniLM і порівняти (+3–10 хв на CPU)', false, v => { ft.on = v; opts.style.display = v ? '' : 'none'; })),
    opts,
    btn('▶ Запустити адаптацію', () => run('/api/m2/train', ft.on ? { unfreeze_layers: ft.layers, epochs: ft.epochs, lr: ft.lr } : {}), 'primary')),
    steps([
      'Усі тексти діляться на **5 частин**. П\'ять разів поспіль: на 4 частинах навчаємо, на 5-й перевіряємо (**крос-валідація**). Так кожен текст один раз потрапляє в тест, а результат не залежить від одного випадкового поділу.',
      '**Базовий рівень — TF-IDF**: кожен текст перетворюється на «мішок слів» з вагами (рідкісні характерні слова важать більше). Класифікатор бачить лише, які слова є в тексті.',
      '**Адаптація — MiniLM**: готова мовна модель (навчена на мільйонах речень 50+ мов) перетворює кожен текст на **ембеддинг** — 384 числа, що описують **зміст**, а не слова.',
      'На ембеддингах навчається **логістична регресія** — простий класифікатор (2 310 чисел). Сама MiniLM не змінюється — це і є перенос знань.',
      'Якщо ввімкнено розморожування — останні шари MiniLM теж підлаштовуються під наші документи. Голова стартує з уже навченої логістичної регресії, тож розморожена модель починає з рівня замороженої (метод **LP-FT**).',
      'Результати всіх методів — на вкладці «Оцінювання».',
    ]),
    jobPanel('m2', () => ctx.go('eval')));
  termify(sec);
}

async function evaluate(sec, ctx) {
  const r = await api('/api/m2/eval');
  if (!r.entry) { mount(sec, noResult(ctx)); return; }
  const m = r.entry.metrics, lab = (m.adapted.labels || Object.keys(r.short)).map(k => r.short[k] || k);
  mount(sec, runCaption(r.entry), kpis(m, ['accuracy', 'f1_macro']), howto('kpi'),
    why(r.why),
    freezeTable(r.freeze),
    h('div.grid.g2', panel('TF-IDF + LR (базовий рівень)', confusion(m.baseline.confusion, lab)),
      panel('MiniLM + LR (адаптація)', confusion(m.adapted.confusion, lab))),
    m.finetuned ? panel('MiniLM з розмороженими шарами', confusion(m.finetuned.confusion, lab)) : null, howto('confusion'),
    h('h2', `Хибні відповіді MiniLM (${r.errors.length})`),
    r.errors.length ? table([['true', 'Істина'], ['pred', 'Прогноз'], [e => h('span.small', e.why || '—'), 'Чому могло статися'], ['text', 'Текст']], r.errors) : alert('Помилок немає.', 'ok'));
}

async function demo(sec) {
  const list = await api('/api/m2/demo');
  const ta = h('textarea', { rows: 4, placeholder: 'Вставте текст навчального документа…' });
  const out = h('div');
  const go = async () => {
    const text = ta.value.trim();
    if (!text) return;
    mount(out, loading('аналіз…'));
    try {
      const r = await api('/api/m2/predict', { body: { text } });
      const keys = Object.keys(r.probs), vals = keys.map(k => r.probs[k]);
      const truth = list.find(x => x.text === text);
      mount(out, h('div.grid.g2',
        h('div', h('h2', { style: { marginTop: 0 } }, r.label_ua),
          truth ? h('p', { class: truth.label === r.label_ua ? 'c-ok' : 'c-er' }, `Еталон: ${truth.label} — ${truth.label === r.label_ua ? '✅ збіг' : '❌ помилка'}`) : null,
          probBars(keys.map(k => r.labels[k]), vals, 'Ймовірності', vals.indexOf(Math.max(...vals)))),
        panel('Чому так: найближчі за змістом навчальні тексти',
          table([[n => n.sim.toFixed(2), 'Схожість'], ['label', 'Тип'], ['text', 'Текст']], r.neighbors, { scroll: false }))));
    } catch (e) { mount(out, alert(e.message, 'er')); }
  };
  mount(sec, 
    h('div.row', select([['', '— демонстраційний приклад —'], ...list.map((x, i) => [i, x.text.slice(0, 90) + '…'])], '',
      v => { ta.value = v === '' ? '' : list[+v].text; go(); })),
    h('div', { style: { margin: '10px 0' } }, ta), btn('Класифікувати', go, 'primary'), h('div', { style: { marginTop: '16px' } }, out));
}
