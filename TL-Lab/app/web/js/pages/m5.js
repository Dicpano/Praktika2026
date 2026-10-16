// Модуль 05 — генерація тестових запитань (Qwen3-0.6B: zero-shot, few-shot, RAG, LoRA) і експорт тесту.
import { h, api, mount, panel, alert, btn, loading, kpis, runCaption, jobPanel, run, table, field, slider, check, tabs, termify, select, download, toast } from '../ui.js';
import { modulePage, modelCard, noResult } from './_module.js';

export const render = (root, ctx) => modulePage(root, ctx, {
  key: 'm5', code: 'MOD-05', title: 'Міні-LLM для створення навчальних тестів', path: '~/modules/m5',
  sections: [['data', 'Модель і дані'], ['adapt', 'Адаптація'], ['eval', 'Оцінювання'], ['demo', 'Демонстрація'], ['test', 'Створити тест'], ['theory', 'Теорія']],
  render: { data, adapt, eval: evaluate, demo, test: makeTest },
});

async function data(sec) {
  const d = await api('/api/m5/data');
  const intro = h('p', 'Невелика мовна модель Qwen3-0.6B за навчальним текстом складає тестове запитання у форматі JSON. Порівнюються чотири способи: ' +
    'zero-shot (лише інструкція), few-shot (3 приклади в запиті), RAG (3 найсхожіші приклади, знайдені пошуком) і LoRA (донавчений адаптер). Тільки LoRA змінює ваги.');
  termify(intro);
  mount(sec, intro, h('div.grid.g2', modelCard(d.card), panel('Дані',
    h('p', `${d.train + d.test} синтетичних прикладів: ${d.train} навчальних, ${d.test} тестових.`),
    h('p', `Типи запитань: ${Object.entries(d.qtypes).map(([k, v]) => `${v} — ${d.by_type[k] || 0}`).join('; ')}.`),
    d.lora ? alert('Адаптер LoRA знайдено.', 'ok') : alert('Адаптера LoRA ще немає — навчіть його в розділі «Адаптація» (потрібна відеокарта) або в Google Colab (див. посібник).', 'wr'),
    h('p.small.muted', 'Редагувати приклади — ', h('a', { href: '#/data/quiz' }, '«Центр даних» → «Тести»'), '.'))),
  d.example ? panel('Приклад', h('pre', { style: { whiteSpace: 'pre-wrap', margin: 0 } }, JSON.stringify(d.example, null, 1))) : null);
}

async function adapt(sec, ctx) {
  const d = await api('/api/m5/data');
  const modes = new Set(['zero', 'few', 'rag', ...(d.lora ? ['lora'] : [])]);
  const lp = { epochs: 3, lr: 2e-4, r: 8 };
  const lrs = [5e-5, 1e-4, 2e-4, 5e-4];
  mount(sec, 
    h('div.panel.param', h('h3', { style: { marginTop: 0 } }, 'Порівняльна оцінка режимів'),
      h('div.row', Object.entries(d.modes).map(([k, v]) => check(v, modes.has(k), on => { on ? modes.add(k) : modes.delete(k); })),
        h('span.grow'), btn('▶ Оцінити режими', () => run('/api/m5/eval_run', { modes: [...modes] }), 'primary')),
      h('p.small.muted', 'На CPU ≈ 10–30 с на текст; 3 режими × 9 текстів ≈ 5–12 хв. Qwen працює в окремому процесі — програма не «зависає».')),
    h('details.x.param', h('summary', 'LoRA-донавчання (потрібна відеокарта; без неї — Google Colab)'), h('div',
      h('div.grid.g3', field('Епохи', slider(1, 5, 1, 3, v => { lp.epochs = v; })),
        field('Learning rate', slider(0, 3, 1, 2, v => { lp.lr = lrs[v]; }, v => lrs[v])),
        field('Ранг r', slider(4, 16, 4, 8, v => { lp.r = v; }))),
      btn('Навчити LoRA', () => run('/api/m5/lora', lp)))),
    jobPanel('m5', j => { if (j.title.startsWith('Оцінка')) ctx.go('eval'); }));
  termify(sec);
}

function q(p) {
  if (!p) return h('span.c-er', 'невалідний JSON');
  return h('div', h('b', p.question), h('div', (p.options || []).map(o => h('div', (o === p.answer ? '✅ ' : '▫️ ') + o))));
}

async function evaluate(sec, ctx) {
  const r = await api('/api/m5/eval');
  if (!r.entry) { mount(sec, noResult(ctx, 'Ще немає результатів — запустіть оцінку режимів.')); return; }
  const by = r.entry.metrics.by_mode;
  const cols = [['text', 'Текст']];
  for (const md of Object.keys(by)) cols.push([row => q(row.outputs[md]?.parsed), r.modes[md]]);
  mount(sec, runCaption(r.entry), kpis(r.entry.metrics, ['valid_json', 'key_in_options']),
    table([[x => r.modes[x], 'Режим'], [x => Math.round(by[x].valid_json * 100) + ' %', 'Валідний JSON'],
      [x => Math.round(by[x].key_in_options * 100) + ' %', 'Ключ серед варіантів']], Object.keys(by), { scroll: false }),
    h('h2', 'Згенеровані запитання (експертна оцінка 1–5: відповідність тексту, правильність ключа, якість хибних варіантів)'),
    table(cols, r.rows, { height: '620px' }));
}

