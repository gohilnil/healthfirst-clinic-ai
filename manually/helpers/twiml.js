'use strict';

/**
 * helpers/twiml.js
 * TwiML response builders for Twilio Voice.
 *
 * Voice: Polly.Joanna (AWS Polly via Twilio — sounds natural, free in trial)
 * Alternative: 'alice' (Twilio built-in, always free)
 * Set TWILIO_VOICE env var to switch. Defaults to 'Polly.Joanna'.
 *
 * Twilio recording settings:
 * - maxLength: 30s per turn (enough for medical descriptions)
 * - timeout: 4s silence before recording stops
 * - playBeep: false (natural conversation)
 * - transcribe: false (we use Groq Whisper instead)
 *
 * <Gather> with digits="0" allows patient to press 0 for a human at any time.
 */

const VOICE = process.env.TWILIO_VOICE || 'Polly.Joanna';
const RECORD_MAX_LENGTH = parseInt(process.env.RECORD_MAX_LENGTH || '30', 10);
const RECORD_TIMEOUT = parseInt(process.env.RECORD_TIMEOUT || '4', 10);

/**
 * Escapes characters that would break XML.
 */
function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Main TwiML builder used in the conversation loop.
 *
 * @param {string} speechText - What Maya says
 * @param {string|null} actionUrl - Where Twilio posts the next recording (null = hangup)
 * @param {boolean} hangup - Whether to hang up after speaking
 * @returns {string} - Valid TwiML XML string
 */
function buildTwiML(speechText, actionUrl, hangup = false) {
  const safeText = escapeXml(speechText);

  if (hangup || !actionUrl) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${VOICE}" language="en-US">${safeText}</Say>
  <Hangup/>
</Response>`;
  }

  // Active conversation turn: speak then record next patient response.
  // Also wrap in a <Gather> to catch "0" for human escalation.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${VOICE}" language="en-US">${safeText}</Say>
  <Record
    action="${escapeXml(actionUrl)}"
    method="POST"
    maxLength="${RECORD_MAX_LENGTH}"
    timeout="${RECORD_TIMEOUT}"
    playBeep="false"
    transcribe="false"
    finishOnKey="#"
  />
  <Say voice="${VOICE}" language="en-US">I didn't receive a response. Goodbye.</Say>
  <Hangup/>
</Response>`;
}

/**
 * Initial greeting TwiML — same as buildTwiML but announces 0-for-human option.
 * Called once at call start from /call/incoming.
 */
function buildGreetingTwiML(speechText, actionUrl) {
  const safeText = escapeXml(speechText);
  const safeAction = escapeXml(actionUrl);
  const reminder = escapeXml(' At any time, press zero to speak with a staff member.');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${VOICE}" language="en-US">${safeText}${reminder}</Say>
  <Record
    action="${safeAction}"
    method="POST"
    maxLength="${RECORD_MAX_LENGTH}"
    timeout="${RECORD_TIMEOUT}"
    playBeep="false"
    transcribe="false"
    finishOnKey="#"
  />
  <Say voice="${VOICE}" language="en-US">I didn't receive a response. Goodbye.</Say>
  <Hangup/>
</Response>`;
}

/**
 * Emergency TwiML — plays immediately on emergency keyword detection.
 * In production: replace <Hangup/> with <Dial> to clinic emergency line.
 */
function buildEmergencyTwiML() {
  const message = escapeXml(
    'This sounds like a medical emergency. Please hang up immediately and dial 9 1 1. ' +
    'If you cannot do that, stay on the line. I am alerting clinic staff right now. ' +
    'You are not alone. Please call 9 1 1 immediately.'
  );

  // In production: add <Dial>+1CLINICEMERGENCYLINE</Dial> before <Hangup/>
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${VOICE}" language="en-US" loop="1">${message}</Say>
  <Hangup/>
</Response>`;
}

/**
 * Error TwiML — used when backend encounters unexpected errors.
 * Always returns valid XML so Twilio doesn't read an error page aloud.
 */
function buildErrorTwiML() {
  const message = escapeXml(
    'I apologise, I\'m experiencing a technical issue right now. ' +
    'Please call back in a few minutes or visit the clinic in person. Thank you.'
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${VOICE}" language="en-US">${message}</Say>
  <Hangup/>
</Response>`;
}

module.exports = {
  buildTwiML,
  buildGreetingTwiML,
  buildEmergencyTwiML,
  buildErrorTwiML,
};
