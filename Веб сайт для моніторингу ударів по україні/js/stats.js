import { store, ALERT_TYPES, ALERT_TYPE_KEYS } from './state.js';

const isAlertStart = (e) => e.threatType !== 'alert_end';

const INK_SECONDARY = '#c3c2b7';
const INK_MUTED = '#898781';
const GRIDLINE = '#2c2c2a';
const SURFACE_2 = '#212120';
const SEQ_BLUE = '#3987e5';

let barChart, lineChart, donutChart;

Chart.defaults.font.family = "system-ui, -apple-system, 'Segoe UI', sans-serif";
Chart.defaults.font.size = 12;
Chart.defaults.color = INK_SECONDARY;

function commonTooltip(extra = {}) {
  return {
    backgroundColor: SURFACE_2,
    titleColor: '#ffffff',
    bodyColor: '#ffffff',
    borderColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
    padding: 10,
    displayColors: true,
    ...extra,
  };
}

function topOblastsData() {
  const counts = new Map();
  for (const e of store.events) {
    if (!isAlertStart(e)) continue;
    counts.set(e.oblastIso, (counts.get(e.oblastIso) || 0) + 1);
  }
  const rows = [...counts.entries()]
    .map(([iso, count]) => ({ iso, name: store.oblastByIso(iso)?.name_ua ?? iso, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  return rows;
}

function dailyTimelineData(days = 14) {
  const buckets = [];
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 86400000);
    buckets.push({ day, count: 0 });
  }
  for (const e of store.events) {
    if (!isAlertStart(e)) continue;
    const t = new Date(e.timestamp).getTime();
    for (const b of buckets) {
      if (t >= b.day.getTime() && t < b.day.getTime() + 86400000) { b.count++; break; }
    }
  }
  return buckets;
}

// Донат — категорійна форма, де будь-які дві частки можуть опинитись поруч
// ("all-pairs"), тож за палітрою dataviz безпечно тримати лише перші 3
// категорійні слоти (blue/orange/aqua); решту типів (хімічна/ядерна —
// у реальності вкрай рідкісні) згортаємо в нейтральне "Інше".
const DONUT_PRIMARY = ['air_raid', 'artillery_shelling', 'urban_fights'];
const OTHER_COLOR = '#898781';

function typeDistributionData() {
  const counts = Object.fromEntries(ALERT_TYPE_KEYS.map((t) => [t, 0]));
  for (const e of store.events) {
    if (counts[e.threatType] !== undefined) counts[e.threatType]++;
  }
  const rows = DONUT_PRIMARY.map((t) => ({ type: t, label: ALERT_TYPES[t].label, color: ALERT_TYPES[t].color, count: counts[t] }));
  const otherCount = ALERT_TYPE_KEYS.filter((t) => !DONUT_PRIMARY.includes(t)).reduce((s, t) => s + counts[t], 0);
  if (otherCount > 0) rows.push({ type: 'other', label: 'Інше (хім./ядерна)', color: OTHER_COLOR, count: otherCount });
  return rows;
}

function renderStatTiles() {
  const today = store.eventsSince(24).filter(isAlertStart);
  const week = store.eventsSince(24 * 7).filter(isAlertStart);
  const activeOblasts = new Set(
    store.oblasts.filter((o) => store.oblastLevel(o.iso) >= 1).map((o) => o.iso)
  );
  const top = topOblastsData()[0];

  document.getElementById('tile-today').textContent = String(today.length);
  document.getElementById('tile-week').textContent = String(week.length);
  const activeEl = document.getElementById('tile-active');
  activeEl.textContent = String(activeOblasts.size);
  activeEl.classList.toggle('crit', activeOblasts.size > 0);
  document.getElementById('tile-top-oblast').textContent = top ? `${top.name} (${top.count})` : '—';
}

function renderBarChart() {
  const rows = topOblastsData();
  const ctx = document.getElementById('chart-oblasts').getContext('2d');
  const data = {
    labels: rows.map((r) => r.name),
    datasets: [{
      label: 'Подій',
      data: rows.map((r) => r.count),
      backgroundColor: SEQ_BLUE,
      borderRadius: 4,
      borderSkipped: 'bottom',
      maxBarThickness: 24,
    }],
  };
  const opts = {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: commonTooltip(),
    },
    scales: {
      x: { grid: { color: GRIDLINE }, ticks: { precision: 0 }, border: { display: false } },
      y: { grid: { display: false }, border: { display: false } },
    },
  };
  if (barChart) { barChart.data = data; barChart.options = opts; barChart.update(); }
  else barChart = new Chart(ctx, { type: 'bar', data, options: opts });
}

function renderLineChart() {
  const buckets = dailyTimelineData(14);
  const lastIndex = buckets.length - 1;
  const ctx = document.getElementById('chart-timeline').getContext('2d');
  const data = {
    labels: buckets.map((b) => b.day.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' })),
    datasets: [{
      label: 'Подій за добу',
      data: buckets.map((b) => b.count),
      borderColor: SEQ_BLUE,
      backgroundColor: 'rgba(57,135,229,0.10)',
      borderWidth: 2,
      fill: true,
      tension: 0.25,
      pointBackgroundColor: SEQ_BLUE,
      pointBorderColor: '#1a1a19',
      pointBorderWidth: 2,
      pointRadius: (c) => (c.dataIndex === lastIndex ? 4 : 0),
      pointHoverRadius: 5,
    }],
  };
  const opts = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: commonTooltip(),
    },
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 7 } },
      y: { grid: { color: GRIDLINE }, ticks: { precision: 0 }, border: { display: false } },
    },
  };
  if (lineChart) { lineChart.data = data; lineChart.options = opts; lineChart.update(); }
  else lineChart = new Chart(ctx, { type: 'line', data, options: opts });
}

function renderDonutChart() {
  const rows = typeDistributionData();
  const ctx = document.getElementById('chart-types').getContext('2d');
  const data = {
    labels: rows.map((r) => r.label),
    datasets: [{
      data: rows.map((r) => r.count),
      backgroundColor: rows.map((r) => r.color),
      borderColor: '#1a1a19',
      borderWidth: 2,
    }],
  };
  const opts = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '62%',
    plugins: {
      legend: { position: 'bottom', labels: { color: INK_SECONDARY, boxWidth: 12, padding: 14 } },
      tooltip: commonTooltip(),
    },
  };
  if (donutChart) { donutChart.data = data; donutChart.options = opts; donutChart.update(); }
  else donutChart = new Chart(ctx, { type: 'doughnut', data, options: opts });
}

export function initStats() {
  renderStatTiles();
  renderBarChart();
  renderLineChart();
  renderDonutChart();
  store.addEventListener('events:changed', () => {
    renderStatTiles();
    renderBarChart();
    renderLineChart();
    renderDonutChart();
  });
}
