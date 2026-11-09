// Модуль A: A1–A4
import { get } from '../api.js';
import { num, dtg } from '../format.js';
import { PAL, card, baseOptions, barDataset, lineDataset, markersPlugin, periodLabel, bucketText } from './common.js';

export async function renderA1(root) {
  const data = await get('air/timeline');
  const c = card(root, { id: 'a1', title: 'Динаміка застосування засобів повітряного нападу за типами',
    sub: `${bucketText(data.bucket)}, од.; ▼ — масована атака`, wide: true });
  const periods = [...new Set(data.rows.map((r) => r.period))];
  const weapons = [...new Map(data.rows.map((r) => [r.weapon, r])).values()];
  if (!data.rows.some((r) => r.launched)) return c.empty();
  const byKey = new Map(data.rows.map((r) => [`${r.period}|${r.weapon}`, r]));
  const waveIdx = [...new Set(data.waves.map((w) => {
    const day = w.started_at.slice(0, 10);
    return periods.findIndex((p, i) => p <= day && (periods[i + 1] ?? '9999') > day);
  }).filter((i) => i >= 0))];
  c.chart({
    type: 'bar',
    data: {
      labels: periods.map((p) => periodLabel(p, data.bucket)),
      datasets: weapons.map((w, i) => barDataset(w.name_ua, periods.map((p) => byKey.get(`${p}|${w.weapon}`)?.launched ?? 0),
        PAL.weapon[w.weapon], { last: i === weapons.length - 1 })),
    },
    options: { ...baseOptions({ stacked: true, yTitle: 'Запущено, од.', unit: 'од.' }),
      plugins: { ...baseOptions({ unit: 'од.' }).plugins, markers: { indices: waveIdx } } },
    plugins: [markersPlugin],
  });
  c.setTable([{ key: 'period', title: 'Період' }, ...weapons.map((w) => ({ key: w.weapon, title: `${w.name_ua}, од.` }))],
    periods.map((p) => ({ period: periodLabel(p, data.bucket), ...Object.fromEntries(weapons.map((w) => [w.weapon, byKey.get(`${p}|${w.weapon}`)?.launched ?? 0])) })));
  if (data.waves.length) {
    c.el.querySelector('.chart-sub').textContent += ` · масованих атак: ${data.waves.length} (остання ${dtg(data.waves.at(-1).started_at)})`;
  }
}

// A2: дві панелі зі спільною віссю часу замість другої осі Y (одна шкала на графік)
export async function renderA2(root) {
  const data = await get('air/intercept-rate');
  const c = card(root, { id: 'a2', title: 'Запущено і знешкоджено засобів повітряного нападу, частка знешкоджених',
    sub: `${bucketText(data.bucket)}; без КАБ; знешкоджено = збито + подавлено РЕБ`, wide: true, size: 'tall' });
  if (!data.rows.some((r) => r.launched)) return c.empty();
  const labels = data.rows.map((r) => periodLabel(r.period, data.bucket));
  const box = c.el.querySelector('.chart-box');
  box.style.height = 'auto';
  box.innerHTML = `<div style="position:relative;height:250px"><canvas role="img" aria-label="Запущено і знешкоджено, од."></canvas></div>
    <div style="position:relative;height:150px;margin-top:8px"><canvas role="img" aria-label="Частка знешкоджених, %"></canvas></div>`;
  const [cv1, cv2] = box.querySelectorAll('canvas');
  c.canvas = cv1;
  c.chart({
    type: 'bar',
    data: { labels, datasets: [
      barDataset('Запущено', data.rows.map((r) => r.launched), '--c-steel'),
      barDataset('Знешкоджено', data.rows.map((r) => r.intercepted + r.suppressed), '--c-sea'),
    ] },
    options: baseOptions({ yTitle: 'од.', unit: 'од.' }),
  });
  // друга панель — окремий графік зі своєю шкалою %, а не друга вісь Y
  const rateOpts = baseOptions({ yTitle: '%', unit: '%', legend: false });
  rateOpts.scales.y.max = 100;
  c.chart({
    type: 'line',
    data: { labels, datasets: [lineDataset('Частка знешкоджених', data.rows.map((r) => r.rate), '--c-sea', { pointRadius: 2 })] },
    options: rateOpts,
  }, cv2, '-rate');
  c.setTable([{ key: 'p', title: 'Період' }, { key: 'l', title: 'Запущено, од.' }, { key: 'i', title: 'Знешкоджено, од.' },
    { key: 'r', title: 'Частка знешкоджених, %', fmt: (v) => num(v, 1) }],
  data.rows.map((r) => ({ p: periodLabel(r.period, data.bucket), l: r.launched, i: r.intercepted + r.suppressed, r: r.rate })));
}

export async function renderA3(root) {
  const rows = (await get('air/by-oblast')).filter((r) => r.launched > 0).slice(0, 10);
  const c = card(root, { id: 'a3', title: 'Області з найбільшою кількістю засобів повітряного нападу', sub: 'топ-10, од.' });
  if (!rows.length) return c.empty();
  c.chart({
    type: 'bar',
    data: { labels: rows.map((r) => r.name_ua), datasets: [barDataset('Запущено', rows.map((r) => r.launched), '--c-gold')] },
    options: baseOptions({ horizontal: true, legend: false, yTitle: 'од.', unit: 'од.' }),
  });
  c.setTable([{ key: 'name_ua', title: 'Область' }, { key: 'launched', title: 'Запущено, од.' },
    { key: 'intercepted', title: 'Збито, од.' }, { key: 'hits', title: 'Влучання, од.' }], rows);
}

export async function renderA4(root) {
  const rows = (await get('alerts/stats')).slice(0, 15);
  const c = card(root, { id: 'a4', title: 'Тривалість тривог за областями', sub: 'топ-15, год (у межах періоду)' });
  if (!rows.length) return c.empty();
  c.chart({
    type: 'bar',
    data: { labels: rows.map((r) => r.name_ua), datasets: [barDataset('Тривалість', rows.map((r) => Number(r.hours)), '--c-steel')] },
    options: baseOptions({ horizontal: true, legend: false, yTitle: 'год', unit: 'год' }),
  });
  c.setTable([{ key: 'name_ua', title: 'Область' }, { key: 'alerts', title: 'Кількість тривог' },
    { key: 'hours', title: 'Тривалість, год', fmt: (v) => num(v, 1) }], rows);
}
