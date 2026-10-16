// Спільні інструменти інтерфейсу: побудова DOM, запити до сервера, компоненти, графіки, формули.

export const S = { settings: {}, jobs: {}, glossary: null, listeners: new Set(), pageOffs: [] };

// ---------- DOM ----------
export function h(tag, attrs, ...kids) {
  const [t, ...cls] = tag.split('.');
  const el = document.createElement(t || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class') el.className += ' ' + v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
export const $ = (s, r = document) => r.querySelector(s);
export function mount(el, ...kids) { el.replaceChildren(...kids.flat().filter(Boolean)); return el; }
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmt = (v, d = 3) => (typeof v === 'number' ? v.toFixed(d) : (v ?? '—'));
export const pct = v => (typeof v === 'number' ? Math.round(v * 100) + ' %' : '—');

// ---------- сервер ----------
export async function api(path, opts = {}) {
  const o = { ...opts };
  if (o.body && !(o.body instanceof FormData)) { o.body = JSON.stringify(o.body); o.headers = { 'Content-Type': 'application/json' }; }
  if (o.body && !o.method) o.method = 'POST';
  const r = await fetch(path, o);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch (e) { /* */ }
    const err = new Error(msg); err.status = r.status; throw err;
  }
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r;
}
export async function download(path, body, name) {
  try {
    const r = await api(path, { method: 'POST', body });
    const b = await r.blob();
    const a = h('a', { href: URL.createObjectURL(b), download: name });
    document.body.append(a); a.click(); a.remove();
  } catch (e) { toast(e.message, 'er'); }
}
export function toast(msg, kind = '') {
  const t = h('div.toast' + (kind ? '.' + kind : ''), msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'er' ? 9000 : 4500);
}

// ---------- каркас сторінки ----------
export function header(code, title, path) {
  return h('div.tl-head',
    h('div.tl-prompt', h('b', 'root@tl-lab'), ':' + path + '$ ', h('span.cursor', './run')),
    h('div.tl-title', h('span', code + ' // '), title),
    h('div.tl-banner', '⚠ навчальний макет. не для бойового застосування. лише відкриті, синтетичні або знеособлені дані.'));
}
export function tabs(items, current, onPick, cls = '') {
  const el = h('div.tabs' + (cls ? '.' + cls : ''));
  for (const [key, label] of items) el.append(h('button', { class: key === current ? 'on' : '', onclick: () => onPick(key) }, label));
  return el;
}
export const panel = (title, ...kids) => h('div.panel', title ? h('div.hd', title) : null, ...kids);
export const alert = (text, kind = '') => h('div.alert' + (kind ? '.' + kind : ''), text);
export const loading = (t = 'завантаження…') => h('div.muted', h('span.spin'), t);
export function btn(label, onclick, cls = '', attrs = {}) {
  return h('button.btn' + (cls ? '.' + cls.split(' ').join('.') : ''), { onclick, ...attrs }, label);
}
export function field(label, input, cls = '') { return h('label.f' + (cls ? '.' + cls : ''), label, input); }
export function slider(min, max, step, value, onInput, fmtv = v => v) {
  const out = h('span.val', fmtv(value));
  const inp = h('input', { type: 'range', min, max, step, value });
  inp.addEventListener('input', () => { out.textContent = fmtv(+inp.value); onInput(+inp.value); });
  return h('div.row', inp, out);
}
export function select(options, value, onChange) {
  const s = h('select', { onchange: () => onChange(s.value) });
  for (const [k, v] of options) s.append(h('option', { value: k, selected: String(k) === String(value) }, v));
  return s;
}
export function check(label, value, onChange) {
  const c = h('input', { type: 'checkbox', checked: !!value, onchange: () => onChange(c.checked) });
  return h('label.side-row', c, label);
}
export function filePick(accept, multiple, onFiles, label = 'Перетягніть файли сюди або натисніть, щоб обрати') {
  const inp = h('input', { type: 'file', accept, multiple, style: { display: 'none' }, onchange: () => inp.files.length && onFiles([...inp.files]) });
  const d = h('div.drop', { onclick: () => inp.click() }, label, inp);
  d.addEventListener('dragover', e => { e.preventDefault(); d.classList.add('over'); });
  d.addEventListener('dragleave', () => d.classList.remove('over'));
  d.addEventListener('drop', e => { e.preventDefault(); d.classList.remove('over'); onFiles([...e.dataTransfer.files]); });
  return d;
}
export function lightbox(src) {
  const l = h('div.lb', { onclick: () => l.remove() }, h('img', { src }));
  document.body.append(l);
}

// ---------- метрики ----------
const MN = { accuracy: 'Accuracy', f1_macro: 'F1-macro', silhouette: 'Silhouette', ari: 'ARI', nmi: 'NMI',
  valid_json: 'Валідний JSON', key_in_options: 'Ключ серед варіантів', mean_reward: 'Середня винагорода' };
export function kpis(metrics, keys, names = {}) {
  const b = metrics.baseline || {}, a = metrics.adapted || {};
  const el = h('div.kpis');
  for (const k of keys) {
    if (!(k in a) && !(k in b)) continue;
    const isPct = ['valid_json', 'key_in_options', 'accuracy'].includes(k);
    const f = v => (typeof v !== 'number' ? '—' : (isPct ? pct(v) : (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3))));
    const d = typeof a[k] === 'number' && typeof b[k] === 'number' ? a[k] - b[k] : null;
    el.append(h('div.kpi', h('div.n', names[k] || MN[k] || k),
      h('div.v', f(b[k]), h('span.ar', '→'), h('span.a', f(a[k]))),
      d === null ? null : h('div.d', { class: d >= 0 ? 'c-ok' : 'c-er' }, (d >= 0 ? '▲ +' : '▼ ') + (isPct ? Math.round(d * 100) + ' п.п.' : (Math.abs(d) >= 10 ? d.toFixed(1) : d.toFixed(3))))));
  }
  return el;
}
export function runCaption(e) {
  if (!e) return null;
  const p = Object.entries(e.params || {}).filter(([k, v]) => typeof v !== 'object').map(([k, v]) => `${k}=${v}`).join(' · ');
  return h('div.muted.small.param', `Запуск ${String(e.time).replace('T', ' ')} · seed ${e.seed} · ${p}`);
}
export function table(cols, rows, opts = {}) {
  const t = h('table.t', h('thead', h('tr', cols.map(c => h('th', c[1])))));
  const tb = h('tbody');
  for (const r of rows) tb.append(h('tr', cols.map(c => { const v = typeof c[0] === 'function' ? c[0](r) : r[c[0]]; return h('td', v instanceof Node ? v : (v ?? '')); })));
  t.append(tb);
  return opts.scroll === false ? t : h('div.scroll', { style: opts.height ? { maxHeight: opts.height } : null }, t);
}

