'use strict';

/**
 * helpers/db.js
 * All PostgreSQL database operations for HealthFirst AI.
 *
 * Conventions:
 * - All functions accept `pool` as first arg (no global state)
 * - All queries use parameterised $1,$2,... (no SQL injection)
 * - All functions are async and return plain objects or arrays
 * - Errors bubble up to callers — no silent swallowing
 */

// ─── Schema Init ───────────────────────────────────────────────────────────────

/**
 * Creates all required tables if they don't exist.
 * Safe to call multiple times (idempotent).
 * Call via GET /setup-db after first deploy.
 */
async function initDb(pool) {
  await pool.query(`
    -- Core call sessions
    CREATE TABLE IF NOT EXISTS sessions (
      id            SERIAL PRIMARY KEY,
      call_sid      VARCHAR(64) UNIQUE NOT NULL,
      patient_phone VARCHAR(30),
      stage         VARCHAR(20)  NOT NULL DEFAULT 'GREETING',
      turn_count    INTEGER      NOT NULL DEFAULT 0,
      silence_count INTEGER      NOT NULL DEFAULT 0,
      patient_name  VARCHAR(120),
      symptom_summary TEXT,
      urgency_level VARCHAR(10)  DEFAULT 'normal',
      preferred_doctor VARCHAR(120),
      confirmed_slot_id INTEGER,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );

    -- Per-call conversation message history
    CREATE TABLE IF NOT EXISTS call_messages (
      id         SERIAL PRIMARY KEY,
      call_sid   VARCHAR(64)  NOT NULL,
      role       VARCHAR(12)  NOT NULL,  -- 'user', 'assistant', 'system'
      content    TEXT         NOT NULL,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_call_messages_sid
      ON call_messages(call_sid, created_at ASC);

    -- Doctors (seed manually after setup)
    CREATE TABLE IF NOT EXISTS doctors (
      id           SERIAL PRIMARY KEY,
      name         VARCHAR(120) NOT NULL,
      specialty    VARCHAR(120),
      phone        VARCHAR(30),
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );

    -- Appointment slots (generate or seed manually)
    CREATE TABLE IF NOT EXISTS appointment_slots (
      id            SERIAL PRIMARY KEY,
      doctor_id     INTEGER REFERENCES doctors(id) ON DELETE CASCADE,
      slot_datetime TIMESTAMPTZ NOT NULL,
      is_booked     BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_slots_available
      ON appointment_slots(is_booked, slot_datetime ASC);

    -- Booked appointments (final confirmed bookings)
    CREATE TABLE IF NOT EXISTS appointments (
      id              SERIAL PRIMARY KEY,
      call_sid        VARCHAR(64),
      slot_id         INTEGER REFERENCES appointment_slots(id),
      patient_name    VARCHAR(120),
      patient_phone   VARCHAR(30),
      symptom_summary TEXT,
      urgency_level   VARCHAR(10) DEFAULT 'normal',
      preferred_doctor VARCHAR(120),
      booked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Seed demo doctors if none exist
  const { rows: existingDoctors } = await pool.query('SELECT id FROM doctors LIMIT 1');
  if (existingDoctors.length === 0) {
    await pool.query(`
      INSERT INTO doctors (name, specialty) VALUES
        ('Dr. Priya Sharma', 'General Physician'),
        ('Dr. Rajesh Patel', 'Internal Medicine'),
        ('Dr. Anita Mehta', 'Family Medicine')
      ON CONFLICT DO NOTHING;
    `);

    // Seed 7 days of sample slots (9am, 11am, 2pm, 4pm) for each doctor
    await pool.query(`
      INSERT INTO appointment_slots (doctor_id, slot_datetime)
      SELECT
        d.id,
        (NOW()::DATE + (gs.day || ' days')::INTERVAL + (h.hour || ' hours')::INTERVAL) AT TIME ZONE 'UTC'
      FROM doctors d
      CROSS JOIN generate_series(1, 7) AS gs(day)
      CROSS JOIN (VALUES (9), (11), (14), (16)) AS h(hour)
      WHERE d.name IN ('Dr. Priya Sharma', 'Dr. Rajesh Patel', 'Dr. Anita Mehta')
      ON CONFLICT DO NOTHING;
    `);
  }

  console.log('DB schema initialised.');
}

// ─── Sessions ──────────────────────────────────────────────────────────────────

async function getSession(pool, callSid) {
  const { rows } = await pool.query(
    'SELECT * FROM sessions WHERE call_sid = $1 LIMIT 1',
    [callSid]
  );
  return rows[0] || null;
}

async function createSession(pool, callSid, patientPhone) {
  const { rows } = await pool.query(
    `INSERT INTO sessions (call_sid, patient_phone, stage, turn_count, silence_count)
     VALUES ($1, $2, 'GREETING', 0, 0)
     ON CONFLICT (call_sid) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [callSid, patientPhone || '']
  );
  return rows[0];
}

/**
 * Updates arbitrary session fields.
 * @param {Object} fields - Key/value pairs matching column names
 */
