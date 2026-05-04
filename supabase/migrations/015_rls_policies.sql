-- 015_rls_policies.sql
-- Phase 7 — multi-tenant data isolation (Step 2: client-scoped RLS policies)
-- Author: Karl (per Phase A classification 2026-05-03)
BEGIN;

-- ===== JWT helper =====
-- Returns the client_id claim from the JWT (set via supabase.auth.setSession()).
-- TEXT, not UUID — clients.id is text.
CREATE OR REPLACE FUNCTION public.jwt_client_id()
RETURNS TEXT
LANGUAGE SQL
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb->>'client_id', '')
$$;

-- ===== DROP existing open policies (31 total) =====
-- All current policies are USING (true). Replace with client-scoped.
-- Order: drop all 31, then create restrictive replacements.

DROP POLICY IF EXISTS "Allow public read on artifacts" ON artifacts;
DROP POLICY IF EXISTS "Allow public insert on artifacts" ON artifacts;
DROP POLICY IF EXISTS "Allow public update on artifacts" ON artifacts;

DROP POLICY IF EXISTS "Allow all access to asset_escalations" ON asset_escalations;

DROP POLICY IF EXISTS "brand_baselines_service_policy" ON brand_baselines;

DROP POLICY IF EXISTS "Allow public read on campaign_deliverables" ON campaign_deliverables;
DROP POLICY IF EXISTS "Allow public insert on campaign_deliverables" ON campaign_deliverables;
DROP POLICY IF EXISTS "Allow public update on campaign_deliverables" ON campaign_deliverables;
DROP POLICY IF EXISTS "Allow public delete on campaign_deliverables" ON campaign_deliverables;

DROP POLICY IF EXISTS "Allow public insert on campaign_memory" ON campaign_memory;
DROP POLICY IF EXISTS "Allow public read on campaign_memory" ON campaign_memory;

DROP POLICY IF EXISTS "Allow public read on campaigns" ON campaigns;
DROP POLICY IF EXISTS "Allow public insert on campaigns" ON campaigns;
DROP POLICY IF EXISTS "Allow public update on campaigns" ON campaigns;
DROP POLICY IF EXISTS "Allow public delete on campaigns" ON campaigns;

DROP POLICY IF EXISTS "Allow public read on clients" ON clients;
DROP POLICY IF EXISTS "Allow public insert on clients" ON clients;
DROP POLICY IF EXISTS "Allow public update on clients" ON clients;

DROP POLICY IF EXISTS "drift_alerts_service_policy" ON drift_alerts;

DROP POLICY IF EXISTS "drift_metrics_service_policy" ON drift_metrics;

DROP POLICY IF EXISTS "Allow public insert on hitl_decisions" ON hitl_decisions;
DROP POLICY IF EXISTS "Allow public read on hitl_decisions" ON hitl_decisions;
DROP POLICY IF EXISTS "Allow public update on hitl_decisions" ON hitl_decisions;

DROP POLICY IF EXISTS "Allow all access to known_limitations" ON known_limitations;

DROP POLICY IF EXISTS "Allow all access to orchestration_decisions" ON orchestration_decisions;

DROP POLICY IF EXISTS "Allow public read on rejection_categories" ON rejection_categories;

DROP POLICY IF EXISTS "Allow public insert on run_logs" ON run_logs;
DROP POLICY IF EXISTS "Allow public read on run_logs" ON run_logs;

DROP POLICY IF EXISTS "Allow public read on runs" ON runs;
DROP POLICY IF EXISTS "Allow public insert on runs" ON runs;
DROP POLICY IF EXISTS "Allow public update on runs" ON runs;

-- ===== CREATE new client-scoped read policies =====
-- All per-client tables: SELECT restricted to rows matching jwt_client_id().
-- WRITE policies are NOT created — os-api uses SUPABASE_SERVICE_ROLE_KEY which
-- bypasses RLS. If we ever expose direct client writes, add INSERT/UPDATE/DELETE
-- policies then.

-- clients (parent table)
CREATE POLICY clients_self_read ON clients
  FOR SELECT USING (id = jwt_client_id() OR auth.role() = 'service_role');

-- Class A — direct client_id NOT NULL
CREATE POLICY runs_client_read ON runs
  FOR SELECT USING (client_id = jwt_client_id() OR auth.role() = 'service_role');
CREATE POLICY campaigns_client_read ON campaigns
  FOR SELECT USING (client_id = jwt_client_id() OR auth.role() = 'service_role');
CREATE POLICY brand_baselines_client_read ON brand_baselines
  FOR SELECT USING (client_id = jwt_client_id() OR auth.role() = 'service_role');
CREATE POLICY drift_metrics_client_read ON drift_metrics
  FOR SELECT USING (client_id = jwt_client_id() OR auth.role() = 'service_role');
CREATE POLICY drift_alerts_client_read ON drift_alerts
  FOR SELECT USING (client_id = jwt_client_id() OR auth.role() = 'service_role');
CREATE POLICY artifacts_client_read ON artifacts
  FOR SELECT USING (client_id = jwt_client_id() OR auth.role() = 'service_role');

-- Class B — backfilled client_id via runs/artifacts
CREATE POLICY run_logs_client_read ON run_logs
  FOR SELECT USING (client_id = jwt_client_id() OR auth.role() = 'service_role');
CREATE POLICY hitl_decisions_client_read ON hitl_decisions
  FOR SELECT USING (client_id = jwt_client_id() OR auth.role() = 'service_role');
CREATE POLICY asset_escalations_client_read ON asset_escalations
  FOR SELECT USING (client_id = jwt_client_id() OR auth.role() = 'service_role');
CREATE POLICY orchestration_decisions_client_read ON orchestration_decisions
  FOR SELECT USING (client_id = jwt_client_id() OR auth.role() = 'service_role');

-- Class C — backfilled client_id via campaigns
CREATE POLICY campaign_deliverables_client_read ON campaign_deliverables
  FOR SELECT USING (client_id = jwt_client_id() OR auth.role() = 'service_role');
CREATE POLICY campaign_memory_client_read ON campaign_memory
  FOR SELECT USING (client_id = jwt_client_id() OR auth.role() = 'service_role');

-- Class E — global tables, readable by any authenticated session
CREATE POLICY rejection_categories_authenticated_read ON rejection_categories
  FOR SELECT USING (auth.role() IN ('authenticated', 'service_role'));
CREATE POLICY known_limitations_authenticated_read ON known_limitations
  FOR SELECT USING (auth.role() IN ('authenticated', 'service_role'));

COMMIT;
