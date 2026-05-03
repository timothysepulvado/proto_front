-- 014_client_id_denormalization.sql
-- Phase 7 — multi-tenant data isolation (Step 1: denormalize client_id)
-- Pre-req for migration 015 (RLS policies).
-- Author: Karl (per Phase A classification 2026-05-03)
BEGIN;

-- ===== Class A* — artifacts already has client_id NULLABLE; flip to NOT NULL =====
-- Probe: 0/149 rows have NULL client_id, so this is safe with no backfill.
-- Defensive: backfill any future NULLs from runs as a safety net.
UPDATE artifacts a
   SET client_id = r.client_id
  FROM runs r
 WHERE a.run_id = r.id
   AND a.client_id IS NULL;

ALTER TABLE artifacts ALTER COLUMN client_id SET NOT NULL;
-- artifacts.client_id FK to clients(id) was added in an earlier migration (per FK probe).
-- Index already exists implicitly via FK; explicit confirm:
CREATE INDEX IF NOT EXISTS artifacts_client_id_idx ON artifacts(client_id);

-- ===== Class B — add client_id, backfill via runs =====

-- run_logs (2866 rows)
ALTER TABLE run_logs ADD COLUMN IF NOT EXISTS client_id TEXT;
UPDATE run_logs rl
   SET client_id = r.client_id
  FROM runs r
 WHERE rl.run_id = r.id
   AND rl.client_id IS NULL;
ALTER TABLE run_logs ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE run_logs
  ADD CONSTRAINT run_logs_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
CREATE INDEX IF NOT EXISTS run_logs_client_id_idx ON run_logs(client_id);

-- hitl_decisions (0 rows — backfill no-op)
ALTER TABLE hitl_decisions ADD COLUMN IF NOT EXISTS client_id TEXT;
UPDATE hitl_decisions hd
   SET client_id = r.client_id
  FROM runs r
 WHERE hd.run_id = r.id
   AND hd.client_id IS NULL;
ALTER TABLE hitl_decisions ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE hitl_decisions
  ADD CONSTRAINT hitl_decisions_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
CREATE INDEX IF NOT EXISTS hitl_decisions_client_id_idx ON hitl_decisions(client_id);

-- asset_escalations (86 rows)
-- Primary backfill: via runs. Defensive fallback: via artifacts.
-- Probe: 0/86 rows have NULL run_id, but defensive in case future rows do.
ALTER TABLE asset_escalations ADD COLUMN IF NOT EXISTS client_id TEXT;
UPDATE asset_escalations ae
   SET client_id = COALESCE(
     (SELECT r.client_id FROM runs r WHERE r.id = ae.run_id),
     a.client_id
   )
  FROM artifacts a
 WHERE ae.artifact_id = a.id
   AND ae.client_id IS NULL;
ALTER TABLE asset_escalations ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE asset_escalations
  ADD CONSTRAINT asset_escalations_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
CREATE INDEX IF NOT EXISTS asset_escalations_client_id_idx ON asset_escalations(client_id);

-- orchestration_decisions (71 rows)
-- Primary backfill: via runs. Defensive fallback: via escalation_id → asset_escalations.client_id
-- (asset_escalations.client_id is backfilled above, so this is safe).
-- Probe: 0/71 rows have NULL run_id.
ALTER TABLE orchestration_decisions ADD COLUMN IF NOT EXISTS client_id TEXT;
UPDATE orchestration_decisions od
   SET client_id = COALESCE(
     (SELECT r.client_id FROM runs r WHERE r.id = od.run_id),
     ae.client_id
   )
  FROM asset_escalations ae
 WHERE od.escalation_id = ae.id
   AND od.client_id IS NULL;
ALTER TABLE orchestration_decisions ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE orchestration_decisions
  ADD CONSTRAINT orchestration_decisions_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
CREATE INDEX IF NOT EXISTS orchestration_decisions_client_id_idx ON orchestration_decisions(client_id);

-- ===== Class C — add client_id, backfill via campaigns =====

-- campaign_deliverables (31 rows)
ALTER TABLE campaign_deliverables ADD COLUMN IF NOT EXISTS client_id TEXT;
UPDATE campaign_deliverables cd
   SET client_id = c.client_id
  FROM campaigns c
 WHERE cd.campaign_id = c.id
   AND cd.client_id IS NULL;
ALTER TABLE campaign_deliverables ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE campaign_deliverables
  ADD CONSTRAINT campaign_deliverables_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
CREATE INDEX IF NOT EXISTS campaign_deliverables_client_id_idx ON campaign_deliverables(client_id);

-- campaign_memory (0 rows — backfill no-op)
ALTER TABLE campaign_memory ADD COLUMN IF NOT EXISTS client_id TEXT;
UPDATE campaign_memory cm
   SET client_id = c.client_id
  FROM campaigns c
 WHERE cm.campaign_id = c.id
   AND cm.client_id IS NULL;
ALTER TABLE campaign_memory ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE campaign_memory
  ADD CONSTRAINT campaign_memory_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
CREATE INDEX IF NOT EXISTS campaign_memory_client_id_idx ON campaign_memory(client_id);

-- ===== verify (Karl runs after COMMIT) =====
-- All target tables should have NOT NULL client_id:
-- SELECT table_name, column_name, is_nullable
--   FROM information_schema.columns
--  WHERE column_name = 'client_id' AND table_schema = 'public'
--  ORDER BY table_name;
-- Expect: run_logs, hitl_decisions, asset_escalations, orchestration_decisions,
--         campaign_deliverables, campaign_memory all NO (plus the 6 Class A's already NO).

-- Row-count parity:
-- SELECT 'asset_escalations OK' AS k WHERE
--   (SELECT COUNT(*) FROM asset_escalations) = (SELECT COUNT(*) FROM asset_escalations WHERE client_id IS NOT NULL);
-- (Repeat per touched table)

COMMIT;
