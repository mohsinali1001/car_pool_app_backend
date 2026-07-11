const https = require('https');
const { clean, labelFromLocation } = require('./locationLabelHelper');

const GROQ_HOST = 'api.groq.com';
const GROQ_PATH = '/openai/v1/chat/completions';

function fallbackLabels(input) {
  return {
    startLocation: labelFromLocation(input.startLocation),
    endLocation: labelFromLocation(input.endLocation),
  };
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_) {
      return null;
    }
  }
}

function postGroq(payload, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: GROQ_HOST,
        path: GROQ_PATH,
        method: 'POST',
        timeout: 3500,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Groq returned ${res.statusCode}`));
          }
          resolve(data);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Groq request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function normalizeRouteLabels(input) {
  const apiKey = process.env.GROQ_API_KEY || process.env.GROK_API_KEY;
  const fallback = fallbackLabels(input);
  if (!apiKey) return fallback;

  const payload = {
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    temperature: 0,
    max_tokens: 160,
    messages: [
      {
        role: 'system',
        content:
          'Normalize Pakistan ride route labels. Return only JSON with startLocation and endLocation. Do not invent coordinates. Keep area/city concise and searchable.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          startLocation: fallback.startLocation,
          endLocation: fallback.endLocation,
          exactPickup: labelFromLocation(input.exactPickup),
          exactDrop: labelFromLocation(input.exactDrop),
          city: clean(input.city),
        }),
      },
    ],
  };

  try {
    const raw = await postGroq(payload, apiKey);
    const decoded = JSON.parse(raw);
    const content = decoded?.choices?.[0]?.message?.content || '';
    const parsed = parseJsonObject(content);
    const startLocation = clean(parsed?.startLocation);
    const endLocation = clean(parsed?.endLocation);
    if (!startLocation || !endLocation) return fallback;
    return { startLocation, endLocation };
  } catch (err) {
    console.warn('AI location normalization skipped:', err.message);
    return fallback;
  }
}

module.exports = { normalizeRouteLabels };
