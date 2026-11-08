// Журнал записів: таблиці за п. 2.3 Порядку (нумераційний і тематичний заголовок, «№ з/п», без порожніх клітинок)
import { get, downloadCsv } from './api.js';
import { esc, num } from './format.js';
import { periodText } from './charts/common.js';

const MODS = [['air', 'Повітряні удари'], ['alerts', 'Тривоги'], ['artillery', 'Артилерія'], ['counter_battery', 'Контрбатарейна'],
  ['ammo', 'Боєприпаси'], ['equipment', 'Озброєння'], ['losses', 'Втрати'], ['strength', 'Укомплектованість'], ['docs', 'Документи ОКП']];
const st = { module: 'air', q: '', sort: null, desc: true, offset: 0, limit: 50 };

export async function renderJournal(root) {
  root.innerHTML = `
    <div class="journal-bar">
      <div class="seg" role="group" aria-label="Модуль">${MODS.map(([k, n]) =>
  `<button type="button" data-m="${k}" aria-pressed="${k === st.module}">${n}</button>`).join('')}</div>
      <label class="sr-only" for="jq">Пошук</label>
      <input id="jq" type="search" placeholder="Пошук: область, підрозділ, номер…" value="${esc(st.q)}">
      <button type="button" class="btn" id="jcsv">Експорт CSV</button>
    </div>
    <div id="jtable" aria-live="polite"></div>
    <div class="pager"><button type="button" class="btn sm" id="jprev">← Попередні</button>
      <span id="jinfo"></span><button type="button" class="btn sm" id="jnext">Наступні →</button></div>`;
  root.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => {
    Object.assign(st, { module: b.dataset.m, sort: null, offset: 0 });
    renderJournal(root);
  }));
  let t;
  root.querySelector('#jq').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { st.q = e.target.value.trim(); st.offset = 0; load(root); }, 300);
  });
  root.querySelector('#jcsv').addEventListener('click', () => downloadCsv(st.module, st.q ? { q: st.q } : {})
    .catch((e) => alert(`Не вдалося експортувати: ${e.message}`)));
  root.querySelector('#jprev').addEventListener('click', () => { st.offset = Math.max(0, st.offset - st.limit); load(root); });
  root.querySelector('#jnext').addEventListener('click', () => { st.offset += st.limit; load(root); });
  await load(root);
}

async function load(root) {
  const extra = { limit: st.limit, offset: st.offset, desc: st.desc };
  if (st.q) extra.q = st.q;
  if (st.sort) extra.sort = st.sort;
  const j = await get(`journal/${st.module}`, extra);
  const head = ['<th scope="col">№ з/п</th>', ...j.columns.map((c) =>
    `<th scope="col" aria-sort="${st.sort === c.key ? (st.desc ? 'descending' : 'ascending') : 'none'}">
      <button type="button" data-sort="${c.key}">${esc(c.title)}${st.sort === c.key ? (st.desc ? ' ▼' : ' ▲') : ''}</button></th>`)].join('');
  const body = j.rows.map((r, i) => `<tr><td class="n">${num(st.offset + i + 1)}</td>${j.columns.map((c) =>
    `<td class="${typeof r[c.key] === 'number' ? 'n' : ''}">${esc(typeof r[c.key] === 'number' ? num(r[c.key]) : r[c.key])}</td>`).join('')}</tr>`).join('');
  root.querySelector('#jtable').innerHTML = `<div style="overflow:auto;max-height:640px"><table class="t">
    <caption><span class="num">Таблиця 1</span>${esc(j.title)} за ${esc(periodText())}${st.q ? ` (пошук: «${esc(st.q)}»)` : ''}</caption>
    <thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${j.columns.length + 1}">Записів немає.</td></tr>`}</tbody></table></div>`;
  root.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
    if (st.sort === b.dataset.sort) st.desc = !st.desc; else { st.sort = b.dataset.sort; st.desc = true; }
    st.offset = 0;
    load(root);
  }));
  root.querySelector('#jinfo').textContent = j.total
    ? `${num(st.offset + 1)}–${num(Math.min(st.offset + st.limit, j.total))} з ${num(j.total)}` : '0 записів';
  root.querySelector('#jprev').disabled = st.offset === 0;
  root.querySelector('#jnext').disabled = st.offset + st.limit >= j.total;
}
