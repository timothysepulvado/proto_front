-- BrandStudios OS Phase 6.5 Migration
-- Generation Feedback Loop: Campaigns v2 with retry tracking and rejection categories

-- ============================================
-- ENUMS
-- ============================================

-- Deliverable status enum
CREATE TYPE deliverable_status AS ENUM (
  'pending',
  'generating',
  'scoring',
  'hitl',
  'approved',
  'failed',
  'retry_queued'
);

-- Campaign mode enum
CREATE TYPE campaign_mode AS ENUM (
  'campaign',  -- Guardrails mode: strict brand compliance
  'creative'   -- Flexible mode: more creative freedom
);

-- Rejection category enum
CREATE TYPE rejection_category AS ENUM (
  'too_dark',
  'too_bright',
  'wrong_colors',
  'off_brand',
  'wrong_composition',
  'cluttered',
  'wrong_model',
  'wrong_outfit',
  'quality_issue',
  'other'
);

-- ============================================
-- TABLES
-- ============================================

-- Campaign deliverables table - tracks individual items in a campaign
CREATE TABLE campaign_deliverables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  ai_model TEXT DEFAULT 'nano',  -- nano, veo, sora
  status deliverable_status NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  current_prompt TEXT NOT NULL,
  original_prompt TEXT NOT NULL,
  negative_prompts TEXT[] DEFAULT '{}',
  rejection_reasons rejection_category[] DEFAULT '{}',
  custom_rejection_note TEXT,
  artifact_id UUID REFERENCES artifacts(id) ON DELETE SET NULL,
  score JSONB,  -- {clip, e5, cohere, fused, decision}
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Campaign short-term memory table - per-campaign rejection tracking
CREATE TABLE campaign_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  deliverable_id UUID NOT NULL REFERENCES campaign_deliverables(id) ON DELETE CASCADE,
  retry_attempt INTEGER NOT NULL,
  rejection_reasons rejection_category[] NOT NULL DEFAULT '{}',
  custom_notes TEXT,
  negative_prompts TEXT[] NOT NULL DEFAULT '{}',
  prompt_before TEXT NOT NULL,
  prompt_after TEXT NOT NULL,
  score_before JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Rejection category definitions table
