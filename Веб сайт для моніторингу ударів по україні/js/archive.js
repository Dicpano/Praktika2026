import { store, ALERT_TYPES, fmtDateTime } from './state.js';

const state = { search: '', sortKey: 'timestamp', sortDir: -1 };
let bodyEl = null;

function threatLabel(e) {
  return e.threatType === 'alert_end' ? 'Відбій тривоги' : (ALERT_TYPES[e.threatType]?.label ?? e.threatType);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function filteredSorted() {
  let rows = store.events;
  if (state.search) {
    const q = state.search.toLowerCase();
    rows = rows.filter((e) => {
      const oblast = store.oblastByIso(e.oblastIso);
      return (
        (oblast?.name_ua ?? '').toLowerCase().includes(q) ||
        threatLabel(e).toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q)
      );
    });
  }
  const key = state.sortKey;
  rows = [...rows].sort((a, b) => {
    let va, vb;
    if (key === 'oblast') {
      va = store.oblastByIso(a.oblastIso)?.name_ua ?? a.oblastIso;
      vb = store.oblastByIso(b.oblastIso)?.name_ua ?? b.oblastIso;
    } else {
      va = a[key]; vb = b[key];
    }
    if (va < vb) return -1 * state.sortDir;
    if (va > vb) return 1 * state.sortDir;
    return 0;
  });
  return rows;
}

function render() {
  if (!bodyEl) return;
  const rows = filteredSorted();
  document.getElementById('archive-count').textContent = `${rows.length} подій`;

  if (!rows.length) {
    bodyEl.innerHTML = '<tr><td colspan="4">Нічого не знайдено. Якщо API alerts.in.ua ще не налаштовано, журнал буде порожнім.</td></tr>';
    return;
  }

  bodyEl.innerHTML = rows.slice(0, 500).map((e) => {
    const oblast = store.oblastByIso(e.oblastIso);
    return `<tr>
      <td>${fmtDateTime(e.timestamp)}</td>
      <td>${escapeHtml(oblast?.name_ua ?? e.oblastIso)}</td>
      <td>${escapeHtml(threatLabel(e))}</td>
      <td class="desc-cell">${escapeHtml(e.description)}</td>
    </tr>`;
  }).join('');
}

function toCsv(rows) {
  const header = ['Час', 'Область', 'Тип', 'Опис'];
  const lines = [header.join(';')];
  for (const e of rows) {
    const oblast = store.oblastByIso(e.oblastIso);
    const cells = [
      fmtDateTime(e.timestamp),
      oblast?.name_ua ?? e.oblastIso,
      threatLabel(e),
      e.description,
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`);
    lines.push(cells.join(';'));
  }
  return lines.join('\r\n');
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function initArchive() {
  bodyEl = document.getElementById('archive-body');
  const searchInput = document.getElementById('archive-search');
  const exportBtn = document.getElementById('archive-export');

  searchInput.addEventListener('input', () => { state.search = searchInput.value.trim(); render(); });

  document.querySelectorAll('table.archive th[data-key]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (state.sortKey === key) state.sortDir *= -1;
      else { state.sortKey = key; state.sortDir = -1; }
      render();
    });
  });

  exportBtn.addEventListener('click', () => {
    const csv = '﻿' + toCsv(filteredSorted());
    download(`alerts_${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8');
  });

  store.addEventListener('events:changed', render);
  render();
}
