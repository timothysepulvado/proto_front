// Multi-tenant RLS verification harness — runs against the live linked Supabase project
// using ephemeral phase7_test_* clients. Cleans up all seeded rows at end.
//
// Asserts:
// 1. JWT-scoped session for client A reads ONLY client A's rows across per-client tables
// 2. JWT-scoped session for client B reads ONLY client B's rows
// 3. Service-role key bypasses RLS and sees both test tenants
// 4. Anon key without JWT returns 0 rows or RLS-deny on per-client tables
// 5. Global tables are readable by both JWT-scoped sessions

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient as createAnonClient } from "@supabase/supabase-js";
import { mintClientJwt } from "../src/auth.js";
import {
  requireClientIdForArtifact,
  requireClientIdForCampaign,
  requireClientIdForEscalation,
  requireClientIdForRun,
} from "../src/db.js";
import { supabase as serviceClient } from "../src/supabase.js";

const RUN_ID_SUFFIX = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const CLIENT_A_ID = `phase7_test_a_${RUN_ID_SUFFIX}`;
const CLIENT_B_ID = `phase7_test_b_${RUN_ID_SUFFIX}`;

const PER_CLIENT_TABLES = [
  "runs",
  "campaigns",
  "campaign_deliverables",
  "artifacts",
  "run_logs",
  "hitl_decisions",
  "asset_escalations",
  "orchestration_decisions",
] as const;

const GLOBAL_TABLES = ["rejection_categories", "known_limitations"] as const;

type PerClientTable = (typeof PER_CLIENT_TABLES)[number];

type IdClientRow = {
  id: string | number;
  client_id: string;
};

type SeededClientRows = {
  campaignId: string;
  runId: string;
  deliverableId: string;
  artifactId: string;
  escalationId: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function expectNoError<T>(
  result: { data: T | null; error: { message: string } | null },
  label: string,
): Promise<T> {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.data == null) throw new Error(`${label}: no data returned`);
  return result.data;
}

async function expectMutation(
  result: { error: { message: string } | null },
  label: string,
): Promise<void> {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
}

async function seedClient(clientId: string): Promise<SeededClientRows> {
  // 1. clients (parent — clients.id is TEXT / client_id source)
  await expectMutation(
    await serviceClient.from("clients").insert({
      id: clientId,
      name: `Phase 7 Test ${clientId}`,
      status: "active",
      brand_slug: clientId,
      ui_config: {},
    }),
    `[seed ${clientId}] clients insert`,
  );

  // 2. campaigns (Class A direct client_id)
  const campaign = await expectNoError(
    await serviceClient
      .from("campaigns")
      .insert({
        client_id: clientId,
        name: `Test Campaign ${clientId}`,
        prompt: "test",
        deliverables: [],
        platforms: [],
        status: "draft",
      })
      .select("id")
      .single(),
    `[seed ${clientId}] campaigns insert`,
  ) as { id: string };

  // 3. runs (Class A direct client_id)
  const run = await expectNoError(
    await serviceClient
      .from("runs")
      .insert({
        client_id: clientId,
        mode: "ingest",
        status: "completed",
        stages: {},
        campaign_id: campaign.id,
        hitl_required: false,
        metadata: {},
      })
      .select("id")
      .single(),
    `[seed ${clientId}] runs insert`,
  ) as { id: string };

  // 4. campaign_deliverables (Class C)
  const deliverable = await expectNoError(
    await serviceClient
      .from("campaign_deliverables")
      .insert({
        client_id: clientId,
        campaign_id: campaign.id,
        description: "test deliverable",
        status: "pending",
        retry_count: 0,
        current_prompt: "test",
        original_prompt: "test",
      })
      .select("id")
      .single(),
    `[seed ${clientId}] campaign_deliverables insert`,
  ) as { id: string };

  // 5. artifacts (Class A* — NOT NULL client_id flip in 014)
  const artifact = await expectNoError(
    await serviceClient
      .from("artifacts")
      .insert({
        client_id: clientId,
        run_id: run.id,
        campaign_id: campaign.id,
        deliverable_id: deliverable.id,
        type: "image",
        name: "test.png",
        path: `/phase7-test/${clientId}/test.png`,
      })
      .select("id")
      .single(),
    `[seed ${clientId}] artifacts insert`,
  ) as { id: string };

  // 6. run_logs (Class B)
  await expectMutation(
    await serviceClient.from("run_logs").insert({
      client_id: clientId,
      run_id: run.id,
      stage: "test",
      level: "info",
      message: "phase7 test log",
    }),
    `[seed ${clientId}] run_logs insert`,
  );

  // 7. hitl_decisions (Class B)
  await expectMutation(
    await serviceClient.from("hitl_decisions").insert({
      client_id: clientId,
      run_id: run.id,
      artifact_id: artifact.id,
      decision: "approve",
    }),
    `[seed ${clientId}] hitl_decisions insert`,
  );

  // 8. asset_escalations (Class B)
  const escalation = await expectNoError(
    await serviceClient
      .from("asset_escalations")
      .insert({
        client_id: clientId,
        artifact_id: artifact.id,
        run_id: run.id,
        current_level: "L1",
        status: "in_progress",
        iteration_count: 0,
      })
      .select("id")
      .single(),
    `[seed ${clientId}] asset_escalations insert`,
  ) as { id: string };

  // 9. orchestration_decisions (Class B)
  await expectMutation(
    await serviceClient.from("orchestration_decisions").insert({
      client_id: clientId,
      escalation_id: escalation.id,
      run_id: run.id,
      iteration: 0,
      input_context: {},
      decision: {},
      model: "test",
    }),
    `[seed ${clientId}] orchestration_decisions insert`,
  );

  return {
    campaignId: campaign.id,
    runId: run.id,
    deliverableId: deliverable.id,
    artifactId: artifact.id,
    escalationId: escalation.id,
  };
}

