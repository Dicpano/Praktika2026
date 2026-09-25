// ============================================================
// ЛОГІКА ДАШБОРДУ: рендер компонентів + анімації
// ============================================================

const D = DASHBOARD_DATA;
document.getElementById('unit-name').textContent = D.unit.name;

// ---------- Живий годинник ----------
function tickClock(){
  const now = new Date();
  document.getElementById('clock-time').textContent = now.toLocaleTimeString('uk-UA');
  document.getElementById('clock-date').textContent = now.toLocaleDateString('uk-UA');
}
tickClock(); setInterval(tickClock, 1000);

// ---------- KPI картки з анімованим лічильником ----------
const kpiGrid = document.getElementById('kpi-grid');
D.kpis.forEach((kpi, i) => {
  const card = document.createElement('div');
  card.className = 'kpi-card';
  card.style.animationDelay = (i * 0.08) + 's';
  card.innerHTML = `
    <div class="kpi-label">${kpi.label}</div>
    <div class="kpi-value" data-target="${kpi.value}">${typeof kpi.value === 'number' ? 0 : kpi.value}</div>
    <div class="kpi-delta ${kpi.trend}">${kpi.delta}</div>
  `;
  kpiGrid.appendChild(card);
});

// Анімація підрахунку для числових KPI
document.querySelectorAll('.kpi-value[data-target]').forEach(el => {
  const target = el.getAttribute('data-target');
  const num = Number(target);
  if (Number.isNaN(num)) return; // текстове значення - залишаємо як є
  let current = 0;
  const steps = 40;
  const inc = num / steps;
  const timer = setInterval(() => {
    current += inc;
    if (current >= num){ current = num; clearInterval(timer); }
    el.textContent = Math.round(current);
  }, 25);
});

// ---------- Спільна палітра ----------
const palette = {
  olive: '#7a8a3d', oliveDark:'#4b5320', sand:'#c7b78a',
  yellow:'#d8b944', blue:'#4a7c9b', red:'#a4372a', text:'#eef0e4', grid:'rgba(199,183,138,0.12)'
};

// Захист: якщо Chart.js з CDN не завантажився (немає інтернету/заблокований CDN),
// решта дашборду (карта, мережа, теплокарта, таблиця) все одно має відмалюватись.
const chartsAvailable = typeof Chart !== 'undefined';
if (!chartsAvailable){
  console.warn('Chart.js не завантажився з CDN — перевірте інтернет-з’єднання. Графіки Chart.js буде пропущено.');
  document.querySelectorAll('canvas').forEach(c => {
    const warn = document.createElement('div');
    warn.style.cssText = 'color:#e79285;font-size:12px;padding:10px;';
    warn.textContent = 'Не вдалося завантажити Chart.js з CDN (потрібне інтернет-з’єднання). Перевірте підключення і перезавантажте сторінку.';
    c.replaceWith(warn);
  });
} else {
  Chart.defaults.color = '#a9b090';
  Chart.defaults.font.family = "'Rajdhani', sans-serif";
}

// ---------- Графік 1: динаміка атак (лінія, анімоване малювання) ----------
const dirColors = { "Східний": palette.red, "Північний": palette.blue, "Південний": palette.yellow, "Західний": palette.olive };
if (chartsAvailable) try {
new Chart(document.getElementById('chart-timeline'), {
  type: 'line',
  data: {
    labels: D.timeSeries.days,
    datasets: Object.entries(D.timeSeries.directions).map(([name, values]) => ({
      label: name,
      data: values,
      borderColor: dirColors[name],
      backgroundColor: dirColors[name] + '33',
      tension: 0.35,
      pointRadius: 2,
      borderWidth: 2,
      fill: name === 'Східний',
    })),
  },
  options: {
    animation: { duration: 1600, easing: 'easeOutQuart' },
    plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, padding: 12 } } },
    scales: {
      x: { grid: { color: palette.grid } },
      y: { grid: { color: palette.grid }, beginAtZero: true },
    },
  },
});

// ---------- Графік 2: структура сил (donut) ----------
new Chart(document.getElementById('chart-structure'), {
  type: 'doughnut',
  data: {
    labels: D.enemyStructure.map(d => d.label),
    datasets: [{
      data: D.enemyStructure.map(d => d.value),
      backgroundColor: [palette.oliveDark, palette.olive, palette.yellow, palette.blue, palette.red, palette.sand],
      borderColor: '#232b18',
      borderWidth: 2,
    }],
  },
  options: {
    animation: { animateRotate: true, animateScale: true, duration: 1400 },
    plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, padding: 10, font: { size: 11 } } } },
  },
});

// ---------- Графік 3: порівняння напрямків (bar) ----------
const dirTotals = Object.entries(D.timeSeries.directions).map(([name, vals]) => ({
  name, total: vals.reduce((a,b) => a+b, 0),
}));
new Chart(document.getElementById('chart-bars'), {
  type: 'bar',
  data: {
    labels: dirTotals.map(d => d.name),
    datasets: [{
      label: 'Сумарно атак',
      data: dirTotals.map(d => d.total),
      backgroundColor: dirTotals.map(d => dirColors[d.name] + 'cc'),
      borderRadius: 6,
    }],
  },
  options: {
    animation: { duration: 1200, easing: 'easeOutBack' },
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { display: false } },
      y: { grid: { color: palette.grid }, beginAtZero: true },
    },
  },
});

