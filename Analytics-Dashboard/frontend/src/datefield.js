// Поле дати у форматі ДД.ММ.РРРР (і ДД.ММ.РРРР ГГ:ХХ для дати з часом) — п. 2.1.1 Порядку.
// Стандартний <input type="date"> показує дату у форматі мови браузера (наприклад, 10/02/2026),
// тому видиме поле — текстове, а календар браузера відкривається кнопкою і лише підставляє значення.
// Усередині значення зберігається в ISO: data-iso = 'РРРР-ММ-ДД' або 'РРРР-ММ-ДД ГГ:ХХ'.

const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="3" width="13" height="11.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M1.5 6.5h13M5 1.5v3M11 1.5v3" stroke="currentColor" stroke-width="1.4"/></svg>';

const pad = (n) => String(n).padStart(2, '0');

// 'РРРР-ММ-ДД[ ГГ:ХХ]' → 'ДД.ММ.РРРР[ ГГ:ХХ]'
export function isoToUa(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(iso || '');
  if (!m) return '';
  return `${m[3]}.${m[2]}.${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}`;
}

// 'ДД.ММ.РРРР[ ГГ:ХХ]' → 'РРРР-ММ-ДД[ ГГ:ХХ]' або null, якщо дата некоректна
export function uaToIso(text, withTime = false) {
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
export function dateFieldHtml(id, { time = false, attrs = '' } = {}) {
  const ph = time ? 'ДД.ММ.РРРР ГГ:ХХ' : 'ДД.ММ.РРРР';
  return `<span class="dfield"><input type="text" id="${id}" class="dtext" data-time="${time ? 1 : 0}" placeholder="${ph}"`
    + ` inputmode="numeric" maxlength="${time ? 16 : 10}" autocomplete="off" spellcheck="false"${attrs}>`
    + `<input type="${time ? 'datetime-local' : 'date'}" class="dpick" tabindex="-1" aria-hidden="true">`
    + `<button type="button" class="dbtn" title="Календар" aria-label="Відкрити календар">${ICON}</button></span>`;
}

export function getIso(el) { return el.dataset.iso || ''; }

export function setIso(el, iso) {
  el.dataset.iso = iso || '';
  el.value = isoToUa(iso);
  el.removeAttribute('aria-invalid');
}

export function setRange(el, min, max) {
  el.dataset.min = min || '';
  el.dataset.max = max || '';
  const pick = el.parentElement.querySelector('.dpick');
  if (pick) { pick.min = min || ''; pick.max = max || ''; }
}

// Підключає поведінку: автокрапки під час введення, перевірка, календар. Подія 'datechange' на текстовому
// полі спрацьовує лише тоді, коли дата коректна і data-iso змінилося (стандартна 'change' не використовується).
export function initDateField(el) {
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
