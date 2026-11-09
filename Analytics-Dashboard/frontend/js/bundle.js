/* Зібрано backend/scripts/build_frontend.py з модулів frontend/src/*.js. Не редагувати вручну. */
(function () {
'use strict';
const __M = {};
// ---- state.js ----
__M["state.js"] = (function () {
// Глобальний стан фільтрів. Дублюється в URL (?date_from=…&oblast=…#air), щоб посиланням можна було поділитися.

const listeners = new Set();
const state = { date_from: null, date_to: null, oblast: [], unit: [], meta: null, dicts: {}, labels: {} };

function initFromUrl() {
  const q = new URLSearchParams(location.search);
  state.date_from = q.get('date_from');
  state.date_to = q.get('date_to');
  state.oblast = q.getAll('oblast');
  state.unit = q.getAll('unit').map(Number).filter(Boolean);
  // Початковий вид карти (необов'язково): ?z=9&c=48.5,37.5
  const c = (q.get('c') || '').split(',').map(Number);
  state.layers = q.get('layers') ? q.get('layers').split(',') : null;   // ?layers=docs,units,line
  state.view = q.get('z') && c.length === 2 && c.every(Number.isFinite) ? { z: Number(q.get('z')), c } : null;
}

function query(extra = {}) {
  const q = new URLSearchParams();
  if (state.date_from) q.set('date_from', state.date_from);
  if (state.date_to) q.set('date_to', state.date_to);
  state.oblast.forEach((o) => q.append('oblast', o));
  state.unit.forEach((u) => q.append('unit', u));
  Object.entries(extra).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x)); else if (v !== undefined && v !== null) q.set(k, v);
  });
  return q;
}

function setFilters(patch) {
  Object.assign(state, patch);
  const url = `${location.pathname}?${query().toString()}${location.hash}`;
  history.replaceState(null, '', url);
  listeners.forEach((fn) => fn(state));
}

// Клік — вибрати лише цю область (повторний клік по єдиній вибраній — зняти вибір).
// Ctrl/Shift + клік — додати/прибрати область, не скидаючи інших.
function toggleOblast(iso, multi = false) {
  const has = state.oblast.includes(iso);
  let next;
  if (multi) next = has ? state.oblast.filter((o) => o !== iso) : [...state.oblast, iso];
  else next = has && state.oblast.length === 1 ? [] : [iso];
  setFilters({ oblast: next });
}

function onChange(fn) { listeners.add(fn); }

function label(group, code) { return state.labels[group]?.[code] ?? code; }

function oblastName(iso) { return state.dicts.oblasts?.find((o) => o.iso_code === iso)?.name_ua ?? iso; }

function filterCaption() {
  const parts = [];
  if (state.oblast.length) parts.push('області: ' + state.oblast.map(oblastName).join(', '));
  if (state.unit.length) {
    const names = state.unit.map((id) => state.dicts.units?.find((u) => u.id === id)?.short_name ?? id);
    parts.push('підрозділи: ' + names.join(', '));
  }
  return parts.length ? parts.join('; ') : 'усі області та підрозділи';
}

return { state, initFromUrl, query, setFilters, toggleOblast, onChange, label, oblastName, filterCaption };
})();
// ---- entries-store.js ----
__M["entries-store.js"] = (function () {
// Записи, внесені без сервера (офлайн-режим): зберігаються в localStorage цього браузера.
// Перевірки повторюють backend/app/routers/entry.py. Записи можна вивантажити:
//   • .sql  — INSERT-и для PostgreSQL (psql -f entries.sql), з пошуком id за кодами довідників;
//   • .json — для імпорту на вкладці «Внесення даних», коли дашборд працює із сервером.

const KEY = 'dashboard.entries.v1';
const DAY = 86400;                                     // час — секунди «настінного» київського часу

function localEntries() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { throw new Error(`Не вдалося зберегти в браузері: ${e.message}`); }
}
function removeLocal(id) { save(localEntries().filter((e) => e.id !== id)); }
function clearLocal() { save([]); }

// Клас калібру за табл. 16 Порядку (як backend/app/sidc.py)
function caliberClass(sys, mm) {
  if (sys === 'mortar') return mm < 60 ? 'light' : mm <= 107 ? 'medium' : 'heavy';
  if (sys === 'mlrs') return mm < 100 ? 'light' : mm < 200 ? 'medium' : 'heavy';
  return mm < 120 ? 'light' : mm <= 160 ? 'medium' : 'heavy';
}

class RowError extends Error {
  constructor(field, message) { super(message); this.field = field; }
}

// ---------- Розбір значень ----------
const TS_RE = [
  [/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/, (m) => [m[1], m[2], m[3], m[4], m[5]]],
  [/^(\d{1,2})\.(\d{1,2})\.(\d{4}),? (\d{1,2})[:.](\d{2})(?::(\d{2}))?$/, (m) => [m[3], m[2], m[1], m[4], m[5]]],
];
const MIN_DAY = Math.floor(Date.UTC(2022, 1, 24) / 86400000);
const today = () => Math.floor(Date.now() / 86400000);

function parseTs(v, key) {
  for (const [re, pick] of TS_RE) {
    const m = v.match(re);
    if (m) {
      const [y, mo, d, h, mi] = pick(m).map(Number);
      const wall = Date.UTC(y, mo - 1, d, h, mi) / 1000;
      const dt = new Date(wall * 1000);
      if (dt.getUTCMonth() !== mo - 1 || h > 23 || mi > 59) break;
      if (wall / DAY < MIN_DAY || wall / DAY > today() + 1) throw new RowError(key, 'дата поза допустимим діапазоном (з 24.02.2022 до сьогодні)');
      return wall;
    }
  }
  throw new RowError(key, `дата і час «${v}» не розпізнані (очікується РРРР-ММ-ДД ГГ:ХХ або ДД.ММ.РРРР ГГ:ХХ)`);
}
function parseDate(v, key) {
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/), y, mo, d;
  if (m) [, y, mo, d] = m.map(Number);
  else if ((m = v.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/))) [, d, mo, y] = m.map(Number);
  else throw new RowError(key, `дата «${v}» не розпізнана (очікується РРРР-ММ-ДД або ДД.ММ.РРРР)`);
  const day = Date.UTC(y, mo - 1, d) / 86400000;
  if (day < MIN_DAY || day > today() + 1) throw new RowError(key, 'дата поза допустимим діапазоном');
  return day;
}
function num(v, key) {
  const n = Number(String(v).replace(',', '.').replace(/\s/g, ''));
  if (!Number.isFinite(n)) throw new RowError(key, `«${v}» — не число`);
  return n;
}
const TRUE = ['так', 'true', '1', 'yes', 'y', '+', 'т'];
const FALSE = ['ні', 'false', '0', 'no', 'n', '-', 'н', ''];

function lookup(list, v, keys) {
  const lv = String(v).trim().toLowerCase();
  return list.find((r) => keys.some((k) => r[k] !== null && r[k] !== undefined && String(r[k]).toLowerCase() === lv));
}

function parse(field, raw, db) {
  let v = raw[field.key] ?? raw[field.label];
  if (v === null || v === undefined || String(v).trim() === '') return null;
  if (typeof v === 'boolean') v = v ? 'так' : 'ні';
  v = String(v).trim();
  const { key, type } = field;
  if (type === 'ts') return parseTs(v, key);
  if (type === 'date') return parseDate(v, key);
  if (type === 'int') {
    const n = num(v, key);
    if (!Number.isInteger(n)) throw new RowError(key, 'потрібне ціле число');
    if ((field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) {
      throw new RowError(key, `значення поза межами ${field.min ?? '…'}–${field.max ?? '…'}`);
    }
    return n;
  }
  if (type === 'lat') { const n = num(v, key); if (n < 44 || n > 52.5) throw new RowError(key, 'широта поза межами України (44–52,5)'); return Math.round(n * 1e5) / 1e5; }
  if (type === 'lon') { const n = num(v, key); if (n < 22 || n > 40.5) throw new RowError(key, 'довгота поза межами України (22–40,5)'); return Math.round(n * 1e5) / 1e5; }
  if (type === 'bool') {
    if (TRUE.includes(v.toLowerCase())) return true;
    if (FALSE.includes(v.toLowerCase())) return false;
    throw new RowError(key, 'очікується «так» або «ні»');
  }
  if (type === 'text') return v;
  if (type === 'rel') {
    if (!/^[A-F][1-6]$/i.test(v)) throw new RowError(key, 'достовірність у форматі A1–F6');
    return v.toUpperCase();
  }
  if (type.startsWith('enum:')) {
    const o = field.options.find((x) => x.value === v.toLowerCase() || x.label.toLowerCase() === v.toLowerCase());
    if (!o) throw new RowError(key, `«${v}» — немає в переліку: ${field.options.map((x) => x.label).join(', ')}`);
    return o.value;
  }
  const refs = {
    oblast: [db.d.oblasts, ['iso_code', 'name_ua', 'name_en']], unit: [db.d.units, ['id', 'short_name', 'name_ua']],
    cp: [db.d.units, ['id', 'short_name', 'name_ua']], weapon: [db.d.weapon_types, ['code', 'name_ua', 'map_label']],
    target: [db.d.target_categories, ['code', 'name_ua']], source: [db.d.info_sources, ['code', 'name_ua']],
  }[type];
  const r = lookup(refs[0], v, refs[1]);
  if (!r) throw new RowError(key, `«${v}» не знайдено в довіднику`);
  if (type === 'cp' && !r.is_command_post) throw new RowError(key, `«${r.short_name}» не є пунктом управління, що приймає документи`);
  return r;
}

// ---------- Перевірка рядка ----------
// Повертає { row — у форматі знімка (для офлайн-обчислень), norm — коди/назви для .json і .sql }
function validate(kind, raw, db, findOblast, n = 1) {
  const spec = db.spec[kind];
  if (!spec) throw new RowError(null, 'Невідомий тип запису');
  const v = {};
  spec.fields.forEach((f) => {
    const x = parse(f, raw, db);
    if (x === null && f.required) throw new RowError(f.key, `обов'язкове поле «${f.label}» не заповнене`);
    v[f.key] = x;
  });
  const fmt = (w) => (w === null ? null : new Date(w * 1000).toISOString().slice(0, 16).replace('T', ' '));
  const norm = {};
  const row = { id: -(Date.now() * 10 + (n % 10)), o: 'manual' };
  if ('lat' in v) {
    if (!v.oblast) {
      const iso = findOblast(v.lat, v.lon);
      if (!iso) throw new RowError('lat', 'координати поза територією України');
      v.oblast = db.d.oblasts.find((o) => o.iso_code === iso);
    }
    Object.assign(row, { lat: v.lat, lon: v.lon });
    Object.assign(norm, { lat: v.lat, lon: v.lon });
  }
  if (v.oblast) { row.ob = v.oblast.id; norm.oblast = v.oblast.iso_code; }
  if (kind === 'strike') {
    const i = v.intercepted ?? 0, s = v.suppressed ?? 0, h = v.hits ?? 0;
    if (i + s + h > v.launched) throw new RowError('hits', 'збито + подавлено + влучань більше, ніж запущено');
    Object.assign(row, { t: v.occurred_at, w: v.weapon.id, wave: null, tg: v.target?.id ?? null, l: v.launched, i, s, h,
      dmg: v.damage_level ?? 0, src: v.info_source?.code ?? null, rel: v.reliability });
    Object.assign(norm, { occurred_at: fmt(v.occurred_at), weapon: v.weapon.code, launched: v.launched, intercepted: i, suppressed: s,
      hits: h, damage_level: v.damage_level ?? 0, target: v.target?.code ?? null, info_source: v.info_source?.code ?? null,
      reliability: v.reliability });
  } else if (kind === 'alert') {
    if (v.ended_at !== null && v.ended_at <= v.started_at) throw new RowError('ended_at', 'відбій має бути пізніше початку');
    Object.assign(row, { ty: v.alert_type, t0: v.started_at, t1: v.ended_at });
    Object.assign(norm, { alert_type: v.alert_type, started_at: fmt(v.started_at), ended_at: fmt(v.ended_at) });
  } else if (kind === 'artillery') {
    let cls = v.caliber_class;
    if (!cls) {
      if (v.caliber_mm === null) throw new RowError('caliber_mm', 'вкажіть калібр або клас калібру');
      cls = caliberClass(v.system_type, v.caliber_mm);
    }
    Object.assign(row, { t: v.occurred_at, dir: v.direction, sys: v.system_type, cls, mm: v.caliber_mm, r: v.rounds, u: v.unit?.id ?? null,
      tg: v.target?.id ?? null, res: v.result || 'unknown', src: v.info_source?.code ?? null, rel: v.reliability });
    Object.assign(norm, { occurred_at: fmt(v.occurred_at), direction: v.direction, system_type: v.system_type, caliber_mm: v.caliber_mm,
      caliber_class: cls, rounds: v.rounds, unit: v.unit?.short_name ?? null, target: v.target?.code ?? null, result: v.result || 'unknown',
      info_source: v.info_source?.code ?? null, reliability: v.reliability });
  } else if (kind === 'counter_battery') {
    const det = v.detected_at, resp = v.responded_at;
    let res = v.result;
    if (resp === null) {
      if (res !== null && res !== 'no_response') throw new RowError('responded_at', 'результат вогню вказано, а час відкриття вогню — ні');
      res = 'no_response';
    } else {
      if (resp < det) throw new RowError('responded_at', 'вогонь відкрито раніше, ніж виявлено позицію');
      if (res === 'no_response') throw new RowError('result', 'вказано час відкриття вогню — результат не може бути «вогонь не відкривався»');
      res = res || 'unknown';
    }
    const unit = resp !== null ? v.unit : null;
    Object.assign(row, { t: det, by: v.detected_by, sys: v.enemy_system, mm: v.caliber_mm, u: unit?.id ?? null, tr: resp,
      rm: resp === null ? null : Math.round((resp - det) / 60), r: resp !== null ? v.rounds : null, res,
      src: v.info_source?.code ?? null, rel: v.reliability });
    Object.assign(norm, { detected_at: fmt(det), detected_by: v.detected_by, enemy_system: v.enemy_system, caliber_mm: v.caliber_mm,
      unit: unit?.short_name ?? null, responded_at: fmt(resp), rounds: row.r, result: res,
      info_source: v.info_source?.code ?? null, reliability: v.reliability });
  } else if (kind === 'ammo') {
    const day = new Date(v.report_date * 86400000).toISOString().slice(0, 10);
    Object.assign(row, { d: v.report_date, u: v.unit.id, a: v.ammo_type, e: v.expended ?? 0, rc: v.received ?? 0, s: v.stock });
    Object.assign(norm, { report_date: day, unit: v.unit.short_name, ammo_type: v.ammo_type, expended: row.e, received: row.rc, stock: v.stock });
  } else if (kind === 'equipment') {
    const day = new Date(v.report_date * 86400000).toISOString().slice(0, 10);
    const rep = v.in_repair ?? 0;
    Object.assign(row, { d: v.report_date, u: v.unit.id, m: v.model, sys: v.system_type, mm: v.caliber_mm,
      tot: v.operational + rep, op: v.operational, rep, lost: v.lost ?? 0 });
    Object.assign(norm, { report_date: day, unit: v.unit.short_name, model: v.model, system_type: v.system_type, caliber_mm: v.caliber_mm,
      operational: v.operational, in_repair: rep, lost: v.lost ?? 0 });
  } else if (kind === 'strength') {
    if (v.present > v.authorized * 1.5) throw new RowError('present', 'у наявності більше ніж півтора штату — перевірте значення');
    const day = new Date(v.report_date * 86400000).toISOString().slice(0, 10);
    Object.assign(row, { d: v.report_date, u: v.unit.id, au: v.authorized, pr: v.present, rp: v.replenished ?? 0 });
    Object.assign(norm, { report_date: day, unit: v.unit.short_name, authorized: v.authorized, present: v.present, replenished: row.rp });
  } else if (kind === 'losses') {
    const k = v.killed ?? 0, w = v.wounded ?? 0, m = v.missing ?? 0, r = v.returned_to_duty ?? 0;
    if (!(k || w || m || r)) throw new RowError('killed', 'усі показники нульові — запис не має сенсу');
    Object.assign(row, { d: v.report_date, u: v.unit.id, c: v.cause, k, w, m, r });
    Object.assign(norm, { report_date: new Date(v.report_date * 86400000).toISOString().slice(0, 10), unit: v.unit.short_name,
      cause: v.cause, killed: k, wounded: w, missing: m, returned_to_duty: r });
  } else if (kind === 'document') {
    const rec = v.received_at, comp = v.completed_at;
    if (comp !== null && comp < rec) throw new RowError('completed_at', 'опрацьовано раніше, ніж надійшов');
    const st = v.status || (comp !== null ? 'done' : 'new');
    if (['done', 'returned'].includes(st) !== (comp !== null)) throw new RowError('status', 'стан «Виконано/Повернуто» потребує дати опрацювання, інші — ні');
    if (v.sender.id === v.recipient.id) throw new RowError('recipient', 'відправник і отримувач збігаються');
    const norm0 = db.d.doc_norms.find((x) => x.urgency === v.urgency);
    const reg = v.reg_number || `M${new Date().toISOString().replace(/\D/g, '').slice(2, 14)}${String(n % 1000).padStart(3, '0')}`;
    Object.assign(row, { reg, ty: v.doc_type, urg: v.urgency, mark: v.special_mark, acc: v.access_level || 'open', ch: v.channel,
      s: v.sender.id, rc: v.recipient.id, t: rec, due: rec + norm0.norm_min * 60, done: comp, st });
    Object.assign(norm, { reg_number: reg, doc_type: v.doc_type, urgency: v.urgency, special_mark: v.special_mark,
      access_level: v.access_level || 'open', channel: v.channel, sender: v.sender.short_name, recipient: v.recipient.short_name,
      received_at: fmt(rec), completed_at: fmt(comp), status: st });
  } else if (kind === 'unit') {
    if (db.d.units.some((u) => u.short_name.toLowerCase() === v.short_name.toLowerCase())) throw new RowError('short_name', 'підрозділ з такою назвою вже існує');
    const ECH = { company: 'E', battalion: 'F', regiment: 'G', brigade: 'H', corps: 'J', command: 'K' };
    const FN = { mech: 'UCIZ--', tank: 'UCA---', artillery: 'UCF---', air_defense: 'UCD---', airborne: 'UCIA--', support: 'USS---',
      hq: 'UH----', recon: 'UCR---', marine: 'UCIN--', training: 'UCI---', signal: 'UUS---', engineer: 'UCE---',
      maintenance: 'USX---', medical: 'USM---' };
    const sidc = `SFGP${FN[v.branch]}${v.branch === 'hq' ? 'A' : '-'}${ECH[v.echelon]}---`;
    const id = Math.max(1000, ...db.d.units.map((u) => u.id)) + 1;
    Object.assign(row, { id, short_name: v.short_name, name_ua: v.name_ua, echelon: v.echelon, branch: v.branch,
      parent_id: v.parent?.id ?? null, oblast_id: v.oblast.id, sidc, is_rear: !!v.is_rear, is_command_post: !!v.is_command_post, origin: 'manual' });
    delete row.o; delete row.ob;
    Object.assign(norm, { short_name: v.short_name, name_ua: v.name_ua, echelon: v.echelon, branch: v.branch,
      parent: v.parent?.short_name ?? null, is_command_post: !!v.is_command_post, is_rear: !!v.is_rear });
  }
  return { row, norm };
}

function addLocal(kind, row, norm) {
  const list = localEntries();
  const e = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, kind, row, norm, created: new Date().toISOString() };
  list.push(e);
  save(list);
  return e;
}

// ---------- Вивантаження ----------
function exportJson() {
  const by = {};
  localEntries().forEach((e) => { (by[e.kind] ??= []).push(e.norm); });
  return JSON.stringify({ format: 'dashboard-entries', version: 1, exported_at: new Date().toISOString(), entries: by }, null, 2);
}

const lit = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const ts = (v) => (v === null || v === undefined ? 'NULL' : `(${lit(v)}::timestamp AT TIME ZONE 'Europe/Kyiv')`);
const ref = (table, col, v) => (v === null || v === undefined ? 'NULL' : `(SELECT id FROM ${table} WHERE ${col} = ${lit(v)})`);
const ins = (table, obj) => `INSERT INTO ${table} (${Object.keys(obj).join(', ')}) VALUES (${Object.values(obj).join(', ')});`;

function exportSql() {
  const out = ['-- Записи, внесені в офлайн-режимі дашборду. Виконати: psql -d dashboard -f entries.sql',
    `-- Вивантажено: ${new Date().toISOString()}. Позначка origin = 'manual'.`, 'BEGIN;', "SET timezone = 'Europe/Kyiv';"];
  const units = localEntries().filter((e) => e.kind === 'unit');
  const rest = localEntries().filter((e) => e.kind !== 'unit');
  [...units, ...rest].forEach((e) => {
    const { kind, norm: n } = e;
    const obl = ref('oblasts', 'iso_code', n.oblast);
    if (kind === 'strike') {
      out.push(ins('strike_events', { occurred_at: ts(n.occurred_at), oblast_id: obl, weapon_type_id: ref('weapon_types', 'code', n.weapon),
        target_category_id: ref('target_categories', 'code', n.target), launched: n.launched, intercepted: n.intercepted,
        suppressed: n.suppressed, hits: n.hits, damage_level: n.damage_level, info_source: lit(n.info_source), reliability: lit(n.reliability),
        lat: n.lat, lon: n.lon, is_synthetic: false, origin: "'manual'" }));
    } else if (kind === 'alert') {
      out.push(ins('air_alerts', { oblast_id: obl, alert_type: lit(n.alert_type), started_at: ts(n.started_at), ended_at: ts(n.ended_at),
        is_synthetic: false, origin: "'manual'" }));
    } else if (kind === 'artillery') {
      out.push(ins('artillery_fire', { occurred_at: ts(n.occurred_at), direction: lit(n.direction), system_type: lit(n.system_type),
        caliber_class: lit(n.caliber_class), caliber_mm: lit(n.caliber_mm), rounds: n.rounds, oblast_id: obl,
        unit_id: ref('units', 'short_name', n.unit), target_category_id: ref('target_categories', 'code', n.target), result: lit(n.result),
        info_source: lit(n.info_source), reliability: lit(n.reliability), lat: n.lat, lon: n.lon, is_synthetic: false, origin: "'manual'" }));
    } else if (kind === 'losses') {
      out.push(ins('personnel_losses', { report_date: `${lit(n.report_date)}::date`, unit_id: ref('units', 'short_name', n.unit), cause: lit(n.cause),
        killed: n.killed, wounded: n.wounded, missing: n.missing, returned_to_duty: n.returned_to_duty, is_synthetic: false, origin: "'manual'" }));
    } else if (kind === 'document') {
      out.push(ins('incoming_documents', { reg_number: lit(n.reg_number), doc_type: lit(n.doc_type), urgency: lit(n.urgency),
        special_mark: lit(n.special_mark), access_level: lit(n.access_level), channel: lit(n.channel),
        sender_unit_id: ref('units', 'short_name', n.sender), recipient_unit_id: ref('units', 'short_name', n.recipient),
        received_at: ts(n.received_at), registered_at: ts(n.received_at),
        due_at: `${ts(n.received_at)} + make_interval(mins => (SELECT norm_min FROM doc_sla_norms WHERE urgency = ${lit(n.urgency)}))`,
        completed_at: ts(n.completed_at), status: lit(n.status), is_synthetic: false, origin: "'manual'" }));
    } else if (kind === 'counter_battery') {
      out.push(ins('counter_battery', { detected_at: ts(n.detected_at), detected_by: lit(n.detected_by), enemy_system: lit(n.enemy_system),
        caliber_mm: lit(n.caliber_mm), oblast_id: obl, lat: n.lat, lon: n.lon, unit_id: ref('units', 'short_name', n.unit),
        responded_at: ts(n.responded_at), rounds: lit(n.rounds), result: lit(n.result), info_source: lit(n.info_source),
        reliability: lit(n.reliability), is_synthetic: false, origin: "'manual'" }));
    } else if (kind === 'ammo') {
      out.push(ins('ammo_supply', { report_date: `${lit(n.report_date)}::date`, unit_id: ref('units', 'short_name', n.unit),
        ammo_type: lit(n.ammo_type), expended: n.expended, received: n.received, stock: n.stock, is_synthetic: false, origin: "'manual'" }));
    } else if (kind === 'equipment') {
      out.push(ins('artillery_equipment', { report_date: `${lit(n.report_date)}::date`, unit_id: ref('units', 'short_name', n.unit),
        model: lit(n.model), system_type: lit(n.system_type), caliber_mm: lit(n.caliber_mm), total: n.operational + n.in_repair,
        operational: n.operational, in_repair: n.in_repair, lost: n.lost, is_synthetic: false, origin: "'manual'" }));
    } else if (kind === 'strength') {
      out.push(ins('unit_strength', { report_date: `${lit(n.report_date)}::date`, unit_id: ref('units', 'short_name', n.unit),
        authorized: n.authorized, present: n.present, replenished: n.replenished, is_synthetic: false, origin: "'manual'" }));
    } else if (kind === 'unit') {
      out.push(ins('units', { short_name: lit(n.short_name), name_ua: lit(n.name_ua), echelon: lit(n.echelon), branch: lit(n.branch),
        parent_id: ref('units', 'short_name', n.parent), oblast_id: obl, lat: n.lat, lon: n.lon, sidc: lit(e.row.sidc),
        is_rear: n.is_rear, is_command_post: n.is_command_post, origin: "'manual'" }));
    }
  });
  out.push('COMMIT;', '');
  return out.join('\n');
}

