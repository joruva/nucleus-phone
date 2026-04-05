#!/usr/bin/env node
/**
 * scripts/resolve-signal-domains.js
 *
 * Multi-strategy domain resolver for .signal-pending placeholder domains.
 *
 * Strategy chain (stops at first hit):
 *   1. Known-company map — instant lookup for well-known subsidiaries/divisions
 *   2. Apollo org search — free, no credits consumed, ~53% hit rate
 *   3. DataForSEO Google SERP — paid but reliable, extracts domain from top result
 *
 * Updates both v35_signal_metadata and v35_lead_reservoir with the resolved domain.
 *
 * Usage:
 *   node scripts/resolve-signal-domains.js [--dry-run] [--limit N] [--strategy apollo|google|all]
 *
 * Env vars (loads from .env + v35-scripts/.env):
 *   DATABASE_URL, APOLLO_API_KEY, DATAFORSEO_AUTH
 */

require('dotenv').config();
// Also load v35-scripts env for DataForSEO + Apollo keys if not in local .env
require('dotenv').config({ path: '/Users/Shared/joruva-v35-scripts/.env', override: false });

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
const DATAFORSEO_AUTH = process.env.DATAFORSEO_AUTH;

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : 600;
})();
const STRATEGY = (() => {
  const idx = process.argv.indexOf('--strategy');
  return idx >= 0 ? process.argv[idx + 1] : 'all';
})();

// ── Known-company map ──────────────────────────────────────────────────
// Companies where the legal entity name differs from the well-known domain.
// Subsidiaries, divisions, holding companies, DBA names.
const KNOWN_DOMAINS = {
  'lincoln electric': 'lincolnelectric.com',
  'xometry': 'xometry.com',
  'qorvo': 'qorvo.com',
  'hamilton sundstrand': 'collinsaerospace.com',  // RTX subsidiary
  'sidus space': 'sidus.space',
  'frequentis': 'frequentis.com',
  'marotta controls': 'marotta.com',
  'kamatics': 'kaman.com',  // Kaman subsidiary
  'atrenne computing': 'atrenne.com',
  'curtiss-wright': 'curtisswright.com',
  'ducommun': 'ducommun.com',
  'heico': 'heico.com',
  'moog': 'moog.com',
  'spirit aerosystems': 'spiritaero.com',
  'triumph group': 'triumphgroup.com',
  'woodward': 'woodward.com',
  'astronics': 'astronics.com',
  'kratos defense': 'kratosdefense.com',
  'mercury systems': 'mrcy.com',
  'drs technologies': 'leonardodrs.com',
};

// ── US state names + abbreviations for name cleaning ───────────────────
const US_STATES = new Set([
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
  'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
  'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
  'minnesota','mississippi','missouri','montana','nebraska','nevada',
  'new hampshire','new jersey','new mexico','new york','north carolina',
  'north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island',
  'south carolina','south dakota','tennessee','texas','utah','vermont',
  'virginia','washington','west virginia','wisconsin','wyoming',
]);

/**
 * Aggressively clean a company name for search:
 * - Strip legal suffixes (Inc, LLC, Corp, etc.)
 * - Strip US state names that Apollo chokes on
 * - Strip geographic qualifiers ("of Texas", "- Ohio Division")
 */
