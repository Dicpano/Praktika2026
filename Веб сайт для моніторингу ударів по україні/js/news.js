import { store } from './state.js';

const SCOPE_LABELS = { global: 'Світ', national: 'Україна', regional: 'Область' };
const state = { scope: '', oblastIso: '', sources: [], allItems: [] };

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtPub(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function populateOblastFilter(sel) {
  const regionalIsos = new Set(state.sources.filter((s) => s.scope === 'regional').map((s) => s.oblastIso));
  const oblasts = store.oblasts.filter((o) => regionalIsos.has(o.iso)).sort((a, b) => a.name_ua.localeCompare(b.name_ua, 'uk'));
  sel.innerHTML = '<option value="">Усі області</option>' + oblasts.map((o) => `<option value="${o.iso}">${o.name_ua}</option>`).join('');
}

function render() {
  const grid = document.getElementById('news-grid');
  let items = state.allItems;
  if (state.scope) items = items.filter((it) => it.scope === state.scope);
  if (state.oblastIso) items = items.filter((it) => it.oblastIso === state.oblastIso);
  items = [...items].sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));

  if (!items.length) {
    grid.innerHTML = '<div class="news-item">Новин не знайдено (спробуйте змінити фільтр або оновити пізніше).</div>';
    return;
  }

  grid.innerHTML = items.slice(0, 120).map((it) => {
    const oblast = it.oblastIso ? store.oblastByIso(it.oblastIso) : null;
    return `
      <article class="news-item">
        <div class="src-line">
          <span class="scope-badge ${it.scope}">${SCOPE_LABELS[it.scope] ?? it.scope}</span>
          <span>${escapeHtml(it.source)}${oblast ? ' · ' + escapeHtml(oblast.name_ua) : ''}</span>
        </div>
        <a class="title" href="${encodeURI(it.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(it.title)}</a>
        <time>${fmtPub(it.pubDate)}</time>
      </article>`;
  }).join('');
}

async function loadSources() {
  const res = await fetch('data/rss-sources.json');
  state.sources = await res.json();
}

async function loadNews(statusEl) {
  statusEl.textContent = 'Оновлення новин…';
  try {
    const res = await fetch('/api/rss/all');
    if (!res.ok) throw new Error('proxy unavailable');
    const results = await res.json();
    const items = [];
    let errCount = 0;
    for (const r of results) {
      if (r.error) errCount++;
      items.push(...r.items);
    }
    state.allItems = items;
    statusEl.textContent = errCount
      ? `Оновлено ${new Date().toLocaleTimeString('uk-UA')} · ${errCount} джерел недоступні`
      : `Оновлено ${new Date().toLocaleTimeString('uk-UA')}`;
    render();
  } catch (err) {
    statusEl.textContent = 'Не вдалося отримати новини. Переконайтесь, що запущено server.py (не просто відкритий index.html).';
  }
}

export async function initNews() {
  await loadSources();
  const scopeSel = document.getElementById('news-filter-scope');
  const oblastSel = document.getElementById('news-filter-oblast');
  const statusEl = document.getElementById('news-status');
  const refreshBtn = document.getElementById('news-refresh');

  populateOblastFilter(oblastSel);

  scopeSel.addEventListener('change', () => { state.scope = scopeSel.value; render(); });
  oblastSel.addEventListener('change', () => { state.oblastIso = oblastSel.value; render(); });
  refreshBtn.addEventListener('click', () => loadNews(statusEl));

  await loadNews(statusEl);
  setInterval(() => loadNews(statusEl), 5 * 60 * 1000);
}
