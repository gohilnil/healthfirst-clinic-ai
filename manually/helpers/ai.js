'use strict';

/**
 * helpers/ai.js
 * Groq LLM orchestration for the clinic receptionist.
 *
 * Model: llama-3.1-70b-versatile (free on Groq, fast, reliable JSON output)
 * Strategy: structured JSON output enforced via system prompt + response_format.
 * The AI extracts patient data AND produces the spoken reply in one call.
 */

const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const LLM_MODEL = 'llama-3.1-70b-versatile';
const MAX_TOKENS = 400; // Short responses = natural voice pacing

/**
 * Stage-specific instructions injected into the system prompt.
 * Each stage tells the AI exactly what to collect and when to transition.
 */
const STAGE_INSTRUCTIONS = {
  GREETING: `
You are in the GREETING stage.
- The patient has just called. Warmly greet them and ask for their name and reason for calling.
- Once you have their name AND a reason (however brief), set "transition" to "TRIAGE".
- Extract their name into extracted.patient_name.
- Keep this stage to 1-2 exchanges maximum.`,

  TRIAGE: `
You are in the TRIAGE stage.
- Ask about their symptoms: what they're experiencing, how long it's been happening, severity (1-10 scale).
- Ask ONE question at a time. Do not overwhelm the patient.
- After 2-4 turns of collecting symptom information, move to booking.
- If severity is 8 or higher, OR symptoms suggest urgency (high fever, severe pain, difficulty breathing), set urgency_level to "urgent".
- Set extracted.symptom_summary to a brief clinical summary of what you've learned.
- When you have enough symptom information, set "transition" to "BOOKING".`,

  BOOKING: `
You are in the BOOKING stage.
- You have the patient's symptoms. Now present 2-3 appointment options from the available slots provided.
- Present options clearly and conversationally — say the doctor's name, specialty, and day/time.
- Ask which option works for them, or if they have a preference.
- Once the patient picks a slot, extract the slot_id number into extracted.slot_id.
- Extract their preferred doctor into extracted.preferred_doctor.
- Set "transition" to "CONFIRMATION" once they have chosen.`,

  CONFIRMATION: `
You are in the CONFIRMATION stage.
- Read back the appointment clearly: doctor name, date, and time.
- Ask for explicit confirmation ("Does that work for you?").
- If they confirm (yes, sounds good, perfect, that works, etc.), set "transition" to "DONE".
- Also tell them to bring a valid ID and insurance card if applicable.
- If they want to change something, set "transition" to "BOOKING".`,

  DONE: `
You are in the DONE stage.
- Thank the patient warmly and confirm their appointment one final time with the key details.
- Tell them they can call back if they have questions.
- Say a natural goodbye.
- Set "transition" to "DONE".`,
};

/**
 * Builds the full system prompt for the current call state.
 */
function buildSystemPrompt(session, slotsContext) {
  const stage = session.stage || 'GREETING';
  const patientName = session.patient_name ? `Patient name: ${session.patient_name}` : 'Patient name: not yet collected';
  const turnInfo = `Current turn: ${session.turn_count || 0}`;

  const slotsSection = slotsContext
    ? `\n\nAVAILABLE APPOINTMENT SLOTS (use these in BOOKING stage):\n${slotsContext}`
    : '';

  return `You are Maya, the AI receptionist at HealthFirst Clinic. 
You are warm, professional, calm, and efficient.
You are speaking on a phone call — keep responses SHORT (2-4 sentences max).
Never use bullet points, lists, or markdown. Speak naturally as if talking on the phone.
Never say "As an AI" or break character. Never mention Groq or any technology.
If a patient sounds distressed, be extra calm and compassionate.

Call context:
- Stage: ${stage}
- ${patientName}
- ${turnInfo}
${slotsSection}

STAGE INSTRUCTIONS:
${STAGE_INSTRUCTIONS[stage] || STAGE_INSTRUCTIONS.GREETING}

CRITICAL: You MUST respond with ONLY a valid JSON object. No text before or after. No markdown.
The JSON must follow this exact schema:
{
  "reply": "Your spoken response to the patient (2-4 natural sentences, phone-appropriate)",
  "transition": null or one of: "TRIAGE", "BOOKING", "CONFIRMATION", "DONE",
  "extracted": {
    "patient_name": null or string,
    "symptom_summary": null or string,
    "urgency_level": null or "normal" or "urgent",
    "preferred_doctor": null or string,
    "slot_id": null or integer
  }
}

Only set "transition" when you are genuinely ready to move to the next stage.
Only populate "extracted" fields you actually learned in this turn or prior turns.
Set fields to null if not yet known — do not guess.`;
}

