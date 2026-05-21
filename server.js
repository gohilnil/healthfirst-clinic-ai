'use strict';

require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');

// Helpers
const { transcribeAudio } = require('./helpers/transcription');
const { getAIResponse } = require('./helpers/ai');
const { buildTwiML, buildGreetingTwiML, buildEmergencyTwiML, buildErrorTwiML } = require('./helpers/twiml');
const {
  initDb,
  getSession,
  createSession,
  updateSession,
  saveMessage,
  getHistory,
  getAvailableSlots,
  bookAppointment,
  getAllAppointments,
} = require('./helpers/db');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── PostgreSQL Pool ───────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ─── Constants ─────────────────────────────────────────────────────────────────
const MAX_TURNS = parseInt(process.env.MAX_CALL_TURNS || '15', 10);

const EMERGENCY_KEYWORDS = [
  'chest pain', 'heart attack', 'stroke', 'cant breathe', "can't breathe",
  'not breathing', 'unconscious', 'passed out', 'overdose', 'suicide',
  'bleeding heavily', 'severe bleeding', 'dying', 'emergency', 'ambulance',
  'collapsed', 'seizure', 'choking',
];

// ─── Basic Routes ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: 'HealthFirst Clinic AI Receptionist',
    version: '1.0.0',
    status: 'live',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

