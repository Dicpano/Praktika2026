// Каркас застосунку: навігація, маршрутизація без перезавантаження сторінки, потік подій задач, фон.
import { S, h, $, mount, api, toast } from './ui.js';

const NAV = [
  ['Огляд', [['', '◎', 'Ситуаційна панель']]],
  ['Модулі', [['m1', '◉', '01 · Техніка · ResNet18'], ['m2', '▤', '02 · Документи · MiniLM'], ['m3', '♫', '03 · Звуки · YAMNet'],
    ['m4', '⬡', '04 · Кластеризація'], ['m5', '?', '05 · Тести · Qwen3'], ['m6', '⚙', '06 · RL-агент · PPO']]],
  ['Дані й результати', [['data', '▦', 'Центр даних'], ['history', '↺', 'Історія експериментів'], ['report', '▣', 'Звіт і слайди']]],
  ['Довідка', [['glossary', 'Ⓐ', 'Словник понять'], ['settings', '⚒', 'Налаштування']]],
];
const PAGES = { '': 'home', m1: 'm1', m2: 'm2', m3: 'm3', m4: 'm4', m5: 'm5', m6: 'm6', data: 'data', history: 'history',
  report: 'report', glossary: 'glossary', settings: 'settings' };

function drawNav(cur) {
  const nav = $('#nav');
  mount(nav);
  for (const [grp, items] of NAV) {
    nav.append(h('div.nav-h', grp));
    for (const [k, ic, label] of items) {
      const j = S.jobs[k];
      nav.append(h('a', { href: '#/' + k, class: k === cur ? 'on' : '' }, h('span.ic', ic), label,
        j && j.active ? h('span.badge', Math.round(j.progress * 100) + '%') : null));
    }
  }
}

// ---------- маршрутизація ----------
export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, q] = raw.split('?');
  const [page, sub] = path.split('/');
  return { page: page || '', sub: sub || '', q: new URLSearchParams(q || '') };
}
export function go(page, sub) { location.hash = '#/' + page + (sub ? '/' + sub : ''); }

let renderSeq = 0;
async function route() {
  const { page, sub, q } = parseHash();
  const name = PAGES[page] ?? 'home';
  drawNav(page);
  for (const off of S.pageOffs.splice(0)) off();
  const seq = ++renderSeq;
  const root = $('#page');
  try {
    const mod = await import(`./pages/${name}.js`);
    if (seq !== renderSeq) return;
    root.replaceChildren();
    await mod.render(root, { page, sub, q, go: s => go(page, s) });
  } catch (e) {
    console.error(e);
    mount(root, h('div.alert.er', 'Помилка сторінки: ' + e.message));
  }
  if (!sub) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ---------- фонові задачі: потік подій від сервера ----------
function drawJobsMini() {
  const act = Object.values(S.jobs).filter(j => j.active);
  const el = $('#jobs-mini');
  if (!act.length) { mount(el); return; }
  mount(el, h('div.tl-jobs', h('div.hd', '▶ ФОНОВІ ЗАДАЧІ'), act.map(j =>
    h('div.tl-jobrow', { onclick: () => go(j.module === 'data' ? 'data' : j.module, j.module === 'data' ? '' : 'adapt') },
      h('span.c-cy', j.module.toUpperCase()), ' ', j.title,
      h('div.tl-jobbar', h('i', { style: { width: (j.progress * 100) + '%' } })),
      h('span.tl-jobmsg', j.status === 'queued' ? 'у черзі' : j.message)))));
}
function applyBg() {
  const s = S.settings;
  const busy = Object.values(S.jobs).some(j => j.active);
  window.__tlbg = { mode: s.bg_pause_jobs && busy ? 'off' : (s.bg_mode || 'matrix'), k: +(s.bg_k ?? 0.5) };
}
function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = ev => {
    const list = JSON.parse(ev.data);
    for (const j of list) {
      const was = S.jobs[j.module];
      S.jobs[j.module] = j;
      if (was && was.active && !j.active && was.id === j.id) {
        toast(`${j.status === 'done' ? '✅' : j.status === 'error' ? '❌' : '⏹'} ${j.module.toUpperCase()} · ${j.title}: ${j.message}`,
          j.status === 'error' ? 'er' : '');
      }
    }
    for (const k of Object.keys(S.jobs)) if (!list.find(j => j.module === k) && S.jobs[k].active) S.jobs[k] = { ...S.jobs[k], active: false };
    for (const fn of S.listeners) fn(list);
    drawJobsMini(); drawNav(parseHash().page); applyBg();
  };
  es.onerror = () => { es.close(); setTimeout(connect, 2000); };
}

// ---------- налаштування інтерфейсу ----------
export async function loadSettings() {
  S.settings = await api('/api/settings');
  document.body.classList.toggle('present', !!S.settings.present_mode);
  document.body.classList.toggle('anim', S.settings.animations !== false);
  $('#present').checked = !!S.settings.present_mode;
  applyBg();
}
export async function saveSetting(k, v) {
  S.settings = await api('/api/settings', { body: { [k]: v } });
  await loadSettings();
}
$('#present').addEventListener('change', e => saveSetting('present_mode', e.target.checked).then(route));

(async () => {
  try { await loadSettings(); } catch (e) { toast('Сервер недоступний: ' + e.message, 'er'); }
  try { for (const j of await api('/api/jobs')) if (!S.jobs[j.module]) S.jobs[j.module] = j; } catch (e) { /* */ }
  connect();
  S.listeners.add(() => { drawJobsMini(); drawNav(parseHash().page); applyBg(); });  // миттєво після запуску задачі
  drawJobsMini();
  route();
})();