CREATE TABLE rejection_categories (
  id rejection_category PRIMARY KEY,
  label TEXT NOT NULL,
  negative_prompt TEXT NOT NULL,
  positive_guidance TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- ALTER EXISTING TABLES
-- ============================================

-- Add v2 fields to campaigns table
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS mode campaign_mode DEFAULT 'campaign';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS max_retries INTEGER DEFAULT 3;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS reference_images TEXT[] DEFAULT '{}';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS guardrails JSONB DEFAULT '{}';
-- guardrails: {season, colorPalette[], styleNotes}
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS total_deliverables INTEGER DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS approved_count INTEGER DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS failed_count INTEGER DEFAULT 0;

-- Add rejection tracking to hitl_decisions
ALTER TABLE hitl_decisions ADD COLUMN IF NOT EXISTS rejection_categories rejection_category[] DEFAULT '{}';
ALTER TABLE hitl_decisions ADD COLUMN IF NOT EXISTS custom_rejection_note TEXT;

-- Add retry metadata to artifacts
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS deliverable_id UUID REFERENCES campaign_deliverables(id) ON DELETE SET NULL;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS retry_number INTEGER DEFAULT 0;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS prompt_used TEXT;

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_campaign_deliverables_campaign_id ON campaign_deliverables(campaign_id);
CREATE INDEX idx_campaign_deliverables_status ON campaign_deliverables(status);
CREATE INDEX idx_campaign_deliverables_artifact_id ON campaign_deliverables(artifact_id);
CREATE INDEX idx_campaign_memory_campaign_id ON campaign_memory(campaign_id);
CREATE INDEX idx_campaign_memory_deliverable_id ON campaign_memory(deliverable_id);
CREATE INDEX idx_artifacts_deliverable_id ON artifacts(deliverable_id);

-- ============================================
-- UPDATED_AT TRIGGERS
-- ============================================

CREATE TRIGGER update_campaign_deliverables_updated_at
  BEFORE UPDATE ON campaign_deliverables
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

ALTER TABLE campaign_deliverables ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE rejection_categories ENABLE ROW LEVEL SECURITY;

-- Public access policies (temporary - tighten with auth later)
CREATE POLICY "Allow public read on campaign_deliverables" ON campaign_deliverables FOR SELECT USING (true);
CREATE POLICY "Allow public insert on campaign_deliverables" ON campaign_deliverables FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update on campaign_deliverables" ON campaign_deliverables FOR UPDATE USING (true);
CREATE POLICY "Allow public delete on campaign_deliverables" ON campaign_deliverables FOR DELETE USING (true);

CREATE POLICY "Allow public read on campaign_memory" ON campaign_memory FOR SELECT USING (true);
CREATE POLICY "Allow public insert on campaign_memory" ON campaign_memory FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public read on rejection_categories" ON rejection_categories FOR SELECT USING (true);

-- ============================================
-- REALTIME
-- ============================================

ALTER PUBLICATION supabase_realtime ADD TABLE campaign_deliverables;

-- ============================================
-- SEED REJECTION CATEGORIES
-- ============================================

INSERT INTO rejection_categories (id, label, negative_prompt, positive_guidance) VALUES
  ('too_dark', 'Too Dark', 'dark lighting, shadows, underexposed, dim, murky', 'bright natural lighting, well-lit'),
  ('too_bright', 'Too Bright', 'overexposed, washed out, harsh light, blown out highlights', 'soft natural lighting, balanced exposure'),
  ('wrong_colors', 'Wrong Colors', 'neon colors, saturated colors, vibrant colors, harsh colors', 'natural color palette, muted tones'),
  ('off_brand', 'Off Brand', 'off-brand aesthetic, inconsistent style, mismatched vibe', 'brand-aligned aesthetic, consistent styling'),
  ('wrong_composition', 'Wrong Composition', 'poor framing, bad crop, awkward angles, unbalanced', 'well-composed, balanced framing, rule of thirds'),
  ('cluttered', 'Too Cluttered', 'busy background, clutter, distracting elements, messy', 'clean background, minimal distractions, organized'),
  ('wrong_model', 'Wrong Model/Person', 'different person, wrong model, inconsistent face', 'consistent model appearance'),
  ('wrong_outfit', 'Wrong Outfit', 'wrong clothing, incorrect outfit, mismatched attire', 'correct outfit as specified'),
  ('quality_issue', 'Quality Issue', 'artifacts, blur, distortion, noise, compression', 'high quality, sharp, clean'),
  ('other', 'Other', '', '')
ON CONFLICT (id) DO UPDATE SET
  label = EXCLUDED.label,
  negative_prompt = EXCLUDED.negative_prompt,
  positive_guidance = EXCLUDED.positive_guidance;

-- ============================================
-- FUNCTIONS
-- ============================================

-- Function to get pending deliverables for retry
CREATE OR REPLACE FUNCTION get_retry_batch(p_campaign_id UUID, p_max_retries INTEGER)
RETURNS TABLE (
  deliverable_id UUID,
  retry_count INTEGER,
  current_prompt TEXT,
  rejection_reasons rejection_category[],
  ai_model TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    cd.id as deliverable_id,
    cd.retry_count,
    cd.current_prompt,
    cd.rejection_reasons,
    cd.ai_model
  FROM campaign_deliverables cd
  WHERE cd.campaign_id = p_campaign_id
    AND cd.status = 'retry_queued'
    AND cd.retry_count < p_max_retries
  ORDER BY cd.created_at;
END;
$$ LANGUAGE plpgsql;

-- Function to get campaign progress
CREATE OR REPLACE FUNCTION get_campaign_progress(p_campaign_id UUID)
RETURNS TABLE (
  total INTEGER,
  pending INTEGER,
  generating INTEGER,
  scoring INTEGER,
  hitl INTEGER,
  approved INTEGER,
  failed INTEGER,
  retry_queued INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::INTEGER as total,
    COUNT(*) FILTER (WHERE status = 'pending')::INTEGER as pending,
    COUNT(*) FILTER (WHERE status = 'generating')::INTEGER as generating,
    COUNT(*) FILTER (WHERE status = 'scoring')::INTEGER as scoring,
    COUNT(*) FILTER (WHERE status = 'hitl')::INTEGER as hitl,
    COUNT(*) FILTER (WHERE status = 'approved')::INTEGER as approved,
    COUNT(*) FILTER (WHERE status = 'failed')::INTEGER as failed,
    COUNT(*) FILTER (WHERE status = 'retry_queued')::INTEGER as retry_queued
  FROM campaign_deliverables
  WHERE campaign_id = p_campaign_id;
END;
$$ LANGUAGE plpgsql;

-- Function to mark deliverable for retry with rejection reasons
CREATE OR REPLACE FUNCTION mark_for_retry(
  p_deliverable_id UUID,
  p_rejection_reasons rejection_category[],
  p_custom_note TEXT DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
  v_campaign_id UUID;
  v_max_retries INTEGER;
  v_current_retry INTEGER;
  v_current_prompt TEXT;
  v_negative_prompts TEXT[];
  v_new_negatives TEXT[];
BEGIN
  -- Get deliverable info
  SELECT cd.campaign_id, cd.retry_count, cd.current_prompt, cd.negative_prompts
  INTO v_campaign_id, v_current_retry, v_current_prompt, v_negative_prompts
  FROM campaign_deliverables cd
  WHERE cd.id = p_deliverable_id;

  -- Get campaign max retries
  SELECT max_retries INTO v_max_retries
  FROM campaigns
  WHERE id = v_campaign_id;

  -- Check if max retries exceeded
  IF v_current_retry >= v_max_retries THEN
    UPDATE campaign_deliverables
    SET status = 'failed', updated_at = NOW()
    WHERE id = p_deliverable_id;
    RETURN FALSE;
  END IF;

  -- Get negative prompts for rejection categories
  SELECT ARRAY_AGG(rc.negative_prompt)
  INTO v_new_negatives
  FROM rejection_categories rc
  WHERE rc.id = ANY(p_rejection_reasons)
    AND rc.negative_prompt != '';

  -- Update deliverable for retry
  UPDATE campaign_deliverables
  SET
    status = 'retry_queued',
    retry_count = retry_count + 1,
    rejection_reasons = p_rejection_reasons,
    custom_rejection_note = p_custom_note,
    negative_prompts = v_negative_prompts || COALESCE(v_new_negatives, '{}'),
    updated_at = NOW()
  WHERE id = p_deliverable_id;

  -- Record in campaign memory
  INSERT INTO campaign_memory (
    campaign_id,
    deliverable_id,
    retry_attempt,
    rejection_reasons,
    custom_notes,
    negative_prompts,
    prompt_before,
    prompt_after
  ) VALUES (
    v_campaign_id,
    p_deliverable_id,
    v_current_retry + 1,
    p_rejection_reasons,
    p_custom_note,
    COALESCE(v_new_negatives, '{}'),
    v_current_prompt,
    v_current_prompt  -- Will be updated by prompt modifier
  );

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
