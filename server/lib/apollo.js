/**
 * lib/apollo.js — Apollo API integration for identity resolution and contact enrichment.
 *
 * Two capabilities:
 * - matchPerson: single-person lookup (identity-resolver.js, 1 credit)
 * - searchPeopleByCompany: find contacts at a company by domain + title (signal enrichment, 1 credit)
 *
 * Stripped from joruva-v35-scripts/src/lib/apollo.js.
 */

const BASE_URL = 'https://api.apollo.io/api/v1';
const TIMEOUT_MS = 15000;

// Title filters for CNC manufacturing personas (from North Star Spear sequence)
const DEFAULT_TITLE_FILTERS = [
  'VP Operations', 'Director of Operations',
  'Director of Quality', 'Quality Manager',
  'Plant Manager', 'General Manager',
  'Purchasing Manager', 'Procurement Director',
  'Maintenance Director',
  'CFO', 'Owner',
];

/**
 * Match a person by name + organization. Returns full person object or null.
 * Consumes 1 Apollo credit.
 *
 * @param {Object} params
 * @param {string} params.firstName
 * @param {string} params.lastName
 * @param {string} params.organization
 * @param {string} [params.email]
 * @returns {Promise<Object|null>}
 */
async function matchPerson({ firstName, lastName, organization, email }) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return null;

  const body = {
    first_name: firstName,
    last_name: lastName,
    organization_name: organization,
    ...(email && { email }),
  };

  const resp = await fetch(`${BASE_URL}/people/match`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Apollo match failed: ${resp.status} ${text.substring(0, 200)}`);
  }

  const data = await resp.json();
  return data.person || null;
}

/**
 * Search for people at a company by domain + title filters.
 * Used by signal enrichment to find callable contacts at signal-scored companies.
 * Consumes 1 Apollo credit per search call.
 *
 * @param {string} domain - Company domain (e.g. 'acmemanufacturing.com')
 * @param {string[]} [titleFilters] - Job titles to filter by (default: CNC manufacturing personas)
 * @param {number} [perPage] - Max results per call (default 10, max 25)
 * @returns {Promise<Array<{name: string, first_name: string, last_name: string, title: string, phone: string|null, email: string|null, linkedin_url: string|null}>>}
 */
async function searchPeopleByCompany(domain, titleFilters = DEFAULT_TITLE_FILTERS, perPage = 10) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return [];

  const body = {
    organization_domains: [domain],
    person_titles: titleFilters,
    page: 1,
    per_page: Math.min(perPage, 25),
  };

  const resp = await fetch(`${BASE_URL}/mixed_people/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Apollo people search failed: ${resp.status} ${text.substring(0, 200)}`);
  }

  const data = await resp.json();
  const people = data.people || [];

  return people.map(p => ({
    name: p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
    first_name: p.first_name || null,
    last_name: p.last_name || null,
    title: p.title || null,
    phone: p.phone_numbers?.[0]?.sanitized_number || p.organization?.phone || null,
    email: p.email || null,
    linkedin_url: p.linkedin_url || null,
  }));
}

module.exports = { matchPerson, searchPeopleByCompany, DEFAULT_TITLE_FILTERS };
