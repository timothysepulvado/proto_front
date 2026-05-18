// Asset-integrity merge-gate harness (Jackie P0 RCA 2026-05-17).
//
// Guards the two confirmed image/video-mismatch root causes so the class can
// never regress invisibly (the PR #8 "make-it-not-harness-invisible" lesson):
//
//   S6 — getArtifactsForDeliverableWithVerdicts had no run_id filter, so
//        GET /api/deliverables/:id/iterations mixed artifacts across every run
//        that ever touched the deliverable → the HUD rendered another run's
//        creative. Fix: optional run scope threaded route→db.
//   S4 — DeliverableTracker had no Realtime subscription on `artifacts`, so a
//        regen INSERT fired no event and the tracker kept the stale
//        latestArtifactId. Fix: campaign-scoped artifacts channel that
//        re-fetches shot-summaries.
//
// SCOPE NOTE: a node merge-gate cannot drive a React Realtime client, so the
// S4 *subscription wiring* itself is verified by Karl's independent diff
// review + code. This harness proves the BACKEND DATA-TRUTH ORACLE that the
// subscription re-fetches against: shot-summaries?run_id=R returns the correct
// latest artifact for run R. If that oracle is correct AND the subscription
// fires (review-verified), the displayed asset is correct.
//
// Required env:
//   OS_API_URL=http://localhost:3001 JWT_AUTH_ENABLED=true \
//   REVIEW_GATE_COMMENT_REGEN_EXECUTION=false tsx tests/_asset-integrity.ts

import { mintClientJwt } from "../src/auth.js";
import { supabase as serviceClient } from "../src/supabase.js";

const OS_API_URL = process.env.OS_API_URL ?? "http://localhost:3001";
const SUFFIX = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const CLIENT_ID = `assetint_${SUFFIX}`;

let assertions = 0;

