// Звіт і слайди: висновок за шаблоном, Markdown-звіт і 2 слайди PowerPoint для доповіді.
import { h, api, mount, alert, btn, header, tabs, kpis, runCaption, download, field, md, panel } from '../ui.js';

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
    const ta = (key, ph, rows = 3) => { const t = h('textarea', { rows, placeholder: ph }); t.value = s[key]; t.addEventListener('input', () => { s[key] = t.value; try { localStorage.setItem('report', JSON.stringify(SAVED)); } catch (e) { /* */ } }); return t; };
    const preview = h('div');
    mount(box, tabs(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map(x => [x, 'MOD-0' + x[1]]), k, x => { KEY.cur = x; draw(); }, 'small'),
      h('h2', r.card.title),
      r.entry ? h('div', runCaption(r.entry), kpis(r.entry.metrics, KPI[k])) : alert('Для цього модуля ще немає запусків — звіт буде без цифр.', 'wr'),
      h('h2', 'Висновок за шаблоном'),
      h('div.grid.g2', field('1–2 типові помилки та їх причина', ta('errors', HINT[k][0])), field('Обмеження', ta('limits', HINT[k][1]))),
      field('Висновок: переваги повторного використання моделі та що покращить результат', ta('conclusion', 'Напр.: готова модель дала F1 0,9 на 30 фото на клас; без неї знадобилися б тисячі фото. Покращити: більше даних, нічні знімки, розморозити layer4.', 4)),
      field('Посилання на GitHub', (() => { const i = h('input', { value: s.repo }); i.addEventListener('input', () => { s.repo = i.value; }); return i; })()),
      h('div.row', { style: { margin: '14px 0' } },
        btn('⤓ Слайди PowerPoint (2 шт.)', () => download(`/api/report/${k}/pptx`, s, `TL-Lab_${k}_slides.pptx`), 'primary'),
        btn('⤓ Звіт (.md)', () => download(`/api/report/${k}/md`, s, `report_${k}.md`)),
        btn('Попередній перегляд', async () => {
          const t = await (await api(`/api/report/${k}/md`, { method: 'POST', body: s })).text();
          mount(preview, panel('Попередній перегляд звіту', md(t)));
        })),
      preview);
  };
  await draw();
}
