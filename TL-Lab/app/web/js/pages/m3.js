// Модуль 03 — розпізнавання звуків (YAMNet + логістична регресія; zero-shot як базовий рівень).
import { h, api, mount, panel, alert, btn, loading, kpis, runCaption, confusion, probBars, plot, jobPanel, run, table, filePick, termify } from '../ui.js';
import { modulePage, modelCard, noResult } from './_module.js';

export const render = (root, ctx) => modulePage(root, ctx, {
  key: 'm3', code: 'MOD-03', title: 'Розпізнавання звуків: Шахеди, авіація, техніка', path: '~/modules/m3',
  render: { data, adapt, eval: evaluate, demo },
});
let MAP = null;

async function data(sec) {
  const d = await api('/api/m3/data');
  MAP = MAP || d.mapping;
  const intro = h('p', 'Аудіомережа YAMNet навчена на AudioSet (2 млн записів, 521 клас звуків). Вона перетворює кожні 0,96 с звуку на ембеддинг; ' +
    'ми навчаємо логістичну регресію розрізняти наші класи. Базовий рівень — zero-shot: готові класи AudioSet без навчання.');
  termify(intro);
  const maps = h('div', Object.entries(MAP).map(([c, names]) => {
    const inp = h('input', { value: names.join('; '), style: { width: '100%' } });
    inp.addEventListener('change', () => { MAP[c] = inp.value.split(';').map(s => s.trim()).filter(Boolean); });
    return h('label.f', { style: { marginBottom: '8px' } }, d.classes.find(x => x.key === c)?.label || c, inp);
  }));
  mount(sec, intro, h('div.grid.g2', modelCard(d.card), panel('Записи за класами',
    table([[c => h('b', c.label), 'Клас'], [c => h('span', { class: c.skip ? 'c-er' : c.low ? 'c-wr' : 'c-ok' }, c.count), 'Записів'],
      [c => c.skip ? 'не навчається (< ' + d.min + ')' : c.low ? 'мало даних' : 'достатньо', 'Стан'],
      [c => c.sample ? h('audio', { controls: true, preload: 'none', src: c.sample }) : '—', 'Приклад']], d.classes, { scroll: false }),
    h('p.small.muted', 'Записи Шахедів збираються автоматично з Wikimedia Commons, інші — з відкритого набору ESC-50: ',
      h('a', { href: '#/data/audio' }, '«Центр даних» → «Аудіо»'), '. Записів реактивного Шахеда у відкритому доступі дуже мало.'))),
  h('details.x.param', h('summary', 'Відповідність класів AudioSet для zero-shot (базовий рівень) — можна змінити'), h('div', maps)));
}

async function adapt(sec, ctx) {
  if (!MAP) MAP = (await api('/api/m3/data')).mapping;
  mount(sec, h('div.panel.param',
    h('p', 'Поділ train/test 70/30 — за файлами. YAMNet заморожена; навчається лише логістична регресія на 2048 ознаках ' +
      '(середнє + максимум ембеддингів по фреймах). Класи з малою кількістю записів позначаються в журналі. ' +
      'YAMNet працює в окремому процесі: перший запуск — до 20 с на старт TensorFlow.'),
    btn('▶ Запустити адаптацію', () => run('/api/m3/train', { mapping: MAP }), 'primary')),
  jobPanel('m3', () => ctx.go('eval')));
  termify(sec);
}

async function evaluate(sec, ctx) {
  const r = await api('/api/m3/eval');
  if (!r.entry) { mount(sec, noResult(ctx)); return; }
  const m = r.entry.metrics, lab = (m.adapted.labels || []).map(k => r.labels[k] || k);
  mount(sec, runCaption(r.entry), kpis(m, ['accuracy', 'f1_macro']),
    r.low && r.low.length ? alert('Мало даних (оцінка ненадійна): ' + r.low.map(k => r.labels[k]).join(', '), 'wr') : null,
    h('div.grid.g2', panel('Zero-shot YAMNet (базовий рівень)', confusion(m.baseline.confusion, lab)),
      panel('YAMNet + LR (адаптація)', confusion(m.adapted.confusion, lab))),
    h('h2', 'Записи з помилками хоча б одного методу'),
    r.errors.length ? table([[e => h('audio', { controls: true, preload: 'none', src: e.url }), 'Запис'], ['true', 'Істина'], ['pred', 'YAMNet + LR'], ['zero_shot', 'Zero-shot']], r.errors)
      : alert('Помилок немає.', 'ok'));
}

async function demo(sec) {
  const list = await api('/api/m3/demo');
  const out = h('div');
  const show = async (name, url, promise) => {
    const card = h('div.panel', loading('YAMNet аналізує запис…'));
    out.prepend(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const r = await promise;
      const keys = Object.keys(r.probs), vals = keys.map(k => r.probs[k]);
      mount(card, h('div.grid.g2',
        h('div', h('div.small.muted', name), url ? h('audio', { controls: true, src: url }) : null,
          h('h2', r.label_ua), h('p', 'Zero-shot (без навчання): ', h('b', r.zs_label)),
          h('p.small.muted', 'Топ-5 класів AudioSet: ' + r.top.map(([n, s]) => `${n} (${s.toFixed(2)})`).join(', ')),
          probBars(keys.map(k => r.labels[k]), vals, 'YAMNet + LR', vals.indexOf(Math.max(...vals)))),
        h('div', plot([{ y: r.wave, mode: 'lines', line: { color: '#00e5ff', width: 1 } }], { title: 'Хвиля (16 кГц)', margin: { l: 40, r: 10, t: 30, b: 20 }, xaxis: { showticklabels: false } }, 170),
          plot([{ z: r.spec, type: 'heatmap', colorscale: 'Viridis', showscale: false }], { title: 'Мел-спектрограма', margin: { l: 40, r: 10, t: 30, b: 30 }, yaxis: { title: 'мел-смуга' } }, 230))));
    } catch (e) { mount(card, alert(e.message, 'er')); }
  };
  mount(sec, h('p', 'Натисніть ▶ біля демонстраційного запису або завантажте свій (WAV, FLAC, OGG, MP3). Результат з\'явиться вгорі.'),
    h('div', { style: { margin: '0 0 14px' } }, filePick('audio/*', false, files => {
      const fd = new FormData(); fd.append('file', files[0]);
      show(files[0].name, URL.createObjectURL(files[0]), api('/api/m3/predict', { method: 'POST', body: fd }));
    }, 'Свій запис: перетягніть сюди або натисніть')),
    out,
    list.length ? h('div.alist', { style: { marginTop: '14px' } }, list.map(f => {
      const fd = new FormData(); fd.append('demo', f.file);
      return h('div.it', btn('▶', () => show(f.name, f.url, api('/api/m3/predict', { method: 'POST', body: fd })), 'sm'),
        h('span', f.name), h('audio', { controls: true, preload: 'none', src: f.url }));
    })) : alert('Демонстраційних записів немає.', 'wr'));
}