async function updateSession(pool, callSid, fields) {
  if (!fields || Object.keys(fields).length === 0) return;

  // Allowed columns to prevent injection via field names
  const ALLOWED_COLUMNS = [
    'stage', 'turn_count', 'silence_count', 'patient_name', 'symptom_summary',
    'urgency_level', 'preferred_doctor', 'confirmed_slot_id',
  ];

  const setClauses = [];
  const values = [];
  let idx = 1;

  for (const [key, val] of Object.entries(fields)) {
    if (!ALLOWED_COLUMNS.includes(key)) continue;
    setClauses.push(`${key} = $${idx}`);
    values.push(val);
    idx++;
  }

  if (setClauses.length === 0) return;

  setClauses.push(`updated_at = NOW()`);
  values.push(callSid);

  await pool.query(
    `UPDATE sessions SET ${setClauses.join(', ')} WHERE call_sid = $${idx}`,
    values
  );
}

// ─── Messages ──────────────────────────────────────────────────────────────────

async function saveMessage(pool, callSid, role, content) {
  await pool.query(
    'INSERT INTO call_messages (call_sid, role, content) VALUES ($1, $2, $3)',
    [callSid, role, content]
  );
}

/**
 * Returns full conversation history for a call, ordered chronologically.
 * Limits to last 30 messages to stay within LLM context window.
 */
async function getHistory(pool, callSid) {
  const { rows } = await pool.query(
    `SELECT role, content FROM call_messages
     WHERE call_sid = $1
     ORDER BY created_at ASC
     LIMIT 30`,
    [callSid]
  );
  return rows;
}

// ─── Slots & Appointments ──────────────────────────────────────────────────────

/**
 * Returns next 5 available appointment slots with doctor info.
 * Only returns future slots.
 */
async function getAvailableSlots(pool, preferredDoctorName) {
  let query = `
    SELECT
      s.id,
      s.slot_datetime,
      d.name AS doctor_name,
      d.specialty
    FROM appointment_slots s
    JOIN doctors d ON s.doctor_id = d.id
    WHERE s.is_booked = FALSE
      AND s.slot_datetime > NOW()
  `;
  const params = [];

  if (preferredDoctorName) {
    query += ` AND d.name ILIKE $1`;
    params.push(`%${preferredDoctorName}%`);
  }

  query += ` ORDER BY s.slot_datetime ASC LIMIT 5`;

  const { rows } = await pool.query(query, params);
  return rows;
}

/**
 * Books an appointment in a transaction.
 * Marks the slot as booked and inserts into appointments table.
 *
 * @param {Object} sessionData - Session row with patient info and confirmed_slot_id
 */
async function bookAppointment(pool, callSid, sessionData) {
  const slotId = sessionData.confirmed_slot_id || sessionData.slot_id;
  if (!slotId) {
    throw new Error('bookAppointment: no slot_id provided');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the slot row to prevent double-booking
    const { rows: slotRows } = await client.query(
      'SELECT id, is_booked FROM appointment_slots WHERE id = $1 FOR UPDATE',
      [slotId]
    );

    if (slotRows.length === 0) {
      throw new Error(`Slot ${slotId} not found`);
    }
    if (slotRows[0].is_booked) {
      throw new Error(`Slot ${slotId} is already booked`);
    }

    // Mark slot as booked
    await client.query(
      'UPDATE appointment_slots SET is_booked = TRUE WHERE id = $1',
      [slotId]
    );

    // Insert appointment record
    const { rows: apptRows } = await client.query(
      `INSERT INTO appointments
         (call_sid, slot_id, patient_name, patient_phone, symptom_summary, urgency_level, preferred_doctor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        callSid,
        slotId,
        sessionData.patient_name || 'Unknown',
        sessionData.patient_phone || '',
        sessionData.symptom_summary || '',
        sessionData.urgency_level || 'normal',
        sessionData.preferred_doctor || '',
      ]
    );

    await client.query('COMMIT');
    console.log(`[Booking] Appointment created: id=${apptRows[0].id} slot=${slotId} patient=${sessionData.patient_name}`);
    return apptRows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Booking] Transaction failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Returns all appointments with doctor and slot details.
 */
async function getAllAppointments(pool) {
  const { rows } = await pool.query(`
    SELECT
      a.id,
      a.patient_name,
      a.patient_phone,
      a.symptom_summary,
      a.urgency_level,
      a.booked_at,
      s.slot_datetime,
      d.name AS doctor_name,
      d.specialty
    FROM appointments a
    LEFT JOIN appointment_slots s ON a.slot_id = s.id
    LEFT JOIN doctors d ON s.doctor_id = d.id
    ORDER BY a.booked_at DESC
    LIMIT 100
  `);
  return rows;
}

module.exports = {
  initDb,
  getSession,
  createSession,
  updateSession,
  saveMessage,
  getHistory,
  getAvailableSlots,
  bookAppointment,
  getAllAppointments,
};
