// Формати: числа uk-UA (пробіл між тисячами, десяткова кома), час «ГГ.ХХ ДД.ММ.РРРР» за київським часом
// (п. 2.1.1 Порядку). Відсутні значення — «немає відом.» (п. 2.3.6).

export const NO_DATA = 'немає відом.';
const nf0 = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 });

export function num(v, digits = 0) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return typeof v === 'string' && v ? v : NO_DATA;
  return (digits ? nf1 : nf0).format(Number(v));
}

const parts = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

export function dtg(iso) {
  if (!iso) return NO_DATA;
  const p = Object.fromEntries(parts.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.hour}.${p.minute} ${p.day}.${p.month}.${p.year}`;
}

// 'YYYY-MM-DD' → 'ДД.ММ.РРРР'
export function d(isoDate) {
  if (!isoDate) return NO_DATA;
  const [y, m, dd] = String(isoDate).slice(0, 10).split('-');
  return `${dd}.${m}.${y}`;
}
export function dShort(isoDate) {
  const [, m, dd] = String(isoDate).slice(0, 10).split('-');
  return `${dd}.${m}`;
}

export function minutes(v) {
  if (v === null || v === undefined) return NO_DATA;
  const m = Number(v);
  if (m < 120) return `${num(m, 1)} хв`;
  return `${num(m / 60, 1)} год`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function isUnverified(rel) { return !!rel && /[4-6]$/.test(rel); }
