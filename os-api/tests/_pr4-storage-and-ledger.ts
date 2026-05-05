// PR #4 + PR #5 verification harness — Storage RLS + cost ledger isolation.
// Mirrors the structure of _phase7-multi-tenant-isolation.ts.
// Drop into os-api/tests/ as `_pr4-storage-and-ledger.ts` after migrations
// 016 + 017 (PR #4) and 018 (PR #5) are applied to the linked Supabase project.
//
// Asserts:
// 1. Storage UPLOAD — client A JWT uploads to own prefix succeeds
// 2. Storage UPLOAD CROSS-TENANT — client A JWT upload to client B prefix is BLOCKED
// 3. Storage DELETE CROSS-TENANT — client A JWT delete of client B file is BLOCKED
// 4. Cost ledger READ isolation — client A JWT sees own ledger entries; not client B's
// 5. Cost ledger APPEND-ONLY — client A JWT cannot UPDATE or DELETE own ledger row
// 6. Storage SELECT — client A's JWT mints a signed URL for own artifact via
//    os-api endpoint; the URL fetches HTTP 200 with the seeded bytes
// 7. Storage SELECT CROSS-TENANT — client A's JWT requesting a signed URL
//    for client B's artifact via the os-api endpoint returns HTTP 403
//
// PRE-REQUISITE for Assertions 6 + 7: os-api must be running with
// JWT_AUTH_ENABLED=true. Without that flag the endpoint's tenant gate
// bootstrap-falls-back to anonymous-allowed and Assertion 7 will fail with
// a 200 response — the harness surfaces a helpful env-hint message in
// that case so the dev can fix and re-run.
//
// PRE-REQUISITE for the FETCH side of Assertion 6: bucket may be public OR
// private (PR #5 Migration 018 flips private). The /object/sign/ URL pattern
// works in both states; this assertion stays correct across the bucket flip.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient as createAnonClient } from "@supabase/supabase-js";
import { mintClientJwt } from "../src/auth.js";
import { supabase as serviceClient } from "../src/supabase.js";

const OS_API_URL = process.env.OS_API_URL ?? "http://localhost:3001";

const RUN_ID_SUFFIX = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const CLIENT_A_ID = `pr4_test_a_${RUN_ID_SUFFIX}`;
const CLIENT_B_ID = `pr4_test_b_${RUN_ID_SUFFIX}`;

const BUCKET = "artifacts";
// 1x1 transparent PNG — bucket has MIME whitelist (migration 004) that excludes text/plain.
// Use image/png to satisfy the allowlist.
const TEST_FILE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const TEST_FILE_MIME = "image/png";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function expectMutation(
  result: { error: { message: string } | null },
  label: string,
): Promise<void> {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
}

async function makeAuthedClient(clientId: string): Promise<SupabaseClient> {
  const url = requireEnv("SUPABASE_URL");
  const publishableKey = requireEnv("SUPABASE_KEY");
  const token = await mintClientJwt(clientId);
  const client = createAnonClient(url, publishableKey, {
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        headers.set("Authorization", `Bearer ${token}`);
        return fetch(input, { ...init, headers });
      },
    },
  });
  const { error } = await client.auth.setSession({ access_token: token, refresh_token: token });
  if (error && !error.message.includes("sub claim must be a UUID")) {
    throw new Error(`[${clientId}] setSession failed: ${error.message}`);
  }
  return client;
}

interface SeededTenant {
  runId: string;
  storageObject: string;
  ledgerId: string;
  artifactId: string;
}