async function demo(sec) {
  const texts = await api('/api/m5/demo');
  const ta = h('textarea', { rows: 4, placeholder: 'Навчальний текст…' });
  let qtype = 'mc';
  const out = h('div');
  const drawRes = async () => {
    const r = await api('/api/m5/job');
    if (!r.demo) { mount(out); return; }
    const d = r.demo;
    mount(out, h('p', h('b', 'Текст: '), d.text), h('div.grid.g3', Object.keys(d.outputs).map(md =>
      panel(d.modes[md], d.parsed[md] ? q(d.parsed[md]) : h('div', h('div.c-er', 'Невалідний JSON'), h('pre', { style: { whiteSpace: 'pre-wrap' } }, d.outputs[md]))))),
    !Object.keys(d.outputs).includes('lora') ? h('p.small.muted', 'Адаптера LoRA немає, тому третя колонка — RAG (без зміни ваг).') : null);
  };
  mount(sec, 
    h('div.row', select([['', '— демонстраційний текст —'], ...texts.map((t, i) => [i, t.slice(0, 100) + '…'])], '', v => { ta.value = v === '' ? '' : texts[+v]; }),
      select([['mc', 'Запитання з 3 варіантами'], ['tf', 'Твердження «правда / неправда»']], qtype, v => { qtype = v; })),
    h('div', { style: { margin: '10px 0' } }, ta),
    btn('▶ Згенерувати', () => ta.value.trim() && run('/api/m5/demo', { text: ta.value, qtype }), 'primary'),
    h('p.small.muted', 'Генерація йде у фоні в окремому процесі. Перший запуск — 20–60 с на завантаження моделі.'),
    jobPanel('m5', drawRes), out);
  drawRes();
}

async function makeTest(sec) {
  const texts = await api('/api/m5/demo');
  const ta = h('textarea', { rows: 10, placeholder: 'Кожен абзац (через порожній рядок) — окремий навчальний текст. На кожен буде одне запитання.' });
  ta.value = texts.join('\n\n');
  const p = { qtype: 'mc', mode: 'rag', title: 'Тест з дисципліни' };
  const out = h('div');
  const titleInp = h('input', { value: p.title, style: { width: '100%' } });
  const drawRes = async () => {
    const r = await api('/api/m5/job');
    if (!r.test) { mount(out); return; }
    const items = r.test.test_items;
    const rows = items.map((it, i) => {
      const qi = h('input', { value: it.question || '', style: { width: '100%' } });
      qi.addEventListener('change', () => { it.question = qi.value; });
      const opts = (it.options && it.options.length ? it.options : (it.type === 'tf' ? ['Правда', 'Неправда'] : ['', '', ''])).map((o, n) => {
        const oi = h('input', { value: o, style: { width: '100%' } });
        oi.addEventListener('change', () => { it.options[n] = oi.value; });
        return oi;
      });
      if (!it.options || !it.options.length) it.options = opts.map(o => o.value);
      const ans = select(it.options.map((o, n) => [o, `${'абв'[n]}) ${o.slice(0, 40)}`]), it.answer, v => { it.answer = v; });
      return h('div.panel', { style: { marginBottom: '10px' } }, h('div.small.muted', `${i + 1}. ${it.text.slice(0, 140)}…`),
        it.ok ? null : alert('Модель відповіла не за форматом — відредагуйте вручну.', 'wr'),
        field('Запитання', qi), h('div.grid.g3', opts), field('Правильна відповідь', ans));
    });
    mount(out, h('h2', `Тест: ${items.filter(x => x.ok).length}/${items.length} запитань без правок`),
      h('p.small.muted', 'Перевірте й за потреби виправте запитання — мовна модель може помилятися.'), ...rows,
      h('div.row', btn('⤓ Word (.docx)', () => download('/api/m5/export/docx', { items, title: titleInp.value }, 'test.docx'), 'primary'),
        btn('⤓ Moodle (GIFT)', () => download('/api/m5/export/gift', { items, title: titleInp.value }, 'test_moodle.gift.txt'))));
  };
  mount(sec, 
    h('p', 'Вставте навчальні тексти — програма складе тест: по одному запитанню на кожен текст. Результат можна відредагувати і завантажити у Word або Moodle.'),
    h('div.grid.g3', field('Назва тесту', titleInp),
      field('Тип запитань', select([['mc', '3 варіанти відповіді'], ['tf', 'Правда / неправда']], p.qtype, v => { p.qtype = v; })),
      field('Режим моделі', select([['rag', 'RAG (рекомендовано)'], ['few', 'Few-shot'], ['zero', 'Zero-shot'], ['lora', 'LoRA (якщо є адаптер)']], p.mode, v => { p.mode = v; }))),
    h('div', { style: { margin: '10px 0' } }, ta),
    btn('▶ Скласти тест', () => {
      const parts = ta.value.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
      if (!parts.length) return toast('Додайте текст', 'wr');
      run('/api/m5/test', { texts: parts, mode: p.mode, qtype: p.qtype });
    }, 'primary'),
    jobPanel('m5', drawRes), out);
  drawRes();
}
