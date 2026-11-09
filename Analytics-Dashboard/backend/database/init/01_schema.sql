-- =====================================================================
-- Аналітичний дашборд оперативної обстановки. Схема БД (PostgreSQL 16).
-- Синтетичні дані (origin = 'synthetic') + записи, внесені через дашборд (origin = 'manual' / 'import').
-- Навчальний проєкт. «По навчанню».
-- =====================================================================

SET client_encoding = 'UTF8';
SET timezone = 'Europe/Kyiv';

-- ---------- Довідники ----------

CREATE TABLE oblasts (
  id SMALLSERIAL PRIMARY KEY,
  iso_code VARCHAR(6) NOT NULL UNIQUE,
  name_ua VARCHAR(64) NOT NULL,
  name_en VARCHAR(64) NOT NULL,
  center_lat NUMERIC(8,5) NOT NULL,
  center_lon NUMERIC(8,5) NOT NULL,
  is_frontline BOOLEAN NOT NULL DEFAULT FALSE,
  is_occupied  BOOLEAN NOT NULL DEFAULT FALSE
);

-- Умовні (вигадані) підрозділи
CREATE TABLE units (
  id SMALLSERIAL PRIMARY KEY,
  short_name VARCHAR(32) NOT NULL UNIQUE,
  name_ua    VARCHAR(128) NOT NULL,
  echelon    VARCHAR(12) NOT NULL CHECK (echelon IN
             ('command','corps','brigade','regiment','battalion','company')),
  branch     VARCHAR(16) NOT NULL CHECK (branch IN
             ('mech','tank','artillery','air_defense','airborne','support','hq','recon','marine',
              'training','signal','engineer','maintenance','medical')),
  parent_id  SMALLINT REFERENCES units(id),
  oblast_id  SMALLINT NOT NULL REFERENCES oblasts(id),
  lat NUMERIC(8,5) NOT NULL,
  lon NUMERIC(8,5) NOT NULL,
  sidc       VARCHAR(20) NOT NULL,
  is_rear    BOOLEAN NOT NULL DEFAULT FALSE,
  is_command_post BOOLEAN NOT NULL DEFAULT FALSE,   -- пункт управління, що приймає документи (ОКП/КП)
  origin VARCHAR(10) NOT NULL DEFAULT 'synthetic' CHECK (origin IN ('synthetic','manual','import'))
);

-- Підрозділи противника: відкриті дані DeepStateMap (db/sources/deepstate.json)
CREATE TABLE enemy_units (
  id SMALLSERIAL PRIMARY KEY,
  name_ua VARCHAR(160) NOT NULL,
  label   VARCHAR(24) NOT NULL,                     -- скорочення для поля T
  branch  VARCHAR(16) NOT NULL,
  echelon VARCHAR(12) NOT NULL CHECK (echelon IN ('army','corps','division','brigade','regiment','battalion','unknown')),
  sidc    VARCHAR(20) NOT NULL,
  lat NUMERIC(8,5) NOT NULL,
  lon NUMERIC(8,5) NOT NULL,
  source  VARCHAR(64) NOT NULL,
  as_of   VARCHAR(32) NOT NULL
);

CREATE TABLE weapon_types (
  id SMALLSERIAL PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name_ua VARCHAR(64) NOT NULL,
  category VARCHAR(24) NOT NULL CHECK (category IN
           ('uav','cruise_missile','ballistic_missile','guided_bomb')),
  sidc VARCHAR(20) NOT NULL,                      -- знак місця ураження (наказ № 140, п. 6.12)
  color_hex CHAR(7) NOT NULL,
  map_label VARCHAR(8) NOT NULL                   -- власне скорочення на карті (п. 2.2.16)
);

CREATE TABLE target_categories (
  id SMALLSERIAL PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name_ua VARCHAR(64) NOT NULL
);

-- Джерела інформації (п. 2.2.15 Порядку)
CREATE TABLE info_sources (
  code VARCHAR(8) PRIMARY KEY,
  name_ua VARCHAR(80) NOT NULL
);

-- Умовні нормативи часу обробки документів ОКП (замовник підтвердив, що поки вони умовні)
CREATE TABLE doc_sla_norms (
  urgency VARCHAR(12) PRIMARY KEY CHECK (urgency IN ('horizon','efir','buran','zlit','none')),
  name_ua VARCHAR(24) NOT NULL,
  norm_min INT NOT NULL CHECK (norm_min > 0),
  sort_order SMALLINT NOT NULL,
  is_conditional BOOLEAN NOT NULL DEFAULT TRUE
);

