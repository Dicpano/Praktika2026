// Записи, внесені без сервера (офлайн-режим): зберігаються в localStorage цього браузера.
// Перевірки повторюють backend/app/routers/entry.py. Записи можна вивантажити:
//   • .sql  — INSERT-и для PostgreSQL (psql -f entries.sql), з пошуком id за кодами довідників;
//   • .json — для імпорту на вкладці «Внесення даних», коли дашборд працює із сервером.

const KEY = 'dashboard.entries.v1';
const DAY = 86400;                                     // час — секунди «настінного» київського часу

export function localEntries() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { throw new Error(`Не вдалося зберегти в браузері: ${e.message}`); }
}
export function removeLocal(id) { save(localEntries().filter((e) => e.id !== id)); }
export function clearLocal() { save([]); }

// Клас калібру за табл. 16 Порядку (як backend/app/sidc.py)
export function caliberClass(sys, mm) {
  if (sys === 'mortar') return mm < 60 ? 'light' : mm <= 107 ? 'medium' : 'heavy';
  if (sys === 'mlrs') return mm < 100 ? 'light' : mm < 200 ? 'medium' : 'heavy';
  return mm < 120 ? 'light' : mm <= 160 ? 'medium' : 'heavy';
}

export class RowError extends Error {
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
export function validate(kind, raw, db, findOblast, n = 1) {
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

export function addLocal(kind, row, norm) {
  const list = localEntries();
  const e = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, kind, row, norm, created: new Date().toISOString() };
  list.push(e);
  save(list);
  return e;
}

// ---------- Вивантаження ----------
export function exportJson() {
  const by = {};
  localEntries().forEach((e) => { (by[e.kind] ??= []).push(e.norm); });
  return JSON.stringify({ format: 'dashboard-entries', version: 1, exported_at: new Date().toISOString(), entries: by }, null, 2);
}

const lit = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const ts = (v) => (v === null || v === undefined ? 'NULL' : `(${lit(v)}::timestamp AT TIME ZONE 'Europe/Kyiv')`);
const ref = (table, col, v) => (v === null || v === undefined ? 'NULL' : `(SELECT id FROM ${table} WHERE ${col} = ${lit(v)})`);
const ins = (table, obj) => `INSERT INTO ${table} (${Object.keys(obj).join(', ')}) VALUES (${Object.values(obj).join(', ')});`;

export function exportSql() {
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
