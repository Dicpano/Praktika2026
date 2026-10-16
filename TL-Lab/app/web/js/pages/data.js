// Центр даних: фото, аудіо й тексти всіх модулів — перегляд, додавання, видалення, автоматичний збір, дублікати.
import { h, api, mount, panel, alert, btn, loading, tabs, jobPanel, run, filePick, lightbox, toast, select, field, table } from '../ui.js';
import { header } from '../ui.js';

const SECS = [['images', 'Фото (модуль 01)'], ['audio', 'Аудіо (модуль 03)'], ['docs', 'Документи (02)'], ['messages', 'Повідомлення (04)'], ['quiz', 'Тести (05)']];
const REVIEW = {
  camo: 'Замасковані позиції: залишайте лише фото з навчань, музеїв і виставок. Знімки реальних позицій ЗСУ з прив\'язкою до місцевості — видаляйте.',
  none: 'Немає цілі: на фото не має бути техніки, людей чи позицій — лише місцевість.',
};
const ST = { imgCls: 'uav', audCls: 'shahed' };

export async function render(root, ctx) {
  const cur = SECS.find(s => s[0] === ctx.sub) ? ctx.sub : 'images';
  const sec = h('div.sec', loading());
  root.append(header('DATA', 'Центр даних', '~/data'), tabs(SECS, cur, ctx.go), sec);
  try { await { images, audio, docs: t => tableEd(t, 'docs'), messages: t => tableEd(t, 'messages'), quiz }[cur](sec); }
  catch (e) { mount(sec, alert(e.message, 'er')); }
}

// ---------------- фото ----------------
async function images(sec) {
  const d = await api('/api/data/images?cls=' + ST.imgCls);
  const sel = new Set();
  const per = h('input', { type: 'number', min: 5, max: 80, value: 30, style: { width: '90px' } });
  const delBtn = btn('Видалити позначені (0)', async () => {
    if (!sel.size || !confirm(`Видалити ${sel.size} фото?`)) return;
    await api('/api/data/images/delete', { body: { cls: ST.imgCls, files: [...sel] } });
    toast(`Видалено ${sel.size}`); images(sec);
  }, 'danger', { disabled: true });
  const dups = h('div');
  const showDups = async () => {
    mount(dups, loading('порівняння фото (aHash)…'));
    const r = await api('/api/data/images/duplicates');
    if (!r.groups.length) { mount(dups, alert('Дублікатів не знайдено ✅', 'ok')); return 0; }
    mount(dups, alert(`Груп майже однакових фото: ${r.groups.length}. Зелена рамка — фото, яке залишиться; решту буде видалено.`, 'wr'),
      btn(`🗑 Видалити всі дублікати (${r.groups.reduce((s, g) => s + g.length - 1, 0)} фото)`, dedupe, 'danger'),
      ...r.groups.map(g => h('div.dupgrp', g.map((f, i) => h('div.thumb', { class: i === 0 ? 'keep' : 'sel', onclick: () => lightbox(f.url) },
        h('img', { src: f.url }), h('div.cap', `${f.cls_ua} · ${f.name}`))))));
    return r.groups.length;
  };
  const dedupe = async () => {
    if (!confirm('Видалити всі знайдені дублікати (у кожній групі залишиться одне фото)?')) return;
    const r = await api('/api/data/images/dedupe', { method: 'POST' });
    toast(`Видалено дублікатів: ${r.removed.length}`); images(sec);
  };
  const gal = h('div.gallery', d.files.map(f => {
    const t = h('div.thumb', { title: 'Клік — позначити для видалення; подвійний клік — збільшити', ondblclick: () => lightbox(f.url),
      onclick: () => { sel.has(f.name) ? sel.delete(f.name) : sel.add(f.name); t.classList.toggle('sel'); delBtn.textContent = `Видалити позначені (${sel.size})`; delBtn.disabled = !sel.size; } },
    h('img', { src: f.url, loading: 'lazy' }), h('div.cap', f.name));
    return t;
  }));
  mount(sec,
    tabs(Object.entries(d.classes).map(([k, v]) => [k, `${v} · ${d.counts[k]}`]), ST.imgCls, k => { ST.imgCls = k; images(sec); }, 'small'),
    REVIEW[ST.imgCls] ? alert(REVIEW[ST.imgCls], 'wr') : null,
    h('div.grid.g2',
      panel('Автоматичний збір з Wikimedia Commons (потрібен Інтернет)',
        h('div.row', field('Фото на клас (докачати до)', per), h('span.grow'),
          btn('☁ Зібрати фото для всіх класів', () => run('/api/data/images/collect', { per_class: +per.value }), 'primary')),
        h('p.small.muted', 'Наявні фото не чіпаються. Автори й ліцензії записуються в data/SOURCES_images.md. Після збору обов\'язково перегляньте фото.')),
      panel(`Додати власні фото в «${d.classes[ST.imgCls]}»`, filePick('image/*', true, async files => {
        const fd = new FormData(); fd.append('cls', ST.imgCls); files.forEach(f => fd.append('files', f));
        const r = await api('/api/data/images/upload', { method: 'POST', body: fd }); toast(`Додано ${r.added} фото`); images(sec);
      }))),
    jobPanel('data', () => images(sec)),
    h('div.row', { style: { margin: '14px 0' } }, h('b', `${d.classes[ST.imgCls]}: ${d.files.length} фото`), h('span.grow'),
      btn('🔍 Знайти дублікати', showDups), btn('🗑 Знайти й видалити дублікати', async () => { if (await showDups()) await dedupe(); }), delBtn),
    dups, d.files.length ? gal : alert('У цьому класі ще немає фото — зберіть їх автоматично або додайте свої.', 'wr'));
}

