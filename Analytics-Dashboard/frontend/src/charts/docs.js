// Модуль D: D1–D4. Нормативи часу обробки — умовні (підтвердження замовника очікується).
import { get } from '../api.js';
import { label } from '../state.js';
import { d, dtg, minutes, num } from '../format.js';
import { PAL, card, baseOptions, barDataset, lineDataset, refLinePlugin, periodLabel, tableHtml, color } from './common.js';

export async function renderD1(root) {
  const data = await get('docs/flow');
  const c = card(root, { id: 'd1', title: 'Надходження документів на ОКП за годинами доби і категоріями терміновості',
    sub: 'середня кількість за добу, од.; київський час', wide: true });
  if (!data.rows.some((r) => r.docs)) return c.empty();
  const urg = [...new Map(data.rows.map((r) => [r.urgency, r.name_ua])).entries()];
  const hours = [...Array(24).keys()];
  const v = (h, u) => Number(data.rows.find((r) => r.hour === h && r.urgency === u)?.per_day ?? 0);
  c.chart({
    type: 'bar',
    data: { labels: hours.map((h) => `${String(h).padStart(2, '0')}.00`),
      datasets: urg.map(([u, n], i) => barDataset(n, hours.map((h) => v(h, u)), PAL.urgency[u], { last: i === urg.length - 1 })) },
    options: baseOptions({ stacked: true, yTitle: 'документів за добу', unit: 'од.' }),
  });
  c.setTable([{ key: 'h', title: 'Година' }, ...urg.map(([u, n]) => ({ key: u, title: `${n}, од./добу`, fmt: (x) => num(x, 1) }))],
    hours.map((h) => ({ h: `${String(h).padStart(2, '0')}.00`, ...Object.fromEntries(urg.map(([u]) => [u, v(h, u)])) })));
}

// D2: час обробки у % від нормативу (норматив = 100 %), щоб усі категорії мали одну шкалу
export async function renderD2(root) {
  const rows = await get('docs/sla');
  const c = card(root, { id: 'd2', title: 'Час обробки документів відносно нормативу за категоріями терміновості',
    sub: '% від нормативу; пунктир — норматив (умовний); у підказці — хвилини' });
  if (!rows.some((r) => r.docs)) return c.empty();
  const ratio = (v, r) => (v === null ? null : Math.round((100 * v) / r.norm_min));
  const opts = baseOptions({ horizontal: true, yTitle: '% від нормативу', unit: '%' });
  opts.plugins.refline = { value: 100, label: 'норматив' };
  opts.scales.x.suggestedMax = 120;
  opts.plugins.tooltip.callbacks.label = (ctx) => {
    const r = rows[ctx.dataIndex];
    const m = ctx.datasetIndex === 0 ? r.median_min : r.p90_min;
    return `${ctx.dataset.label}: ${minutes(m)} (${num(ctx.parsed.x)} % від нормативу ${minutes(r.norm_min)})`;
  };
  c.chart({
    type: 'bar',
    data: { labels: rows.map((r) => r.name_ua), datasets: [
      barDataset('Медіана', rows.map((r) => ratio(r.median_min, r)), '--c-storm'),
      barDataset('90-й процентиль', rows.map((r) => ratio(r.p90_min, r)), '--c-steel'),
    ] },
    options: opts,
    plugins: [refLinePlugin],
  });
  c.setTable([{ key: 'name_ua', title: 'Категорія терміновості' }, { key: 'docs', title: 'Документів, од.' },
    { key: 'norm_min', title: 'Норматив (умовний)', fmt: minutes }, { key: 'median_min', title: 'Медіана', fmt: minutes },
    { key: 'p90_min', title: '90-й процентиль', fmt: minutes }, { key: 'overdue_pct', title: 'Прострочено, %', fmt: (x) => num(x, 1) }], rows);
}

export async function renderD3(root) {
  const data = await get('docs/overdue');
  const c = card(root, { id: 'd3', title: 'Частка прострочених документів по днях',
    sub: `%; пунктир — поріг ${num(data.threshold_pct, 1)} % (умовний); червоні точки — перевищення` });
  if (!data.rows.some((r) => r.docs)) return c.empty();
  const red = color('--c-red'), sea = color('--c-sea');
  const opts = baseOptions({ legend: false, yTitle: '%', unit: '%' });
  opts.plugins.refline = { value: data.threshold_pct, label: `поріг ${num(data.threshold_pct, 1)} %` };
  c.chart({
    type: 'line',
    data: { labels: data.rows.map((r) => periodLabel(r.period, 'day')), datasets: [lineDataset('Прострочено', data.rows.map((r) => r.overdue_pct), '--c-sea', {
      pointRadius: data.rows.map((r) => (r.overdue_pct > data.threshold_pct ? 4 : 0)),
      pointBackgroundColor: data.rows.map((r) => (r.overdue_pct > data.threshold_pct ? red : sea)) })] },
    options: opts,
    plugins: [refLinePlugin],
  });
  c.setTable([{ key: 'p', title: 'Дата' }, { key: 'docs', title: 'Документів, од.' }, { key: 'overdue', title: 'Прострочено, од.' },
    { key: 'overdue_pct', title: 'Прострочено, %', fmt: (x) => num(x, 1) }], data.rows.map((r) => ({ p: d(r.period), ...r })));
}

export async function renderD4(root) {
  const rows = await get('docs/queue');
  const c = card(root, { id: 'd4', title: 'Черга необроблених документів', sub: 'на кінець даних; сортування за терміновістю і строком', wide: true, html: true });
  const cols = [
    { key: 'reg_number', title: 'Обліковий номер' }, { key: 'urgency_ua', title: 'Категорія терміновості' },
    { key: 'doc_type', title: 'Вид документа', fmt: (v) => label('doc_type', v) }, { key: 'sender', title: 'Відправник' },
    { key: 'received_at', title: 'Надходження', fmt: dtg }, { key: 'due_at', title: 'Строк', fmt: dtg },
    { key: 'waiting_min', title: 'Очікує', fmt: minutes }, { key: 'status', title: 'Стан', fmt: (v) => label('status', v) },
    { key: 'is_overdue', title: 'Прострочено', fmt: (v) => (v ? 'так' : 'ні') },
  ];
  if (!rows.length) { c.htmlBox.innerHTML = '<div class="empty">Черга порожня.</div>'; return; }
  c.htmlBox.innerHTML = `<div style="max-height:420px;overflow:auto">${tableHtml(`ЧЕРГА необроблених документів ОКП (${num(rows.length)} од.)`, cols, rows)}</div>`;
  c.htmlBox.querySelectorAll('tbody tr').forEach((tr, i) => { if (rows[i].is_overdue) tr.classList.add('overdue'); });
  c.setTable(cols, rows);

}
