-- =====================================================================
-- Представлення та ролі. Дати рахуються за київським часом (п. 2.1.1 Порядку).
-- =====================================================================

SET timezone = 'Europe/Kyiv';

-- ---------- Модуль A ----------

CREATE VIEW v_air_daily AS
SELECT (s.occurred_at AT TIME ZONE 'Europe/Kyiv')::date AS day,
       w.code AS weapon, w.category,
       COUNT(*)            AS events,
       SUM(s.launched)     AS launched,
       SUM(s.intercepted)  AS intercepted,
       SUM(s.suppressed)   AS suppressed,
       SUM(s.hits)         AS hits
FROM strike_events s JOIN weapon_types w ON w.id = s.weapon_type_id
GROUP BY 1, 2, 3;

CREATE VIEW v_air_oblast AS
SELECT o.iso_code, o.name_ua,
       COUNT(s.id)                       AS events,
       COALESCE(SUM(s.launched), 0)      AS launched,
       COALESCE(SUM(s.intercepted), 0)   AS intercepted,
       COALESCE(SUM(s.hits), 0)          AS hits
FROM oblasts o LEFT JOIN strike_events s ON s.oblast_id = o.id
GROUP BY o.iso_code, o.name_ua;

CREATE VIEW v_alert_summary AS
SELECT o.iso_code, o.name_ua, a.alert_type,
       COUNT(*) AS alerts,
       ROUND(SUM(COALESCE(a.duration_min, 0)) / 60.0, 1) AS hours
FROM air_alerts a JOIN oblasts o ON o.id = a.oblast_id
GROUP BY 1, 2, 3;

-- ---------- Модуль B ----------

CREATE VIEW v_art_daily AS
SELECT (occurred_at AT TIME ZONE 'Europe/Kyiv')::date AS day,
       direction, system_type,
       COUNT(*) AS shellings, SUM(rounds) AS rounds
FROM artillery_fire
GROUP BY 1, 2, 3;

CREATE VIEW v_art_hour_weekday AS
SELECT EXTRACT(ISODOW FROM occurred_at AT TIME ZONE 'Europe/Kyiv')::int AS weekday,  -- 1 = понеділок
       EXTRACT(HOUR   FROM occurred_at AT TIME ZONE 'Europe/Kyiv')::int AS hour,
       COUNT(*) AS shellings, SUM(rounds) AS rounds
FROM artillery_fire
WHERE direction = 'incoming'
GROUP BY 1, 2;

-- ---------- Модуль C ----------

CREATE VIEW v_losses_daily AS
SELECT report_date AS day,
       SUM(killed) AS killed, SUM(wounded) AS wounded,
       SUM(missing) AS missing, SUM(returned_to_duty) AS returned_to_duty
FROM personnel_losses
GROUP BY 1;

CREATE VIEW v_losses_by_cause AS
SELECT cause, SUM(killed) AS killed, SUM(wounded) AS wounded, SUM(missing) AS missing
FROM personnel_losses
GROUP BY 1;

CREATE VIEW v_losses_by_unit AS
SELECT u.short_name, u.echelon, p.report_date AS day,
       SUM(p.killed) AS killed, SUM(p.wounded) AS wounded, SUM(p.missing) AS missing
FROM personnel_losses p JOIN units u ON u.id = p.unit_id
GROUP BY 1, 2, 3;

-- ---------- Модуль D ----------

CREATE VIEW v_docs_hourly AS
SELECT EXTRACT(HOUR FROM received_at AT TIME ZONE 'Europe/Kyiv')::int AS hour,
       urgency, COUNT(*) AS docs
FROM incoming_documents
GROUP BY 1, 2;

CREATE VIEW v_docs_sla AS
SELECT d.urgency, n.name_ua, n.norm_min, n.sort_order,
       COUNT(*) AS docs,
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY d.processing_min) AS median_min,
       PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY d.processing_min) AS p90_min,
       ROUND(100.0 * AVG(CASE WHEN d.due_at < COALESCE(d.completed_at, now()) THEN 1 ELSE 0 END), 2) AS overdue_pct
FROM incoming_documents d JOIN doc_sla_norms n ON n.urgency = d.urgency
GROUP BY d.urgency, n.name_ua, n.norm_min, n.sort_order;

-- ---------- Поточний момент даних ----------
-- «Станом на»: дата генерації або пізніший запис, внесений через дашборд/імпорт.
CREATE VIEW v_as_of AS
SELECT GREATEST(
  (SELECT value::timestamptz FROM dataset_meta WHERE key = 'data_as_of'),
  COALESCE((SELECT MAX(occurred_at) FROM strike_events WHERE origin <> 'synthetic'), '-infinity'),
  COALESCE((SELECT MAX(occurred_at) FROM artillery_fire WHERE origin <> 'synthetic'), '-infinity'),
  COALESCE((SELECT MAX(started_at) FROM air_alerts WHERE origin <> 'synthetic'), '-infinity'),
  COALESCE((SELECT MAX(report_date)::timestamptz FROM personnel_losses WHERE origin <> 'synthetic'), '-infinity'),
  COALESCE((SELECT MAX(COALESCE(responded_at, detected_at)) FROM counter_battery WHERE origin <> 'synthetic'), '-infinity'),
  COALESCE((SELECT MAX(report_date)::timestamptz FROM ammo_supply WHERE origin <> 'synthetic'), '-infinity'),
  COALESCE((SELECT MAX(report_date)::timestamptz FROM artillery_equipment WHERE origin <> 'synthetic'), '-infinity'),
  COALESCE((SELECT MAX(report_date)::timestamptz FROM unit_strength WHERE origin <> 'synthetic'), '-infinity'),
  COALESCE((SELECT MAX(GREATEST(received_at, COALESCE(completed_at, received_at))) FROM incoming_documents
            WHERE origin <> 'synthetic'), '-infinity')
) AS as_of;

-- ---------- Ролі ----------
-- Ролі кластерні, тому створюються лише якщо їх ще немає.
-- dashboard_ro — читання (дашборд), dashboard_rw — внесення записів через форму/імпорт (лише INSERT/DELETE фактів).
-- Паролі збігаються з DB_RO_PASSWORD / DB_RW_PASSWORD у .env.example (локальний навчальний стенд).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_owner') THEN
    CREATE ROLE dashboard_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_ro') THEN
    CREATE ROLE dashboard_ro LOGIN PASSWORD 'dashboard_ro_local';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_rw') THEN
    CREATE ROLE dashboard_rw LOGIN PASSWORD 'dashboard_rw_local';
  END IF;
END $$;

GRANT ALL ON ALL TABLES IN SCHEMA public TO dashboard_owner;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dashboard_owner;
GRANT USAGE ON SCHEMA public TO dashboard_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dashboard_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO dashboard_ro;

-- Внесення даних: лише таблиці фактів і підрозділи; видаляти API дозволяє тільки origin <> 'synthetic'
GRANT USAGE ON SCHEMA public TO dashboard_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dashboard_rw;
GRANT INSERT, DELETE ON strike_events, air_alerts, artillery_fire, personnel_losses, incoming_documents, units,
  counter_battery, ammo_supply, artillery_equipment, unit_strength TO dashboard_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dashboard_rw;
