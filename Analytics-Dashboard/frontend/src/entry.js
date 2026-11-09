// Вкладка «Внесення даних»: форма (один запис) та імпорт файлу (CSV, Excel, JSON).
//   • онлайн — записи йдуть у PostgreSQL через API (origin = manual / import);
//   • офлайн — записи зберігаються в цьому браузері (localStorage), одразу враховуються в графіках
//     і на карті та вивантажуються як .sql (для psql) або .json (для імпорту, коли є сервер).
/* global L, GEO, XLSX */
import { get, post, del, mode, clearCache, saveFile } from './api.js';
import { state } from './state.js';
import { esc, num, dtg } from './format.js';
import { dateFieldHtml, initDateField, setIso, getIso } from './datefield.js';
import * as offline from './offline.js';
import { validate, addLocal, localEntries, removeLocal, clearLocal, exportJson, exportSql, RowError } from './entries-store.js';

const KINDS = [['strike', 'Повітряний удар'], ['alert', 'Тривога'], ['artillery', 'Артилерія'],
  ['counter_battery', 'Контрбатарейна'], ['ammo', 'Боєприпаси'], ['equipment', 'Озброєння'], ['losses', 'Втрати'],
  ['strength', 'Укомплектованість'], ['document', 'Документ ОКП'], ['unit', 'Підрозділ']];
const EXAMPLE = {
  strike: { occurred_at: '2026-11-06 21:40', weapon: 'КАБ', launched: 2, intercepted: 0, suppressed: 0, hits: 2, damage_level: 2,
    target: 'Житловий сектор', lat: 47.84, lon: 35.14, oblast: '', info_source: 'ПвР', reliability: 'B2' },
  alert: { oblast: 'UA-63', alert_type: 'Повітряна тривога', started_at: '2026-11-06 22:05', ended_at: '2026-11-06 23:10' },
  artillery: { occurred_at: '2026-11-06 14:20', direction: 'Вогонь противника', system_type: 'Гаубиця', caliber_mm: 152,
    caliber_class: '', rounds: 6, unit: '', target: '', result: 'немає відом.', lat: 48.6, lon: 38.05, oblast: '', info_source: 'АР', reliability: 'B2' },
  losses: { report_date: '2026-11-06', unit: '', cause: 'Артилерія', killed: 0, wounded: 3, missing: 0, returned_to_duty: 1 },
  counter_battery: { detected_at: '2026-11-06 14:21', detected_by: 'РЛС контрбатарейної боротьби', enemy_system: 'Гаубиця', caliber_mm: 152,
    lat: 48.62, lon: 38.12, oblast: '', unit: '', responded_at: '2026-11-06 14:28', rounds: 6, result: 'подавлено', info_source: 'РЛР', reliability: 'B2' },
  ammo: { report_date: '2026-11-06', unit: '', ammo_type: 'Снаряди 152 мм', expended: 48, received: 120, stock: 310 },
  equipment: { report_date: '2026-11-02', unit: '', model: '2С3 «Акація»', system_type: 'Гаубиця', caliber_mm: 152, operational: 14, in_repair: 3, lost: 0 },
  strength: { report_date: '2026-11-06', unit: '', authorized: 450, present: 382, replenished: 12 },
  document: { reg_number: '', doc_type: 'Бойове донесення', urgency: 'ЗЛІТ', special_mark: '', access_level: 'Відкрито',
    channel: 'АСУ', sender: '', recipient: '', received_at: '2026-11-06 07:30', completed_at: '2026-11-06 08:40', status: '' },
  unit: { short_name: '3 мпр/1 омбр (ум.)', name_ua: '3-тя механізована рота (умовна)', echelon: 'рота', branch: 'механізований',
    parent: '', lat: 48.5, lon: 37.3, oblast: '', is_command_post: 'ні', is_rear: 'ні' },
};

