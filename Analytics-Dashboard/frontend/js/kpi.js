// KPI-блоки: значення + зміна до попереднього періоду такої самої довжини
import { get } from './api.js';
import { esc, num, NO_DATA } from './format.js';

export async function renderKpi(root, module) {
  const data = await get('kpi', { module });
  root.innerHTML = data.items.map((k) => {
    const none = k.value === null || k.value === undefined;
    let delta = none ? 'немає даних за обраний період і фільтри' : 'немає даних за попередній період';
    if (k.delta_pct !== null && k.delta_pct !== undefined) {
      const up = k.delta_pct > 0;
      const good = (up && k.better === 'up') || (!up && k.better === 'down');
      const arrow = k.delta_pct === 0 ? '→' : up ? '▲' : '▼';
      delta = `<span class="${k.delta_pct === 0 ? '' : good ? 'good' : 'bad'}">${arrow} ${num(Math.abs(k.delta_pct), 1)} %</span> до попереднього періоду`;
    } else if (!none && k.value === 0 && k.previous === 0) {
      delta = '→ без змін (у попередньому періоді теж 0)';
    }
    const digits = k.unit === '%' || k.unit === 'хв' || k.key === 'docs_per_day' ? 1 : 0;
    // Відсутнє значення — «немає відом.» (п. 2.3.6) звичайним розміром і без одиниці виміру
    const value = none
      ? `<div class="kpi-value na">${NO_DATA}</div>`
      : `<div class="kpi-value">${esc(num(k.value, digits))}<small>${esc(k.unit)}</small></div>`;
    return `<div class="kpi" data-module="${esc(k.module)}">
      <div class="kpi-label">${esc(k.label)}${k.note ? ` <span>(${esc(k.note)})</span>` : ''}</div>
      ${value}
      <div class="kpi-delta">${delta}</div></div>`;
  }).join('');
}