function cleanCompanyName(raw) {
  let name = raw
    // Legal suffixes (2 passes for "Holdings Inc" → "Holdings" → "")
    .replace(/,?\s*(INC\.?|LLC\.?|CORP\.?|CORPORATION|L\.?P\.?|CO\.?|LTD\.?|COMPANY|HOLDINGS?|ENTERPRISES?|ASSOCIATES?|SOLUTIONS?|TECHNOLOGIES|GROUP|MFG\.?|MANUFACTURING)\s*$/ig, '')
    .replace(/,?\s*(INC\.?|LLC\.?|CORP\.?|CO\.?|LTD\.?)\s*$/ig, '')
    // Geographic qualifiers: "of Texas", "- Ohio", ", Arizona"
    .replace(/\s*[-–—]\s*(of\s+)?[A-Z][a-z]+(\s+[A-Z][a-z]+)?\s*(Division|Branch|Plant|Facility|Operations?)?\s*$/i, '')
    .replace(/,?\s+of\s+[A-Z][a-z]+(\s+[A-Z][a-z]+)?\s*$/i, '')
    .replace(/[,.\s]+$/, '')
    .trim();

  // Strip trailing state names: "XMEK Arizona" → "XMEK"
  const words = name.split(/\s+/);
  if (words.length >= 2) {
    const lastWord = words[words.length - 1].toLowerCase();
    const lastTwo = words.length >= 3
      ? words.slice(-2).join(' ').toLowerCase()
      : null;
    if (lastTwo && US_STATES.has(lastTwo)) {
      name = words.slice(0, -2).join(' ');
    } else if (US_STATES.has(lastWord)) {
      name = words.slice(0, -1).join(' ');
    }
  }

  return name.replace(/[,.\s]+$/, '').trim();
}

/**
 * Strategy 1: Known-company lookup (instant, free).
 */
function lookupKnown(cleanedName) {
  const lower = cleanedName.toLowerCase();
  for (const [key, domain] of Object.entries(KNOWN_DOMAINS)) {
    if (lower.includes(key)) return { domain, source: 'known-map' };
  }
  return null;
}

/**
 * Validate that a resolved domain/name plausibly matches the company we searched for.
 * Prevents false positives like "REV-CAP" → revolut.com.
 */
function validateMatch(searchName, result) {
  const searchWords = searchName.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length >= 3);
  if (!searchWords.length) return false; // Can't validate very short names — reject to avoid false positives

  // Check domain: does it contain any significant search word?
  const domainLower = result.domain.toLowerCase().replace(/\.[a-z]+$/, ''); // strip TLD
  const domainHit = searchWords.some(w => domainLower.includes(w));
  if (domainHit) return true;

  // Check title/org name if available
  const titleStr = (result.apolloName || result.title || '').toLowerCase();
  const titleWords = titleStr.replace(/[^a-z0-9\s]/g, '').split(/\s+/);
  const titleOverlap = searchWords.filter(w => titleWords.includes(w)).length;
  // At least 1 significant word overlap, or 50% of search words
  if (titleOverlap >= 1 && (titleOverlap >= searchWords.length * 0.5 || titleOverlap >= 2)) return true;

  return false;
}

/**
 * Strategy 2: Apollo organization search (free, no credits).
 */
async function searchApollo(name) {
  if (!APOLLO_API_KEY) return null;

  const resp = await fetch('https://api.apollo.io/api/v1/organizations/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': APOLLO_API_KEY },
    body: JSON.stringify({ q_organization_name: name, per_page: 1 }),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) return null;
  const data = await resp.json();
  const org = data.organizations?.[0];
  if (!org) return null;

  const website = org.website_url || '';
  let domain = org.primary_domain;
  if (!domain && website) {
    try { domain = new URL(website).hostname.replace(/^www\./, ''); } catch {}
  }

  if (!domain) return null;

  // Quick sanity: reject mega-corps that Apollo returns as "closest match"
  // for small niche companies (e.g., "REV-CAP" → Revolut)
  const APOLLO_FALSE_POSITIVES = new Set([
    'revolut.com', 'stripe.com', 'paypal.com', 'shopify.com',
    'salesforce.com', 'hubspot.com', 'slack.com',
  ]);
  if (APOLLO_FALSE_POSITIVES.has(domain)) return null;

  return { domain, source: 'apollo', apolloName: org.name };
}

/**
 * Strategy 3: DataForSEO Google SERP — search company name, extract domain
 * from the top organic result's URL.
 */
