-- Migration 007: Escalation System (known limitations + asset escalations + orchestration decisions)
-- Productizes the Shot Escalation Ladder doctrine from Drift MV into persistent schema.
-- Three tables: institutional catalog, per-artifact state machine, per-decision audit trail.

-- ─────────────────────────────────────────────────────────────────────────────
-- known_limitations: catalog of model failure modes (persists across productions)
-- Seeded from Drift MV's Phase 2 v2→v4 learnings (qa_prompt_evolution.md).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS known_limitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model TEXT NOT NULL,                            -- e.g. 'veo-3.1-generate-001', 'gemini-3-pro-image-preview'
  category TEXT NOT NULL,                         -- 'atmospheric' | 'temporal' | 'character' | 'lighting' | 'zoom'
  failure_mode TEXT NOT NULL UNIQUE,              -- snake_case identifier, e.g. 'atmospheric_creep_fire_smoke_aerial'
  description TEXT NOT NULL,
  mitigation TEXT,                                -- recommended workaround / rule to apply
  severity TEXT NOT NULL,                         -- 'warning' (proceed with caution) | 'blocking' (must escalate)
  detected_in_production_id TEXT,                 -- e.g. 'drift-mv'
  detected_in_run_id UUID,
  times_encountered INT NOT NULL DEFAULT 1,       -- increments every time a future production hits this wall
  last_encountered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT known_limitations_severity_check CHECK (severity IN ('warning', 'blocking'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- asset_escalations: per-artifact state machine for wall-hits
-- One row per artifact that fails QA twice on the same class. Tracks L-level,
-- iteration count, resolution path, linked limitation, successor artifact.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS asset_escalations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id UUID NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  deliverable_id UUID REFERENCES campaign_deliverables(id) ON DELETE SET NULL,
  run_id UUID REFERENCES runs(id) ON DELETE CASCADE,
  current_level TEXT NOT NULL DEFAULT 'L1',       -- 'L1' | 'L2' | 'L3'
  status TEXT NOT NULL DEFAULT 'in_progress',     -- 'in_progress' | 'resolved' | 'accepted' | 'redesigned' | 'replaced' | 'hitl_required'
  iteration_count INT NOT NULL DEFAULT 0,
  failure_class TEXT,                             -- matches known_limitations.failure_mode when classified
  known_limitation_id UUID REFERENCES known_limitations(id) ON DELETE SET NULL,
  resolution_path TEXT,                           -- 'prompt_fix' | 'approach_change' | 'accept' | 'redesign' | 'replace'
  resolution_notes TEXT,
  final_artifact_id UUID REFERENCES artifacts(id) ON DELETE SET NULL,  -- successor artifact that resolved this escalation
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT asset_escalations_level_check CHECK (current_level IN ('L1', 'L2', 'L3')),
  CONSTRAINT asset_escalations_status_check CHECK (status IN ('in_progress', 'resolved', 'accepted', 'redesigned', 'replaced', 'hitl_required')),
  CONSTRAINT asset_escalations_resolution_check CHECK (resolution_path IS NULL OR resolution_path IN ('prompt_fix', 'approach_change', 'accept', 'redesign', 'replace'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- orchestration_decisions: per-decision audit trail (every Claude orchestrator call)
-- Captures input context + decision output for every escalation step.
-- This is the RL training corpus for future orchestrator fine-tuning.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orchestration_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escalation_id UUID NOT NULL REFERENCES asset_escalations(id) ON DELETE CASCADE,
  run_id UUID REFERENCES runs(id) ON DELETE CASCADE,
  iteration INT NOT NULL,                         -- 1st, 2nd, 3rd... decision in this escalation
  input_context JSONB NOT NULL,                   -- artifact_id, qa_verdict, prompt_history, catalog, attempt_count
  decision JSONB NOT NULL,                        -- level, action, failure_class, new_prompts, reasoning, confidence
  model TEXT NOT NULL,                            -- e.g. 'claude-opus-4-7-20260101'
  tokens_in INT,
  tokens_out INT,
  cost NUMERIC(10, 6),                            -- USD, 6 decimal places
  latency_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_known_limitations_model ON known_limitations(model);
CREATE INDEX IF NOT EXISTS idx_known_limitations_category ON known_limitations(category);
CREATE INDEX IF NOT EXISTS idx_known_limitations_severity ON known_limitations(severity);

CREATE INDEX IF NOT EXISTS idx_asset_escalations_artifact ON asset_escalations(artifact_id);
CREATE INDEX IF NOT EXISTS idx_asset_escalations_deliverable ON asset_escalations(deliverable_id);
CREATE INDEX IF NOT EXISTS idx_asset_escalations_run ON asset_escalations(run_id);
CREATE INDEX IF NOT EXISTS idx_asset_escalations_status ON asset_escalations(status);
CREATE INDEX IF NOT EXISTS idx_asset_escalations_limitation ON asset_escalations(known_limitation_id);

CREATE INDEX IF NOT EXISTS idx_orchestration_decisions_escalation ON orchestration_decisions(escalation_id);
CREATE INDEX IF NOT EXISTS idx_orchestration_decisions_run ON orchestration_decisions(run_id);
CREATE INDEX IF NOT EXISTS idx_orchestration_decisions_model ON orchestration_decisions(model);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security (allow-all to match existing pattern from migration 003;
-- tighten in a future migration when auth is wired through)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE known_limitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_escalations ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_decisions ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['known_limitations', 'asset_escalations', 'orchestration_decisions']) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = tbl AND policyname = 'Allow all access to ' || tbl
    ) THEN
      EXECUTE format('CREATE POLICY "Allow all access to %I" ON %I FOR ALL USING (true) WITH CHECK (true)', tbl, tbl);
    END IF;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime publications (so HUD can subscribe when UI lands in Phase C3)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'known_limitations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE known_limitations;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'asset_escalations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE asset_escalations;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'orchestration_decisions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE orchestration_decisions;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Updated_at trigger for known_limitations + asset_escalations
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_escalation_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_known_limitations_updated_at ON known_limitations;
CREATE TRIGGER trg_known_limitations_updated_at
  BEFORE UPDATE ON known_limitations
  FOR EACH ROW EXECUTE FUNCTION update_escalation_updated_at();

DROP TRIGGER IF EXISTS trg_asset_escalations_updated_at ON asset_escalations;
CREATE TRIGGER trg_asset_escalations_updated_at
  BEFORE UPDATE ON asset_escalations
  FOR EACH ROW EXECUTE FUNCTION update_escalation_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- SEED DATA — 7 Veo 3.1 limitations discovered during Drift MV production
-- Source: ~/Temp-gen/productions/drift-mv/qa_prompt_evolution.md
-- Idempotent via ON CONFLICT on unique failure_mode.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO known_limitations (model, category, failure_mode, description, mitigation, severity, detected_in_production_id)
VALUES
  (
    'veo-3.1-generate-001',
    'atmospheric',
    'atmospheric_creep_fire_smoke_aerial',
    'Extended aerial shots over scenes containing fire, smoke columns, or burning buildings accumulate atmospheric haze in the last 3-4 seconds regardless of camera trajectory or negation prompts. Veo exhibits a scene-content-driven atmospheric generation bias even with triple-locked "zero fog, zero cloud, zero atmospheric haze" negation.',
    'Remove fire/smoke from scene description. OR use fixed-altitude lateral orbit AND trim clip to first 60-70 percent. OR redesign as ground-level composition avoiding the aerial entirely.',
    'blocking',
    'drift-mv'
  ),
  (
    'veo-3.1-generate-001',
    'atmospheric',
    'atmospheric_generation_ascending_aerial',
    'Ascending camera moves in aerial shots trigger atmospheric layer generation (fog, cloud, haze) regardless of negation prompts like "stays below cloud layer" or "clear visibility throughout." Veo treats ascending trajectory as a cue to add atmospheric layers.',
    'Use fixed-altitude lateral movement (orbit, pan, lateral dolly). Avoid ascending pullbacks when ground detail must remain visible.',
    'blocking',
    'drift-mv'
  ),
  (
    'veo-3.1-generate-001',
    'temporal',
    'scene_progression_vfx_completion',
    'VFX events described with completion-tense verbs (passes through, breaks, shatters) trigger Veo to render the aftermath instead of a sustained effect. By the end of the clip, the VFX has disappeared or the scene has shifted to a post-event rubble state.',
    'Use continuous-tense language (expands continuously, radiates outward, crawls across) plus an explicit end-state lock ("remains visible in frame at all times", "continues throughout the full duration").',
    'warning',
    'drift-mv'
  ),
  (
    'veo-3.1-generate-001',
    'zoom',
    'scale_jump_excessive_zoom',
    'Zoom ranges beyond approximately 2 stops in 8 seconds render as a scene cut rather than a smooth pullback or push-in. Macro-to-wide is the most common offender.',
    'Limit zoom to about 2 stops in 8 seconds. Close-up to medium works. Macro to wide renders as a cut artifact. If wider reveal needed, split across two shots.',
    'warning',
    'drift-mv'
  ),
  (
    'veo-3.1-generate-001',
    'temporal',
    'subtle_vfx_absorption',
    'Veo temporal coherence smooths away subtle VFX effects (thin grids, faint glows, delicate particles, slow crawls). Small-scale effects get absorbed into the base composition over 8 seconds and become invisible by last frame.',
    'Use large-scale, dramatic VFX changes. "Golden circuitry erupts and spreads rapidly across entire torso and limbs" beats "thin gold grid crawls slowly." Make the VFX the climactic focal point, not background atmosphere.',
    'warning',
    'drift-mv'
  ),
  (
    'veo-3.1-generate-001',
    'lighting',
    'backlight_color_homogenization',
    'Warm backlighting washes multiple distinct-colored subjects toward the same warm tone. By the end of the clip, faction color identity is lost and all subjects read as gold/bronze.',
    'Use front/side lighting (front-left is proven across Shot 20 and Shot 18) for multi-subject color distinction. Keep background darker than subjects for contrast. Explicitly lock "each subject color remains clearly distinguishable" in the prompt.',
    'warning',
    'drift-mv'
  ),
  (
    'veo-3.1-generate-001',
    'character',
    'generic_appearance_lock',
    'Generic locks like "exact appearance remains unchanged" are weak and result in wardrobe, material, and feature drift over 8 seconds. Veo needs specific anchoring material descriptions to hold identity.',
    'Name specific materials, textures, fabrics, thread patterns. "Fitted matte black tactical jacket with thin gold thread stitching at the collar and cuffs" holds where "remains unchanged" fails. Material language (welded steel, chipped paint, thin gold thread) is the strongest identity lock.',
    'warning',
    'drift-mv'
  )
ON CONFLICT (failure_mode) DO UPDATE SET
  description = EXCLUDED.description,
  mitigation = EXCLUDED.mitigation,
  severity = EXCLUDED.severity,
  updated_at = now();