return { localEntries, removeLocal, clearLocal, caliberClass, RowError, validate, addLocal, exportJson, exportSql };
})();
// ---- offline.js ----
__M["offline.js"] = (function () {
// Офлайн-режим: ті самі відповіді, що й FastAPI, але обчислені в браузері зі знімка бази
// (data/dataset.js → window.DATASET). Використовується, коли index.html відкрито як файл (file://)
// або сервер API недоступний. Логіка повторює SQL з backend/app/routers/*.py.
//
// Час у знімку — «київський настінний» у секундах від 1970-01-01, тому доба/година/день тижня
// рахуються простим діленням; тривалості — у реальному часі (з урахуванням переходу на літній час).
/* global DATASET */
const { localEntries, caliberClass } = __M["entries-store.js"];
const DAY = 86400;
let DB = null;

// ---------- Розпакування знімка ----------
function decode(t) {
  const keys = Object.keys(t.cols);
  const cols = keys.map((k) => {
    const c = t.cols[k];
    return Array.isArray(c) ? c : c.i.map((i) => (i < 0 ? null : c.d[i]));
  });
  const out = new Array(t.n);
  for (let r = 0; r < t.n; r += 1) {
    const o = {};
    for (let j = 0; j < keys.length; j += 1) o[keys[j]] = cols[j][r];
    out[r] = o;
  }
  return out;
}

function init() {
  if (DB) return DB;
  const D = window.DATASET;
  if (!D) throw new Error('Не знайдено знімок даних data/dataset.js');
  DB = { meta: { ...D.meta }, labels: D.labels, noData: D.no_data, spec: D.entry_spec, d: {}, t: {} };
  Object.entries(D.dicts).forEach(([k, v]) => { DB.d[k] = v.map((x) => ({ ...x })); });
  Object.entries(D.tables).forEach(([k, v]) => { DB.t[k] = decode(v); });
  mergeLocal();
  return DB;
}

// Записи, внесені в офлайн-режимі (localStorage), додаються до таблиць знімка
function mergeLocal() {
  const map = { strike: 'strikes', alert: 'alerts', artillery: 'artillery', losses: 'losses', document: 'docs',
    counter_battery: 'cb', ammo: 'ammo', equipment: 'equip', strength: 'strength' };
  localEntries().forEach((e) => {
    if (e.kind === 'unit') DB.d.units.push({ ...e.row });
    else DB.t[map[e.kind]].push({ ...e.row });
  });
  ['strikes', 'artillery', 'docs', 'cb'].forEach((k) => DB.t[k].sort((a, b) => a.t - b.t));
  ['ammo', 'equip', 'strength'].forEach((k) => DB.t[k].sort((a, b) => a.d - b.d || a.u - b.u));
  DB.t.alerts.sort((a, b) => a.t0 - b.t0);
  idx();
}

function idx() {
  DB.oblById = new Map(DB.d.oblasts.map((o) => [o.id, o]));
  DB.oblByIso = new Map(DB.d.oblasts.map((o) => [o.iso_code, o]));
  DB.unitById = new Map(DB.d.units.map((u) => [u.id, u]));
  DB.weapById = new Map(DB.d.weapon_types.map((w) => [w.id, w]));
  DB.tgById = new Map(DB.d.target_categories.map((t) => [t.id, t]));
  DB.norm = new Map(DB.d.doc_norms.map((n) => [n.urgency, n]));
  const last = (arr, f) => arr.reduce((m, r) => Math.max(m, f(r) ?? 0), 0);
  const manual = (r) => r.o && r.o !== 'synthetic';
  DB.asOf = Math.max(DB.meta.as_of_sec,
    last(DB.t.strikes.filter(manual), (r) => r.t), last(DB.t.artillery.filter(manual), (r) => r.t),
    last(DB.t.docs.filter(manual), (r) => Math.max(r.t, r.done ?? 0)),
    last(DB.t.alerts.filter(manual), (r) => Math.max(r.t0, r.t1 ?? 0)),
    last(DB.t.losses.filter(manual), (r) => r.d * DAY + DAY - 1),
    last(DB.t.cb.filter(manual), (r) => Math.max(r.t, r.tr ?? 0)),
    ...['ammo', 'equip', 'strength'].map((k) => last(DB.t[k].filter(manual), (r) => r.d * DAY + DAY - 1)));
}

function reload() { DB = null; init(); }

// ---------- Час ----------
const pad = (n) => String(n).padStart(2, '0');
const dayIso = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
const isoDay = (s) => Math.floor(Date.parse(`${s}T00:00:00Z`) / 86400000);
const isoDow = (d) => ((d + 3) % 7) + 1;              // 1970-01-01 — четвер; 1 = понеділок
const weekStart = (d) => d - (isoDow(d) - 1);
function lastSunday(y, m) {                            // m: 0-based
  const d = new Date(Date.UTC(y, m + 1, 0));
  return Math.floor(d.getTime() / 86400000) - d.getUTCDay();
}
function kyivOffset(wall) {                            // літній час ЄС: остання неділя березня / жовтня, с
  const y = new Date(wall * 1000).getUTCFullYear();
  const s = lastSunday(y, 2) * DAY + 3 * 3600, e = lastSunday(y, 9) * DAY + 4 * 3600;
  return wall >= s && wall < e ? 10800 : 7200;
}
const real = (wall) => wall - kyivOffset(wall);         // настінний київський → секунди UTC
const minBetween = (a, b) => Math.round((real(b) - real(a)) / 60);
function kyivIso(wall) {
  if (wall === null || wall === undefined) return null;
  const t = new Date(wall * 1000);
  return `${t.toISOString().slice(0, 19)}+${pad(kyivOffset(wall) / 3600)}:00`;
}
const fmtT = (wall) => {                               // «ГГ.ХХ ДД.ММ.РРРР» (п. 2.1.1 Порядку)
  if (wall === null || wall === undefined) return null;
  const t = new Date(wall * 1000);
  return `${pad(t.getUTCHours())}.${pad(t.getUTCMinutes())} ${pad(t.getUTCDate())}.${pad(t.getUTCMonth() + 1)}.${t.getUTCFullYear()}`;
};
const fmtD = (d) => { const [y, m, dd] = dayIso(d).split('-'); return `${dd}.${m}.${y}`; };

// ---------- Фільтри (як backend/app/filters.py) ----------
const LISTS = ['oblast', 'unit', 'weapon', 'system', 'direction', 'cause', 'urgency', 'doc_type'];
function filters(q) {
  const f = {};
  LISTS.forEach((k) => { f[k] = q.getAll(k); });
  f.unit = f.unit.map(Number);
  const pTo = Math.floor(DB.asOf / DAY);
  const dt = q.get('date_to') ? isoDay(q.get('date_to')) : pTo;
  const df = q.get('date_from') ? isoDay(q.get('date_from')) : dt - 29;
  if (df > dt) throw new Error('422: date_from пізніше за date_to');
  if (dt - df + 1 > 366) throw new Error('422: Період не може перевищувати 366 днів');
  Object.assign(f, { df, dt, days: dt - df + 1, t0: df * DAY, t1: (dt + 1) * DAY });
  f.obl = new Set(f.oblast.map((iso) => DB.oblByIso.get(iso)?.id));
  return f;
}
const shift = (f, df, dt) => ({ ...f, df, dt, days: dt - df + 1, t0: df * DAY, t1: (dt + 1) * DAY });
const previous = (f) => shift(f, f.df - f.days, f.df - 1);
const lastDays = (f, n) => shift(f, f.dt - n + 1, f.dt);
const inT = (f, t) => t >= f.t0 && t < f.t1;
const has = (list, v) => !list.length || list.includes(v);
const oblOk = (f, id) => !f.oblast.length || f.obl.has(id);
const unitOk = (f, id) => !f.unit.length || f.unit.includes(id);
const bucketOf = (f, o) => (o === 'day' || o === 'week' ? o : f.days <= 92 ? 'day' : 'week');
const trunc = (b, d) => (b === 'week' ? weekStart(d) : d);
function series(b, f) {
  const out = [];
  for (let d = trunc(b, f.df); d <= f.dt; d += b === 'week' ? 7 : 1) out.push(d);
  return out;
}
const pct = (a, b) => (!b ? null : Math.round(1000 * a / b) / 10);
const r2 = (v) => Math.round(v * 100) / 100;
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const x = p * (sorted.length - 1), lo = Math.floor(x), hi = Math.ceil(x);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
}
const sum = (arr, k) => arr.reduce((s, r) => s + (typeof k === 'function' ? k(r) : r[k]) , 0);
function groupBy(arr, key) {
  const m = new Map();
  arr.forEach((r) => { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
  return m;
}
const fc = (rows) => ({ type: 'FeatureCollection', features: rows.map(({ lat, lon, ...p }) =>
  ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: p })) });

// ---------- Вибірки модулів ----------
const strikes = (f, extra) => DB.t.strikes.filter((s) => inT(f, s.t) && oblOk(f, s.ob)
  && has(f.weapon, DB.weapById.get(s.w).code) && (!extra || extra(s)));
const arts = (f, extra) => DB.t.artillery.filter((a) => inT(f, a.t) && oblOk(f, a.ob) && unitOk(f, a.u)
  && has(f.system, a.sys) && has(f.direction, a.dir) && (!extra || extra(a)));
const losses = (f) => DB.t.losses.filter((l) => l.d >= f.df && l.d <= f.dt
  && oblOk(f, DB.unitById.get(l.u)?.oblast_id) && unitOk(f, l.u) && has(f.cause, l.c));
const docs = (f, { time = true } = {}) => DB.t.docs.filter((d) => (!time || inT(f, d.t))
  && oblOk(f, DB.unitById.get(d.s)?.oblast_id) && unitOk(f, d.s) && has(f.urgency, d.urg) && has(f.doc_type, d.ty));
const cbs = (f) => DB.t.cb.filter((c) => inT(f, c.t) && oblOk(f, c.ob) && unitOk(f, c.u) && has(f.system, c.sys));
const daily = (tbl, f, extra) => DB.t[tbl].filter((r) => r.d >= f.df && r.d <= f.dt
  && oblOk(f, DB.unitById.get(r.u)?.oblast_id) && unitOk(f, r.u) && (!extra || extra(r)));
const equips = (f) => daily('equip', f, (r) => has(f.system, r.sys));
const round1 = (v) => Math.round(v * 10) / 10;
// Останнє донесення в періоді для кожного ключа (рядок з найбільшою датою)
function lastBy(rows, key) {
  const m = new Map();
  rows.forEach((r) => { const k = key(r); const x = m.get(k); if (!x || r.d > x.d) m.set(k, r); });
  return [...m.values()];
}
const overdue = (d) => d.due !== null && d.due < (d.done ?? DB.asOf);
const procMin = (d) => (d.done === null ? null : minBetween(d.t, d.done));
const isKab = (s) => DB.weapById.get(s.w).category === 'guided_bomb';

// ---------- Ендпоінти ----------
const H = {};

H.health = () => ({ status: 'ok', db: 'offline', synthetic: true });
H.meta = () => ({ ...DB.meta, period_from: DB.meta.period_from, period_to: dayIso(Math.floor(DB.asOf / DAY)),
  data_as_of: kyivIso(DB.asOf), offline: true });
H['dict-labels'] = () => DB.labels;
H['dict/oblasts'] = () => [...DB.d.oblasts].sort((a, b) => a.name_ua.localeCompare(b.name_ua, 'uk'));
H['dict/units'] = () => DB.d.units.map((u) => ({ ...u, parent: DB.unitById.get(u.parent_id)?.short_name ?? null,
  oblast: DB.oblById.get(u.oblast_id)?.iso_code }));
H['dict/weapon-types'] = () => DB.d.weapon_types;
H['dict/target-categories'] = () => DB.d.target_categories;
H['dict/info-sources'] = () => DB.d.info_sources;
H['dict/doc-norms'] = () => DB.d.doc_norms;
H['entry/spec'] = () => DB.spec;

// --- A ---
H['air/timeline'] = (q, f) => {
  const b = bucketOf(f, q.get('bucket'));
  const g = groupBy(strikes(f), (s) => `${trunc(b, Math.floor(s.t / DAY))}|${s.w}`);
  const rows = [];
  series(b, f).forEach((p) => DB.d.weapon_types.forEach((w) => {
    const x = g.get(`${p}|${w.id}`) || [];
    rows.push({ period: dayIso(p), weapon: w.code, name_ua: w.name_ua, color_hex: w.color_hex,
      launched: sum(x, 'l'), intercepted: sum(x, 'i'), suppressed: sum(x, 's'), hits: sum(x, 'h') });
  }));
  const waves = DB.d.attack_waves.filter((w) => w.t0 >= f.t0 && w.t0 < f.t1)
    .map((w) => ({ id: w.id, started_at: kyivIso(w.t0), ended_at: kyivIso(w.t1), title: w.title }));
  return { bucket: b, rows: f.weapon.length ? rows.filter((r) => f.weapon.includes(r.weapon)) : rows, waves };
};
H['air/intercept-rate'] = (q, f) => {
  const b = bucketOf(f, q.get('bucket'));
  const g = groupBy(strikes(f, (s) => !isKab(s)), (s) => trunc(b, Math.floor(s.t / DAY)));
  return { bucket: b, rows: series(b, f).map((p) => {
    const x = g.get(p) || [];
    const l = sum(x, 'l'), i = sum(x, 'i'), s = sum(x, 's');
    return { period: dayIso(p), launched: l, intercepted: i, suppressed: s, rate: l ? Math.round(1000 * (i + s) / l) / 10 : null };
  }) };
};
H['air/by-oblast'] = (q, f) => {
  const g = groupBy(strikes(f), (s) => s.ob);
  return DB.d.oblasts.map((o) => {
    const x = g.get(o.id) || [];
    return { iso_code: o.iso_code, name_ua: o.name_ua, events: x.length, launched: sum(x, 'l'), intercepted: sum(x, 'i'), hits: sum(x, 'h') };
  }).sort((a, b) => b.launched - a.launched || a.name_ua.localeCompare(b.name_ua, 'uk'));
};
H['air/impacts'] = (q, f) => {
  const lim = Math.min(1000, Number(q.get('limit') || 1000));
  const rows = strikes(f, (s) => s.h > 0).slice(-lim).reverse().map((s) => {
    const w = DB.weapById.get(s.w);
    return { id: s.id, occurred_at: kyivIso(s.t), weapon: w.code, weapon_name: w.name_ua, sidc: w.sidc, map_label: w.map_label,
      category: w.category, launched: s.l, hits: s.h, damage_level: s.dmg, target: DB.tgById.get(s.tg)?.name_ua ?? null,
      info_source: s.src, reliability: s.rel, origin: s.o, oblast: DB.oblById.get(s.ob).name_ua, lat: s.lat, lon: s.lon };
  });
  return fc(rows);
};
H['alerts/stats'] = (q, f) => {
  const g = new Map();
  DB.t.alerts.forEach((a) => {
    if (!(a.t0 < f.t1 && (a.t1 ?? Infinity) > f.t0) || !oblOk(f, a.ob)) return;
    const x = g.get(a.ob) || { n: 0, m: 0 };
    x.n += 1;
    x.m += real(Math.min(a.t1 ?? f.t1, f.t1)) - real(Math.max(a.t0, f.t0));
    g.set(a.ob, x);
  });
  return [...g].map(([id, x]) => ({ iso_code: DB.oblById.get(id).iso_code, name_ua: DB.oblById.get(id).name_ua,
    alerts: x.n, hours: Math.round(x.m / 360) / 10 })).sort((a, b) => b.hours - a.hours);
};
H['alerts/active'] = () => DB.t.alerts.filter((a) => a.t1 === null).map((a) => ({ id: a.id,
  iso_code: DB.oblById.get(a.ob).iso_code, name_ua: DB.oblById.get(a.ob).name_ua, alert_type: a.ty, started_at: kyivIso(a.t0) }));

// --- B ---
const ART_FN = { mortar: 'EWO{c}--', howitzer: 'EWH{c}--', gun: 'EWG{c}--', mlrs: 'EWR{c}--', tank: 'EVAT{c}-' };
const CLS = { light: 'L', medium: 'M', heavy: 'H' };
const artSidc = (sys, cls) => `SHGP${ART_FN[sys].replace('{c}', CLS[cls])}-----`;
H['artillery/timeline'] = (q, f) => {
  const b = bucketOf(f, q.get('bucket'));
  const g = groupBy(arts(f), (a) => `${trunc(b, Math.floor(a.t / DAY))}|${a.dir}`);
  const rows = [];
  series(b, f).forEach((p) => ['incoming', 'outgoing'].forEach((dir) => {
    const x = g.get(`${p}|${dir}`) || [];
    rows.push({ period: dayIso(p), direction: dir, shellings: x.length, rounds: sum(x, 'r') });
  }));
  return { bucket: b, rows };
};
H['artillery/by-system'] = (q, f) => [...groupBy(arts(f), (a) => `${a.sys}|${a.dir}`)].map(([k, x]) => {
  const [system_type, direction] = k.split('|');
  return { system_type, direction, shellings: x.length, rounds: sum(x, 'r') };
}).sort((a, b) => b.rounds - a.rounds);
H['artillery/heatmap'] = (q, f) => {
  const g = groupBy(arts(f, (a) => a.dir === 'incoming'), (a) => `${isoDow(Math.floor(a.t / DAY))}|${Math.floor((a.t % DAY) / 3600)}`);
  const rows = [];
  for (let wd = 1; wd <= 7; wd += 1) for (let h = 0; h < 24; h += 1) {
    const x = g.get(`${wd}|${h}`) || [];
    rows.push({ weekday: wd, hour: h, shellings: x.length, rounds: sum(x, 'r') });
  }
  return rows;
};
H['artillery/by-oblast'] = (q, f) => {
  const g = groupBy(arts(f, (a) => a.dir === 'incoming'), (a) => a.ob);
  return DB.d.oblasts.map((o) => { const x = g.get(o.id) || []; return { iso_code: o.iso_code, name_ua: o.name_ua, shellings: x.length, rounds: sum(x, 'r') }; })
    .sort((a, b) => b.rounds - a.rounds || DB.oblByIso.get(a.iso_code).id - DB.oblByIso.get(b.iso_code).id);
};
H['artillery/geojson'] = (q, f) => {
  const lim = Math.min(1000, Number(q.get('limit') || 1000));
  return fc(arts(f).slice(-lim).reverse().map((a) => ({ id: a.id, occurred_at: kyivIso(a.t), direction: a.dir, system_type: a.sys,
    caliber_class: a.cls, caliber_mm: a.mm, rounds: a.r, result: a.res, unit: DB.unitById.get(a.u)?.short_name ?? null,
    oblast: DB.oblById.get(a.ob).name_ua, info_source: a.src, reliability: a.rel, lat: a.lat, lon: a.lon, sidc: artSidc(a.sys, a.cls) })));
};

const DETECT_ORDER = ['radar', 'uav', 'sound', 'visual'];
const RESULTS = ['destroyed', 'damaged', 'suppressed', 'no_effect', 'unknown', 'no_response'];
H['artillery/counter-battery'] = (q, f) => {
  const g = groupBy(cbs(f), (c) => c.by);
  return DETECT_ORDER.map((by) => {
    const x = g.get(by) || [];
    const rm = x.map((c) => c.rm).filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
    const med = percentile(rm, 0.5);
    const o = { detected_by: by, detected: x.length, responded: x.filter((c) => c.tr !== null).length,
      median_min: med === null ? null : round1(med) };
    RESULTS.forEach((r) => { o[r] = x.filter((c) => c.res === r).length; });
    o.response_pct = pct(o.responded, o.detected);
    return o;
  });
};
H['artillery/cb-geojson'] = (q, f) => {
  const lim = Math.min(1000, Number(q.get('limit') || 1000));
  return fc(cbs(f).slice(-lim).reverse().map((c) => ({ id: c.id, detected_at: kyivIso(c.t), detected_by: c.by,
    enemy_system: c.sys, caliber_mm: c.mm, unit: DB.unitById.get(c.u)?.short_name ?? null, responded_at: kyivIso(c.tr),
    reaction_min: c.rm, rounds: c.r, result: c.res, oblast: DB.oblById.get(c.ob).name_ua, info_source: c.src,
    reliability: c.rel, origin: c.o, lat: c.lat, lon: c.lon, sidc: artSidc(c.sys, caliberClass(c.sys, c.mm || 0)) })));
};
const AMMO_ORDER = ['mortar_120', 'how_122', 'how_152', 'how_155', 'how_203', 'mlrs_122', 'mlrs_220', 'mlrs_300'];
H['artillery/ammo'] = (q, f) => {
  const n = Math.min(7, f.days);
  const rows = daily('ammo', f);
  const stock = groupBy(lastBy(rows, (r) => `${r.u}|${r.a}`), (r) => r.a);
  return [...groupBy(rows, (r) => r.a)].map(([a, x]) => {
    const expN = sum(x.filter((r) => r.d > f.dt - n), 'e');
    const st = sum(stock.get(a) || [], 's');
    return { ammo_type: a, expended: sum(x, 'e'), received: sum(x, 'rc'), stock: st, avg_daily: round1(expN / n),
      days_of_fire: expN > 0 ? round1(st * n / expN) : null };
  }).sort((a, b) => AMMO_ORDER.indexOf(a.ammo_type) - AMMO_ORDER.indexOf(b.ammo_type));
};
const family = (a) => (a.startsWith('how_') ? 'howitzer' : a.split('_')[0]);
H['artillery/ammo-timeline'] = (q, f) => {
  const b = bucketOf(f, q.get('bucket'));
  const g = groupBy(daily('ammo', f), (r) => `${trunc(b, r.d)}|${family(r.a)}`);
  const rows = [];
  series(b, f).forEach((p) => ['mortar', 'howitzer', 'mlrs'].forEach((fm) => {
    rows.push({ period: dayIso(p), family: fm, expended: sum(g.get(`${p}|${fm}`) || [], 'e') });
  }));
  return { bucket: b, rows };
};
H['artillery/equipment'] = (q, f) => {
  const rows = equips(f);
  const lost = groupBy(rows, (r) => r.m);
  return [...groupBy(lastBy(rows, (r) => `${r.u}|${r.m}`), (r) => r.m)].map(([m, x]) => {
    const total = sum(x, 'tot'), op = sum(x, 'op');
    const mms = x.map((r) => r.mm).filter((v) => v !== null && v !== undefined);
    return { model: m, system_type: x.map((r) => r.sys).sort(cmpStr)[0], caliber_mm: mms.length ? Math.min(...mms) : null,
      total, operational: op, in_repair: sum(x, 'rep'), lost: sum(lost.get(m), 'lost'), ready_pct: total ? round1(100 * op / total) : null };
  }).sort((a, b) => b.total - a.total || cmpStr(a.model, b.model));
};

// --- C ---
H['losses/timeline'] = (q, f) => {
  const g = groupBy(losses(f), (l) => weekStart(l.d));
  return { bucket: 'week', rows: series('week', f).map((p) => {
    const x = g.get(p) || [];
    return { period: dayIso(p), killed: sum(x, 'k'), wounded: sum(x, 'w'), missing: sum(x, 'm') };
  }) };
};
H['losses/by-cause'] = (q, f) => [...groupBy(losses(f), (l) => l.c)].map(([cause, x]) => ({ cause, killed: sum(x, 'k'),
  wounded: sum(x, 'w'), missing: sum(x, 'm'), total: sum(x, (l) => l.k + l.w + l.m) })).sort((a, b) => b.total - a.total);
H['losses/by-unit'] = (q, f) => [...groupBy(losses(f), (l) => l.u)].map(([id, x]) => ({ id, short_name: DB.unitById.get(id).short_name,
  echelon: DB.unitById.get(id).echelon, killed: sum(x, 'k'), wounded: sum(x, 'w'), missing: sum(x, 'm'),
  total: sum(x, (l) => l.k + l.w + l.m) })).sort((a, b) => b.total - a.total || a.id - b.id);
H['losses/correlation'] = (q, f) => {
  const gl = groupBy(losses(f), (l) => l.d);
  const ga = groupBy(DB.t.artillery.filter((a) => a.dir === 'incoming' && inT(f, a.t) && oblOk(f, a.ob) && unitOk(f, a.u)),
    (a) => Math.floor(a.t / DAY));
  return series('day', f).map((p) => ({ period: dayIso(p), incoming_rounds: sum(ga.get(p) || [], 'r'),
    wounded: sum(gl.get(p) || [], 'w'), killed: sum(gl.get(p) || [], 'k') }));
};

H['losses/strength'] = (q, f) => {
  const g = groupBy(daily('strength', f), (r) => r.d);
  return series('day', f).map((p) => {
    const x = g.get(p);
    if (!x) return { period: dayIso(p), authorized: null, present: null, manning_pct: null, replenished: 0 };
    const au = sum(x, 'au'), pr = sum(x, 'pr');
    return { period: dayIso(p), authorized: au, present: pr, manning_pct: au ? round1(100 * pr / au) : null, replenished: sum(x, 'rp') };
  });
};
H['losses/strength-by-unit'] = (q, f) => {
  const rows = daily('strength', f);
  const rep = groupBy(rows, (r) => r.u);
  return lastBy(rows, (r) => r.u).map((l) => {
    const u = DB.unitById.get(l.u);
    return { id: u.id, short_name: u.short_name, echelon: u.echelon, authorized: l.au, present: l.pr,
      manning_pct: round1(100 * l.pr / l.au), replenished: sum(rep.get(l.u), 'rp') };
  }).sort((a, b) => a.manning_pct - b.manning_pct || a.id - b.id);
};

// --- D ---
H['docs/flow'] = (q, f) => {
  const g = groupBy(docs(f), (d) => `${Math.floor((d.t % DAY) / 3600)}|${d.urg}`);
  const norms = [...DB.d.doc_norms].sort((a, b) => a.sort_order - b.sort_order);
  const rows = [];
  for (let h = 0; h < 24; h += 1) norms.forEach((n) => {
    const c = (g.get(`${h}|${n.urgency}`) || []).length;
    rows.push({ hour: h, urgency: n.urgency, name_ua: n.name_ua, docs: c, per_day: r2(c / f.days) });
  });
  return { days: f.days, rows };
};
H['docs/sla'] = (q, f) => {
  const g = groupBy(docs(f), (d) => d.urg);
  return [...DB.d.doc_norms].sort((a, b) => a.sort_order - b.sort_order).filter((n) => g.has(n.urgency)).map((n) => {
    const x = g.get(n.urgency);
    const pm = x.map(procMin).filter((v) => v !== null).sort((a, b) => a - b);
    return { urgency: n.urgency, name_ua: n.name_ua, norm_min: n.norm_min, is_conditional: n.is_conditional, docs: x.length,
      median_min: percentile(pm, 0.5), p90_min: percentile(pm, 0.9), overdue_pct: r2(100 * x.filter(overdue).length / x.length) };
  });
};
H['docs/overdue'] = (q, f) => {
  const g = groupBy(docs(f), (d) => Math.floor(d.t / DAY));
  return { threshold_pct: 5.0, rows: series('day', f).map((p) => {
    const x = g.get(p) || [];
    const o = x.filter(overdue).length;
    return { period: dayIso(p), docs: x.length, overdue: o, overdue_pct: x.length ? r2(100 * o / x.length) : null };
  }) };
};
H['docs/by-type'] = (q, f) => [...groupBy(docs(f), (d) => d.ty)].map(([doc_type, x]) => ({ doc_type, docs: x.length,
  overdue: x.filter(overdue).length })).sort((a, b) => b.docs - a.docs);
H['docs/queue'] = (q, f) => {
  const lim = Number(q.get('limit') || 200);
  return docs(f, { time: false }).filter((d) => d.st === 'new' || d.st === 'in_work').map((d) => {
    const n = DB.norm.get(d.urg);
    return { id: d.id, reg_number: d.reg, doc_type: d.ty, urgency: d.urg, urgency_ua: n.name_ua, sort_order: n.sort_order,
      status: d.st, access_level: d.acc, channel: d.ch, special_mark: d.mark, sender: DB.unitById.get(d.s)?.short_name,
      recipient: DB.unitById.get(d.rc)?.short_name, origin: d.o, received_at: kyivIso(d.t), due_at: kyivIso(d.due),
      is_overdue: overdue(d), waiting_min: minBetween(d.t, DB.asOf), _due: d.due };
  }).sort((a, b) => a.sort_order - b.sort_order || a._due - b._due).slice(0, lim).map(({ _due, ...r }) => r);
};

// --- KPI ---
function kAir(f) {
  const x = strikes(f), nk = x.filter((s) => !isKab(s));
  return { air_launched: sum(x, 'l'), air_rate: pct(sum(nk, (s) => s.i + s.s), sum(nk, 'l')) };
}
function kArt(f) {
  const x = arts(f, (a) => a.dir === 'incoming');
  const cb = cbs(f);
  const eq = lastBy(equips(f), (r) => `${r.u}|${r.m}`);
  return { art_shellings: x.length, art_rounds: sum(x, 'r'),
    art_cb_response: pct(cb.filter((c) => c.tr !== null).length, cb.length), art_eq_ready: pct(sum(eq, 'op'), sum(eq, 'tot')) };
}
function kLoss(f) {
  const x = losses(f);
  const s = daily('strength', f);
  const maxD = s.reduce((m, r) => Math.max(m, r.d), -Infinity);
  const last = s.filter((r) => r.d === maxD);
  return { loss_wounded: sum(x, 'w'), loss_killed: sum(x, 'k'), loss_manning: pct(sum(last, 'pr'), sum(last, 'au')) };
}
function kDocs(f) {
  const x = docs(f);
  const urgent = x.filter((d) => d.urg === 'horizon' || d.urg === 'efir').map(procMin).filter((v) => v !== null).sort((a, b) => a - b);
  const med = percentile(urgent, 0.5);
  return { docs_per_day: Math.round(10 * x.length / f.days) / 10,
    docs_overdue: x.length ? Math.round(1000 * x.filter(overdue).length / x.length) / 10 : null,
    docs_median_urgent: med === null ? null : Math.round(med * 10) / 10 };
}
const SPEC = {
  air_launched: ['air', 'Засобів повітряного нападу', 'од.', 'down', null],
  air_rate: ['air', 'Збито та подавлено', '%', 'up', 'без КАБ'],
  art_shellings: ['artillery', 'Обстрілів по наших військах', 'од.', 'down', null],
  art_rounds: ['artillery', 'Пострілів противника', 'пострілів', 'down', null],
  art_cb_response: ['artillery', 'Відповідь на виявлені позиції', '%', 'up', 'контрбатарейна боротьба'],
  art_eq_ready: ['artillery', 'Справних артсистем', '%', 'up', 'за останнім донесенням'],
  loss_wounded: ['losses', 'Санітарні втрати', 'осіб', 'down', 'останні 7 діб періоду'],
  loss_killed: ['losses', 'Безповоротні втрати', 'осіб', 'down', 'останні 7 діб періоду'],
  loss_manning: ['losses', 'Укомплектованість', '%', 'up', 'на кінець періоду'],
  docs_per_day: ['docs', 'Документів за добу', 'од.', 'down', 'середнє'],
  docs_overdue: ['docs', 'Прострочено', '%', 'down', null],
  docs_median_urgent: ['docs', 'Медіана обробки ГОРИЗОНТ/ЕФІР', 'хв', 'down', null],
};
const CALC = { air: kAir, artillery: kArt, losses: kLoss, docs: kDocs };
const OVERVIEW = ['air_launched', 'air_rate', 'art_shellings', 'art_rounds', 'loss_wounded', 'loss_killed', 'docs_per_day', 'docs_overdue'];
H.kpi = (q, f) => {
  const module = q.get('module') || 'overview';
  const mods = module === 'overview' ? Object.keys(CALC) : [module];
  const cur = {}, prev = {};
  mods.forEach((m) => {
    const ff = m === 'losses' ? lastDays(f, Math.min(7, f.days)) : f;
    Object.assign(cur, CALC[m](ff));
    Object.assign(prev, CALC[m](m === 'losses' ? lastDays(previous(f), Math.min(7, f.days)) : previous(f)));
  });
  const keys = module === 'overview' ? OVERVIEW : Object.keys(SPEC).filter((k) => SPEC[k][0] === module);
  return { module, date_from: dayIso(f.df), date_to: dayIso(f.dt), items: keys.map((k) => {
    const [m, label, unit, better, note] = SPEC[k];
    const v = cur[k] ?? null, pv = prev[k] ?? null;
    const delta = pv === null || pv === 0 || v === null ? null : Math.round(1000 * (v - pv) / pv) / 10;
    return { key: k, module: m, label, value: v, unit, previous: pv, delta_pct: delta, better, note };
  }) };
};

// --- Карта ---
const NOMINAL = { command: 200, corps: 300, brigade: 400, regiment: 800, battalion: 450, company: 100 };
const readiness = (loss, e) => { const r = loss / (NOMINAL[e] || 400); return r < 0.05 ? 'green' : r < 0.12 ? 'yellow' : r < 0.25 ? 'red' : 'black'; };
H['map/units'] = (q, f) => {
  const g = groupBy(DB.t.losses.filter((l) => l.d >= f.df && l.d <= f.dt), (l) => l.u);
  return DB.d.units.map((u) => {
    const x = g.get(u.id) || [];
    const k = sum(x, 'k'), w = sum(x, 'w'), m = sum(x, 'm');
    const o = DB.oblById.get(u.oblast_id);
    return { ...u, parent: DB.unitById.get(u.parent_id)?.short_name ?? null, oblast: o.iso_code, oblast_ua: o.name_ua,
      killed: k, wounded: w, missing: m, readiness: readiness(k + w + m, u.echelon), selected: !f.unit.length || f.unit.includes(u.id) };
  });
};
H['map/enemy-units'] = () => ({ source: DB.d.enemy_units[0]?.source ?? 'DeepStateMap', as_of: DB.d.enemy_units[0]?.as_of ?? '',
  rows: DB.d.enemy_units });
H['map/contact-line'] = () => {
  const segs = new Map();
  DB.d.contact_line.forEach((r) => { if (!segs.has(r.segment)) segs.set(r.segment, []); segs.get(r.segment).push([r.lat, r.lon, r.e_lat, r.e_lon]); });
  return { source: 'DeepStateMap (deepstatemap.live)', as_of: DB.meta.deepstate_as_of,
    note: 'Положення лінії — за відкритими даними DeepStateMap; не є офіційними даними.', segments: [...segs.values()] };
};
const FLOW_LEVEL = { corps: 1, brigade: 2, regiment: 2, battalion: 3, company: 4 };
H['map/flows'] = (q, f) => {
  const pairs = groupBy(docs(f), (d) => `${d.s}|${d.rc}`);
  const edges = new Map(), received = new Map();
  pairs.forEach((x, k) => {
    const [s, r] = k.split('|').map(Number);
    const n = x.length, o = x.filter(overdue).length;
    const rc = received.get(r) || { docs: 0, overdue: 0 };
    rc.docs += n; rc.overdue += o; received.set(r, rc);
    let cur = s, guard = 0;
    while (cur !== r && DB.unitById.get(cur)?.parent_id != null && guard < 8) {
      const par = DB.unitById.get(cur).parent_id;
      const e = edges.get(`${cur}|${par}`) || { a: cur, b: par, docs: 0, overdue: 0 };
      e.docs += n; e.overdue += o; edges.set(`${cur}|${par}`, e);
      cur = par; guard += 1;
    }
  });
  const out = [...edges.values()].map((e) => {
    const ua = DB.unitById.get(e.a), ub = DB.unitById.get(e.b);
    return { from_id: e.a, to_id: e.b, from: ua.short_name, to: ub.short_name, level: FLOW_LEVEL[ua.echelon] ?? 4, echelon: ua.echelon,
      from_lat: ua.lat, from_lon: ua.lon, to_lat: ub.lat, to_lon: ub.lon, docs: e.docs, overdue: e.overdue,
      overdue_pct: e.docs ? Math.round(1000 * e.overdue / e.docs) / 10 : 0 };
  }).sort((a, b) => a.level - b.level || b.docs - a.docs || a.from_id - b.from_id);
  const posts = [...received].sort((a, b) => a[0] - b[0]).map(([id, v]) => ({ id, name: DB.unitById.get(id).short_name, lat: DB.unitById.get(id).lat,
    lon: DB.unitById.get(id).lon, ...v, overdue_pct: v.docs ? Math.round(1000 * v.overdue / v.docs) / 10 : 0 }));
  return { edges: out, posts };
};
H['map/choropleth'] = (q, f) => {
  const module = q.get('module') || 'air';
  const v = new Map();
  const add = (id, x) => v.set(id, (v.get(id) || 0) + x);
  let label;
  if (module === 'air') { DB.t.strikes.forEach((s) => inT(f, s.t) && add(s.ob, s.l)); label = 'Засобів повітряного нападу, од.'; }
  else if (module === 'artillery') { DB.t.artillery.forEach((a) => a.dir === 'incoming' && inT(f, a.t) && add(a.ob, a.r)); label = 'Пострілів противника'; }
  else if (module === 'losses') { DB.t.losses.forEach((l) => l.d >= f.df && l.d <= f.dt && add(DB.unitById.get(l.u).oblast_id, l.k + l.w + l.m)); label = 'Втрати, осіб'; }
  else if (module === 'docs') { DB.t.docs.forEach((d) => inT(f, d.t) && add(DB.unitById.get(d.s).oblast_id, 1)); label = 'Документів від підрозділів, од.'; }
  else { DB.t.alerts.forEach((a) => inT(f, a.t0) && a.t1 !== null && add(a.ob, minBetween(a.t0, a.t1))); label = 'Тривалість тривог, год'; }
  return { module, label, values: DB.d.oblasts.map((o) => ({ iso_code: o.iso_code, name_ua: o.name_ua,
    value: module === 'alerts' ? Math.round((v.get(o.id) || 0) / 6) / 10 : (v.get(o.id) || 0) })) };
};

// --- Журнал (як backend/app/routers/journal.py) ---
const L = (g, c) => (c === null || c === undefined ? null : DB.labels[g]?.[c] ?? c);
const mask = (v) => (v >= 1 && v <= 4 ? '<5' : v);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);   // як COLLATE "C" / порівняння байтів
const JOURNAL = {
  air: { title: 'ПЕРЕЛІК повітряних ударів', rows: (f) => strikes(f), def: (a, b) => b.t - a.t,
    cols: [['time', 'Час', (s) => fmtT(s.t), (s) => s.t], ['oblast', 'Область', (s) => DB.oblById.get(s.ob).name_ua],
      ['weapon', 'Засіб', (s) => DB.weapById.get(s.w).name_ua], ['launched', 'Запущено, од.', (s) => s.l],
      ['intercepted', 'Збито, од.', (s) => s.i], ['suppressed', 'Подавлено РЕБ, од.', (s) => s.s], ['hits', 'Влучання, од.', (s) => s.h],
      ['target', 'Категорія цілі', (s) => DB.tgById.get(s.tg)?.name_ua ?? null], ['source', 'Джерело', (s) => s.src],
      ['reliability', 'Достовірність', (s) => s.rel], ['origin', 'Походження запису', (s) => L('origin', s.o)]],
    search: ['oblast', 'weapon', 'target'] },
  alerts: { title: 'ПЕРЕЛІК повітряних тривог', rows: (f) => DB.t.alerts.filter((a) => inT(f, a.t0) && oblOk(f, a.ob)), def: (a, b) => b.t0 - a.t0,
    cols: [['start', 'Початок', (a) => fmtT(a.t0), (a) => a.t0], ['end', 'Кінець', (a) => fmtT(a.t1), (a) => a.t1],
      ['oblast', 'Область', (a) => DB.oblById.get(a.ob).name_ua], ['type', 'Тип тривоги', (a) => L('alert_type', a.ty)],
      ['duration', 'Тривалість, хв', (a) => (a.t1 === null ? null : minBetween(a.t0, a.t1))], ['origin', 'Походження запису', (a) => L('origin', a.o)]],
    search: ['oblast'] },
  artillery: { title: 'ПЕРЕЛІК артилерійських обстрілів', rows: (f) => arts(f), def: (a, b) => b.t - a.t,
    cols: [['time', 'Час', (a) => fmtT(a.t), (a) => a.t], ['direction', 'Напрямок вогню', (a) => L('direction', a.dir)],
      ['system', 'Система', (a) => L('system_type', a.sys)], ['caliber', 'Калібр, мм', (a) => a.mm],
      ['class', 'Клас калібру', (a) => L('caliber_class', a.cls)], ['rounds', 'Кількість пострілів', (a) => a.r],
      ['oblast', 'Область', (a) => DB.oblById.get(a.ob).name_ua], ['unit', 'Підрозділ', (a) => DB.unitById.get(a.u)?.short_name ?? null],
      ['result', 'Результат ураження', (a) => L('result', a.res)], ['source', 'Джерело', (a) => a.src],
      ['reliability', 'Достовірність', (a) => a.rel], ['origin', 'Походження запису', (a) => L('origin', a.o)]],
    search: ['oblast', 'unit'] },
  losses: { title: 'ЗВЕДЕННЯ втрат особового складу за підрозділами і добами', rows: (f) => losses(f),
    def: (a, b) => b.d - a.d || cmpStr(DB.unitById.get(a.u).short_name, DB.unitById.get(b.u).short_name),
    cols: [['date', 'Дата', (l) => fmtD(l.d), (l) => l.d], ['unit', 'Підрозділ', (l) => DB.unitById.get(l.u).short_name],
      ['cause', 'Причина', (l) => L('cause', l.c)], ['killed', 'Безповоротні, осіб', (l) => mask(l.k), (l) => l.k],
      ['wounded', 'Санітарні, осіб', (l) => mask(l.w), (l) => l.w], ['missing', 'Зниклі безвісти, осіб', (l) => mask(l.m), (l) => l.m],
      ['returned', 'Повернуто до строю, осіб', (l) => mask(l.r), (l) => l.r], ['origin', 'Походження запису', (l) => L('origin', l.o)]],
    search: ['unit'] },
  counter_battery: { title: 'ПЕРЕЛІК виявлених вогневих позицій противника (контрбатарейна боротьба)', rows: (f) => cbs(f), def: (a, b) => b.t - a.t,
    cols: [['time', 'Виявлено', (c) => fmtT(c.t), (c) => c.t], ['means', 'Засіб виявлення', (c) => L('detected_by', c.by)],
      ['system', 'Система противника', (c) => L('system_type', c.sys)], ['caliber', 'Калібр, мм', (c) => c.mm],
      ['oblast', 'Область', (c) => DB.oblById.get(c.ob).name_ua], ['unit', 'Підрозділ, що відкрив вогонь', (c) => DB.unitById.get(c.u)?.short_name ?? null],
      ['responded', 'Відкрито вогонь', (c) => fmtT(c.tr), (c) => c.tr], ['reaction', 'Час реакції, хв', (c) => c.rm],
      ['rounds', 'Пострілів у відповідь', (c) => c.r], ['result', 'Результат', (c) => L('result', c.res)], ['source', 'Джерело', (c) => c.src],
      ['reliability', 'Достовірність', (c) => c.rel], ['origin', 'Походження запису', (c) => L('origin', c.o)]],
    search: ['oblast', 'unit'] },
  ammo: { title: 'ВІДОМІСТЬ руху боєприпасів за підрозділами і добами', rows: (f) => daily('ammo', f),
    def: (a, b) => b.d - a.d || cmpStr(DB.unitById.get(a.u).short_name, DB.unitById.get(b.u).short_name) || cmpStr(a.a, b.a),
    cols: [['date', 'Дата', (r) => fmtD(r.d), (r) => r.d], ['unit', 'Підрозділ', (r) => DB.unitById.get(r.u).short_name],
      ['ammo', 'Вид боєприпасів', (r) => L('ammo_type', r.a)], ['expended', 'Витрачено, шт.', (r) => r.e],
      ['received', 'Надійшло, шт.', (r) => r.rc], ['stock', 'Залишок на кінець доби, шт.', (r) => r.s],
      ['origin', 'Походження запису', (r) => L('origin', r.o)]],
    search: ['unit'] },
  equipment: { title: 'ВІДОМІСТЬ стану артилерійського озброєння (щотижневі донесення)', rows: (f) => equips(f),
    def: (a, b) => b.d - a.d || cmpStr(DB.unitById.get(a.u).short_name, DB.unitById.get(b.u).short_name) || cmpStr(a.m, b.m),
    cols: [['date', 'Дата донесення', (r) => fmtD(r.d), (r) => r.d], ['unit', 'Підрозділ', (r) => DB.unitById.get(r.u).short_name],
      ['model', 'Зразок озброєння', (r) => r.m], ['system', 'Тип системи', (r) => L('system_type', r.sys)], ['caliber', 'Калібр, мм', (r) => r.mm],
      ['total', 'У наявності, од.', (r) => r.tot], ['operational', 'Справні, од.', (r) => r.op], ['repair', 'У ремонті, од.', (r) => r.rep],
      ['lost', 'Втрачено за тиждень, од.', (r) => r.lost], ['origin', 'Походження запису', (r) => L('origin', r.o)]],
    search: ['unit', 'model'] },
  strength: { title: 'ВІДОМІСТЬ укомплектованості підрозділів особовим складом', rows: (f) => daily('strength', f),
    def: (a, b) => b.d - a.d || cmpStr(DB.unitById.get(a.u).short_name, DB.unitById.get(b.u).short_name),
    cols: [['date', 'Дата', (r) => fmtD(r.d), (r) => r.d], ['unit', 'Підрозділ', (r) => DB.unitById.get(r.u).short_name],
      ['authorized', 'За штатом, осіб', (r) => r.au], ['present', 'У наявності, осіб', (r) => r.pr],
      ['manning', 'Укомплектованість, %', (r) => round1(100 * r.pr / r.au)], ['replenished', 'Прибуло поповнення, осіб', (r) => r.rp],
      ['origin', 'Походження запису', (r) => L('origin', r.o)]],
    search: ['unit'] },
  docs: { title: 'ПЕРЕЛІК вхідних документів ОКП', rows: (f) => docs(f), def: (a, b) => b.t - a.t,
    cols: [['reg', 'Обліковий номер', (d) => d.reg], ['received', 'Надходження', (d) => fmtT(d.t), (d) => d.t],
      ['type', 'Вид документа', (d) => L('doc_type', d.ty)], ['urgency', 'Категорія терміновості', (d) => L('urgency', d.urg), (d) => DB.norm.get(d.urg).sort_order],
      ['access', 'Гриф (синт.)', (d) => L('access_level', d.acc)], ['channel', 'Канал', (d) => L('channel', d.ch)],
      ['sender', 'Відправник', (d) => DB.unitById.get(d.s)?.short_name], ['status', 'Стан', (d) => L('status', d.st)],
      ['processing', 'Час обробки, хв', procMin], ['overdue', 'Прострочено', (d) => (overdue(d) ? 'так' : 'ні')],
      ['recipient', 'Отримувач', (d) => DB.unitById.get(d.rc)?.short_name], ['origin', 'Походження запису', (d) => L('origin', d.o)]],
    search: ['reg', 'sender'] },
};
function journalQuery(module, q, f, { all = false } = {}) {
  const m = JOURNAL[module];
  if (!m) throw new Error('404: Невідомий модуль');
  let rows = m.rows(f);
  const text = (q.get('q') || '').trim().toLowerCase();
  if (text) {
    const cols = m.cols.filter((c) => m.search.includes(c[0]));
    rows = rows.filter((r) => cols.some((c) => String(c[2](r) ?? '').toLowerCase().includes(text)));
  }
  const sort = q.get('sort');
  const desc = q.get('desc') !== 'false';
  if (sort && !all) {
    const c = m.cols.find((x) => x[0] === sort);
    if (!c) throw new Error('422: Невідома колонка сортування');
    const key = c[3] || c[2];
    rows = [...rows].sort((a, b) => {
      const va = key(a), vb = key(b);
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const cmp = typeof va === 'number' ? va - vb : cmpStr(String(va), String(vb));
      return (desc ? -cmp : cmp) || m.def(a, b) || b.id - a.id;
    });
  } else rows = [...rows].sort((a, b) => m.def(a, b) || b.id - a.id);
  const total = rows.length;
  const limit = Math.min(1000, Number(q.get('limit') || 50)), offset = Number(q.get('offset') || 0);
  const page = all ? rows : rows.slice(offset, offset + limit);
  const out = page.map((r) => {
    const o = { _id: r.id };
    m.cols.forEach(([k, , fn]) => { const v = fn(r); o[k] = v === null || v === undefined ? DB.noData : v; });
    return o;
  });
  return { m, total, limit, offset, rows: out };
}
H.journal = (q, f, module) => {
  const { m, total, limit, offset, rows } = journalQuery(module, q, f);
  return { title: m.title, columns: m.cols.map((c) => ({ key: c[0], title: c[1] })), total, limit, offset, rows };
};

