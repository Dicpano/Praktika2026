// Центральне сховище даних і довідники, спільні для всіх модулів.
// Джерело подій — РЕАЛЬНИЙ API alerts.in.ua (js/alerts.js). Тип тривоги
// (alert_type) — це поле, яке реально повертає API, нічого не вигадано.

export const ALERT_TYPES = {
  air_raid:            { label: 'Повітряна тривога',      color: '#3987e5', level: 1 }, // cat-1 blue / warning
  artillery_shelling:  { label: 'Загроза артобстрілу',    color: '#d95926', level: 2 }, // cat-2 orange / serious
  urban_fights:        { label: 'Вуличні бої',            color: '#199e70', level: 2 }, // cat-3 aqua / serious
  chemical:            { label: 'Хімічна загроза',        color: '#c98500', level: 3 }, // cat-4 yellow / critical
  nuclear:              { label: 'Радіаційна загроза',     color: '#e87ba4', level: 3 }, // cat-5 magenta / critical
};

export const ALERT_TYPE_KEYS = Object.keys(ALERT_TYPES);

// Рівень 0..3 -> колір зі status-палітри (фіксована, "стан").
export const LEVELS = {
  0: { key: 'calm',     label: 'Спокійно',          color: '#0ca30c' },
  1: { key: 'alert',    label: 'Повітряна тривога', color: '#fab219' },
  2: { key: 'serious',  label: 'Бойові дії/обстріл', color: '#ec835a' },
  3: { key: 'critical', label: 'Хімічна/ядерна загроза', color: '#d03b3b' },
};

export function eventLevel(evt) {
  if (evt.threatType === 'alert_end') return 0;
  return ALERT_TYPES[evt.threatType]?.level ?? 1;
}

class Store extends EventTarget {
  constructor() {
    super();
    this.oblasts = [];      // [{iso, name_ua, name_en}]
    this.events = [];       // newest first — реальні alert_start/alert_end з alerts.in.ua
    this.alertsStatus = { configured: false, reason: 'no_token', message: '' };
  }

  setOblasts(list) {
    this.oblasts = list;
    this.dispatchEvent(new CustomEvent('oblasts:ready'));
  }

  oblastByIso(iso) {
    return this.oblasts.find((o) => o.iso === iso) || null;
  }

  setAlertsStatus(status) {
    this.alertsStatus = status;
    this.dispatchEvent(new CustomEvent('alerts-status:changed'));
  }

  addEvent(evt) {
    this.events.unshift(evt);
    this.dispatchEvent(new CustomEvent('events:changed', { detail: { added: evt } }));
  }

  addEvents(list) {
    if (!list.length) return;
    this.events = [...list, ...this.events];
    this.dispatchEvent(new CustomEvent('events:changed', { detail: { addedMany: list } }));
  }

  eventsSince(hours) {
    const cutoff = Date.now() - hours * 3600 * 1000;
    return this.events.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
  }

  // Найсвіжіша подія по області — визначає поточний стан на карті.
  latestForOblast(iso) {
    for (const e of this.events) {
      if (e.oblastIso === iso) return e;
    }
    return null;
  }

  oblastLevel(iso) {
    const e = this.latestForOblast(iso);
    return e ? eventLevel(e) : 0;
  }
}

export const store = new Store();

export function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return 'щойно';
  if (m < 60) return `${m} хв тому`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} год тому`;
  const d = Math.floor(h / 24);
  return `${d} дн тому`;
}
