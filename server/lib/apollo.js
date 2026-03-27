/**
 * lib/apollo.js — Simplified Apollo People Match for identity resolution.
 * 1 credit per match call. Budget-gated via checkCreditBudget().
 *
 * Stripped from joruva-v35-scripts/src/lib/apollo.js.
 * No circuit breaker, no rate limiter — overkill at <10 calls/day.
 */

const BASE_URL = 'https://api.apollo.io/api/v1';
const TIMEOUT_MS = 10000;

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

module.exports = { matchPerson };
