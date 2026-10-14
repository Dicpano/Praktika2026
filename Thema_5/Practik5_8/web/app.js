// Оперативний Дашборд — Web (simple JS). Дані беруться з FastAPI.
const API_BASE_URL = "http://localhost:8000";

const VIEWS = ["executive", "analyst", "demo"];
const params = new URLSearchParams(location.search);
const VIEW = VIEWS.includes(params.get("view")) ? params.get("view") : "analyst";

const state = { filters: {}, trendGroup: "day", page: 1, pageSize: 20, sort: "occurred_at", order: "desc" };
const charts = {};
const $ = id => document.getElementById(id);
const fmt = n => Number(n).toLocaleString("uk-UA");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

Chart.defaults.color = "#a9b090";
Chart.defaults.borderColor = "rgba(199,183,138,0.12)";
const PALETTE = ["#d8b944", "#7a8a3d", "#4a7c9b", "#c0662d", "#c7b78a", "#a4372a", "#6f8f72", "#8e7cc3"];

// ------------------------------------------------------------------ API
function query(extra = {}) {
  const q = new URLSearchParams();
  Object.entries({ ...state.filters, ...extra }).forEach(([k, v]) => { if (v !== "" && v != null) q.set(k, v); });
  const s = q.toString();
  return s ? "?" + s : "";
}

async function api(path) {
  const res = await fetch(API_BASE_URL + path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : `HTTP ${res.status}`);
  }
  return res.json();
}

function showError(err) {
  const b = $("banner");
  b.hidden = false;
  b.textContent = `Помилка API (${API_BASE_URL}): ${err.message}. Перевірте, що API запущено: uvicorn api.main:app --reload`;
}

// ------------------------------------------------------------------ режими аудиторій
function applyView() {
  document.body.classList.add("view-" + VIEW);
  document.querySelectorAll("[data-show]").forEach(el => {
    el.hidden = !el.dataset.show.split(" ").includes(VIEW);
  });
  document.querySelectorAll("#views a").forEach(a => {
    a.classList.toggle("active", a.dataset.view === VIEW);
    a.href = "?view=" + a.dataset.view;
  });
}
const visible = el => !el.closest("[data-show]") || !el.closest("[data-show]").hidden;

// ------------------------------------------------------------------ фільтри
async function loadFilters() {
  const f = await api("/filters");
  const fill = (id, items) => items.forEach(v => $(id).insertAdjacentHTML("beforeend", `<option>${esc(v)}</option>`));
  fill("f-sector", f.sectors);
  fill("f-direction", f.directions);
  fill("f-type", f.event_types);
  ["f-from", "f-to"].forEach(id => { $(id).min = f.min_date; $(id).max = f.max_date; });
  $("f-from").value = f.min_date;
  $("f-to").value = f.max_date;
}

function readFilters() {
  state.filters = {
    from: $("f-from").value, to: $("f-to").value,
    sector: $("f-sector").value, direction: $("f-direction").value,
    event_type: $("f-type").value, min_intensity: $("f-min").value,
  };
  state.page = 1;
}

// ------------------------------------------------------------------ блоки
async function renderKpi() {
  const k = await api("/kpi" + query());
  $("k-total").textContent = fmt(k.total_incidents);
  $("k-sum").textContent = fmt(k.total_intensity);
  $("k-avg").textContent = k.avg_intensity;
  $("k-top").textContent = k.top_direction ?? "—";
  return k;
}

function drawChart(key, canvasId, config) {
  if (charts[key]) charts[key].destroy();
  charts[key] = new Chart($(canvasId), config);
}

