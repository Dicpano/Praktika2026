// Спільне для графіків: картка за чеклістом §10.6 ТЗ (назва, підзаголовок з періодом і фільтрами,
// підпис джерела, «Показати таблицю», експорт PNG/CSV, aria-label), кольори з токенів, формати uk-UA.
/* global Chart */
import { state, filterCaption } from '../state.js';
import { d, dtg, esc, num, NO_DATA } from '../format.js';

const charts = new Map();

export function color(token) {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

export const PAL = {
  weapon: { uav_attack: '--c-gold', cruise_missile: '--c-storm', ballistic_missile: '--c-marun', guided_bomb: '--c-step' },
  system: { mortar: '--c-step', howitzer: '--c-storm', gun: '--c-steel', mlrs: '--c-sea', tank: '--c-olive' },
  direction: { incoming: '--c-marun', outgoing: '--c-sea' },
  loss: { killed: '--c-marun', wounded: '--c-gold', missing: '--c-steel' },
  urgency: { horizon: '--c-red', efir: '--c-gold', buran: '--c-storm', zlit: '--c-sea', none: '--c-steel' },
};

export function periodText() {
  return `${d(state.date_from)} – ${d(state.date_to)}`;
}

export function sourceText() {
  const m = state.meta;
  return `Джерело: синтетичні дані (генератор v${m?.generator_version ?? '—'}), станом на ${dtg(m?.data_as_of)}. По навчанню.`;
}

/** Створює картку графіка всередині container. */
export function card(container, { id, title, sub = '', wide = false, size = '', html = false }) {
  const el = document.createElement('article');
  el.className = `card${wide ? ' wide' : ''}`;
  el.id = `card-${id}`;
  const subText = [sub, periodText(), filterCaption()].filter(Boolean).join(' · ');
  el.innerHTML = `
    <header><div class="titles"><h3 class="chart-title" id="t-${id}">${esc(title)}</h3>
      <p class="chart-sub">${esc(subText)}</p></div>
      <div class="tools">
        <button type="button" class="btn sm" data-act="table" aria-pressed="false" aria-controls="tbl-${id}">Таблиця</button>
        ${html ? '' : '<button type="button" class="btn sm" data-act="png">PNG</button>'}
        <button type="button" class="btn sm" data-act="csv">CSV</button>
      </div></header>
    ${html ? `<div class="chart-html" role="img" aria-labelledby="t-${id}"></div>`
    : `<div class="chart-box ${size}"><canvas role="img" aria-label="${esc(title)}"></canvas></div>`}
    <div class="chart-table" id="tbl-${id}"></div>
    <p class="chart-source">${esc(sourceText())}</p>`;
  container.appendChild(el);
  const api = {
    el, id, title,
    canvas: el.querySelector('canvas'),
    htmlBox: el.querySelector('.chart-html'),
    table: { columns: [], rows: [] },
    setTable(columns, rows) {
      api.table = { columns, rows };
      el.querySelector('.chart-table').innerHTML = tableHtml(title, columns, rows);
    },
    chart(config, canvas = api.canvas, suffix = '') {
      charts.get(id + suffix)?.destroy();
      const c = new Chart(canvas, config);
      charts.set(id + suffix, c);
      return c;
    },
    empty(msg = 'Немає даних за обраний період і фільтри.') {
      const box = el.querySelector('.chart-box, .chart-html');
      box.innerHTML = `<div class="empty">${esc(msg)}</div>`;
    },
  };
  el.querySelector('[data-act="table"]').addEventListener('click', (e) => {
    const on = el.classList.toggle('show-table');
    e.currentTarget.setAttribute('aria-pressed', String(on));
  });
  el.querySelector('[data-act="png"]')?.addEventListener('click', () => downloadPng(api));
  el.querySelector('[data-act="csv"]').addEventListener('click', () => downloadCsv(api));
  return api;
}

export function destroyAll() { charts.forEach((c) => c.destroy()); charts.clear(); }

export function tableHtml(title, columns, rows, n = null) {
  const head = ['№ з/п', ...columns.map((c) => c.title)].map((t) => `<th scope="col">${esc(t)}</th>`).join('');
  const body = rows.map((r, i) => `<tr><td class="n">${i + 1}</td>${columns.map((c) => {
    const v = r[c.key];
    const txt = v === null || v === undefined || v === '' ? NO_DATA : (c.fmt ? c.fmt(v, r) : v);
    return `<td class="${typeof v === 'number' ? 'n' : ''}">${esc(txt)}</td>`;
  }).join('')}</tr>`).join('');
  const cap = n ? `<span class="num">Таблиця ${n}</span>` : '';
  return `<table class="t"><caption>${cap}${esc(title)}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function downloadPng(api) {
  const src = api.canvas;
  const c = document.createElement('canvas');
  const pad = 48;
  c.width = src.width; c.height = src.height + pad * 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color('--surface') || '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = color('--text');
  ctx.font = `${Math.round(18 * devicePixelRatio)}px Volja, sans-serif`;
  ctx.fillText(api.title, 8, 28);
  ctx.drawImage(src, 0, pad);
  ctx.font = `${Math.round(11 * devicePixelRatio)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = color('--text-muted');
  ctx.fillText(`${periodText()} · ${sourceText()}`, 8, c.height - 14);
  const a = document.createElement('a');
  a.download = `${api.id}.png`;
  a.href = c.toDataURL('image/png');
  a.click();
}

function downloadCsv(api) {
  const { columns, rows } = api.table;
  const q = (v) => `"${String(v ?? NO_DATA).replace(/"/g, '""')}"`;
  const lines = [q(`${api.title}, ${periodText()}. Синтетичні дані. По навчанню.`),
    ['№ з/п', ...columns.map((c) => c.title)].map(q).join(';'),
    ...rows.map((r, i) => [i + 1, ...columns.map((c) => (c.fmt ? c.fmt(r[c.key], r) : r[c.key]))].map(q).join(';'))];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.download = `${api.id}.csv`;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- Опції Chart.js ----

export function axisTitle(text) { return { display: !!text, text, font: { size: 12 } }; }

export function baseOptions({ yTitle = '', xTitle = '', stacked = false, horizontal = false, legend = true, unit = '' } = {}) {
  const valueAxis = {
    beginAtZero: true, stacked, title: axisTitle(yTitle),
    grid: { color: color('--grid') }, border: { display: false },
    ticks: { callback: (v) => num(v, 1), precision: 0 },
  };
  const catAxis = { stacked, title: axisTitle(xTitle), grid: { display: false }, ticks: { autoSkip: true, maxRotation: 0 } };
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
    indexAxis: horizontal ? 'y' : 'x',
    interaction: { mode: horizontal ? 'nearest' : 'index', intersect: false, axis: horizontal ? 'y' : 'x' },
    scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
    plugins: {
      legend: { display: legend, position: 'bottom', labels: { boxWidth: 12, boxHeight: 12, useBorderRadius: true, borderRadius: 2 } },
      tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${num(ctx.parsed[horizontal ? 'x' : 'y'], 1)}${unit ? ` ${unit}` : ''}` } },
    },
  };
}

// Стовпчики: тонкі, заокруглений лише «кінець» верхнього сегмента, 1 px проміжок кольором поверхні між сегментами
export function barDataset(label, data, token, { last = true, extra = {} } = {}) {
  return {
    label, data, backgroundColor: color(token), borderColor: color('--surface'), borderWidth: 1,
    borderRadius: last ? 4 : 0, borderSkipped: 'start', maxBarThickness: 28, categoryPercentage: 0.8, barPercentage: 0.9, ...extra,
  };
}

export function lineDataset(label, data, token, extra = {}) {
  return { type: 'line', label, data, borderColor: color(token), backgroundColor: color(token), borderWidth: 2,
    pointRadius: 0, pointHoverRadius: 4, tension: 0.2, spanGaps: false, ...extra };
}

// Позначки подій (масовані атаки тощо) над віссю X
export const markersPlugin = {
  id: 'markers',
  afterDatasetsDraw(chart, _args, opts) {
    const idx = opts?.indices || [];
    if (!idx.length) return;
    const { ctx, chartArea, scales } = chart;
    ctx.save();
    ctx.fillStyle = color('--text');
    ctx.strokeStyle = color('--text-muted');
    ctx.setLineDash([3, 3]);
    idx.forEach((i) => {
      const x = scales.x.getPixelForValue(i);
      ctx.beginPath(); ctx.moveTo(x, chartArea.top + 10); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 4, chartArea.top); ctx.lineTo(x + 4, chartArea.top); ctx.lineTo(x, chartArea.top + 7);
      ctx.closePath(); ctx.fill();
    });
    ctx.restore();
  },
};

// Вертикальна референтна лінія (норматив, поріг) на горизонтальному графіку
export const refLinePlugin = {
  id: 'refline',
  afterDatasetsDraw(chart, _args, opts) {
    if (opts?.value === undefined) return;
    const { ctx, chartArea, scales } = chart;
    const horizontal = chart.options.indexAxis === 'y';
    ctx.save();
    ctx.strokeStyle = color('--text');
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    if (horizontal) {
      const x = scales.x.getPixelForValue(opts.value);
      ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom);
    } else {
      const y = scales.y.getPixelForValue(opts.value);
      ctx.moveTo(chartArea.left, y); ctx.lineTo(chartArea.right, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color('--text');
    ctx.font = '12px Volja, "Segoe UI", sans-serif';
    if (horizontal) ctx.fillText(opts.label || '', scales.x.getPixelForValue(opts.value) + 4, chartArea.top + 12);
    else ctx.fillText(opts.label || '', chartArea.right - ctx.measureText(opts.label || '').width - 4, scales.y.getPixelForValue(opts.value) - 6);
    ctx.restore();
  },
};

export function periodLabel(p, bucket) {
  const [, m, dd] = p.split('-');  // рік видно в підзаголовку графіка
  return bucket === 'week' ? `тиж. ${dd}.${m}` : `${dd}.${m}`;
}

export function bucketText(b) { return b === 'week' ? 'по тижнях' : 'по днях'; }