function exportCsv(module, q) {
  init();
  const f = filters(q);
  const { m, rows } = journalQuery(module, q, f, { all: true });
  const cell = (v) => { const s = String(v ?? ''); return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [[`${m.title} за ${fmtD(f.df)}–${fmtD(f.dt)}. Синтетичні дані. По навчанню.`],
    ['№ з/п', ...m.cols.map((c) => c[1])], ...rows.map((r, i) => [i + 1, ...m.cols.map((c) => r[c[0]])])];
  const text = `﻿${lines.map((l) => l.map(cell).join(';')).join('\r\n')}\r\n`;
  return { name: `${module}_${dayIso(f.df).replace(/-/g, '')}-${dayIso(f.dt).replace(/-/g, '')}.csv`, text };
}

// ---------- Точка входу ----------
async function handle(path, params) {
  init();
  const q = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  if (path.startsWith('journal/')) return H.journal(q, filters(q), path.slice(8));
  const fn = H[path];
  if (!fn) throw new Error(`404: офлайн-режим не підтримує ${path}`);
  return fn(q, fn.length > 1 ? filters(q) : null);
}

const db = () => init();

return { init, reload, dayIso, kyivIso, exportCsv, handle, db };
})();
// ---- api.js ----
__M["api.js"] = (function () {
// Джерело даних дашборду. Два режими з однаковими відповідями:
//   • online  — FastAPI + PostgreSQL (сторінку відкрито з http://…, сервер відповідає);
//   • offline — знімок бази data/dataset.js, обчислення в браузері (сторінку відкрито як файл
//               або сервер недоступний). Так дашборд відкривається на будь-якому комп'ютері.
const { query } = __M["state.js"];
const offline = __M["offline.js"];
const cache = new Map();
let modePromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`не знайдено ${src}`));
    document.head.appendChild(s);
  });
}

