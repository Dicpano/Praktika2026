// Модуль B: B1–B7
import { get } from '../api.js';
import { label } from '../state.js';
import { num } from '../format.js';
import { PAL, card, baseOptions, barDataset, periodLabel, bucketText, color, refLinePlugin } from './common.js';

// B1: дзеркальні стовпчики — вихідний вогонь угору, вхідний униз
export async function renderB1(root) {
  const data = await get('artillery/timeline');
  const c = card(root, { id: 'b1', title: 'Обстріли: вогонь противника і вогонь своїх засобів',
    sub: `${bucketText(data.bucket)}, кількість обстрілів; вогонь противника — униз від нуля`, wide: true });
  if (!data.rows.some((r) => r.shellings)) return c.empty();
  const periods = [...new Set(data.rows.map((r) => r.period))];
  const get_ = (p, dir) => data.rows.find((r) => r.period === p && r.direction === dir)?.shellings ?? 0;
  const opts = baseOptions({ stacked: true, yTitle: 'обстрілів', unit: 'обстрілів' });
  opts.scales.y.ticks.callback = (v) => num(Math.abs(v));
  opts.plugins.tooltip.callbacks.label = (ctx) => `${ctx.dataset.label}: ${num(Math.abs(ctx.parsed.y))} обстрілів`;
  c.chart({
    type: 'bar',
    data: { labels: periods.map((p) => periodLabel(p, data.bucket)), datasets: [
      barDataset(label('direction', 'outgoing'), periods.map((p) => get_(p, 'outgoing')), PAL.direction.outgoing),
      barDataset(label('direction', 'incoming'), periods.map((p) => -get_(p, 'incoming')), PAL.direction.incoming),
    ] },
    options: opts,
  });
  c.setTable([{ key: 'p', title: 'Період' }, { key: 'o', title: 'Вогонь своїх засобів, обстрілів' },
    { key: 'i', title: 'Вогонь противника, обстрілів' }],
  periods.map((p) => ({ p: periodLabel(p, data.bucket), o: get_(p, 'outgoing'), i: get_(p, 'incoming') })));
}

export async function renderB2(root) {
  const rows = await get('artillery/by-system');
  const c = card(root, { id: 'b2', title: 'Кількість пострілів за типами систем', sub: 'пострілів', wide: true });
  if (!rows.length) return c.empty();
  const systems = ['mortar', 'howitzer', 'gun', 'mlrs', 'tank'];
  const v = (s, d) => rows.find((r) => r.system_type === s && r.direction === d)?.rounds ?? 0;
  systems.sort((a, b) => (v(b, 'incoming') + v(b, 'outgoing')) - (v(a, 'incoming') + v(a, 'outgoing')));
  c.chart({
    type: 'bar',
    data: { labels: systems.map((s) => label('system_type', s)), datasets: [
      barDataset(label('direction', 'incoming'), systems.map((s) => v(s, 'incoming')), PAL.direction.incoming),
      barDataset(label('direction', 'outgoing'), systems.map((s) => v(s, 'outgoing')), PAL.direction.outgoing),
    ] },
    options: baseOptions({ horizontal: true, yTitle: 'пострілів', unit: 'пострілів' }),
  });
  c.setTable([{ key: 's', title: 'Система' }, { key: 'i', title: 'Вогонь противника, пострілів' },
    { key: 'o', title: 'Вогонь своїх засобів, пострілів' }],
  systems.map((s) => ({ s: label('system_type', s), i: v(s, 'incoming'), o: v(s, 'outgoing') })));
}