// ---------------- аудіо ----------------
async function audio(sec) {
  const d = await api('/api/data/audio?cls=' + ST.audCls);
  const sel = new Set();
  const per = h('input', { type: 'number', min: 5, max: 60, value: 25, style: { width: '90px' } });
  const delBtn = btn('Видалити позначені (0)', async () => {
    if (!sel.size || !confirm(`Видалити ${sel.size} записів?`)) return;
    await api('/api/data/audio/delete', { body: { cls: ST.audCls, files: [...sel] } });
    toast(`Видалено ${sel.size}`); audio(sec);
  }, 'danger', { disabled: true });
  mount(sec,
    tabs(Object.entries(d.classes).map(([k, v]) => [k, `${v} · ${d.counts[k]}`]), ST.audCls, k => { ST.audCls = k; audio(sec); }, 'small'),
    ['shahed', 'jet_shahed'].includes(ST.audCls) ? alert('Записи Шахедів збираються з відео й аудіо Wikimedia Commons (вільні ліцензії): програма вирізає 5-секундні фрагменти зі сталим гулом. ' +
      'Обов\'язково прослухайте їх і видаліть фрагменти з вибухами, стріляниною чи мовою. Записів реактивного Шахеда у відкритому доступі дуже мало — клас буде позначено «мало даних».', 'wr') : null,
    h('div.grid.g2',
      panel('Автоматичний збір (потрібен Інтернет)', h('div.row', field('Записів на клас (докачати до)', per), h('span.grow'),
        btn('☁ Зібрати звуки', () => run('/api/data/audio/collect', { per_class: +per.value }), 'primary')),
      h('p.small.muted', 'Шахеди — з Wikimedia Commons; вертоліт, літак, бензопила, двигун, сирена, фон — з відкритого набору ESC-50. Джерела — у data/SOURCES_audio.md.')),
      panel(`Додати власні записи в «${d.classes[ST.audCls]}»`, filePick('audio/*', true, async files => {
        const fd = new FormData(); fd.append('cls', ST.audCls); files.forEach(f => fd.append('files', f));
        const r = await api('/api/data/audio/upload', { method: 'POST', body: fd }); toast(`Додано ${r.added}`); audio(sec);
      }, 'WAV / FLAC / OGG / MP3 — лише відкриті записи, без оперативних матеріалів'))),
    jobPanel('data', () => audio(sec)),
    h('div.row', { style: { margin: '14px 0' } }, h('b', `${d.classes[ST.audCls]}: ${d.files.length} записів`), h('span.grow'), delBtn),
    h('div.alist', d.files.map(f => {
      const c = h('input', { type: 'checkbox', onchange: () => { c.checked ? sel.add(f.name) : sel.delete(f.name); delBtn.textContent = `Видалити позначені (${sel.size})`; delBtn.disabled = !sel.size; } });
      return h('div.it', c, h('span', f.name), h('audio', { controls: true, preload: 'none', src: f.url }));
    })));
}