function mode() {
  modePromise ??= (async () => {
    if (location.protocol !== 'file:') {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 2500);
        const r = await fetch('/api/health', { signal: ctl.signal });
        clearTimeout(t);
        if (r.ok) return 'online';
      } catch { /* сервер недоступний — офлайн */ }
    }
    if (!window.DATASET) await loadScript('data/dataset.js');
    offline.init();
    return 'offline';
  })();
  return modePromise;
}

async function http(method, url, body, headers = {}) {
  const r = await fetch(url, { method, headers: { Accept: 'application/json', ...headers }, body });
  if (!r.ok) {
    let msg = r.statusText, detail = null;
    try { detail = (await r.json()).detail; msg = typeof detail === 'string' ? detail : msg; } catch { /* ignore */ }
    const e = new Error(`${r.status}: ${msg}`);
    e.status = r.status;
    e.detail = detail;
    throw e;
  }
  return r.json();
}

async function get(path, extra = {}, { filters = true } = {}) {
  const params = filters ? query(extra) : new URLSearchParams(extra);
  const qs = params.toString();
  const key = `${path}?${qs}`;
  if (cache.has(key)) return cache.get(key);
  const p = mode().then((m) => (m === 'online' ? http('GET', `/api/${path}${qs ? `?${qs}` : ''}`) : offline.handle(path, params)));
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}

// Код доступу для внесення даних (якщо на сервері задано ENTRY_TOKEN). Зберігається лише до закриття вкладки.
const TOKEN_KEY = 'entry-token';
function readToken() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
function saveToken(v) { try { if (v) sessionStorage.setItem(TOKEN_KEY, v); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } }

async function write(method, url, body, headers = {}) {
  clearCache();
  for (let attempt = 0; ; attempt += 1) {
    const token = readToken();
    try {
      return await http(method, url, body, token ? { ...headers, 'X-Entry-Token': token } : headers);
    } catch (e) {
      if (e.status !== 401 || attempt >= 2) throw e;
      saveToken('');
      const v = window.prompt(attempt ? 'Код неправильний. Введіть код доступу для внесення даних:'
        : 'Для внесення даних потрібен код доступу (ENTRY_TOKEN з файлу .env):');
      if (!v) throw e;
      saveToken(v.trim());
    }
  }
}

async function post(path, body, { csv = false } = {}) {
  return csv ? write('POST', `/api/${path}`, body, { 'Content-Type': 'text/csv; charset=utf-8' })
    : write('POST', `/api/${path}`, JSON.stringify(body), { 'Content-Type': 'application/json' });
}

async function del(path) { return write('DELETE', `/api/${path}`); }

function clearCache() { cache.clear(); }

// Експорт CSV: онлайн — посилання на API; офлайн — файл формується в браузері
function csvUrl(module, extra = {}) { return `/api/export/${module}.csv?${query(extra).toString()}`; }
async function downloadCsv(module, extra = {}) {
  if (await mode() === 'online') { location.href = csvUrl(module, extra); return; }
  const { name, text } = offline.exportCsv(module, query(extra));
  saveFile(name, text, 'text/csv;charset=utf-8');
}

function saveFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

return { mode, get, post, del, clearCache, csvUrl, downloadCsv, saveFile };
})();
// ---- fonts.js ----
__M["fonts.js"] = (function () {
// Реєстрація шрифтів для Chart.js (v4).
// Canvas не чекає на @font-face, тому графіки малюємо лише після document.fonts.load(),
// а вже створені — перемальовуємо (документація Chart.js, «Loading Fonts»).

// Volja = UAF Sans (фірмовий шрифт). Системний шрифт у стеку підставляє відсутні гліфи (% + тощо).
const FONT_BODY = '"Volja", "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';
const FONT_DISPLAY = FONT_BODY;

const FACES = ['400 16px "Volja"', '900 16px "Volja"'];

async function loadChartFonts(Chart, timeoutMs = 3000) {
  if (document.fonts) {
    const loads = FACES.map((f) => document.fonts.load(f).catch(() => []));
    // Не блокуємо дашборд, якщо шрифт не завантажився: малюємо із запасним.
    await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, timeoutMs))]);
  }
  applyChartTheme(Chart);
  Object.values(Chart.instances || {}).forEach((c) => c.update('none'));
}

// Викликається також при зміні теми: кольори беруться з CSS-токенів.
function applyChartTheme(Chart) {
  const css = getComputedStyle(document.documentElement);
  const v = (n, d) => css.getPropertyValue(n).trim() || d;
  Chart.defaults.font.family = FONT_BODY;
  Chart.defaults.font.size = 12;            // осі й легенди: 12 px (ТЗ §9.2)
  Chart.defaults.color = v('--text-muted', '#5c5444');
  Chart.defaults.borderColor = v('--grid', '#e4dfd2');
  Chart.defaults.plugins.legend.labels.font = { family: FONT_BODY, size: 12 };
  Chart.defaults.plugins.tooltip.titleFont = { family: FONT_BODY, size: 12, weight: '600' };
  Chart.defaults.plugins.tooltip.bodyFont = { family: FONT_BODY, size: 12 };
  Chart.defaults.plugins.tooltip.backgroundColor = v('--tooltip-bg', '#2b2619');
  Chart.defaults.plugins.tooltip.titleColor = v('--tooltip-fg', '#fff');
  Chart.defaults.plugins.tooltip.bodyColor = v('--tooltip-fg', '#fff');
}

return { FONT_BODY, FONT_DISPLAY, loadChartFonts, applyChartTheme };
})();
// ---- format.js ----
__M["format.js"] = (function () {
// Формати: числа uk-UA (пробіл між тисячами, десяткова кома), час «ГГ.ХХ ДД.ММ.РРРР» за київським часом
// (п. 2.1.1 Порядку). Відсутні значення — «немає відом.» (п. 2.3.6).

const NO_DATA = 'немає відом.';
const nf0 = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 });

function num(v, digits = 0) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return typeof v === 'string' && v ? v : NO_DATA;
  return (digits ? nf1 : nf0).format(Number(v));
}

const parts = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

function dtg(iso) {
  if (!iso) return NO_DATA;
  const p = Object.fromEntries(parts.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.hour}.${p.minute} ${p.day}.${p.month}.${p.year}`;
}

// 'YYYY-MM-DD' → 'ДД.ММ.РРРР'
function d(isoDate) {
  if (!isoDate) return NO_DATA;
  const [y, m, dd] = String(isoDate).slice(0, 10).split('-');
  return `${dd}.${m}.${y}`;
}
function dShort(isoDate) {
  const [, m, dd] = String(isoDate).slice(0, 10).split('-');
  return `${dd}.${m}`;
}

function minutes(v) {
  if (v === null || v === undefined) return NO_DATA;
  const m = Number(v);
  if (m < 120) return `${num(m, 1)} хв`;
  return `${num(m / 60, 1)} год`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isUnverified(rel) { return !!rel && /[4-6]$/.test(rel); }

return { NO_DATA, num, dtg, d, dShort, minutes, esc, isUnverified };
})();
// ---- datefield.js ----
__M["datefield.js"] = (function () {
// Поле дати у форматі ДД.ММ.РРРР (і ДД.ММ.РРРР ГГ:ХХ для дати з часом) — п. 2.1.1 Порядку.
// Стандартний <input type="date"> показує дату у форматі мови браузера (наприклад, 10/02/2026),
// тому видиме поле — текстове, а календар браузера відкривається кнопкою і лише підставляє значення.
// Усередині значення зберігається в ISO: data-iso = 'РРРР-ММ-ДД' або 'РРРР-ММ-ДД ГГ:ХХ'.

const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="3" width="13" height="11.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M1.5 6.5h13M5 1.5v3M11 1.5v3" stroke="currentColor" stroke-width="1.4"/></svg>';

const pad = (n) => String(n).padStart(2, '0');

// 'РРРР-ММ-ДД[ ГГ:ХХ]' → 'ДД.ММ.РРРР[ ГГ:ХХ]'
function isoToUa(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(iso || '');
  if (!m) return '';
  return `${m[3]}.${m[2]}.${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}`;
}

// 'ДД.ММ.РРРР[ ГГ:ХХ]' → 'РРРР-ММ-ДД[ ГГ:ХХ]' або null, якщо дата некоректна
function uaToIso(text, withTime = false) {
  const m = /^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2})[:.](\d{2}))?\s*$/.exec(text || '');
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  const date = `${y}-${pad(mo)}-${pad(d)}`;
  if (!withTime) return date;
  const h = m[4] === undefined ? 0 : Number(m[4]);
  const mi = m[5] === undefined ? 0 : Number(m[5]);
  if (h > 23 || mi > 59) return null;
  return `${date} ${pad(h)}:${pad(mi)}`;
}

// HTML поля. attrs — додаткові атрибути видимого текстового поля (name, required тощо).
function dateFieldHtml(id, { time = false, attrs = '' } = {}) {
  const ph = time ? 'ДД.ММ.РРРР ГГ:ХХ' : 'ДД.ММ.РРРР';
  return `<span class="dfield"><input type="text" id="${id}" class="dtext" data-time="${time ? 1 : 0}" placeholder="${ph}"`
    + ` inputmode="numeric" maxlength="${time ? 16 : 10}" autocomplete="off" spellcheck="false"${attrs}>`
    + `<input type="${time ? 'datetime-local' : 'date'}" class="dpick" tabindex="-1" aria-hidden="true">`
    + `<button type="button" class="dbtn" title="Календар" aria-label="Відкрити календар">${ICON}</button></span>`;
}

function getIso(el) { return el.dataset.iso || ''; }

function setIso(el, iso) {
  el.dataset.iso = iso || '';
  el.value = isoToUa(iso);
  el.removeAttribute('aria-invalid');
}

function setRange(el, min, max) {
  el.dataset.min = min || '';
  el.dataset.max = max || '';
  const pick = el.parentElement.querySelector('.dpick');
  if (pick) { pick.min = min || ''; pick.max = max || ''; }
}

// Підключає поведінку: автокрапки під час введення, перевірка, календар. Подія 'datechange' на текстовому
// полі спрацьовує лише тоді, коли дата коректна і data-iso змінилося (стандартна 'change' не використовується).
function initDateField(el) {
  if (el.dataset.ready) return;
  el.dataset.ready = '1';
  const time = el.dataset.time === '1';
  const wrap = el.parentElement;
  const pick = wrap.querySelector('.dpick');

  el.addEventListener('input', (e) => {
    if (e.inputType && e.inputType.startsWith('delete')) return;
    const digits = el.value.replace(/\D/g, '').slice(0, time ? 12 : 8);
    let v = digits.slice(0, 2);
    if (digits.length > 2) v += `.${digits.slice(2, 4)}`;
    if (digits.length > 4) v += `.${digits.slice(4, 8)}`;
    if (time && digits.length > 8) v += ` ${digits.slice(8, 10)}`;
    if (time && digits.length > 10) v += `:${digits.slice(10, 12)}`;
    el.value = v;
  });

  const commit = (fire = true) => {
    if (!el.value.trim()) {
      const changed = !!el.dataset.iso;
      el.dataset.iso = '';
      el.removeAttribute('aria-invalid');
      if (changed && fire) el.dispatchEvent(new CustomEvent('datechange', { bubbles: true }));
      return true;
    }
    let iso = uaToIso(el.value, time);
    const day = iso && iso.slice(0, 10);
    if (iso && ((el.dataset.min && day < el.dataset.min) || (el.dataset.max && day > el.dataset.max))) iso = null;
    if (!iso) {
      // Некоректна дата не повинна тихо підмінятися попереднім значенням
      el.dataset.iso = '';
      el.setAttribute('aria-invalid', 'true');
      el.title = `Дата у форматі ${el.placeholder}${el.dataset.min ? `, від ${isoToUa(el.dataset.min)} до ${isoToUa(el.dataset.max)}` : ''}`;
      return false;
    }
    el.removeAttribute('aria-invalid');
    el.title = '';
    el.value = isoToUa(iso);
    if (iso !== el.dataset.iso) {
      el.dataset.iso = iso;
      if (fire) el.dispatchEvent(new CustomEvent('datechange', { bubbles: true }));
    }
    return true;
  };
  el.addEventListener('blur', () => commit());
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
  el.commitDate = commit;

  wrap.querySelector('.dbtn').addEventListener('click', () => {
    const iso = el.dataset.iso;
    pick.value = iso ? (time ? iso.replace(' ', 'T') : iso) : '';
    try { pick.showPicker(); } catch { pick.focus(); pick.click(); }
  });
  pick.addEventListener('change', () => {
    if (!pick.value) return;
    el.value = isoToUa(pick.value.replace('T', ' '));
    commit();
  });
}

return { isoToUa, uaToIso, dateFieldHtml, getIso, setIso, setRange, initDateField };
})();
// ---- kpi.js ----
__M["kpi.js"] = (function () {
// KPI-блоки: значення + зміна до попереднього періоду такої самої довжини
const { get } = __M["api.js"];
const { esc, num, NO_DATA } = __M["format.js"];
async function renderKpi(root, module) {
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

return { renderKpi };
})();
// ---- symbols.js ----
__M["symbols.js"] = (function () {
// Умовні знаки: основу малює milsymbol (2525C / APP-6, на яких ґрунтується Порядок, наказ № 140),
// національні особливості Порядку — власним SVG-шаром поверх знака:
//   • кольори заливки за табл. 6 Порядку;
//   • позначки ураження за п. 2.2.12: знищено — 2 суцільні перехресні лінії; виведено з ладу/подавлено —
//     1 суцільна + 1 пунктирна; заплановано до ураження — 2 пунктирні. Синій — уразили свої, червоний — противник;
//   • «?» синього кольору для неперевірених даних (п. 2.2.15);
//   • смуга боєздатності (поле AL, табл. 13);
//   • монохромний режим (п. 2.2.13): противник з підписом «ПТН»;
//   • власний підпис під знаком (tag) — напр. засіб ураження біля знака «Вибух» (п. 6.12, 2.2.16).
/* global ms */

const BASE = 30;                 // розмір рендеру; на карті масштабується CSS-змінною --s
const ORDER_COLORS = {
  Friend: 'rgb(128,224,255)', Hostile: 'rgb(255,128,128)', Neutral: 'rgb(170,255,170)',
  Unknown: 'rgb(255,255,128)', Civilian: 'rgb(255,161,255)',
};
const BLUE = '#0057B7';
const RED = '#D40000';
const READINESS = {
  green: { color: '#2E9E44', label: 'боєздатний' }, yellow: { color: '#F5C400', label: 'обмежено боєздатний' },
  red: { color: '#E52421', label: 'небоєздатний' }, black: { color: '#000000', label: 'потребує відновлення' },
};

let ready = false;
function init() {
  if (ready) return;
  const c = ORDER_COLORS;
  ms.setColorMode('Order140', ms.ColorMode(c.Civilian, c.Friend, c.Hostile, c.Neutral, c.Unknown));
  ready = true;
}

const cache = new Map();

/**
 * @param {string} sidc
 * @param {object} o  amps — ампліфікатори milsymbol (uniqueDesignation, higherFormation, quantity, type, dtg…)
 *                    mono, text (показувати текстові поля), cross: 'destroyed'|'disabled'|'planned', crossColor,
 *                    unverified, readiness: 'green'|'yellow'|'red'|'black', size, tag (підпис під знаком), tagColor
 * @returns {{svg:string, ax:number, ay:number, w:number, h:number}}
 */
function render(sidc, o = {}) {
  init();
  const key = JSON.stringify([sidc, o]);
  if (cache.has(key)) return cache.get(key);
  const size = o.size ?? BASE;
  const hostile = sidc[1] === 'H';
  const amps = { ...(o.amps || {}) };
  if (o.mono && hostile) amps.additionalInformation = [amps.additionalInformation, 'ПТН'].filter(Boolean).join(' ');
  const opts = { size, infoFields: o.text !== false, ...amps };
  if (o.mono) { opts.monoColor = '#000000'; opts.fill = false; } else { opts.colorMode = 'Order140'; }
  const sym = new ms.Symbol(sidc, opts);
  const inner = sym.asSVG();
  const a = sym.getAnchor();
  const s = sym.getSize();
  const oc = sym.getOctagonAnchor ? sym.getOctagonAnchor() : a;
  const pad = Math.round(size * 0.55);
  const W = Math.ceil(s.width + pad * 2), H = Math.ceil(s.height + pad * 2);
  const cx = oc.x + pad, cy = oc.y + pad;
  const hw = size * (hostile ? 0.78 : 0.82), hh = size * (hostile ? 0.78 : 0.58);
  let over = '';

  if (o.cross) {
    const col = o.crossColor || BLUE;
    const sw = Math.max(2, size / 12);
    const dashA = o.cross === 'planned' ? `stroke-dasharray="${sw * 2.2} ${sw * 1.6}"` : '';
    const dashB = o.cross === 'destroyed' ? '' : `stroke-dasharray="${sw * 2.2} ${sw * 1.6}"`;
    over += `<line x1="${cx - hw}" y1="${cy - hh}" x2="${cx + hw}" y2="${cy + hh}" stroke="${col}" stroke-width="${sw}" ${dashA}/>`;
    over += `<line x1="${cx - hw}" y1="${cy + hh}" x2="${cx + hw}" y2="${cy - hh}" stroke="${col}" stroke-width="${sw}" ${dashB}/>`;
  }
  if (o.readiness && READINESS[o.readiness]) {
    const bw = hw * 2, bh = Math.max(3, size / 7);
    over += `<rect x="${cx - hw}" y="${cy + hh + size * 0.12}" width="${bw}" height="${bh}" fill="${READINESS[o.readiness].color}" stroke="#000" stroke-width="0.6"/>`;
  }
  if (o.unverified) {
    over += `<text x="${cx + hw + 2}" y="${cy - hh + size * 0.1}" fill="${BLUE}" font-size="${size * 0.62}" font-weight="700" font-family="Arial, sans-serif">?</text>`;
  }
  if (o.tag) {
    const col = o.mono ? '#000' : (o.tagColor || RED);
    over += `<text x="${cx}" y="${cy + hh + size * 0.62}" text-anchor="middle" fill="${col}" stroke="#fff" stroke-width="${size / 9}"
      paint-order="stroke" font-size="${size * 0.5}" font-weight="700" font-family="Volja, Segoe UI, Arial, sans-serif">${o.tag}</text>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<g transform="translate(${pad},${pad})">${inner}</g>${over}</svg>`;
  const out = { svg, ax: a.x + pad, ay: a.y + pad, w: W, h: H };
  cache.set(key, out);
  return out;
}

// Ланка за 12-м символом SIDC (табл. 8 Порядку): I — дивізія … M — регіон
const ECHELON_MARK = { H: 'X', I: 'XX', J: 'XXX', K: 'XXXX', L: 'XXXXX', M: 'XXXXXX' };
const echelonMark = (sidc) => ECHELON_MARK[sidc?.[11]] ?? '';

/**
 * Пункт управління угруповання за п. 6.1 Порядку (зразки «ОКП ОК “Схід”», «ОКП ОУВ “Таврія”», «ОКП ОТУ “Поділ”»):
 * прапорець зі смугою вгорі, у ньому — скорочення угруповання; над прапорцем — ланка (табл. 8);
 * флагшток іде вниз від лівого краю прапорця, його нижня точка — місце пункту на місцевості;
 * під прапорцем праворуч від флагштока — вид пункту (ОКП); ліворуч — найменування, праворуч — підпорядкованість.
 * @param {object} o echelon ('XXXX'), inner ('ОСУВ'), kind ('ОКП'), left, right, mono, size, text (false — без бічних підписів)
 */
function renderCP(o = {}) {
  const key = JSON.stringify(['cp', o]);
  if (cache.has(key)) return cache.get(key);
  const size = o.size ?? BASE;
  const col = '#000', fill = o.mono ? '#fff' : ORDER_COLORS.Friend;
  const fw = size * 1.75, fh = size * 1.1, band = fh * 0.2, sw = Math.max(1.2, size / 20);
  const fs = size * 0.44, fsSide = size * 0.42;
  const font = 'font-family="Arial, sans-serif" font-weight="700"';
  const sideW = (s) => (s ? s.length * fsSide * 0.62 + size * 0.25 : 0);
  const showSides = o.text !== false;
  const lw = showSides ? sideW(o.left) : 0, rw = showSides ? sideW(o.right) : 0;
  const pad = sw + 2;
  const x0 = pad + lw;                       // лівий край прапорця = флагшток
  const yTop = pad + fs * 1.15;              // під позначкою ланки
  const yStaff = yTop + fh * 2;              // нижня точка флагштока
  const W = Math.ceil(x0 + fw + rw + pad), H = Math.ceil(yStaff + pad);
  const cx = x0 + fw / 2;
  // скорочення в прапорці стискається, якщо довге
  const innerFs = Math.min(fs, (fw * 0.9) / Math.max(1, (o.inner || '').length * 0.66));
  let g = `<rect x="${x0}" y="${yTop}" width="${fw}" height="${fh}" fill="${fill}" stroke="${col}" stroke-width="${sw}"/>`
    + `<line x1="${x0}" y1="${yTop + band}" x2="${x0 + fw}" y2="${yTop + band}" stroke="${col}" stroke-width="${sw}"/>`
    + `<line x1="${x0}" y1="${yTop}" x2="${x0}" y2="${yStaff}" stroke="${col}" stroke-width="${sw * 1.1}"/>`;
  if (o.echelon) g += `<text x="${cx}" y="${yTop - sw * 1.5}" text-anchor="middle" font-size="${fs}" ${font} fill="${col}">${o.echelon}</text>`;
  if (o.inner) g += `<text x="${cx}" y="${yTop + band + (fh - band) / 2 + innerFs * 0.36}" text-anchor="middle" font-size="${innerFs}" ${font} fill="${col}">${o.inner}</text>`;
  if (o.kind) g += `<text x="${cx}" y="${yTop + fh + fs * 1.15}" text-anchor="middle" font-size="${fs}" ${font} fill="${col}">${o.kind}</text>`;
  const ySide = yTop + fh + fsSide * 0.35;
  if (showSides && o.left) g += `<text x="${x0 - size * 0.18}" y="${ySide}" text-anchor="end" font-size="${fsSide}" font-family="Arial, sans-serif" fill="${col}">${o.left}</text>`;
  if (showSides && o.right) g += `<text x="${x0 + fw + size * 0.18}" y="${ySide}" font-size="${fsSide}" font-family="Arial, sans-serif" fill="${col}">${o.right}</text>`;
  const out = { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${g}</svg>`,
    ax: x0, ay: yStaff, w: W, h: H };
  cache.set(key, out);
  return out;
}

