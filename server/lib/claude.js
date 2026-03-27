/**
 * lib/claude.js — Claude API rapport intelligence module.
 * Generates pre-call briefings from assembled contact data.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6-20250514';
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const FETCH_TIMEOUT = 6000; // 6 seconds

// In-memory cache: Map<string, { data, expiresAt }>
const cache = new Map();

const SYSTEM_PROMPT = `You are a rapport-first intelligence analyst for Joruva Industrial, a compressed air systems distributor. Your job is to prepare a sales caller with a pre-call briefing.

Given contact data (name, title, company, interaction history, pipeline data, PB profile), produce a JSON object with these fields:

- rapport_starters: Array of 2-3 conversation openers based on REAL data (career history, headline, company, location, tenure, past interactions). NEVER fabricate facts. If data is sparse, use what's available.
- intel_nuggets: Array of 2-4 buying signals, objection prep points, or compliance notes derived from interaction history and pipeline data.
- opening_line: A natural, warm opening line for the call. Use their first name.
- adapted_script: 2-3 sentences tailoring the standard pitch to this specific contact's industry/role/history.
- watch_outs: Array of 0-2 things to avoid (e.g., competitor mentions, past complaints, sensitive topics).
- product_reference: Relevant product lines based on their history/industry.

Respond with ONLY valid JSON, no markdown fences.`;

function cacheKey(contactData) {
  return contactData.hubspotContactId
    || contactData.phone
    || contactData.email
    || 'unknown';
}

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL });
}

function buildFallback(contactData) {
  const name = contactData.name || 'there';
  const starters = [];
  if (contactData.company) starters.push(`Ask about their role at ${contactData.company}`);
  if (contactData.title) starters.push(`Reference their work as ${contactData.title}`);
  if (!starters.length) starters.push('Start with a warm introduction about Joruva Industrial');

  return {
    fallback: true,
    rapport_starters: starters,
    intel_nuggets: [],
    opening_line: `Hi ${name.split(' ')[0]}, this is calling from Joruva Industrial.`,
    adapted_script: '',
    watch_outs: [],
    product_reference: [],
  };
}

async function generateRapportIntel(contactData) {
  const key = cacheKey(contactData);
  const cached = getCached(key);
  if (cached) return cached;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('ANTHROPIC_API_KEY not set — returning fallback');
    return buildFallback(contactData);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Generate a pre-call briefing for this contact:\n\n${JSON.stringify(contactData, null, 2)}`,
        }],
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Claude API ${resp.status}: ${body.substring(0, 200)}`);
    }

    const result = await resp.json();
    const text = result.content?.[0]?.text;
    if (!text) throw new Error('Empty Claude response');

    const intel = JSON.parse(text);
    intel.fallback = false;
    setCache(key, intel);
    return intel;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('Claude API timed out after 6s — returning fallback');
    } else {
      console.error('Claude rapport generation failed:', err.message);
    }
    return buildFallback(contactData);
  } finally {
    clearTimeout(timer);
  }
}

function clearCache(key) {
  if (key) {
    cache.delete(key);
  } else {
    cache.clear();
  }
}

module.exports = { generateRapportIntel, clearCache };