async function makeAuthedClient(clientId: string): Promise<SupabaseClient> {
  const url = requireEnv("SUPABASE_URL");
  const publishableKey = requireEnv("SUPABASE_KEY");
  const token = await mintClientJwt(clientId);

  // Supabase-js v2 GoTrue validates app JWTs like user-session JWTs and can
  // reject the locked Phase E shape sub=client_<id> as non-UUID. Keep the
  // setSession call from the Phase F contract, while using the same JWT as the
  // Authorization header for PostgREST verification (the path the HUD uses).
  const client = createAnonClient(url, publishableKey, {
    global: {
      fetch: (input, init) => {
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

function makeAnonClient(): SupabaseClient {
  return createAnonClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_KEY"));
}

async function assertOnlyClient(client: SupabaseClient, expectedClientId: string, label: string): Promise<void> {
  for (const tbl of PER_CLIENT_TABLES) {
    const { data, error } = await client.from(tbl).select("id, client_id");
    if (error) throw new Error(`[${label}] ${tbl} query failed: ${error.message}`);
    const rows = (data ?? []) as IdClientRow[];
    const wrong = rows.filter((row) => row.client_id !== expectedClientId);
    if (wrong.length > 0) {
      throw new Error(
        `[${label}] ${tbl} returned ${wrong.length} row(s) for OTHER client(s): ${wrong
          .map((row) => row.client_id)
          .join(",")}`,
      );
    }
    if (!rows.some((row) => row.client_id === expectedClientId)) {
      throw new Error(`[${label}] ${tbl} returned no rows for expected client ${expectedClientId}`);
    }
  }
  console.log(`✓ [${label}] all per-client tables filtered to ${expectedClientId}`);
}

async function assertSeesBoth(client: SupabaseClient): Promise<void> {
  let totalA = 0;
  let totalB = 0;
  for (const tbl of PER_CLIENT_TABLES) {
    const { data, error } = await client
      .from(tbl)
      .select("id, client_id")
      .in("client_id", [CLIENT_A_ID, CLIENT_B_ID]);
    if (error) throw new Error(`[service-role] ${tbl} query failed: ${error.message}`);
    const rows = (data ?? []) as IdClientRow[];
    const countA = rows.filter((row) => row.client_id === CLIENT_A_ID).length;
    const countB = rows.filter((row) => row.client_id === CLIENT_B_ID).length;
    if (countA < 1 || countB < 1) {
      throw new Error(`[service-role] ${tbl} expected both clients, got A=${countA}, B=${countB}`);
    }
    totalA += countA;
    totalB += countB;
  }
  console.log(`✓ service role sees both clients (A=${totalA} rows, B=${totalB} rows)`);
}

async function expectTenantMismatch(label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = describeError(error);
    if (message.includes("Tenant mismatch")) return;
    throw new Error(`[tenant-mismatch] ${label} threw unexpected error: ${message}`);
  }
  throw new Error(`[tenant-mismatch] ${label} accepted a wrong client_id`);
}

async function assertTenantMismatchValidation(rows: SeededClientRows): Promise<void> {
  await expectTenantMismatch("run", () => requireClientIdForRun(rows.runId, CLIENT_B_ID));
  await expectTenantMismatch("campaign", () => requireClientIdForCampaign(rows.campaignId, CLIENT_B_ID));
  await expectTenantMismatch("artifact", () => requireClientIdForArtifact(rows.artifactId, CLIENT_B_ID));
  await expectTenantMismatch("escalation", () => requireClientIdForEscalation(rows.escalationId, CLIENT_B_ID));
  console.log("✓ requireClientIdFor* helpers reject mismatched tenant IDs");
}

async function assertAnonBlocked(client: SupabaseClient): Promise<void> {
  for (const tbl of PER_CLIENT_TABLES) {
    const { data, error } = await client.from(tbl).select("id, client_id");
    if (error) {
      const isExpectedDeny =
        error.code === "PGRST301" ||
        error.code === "42501" ||
        error.message.includes("permission") ||
        error.message.includes("RLS");
      if (!isExpectedDeny) {
        throw new Error(
          `[anon] ${tbl} unexpected error (not RLS deny): ${error.code} ${error.message}`,
        );
      }
      continue;
    }
    const rows = data ?? [];
    if (rows.length > 0) {
      throw new Error(`[anon] ${tbl} returned ${rows.length} row(s); expected 0 rows or RLS deny`);
    }
  }
  console.log("✓ anon (no JWT) blocked or returned 0 rows on per-client tables");
}

async function assertGlobalReadable(client: SupabaseClient, label: string): Promise<void> {
  for (const tbl of GLOBAL_TABLES) {
    const { data, error } = await client.from(tbl).select("id");
    if (error) throw new Error(`[${label}] ${tbl} query failed: ${error.message}`);
    if (!data || data.length === 0) {
      throw new Error(`[${label}] ${tbl} returned 0 rows — global table should be readable`);
    }
  }
  console.log(`✓ [${label}] global tables readable`);
}

async function cleanupClient(clientId: string): Promise<void> {
  const deletes: Array<[PerClientTable | "clients", PromiseLike<{ error: { message: string } | null }>]> = [
    ["orchestration_decisions", serviceClient.from("orchestration_decisions").delete().eq("client_id", clientId)],
    ["asset_escalations", serviceClient.from("asset_escalations").delete().eq("client_id", clientId)],
    ["hitl_decisions", serviceClient.from("hitl_decisions").delete().eq("client_id", clientId)],
    ["run_logs", serviceClient.from("run_logs").delete().eq("client_id", clientId)],
    ["artifacts", serviceClient.from("artifacts").delete().eq("client_id", clientId)],
    ["campaign_deliverables", serviceClient.from("campaign_deliverables").delete().eq("client_id", clientId)],
    ["runs", serviceClient.from("runs").delete().eq("client_id", clientId)],
    ["campaigns", serviceClient.from("campaigns").delete().eq("client_id", clientId)],
    ["clients", serviceClient.from("clients").delete().eq("id", clientId)],
  ];

  for (const [table, query] of deletes) {
    const { error } = await query;
    if (error) throw new Error(`[cleanup ${clientId}] ${table}: ${error.message}`);
  }
}

async function assertNoPhase7Orphans(): Promise<void> {
  const { count, error } = await serviceClient
    .from("clients")
    .select("id", { count: "exact", head: true })
    .like("id", "phase7_test_%");
  if (error) throw new Error(`orphan probe failed: ${error.message}`);
  if ((count ?? 0) !== 0) throw new Error(`orphan probe found ${count} phase7_test_* client row(s)`);
}

async function main(): Promise<void> {
  console.log(`[Phase 7 multi-tenant isolation harness] starting (suffix: ${RUN_ID_SUFFIX})`);
  try {
    const seededA = await seedClient(CLIENT_A_ID);
    const seededB = await seedClient(CLIENT_B_ID);
    console.log(`✓ seeded ephemeral test clients ${CLIENT_A_ID} + ${CLIENT_B_ID}`);
    console.log(`  A rows: ${JSON.stringify(seededA)}`);
    console.log(`  B rows: ${JSON.stringify(seededB)}`);

    const authedA = await makeAuthedClient(CLIENT_A_ID);
    const authedB = await makeAuthedClient(CLIENT_B_ID);
    console.log("✓ minted JWTs for both");

    const anon = makeAnonClient();

    await assertOnlyClient(authedA, CLIENT_A_ID, "JWT-A");
    await assertOnlyClient(authedB, CLIENT_B_ID, "JWT-B");
    await assertSeesBoth(serviceClient);
    await assertTenantMismatchValidation(seededA);
    await assertAnonBlocked(anon);
    await assertGlobalReadable(authedA, "JWT-A-global");
    await assertGlobalReadable(authedB, "JWT-B-global");

    console.log("\n✓✓✓ ALL 5 ASSERTIONS PASS — multi-tenant RLS verified");
  } catch (error) {
    console.error(`\n✗ FAIL: ${describeError(error)}`);
    process.exitCode = 1;
  } finally {
    try {
      await cleanupClient(CLIENT_A_ID);
      await cleanupClient(CLIENT_B_ID);
      await assertNoPhase7Orphans();
      console.log("✓ cleanup complete");
    } catch (error) {
      console.error(
        `✗ CLEANUP FAILED — orphan rows for ${CLIENT_A_ID}/${CLIENT_B_ID} may remain: ${describeError(error)}`,
      );
      process.exitCode = 1;
    }
  }
}

void main();