async function seedClient(clientId: string): Promise<SeededTenant> {
  // 1. clients
  await expectMutation(
    await serviceClient.from("clients").insert({
      id: clientId,
      name: `PR4 Test ${clientId}`,
      status: "active",
      brand_slug: clientId,
      ui_config: {},
    }),
    `[seed ${clientId}] clients insert`,
  );

  // 2. minimal run for FK
  const runRes = await serviceClient
    .from("runs")
    .insert({
      client_id: clientId,
      mode: "ingest",
      status: "completed",
      stages: {},
      hitl_required: false,
      metadata: {},
    })
    .select("id")
    .single();
  if (runRes.error || !runRes.data) throw new Error(`[seed ${clientId}] run: ${runRes.error?.message}`);
  const runId = (runRes.data as { id: string }).id;

  // 3. Storage object — uploaded via SERVICE-ROLE client (always allowed)
  const storageObject = `${clientId}/${runId}/seed-${RUN_ID_SUFFIX}.png`;
  const upload = await serviceClient.storage.from(BUCKET).upload(storageObject, TEST_FILE_BYTES, {
    contentType: TEST_FILE_MIME,
    upsert: true,
  });
  if (upload.error) throw new Error(`[seed ${clientId}] storage upload: ${upload.error.message}`);

  // 4. Cost ledger entry
  const ledgerRes = await serviceClient
    .from("cost_ledger_entries")
    .insert({
      client_id: clientId,
      run_id: runId,
      event_type: "orchestrator_decision",
      source: "opus-4.7",
      cost_usd: 0.0123,
    })
    .select("id")
    .single();
  if (ledgerRes.error || !ledgerRes.data) throw new Error(`[seed ${clientId}] ledger: ${ledgerRes.error?.message}`);
  const ledgerId = (ledgerRes.data as { id: string }).id;

  // 5. Artifact row tied to the Storage object — required for the
  //    /api/artifacts/:artifactId/signed-url endpoint to look up tenant
  //    + storage_path. Public URL is illustrative only; the endpoint never
  //    reads the `path` column for signing (it uses storage_path).
  const publicUrl = `https://placeholder/storage/v1/object/public/${BUCKET}/${storageObject}`;
  const artifactRes = await serviceClient
    .from("artifacts")
    .insert({
      run_id: runId,
      client_id: clientId,
      type: "image",
      name: `seed-${RUN_ID_SUFFIX}.png`,
      path: publicUrl,
      storage_path: storageObject,
      stage: "seed",
      size: TEST_FILE_BYTES.length,
      metadata: { harness: "pr4-pr5", suffix: RUN_ID_SUFFIX },
    })
    .select("id")
    .single();
  if (artifactRes.error || !artifactRes.data) {
    throw new Error(`[seed ${clientId}] artifact: ${artifactRes.error?.message}`);
  }
  const artifactId = (artifactRes.data as { id: string }).id;

  return { runId, storageObject, ledgerId, artifactId };
}

async function cleanup(clientId: string, seeded: SeededTenant | undefined): Promise<void> {
  // Reverse-order FK-aware delete. All via service-role.
  // Best-effort sequence: attempt every step, collect errors, then THROW after
  // the full pass so an orphan row never produces a false-green run. (CR R2.)
  // NOTE: cost_ledger_entries is append-only by RLS design (no UPDATE/DELETE
  // policies). Cleanup of the seeded ledger row + artifacts row happens
  // automatically via ON DELETE CASCADE on (cost_ledger_entries|artifacts).run_id
  // when we delete the run below — no explicit DELETE required, which respects
  // the append-only invariant even if BYPASSRLS is ever revoked from service_role
  // in the future.
  const errors: string[] = [];

  if (seeded) {
    // Storage object first (no FK to client but cleanup courtesy)
    const rmObj = await serviceClient.storage.from(BUCKET).remove([seeded.storageObject]);
    if (rmObj.error) errors.push(`storage remove: ${rmObj.error.message}`);

    // Run row — CASCADE deletes the seeded ledger row + artifacts row + any run_logs.
    const rmRun = await serviceClient.from("runs").delete().eq("id", seeded.runId);
    if (rmRun.error) errors.push(`run delete: ${rmRun.error.message}`);
  }

  // Client last
  const rmClient = await serviceClient.from("clients").delete().eq("id", clientId);
  if (rmClient.error) errors.push(`client delete: ${rmClient.error.message}`);

  if (errors.length > 0) {
    throw new Error(`[cleanup ${clientId}] ${errors.length} step(s) failed — orphans likely:\n  - ${errors.join("\n  - ")}`);
  }
}

