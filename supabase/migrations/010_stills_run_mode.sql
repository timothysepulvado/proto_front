-- 010_stills_run_mode.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds 'stills' to the run_mode enum for the productized stills critic-in-loop
-- runner path (Phase B of ADR-004). Mirrors the additive pattern from
-- 008_regrade_run_mode.sql.
--
-- Source: ADR-004 Phase B + Brandy decision on Karl's pre-flight Q1/Q2:
--   ~/agent-vault/adr/004-stills-critic-in-loop.md
--   ~/agent-vault/briefs/2026-04-29-phase-c-stills-mode-runner-and-image-grading.md
--
-- Idempotent via IF NOT EXISTS. Safe to re-apply.
--
-- Note: this migration MUST land AFTER 009_image_class_known_limitations.sql
-- because Phase B's runner reads from the seeded known_limitations rows.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TYPE run_mode ADD VALUE IF NOT EXISTS 'stills';

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification query (for manual smoke after apply):
--   SELECT enumlabel FROM pg_enum
--   WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'run_mode')
--   ORDER BY enumsortorder;
-- Expected: full, ingest, images, video, drift, export, regrade, stills
-- ─────────────────────────────────────────────────────────────────────────────