// ---------------- таблиці текстів ----------------
async function tableEd(sec, name) {
  const d = await api('/api/data/table/' + name);
  const rows = d.rows;
  const isDocs = name === 'docs';
  const body = h('tbody');
  const draw = () => {
    mount(body, rows.map((r, i) => h('tr',
      h('td', { contenteditable: 'true', oninput: e => { r.text = e.target.innerText; } }, r.text),
      isDocs ? h('td', select(Object.entries(d.labels), r.label, v => { r.label = v; }))
        : h('td', { contenteditable: 'true', oninput: e => { r.ref_label = e.target.innerText; } }, r.ref_label || ''),
      h('td', btn('✕', () => { rows.splice(i, 1); draw(); }, 'sm danger')))));
    cnt.textContent = isDocs ? Object.entries(d.labels).map(([k, v]) => `${v}: ${rows.filter(r => r.label === k).length}`).join(' · ') : `${rows.length} повідомлень`;
  };
  const cnt = h('div.small.muted');
  const save = async () => {
    try { const r = await api('/api/data/table/' + name, { body: { rows } }); toast(`Збережено: ${r.saved}. Перезапустіть адаптацію модуля.`); }
    catch (e) { toast(e.message, 'er'); }
  };
  draw();
  const imp = isDocs ? panel('Імпорт власних навчальних документів (.docx, .txt — кожен файл = один документ)', h('div.row',
    field('Тип документів', h('span', select(Object.entries(d.labels), 'combat', v => { imp.dataset.l = v; }))), h('div.grow', filePick('.docx,.txt', true, async files => {
      const fd = new FormData(); fd.append('label', imp.dataset.l || 'combat'); files.forEach(f => fd.append('files', f));
      const r = await api('/api/data/docs/import', { method: 'POST', body: fd }); toast(`Імпортовано ${r.added}`); tableEd(sec, name);
    }))), alert('Лише навчальні або вигадані документи. Справжні службові документи й матеріали реальної обстановки не завантажуйте.', 'wr')) : null;
  mount(sec,
    h('p.muted', isDocs ? 'Клацніть по тексту, щоб редагувати. Кожна категорія — щонайменше 5 текстів (для 5-кратної крос-валідації).'
      : 'ref_label — прихована тема для оцінки ARI/NMI; кластеризація її не бачить. Можна залишити порожньою.'),
    imp, cnt,
    h('div.scroll', { style: { maxHeight: '560px' } }, h('table.t', h('thead', h('tr', h('th', 'Текст'), h('th', isDocs ? 'Тип' : 'Прихована тема'), h('th', ''))), body)),
    h('div.row', { style: { marginTop: '10px' } }, btn('+ Додати рядок', () => { rows.push(isDocs ? { text: '', label: 'info' } : { text: '', ref_label: '' }); draw(); }),
      h('span.grow'), btn('💾 Зберегти', save, 'primary')));
}

async function quiz(sec) {
  const d = await api('/api/data/table/quiz');
  const rows = d.rows;
  const list = h('div');
  const draw = () => mount(list, rows.map((r, i) => {
    const ed = (k, w = '100%') => { const x = h('input', { value: r[k], style: { width: w } }); x.addEventListener('change', () => { r[k] = x.value; }); return x; };
    const opts = r.options.map((o, n) => { const x = h('input', { value: o, style: { width: '100%' } }); x.addEventListener('change', () => { if (r.answer === r.options[n]) r.answer = x.value; r.options[n] = x.value; }); return x; });
    const tx = h('textarea', { rows: 2 }, r.text); tx.addEventListener('change', () => { r.text = tx.value; });
    return h('details.x', h('summary', `${i + 1}. [${r.type === 'tf' ? 'П/Н' : '3 вар.'}] ${r.question}`), h('div',
      field('Навчальний текст', tx), field('Запитання / твердження', ed('question')), h('div.grid.g3', opts),
      h('div.row', field('Правильна', select(r.options.map(o => [o, o]), r.answer, v => { r.answer = v; })), h('span.grow'),
        btn('Видалити', () => { rows.splice(i, 1); draw(); }, 'sm danger'))));
  }));
  draw();
  mount(sec, h('p.muted', `${rows.length} прикладів «текст → запитання». ≈20 % іде на тест (не більше 6 + 3).`),
    h('div.row', btn('+ Запитання з 3 варіантами', () => { rows.unshift({ type: 'mc', text: '', question: 'Нове запитання', options: ['', '', ''], answer: '' }); draw(); }),
      btn('+ Твердження «правда/неправда»', () => { rows.unshift({ type: 'tf', text: '', question: 'Нове твердження', options: ['Правда', 'Неправда'], answer: 'Правда' }); draw(); }),
      h('span.grow'), btn('💾 Зберегти', async () => { try { const r = await api('/api/data/table/quiz', { body: { rows } }); toast(`Збережено ${r.saved}`); } catch (e) { toast(e.message, 'er'); } }, 'primary')),
    list);
}