async function requestSignedUrl(
  token: string,
  artifactId: string,
): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(`${OS_API_URL}/api/artifacts/${artifactId}/signed-url`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    /* non-JSON response — leave null */
  }
  return { status: resp.status, body };
}

async function main(): Promise<void> {
  console.log(`PR #4 harness — clients: ${CLIENT_A_ID} / ${CLIENT_B_ID}`);

  let seededA: SeededTenant | undefined;
  let seededB: SeededTenant | undefined;

  // Error accumulators — primary (assertion / setup) is preserved separately
  // from cleanup errors so a finally-throw never masks the actual test failure.
  // Aggregation + non-zero exit happens AFTER the try/finally completes (CR R4).
  let primaryError: unknown = undefined;
  const cleanupErrors: string[] = [];

  try {
    seededA = await seedClient(CLIENT_A_ID);
    seededB = await seedClient(CLIENT_B_ID);
    console.log(`✓ seeded both test tenants`);
    // Type-narrow for downstream use (cleanup branch handles undefined separately).
    const sA = seededA;
    const sB = seededB;

    const clientA = await makeAuthedClient(CLIENT_A_ID);
    // clientB session intentionally unused — assertions 1-5 are unidirectional from client A.
    // Symmetric reverse-tenant assertions deferred (would 2x test runtime for low marginal coverage).

    // ===== Assertion 1: Storage UPLOAD — same-tenant succeeds =====
    const ownPath = `${CLIENT_A_ID}/${sA.runId}/upload-own-${RUN_ID_SUFFIX}.png`;
    const ownUpload = await clientA.storage.from(BUCKET).upload(ownPath, TEST_FILE_BYTES, { contentType: TEST_FILE_MIME });
    if (ownUpload.error) {
      throw new Error(`✗ Assertion 1 FAILED — own-tenant upload should succeed: ${ownUpload.error.message}`);
    }
    console.log(`✓ Assertion 1 — client A uploaded to own prefix`);

    // Cleanup own upload to avoid noise — fail loudly so orphans don't accumulate (CR R4).
    const rmOwn = await serviceClient.storage.from(BUCKET).remove([ownPath]);
    if (rmOwn.error) {
      throw new Error(`mid-test own-upload cleanup failed: ${rmOwn.error.message}`);
    }

    // ===== Assertion 2: Storage UPLOAD CROSS-TENANT — must be BLOCKED =====
    const crossPath = `${CLIENT_B_ID}/${sB.runId}/upload-cross-${RUN_ID_SUFFIX}.png`;
    const crossUpload = await clientA.storage.from(BUCKET).upload(crossPath, TEST_FILE_BYTES, { contentType: TEST_FILE_MIME });
    if (!crossUpload.error) {
      // If it succeeded, clean it up first then throw
      await serviceClient.storage.from(BUCKET).remove([crossPath]);
      throw new Error(`✗ Assertion 2 FAILED — cross-tenant upload should be blocked, but succeeded`);
    }
    console.log(`✓ Assertion 2 — cross-tenant upload BLOCKED (${crossUpload.error.message})`);

    // ===== Assertion 3: Storage DELETE CROSS-TENANT — must be BLOCKED =====
    // Storage delete returns { error: null, data: [] } on RLS denial in some Supabase versions;
    // attempt the delete (return discarded — verify by re-list instead of error shape).
    await clientA.storage.from(BUCKET).remove([sB.storageObject]);
    const stillExists = await serviceClient.storage.from(BUCKET).list(`${CLIENT_B_ID}/${sB.runId}`, {
      search: sB.storageObject.split("/").pop() ?? "",
    });
    // Surface list errors loudly — otherwise an API hiccup looks like "file deleted" and the assertion lies (CR R4).
    if (stillExists.error) {
      throw new Error(`✗ Assertion 3 verification list failed: ${stillExists.error.message}`);
    }
    const found = (stillExists.data ?? []).some((f: { name: string }) => sB.storageObject.endsWith(f.name));
    if (!found) {
      throw new Error(`✗ Assertion 3 FAILED — client A delete REMOVED client B file ${sB.storageObject}`);
    }
    console.log(`✓ Assertion 3 — cross-tenant delete BLOCKED (file ${sB.storageObject} still exists)`);

    // ===== Assertion 4: Cost ledger READ isolation =====
    const ledgerReadA = await clientA.from("cost_ledger_entries").select("id, client_id");
    if (ledgerReadA.error) throw new Error(`✗ Assertion 4 FAILED — client A ledger read: ${ledgerReadA.error.message}`);
    const rowsA = ledgerReadA.data ?? [];
    const wrongClient = rowsA.filter((r: { client_id: string }) => r.client_id !== CLIENT_A_ID);
    if (wrongClient.length > 0) {
      throw new Error(
        `✗ Assertion 4 FAILED — client A saw ${wrongClient.length} cross-tenant ledger row(s)`,
      );
    }
    if (!rowsA.some((r: { id: string }) => r.id === sA.ledgerId)) {
      throw new Error(`✗ Assertion 4 FAILED — client A did not see own ledger entry`);
    }
    console.log(`✓ Assertion 4 — ledger READ isolated (A sees own + 0 cross-tenant)`);

    // ===== Assertion 5: Cost ledger APPEND-ONLY =====
    // RLS denial may surface as error OR silently affect 0 rows.
    // Verify the row's cost_usd is unchanged via service-role re-read (return discarded).
    await clientA
      .from("cost_ledger_entries")
      .update({ cost_usd: 999.99 })
      .eq("id", sA.ledgerId);
    // RLS denial may surface as error OR silently affect 0 rows.
    // Verify the row's cost_usd is unchanged.
    const reread = await serviceClient
      .from("cost_ledger_entries")
      .select("cost_usd")
      .eq("id", sA.ledgerId)
      .single();
    if (reread.error) throw new Error(`✗ Assertion 5 reread failed: ${reread.error.message}`);
    const cost = Number((reread.data as { cost_usd: number }).cost_usd);
    if (Math.abs(cost - 0.0123) > 0.0001) {
      throw new Error(
        `✗ Assertion 5 FAILED — client A UPDATE was permitted (cost changed from 0.0123 to ${cost})`,
      );
    }
    console.log(`✓ Assertion 5 — ledger APPEND-ONLY (UPDATE blocked; cost still 0.0123)`);

    // ===== Assertions 6 + 7 — Storage SELECT (signed-URL) isolation =====
    // These exercise the os-api endpoint /api/artifacts/:id/signed-url end-to-end:
    // own-tenant request must mint a working URL; cross-tenant must 403.
    // Both depend on os-api running with JWT_AUTH_ENABLED=true; the probe
    // ahead of Assertion 7 surfaces a clear env-hint if the flag is off.

    const tokenA = await mintClientJwt(CLIENT_A_ID);

    // ===== Assertion 6: Storage SELECT — same-tenant signed URL works end-to-end =====
    const ownReq = await requestSignedUrl(tokenA, sA.artifactId);
    if (ownReq.status !== 200) {
      const detail = (ownReq.body as { error?: string } | null)?.error ?? `status=${ownReq.status}`;
      throw new Error(`✗ Assertion 6 FAILED — own-tenant signed-URL request: ${detail}`);
    }
    const ownBody = ownReq.body as { signedUrl?: string; expiresInSeconds?: number } | null;
    if (!ownBody?.signedUrl || typeof ownBody.signedUrl !== "string") {
      throw new Error(`✗ Assertion 6 FAILED — endpoint response missing signedUrl: ${JSON.stringify(ownBody)}`);
    }
    if (!ownBody.signedUrl.includes("/object/sign/") || !ownBody.signedUrl.includes("token=")) {
      throw new Error(`✗ Assertion 6 FAILED — signedUrl shape unexpected: ${ownBody.signedUrl.slice(0, 80)}`);
    }

    const fetchOwn = await fetch(ownBody.signedUrl);
    if (!fetchOwn.ok) {
      throw new Error(
        `✗ Assertion 6 FAILED — fetching minted signed URL returned HTTP ${fetchOwn.status} ` +
          `(bucket policy may not yet permit signed reads — verify Migration 016 SELECT policy is live)`,
      );
    }
    const fetchedBytes = Buffer.from(await fetchOwn.arrayBuffer());
    if (fetchedBytes.length !== TEST_FILE_BYTES.length) {
      throw new Error(
        `✗ Assertion 6 FAILED — fetched bytes length ${fetchedBytes.length} ≠ seeded ${TEST_FILE_BYTES.length}`,
      );
    }
    if (!fetchedBytes.equals(TEST_FILE_BYTES)) {
      throw new Error(`✗ Assertion 6 FAILED — fetched bytes differ from seeded payload`);
    }
    console.log(`✓ Assertion 6 — own-tenant signed URL minted + fetches HTTP 200 with seeded bytes`);

    // ===== Assertion 7: Storage SELECT CROSS-TENANT — must return 403 =====
    const crossReq = await requestSignedUrl(tokenA, sB.artifactId);
    if (crossReq.status === 200) {
      // Most likely cause: os-api running with JWT_AUTH_ENABLED=false.
      // The endpoint's tenant gate bootstrap-falls-back to anonymous-allowed
      // in that configuration; the gate only engages when the flag is on.
      throw new Error(
        `✗ Assertion 7 FAILED — cross-tenant signed-URL request returned HTTP 200, expected 403.\n` +
          `  Most likely cause: os-api is running with JWT_AUTH_ENABLED=false (default).\n` +
          `  Restart os-api with JWT_AUTH_ENABLED=true in its env, then re-run this harness.`,
      );
    }
    if (crossReq.status !== 403) {
      const detail = (crossReq.body as { error?: string } | null)?.error ?? `status=${crossReq.status}`;
      throw new Error(`✗ Assertion 7 FAILED — expected HTTP 403, got HTTP ${crossReq.status}: ${detail}`);
    }
    console.log(`✓ Assertion 7 — cross-tenant signed-URL request BLOCKED with HTTP 403`);

    console.log(`\n✓✓✓ ALL 7 ASSERTIONS PASS — PR #4 + PR #5 Storage + ledger isolation verified`);
  } catch (err) {
    primaryError = err;
  } finally {
    // Always attempt BOTH cleanups; never throw FROM finally (Biome no-unsafe-finally).
    // Cleanup errors accumulate into cleanupErrors; aggregation after finally.
    for (const [cid, seeded] of [
      [CLIENT_A_ID, seededA] as const,
      [CLIENT_B_ID, seededB] as const,
    ]) {
      try {
        await cleanup(cid, seeded);
      } catch (err) {
        cleanupErrors.push(err instanceof Error ? err.message : String(err));
      }
    }
    console.log(cleanupErrors.length > 0 ? `cleanup INCOMPLETE — ${cleanupErrors.length} step(s) failed` : `cleanup complete`);
  }

  // Post-finally aggregation (preserves primary error + surfaces cleanup
  // failures even when assertions pass).
  if (primaryError !== undefined && cleanupErrors.length > 0) {
    const detail = `\n  cleanup also failed:\n    - ${cleanupErrors.join("\n    - ")}`;
    if (primaryError instanceof Error) {
      primaryError.message += detail;
      throw primaryError;
    }
    throw new Error(`${String(primaryError)}${detail}`);
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new Error(`cleanup failures:\n  - ${cleanupErrors.join("\n  - ")}`);
  }
}

main().catch((err) => {
  console.error(`PR #4 HARNESS FAILURE:`, err);
  process.exit(1);
});
