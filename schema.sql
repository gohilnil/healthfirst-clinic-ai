-- ─── HealthFirst Clinic AI — PostgreSQL Schema ────────────────────────────────
-- Run this manually OR hit GET /setup-db after first deploy.
-- This file is idempotent — safe to run multiple times.

-- ─── Sessions ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id               SERIAL PRIMARY KEY,
  call_sid         VARCHAR(64)  UNIQUE NOT NULL,
  patient_phone    VARCHAR(30),
  stage            VARCHAR(20)  NOT NULL DEFAULT 'GREETING',
  turn_count       INTEGER      NOT NULL DEFAULT 0,
  silence_count    INTEGER      NOT NULL DEFAULT 0,
  patient_name     VARCHAR(120),
  symptom_summary  TEXT,
  urgency_level    VARCHAR(10)  DEFAULT 'normal',
  preferred_doctor VARCHAR(120),
  confirmed_slot_id INTEGER,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Call Message History ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS call_messages (
  id         SERIAL PRIMARY KEY,
  call_sid   VARCHAR(64)  NOT NULL,
  role       VARCHAR(12)  NOT NULL,  -- 'user', 'assistant', 'system'
  content    TEXT         NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_messages_sid
  ON call_messages(call_sid, created_at ASC);

-- ─── Doctors ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS doctors (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(120) NOT NULL,
  specialty  VARCHAR(120),
  phone      VARCHAR(30),
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Appointment Slots ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointment_slots (
  id            SERIAL PRIMARY KEY,
  doctor_id     INTEGER      REFERENCES doctors(id) ON DELETE CASCADE,
  slot_datetime TIMESTAMPTZ  NOT NULL,
  is_booked     BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_slots_available
  ON appointment_slots(is_booked, slot_datetime ASC);

-- ─── Booked Appointments ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id               SERIAL PRIMARY KEY,
  call_sid         VARCHAR(64),
  slot_id          INTEGER      REFERENCES appointment_slots(id),
  patient_name     VARCHAR(120),
  patient_phone    VARCHAR(30),
  symptom_summary  TEXT,
  urgency_level    VARCHAR(10)  DEFAULT 'normal',
  preferred_doctor VARCHAR(120),
  booked_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Seed: Doctors ────────────────────────────────────────────────────────────
INSERT INTO doctors (name, specialty) VALUES
  ('Dr. Priya Sharma',  'General Physician'),
  ('Dr. Rajesh Patel',  'Internal Medicine'),
  ('Dr. Anita Mehta',   'Family Medicine')
ON CONFLICT DO NOTHING;

-- ─── Seed: Slots (next 7 days, 4 slots/day/doctor) ───────────────────────────
-- Generates 9am, 11am, 2pm, 4pm slots for each doctor for the next 7 days.
INSERT INTO appointment_slots (doctor_id, slot_datetime)
SELECT
  d.id,
  (CURRENT_DATE + (gs.day || ' days')::INTERVAL + (h.hour || ' hours')::INTERVAL)
    AT TIME ZONE 'UTC'
FROM doctors d
CROSS JOIN generate_series(1, 7) AS gs(day)
CROSS JOIN (VALUES (9), (11), (14), (16)) AS h(hour)
ON CONFLICT DO NOTHING;

-- ─── Verify ───────────────────────────────────────────────────────────────────
-- Run these to check after setup:
-- SELECT COUNT(*) FROM doctors;           -- should be 3
-- SELECT COUNT(*) FROM appointment_slots; -- should be 84 (3 doctors x 7 days x 4 slots)
-- SELECT * FROM appointment_slots ORDER BY slot_datetime LIMIT 10;
