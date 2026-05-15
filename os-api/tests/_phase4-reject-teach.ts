// ADR-006 D4 Reject-as-Teach endpoint contract harness.
//
// PRE-REQUISITE: os-api running with JWT_AUTH_ENABLED=true.
// Verifies POST /api/escalations/:id/reject, shared category dropdown endpoint,
// optional reference-image Storage upload, tenant gate, and append-only RLS.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient as createAnonClient } from "@supabase/supabase-js";
import { mintClientJwt } from "../src/auth.js";
import { supabase as serviceClient } from "../src/supabase.js";

const OS_API_URL = process.env.OS_API_URL ?? "http://localhost:3001";
const SUFFIX = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const CLIENT_A_ID = `phase4_reject_a_${SUFFIX}`;
const CLIENT_B_ID = `phase4_reject_b_${SUFFIX}`;
const ONE_BY_ONE_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

interface SeededEscalation {
  campaignId: string;
  runId: string;
  deliverableId: string;
  artifactId: string;
  escalationId: string;
}

interface SeededTenant {
  shot1: SeededEscalation;
  shot2: SeededEscalation;
}

interface RequestResult {
  status: number;
  body: Record<string, unknown>;
}

let assertions = 0;
const storagePathsToCleanup: string[] = [];

function check(label: string, condition: unknown): void {
  assertions += 1;
  if (!condition) throw new Error(`Assertion ${assertions} failed: ${label}`);
  console.log(`✓ ${assertions}. ${label}`);
}

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

async function expectSingle<T>(
  result: { data: T | null; error: { message: string } | null },
  label: string,
): Promise<T> {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (!result.data) throw new Error(`${label}: no data returned`);
  return result.data;
}

