// Глобальний стан фільтрів. Дублюється в URL (?date_from=…&oblast=…#air), щоб посиланням можна було поділитися.

const listeners = new Set();
export const state = { date_from: null, date_to: null, oblast: [], unit: [], meta: null, dicts: {}, labels: {} };

export function initFromUrl() {
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

export function query(extra = {}) {
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

export function setFilters(patch) {
  Object.assign(state, patch);
  const url = `${location.pathname}?${query().toString()}${location.hash}`;
  history.replaceState(null, '', url);
  listeners.forEach((fn) => fn(state));
}

// Клік — вибрати лише цю область (повторний клік по єдиній вибраній — зняти вибір).
// Ctrl/Shift + клік — додати/прибрати область, не скидаючи інших.
export function toggleOblast(iso, multi = false) {
  const has = state.oblast.includes(iso);
  let next;
  if (multi) next = has ? state.oblast.filter((o) => o !== iso) : [...state.oblast, iso];
  else next = has && state.oblast.length === 1 ? [] : [iso];
  setFilters({ oblast: next });
}

export function onChange(fn) { listeners.add(fn); }

export function label(group, code) { return state.labels[group]?.[code] ?? code; }

export function oblastName(iso) { return state.dicts.oblasts?.find((o) => o.iso_code === iso)?.name_ua ?? iso; }

export function filterCaption() {
  const parts = [];
  if (state.oblast.length) parts.push('області: ' + state.oblast.map(oblastName).join(', '));
  if (state.unit.length) {
    const names = state.unit.map((id) => state.dicts.units?.find((u) => u.id === id)?.short_name ?? id);
    parts.push('підрозділи: ' + names.join(', '));
  }
  return parts.length ? parts.join('; ') : 'усі області та підрозділи';
}
