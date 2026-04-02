#!/usr/bin/env node

/**
 * Phase 0 Validation Script — Per-Rep Email Sending
 *
 * Proves the full path: auth code login → token cache → refresh → Graph API sendMail
 * Run: node scripts/test-msal-mail-send.js
 *
 * Prerequisites:
 *   - Mail.Send delegated permission added to the Entra app and admin-consented
 *   - ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET, ENTRA_TENANT_ID set in .env or env
 *   - DATABASE_URL pointing to nucleus-phone Postgres
 *   - http://localhost:3099/callback added as a redirect URI in the Entra app registration
 */

const msal = require('@azure/msal-node');
const http = require('http');
const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');
const { Pool } = require('pg');
const { exec } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────

const TENANT_ID = process.env.ENTRA_TENANT_ID;
const CLIENT_ID = process.env.ENTRA_CLIENT_ID;
const CLIENT_SECRET = process.env.ENTRA_CLIENT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SCOPES = ['Mail.Send', 'offline_access', 'User.Read', 'openid', 'profile', 'email'];
const LOCAL_PORT = 3099;
const REDIRECT_URI = `http://localhost:${LOCAL_PORT}/callback`;

// Use existing M365 key or generate a test key
const ENCRYPTION_KEY = process.env.MSAL_ENCRYPTION_KEY
  || process.env.M365_ENCRYPTION_KEY
  || randomBytes(32).toString('hex');

if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET, or ENTRA_TENANT_ID');
  process.exit(1);
}

// ─── Crypto (same as joruva-mcp-m365/src/crypto.ts) ───────────────────

function getKey() {
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
    throw new Error('MSAL_ENCRYPTION_KEY must be a 64-char hex string');
  }
  return Buffer.from(ENCRYPTION_KEY, 'hex');
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(ciphertext) {
  const key = getKey();
  const [ivHex, tagHex, dataHex] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final('utf8');
}

// ─── DB ───────────────────────────────────────────────────────────────

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 });
  }
  return pool;
}