// B3: теплокарта 24×7 (HTML-сітка: послідовна шкала одного тону)
export async function renderB3(root) {
  const rows = await get('artillery/heatmap');
  const c = card(root, { id: 'b3', title: 'Вогонь противника за годинами доби і днями тижня',
    sub: 'кількість обстрілів; київський час', wide: true, html: true });
  const max = Math.max(1, ...rows.map((r) => r.shellings));
  const ramp = [1, 2, 3, 4, 5].map((i) => color(`--seq-${i}`));
  const step = (v) => (v === 0 ? ramp[0] : ramp[Math.min(4, 1 + Math.floor((v / max) * 3.999))]);
  const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
  let html = '<div class="heat"><div></div>';
  for (let h = 0; h < 24; h += 1) html += `<div class="lbl">${h % 3 === 0 ? String(h).padStart(2, '0') : ''}</div>`;
  for (let wd = 1; wd <= 7; wd += 1) {
    html += `<div class="lbl">${days[wd - 1]}</div>`;
    for (let h = 0; h < 24; h += 1) {
      const r = rows.find((x) => x.weekday === wd && x.hour === h);
      html += `<div class="c" style="background:${step(r.shellings)}" title="${days[wd - 1]}, ${String(h).padStart(2, '0')}.00–${String(h).padStart(2, '0')}.59: ${num(r.shellings)} обстрілів, ${num(r.rounds)} пострілів"></div>`;
    }
  }
  html += '</div><div class="heat-legend">менше'
    + ramp.map((col) => `<span class="sw" style="background:${col}"></span>`).join('') + `більше (макс. ${num(max)} обстрілів)</div>`;
  c.htmlBox.innerHTML = html;
  c.setTable([{ key: 'd', title: 'День тижня' }, { key: 'h', title: 'Година' }, { key: 's', title: 'Обстрілів' }, { key: 'r', title: 'Пострілів' }],
    rows.map((r) => ({ d: days[r.weekday - 1], h: `${String(r.hour).padStart(2, '0')}.00`, s: r.shellings, r: r.rounds })));
}

const MIN_DAYS = 5;   // мінімальний запас боєприпасів, діб вогню (умовний норматив)
const one = (x) => (x === null || x === undefined ? null : num(x, 1));

// B4: запас боєприпасів у добах вогню — один ряд, колір стовпчика за станом (червоний — менше 3 діб)
export async function renderB4(root) {
  const rows = await get('artillery/ammo');
  const c = card(root, { id: 'b4', title: 'Запас боєприпасів у добах вогню на кінець періоду',
    sub: `залишок ÷ середньодобова витрата за останні 7 діб; пунктир — мінімальний запас ${MIN_DAYS} діб (умовний); червоний — менше 3 діб` });
  if (!rows.length) return c.empty();
  const shown = rows.filter((r) => r.days_of_fire !== null);
  const col = (v) => color(v < 3 ? '--c-red' : v < MIN_DAYS ? '--c-gold' : '--c-sea');
  const opts = baseOptions({ horizontal: true, legend: false, yTitle: 'діб вогню', unit: 'діб' });
  opts.plugins.refline = { value: MIN_DAYS, label: `мін. ${MIN_DAYS} діб` };
  c.chart({
    type: 'bar',
    data: { labels: shown.map((r) => label('ammo_type', r.ammo_type)),
      datasets: [barDataset('Запас', shown.map((r) => r.days_of_fire), '--c-sea', { extra: { backgroundColor: shown.map((r) => col(r.days_of_fire)) } })] },
    options: opts,
    plugins: [refLinePlugin],
  });
  c.setTable([{ key: 'a', title: 'Вид боєприпасів' }, { key: 'expended', title: 'Витрачено за період, шт.' },
    { key: 'received', title: 'Надійшло за період, шт.' }, { key: 'stock', title: 'Залишок, шт.' },
    { key: 'avg_daily', title: 'Середньодобова витрата, шт.', fmt: one }, { key: 'days_of_fire', title: 'Запас, діб вогню', fmt: one }],
  rows.map((r) => ({ a: label('ammo_type', r.ammo_type), ...r })));
}

