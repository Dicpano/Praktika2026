// Звіт і слайди: автоматичний висновок, 6 слайдів модуля з тезами, загальна доповідь (10 слайдів), Markdown-звіт.
import { h, api, mount, alert, btn, header, tabs, kpis, runCaption, download, field, md, panel, why, table, toast } from '../ui.js';

const KEY = { cur: 'm1' };
const SAVED = (() => { try { return JSON.parse(localStorage.getItem('report') || '{}'); } catch (e) { return {}; } })();
const KPI = { m1: ['accuracy', 'f1_macro'], m2: ['accuracy', 'f1_macro'], m3: ['accuracy', 'f1_macro'], m4: ['silhouette', 'ari', 'nmi'],
  m5: ['valid_json', 'key_in_options'], m6: ['mean_reward'] };
const HINT = {
  m1: ['Напр.: БПЛА на фоні хмар віднесено до «немає цілі» — замало таких фото; замаскована позиція сплутана з бронетехнікою.',
    'Напр.: 20–30 фото на клас з відкритих джерел, оцінка на малій тестовій вибірці, немає нічних і тепловізійних знімків.'],
  m2: ['Напр.: аналітичну довідку з датами сплутано з інформаційним повідомленням.', 'Напр.: синтетичні тексти, 26 на тип, шаблонна мова.'],
  m3: ['Напр.: бензопилу сплутано з Шахедом — схожий звук двотактного двигуна.', 'Напр.: мало відкритих записів Шахедів, особливо реактивних.'],
  m4: ['Напр.: повідомлення про ремонт генератора потрапило до кластера «логістика».', 'Напр.: 60 коротких повідомлень, k обрано за silhouette.'],
  m5: ['Напр.: модель дублює правильну відповідь у хибних варіантах.', 'Напр.: модель 0,6B слабко володіє українською, ~70 прикладів.'],
  m6: ['Напр.: після донавчання агент гірше працює у стандартних умовах (забування).', 'Напр.: спрощена фізика симулятора, одна зміна за раз.'],
};

export async function render(root) {
  root.append(header('REPORT', 'Звіт і слайди для доповіді', '~/results'));
  const box = h('div');
  root.append(box);
  const draw = async () => {
    const k = KEY.cur;
    const r = await api('/api/report/' + k);
    const s = SAVED[k] || (SAVED[k] = { errors: '', limits: '', conclusion: '', repo: 'https://github.com/Dicpano/Praktika2026' });
    const store = () => { try { localStorage.setItem('report', JSON.stringify(SAVED)); } catch (e) { /* */ } };
    const areas = {};
    const ta = (key, rows = 3) => {
      const t = h('textarea', { rows, placeholder: (r.auto && r.auto[key]) || HINT[k][key === 'errors' ? 0 : 1] });
      t.value = s[key];
      t.addEventListener('input', () => { s[key] = t.value; store(); });
      areas[key] = t;
      return t;
    };
    const speaker = h('input', { value: SAVED.speaker || '', placeholder: 'Напр.: підполковник Прізвище І. П., група 5202 (на титульному слайді)' });
    speaker.addEventListener('input', () => { SAVED.speaker = speaker.value; store(); });
    const body = () => ({ ...s, speaker: SAVED.speaker || '' });
    const preview = h('div');
    mount(box,
      panel('Загальна доповідь — усі 6 модулів одним файлом',
        h('p', 'Титул → що таке transfer learning → по слайду на кожен модуль (головна цифра, графік, пояснення) → підсумкова таблиця → висновки. ' +
          'Цифри беруться з останніх запусків; до кожного слайда — тези для виступу в нотатках (режим доповідача PowerPoint).'),
        table([['title', 'Модуль'], ['metric', 'Метрика'], [x => x.done ? `${x.before} → ${x.after}` : h('span.c-wr', 'ще не запускали'), 'До → після']],
          r.summary || [], { scroll: false }),
        field('Доповідач (необов\'язково)', speaker),
        h('div.row', { style: { marginTop: '10px' } },
          btn('⤓ Загальна доповідь (10 слайдів)', () => download('/api/report/all/pptx', body(), 'TL-Lab_dopovid.pptx'), 'primary'))),
      h('h2', 'Звіт і слайди окремого модуля'),
      tabs(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map(x => [x, 'MOD-0' + x[1]]), k, x => { KEY.cur = x; draw(); }, 'small'),
      h('h2', r.card.title),
      r.entry ? h('div', runCaption(r.entry), kpis(r.entry.metrics, KPI[k])) : alert('Для цього модуля ще немає запусків — звіт буде без цифр. Запустіть адаптацію у вкладці модуля.', 'wr'),
      why(r.why, 'Чому так вийшло (піде на слайд 5)'),
      h('h2', 'Висновок'),
      h('p.small.muted', 'Поля вже заповнені автоматично з результатів (сірий текст). Можна залишити як є, натиснути «Підставити автоматичний текст», щоб відредагувати, або написати своє.'),
      h('div.grid.g2', field('Типові помилки та їх причина', ta('errors')), field('Обмеження', ta('limits'))),
      field('Висновок: переваги повторного використання моделі та що покращить результат', ta('conclusion', 4)),
      field('Посилання на GitHub', (() => { const i = h('input', { value: s.repo }); i.addEventListener('input', () => { s.repo = i.value; store(); }); return i; })()),
      h('div.row', { style: { margin: '14px 0' } },
        btn('✎ Підставити автоматичний текст', () => {
          for (const key of ['errors', 'limits', 'conclusion']) { s[key] = (r.auto && r.auto[key]) || ''; areas[key].value = s[key]; }
          store(); toast('Текст підставлено — можна редагувати');
        }),
        btn('⤓ Слайди модуля (6 шт.)', () => download(`/api/report/${k}/pptx`, body(), `TL-Lab_${k}_slides.pptx`), 'primary'),
        btn('⤓ Звіт (.md)', () => download(`/api/report/${k}/md`, body(), `report_${k}.md`)),
        btn('Попередній перегляд звіту', async () => {
          const t = await (await api(`/api/report/${k}/md`, { method: 'POST', body: body() })).text();
          mount(preview, panel('Попередній перегляд звіту', md(t)));
        })),
      h('p.small.muted', 'Слайди модуля: 1 — задача і навіщо це військовим; 2 — модель і дані; 3 — як адаптували (схема); 4 — результати; ' +
        '5 — чому так вийшло; 6 — висновок. Тези для виступу — у нотатках до слайдів.'),
      preview);
  };
  await draw();
}
