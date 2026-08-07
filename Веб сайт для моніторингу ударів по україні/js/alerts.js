// Реальні повітряні тривоги з офіційного API alerts.in.ua.
// Сервер (server.py) проксує /api/alerts і додає токен — сюди ходимо
// лише на свій же бекенд, самого токена фронтенд ніколи не бачить.
//
// API повертає список активних тривог (по областях і частково по
// районах/громадах). Ми зводимо це до стану "область у тривозі / ні"
// і на кожному опитуванні порівнюємо з попереднім станом, синтезуючи
// alert_start / alert_end події — решта застосунку (карта, стрічка,
// статистика) вже вміє їх показувати.

import { store, ALERT_TYPES } from './state.js';

const POLL_MS = 20000;

let activeByOblast = new Map(); // iso -> { alertType, startedAt }
let nameIndex = null;
let idCounter = 1;
let timer = null;

const nextId = () => `al_${Date.now()}_${idCounter++}`;

function normalize(name) {
  return (name || '')
    .toLowerCase()
    .replace('автономна республіка ', '')
    .replace('область', '')
    .replace('м. ', '')
    .replace(/[«»".]/g, '')
    .trim();
}

function buildNameIndex() {
  nameIndex = new Map();
  for (const o of store.oblasts) {
    nameIndex.set(normalize(o.name_ua), o.iso);
  }
}

function resolveOblastIso(alert) {
  if (!nameIndex) buildNameIndex();
  const candidates = [alert.location_oblast, alert.location_title, alert.location];
  for (const c of candidates) {
    if (!c) continue;
    const iso = nameIndex.get(normalize(c));
    if (iso) return iso;
  }
  return null;
}

function levelOf(alertType) {
  return ALERT_TYPES[alertType]?.level ?? 1;
}

async function poll() {
  let data;
  try {
    const res = await fetch('/api/alerts');
    data = await res.json();
  } catch {
    store.setAlertsStatus({
      configured: false,
      reason: 'network_error',
      message: 'Немає з’єднання з локальним сервером. Переконайтесь, що запущено server.py.',
    });
    scheduleNext();
    return;
  }

  store.setAlertsStatus({ configured: data.configured, reason: data.reason, message: data.message });

  if (!data.configured) {
    // Токен не налаштований/недійсний — активний стан не показуємо як "спокійно",
    // просто не генеруємо нових подій. UI сам показує банер "не налаштовано".
    scheduleNext();
    return;
  }

  const grouped = new Map();
  const unmatched = [];

  for (const a of data.alerts || []) {
    const iso = resolveOblastIso(a);
    const alertType = a.alert_type || a.alertType || 'air_raid';
    const startedAt = a.started_at || a.startedAt || new Date().toISOString();
    if (!iso) { unmatched.push(a); continue; }

    const prev = grouped.get(iso);
    if (!prev || levelOf(alertType) > levelOf(prev.alertType)) {
      grouped.set(iso, {
        alertType,
        startedAt: prev && prev.startedAt < startedAt ? prev.startedAt : startedAt,
      });
    } else {
      prev.startedAt = prev.startedAt < startedAt ? prev.startedAt : startedAt;
    }
  }

  if (unmatched.length) {
    // Діагностика на випадок, якщо назви областей у відповіді API
    // не збіглися з нашим довідником — не ламає UI, тільки лог.
    console.debug('[alerts] не вдалось зіставити область для:', unmatched.slice(0, 3));
  }

  const newEvents = [];
  const now = new Date().toISOString();

  for (const [iso, info] of grouped) {
    const prev = activeByOblast.get(iso);
    if (!prev || prev.alertType !== info.alertType) {
      newEvents.push({
        id: nextId(),
        timestamp: info.startedAt,
        oblastIso: iso,
        threatType: info.alertType,
        description: `${ALERT_TYPES[info.alertType]?.label ?? info.alertType} — дані alerts.in.ua`,
      });
    }
  }
  for (const [iso] of activeByOblast) {
    if (!grouped.has(iso)) {
      newEvents.push({
        id: nextId(),
        timestamp: now,
        oblastIso: iso,
        threatType: 'alert_end',
        description: 'Відбій тривоги — дані alerts.in.ua',
      });
    }
  }

  activeByOblast = grouped;

  if (newEvents.length) {
    newEvents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    store.addEvents(newEvents);
  }

  scheduleNext();
}

function scheduleNext() {
  timer = setTimeout(poll, POLL_MS);
}

export function startAlertsPolling() {
  poll();
}

export function stopAlertsPolling() {
  if (timer) clearTimeout(timer);
}
