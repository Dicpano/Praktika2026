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

export const BASE = 30;                 // розмір рендеру; на карті масштабується CSS-змінною --s
export const ORDER_COLORS = {
  Friend: 'rgb(128,224,255)', Hostile: 'rgb(255,128,128)', Neutral: 'rgb(170,255,170)',
  Unknown: 'rgb(255,255,128)', Civilian: 'rgb(255,161,255)',
};
export const BLUE = '#0057B7';
export const RED = '#D40000';
export const READINESS = {
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
export function render(sidc, o = {}) {
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
export const echelonMark = (sidc) => ECHELON_MARK[sidc?.[11]] ?? '';

/**
 * Пункт управління угруповання за п. 6.1 Порядку (зразки «ОКП ОК “Схід”», «ОКП ОУВ “Таврія”», «ОКП ОТУ “Поділ”»):
 * прапорець зі смугою вгорі, у ньому — скорочення угруповання; над прапорцем — ланка (табл. 8);
 * флагшток іде вниз від лівого краю прапорця, його нижня точка — місце пункту на місцевості;
 * під прапорцем праворуч від флагштока — вид пункту (ОКП); ліворуч — найменування, праворуч — підпорядкованість.
 * @param {object} o echelon ('XXXX'), inner ('ОСУВ'), kind ('ОКП'), left, right, mono, size, text (false — без бічних підписів)
 */
export function renderCP(o = {}) {
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
export function renderTarget(o = {}) {
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
export function crossForResult(result) {
  if (result === 'destroyed') return 'destroyed';
  if (result === 'damaged' || result === 'suppressed') return 'disabled';
  return null;
}

// Повітряна ціль: усі знешкоджено → «знищено»; є подавлені РЕБ і без влучань → «подавлено»
export function crossForStrike(p) {
  if (p.hits > 0) return null;
  if (p.intercepted >= p.launched) return 'destroyed';
  if (p.intercepted + p.suppressed >= p.launched) return 'disabled';
  return null;
}

// Знак на карті — <img> із SVG у data-URL, а не вбудований SVG: один DOM-вузол замість десятків,
// браузер растеризує однакові знаки один раз (кеш зображень). Помітно прискорює масштабування.
export function iconHtml(r, cls = '') {
  r.url ??= `data:image/svg+xml;charset=utf-8,${encodeURIComponent(r.svg)}`;
  return `<div class="sym ${cls}" style="--ax:${r.ax};--ay:${r.ay}"><img src="${r.url}" width="${r.w}" height="${r.h}" alt="" draggable="false"></div>`;
}