// Ціль вогню своєї артилерії: знак п. 6.2.2 Порядку «Вогонь по одиночній цілі із зазначенням номера цілі» —
// хрест із номером. Вогонь артилерії своїх військ наноситься синім (п. 2.2.2), у монохромі — чорним (п. 2.2.13).
// Результат ураження — перехресні лінії за п. 2.2.12 поверх знака.
function renderTarget(o = {}) {
  const key = JSON.stringify(['target', o]);
  if (cache.has(key)) return cache.get(key);
  const size = o.size ?? BASE;
  const col = o.mono ? '#000' : BLUE;
  const r = size * 0.62, sw = Math.max(2, size / 14);
  const pad = Math.round(size * 0.9);
  const W = Math.ceil(r * 2 + pad * 2), H = W;
  const cx = W / 2, cy = H / 2;
  let g = `<line x1="${cx - r}" y1="${cy}" x2="${cx + r}" y2="${cy}" stroke="${col}" stroke-width="${sw}"/>`
    + `<line x1="${cx}" y1="${cy - r}" x2="${cx}" y2="${cy + r}" stroke="${col}" stroke-width="${sw}"/>`;
  if (o.label) {
    g += `<text x="${cx + sw * 1.5}" y="${cy - sw * 1.5}" fill="${col}" stroke="#fff" stroke-width="${size / 10}" paint-order="stroke"
      font-size="${size * 0.42}" font-weight="700" font-family="Arial, sans-serif">${o.label}</text>`;
  }
  if (o.cross) {
    const h = r * 0.8, sw2 = Math.max(2, size / 12), dash = `stroke-dasharray="${sw2 * 2.2} ${sw2 * 1.6}"`;
    g += `<line x1="${cx - h}" y1="${cy - h}" x2="${cx + h}" y2="${cy + h}" stroke="${col}" stroke-width="${sw2}" ${o.cross === 'planned' ? dash : ''}/>`;
    g += `<line x1="${cx - h}" y1="${cy + h}" x2="${cx + h}" y2="${cy - h}" stroke="${col}" stroke-width="${sw2}" ${o.cross === 'destroyed' ? '' : dash}/>`;
  }
  if (o.unverified) {
    g += `<text x="${cx + r * 0.7}" y="${cy + r}" fill="${BLUE}" font-size="${size * 0.62}" font-weight="700" font-family="Arial, sans-serif">?</text>`;
  }
  const out = { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${g}</svg>`,
    ax: cx, ay: cy, w: W, h: H };
  cache.set(key, out);
  return out;
}

// Результат артилерійського вогню → тип позначки за п. 2.2.12
function crossForResult(result) {
  if (result === 'destroyed') return 'destroyed';
  if (result === 'damaged' || result === 'suppressed') return 'disabled';
  return null;
}

// Повітряна ціль: усі знешкоджено → «знищено»; є подавлені РЕБ і без влучань → «подавлено»
function crossForStrike(p) {
  if (p.hits > 0) return null;
  if (p.intercepted >= p.launched) return 'destroyed';
  if (p.intercepted + p.suppressed >= p.launched) return 'disabled';
  return null;
}

// Знак на карті — <img> із SVG у data-URL, а не вбудований SVG: один DOM-вузол замість десятків,
// браузер растеризує однакові знаки один раз (кеш зображень). Помітно прискорює масштабування.
function iconHtml(r, cls = '') {
  r.url ??= `data:image/svg+xml;charset=utf-8,${encodeURIComponent(r.svg)}`;
  return `<div class="sym ${cls}" style="--ax:${r.ax};--ay:${r.ay}"><img src="${r.url}" width="${r.w}" height="${r.h}" alt="" draggable="false"></div>`;
}

return { BASE, ORDER_COLORS, BLUE, RED, READINESS, render, echelonMark, renderCP, renderTarget, crossForResult, crossForStrike, iconHtml };
})();
// ---- map.js ----
__M["map.js"] = (function () {
// Карта України: OpenStreetMap + Leaflet + milsymbol.
// Знаки — за Порядком (наказ № 140); чого в ньому немає — за APP-6 / MIL-STD-2525C.
// Поведінка від масштабу (п. 5.4.3: розмір знака залежить від масштабу карти):
//   • розмір знака змінюється разом із зумом (CSS-змінна --s, без перемальовування SVG);
//   • дрібні ланки ховаються при віддаленні (пороги MIN_ZOOM_*), на масштабі 5 знаки зникають;
//   • текстові ампліфікатори — з масштабу 8,5.
// Засоби повітряного нападу противника (БпЛА, ракети, КАБ) на карті показано лише місцями уражень
// (знак «Вибух, підрив» п. 6.12 з власним підписом засобу, п. 2.2.16); траєкторії — ні, деталі — у звітах.
/* global L, GEO */
const { get } = __M["api.js"];
const { state, toggleOblast, label } = __M["state.js"];
const { BASE, BLUE, RED, READINESS, render, renderTarget, renderCP, echelonMark, iconHtml, crossForResult } = __M["symbols.js"];
const { dtg, esc, num, isUnverified } = __M["format.js"];
const UA_BOUNDS = L.latLngBounds([44.2, 22.0], [52.45, 40.3]);
const sizeForZoom = (z) => 14 + (Math.max(5, Math.min(12, z)) - 5) * 4;   // 14 px … 42 px
// Пороги ×10 (класи mz-N / zl-N): елемент із класом mz-N ховається, коли зум < N/10
const THRESHOLDS = [55, 65, 70, 80, 90, 95];
const MIN_ZOOM_ECHELON = { command: 55, corps: 55, brigade: 65, regiment: 70, battalion: 80, company: 95 };
const MIN_ZOOM_ENEMY = { army: 55, corps: 55, division: 65, brigade: 80, regiment: 80, battalion: 90, unknown: 90 };
const MIN_ZOOM_FLOW = { 1: 55, 2: 65, 3: 80, 4: 95 };
const EVENT_MIN_ZOOM = 55;
const LABEL_ZOOM = 8.5;
const SEA = '#035C6B', GOLD = '#C98A00';

const strip = (s) => (s || '').replace(/\s*\((умовна|умовний|умовне|ум\.)\)/g, '');

function popup(title, rows, extra = '', note = 'Синтетичні дані. По навчанню.') {
  const dl = rows.filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<dt>${esc(k)}:</dt><dd>${esc(v ?? 'немає відом.')}</dd>`).join('');
  return `<div class="pop"><h4>${esc(title)}</h4><dl>${dl}</dl>${extra}<div class="syn">${esc(note)}</div></div>`;
}

function sourceText(src, rel) {
  if (!src && !rel) return 'немає відом.';
  return `${src || '—'}, ${rel || '—'}${isUnverified(rel) ? ' (?) неперевірено' : ''}`;
}

