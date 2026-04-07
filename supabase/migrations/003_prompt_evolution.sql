-- Migration 003: Prompt evolution system
-- Versioned prompt templates, scoring, and evolution tracking

-- Prompt templates (versioned prompts per client/campaign)
CREATE TABLE IF NOT EXISTS prompt_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  stage TEXT NOT NULL DEFAULT 'generate',
  version INTEGER NOT NULL DEFAULT 1,
  prompt_text TEXT NOT NULL,
  parent_id UUID REFERENCES prompt_templates(id) ON DELETE SET NULL,
  is_active BOOLEAN DEFAULT true,
  source TEXT DEFAULT 'manual',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prompt scores (per-use scoring)
CREATE TABLE IF NOT EXISTS prompt_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id UUID NOT NULL REFERENCES prompt_templates(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  artifact_id UUID REFERENCES artifacts(id) ON DELETE SET NULL,
  score FLOAT NOT NULL,
  gate_decision TEXT,
  feedback TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prompt evolution log (tracks mutations)
CREATE TABLE IF NOT EXISTS prompt_evolution_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_prompt_id UUID NOT NULL REFERENCES prompt_templates(id) ON DELETE CASCADE,
  child_prompt_id UUID NOT NULL REFERENCES prompt_templates(id) ON DELETE CASCADE,
  run_id UUID REFERENCES runs(id) ON DELETE SET NULL,
  trigger TEXT NOT NULL DEFAULT 'auto',
  reason TEXT,
  rejection_categories TEXT[],
  score_before FLOAT,
  score_after FLOAT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_prompt_templates_client ON prompt_templates(client_id);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_campaign ON prompt_templates(campaign_id);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_active ON prompt_templates(client_id, stage, is_active);
CREATE INDEX IF NOT EXISTS idx_prompt_scores_prompt ON prompt_scores(prompt_id);
CREATE INDEX IF NOT EXISTS idx_prompt_scores_run ON prompt_scores(run_id);
CREATE INDEX IF NOT EXISTS idx_prompt_evolution_parent ON prompt_evolution_log(parent_prompt_id);
CREATE INDEX IF NOT EXISTS idx_prompt_evolution_child ON prompt_evolution_log(child_prompt_id);

-- RLS
ALTER TABLE prompt_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_evolution_log ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['prompt_templates', 'prompt_scores', 'prompt_evolution_log']) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = tbl AND policyname = 'Allow all access to ' || tbl
    ) THEN
      EXECUTE format('CREATE POLICY "Allow all access to %I" ON %I FOR ALL USING (true) WITH CHECK (true)', tbl, tbl);
    END IF;
  END LOOP;
END $$;

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE prompt_templates;
ALTER PUBLICATION supabase_realtime ADD TABLE prompt_scores;
