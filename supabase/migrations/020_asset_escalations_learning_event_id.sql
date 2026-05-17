-- 020_asset_escalations_learning_event_id.sql
-- ADR-006 D4 Sub-phase 4.D-3 — link Review Gate Reject-as-Teach blocks to append-only learning events.
BEGIN;

ALTER TABLE public.asset_escalations
  ADD COLUMN IF NOT EXISTS learning_event_id UUID REFERENCES public.rejection_learning_events(id) ON DELETE SET NULL;

ALTER TABLE public.asset_escalations
  DROP CONSTRAINT IF EXISTS asset_escalations_status_check;

ALTER TABLE public.asset_escalations
  ADD CONSTRAINT asset_escalations_status_check
  CHECK (status IN (
    'in_progress',
    'resolved',
    'accepted',
    'redesigned',
    'replaced',
    'hitl_required',
    'rejected_soft',
    'rejected_terminal'
  ));

CREATE INDEX IF NOT EXISTS idx_asset_escalations_learning_event_id
  ON public.asset_escalations (learning_event_id)
  WHERE learning_event_id IS NOT NULL;

COMMENT ON COLUMN public.asset_escalations.learning_event_id IS
  'ADR-006 D4 Reject-as-Teach captured rejection_learning_events.id for the escalation.';

COMMIT;