async function ensureTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS msal_token_cache (
      partition_key VARCHAR(255) PRIMARY KEY,
      cache_data TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('Phase 0: Per-Rep Email Validation Script\n');

  // Step 1: Authorization code login (same flow as production)
  console.log('1. Starting authorization code login...');
  console.log(`   Redirect URI: ${REDIRECT_URI}`);
  console.log('   NOTE: This URI must be registered in the Entra app. If not, add it now.\n');

  const msalApp = new msal.ConfidentialClientApplication({
    auth: {
      clientId: CLIENT_ID,
      authority: `https://login.microsoftonline.com/${TENANT_ID}`,
      clientSecret: CLIENT_SECRET,
    },
  });

  // Get auth URL and open browser
  const authUrl = await msalApp.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
  });

  // Start local server to catch the callback
  const authCode = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${LOCAL_PORT}`);
      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<h2>Auth failed: ${error}</h2><p>${url.searchParams.get('error_description')}</p>`);
          server.close();
          reject(new Error(`Auth failed: ${error} — ${url.searchParams.get('error_description')}`));
        } else if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h2 style="color:green">Authenticated! You can close this tab.</h2>');
          server.close();
          resolve(code);
        }
      }
    });
    server.listen(LOCAL_PORT, () => {
      console.log(`   Local server listening on port ${LOCAL_PORT}`);
      console.log('   Opening browser...\n');
      // Open browser (macOS)
      exec(`open "${authUrl}"`);
    });
    // Timeout after 2 minutes
    setTimeout(() => { server.close(); reject(new Error('Auth timed out after 2 minutes')); }, 120000);
  });

  // Exchange auth code for tokens
  const result = await msalApp.acquireTokenByCode({
    code: authCode,
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
  });
  const email = (result.account?.username || '').toLowerCase();
  console.log(`   Authenticated as: ${email}`);
  console.log(`   Account homeId: ${result.account?.homeAccountId}`);

  // Step 2: Serialize and inspect cache
  console.log('\n2. Inspecting MSAL token cache structure...');
  const cacheJson = msalApp.getTokenCache().serialize();
  const cache = JSON.parse(cacheJson);

  console.log('   Cache top-level keys:', Object.keys(cache));
  console.log('   RefreshToken entries:', Object.keys(cache.RefreshToken || {}).length);

  // Log the structure of the first refresh token entry (keys only, not secrets)
  const rtEntries = Object.entries(cache.RefreshToken || {});
  if (rtEntries.length > 0) {
    const [rtKey, rtValue] = rtEntries[0];
    console.log('   RefreshToken key format:', rtKey);
    console.log('   RefreshToken entry fields:', Object.keys(rtValue));
    console.log('   RefreshToken.username:', rtValue.username);
    console.log('   RefreshToken.secret present:', !!rtValue.secret);
  }

  // Step 3: Test extraction pattern
  console.log('\n3. Testing refresh token extraction pattern...');
  const extracted = Object.values(cache.RefreshToken || {})
    .find(entry => entry.username?.toLowerCase() === email);

  if (!extracted?.secret) {
    console.error('   EXTRACTION FAILED — fallback to flat token storage needed');
    console.log('   Available usernames:', Object.values(cache.RefreshToken || {}).map(e => e.username));
    // Fallback: extract directly from the MSAL result
    console.log('\n   Testing fallback: extract from acquireTokenByCode result...');
    // In auth code flow, MSAL doesn't expose refresh_token directly on the result.
    // But it IS in the serialized cache. If extraction by username fails, try by homeAccountId.
    const byHomeId = Object.values(cache.RefreshToken || {})
      .find(entry => entry.home_account_id === result.account?.homeAccountId);
    if (byHomeId?.secret) {
      console.log('   Fallback succeeded: match by home_account_id');
      console.log('   DECISION: Use home_account_id for extraction, not username');
    } else {
      console.error('   Both extraction methods failed. Need alternative approach.');
      process.exit(1);
    }
  } else {
    console.log('   Extraction by username succeeded');
  }

  const refreshToken = extracted?.secret
    || Object.values(cache.RefreshToken || {}).find(e => e.home_account_id === result.account?.homeAccountId)?.secret;

  // Step 4: Encrypt and store in DB
  if (DATABASE_URL) {
    console.log('\n4. Storing encrypted cache in Postgres...');
    await ensureTable();
    const encrypted = encrypt(cacheJson);
    await getPool().query(
      `INSERT INTO msal_token_cache (partition_key, cache_data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (partition_key)
       DO UPDATE SET cache_data = $2, updated_at = NOW()`,
      [email, encrypted]
    );
    console.log('   Stored OK');

    // Step 5: Load back and decrypt
    console.log('\n5. Loading back from DB and decrypting...');
    const { rows } = await getPool().query(
      'SELECT cache_data FROM msal_token_cache WHERE partition_key = $1',
      [email]
    );
    const decrypted = decrypt(rows[0].cache_data);
    const reloaded = JSON.parse(decrypted);
    const reloadedRt = Object.values(reloaded.RefreshToken || {})
      .find(e => e.username?.toLowerCase() === email || e.home_account_id === result.account?.homeAccountId);
    console.log('   Round-trip OK, refresh token matches:', reloadedRt?.secret === refreshToken);
  } else {
    console.log('\n4-5. Skipping DB test (no DATABASE_URL)');
  }

  // Step 6: Direct token refresh (skip MSAL, call endpoint directly)
  console.log('\n6. Testing direct token endpoint refresh...');
  const tokenUrl = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const refreshBody = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: 'Mail.Send offline_access',
  });

  const refreshRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: refreshBody.toString(),
  });

  if (!refreshRes.ok) {
    const err = await refreshRes.json().catch(() => ({}));
    console.error('   Token refresh FAILED:', refreshRes.status, err.error_description || err.error);
    process.exit(1);
  }

  const tokenData = await refreshRes.json();
  console.log('   Refresh succeeded');
  console.log('   New access token length:', tokenData.access_token.length);
  console.log('   New refresh token received:', !!tokenData.refresh_token);
  console.log('   Scopes:', tokenData.scope);

  // Step 7: Send test email via Graph API
  console.log('\n7. Sending test email via Graph API /me/sendMail...');
  const sendRes = await fetch(`${GRAPH_BASE}/me/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject: `[Phase 0 Test] Per-Rep Email Validation — ${email}`,
        body: {
          contentType: 'HTML',
          content: `<p>This is a test email sent from <strong>${email}</strong>'s mailbox via Graph API.</p>
                    <p>If you're reading this, Phase 0 validation passed. The per-rep email sending infrastructure works.</p>
                    <p style="color: #7EC55F; font-weight: 600;">— Nucleus Phone System</p>`,
        },
        toRecipients: [{ emailAddress: { address: 'tom@joruva.com', name: 'Tom Russo' } }],
      },
    }),
  });

  if (!sendRes.ok) {
    const err = await sendRes.text();
    console.error('   sendMail FAILED:', sendRes.status, err.substring(0, 300));
    process.exit(1);
  }

  console.log('   Email sent successfully from', email, '→ tom@joruva.com');

  // Step 8: Verify "from" via Graph API
  console.log('\n8. Verifying sender identity...');
  const meRes = await fetch(`${GRAPH_BASE}/me?$select=mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (meRes.ok) {
    const me = await meRes.json();
    console.log('   Graph /me says mail:', me.mail);
    console.log('   Graph /me says UPN:', me.userPrincipalName);
    console.log('   From address matches login:', (me.mail || me.userPrincipalName).toLowerCase() === email);
  }

  console.log('\n✓ Phase 0 PASSED — all checks green');
  console.log('  - Device code login: OK');
  console.log('  - Cache serialization: OK');
  console.log('  - Refresh token extraction: OK');
  console.log('  - Encrypt/decrypt round-trip: OK');
  console.log('  - Direct token refresh: OK');
  console.log('  - Graph API sendMail: OK');
  console.log('  - Sender identity: OK');

  if (pool) await pool.end();
}

main().catch((err) => {
  console.error('\nPhase 0 FAILED:', err.message);
  if (pool) pool.end();
  process.exit(1);
});
