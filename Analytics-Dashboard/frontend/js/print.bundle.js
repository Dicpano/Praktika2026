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
// ---- print.js ----
__M["print.js"] = (function () {
// Друкована довідка: ті самі фільтри, що й у дашборді (параметри URL). Таблиці за п. 2.3 Порядку.
const { get } = __M["api.js"];
const { state, initFromUrl, label } = __M["state.js"];
const { d, dtg, esc, minutes, num, NO_DATA } = __M["format.js"];
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

return {  };
})();
})();
