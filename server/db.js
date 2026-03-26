const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Unexpected pool error:', err);
});

async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS nucleus_phone_calls (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        conference_name VARCHAR(100) UNIQUE,
        conference_sid VARCHAR(50),
        caller_identity VARCHAR(50),
        lead_phone VARCHAR(20),
        lead_name VARCHAR(255),
        lead_company VARCHAR(255),
        hubspot_contact_id VARCHAR(50),
        direction VARCHAR(10) DEFAULT 'outbound',
        status VARCHAR(20) DEFAULT 'connecting',
        duration_seconds INTEGER,
        disposition VARCHAR(30),
        qualification VARCHAR(20),
        products_discussed JSONB DEFAULT '[]',
        notes TEXT,
        recording_url TEXT,
        recording_duration INTEGER,
        fireflies_uploaded BOOLEAN DEFAULT FALSE,
        participants JSONB DEFAULT '[]',
        slack_notified BOOLEAN DEFAULT FALSE,
        hubspot_synced BOOLEAN DEFAULT FALSE
      );

      CREATE INDEX IF NOT EXISTS idx_npc_caller ON nucleus_phone_calls(caller_identity);
      CREATE INDEX IF NOT EXISTS idx_npc_lead_phone ON nucleus_phone_calls(lead_phone);
      CREATE INDEX IF NOT EXISTS idx_npc_status ON nucleus_phone_calls(status);
      CREATE INDEX IF NOT EXISTS idx_npc_created ON nucleus_phone_calls(created_at DESC);
    `);
    console.log('nucleus_phone_calls table ready');
  } finally {
    client.release();
  }
}

module.exports = { pool, initSchema };
