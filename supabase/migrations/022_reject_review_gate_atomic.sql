-- 022_reject_review_gate_atomic.sql
-- ADR-006 D4-9 (PR #8 review hardening) — atomic Reject-as-Teach write path.
--
-- Problem (CodeRabbit PR #8 finding os-api/src/db.ts:3552):
--   rejectReviewGateEscalation inserts a rejection_learning_events row, then
--   transitions the asset_escalations row. If the second write fails or loses
--   a race, the learning row is orphaned (no terminal escalation pointing to
--   it) and a retry creates duplicate learnings that later get injected into
--   prompt context.
--
-- Fix: a single SQL function that performs the insert + update in one
-- transaction so both succeed-together or fail-together. Idempotency via the
-- learning event id (caller supplies a uuid) — re-running with the same id
-- catches the duplicate-PK before the update happens.
--
-- The function returns both rows so the application can keep the existing
-- typed-mapper pipeline without a follow-up SELECT.

BEGIN;

CREATE OR REPLACE FUNCTION reject_review_gate_escalation_atomic(
  -- learning event payload
  p_event_id        UUID,
  p_client_id       TEXT,
  p_campaign_id     UUID,
  p_shot_id         INTEGER,
  p_asset_id        UUID,
  p_category_id     rejection_category,
  p_what_wrong      TEXT,
  p_correction      TEXT,
  p_ref_image_path  TEXT,
  p_block_mode      TEXT,
  p_created_by      TEXT,
  -- escalation transition payload
  p_escalation_id   UUID,
  p_new_status      TEXT,
  p_resolution_notes TEXT,
  p_resolved_at     TIMESTAMPTZ
) RETURNS TABLE (
  learning_event   rejection_learning_events,
  updated_escalation asset_escalations
)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_learning rejection_learning_events;
  v_escalation asset_escalations;
BEGIN
  -- 1. Insert the learning event. PK collision on retry surfaces as a
  --    unique_violation that the caller treats as 409 conflict.
  INSERT INTO rejection_learning_events (
    id, client_id, campaign_id, shot_id, asset_id, category_id,
    what_wrong, correction, ref_image_path, block_mode, created_by
  ) VALUES (
    p_event_id, p_client_id, p_campaign_id, p_shot_id, p_asset_id, p_category_id,
    p_what_wrong, p_correction, p_ref_image_path, p_block_mode, p_created_by
  )
  RETURNING * INTO v_learning;

  -- 2. Transition the escalation in the same transaction. Failure rolls back
  --    the insert above so the system never holds a learning row that's not
  --    attached to a terminal escalation.
  -- asset_escalations.status + resolution_path are TEXT columns (not enums);
  -- write the value directly. resolution_path is intentionally left untouched
  -- here — the reject path does not set it (only accept does).
  UPDATE asset_escalations
  SET status = p_new_status,
      resolution_notes = p_resolution_notes,
      learning_event_id = p_event_id,
      resolved_at = p_resolved_at
  WHERE id = p_escalation_id
  RETURNING * INTO v_escalation;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset escalation % not found while writing reject transition', p_escalation_id;
  END IF;

  learning_event := v_learning;
  updated_escalation := v_escalation;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION reject_review_gate_escalation_atomic(
  UUID, TEXT, UUID, INTEGER, UUID, rejection_category, TEXT, TEXT, TEXT, TEXT, TEXT,
  UUID, TEXT, TEXT, TIMESTAMPTZ
) IS
  'Atomic Reject-as-Teach: inserts a rejection_learning_events row and '
  'transitions the asset_escalations row in a single transaction so a '
  'mid-flight failure cannot leave an orphan learning row (CodeRabbit PR #8 '
  'db.ts:3552).';

GRANT EXECUTE ON FUNCTION reject_review_gate_escalation_atomic(
  UUID, TEXT, UUID, INTEGER, UUID, rejection_category, TEXT, TEXT, TEXT, TEXT, TEXT,
  UUID, TEXT, TEXT, TIMESTAMPTZ
) TO authenticated, service_role;

COMMIT;
