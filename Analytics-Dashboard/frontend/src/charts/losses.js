// Модуль C: C1–C5 (лише агрегати)
import { get } from '../api.js';
import { label } from '../state.js';
import { d, num } from '../format.js';
import { PAL, card, baseOptions, barDataset, lineDataset, periodLabel, color, refLinePlugin } from './common.js';

const KINDS = [['killed', 'Безповоротні (загиблі)'], ['wounded', 'Санітарні (поранені)'], ['missing', 'Зниклі безвісти']];

export async function renderC1(root) {
  const data = await get('losses/timeline');
  const c = card(root, { id: 'c1', title: 'Втрати особового складу по тижнях', sub: 'осіб; перший і останній тижні можуть бути неповними', wide: true });
  if (!data.rows.some((r) => r.killed + r.wounded + r.missing)) return c.empty();
  c.chart({
    type: 'bar',
    data: { labels: data.rows.map((r) => periodLabel(r.period, 'week')),
      datasets: KINDS.map(([k, n], i) => barDataset(n, data.rows.map((r) => r[k]), PAL.loss[k], { last: i === KINDS.length - 1 })) },
    options: baseOptions({ stacked: true, yTitle: 'осіб', unit: 'осіб' }),
  });
  c.setTable([{ key: 'p', title: 'Тиждень з' }, ...KINDS.map(([k, n]) => ({ key: k, title: `${n}, осіб` }))],
    data.rows.map((r) => ({ p: d(r.period), ...r })));
}

export async function renderC2(root) {
  const rows = await get('losses/by-cause');
  const c = card(root, { id: 'c2', title: 'Втрати особового складу за причинами', sub: 'осіб' });
  if (!rows.length) return c.empty();
  c.chart({
    type: 'bar',
    data: { labels: rows.map((r) => label('cause', r.cause)),
      datasets: KINDS.map(([k, n], i) => barDataset(n, rows.map((r) => r[k]), PAL.loss[k], { last: i === KINDS.length - 1 })) },
    options: baseOptions({ horizontal: true, stacked: true, yTitle: 'осіб', unit: 'осіб' }),
  });
  c.setTable([{ key: 'c', title: 'Причина' }, ...KINDS.map(([k, n]) => ({ key: k, title: `${n}, осіб` }))],
    rows.map((r) => ({ c: label('cause', r.cause), ...r })));
}

// C3: точкова діаграма (одна шкала на вісь) — інтенсивність вогню vs санітарні втрати за добу
export async function renderC3(root) {
  const rows = await get('losses/correlation');
  const c = card(root, { id: 'c3', title: 'Зв\'язок інтенсивності вогню противника і санітарних втрат',
    sub: 'одна точка — одна доба; вісь X — пострілів противника, вісь Y — поранених, осіб' });
  if (!rows.length) return c.empty();
  const pts = rows.map((r) => ({ x: r.incoming_rounds, y: r.wounded, day: r.period }));
  const opts = baseOptions({ legend: false, unit: 'осіб' });
  opts.scales = {
    // Точкова діаграма: вісь X не мусить починатися з нуля — межі за даними з невеликим запасом
    x: { type: 'linear', beginAtZero: false, grace: '5%', title: { display: true, text: 'Пострілів противника за добу' }, grid: { color: color('--grid') },
      ticks: { callback: (v) => num(v) } },
    y: { beginAtZero: true, title: { display: true, text: 'Санітарні втрати, осіб' }, grid: { color: color('--grid') } },
  };
  opts.interaction = { mode: 'nearest', intersect: true };
  opts.plugins.tooltip.callbacks.label = (ctx) => `${d(ctx.raw.day)}: ${num(ctx.raw.x)} пострілів, ${num(ctx.raw.y)} поранених`;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
  const cov = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
  const sx = Math.sqrt(pts.reduce((s, p) => s + (p.x - mx) ** 2, 0)), sy = Math.sqrt(pts.reduce((s, p) => s + (p.y - my) ** 2, 0));
  const r = sx && sy ? cov / (sx * sy) : null;
  c.chart({
    type: 'scatter',
    data: { datasets: [{ label: 'Доба', data: pts, backgroundColor: color('--c-gold'), borderColor: color('--surface'), borderWidth: 1,
      pointRadius: 4, pointHoverRadius: 6 }] },
    options: opts,
  });
  if (r !== null) c.el.querySelector('.chart-sub').textContent += ` · коефіцієнт кореляції r = ${r.toFixed(2).replace('.', ',')}${Math.abs(r) >= 0.5 ? ' (помітний зв\'язок)' : ''}`;
  c.setTable([{ key: 'd', title: 'Дата' }, { key: 'x', title: 'Пострілів противника' }, { key: 'y', title: 'Поранених, осіб' }],
    pts.map((p) => ({ d: d(p.day), x: p.x, y: p.y })));
}

