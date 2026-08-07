import { store, ALERT_TYPES, LEVELS, eventLevel, fmtTime, timeAgo } from './state.js';

const state = { oblastIso: '', threatType: '', hours: 24 };

function populateOblastSelect(sel) {
  sel.innerHTML = '<option value="">Усі області</option>' +
    [...store.oblasts]
      .sort((a, b) => a.name_ua.localeCompare(b.name_ua, 'uk'))
      .map((o) => `<option value="${o.iso}">${o.name_ua}</option>`).join('');
}

function populateThreatSelect(sel) {
  sel.innerHTML = '<option value="">Усі типи</option>' +
    Object.entries(ALERT_TYPES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
}

function matchesFilters(evt) {
  if (state.oblastIso && evt.oblastIso !== state.oblastIso) return false;
  if (state.threatType && evt.threatType !== state.threatType) return false;
  const cutoff = Date.now() - state.hours * 3600 * 1000;
  if (new Date(evt.timestamp).getTime() < cutoff) return false;
  return true;
}

function renderItem(evt, isNew = false) {
  const oblast = store.oblastByIso(evt.oblastIso);
  const level = eventLevel(evt);
  const label = evt.threatType === 'alert_end'
    ? 'Відбій тривоги'
    : (ALERT_TYPES[evt.threatType]?.label ?? evt.threatType);

  const el = document.createElement('div');
  el.className = 'event-item' + (isNew ? ' new' : '');
  el.innerHTML = `
    <span class="level-dot" style="background:${LEVELS[level].color}"></span>
    <div class="body">
      <div class="top-line">
        <span>${oblast ? escapeHtml(oblast.name_ua) : evt.oblastIso}</span>
        <time>${fmtTime(evt.timestamp)} · ${timeAgo(evt.timestamp)}</time>
      </div>
      <div class="desc">${escapeHtml(label)} — ${escapeHtml(evt.description)}</div>
    </div>
  `;
  return el;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let feedEl = null;

function renderAll() {
  if (!feedEl) return;
  feedEl.innerHTML = '';
  const list = store.events.filter(matchesFilters).slice(0, 200);
  if (!list.length) {
    feedEl.innerHTML = '<div class="event-item"><div class="body">Немає подій за обраними фільтрами. Якщо API alerts.in.ua ще не налаштовано — див. вкладку «Про проєкт».</div></div>';
    return;
  }
  const frag = document.createDocumentFragment();
  list.forEach((evt) => frag.appendChild(renderItem(evt)));
  feedEl.appendChild(frag);
}

export function initFeed() {
  feedEl = document.getElementById('event-feed');
  const oblastSel = document.getElementById('feed-filter-oblast');
  const threatSel = document.getElementById('feed-filter-threat');
  const hoursSel = document.getElementById('feed-filter-hours');

  populateOblastSelect(oblastSel);
  populateThreatSelect(threatSel);

  oblastSel.addEventListener('change', () => { state.oblastIso = oblastSel.value; renderAll(); });
  threatSel.addEventListener('change', () => { state.threatType = threatSel.value; renderAll(); });
  hoursSel.addEventListener('change', () => { state.hours = Number(hoursSel.value); renderAll(); });

  store.addEventListener('events:changed', (e) => {
    if (e.detail?.added && matchesFilters(e.detail.added) && !state.oblastIso && !state.threatType) {
      feedEl.prepend(renderItem(e.detail.added, true));
    } else {
      renderAll();
    }
  });

  renderAll();
}