async function requestJson(
  method: "GET" | "POST",
  path: string,
  token?: string,
  body?: Record<string, unknown>,
): Promise<RequestResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(`${OS_API_URL}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = await resp.json() as Record<string, unknown>;
  } catch {
    // leave empty
  }
  return { status: resp.status, body: parsed };
}

async function makeAuthedClient(clientId: string): Promise<SupabaseClient> {
  const token = await mintClientJwt(clientId);
  const client = createAnonClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_KEY"), {
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

async function seedTenant(clientId: string): Promise<SeededTenant> {
  await expectMutation(
    await serviceClient.from("clients").insert({
      id: clientId,
      name: `Phase 4 Reject ${clientId}`,
      status: "active",
      brand_slug: clientId,
      ui_config: {},
    }),
    `[seed ${clientId}] client`,
  );

  const campaign = await expectSingle<{ id: string }>(
    await serviceClient
      .from("campaigns")
      .insert({
        client_id: clientId,
        name: `Phase 4 Reject Campaign ${clientId}`,
        prompt: "reject-as-teach contract test campaign",
        deliverables: [],
        platforms: [],
        status: "draft",
        guardrails: {
          qa_threshold: { pass_threshold: 3.0 },
          music_video_context: {
            title: "Reject-as-Teach Contract MV",
            total_shots: 2,
            shot_list_summary: [
              { shot_number: 1, beat_name: "intro", visual_intent_summary: "shot one" },
              { shot_number: 2, beat_name: "hook_1", visual_intent_summary: "shot two" },
            ],
          },
        },
      })
      .select("id")
      .single(),
    `[seed ${clientId}] campaign`,
  );

  async function seedShot(shotNumber: number): Promise<SeededEscalation> {
    const run = await expectSingle<{ id: string }>(
      await serviceClient
        .from("runs")
        .insert({
          client_id: clientId,
          campaign_id: campaign.id,
          mode: "stills",
          status: "needs_review",
          stages: [],
          hitl_required: true,
          metadata: {},
        })
        .select("id")
        .single(),
      `[seed ${clientId}] run shot ${shotNumber}`,
    );

    const deliverable = await expectSingle<{ id: string }>(
      await serviceClient
        .from("campaign_deliverables")
        .insert({
          client_id: clientId,
          campaign_id: campaign.id,
          description: `Shot ${shotNumber} reject-as-teach deliverable`,
          status: "pending",
          retry_count: 0,
          current_prompt: `shot ${shotNumber}`,
          original_prompt: `shot ${shotNumber}`,
        })
        .select("id")
        .single(),
      `[seed ${clientId}] deliverable shot ${shotNumber}`,
    );

    const artifact = await expectSingle<{ id: string }>(
      await serviceClient
        .from("artifacts")
        .insert({
          client_id: clientId,
          campaign_id: campaign.id,
          run_id: run.id,
          deliverable_id: deliverable.id,
          type: "image",
          name: `shot_${shotNumber}_reject_iter_1.png`,
          path: `/tmp/phase4_reject_${clientId}_${shotNumber}.png`,
          metadata: { iter: 1 },
        })
        .select("id")
        .single(),
      `[seed ${clientId}] artifact shot ${shotNumber}`,
    );

    const escalation = await expectSingle<{ id: string }>(
      await serviceClient
        .from("asset_escalations")
        .insert({
          client_id: clientId,
          artifact_id: artifact.id,
          deliverable_id: deliverable.id,
          run_id: run.id,
          current_level: "L2",
          status: "hitl_required",
          iteration_count: 1,
          failure_class: "direction_reversion",
        })
        .select("id")
        .single(),
      `[seed ${clientId}] escalation shot ${shotNumber}`,
    );

    return {
      campaignId: campaign.id,
      runId: run.id,
      deliverableId: deliverable.id,
      artifactId: artifact.id,
      escalationId: escalation.id,
    };
  }

  return {
    shot1: await seedShot(1),
    shot2: await seedShot(2),
  };
}

async function assertAppendOnlyRls(client: SupabaseClient, eventId: string): Promise<void> {
  const { data: updateRows, error: updateError } = await client
    .from("rejection_learning_events")
    .update({ correction: "MUTATED — append-only regression" })
    .eq("id", eventId)
    .select("id, correction");
  if (updateError) throw new Error(`[rlearn] append-only UPDATE errored instead of affecting 0 rows: ${updateError.message}`);
  check("append-only RLS UPDATE affects 0 rows", (updateRows ?? []).length === 0);

  const { data: deleteRows, error: deleteError } = await client
    .from("rejection_learning_events")
    .delete()
    .eq("id", eventId)
    .select("id");
  if (deleteError) throw new Error(`[rlearn] append-only DELETE errored instead of affecting 0 rows: ${deleteError.message}`);
  check("append-only RLS DELETE affects 0 rows", (deleteRows ?? []).length === 0);

  const row = await expectSingle<{ id: string; correction: string }>(
    await serviceClient
      .from("rejection_learning_events")
      .select("id, correction")
      .eq("id", eventId)
      .single(),
    "[verify] append-only learning row survived",
  );
  check("append-only RLS leaves learning correction unchanged", row.correction !== "MUTATED — append-only regression");
}

async function cleanup(clientId: string): Promise<void> {
  const { data: runs } = await serviceClient.from("runs").select("id").eq("client_id", clientId);
  const runIds = (runs ?? []).map((row: { id: string }) => row.id);
  const { data: campaigns } = await serviceClient.from("campaigns").select("id").eq("client_id", clientId);
  const campaignIds = (campaigns ?? []).map((row: { id: string }) => row.id);

  await serviceClient.from("asset_escalations").delete().eq("client_id", clientId);
  await serviceClient.from("rejection_learning_events").delete().eq("client_id", clientId);
  await serviceClient.from("artifacts").delete().eq("client_id", clientId);
  await serviceClient.from("campaign_deliverables").delete().eq("client_id", clientId);
  if (runIds.length > 0) await serviceClient.from("run_logs").delete().in("run_id", runIds);
  if (runIds.length > 0) await serviceClient.from("runs").delete().in("id", runIds);
  if (campaignIds.length > 0) await serviceClient.from("campaigns").delete().in("id", campaignIds);
  await serviceClient.from("clients").delete().eq("id", clientId);
}

async function cleanupStorage(): Promise<void> {
  if (storagePathsToCleanup.length === 0) return;
  await serviceClient.storage.from("artifacts").remove(storagePathsToCleanup).catch(() => undefined);
}

async function main(): Promise<void> {
  const health = await fetch(`${OS_API_URL}/api/health`);
  check("os-api health endpoint responds", health.ok);

  const seededA = await seedTenant(CLIENT_A_ID);
  const seededB = await seedTenant(CLIENT_B_ID);
  const tokenA = await mintClientJwt(CLIENT_A_ID);
  const authedA = await makeAuthedClient(CLIENT_A_ID);

  try {
    const categoriesMissingJwt = await requestJson("GET", "/api/rejection-categories");
    check("rejection-categories returns 401 when JWT missing", categoriesMissingJwt.status === 401);

    const categoriesResp = await requestJson("GET", "/api/rejection-categories", tokenA);
    const categories = (categoriesResp.body.categories ?? []) as Array<{ id: string; name?: string }>;
    check("rejection-categories returns 200 with JWT", categoriesResp.status === 200);
    check("rejection-categories returns a non-empty shared taxonomy", categories.length > 0 && typeof categories[0]?.id === "string");
    const categoryId = categories[0].id;

    const missingJwt = await requestJson("POST", `/api/escalations/${seededA.shot1.escalationId}/reject`, undefined, {
      category_id: categoryId,
      what_wrong: "The shot reintroduced the banned hero mech silhouette.",
      correction: "Keep the frame grounded in human aftermath and remove hero mech framing.",
      block_mode: "soft",
    });
    check("reject endpoint returns 401 when JWT missing", missingJwt.status === 401);

    const crossTenant = await requestJson("POST", `/api/escalations/${seededB.shot1.escalationId}/reject`, tokenA, {
      category_id: categoryId,
      what_wrong: "The shot reintroduced the banned hero mech silhouette.",
      correction: "Keep the frame grounded in human aftermath and remove hero mech framing.",
      block_mode: "soft",
    });
    // Resource-existence-leak fix (CodeRabbit PR #8). Cross-tenant probes now
    // return a uniform 404 — the scoped DB lookup returns null for both
    // "not found" and "exists but foreign tenant" so the outsider cannot
    // differentiate the two. Mirrors PR #6 R2 hardening + the same change in
    // _phase4-review-gate-card.ts.
    check("reject endpoint returns 404 for cross-tenant escalation (no existence leak)", crossTenant.status === 404);

    const invalidPayload = await requestJson("POST", `/api/escalations/${seededA.shot1.escalationId}/reject`, tokenA, {
      category_id: categoryId,
      what_wrong: "too short",
      correction: "also bad",
      block_mode: "soft",
    });
    check("reject endpoint returns 400 for invalid learning payload", invalidPayload.status === 400);

    const softReject = await requestJson("POST", `/api/escalations/${seededA.shot1.escalationId}/reject`, tokenA, {
      category_id: categoryId,
      what_wrong: "The image reintroduced heroic mech iconography after the campaign pivoted away from it.",
      correction: "Use grounded human aftermath framing, remove hero-mech silhouettes, and keep the palette documentary-dry.",
      ref_image_data: ONE_BY_ONE_PNG,
      block_mode: "soft",
    });
    check("soft reject with ref image returns 200", softReject.status === 200);
    check("soft reject returns a learning event id", typeof softReject.body.eventId === "string");
    check("soft reject returns a signed ref-image URL", typeof softReject.body.refImageSignedUrl === "string" && String(softReject.body.refImageSignedUrl).includes("token="));

    const eventId = softReject.body.eventId as string;
    const refImagePath = softReject.body.refImagePath as string;
    storagePathsToCleanup.push(refImagePath);

    const softEscalation = await expectSingle<{
      status: string;
      learning_event_id: string | null;
      resolution_notes: string | null;
      resolved_at: string | null;
    }>(
      await serviceClient
        .from("asset_escalations")
        .select("status, learning_event_id, resolution_notes, resolved_at")
        .eq("id", seededA.shot1.escalationId)
        .single(),
      "[verify] soft rejected escalation",
    );
    check("soft reject writes status=rejected_soft + learning_event_id", softEscalation.status === "rejected_soft" && softEscalation.learning_event_id === eventId);
    check("soft reject marks escalation resolved", Boolean(softEscalation.resolved_at && softEscalation.resolution_notes?.includes(eventId)));

    const learningRow = await expectSingle<{
      id: string;
      client_id: string;
      campaign_id: string | null;
      shot_id: number | null;
      asset_id: string | null;
      category_id: string | null;
      what_wrong: string;
      correction: string;
      ref_image_path: string | null;
      block_mode: string;
    }>(
      await serviceClient
        .from("rejection_learning_events")
        .select("id, client_id, campaign_id, shot_id, asset_id, category_id, what_wrong, correction, ref_image_path, block_mode")
        .eq("id", eventId)
        .single(),
      "[verify] learning row",
    );
    check("learning row persists tenant/campaign/shot/artifact context", learningRow.client_id === CLIENT_A_ID && learningRow.campaign_id === seededA.shot1.campaignId && learningRow.shot_id === 1 && learningRow.asset_id === seededA.shot1.artifactId);
    check("learning row persists category, correction, block_mode=soft", learningRow.category_id === categoryId && learningRow.block_mode === "soft" && learningRow.correction.includes("grounded human aftermath"));
    check("ref image path follows client_id/run_id/learning/event_id.png", learningRow.ref_image_path === `${CLIENT_A_ID}/${seededA.shot1.runId}/learning/${eventId}.png`);

    const signedFetch = await fetch(softReject.body.refImageSignedUrl as string);
    check("ref image signed URL fetches uploaded PNG bytes", signedFetch.ok);

    await assertAppendOnlyRls(authedA, eventId);

    const terminalReject = await requestJson("POST", `/api/escalations/${seededA.shot2.escalationId}/reject`, tokenA, {
      category_id: categoryId,
      what_wrong: "The second image repeats the same disallowed hero-mech posture and should not stay in circulation.",
      correction: "Regenerate from a human-scaled aftermath angle without heroic robot posture or glowing weapon framing.",
      block_mode: "terminal",
    });
    check("terminal reject returns 200", terminalReject.status === 200);
    const terminalEscalation = await expectSingle<{ status: string; learning_event_id: string | null }>(
      await serviceClient
        .from("asset_escalations")
        .select("status, learning_event_id")
        .eq("id", seededA.shot2.escalationId)
        .single(),
      "[verify] terminal rejected escalation",
    );
    check("terminal reject writes status=rejected_terminal + learning_event_id", terminalEscalation.status === "rejected_terminal" && Boolean(terminalEscalation.learning_event_id));

    console.log(`\n${assertions}/${assertions} — Phase 4 Reject-as-Teach endpoint contract verified`);
  } finally {
    await cleanupStorage();
    await cleanup(CLIENT_A_ID);
    await cleanup(CLIENT_B_ID);
  }
}

main().catch(async (err) => {
  console.error(err);
  await cleanupStorage().catch(() => undefined);
  await cleanup(CLIENT_A_ID).catch(() => undefined);
  await cleanup(CLIENT_B_ID).catch(() => undefined);
  process.exit(1);
});