-- Лінія зіткнення за DeepState: межа окупованої території; e_lat/e_lon — зсув у бік противника (для червоної лінії)
CREATE TABLE contact_line (
  seq SMALLINT PRIMARY KEY,
  segment SMALLINT NOT NULL DEFAULT 1,
  lat NUMERIC(8,5) NOT NULL,
  lon NUMERIC(8,5) NOT NULL,
  e_lat NUMERIC(8,5) NOT NULL,
  e_lon NUMERIC(8,5) NOT NULL
);

-- Метадані набору даних
CREATE TABLE dataset_meta (
  key VARCHAR(32) PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------- Модуль A: повітряні удари і тривоги ----------

CREATE TABLE attack_waves (
  id SERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at   TIMESTAMPTZ NOT NULL CHECK (ended_at >= started_at),
  title VARCHAR(128)
);

CREATE TABLE strike_events (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  oblast_id SMALLINT NOT NULL REFERENCES oblasts(id),
  weapon_type_id SMALLINT NOT NULL REFERENCES weapon_types(id),
  wave_id INT REFERENCES attack_waves(id),
  target_category_id SMALLINT REFERENCES target_categories(id),
  launched    INT NOT NULL CHECK (launched > 0),
  intercepted INT NOT NULL DEFAULT 0 CHECK (intercepted >= 0),
  suppressed  INT NOT NULL DEFAULT 0 CHECK (suppressed  >= 0),
  hits        INT NOT NULL DEFAULT 0 CHECK (hits        >= 0),
  damage_level SMALLINT NOT NULL DEFAULT 0 CHECK (damage_level BETWEEN 0 AND 3),
  info_source VARCHAR(8) REFERENCES info_sources(code),
  reliability CHAR(2) CHECK (reliability ~ '^[A-F][1-6]$'),
  lat NUMERIC(8,5) NOT NULL,
  lon NUMERIC(8,5) NOT NULL,
  is_synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  origin VARCHAR(10) NOT NULL DEFAULT 'synthetic' CHECK (origin IN ('synthetic','manual','import')),
  CHECK (intercepted + suppressed + hits <= launched)
);

CREATE TABLE air_alerts (
  id BIGSERIAL PRIMARY KEY,
  oblast_id SMALLINT NOT NULL REFERENCES oblasts(id),
  alert_type VARCHAR(24) NOT NULL CHECK (alert_type IN
             ('air_raid','artillery_shelling','urban_fights','chemical','nuclear')),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at   TIMESTAMPTZ CHECK (ended_at IS NULL OR ended_at > started_at),
  duration_min INT GENERATED ALWAYS AS (CASE WHEN ended_at IS NULL THEN NULL
               ELSE (EXTRACT(EPOCH FROM ended_at - started_at)/60)::INT END) STORED,
  is_synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  origin VARCHAR(10) NOT NULL DEFAULT 'synthetic' CHECK (origin IN ('synthetic','manual','import'))
);

-- ---------- Модуль B: артилерія ----------
-- incoming: lat/lon = виявлена вогнева позиція противника (АР, РЛР);
-- outgoing: lat/lon = ціль, по якій вели вогонь свої засоби; result = результат ураження цілі.

CREATE TABLE artillery_fire (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  direction  VARCHAR(8) NOT NULL CHECK (direction IN ('incoming','outgoing')),
  system_type VARCHAR(12) NOT NULL CHECK (system_type IN
              ('mortar','howitzer','gun','mlrs','tank')),
  caliber_class VARCHAR(8) NOT NULL CHECK (caliber_class IN ('light','medium','heavy')),
  caliber_mm SMALLINT,
  rounds INT NOT NULL CHECK (rounds > 0),
  oblast_id SMALLINT NOT NULL REFERENCES oblasts(id),
  unit_id   SMALLINT REFERENCES units(id),
  target_category_id SMALLINT REFERENCES target_categories(id),
  result VARCHAR(12) NOT NULL DEFAULT 'unknown' CHECK (result IN
         ('destroyed','damaged','suppressed','no_effect','unknown')),
  info_source VARCHAR(8) REFERENCES info_sources(code),
  reliability CHAR(2) CHECK (reliability ~ '^[A-F][1-6]$'),
  lat NUMERIC(8,5) NOT NULL,
  lon NUMERIC(8,5) NOT NULL,
  is_synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  origin VARCHAR(10) NOT NULL DEFAULT 'synthetic' CHECK (origin IN ('synthetic','manual','import'))
);

-- ---------- Модуль C: втрати (лише агрегати) ----------

CREATE TABLE personnel_losses (
  id BIGSERIAL PRIMARY KEY,
  report_date DATE NOT NULL,
  unit_id SMALLINT NOT NULL REFERENCES units(id),
  cause VARCHAR(12) NOT NULL CHECK (cause IN
        ('artillery','air_strike','uav','mine','small_arms','accident','other')),
  killed  INT NOT NULL DEFAULT 0 CHECK (killed  >= 0),
  wounded INT NOT NULL DEFAULT 0 CHECK (wounded >= 0),
  missing INT NOT NULL DEFAULT 0 CHECK (missing >= 0),
  returned_to_duty INT NOT NULL DEFAULT 0 CHECK (returned_to_duty >= 0),
  is_synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  origin VARCHAR(10) NOT NULL DEFAULT 'synthetic' CHECK (origin IN ('synthetic','manual','import')),
  UNIQUE (report_date, unit_id, cause)
);

-- ---------- Модуль D: документообіг ОКП ----------

CREATE TABLE incoming_documents (
  id BIGSERIAL PRIMARY KEY,
  reg_number VARCHAR(16) NOT NULL UNIQUE,
  doc_type VARCHAR(24) NOT NULL CHECK (doc_type IN
           ('combat_report','combat_order','directive','preliminary_order',
            'request','info_report','intel_summary','logistics_request')),
  urgency VARCHAR(12) NOT NULL REFERENCES doc_sla_norms(urgency),
  special_mark VARCHAR(16) CHECK (special_mark IN
           ('reverse_check','control','training','personal')),
  access_level VARCHAR(8) NOT NULL CHECK (access_level IN ('open','dsk','secret')),
  channel VARCHAR(16) NOT NULL CHECK (channel IN
           ('asu','sedo','sys002','sys001','courier','radio')),
  sender_unit_id SMALLINT NOT NULL REFERENCES units(id),
  recipient_unit_id SMALLINT NOT NULL REFERENCES units(id),   -- ОКП / КП, що прийняв документ
  received_at   TIMESTAMPTZ NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL,
  due_at        TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  status VARCHAR(12) NOT NULL CHECK (status IN ('new','in_work','done','returned')),
  processing_min INT GENERATED ALWAYS AS (CASE WHEN completed_at IS NULL THEN NULL
                 ELSE (EXTRACT(EPOCH FROM completed_at - received_at)/60)::INT END) STORED,
  is_synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  origin VARCHAR(10) NOT NULL DEFAULT 'synthetic' CHECK (origin IN ('synthetic','manual','import')),

  CHECK (registered_at >= received_at),
  CHECK (completed_at IS NULL OR completed_at >= registered_at),
  CHECK ((status IN ('done','returned')) = (completed_at IS NOT NULL))
);

-- ---------- Модуль B (доповнення): контрбатарейна боротьба ----------
-- Виявлена вогнева позиція противника і реакція своїх засобів (час реакції — від виявлення до відкриття вогню).
CREATE TABLE counter_battery (
  id BIGSERIAL PRIMARY KEY,
  detected_at TIMESTAMPTZ NOT NULL,
  detected_by VARCHAR(8) NOT NULL CHECK (detected_by IN ('radar','uav','sound','visual')),
  enemy_system VARCHAR(12) NOT NULL CHECK (enemy_system IN ('mortar','howitzer','gun','mlrs','tank')),
  caliber_mm SMALLINT,
  oblast_id SMALLINT NOT NULL REFERENCES oblasts(id),
  lat NUMERIC(8,5) NOT NULL,
  lon NUMERIC(8,5) NOT NULL,
  unit_id SMALLINT REFERENCES units(id),                 -- підрозділ, що відкрив вогонь у відповідь
  responded_at TIMESTAMPTZ,
  rounds INT CHECK (rounds > 0),
  result VARCHAR(12) NOT NULL DEFAULT 'unknown' CHECK (result IN
         ('destroyed','damaged','suppressed','no_effect','unknown','no_response')),
  info_source VARCHAR(8) REFERENCES info_sources(code),
  reliability CHAR(2) CHECK (reliability ~ '^[A-F][1-6]$'),
  reaction_min INT GENERATED ALWAYS AS (CASE WHEN responded_at IS NULL THEN NULL
               ELSE (EXTRACT(EPOCH FROM responded_at - detected_at)/60)::INT END) STORED,
  is_synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  origin VARCHAR(10) NOT NULL DEFAULT 'synthetic' CHECK (origin IN ('synthetic','manual','import')),
  CHECK (responded_at IS NULL OR responded_at >= detected_at),
  CHECK ((responded_at IS NULL) = (result = 'no_response'))
);

-- ---------- Модуль B (доповнення): боєприпаси (добове донесення підрозділу) ----------
CREATE TABLE ammo_supply (
  id BIGSERIAL PRIMARY KEY,
  report_date DATE NOT NULL,
  unit_id SMALLINT NOT NULL REFERENCES units(id),
  ammo_type VARCHAR(12) NOT NULL CHECK (ammo_type IN
            ('mortar_120','how_122','how_152','how_155','how_203','mlrs_122','mlrs_220','mlrs_300')),
  expended INT NOT NULL DEFAULT 0 CHECK (expended >= 0),   -- витрачено за добу
  received INT NOT NULL DEFAULT 0 CHECK (received >= 0),   -- надійшло за добу
  stock    INT NOT NULL CHECK (stock >= 0),                 -- залишок на кінець доби
  is_synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  origin VARCHAR(10) NOT NULL DEFAULT 'synthetic' CHECK (origin IN ('synthetic','manual','import')),
  UNIQUE (report_date, unit_id, ammo_type)
);

-- ---------- Модуль B (доповнення): стан артилерійського озброєння (щотижневе донесення) ----------
CREATE TABLE artillery_equipment (
  id BIGSERIAL PRIMARY KEY,
  report_date DATE NOT NULL,
  unit_id SMALLINT NOT NULL REFERENCES units(id),
  model VARCHAR(32) NOT NULL,                               -- зразок озброєння
  system_type VARCHAR(12) NOT NULL CHECK (system_type IN ('mortar','howitzer','gun','mlrs')),
  caliber_mm SMALLINT,
  total INT NOT NULL CHECK (total >= 0),                    -- за штатом у наявності
  operational INT NOT NULL CHECK (operational >= 0),        -- справні
  in_repair INT NOT NULL DEFAULT 0 CHECK (in_repair >= 0),  -- у ремонті
  lost INT NOT NULL DEFAULT 0 CHECK (lost >= 0),            -- втрачено безповоротно за тиждень
  is_synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  origin VARCHAR(10) NOT NULL DEFAULT 'synthetic' CHECK (origin IN ('synthetic','manual','import')),
  CHECK (operational + in_repair = total),
  UNIQUE (report_date, unit_id, model)
);

-- ---------- Модуль C (доповнення): укомплектованість особовим складом (добове донесення) ----------
-- Лише агрегати за підрозділом; без персональних даних.
CREATE TABLE unit_strength (
  id BIGSERIAL PRIMARY KEY,
  report_date DATE NOT NULL,
  unit_id SMALLINT NOT NULL REFERENCES units(id),
  authorized INT NOT NULL CHECK (authorized > 0),           -- за штатом
  present INT NOT NULL CHECK (present >= 0),                -- у наявності
  replenished INT NOT NULL DEFAULT 0 CHECK (replenished >= 0), -- прибуло поповнення за добу
  is_synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  origin VARCHAR(10) NOT NULL DEFAULT 'synthetic' CHECK (origin IN ('synthetic','manual','import')),
  UNIQUE (report_date, unit_id)
);

-- ---------- Індекси ----------
CREATE INDEX ix_cb_time            ON counter_battery (detected_at);
CREATE INDEX ix_cb_unit_time       ON counter_battery (unit_id, detected_at);
CREATE INDEX ix_ammo_date          ON ammo_supply (report_date);
CREATE INDEX ix_ammo_unit_date     ON ammo_supply (unit_id, report_date);
CREATE INDEX ix_eq_date            ON artillery_equipment (report_date);
CREATE INDEX ix_str_date           ON unit_strength (report_date);
CREATE INDEX ix_str_unit_date      ON unit_strength (unit_id, report_date);

CREATE INDEX ix_strike_time        ON strike_events (occurred_at);
CREATE INDEX ix_strike_oblast_time ON strike_events (oblast_id, occurred_at);
CREATE INDEX ix_alert_time         ON air_alerts (started_at);
CREATE INDEX ix_alert_oblast_time  ON air_alerts (oblast_id, started_at);
CREATE INDEX ix_art_time           ON artillery_fire (occurred_at);
CREATE INDEX ix_art_oblast_time    ON artillery_fire (oblast_id, occurred_at);
CREATE INDEX ix_art_unit_time      ON artillery_fire (unit_id, occurred_at);
CREATE INDEX ix_loss_date          ON personnel_losses (report_date);
CREATE INDEX ix_loss_unit_date     ON personnel_losses (unit_id, report_date);
CREATE INDEX ix_doc_received       ON incoming_documents (received_at);
CREATE INDEX ix_doc_unit_received  ON incoming_documents (sender_unit_id, received_at);
CREATE INDEX ix_doc_recipient    ON incoming_documents (recipient_unit_id, received_at);
CREATE INDEX ix_doc_open           ON incoming_documents (status) WHERE status IN ('new','in_work');