const st = { kind: 'strike', spec: null, dicts: null, rows: null, fileName: '', check: null, map: null, marker: null };

// ---------- Допоміжне ----------
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function findOblast(lat, lon) {
  const feats = [...GEO.oblasts.features].sort((a, b) => !['UA-30', 'UA-40'].includes(a.properties.iso) - !['UA-30', 'UA-40'].includes(b.properties.iso));
  for (const f of feats) {
    const g = f.geometry, polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    if (polys.some((p) => inRing(lon, lat, p[0]) && !p.slice(1).some((h) => inRing(lon, lat, h)))) return f.properties.iso;
  }
  return null;
}
const oblastUa = (iso) => state.dicts.oblasts.find((o) => o.iso_code === iso)?.name_ua ?? iso;

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = Object.assign(document.createElement('script'), { src, onload: res, onerror: () => rej(new Error(`не знайдено ${src}`)) });
    document.head.appendChild(s);
  });
}
async function xlsxLib() { if (!window.XLSX) await loadScript('vendor/sheetjs/xlsx.full.min.js'); return window.XLSX; }

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0];
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((x) => x.trim() !== ''));
  const [head, ...body] = nonEmpty;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

// Ключі колонок: дозволено і ключ (occurred_at), і підпис поля («Дата і час»)
function normalizeKeys(rows, fields) {
  return rows.map((r) => {
    const o = {};
    Object.entries(r).forEach(([k, v]) => {
      const f = fields.find((x) => x.key === k || x.label.toLowerCase() === String(k).trim().toLowerCase());
      o[f ? f.key : k] = v instanceof Date ? v.toISOString().slice(0, 16).replace('T', ' ') : v;
    });
    return o;
  });
}

// ---------- Рендер ----------
export async function renderEntry(root) {
  const m = await mode();
  st.spec ??= await get('entry/spec', {}, { filters: false });
  st.dicts ??= Object.fromEntries(await Promise.all(['weapon-types', 'target-categories', 'info-sources']
    .map(async (k) => [k, await get(`dict/${k}`, {}, { filters: false })])));
  root.innerHTML = `
    <div class="entry-mode card ${m}">${m === 'online'
    ? '<b>Режим: сервер (PostgreSQL).</b> Записи вносяться в базу даних і одразу видно всім, хто відкриває дашборд із цього сервера. Позначка в журналі: «внесено вручну» або «імпорт».'
    : '<b>Режим: офлайн (без сервера).</b> Записи зберігаються лише в цьому браузері й одразу враховуються в графіках і на карті. Щоб перенести їх у PostgreSQL, вивантажте <b>.sql</b> (виконати <code>psql -d dashboard -f entries.sql</code>) або <b>.json</b> (імпортувати тут, коли дашборд працює із сервером).'}</div>
    <div class="seg" role="group" aria-label="Тип запису">${KINDS.map(([k, n]) =>
  `<button type="button" data-k="${k}" aria-pressed="${k === st.kind}">${n}</button>`).join('')}</div>
    <div class="entry-grid">
      <section class="card"><h3 class="chart-title">Новий запис: ${esc(st.spec[st.kind].title)}</h3>
        <form id="e-form" novalidate></form>
        <div id="e-map-box" hidden><div class="hint">Клацніть на карті, щоб задати координати. Область визначиться автоматично.</div><div id="e-map"></div></div>
      </section>
      <section class="card"><h3 class="chart-title">Імпорт з файлу (CSV, Excel, JSON)</h3>
        <p class="hint">Перший рядок — назви колонок: ключ поля (<code>occurred_at</code>) або підпис («Дата і час»). Значення — код або українська назва.
          Час — «РРРР-ММ-ДД ГГ:ХХ» або «ДД.ММ.РРРР ГГ:ХХ», київський. Імпорт «все або нічого»: якщо хоч один рядок з помилкою, не вноситься жоден.</p>
        <div class="row-btns">
          <button type="button" class="btn sm" id="t-csv">Шаблон CSV</button>
          <button type="button" class="btn sm" id="t-xlsx">Шаблон Excel</button>
          <label class="btn sm file">Вибрати файл…<input type="file" id="e-file" accept=".csv,.txt,.xlsx,.xls,.json" hidden></label>
        </div>
        <div id="e-preview" aria-live="polite"></div>
      </section>
    </div>
    <section class="card"><h3 class="chart-title">Внесені записи (${m === 'online' ? 'у базі, крім синтетичних' : 'у цьому браузері'})</h3>
      <div class="row-btns" ${m === 'online' ? 'hidden' : ''}>
        <button type="button" class="btn sm" id="x-sql">Вивантажити .sql</button>
        <button type="button" class="btn sm" id="x-json">Вивантажити .json</button>
        <button type="button" class="btn sm" id="x-clear">Очистити всі</button>
      </div>
      <div id="e-list" aria-live="polite"></div>
    </section>`;
  root.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => {
    Object.assign(st, { kind: b.dataset.k, rows: null, check: null });
    destroyMap();
    renderEntry(root);
  }));
  renderForm(root, m);
  root.querySelector('#t-csv').addEventListener('click', templateCsv);
  root.querySelector('#t-xlsx').addEventListener('click', () => templateXlsx().catch((e) => alert(e.message)));
  root.querySelector('#e-file').addEventListener('change', (e) => onFile(root, m, e.target.files[0]).catch((err) => {
    root.querySelector('#e-preview').innerHTML = `<p class="err">Не вдалося прочитати файл: ${esc(err.message)}</p>`;
  }));
  if (m === 'offline') {
    root.querySelector('#x-sql').addEventListener('click', () => saveFile('entries.sql', exportSql(), 'application/sql;charset=utf-8'));
    root.querySelector('#x-json').addEventListener('click', () => saveFile('entries.json', exportJson(), 'application/json;charset=utf-8'));
    root.querySelector('#x-clear').addEventListener('click', () => {
      if (!localEntries().length || !confirm('Видалити всі записи, внесені в цьому браузері?')) return;
      clearLocal(); afterChange(); renderList(root, m);
    });
  }
  await renderList(root, m);
}

