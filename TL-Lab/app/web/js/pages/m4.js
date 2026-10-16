// Модуль 04 — кластеризація повідомлень (MiniLM + KMeans; базовий рівень — KMeans на TF-IDF).
import { h, api, mount, panel, alert, btn, loading, kpis, runCaption, plot, jobPanel, run, table, field, slider, tabs, termify, COLORS, select, why, howto, steps } from '../ui.js';
import { modulePage, modelCard, noResult } from './_module.js';

export const render = (root, ctx) => modulePage(root, ctx, {
  key: 'm4', code: 'MOD-04', title: 'Кластеризація інформаційних повідомлень', path: '~/modules/m4',
  sections: [['data', 'Модель і дані'], ['adapt', 'Кластеризація'], ['eval', 'Оцінювання'], ['demo', 'Демонстрація'], ['theory', 'Теорія']],
  render: { data, adapt, eval: evaluate, demo },
});
let VIEW = { method: 'PCA', perp: 7 };

async function data(sec) {
  const d = await api('/api/m4/data');
  const intro = h('p', 'Навчання без учителя: міток немає. Повідомлення перетворюються на ембеддинги MiniLM, і KMeans групує їх за змістом. ' +
    'Ваги мережі не змінюються — це використання готових ознак, а не донавчання.');
  termify(intro);
  mount(sec, intro, h('div.grid.g2', modelCard(d.card), panel('Дані',
    h('p', `${d.texts.length} синтетичних повідомлень. Приховані теми (для оцінки, алгоритм їх не бачить): `, h('b', d.topics.join(', ')), '.'),
    h('p.small.muted', 'Редагувати — ', h('a', { href: '#/data/messages' }, '«Центр даних» → «Повідомлення»'), '.'))),
  h('h2', 'Повідомлення'), table([[t => t, 'Текст']], d.texts, { height: '360px' }));
}

function scatter(points, names, extra) {
  const k = Math.max(...points.map(p => p.c)) + 1;
  const traces = [...Array(k).keys()].map(c => {
    const ps = points.filter(p => p.c === c);
    return { type: 'scatter', mode: 'markers', name: `К${c + 1}: ${names[c] || ''}`, x: ps.map(p => p.x), y: ps.map(p => p.y), text: ps.map(p => p.t),
      hovertemplate: '%{text}<extra></extra>', marker: { size: 11, color: COLORS[c % COLORS.length], line: { color: '#05070a', width: 1 } } };
  });
  if (extra) traces.push(extra);
  return plot(traces, { legend: { orientation: 'h', y: -0.15 }, margin: { l: 40, r: 10, t: 20, b: 40 } }, 480);
}

async function adapt(sec, ctx) {
  const p = { k: 6 };
  const res = h('div');
  mount(sec, h('div.panel.param', h('div.row',
    field('Кількість кластерів k', slider(2, 9, 1, p.k, v => { p.k = v; })), h('span.grow'),
    btn('⬡ Згрупувати', () => run('/api/m4/run', p), 'primary')),
  h('p.small.muted', 'Підказка: оберіть k за графіками silhouette і методом «ліктя» в розділі «Оцінювання».')),
  steps([
    'Кожне повідомлення перетворюється на **ембеддинг MiniLM** — 384 числа, що описують зміст. Схожі за змістом повідомлення отримують близькі числа.',
    '**KMeans** ставить k «центрів» і ділить повідомлення на k груп так, щоб кожне було якнайближче до свого центру. Міток тем модель **не бачить** — це навчання без учителя.',
    'Для кожної групи автоматично підбираються **ключові слова** (слова, характерні саме для неї) — з них складається назва кластера.',
    '**Базовий рівень**: те саме, але на TF-IDF (лише збіг слів), без MiniLM.',
    'Для перевірки знайдені групи порівнюються з прихованими еталонними темами (ARI, NMI). Для вибору k рахуються silhouette і метод «ліктя» → вкладка «Оцінювання».',
  ]),
  jobPanel('m4', () => draw()), res);
  termify(sec);
  const draw = async () => {
    mount(res, loading());
    const r = await api(`/api/m4/result?method=${VIEW.method}&perp=${VIEW.perp}`);
    if (!r.entry) { mount(res); return; }
    const names = Object.fromEntries(r.clusters.map(c => [c.id, c.name]));
    mount(res, h('div.row', tabs([['PCA', 'PCA'], ['t-SNE', 't-SNE']], VIEW.method, m => { VIEW.method = m; draw(); }, 'small'),
      VIEW.method === 't-SNE' ? field('perplexity', slider(3, 15, 1, VIEW.perp, v => { VIEW.perp = v; })) : null,
      VIEW.method === 't-SNE' ? btn('Перебудувати', draw, 'sm') : null),
    panel(`Повідомлення на площині (${VIEW.method}), колір — кластер KMeans (k = ${r.k})`, scatter(r.points, names), howto('scatter')),
    h('h2', 'Кластери (назви — автоматично з ключових слів)'),
    ...r.clusters.map((c, i) => h('details.x', { open: i === 0 || null },
      h('summary', h('span', { style: { color: COLORS[c.id % COLORS.length] } }, '■ '), `Кластер ${c.id + 1}: ${c.name} — ${c.items.length} текстів`),
      h('div', h('p', h('b', 'Ключові слова: '), c.keywords.join(', ')), c.topic ? h('p.small.muted', 'Переважна прихована тема (для перевірки): ' + c.topic) : null,
        h('p', h('b', 'Найтиповіший текст: '), c.representative), table([[t => t, 'Текст']], c.items, { scroll: false })))));
  };
  draw();
}

