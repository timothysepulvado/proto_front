// Full-sweep tenant/contract audit harness (REPORT-ONLY).
//
// This is intentionally NOT wired into test:merge-gate yet because this audit
// is finding/proving gaps, not fixing them. Existing known-good gates run
// active assertions below; newly found gaps are listed as GAP-skipped with a
// stable finding id so Brandy can unskip each block after implementing fixes.
//
// Required env for active checks:
//   OS_API_URL=http://localhost:3301 JWT_AUTH_ENABLED=true \
//   REVIEW_GATE_COMMENT_REGEN_EXECUTION=false tsx tests/_fullsweep-tenant-contract.ts

import { mintClientJwt } from "../src/auth.js";
import { supabase as serviceClient } from "../src/supabase.js";

const OS_API_URL = process.env.OS_API_URL ?? "http://localhost:3001";
const SUFFIX = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const CLIENT_A_ID = `fullsweep_a_${SUFFIX}`;
const CLIENT_B_ID = `fullsweep_b_${SUFFIX}`;

interface SeededTenant {
  clientId: string;
  campaignId: string;
  runId: string;
  deliverableId: string;
  artifactId: string;
  escalationId: string;
}

let assertions = 0;
let skipped = 0;

function check(label: string, condition: unknown): void {
  assertions += 1;
  if (!condition) throw new Error(`Assertion ${assertions} failed: ${label}`);
  console.log(`✓ ${assertions}. ${label}`);
}

function skipGap(ref: string, label: string): void {
  skipped += 1;
  console.log(`↷ GAP-SKIP ${ref}: ${label}`);
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

async function requestGet(
  path: string,
  token: string | undefined,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(`${OS_API_URL}${path}`, { method: "GET", headers });
  let parsed: unknown = null;
  try {
    parsed = await resp.json();
  } catch {
    // Binary/SSE/empty bodies are not JSON.
  }
  return { status: resp.status, body: parsed };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function seedTenant(clientId: string): Promise<SeededTenant> {
  await expectMutation(
    await serviceClient.from("clients").insert({
      id: clientId,
      name: `Full Sweep ${clientId}`,
      status: "active",
      brand_slug: clientId,
      ui_config: { display_name: `Full Sweep ${clientId}`, featured: false },
    }),
    `[seed ${clientId}] client`,
  );

  const campaign = await expectSingle<{ id: string }>(
    await serviceClient
      .from("campaigns")
      .insert({
        client_id: clientId,
        name: `Full Sweep Campaign ${clientId}`,
        prompt: "full-sweep contract campaign",
        deliverables: [],
        platforms: [],
        status: "draft",
        guardrails: {
          qa_threshold: { pass_threshold: 3.0, accept_threshold: 2.5 },
          music_video_context: {
            title: "Full Sweep MV",
            synopsis: "Contract test synopsis.",
            reference_tone: "Contract test tone.",
            total_shots: 1,
            track_duration_s: 8,
            shot_list_summary: [
              { shot_number: 1, beat_name: "intro", visual_intent_summary: "shot one" },
            ],
            ingested_at: new Date().toISOString(),
            manifest_sha256: "full-sweep-contract-test",
            direction_mantra: "grounded direction",
            abandoned_directions: [],
          },
          directional_history: {
            current_direction_mantra: "grounded direction",
            abandoned_directions: [],
          },
        },
      })
      .select("id")
      .single(),
    `[seed ${clientId}] campaign`,
  );

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
    `[seed ${clientId}] run`,
  );

  const deliverable = await expectSingle<{ id: string }>(
    await serviceClient
      .from("campaign_deliverables")
      .insert({
        client_id: clientId,
        campaign_id: campaign.id,
        description: "Shot 1 full-sweep deliverable",
        status: "pending",
        retry_count: 0,
        current_prompt: "shot 1",
        original_prompt: "shot 1",
      })
      .select("id")
      .single(),
    `[seed ${clientId}] deliverable`,
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
        name: `full_sweep_${clientId}.png`,
        path: `/tmp/full_sweep_${clientId}.png`,
        metadata: { iter: 1 },
      })
      .select("id")
      .single(),
    `[seed ${clientId}] artifact`,
  );

  await expectMutation(
    await serviceClient.from("run_logs").insert({
      client_id: clientId,
      run_id: run.id,
      stage: "grade",
      level: "info",
      message: "[in_loop] shot 1 iter 1: FAIL score=2.10 → direction_reversion",
    }),
    `[seed ${clientId}] run log`,
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
    `[seed ${clientId}] escalation`,
  );

  await expectMutation(
    await serviceClient.from("cost_ledger_entries").insert({
      client_id: clientId,
      run_id: run.id,
      deliverable_id: deliverable.id,
      artifact_id: artifact.id,
      escalation_id: escalation.id,
      event_type: "fullsweep_contract",
      source: "harness",
      cost_usd: 0.0123,
      metadata: { harness: "fullsweep" },
      rate_card_version: "test",
    }),
    `[seed ${clientId}] cost ledger`,
  );

  return {
    clientId,
    campaignId: campaign.id,
    runId: run.id,
    deliverableId: deliverable.id,
    artifactId: artifact.id,
    escalationId: escalation.id,
  };
}