const flowColor = (pct) => (pct > 10 ? RED : pct >= 5 ? GOLD : SEA);
// Засіб виявлення — скорочення джерел за п. 2.2.15 Порядку (пишуться чорним)
const CB_TAG = { radar: 'РЛР', uav: 'ПвР', sound: 'АР', visual: 'С' };
const ring = (r) => r.map(([lon, lat]) => [lat, lon]);
// «ОТУ-1 (умовне)» → у прапорці «ОТУ», ліворуч «1», праворуч — старший («ОСУВ»), під прапорцем «ОКП» (п. 6.1)
function cpParts(u) {
  const name = strip(u.short_name).trim();
  const m = name.match(/^([А-ЯІЇЄҐA-Z]+)(?:[-\s]+(.+))?$/u);
  return { echelon: echelonMark(u.sidc), inner: m ? m[1] : name, left: m?.[2] ?? '', kind: 'ОКП',
    right: strip(u.parent).replace(/\s*\(.*$/, '').trim() };
}

class MapView {
  constructor(el, { panel = true, legendEl = null } = {}) {
    this.el = el;
    this.legendEl = legendEl;
    this.mono = false;
    this.choroModule = 'air';
    this.on = { oblasts: true, areas: true, line: true, enemy: true, units: true, impacts: true, artillery: true,
      cb: false, docs: false, alerts: true };
    // Набір шарів можна передати в URL: ?layers=docs,units,line
    if (state.layers) Object.keys(this.on).forEach((k) => { this.on[k] = state.layers.includes(k); });
    this.map = L.map(el, { minZoom: 5, maxZoom: 12, maxBounds: UA_BOUNDS.pad(0.25), maxBoundsViscosity: 0.8,
      zoomSnap: 0.5, zoomDelta: 0.5, wheelPxPerZoomLevel: 120, preferCanvas: false, attributionControl: true });
    this.initBasemap();
    if (state.view) this.map.setView(state.view.c, state.view.z);
    else this.map.fitBounds(UA_BOUNDS);

    // Полігони й лінії малюються на одному canvas: при зміні масштабу не перебудовуються сотні SVG-шляхів
    this.vec = L.canvas({ padding: 0.3, tolerance: 3 });
    const cluster = (z, kind, r = 50) => L.markerClusterGroup({ disableClusteringAtZoom: z, maxClusterRadius: r,
      showCoverageOnHover: false, animate: false, chunkedLoading: true,
      iconCreateFunction: (c) => this.clusterIcon(c, kind) });
    // Знаки своїх і противника, що не мають бути видні на поточному масштабі, прибираються з карти (а не ховаються CSS)
    this.zMarkers = [];
    this.g = {
      oblasts: L.layerGroup(), areas: L.layerGroup(), alerts: L.layerGroup(), line: L.layerGroup(), docs: L.layerGroup(),
      enemy: L.layerGroup(), units: L.layerGroup(), impacts: cluster(8, 'imp', 22), artillery: cluster(11, 'art', 45), cb: cluster(10, 'art', 35),
    };
    Object.entries(this.g).forEach(([k, layer]) => { if (this.on[k]) layer.addTo(this.map); });

    this.addHomeButton();
    if (panel) this.addPanel();
    const apply = (z) => this.applyZoom(z);
    this.map.on('zoomanim', (e) => apply(e.zoom));
    this.map.on('zoomend', () => {
      const z = this.map.getZoom();
      apply(z);
      this.syncZoomMarkers(z);
      if (z !== this.lineZoom) this.drawLine();   // дуги залежать лише від масштабу, не від зсуву
    });
    // Дуги рахуються лише для видимої частини (з запасом); при виході за неї — перерахунок
    this.map.on('moveend', () => {
      if (this.lineBounds && this.map.getZoom() === this.lineZoom && !this.lineBounds.contains(this.map.getPixelBounds())) this.drawLine();
    });
    this.applyZoom(this.map.getZoom());
  }

  // ---- Підкладка: OSM (потрібен інтернет) або векторна «Схема» з Natural Earth (data/basemap.js, без інтернету) ----
  initBasemap() {
    const tail = 'межі: geoBoundaries (CC BY 4.0); лінія зіткнення, зони, противник: '
      + '<a href="https://deepstatemap.live" target="_blank" rel="noopener">DeepStateMap</a>. Свої підрозділи й події — синтетичні.';
    this.osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin', attribution: `&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; ${tail}`,
    });
    // Жоден тайл не завантажився, а помилок уже кілька — інтернету немає: автоматично вмикаємо схему
    let ok = 0, fail = 0;
    this.osm.on('tileload', () => { ok += 1; });
    this.osm.on('tileerror', () => {
      fail += 1;
      if (!ok && fail >= 4 && this.baseMode === 'osm' && window.BASEMAP) { this.autoSchema = true; this.setBasemap('schema', false); }
    });
    this.schema = L.layerGroup();
    this.schemaTail = `Підкладка: Natural Earth (суспільне надбання); ${tail}`;
    let saved = null;
    try { saved = localStorage.getItem('basemap'); } catch { /* сховище недоступне */ }
    // Сторінка, відкрита як файл (file://), не має адреси для Referer — OSM на такі запити віддає заглушку
    // «Access blocked». Тому в офлайн-файлі OSM недоступна і завжди показується схема.
    this.osmAllowed = location.protocol !== 'file:' || !window.BASEMAP;
    const want = !this.osmAllowed ? 'schema' : saved || (navigator.onLine === false ? 'schema' : 'osm');
    this.setBasemap(window.BASEMAP ? want : 'osm', false);
  }

  setBasemap(mode, remember = true) {
    this.baseMode = mode;
    if (remember) { try { localStorage.setItem('basemap', mode); } catch { /* немає сховища */ } }
    const schema = mode === 'schema';
    if (schema) {
      this.map.removeLayer(this.osm);
      if (!this.schemaBuilt) this.buildSchema();
      this.schema.addTo(this.map);
      this.syncCityLabels();
    } else {
      this.map.removeLayer(this.schema);
      this.osm.addTo(this.map);
    }
    this.el.classList.toggle('base-schema', schema);
    const attr = this.map.attributionControl;
    if (attr) {
      attr.removeAttribution(this.schemaTail);
      if (schema) attr.addAttribution(this.schemaTail);
    }
    const sel = this.el.parentElement?.querySelector('[data-base]');
    if (sel) sel.value = mode;
    const note = this.el.parentElement?.querySelector('.basenote');
    if (note) note.textContent = schema && this.autoSchema ? 'Немає зʼєднання з OpenStreetMap — показано схему без інтернету.' : '';
  }

  buildSchema() {
    const B = window.BASEMAP;
    this.schemaBuilt = true;
    const pane = (name, z) => { const p = this.map.createPane(name); p.style.zIndex = z; p.style.pointerEvents = 'none'; return name; };
    const r = L.canvas({ pane: pane('basemap', 150), padding: 0.3 });
    // Підписи міст — над хороплетом і знаками (маркери 600, підказки 650), щоб кластери й області їх не закривали
    pane('basemapLabels', 640);
    const ll = (pts) => pts.map(([lon, lat]) => [lat, lon]);
    const opt = { renderer: r, interactive: false, smoothFactor: 1 };
    B.land.forEach((poly) => L.polygon(poly.map(ll), { ...opt, stroke: false, fillColor: '#F3F0E6', fillOpacity: 1 }).addTo(this.schema));
    B.lakes.forEach((poly) => L.polygon(poly.map(ll), { ...opt, color: '#7FA8C4', weight: 0.6, fillColor: '#BFD6E6', fillOpacity: 1 }).addTo(this.schema));
    L.polyline(B.rivers.map(ll), { ...opt, color: '#7FA8C4', weight: 1.2 }).addTo(this.schema);
    L.polyline(B.borders.map(ll), { ...opt, color: '#6B5E7B', weight: 1.4, dashArray: '6 3 1.5 3' }).addTo(this.schema);
    // Міста: точка + підпис; дрібніші (більший rank) з'являються при наближенні
    this.cities = B.cities.map((c) => ({
      r: c.r,
      m: L.marker(c.ll, { pane: 'basemapLabels', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'city', iconSize: null,
          html: `<i class="${c.cap ? 'cap' : ''}"></i><span>${esc(c.n)}</span>` }) }),
    }));
    this.map.on('zoomend', () => this.syncCityLabels());
  }

  syncCityLabels() {
    if (!this.cities || this.baseMode !== 'schema') return;
    const z = this.map.getZoom();
    const maxRank = z < 6 ? 3 : z < 7 ? 4 : z < 8 ? 6 : z < 9 ? 7 : 8;
    this.cities.forEach(({ r, m }) => {
      const want = r <= maxRank, has = this.schema.hasLayer(m);
      if (want && !has) this.schema.addLayer(m);
      else if (!want && has) this.schema.removeLayer(m);
    });
  }

  // Додає/прибирає маркери ланок за порогом масштабу (min — у десятих, як класи mz-N)
  syncZoomMarkers(z = this.map.getZoom()) {
    const zz = z * 10, labels = z >= LABEL_ZOOM;
    this.zMarkers.forEach(({ m, min, group, bare, full }) => {
      const want = zz >= min;
      // один SVG на знак: без підписів на загальному виді, з ампліфікаторами — при наближенні
      const icon = labels ? full : bare;
      if (icon && m.options.icon !== icon && (want || !group.hasLayer(m))) m.setIcon(icon);
      if (want && !group.hasLayer(m)) group.addLayer(m);
      else if (!want && group.hasLayer(m)) group.removeLayer(m);
    });
  }

  clusterIcon(c, kind) {
    const n = c.getChildCount();
    const s = n < 10 ? 28 : n < 100 ? 34 : 40;
    return L.divIcon({ html: `<div class="cluster ${kind}" style="width:${s}px;height:${s}px">${n}</div>`,
      className: `mz-${EVENT_MIN_ZOOM}`, iconSize: [s, s] });
  }

  applyZoom(z) {
    const c = this.el;
    c.style.setProperty('--s', (sizeForZoom(z) / BASE).toFixed(3));
    THRESHOLDS.forEach((t) => c.classList.toggle(`zl-${t}`, z * 10 < t));
    c.classList.toggle('labels-on', z >= LABEL_ZOOM);
    const light = z >= 7;
    if (this.choroLight !== light) {
      this.choroLight = light;
      this.choroLayer?.setStyle({ fillOpacity: light ? 0.25 : 0.45 });
    }
    const zn = c.parentElement?.querySelector('.zoomnote');
    if (zn) zn.textContent = `Масштаб ${String(z).replace('.', ',')}: ${this.zoomHint(z)}`;
  }

  zoomHint(z) {
    if (z < 5.5) return 'лише області; наблизьте для знаків';
    if (z < 6.5) return "ОСУВ, ОТУ, армії й корпуси противника; події об'єднано в кластери";
    if (z < 7) return '+ бригади; дивізії противника';
    if (z < 8) return '+ полки';
    if (z < 8.5) return '+ батальйони; бригади й полки противника';
    if (z < 9) return '+ підписи знаків';
    if (z < 9.5) return '+ батальйони противника';
    return 'усі ланки, включно з ротами';
  }

  addHomeButton() {
    const Home = L.Control.extend({
      onAdd: () => {
        const b = L.DomUtil.create('button', 'btn sm');
        b.type = 'button';
        b.textContent = 'Вся Україна';
        b.style.background = '#fff';
        b.setAttribute('aria-label', 'Показати всю Україну');
        L.DomEvent.on(b, 'click', (e) => { L.DomEvent.stop(e); this.map.fitBounds(UA_BOUNDS); });
        return b;
      },
    });
    new Home({ position: 'topleft' }).addTo(this.map);
  }

  addPanel() {
    const p = document.createElement('div');
    p.className = 'map-panel';
    const names = { oblasts: 'Області (хороплет)', areas: 'Окупована і «сіра» зони', line: 'Лінія зіткнення',
      enemy: 'Підрозділи противника', units: 'Свої підрозділи (умовні)', impacts: 'Місця уражень (A)',
      artillery: 'Артилерійський вогонь (B)', cb: 'Контрбатарейна боротьба (B)', docs: 'Потоки документів ОКП (D)', alerts: 'Тривоги зараз' };
    p.innerHTML = `<fieldset><legend>Шари</legend>${Object.entries(names).map(([k, n]) =>
      `<label><input type="checkbox" data-layer="${k}" ${this.on[k] ? 'checked' : ''}> ${n}</label>`).join('')}</fieldset>
      <label style="display:block;margin-top:6px">Хороплет:
        <select data-choro aria-label="Метрика хороплета">
          <option value="air">Засоби повітряного нападу</option><option value="artillery">Постріли противника</option>
          <option value="alerts">Тривалість тривог</option><option value="losses">Втрати</option>
          <option value="docs">Документи від підрозділів</option></select></label>
      <label><input type="checkbox" data-mono> Монохромний (друк)</label>
      <label style="display:block;margin-top:6px">Підкладка:
        <select data-base aria-label="Підкладка карти">
          <option value="osm" ${this.osmAllowed ? '' : 'disabled'}>OpenStreetMap (інтернет${this.osmAllowed ? '' : '; лише через сервер'})</option>
          <option value="schema" ${window.BASEMAP ? '' : 'disabled'}>Схема (без інтернету)</option></select></label>
      <div class="basenote"></div>
      <div class="zoomnote"></div>`;
    L.DomEvent.disableClickPropagation(p);
    L.DomEvent.disableScrollPropagation(p);
    this.el.parentElement.appendChild(p);
    p.querySelectorAll('[data-layer]').forEach((cb) => cb.addEventListener('change', () => {
      const k = cb.dataset.layer;
      this.on[k] = cb.checked;
      if (cb.checked) this.g[k].addTo(this.map); else this.map.removeLayer(this.g[k]);
      this.renderLegend();
    }));
    const base = p.querySelector('[data-base]');
    base.value = this.baseMode;
    base.addEventListener('change', (e) => { this.autoSchema = false; this.setBasemap(e.target.value); });
    p.querySelector('[data-choro]').addEventListener('change', (e) => { this.choroModule = e.target.value; this.drawChoropleth(); });
    p.querySelector('[data-mono]').addEventListener('change', (e) => {
      this.mono = e.target.checked;
      this.redrawSymbols(); this.drawLine(); this.drawAreas();
    });
    this.applyZoom(this.map.getZoom());
  }

  async refresh() {
    const seq = (this.seq = (this.seq || 0) + 1);
    this.restyleSelection();   // виділення області змінюється одразу, не чекаючи даних
    const [units, impacts, art, cb, flows, alerts, line, enemy] = await Promise.all([
      get('map/units'), get('air/impacts'), get('artillery/geojson'), get('artillery/cb-geojson'), get('map/flows'),
      get('alerts/active', {}, { filters: false }), get('map/contact-line', {}, { filters: false }),
      get('map/enemy-units', {}, { filters: false }),
    ]);
    if (seq !== this.seq) return;   // за цей час фільтр змінився ще раз — застарілу відповідь не малюємо
    Object.assign(this, { geo: GEO.oblasts, units, impacts, art, cb, flows, alerts, line, enemy });
    await this.drawChoropleth();
    if (seq !== this.seq) return;
    this.drawAreas();
    this.drawAlerts();
    this.drawLine();
    this.redrawSymbols();
    this.drawFlows();
  }

  async drawChoropleth() {
    const ch = await get('map/choropleth', { module: this.choroModule });
    const vals = Object.fromEntries(ch.values.map((v) => [v.iso_code, v.value]));
    const sorted = ch.values.map((v) => v.value).filter((v) => v > 0).sort((a, b) => a - b);
    const q = [0.2, 0.4, 0.6, 0.8].map((p) => sorted[Math.floor(p * (sorted.length - 1))] ?? 0);
    const css = getComputedStyle(document.documentElement);
    const ramp = [1, 2, 3, 4, 5].map((i) => css.getPropertyValue(`--seq-${i}`).trim());
    const cls = (v) => (!v ? 0 : v <= q[0] ? 0 : v <= q[1] ? 1 : v <= q[2] ? 2 : v <= q[3] ? 3 : 4);
    this.choro = { label: ch.label, q, ramp };
    this.g.oblasts.clearLayers();
    this.choroLight = this.map.getZoom() >= 7;
    this.choroLayer = L.geoJSON(this.geo, {
      renderer: this.vec, smoothFactor: 1.5,
      style: (f) => ({ ...this.selStyle(f), fillColor: ramp[cls(vals[f.properties.iso])], fillOpacity: this.choroLight ? 0.25 : 0.45 }),
      onEachFeature: (f, layer) => {
        layer.bindTooltip(`${esc(f.properties.name_ua)}: ${num(vals[f.properties.iso], 1)} (${esc(ch.label)})`, { sticky: true });
        layer.on('click', (e) => {
          const ev = e.originalEvent || {};
          toggleOblast(f.properties.iso, ev.ctrlKey || ev.metaKey || ev.shiftKey);
        });
      },
    }).addTo(this.g.oblasts);
    this.choroLayer.bringToBack();   // області — найнижчий шар під зонами й лінією
    this.renderLegend();
  }

  selStyle(f) {
    const sel = state.oblast.includes(f.properties.iso);
    return { color: sel ? '#F39200' : '#4D4634', weight: sel ? 3 : 0.8 };
  }

  // Лише контур вибраних областей — без запиту даних
  restyleSelection() {
    this.choroLayer?.eachLayer((l) => {
      l.setStyle(this.selStyle(l.feature));
      if (state.oblast.includes(l.feature.properties.iso)) l.bringToFront();
    });
  }

  // Окупована та «сіра» зони — заливка поверх хороплета (власний знак, пояснено в легенді, п. 2.2.16)
  drawAreas() {
    this.g.areas.clearLayers();
    const asOf = GEO.deepstate?.as_of ?? '';
    const tip = (t) => `${t} — за даними DeepStateMap (deepstatemap.live), станом на ${asOf}`;
    GEO.occupied.forEach((poly) => L.polygon(poly.map(ring), {
      renderer: this.vec, smoothFactor: 1.5, stroke: false, fillColor: this.mono ? '#000' : RED, fillOpacity: this.mono ? 0.12 : 0.16, interactive: true,
    }).bindTooltip(esc(tip('Тимчасово окупована територія')), { sticky: true }).addTo(this.g.areas));
    GEO.grey.forEach((poly) => L.polygon(poly.map(ring), {
      renderer: this.vec, smoothFactor: 1.5, color: '#707276', weight: 0.5, fillColor: '#707276', fillOpacity: 0.3, interactive: true,
    }).bindTooltip(esc(tip('«Сіра» зона (неконтрольована)')), { sticky: true }).addTo(this.g.areas));
  }

  drawAlerts() {
    this.g.alerts.clearLayers();
    const active = new Map(this.alerts.map((a) => [a.iso_code, a]));
    L.geoJSON(this.geo, {
      renderer: this.vec, smoothFactor: 1.5,
      filter: (f) => active.has(f.properties.iso),
      style: { color: '#E52421', weight: 3, dashArray: '6 4', fill: false, interactive: true },
      onEachFeature: (f, layer) => {
        const a = active.get(f.properties.iso);
        layer.bindPopup(popup(`Тривога: ${f.properties.name_ua}`, [
          ['Тип', label('alert_type', a.alert_type)], ['Початок', dtg(a.started_at)], ['Стан', 'триває (на кінець даних)']]));
      },
    }).addTo(this.g.alerts);
  }

  // Лінія зіткнення (п. 6.2.1 Порядку): лінія своїх військ — синя з дугами в бік противника;
  // лінія противника — червона з дугами в бік своїх. Монохромно (п. 2.2.13): свої — одинарна, противник — подвійна.
  // Дуги будуються в пікселях поточного масштабу, тому перемальовуються після зміни зуму.
  drawLine() {
    if (!this.line) return;
    this.g.line.clearLayers();
    const m = this.map, z = m.getZoom();
    this.lineZoom = z;
    const R = { renderer: this.vec };
    const step = 9 + (z - 5) * 1.2;                // крок дуг, px
    const pt = (la, lo) => m.project([la, lo], z);
    const back = (p) => m.unproject(p, z);
    // Дуги вздовж усієї ламаної (крок у пікселях не залежить від густоти вершин)
    const scallop = (pts, toward) => {
      const cum = [0];
      for (let i = 1; i < pts.length; i += 1) cum.push(cum[i - 1] + pts[i - 1].distanceTo(pts[i]));
      const total = cum[cum.length - 1];
      let j = 0;
      const at = (s) => {
        while (j < pts.length - 2 && cum[j + 1] < s) j += 1;
        while (j > 0 && cum[j] > s) j -= 1;
        const a = pts[j], b = pts[j + 1], sl = (cum[j + 1] - cum[j]) || 1, t = (s - cum[j]) / sl;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, ux: (b.x - a.x) / sl, uy: (b.y - a.y) / sl, i: j };
      };
      const out = [];
      for (let s = 0; s + step <= total; s += step) {
        const c = at(s + step / 2);
        let nx = -c.uy, ny = c.ux;
        if (nx * toward[c.i].x + ny * toward[c.i].y < 0) { nx = -nx; ny = -ny; }
        for (let k = 0; k <= 4; k += 1) {
          const th = Math.PI * (k / 4);
          const p = at(s + step / 2 - Math.cos(th) * step / 2);
          const off = Math.sin(th) * step / 2.2;
          out.push(back(L.point(p.x + nx * off, p.y + ny * off)));
        }
      }
      return out;
    };
    const offset = (pts, d) => pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const len = a.distanceTo(b) || 1;
      return back(L.point(p.x - (b.y - a.y) / len * d, p.y + (b.x - a.x) / len * d));
    });
    const tip = `Лінія зіткнення за відкритими даними DeepStateMap, станом на ${this.line.as_of}. Не є офіційними даними.`;
    // Видима область + запас 60 % з кожного боку (у пікселях поточного масштабу)
    const pb = m.getPixelBounds(), padPx = pb.getSize().multiplyBy(0.6);
    const vis = L.bounds(pb.min.subtract(padPx), pb.max.add(padPx));
    this.lineBounds = vis;
    this.line.segments.forEach((seg) => {
      if (seg.length < 2) return;
      const ownAll = seg.map(([la, lo]) => pt(la, lo));
      const enAll = seg.map(([, , ela, elo]) => pt(ela, elo));
      // неперервні ділянки, що потрапляють у видиму область (з однією сусідньою вершиною для гладкості)
      const inside = ownAll.map((p, i) => vis.contains(p) || vis.contains(enAll[i]));
      const runs = [];
      let start = -1;
      inside.forEach((v, i) => {
        if (v && start < 0) start = Math.max(0, i - 1);
        if ((!v || i === inside.length - 1) && start >= 0) { runs.push([start, Math.min(inside.length, i + 2)]); start = -1; }
      });
      runs.forEach(([a, b]) => {
        const own = ownAll.slice(a, b), en = enAll.slice(a, b);
        if (own.length < 2) return;
        const dir = own.map((p, i) => L.point(en[i].x - p.x, en[i].y - p.y));
        const back2 = dir.map((d) => L.point(-d.x, -d.y));
        if (this.mono) {
          L.polyline(scallop(own, dir), { ...R, color: '#000', weight: 1.6, interactive: false }).addTo(this.g.line);
          L.polyline(offset(en, 2), { ...R, color: '#000', weight: 1.2, interactive: false }).addTo(this.g.line);
          L.polyline(offset(en, -2), { ...R, color: '#000', weight: 1.2, interactive: false }).addTo(this.g.line);
        } else {
          L.polyline(scallop(own, dir), { ...R, color: BLUE, weight: 2, interactive: false }).addTo(this.g.line);
          L.polyline(scallop(en, back2), { ...R, color: RED, weight: 2, interactive: false }).addTo(this.g.line);
        }
      });
      L.polyline(seg.map(([la, lo]) => [la, lo]), { ...R, opacity: 0, weight: 14 }).bindTooltip(esc(tip), { sticky: true }).addTo(this.g.line);
    });
  }

  // Потоки документів ОКП ієрархічно: кожне ребро — «підлеглий → старший» пункт управління,
  // вага — кількість документів, що пройшли ланкою. Видимість ребер — за тими ж порогами, що й знаки:
  // на загальному виді лише ОТУ → ОСУВ, при наближенні з'являються бригади, батальйони, роти.
  drawFlows() {
    this.g.docs.clearLayers();
    const edges = this.flows?.edges ?? [];
    if (!edges.length) return;
    const maxBy = {};
    edges.forEach((e) => { maxBy[e.level] = Math.max(maxBy[e.level] || 0, e.docs); });
    edges.forEach((e) => {
      const mz = `mz-${MIN_ZOOM_FLOW[e.level]}`;
      const w = 1.5 + 6 * Math.sqrt(e.docs / maxBy[e.level]) * (e.level === 1 ? 1.3 : 1);
      const col = this.mono ? '#000' : flowColor(e.overdue_pct);
      const a = [e.from_lat, e.from_lon], b = [e.to_lat, e.to_lon];
      const tip = `${esc(strip(e.from))} → ${esc(strip(e.to))}: ${num(e.docs)} док., прострочено ${num(e.overdue_pct, 1)} %`;
      L.polyline([a, b], { color: col, weight: w, opacity: 0.8, lineCap: 'round', className: mz })
        .bindTooltip(tip, { sticky: true }).addTo(this.g.docs);
      const pa = this.map.project(a, 0), pb = this.map.project(b, 0);
      const ang = Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI;
      const mid = [a[0] + (b[0] - a[0]) * 0.6, a[1] + (b[1] - a[1]) * 0.6];
      L.marker(mid, { interactive: false, keyboard: false,
        icon: L.divIcon({ className: `flow-arrow ${mz}`, iconSize: [0, 0],
          html: `<i style="color:${col};transform:rotate(${ang.toFixed(1)}deg)"></i>` }) }).addTo(this.g.docs);
    });
    (this.flows.posts || []).forEach((p) => {
      L.marker([p.lat, p.lon], { interactive: false, keyboard: false, zIndexOffset: 900,
        icon: L.divIcon({ className: `post-badge mz-${EVENT_MIN_ZOOM}`, iconSize: [0, 0],
          html: `<b>${num(p.docs)} док. · ${num(p.overdue_pct, 1)} %</b>` }) }).addTo(this.g.docs);
    });
  }

  redrawSymbols() {
    const mono = this.mono;
    // Свої підрозділи (без кластеризації — видимість керується ланкою і зумом)
    this.g.units.clearLayers();
    this.zMarkers = [];
    this.units.forEach((u) => {
      const cp = u.echelon === 'command' || u.echelon === 'corps';
      const amps = u.echelon === 'command'
        ? { uniqueDesignation: 'ОКП', higherFormation: strip(u.short_name) }
        : u.echelon === 'corps' ? { uniqueDesignation: strip(u.short_name), higherFormation: 'КП' }
          : { uniqueDesignation: strip(u.short_name).split('/')[0], higherFormation: strip(u.parent).replace(/\s*\(.*$/, '') };
      const common = { mono, readiness: cp ? null : u.readiness };
      let bare, full;
      if (cp) {
        // Пункт управління угруповання — власне креслення за п. 6.1 Порядку (milsymbol малює його інакше)
        const o = { mono, ...cpParts(u) };
        bare = renderCP({ ...o, text: false });
        full = renderCP(o);
      } else {
        bare = render(u.sidc, { ...common, text: false });
        full = render(u.sidc, { ...common, text: true, amps });
      }
      const mz = `mz-${MIN_ZOOM_ECHELON[u.echelon] ?? 80}`;
      const dim = u.selected ? '' : ' dim';
      const ib = L.divIcon({ className: 'sym-wrap', html: iconHtml(bare, `bare ${mz}${dim}`), iconSize: [0, 0] });
      const ifl = L.divIcon({ className: 'sym-wrap', html: iconHtml(full, `full ${mz}${dim}`), iconSize: [0, 0] });
      const m = L.marker([u.lat, u.lon], { icon: ib,
        title: u.short_name, keyboard: true, zIndexOffset: cp ? 800 : u.echelon === 'company' ? 0 : 500 });
      const losses = u.killed + u.wounded + u.missing;
      m.bindPopup(popup(u.name_ua, [
        ['Скорочено', u.short_name], ['Ланка', label('echelon', u.echelon)], ['Старший начальник', u.parent || '—'],
        ['Область', u.oblast_ua], ['Втрати за період', `${num(losses)} осіб (загиблі ${num(u.killed)}, поранені ${num(u.wounded)}, зниклі ${num(u.missing)})`],
        ['Боєздатність (AL)', cp ? undefined : READINESS[u.readiness]?.label],
        ['Походження', u.origin && u.origin !== 'synthetic' ? label('origin', u.origin) : undefined],
      ], '', 'Умовний підрозділ. Синтетичні дані. По навчанню.'));
      this.zMarkers.push({ m, min: MIN_ZOOM_ECHELON[u.echelon] ?? 80, group: this.g.units, bare: ib, full: ifl });
    });

    // Противник — відкриті дані DeepStateMap (координати без змін)
    this.g.enemy.clearLayers();
    (this.enemy?.rows ?? []).forEach((u) => {
      const amps = { uniqueDesignation: u.label };
      const bare = render(u.sidc, { mono, text: false });
      const full = render(u.sidc, { mono, text: true, amps });
      const mz = `mz-${MIN_ZOOM_ENEMY[u.echelon] ?? 80}`;
      const ib = L.divIcon({ className: 'sym-wrap', html: iconHtml(bare, `bare ${mz}`), iconSize: [0, 0] });
      const ifl = L.divIcon({ className: 'sym-wrap', html: iconHtml(full, `full ${mz}`), iconSize: [0, 0] });
      const m = L.marker([u.lat, u.lon], { icon: ib,
        title: u.label, keyboard: true, zIndexOffset: 400 });
      m.bindPopup(popup(u.name_ua, [['Скорочено', u.label], ['Ланка', label('echelon', u.echelon)],
        ['Джерело', `${u.source}, станом на ${u.as_of}`]], '', 'Відкриті дані (OSINT) DeepStateMap; не є офіційними даними.'));
      this.zMarkers.push({ m, min: MIN_ZOOM_ENEMY[u.echelon] ?? 80, group: this.g.enemy, bare: ib, full: ifl });
    });
    this.syncZoomMarkers();

    // Місця уражень: знак «Вибух, підрив» (п. 6.12) + підпис засобу (БпЛА, КрР, БалР, КАБ)
    this.g.impacts.clearLayers();
    this.impacts.features.forEach((f) => {
      const p = f.properties;
      const r = render(p.sidc, { mono, text: false, tag: p.map_label, unverified: isUnverified(p.reliability) });
      const m = L.marker([f.geometry.coordinates[1], f.geometry.coordinates[0]], {
        icon: L.divIcon({ className: 'sym-wrap', html: iconHtml(r, `mz-${EVENT_MIN_ZOOM}`), iconSize: [0, 0] }), title: `Ураження: ${p.weapon_name}` });
      m.bindPopup(popup(`Місце ураження: ${p.map_label}`, [
        ['Час', dtg(p.occurred_at)], ['Засіб', p.weapon_name], ['Область', p.oblast], ['Запущено', num(p.launched)],
        ['Влучань', num(p.hits)], ['Обʼєкт', p.target], ['Ступінь руйнувань', `${p.damage_level} з 3`],
        ['Джерело, достовірність', sourceText(p.info_source, p.reliability)],
        ['Походження', p.origin && p.origin !== 'synthetic' ? label('origin', p.origin) : undefined]]));
      this.g.impacts.addLayer(m);
    });

    // Артилерія: вогонь противника — знак його засобу на виявленій вогневій позиції (ромб, табл. 4, 16);
    // вогонь своїх засобів — знак цілі «Вогонь по одиночній цілі» (п. 6.2.2) синім, з позначкою результату (п. 2.2.12)
    this.g.artillery.clearLayers();
    this.art.features.forEach((f) => {
      const p = f.properties;
      const outgoing = p.direction === 'outgoing';
      const r = outgoing
        ? renderTarget({ mono, label: String(p.id % 10000), cross: crossForResult(p.result), unverified: isUnverified(p.reliability) })
        : render(p.sidc, { mono, text: false, unverified: isUnverified(p.reliability) });
      const m = L.marker([f.geometry.coordinates[1], f.geometry.coordinates[0]], {
        icon: L.divIcon({ className: 'sym-wrap', html: iconHtml(r, `mz-${EVENT_MIN_ZOOM}`), iconSize: [0, 0] }),
        title: label('system_type', p.system_type) });
      m.bindPopup(popup(outgoing ? `Ціль № ${p.id % 10000}: вогонь своїх засобів` : 'Вогнева позиція противника (виявлена)', [
        ['Час', dtg(p.occurred_at)], [outgoing ? 'Чим вражено' : 'Система', `${label('system_type', p.system_type)}, ${p.caliber_mm ?? '—'} мм (${label('caliber_class', p.caliber_class)})`],
        ['Пострілів', num(p.rounds)], ['Підрозділ', p.unit], ['Результат', label('result', p.result)], ['Область', p.oblast],
        ['Джерело, достовірність', sourceText(p.info_source, p.reliability)]]));
      this.g.artillery.addLayer(m);
    });

    // Контрбатарейна боротьба: виявлена позиція противника, підпис — засіб виявлення; позначка результату вогню у відповідь
    this.g.cb.clearLayers();
    (this.cb?.features ?? []).forEach((f) => {
      const p = f.properties;
      const r = render(p.sidc, { mono, text: false, tag: CB_TAG[p.detected_by], tagColor: '#000', cross: crossForResult(p.result), crossColor: BLUE,
        unverified: isUnverified(p.reliability) });
      const m = L.marker([f.geometry.coordinates[1], f.geometry.coordinates[0]], {
        icon: L.divIcon({ className: 'sym-wrap', html: iconHtml(r, `mz-${EVENT_MIN_ZOOM}`), iconSize: [0, 0] }),
        title: `Виявлена позиція: ${label('system_type', p.enemy_system)}` });
      m.bindPopup(popup('Виявлена вогнева позиція противника', [
        ['Виявлено', dtg(p.detected_at)], ['Засіб виявлення', label('detected_by', p.detected_by)],
        ['Система', `${label('system_type', p.enemy_system)}${p.caliber_mm ? `, ${p.caliber_mm} мм` : ''}`],
        ['Вогонь у відповідь', p.responded_at ? `${dtg(p.responded_at)}, ${p.unit ?? '—'}, ${num(p.rounds)} пострілів` : 'не відкривався'],
        ['Час реакції', p.reaction_min !== null && p.reaction_min !== undefined ? `${num(p.reaction_min)} хв` : undefined],
        ['Результат', label('result', p.result)], ['Область', p.oblast],
        ['Джерело, достовірність', sourceText(p.info_source, p.reliability)],
        ['Походження', p.origin && p.origin !== 'synthetic' ? label('origin', p.origin) : undefined]]));
      this.g.cb.addLayer(m);
    });
    this.drawFlows();
    this.renderLegend();
  }

  renderLegend() {
    if (!this.legendEl) return;
    const mono = this.mono;
    const rows = [];
    const sym = (sidc, o = {}) => render(sidc, { mono, size: 22, text: false, ...o }).svg;
    const ds = `DeepStateMap, станом на ${GEO.deepstate?.as_of ?? ''}`;
    if (this.on.units) {
      const cpSym = (sidc, name, parent) => renderCP({ mono, size: 18, ...cpParts({ sidc, short_name: name, parent }) }).svg;
      rows.push([cpSym('SFGPUH----AK---', 'ОСУВ'), 'Основний командний пункт (ОКП) оперативно-стратегічного угруповання військ: прапорець зі скороченням угруповання, флагшток спирається на точку розміщення (п. 6.1), ланка «XXXX» (табл. 8). Умовний']);
      rows.push([cpSym('SFGPUH----AJ---', 'ОТУ-1', 'ОСУВ'), 'ОКП оперативно-тактичного угруповання: ліворуч — найменування (номер), праворуч — підпорядкованість (п. 6.1), ланка «XXX». Умовний']);
      rows.push([sym('SFGPUCIZ---H---'), 'Своя механізована бригада; ланка — над знаком (табл. 8). Умовна, синтетична']);
      rows.push([Object.values(READINESS).map((r) => `<span style="display:inline-block;width:12px;height:8px;background:${r.color};border:1px solid #000;margin:1px"></span>`).join(''),
        'Смуга під знаком — боєздатність (поле AL): ' + Object.values(READINESS).map((r) => r.label).join(' / ')]);
    }
    if (this.on.enemy) rows.push([sym('SHGPUCIZ---H---'), `Підрозділ противника (механізована бригада). Положення — відкриті дані ${ds}`]);
    if (this.on.impacts) {
      rows.push([sym('OHVPE----------', { tag: 'КАБ' }), 'Місце ураження: знак «Вибух, підрив» (п. 6.12) з власним підписом засобу (п. 2.2.16)']);
      rows.push(['<b>БпЛА · КрР · БалР · КАБ</b>', 'Підписи: ударний БпЛА, крилата ракета, балістична ракета, керована авіабомба. Траєкторії не показуються — деталі у звітах модуля A']);
    }
    if (this.on.artillery) {
      rows.push([sym('SHGPEWHM-------'), 'Засіб вогневого ураження противника (гаубиця, середній калібр, табл. 16): виявлена вогнева позиція']);
      rows.push([renderTarget({ mono, size: 22, label: '401' }).svg, 'Вогонь своїх засобів по одиночній цілі з номером цілі (п. 6.2.2); синій — вогонь своєї артилерії (п. 2.2.2)']);
      rows.push([renderTarget({ mono, size: 22, cross: 'destroyed' }).svg, 'Ціль знищено: дві суцільні лінії (п. 2.2.12)']);
      rows.push([renderTarget({ mono, size: 22, cross: 'disabled' }).svg, 'Ціль виведено з ладу / подавлено: суцільна + пунктирна (п. 2.2.12)']);
    }
    if (this.on.cb) {
      rows.push([sym('SHGPEWHM-------', { tag: 'РЛР', tagColor: '#000', cross: 'disabled', crossColor: BLUE }), 'Контрбатарейна боротьба: виявлена вогнева позиція противника; підпис — джерело за п. 2.2.15 (РЛР — радіолокаційна, ПвР — повітряна, АР — артилерійська розвідка, С — спостереження); позначка — результат вогню у відповідь (п. 2.2.12)']);
    }
    if (this.on.impacts || this.on.artillery || this.on.cb) rows.push([sym('SHGPEWHM-------', { unverified: true }), '«?» — дані не перевірено (достовірність *4–*6, п. 2.2.15)']);
    if (mono) rows.push(['<b>ПТН</b>', 'Монохромний режим: противник позначається підписом «ПТН» або подвійною лінією (п. 2.2.13)']);
    if (this.on.line) {
      rows.push([mono
        ? '<svg width="48" height="16"><path d="M0 5 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0" fill="none" stroke="#000" stroke-width="1.6"/><line x1="0" y1="10" x2="48" y2="10" stroke="#000"/><line x1="0" y1="14" x2="48" y2="14" stroke="#000"/></svg>'
        : '<svg width="48" height="16"><path d="M0 6 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0" fill="none" stroke="#0057B7" stroke-width="2"/><path d="M0 10 q4 6 8 0 q4 6 8 0 q4 6 8 0 q4 6 8 0 q4 6 8 0 q4 6 8 0" fill="none" stroke="#D40000" stroke-width="2"/></svg>',
      `Лінія зіткнення (п. 6.2.1): синя — свої війська, червона — противник; дуги звернені до протилежної сторони. За даними ${ds}`]);
    }
    if (this.on.areas) {
      rows.push([`<span style="display:inline-block;width:40px;height:14px;background:${mono ? 'rgba(0,0,0,.12)' : 'rgba(212,0,0,.16)'};border:1px solid #999"></span>`,
        `Тимчасово окупована територія (власне позначення, п. 2.2.16). ${ds}`]);
      rows.push(['<span style="display:inline-block;width:40px;height:14px;background:rgba(112,114,118,.3);border:1px solid #707276"></span>', `«Сіра» зона. ${ds}`]);
    }
    if (this.on.docs) {
      rows.push([`<svg width="48" height="14"><line x1="2" y1="7" x2="38" y2="7" stroke="${SEA}" stroke-width="5" stroke-linecap="round"/><path d="M36 2 L46 7 L36 12 Z" fill="${SEA}"/></svg>`,
        'Потік документів «підлеглий → старший пункт управління»; товщина — обсяг (у межах ланки). На загальному виді — ОТУ → ОСУВ, при наближенні — бригади, батальйони, роти']);
      rows.push([[SEA, GOLD, RED].map((c) => `<span style="display:inline-block;width:14px;height:6px;background:${c};margin:1px"></span>`).join(''),
        'Частка прострочених: до 5 % / 5–10 % / понад 10 % (нормативи умовні); підпис біля ОКП — прийнято і прострочено']);
    }
    if (this.on.alerts) rows.push(['<svg width="48" height="10"><line x1="0" y1="5" x2="48" y2="5" stroke="#E52421" stroke-width="3" stroke-dasharray="6 4"/></svg>', 'Область з тривогою, що триває']);
    if (this.on.oblasts && this.choro) {
      const { q, ramp } = this.choro;
      rows.push([ramp.map((c) => `<span style="display:inline-block;width:12px;height:12px;background:${c};border:1px solid #999"></span>`).join(''),
        `${this.choro.label}: ≤${num(q[0])} … >${num(q[3])}`]);
    }
    this.legendEl.innerHTML = `<table class="t map-legend"><caption><b>УМОВНІ ПОЗНАЧЕННЯ</b></caption>
      <thead><tr><th>Знак</th><th>Зміст знака</th></tr></thead><tbody>${
  rows.map(([s, t]) => `<tr><td class="sym-cell">${s}</td><td>${esc(t)}</td></tr>`).join('')}</tbody></table>`;
  }

  invalidate() { this.map.invalidateSize(); }
}