async function renderTrend() {
  const rows = await api("/trend" + query({ group: state.trendGroup }));
  drawChart("trend", "ch-trend", {
    type: state.trendGroup === "day" ? "line" : "bar",
    data: {
      labels: rows.map(r => r.t),
      datasets: [{ label: "Інцидентів", data: rows.map(r => r.value), borderColor: "#d8b944",
        backgroundColor: state.trendGroup === "day" ? "rgba(216,185,68,.15)" : "#7a8a3d",
        fill: true, tension: .25, pointRadius: 0 }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { x: { ticks: { maxTicksLimit: 10 } }, y: { beginAtZero: true } } },
  });
  return rows;
}

async function renderDistributions() {
  const [dirs, types] = await Promise.all([api("/distribution/directions" + query()), api("/distribution/types" + query())]);
  drawChart("dir", "ch-dir", {
    type: "bar",
    data: { labels: dirs.map(r => r.label), datasets: [{ data: dirs.map(r => r.value), backgroundColor: "#4a7c9b" }] },
    options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });
  drawChart("type", "ch-type", {
    type: "doughnut",
    data: { labels: types.map(r => r.label), datasets: [{ data: types.map(r => r.value), backgroundColor: PALETTE, borderColor: "#232b18" }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right" } } },
  });
}

function heatColor(t) {   // 0..1 → пісочний → жовтий → червоний
  const stops = [[232, 223, 195], [216, 185, 68], [164, 55, 42]];
  const x = t * (stops.length - 1), i = Math.min(Math.floor(x), stops.length - 2), f = x - i;
  return `rgb(${stops[i].map((c, k) => Math.round(c + (stops[i + 1][k] - c) * f))})`;
}

async function renderHeatmap() {
  const h = await api("/heatmap" + query());
  const max = Math.max(1, ...h.rows.flatMap(r => r.values));
  let html = "<tr><th></th>" + h.columns.map(c => `<th>${c.slice(5)}</th>`).join("") + "</tr>";
  h.rows.forEach(r => {
    html += `<tr><th class="row">${esc(r.sector)}</th>` + r.values.map((v, i) => v === 0
      ? `<td style="background:rgba(255,255,255,.04);color:#a9b090" title="${esc(r.sector)}, тиждень ${h.columns[i]}">0</td>`
      : `<td style="background:${heatColor(v / max)};color:${v / max > .6 ? "#fff" : "#1c2213"}" title="${esc(r.sector)}, тиждень ${h.columns[i]}: ${v}">${v}</td>`
    ).join("") + "</tr>";
  });
  $("heatmap").innerHTML = h.rows.length ? html : "<tr><td class='dim'>Немає даних для обраних фільтрів</td></tr>";
}

async function renderIncidents() {
  const d = await api("/incidents" + query({ page: state.page, page_size: state.pageSize, sort: state.sort, order: state.order }));
  const pages = Math.max(1, Math.ceil(d.total / d.page_size));
  $("page-info").textContent = `${d.page} / ${pages} · ${fmt(d.total)} записів`;
  $("prev").disabled = d.page <= 1;
  $("next").disabled = d.page >= pages;
  document.querySelectorAll("#inc-table th[data-sort]").forEach(th => {
    th.classList.toggle("sorted", th.dataset.sort === state.sort);
    th.classList.toggle("asc", th.dataset.sort === state.sort && state.order === "asc");
  });
  document.querySelector("#inc-table tbody").innerHTML = d.items.map(r => `
    <tr>
      <td>${r.occurred_at.replace("T", " ")}</td><td>${esc(r.sector)}</td><td>${esc(r.direction)}</td>
      <td>${esc(r.event_type)}</td>
      <td><span class="int" style="background:${heatColor(r.intensity / 50)};color:${r.intensity > 30 ? "#fff" : "#1c2213"}">${r.intensity}</span></td>
      <td class="col-source">${esc(r.source)}</td>
      <td><button data-id="${r.id}" class="details">Details</button></td>
    </tr>`).join("") || `<tr><td colspan="7" class="dim">Немає записів</td></tr>`;
}

async function openDetails(id) {
  const r = await api(`/incidents/${id}`);
  const fields = [["ID", r.id], ["Час", r.occurred_at.replace("T", " ")], ["Сектор", r.sector], ["Напрямок", r.direction],
    ["Тип події", r.event_type], ["Інтенсивність", r.intensity], ["Джерело", r.source], ["Опис", r.summary]]
    .filter(([k]) => !(VIEW === "demo" && k === "Джерело"));   // demo: без поля source
  $("m-title").textContent = `Інцидент №${r.id}`;
  $("m-body").innerHTML = fields.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
  $("modal").hidden = false;
}

// ------------------------------------------------------------------ інсайт (executive)
function buildInsight(kpi, trend, dirs) {
  if (!kpi.total_incidents) return "За обраними фільтрами інцидентів не зафіксовано.";
  const daily = trend.map(r => r.value);
  const last7 = daily.slice(-7).reduce((a, b) => a + b, 0);
  const prev7 = daily.slice(-14, -7).reduce((a, b) => a + b, 0);
  const top = dirs[0];
  const share = Math.round(100 * top.value / kpi.total_incidents);
  let change = "";
  if (prev7 > 0) {
    const pct = Math.round(100 * (last7 - prev7) / prev7);
    change = pct > 10 ? `Активність <b>зростає</b>: +${pct}% за останні 7 днів порівняно з попереднім тижнем (${last7} проти ${prev7}). `
      : pct < -10 ? `Активність <b>знижується</b>: ${pct}% за останні 7 днів (${last7} проти ${prev7}). `
      : `Активність <b>стабільна</b>: ${last7} інцидентів за останні 7 днів (попередній тиждень — ${prev7}). `;
  }
  return `${change}Найбільше навантаження — <b>${esc(top.label)}</b> напрямок (${share}% усіх інцидентів). ` +
    `Середня інтенсивність — ${kpi.avg_intensity} з 50.`;
}

// ------------------------------------------------------------------ оновлення всіх видимих блоків
async function refresh() {
  $("banner").hidden = true;
  try {
    const jobs = [renderKpi(), renderTrend()];
    if (visible($("ch-dir"))) jobs.push(renderDistributions());
    if (visible($("heatmap"))) jobs.push(renderHeatmap());
    if (visible($("inc-table"))) jobs.push(renderIncidents());
    const [kpi] = await Promise.all(jobs);
    if (VIEW === "executive") {
      const [trendDay, dirs] = await Promise.all([api("/trend" + query({ group: "day" })), api("/distribution/directions" + query())]);
      $("insight").innerHTML = buildInsight(kpi, trendDay, dirs);
    }
  } catch (e) { showError(e); }
}

// ------------------------------------------------------------------ події
$("apply").addEventListener("click", () => { readFilters(); refresh(); });
$("reset").addEventListener("click", () => {
  ["f-sector", "f-direction", "f-type", "f-min"].forEach(id => $(id).value = "");
  $("f-from").value = $("f-from").min; $("f-to").value = $("f-to").max;
  readFilters(); refresh();
});
document.querySelectorAll("#trend-group button").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("#trend-group button").forEach(x => x.classList.toggle("active", x === b));
  state.trendGroup = b.dataset.g;
  renderTrend().catch(showError);
}));
$("prev").addEventListener("click", () => { state.page--; renderIncidents().catch(showError); });
$("next").addEventListener("click", () => { state.page++; renderIncidents().catch(showError); });
$("page-size").addEventListener("change", e => { state.pageSize = +e.target.value; state.page = 1; renderIncidents().catch(showError); });
document.querySelectorAll("#inc-table th[data-sort]").forEach(th => th.addEventListener("click", () => {
  state.order = state.sort === th.dataset.sort && state.order === "desc" ? "asc" : "desc";
  state.sort = th.dataset.sort; state.page = 1;
  renderIncidents().catch(showError);
}));
document.querySelector("#inc-table tbody").addEventListener("click", e => {
  const btn = e.target.closest("button.details");
  if (btn) openDetails(btn.dataset.id).catch(showError);
});
$("modal-close").addEventListener("click", () => $("modal").hidden = true);
$("modal").addEventListener("click", e => { if (e.target.id === "modal") $("modal").hidden = true; });
document.addEventListener("keydown", e => { if (e.key === "Escape") $("modal").hidden = true; });

// ------------------------------------------------------------------ старт
applyView();
loadFilters().then(() => { readFilters(); return refresh(); }).catch(showError);
