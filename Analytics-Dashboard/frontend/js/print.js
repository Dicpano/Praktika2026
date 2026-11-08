// Друкована довідка: ті самі фільтри, що й у дашборді (параметри URL). Таблиці за п. 2.3 Порядку.
import { get } from './api.js';
import { state, initFromUrl, label } from './state.js';
import { d, dtg, esc, minutes, num, NO_DATA } from './format.js';

let tableNo = 0;
function table(title, cols, rows) {
  tableNo += 1;
  const head = `<tr><th>№ з/п</th>${cols.map((c) => `<th>${esc(c.title)}</th>`).join('')}</tr>`;
  const body = rows.length ? rows.map((r, i) => `<tr><td class="n">${i + 1}</td>${cols.map((c) => {
    const v = r[c.key];
    const t = v === null || v === undefined || v === '' ? NO_DATA : c.fmt ? c.fmt(v, r) : v;
    return `<td class="${c.n ? 'n' : ''}">${esc(t)}</td>`;
  }).join('')}</tr>`).join('') : `<tr><td>–</td>${cols.map(() => '<td>–</td>').join('')}</tr>`;
  return `<table><caption><span class="num">Таблиця ${tableNo}</span>${esc(title)}</caption><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

async function main() {
  initFromUrl();
  const meta = await get('meta', {}, { filters: false });
  state.labels = await get('dict-labels', {}, { filters: false });
  state.date_to ||= meta.period_to;
  // без параметрів — як у дашборді: останні 30 діб до «станом на»
  state.date_from ||= new Date(Date.parse(`${state.date_to}T12:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
  const [kpi, air, alerts, losses, sla, queue] = await Promise.all([
    get('kpi', { module: 'overview' }), get('air/by-oblast'), get('alerts/stats'), get('losses/by-cause'),
    get('docs/sla'), get('docs/queue', { limit: 15 })]);
  const period = `${d(state.date_from)}–${d(state.date_to)}`;
  const filt = [state.oblast.length ? `області: ${state.oblast.join(', ')}` : '', state.unit.length ? `підрозділи (id): ${state.unit.join(', ')}` : '']
    .filter(Boolean).join('; ');
  const k = Object.fromEntries(kpi.items.map((i) => [i.key, i]));
  const top = air.filter((r) => r.launched > 0).slice(0, 5);

  document.querySelector('#doc').innerHTML = `
    <h1>ДОВІДКА</h1>
    <div class="subtitle">щодо оперативної обстановки за ${esc(period)}<br>(синтетичні дані, навчальний проєкт)</div>
    <p>За період ${esc(period)}${filt ? ` (${esc(filt)})` : ''} противник застосував ${num(k.air_launched.value)} засобів повітряного нападу;
      частка збитих і подавлених (без КАБ) становить ${num(k.air_rate.value, 1)} %. Найбільше засобів зафіксовано в областях:
      ${top.map((r) => `${esc(r.name_ua)} (${num(r.launched)})`).join(', ') || NO_DATA}.</p>
    <p>Зафіксовано ${num(k.art_shellings.value)} обстрілів по наших військах (${num(k.art_rounds.value)} пострілів противника).
      Втрати особового складу за останні 7 діб періоду: санітарні — ${num(k.loss_wounded.value)} осіб, безповоротні — ${num(k.loss_killed.value)} осіб.</p>
    <p>На ОКП надходило в середньому ${num(k.docs_per_day.value, 1)} документів за добу, прострочено ${num(k.docs_overdue.value, 1)} %.
      Нормативи часу обробки умовні.</p>
    ${table(`ОСНОВНІ показники за ${period}`, [
    { key: 'label', title: 'Показник' }, { key: 'v', title: 'Значення', n: true },
    { key: 'p', title: 'Попередній період', n: true }, { key: 'dp', title: 'Зміна, %', n: true }],
  kpi.items.map((i) => ({ label: `${i.label}${i.note ? ` (${i.note})` : ''}, ${i.unit}`, v: num(i.value, 1), p: i.previous === null ? NO_DATA : num(i.previous, 1),
    dp: i.delta_pct === null ? NO_DATA : num(i.delta_pct, 1) })))}
    ${table('ОБЛАСТІ з найбільшою кількістю засобів повітряного нападу', [
    { key: 'name_ua', title: 'Область' }, { key: 'launched', title: 'Запущено, од.', n: true, fmt: num },
    { key: 'intercepted', title: 'Збито, од.', n: true, fmt: num }, { key: 'hits', title: 'Влучання, од.', n: true, fmt: num }], air.filter((r) => r.launched > 0).slice(0, 10))}
    ${table('ТРИВАЛІСТЬ тривог за областями (топ-10)', [
    { key: 'name_ua', title: 'Область' }, { key: 'alerts', title: 'Кількість тривог', n: true, fmt: num },
    { key: 'hours', title: 'Тривалість, год', n: true, fmt: (v) => num(v, 1) }], alerts.slice(0, 10))}
    ${table('ВТРАТИ особового складу за причинами', [
    { key: 'cause', title: 'Причина', fmt: (v) => label('cause', v) }, { key: 'killed', title: 'Безповоротні, осіб', n: true, fmt: num },
    { key: 'wounded', title: 'Санітарні, осіб', n: true, fmt: num }, { key: 'missing', title: 'Зниклі безвісти, осіб', n: true, fmt: num }], losses)}
    ${table('ЧАС обробки документів ОКП за категоріями терміновості', [
    { key: 'name_ua', title: 'Категорія терміновості' }, { key: 'docs', title: 'Документів, од.', n: true, fmt: num },
    { key: 'norm_min', title: 'Норматив (умовний)', fmt: minutes }, { key: 'median_min', title: 'Медіана', fmt: minutes },
    { key: 'p90_min', title: '90-й процентиль', fmt: minutes }, { key: 'overdue_pct', title: 'Прострочено, %', n: true, fmt: (v) => num(v, 1) }], sla)}
    ${table('ЧЕРГА необроблених документів ОКП (перші 15)', [
    { key: 'reg_number', title: 'Обліковий номер' }, { key: 'urgency_ua', title: 'Категорія терміновості' },
    { key: 'doc_type', title: 'Вид документа', fmt: (v) => label('doc_type', v) }, { key: 'sender', title: 'Відправник' },
    { key: 'due_at', title: 'Строк', fmt: dtg }, { key: 'is_overdue', title: 'Прострочено', fmt: (v) => (v ? 'так' : 'ні') }], queue)}
    <div class="foot">Джерело: синтетичні дані (генератор v${esc(meta.generator_version)}), станом на ${esc(dtg(meta.data_as_of))}.
      Час київський. Документ сформовано автоматично в навчальних цілях.</div>`;
}

main().catch((e) => { document.querySelector('#doc').textContent = `Помилка: ${e.message}`; });
