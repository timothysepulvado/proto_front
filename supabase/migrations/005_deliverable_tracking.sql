-- Migration 005: Wire campaign_deliverables through generation + HITL pipeline
-- Adds deliverable_id FK to artifacts, status index, updated_at trigger, realtime,
-- and extends deliverable_status enum with our pipeline statuses.

-- Extend deliverable_status enum with pipeline status values
ALTER TYPE deliverable_status ADD VALUE IF NOT EXISTS 'reviewing';
ALTER TYPE deliverable_status ADD VALUE IF NOT EXISTS 'rejected';
ALTER TYPE deliverable_status ADD VALUE IF NOT EXISTS 'regenerating';

-- Add deliverable_id FK to artifacts (missing from all prior migrations)
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS deliverable_id UUID
  REFERENCES campaign_deliverables(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_deliverable_id ON artifacts(deliverable_id);

-- Status index for deliverable queries (pending/regenerating lookups)
CREATE INDEX IF NOT EXISTS idx_campaign_deliverables_status ON campaign_deliverables(status);

-- updated_at trigger (update_updated_at_column function exists from 001)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_campaign_deliverables'
  ) THEN
    CREATE TRIGGER set_updated_at_campaign_deliverables
      BEFORE UPDATE ON campaign_deliverables
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- Realtime — add only if not already a member
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'campaign_deliverables'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE campaign_deliverables;
  END IF;
END $$;
