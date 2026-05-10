-- 019_rejection_learning_events.sql
-- ADR-006 D4 Schema D4-1 — append-only Reject-as-Teach learning log
BEGIN;

CREATE TABLE IF NOT EXISTS rejection_learning_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  campaign_id    UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  shot_id        INTEGER,
  asset_id       UUID REFERENCES artifacts(id) ON DELETE SET NULL,
  category_id    rejection_category REFERENCES rejection_categories(id),
  what_wrong     TEXT NOT NULL,
  correction     TEXT NOT NULL,
  ref_image_path TEXT,
  block_mode     TEXT NOT NULL CHECK (block_mode IN ('soft', 'terminal')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rlearn_client_campaign
  ON rejection_learning_events (client_id, campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rlearn_shot
  ON rejection_learning_events (campaign_id, shot_id);

ALTER TABLE rejection_learning_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rlearn_client_read ON rejection_learning_events;
CREATE POLICY rlearn_client_read ON rejection_learning_events
  FOR SELECT USING (
    client_id = jwt_client_id() OR auth.role() = 'service_role'
  );

DROP POLICY IF EXISTS rlearn_client_write ON rejection_learning_events;
CREATE POLICY rlearn_client_write ON rejection_learning_events
  FOR INSERT WITH CHECK (
    client_id = jwt_client_id() OR auth.role() = 'service_role'
  );
-- No UPDATE / DELETE policies — rejection learnings are append-only audit rows.

COMMIT;