function options(f) {
  const blank = f.required ? '<option value="">— оберіть —</option>' : '<option value="">— немає —</option>';
  let items = [];
  if (f.options) items = f.options.map((o) => [o.value, o.label]);
  else if (f.type === 'oblast') items = state.dicts.oblasts.map((o) => [o.iso_code, o.name_ua]);
  else if (f.type === 'unit') items = state.dicts.units.map((u) => [u.short_name, u.short_name]);
  else if (f.type === 'cp') items = state.dicts.units.filter((u) => u.is_command_post).map((u) => [u.short_name, u.short_name]);
  else if (f.type === 'weapon') items = st.dicts['weapon-types'].map((w) => [w.code, `${w.name_ua} (${w.map_label})`]);
  else if (f.type === 'target') items = st.dicts['target-categories'].map((t) => [t.code, t.name_ua]);
  else if (f.type === 'source') items = st.dicts['info-sources'].map((s) => [s.code, `${s.code} — ${s.name_ua}`]);
  else if (f.type === 'rel') items = 'ABCDEF'.split('').flatMap((a) => [1, 2, 3, 4, 5, 6].map((n) => [`${a}${n}`, `${a}${n}`]));
  return blank + items.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
}

function input(f) {
  const req = f.required ? ' required' : '';
  const id = `f-${f.key}`;
  if (f.type === 'bool') return `<label class="chk"><input type="checkbox" id="${id}" name="${f.key}"> ${esc(f.label)}</label>`;
  let ctl;
  if (['oblast', 'unit', 'cp', 'weapon', 'target', 'source', 'rel'].includes(f.type) || f.type.startsWith('enum:')) {
    ctl = `<select id="${id}" name="${f.key}"${req}>${options(f)}</select>`;
  } else if (f.type === 'ts') ctl = dateFieldHtml(id, { time: true, attrs: ` name="${f.key}"${req}` });
  else if (f.type === 'date') ctl = dateFieldHtml(id, { attrs: ` name="${f.key}"${req}` });
  else if (f.type === 'int') ctl = `<input type="number" step="1" id="${id}" name="${f.key}"${f.min !== undefined ? ` min="${f.min}"` : ''}${f.max !== undefined ? ` max="${f.max}"` : ''}${req}>`;
  else if (f.type === 'lat' || f.type === 'lon') ctl = `<input type="number" step="0.00001" id="${id}" name="${f.key}"${req}>`;
  else ctl = `<input type="text" id="${id}" name="${f.key}" maxlength="128"${req}>`;
  return `<label for="${id}">${esc(f.label)}${f.required ? ' <span class="req" aria-label="обовʼязкове">*</span>' : ''}</label>${ctl}<div class="ferr" data-err="${f.key}"></div>`;
}

