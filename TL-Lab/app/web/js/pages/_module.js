// Спільний каркас сторінки модуля: заголовок, розділи, картка моделі, теорія.
import { h, api, mount, header, tabs, panel, loading, md, alert, termify } from '../ui.js';

export const SECTIONS = [['data', 'Модель і дані'], ['adapt', 'Адаптація'], ['eval', 'Оцінювання'], ['demo', 'Демонстрація'], ['theory', 'Теорія']];

export async function modulePage(root, ctx, cfg) {
  const sections = cfg.sections || SECTIONS;
  const cur = sections.find(s => s[0] === ctx.sub) ? ctx.sub : sections[0][0];
  const sec = h('div.sec', loading());
  root.append(header(cfg.code, cfg.title, cfg.path), tabs(sections, cur, ctx.go), sec);
  try {
    if (cur === 'theory') await theory(sec, cfg.key);
    else await cfg.render[cur](sec, ctx);
  } catch (e) {
    mount(sec, alert(e.message, 'er'));
  }
}

export function modelCard(c) {
  const rows = [['Модель', c.model], ['Попередньо навчена на', c.pretrained_on], ['Параметрів', c.params],
    ['Що адаптовано', c.adapted], ['Базовий рівень', c.baseline], ['Ліцензія', c.license]];
  const el = panel('Картка моделі',
    h('table.t', h('tbody', rows.map(([k, v]) => h('tr', h('td.muted', { style: { width: '220px' } }, k), h('td', v))))),
    h('div.small.muted', { style: { marginTop: '8px' } }, 'Джерело: ', h('a', { href: c.source, target: '_blank' }, c.source)),
    c.missing && c.missing.length ? alert('Бракує бібліотек: ' + c.missing.join(', ') + ' — повторно запустіть INSTALL.bat', 'er') : null,
    !c.cached ? alert('Готова модель ще не завантажена — повторно запустіть INSTALL.bat (потрібен Інтернет).', 'wr') : null);
  termify(el);
  return el;
}

async function theory(sec, key) {
  const items = await api('/api/theory/' + key);
  mount(sec, 
    h('p.muted', 'Як працює модуль, які ваги, формули й методи він використовує і чому. Терміни з підкресленням — наведіть, щоб побачити пояснення.'),
    ...items.map((it, i) => h('details.x', { open: i < 2 || null }, h('summary', it.title), h('div', md(it.md)))));
}

/** Рядок «немає результатів» з кнопкою переходу до адаптації. */
export function noResult(ctx, text = 'Ще немає результатів — запустіть адаптацію.') {
  return alert(h('span', text, ' ', h('a', { href: '#/' + ctx.page + '/adapt' }, 'Перейти до адаптації →')));
}