return { MapView };
})();
// ---- charts/common.js ----
__M["charts/common.js"] = (function () {
// Спільне для графіків: картка за чеклістом §10.6 ТЗ (назва, підзаголовок з періодом і фільтрами,
// підпис джерела, «Показати таблицю», експорт PNG/CSV, aria-label), кольори з токенів, формати uk-UA.
/* global Chart */
const { state, filterCaption } = __M["state.js"];
const { d, dtg, esc, num, NO_DATA } = __M["format.js"];
const charts = new Map();

function color(token) {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

const PAL = {
  weapon: { uav_attack: '--c-gold', cruise_missile: '--c-storm', ballistic_missile: '--c-marun', guided_bomb: '--c-step' },
  system: { mortar: '--c-step', howitzer: '--c-storm', gun: '--c-steel', mlrs: '--c-sea', tank: '--c-olive' },
  direction: { incoming: '--c-marun', outgoing: '--c-sea' },
  loss: { killed: '--c-marun', wounded: '--c-gold', missing: '--c-steel' },
  urgency: { horizon: '--c-red', efir: '--c-gold', buran: '--c-storm', zlit: '--c-sea', none: '--c-steel' },
};

function periodText() {
  return `${d(state.date_from)} – ${d(state.date_to)}`;
}

function sourceText() {
  const m = state.meta;
  return `Джерело: синтетичні дані (генератор v${m?.generator_version ?? '—'}), станом на ${dtg(m?.data_as_of)}. По навчанню.`;
}

/** Створює картку графіка всередині container. */
function card(container, { id, title, sub = '', wide = false, size = '', html = false }) {
  const el = document.createElement('article');
  el.className = `card${wide ? ' wide' : ''}`;
  el.id = `card-${id}`;
  const subText = [sub, periodText(), filterCaption()].filter(Boolean).join(' · ');
  el.innerHTML = `
    <header><div class="titles"><h3 class="chart-title" id="t-${id}">${esc(title)}</h3>
      <p class="chart-sub">${esc(subText)}</p></div>
      <div class="tools">
        <button type="button" class="btn sm" data-act="table" aria-pressed="false" aria-controls="tbl-${id}">Таблиця</button>
        ${html ? '' : '<button type="button" class="btn sm" data-act="png">PNG</button>'}
        <button type="button" class="btn sm" data-act="csv">CSV</button>
      </div></header>
    ${html ? `<div class="chart-html" role="img" aria-labelledby="t-${id}"></div>`
    : `<div class="chart-box ${size}"><canvas role="img" aria-label="${esc(title)}"></canvas></div>`}
    <div class="chart-table" id="tbl-${id}"></div>
    <p class="chart-source">${esc(sourceText())}</p>`;
  container.appendChild(el);
  const api = {
    el, id, title,
    canvas: el.querySelector('canvas'),
    htmlBox: el.querySelector('.chart-html'),
    table: { columns: [], rows: [] },
    setTable(columns, rows) {
      api.table = { columns, rows };
      el.querySelector('.chart-table').innerHTML = tableHtml(title, columns, rows);
    },
    chart(config, canvas = api.canvas, suffix = '') {
      charts.get(id + suffix)?.destroy();
      const c = new Chart(canvas, config);
      charts.set(id + suffix, c);
      return c;
    },
    empty(msg = 'Немає даних за обраний період і фільтри.') {
      const box = el.querySelector('.chart-box, .chart-html');
      box.innerHTML = `<div class="empty">${esc(msg)}</div>`;
    },
  };
  el.querySelector('[data-act="table"]').addEventListener('click', (e) => {
    const on = el.classList.toggle('show-table');
    e.currentTarget.setAttribute('aria-pressed', String(on));
  });
  el.querySelector('[data-act="png"]')?.addEventListener('click', () => downloadPng(api));
  el.querySelector('[data-act="csv"]').addEventListener('click', () => downloadCsv(api));
  return api;
}

function destroyAll() { charts.forEach((c) => c.destroy()); charts.clear(); }

function tableHtml(title, columns, rows, n = null) {
  const head = ['№ з/п', ...columns.map((c) => c.title)].map((t) => `<th scope="col">${esc(t)}</th>`).join('');
  const body = rows.map((r, i) => `<tr><td class="n">${i + 1}</td>${columns.map((c) => {
    const v = r[c.key];
    const txt = v === null || v === undefined || v === '' ? NO_DATA : (c.fmt ? c.fmt(v, r) : v);
    return `<td class="${typeof v === 'number' ? 'n' : ''}">${esc(txt)}</td>`;
  }).join('')}</tr>`).join('');
  const cap = n ? `<span class="num">Таблиця ${n}</span>` : '';
  return `<table class="t"><caption>${cap}${esc(title)}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function downloadPng(api) {
  const src = api.canvas;
  const c = document.createElement('canvas');
  const pad = 48;
  c.width = src.width; c.height = src.height + pad * 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color('--surface') || '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = color('--text');
  ctx.font = `${Math.round(18 * devicePixelRatio)}px Volja, sans-serif`;
  ctx.fillText(api.title, 8, 28);
  ctx.drawImage(src, 0, pad);
  ctx.font = `${Math.round(11 * devicePixelRatio)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = color('--text-muted');
  ctx.fillText(`${periodText()} · ${sourceText()}`, 8, c.height - 14);
  const a = document.createElement('a');
  a.download = `${api.id}.png`;
  a.href = c.toDataURL('image/png');
  a.click();
}

function downloadCsv(api) {
  const { columns, rows } = api.table;
  const q = (v) => `"${String(v ?? NO_DATA).replace(/"/g, '""')}"`;
  const lines = [q(`${api.title}, ${periodText()}. Синтетичні дані. По навчанню.`),
    ['№ з/п', ...columns.map((c) => c.title)].map(q).join(';'),
    ...rows.map((r, i) => [i + 1, ...columns.map((c) => (c.fmt ? c.fmt(r[c.key], r) : r[c.key]))].map(q).join(';'))];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.download = `${api.id}.csv`;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- Опції Chart.js ----

function axisTitle(text) { return { display: !!text, text, font: { size: 12 } }; }

function baseOptions({ yTitle = '', xTitle = '', stacked = false, horizontal = false, legend = true, unit = '' } = {}) {
  const valueAxis = {
    beginAtZero: true, stacked, title: axisTitle(yTitle),
    grid: { color: color('--grid') }, border: { display: false },
    ticks: { callback: (v) => num(v, 1), precision: 0 },
  };
  const catAxis = { stacked, title: axisTitle(xTitle), grid: { display: false }, ticks: { autoSkip: true, maxRotation: 0 } };
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
    indexAxis: horizontal ? 'y' : 'x',
    interaction: { mode: horizontal ? 'nearest' : 'index', intersect: false, axis: horizontal ? 'y' : 'x' },
    scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
    plugins: {
      legend: { display: legend, position: 'bottom', labels: { boxWidth: 12, boxHeight: 12, useBorderRadius: true, borderRadius: 2 } },
      tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${num(ctx.parsed[horizontal ? 'x' : 'y'], 1)}${unit ? ` ${unit}` : ''}` } },
    },
  };
}

// Стовпчики: тонкі, заокруглений лише «кінець» верхнього сегмента, 1 px проміжок кольором поверхні між сегментами
function barDataset(label, data, token, { last = true, extra = {} } = {}) {
  return {
    label, data, backgroundColor: color(token), borderColor: color('--surface'), borderWidth: 1,
    borderRadius: last ? 4 : 0, borderSkipped: 'start', maxBarThickness: 28, categoryPercentage: 0.8, barPercentage: 0.9, ...extra,
  };
}

function lineDataset(label, data, token, extra = {}) {
  return { type: 'line', label, data, borderColor: color(token), backgroundColor: color(token), borderWidth: 2,
    pointRadius: 0, pointHoverRadius: 4, tension: 0.2, spanGaps: false, ...extra };
}

// Позначки подій (масовані атаки тощо) над віссю X
const markersPlugin = {
  id: 'markers',
  afterDatasetsDraw(chart, _args, opts) {
    const idx = opts?.indices || [];
    if (!idx.length) return;
    const { ctx, chartArea, scales } = chart;
    ctx.save();
    ctx.fillStyle = color('--text');
    ctx.strokeStyle = color('--text-muted');
    ctx.setLineDash([3, 3]);
    idx.forEach((i) => {
      const x = scales.x.getPixelForValue(i);
      ctx.beginPath(); ctx.moveTo(x, chartArea.top + 10); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 4, chartArea.top); ctx.lineTo(x + 4, chartArea.top); ctx.lineTo(x, chartArea.top + 7);
      ctx.closePath(); ctx.fill();
    });
    ctx.restore();
  },
};

// Вертикальна референтна лінія (норматив, поріг) на горизонтальному графіку
const refLinePlugin = {
  id: 'refline',
  afterDatasetsDraw(chart, _args, opts) {
    if (opts?.value === undefined) return;
    const { ctx, chartArea, scales } = chart;
    const horizontal = chart.options.indexAxis === 'y';
    ctx.save();
    ctx.strokeStyle = color('--text');
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    if (horizontal) {
      const x = scales.x.getPixelForValue(opts.value);
      ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom);
    } else {
      const y = scales.y.getPixelForValue(opts.value);
      ctx.moveTo(chartArea.left, y); ctx.lineTo(chartArea.right, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color('--text');
    ctx.font = '12px Volja, "Segoe UI", sans-serif';
    if (horizontal) ctx.fillText(opts.label || '', scales.x.getPixelForValue(opts.value) + 4, chartArea.top + 12);
    else ctx.fillText(opts.label || '', chartArea.right - ctx.measureText(opts.label || '').width - 4, scales.y.getPixelForValue(opts.value) - 6);
    ctx.restore();
  },
};

function periodLabel(p, bucket) {
  const [, m, dd] = p.split('-');  // рік видно в підзаголовку графіка
  return bucket === 'week' ? `тиж. ${dd}.${m}` : `${dd}.${m}`;
}

function bucketText(b) { return b === 'week' ? 'по тижнях' : 'по днях'; }

return { color, PAL, periodText, sourceText, card, destroyAll, tableHtml, axisTitle, baseOptions, barDataset, lineDataset, markersPlugin, refLinePlugin, periodLabel, bucketText };
})();
// ---- charts/air.js ----
__M["charts/air.js"] = (function () {
// Модуль A: A1–A4
const { get } = __M["api.js"];
const { num, dtg } = __M["format.js"];
const { PAL, card, baseOptions, barDataset, lineDataset, markersPlugin, periodLabel, bucketText } = __M["charts/common.js"];
async function renderA1(root) {
  const data = await get('air/timeline');
  const c = card(root, { id: 'a1', title: 'Динаміка застосування засобів повітряного нападу за типами',
    sub: `${bucketText(data.bucket)}, од.; ▼ — масована атака`, wide: true });
  const periods = [...new Set(data.rows.map((r) => r.period))];
  const weapons = [...new Map(data.rows.map((r) => [r.weapon, r])).values()];
  if (!data.rows.some((r) => r.launched)) return c.empty();
  const byKey = new Map(data.rows.map((r) => [`${r.period}|${r.weapon}`, r]));
  const waveIdx = [...new Set(data.waves.map((w) => {
    const day = w.started_at.slice(0, 10);
    return periods.findIndex((p, i) => p <= day && (periods[i + 1] ?? '9999') > day);
  }).filter((i) => i >= 0))];
  c.chart({
    type: 'bar',
    data: {
      labels: periods.map((p) => periodLabel(p, data.bucket)),
      datasets: weapons.map((w, i) => barDataset(w.name_ua, periods.map((p) => byKey.get(`${p}|${w.weapon}`)?.launched ?? 0),
        PAL.weapon[w.weapon], { last: i === weapons.length - 1 })),
    },
    options: { ...baseOptions({ stacked: true, yTitle: 'Запущено, од.', unit: 'од.' }),
      plugins: { ...baseOptions({ unit: 'од.' }).plugins, markers: { indices: waveIdx } } },
    plugins: [markersPlugin],
  });
  c.setTable([{ key: 'period', title: 'Період' }, ...weapons.map((w) => ({ key: w.weapon, title: `${w.name_ua}, од.` }))],
    periods.map((p) => ({ period: periodLabel(p, data.bucket), ...Object.fromEntries(weapons.map((w) => [w.weapon, byKey.get(`${p}|${w.weapon}`)?.launched ?? 0])) })));
  if (data.waves.length) {
    c.el.querySelector('.chart-sub').textContent += ` · масованих атак: ${data.waves.length} (остання ${dtg(data.waves.at(-1).started_at)})`;
  }
}

// A2: дві панелі зі спільною віссю часу замість другої осі Y (одна шкала на графік)
async function renderA2(root) {
  const data = await get('air/intercept-rate');
  const c = card(root, { id: 'a2', title: 'Запущено і знешкоджено засобів повітряного нападу, частка знешкоджених',
    sub: `${bucketText(data.bucket)}; без КАБ; знешкоджено = збито + подавлено РЕБ`, wide: true, size: 'tall' });
  if (!data.rows.some((r) => r.launched)) return c.empty();
  const labels = data.rows.map((r) => periodLabel(r.period, data.bucket));
  const box = c.el.querySelector('.chart-box');
  box.style.height = 'auto';
  box.innerHTML = `<div style="position:relative;height:250px"><canvas role="img" aria-label="Запущено і знешкоджено, од."></canvas></div>
    <div style="position:relative;height:150px;margin-top:8px"><canvas role="img" aria-label="Частка знешкоджених, %"></canvas></div>`;
  const [cv1, cv2] = box.querySelectorAll('canvas');
  c.canvas = cv1;
  c.chart({
    type: 'bar',
    data: { labels, datasets: [
      barDataset('Запущено', data.rows.map((r) => r.launched), '--c-steel'),
      barDataset('Знешкоджено', data.rows.map((r) => r.intercepted + r.suppressed), '--c-sea'),
    ] },
    options: baseOptions({ yTitle: 'од.', unit: 'од.' }),
  });
  // друга панель — окремий графік зі своєю шкалою %, а не друга вісь Y
  const rateOpts = baseOptions({ yTitle: '%', unit: '%', legend: false });
  rateOpts.scales.y.max = 100;
  c.chart({
    type: 'line',
    data: { labels, datasets: [lineDataset('Частка знешкоджених', data.rows.map((r) => r.rate), '--c-sea', { pointRadius: 2 })] },
    options: rateOpts,
  }, cv2, '-rate');
  c.setTable([{ key: 'p', title: 'Період' }, { key: 'l', title: 'Запущено, од.' }, { key: 'i', title: 'Знешкоджено, од.' },
    { key: 'r', title: 'Частка знешкоджених, %', fmt: (v) => num(v, 1) }],
  data.rows.map((r) => ({ p: periodLabel(r.period, data.bucket), l: r.launched, i: r.intercepted + r.suppressed, r: r.rate })));
}

async function renderA3(root) {
  const rows = (await get('air/by-oblast')).filter((r) => r.launched > 0).slice(0, 10);
  const c = card(root, { id: 'a3', title: 'Області з найбільшою кількістю засобів повітряного нападу', sub: 'топ-10, од.' });
  if (!rows.length) return c.empty();
  c.chart({
    type: 'bar',
    data: { labels: rows.map((r) => r.name_ua), datasets: [barDataset('Запущено', rows.map((r) => r.launched), '--c-gold')] },
    options: baseOptions({ horizontal: true, legend: false, yTitle: 'од.', unit: 'од.' }),
  });
  c.setTable([{ key: 'name_ua', title: 'Область' }, { key: 'launched', title: 'Запущено, од.' },
    { key: 'intercepted', title: 'Збито, од.' }, { key: 'hits', title: 'Влучання, од.' }], rows);
}

async function renderA4(root) {
  const rows = (await get('alerts/stats')).slice(0, 15);
  const c = card(root, { id: 'a4', title: 'Тривалість тривог за областями', sub: 'топ-15, год (у межах періоду)' });
  if (!rows.length) return c.empty();
  c.chart({
    type: 'bar',
    data: { labels: rows.map((r) => r.name_ua), datasets: [barDataset('Тривалість', rows.map((r) => Number(r.hours)), '--c-steel')] },
    options: baseOptions({ horizontal: true, legend: false, yTitle: 'год', unit: 'год' }),
  });
  c.setTable([{ key: 'name_ua', title: 'Область' }, { key: 'alerts', title: 'Кількість тривог' },
    { key: 'hours', title: 'Тривалість, год', fmt: (v) => num(v, 1) }], rows);
}

return { renderA1, renderA2, renderA3, renderA4 };
})();
// ---- charts/artillery.js ----
__M["charts/artillery.js"] = (function () {
// Модуль B: B1–B7
const { get } = __M["api.js"];
const { label } = __M["state.js"];
const { num } = __M["format.js"];
const { PAL, card, baseOptions, barDataset, periodLabel, bucketText, color, refLinePlugin } = __M["charts/common.js"];
// B1: дзеркальні стовпчики — вихідний вогонь угору, вхідний униз
async function renderB1(root) {
  const data = await get('artillery/timeline');
  const c = card(root, { id: 'b1', title: 'Обстріли: вогонь противника і вогонь своїх засобів',
    sub: `${bucketText(data.bucket)}, кількість обстрілів; вогонь противника — униз від нуля`, wide: true });
  if (!data.rows.some((r) => r.shellings)) return c.empty();
  const periods = [...new Set(data.rows.map((r) => r.period))];
  const get_ = (p, dir) => data.rows.find((r) => r.period === p && r.direction === dir)?.shellings ?? 0;
  const opts = baseOptions({ stacked: true, yTitle: 'обстрілів', unit: 'обстрілів' });
  opts.scales.y.ticks.callback = (v) => num(Math.abs(v));
  opts.plugins.tooltip.callbacks.label = (ctx) => `${ctx.dataset.label}: ${num(Math.abs(ctx.parsed.y))} обстрілів`;
  c.chart({
    type: 'bar',
    data: { labels: periods.map((p) => periodLabel(p, data.bucket)), datasets: [
      barDataset(label('direction', 'outgoing'), periods.map((p) => get_(p, 'outgoing')), PAL.direction.outgoing),
      barDataset(label('direction', 'incoming'), periods.map((p) => -get_(p, 'incoming')), PAL.direction.incoming),
    ] },
    options: opts,
  });
  c.setTable([{ key: 'p', title: 'Період' }, { key: 'o', title: 'Вогонь своїх засобів, обстрілів' },
    { key: 'i', title: 'Вогонь противника, обстрілів' }],
  periods.map((p) => ({ p: periodLabel(p, data.bucket), o: get_(p, 'outgoing'), i: get_(p, 'incoming') })));
}

async function renderB2(root) {
  const rows = await get('artillery/by-system');
  const c = card(root, { id: 'b2', title: 'Кількість пострілів за типами систем', sub: 'пострілів', wide: true });
  if (!rows.length) return c.empty();
  const systems = ['mortar', 'howitzer', 'gun', 'mlrs', 'tank'];
  const v = (s, d) => rows.find((r) => r.system_type === s && r.direction === d)?.rounds ?? 0;
  systems.sort((a, b) => (v(b, 'incoming') + v(b, 'outgoing')) - (v(a, 'incoming') + v(a, 'outgoing')));
  c.chart({
    type: 'bar',
    data: { labels: systems.map((s) => label('system_type', s)), datasets: [
      barDataset(label('direction', 'incoming'), systems.map((s) => v(s, 'incoming')), PAL.direction.incoming),
      barDataset(label('direction', 'outgoing'), systems.map((s) => v(s, 'outgoing')), PAL.direction.outgoing),
    ] },
    options: baseOptions({ horizontal: true, yTitle: 'пострілів', unit: 'пострілів' }),
  });
  c.setTable([{ key: 's', title: 'Система' }, { key: 'i', title: 'Вогонь противника, пострілів' },
    { key: 'o', title: 'Вогонь своїх засобів, пострілів' }],
  systems.map((s) => ({ s: label('system_type', s), i: v(s, 'incoming'), o: v(s, 'outgoing') })));
}

// B3: теплокарта 24×7 (HTML-сітка: послідовна шкала одного тону)
async function renderB3(root) {
  const rows = await get('artillery/heatmap');
  const c = card(root, { id: 'b3', title: 'Вогонь противника за годинами доби і днями тижня',
    sub: 'кількість обстрілів; київський час', wide: true, html: true });
  const max = Math.max(1, ...rows.map((r) => r.shellings));
  const ramp = [1, 2, 3, 4, 5].map((i) => color(`--seq-${i}`));
  const step = (v) => (v === 0 ? ramp[0] : ramp[Math.min(4, 1 + Math.floor((v / max) * 3.999))]);
  const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
  let html = '<div class="heat"><div></div>';
  for (let h = 0; h < 24; h += 1) html += `<div class="lbl">${h % 3 === 0 ? String(h).padStart(2, '0') : ''}</div>`;
  for (let wd = 1; wd <= 7; wd += 1) {
    html += `<div class="lbl">${days[wd - 1]}</div>`;
    for (let h = 0; h < 24; h += 1) {
      const r = rows.find((x) => x.weekday === wd && x.hour === h);
      html += `<div class="c" style="background:${step(r.shellings)}" title="${days[wd - 1]}, ${String(h).padStart(2, '0')}.00–${String(h).padStart(2, '0')}.59: ${num(r.shellings)} обстрілів, ${num(r.rounds)} пострілів"></div>`;
    }
  }
  html += '</div><div class="heat-legend">менше'
    + ramp.map((col) => `<span class="sw" style="background:${col}"></span>`).join('') + `більше (макс. ${num(max)} обстрілів)</div>`;
  c.htmlBox.innerHTML = html;
  c.setTable([{ key: 'd', title: 'День тижня' }, { key: 'h', title: 'Година' }, { key: 's', title: 'Обстрілів' }, { key: 'r', title: 'Пострілів' }],
    rows.map((r) => ({ d: days[r.weekday - 1], h: `${String(r.hour).padStart(2, '0')}.00`, s: r.shellings, r: r.rounds })));
}

const MIN_DAYS = 5;   // мінімальний запас боєприпасів, діб вогню (умовний норматив)
const one = (x) => (x === null || x === undefined ? null : num(x, 1));

// B4: запас боєприпасів у добах вогню — один ряд, колір стовпчика за станом (червоний — менше 3 діб)
async function renderB4(root) {
  const rows = await get('artillery/ammo');
  const c = card(root, { id: 'b4', title: 'Запас боєприпасів у добах вогню на кінець періоду',
    sub: `залишок ÷ середньодобова витрата за останні 7 діб; пунктир — мінімальний запас ${MIN_DAYS} діб (умовний); червоний — менше 3 діб` });
  if (!rows.length) return c.empty();
  const shown = rows.filter((r) => r.days_of_fire !== null);
  const col = (v) => color(v < 3 ? '--c-red' : v < MIN_DAYS ? '--c-gold' : '--c-sea');
  const opts = baseOptions({ horizontal: true, legend: false, yTitle: 'діб вогню', unit: 'діб' });
  opts.plugins.refline = { value: MIN_DAYS, label: `мін. ${MIN_DAYS} діб` };
  c.chart({
    type: 'bar',
    data: { labels: shown.map((r) => label('ammo_type', r.ammo_type)),
      datasets: [barDataset('Запас', shown.map((r) => r.days_of_fire), '--c-sea', { extra: { backgroundColor: shown.map((r) => col(r.days_of_fire)) } })] },
    options: opts,
    plugins: [refLinePlugin],
  });
  c.setTable([{ key: 'a', title: 'Вид боєприпасів' }, { key: 'expended', title: 'Витрачено за період, шт.' },
    { key: 'received', title: 'Надійшло за період, шт.' }, { key: 'stock', title: 'Залишок, шт.' },
    { key: 'avg_daily', title: 'Середньодобова витрата, шт.', fmt: one }, { key: 'days_of_fire', title: 'Запас, діб вогню', fmt: one }],
  rows.map((r) => ({ a: label('ammo_type', r.ammo_type), ...r })));
}

// B5: витрата боєприпасів за родами (складені стовпчики)
async function renderB5(root) {
  const data = await get('artillery/ammo-timeline');
  const c = card(root, { id: 'b5', title: 'Витрата боєприпасів артилерійськими підрозділами',
    sub: `${bucketText(data.bucket)}, штук (пострілів)`, wide: true });
  if (!data.rows.some((r) => r.expended)) return c.empty();
  const fams = ['mortar', 'howitzer', 'mlrs'];
  const periods = [...new Set(data.rows.map((r) => r.period))];
  const v = (p, fm) => data.rows.find((r) => r.period === p && r.family === fm)?.expended ?? 0;
  c.chart({
    type: 'bar',
    data: { labels: periods.map((p) => periodLabel(p, data.bucket)),
      datasets: fams.map((fm, i) => barDataset(label('ammo_family', fm), periods.map((p) => v(p, fm)), PAL.system[fm], { last: i === fams.length - 1 })) },
    options: baseOptions({ stacked: true, yTitle: 'шт.', unit: 'шт.' }),
  });
  c.setTable([{ key: 'p', title: 'Період' }, ...fams.map((fm) => ({ key: fm, title: `${label('ammo_family', fm)}, шт.` }))],
    periods.map((p) => ({ p: periodLabel(p, data.bucket), ...Object.fromEntries(fams.map((fm) => [fm, v(p, fm)])) })));
}

// B6: контрбатарейна боротьба — результат за засобами виявлення
const CB_RES = [['destroyed', '--c-sea'], ['damaged', '--c-storm'], ['suppressed', '--c-steel'], ['no_effect', '--c-step'],
  ['unknown', '--c-olive'], ['no_response', '--c-marun']];
async function renderB6(root) {
  const rows = await get('artillery/counter-battery');
  const c = card(root, { id: 'b6', title: 'Контрбатарейна боротьба: виявлені позиції противника і результат',
    sub: 'кількість виявлених вогневих позицій за засобом виявлення; у підписі — медіана часу реакції', wide: true });
  if (!rows.some((r) => r.detected)) return c.empty();
  const labels = rows.map((r) => `${label('detected_by', r.detected_by)}${r.median_min !== null ? ` (${num(r.median_min, 1)} хв)` : ''}`);
  c.chart({
    type: 'bar',
    data: { labels, datasets: CB_RES.map(([k, tok], i) => barDataset(label('result', k), rows.map((r) => r[k]), tok, { last: i === CB_RES.length - 1 })) },
    options: baseOptions({ horizontal: true, stacked: true, yTitle: 'позицій', unit: 'позицій' }),
  });
  c.setTable([{ key: 'm', title: 'Засіб виявлення' }, { key: 'detected', title: 'Виявлено позицій' }, { key: 'responded', title: 'Відкрито вогонь' },
    { key: 'response_pct', title: 'Частка відповідей, %', fmt: one }, { key: 'median_min', title: 'Медіана часу реакції, хв', fmt: one },
    ...CB_RES.map(([k]) => ({ key: k, title: label('result', k) }))],
  rows.map((r) => ({ m: label('detected_by', r.detected_by), ...r })));
}

// B7: стан артилерійського озброєння за зразками
async function renderB7(root) {
  const rows = await get('artillery/equipment');
  const c = card(root, { id: 'b7', title: 'Стан артилерійського озброєння за зразками',
    sub: 'одиниць; за останнім щотижневим донесенням у періоді' });
  if (!rows.length) return c.empty();
  const lab = rows.map((r) => `${r.model}${r.caliber_mm ? `, ${r.caliber_mm} мм` : ''}`);
  c.chart({
    type: 'bar',
    data: { labels: lab, datasets: [
      barDataset('Справні', rows.map((r) => r.operational), '--c-sea', { last: false }),
      barDataset('У ремонті', rows.map((r) => r.in_repair), '--c-gold'),
    ] },
    options: baseOptions({ horizontal: true, stacked: true, yTitle: 'од.', unit: 'од.' }),
  });
  c.setTable([{ key: 'm', title: 'Зразок' }, { key: 's', title: 'Тип системи' }, { key: 'total', title: 'У наявності, од.' },
    { key: 'operational', title: 'Справні, од.' }, { key: 'in_repair', title: 'У ремонті, од.' },
    { key: 'lost', title: 'Втрачено за період, од.' }, { key: 'ready_pct', title: 'Справних, %', fmt: one }],
  rows.map((r, i) => ({ m: lab[i], s: label('system_type', r.system_type), ...r })));
}

return { renderB1, renderB2, renderB3, renderB4, renderB5, renderB6, renderB7 };
})();
// ---- charts/losses.js ----
__M["charts/losses.js"] = (function () {
// Модуль C: C1–C5 (лише агрегати)
const { get } = __M["api.js"];
const { label } = __M["state.js"];
const { d, num } = __M["format.js"];
const { PAL, card, baseOptions, barDataset, lineDataset, periodLabel, color, refLinePlugin } = __M["charts/common.js"];
const KINDS = [['killed', 'Безповоротні (загиблі)'], ['wounded', 'Санітарні (поранені)'], ['missing', 'Зниклі безвісти']];

async function renderC1(root) {
  const data = await get('losses/timeline');
  const c = card(root, { id: 'c1', title: 'Втрати особового складу по тижнях', sub: 'осіб; перший і останній тижні можуть бути неповними', wide: true });
  if (!data.rows.some((r) => r.killed + r.wounded + r.missing)) return c.empty();
  c.chart({
    type: 'bar',
    data: { labels: data.rows.map((r) => periodLabel(r.period, 'week')),
      datasets: KINDS.map(([k, n], i) => barDataset(n, data.rows.map((r) => r[k]), PAL.loss[k], { last: i === KINDS.length - 1 })) },
    options: baseOptions({ stacked: true, yTitle: 'осіб', unit: 'осіб' }),
  });
  c.setTable([{ key: 'p', title: 'Тиждень з' }, ...KINDS.map(([k, n]) => ({ key: k, title: `${n}, осіб` }))],
    data.rows.map((r) => ({ p: d(r.period), ...r })));
}

async function renderC2(root) {
  const rows = await get('losses/by-cause');
  const c = card(root, { id: 'c2', title: 'Втрати особового складу за причинами', sub: 'осіб' });
  if (!rows.length) return c.empty();
  c.chart({
    type: 'bar',
    data: { labels: rows.map((r) => label('cause', r.cause)),
      datasets: KINDS.map(([k, n], i) => barDataset(n, rows.map((r) => r[k]), PAL.loss[k], { last: i === KINDS.length - 1 })) },
    options: baseOptions({ horizontal: true, stacked: true, yTitle: 'осіб', unit: 'осіб' }),
  });
  c.setTable([{ key: 'c', title: 'Причина' }, ...KINDS.map(([k, n]) => ({ key: k, title: `${n}, осіб` }))],
    rows.map((r) => ({ c: label('cause', r.cause), ...r })));
}

// C3: точкова діаграма (одна шкала на вісь) — інтенсивність вогню vs санітарні втрати за добу
async function renderC3(root) {
  const rows = await get('losses/correlation');
  const c = card(root, { id: 'c3', title: 'Зв\'язок інтенсивності вогню противника і санітарних втрат',
    sub: 'одна точка — одна доба; вісь X — пострілів противника, вісь Y — поранених, осіб' });
  if (!rows.length) return c.empty();
  const pts = rows.map((r) => ({ x: r.incoming_rounds, y: r.wounded, day: r.period }));
  const opts = baseOptions({ legend: false, unit: 'осіб' });
  opts.scales = {
    // Точкова діаграма: вісь X не мусить починатися з нуля — межі за даними з невеликим запасом
    x: { type: 'linear', beginAtZero: false, grace: '5%', title: { display: true, text: 'Пострілів противника за добу' }, grid: { color: color('--grid') },
      ticks: { callback: (v) => num(v) } },
    y: { beginAtZero: true, title: { display: true, text: 'Санітарні втрати, осіб' }, grid: { color: color('--grid') } },
  };
  opts.interaction = { mode: 'nearest', intersect: true };
  opts.plugins.tooltip.callbacks.label = (ctx) => `${d(ctx.raw.day)}: ${num(ctx.raw.x)} пострілів, ${num(ctx.raw.y)} поранених`;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
  const cov = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
  const sx = Math.sqrt(pts.reduce((s, p) => s + (p.x - mx) ** 2, 0)), sy = Math.sqrt(pts.reduce((s, p) => s + (p.y - my) ** 2, 0));
  const r = sx && sy ? cov / (sx * sy) : null;
  c.chart({
    type: 'scatter',
    data: { datasets: [{ label: 'Доба', data: pts, backgroundColor: color('--c-gold'), borderColor: color('--surface'), borderWidth: 1,
      pointRadius: 4, pointHoverRadius: 6 }] },
    options: opts,
  });
  if (r !== null) c.el.querySelector('.chart-sub').textContent += ` · коефіцієнт кореляції r = ${r.toFixed(2).replace('.', ',')}${Math.abs(r) >= 0.5 ? ' (помітний зв\'язок)' : ''}`;
  c.setTable([{ key: 'd', title: 'Дата' }, { key: 'x', title: 'Пострілів противника' }, { key: 'y', title: 'Поранених, осіб' }],
    pts.map((p) => ({ d: d(p.day), x: p.x, y: p.y })));
}

const NORM_MANNING = 85;   // умовний норматив укомплектованості, %
const one = (x) => (x === null || x === undefined ? null : num(x, 1));

// C4: укомплектованість по днях (один ряд, одна вісь — %)
async function renderC4(root) {
  const rows = await get('losses/strength');
  const c = card(root, { id: 'c4', title: 'Укомплектованість особовим складом по днях',
    sub: `% наявних від штатної чисельності (обрані підрозділи); пунктир — ${NORM_MANNING} % (умовний норматив)`, wide: true });
  if (!rows.some((r) => r.manning_pct !== null)) return c.empty();
  const opts = baseOptions({ legend: false, yTitle: '%', unit: '%' });
  // Лінійний графік: вісь підлаштовано під дані (це не стовпчики, нуль не обов'язковий); норматив завжди видно
  const vals = rows.map((r) => r.manning_pct).filter((v) => v !== null);
  opts.scales.y.beginAtZero = false;
  opts.scales.y.min = Math.max(0, Math.floor(Math.min(...vals, NORM_MANNING) - 3));
  opts.scales.y.max = Math.min(105, Math.ceil(Math.max(...vals, NORM_MANNING) + 3));
  opts.plugins.refline = { value: NORM_MANNING, label: `${NORM_MANNING} %` };
  c.chart({
    type: 'line',
    data: { labels: rows.map((r) => periodLabel(r.period, 'day')),
      datasets: [lineDataset('Укомплектованість', rows.map((r) => r.manning_pct), '--c-sea')] },
    options: opts,
    plugins: [refLinePlugin],
  });
  c.setTable([{ key: 'p', title: 'Дата' }, { key: 'authorized', title: 'За штатом, осіб' }, { key: 'present', title: 'У наявності, осіб' },
    { key: 'manning_pct', title: 'Укомплектованість, %', fmt: one }, { key: 'replenished', title: 'Прибуло поповнення, осіб' }],
  rows.map((r) => ({ p: d(r.period), ...r })));
}

// C5: підрозділи з найнижчою укомплектованістю на кінець періоду
async function renderC5(root) {
  const all = await get('losses/strength-by-unit');
  const rows = all.slice(0, 15);
  const c = card(root, { id: 'c5', title: 'Підрозділи з найнижчою укомплектованістю',
    sub: `% на кінець періоду, 15 найнижчих з ${num(all.length)}; червоний — менше 70 %, золотий — менше ${NORM_MANNING} %` });
  if (!rows.length) return c.empty();
  const col = (v) => color(v < 70 ? '--c-red' : v < NORM_MANNING ? '--c-gold' : '--c-sea');
  const opts = baseOptions({ horizontal: true, legend: false, yTitle: '%', unit: '%' });
  opts.scales.x.max = 100;
  opts.scales.y.ticks.autoSkip = false;
  opts.plugins.refline = { value: NORM_MANNING, label: `${NORM_MANNING} %` };
  c.chart({
    type: 'bar',
    data: { labels: rows.map((r) => r.short_name),
      datasets: [barDataset('Укомплектованість', rows.map((r) => r.manning_pct), '--c-sea', { extra: { backgroundColor: rows.map((r) => col(r.manning_pct)) } })] },
    options: opts,
    plugins: [refLinePlugin],
  });
  c.setTable([{ key: 'short_name', title: 'Підрозділ' }, { key: 'e', title: 'Ланка' }, { key: 'authorized', title: 'За штатом, осіб' },
    { key: 'present', title: 'У наявності, осіб' }, { key: 'manning_pct', title: 'Укомплектованість, %', fmt: one },
    { key: 'replenished', title: 'Поповнення за період, осіб' }],
  all.map((r) => ({ e: label('echelon', r.echelon), ...r })));
}

return { renderC1, renderC2, renderC3, renderC4, renderC5 };
})();
// ---- charts/docs.js ----
__M["charts/docs.js"] = (function () {
// Модуль D: D1–D4. Нормативи часу обробки — умовні (підтвердження замовника очікується).
const { get } = __M["api.js"];
const { label } = __M["state.js"];
const { d, dtg, minutes, num } = __M["format.js"];
const { PAL, card, baseOptions, barDataset, lineDataset, refLinePlugin, periodLabel, tableHtml, color } = __M["charts/common.js"];
async function renderD1(root) {
  const data = await get('docs/flow');
  const c = card(root, { id: 'd1', title: 'Надходження документів на ОКП за годинами доби і категоріями терміновості',
    sub: 'середня кількість за добу, од.; київський час', wide: true });
  if (!data.rows.some((r) => r.docs)) return c.empty();
  const urg = [...new Map(data.rows.map((r) => [r.urgency, r.name_ua])).entries()];
  const hours = [...Array(24).keys()];
  const v = (h, u) => Number(data.rows.find((r) => r.hour === h && r.urgency === u)?.per_day ?? 0);
  c.chart({
    type: 'bar',
    data: { labels: hours.map((h) => `${String(h).padStart(2, '0')}.00`),
      datasets: urg.map(([u, n], i) => barDataset(n, hours.map((h) => v(h, u)), PAL.urgency[u], { last: i === urg.length - 1 })) },
    options: baseOptions({ stacked: true, yTitle: 'документів за добу', unit: 'од.' }),
  });
  c.setTable([{ key: 'h', title: 'Година' }, ...urg.map(([u, n]) => ({ key: u, title: `${n}, од./добу`, fmt: (x) => num(x, 1) }))],
    hours.map((h) => ({ h: `${String(h).padStart(2, '0')}.00`, ...Object.fromEntries(urg.map(([u]) => [u, v(h, u)])) })));
}

// D2: час обробки у % від нормативу (норматив = 100 %), щоб усі категорії мали одну шкалу
async function renderD2(root) {
  const rows = await get('docs/sla');
  const c = card(root, { id: 'd2', title: 'Час обробки документів відносно нормативу за категоріями терміновості',
    sub: '% від нормативу; пунктир — норматив (умовний); у підказці — хвилини' });
  if (!rows.some((r) => r.docs)) return c.empty();
  const ratio = (v, r) => (v === null ? null : Math.round((100 * v) / r.norm_min));
  const opts = baseOptions({ horizontal: true, yTitle: '% від нормативу', unit: '%' });
  opts.plugins.refline = { value: 100, label: 'норматив' };
  opts.scales.x.suggestedMax = 120;
  opts.plugins.tooltip.callbacks.label = (ctx) => {
    const r = rows[ctx.dataIndex];
    const m = ctx.datasetIndex === 0 ? r.median_min : r.p90_min;
    return `${ctx.dataset.label}: ${minutes(m)} (${num(ctx.parsed.x)} % від нормативу ${minutes(r.norm_min)})`;
  };
  c.chart({
    type: 'bar',
    data: { labels: rows.map((r) => r.name_ua), datasets: [
      barDataset('Медіана', rows.map((r) => ratio(r.median_min, r)), '--c-storm'),
      barDataset('90-й процентиль', rows.map((r) => ratio(r.p90_min, r)), '--c-steel'),
    ] },
    options: opts,
    plugins: [refLinePlugin],
  });
  c.setTable([{ key: 'name_ua', title: 'Категорія терміновості' }, { key: 'docs', title: 'Документів, од.' },
    { key: 'norm_min', title: 'Норматив (умовний)', fmt: minutes }, { key: 'median_min', title: 'Медіана', fmt: minutes },
    { key: 'p90_min', title: '90-й процентиль', fmt: minutes }, { key: 'overdue_pct', title: 'Прострочено, %', fmt: (x) => num(x, 1) }], rows);
}

async function renderD3(root) {
  const data = await get('docs/overdue');
  const c = card(root, { id: 'd3', title: 'Частка прострочених документів по днях',
    sub: `%; пунктир — поріг ${num(data.threshold_pct, 1)} % (умовний); червоні точки — перевищення` });
  if (!data.rows.some((r) => r.docs)) return c.empty();
  const red = color('--c-red'), sea = color('--c-sea');
  const opts = baseOptions({ legend: false, yTitle: '%', unit: '%' });
  opts.plugins.refline = { value: data.threshold_pct, label: `поріг ${num(data.threshold_pct, 1)} %` };
  c.chart({
    type: 'line',
    data: { labels: data.rows.map((r) => periodLabel(r.period, 'day')), datasets: [lineDataset('Прострочено', data.rows.map((r) => r.overdue_pct), '--c-sea', {
      pointRadius: data.rows.map((r) => (r.overdue_pct > data.threshold_pct ? 4 : 0)),
      pointBackgroundColor: data.rows.map((r) => (r.overdue_pct > data.threshold_pct ? red : sea)) })] },
    options: opts,
    plugins: [refLinePlugin],
  });
  c.setTable([{ key: 'p', title: 'Дата' }, { key: 'docs', title: 'Документів, од.' }, { key: 'overdue', title: 'Прострочено, од.' },
    { key: 'overdue_pct', title: 'Прострочено, %', fmt: (x) => num(x, 1) }], data.rows.map((r) => ({ p: d(r.period), ...r })));
}

async function renderD4(root) {
  const rows = await get('docs/queue');
  const c = card(root, { id: 'd4', title: 'Черга необроблених документів', sub: 'на кінець даних; сортування за терміновістю і строком', wide: true, html: true });
  const cols = [
    { key: 'reg_number', title: 'Обліковий номер' }, { key: 'urgency_ua', title: 'Категорія терміновості' },
    { key: 'doc_type', title: 'Вид документа', fmt: (v) => label('doc_type', v) }, { key: 'sender', title: 'Відправник' },
    { key: 'received_at', title: 'Надходження', fmt: dtg }, { key: 'due_at', title: 'Строк', fmt: dtg },
    { key: 'waiting_min', title: 'Очікує', fmt: minutes }, { key: 'status', title: 'Стан', fmt: (v) => label('status', v) },
    { key: 'is_overdue', title: 'Прострочено', fmt: (v) => (v ? 'так' : 'ні') },
  ];
  if (!rows.length) { c.htmlBox.innerHTML = '<div class="empty">Черга порожня.</div>'; return; }
  c.htmlBox.innerHTML = `<div style="max-height:420px;overflow:auto">${tableHtml(`ЧЕРГА необроблених документів ОКП (${num(rows.length)} од.)`, cols, rows)}</div>`;
  c.htmlBox.querySelectorAll('tbody tr').forEach((tr, i) => { if (rows[i].is_overdue) tr.classList.add('overdue'); });
  c.setTable(cols, rows);

}

return { renderD1, renderD2, renderD3, renderD4 };
})();
// ---- journal.js ----
__M["journal.js"] = (function () {
// Журнал записів: таблиці за п. 2.3 Порядку (нумераційний і тематичний заголовок, «№ з/п», без порожніх клітинок)
const { get, downloadCsv } = __M["api.js"];
const { esc, num } = __M["format.js"];
const { periodText } = __M["charts/common.js"];
const MODS = [['air', 'Повітряні удари'], ['alerts', 'Тривоги'], ['artillery', 'Артилерія'], ['counter_battery', 'Контрбатарейна'],
  ['ammo', 'Боєприпаси'], ['equipment', 'Озброєння'], ['losses', 'Втрати'], ['strength', 'Укомплектованість'], ['docs', 'Документи ОКП']];
const st = { module: 'air', q: '', sort: null, desc: true, offset: 0, limit: 50 };

async function renderJournal(root) {
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

return { renderJournal };
})();
// ---- entry.js ----
__M["entry.js"] = (function () {
// Вкладка «Внесення даних»: форма (один запис) та імпорт файлу (CSV, Excel, JSON).
//   • онлайн — записи йдуть у PostgreSQL через API (origin = manual / import);
//   • офлайн — записи зберігаються в цьому браузері (localStorage), одразу враховуються в графіках
//     і на карті та вивантажуються як .sql (для psql) або .json (для імпорту, коли є сервер).
/* global L, GEO, XLSX */
const { get, post, del, mode, clearCache, saveFile } = __M["api.js"];
const { state } = __M["state.js"];
const { esc, num, dtg } = __M["format.js"];
const { dateFieldHtml, initDateField, setIso, getIso } = __M["datefield.js"];
const offline = __M["offline.js"];
const { validate, addLocal, localEntries, removeLocal, clearLocal, exportJson, exportSql, RowError } = __M["entries-store.js"];
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
function findOblast(lat, lon) {
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
async function renderEntry(root) {
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

return { findOblast, renderEntry };
})();
// ---- app.js ----
__M["app.js"] = (function () {
// Точка входу: фільтри, вкладки (hash-маршрути), теми, перемальовування при зміні стану.
/* global Chart */
const { get, mode } = __M["api.js"];
const { state, initFromUrl, setFilters, onChange, query, oblastName } = __M["state.js"];
const { loadChartFonts, applyChartTheme } = __M["fonts.js"];
const { d, dtg, esc } = __M["format.js"];
const { initDateField, setRange, setIso, getIso } = __M["datefield.js"];
const { renderKpi } = __M["kpi.js"];
const { MapView } = __M["map.js"];
const { destroyAll } = __M["charts/common.js"];
const { renderA1, renderA2, renderA3, renderA4 } = __M["charts/air.js"];
const { renderB1, renderB2, renderB3, renderB4, renderB5, renderB6, renderB7 } = __M["charts/artillery.js"];
const { renderC1, renderC2, renderC3, renderC4, renderC5 } = __M["charts/losses.js"];
const { renderD1, renderD2, renderD3, renderD4 } = __M["charts/docs.js"];
const { renderJournal } = __M["journal.js"];
const { renderEntry } = __M["entry.js"];
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

return {  };
})();
})();