function renderForm(root, m) {
  const fields = st.spec[st.kind].fields;
  const form = root.querySelector('#e-form');
  form.innerHTML = `<div class="fgrid">${fields.map((f) => `<div class="fcell ${f.type === 'bool' ? 'wide' : ''}">${input(f)}</div>`).join('')}</div>
    <div class="row-btns"><button type="submit" class="btn primary">Внести запис</button>
      ${fields.some((f) => f.type === 'lat') ? '<button type="button" class="btn sm" id="e-pick">Вибрати точку на карті</button>' : ''}
      <span id="e-msg" role="status"></span></div>`;
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace('T', ' ');
  form.querySelectorAll('.dtext').forEach((el) => initDateField(el));
  fields.filter((f) => f.type === 'ts' && f.required).forEach((f) => { setIso(form.elements[f.key], now); });
  fields.filter((f) => f.type === 'date' && f.required).forEach((f) => { setIso(form.elements[f.key], now.slice(0, 10)); });
  root.querySelector('#e-pick')?.addEventListener('click', () => showMap(root));
  ['lat', 'lon'].forEach((k) => form.elements[k]?.addEventListener('change', () => syncOblast(form)));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.querySelectorAll('.ferr').forEach((x) => { x.textContent = ''; });
    const msg = root.querySelector('#e-msg');
    const values = {};
    fields.forEach((f) => {
      const el = form.elements[f.key];
      if (f.type === 'bool') values[f.key] = el.checked ? 'так' : 'ні';
      else if (f.type === 'ts' || f.type === 'date') {
        el.commitDate?.(false);
        // коректна дата → ISO; некоректний текст передається як є, щоб перевірка показала помилку в полі
        values[f.key] = getIso(el) || el.value.trim();
      } else values[f.key] = el.value;
    });
    msg.className = ''; msg.textContent = 'Перевірка…';
    try {
      if (m === 'online') await post(`entry/${st.kind}`, values);
      else {
        const { row, norm } = validate(st.kind, values, offline.db(), findOblast);
        addLocal(st.kind, row, norm);
      }
      msg.className = 'ok';
      msg.textContent = 'Запис внесено. Графіки, KPI і карта вже його враховують.';
      await afterChange();
      renderList(root, m);
    } catch (err) {
      msg.className = 'err';
      const errors = err.detail?.errors ?? (err instanceof RowError ? [{ field: err.field, message: err.message }] : null);
      if (errors) {
        errors.forEach((x) => { const box = form.querySelector(`[data-err="${x.field}"]`); if (box) box.textContent = x.message; });
        msg.textContent = `Запис не внесено: ${errors.map((x) => x.message).join('; ')}`;
      } else msg.textContent = `Помилка: ${err.message}`;
    }
  });
}