// ---------- Графік 4: readiness (radar) ----------
new Chart(document.getElementById('chart-radar'), {
  type: 'radar',
  data: {
    labels: D.readiness.labels,
    datasets: D.readiness.units.map(u => ({
      label: u.name,
      data: u.values,
      borderColor: u.color,
      backgroundColor: u.color + '30',
      borderWidth: 2,
      pointRadius: 3,
    })),
  },
  options: {
    animation: { duration: 1500 },
    plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } },
    scales: {
      r: {
        angleLines: { color: palette.grid },
        grid: { color: palette.grid },
        pointLabels: { font: { size: 10 } },
        suggestedMin: 0, suggestedMax: 100,
      },
    },
  },
});
} catch (e) { console.error('Помилка побудови Chart.js графіків:', e); }

// ---------- Схематична карта подій ----------
const mapWrap = document.getElementById('map-wrap');
const tooltip = document.getElementById('map-tooltip');
const intensityClass = { "висока": "high", "середня": "mid", "низька": "low" };
const intensityDot = { "висока": "", "середня": "mid", "низька": "low" };
D.mapEvents.forEach(ev => {
  const dot = document.createElement('div');
  dot.className = 'map-marker ' + (ev.intensity === 'висока' ? '' : ev.intensity === 'середня' ? 'mid' : 'low');
  dot.style.left = ev.x + '%';
  dot.style.top = ev.y + '%';
  dot.addEventListener('mouseenter', () => {
    tooltip.textContent = `${ev.time} · ${ev.type} · інтенсивність: ${ev.intensity}`;
  });
  dot.addEventListener('mouseleave', () => {
    tooltip.textContent = 'Наведіть курсор на маркер для деталей події';
  });
  mapWrap.appendChild(dot);
});

// ---------- Мережевий граф (SVG) ----------
const svgNS = 'http://www.w3.org/2000/svg';
const netSvg = document.getElementById('network-svg');
const nodeById = Object.fromEntries(D.network.nodes.map(n => [n.id, n]));
const groupColor = { command: palette.yellow, staff: palette.blue, unit: palette.olive };

D.network.edges.forEach(([a, b]) => {
  const na = nodeById[a], nb = nodeById[b];
  const line = document.createElementNS(svgNS, 'line');
  line.setAttribute('x1', na.x); line.setAttribute('y1', na.y);
  line.setAttribute('x2', nb.x); line.setAttribute('y2', nb.y);
  line.setAttribute('class', 'net-edge');
  netSvg.appendChild(line);
});

D.network.nodes.forEach(n => {
  const g = document.createElementNS(svgNS, 'g');
  g.setAttribute('class', 'net-node');
  const circle = document.createElementNS(svgNS, 'circle');
  circle.setAttribute('cx', n.x); circle.setAttribute('cy', n.y);
  circle.setAttribute('r', n.group === 'command' ? 16 : 12);
  circle.setAttribute('fill', groupColor[n.group]);
  circle.setAttribute('stroke', '#1c2213');
  circle.setAttribute('stroke-width', '2');
  const label = document.createElementNS(svgNS, 'text');
  label.setAttribute('x', n.x); label.setAttribute('y', n.y + (n.group === 'command' ? 30 : 26));
  label.setAttribute('text-anchor', 'middle');
  label.setAttribute('class', 'net-label');
  label.textContent = n.label;
  g.appendChild(circle); g.appendChild(label);
  netSvg.appendChild(g);
});

// ---------- Кореляційна теплова карта (CSS grid) ----------
const heatmapEl = document.getElementById('heatmap');
const factors = D.correlation.factors;
const matrix = D.correlation.matrix;
function heatColor(v){
  // v в [-1,1] -> від червоного (негативна) через оливковий (0) до жовтого (позитивна)
  if (v >= 0){
    const t = v;
    return `rgba(${Math.round(122+ t*94)}, ${Math.round(138+ t*47)}, ${Math.round(61-t*30)}, ${0.35+t*0.5})`;
  } else {
    const t = -v;
    return `rgba(${Math.round(122+ t*42)}, ${Math.round(138- t*90)}, ${Math.round(61- t*30)}, ${0.35+t*0.5})`;
  }
}
let heatHtml = `<div style="display:grid; grid-template-columns:150px repeat(${factors.length},1fr); gap:3px; font-size:10px;">`;
heatHtml += `<div></div>` + factors.map(f => `<div style="writing-mode:vertical-rl; transform:rotate(180deg); color:var(--text-dim); text-align:left; padding:2px;">${f}</div>`).join('');
factors.forEach((rowLabel, i) => {
  heatHtml += `<div style="color:var(--text-dim); display:flex; align-items:center; padding-right:6px;">${rowLabel}</div>`;
  matrix[i].forEach((v, j) => {
    heatHtml += `<div class="heatmap-cell" title="${rowLabel} × ${factors[j]}: ${v.toFixed(2)}" style="background:${heatColor(v)}; border-radius:4px; aspect-ratio:1; display:flex; align-items:center; justify-content:center; color:#12160b; font-weight:700;">${v.toFixed(2)}</div>`;
  });
});
heatHtml += `</div>`;
heatmapEl.innerHTML = heatHtml;

// ---------- Таблиця подій ----------
const tbody = document.getElementById('events-tbody');
D.eventsTable.forEach((ev, i) => {
  const tr = document.createElement('tr');
  tr.style.animationDelay = (i * 0.05) + 's';
  const cls = ev.intensity === 'Висока' ? 'high' : ev.intensity === 'Середня' ? 'mid' : 'low';
  tr.innerHTML = `
    <td>${ev.time}</td>
    <td>${ev.direction}</td>
    <td>${ev.type}</td>
    <td><span class="badge ${cls}">${ev.intensity}</span></td>
  `;
  tbody.appendChild(tr);
});
