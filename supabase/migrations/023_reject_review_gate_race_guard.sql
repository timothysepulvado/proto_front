-- 023_reject_review_gate_race_guard.sql
-- ADR-006 D4-9 (PR #8 independent review — Karl BLOCK finding #1).
--
-- Problem (migration 022 reject_review_gate_escalation_atomic, lines 50-73):
--   The RPC inserts the rejection_learning_events row FIRST, then blindly
--   UPDATEs asset_escalations with no row lock and no status guard. The
--   application-level openness check in db.ts:3562
--   (REVIEW_GATE_OPEN_STATUSES.has(ctx.escalation.status)) is a classic
--   TOCTOU: two concurrent POST /api/escalations/:id/reject calls on the
--   same open escalation both pass that check before either commits. Each
--   supplies a distinct caller-generated p_event_id, so there is no PK
--   collision on rejection_learning_events; both INSERTs succeed, the later
--   UPDATE wins and overwrites learning_event_id, and the first request's
--   learning row is orphaned (no terminal escalation points at it). The
--   "idempotency via event id" guarantee in migration 022 only covered
--   same-id retries, never distinct-id concurrent rejects.
--
-- Fix: lock-then-validate-then-write. SELECT ... FOR UPDATE serializes
--   concurrent rejects on the same escalation row. The validation re-reads
--   the LOCKED row (not a stale app-side snapshot) and aborts unless the
--   escalation is still open AND has no learning_event_id yet. Only then do
--   we insert the learning event and transition the escalation. The race
--   loser blocks on the lock, re-reads the now-terminal row, and rolls back
--   its own learning insert — no orphan possible.
--
--   Worked race (T1, T2 concurrent, same open escalation, distinct event ids):
--     T1: lock row → status=hitl_required, learning_event_id=NULL → pass →
--         INSERT learning(T1) → UPDATE status=rejected_*, learning_event_id=T1
--         → COMMIT (lock released)
--     T2: blocked on SELECT FOR UPDATE until T1 commits → acquires lock →
--         re-reads row → status=rejected_* (terminal) AND
--         learning_event_id IS NOT NULL → RAISE EXCEPTION → T2 rolls back
--         entirely (its learning INSERT never happens). No orphan, no
--         double-write.
--
-- Same signature as migration 022 — CREATE OR REPLACE only, zero caller
-- changes (os-api/src/db.ts::rejectReviewGateEscalation unchanged). The
-- application pre-check at db.ts:3562 stays as a fast-fail UX path; this
-- function is now the authoritative serialization point.
--
-- Open statuses are the source-of-truth mirror of
-- REVIEW_GATE_OPEN_STATUSES in os-api/src/db.ts:3185
-- (new Set(["hitl_required", "in_progress"])). asset_escalations.status is
-- a TEXT column (not an enum) — migration 022 header confirms.

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
  v_locked_status            TEXT;
  v_locked_learning_event_id UUID;
BEGIN
  -- 1. Lock the escalation row FIRST. SELECT ... FOR UPDATE serializes any
  --    concurrent reject on the same escalation: the second caller blocks
  --    here until the first transaction commits or rolls back, then sees
  --    the post-commit state below.
  SELECT status, learning_event_id
    INTO v_locked_status, v_locked_learning_event_id
    FROM asset_escalations
   WHERE id = p_escalation_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset escalation % not found while writing reject transition', p_escalation_id;
  END IF;

  -- 2. Validate the LOCKED row (not a stale app-side snapshot). Reject is
  --    only legal from an open escalation that has not already captured a
  --    learning event. The race loser and any post-terminal retry fail here
  --    and roll back before any learning row is inserted.
  IF v_locked_status NOT IN ('hitl_required', 'in_progress')
     OR v_locked_learning_event_id IS NOT NULL THEN
    -- Message intentionally contains "already terminal" so the os-api reject
    -- route catch maps the race loser / post-terminal retry to HTTP 409
    -- Conflict (not a generic 500). Under FOR UPDATE the loser only reaches
    -- here after the winner commits, so status is always terminal and
    -- learning_event_id is always set — the phrase is accurate in every
    -- guard-trip case (race loser, retry, or genuinely-resolved escalation).
    RAISE EXCEPTION
      'Escalation % reject conflict — already terminal or learning event already attached (status=%, learning_event_id=%)',
      p_escalation_id, v_locked_status, v_locked_learning_event_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- 3. Insert the learning event. We hold the escalation row lock, so no
  --    competing reject can interleave between here and the UPDATE below.
  --    A duplicate p_event_id still surfaces as unique_violation and rolls
  --    back the whole transaction (defensive — unreachable in normal flow
  --    now that the status/learning_event_id guard fires first).
  INSERT INTO rejection_learning_events (
    id, client_id, campaign_id, shot_id, asset_id, category_id,
    what_wrong, correction, ref_image_path, block_mode, created_by
  ) VALUES (
    p_event_id, p_client_id, p_campaign_id, p_shot_id, p_asset_id, p_category_id,
    p_what_wrong, p_correction, p_ref_image_path, p_block_mode, p_created_by
  )
  RETURNING * INTO v_learning;

  -- 4. Transition the escalation in the same transaction. resolution_path is
  --    intentionally left untouched (only accept sets it). The WHERE clause
  --    re-asserts the open guard as belt-and-suspenders against the
  --    (already-impossible-under-lock) interleave.
  UPDATE asset_escalations
  SET status = p_new_status,
      resolution_notes = p_resolution_notes,
      learning_event_id = p_event_id,
      resolved_at = p_resolved_at
  WHERE id = p_escalation_id
    AND status IN ('hitl_required', 'in_progress')
    AND learning_event_id IS NULL
  RETURNING * INTO v_escalation;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset escalation % transition lost a race after lock (status=%)',
      p_escalation_id, v_locked_status;
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
  'Atomic Reject-as-Teach with concurrency guard (migration 023, ADR-006 '
  'D4-9, Karl PR #8 review BLOCK #1): SELECT ... FOR UPDATE the escalation, '
  'validate open status + null learning_event_id on the LOCKED row, then '
  'insert the learning event and transition the escalation in one '
  'transaction. Serializes concurrent rejects so a distinct-event-id race '
  'cannot orphan a learning row (supersedes migration 022 blind-write).';

GRANT EXECUTE ON FUNCTION reject_review_gate_escalation_atomic(
  UUID, TEXT, UUID, INTEGER, UUID, rejection_category, TEXT, TEXT, TEXT, TEXT, TEXT,
  UUID, TEXT, TEXT, TIMESTAMPTZ
) TO authenticated, service_role;

COMMIT;