function syncOblast(form) {
  const lat = Number(form.elements.lat?.value), lon = Number(form.elements.lon?.value);
  if (!form.elements.oblast || !Number.isFinite(lat) || !Number.isFinite(lon) || !lat || !lon) return;
  const iso = findOblast(lat, lon);
  const box = form.querySelector('[data-err="oblast"]');
  if (box) box.textContent = iso ? `за координатами: ${oblastUa(iso)}` : 'точка поза межами України';
}

function destroyMap() { st.map?.remove(); st.map = null; st.marker = null; }

function showMap(root) {
  const box = root.querySelector('#e-map-box');
  box.hidden = false;
  const form = root.querySelector('#e-form');
  if (!st.map) {
    st.map = L.map(root.querySelector('#e-map'), { minZoom: 5, maxZoom: 12 }).fitBounds([[44.2, 22.0], [52.45, 40.3]]);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(st.map);
    L.geoJSON(GEO.oblasts, { style: { color: '#4D4634', weight: 0.8, fill: false }, interactive: false }).addTo(st.map);
    GEO.occupied.forEach((p) => L.polygon(p.map((r) => r.map(([x, y]) => [y, x])), { stroke: false, fillColor: '#D40000', fillOpacity: 0.15, interactive: false }).addTo(st.map));
    st.map.on('click', (e) => {
      const { lat, lng } = e.latlng;
      form.elements.lat.value = lat.toFixed(5);
      form.elements.lon.value = lng.toFixed(5);
      if (st.marker) st.marker.setLatLng(e.latlng); else st.marker = L.marker(e.latlng).addTo(st.map);
      syncOblast(form);
    });
  }
  setTimeout(() => st.map.invalidateSize(), 50);
}

async function afterChange() {
  clearCache();
  if (await mode() === 'offline') offline.reload();
  const [meta, units] = await Promise.all([get('meta', {}, { filters: false }), get('dict/units', {}, { filters: false })]);
  state.meta = meta;
  state.dicts.units = units;
  const a = document.querySelector('#asof');
  if (a) a.textContent = `станом на ${dtg(meta.data_as_of)}`;
}