// ─── DB Setup Route ────────────────────────────────────────────────────────────
app.get('/setup-db', async (req, res) => {
  try {
    await initDb(pool);
    res.json({ status: 'ok', message: 'Database schema initialised successfully.' });
  } catch (err) {
    console.error('DB setup error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── Appointments REST API ─────────────────────────────────────────────────────
app.get('/api/appointments', async (req, res) => {
  try {
    const rows = await getAllAppointments(pool);
    res.json({ status: 'ok', count: rows.length, appointments: rows });
  } catch (err) {
    console.error('GET /api/appointments error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/book', async (req, res) => {
  const { patient_name, patient_phone, symptom_summary, slot_id } = req.body;
  if (!patient_name || !slot_id) {
    return res.status(400).json({ status: 'error', message: 'patient_name and slot_id are required.' });
  }
  try {
    const appt = await bookAppointment(pool, null, {
      patient_name,
      patient_phone: patient_phone || '',
      symptom_summary: symptom_summary || '',
      preferred_doctor: '',
      slot_id: parseInt(slot_id, 10),
    });
    res.json({ status: 'ok', appointment: appt });
  } catch (err) {
    console.error('POST /api/book error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── Twilio: Incoming Call ─────────────────────────────────────────────────────
// Twilio webhook: configure as POST https://your-railway-url/call/incoming
app.post('/call/incoming', async (req, res) => {
const callSid = req.body.CallSid || `test-${Date.now()}`;
const callerPhone = req.body.From || '';

  try {
    // Create fresh session for this call
    await createSession(pool, callSid, callerPhone);

    // Save initial system context
    await saveMessage(pool, callSid, 'system',
      'New call started. Patient has not yet spoken. Begin with a warm greeting.');

    const twiml = buildGreetingTwiML(
      'Thank you for calling HealthFirst Clinic. My name is Maya and I\'m your AI receptionist. ' +
      'How can I help you today?',
      `/call/speech?callSid=${callSid}`
    );

    res.type('text/xml').send(twiml);
  } catch (err) {
    console.error('Incoming call error:', err);
    res.type('text/xml').send(buildErrorTwiML());
  }
});

// ─── Twilio: Speech Handler (Main Conversation Loop) ──────────────────────────
// Twilio posts here after every recording
app.post('/call/speech', async (req, res) => {
  const callSid = req.query.callSid || req.body.CallSid;
  const recordingUrl = req.body.RecordingUrl;
  const recordingStatus = req.body.RecordingStatus;
  const digits = req.body.Digits; // pressed 0 for human

  // Handle "press 0 for human" escape hatch
  if (digits === '0') {
    return res.type('text/xml').send(
      buildTwiML(
        'Please hold while I connect you to a staff member.',
        null,
        true // hangup — in production, replace with <Dial> to clinic phone
      )
    );
  }

  if (!callSid) {
    return res.type('text/xml').send(buildErrorTwiML());
  }

  try {
    // 1. Load session
    let session = await getSession(pool, callSid);
    if (!session) {
      // Failsafe: recreate if missing
      session = await createSession(pool, callSid, req.body.From || '');
    }

    // 2. Transcribe audio
    let userText = '';
    if (recordingStatus === 'completed' && recordingUrl) {
      try {
        userText = await transcribeAudio(recordingUrl + '.mp3');
      } catch (transcribeErr) {
        console.error('Transcription failed:', transcribeErr.message);
        userText = '';
      }
    }

    // 3. Handle silence / unclear speech (max 2 retries)
    if (!userText || userText.trim().length < 2) {
      const silenceCount = (session.silence_count || 0) + 1;
      await updateSession(pool, callSid, { silence_count: silenceCount });

      if (silenceCount >= 3) {
        return res.type('text/xml').send(
          buildTwiML(
            "I'm having trouble hearing you. Please call us back or visit the clinic in person. Goodbye.",
            null,
            true
          )
        );
      }

      return res.type('text/xml').send(
        buildTwiML(
          "I'm sorry, I didn't catch that. Could you please repeat yourself?",
          `/call/speech?callSid=${callSid}`,
          false
        )
      );
    }

    // 4. Reset silence counter on successful transcription
    await updateSession(pool, callSid, { silence_count: 0 });

    // 5. Emergency keyword detection — BEFORE any LLM call
    const lowerText = userText.toLowerCase();
    const isEmergency = EMERGENCY_KEYWORDS.some(kw => lowerText.includes(kw));
    if (isEmergency) {
      await updateSession(pool, callSid, { stage: 'EMERGENCY' });
      await saveMessage(pool, callSid, 'user', userText);
      await saveMessage(pool, callSid, 'system', 'EMERGENCY DETECTED — call escalated');
      return res.type('text/xml').send(buildEmergencyTwiML());
    }

    // 6. Enforce max turns
    const newTurnCount = (session.turn_count || 0) + 1;
    if (newTurnCount > MAX_TURNS) {
      return res.type('text/xml').send(
        buildTwiML(
          'Thank you for your patience. I\'ve noted all the details. ' +
          'A staff member will call you back within 15 minutes. Goodbye.',
          null,
          true
        )
      );
    }

    // 7. Persist user message
    await saveMessage(pool, callSid, 'user', userText);

    // 8. Load full conversation history for LLM context
    const history = await getHistory(pool, callSid);

    // 9. Inject available slots into context if entering BOOKING stage
    let slotsContext = null;
    if (session.stage === 'TRIAGE' || session.stage === 'BOOKING') {
      const slots = await getAvailableSlots(pool);
      if (slots.length > 0) {
        slotsContext = slots
          .slice(0, 5)
          .map(s => `Dr. ${s.doctor_name} (${s.specialty}) — ${formatSlotDate(s.slot_datetime)}`)
          .join('; ');
      }
    }

    // 10. Call Groq LLM
    const aiResult = await getAIResponse(session, history, slotsContext);

    // 11. Execute state transitions and data extraction
    let updatedFields = {
      turn_count: newTurnCount,
    };

    if (aiResult.extracted) {
      if (aiResult.extracted.patient_name) updatedFields.patient_name = aiResult.extracted.patient_name;
      if (aiResult.extracted.symptom_summary) updatedFields.symptom_summary = aiResult.extracted.symptom_summary;
      if (aiResult.extracted.urgency_level) updatedFields.urgency_level = aiResult.extracted.urgency_level;
      if (aiResult.extracted.preferred_doctor) updatedFields.preferred_doctor = aiResult.extracted.preferred_doctor;
      if (aiResult.extracted.slot_id) updatedFields.confirmed_slot_id = aiResult.extracted.slot_id;
    }

    if (aiResult.transition) {
      updatedFields.stage = aiResult.transition;
    }

    await updateSession(pool, callSid, updatedFields);

    // 12. Book appointment when reaching DONE
    if (aiResult.transition === 'DONE' && session.stage === 'CONFIRMATION') {
      try {
        const sessionNow = await getSession(pool, callSid);
        if (sessionNow.confirmed_slot_id) {
          await bookAppointment(pool, callSid, sessionNow);
        }
      } catch (bookErr) {
        console.error('Booking error (non-fatal):', bookErr.message);
      }
    }

    // 13. Persist assistant reply
    await saveMessage(pool, callSid, 'assistant', aiResult.reply);

    // 14. Generate TwiML response
    const shouldHangup = aiResult.transition === 'DONE';
    const twiml = buildTwiML(
      aiResult.reply,
      shouldHangup ? null : `/call/speech?callSid=${callSid}`,
      shouldHangup
    );

    res.type('text/xml').send(twiml);

  } catch (err) {
    console.error('Speech handler error:', err);
    // Never leave the patient hanging — always return valid TwiML
    res.type('text/xml').send(
      buildTwiML(
        'I apologise, I\'m experiencing a technical issue. Please call back shortly or visit us in person. Goodbye.',
        null,
        true
      )
    );
  }
});

// ─── Utility ───────────────────────────────────────────────────────────────────
function formatSlotDate(dt) {
  if (!dt) return 'unknown time';
  const d = new Date(dt);
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

// ─── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HealthFirst AI running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'production'}`);
});

module.exports = app;