// ---------- консоль подій і фонові задачі ----------
export function term(lines, title) {
  const el = h('div.term', title ? h('div.hd', title) : null);
  for (const [t, lvl, txt] of lines || []) el.append(h('div', h('span.t', `[${t}] `), h('span', { class: lvl || '' }, txt)));
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  return el;
}
export function onJobs(fn) { S.listeners.add(fn); return () => S.listeners.delete(fn); }

/** Панель задачі модуля: прогрес, журнал, «Скасувати». onDone викликається, коли задача завершилась. */
export function jobPanel(module, onDone) {
  const box = h('div');
  let prev = null;
  const draw = j => {
    if (!j) { mount(box); return; }
    const icon = { done: '✅', error: '❌', cancelled: '⏹' }[j.status] || '';
    if (j.active) {
      mount(box, h('div.jobbox',
        h('div.top', h('span.spin'), h('b', j.title), h('span.muted', `${j.message} · ${Math.round(j.progress * 100)} % · ${Math.round(j.elapsed)} с`),
          h('span.grow'), btn('Скасувати', () => api(`/api/jobs/${j.id}/cancel`, { method: 'POST' }), 'sm danger')),
        h('div.prog', h('i', { style: { width: (j.progress * 100) + '%' } })),
        h('div.muted.small', 'Можна переходити до інших модулів — задача виконується у фоні.'),
        term(j.lines, `${j.module.toUpperCase()} · ${j.title} — журнал подій`)));
    } else {
      mount(box, h('details.x', { open: j.status === 'error' || null },
        h('summary', `${icon} Остання задача: ${j.title} — ${j.message} (${Math.round(j.elapsed)} с)`),
        h('div', j.error ? alert(j.error, 'er') : null, term(j.lines, `${j.module.toUpperCase()} · ${j.title}`))));
    }
    if (prev && prev.active && !j.active && prev.id === j.id && onDone) onDone(j);
    prev = j;
  };
  api(`/api/jobs/${module}`).then(draw).catch(() => {});
  const off = onJobs(all => { const j = all.find(x => x.module === module); if (j) draw(j); });
  S.pageOffs.push(off);   // відписка при переході на іншу сторінку
  return box;
}
/** Запуск фонової задачі: POST → оновлення панелі задачі. */
export async function run(path, body, after) {
  try {
    const r = await api(path, { method: 'POST', body: body || {} });
    if (r.already) toast(`У модулі вже виконується «${r.job.title}»`, 'wr');
    else toast(`Задачу «${r.job.title}» запущено у фоні`);
    S.jobs[r.job.module] = r.job;
    for (const fn of S.listeners) fn([r.job]);
    if (after) after(r.job);
    return r.job;
  } catch (e) { toast(e.message, 'er'); }
}