/**
 * Calls Groq LLM and returns parsed AI result.
 *
 * @param {Object} session - Current session row from PostgreSQL
 * @param {Array} history - Array of {role, content} message objects
 * @param {string|null} slotsContext - Formatted available slots string or null
 * @returns {Promise<{reply: string, transition: string|null, extracted: Object}>}
 */
async function getAIResponse(session, history, slotsContext) {
  const systemPrompt = buildSystemPrompt(session, slotsContext);

  // Build messages array: system + conversation history
  // Filter out 'system' role messages from history (pg stores them for context)
  // Groq only supports: system, user, assistant roles
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content })),
  ];

  let rawResponse;
  try {
    const completion = await groq.chat.completions.create({
      model: LLM_MODEL,
      messages,
      temperature: 0.3,        // Low = consistent, professional, predictable
      max_tokens: MAX_TOKENS,
      response_format: { type: 'json_object' }, // Enforce JSON output
    });

    rawResponse = completion.choices[0]?.message?.content || '';
    console.log(`[AI Raw] Stage=${session.stage} → ${rawResponse.slice(0, 200)}`);
  } catch (err) {
    console.error('Groq LLM error:', err.message);
    return {
      reply: "I'm sorry, I'm having a moment of difficulty. Could you please repeat what you said?",
      transition: null,
      extracted: {},
    };
  }

  // Parse JSON response
  return parseAIResponse(rawResponse, session.stage);
}

/**
 * Safely parses the LLM JSON response with fallbacks.
 */
function parseAIResponse(rawResponse, currentStage) {
  const fallback = {
    reply: "I'm sorry, could you please repeat that? I want to make sure I understand you correctly.",
    transition: null,
    extracted: {},
  };

  if (!rawResponse || rawResponse.trim().length === 0) {
    console.warn('Empty LLM response — using fallback');
    return fallback;
  }

  try {
    // Strip any accidental markdown code fences
    const cleaned = rawResponse
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    // Validate reply field
    if (!parsed.reply || typeof parsed.reply !== 'string' || parsed.reply.trim().length === 0) {
      console.warn('LLM returned empty reply — using fallback reply');
      parsed.reply = fallback.reply;
    }

    // Sanitize transition — only allow known stage names
    const validTransitions = ['TRIAGE', 'BOOKING', 'CONFIRMATION', 'DONE', null];
    if (!validTransitions.includes(parsed.transition)) {
      console.warn(`Invalid transition "${parsed.transition}" — ignoring`);
      parsed.transition = null;
    }

    // Sanitize extracted fields
    const extracted = parsed.extracted || {};
    return {
      reply: parsed.reply.trim(),
      transition: parsed.transition || null,
      extracted: {
        patient_name: typeof extracted.patient_name === 'string' ? extracted.patient_name.trim() : null,
        symptom_summary: typeof extracted.symptom_summary === 'string' ? extracted.symptom_summary.trim() : null,
        urgency_level: ['normal', 'urgent'].includes(extracted.urgency_level) ? extracted.urgency_level : null,
        preferred_doctor: typeof extracted.preferred_doctor === 'string' ? extracted.preferred_doctor.trim() : null,
        slot_id: Number.isInteger(extracted.slot_id) ? extracted.slot_id : null,
      },
    };
  } catch (err) {
    console.error('AI response parse error:', err.message, '| Raw:', rawResponse.slice(0, 300));
    return fallback;
  }
}

module.exports = { getAIResponse };