async function cleanup(clientId: string): Promise<void> {
  const { data: runs } = await serviceClient.from("runs").select("id").eq("client_id", clientId);
  const runIds = (runs ?? []).map((row: { id: string }) => row.id);
  const { data: campaigns } = await serviceClient.from("campaigns").select("id").eq("client_id", clientId);
  const campaignIds = (campaigns ?? []).map((row: { id: string }) => row.id);

  await serviceClient.from("cost_ledger_entries").delete().eq("client_id", clientId);
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

  // Phase 2 (fullsweep fix branch): A1-A3,A5-A9,A12-A16 + MINOR known-
  // limitations are now gated and UN-SKIPPED into the active no-auth (401) /
  // cross-tenant (404) / own-tenant (200) contract below. The only A-findings
  // still GAP-skipped are the ones whose fix lands in a later phase:
  //   A4  → Phase 3 (SSE auth via ?access_token=)
  //   A10 → Phase 4 (drift-route reconcile — schema-broken)
  //   A11 → Phase 4 (drift-route reconcile — schema-broken)
  skipGap("A4", "GET /api/runs/:runId/logs streams run_logs no-auth — Phase 3 SSE-auth");
  skipGap("A10", "GET /api/runs/:runId/drift-alerts ungated + schema-broken — Phase 4 drift reconcile");
  skipGap("A11", "GET /api/runs/:runId/drift-metrics ungated + schema-broken — Phase 4 drift reconcile");

  // GAP: B1-B4 — frontend/backend contract skips. These are static source
  // checks to unskip after the source callers/routes are fixed.
  skipGap("B1", "ShotDetailDrawer fetches gated /api/runs/:runId/escalation-report without auth headers");
  skipGap("B2", "WatcherSignalsPanel uses EventSource /api/runs/:runId/logs; native EventSource cannot send Authorization");
  skipGap("B3", "PromptEvolutionPanel/src/api.ts reference prompt_* tables absent from live DB");
  skipGap("B4", "Drift run routes expect run_id/artifact_id/fused_z columns absent from live drift tables");

  const seededA = await seedTenant(CLIENT_A_ID);
  const seededB = await seedTenant(CLIENT_B_ID);
  const tokenA = await mintClientJwt(CLIENT_A_ID);

  try {
    const activeNoAuthRoutes: Array<[string, string]> = [
      ["run-detail", `/api/runs/${seededA.runId}/detail`],
      ["run-cost-ledger", `/api/runs/${seededA.runId}/cost-ledger`],
      ["client-cost-summary", `/api/clients/${seededA.clientId}/cost-summary`],
      ["iterations", `/api/deliverables/${seededA.deliverableId}/iterations`],
      ["signed-url", `/api/artifacts/${seededA.artifactId}/signed-url`],
      ["motion-phase-gate", `/api/campaigns/${seededA.campaignId}/motion-phase-gate`],
      ["direction-drift", `/api/campaigns/${seededA.campaignId}/direction-drift`],
      ["shot-summaries", `/api/campaigns/${seededA.campaignId}/shot-summaries`],
      ["escalations-list", "/api/escalations"],
      ["escalation-detail", `/api/escalations/${seededA.escalationId}`],
      ["artifact-escalation", `/api/artifacts/${seededA.artifactId}/escalation`],
      ["campaign-escalations", `/api/campaigns/${seededA.campaignId}/escalations`],
      ["run-escalation-report", `/api/runs/${seededA.runId}/escalation-report`],
      ["orchestrator-decisions", `/api/orchestrator/decisions/${seededA.escalationId}`],
      // Phase 2 fullsweep — newly gated per-tenant GET surfaces (A1-A3,A5-A9,
      // A12-A16) + MINOR shared catalog. All return 401 when JWT missing.
      ["A1 clients-list", "/api/clients"],
      ["A2 client-detail", `/api/clients/${seededA.clientId}`],
      ["A3 run", `/api/runs/${seededA.runId}`],
      ["A5 run-review", `/api/runs/${seededA.runId}/review`],
      ["A6 run-artifacts", `/api/runs/${seededA.runId}/artifacts`],
      ["A7 artifact-file", `/api/artifacts/${seededA.artifactId}/file`],
      ["A8 artifact-platforms", `/api/artifacts/${seededA.artifactId}/platforms`],
      ["A9 client-drift-alerts", `/api/clients/${seededA.clientId}/drift-alerts`],
      ["A12 client-campaigns", `/api/clients/${seededA.clientId}/campaigns`],
      ["A13 campaign-detail", `/api/campaigns/${seededA.campaignId}`],
      ["A14 campaign-recent-runs", `/api/campaigns/${seededA.campaignId}/recent-runs`],
      ["A15 campaign-deliverables", `/api/campaigns/${seededA.campaignId}/deliverables`],
      ["A16 deliverable-detail", `/api/deliverables/${seededA.deliverableId}`],
      ["MINOR known-limitations", "/api/known-limitations"],
    ];
    for (const [label, path] of activeNoAuthRoutes) {
      const resp = await requestGet(path, undefined);
      check(`${label} returns 401 when JWT missing`, resp.status === 401);
    }

    const crossExpectations: Array<[string, string, number]> = [
      ["run-detail", `/api/runs/${seededB.runId}/detail`, 404],
      ["run-cost-ledger", `/api/runs/${seededB.runId}/cost-ledger`, 403],
      ["client-cost-summary", `/api/clients/${seededB.clientId}/cost-summary`, 403],
      ["iterations", `/api/deliverables/${seededB.deliverableId}/iterations`, 404],
      ["signed-url", `/api/artifacts/${seededB.artifactId}/signed-url`, 403],
      ["motion-phase-gate", `/api/campaigns/${seededB.campaignId}/motion-phase-gate`, 404],
      ["direction-drift", `/api/campaigns/${seededB.campaignId}/direction-drift`, 404],
      ["shot-summaries", `/api/campaigns/${seededB.campaignId}/shot-summaries`, 404],
      ["escalation-detail", `/api/escalations/${seededB.escalationId}`, 404],
      ["artifact-escalation", `/api/artifacts/${seededB.artifactId}/escalation`, 404],
      ["run-escalation-report", `/api/runs/${seededB.runId}/escalation-report`, 404],
      ["orchestrator-decisions", `/api/orchestrator/decisions/${seededB.escalationId}`, 404],
      // Phase 2 fullsweep — cross-tenant probe (caller A, resource B) → uniform
      // 404 (no existence leak) for every newly gated single/aggregate route.
      ["A2 client-detail", `/api/clients/${seededB.clientId}`, 404],
      ["A3 run", `/api/runs/${seededB.runId}`, 404],
      ["A5 run-review", `/api/runs/${seededB.runId}/review`, 404],
      ["A6 run-artifacts", `/api/runs/${seededB.runId}/artifacts`, 404],
      ["A7 artifact-file", `/api/artifacts/${seededB.artifactId}/file`, 404],
      ["A8 artifact-platforms", `/api/artifacts/${seededB.artifactId}/platforms`, 404],
      ["A9 client-drift-alerts", `/api/clients/${seededB.clientId}/drift-alerts`, 404],
      ["A12 client-campaigns", `/api/clients/${seededB.clientId}/campaigns`, 404],
      ["A13 campaign-detail", `/api/campaigns/${seededB.campaignId}`, 404],
      ["A14 campaign-recent-runs", `/api/campaigns/${seededB.campaignId}/recent-runs`, 404],
      ["A15 campaign-deliverables", `/api/campaigns/${seededB.campaignId}/deliverables`, 404],
      ["A16 deliverable-detail", `/api/deliverables/${seededB.deliverableId}`, 404],
    ];
    for (const [label, path, expected] of crossExpectations) {
      const resp = await requestGet(path, tokenA);
      check(`${label} returns ${expected} cross-tenant`, resp.status === expected);
    }

    const escalationsCross = await requestGet(`/api/escalations?clientId=${seededB.clientId}`, tokenA);
    check(
      "escalations list ignores foreign clientId filter under JWT and leaks no B rows",
      escalationsCross.status === 200 &&
        Array.isArray(escalationsCross.body) &&
        !escalationsCross.body.some((row) => isObject(row) && row.id === seededB.escalationId),
    );

    const campaignEscCross = await requestGet(`/api/campaigns/${seededB.campaignId}/escalations`, tokenA);
    check(
      "campaign-escalations returns 200 + empty cross-tenant",
      campaignEscCross.status === 200 &&
        Array.isArray(campaignEscCross.body) &&
        campaignEscCross.body.length === 0,
    );

    const runDetail = await requestGet(`/api/runs/${seededA.runId}/detail`, tokenA);
    check("run-detail own-tenant returns 200", runDetail.status === 200);
    check(
      "run-detail shape matches frontend contract",
      isObject(runDetail.body) &&
        isObject(runDetail.body.run) &&
        Array.isArray(runDetail.body.logs) &&
        Array.isArray(runDetail.body.artifacts) &&
        typeof runDetail.body.orchestrationDecisionCount === "number" &&
        typeof runDetail.body.totalOrchestrationCost === "number",
    );

    const costLedger = await requestGet(`/api/runs/${seededA.runId}/cost-ledger`, tokenA);
    check("cost-ledger own-tenant returns 200", costLedger.status === 200);
    check(
      "cost-ledger shape matches frontend contract",
      isObject(costLedger.body) &&
        costLedger.body.runId === seededA.runId &&
        typeof costLedger.body.totalUsd === "number" &&
        typeof costLedger.body.entryCount === "number" &&
        isObject(costLedger.body.breakdown) &&
        Array.isArray(costLedger.body.entries),
    );

    const costSummary = await requestGet(`/api/clients/${seededA.clientId}/cost-summary`, tokenA);
    check("cost-summary own-tenant returns 200", costSummary.status === 200);
    check(
      "cost-summary shape has client/month/total/breakdown",
      isObject(costSummary.body) &&
        costSummary.body.clientId === seededA.clientId &&
        typeof costSummary.body.month === "string" &&
        typeof costSummary.body.totalUsd === "number" &&
        Array.isArray(costSummary.body.breakdown),
    );

    const iterations = await requestGet(`/api/deliverables/${seededA.deliverableId}/iterations`, tokenA);
    check("iterations own-tenant returns 200", iterations.status === 200);
    check(
      "iterations shape matches frontend contract",
      isObject(iterations.body) &&
        iterations.body.deliverableId === seededA.deliverableId &&
        Array.isArray(iterations.body.rows) &&
        typeof iterations.body.generatedAt === "string",
    );

    const motion = await requestGet(`/api/campaigns/${seededA.campaignId}/motion-phase-gate`, tokenA);
    check("motion-phase-gate own-tenant returns 200", motion.status === 200);
    check("motion-phase-gate shape has campaignId + shotsOfNote", isObject(motion.body) && motion.body.campaignId === seededA.campaignId && Array.isArray(motion.body.shotsOfNote));

    const direction = await requestGet(`/api/campaigns/${seededA.campaignId}/direction-drift`, tokenA);
    check("direction-drift own-tenant returns 200 object map", direction.status === 200 && isObject(direction.body));

    const summaries = await requestGet(`/api/campaigns/${seededA.campaignId}/shot-summaries`, tokenA);
    check("shot-summaries own-tenant returns 200 array", summaries.status === 200 && Array.isArray(summaries.body));
    check(
      "shot-summaries row shape matches frontend contract",
      Array.isArray(summaries.body) &&
        summaries.body.some((row) =>
          isObject(row) &&
          row.deliverableId === seededA.deliverableId &&
          "shotNumber" in row &&
          "cumulativeCost" in row &&
          "orchestratorCallCount" in row
        ),
    );

    const escalationDetail = await requestGet(`/api/escalations/${seededA.escalationId}`, tokenA);
    check("escalation detail own-tenant returns 200 + decisions array", escalationDetail.status === 200 && isObject(escalationDetail.body) && Array.isArray(escalationDetail.body.decisions));

    const artifactEscalation = await requestGet(`/api/artifacts/${seededA.artifactId}/escalation`, tokenA);
    check("artifact escalation own-tenant returns 200", artifactEscalation.status === 200 && isObject(artifactEscalation.body));

    const campaignEscalations = await requestGet(`/api/campaigns/${seededA.campaignId}/escalations`, tokenA);
    check("campaign escalations own-tenant returns own row", campaignEscalations.status === 200 && Array.isArray(campaignEscalations.body) && campaignEscalations.body.some((row) => isObject(row) && row.id === seededA.escalationId));

    const report = await requestGet(`/api/runs/${seededA.runId}/escalation-report`, tokenA);
    check("run escalation report own-tenant returns 200 + deliverables", report.status === 200 && isObject(report.body) && Array.isArray(report.body.deliverables));

    const decisions = await requestGet(`/api/orchestrator/decisions/${seededA.escalationId}`, tokenA);
    check("orchestrator decisions own-tenant returns 200 array", decisions.status === 200 && Array.isArray(decisions.body));

    // ===== Phase 2 fullsweep — own-tenant (caller A, resource A) → 200 =====
    // A1 is forced-scope: caller A sees ONLY its own client, never B's row
    // (no-leak contract identical to the escalations-list assertion).
    const clientsList = await requestGet("/api/clients", tokenA);
    check(
      "A1 clients-list own-tenant returns 200 scoped to caller (no B leak)",
      clientsList.status === 200 &&
        Array.isArray(clientsList.body) &&
        clientsList.body.some((row) => isObject(row) && row.id === seededA.clientId) &&
        !clientsList.body.some((row) => isObject(row) && row.id === seededB.clientId),
    );

    const clientDetail = await requestGet(`/api/clients/${seededA.clientId}`, tokenA);
    check(
      "A2 client-detail own-tenant returns 200 with id + runs",
      clientDetail.status === 200 &&
        isObject(clientDetail.body) &&
        clientDetail.body.id === seededA.clientId &&
        Array.isArray(clientDetail.body.runs),
    );

    const runDetailA3 = await requestGet(`/api/runs/${seededA.runId}`, tokenA);
    check(
      "A3 run own-tenant returns 200 with matching runId",
      runDetailA3.status === 200 &&
        isObject(runDetailA3.body) &&
        runDetailA3.body.runId === seededA.runId,
    );

    const runReview = await requestGet(`/api/runs/${seededA.runId}/review`, tokenA);
    check(
      "A5 run-review own-tenant returns 200 with artifacts + decisions arrays",
      runReview.status === 200 &&
        isObject(runReview.body) &&
        runReview.body.runId === seededA.runId &&
        Array.isArray(runReview.body.artifacts) &&
        Array.isArray(runReview.body.decisions),
    );

    const runArtifacts = await requestGet(`/api/runs/${seededA.runId}/artifacts`, tokenA);
    check(
      "A6 run-artifacts own-tenant returns 200 array incl. seeded artifact",
      runArtifacts.status === 200 &&
        Array.isArray(runArtifacts.body) &&
        runArtifacts.body.some((row) => isObject(row) && row.id === seededA.artifactId),
    );

    const clientDriftAlerts = await requestGet(`/api/clients/${seededA.clientId}/drift-alerts`, tokenA);
    check(
      "A9 client-drift-alerts own-tenant returns 200 array",
      clientDriftAlerts.status === 200 && Array.isArray(clientDriftAlerts.body),
    );

    const clientCampaigns = await requestGet(`/api/clients/${seededA.clientId}/campaigns`, tokenA);
    check(
      "A12 client-campaigns own-tenant returns 200 array incl. seeded campaign",
      clientCampaigns.status === 200 &&
        Array.isArray(clientCampaigns.body) &&
        clientCampaigns.body.some((row) => isObject(row) && row.id === seededA.campaignId),
    );

    const campaignDetail = await requestGet(`/api/campaigns/${seededA.campaignId}`, tokenA);
    check(
      "A13 campaign-detail own-tenant returns 200 with deliverablesList",
      campaignDetail.status === 200 &&
        isObject(campaignDetail.body) &&
        campaignDetail.body.id === seededA.campaignId &&
        Array.isArray(campaignDetail.body.deliverablesList),
    );

    const campaignRecentRuns = await requestGet(`/api/campaigns/${seededA.campaignId}/recent-runs`, tokenA);
    check(
      "A14 campaign-recent-runs own-tenant returns 200 array",
      campaignRecentRuns.status === 200 && Array.isArray(campaignRecentRuns.body),
    );

    const campaignDeliverables = await requestGet(`/api/campaigns/${seededA.campaignId}/deliverables`, tokenA);
    check(
      "A15 campaign-deliverables own-tenant returns 200 array incl. seeded deliverable",
      campaignDeliverables.status === 200 &&
        Array.isArray(campaignDeliverables.body) &&
        campaignDeliverables.body.some((row) => isObject(row) && row.id === seededA.deliverableId),
    );

    const deliverableDetail = await requestGet(`/api/deliverables/${seededA.deliverableId}`, tokenA);
    check(
      "A16 deliverable-detail own-tenant returns 200 with matching id",
      deliverableDetail.status === 200 &&
        isObject(deliverableDetail.body) &&
        deliverableDetail.body.id === seededA.deliverableId,
    );

    // A7/A8 own-tenant intentionally NOT asserted at 200: the seeded artifact
    // has no on-disk file (A7) and no cloudinaryPublicId (A8), so a 200 is not
    // reachable from a DB-only seed. The no-auth-401 + cross-tenant-404
    // assertions above fully prove the tenant gate for both.

    const knownLimits = await requestGet("/api/known-limitations", tokenA);
    check(
      "MINOR known-limitations own-tenant (shared catalog) returns 200",
      knownLimits.status === 200,
    );

    console.log(`\n${assertions}/${assertions} active assertions passed; ${skipped} GAP-skipped findings remain`);
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
