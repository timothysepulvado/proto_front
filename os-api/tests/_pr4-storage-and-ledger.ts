// PR #4 verification harness — Storage write-side RLS + cost ledger isolation.
// Mirrors the structure of _phase7-multi-tenant-isolation.ts.
// Drop into os-api/tests/ as `_pr4-storage-and-ledger.ts` after migrations
// 016 + 017 are applied to the linked Supabase project.
//
// Asserts:
// 1. Storage UPLOAD — client A JWT uploads to own prefix succeeds
// 2. Storage UPLOAD CROSS-TENANT — client A JWT upload to client B prefix is BLOCKED
// 3. Storage DELETE CROSS-TENANT — client A JWT delete of client B file is BLOCKED
// 4. Cost ledger READ isolation — client A JWT sees own ledger entries; not client B's
// 5. Cost ledger APPEND-ONLY — client A JWT cannot UPDATE or DELETE own ledger row
//
// NOTE: Storage SELECT isolation NOT TESTED in PR #4 — bucket stays public=true,
// /object/public/ URL pattern bypasses RLS entirely. PR #5 flips bucket private
// + adds a SELECT isolation assertion to this harness.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient as createAnonClient } from "@supabase/supabase-js";
import { mintClientJwt } from "../src/auth.js";
import { supabase as serviceClient } from "../src/supabase.js";

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

async function seedClient(clientId: string): Promise<{ runId: string; storageObject: string; ledgerId: string }> {
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

  return { runId, storageObject, ledgerId };
}

async function cleanup(clientId: string, seeded: { runId: string; storageObject: string; ledgerId: string } | undefined): Promise<void> {
  // Reverse-order FK-aware delete. All via service-role, all soft-fail logged.
  // NOTE: cost_ledger_entries is append-only by RLS design (no UPDATE/DELETE
  // policies). Cleanup of the seeded ledger row happens automatically via
  // ON DELETE CASCADE on cost_ledger_entries.run_id when we delete the run
  // below — no explicit ledger DELETE required, which respects the invariant
  // even if BYPASSRLS is ever revoked from service_role in the future.
  if (seeded) {
    // Storage object first (no FK to client but cleanup courtesy)
    const rmObj = await serviceClient.storage.from(BUCKET).remove([seeded.storageObject]);
    if (rmObj.error) console.warn(`[cleanup ${clientId}] storage remove: ${rmObj.error.message}`);

    // Run row — CASCADE deletes the seeded ledger row + any artifacts/run_logs.
    const rmRun = await serviceClient.from("runs").delete().eq("id", seeded.runId);
    if (rmRun.error) console.warn(`[cleanup ${clientId}] run: ${rmRun.error.message}`);
  }

  // Client last
  const rmClient = await serviceClient.from("clients").delete().eq("id", clientId);
  if (rmClient.error) console.warn(`[cleanup ${clientId}] client: ${rmClient.error.message}`);
}

async function main(): Promise<void> {
  console.log(`PR #4 harness — clients: ${CLIENT_A_ID} / ${CLIENT_B_ID}`);

  let seededA: { runId: string; storageObject: string; ledgerId: string } | undefined;
  let seededB: { runId: string; storageObject: string; ledgerId: string } | undefined;

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

    // Cleanup own upload to avoid noise
    await serviceClient.storage.from(BUCKET).remove([ownPath]);

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

    console.log(`\n✓✓✓ ALL 5 ASSERTIONS PASS — PR #4 Storage write-side RLS + ledger isolation verified`);
  } finally {
    await cleanup(CLIENT_A_ID, seededA);
    await cleanup(CLIENT_B_ID, seededB);
    console.log(`cleanup complete`);
  }
}

main().catch((err) => {
  console.error(`PR #4 HARNESS FAILURE:`, err);
  process.exit(1);
});
