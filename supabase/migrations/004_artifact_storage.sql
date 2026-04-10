-- Migration 004: Artifact storage integration
-- Adds columns for Supabase Storage tracking + direct client/campaign references
-- Storage path convention: {client_id}/{run_id}/{artifact_id}.{ext}

-- ============ New columns on artifacts ============

-- Direct client reference (avoids join through runs for artifact queries)
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS client_id TEXT REFERENCES clients(id) ON DELETE CASCADE;

-- Campaign link (nullable — only set when run has a campaign)
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;

-- Which pipeline stage produced this artifact
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS stage TEXT;

-- Supabase Storage bucket-internal path (for delete/update ops)
-- e.g. "client_cylndr/abc-123/def-456.png"
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS storage_path TEXT;

-- Generation metadata: model, prompt, parameters, etc.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS metadata JSONB;

-- ============ Indexes ============

CREATE INDEX IF NOT EXISTS idx_artifacts_client_id ON artifacts(client_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_campaign_id ON artifacts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_stage ON artifacts(stage);
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type);

-- ============ Backfill client_id from runs ============
-- For any existing artifact rows, populate client_id from the parent run

UPDATE artifacts
SET client_id = runs.client_id
FROM runs
WHERE artifacts.run_id = runs.id
  AND artifacts.client_id IS NULL;

-- ============ Storage bucket ============
-- Create the "artifacts" bucket for generated asset files.
-- Public read so the frontend can render images/videos via URL.
-- Authenticated write (service key) so only the API/worker can upload.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'artifacts',
  'artifacts',
  true,
  104857600,  -- 100MB limit (videos can be large)
  ARRAY[
    'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    'video/mp4', 'video/webm',
    'application/pdf',
    'application/zip', 'application/gzip'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- ============ Storage RLS policies ============

-- Anyone can read (public bucket)
CREATE POLICY "Public read on artifacts bucket"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'artifacts');

-- Service role / authenticated can upload
CREATE POLICY "Authenticated upload to artifacts bucket"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'artifacts');

-- Service role / authenticated can update
CREATE POLICY "Authenticated update in artifacts bucket"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'artifacts');

-- Service role / authenticated can delete
CREATE POLICY "Authenticated delete from artifacts bucket"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'artifacts');

-- ============ Realtime (artifacts table) ============
-- Enable so the UI can subscribe to new artifact inserts

ALTER PUBLICATION supabase_realtime ADD TABLE artifacts;
