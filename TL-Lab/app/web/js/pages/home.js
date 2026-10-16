// Ситуаційна панель: стан шести модулів, останні результати, перехід одним кліком.
import { h, api, header, fmt } from '../ui.js';

const WHY = {
  m1: 'Розпізнає на фото БПЛА, бронетехніку, артилерію, вантажівки, замасковані позиції або порожню місцевість.',
  m2: 'Сортує службові документи за типом: донесення, наказ, рапорт, заявка, довідка, повідомлення.',
  m3: 'Впізнає звуки: Шахед, реактивний Шахед, вертоліт, літак, техніка, сирена, фон.',
  m4: 'Без підказок групує потік повідомлень за темами — логістика, погода, зв\'язок…',
  m5: 'Мала мовна модель складає тестові запитання за навчальним текстом.',
  m6: 'Агент, навчений керувати системою, переучується під нові умови (вітер, шум, інша фізика).',
};
const SHORT = { f1_macro: 'F1', silhouette: 'SIL', valid_json: 'JSON', mean_reward: 'REW' };

export async function render(root) {
  root.append(header('SITREP', 'Ситуаційна панель модулів', '~'));
  const boot = h('div.boot'), grid = h('div.grid.g3');
  root.append(boot, grid, h('p.muted.small', { style: { marginTop: '18px' } },
    'Програма працює без Інтернету. Навчання йде у фоні — можна вільно переходити між модулями. ',
    'Незнайомий термін? Сторінка ', h('a', { href: '#/glossary' }, '«Словник понять»'), '.'));
  const st = await api('/api/status');
  const w = st.warmup;
  const lines = [
    ['ok', 'OK', `ініціалізація ядра · seed 42 · журнал results.json · запусків: ${st.runs}`],
    w.done ? ['ok', 'OK', `прогрів бібліотек завершено за ${Math.round(w.seconds)} с`] : ['wr', '....', 'прогрів бібліотек у фоні — перше відкриття модуля може тривати кілька секунд'],
    st.gpu === null ? ['wr', '....', 'GPU: перевірка…'] : [st.gpu ? 'ok' : 'wr', st.gpu ? 'OK' : '--', st.gpu ? 'GPU: виявлено' : 'GPU: немає — LoRA навчається через Google Colab'],
  ];
  for (const [k, m] of Object.entries(st.modules)) {
    const s = m.missing.length ? 'er' : (m.cached ? 'ok' : 'wr');
    lines.push([s, { ok: 'OK', wr: 'WARN', er: 'FAIL' }[s], `${k.toUpperCase()} · ${m.model} · ${{ ok: 'модель готова', wr: 'модель не завантажено', er: 'бракує: ' + m.missing.join(', ') }[s]}`]);
  }
  lines.forEach(([c, t, txt], i) => boot.append(h('div', { style: { animationDelay: (i * 0.07) + 's' } }, '[ ', h('span', { class: c }, t), ' ] ', txt)));
  boot.append(h('div', { style: { animationDelay: (lines.length * 0.07) + 's' } }, h('span.ok', 'root@tl-lab'), ':~$ ', h('span.cursor')));

  for (const [k, m] of Object.entries(st.modules)) {
    let s = m.missing.length ? 'er' : (m.cached ? 'ok' : 'wr');
    let state = { ok: 'ГОТОВО', wr: 'ОЧІКУЄ МОДЕЛЬ', er: 'ВИМКНЕНО' }[s];
    if (m.job) { s = 'ok'; state = `НАВЧАННЯ ${Math.round(m.job.progress * 100)}%`; }
    const res = typeof m.m_adapt === 'number'
      ? h('span', typeof m.m_base === 'number' ? fmt(m.m_base) + ' → ' : '', h('span.c-ok', fmt(m.m_adapt))) : '—';
    grid.append(h('div.mcard', { onclick: () => { location.hash = '#/' + k; } },
      h('div.code', 'MOD-' + k.slice(1).padStart(2, '0')),
      h('div.name', m.title.replace(/^\d+\.\s*/, '')),
      h('div.model', m.model),
      h('div.small', { style: { minHeight: '3.2em', marginBottom: '8px', lineHeight: 1.45 } }, WHY[k]),
      h('div.r', h('span', 'СТАН'), h('span', h('i', { class: 'dot ' + s }), state)),
      h('div.r', h('span', 'ОСТАННІЙ ЗАПУСК'), h('span', m.last_time ? m.last_time.replace('T', ' ').slice(5, 16) : '—')),
      h('div.r', h('span', `${SHORT[m.metric] || m.metric} БАЗА → АДАПТ.`), h('span', res))));
  }
}
