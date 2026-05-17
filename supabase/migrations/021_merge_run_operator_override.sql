-- 021_merge_run_operator_override.sql
-- ADR-006 D4-9 (PR #8 review hardening) — atomic JSONB merge for
-- runs.metadata.operator_override.<key>.
--
-- Problem (CodeRabbit PR #8 finding os-api/src/db.ts:3249):
--   acceptReviewGateEscalation + commentReviewGateEscalation both read the
--   full runs.metadata blob, mutate operator_override.<key>, then write the
--   entire metadata back via updateRun({ metadata }). Two concurrent operator
--   actions on different shots race on the same row and the later write drops
--   the earlier shot's operator_override entry.
--
-- Fix: a SECURITY INVOKER function that performs the merge as a single
-- jsonb_set statement so the existing row's other shot keys are preserved.
-- SECURITY INVOKER means RLS still applies; service-role callers bypass via
-- the service_role helper as today.
--
-- Returns the updated runs row so callers can keep the existing typed mapper
-- pipeline (the route handler then reads the returned metadata to build the
-- ReviewGateAcceptResult / ReviewGateCommentResult).

BEGIN;

CREATE OR REPLACE FUNCTION merge_run_operator_override(
  p_run_id      UUID,
  p_override_key TEXT,
  p_payload     JSONB
) RETURNS SETOF runs
LANGUAGE sql
SECURITY INVOKER
AS $$
  UPDATE runs
  SET metadata = jsonb_set(
    -- ensure a metadata document exists
    COALESCE(metadata, '{}'::jsonb),
    -- and an operator_override sub-document exists before the targeted merge
    ARRAY['operator_override'],
    COALESCE(metadata->'operator_override', '{}'::jsonb) || jsonb_build_object(p_override_key, p_payload),
    true
  )
  WHERE id = p_run_id
  RETURNING *;
$$;

COMMENT ON FUNCTION merge_run_operator_override(UUID, TEXT, JSONB) IS
  'Atomic merge of payload into runs.metadata.operator_override.<key>. '
  'Used by Review Gate accept + comment handlers to prevent concurrent '
  'whole-blob writes from clobbering each other (CodeRabbit PR #8 db.ts:3249).';

-- Grant execute to the same roles that already touch runs (RLS still applies
-- via SECURITY INVOKER + table policies).
GRANT EXECUTE ON FUNCTION merge_run_operator_override(UUID, TEXT, JSONB)
  TO authenticated, service_role;

COMMIT;
