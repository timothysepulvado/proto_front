// ADR-006 D4 ReviewGateImageCard endpoint contract harness.
//
// PRE-REQUISITE: os-api running with JWT_AUTH_ENABLED=true. For deterministic
// local tests, start it with REVIEW_GATE_COMMENT_REGEN_EXECUTION=false so the
// endpoint creates the regen run without launching sidecar-dependent execution.

import { mintClientJwt } from "../src/auth.js";
import { supabase as serviceClient } from "../src/supabase.js";

const OS_API_URL = process.env.OS_API_URL ?? "http://localhost:3001";
const SUFFIX = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const CLIENT_A_ID = `phase4_rg_a_${SUFFIX}`;
const CLIENT_B_ID = `phase4_rg_b_${SUFFIX}`;

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

let assertions = 0;

function check(label: string, condition: unknown): void {
  assertions += 1;
  if (!condition) throw new Error(`Assertion ${assertions} failed: ${label}`);
  console.log(`✓ ${assertions}. ${label}`);
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
  path: string,
  token: string | undefined,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(`${OS_API_URL}${path}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = await resp.json() as Record<string, unknown>;
  } catch {
    // leave empty
  }
  return { status: resp.status, body: parsed };
}

async function seedTenant(clientId: string): Promise<SeededTenant> {
  await expectMutation(
    await serviceClient.from("clients").insert({
      id: clientId,
      name: `Phase 4 Review Gate ${clientId}`,
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
        name: `Phase 4 Review Gate Campaign ${clientId}`,
        prompt: "contract test campaign",
        deliverables: [],
        platforms: [],
        status: "draft",
        guardrails: {
          qa_threshold: { pass_threshold: 3.0, accept_threshold: 2.5 },
          music_video_context: {
            title: "Contract Test MV",
            synopsis: "Contract test synopsis.",
            reference_tone: "Contract test tone.",
            total_shots: 2,
            track_duration_s: 16,
            shot_list_summary: [
              { shot_number: 1, beat_name: "intro", visual_intent_summary: "shot one" },
              { shot_number: 2, beat_name: "hook_1", visual_intent_summary: "shot two" },
            ],
            ingested_at: new Date().toISOString(),
            manifest_sha256: "phase4-contract-test",
            direction_mantra: "old realistic direction",
            abandoned_directions: [],
          },
          directional_history: {
            current_direction_mantra: "old realistic direction",
            abandoned_directions: [],
          },
        },
      })
      .select("id")
      .single(),
    `[seed ${clientId}] campaign`,
  );

  async function seedShot(shotNumber: number, score: number): Promise<SeededEscalation> {
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
          description: `Shot ${shotNumber} contract-test deliverable`,
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
          name: `shot_${shotNumber}_iter_1.png`,
          path: `/tmp/phase4_review_gate_${clientId}_${shotNumber}.png`,
          metadata: { iter: 1 },
        })
        .select("id")
        .single(),
      `[seed ${clientId}] artifact shot ${shotNumber}`,
    );

    await expectMutation(
      await serviceClient.from("run_logs").insert({
        client_id: clientId,
        run_id: run.id,
        stage: "grade",
        level: "info",
        message: `[in_loop] shot ${shotNumber} iter 1: FAIL score=${score.toFixed(2)} → direction_reversion`,
      }),
      `[seed ${clientId}] run log shot ${shotNumber}`,
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
    shot1: await seedShot(1, 2.1),
    shot2: await seedShot(2, 2.2),
  };
}

async function cleanup(clientId: string): Promise<void> {
  const { data: runs } = await serviceClient.from("runs").select("id").eq("client_id", clientId);
  const runIds = (runs ?? []).map((row: { id: string }) => row.id);
  const { data: campaigns } = await serviceClient.from("campaigns").select("id").eq("client_id", clientId);
  const campaignIds = (campaigns ?? []).map((row: { id: string }) => row.id);

  if (runIds.length > 0) await serviceClient.from("run_logs").delete().in("run_id", runIds);
  await serviceClient.from("asset_escalations").delete().eq("client_id", clientId);
  await serviceClient.from("artifacts").delete().eq("client_id", clientId);
  await serviceClient.from("campaign_deliverables").delete().eq("client_id", clientId);
  if (runIds.length > 0) await serviceClient.from("runs").delete().in("id", runIds);
  if (campaignIds.length > 0) await serviceClient.from("campaigns").delete().in("id", campaignIds);
  await serviceClient.from("clients").delete().eq("id", clientId);
}

async function main(): Promise<void> {
  const health = await fetch(`${OS_API_URL}/api/health`);
  check("os-api health endpoint responds", health.ok);

  const seededA = await seedTenant(CLIENT_A_ID);
  const seededB = await seedTenant(CLIENT_B_ID);
  const tokenA = await mintClientJwt(CLIENT_A_ID);

  try {
    const missingComment = await requestJson(
      `/api/escalations/${seededA.shot1.escalationId}/comment`,
      undefined,
      { text: "shot note", scope: "shot" },
    );
    check("comment endpoint returns 401 when JWT missing", missingComment.status === 401);

    const missingAccept = await requestJson(
      `/api/escalations/${seededA.shot1.escalationId}/accept`,
      undefined,
      {},
    );
    check("accept endpoint returns 401 when JWT missing", missingAccept.status === 401);

    const crossComment = await requestJson(
      `/api/escalations/${seededB.shot1.escalationId}/comment`,
      tokenA,
      { text: "cross tenant note", scope: "shot" },
    );
    check("comment endpoint returns 403 for cross-tenant escalation", crossComment.status === 403);

    const crossAccept = await requestJson(
      `/api/escalations/${seededB.shot1.escalationId}/accept`,
      tokenA,
      {},
    );
    check("accept endpoint returns 403 for cross-tenant escalation", crossAccept.status === 403);

    const shotText = "tighten this exact shot around the documentary-dry direction";
    const shotComment = await requestJson(
      `/api/escalations/${seededA.shot1.escalationId}/comment`,
      tokenA,
      { text: shotText, scope: "shot" },
    );
    check("shot-scoped comment returns 200", shotComment.status === 200);
    check("shot-scoped comment returns a new regen run id", typeof shotComment.body.newRunId === "string");
    check("shot-scoped comment targets only shot 1", JSON.stringify(shotComment.body.targetShotIds) === JSON.stringify([1]));
    check("shot-scoped comment emits a regen-from-comment event name", String(shotComment.body.eventName).startsWith("regen-from-comment:"));

    const shotRun = await expectSingle<{ metadata: Record<string, unknown> }>(
      await serviceClient.from("runs").select("metadata").eq("id", seededA.shot1.runId).single(),
      "[verify] shot source run metadata",
    );
    const shotOverride = ((shotRun.metadata.operator_override as Record<string, unknown>).shot_1 as Record<string, unknown>);
    check("shot-scoped comment writes operator_override.shot_1.direction_comment", shotOverride.direction_comment === shotText);

    const newRunId = shotComment.body.newRunId as string;
    const regenRun = await expectSingle<{ metadata: Record<string, unknown>; mode: string; status: string }>(
      await serviceClient.from("runs").select("metadata, mode, status").eq("id", newRunId).single(),
      "[verify] shot regen run",
    );
    check("shot-scoped comment creates pending stills regen run", regenRun.mode === "stills" && regenRun.status === "pending");
    check("shot-scoped regen run persists shot_ids=[1]", JSON.stringify(regenRun.metadata.shot_ids) === JSON.stringify([1]));

    const campaignText = "new campaign-wide mantra: grounded human aftermath, no hero-mech framing";
    const campaignComment = await requestJson(
      `/api/escalations/${seededA.shot2.escalationId}/comment`,
      tokenA,
      { text: campaignText, scope: "campaign" },
    );
    check("campaign-scoped comment returns 200", campaignComment.status === 200);
    check("campaign-scoped comment targets below-threshold shots", (campaignComment.body.targetShotIds as unknown[]).length >= 2);

    const campaignRow = await expectSingle<{ guardrails: Record<string, unknown> }>(
      await serviceClient.from("campaigns").select("guardrails").eq("id", seededA.shot1.campaignId).single(),
      "[verify] campaign guardrails",
    );
    const mvc = campaignRow.guardrails.music_video_context as Record<string, unknown>;
    const directionalHistory = campaignRow.guardrails.directional_history as Record<string, unknown>;
    check("campaign comment updates music_video_context.direction_mantra", mvc.direction_mantra === campaignText);
    check("campaign comment updates directional_history.current_direction_mantra", directionalHistory.current_direction_mantra === campaignText);
    check("campaign comment moves prior mantra into abandoned_directions", Array.isArray(mvc.abandoned_directions) && mvc.abandoned_directions.length === 1);

    const campaignSourceRun = await expectSingle<{ metadata: Record<string, unknown> }>(
      await serviceClient.from("runs").select("metadata").eq("id", seededA.shot2.runId).single(),
      "[verify] campaign source run metadata",
    );
    const campaignOverride = ((campaignSourceRun.metadata.operator_override as Record<string, unknown>).campaign as Record<string, unknown>);
    check("campaign comment writes operator_override.campaign.direction_pivot", Boolean(campaignOverride.direction_pivot));

    const accept = await requestJson(
      `/api/escalations/${seededA.shot1.escalationId}/accept`,
      tokenA,
      {},
    );
    check("accept endpoint returns 200", accept.status === 200);

    const acceptedEscalation = await expectSingle<{
      status: string;
      resolution_path: string | null;
      final_artifact_id: string | null;
    }>(
      await serviceClient
        .from("asset_escalations")
        .select("status, resolution_path, final_artifact_id")
        .eq("id", seededA.shot1.escalationId)
        .single(),
      "[verify] accepted escalation",
    );
    check("accept writes status=resolved + resolution_path=accept", acceptedEscalation.status === "resolved" && acceptedEscalation.resolution_path === "accept");
    check("accept locks final artifact id", acceptedEscalation.final_artifact_id === seededA.shot1.artifactId);

    console.log(`\n${assertions}/${assertions} — Phase 4 Review Gate card endpoint contract verified`);
  } finally {
    await cleanup(CLIENT_A_ID);
    await cleanup(CLIENT_B_ID);
  }
}

main().catch(async (err) => {
  console.error(err);
  await cleanup(CLIENT_A_ID).catch(() => undefined);
  await cleanup(CLIENT_B_ID).catch(() => undefined);
  process.exit(1);
});