async function evaluate(sec, ctx) {
  const r = await api('/api/m4/result');
  if (!r.entry) { mount(sec, noResult(ctx, 'Ще немає результатів — виконайте кластеризацію.')); return; }
  const sil = r.silhouette, el = r.elbow || {};
  const best = Object.entries(sil).sort((a, b) => b[1] - a[1])[0];
  const cap = h('p.small.muted', 'Silhouette — наскільки кластери щільні й відокремлені (−1…1). ARI і NMI — збіг із прихованими темами (1 = повний збіг, 0 = випадковий). Метод «ліктя»: де крива перестає різко падати — там розумне k.');
  termify(cap);
  mount(sec, runCaption(r.entry), kpis(r.entry.metrics, ['silhouette', 'ari', 'nmi']), cap, howto('kpi'),
    why(r.why),
    h('div.grid.g2',
      panel(`Вибір k за silhouette (найкраще k = ${best[0]})`, plot([{ x: Object.keys(sil), y: Object.values(sil), mode: 'lines+markers', line: { color: '#00e5ff' } }],
        { xaxis: { title: 'k' }, yaxis: { title: 'silhouette' } }, 280), howto('silhouette')),
      panel('Метод «ліктя» (inertia)', plot([{ x: Object.keys(el), y: Object.values(el), mode: 'lines+markers', line: { color: '#ffb000' } }],
        { xaxis: { title: 'k' }, yaxis: { title: 'сума квадратів відстаней' } }, 280), howto('elbow'))),
    r.cross ? panel('Перехресна таблиця «кластер × прихована тема»', plot([{ type: 'heatmap', z: r.cross.values, x: r.cross.columns, y: r.cross.index,
      colorscale: [[0, '#05070a'], [1, '#00e5ff']], showscale: false, text: r.cross.values, texttemplate: '%{text}' }], { margin: { l: 60, r: 10, t: 10, b: 60 }, yaxis: { autorange: 'reversed' } }, 320), howto('cross')) : null);
}

async function demo(sec) {
  const list = await api('/api/m4/demo');
  const inp = h('input', { style: { width: '100%' }, placeholder: 'Нове повідомлення…' });
  const out = h('div');
  const go = async () => {
    if (!inp.value.trim()) return;
    mount(out, loading());
    try {
      const r = await api('/api/m4/assign', { body: { text: inp.value } });
      mount(out, h('h2', `Кластер ${r.cluster + 1}: ${r.name}`),
        h('p.small.muted', 'Відстані до центрів: ' + r.dist.map((d, i) => `К${i + 1}: ${d.toFixed(2)}`).join(' · ')),
        panel('Нове повідомлення (зірка) серед наявних, PCA', scatter(r.points, r.names, { type: 'scatter', mode: 'markers', name: 'нове', x: [r.xy[0]], y: [r.xy[1]],
          text: [inp.value], hovertemplate: '%{text}<extra></extra>', marker: { symbol: 'star', size: 24, color: '#ffffff', line: { color: '#00e5ff', width: 2 } } })));
    } catch (e) { mount(out, alert(e.message, 'er')); }
  };
  mount(sec, select([['', '— демонстраційне повідомлення —'], ...list.map((t, i) => [i, t])], '', v => { inp.value = v === '' ? '' : list[+v]; go(); }),
    h('div.row', { style: { margin: '10px 0' } }, h('div.grow', inp), btn('Визначити кластер', go, 'primary')), out);
}