async function searchGoogle(name) {
  if (!DATAFORSEO_AUTH) return null;

  const resp = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/advanced', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${DATAFORSEO_AUTH}`,
    },
    body: JSON.stringify([{
      keyword: `${name} company website`,
      location_code: 2840, // US
      language_code: 'en',
      depth: 10,
    }]),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) return null;
  const data = await resp.json();

  const items = data?.tasks?.[0]?.result?.[0]?.items;
  if (!items?.length) return null;

  // Find the first organic result that looks like a company website
  // (skip LinkedIn, Wikipedia, Yelp, BBB, etc.)
  const SKIP_DOMAINS = new Set([
    'linkedin.com', 'facebook.com', 'twitter.com', 'x.com',
    'wikipedia.org', 'yelp.com', 'bbb.org', 'bloomberg.com',
    'dnb.com', 'zoominfo.com', 'crunchbase.com', 'glassdoor.com',
    'indeed.com', 'mapquest.com', 'yellowpages.com', 'manta.com',
    'opencorporates.com', 'sec.gov', 'sam.gov', 'usaspending.gov',
    'google.com', 'youtube.com', 'amazon.com', 'govtribe.com',
    'govwin.com', 'fpds.gov', 'usajobs.gov', 'thomasnet.com',
    'macroaxis.com', 'buzzfile.com', 'chamberofcommerce.com',
    'northdata.com', 'pitchbook.com', 'cbinsights.com', 'owler.com',
    'craft.co', 'rocketreach.co', 'leadiq.com', 'apollo.io',
    'datanyze.com', 'lusha.com', 'clearbit.com', 'builtwith.com',
    'iowabids.com', 'bidnet.com', 'govplanet.com', 'surplus.com',
    'kompass.com', 'dnb.com', 'hoovers.com', 'spoke.com',
    'rev.com', 'trustpilot.com', 'g2.com', 'capterra.com',
    'yahoo.com', 'gao.gov', 'highergov.com', 'industrynet.com',
    'napaonline.com', 'amd.com', 'motorcarparts.com',
  ]);

  for (const item of items) {
    if (item.type !== 'organic') continue;
    const url = item.url;
    if (!url) continue;

    let domain;
    try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }

    if (SKIP_DOMAINS.has(domain)) continue;
    // Skip subdomains of skip domains
    if ([...SKIP_DOMAINS].some(d => domain.endsWith('.' + d))) continue;
    // Skip non-US TLDs (these are US companies)
    if (/\.(za|uk|au|de|fr|jp|cn|ru|br|in|kr|es|it|nl|se|no|dk|fi|pl|cz)\b/.test(domain)) continue;

    return { domain, source: 'google', title: item.title };
  }

  return null;
}

/**
 * Resolve a single company through the strategy chain.
 */
async function resolveCompany(companyName) {
  const cleaned = cleanCompanyName(companyName);

  // Strategy 1: Known-company map
  const known = lookupKnown(cleaned);
  if (known) return known;

  if (STRATEGY === 'all' || STRATEGY === 'google') {
    // Strategy 2: DataForSEO Google SERP — higher precision than Apollo
    // Company's own website naturally ranks #1 for its name
    const google = await searchGoogle(cleaned);
    if (google && validateMatch(cleaned, google)) return google;
  }

  if (STRATEGY === 'all' || STRATEGY === 'apollo') {
    // Strategy 3: Apollo org search (free fallback for Google misses)
    const apollo = await searchApollo(cleaned);
    if (apollo && validateMatch(cleaned, apollo)) return apollo;

    // Also try with just the first 2-3 words for very long names
    const shortName = cleaned.split(/\s+/).slice(0, 3).join(' ');
    if (shortName !== cleaned && shortName.length >= 3) {
      const apolloShort = await searchApollo(shortName);
      if (apolloShort && validateMatch(shortName, apolloShort)) return { ...apolloShort, source: 'apollo-short' };
    }
  }

  return null;
}

/**
 * Update both tables atomically.
 */
