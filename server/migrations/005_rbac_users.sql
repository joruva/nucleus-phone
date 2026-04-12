-- 005_rbac_users.sql
-- nucleus-phone-e5p: DB-backed user registry for RBAC + instant revocation.
--
-- The canonical source of this schema is server/db.js initSchema() — that's
-- what runs at every deploy. This file exists so the migration intent is
-- grep-able from the migrations/ folder like the earlier migrations.
--
-- Roles (ordered, least to most privilege):
--   external_caller — commission reps and outside users (Blake et al.)
--                     allow-list: call list, cockpit, history (own), practice, token (own)
--   caller          — internal @joruva.com team (Kate, Britt, Ryann, Alex, Lily)
--                     full call surface + scoreboard + /ask + quote-request
--   admin           — Tom, Paul. Signals, curation, equipment config,
--                     scoreboard/aggregate, fireflies-sync, user management.

CREATE TABLE IF NOT EXISTS nucleus_phone_users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  identity VARCHAR(50) UNIQUE NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'caller'
    CHECK (role IN ('external_caller', 'caller', 'admin')),
  display_name VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_npu_email_active ON nucleus_phone_users(email) WHERE is_active = TRUE;
