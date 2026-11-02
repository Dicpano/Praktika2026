(() => {
  'use strict';

  const LEVELS = window.LEVELS;
  const STAGES = window.STAGES;
  const STORE_KEY = 'iaz-trainer-v1';

  // ---------- Словники відображення ----------
  const SECTORS = { north: 'ПІВНІЧ', south: 'ПІВДЕНЬ', east: 'СХІД', west: 'ЗАХІД', center: 'ЦЕНТР' };
  const SOURCES = { humint: 'HUMINT', sigint: 'SIGINT', imint: 'IMINT', osint: 'OSINT' };
  const TARGETS = {
    tank: 'ТАНКИ', infantry: 'ПІХОТА', artillery: 'АРТИЛЕРІЯ', mlrs: 'РСЗВ', ew: 'РЕБ',
    ad: 'ППО', cp: 'КП', logistics: 'СКЛАД', radar: 'РЛС'
  };
  const PRIO = { flash: 'FLASH', immediate: 'IMMEDIATE', priority: 'PRIORITY', routine: 'ROUTINE' };
  const RANKS = [
    [0, 'Рекрут'], [3, 'Солдат'], [6, 'Старший солдат'], [9, 'Сержант'], [12, 'Старший сержант'],
    [15, 'Лейтенант'], [18, 'Капітан'], [21, 'Майор'], [23, 'Полковник']
  ];

  const S = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const SRC_ICON = {
    humint: `<svg viewBox="0 0 24 24" ${S}><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>`,
    sigint: `<svg viewBox="0 0 24 24" ${S}><path d="M12 11v10M8 21h8"/><circle cx="12" cy="9" r="2"/><path d="M7.8 4.8a6 6 0 0 0 0 8.4M16.2 4.8a6 6 0 0 1 0 8.4"/></svg>`,
    imint: `<svg viewBox="0 0 24 24" ${S}><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`,
    osint: `<svg viewBox="0 0 24 24" ${S}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>`
  };
  const G = 'fill="none" stroke="#1a0d09" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"';
  const T_GLYPH = {
    tank: `<ellipse cx="24" cy="24" rx="10" ry="5" ${G}/>`,
    infantry: `<path d="M17 18l14 12M31 18L17 30" ${G}/>`,
    artillery: `<circle cx="24" cy="24" r="4.5" fill="#1a0d09"/>`,
    mlrs: `<circle cx="24" cy="28" r="3.5" fill="#1a0d09"/><path d="M18 22l6-6 6 6" ${G}/>`,
    ew: `<path d="M13 24l5-5 6 10 6-10 5 5" ${G}/>`,
    ad: `<path d="M15 30a9 9 0 0 1 18 0M24 30v-12" ${G}/>`,
    cp: `<path d="M19 33V15h11l-3 4 3 4H19" ${G}/>`,
    logistics: `<rect x="16" y="19" width="16" height="10" ${G}/><path d="M16 24h16" ${G}/>`,
    radar: `<path d="M16 17a11 11 0 0 0 14 14M23 24l8-8" ${G}/>`
  };
  const targetSvg = (k) =>
    `<svg viewBox="0 0 48 48"><path d="M24 2L46 24L24 46L2 24Z" fill="#e46a52" stroke="#1a0d09" stroke-width="2"/>${T_GLYPH[k] || ''}</svg>`;
  const FIRE_SVG = `<svg viewBox="0 0 40 40"><path d="M20 2l4 10 9-5-4 10 9 3-9 4 5 9-10-4-4 9-4-9-10 4 5-9-9-4 9-3-4-10 9 5z" fill="#ff9a3d" stroke="#5a1f05" stroke-width="1.5"/><circle cx="20" cy="20" r="5" fill="#ffe08a"/></svg>`;

  // ---------- Утиліти ----------
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const kindOf = (node, dict) => [...node.classList].find((c) => c in dict);
  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  const ui = {
    board: $('board'), boardWrap: $('boardWrap'), viewer: $('viewer'), input: $('input'), form: $('form'),
    status: $('status'), log: $('log'), hint: $('hint'), hintBtn: $('hintBtn'), tooltip: $('tooltip')
  };

  // ---------- Збережений прогрес ----------
  const state = load();
  function load() {
    const def = { current: 0, done: {}, hinted: {}, introSeen: false };
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && typeof s === 'object') return Object.assign(def, s);
    } catch (e) { /* немає сховища — граємо без збереження */ }
    return def;
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ігноруємо */ }
  }
  const doneCount = () => Object.keys(state.done).length;
  const rankIdx = (n) => RANKS.reduce((acc, [min], i) => (n >= min ? i : acc), 0);
  const rankName = (n) => RANKS[rankIdx(n)][1];

  let root = null;
  let expected = new Set();
  let locked = false;
  let hintStep = 0;

  // ---------- Карта обстановки ----------
  function buildVisual(node) {
    const tag = node.tagName.toLowerCase();
    const v = el('div', 'v v-' + tag);
    node.__v = v;
    v.__src = node;

    if (tag === 'sector') {
      v.append(el('div', 'v-label', `СЕКТОР «${esc(SECTORS[node.id] || node.id.toUpperCase())}»`));
    } else if (tag === 'target') {
      const k = kindOf(node, TARGETS) || 'unknown';
      v.classList.add('t-' + k);
      v.append(el('div', 't-sym', targetSvg(k)), el('div', 't-name', TARGETS[k] || 'НЕВІДОМО'));
    } else if (tag === 'report') {
      const k = kindOf(node, SOURCES);
      v.classList.add('src-' + (k || 'none'));
      v.append(el('div', 'rp-head', (SRC_ICON[k] || '') + `<span>${k ? SOURCES[k] : 'ДОНЕСЕННЯ'}</span>`));
      if (node.id) v.append(el('div', 'rp-num', '№ ' + esc(node.id.replace(/^\D+/, ''))));
      const rel = node.getAttribute('rel') || '';
      const cred = node.getAttribute('cred') || '';
      if (rel || cred) v.append(el('div', 'rp-code', esc(rel + cred)));
      const prio = node.getAttribute('prio');
      if (prio) v.append(el('div', 'rp-prio p-' + esc(prio), PRIO[prio] || esc(prio.toUpperCase())));
      if (node.hasAttribute('verified')) v.append(el('div', 'rp-ok', '✔ ПЕРЕВІРЕНО'));
    } else if (tag === 'dossier') {
      v.append(el('div', 'v-label', 'СПРАВА · ' + (TARGETS[kindOf(node, TARGETS)] || '')));
    } else if (tag === 'fire') {
      v.append(el('div', 'f-burst', FIRE_SVG), el('div', 'f-name', 'УРАЖЕННЯ'));
    }

    const kids = [...node.children];
    if (kids.length) {
      const box = el('div', 'v-kids');
      kids.forEach((k) => box.append(buildVisual(k)));
      v.append(box);
    }
    return v;
  }

  // ---------- Журнал обстановки (розмітка) ----------
  function attrsHtml(node) {
    return [...node.attributes].map((a) =>
      ` <span class="x-attr">${esc(a.name)}</span>` + (a.value !== '' ? `=<span class="x-val">"${esc(a.value)}"</span>` : '')
    ).join('');
  }
  function plainTag(node) {
    const attrs = [...node.attributes].map((a) => ' ' + a.name + (a.value !== '' ? `="${a.value}"` : '')).join('');
    return `<${node.tagName.toLowerCase()}${attrs}${node.children.length ? '' : ' /'}>`;
  }
  function buildViewer(nodes, depth) {
    nodes.forEach((n) => {
      const tag = n.tagName.toLowerCase();
      const kids = [...n.children];
      const ind = '  '.repeat(depth);
      const open = el('div', 'x-line',
        `${ind}<span class="x-br">&lt;</span><span class="x-tag">${tag}</span>${attrsHtml(n)}<span class="x-br">${kids.length ? '&gt;' : ' /&gt;'}</span>`);
      open.__src = n;
      n.__lines = [open];
      ui.viewer.append(open);
      if (kids.length) {
        buildViewer(kids, depth + 1);
        const close = el('div', 'x-line', `${ind}<span class="x-br">&lt;/</span><span class="x-tag">${tag}</span><span class="x-br">&gt;</span>`);
        close.__src = n;
        n.__lines.push(close);
        ui.viewer.append(close);
      }
    });
  }

  function mark(node, cls, on) {
    if (node.__v) node.__v.classList.toggle(cls, on);
    (node.__lines || []).forEach((l) => l.classList.toggle(cls, on));
  }

  // ---------- Наведення ----------
  let hovered = null;
  function setHover(node, withTip) {
    if (hovered !== node) {
      if (hovered) mark(hovered, 'is-hover', false);
      hovered = node;
      if (node) mark(node, 'is-hover', true);
    }
    if (node && withTip) {
      ui.tooltip.textContent = plainTag(node);
      ui.tooltip.hidden = false;
    } else {
      ui.tooltip.hidden = true;
    }
  }
  ui.board.addEventListener('mouseover', (e) => {
    const v = e.target.closest('.v');
    setHover(v ? v.__src : null, true);
  });
  ui.board.addEventListener('mouseleave', () => setHover(null));
  ui.board.addEventListener('mousemove', (e) => {
    if (ui.tooltip.hidden) return;
    const r = ui.boardWrap.getBoundingClientRect();
    const x = Math.min(e.clientX - r.left + 14, r.width - ui.tooltip.offsetWidth - 6);
    ui.tooltip.style.left = Math.max(6, x) + 'px';
    ui.tooltip.style.top = (e.clientY - r.top + 18) + 'px';
  });
  ui.viewer.addEventListener('mouseover', (e) => {
    const l = e.target.closest('.x-line');
    setHover(l ? l.__src : null, false);
  });
  ui.viewer.addEventListener('mouseleave', () => setHover(null));

  // ---------- Рівень ----------
  function loadLevel(i) {
    i = Math.max(0, Math.min(LEVELS.length - 1, i));
    state.current = i;
    save();
    locked = false;
    hovered = null;
    hintStep = 0;
    const L = LEVELS[i];

    root = document.createElement('div');
    root.innerHTML = L.markup.trim();
    expected = new Set(root.querySelectorAll(L.selector));

    ui.board.className = 'board';
    ui.board.replaceChildren(...[...root.children].map(buildVisual));
    ui.viewer.replaceChildren();
    buildViewer([...root.children], 0);
    expected.forEach((n) => mark(n, 'is-objective', true));

    $('lvlNum').textContent = pad(i + 1);
    $('orderNo').textContent = 'НАКАЗ № ' + pad(i + 1) + ' · ' + L.title.toUpperCase();
    $('stageLabel').textContent = STAGES[L.stage];
    $('orderText').innerHTML = L.order;
    $('doneMark').hidden = !state.done[i];
    $('syntaxName').textContent = L.syntaxName;
    $('syntax').textContent = L.syntax;
    $('syntaxDesc').innerHTML = L.syntaxDesc;
    $('examples').replaceChildren(...L.examples.map(([c, d]) => el('div', 'ex', `<code>${esc(c)}</code><span>${d}</span>`)));
    $('docTitle').textContent = L.doctrine.title;
    $('docBody').innerHTML = L.doctrine.body;

    ui.input.value = '';
    ui.input.disabled = false;
    setStatus('');
    ui.log.replaceChildren();
    ui.hint.hidden = true;
    ui.hintBtn.hidden = false;
    ui.hintBtn.textContent = 'ПІДКАЗКА';
    ui.tooltip.hidden = true;

    updateProgress();
    if (window.matchMedia('(hover: hover)').matches) ui.input.focus();
  }

  function setStatus(text, cls) {
    ui.status.textContent = text;
    ui.status.className = 'term-status' + (cls ? ' ' + cls : '');
  }
  function log(cls, sel, text) {
    const line = el('div', 'log-line ' + cls, `<span class="log-sel">&gt; ${esc(sel)}</span> <span>${text}</span>`);
    ui.log.prepend(line);
    while (ui.log.children.length > 3) ui.log.lastChild.remove();
  }

  function query(sel) {
    try { return [...root.querySelectorAll(sel)]; } catch (e) { return null; }
  }

  // Живий приціл: що зараз відбирає введений селектор
  function preview() {
    if (locked || !root) return;
    root.querySelectorAll('*').forEach((n) => mark(n, 'is-aimed', false));
    const sel = ui.input.value.trim();
    if (!sel) { setStatus(''); return; }
    const found = query(sel);
    if (!found) { setStatus('СИНТАКСИС: запит ще не завершено', 'err'); return; }
    found.forEach((n) => mark(n, 'is-aimed', true));
    setStatus(`У ПРИЦІЛІ: ${found.length} · ПОТРІБНО: ${expected.size}`, found.length ? 'aim' : '');
  }
  ui.input.addEventListener('input', preview);

  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (locked) return;
    const sel = ui.input.value.trim();
    if (!sel) { fail(sel, 'введіть запит'); return; }
    const found = query(sel);
    if (!found) { fail(sel, 'помилка синтаксису селектора'); return; }
    const got = new Set(found);
    const missed = [...expected].filter((n) => !got.has(n)).length;
    const extra = found.filter((n) => !expected.has(n)).length;
    if (!missed && !extra) success(sel);
    else fail(sel, `ВІДМОВА · пропущено: ${missed} · зайвих: ${extra}`);
  });

  function fail(sel, text) {
    log('err', sel, '✖ ' + text);
    ui.board.classList.remove('shake');
    void ui.board.offsetWidth;
    ui.board.classList.add('shake');
  }

  function success(sel) {
    locked = true;
    ui.input.disabled = true;
    const i = state.current;
    const before = doneCount();
    state.done[i] = state.done[i] === 'ok' ? 'ok' : (state.hinted[i] ? 'hint' : 'ok');
    save();

    expected.forEach((n) => {
      n.__v.classList.add('is-hit');
      if (!n.parentElement || !expected.has(n.parentElement)) n.__v.append(el('div', 'hit-stamp', 'ПРИЙНЯТО'));
    });
    ui.board.classList.add('is-success');
    log('ok', sel, `✔ ПРИЙНЯТО — відібрано ${expected.size}`);
    $('doneMark').hidden = false;

    const after = doneCount();
    if (rankIdx(after) > rankIdx(before)) toast('ПІДВИЩЕННЯ В ЗВАННІ: ' + rankName(after).toUpperCase());
    updateProgress();

    setTimeout(() => {
      const next = nextLevel(i);
      if (next === -1) showFinale();
      else loadLevel(next);
    }, 1600);
  }

  function nextLevel(i) {
    if (doneCount() >= LEVELS.length) return i < LEVELS.length - 1 ? i + 1 : -1;
    for (let k = 1; k <= LEVELS.length; k++) {
      const j = (i + k) % LEVELS.length;
      if (!state.done[j]) return j;
    }
    return -1;
  }

  // ---------- Підказка ----------
  ui.hintBtn.addEventListener('click', () => {
    const L = LEVELS[state.current];
    hintStep++;
    ui.hint.hidden = false;
    if (hintStep === 1) {
      ui.hint.innerHTML = L.hint;
      ui.hintBtn.textContent = 'ПОКАЗАТИ РІШЕННЯ';
    } else {
      state.hinted[state.current] = true;
      save();
      ui.hint.innerHTML = L.hint + `<div class="hint-sol">Рішення: <code>${esc(L.selector)}</code></div>`;
      ui.hintBtn.hidden = true;
    }
  });

  // ---------- Прогрес, звання, меню ----------
  function updateProgress() {
    const n = doneCount();
    $('progressBar').style.width = (n / LEVELS.length * 100) + '%';
    $('rank').textContent = rankName(n);
    $('lvlTotal').textContent = pad(LEVELS.length);
  }

  function renderMenu() {
    const box = $('menuList');
    box.replaceChildren();
    STAGES.forEach((s, si) => {
      box.append(el('div', 'menu-stage', s));
      LEVELS.forEach((L, i) => {
        if (L.stage !== si) return;
        const d = state.done[i];
        const b = el('button',
          'menu-item' + (i === state.current ? ' is-current' : '') + (d ? ' is-done' : ''),
          `<span class="mi-num">${pad(i + 1)}</span><span class="mi-title">${esc(L.title)}</span>` +
          `<code class="mi-syn">${esc(L.syntax)}</code><span class="mi-check">${d === 'ok' ? '✔' : d === 'hint' ? '◐' : ''}</span>`);
        b.type = 'button';
        b.addEventListener('click', () => { closeAll(); loadLevel(i); });
        box.append(b);
      });
    });
  }

  function open(id) { $(id).hidden = false; }
  function closeAll() {
    ['menu', 'intro', 'finale'].forEach((id) => { $(id).hidden = true; });
    if (!state.introSeen) { state.introSeen = true; save(); }
  }
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeAll));
  ['menu', 'intro', 'finale'].forEach((id) => {
    $(id).addEventListener('click', (e) => { if (e.target.id === id) closeAll(); });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });

  $('menuBtn').addEventListener('click', () => { renderMenu(); open('menu'); });
  $('helpBtn').addEventListener('click', () => open('intro'));
  $('prev').addEventListener('click', () => loadLevel(state.current - 1));
  $('next').addEventListener('click', () => loadLevel(state.current + 1));
  $('resetBtn').addEventListener('click', () => {
    if (!confirm('Скинути весь прогрес і звання?')) return;
    state.done = {};
    state.hinted = {};
    save();
    closeAll();
    loadLevel(0);
  });
  $('restartBtn').addEventListener('click', () => {
    state.done = {};
    state.hinted = {};
    save();
    closeAll();
    loadLevel(0);
  });

  function showFinale() {
    const vals = Object.values(state.done);
    $('fRank').textContent = rankName(doneCount());
    $('fClean').textContent = vals.filter((v) => v === 'ok').length;
    $('fHint').textContent = vals.filter((v) => v === 'hint').length;
    $('cheat').replaceChildren(...LEVELS.map((L) =>
      el('div', 'cheat-row', `<code>${esc(L.selector)}</code><span>${esc(L.title)}</span>`)));
    open('finale');
  }

  let toastTimer = 0;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }

  // ---------- Старт ----------
  loadLevel(Math.min(state.current || 0, LEVELS.length - 1));
  if (!state.introSeen) open('intro');
})();
