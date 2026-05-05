-- 018_storage_bucket_private.sql
-- PR #5 Phase D — flip artifacts bucket private now that HUD reads via signed URLs.
--
-- The client-scoped SELECT policy artifacts_client_read from migration 016 has
-- been DORMANT while bucket public=true (the /object/public/<bucket>/<path>
-- URL pattern bypasses storage.objects RLS entirely on Supabase Storage). After
-- this migration:
--   • /object/public/ URLs return 400/404 (no longer accessible)
--   • /object/sign/<...>?token=... URLs continue to work via Storage's signed-URL
--     verification path, which respects the SELECT policy
--   • /object/authenticated/ URLs work for callers presenting a valid JWT whose
--     client_id matches the storage_path[1] folder
--
-- HUD readers must already be migrated to use the GET /api/artifacts/:id/signed-url
-- endpoint (PR #5 Phase A) BEFORE this migration is applied. If a /public/ URL is
-- still hard-coded in any HUD render path, that artifact will 404 post-flip. The
-- merge gate covers this via PR #5 Phase E Assertion 6 (own-tenant signed URL
-- fetches HTTP 200 with seeded bytes — exercises the sign-URL path under the new
-- bucket policy).
--
-- WRITE SURFACE UNCHANGED — Migration 016's INSERT/UPDATE/DELETE policies on
-- storage.objects continue to govern writes. This migration only affects READ
-- access to bucket objects via the public URL pattern.
--
-- ROLLBACK: a single UPDATE statement re-opens the public read path. Signed URLs
-- continue to work either way; restoring public bucket only impacts the leak surface,
-- not HUD functionality.
BEGIN;

UPDATE storage.buckets
   SET public = false
 WHERE id = 'artifacts';

-- Verification (commented; run via separate db query --linked after migration applies):
-- SELECT id, public FROM storage.buckets WHERE id = 'artifacts';
--   expected: public = false

COMMIT;
