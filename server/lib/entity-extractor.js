/**
 * entity-extractor.js — Detects equipment mentions in transcript text.
 *
 * Uses a keyword pre-filter to avoid Claude API calls on irrelevant text,
 * then Claude Haiku for extraction when keywords are present.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
// 5s is intentionally tight — this runs on live transcript chunks during calls.
// Latency matters more than completeness here; a missed extraction on one chunk
// will likely be caught on the next chunk when the prospect repeats the model.
const FETCH_TIMEOUT = 5000;

// Pre-filter: triggers Claude extraction only when transcript likely mentions equipment.
// False positives are acceptable (Claude sorts them out) but cost API money.
// Uses \b word boundaries on short/ambiguous words to reduce false matches.
const EQUIPMENT_KEYWORDS = /haas|mazak|bridgeport|fanuc|\bcnc\b|grizzly|\bpiston\b|\brecip\b|\brotary\b|\bdryer\b|\bbooth\b|\bblast\b|erector|pearson|packaging|doosan|okuma|hurco|kitamura|dmg|mori|laguna|thermwood|shopbot|wexxar|loveshaw|\bhvlp\b|\bsander\b|clemco|schmidt|\bsata\b|devilbiss|iwata|dynabrade|atlas.copco|kaeser|ingersoll|sullair|quincy|gardner.denver|fs.curtis|campbell|kaishan|elgi|kobelco|hitachi|\bcompressor\b/i;

const SYSTEM_PROMPT = `You extract equipment mentions from sales call transcripts. The caller sells compressed air systems (compressors, dryers, filters) and the prospect uses industrial equipment that consumes compressed air.

Your job is to identify the PROSPECT'S equipment — the machines they already own or operate. Do NOT extract compressed air products being recommended, quoted, or discussed as potential purchases. The prospect's equipment drives the air demand sizing; the products being sold are the OUTPUT of that sizing, not inputs to it.

For each piece of prospect equipment, extract:
- manufacturer: The equipment brand/manufacturer
- model: The specific model number or name
- count: How many units mentioned (default 1)
- raw_mention: The exact text from the transcript that references this equipment

If the transcript mentions a brand without a specific model (e.g. "we run Haas"), still extract it with model set to null.

Respond with ONLY a valid JSON array. No markdown fences, no explanation.
Example: [{"manufacturer":"Haas","model":"VF-2","count":3,"raw_mention":"three Haas VF-2s"}]
If no equipment is mentioned, respond with: []`;

// Hard filter: CAS product model prefixes that must never enter the sizing pipeline.
// These are the products being SOLD, not the prospect's equipment.
const CAS_MODEL_PREFIX = /^(JRS|JVSD|JLF|JRD|JDD|JPF|JCF|OWS)/i;
const CAS_MANUFACTURERS = /^(cas|compressed air systems?|joruva)/i;

/**
 * Extract equipment mentions from transcript text.
 * Returns array of { manufacturer, model, count, raw_mention }.
 * Returns empty array on no matches, errors, or timeout.
 */
async function extractEquipment(text) {
  if (!text || typeof text !== 'string') return [];

  // Pre-filter: skip Claude call if no equipment keywords
  if (!EQUIPMENT_KEYWORDS.test(text)) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('entity-extractor: ANTHROPIC_API_KEY not set — extraction disabled');
    return [];
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error(`entity-extractor: Claude API returned ${res.status}`);
      return [];
    }

    const data = await res.json();
    const textBlock = data.content?.find(b => b.type === 'text');
    if (!textBlock?.text) return [];

    const cleaned = textBlock.text
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();

    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map(item => ({
        manufacturer: item.manufacturer || null,
        model: item.model || null,
        count: Math.max(1, parseInt(item.count, 10) || 1),
        raw_mention: item.raw_mention || '',
      }))
      .filter(item => {
        if (item.model && CAS_MODEL_PREFIX.test(item.model)) return false;
        if (item.manufacturer && CAS_MANUFACTURERS.test(item.manufacturer)) return false;
        return true;
      });
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('entity-extractor: timed out');
    } else if (err instanceof SyntaxError) {
      console.error('entity-extractor: failed to parse Claude response');
    } else {
      console.error('entity-extractor error:', err.message);
    }
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { extractEquipment, EQUIPMENT_KEYWORDS, CAS_MODEL_PREFIX, CAS_MANUFACTURERS };
