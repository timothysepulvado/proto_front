-- Migration 002: Ensure hitl_decisions table matches application expectations
-- Note: The hitl_decisions table already exists in the live Supabase schema.
-- This migration documents the schema and adds any missing columns/indexes.

-- Create table if it doesn't exist (idempotent)
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

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_hitl_decisions_run_id ON hitl_decisions(run_id);
CREATE INDEX IF NOT EXISTS idx_hitl_decisions_artifact_id ON hitl_decisions(artifact_id);
CREATE INDEX IF NOT EXISTS idx_hitl_decisions_decision ON hitl_decisions(decision);

-- RLS (match existing permissive policy pattern)
ALTER TABLE hitl_decisions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'hitl_decisions' AND policyname = 'Allow all access to hitl_decisions'
  ) THEN
    CREATE POLICY "Allow all access to hitl_decisions" ON hitl_decisions
      FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Enable Realtime on hitl_decisions
ALTER PUBLICATION supabase_realtime ADD TABLE hitl_decisions;