// B5: витрата боєприпасів за родами (складені стовпчики)
export async function renderB5(root) {
  const data = await get('artillery/ammo-timeline');
  const c = card(root, { id: 'b5', title: 'Витрата боєприпасів артилерійськими підрозділами',
    sub: `${bucketText(data.bucket)}, штук (пострілів)`, wide: true });
  if (!data.rows.some((r) => r.expended)) return c.empty();
  const fams = ['mortar', 'howitzer', 'mlrs'];
  const periods = [...new Set(data.rows.map((r) => r.period))];
  const v = (p, fm) => data.rows.find((r) => r.period === p && r.family === fm)?.expended ?? 0;
  c.chart({
    type: 'bar',
    data: { labels: periods.map((p) => periodLabel(p, data.bucket)),
      datasets: fams.map((fm, i) => barDataset(label('ammo_family', fm), periods.map((p) => v(p, fm)), PAL.system[fm], { last: i === fams.length - 1 })) },
    options: baseOptions({ stacked: true, yTitle: 'шт.', unit: 'шт.' }),
  });
  c.setTable([{ key: 'p', title: 'Період' }, ...fams.map((fm) => ({ key: fm, title: `${label('ammo_family', fm)}, шт.` }))],
    periods.map((p) => ({ p: periodLabel(p, data.bucket), ...Object.fromEntries(fams.map((fm) => [fm, v(p, fm)])) })));
}

// B6: контрбатарейна боротьба — результат за засобами виявлення
const CB_RES = [['destroyed', '--c-sea'], ['damaged', '--c-storm'], ['suppressed', '--c-steel'], ['no_effect', '--c-step'],
  ['unknown', '--c-olive'], ['no_response', '--c-marun']];
export async function renderB6(root) {
  const rows = await get('artillery/counter-battery');
  const c = card(root, { id: 'b6', title: 'Контрбатарейна боротьба: виявлені позиції противника і результат',
    sub: 'кількість виявлених вогневих позицій за засобом виявлення; у підписі — медіана часу реакції', wide: true });
  if (!rows.some((r) => r.detected)) return c.empty();
  const labels = rows.map((r) => `${label('detected_by', r.detected_by)}${r.median_min !== null ? ` (${num(r.median_min, 1)} хв)` : ''}`);
  c.chart({
    type: 'bar',
    data: { labels, datasets: CB_RES.map(([k, tok], i) => barDataset(label('result', k), rows.map((r) => r[k]), tok, { last: i === CB_RES.length - 1 })) },
    options: baseOptions({ horizontal: true, stacked: true, yTitle: 'позицій', unit: 'позицій' }),
  });
  c.setTable([{ key: 'm', title: 'Засіб виявлення' }, { key: 'detected', title: 'Виявлено позицій' }, { key: 'responded', title: 'Відкрито вогонь' },
    { key: 'response_pct', title: 'Частка відповідей, %', fmt: one }, { key: 'median_min', title: 'Медіана часу реакції, хв', fmt: one },
    ...CB_RES.map(([k]) => ({ key: k, title: label('result', k) }))],
  rows.map((r) => ({ m: label('detected_by', r.detected_by), ...r })));
}

// B7: стан артилерійського озброєння за зразками
export async function renderB7(root) {
  const rows = await get('artillery/equipment');
  const c = card(root, { id: 'b7', title: 'Стан артилерійського озброєння за зразками',
    sub: 'одиниць; за останнім щотижневим донесенням у періоді' });
  if (!rows.length) return c.empty();
  const lab = rows.map((r) => `${r.model}${r.caliber_mm ? `, ${r.caliber_mm} мм` : ''}`);
  c.chart({
    type: 'bar',
    data: { labels: lab, datasets: [
      barDataset('Справні', rows.map((r) => r.operational), '--c-sea', { last: false }),
      barDataset('У ремонті', rows.map((r) => r.in_repair), '--c-gold'),
    ] },
    options: baseOptions({ horizontal: true, stacked: true, yTitle: 'од.', unit: 'од.' }),
  });
  c.setTable([{ key: 'm', title: 'Зразок' }, { key: 's', title: 'Тип системи' }, { key: 'total', title: 'У наявності, од.' },
    { key: 'operational', title: 'Справні, од.' }, { key: 'in_repair', title: 'У ремонті, од.' },
    { key: 'lost', title: 'Втрачено за період, од.' }, { key: 'ready_pct', title: 'Справних, %', fmt: one }],
  rows.map((r, i) => ({ m: lab[i], s: label('system_type', r.system_type), ...r })));
}
