-- BrandStudios OS Phase 2 Migration
-- Campaigns, HITL decisions, and per-client storage config

-- ============================================
-- ENUMS
-- ============================================

CREATE TYPE campaign_status AS ENUM ('draft', 'pending', 'running', 'needs_review', 'completed', 'failed');
CREATE TYPE hitl_decision_type AS ENUM ('approve', 'reject', 'changes');
CREATE TYPE storage_type AS ENUM ('cloudinary', 's3', 'supabase');

-- ============================================
-- TABLES
-- ============================================

-- Campaigns table
CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  deliverables JSONB NOT NULL DEFAULT '{"images": 1, "videos": 0}',
  platforms JSONB NOT NULL DEFAULT '["web"]',
  status campaign_status NOT NULL DEFAULT 'draft',
  scheduled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HITL Decisions table
CREATE TABLE hitl_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id UUID NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  reviewer_id TEXT, -- For future auth
  decision hitl_decision_type NOT NULL,
  notes TEXT,
  grade_scores JSONB, -- Store {clip: 0.85, e5: 0.72, cohere: 0.91, fused: 0.83}
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add storage_config to clients
ALTER TABLE clients ADD COLUMN IF NOT EXISTS storage_config JSONB DEFAULT NULL;

-- Add pinecone_namespace to clients
ALTER TABLE clients ADD COLUMN IF NOT EXISTS pinecone_namespace TEXT;

-- Add campaign_id reference to runs
ALTER TABLE runs ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;

-- Add prompt to runs (for direct runs without campaign)
ALTER TABLE runs ADD COLUMN IF NOT EXISTS prompt TEXT;

-- Add grade/score to artifacts
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS grade JSONB;

-- Add thumbnail_url to artifacts (for gallery preview)
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_campaigns_client_id ON campaigns(client_id);
CREATE INDEX idx_campaigns_status ON campaigns(status);
CREATE INDEX idx_campaigns_created_at ON campaigns(created_at DESC);
CREATE INDEX idx_hitl_decisions_artifact_id ON hitl_decisions(artifact_id);
CREATE INDEX idx_hitl_decisions_run_id ON hitl_decisions(run_id);
CREATE INDEX idx_runs_campaign_id ON runs(campaign_id);

-- ============================================
-- UPDATED_AT TRIGGER FOR CAMPAIGNS
-- ============================================

CREATE TRIGGER update_campaigns_updated_at
  BEFORE UPDATE ON campaigns
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE hitl_decisions ENABLE ROW LEVEL SECURITY;

-- Public access policies (temporary - tighten with auth later)
CREATE POLICY "Allow public read on campaigns" ON campaigns FOR SELECT USING (true);
CREATE POLICY "Allow public insert on campaigns" ON campaigns FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update on campaigns" ON campaigns FOR UPDATE USING (true);
CREATE POLICY "Allow public delete on campaigns" ON campaigns FOR DELETE USING (true);

CREATE POLICY "Allow public read on hitl_decisions" ON hitl_decisions FOR SELECT USING (true);
CREATE POLICY "Allow public insert on hitl_decisions" ON hitl_decisions FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update on hitl_decisions" ON hitl_decisions FOR UPDATE USING (true);

-- Update artifact policies to allow updates
DROP POLICY IF EXISTS "Allow public update on artifacts" ON artifacts;
CREATE POLICY "Allow public update on artifacts" ON artifacts FOR UPDATE USING (true);

-- ============================================
-- REALTIME
-- ============================================

ALTER PUBLICATION supabase_realtime ADD TABLE campaigns;
ALTER PUBLICATION supabase_realtime ADD TABLE hitl_decisions;

-- ============================================
-- UPDATE EXISTING CLIENTS WITH PINECONE NAMESPACES
-- ============================================

UPDATE clients SET pinecone_namespace = 'jenni_kayne' WHERE id = 'client_jenni_kayne';
UPDATE clients SET pinecone_namespace = 'lilydale' WHERE id = 'client_lilydale';
UPDATE clients SET pinecone_namespace = 'cylndr' WHERE id = 'client_cylndr';

-- Set default storage configs
UPDATE clients SET storage_config = '{"type": "cloudinary", "folder": "brand-assets/"}'::jsonb
WHERE id IN ('client_jenni_kayne', 'client_lilydale');

UPDATE clients SET storage_config = '{"type": "s3", "bucket": "cylndr-brand-assets"}'::jsonb
WHERE id = 'client_cylndr';