// ---------- Імпорт ----------
async function onFile(root, m, file) {
  if (!file) return;
  const box = root.querySelector('#e-preview');
  box.innerHTML = '<p>Читання файлу…</p>';
  const fields = st.spec[st.kind].fields;
  let rows;
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext === 'json') {
    const j = JSON.parse(await file.text());
    if (j.format === 'dashboard-entries') {
      const kinds = Object.keys(j.entries || {});
      if (kinds.length > 1 || (kinds.length === 1 && kinds[0] !== st.kind)) {
        box.innerHTML = `<p>Файл містить записи типів: ${kinds.map((k) => `${esc(KINDS.find((x) => x[0] === k)?.[1] ?? k)} (${num(j.entries[k].length)})`).join(', ')}.
          Імпортуйте їх по черзі: оберіть тип угорі й виберіть файл ще раз.</p>`;
        rows = j.entries[st.kind] || [];
        if (!rows.length) return;
      } else rows = j.entries[st.kind] || [];
    } else rows = Array.isArray(j) ? j : j.rows;
  } else if (ext === 'xlsx' || ext === 'xls') {
    const X = await xlsxLib();
    const wb = X.read(await file.arrayBuffer(), { cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = X.utils.sheet_to_json(ws, { defval: '', raw: false, dateNF: 'yyyy-mm-dd hh:mm' });
  } else rows = parseCsv(await file.text());
  rows = normalizeKeys(rows || [], fields);
  st.rows = rows;
  st.fileName = file.name;
  await checkRows(root, m);
}

async function checkRows(root, m) {
  const box = root.querySelector('#e-preview');
  const rows = st.rows;
  if (!rows.length) { box.innerHTML = '<p class="err">У файлі немає рядків з даними.</p>'; return; }
  let res;
  if (m === 'online') res = await post(`import/${st.kind}/check`, { rows });
  else {
    const errors = [];
    rows.forEach((r, i) => {
      try { validate(st.kind, r, offline.db(), findOblast, i + 1); } catch (e) { errors.push({ row: i + 1, field: e.field, message: e.message }); }
    });
    res = { rows: rows.length, valid: rows.length - errors.length, errors };
  }
  st.check = res;
  const fields = st.spec[st.kind].fields;
  const errByRow = new Map(res.errors.map((e) => [e.row, e]));
  const shown = rows.slice(0, 20);
  box.innerHTML = `<p><b>${esc(st.fileName)}</b>: рядків ${num(res.rows)}, без помилок ${num(res.valid)}, з помилками ${num(res.errors.length)}.</p>
    <div style="overflow:auto;max-height:320px"><table class="t"><caption><span class="num">Таблиця 1</span>ПОПЕРЕДНІЙ ПЕРЕГЛЯД імпорту${rows.length > 20 ? ' (перші 20 рядків)' : ''}</caption>
      <thead><tr><th>№ з/п</th>${fields.map((f) => `<th>${esc(f.label)}</th>`).join('')}<th>Перевірка</th></tr></thead>
      <tbody>${shown.map((r, i) => {
    const e = errByRow.get(i + 1);
    return `<tr class="${e ? 'bad' : ''}"><td class="n">${i + 1}</td>${fields.map((f) => `<td>${esc(r[f.key] ?? '') || '–'}</td>`).join('')}
        <td>${e ? `✕ ${esc(e.message)}` : '✓'}</td></tr>`;
  }).join('')}</tbody></table></div>
    ${res.errors.length > 0 && res.errors.some((e) => e.row > 20) ? `<ul class="err">${res.errors.filter((e) => e.row > 20).slice(0, 30).map((e) => `<li>Рядок ${e.row}: ${esc(e.message)}</li>`).join('')}</ul>` : ''}
    <div class="row-btns"><button type="button" class="btn primary" id="e-import" ${res.errors.length ? 'disabled' : ''}>Внести ${num(res.rows)} записів</button>
      <span id="e-imsg" role="status">${res.errors.length ? 'Виправте помилки у файлі й виберіть його ще раз.' : ''}</span></div>`;
  box.querySelector('#e-import').addEventListener('click', async () => {
    const msg = box.querySelector('#e-imsg');
    msg.textContent = 'Внесення…';
    try {
      let n;
      if (m === 'online') n = (await post(`import/${st.kind}`, { rows })).inserted;
      else {
        const prepared = rows.map((r, i) => validate(st.kind, r, offline.db(), findOblast, i + 1));
        prepared.forEach(({ row, norm }) => addLocal(st.kind, row, norm));
        n = prepared.length;
      }
      msg.className = 'ok';
      msg.textContent = `Внесено ${num(n)} записів.`;
      box.querySelector('#e-import').disabled = true;
      await afterChange();
      renderList(root, m);
    } catch (err) {
      msg.className = 'err';
      msg.textContent = `Не внесено: ${err.detail?.errors?.map((e) => `рядок ${e.row}: ${e.message}`).join('; ') ?? err.message}`;
    }
  });
}

function templateRows() {
  const fields = st.spec[st.kind].fields;
  const ex = EXAMPLE[st.kind];
  if (st.kind === 'losses' || st.kind === 'unit') ex[st.kind === 'losses' ? 'unit' : 'parent'] = state.dicts.units.find((u) => u.echelon === 'brigade')?.short_name ?? '';
  const artBn = state.dicts.units.find((u) => u.branch === 'artillery' && u.echelon === 'battalion')?.short_name ?? '';
  if (['counter_battery', 'ammo', 'equipment'].includes(st.kind)) ex.unit = artBn;
  if (st.kind === 'strength') ex.unit = state.dicts.units.find((u) => u.echelon === 'battalion' && u.branch === 'mech')?.short_name ?? '';
  if (st.kind === 'document') {
    ex.sender = state.dicts.units.find((u) => u.echelon === 'battalion')?.short_name ?? '';
    ex.recipient = state.dicts.units.find((u) => u.is_command_post)?.short_name ?? '';
  }
  return { fields, ex };
}

function templateCsv() {
  const { fields, ex } = templateRows();
  const cell = (v) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const text = `﻿${fields.map((f) => f.key).join(';')}\r\n${fields.map((f) => cell(ex[f.key])).join(';')}\r\n`;
  saveFile(`template_${st.kind}.csv`, text, 'text/csv;charset=utf-8');
}

async function templateXlsx() {
  const X = await xlsxLib();
  const { fields, ex } = templateRows();
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([fields.map((f) => f.key), fields.map((f) => ex[f.key] ?? '')]), 'Дані');
  const help = [['Колонка', 'Зміст', "Обов'язкове", 'Допустимі значення']].concat(fields.map((f) => [f.key, f.label, f.required ? 'так' : 'ні',
    f.options ? f.options.map((o) => o.label).join('; ') : { ts: 'РРРР-ММ-ДД ГГ:ХХ (київський час)', date: 'РРРР-ММ-ДД', lat: '44–52,5', lon: '22–40,5',
      rel: 'A1…F6', bool: 'так / ні', oblast: 'код UA-xx або назва області', unit: 'скорочена назва підрозділу', cp: 'ОКП / КП', weapon: 'БпЛА, КрР, БалР, КАБ або код',
      source: 'скорочення за п. 2.2.15', target: 'назва категорії' }[f.type] ?? (f.min !== undefined ? `ціле ≥ ${f.min}` : '')]));
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(help), 'Довідка');
  X.writeFile(wb, `template_${st.kind}.xlsx`);
}