const NORM_MANNING = 85;   // умовний норматив укомплектованості, %
const one = (x) => (x === null || x === undefined ? null : num(x, 1));

// C4: укомплектованість по днях (один ряд, одна вісь — %)
export async function renderC4(root) {
  const rows = await get('losses/strength');
  const c = card(root, { id: 'c4', title: 'Укомплектованість особовим складом по днях',
    sub: `% наявних від штатної чисельності (обрані підрозділи); пунктир — ${NORM_MANNING} % (умовний норматив)`, wide: true });
  if (!rows.some((r) => r.manning_pct !== null)) return c.empty();
  const opts = baseOptions({ legend: false, yTitle: '%', unit: '%' });
  // Лінійний графік: вісь підлаштовано під дані (це не стовпчики, нуль не обов'язковий); норматив завжди видно
  const vals = rows.map((r) => r.manning_pct).filter((v) => v !== null);
  opts.scales.y.beginAtZero = false;
  opts.scales.y.min = Math.max(0, Math.floor(Math.min(...vals, NORM_MANNING) - 3));
  opts.scales.y.max = Math.min(105, Math.ceil(Math.max(...vals, NORM_MANNING) + 3));
  opts.plugins.refline = { value: NORM_MANNING, label: `${NORM_MANNING} %` };
  c.chart({
    type: 'line',
    data: { labels: rows.map((r) => periodLabel(r.period, 'day')),
      datasets: [lineDataset('Укомплектованість', rows.map((r) => r.manning_pct), '--c-sea')] },
    options: opts,
    plugins: [refLinePlugin],
  });
  c.setTable([{ key: 'p', title: 'Дата' }, { key: 'authorized', title: 'За штатом, осіб' }, { key: 'present', title: 'У наявності, осіб' },
    { key: 'manning_pct', title: 'Укомплектованість, %', fmt: one }, { key: 'replenished', title: 'Прибуло поповнення, осіб' }],
  rows.map((r) => ({ p: d(r.period), ...r })));
}

// C5: підрозділи з найнижчою укомплектованістю на кінець періоду
export async function renderC5(root) {
  const all = await get('losses/strength-by-unit');
  const rows = all.slice(0, 15);
  const c = card(root, { id: 'c5', title: 'Підрозділи з найнижчою укомплектованістю',
    sub: `% на кінець періоду, 15 найнижчих з ${num(all.length)}; червоний — менше 70 %, золотий — менше ${NORM_MANNING} %` });
  if (!rows.length) return c.empty();
  const col = (v) => color(v < 70 ? '--c-red' : v < NORM_MANNING ? '--c-gold' : '--c-sea');
  const opts = baseOptions({ horizontal: true, legend: false, yTitle: '%', unit: '%' });
  opts.scales.x.max = 100;
  opts.scales.y.ticks.autoSkip = false;
  opts.plugins.refline = { value: NORM_MANNING, label: `${NORM_MANNING} %` };
  c.chart({
    type: 'bar',
    data: { labels: rows.map((r) => r.short_name),
      datasets: [barDataset('Укомплектованість', rows.map((r) => r.manning_pct), '--c-sea', { extra: { backgroundColor: rows.map((r) => col(r.manning_pct)) } })] },
    options: opts,
    plugins: [refLinePlugin],
  });
  c.setTable([{ key: 'short_name', title: 'Підрозділ' }, { key: 'e', title: 'Ланка' }, { key: 'authorized', title: 'За штатом, осіб' },
    { key: 'present', title: 'У наявності, осіб' }, { key: 'manning_pct', title: 'Укомплектованість, %', fmt: one },
    { key: 'replenished', title: 'Поповнення за період, осіб' }],
  all.map((r) => ({ e: label('echelon', r.echelon), ...r })));
}
