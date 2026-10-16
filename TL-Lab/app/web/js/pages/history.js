// Історія експериментів: усі запуски, динаміка метрик, експорт CSV, видалення.
import { h, api, mount, alert, btn, header, tabs, plot, toast, fmt } from '../ui.js';

let PICK = 'all';
export async function render(root) {
  root.append(header('LOG', 'Історія експериментів', '~/results'));
  const box = h('div');
  root.append(box);
  const draw = async () => {
    const rows = await api('/api/history');
    if (!rows.length) { mount(box, alert('Журнал порожній — запустіть адаптацію в будь-якому модулі.')); return; }
    const mods = ['all', ...new Set(rows.map(r => r.module))].sort();
    const view = rows.filter(r => PICK === 'all' || r.module === PICK).reverse();
    const sel = new Set();
    const delBtn = btn('Видалити позначені', async () => {
      if (!sel.size || !confirm(`Видалити ${sel.size} запусків з журналу?`)) return;
      await api('/api/history/delete', { body: { ids: [...sel] } }); toast('Видалено'); draw();
    }, 'danger');
    const t = h('table.t', h('thead', h('tr', ['', '#', 'Модуль', 'Час', 'Метрика', 'База', 'Адаптація', 'Δ', 'Параметри'].map(c => h('th', c)))),
      h('tbody', view.map(r => {
        const d = typeof r.adapted === 'number' && typeof r.baseline === 'number' ? r.adapted - r.baseline : null;
        const c = h('input', { type: 'checkbox', onchange: () => c.checked ? sel.add(r.i) : sel.delete(r.i) });
        return h('tr', h('td', c), h('td', r.i), h('td.c-cy', r.module.toUpperCase()), h('td', r.time.replace('T', ' ')), h('td', r.metric),
          h('td', fmt(r.baseline)), h('td.c-ok', fmt(r.adapted)), h('td', { class: d === null ? '' : d >= 0 ? 'c-ok' : 'c-er' }, d === null ? '—' : (d >= 0 ? '+' : '') + d.toFixed(3)),
          h('td.small.muted', Object.entries(r.params).filter(([k, v]) => typeof v !== 'object').map(([k, v]) => `${k}=${v}`).join(', ')));
      })));
    const series = PICK === 'all' ? null : rows.filter(r => r.module === PICK);
    mount(box, tabs(mods.map(m => [m, m === 'all' ? 'Усі' : m.toUpperCase()]), PICK, m => { PICK = m; draw(); }, 'small'),
      series && series.length ? plot([
        { x: series.map(r => r.time.replace('T', ' ')), y: series.map(r => r.baseline), name: 'базовий рівень', mode: 'lines+markers', line: { color: '#5f8f99' } },
        { x: series.map(r => r.time.replace('T', ' ')), y: series.map(r => r.adapted), name: 'адаптація', mode: 'lines+markers', line: { color: '#00e5ff' } }],
      { title: `${series[0].metric} за запусками`, yaxis: { title: series[0].metric } }, 300) : null,
      h('div.scroll', { style: { maxHeight: '520px' } }, t),
      h('div.row', { style: { marginTop: '10px' } }, h('a.btn', { href: '/api/history.csv', download: 'experiments.csv' }, '⤓ Експорт CSV'), h('span.grow'), delBtn));
  };
  await draw();
}
