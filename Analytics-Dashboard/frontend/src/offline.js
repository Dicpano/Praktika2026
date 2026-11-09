// Офлайн-режим: ті самі відповіді, що й FastAPI, але обчислені в браузері зі знімка бази
// (data/dataset.js → window.DATASET). Використовується, коли index.html відкрито як файл (file://)
// або сервер API недоступний. Логіка повторює SQL з backend/app/routers/*.py.
//
// Час у знімку — «київський настінний» у секундах від 1970-01-01, тому доба/година/день тижня
// рахуються простим діленням; тривалості — у реальному часі (з урахуванням переходу на літній час).
/* global DATASET */
import { localEntries, caliberClass } from './entries-store.js';

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

export function init() {
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

export function reload() { DB = null; init(); }

// ---------- Час ----------
const pad = (n) => String(n).padStart(2, '0');
export const dayIso = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
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
export function kyivIso(wall) {
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

export function exportCsv(module, q) {
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
export async function handle(path, params) {
  init();
  const q = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  if (path.startsWith('journal/')) return H.journal(q, filters(q), path.slice(8));
  const fn = H[path];
  if (!fn) throw new Error(`404: офлайн-режим не підтримує ${path}`);
  return fn(q, fn.length > 1 ? filters(q) : null);
}

export const db = () => init();