async function updateDomain(oldDomain, newDomain) {
  // Check both tables for existing domain (both have unique constraints)
  const [smCheck, lrCheck] = await Promise.all([
    pool.query(`SELECT domain FROM v35_signal_metadata WHERE domain = $1`, [newDomain]),
    pool.query(`SELECT domain FROM v35_lead_reservoir WHERE domain = $1`, [newDomain]),
  ]);

  if (smCheck.rows.length > 0 || lrCheck.rows.length > 0) {
    return { skipped: true, reason: 'domain-exists' };
  }

  await pool.query('BEGIN');
  await pool.query(
    `UPDATE v35_signal_metadata SET domain = $1 WHERE domain = $2`,
    [newDomain, oldDomain],
  );
  await pool.query(
    `UPDATE v35_lead_reservoir SET domain = $1 WHERE domain = $2`,
    [newDomain, oldDomain],
  );
  await pool.query('COMMIT');
  return { skipped: false };
}

async function run() {
  console.log(`\n=== Signal Domain Resolver (Multi-Strategy) ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Strategy: ${STRATEGY}`);
  console.log(`Limit: ${LIMIT}`);
  console.log(`Apollo: ${APOLLO_API_KEY ? 'available' : 'MISSING'}`);
  console.log(`DataForSEO: ${DATAFORSEO_AUTH ? 'available' : 'MISSING'}\n`);

  // Get all .signal-pending companies, highest signal_score first
  const result = await pool.query(
    `SELECT sm.domain AS old_domain, lr.company_name, sm.signal_tier, sm.signal_score
     FROM v35_signal_metadata sm
     JOIN v35_lead_reservoir lr ON lr.domain = sm.domain
     WHERE sm.domain LIKE '%.signal-pending'
       AND sm.signal_tier IN ('spear', 'targeted')
     ORDER BY sm.signal_score DESC
     LIMIT $1`,
    [LIMIT],
  );

  const companies = result.rows;
  console.log(`Found ${companies.length} companies with .signal-pending domains\n`);

  const stats = { known: 0, apollo: 0, 'apollo-short': 0, google: 0, notFound: 0, skipped: 0, errors: 0 };

  for (let i = 0; i < companies.length; i++) {
    const c = companies[i];

    try {
      const match = await resolveCompany(c.company_name);

      if (match) {
        const label = `[${match.source}]`.padEnd(15);
        console.log(`  [${String(i + 1).padStart(3)}/${companies.length}] ✓ ${label} ${c.company_name} → ${match.domain}`);

        if (!DRY_RUN) {
          const result = await updateDomain(c.old_domain, match.domain);
          if (result.skipped) {
            console.log(`    ⚠ Domain ${match.domain} already exists — skipping`);
            stats.skipped++;
            continue;
          }
        }
        stats[match.source] = (stats[match.source] || 0) + 1;
      } else {
        console.log(`  [${String(i + 1).padStart(3)}/${companies.length}] ✗ ${c.company_name}`);
        stats.notFound++;
      }

      // Rate limit: ~2 req/sec for Apollo, slower for Google (costs money)
      if (i < companies.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }

    } catch (err) {
      console.error(`  [${String(i + 1).padStart(3)}/${companies.length}] ! ${c.company_name} — ${err.message}`);
      stats.errors++;
      try { await pool.query('ROLLBACK'); } catch {}
    }
  }

  const resolved = (stats['known-map'] || 0) + stats.apollo + stats['apollo-short'] + stats.google;
  console.log(`\n=== Results ===`);
  console.log(`Resolved:    ${resolved}`);
  console.log(`  Known map: ${stats['known-map'] || 0}`);
  console.log(`  Apollo:    ${stats.apollo}`);
  console.log(`  Apollo-s:  ${stats['apollo-short']}`);
  console.log(`  Google:    ${stats.google}`);
  console.log(`Skipped:     ${stats.skipped} (domain collision)`);
  console.log(`Not found:   ${stats.notFound}`);
  console.log(`Errors:      ${stats.errors}`);
  console.log(`Total:       ${companies.length}`);

  if (DRY_RUN) console.log(`\nDry run — no changes applied. Run without --dry-run to commit.`);

  await pool.end();
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