// ---------- графіки (Plotly, локально) ----------
const BASE = { paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(5,10,14,.6)',
  font: { family: 'Consolas, "DejaVu Sans Mono", monospace', color: '#b8f3ff', size: 12 },
  margin: { l: 60, r: 20, t: 40, b: 50 }, xaxis: { gridcolor: '#12313a', zerolinecolor: '#1c4a55' },
  yaxis: { gridcolor: '#12313a', zerolinecolor: '#1c4a55' }, legend: { bgcolor: 'rgba(0,0,0,0)' } };
export const COLORS = ['#00e5ff', '#39ff9a', '#ffb000', '#ff3b8d', '#a78bfa', '#ff7d4d', '#4dd0ff', '#c6ff4d', '#ff4d6d'];
export function plot(data, layout = {}, height = 320) {
  const el = h('div.plot', { style: { height: height + 'px' } });
  const draw = () => {
    if (!window.Plotly) return setTimeout(draw, 80);
    const L = { ...BASE, ...layout, xaxis: { ...BASE.xaxis, ...(layout.xaxis || {}) }, yaxis: { ...BASE.yaxis, ...(layout.yaxis || {}) },
      title: layout.title ? { text: layout.title, font: { size: 13, color: '#e6fdff' } } : undefined };
    window.Plotly.newPlot(el, data, L, { displayModeBar: false, responsive: true });
  };
  requestAnimationFrame(draw);
  return el;
}
export function confusion(m, labels, title) {
  return plot([{ type: 'heatmap', z: m, x: labels, y: labels, colorscale: [[0, '#05070a'], [0.35, '#063a44'], [1, '#00e5ff']],
    showscale: false, text: m, texttemplate: '%{text}', hovertemplate: 'істина: %{y}<br>прогноз: %{x}<br>%{z}<extra></extra>' }],
  { title, xaxis: { title: 'прогноз', tickangle: -30, automargin: true }, yaxis: { title: 'істина', autorange: 'reversed', automargin: true },
    margin: { l: 20 + 7 * Math.max(...labels.map(l => String(l).length)), r: 10, t: 40, b: 30 + 5 * Math.max(...labels.map(l => String(l).length)) } },
  Math.max(300, 60 + labels.length * 42));
}
export function probBars(labels, values, title, hl) {
  return plot([{ type: 'bar', orientation: 'h', x: values, y: labels, marker: { color: values.map((v, i) => i === hl ? '#39ff9a' : '#0e7c8a') },
    text: values.map(v => Math.round(v * 100) + ' %'), textposition: 'auto', hovertemplate: '%{y}: %{x:.1%}<extra></extra>' }],
  { title, xaxis: { range: [0, 1], tickformat: '.0%' }, yaxis: { autorange: 'reversed' }, margin: { l: 190, r: 20, t: title ? 36 : 10, b: 30 } },
  Math.max(150, 40 + labels.length * 30));
}

