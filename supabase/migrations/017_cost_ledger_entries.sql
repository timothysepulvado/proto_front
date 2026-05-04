-- 017_cost_ledger_entries.sql
-- PR #4 Phase D — Per-event cost ledger for multi-tenant billing audit
BEGIN;

-- ===== Schema =====
CREATE TABLE IF NOT EXISTS cost_ledger_entries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  run_id            UUID REFERENCES runs(id) ON DELETE CASCADE,
  deliverable_id    UUID REFERENCES campaign_deliverables(id) ON DELETE SET NULL,
  artifact_id       UUID REFERENCES artifacts(id) ON DELETE SET NULL,
  escalation_id     UUID REFERENCES asset_escalations(id) ON DELETE SET NULL,

  -- Event classification
  event_type        TEXT NOT NULL,
    -- enum-like values, enforced app-side for now:
    -- 'orchestrator_decision', 'video_generate', 'image_generate',
    -- 'video_critic', 'image_critic', 'consensus_critic', 'embedding'
  source            TEXT NOT NULL,
    -- model/api id: 'opus-4.7', 'veo-3.1-generate-001', 'veo-3.1-lite-generate-001',
    --              'gemini-3-pro-image-preview', 'gemini-3.1-pro-preview',
    --              'cohere-embed-v4', 'gemini-embedding-2'

  -- Cost (USD; numeric for accuracy)
  cost_usd          NUMERIC(12,6) NOT NULL CHECK (cost_usd >= 0),

  -- Token / unit accounting (optional; populated where applicable)
  tokens_input      INTEGER,
  tokens_output     INTEGER,
  tokens_cached     INTEGER,
  units             NUMERIC(10,3),  -- e.g. seconds for Veo, frames for tiebreak
  units_kind        TEXT,           -- 'seconds', 'frames', 'images', null

  -- Provenance / replay
  metadata          JSONB DEFAULT '{}'::jsonb,
    -- e.g. { "request_id": "...", "model_version": "...", "duration_seconds": 8 }
  rate_card_version TEXT NOT NULL DEFAULT 'v1',
    -- bump when pricing constants change; allows re-cost queries vs historical rates

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===== Indexes =====
CREATE INDEX IF NOT EXISTS idx_cost_ledger_client_created ON cost_ledger_entries(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_run ON cost_ledger_entries(run_id);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_deliverable ON cost_ledger_entries(deliverable_id);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_event_type ON cost_ledger_entries(event_type);

-- ===== RLS =====
ALTER TABLE cost_ledger_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY cost_ledger_client_read ON cost_ledger_entries
  FOR SELECT USING (
    client_id = jwt_client_id() OR auth.role() = 'service_role'
  );

CREATE POLICY cost_ledger_service_write ON cost_ledger_entries
  FOR INSERT WITH CHECK (
    auth.role() = 'service_role'
  );
-- No UPDATE / DELETE policies — ledger is append-only for audit. Service role bypasses
-- via RLS exception for INSERT only; corrections happen via compensating entries.

COMMIT;
