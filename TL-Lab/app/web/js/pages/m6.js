// Модуль 06 — донавчання RL-агента PPO у зміненому середовищі (CartPole, Acrobot; фізика, вітер, шум датчиків).
import { h, api, mount, panel, alert, btn, loading, kpis, runCaption, plot, jobPanel, run, field, slider, select, tabs, termify, S, check, why, howto, steps, freezeTable } from '../ui.js';
import { modulePage, modelCard, noResult } from './_module.js';

export const render = (root, ctx) => modulePage(root, ctx, {
  key: 'm6', code: 'MOD-06', title: 'Донавчання RL-агента у зміненому середовищі', path: '~/modules/m6',
  sections: [['data', 'Модель і середовище'], ['adapt', 'Адаптація'], ['eval', 'Оцінювання'], ['demo', 'Демонстрація'], ['theory', 'Теорія']],
  render: { data, adapt, eval: evaluate, demo },
});

const ST = (() => { try { return JSON.parse(localStorage.getItem('m6') || 'null') || {}; } catch (e) { return {}; } })();
function save() { try { localStorage.setItem('m6', JSON.stringify(ST)); } catch (e) { /* */ } }
async function info() {
  const i = await api('/api/m6/info?env=' + (ST.env || 'cartpole'));
  ST.env = i.env;
  if (!ST.param || !(ST.param in i.defaults)) { ST.param = Object.keys(i.suggest)[0]; ST.value = i.suggest[ST.param]; }
  return i;
}
const cond = i => h('b', `${i.labels[ST.param]} = ${ST.value} (стандарт ${i.defaults[ST.param]})`);

async function data(sec, ctx) {
  const i = await info();
  const scanBox = h('div');
  const valInp = h('input', { type: 'number', step: 'any', value: ST.value, style: { width: '140px' } });
  valInp.addEventListener('change', () => { ST.value = +valInp.value; save(); });
  const drawScan = async () => {
    const r = await api('/api/m6/scan');
    if (!r.scan || r.env !== ST.env) { mount(scanBox); return; }
    const xs = Object.keys(r.scan).map(Number), ys = Object.values(r.scan);
    const [lo, hi] = r.range, base = ys[0], line = lo + 0.7 * (base - lo);
    mount(scanBox, panel('Як зміна параметра шкодить готовому агенту', plot([{ x: xs, y: ys, mode: 'lines+markers', line: { color: '#00e5ff' } },
      { x: [xs[0], xs[xs.length - 1]], y: [line, line], mode: 'lines', line: { dash: 'dash', color: '#ffb000' }, name: '−30 %' }],
    { xaxis: { title: r.label }, yaxis: { title: 'середня винагорода (5 еп.)' }, showlegend: false }, 300),
    h('p.small.muted', 'Оберіть значення, за якого винагорода падає щонайменше на 30 % (нижче жовтої лінії) — інакше донавчанню нічого показати.'), howto('rl_scan')));
  };
  const intro = h('p', 'Навчання з підкріпленням: агент діє в середовищі й отримує винагороду. Готовий агент PPO навчений у стандартних умовах. ' +
    'Ми змінюємо умови — агент «ламається» — і продовжуємо навчання в нових умовах, перевіряючи, чи не забув він старі.');
  termify(intro);
  mount(sec, intro,
    tabs(Object.entries(i.envs).map(([k, v]) => [k, v.title]), i.env, k => { ST.env = k; ST.param = null; save(); data(sec, ctx); }),
    h('div.grid.g2', modelCard(i.card), panel('Середовище і агент', h('p', i.envs[i.env].about),
      i.agent ? alert('Агент: ' + i.agent, 'ok') : h('div', alert('Готового агента немає (його завантажує INSTALL.bat). Можна створити резервного без Інтернету.', 'wr'),
        btn('Створити резервного агента (2–5 хв)', () => run('/api/m6/backup', { env: i.env }))))),
    h('h2', 'Що змінюємо'),
    h('div.panel', h('div.row',
      field('Параметр / сценарій', select(Object.entries(i.labels), ST.param, v => { ST.param = v; ST.value = i.suggest[v]; valInp.value = ST.value; save(); })),
      field('Нове значення', valInp), h('span.grow'),
      i.agent ? btn('Пошук параметра (ФВ-6.3)', () => run('/api/m6/scan', { env: i.env, param: ST.param })) : null),
    h('p.small.muted', 'Сценарії: фізика (довжина, маса), «вітер» — випадкові поштовхи, «шум датчиків» — агент бачить стан з похибкою. ' +
      'Рекомендовані значення підставляються автоматично.')),
    jobPanel('m6', drawScan), scanBox);
  save(); drawScan();
}