// ---------- Список внесених ----------
async function renderList(root, m) {
  const box = root.querySelector('#e-list');
  let rows;
  if (m === 'online') {
    rows = (await get(`entry/${st.kind}/records`, {}, { filters: false })).map((r) => ({ id: r.id, at: r.at ? dtg(r.at) : '–', summary: r.summary, origin: state.labels.origin?.[r.origin] ?? r.origin }));
  } else {
    rows = localEntries().filter((e) => e.kind === st.kind).reverse().map((e) => ({ id: e.id, at: dtg(e.created), summary: Object.values(e.norm).filter((v) => v !== null && v !== '').slice(0, 5).join(', '), origin: 'у браузері' }));
  }
  const total = m === 'offline' ? localEntries().length : null;
  box.innerHTML = rows.length ? `<table class="t"><caption><span class="num">Таблиця 2</span>ПЕРЕЛІК внесених записів: ${esc(KINDS.find((k) => k[0] === st.kind)[1])}${total !== null ? ` (усього в браузері: ${num(total)})` : ''}</caption>
    <thead><tr><th>№ з/п</th><th>${m === 'online' ? 'Час події' : 'Внесено'}</th><th>Зміст</th><th>Походження</th><th>Дія</th></tr></thead>
    <tbody>${rows.map((r, i) => `<tr><td class="n">${i + 1}</td><td>${esc(r.at)}</td><td>${esc(r.summary)}</td><td>${esc(r.origin)}</td>
      <td><button type="button" class="btn sm" data-del="${esc(r.id)}">Видалити</button></td></tr>`).join('')}</tbody></table>`
    : `<p>Записів цього типу ще не внесено${total ? ` (усього в браузері: ${num(total)})` : ''}.</p>`;
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Видалити запис?')) return;
    try {
      if (m === 'online') await del(`entry/${st.kind}/${b.dataset.del}`); else removeLocal(b.dataset.del);
      await afterChange();
      renderList(root, m);
    } catch (e) { alert(`Не видалено: ${e.message}`); }
  }));
}
