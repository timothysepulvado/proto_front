-- 013_client_ui_config.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds a `ui_config` JSONB column to the `clients` table for multi-tenant
-- presentation overrides — display_name, entity_label, featured flag, and
-- any future per-tenant UI configuration.
--
-- Why JSONB (not new columns per-flag):
--   1. Matches the existing `storage_config` JSONB pattern on the same table.
--   2. Extensible for future UI flags (themes, feature gates, branding) without
--      another migration round-trip per flag.
--   3. Multi-tenant SaaS canonical pattern (Stripe Connect, Auth0 tenants):
--      typed runtime contract enforced in app layer, not schema.
--   4. Frontend reads the entire blob in one query at mount.
--
-- Source: PR #2 CodeRabbit review section 0.B.3 (`src/App.tsx:111`).
-- The `clientUiConfig` constant currently hardcodes:
--   "client_drift-mv": { displayName: "BrandStudios", entityLabel: "Agency", featured: true }
-- Karl will move that hardcoded map to read from `clients.ui_config` after
-- this migration applies.
--
-- Idempotent via IF NOT EXISTS. Safe to re-apply.
-- Tim authorized 2026-05-02 (Phase 0.B carve-out per plan streamed-chasing-willow).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE clients ADD COLUMN IF NOT EXISTS ui_config JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Seed: set the BrandStudios UI override that's currently hardcoded in App.tsx.
-- Karl deletes the hardcoded map after wiring App.tsx to read this row.
UPDATE clients
SET ui_config = jsonb_build_object(
    'display_name', 'BrandStudios',
    'entity_label', 'Agency',
    'featured', true
  )
WHERE id = 'client_drift-mv'
  AND ui_config = '{}'::jsonb;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification queries (manual smoke after apply):
--   SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'clients' AND column_name = 'ui_config';
--   -- Expected: 1 row, jsonb, '{}'::jsonb default.
--
--   SELECT id, ui_config FROM clients WHERE id = 'client_drift-mv';
--   -- Expected: ui_config = {"display_name": "BrandStudios",
--   --                        "entity_label": "Agency", "featured": true}
-- ─────────────────────────────────────────────────────────────────────────────
