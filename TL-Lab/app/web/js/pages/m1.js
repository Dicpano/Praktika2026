// Модуль 01 — класифікація техніки й позицій на фото (ResNet18 + Grad-CAM).
import { h, api, mount, panel, alert, btn, field, slider, check, loading, kpis, runCaption, confusion, plot, probBars,
  jobPanel, run, filePick, lightbox, termify, S, pct } from '../ui.js';
import { modulePage, modelCard, noResult } from './_module.js';

export const render = (root, ctx) => modulePage(root, ctx, {
  key: 'm1', code: 'MOD-01', title: 'Класифікатор техніки й позицій', path: '~/modules/m1',
  render: { data, adapt, eval: evaluate, demo },
});

async function data(sec) {
  mount(sec, loading('завантаження моделі й набору фото…'));
  const d = await api('/api/m1/data');
  const rows = d.classes.map(c => h('div.panel',
    h('div.row', h('b', c.label), h('span.grow'), h('span', { class: c.count >= 20 ? 'c-ok' : c.count >= d.min ? 'c-wr' : 'c-er' }, `${c.count} фото`)),
    c.count < d.min ? h('div.small.c-er', `менше ${d.min} — клас не бере участі в навчанні`) : c.count < 20 ? h('div.small.c-wr', 'рекомендовано 20–30') : null,
    h('div.gallery', { style: { gridTemplateColumns: 'repeat(4,1fr)', marginTop: '8px' } },
      c.samples.map(u => h('div.thumb', { onclick: () => lightbox(u) }, h('img', { src: u, loading: 'lazy' }))))));
  const intro = h('p', 'Готова мережа ResNet18 «бачила» 1,28 млн фото ImageNet і вже вміє виділяти форми, текстури й частини об\'єктів. ' +
    'Ми замінюємо лише її останній шар — і вчимо розрізняти наші класи на кількох десятках фото. Це і є transfer learning.');
  termify(intro);
  mount(sec, intro, h('div.grid.g2', modelCard(d.card),
    panel('Набір даних', h('p', `Усього ${d.total} фото. Додати, переглянути, видалити, зібрати автоматично чи знайти дублікати — `,
      h('a', { href: '#/data' }, '«Центр даних» →')))),
  h('h2', 'Класи'), h('div.grid.g3', rows));
}

async function adapt(sec, ctx) {
  const p = { epochs: 10, lr: 0.001, unfreeze: false };
  const lrs = [0.0001, 0.0003, 0.001, 0.003];
  const form = h('div.panel.param',
    h('div.grid.g3',
      field('Епохи (скільки разів модель побачить усі фото)', slider(3, 30, 1, p.epochs, v => { p.epochs = v; })),
      field('Learning rate (крок навчання)', slider(0, 3, 1, 2, v => { p.lr = lrs[v]; }, v => lrs[v])),
      field('Розморозити layer4', check('довше, але точніше на нетипових ракурсах', false, v => { p.unfreeze = v; }))),
    h('p.small.muted', 'Спершу навчається базовий варіант (без аугментації), потім — з аугментацією. Класи з менш ніж 5 фото пропускаються. На CPU 5–15 хв.'),
    btn('▶ Запустити адаптацію', () => run('/api/m1/train', p), 'primary'));
  mount(sec, form, jobPanel('m1', () => ctx.go('eval')));
}

async function evaluate(sec, ctx) {
  const r = await api('/api/m1/eval');
  if (!r.entry) { mount(sec, noResult(ctx)); return; }
  const m = r.entry.metrics, labels = Object.values(r.labels);
  const errs = h('div');
  mount(sec, runCaption(r.entry), kpis(m, ['accuracy', 'f1_macro']),
    h('div.grid.g2', panel('Базовий рівень (без аугментації)', confusion(m.baseline.confusion, labels)),
      panel('Адаптована модель', confusion(m.adapted.confusion, labels))),
    r.loss ? panel('Крива втрат (адаптація)', plot([{ y: r.loss, x: r.loss.map((_, i) => i + 1), mode: 'lines+markers', line: { color: '#00e5ff' } }],
      { xaxis: { title: 'епоха' }, yaxis: { title: 'loss' } }, 240)) : null,
    h('h2', `Помилки на тесті з Grad-CAM (${r.errors.length})`), errs);
  if (!r.errors.length) { errs.append(alert('На тестовій вибірці помилок немає.', 'ok')); return; }
  for (const e of r.errors) {
    const box = h('div.panel', h('div.grid.g3', h('div.imgbox', h('img', { src: e.url })), h('div.imgbox', loading('Grad-CAM…')),
      h('div', h('p', h('b', 'Істина: '), e.true_ua), h('p', h('b', 'Прогноз: '), e.pred_ua, ` (${pct(e.conf)})`),
        h('p.muted.small', 'Подивіться, куди «дивилась» мережа: на об\'єкт чи на фон (небо, дорогу, ліс)? Типові причини — ракурс, фон, частковий об\'єкт, схожі класи.'))));
    errs.append(box);
    api('/api/m1/cam?file=' + encodeURIComponent(e.file)).then(c => {
      box.querySelectorAll('.imgbox')[1].replaceChildren(h('img', { src: c.cam }));
    }).catch(() => {});
  }
}

async function demo(sec) {
  const list = await api('/api/m1/demo');
  const out = h('div');
  const show = async (title, promise) => {
    const card = h('div.panel', loading('аналіз фото…'));
    out.prepend(card);
    try {
      const c = await promise;
      const labels = Object.keys(c.probs), vals = labels.map(k => c.probs[k]);
      mount(card, h('div.grid.g3',
        h('div.imgbox', h('img', { src: c.image }), h('div.small.muted', title)),
        h('div.imgbox', h('img', { src: c.cam }), h('div.small.muted', 'Grad-CAM: куди «дивилась» мережа')),
        h('div', h('h2', { style: { marginTop: 0 } }, c.verdict),
          h('p.muted', `впевненість ${pct(c.conf)} · поріг «невизначено» ${pct(c.threshold)} (змінюється в налаштуваннях)`),
          probBars(labels.map(k => c.labels[k]), vals, null, vals.indexOf(Math.max(...vals))))));
    } catch (e) { mount(card, alert(e.message, 'er')); }
  };
  mount(sec, 
    h('p', 'Оберіть демонстраційне фото або завантажте своє. Модель покаже клас, впевненість і теплову карту уваги.'),
    list.length ? h('div.gallery', list.map(f => h('div.thumb', { onclick: () => show(f.name, api('/api/m1/cam?file=' + encodeURIComponent(f.file))) },
      h('img', { src: f.url, loading: 'lazy' }), h('div.cap', f.name)))) : alert('Демонстраційних фото немає — додайте їх у «Центрі даних» (клас «Демо»).', 'wr'),
    h('div', { style: { margin: '14px 0' } }, filePick('image/*', true, files => {
      for (const f of files) { const fd = new FormData(); fd.append('file', f); show(f.name, api('/api/m1/predict', { method: 'POST', body: fd })); }
    }, 'Своє фото: перетягніть сюди або натисніть')),
    out);
}
