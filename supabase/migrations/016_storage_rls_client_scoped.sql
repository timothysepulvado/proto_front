-- 016_storage_rls_client_scoped.sql
-- PR #4 Phase B — Lock down storage.objects writes to client-scoped tenants
-- Reuses jwt_client_id() helper from migration 015
-- NOTE: bucket stays public=true in this PR. The /public/ URL pattern
-- bypasses RLS regardless, so SELECT policies are documentation only
-- until PR #5 flips bucket private + migrates HUD to signed URLs.
-- INSERT/UPDATE/DELETE policies DO take effect immediately — closing
-- the write-side leak (no auth'd user can clobber another tenant's files).
BEGIN;

-- ===== DROP wide-open policies from migration 004 =====
DROP POLICY IF EXISTS "Public read on artifacts bucket" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated upload to artifacts bucket" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated update in artifacts bucket" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated delete from artifacts bucket" ON storage.objects;

-- ===== CREATE client-scoped policies =====
-- Path convention: {client_id}/{run_id}/{artifact_id}.{ext}
-- storage.foldername(name) returns array of path segments; [1] is the first folder.
-- Service role bypasses (mirrors table-layer pattern from migration 015).

-- SELECT — fires on /sign/ + /authenticated/ URL patterns (and after PR #5 flip,
-- on /public/ as well). No-op for /public/ pattern while bucket public=true.
CREATE POLICY "artifacts_client_read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'artifacts'
    AND (
      (storage.foldername(name))[1] = jwt_client_id()
      OR auth.role() = 'service_role'
    )
  );

-- INSERT — TAKES EFFECT IMMEDIATELY. No auth'd user can upload to another tenant's prefix.
CREATE POLICY "artifacts_client_insert"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'artifacts'
    AND (
      (storage.foldername(name))[1] = jwt_client_id()
      OR auth.role() = 'service_role'
    )
  );

-- UPDATE — TAKES EFFECT IMMEDIATELY.
CREATE POLICY "artifacts_client_update"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'artifacts'
    AND (
      (storage.foldername(name))[1] = jwt_client_id()
      OR auth.role() = 'service_role'
    )
  );

-- DELETE — TAKES EFFECT IMMEDIATELY.
CREATE POLICY "artifacts_client_delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'artifacts'
    AND (
      (storage.foldername(name))[1] = jwt_client_id()
      OR auth.role() = 'service_role'
    )
  );

-- BUCKET PRIVACY: deferred to PR #5.
-- UPDATE storage.buckets SET public = false WHERE id = 'artifacts';

COMMIT;
