// Реєстрація шрифтів для Chart.js (v4).
// Canvas не чекає на @font-face, тому графіки малюємо лише після document.fonts.load(),
// а вже створені — перемальовуємо (документація Chart.js, «Loading Fonts»).

// Volja = UAF Sans (фірмовий шрифт). Системний шрифт у стеку підставляє відсутні гліфи (% + тощо).
export const FONT_BODY = '"Volja", "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';
export const FONT_DISPLAY = FONT_BODY;

const FACES = ['400 16px "Volja"', '900 16px "Volja"'];

export async function loadChartFonts(Chart, timeoutMs = 3000) {
  if (document.fonts) {
    const loads = FACES.map((f) => document.fonts.load(f).catch(() => []));
    // Не блокуємо дашборд, якщо шрифт не завантажився: малюємо із запасним.
    await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, timeoutMs))]);
  }
  applyChartTheme(Chart);
  Object.values(Chart.instances || {}).forEach((c) => c.update('none'));
}

// Викликається також при зміні теми: кольори беруться з CSS-токенів.
export function applyChartTheme(Chart) {
  const css = getComputedStyle(document.documentElement);
  const v = (n, d) => css.getPropertyValue(n).trim() || d;
  Chart.defaults.font.family = FONT_BODY;
  Chart.defaults.font.size = 12;            // осі й легенди: 12 px (ТЗ §9.2)
  Chart.defaults.color = v('--text-muted', '#5c5444');
  Chart.defaults.borderColor = v('--grid', '#e4dfd2');
  Chart.defaults.plugins.legend.labels.font = { family: FONT_BODY, size: 12 };
  Chart.defaults.plugins.tooltip.titleFont = { family: FONT_BODY, size: 12, weight: '600' };
  Chart.defaults.plugins.tooltip.bodyFont = { family: FONT_BODY, size: 12 };
  Chart.defaults.plugins.tooltip.backgroundColor = v('--tooltip-bg', '#2b2619');
  Chart.defaults.plugins.tooltip.titleColor = v('--tooltip-fg', '#fff');
  Chart.defaults.plugins.tooltip.bodyColor = v('--tooltip-fg', '#fff');
}
