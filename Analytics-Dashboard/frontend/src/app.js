// Точка входу: фільтри, вкладки (hash-маршрути), теми, перемальовування при зміні стану.
/* global Chart */
import { get, mode } from './api.js';
import { state, initFromUrl, setFilters, onChange, query, oblastName } from './state.js';
import { loadChartFonts, applyChartTheme } from './fonts.js';
import { d, dtg, esc } from './format.js';
import { initDateField, setRange, setIso, getIso } from './datefield.js';
import { renderKpi } from './kpi.js';
import { MapView } from './map.js';
import { destroyAll } from './charts/common.js';
import { renderA1, renderA2, renderA3, renderA4 } from './charts/air.js';
import { renderB1, renderB2, renderB3, renderB4, renderB5, renderB6, renderB7 } from './charts/artillery.js';
import { renderC1, renderC2, renderC3, renderC4, renderC5 } from './charts/losses.js';
import { renderD1, renderD2, renderD3, renderD4 } from './charts/docs.js';
import { renderJournal } from './journal.js';
import { renderEntry } from './entry.js';

const maps = {};

// Місця під графіки у фіксованому порядку (дані вантажаться паралельно, порядок не змінюється)
function slots(g, n) {
  return Array.from({ length: n }, () => {
    const s = document.createElement('div');
    s.style.display = 'contents';
    g.appendChild(s);
    return s;
  });
}

const PAGES = {
  overview: async (el) => {
    await renderKpi(el.querySelector('.kpis'), 'overview');
    const s = slots(el.querySelector('.grid'), 4);
    await Promise.all([renderA1(s[0]), renderB1(s[1]), renderC1(s[2]), renderD1(s[3])]);
    maps.overview ??= new MapView(el.querySelector('#map'), { legendEl: el.querySelector('#legend-overview') });
    maps.overview.invalidate();
    await maps.overview.refresh();
  },
  air: async (el) => {
    await renderKpi(el.querySelector('.kpis'), 'air');
    const s = slots(el.querySelector('.grid'), 4);
    await Promise.all([renderA1(s[0]), renderA2(s[1]), renderA3(s[2]), renderA4(s[3])]);
  },
  artillery: async (el) => {
    await renderKpi(el.querySelector('.kpis'), 'artillery');
    const s = slots(el.querySelector('.grid'), 7);
    await Promise.all([renderB1(s[0]), renderB2(s[1]), renderB3(s[2]), renderB6(s[3]), renderB4(s[4]), renderB7(s[5]), renderB5(s[6])]);
  },
  losses: async (el) => {
    await renderKpi(el.querySelector('.kpis'), 'losses');
    const s = slots(el.querySelector('.grid'), 5);
    await Promise.all([renderC1(s[0]), renderC2(s[1]), renderC3(s[2]), renderC4(s[3]), renderC5(s[4])]);
  },
  docs: async (el) => {
    await renderKpi(el.querySelector('.kpis'), 'docs');
    const s = slots(el.querySelector('.grid'), 4);
    await Promise.all([renderD1(s[0]), renderD2(s[1]), renderD3(s[2]), renderD4(s[3])]);
  },
  map: async (el) => {
    maps.full ??= new MapView(el.querySelector('#map-full'), { legendEl: el.querySelector('#legend-full') });
    maps.full.invalidate();
    await maps.full.refresh();
  },
  journal: async (el) => renderJournal(el.querySelector('.journal')),
  entry: async (el) => renderEntry(el.querySelector('.entry')),
  about: async () => {},
};

function currentPage() {
  const h = location.hash.replace('#', '');
  return PAGES[h] ? h : 'overview';
}

let renderSeq = 0;
async function render() {
  const page = currentPage();
  const seq = ++renderSeq;
  document.querySelectorAll('nav.tabs a').forEach((a) => a.setAttribute('aria-current', a.hash === `#${page}` ? 'page' : 'false'));
  document.querySelectorAll('section.page').forEach((s) => s.classList.toggle('active', s.id === `p-${page}`));
  const el = document.getElementById(`p-${page}`);
  destroyAll();
  el.querySelectorAll('.grid').forEach((g) => { g.innerHTML = ''; });
  document.querySelector('.period-plaque').textContent = `${d(state.date_from)} – ${d(state.date_to)}`;
  renderChips();
  try {
    await PAGES[page](el);
  } catch (e) {
    if (seq !== renderSeq) return;
    console.error(e);
    const box = document.createElement('p');
    box.className = 'card';
    box.textContent = `Помилка завантаження даних: ${e.message}`;
    el.prepend(box);
  }
}

