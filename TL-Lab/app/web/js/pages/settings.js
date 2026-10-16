// Налаштування: інтерфейс і фон, модулі, продуктивність, дані й кеш, стан системи.
import { h, api, mount, alert, btn, header, tabs, panel, field, slider, select, check, table, toast, S, loading } from '../ui.js';
import { saveSetting } from '../app.js';

const SECS = [['ui', 'Інтерфейс'], ['mods', 'Модулі'], ['perf', 'Продуктивність'], ['data', 'Дані й кеш'], ['sys', 'Система']];

export async function render(root, ctx) {
  const cur = SECS.find(s => s[0] === ctx.sub) ? ctx.sub : 'ui';
  const sec = h('div.sec');
  root.append(header('SETUP', 'Налаштування', '~/settings'), tabs(SECS, cur, ctx.go), sec);
  const s = S.settings;
  const set = (k, v) => saveSetting(k, v).then(() => toast('Збережено'));
  if (cur === 'ui') {
    mount(sec, h('div.grid.g2',
      panel('Анімація фону',
        field('Режим', select([['matrix', 'Цифровий дощ'], ['radar', 'Радар'], ['off', 'Вимкнено']], s.bg_mode, v => set('bg_mode', v))),
        field('Інтенсивність', slider(0.1, 1, 0.1, s.bg_k, v => { S.settings.bg_k = v; window.__tlbg = { ...window.__tlbg, k: v }; }, v => v.toFixed(1))),
        btn('Зберегти інтенсивність', () => set('bg_k', S.settings.bg_k), 'sm'),
        check('Ставити анімацію на паузу, поки йде навчання (процесор — моделям)', s.bg_pause_jobs, v => set('bg_pause_jobs', v)),
        h('p.small.muted', 'На слабкому ПК або проєкторі з низьким контрастом оберіть «Вимкнено». Анімація також зупиняється, коли вікно згорнуте.')),
      panel('Відображення',
        check('Плавні переходи між розділами', s.animations, v => set('animations', v)),
        check('Режим «Доповідь» (великі табло, без службових параметрів)', s.present_mode, v => set('present_mode', v)),
        h('div', { style: { marginTop: '14px' } }, btn('Скинути всі налаштування', async () => { await api('/api/settings/reset', { method: 'POST' }); location.reload(); }, 'danger')))));
  } else if (cur === 'mods') {
    const steps = [10000, 20000, 30000, 50000, 100000];
    mount(sec, h('div.grid.g2',
      panel('Модуль 01', field('Поріг «невизначено» (якщо максимальна ймовірність нижча — програма пише «Невизначено»)',
        slider(0.2, 0.95, 0.01, s.uncertain, v => { S.settings.uncertain = v; }, v => Math.round(v * 100) + ' %')),
      btn('Зберегти', () => set('uncertain', S.settings.uncertain), 'sm')),
      panel('Модуль 06', field('Кроків донавчання за замовчуванням', select(steps.map(x => [x, x.toLocaleString('uk')]), s.rl_steps, v => set('rl_steps', +v))))));
  } else if (cur === 'perf') {
    const [jobs, sys] = await Promise.all([api('/api/jobs'), api('/api/system')]);
    const w = sys.warmup;
    mount(sec, h('div.grid.g2',
      panel('Фонові задачі', field('Скільки задач навчання виконувати одночасно', select([[1, '1 — по черзі (рекомендовано для 8 ГБ ОЗП)'], [2, '2 — паралельно (16 ГБ+)']], s.workers, v => set('workers', +v)))),
      panel('Прогрів після запуску', check('Завантажувати бібліотеки й MiniLM у фоні одразу після старту', s.warmup, v => set('warmup', v)),
        h('p.small', w.done ? `Завершено за ${Math.round(w.seconds)} с` : w.started ? 'Триває…' : 'Не запускався'),
        table([[r => r[0], 'Компонент'], [r => r[1], 'Стан']], Object.entries(w.status || {}), { scroll: false }))),
    h('h2', 'Задачі цього сеансу'),
    jobs.length ? table([[j => j.module.toUpperCase(), 'Модуль'], ['title', 'Задача'], ['status', 'Стан'], [j => Math.round(j.progress * 100) + ' %', 'Прогрес'], [j => Math.round(j.elapsed) + ' с', 'Тривалість']], jobs) : alert('Задач ще не було.'));
  } else if (cur === 'data') {
    const sys = await api('/api/system');
    const clear = (what, q) => async () => { if (confirm(q)) { await api('/api/system/clear/' + what, { method: 'POST' }); toast('Готово'); ctx.go('data'); render(root, ctx); } };
    mount(sec, table([[r => r[0], 'Папка'], [r => r[1] + ' МБ', 'Розмір']], Object.entries(sys.folders), { scroll: false }),
      h('div.row', { style: { marginTop: '14px' } }, btn('Очистити кеш ембеддингів', clear('cache', 'Очистити кеш ембеддингів?')),
        btn('Очистити графіки й відео', clear('figs', 'Видалити збережені графіки й відео?')),
        btn('Очистити журнал експериментів', clear('results', 'Видалити ВСІ результати експериментів? Це не можна скасувати.'), 'danger')));
  } else {
    mount(sec, loading());
    const sys = await api('/api/system');
    mount(sec, h('p', `GPU: ${sys.gpu === null ? 'перевірка…' : sys.gpu ? 'є' : 'немає'}`),
      h('div.grid.g2', panel('Бібліотеки', table([[r => r[0], 'Бібліотека'], [r => r[1] || h('span.c-er', 'не встановлено'), 'Версія']], Object.entries(sys.libs), { scroll: false })),
        panel('Модулі', table([[c => c.title, 'Модуль'], [c => c.missing.length ? h('span.c-er', c.missing.join(', ')) : h('span.c-ok', 'OK'), 'Бібліотеки'],
          [c => c.cached ? h('span.c-ok', 'OK') : h('span.c-wr', 'немає'), 'Готова модель']], sys.cards, { scroll: false }),
        h('p.small.muted', 'Бракує бібліотек або моделей — повторно запустіть INSTALL.bat: він докачає лише відсутнє.'))));
  }
}
