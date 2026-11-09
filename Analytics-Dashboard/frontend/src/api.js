// Джерело даних дашборду. Два режими з однаковими відповідями:
//   • online  — FastAPI + PostgreSQL (сторінку відкрито з http://…, сервер відповідає);
//   • offline — знімок бази data/dataset.js, обчислення в браузері (сторінку відкрито як файл
//               або сервер недоступний). Так дашборд відкривається на будь-якому комп'ютері.
import { query } from './state.js';
import * as offline from './offline.js';

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

export function mode() {
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

export async function get(path, extra = {}, { filters = true } = {}) {
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

export async function post(path, body, { csv = false } = {}) {
  return csv ? write('POST', `/api/${path}`, body, { 'Content-Type': 'text/csv; charset=utf-8' })
    : write('POST', `/api/${path}`, JSON.stringify(body), { 'Content-Type': 'application/json' });
}

export async function del(path) { return write('DELETE', `/api/${path}`); }

export function clearCache() { cache.clear(); }

// Експорт CSV: онлайн — посилання на API; офлайн — файл формується в браузері
export function csvUrl(module, extra = {}) { return `/api/export/${module}.csv?${query(extra).toString()}`; }
export async function downloadCsv(module, extra = {}) {
  if (await mode() === 'online') { location.href = csvUrl(module, extra); return; }
  const { name, text } = offline.exportCsv(module, query(extra));
  saveFile(name, text, 'text/csv;charset=utf-8');
}

export function saveFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