// ---------- Markdown + формули (KaTeX), підвантажуються лише коли потрібні ----------
let mdReady = null;
function loadScript(src) { return new Promise((ok, no) => { const s = h('script', { src }); s.onload = ok; s.onerror = no; document.head.append(s); }); }
export function ensureMd() {
  if (!mdReady) {
    document.head.append(h('link', { rel: 'stylesheet', href: '/static/vendor/katex/katex.min.css' }));
    mdReady = Promise.all([loadScript('/static/vendor/marked.min.js'), loadScript('/static/vendor/katex/katex.min.js')]);
  }
  return mdReady;
}
export function md(text) {
  const el = h('div.md', loading());
  ensureMd().then(() => {
    const maths = [];
    let s = String(text).replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => { maths.push([m, true]); return `@@M${maths.length - 1}@@`; })
      .replace(/\$([^$\n]+?)\$/g, (_, m) => { maths.push([m, false]); return `@@M${maths.length - 1}@@`; });
    s = window.marked.parse(s);
    s = s.replace(/@@M(\d+)@@/g, (_, i) => { const [m, d] = maths[+i]; try { return window.katex.renderToString(m, { displayMode: d, throwOnError: false }); } catch (e) { return esc(m); } });
    el.innerHTML = s;
    termify(el);
  });
  return el;
}

// ---------- словник: підказки біля термінів ----------
export async function glossary() {
  if (!S.glossary) S.glossary = await api('/api/glossary');
  return S.glossary;
}
let tipEl = null;
function showTip(e, t) {
  tipEl?.remove();
  tipEl = h('div.tip', h('b', t.term), ' — ', t.short);
  document.body.append(tipEl);
  const r = e.target.getBoundingClientRect();
  tipEl.style.left = Math.min(r.left, innerWidth - 440) + 'px';
  tipEl.style.top = (r.bottom + 6 + tipEl.offsetHeight > innerHeight ? r.top - tipEl.offsetHeight - 6 : r.bottom + 6) + 'px';
}
/** Перше згадування кожного терміна в блоці стає підказкою з визначенням зі словника. */
export async function termify(root) {
  const terms = await glossary();
  const pats = [];
  for (const t of terms) for (const a of [t.term, ...(t.aliases || [])]) pats.push([a, t]);
  pats.sort((a, b) => b[0].length - a[0].length);
  const used = new Set();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n =>
    (n.parentElement.closest('.katex, code, .term-q, a, h4, .tip, button, select, option') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    for (const [a, t] of pats) {
      if (used.has(t.term)) continue;
      const re = new RegExp(`(^|[^\\p{L}])(${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\p{L}])`, 'iu');
      const m = re.exec(n.nodeValue);
      if (!m) continue;
      used.add(t.term);
      const i = m.index + m[1].length;
      const after = n.splitText(i); after.splitText(m[2].length);
      const sp = h('span.term-q', { onmouseenter: e => showTip(e, t), onmouseleave: () => tipEl?.remove(),
        onclick: () => { location.hash = '#/glossary?q=' + encodeURIComponent(t.term); } }, after.nodeValue);
      after.replaceWith(sp);
      if (sp.nextSibling && sp.nextSibling.nodeType === 3) nodes.push(sp.nextSibling);
      break;
    }
  }
}