function check(label: string, condition: unknown): void {
  assertions += 1;
  if (!condition) throw new Error(`Assertion ${assertions} failed: ${label}`);
  console.log(`✓ ${assertions}. ${label}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function must<T>(
  result: { data: T | null; error: { message: string } | null },
  label: string,
): Promise<T> {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (!result.data) throw new Error(`${label}: no data returned`);
  return result.data;
}

async function expectMutation(
  result: { error: { message: string } | null },
  label: string,
): Promise<void> {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
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
    // non-JSON body
  }
  return { status: resp.status, body: parsed };
}

interface Seed {
  campaignId: string;
  deliverableId: string;
  runAId: string;
  runBId: string;
  artifactAId: string;
  artifactBId: string;
}

async function seedRun(
  campaignId: string,
  deliverableId: string,
  createdAtIso: string,
): Promise<{ runId: string; artifactId: string }> {
  const run = await must<{ id: string }>(
    await serviceClient
      .from("runs")
      .insert({
        client_id: CLIENT_ID,
        campaign_id: campaignId,
        mode: "stills",
        status: "needs_review",
        stages: [],
        hitl_required: true,
        metadata: {},
      })
      .select("id")
      .single(),
    "[seed] run",
  );

  const artifact = await must<{ id: string }>(
    await serviceClient
      .from("artifacts")
      .insert({
        client_id: CLIENT_ID,
        campaign_id: campaignId,
        run_id: run.id,
        deliverable_id: deliverableId,
        type: "image",
        name: `assetint_${run.id}.png`,
        path: `/tmp/assetint_${run.id}.png`,
        metadata: { iter: 1 },
        created_at: createdAtIso,
      })
      .select("id")
      .single(),
    "[seed] artifact",
  );

  await expectMutation(
    await serviceClient.from("asset_escalations").insert({
      client_id: CLIENT_ID,
      artifact_id: artifact.id,
      deliverable_id: deliverableId,
      run_id: run.id,
      current_level: "L2",
      status: "hitl_required",
      iteration_count: 1,
      failure_class: "direction_reversion",
    }),
    "[seed] escalation",
  );

  return { runId: run.id, artifactId: artifact.id };
}

async function seed(): Promise<Seed> {
  await expectMutation(
    await serviceClient.from("clients").insert({
      id: CLIENT_ID,
      name: `Asset Integrity ${CLIENT_ID}`,
      status: "active",
      brand_slug: CLIENT_ID,
      ui_config: { display_name: `Asset Integrity ${CLIENT_ID}`, featured: false },
    }),
    "[seed] client",
  );

  const campaign = await must<{ id: string }>(
    await serviceClient
      .from("campaigns")
      .insert({
        client_id: CLIENT_ID,
        name: `Asset Integrity Campaign`,
        prompt: "asset integrity campaign",
        deliverables: [],
        platforms: [],
        status: "draft",
        guardrails: {},
      })
      .select("id")
      .single(),
    "[seed] campaign",
  );

  const deliverable = await must<{ id: string }>(
    await serviceClient
      .from("campaign_deliverables")
      .insert({
        client_id: CLIENT_ID,
        campaign_id: campaign.id,
        description: "Shot 1 asset-integrity deliverable",
        status: "pending",
        retry_count: 0,
        current_prompt: "shot 1",
        original_prompt: "shot 1",
      })
      .select("id")
      .single(),
    "[seed] deliverable",
  );

  // Run A older, Run B newer — same deliverable. B is the "current" creative;
  // the S6 bug surfaced as A's artifact bleeding into B's iteration view.
  const older = new Date(Date.now() - 120_000).toISOString();
  const newer = new Date().toISOString();
  const a = await seedRun(campaign.id, deliverable.id, older);
  const b = await seedRun(campaign.id, deliverable.id, newer);

  return {
    campaignId: campaign.id,
    deliverableId: deliverable.id,
    runAId: a.runId,
    runBId: b.runId,
    artifactAId: a.artifactId,
    artifactBId: b.artifactId,
  };
}

async function cleanup(): Promise<void> {
  const { data: runs } = await serviceClient.from("runs").select("id").eq("client_id", CLIENT_ID);
  const runIds = (runs ?? []).map((r: { id: string }) => r.id);
  await serviceClient.from("asset_escalations").delete().eq("client_id", CLIENT_ID);
  await serviceClient.from("artifacts").delete().eq("client_id", CLIENT_ID);
  if (runIds.length > 0) await serviceClient.from("run_logs").delete().in("run_id", runIds);
  await serviceClient.from("campaign_deliverables").delete().eq("client_id", CLIENT_ID);
  if (runIds.length > 0) await serviceClient.from("runs").delete().in("id", runIds);
  await serviceClient.from("campaigns").delete().eq("client_id", CLIENT_ID);
  await serviceClient.from("clients").delete().eq("id", CLIENT_ID);
}

function iterationArtifactIds(body: unknown): string[] {
  if (!isObject(body) || !Array.isArray(body.rows)) return [];
  const ids: string[] = [];
  for (const row of body.rows) {
    if (isObject(row) && isObject(row.artifact) && typeof row.artifact.id === "string") {
      ids.push(row.artifact.id);
    }
  }
  return ids;
}

function iterationRunIds(body: unknown): string[] {
  if (!isObject(body) || !Array.isArray(body.rows)) return [];
  return body.rows
    .filter(isObject)
    .map((row) => row.runId)
    .filter((v): v is string => typeof v === "string");
}

async function main(): Promise<void> {
  const health = await fetch(`${OS_API_URL}/api/health`);
  check("os-api health endpoint responds", health.ok);

  const s = await seed();
  const token = await mintClientJwt(CLIENT_ID);

  try {
    // ── S6: run-scoped iterations must NOT bleed across runs ──────────────
    const iterB = await requestGet(
      `/api/deliverables/${s.deliverableId}/iterations?run_id=${s.runBId}`,
      token,
    );
    check("S6: iterations?run_id=B returns 200", iterB.status === 200);
    const idsB = iterationArtifactIds(iterB.body);
    check(
      "S6: iterations?run_id=B contains ONLY run B's artifact (no cross-run bleed)",
      idsB.length > 0 && idsB.every((id) => id === s.artifactBId) && !idsB.includes(s.artifactAId),
    );
    check(
      "S6: every iterations?run_id=B row is scoped to run B",
      iterationRunIds(iterB.body).every((rid) => rid === s.runBId),
    );

    const iterA = await requestGet(
      `/api/deliverables/${s.deliverableId}/iterations?run_id=${s.runAId}`,
      token,
    );
    const idsA = iterationArtifactIds(iterA.body);
    check(
      "S6: iterations?run_id=A returns ONLY run A's artifact (symmetric scoping)",
      iterA.status === 200 &&
        idsA.length > 0 &&
        idsA.every((id) => id === s.artifactAId) &&
        !idsA.includes(s.artifactBId),
    );

    // ── S6: back-compat — no run_id keeps full history (internal callers) ──
    const iterAll = await requestGet(`/api/deliverables/${s.deliverableId}/iterations`, token);
    const idsAll = iterationArtifactIds(iterAll.body);
    check(
      "S6: iterations without run_id preserves full cross-run history (back-compat)",
      iterAll.status === 200 && idsAll.includes(s.artifactAId) && idsAll.includes(s.artifactBId),
    );

    // ── S6: fail-closed — malformed run_id never silently widens ─────────
    const iterBad = await requestGet(
      `/api/deliverables/${s.deliverableId}/iterations?run_id=not-a-uuid`,
      token,
    );
    check("S6: malformed run_id returns 400 (fail closed)", iterBad.status === 400);

    // ── S4 oracle: shot-summaries?run_id=R returns R's latest artifact ────
    const sumB = await requestGet(
      `/api/campaigns/${s.campaignId}/shot-summaries?run_id=${s.runBId}`,
      token,
    );
    check("S4 oracle: shot-summaries?run_id=B returns 200 array", sumB.status === 200 && Array.isArray(sumB.body));
    const rowB =
      Array.isArray(sumB.body) &&
      sumB.body.find((r) => isObject(r) && r.deliverableId === s.deliverableId);
    check(
      "S4 oracle: shot-summaries?run_id=B latestArtifactId === run B artifact",
      isObject(rowB) && rowB.latestArtifactId === s.artifactBId,
    );

    const sumA = await requestGet(
      `/api/campaigns/${s.campaignId}/shot-summaries?run_id=${s.runAId}`,
      token,
    );
    const rowA =
      Array.isArray(sumA.body) &&
      sumA.body.find((r) => isObject(r) && r.deliverableId === s.deliverableId);
    check(
      "S4 oracle: shot-summaries?run_id=A latestArtifactId === run A artifact (symmetric)",
      sumA.status === 200 && isObject(rowA) && rowA.latestArtifactId === s.artifactAId,
    );

    console.log(`\n${assertions}/${assertions} asset-integrity assertions passed (S6 + S4 oracle)`);
  } finally {
    await cleanup();
  }
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
