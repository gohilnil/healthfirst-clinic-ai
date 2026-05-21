'use strict';

/**
 * helpers/transcription.js
 * Transcribes Twilio recording URLs using Groq Whisper API.
 *
 * Twilio recording URLs require Basic Auth using AccountSid:AuthToken.
 * We fetch the audio buffer, pass it to Groq Whisper via the SDK.
 */

const Groq = require('groq-sdk');
const fetch = require('node-fetch');
const FormData = require('form-data');

// Groq SDK instance — key pulled from env at runtime
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const WHISPER_MODEL = 'whisper-large-v3';
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB Groq limit

/**
 * Downloads a Twilio recording and transcribes it via Groq Whisper.
 *
 * @param {string} recordingUrl - Full .mp3 URL from Twilio (RecordingUrl + '.mp3')
 * @returns {Promise<string>} - Transcribed text, trimmed
 */
async function transcribeAudio(recordingUrl) {
  if (!recordingUrl) {
    throw new Error('transcribeAudio: recordingUrl is required');
  }

  // Build Basic Auth header for Twilio recording access
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
  }

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  // Fetch audio from Twilio
  let audioBuffer;
  try {
    const response = await fetch(recordingUrl, {
      headers: { Authorization: `Basic ${credentials}` },
      timeout: 15000,
    });

    if (!response.ok) {
      throw new Error(`Twilio recording fetch failed: ${response.status} ${response.statusText}`);
    }

    audioBuffer = await response.buffer();

    if (audioBuffer.length === 0) {
      throw new Error('Empty audio buffer received from Twilio');
    }

    if (audioBuffer.length > MAX_AUDIO_BYTES) {
      throw new Error(`Audio too large: ${audioBuffer.length} bytes (max ${MAX_AUDIO_BYTES})`);
    }
  } catch (err) {
    console.error('Audio download error:', err.message);
    throw err;
  }

  // Send to Groq Whisper
  try {
    // Groq SDK accepts a File-like object; we build a FormData manually
    // because Node's Groq SDK toFile() helper handles Buffer → File conversion
    const { toFile } = require('groq-sdk');
    const audioFile = await toFile(audioBuffer, 'recording.mp3', { type: 'audio/mpeg' });

    const transcription = await groq.audio.transcriptions.create({
      file: audioFile,
      model: WHISPER_MODEL,
      language: 'en',
      response_format: 'json',
    });

    const text = (transcription.text || '').trim();
    console.log(`[Transcription] "${text}"`);
    return text;
  } catch (err) {
    console.error('Groq Whisper error:', err.message);
    throw err;
  }
}

module.exports = { transcribeAudio };
