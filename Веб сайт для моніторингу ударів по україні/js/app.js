import { initMap, resizeMap } from './map.js';
import { startAlertsPolling } from './alerts.js';
import { store } from './state.js';
import { initFeed } from './feed.js';
import { initArchive } from './archive.js';
import { initStats } from './stats.js';
import { initNews } from './news.js';

const initialized = { stats: false, news: false, archive: false };

function initClock() {
  const el = document.getElementById('clock');
  const tick = () => {
    el.textContent = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  tick();
  setInterval(tick, 1000);
}

function initTabs() {
  const buttons = document.querySelectorAll('nav.tabs button');
  const views = document.querySelectorAll('.view');

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.view;

      buttons.forEach((b) => b.classList.toggle('active', b === btn));
      views.forEach((v) => v.classList.toggle('active', v.id === `view-${target}`));

      if (target === 'dashboard') resizeMap();
      if (target === 'stats' && !initialized.stats) { initStats(); initialized.stats = true; }
      if (target === 'news' && !initialized.news) { initNews(); initialized.news = true; }
      if (target === 'archive' && !initialized.archive) { initArchive(); initialized.archive = true; }
    });
  });
}

function initAlertsStatusUI() {
  const dot = document.getElementById('conn-dot');
  const banner = document.getElementById('alerts-config-banner');
  const aboutStatus = document.getElementById('about-alerts-status');

  const render = () => {
    const s = store.alertsStatus;

    if (s.configured) {
      dot.style.background = '#0ca30c';
      dot.style.boxShadow = '0 0 0 3px rgba(12,163,12,0.18)';
      banner.style.display = 'none';
      if (aboutStatus) aboutStatus.textContent = '✅ Токен налаштовано, тривоги отримуються з alerts.in.ua.';
    } else {
      dot.style.background = '#fab219';
      dot.style.boxShadow = '0 0 0 3px rgba(250,178,25,0.18)';
      banner.style.display = 'block';
      banner.innerHTML = `⚠ <strong>Реальні тривоги не підключено.</strong> ${escapeHtml(s.message || 'Токен alerts.in.ua не налаштовано.')} Деталі — на вкладці «Про проєкт».`;
      if (aboutStatus) aboutStatus.textContent = `⚠ Поточний стан: ${s.message || 'токен не налаштовано'}`;
    }
  };

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  store.addEventListener('alerts-status:changed', render);
  render();
}

async function main() {
  initClock();
  initTabs();
  initAlertsStatusUI();

  await initMap();       // наповнює store.oblasts із GeoJSON
  initFeed();
  startAlertsPolling();  // реальні тривоги з alerts.in.ua (через /api/alerts)
}

main();
