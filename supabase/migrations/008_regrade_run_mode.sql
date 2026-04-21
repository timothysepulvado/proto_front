-- Migration 008: Add "regrade" to the run_mode enum
--
-- Step 10d Session A (2026-04-20). A new runner mode iterates a campaign's
-- deliverables and re-grades each deliverable's most-recent video artifact via
-- the consensus critic + escalation loop, without firing fresh Temp-gen
-- generation up-front. This is the reuse-first regression entry point.
--
-- runs.mode is a Postgres enum (declared in 001_initial_schema.sql), so we
-- need ALTER TYPE ... ADD VALUE for the new literal to be accepted. Idempotent
-- via IF NOT EXISTS.

ALTER TYPE run_mode ADD VALUE IF NOT EXISTS 'regrade';