// ------------------------------------------------------------ пояснення «Чому так вийшло» і «Як читати»
/** **жирний** у рядку -> елементи (без повного markdown — швидко і безпечно). */
export function inl(s) {
  return String(s).split('**').map((p, i) => (i % 2 ? h('b', p) : p));
}
const WHY_ICON = { ok: '✔', wr: '⚠', info: '→', tip: '★' };
/** Блок «Чому так вийшло» з пунктів {t, md}, які сервер складає з цифр останнього запуску. */
export function why(items, title = 'Чому так вийшло') {
  if (!items || !items.length) return null;
  const el = panel(title, h('ul.why', items.map(it => h('li', { class: 'w-' + it.t }, h('span.wi', WHY_ICON[it.t] || '→'), h('span', inl(it.md))))));
  el.classList.add('why-panel');
  termify(el);
  return el;
}
export const HOWTO = {
  kpi: 'Велике число ліворуч — **базовий рівень** (без адаптації), праворуч — **після адаптації**. Нижче — різниця: зелена ▲ — краще, червона ▼ — гірше. **Accuracy** — частка правильних відповідей. **F1-macro** — середня якість по всіх класах порівну (від 0 до 1), чесніша, коли класи різного розміру.',
  confusion: '**Рядок** — що було насправді (істина), **стовпчик** — що відповіла модель (прогноз). Числа на **діагоналі** (яскраві клітинки з лівого верхнього кута в правий нижній) — правильні відповіді. Усе **поза діагоналлю** — помилки: наприклад, число в рядку «Шахед» і стовпчику «Двигун техніки» — скільки Шахедів модель прийняла за двигун. Ідеальна матриця — яскрава діагональ і нулі навколо.',
  loss: '**Втрати (loss)** — наскільки модель помиляється на навчальних прикладах. По горизонталі — епохи (проходи по всіх даних). Крива має **спадати й вирівнюватись**. Якщо ще падає — можна більше епох. Якщо в кінці росте — learning rate завеликий.',
  freeze: 'Порівняння варіантів: **заморожена** модель — змінюється лише останній шар; **розморожена** — ще й кілька верхніх шарів самої мережі. «Навчуваних параметрів» — скільки чисел модель змінює під час навчання. Більше параметрів — довше і більший ризик «завчити» малий набір даних.',
  scatter: 'Кожна точка — одне повідомлення; 384 числа ембеддингу стиснуто до 2 осей (**PCA** або **t-SNE**), тож самі осі нічого не означають. Важливо, **що поруч**: близькі точки — схожі за змістом повідомлення. Колір — кластер, до якого KMeans відніс повідомлення. Добре, коли кольори утворюють окремі «хмари».',
  silhouette: 'Для кожного k (кількості кластерів) — середній **silhouette**: наскільки повідомлення ближчі до свого кластера, ніж до сусіднього (від −1 до 1). **Найвища точка** — найкраще k за цим критерієм.',
  elbow: '**Inertia** — сумарна відстань від повідомлень до центрів їхніх кластерів. Зі зростанням k вона завжди падає. Шукайте **«лікоть»** — місце, де падіння різко сповільнюється: далі нові кластери вже мало що дають.',
  cross: 'Рядки — знайдені кластери, стовпчики — приховані еталонні теми (модель їх не бачила). Яскрава клітинка — багато повідомлень. **Добре**, коли в кожному рядку одна яскрава клітинка: кластер = одна тема. Кілька світлих клітинок у рядку — змішаний кластер.',
  m5table: 'Для кожного тестового тексту — відповідь кожного режиму. **Валідний JSON** — модель дотрималась формату. **Ключ серед варіантів** — правильна відповідь справді є серед запропонованих. Ці метрики перевіряють лише форму; зміст оцінює людина (1–5).',
  rl_curve: 'Кожна точка — один епізод під час донавчання: по горизонталі — крок навчання, по вертикалі — набрана винагорода. Точки «скачуть», бо кожен епізод починається по-різному; **лінія** — ковзне середнє. Вона має **рости** — агент пристосовується до нових умов.',
  rl_bars: 'Чотири стовпчики: агент **до** і **після** донавчання — у **зміненому** середовищі (чи навчився) і в **стандартному** (чи не забув старе). Ідеально: у зміненому стовпчик «після» значно вищий, у стандартному — не нижчий, ніж «до».',
  rl_scan: 'Як готовий агент справляється, якщо поступово змінювати параметр середовища. Де крива **різко падає** — там агент «ламається». Для донавчання обирайте значення після падіння.',
};
/** Згорнута підказка «Як читати цей графік». */
export function howto(key) {
  return h('details.x.howto', h('summary', 'ⓘ Як читати цей графік'), h('div', h('p', inl(HOWTO[key] || key))));
}
/** Таблиця «заморожена / розморожена». */
export function freezeTable(f, metricName = 'F1-macro') {
  if (!f || !f.rows) return null;
  const n = v => Number(v).toLocaleString('uk-UA');
  const best = Math.max(...f.rows.map(r => r.score));
  return panel('Заморожена чи розморожена: порівняння',
    table([['variant', 'Варіант'], [r => `${n(r.trainable)} з ${n(r.total)} (${(100 * r.trainable / r.total).toFixed(r.trainable / r.total < 0.01 ? 2 : 1).replace('.', ',')} %)`, 'Навчуваних параметрів'],
      [r => h('b', { class: r.score === best ? 'c-ok' : '' }, f.metric === 'mean_reward' ? r.score.toFixed(0) : r.score.toFixed(3)), metricName],
      ...(f.rows[0].orig !== undefined ? [[r => r.orig.toFixed(0), 'У стандартному середовищі']] : []),
      [r => `${Math.round(r.seconds)} с`, 'Час']], f.rows, { scroll: false }),
    howto('freeze'));
}
/** «Що відбувається, коли натискаєте кнопку» — кроки простими словами. */
export function steps(items, title = 'Що відбувається під час адаптації — крок за кроком') {
  const el = h('details.x.steps', h('summary', title), h('div', h('ol', items.map(s => h('li', inl(s))))));
  termify(el);
  return el;
}
