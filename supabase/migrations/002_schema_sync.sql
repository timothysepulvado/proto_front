-- Migration 002: Sync schema with live Supabase database
-- The live DB has tables and columns not in migration 001. This brings migrations up to date.

-- ============ Missing columns on existing tables ============

-- clients: add brand-specific columns
ALTER TABLE clients ADD COLUMN IF NOT EXISTS brand_slug TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS pinecone_namespace TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS storage_config JSONB;

-- runs: add campaign_id
ALTER TABLE runs ADD COLUMN IF NOT EXISTS campaign_id UUID;

-- ============ New tables ============

-- Campaigns
CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT,
  deliverables JSONB,
  platforms TEXT[],
  mode TEXT DEFAULT 'full',
  max_retries INTEGER DEFAULT 3,
  reference_images TEXT[],
  guardrails JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Campaign deliverables (per-asset tracking)
CREATE TABLE IF NOT EXISTS campaign_deliverables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  description TEXT,
  ai_model TEXT,
  current_prompt TEXT,
  original_prompt TEXT,
  status TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Campaign memory (prompt evolution history)
CREATE TABLE IF NOT EXISTS campaign_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  deliverable_id UUID REFERENCES campaign_deliverables(id) ON DELETE SET NULL,
  prompt_before TEXT,
  prompt_after TEXT,
  score_before FLOAT,
  score_after FLOAT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Brand baselines (versioned similarity baselines)
CREATE TABLE IF NOT EXISTS brand_baselines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  version INTEGER DEFAULT 1,
  is_active BOOLEAN DEFAULT true,
  clip_baseline_z FLOAT,
  e5_baseline_z FLOAT,
  cohere_baseline_z FLOAT,
  fused_baseline_z FLOAT,
  clip_baseline_raw FLOAT,
  e5_baseline_raw FLOAT,
  cohere_baseline_raw FLOAT,
  clip_stddev FLOAT,
  e5_stddev FLOAT,
  cohere_stddev FLOAT,
  sample_count INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Drift metrics (per-run drift scores)
CREATE TABLE IF NOT EXISTS drift_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  artifact_id UUID REFERENCES artifacts(id) ON DELETE SET NULL,
  clip_z FLOAT,
  e5_z FLOAT,
  cohere_z FLOAT,
  fused_z FLOAT,
  clip_raw FLOAT,
  e5_raw FLOAT,
  cohere_raw FLOAT,
  gate_decision TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Drift alerts
CREATE TABLE IF NOT EXISTS drift_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  severity TEXT NOT NULL CHECK (severity IN ('warn', 'error', 'critical')),
  message TEXT NOT NULL,
  fused_z FLOAT,
  acknowledged BOOLEAN DEFAULT false,
  acknowledged_at TIMESTAMPTZ,
  resolution_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HITL decisions
CREATE TABLE IF NOT EXISTS hitl_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  artifact_id UUID REFERENCES artifacts(id) ON DELETE SET NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'needs_revision')),
  notes TEXT,
  grade_scores JSONB,
  rejection_categories TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rejection categories (taxonomy)
CREATE TABLE IF NOT EXISTS rejection_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  negative_prompt TEXT,
  positive_guidance TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ Indexes ============

CREATE INDEX IF NOT EXISTS idx_campaigns_client_id ON campaigns(client_id);
CREATE INDEX IF NOT EXISTS idx_campaign_deliverables_campaign_id ON campaign_deliverables(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_memory_campaign_id ON campaign_memory(campaign_id);
CREATE INDEX IF NOT EXISTS idx_brand_baselines_client_id ON brand_baselines(client_id);
CREATE INDEX IF NOT EXISTS idx_drift_metrics_run_id ON drift_metrics(run_id);
CREATE INDEX IF NOT EXISTS idx_drift_alerts_client_id ON drift_alerts(client_id);
CREATE INDEX IF NOT EXISTS idx_drift_alerts_run_id ON drift_alerts(run_id);
CREATE INDEX IF NOT EXISTS idx_hitl_decisions_run_id ON hitl_decisions(run_id);
CREATE INDEX IF NOT EXISTS idx_hitl_decisions_artifact_id ON hitl_decisions(artifact_id);
CREATE INDEX IF NOT EXISTS idx_runs_campaign_id ON runs(campaign_id);

-- ============ RLS Policies (permissive — tighten for multi-tenant) ============

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_deliverables ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE drift_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE drift_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hitl_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rejection_categories ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'campaigns', 'campaign_deliverables', 'campaign_memory',
    'brand_baselines', 'drift_metrics', 'drift_alerts',
    'hitl_decisions', 'rejection_categories'
  ]) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = tbl AND policyname = 'Allow all access to ' || tbl
    ) THEN
      EXECUTE format('CREATE POLICY "Allow all access to %I" ON %I FOR ALL USING (true) WITH CHECK (true)', tbl, tbl);
    END IF;
  END LOOP;
END $$;

-- ============ Realtime ============

ALTER PUBLICATION supabase_realtime ADD TABLE drift_metrics;
ALTER PUBLICATION supabase_realtime ADD TABLE drift_alerts;
ALTER PUBLICATION supabase_realtime ADD TABLE hitl_decisions;
ALTER PUBLICATION supabase_realtime ADD TABLE campaigns;

-- ============ Seed rejection categories ============

INSERT INTO rejection_categories (name, description, negative_prompt, positive_guidance) VALUES
  ('too_dark', 'Image is too dark overall', 'not dark, not underexposed, not shadowy', 'bright, well-lit, natural lighting'),
  ('too_bright', 'Image is overexposed or washed out', 'not overexposed, not washed out, not blown highlights', 'balanced exposure, natural tones'),
  ('wrong_colors', 'Colors don''t match brand palette', 'avoid off-brand colors, no neon, no clashing tones', 'use brand-approved color palette'),
  ('off_brand', 'General brand misalignment', 'not generic, not stock-photo-like', 'authentic to brand identity and values'),
  ('wrong_composition', 'Layout or framing issues', 'avoid awkward cropping, no cluttered layout', 'balanced composition, clear focal point'),
  ('cluttered', 'Too many elements, visual noise', 'not busy, not cluttered, minimal distractions', 'clean, minimal, focused'),
  ('wrong_model', 'Model doesn''t match brand demographic', 'avoid mismatched demographics', 'diverse, authentic representation'),
  ('wrong_outfit', 'Clothing doesn''t match brand style', 'avoid off-brand styling', 'on-brand fashion and styling'),
  ('quality_issue', 'Technical quality problem (blur, artifacts)', 'not blurry, no artifacts, no distortion', 'sharp, high-resolution, clean rendering'),
  ('other', 'Other issue not covered above', '', '')
ON CONFLICT (name) DO NOTHING;
