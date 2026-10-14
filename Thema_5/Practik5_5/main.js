/* Дашборд 5.5: кожен блок показує свій тип даних
   (скалярні KPI, часовий ряд, категоріальні, агреговані за періодами, матриця, геопросторові, таблиця). */
(function () {
  const D = window.DATA;
  const fmt = n => n.toLocaleString('uk-UA');
  const MONTHS = ['Січ', 'Лют', 'Бер', 'Кві', 'Тра', 'Чер', 'Лип', 'Сер', 'Вер', 'Жов', 'Лис', 'Гру'];
  const C = { yellow: '#d8b944', sand: '#c7b78a', olive: '#7a8a3d', blue: '#4a7c9b', red: '#a4372a', text: '#eef0e4', dim: '#a9b090', grid: 'rgba(199,183,138,0.12)' };

  Chart.defaults.color = C.dim;
  Chart.defaults.font.family = "'Rajdhani', sans-serif";
  Chart.defaults.font.size = 13;
  Chart.defaults.borderColor = C.grid;
  Chart.defaults.plugins.legend.labels.color = C.text;

  // ------------------------------------------------ шапка та KPI (скалярні)
  document.getElementById('data-date').textContent = D.kpi.date;
  document.getElementById('data-day').textContent = `${D.kpi.day}-а доба повномасштабного вторгнення`;
  document.getElementById('source').textContent = D.source;

  const kpis = [
    ['Особовий склад', D.kpi.personnel, D.kpi.personnel_delta],
    ['Танки', D.kpi.tank, D.kpi.tank_delta],
    ['Артсистеми', D.kpi.artillery, D.kpi.artillery_delta],
    ['БпЛА опер.-такт. рівня', D.kpi.drone, D.kpi.drone_delta],
  ];
  document.getElementById('kpi-grid').innerHTML = kpis.map(([label, v, d]) => `
    <div class="kpi">
      <div class="label">${label}</div>
      <div class="value">${fmt(v)}</div>
      <div class="delta">+${fmt(d)} <span class="dim">за останню добу</span></div>
    </div>`).join('');

  // ------------------------------------------------ часові ряди
  const S = D.series;
  let period = 'all';

  function sliceRange() {
    const n = S.dates.length;
    const k = period === 'all' ? n : Math.min(n, Number(period));
    return [n - k, n];
  }

  function rolling(arr, w) {
    const out = [];
    let sum = 0;
    arr.forEach((v, i) => {
      sum += v;
      if (i >= w) sum -= arr[i - w];
      out.push(i >= w - 1 ? Math.round(sum / w) : null);
    });
    return out;
  }

  const timeAxis = { ticks: { maxTicksLimit: 8, maxRotation: 0 }, grid: { display: false } };

  const cumChart = new Chart(document.getElementById('ch-cum'), {
    type: 'line',
    data: { labels: [], datasets: [{
      label: 'Особовий склад (накопичувально)', data: [], borderColor: C.yellow, borderWidth: 2,
      backgroundColor: 'rgba(216,185,68,0.15)', fill: true, pointRadius: 0, tension: 0.1 }] },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + fmt(c.parsed.y) } } },
      scales: { x: timeAxis, y: { ticks: { callback: v => fmt(v) } } },
    },
  });

  const dailyChart = new Chart(document.getElementById('ch-daily'), {
    data: { labels: [], datasets: [
      { type: 'bar', label: 'за добу', data: [], backgroundColor: 'rgba(122,138,61,0.55)', barPercentage: 1, categoryPercentage: 1 },
      { type: 'line', label: 'ковзне середнє (7 діб)', data: [], borderColor: C.yellow, borderWidth: 2, pointRadius: 0 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      scales: { x: timeAxis, y: { beginAtZero: true, ticks: { callback: v => fmt(v) } } },
    },
  });

  function updateTime() {
    const [a, b] = sliceRange();
    const labels = S.dates.slice(a, b);
    cumChart.data.labels = labels;
    cumChart.data.datasets[0].data = S.personnel_cum.slice(a, b);
    cumChart.update();

    const key = document.getElementById('daily-metric').value;
    const full = S[key];
    dailyChart.data.labels = labels;
    dailyChart.data.datasets[0].data = full.slice(a, b);
    dailyChart.data.datasets[1].data = rolling(full, 7).slice(a, b);
    dailyChart.update();
  }

  document.querySelectorAll('#period button').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('#period button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    period = btn.dataset.p;
    updateTime();
  }));
  document.getElementById('daily-metric').addEventListener('change', updateTime);
  updateTime();

  // ------------------------------------------------ категоріальні: структура
  const structChart = new Chart(document.getElementById('ch-structure'), {
    type: 'bar',
    data: {
      labels: D.structure.map(r => r.label),
      datasets: [{ data: D.structure.map(r => r.value), backgroundColor: D.structure.map((_, i) => i < 3 ? C.yellow : C.olive) }],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + fmt(c.parsed.x) } } },
      scales: { x: { type: 'logarithmic', ticks: { callback: v => [1, 10, 100, 1000, 10000, 100000, 1000000].includes(v) ? fmt(v) : '' } },
                y: { grid: { display: false } } },
    },
  });
  document.getElementById('log-scale').addEventListener('change', e => {
    structChart.options.scales.x.type = e.target.checked ? 'logarithmic' : 'linear';
    structChart.options.scales.x.ticks.callback = e.target.checked
      ? v => [1, 10, 100, 1000, 10000, 100000, 1000000].includes(v) ? fmt(v) : ''
      : v => fmt(v);
    structChart.update();
  });

  // ------------------------------------------------ порівняння періодів
  const Y = D.years;
  const yearChart = new Chart(document.getElementById('ch-years'), {
    type: 'bar',
    data: { labels: Y.years, datasets: [{ data: [], backgroundColor: Y.years.map((_, i) => i === Y.years.length - 1 ? C.yellow : C.blue) }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${fmt(c.parsed.y)} на добу` } } },
      scales: { y: { beginAtZero: true, title: { display: true, text: 'середнє на добу', color: C.dim } }, x: { grid: { display: false } } },
    },
  });
  function updateYears() {
    yearChart.data.datasets[0].data = Y[document.getElementById('year-metric').value];
    yearChart.update();
  }
  document.getElementById('year-metric').addEventListener('change', updateYears);
  updateYears();

  // ------------------------------------------------ матриця: теплова карта
  const M = D.matrix;
  const flat = M.values.flat().filter(v => v !== null);
  const lo = Math.min(...flat), hi = Math.max(...flat);
  const stops = [[232, 223, 195], [216, 185, 68], [192, 102, 45], [125, 31, 23]];
  function heatColor(v) {
    const t = (v - lo) / (hi - lo) * (stops.length - 1);
    const i = Math.min(Math.floor(t), stops.length - 2), f = t - i;
    const c = stops[i].map((x, k) => Math.round(x + (stops[i + 1][k] - x) * f));
    return { bg: `rgb(${c})`, fg: t > 1.6 ? '#fff' : '#1c2213' };
  }
  let html = '<tr><th></th>' + M.months.map(m => `<th>${MONTHS[m - 1]}</th>`).join('') + '</tr>';
  M.years.forEach((y, r) => {
    html += `<tr><th>${y}</th>` + M.values[r].map((v, c) => {
      if (v === null) return '<td class="empty">—</td>';
      const col = heatColor(v);
      return `<td style="background:${col.bg};color:${col.fg}" title="${MONTHS[M.months[c] - 1]} ${y}: ${fmt(v)} на добу">${fmt(v)}</td>`;
    }).join('') + '</tr>';
  });
  document.getElementById('heatmap').innerHTML = html;
  document.getElementById('hm-min').textContent = fmt(lo);
  document.getElementById('hm-max').textContent = fmt(hi);

  // ------------------------------------------------ геопросторові: карта
  const G = D.geo;
  const totalDays = G.points.reduce((s, p) => s + p.days, 0);
  document.getElementById('geo-note').textContent =
    `Кількість діб, коли напрямок вказано як напрямок найбільших втрат (дані за ${G.period}). Розмір кола ∝ кількості діб.`;

  const rankEl = document.getElementById('geo-rank');
  if (window.L) {
    const map = L.map('map', { zoomSnap: 0.5 }).setView([48.6, 35.5], 6.5);
    // Без тайлової підкладки: межі областей з локального GeoJSON — карта працює без API-ключів
    map.attributionControl.addAttribution('Межі областей: geoBoundaries / OpenStreetMap');
    L.geoJSON(window.OBLASTS, {
      style: { color: '#c7b78a', weight: 1, fillColor: '#4b5320', fillOpacity: 0.25 },
      onEachFeature: (f, layer) => layer.bindTooltip(f.properties.name_ua, { sticky: true }),
    }).addTo(map);
    const maxDays = Math.max(...G.points.map(p => p.days));
    const markers = G.points.map(p => L.circleMarker([p.lat, p.lon], {
      radius: 6 + 26 * Math.sqrt(p.days / maxDays), color: '#d8b944', weight: 2,
      fillColor: '#a4372a', fillOpacity: 0.6,
    }).bindPopup(`<b>${p.name} напрямок</b><br>${p.days} діб (${(100 * p.days / totalDays).toFixed(1)}% згадок)`).addTo(map));
    rankEl.innerHTML = G.points.map((p, i) => `<li data-i="${i}">${p.name} <b>${p.days}</b></li>`).join('');
    rankEl.querySelectorAll('li').forEach(li => li.addEventListener('click', () => {
      const p = G.points[li.dataset.i];
      map.flyTo([p.lat, p.lon], 8);
      markers[li.dataset.i].openPopup();
    }));
  } else {
    document.getElementById('map').innerHTML = '<p class="dim" style="padding:16px">Карта недоступна без інтернету (Leaflet завантажується з CDN).</p>';
    rankEl.innerHTML = G.points.map(p => `<li>${p.name} <b>${p.days}</b></li>`).join('');
  }

  // ------------------------------------------------ таблиця корекцій
  const tbody = document.querySelector('#corr-table tbody');
  function renderTable(q) {
    q = q.trim().toLowerCase();
    const rows = D.corrections.filter(r =>
      !q || r.date.includes(q) || Object.keys(r.changes).some(k => k.toLowerCase().includes(q)));
    tbody.innerHTML = rows.map(r => `<tr><td>${r.date}</td><td>${r.day}</td><td>${
      Object.entries(r.changes).map(([k, v]) =>
        `<span class="tag ${v > 0 ? 'pos' : 'neg'}">${k}: ${v > 0 ? '+' : ''}${fmt(v)}</span>`).join('')
    }</td></tr>`).join('');
    document.getElementById('corr-count').textContent = `Показано ${rows.length} з ${D.corrections.length} записів`;
  }
  document.getElementById('corr-search').addEventListener('input', e => renderTable(e.target.value));
  renderTable('');
})();