async function adapt(sec, ctx) {
  const i = await info();
  const tsteps = [10000, 20000, 30000, 50000, 100000];
  let ts = tsteps.includes(i.steps) ? i.steps : 50000;
  const curve = h('div');
  const drawCurve = async () => {
    const r = await api('/api/m6/eval');
    if (!r.curve || !r.curve.length) { mount(curve); return; }
    const xs = r.curve.map(c => c[0]), ys = r.curve.map(c => c[1]);
    const roll = ys.map((_, k) => { const a = ys.slice(Math.max(0, k - 19), k + 1); return a.reduce((s, v) => s + v, 0) / a.length; });
    mount(curve, panel('Крива навчання (останнє донавчання)', plot([{ x: xs, y: ys, mode: 'markers', marker: { size: 3, color: '#1c4a55' }, name: 'епізод' },
      { x: xs, y: roll, mode: 'lines', line: { color: '#00e5ff' }, name: 'середнє за 20' }], { xaxis: { title: 'крок' }, yaxis: { title: 'винагорода епізоду' } }, 300), howto('rl_curve')));
  };
  let cmp = false;
  mount(sec, h('div.panel.param',
    h('p', `Середовище ${i.envs[i.env].title}. Умови: `, cond(i), ' — змінити в розділі «Модель і середовище». ',
      'Оцінка на 20 епізодах з фіксованими seed до і після + контроль на стандартному середовищі.'),
    h('div.row', field('Кроків донавчання', slider(0, 4, 1, tsteps.indexOf(ts), v => { ts = tsteps[v]; }, v => tsteps[v].toLocaleString('uk'))), h('span.grow'),
      btn('▶ Запустити донавчання', () => run('/api/m6/train', { env: i.env, param: ST.param, value: ST.value, timesteps: ts, compare_frozen: cmp }), 'primary')),
    h('div.f', check('Порівняти з частковим донавчанням: тіло мережі заморожене, навчається лише останній шар (час ×2)', false, v => { cmp = v; }))),
  steps([
    'Береться **готовий агент PPO**, уже навчений у стандартному середовищі (з Hugging Face або резервний).',
    'Середовище **змінюється**: довша жердина, вітер, шум датчиків тощо. Агент перевіряється в ньому на 20 епізодах з однаковими стартами — це «до».',
    '**Донавчання**: агент далі грає вже в зміненому середовищі й за методом PPO підправляє свою нейромережу — що робити в кожному стані. Він не починає з нуля, а пристосовує готові навички.',
    'Якщо ввімкнено порівняння — те саме ще раз з **замороженим тілом** мережі: змінюється лише останній шар, що обирає дію.',
    'Перевірка «після» в зміненому середовищі + **контроль забування**: чи вміє агент ще діяти в стандартному.',
  ]),
  jobPanel('m6', drawCurve), curve);
  termify(sec);
  drawCurve();
}

async function evaluate(sec, ctx) {
  const r = await api('/api/m6/eval');
  if (!r.entry) { mount(sec, noResult(ctx, 'Ще немає результатів — запустіть донавчання.')); return; }
  const m = r.entry.metrics;
  const keys = ['baseline', 'adapted', 'original_env_before', 'original_env_after'];
  const names = ['Змінене: до', 'Змінене: після', 'Стандартне: до', 'Стандартне: після'];
  const env = r.entry.params.env || 'cartpole';
  mount(sec, runCaption(r.entry), kpis(m, ['mean_reward'], { mean_reward: 'Середня винагорода у зміненому середовищі' }), howto('kpi'),
    why(r.why),
    freezeTable(r.freeze, 'Винагорода у зміненому'),
    panel('Донавчання в нових умовах і контроль забування', plot([{ type: 'bar', x: names, y: keys.map(k => m[k].mean_reward),
      error_y: { type: 'data', array: keys.map(k => m[k].std_reward), color: '#b8f3ff' }, marker: { color: ['#ff3b5c', '#00e5ff', '#1c4a55', '#39ff9a'] } }],
    { yaxis: { title: 'середня винагорода ± СКВ', range: env === 'acrobot' ? [-520, 0] : [0, 520] } }, 380), howto('rl_bars')),
    h('p.small.muted', env === 'acrobot' ? 'Acrobot: винагорода від’ємна (−1 за крок), ближче до 0 — краще.' : 'CartPole: максимум 500 — жердина втримана весь епізод.'));
}

async function demo(sec) {
  const i = await info();
  const v = h('div');
  const drawVid = async () => {
    const r = await api('/api/m6/video?env=' + i.env);
    mount(v, r.url ? panel('Ліворуч — агент до донавчання, праворуч — після (однаковий старт, однаковий час)', h('div.imgbox', h('img', { src: r.url }))) : null);
  };
  mount(sec, 
    i.finetuned ? null : alert('Спершу виконайте донавчання в цьому середовищі.', 'wr'),
    h('p', `Умови: `, cond(i)),
    btn('🎬 Записати відео до / після', () => run('/api/m6/record', { env: i.env, param: ST.param, value: ST.value }), 'primary', { disabled: !i.finetuned || null }),
    jobPanel('m6', drawVid), v);
  drawVid();
}
