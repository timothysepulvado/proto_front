-- Migration 006: Add generation spec columns to campaign_deliverables
--
-- Enriches deliverables with format, media type, duration, aspect ratio,
-- resolution, platform, quality tier, reference images, and estimated cost.
-- Supports the new Temp-gen sidecar pipeline (Veo 3.1 + Gemini image).

ALTER TABLE campaign_deliverables
  ADD COLUMN IF NOT EXISTS format TEXT,
  ADD COLUMN IF NOT EXISTS media_type TEXT DEFAULT 'image',
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS aspect_ratio TEXT DEFAULT '16:9',
  ADD COLUMN IF NOT EXISTS resolution TEXT DEFAULT '720p',
  ADD COLUMN IF NOT EXISTS platform TEXT,
  ADD COLUMN IF NOT EXISTS quality_tier TEXT DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS reference_images TEXT[],
  ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(10,4);

CREATE INDEX IF NOT EXISTS idx_deliverables_media_type
  ON campaign_deliverables(media_type);