function addDays(iso, n) {
  const t = new Date(`${iso}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function buildFilters() {
  const f = document.querySelector('.filters');
  const { period_from: pf, period_to: pt } = state.meta;
  const fFrom = f.querySelector('#f-from'), fTo = f.querySelector('#f-to');
  [fFrom, fTo].forEach((el) => { initDateField(el); setRange(el, pf, pt); });
  setIso(fFrom, state.date_from);
  setIso(fTo, state.date_to);
  f.querySelector('#f-oblast').innerHTML = '<option value="">— додати область —</option>'
    + state.dicts.oblasts.map((o) => `<option value="${esc(o.iso_code)}">${esc(o.name_ua)}</option>`).join('');
  f.querySelector('#f-unit').innerHTML = '<option value="">— додати підрозділ —</option>'
    + state.dicts.units.map((u) => `<option value="${u.id}">${esc(u.short_name)}</option>`).join('');

  const apply = () => {
    let from = getIso(fFrom), to = getIso(fTo);
    if (!from || !to) return;
    if (from > to) [from, to] = [to, from];
    setIso(fFrom, from); setIso(fTo, to);
    setFilters({ date_from: from, date_to: to });
  };
  fFrom.addEventListener('datechange', apply);
  fTo.addEventListener('datechange', apply);
  f.querySelector('#f-preset').addEventListener('change', (e) => {
    const n = Number(e.target.value);
    if (!n) return;
    const to = pt;
    const from = n >= 365 ? pf : addDays(to, -(n - 1));
    setIso(fFrom, from); setIso(fTo, to);
    setFilters({ date_from: from, date_to: to });
  });
  f.querySelector('#f-oblast').addEventListener('change', (e) => {
    if (e.target.value && !state.oblast.includes(e.target.value)) setFilters({ oblast: [...state.oblast, e.target.value] });
    e.target.value = '';
  });
  f.querySelector('#f-unit').addEventListener('change', (e) => {
    const id = Number(e.target.value);
    if (id && !state.unit.includes(id)) setFilters({ unit: [...state.unit, id] });
    e.target.value = '';
  });
  f.querySelector('#f-reset').addEventListener('click', () => {
    const to = pt, from = addDays(pt, -29);
    setIso(fFrom, from); setIso(fTo, to);
    setFilters({ date_from: from, date_to: to, oblast: [], unit: [] });
  });
}

function renderChips() {
  const box = document.querySelector('#f-chips');
  const chips = [
    ...state.oblast.map((o) => ({ t: oblastName(o), rm: () => setFilters({ oblast: state.oblast.filter((x) => x !== o) }) })),
    ...state.unit.map((id) => ({ t: state.dicts.units.find((u) => u.id === id)?.short_name ?? id,
      rm: () => setFilters({ unit: state.unit.filter((x) => x !== id) }) })),
  ];
  box.innerHTML = chips.length ? chips.map((c, i) => `<span class="chip">${esc(c.t)}<button type="button" data-i="${i}" aria-label="Прибрати фільтр ${esc(c.t)}">✕</button></span>`).join('')
    : '<span class="chip">усі області та підрозділи</span>';
  box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => chips[Number(b.dataset.i)].rm()));
}

function setupTheme() {
  const btn = document.querySelector('#theme');
  const names = { auto: 'Тема: авто', light: 'Тема: світла', dark: 'Тема: темна' };
  let mode = 'auto';
  try { mode = localStorage.getItem('theme') || 'auto'; } catch { /* приватний режим */ }
  const apply = () => {
    if (mode === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = mode;
    btn.textContent = names[mode];
  };
  apply();
  btn.addEventListener('click', () => {
    mode = { auto: 'light', light: 'dark', dark: 'auto' }[mode];
    try { localStorage.setItem('theme', mode); } catch { /* ignore */ }
    apply();
    applyChartTheme(Chart);
    render();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyChartTheme(Chart); render(); });
}

async function main() {
  initFromUrl();
  const m = await mode();
  document.documentElement.dataset.mode = m;
  const [meta, oblasts, units, labels] = await Promise.all([
    get('meta', {}, { filters: false }), get('dict/oblasts', {}, { filters: false }),
    get('dict/units', {}, { filters: false }), get('dict-labels', {}, { filters: false })]);
  state.meta = meta;
  state.dicts = { oblasts, units };
  state.labels = labels;
  state.date_to ||= meta.period_to;
  state.date_from ||= addDays(state.date_to, -29);
  history.replaceState(null, '', `${location.pathname}?${query().toString()}${location.hash}`);
  document.querySelector('#asof').textContent = `станом на ${dtg(meta.data_as_of)}`;
  const badge = document.querySelector('#mode');
  badge.textContent = m === 'online' ? 'Сервер: PostgreSQL' : 'Офлайн: знімок бази';
  badge.title = m === 'online' ? 'Дані з PostgreSQL через FastAPI' : `Сервер недоступний або сторінку відкрито як файл. Дані — знімок бази data/dataset.js (сформовано ${meta.snapshot_at ?? '—'}).`;
  document.querySelector('#print').addEventListener('click', () => window.open(`print.html?${query().toString()}`, '_blank'));
  buildFilters();
  setupTheme();
  await loadChartFonts(Chart);
  onChange(() => render());
  window.addEventListener('hashchange', render);
  await render();
}

main().catch((e) => {
  document.querySelector('main').insertAdjacentHTML('afterbegin',
    `<p class="card">Не вдалося завантажити дані: ${esc(e.message)}.<br>Спосіб 1 — сервер: <code>uvicorn backend.app.main:app --reload</code> (або <code>docker compose up -d</code>) і відкрити <code>http://localhost:8000</code>.<br>Спосіб 2 — без сервера: відкрити <code>frontend/index.html</code>; поруч мають бути <code>data/dataset.js</code> і <code>data/geo.js</code> (<code>python -m backend.scripts.export_snapshot</code>, <code>python -m backend.scripts.build_frontend</code>).</p>`);
});
