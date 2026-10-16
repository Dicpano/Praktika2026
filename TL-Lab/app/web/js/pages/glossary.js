// Словник понять: усі терміни програми простими словами, з прикладами і прив'язкою до модулів.
import { h, mount, header, glossary, tabs } from '../ui.js';

const GROUPS = [['all', 'Усі'], ['base', 'Основи ML'], ['data', 'Дані й оцінювання'], ['vision', 'Зображення'], ['text', 'Тексти'],
  ['audio', 'Звук'], ['cluster', 'Кластеризація'], ['llm', 'Мовні моделі'], ['rl', 'Навчання з підкріпленням']];
let G = 'all';

export async function render(root, ctx) {
  const terms = await glossary();
  const q = h('input', { placeholder: 'Пошук терміна…', value: ctx.q.get('q') || '', style: { width: '100%', fontSize: '1rem' } });
  const list = h('div.gl');
  const draw = () => {
    const s = q.value.trim().toLowerCase();
    const hl = t => {
      if (!s) return t;
      const i = t.toLowerCase().indexOf(s);
      return i < 0 ? t : [t.slice(0, i), h('mark', t.slice(i, i + s.length)), t.slice(i + s.length)];
    };
    const items = terms.filter(t => (G === 'all' || t.group === G) &&
      (!s || [t.term, t.short, t.long, ...(t.aliases || [])].join(' ').toLowerCase().includes(s)));
    mount(list, items.length ? items.map(t => h('div.it', { id: 't-' + t.term },
      h('span.mods', (t.modules || []).map(m => 'MOD-0' + m).join(' ')),
      h('h4', hl(t.term)), h('div', h('b', hl(t.short))), h('p', { style: { margin: '6px 0 0' } }, hl(t.long)),
      t.example ? h('div.ex', '▸ Приклад: ', t.example) : null)) : h('p.muted', 'Нічого не знайдено.'));
  };
  q.addEventListener('input', draw);
  root.append(header('GLOSSARY', 'Словник понять', '~/glossary'),
    h('p.muted', `${terms.length} понять, які трапляються в програмі й на доповіді: простими словами, з прикладом і номерами модулів. ` +
      'У тексті модулів такі терміни підкреслено — наведіть мишу, щоб побачити коротке пояснення.'),
    q, h('div', { style: { margin: '12px 0' } }, tabs(GROUPS, G, g => { G = g; draw(); render2(); }, 'small')), list);
  const render2 = () => root.querySelectorAll('.tabs.small button').forEach((b, i) => b.classList.toggle('on', GROUPS[i][0] === G));
  draw();
  if (ctx.q.get('q')) setTimeout(() => document.getElementById('t-' + ctx.q.get('q'))?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
}
