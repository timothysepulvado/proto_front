// ADR-006 D4-9 — Reject-as-Teach concurrency repro (PR #8 Karl review BLOCK #1).
//
// PRE-REQUISITE: os-api running with JWT_AUTH_ENABLED=true AND migration 023
// applied (reject_review_gate_escalation_atomic lock-then-validate-then-write).
//
// The blind-write migration 022 RPC let two concurrent POST .../reject calls
// on the same open escalation BOTH insert a rejection_learning_events row
// (distinct server-generated event ids → no PK collision); the later UPDATE
// won and overwrote learning_event_id, orphaning the first learning row. The
// existing _phase4-reject-teach.ts harness is blind to this (it never fires
// concurrent rejects). This repro is the targeted proof:
//
//   Pre-023  → both rejects 200, TWO learning rows, one orphaned  → FAILS
//   Post-023 → exactly one 200 + one 409, ONE learning row, no
//              orphan, escalation.learning_event_id points at it   → PASSES
//
// Karl's exact repro spec: "create a disposable open escalation, fire two
// parallel POST /api/escalations/:id/reject calls with different payloads,
// then compare learning rows vs final asset_escalations.learning_event_id."

import { mintClientJwt } from "../src/auth.js";
import { supabase as serviceClient } from "../src/supabase.js";

const OS_API_URL = process.env.OS_API_URL ?? "http://localhost:3001";
const SUFFIX = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const CLIENT_ID = `phase4_race_${SUFFIX}`;

interface RequestResult {
  status: number;
  body: Record<string, unknown>;
}

let assertions = 0;

function check(label: string, condition: unknown): void {
  assertions += 1;
  if (!condition) throw new Error(`Assertion ${assertions} failed: ${label}`);
  console.log(`✓ ${assertions}. ${label}`);
}

async function expectSingle<T>(
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
    parsed = (await resp.json()) as Record<string, unknown>;
  } catch {
    // leave empty
  }
  return { status: resp.status, body: parsed };
}

async function seedOpenEscalation(): Promise<{ escalationId: string }> {
  await expectMutation(
    await serviceClient.from("clients").insert({
      id: CLIENT_ID,
      name: `Phase 4 Reject Race ${CLIENT_ID}`,
      status: "active",
      brand_slug: CLIENT_ID,
      ui_config: {},
    }),
    `[seed ${CLIENT_ID}] client`,
  );

  const campaign = await expectSingle<{ id: string }>(
    await serviceClient
      .from("campaigns")
      .insert({
        client_id: CLIENT_ID,
        name: `Phase 4 Reject Race Campaign ${CLIENT_ID}`,
        prompt: "reject-as-teach concurrency repro campaign",
        deliverables: [],
        platforms: [],
        status: "draft",
        guardrails: {
          qa_threshold: { pass_threshold: 3.0 },
          music_video_context: {
            title: "Reject-as-Teach Race Repro MV",
            total_shots: 1,
            shot_list_summary: [
              { shot_number: 1, beat_name: "intro", visual_intent_summary: "shot one" },
            ],
          },
        },
      })
      .select("id")
      .single(),
    `[seed ${CLIENT_ID}] campaign`,
  );

  const run = await expectSingle<{ id: string }>(
    await serviceClient
      .from("runs")
      .insert({
        client_id: CLIENT_ID,
        campaign_id: campaign.id,
        mode: "stills",
        status: "needs_review",
        stages: [],
        hitl_required: true,
        metadata: {},
      })
      .select("id")
      .single(),
    `[seed ${CLIENT_ID}] run`,
  );

  const deliverable = await expectSingle<{ id: string }>(
    await serviceClient
      .from("campaign_deliverables")
      .insert({
        client_id: CLIENT_ID,
        campaign_id: campaign.id,
        description: "Shot 1 reject-race deliverable",
        status: "pending",
        retry_count: 0,
        current_prompt: "shot 1",
        original_prompt: "shot 1",
      })
      .select("id")
      .single(),
    `[seed ${CLIENT_ID}] deliverable`,
  );

  const artifact = await expectSingle<{ id: string }>(
    await serviceClient
      .from("artifacts")
      .insert({
        client_id: CLIENT_ID,
        campaign_id: campaign.id,
        run_id: run.id,
        deliverable_id: deliverable.id,
        type: "image",
        name: "shot_1_race_iter_1.png",
        path: `/tmp/phase4_race_${CLIENT_ID}_1.png`,
        metadata: { iter: 1 },
      })
      .select("id")
      .single(),
    `[seed ${CLIENT_ID}] artifact`,
  );

  const escalation = await expectSingle<{ id: string }>(
    await serviceClient
      .from("asset_escalations")
      .insert({
        client_id: CLIENT_ID,
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
    `[seed ${CLIENT_ID}] escalation`,
  );

  return { escalationId: escalation.id };
}

async function cleanup(): Promise<void> {
  const { data: runs } = await serviceClient.from("runs").select("id").eq("client_id", CLIENT_ID);
  const runIds = (runs ?? []).map((row: { id: string }) => row.id);
  const { data: campaigns } = await serviceClient
    .from("campaigns")
    .select("id")
    .eq("client_id", CLIENT_ID);
  const campaignIds = (campaigns ?? []).map((row: { id: string }) => row.id);

  await serviceClient.from("asset_escalations").delete().eq("client_id", CLIENT_ID);
  await serviceClient.from("rejection_learning_events").delete().eq("client_id", CLIENT_ID);
  await serviceClient.from("artifacts").delete().eq("client_id", CLIENT_ID);
  await serviceClient.from("campaign_deliverables").delete().eq("client_id", CLIENT_ID);
  if (runIds.length > 0) await serviceClient.from("run_logs").delete().in("run_id", runIds);
  if (runIds.length > 0) await serviceClient.from("runs").delete().in("id", runIds);
  if (campaignIds.length > 0) await serviceClient.from("campaigns").delete().in("id", campaignIds);
  await serviceClient.from("clients").delete().eq("id", CLIENT_ID);
}

async function main(): Promise<void> {
  const health = await fetch(`${OS_API_URL}/api/health`);
  check("os-api health endpoint responds", health.ok);

  const { escalationId } = await seedOpenEscalation();
  const token = await mintClientJwt(CLIENT_ID);

  try {
    const categoriesResp = await requestJson("GET", "/api/rejection-categories", token);
    const categories = (categoriesResp.body.categories ?? []) as Array<{ id: string }>;
    check("rejection-categories returns a non-empty taxonomy", categories.length > 0);
    const categoryId = categories[0].id;

    // Two DIFFERENT payloads on the SAME open escalation, fired in parallel.
    // The server mints a distinct event id (uuidv4) per request, so pre-023
    // there is no PK collision to save us — both inserts land.
    const rejectA = requestJson("POST", `/api/escalations/${escalationId}/reject`, token, {
      category_id: categoryId,
      what_wrong: "RACE A — reintroduced the banned hero mech silhouette in the foreground.",
      correction: "RACE A — keep the frame grounded in human aftermath; remove hero-mech framing.",
      block_mode: "soft",
    });
    const rejectB = requestJson("POST", `/api/escalations/${escalationId}/reject`, token, {
      category_id: categoryId,
      what_wrong: "RACE B — palette drifted toward heroic saturation against the documentary mantra.",
      correction: "RACE B — pull the grade documentary-dry and desaturate the key light.",
      block_mode: "terminal",
    });
    const [resA, resB] = await Promise.all([rejectA, rejectB]);

    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    const okCount = statuses.filter((s) => s === 200).length;
    const conflictCount = statuses.filter((s) => s === 409).length;

    check(
      `exactly one parallel reject wins with 200 (got statuses ${JSON.stringify([resA.status, resB.status])})`,
      okCount === 1,
    );
    check(
      `the race loser gets 409 Conflict, not a 500 or a second 200 (statuses ${JSON.stringify([resA.status, resB.status])})`,
      conflictCount === 1,
    );

    // DB invariant — the actual corruption check.
    const { data: learningRows, error: learningErr } = await serviceClient
      .from("rejection_learning_events")
      .select("id")
      .eq("client_id", CLIENT_ID);
    if (learningErr) throw new Error(`learning-row read: ${learningErr.message}`);
    check(
      `exactly ONE rejection_learning_events row exists — no orphan, no double-insert (found ${learningRows?.length ?? 0})`,
      (learningRows?.length ?? 0) === 1,
    );
    const onlyLearningId = (learningRows ?? [])[0]?.id as string | undefined;

    const escalationRow = await expectSingle<{
      status: string;
      learning_event_id: string | null;
    }>(
      await serviceClient
        .from("asset_escalations")
        .select("status, learning_event_id")
        .eq("id", escalationId)
        .single(),
      "final escalation read",
    );

    check(
      "escalation.learning_event_id is non-null after the race",
      typeof escalationRow.learning_event_id === "string" && escalationRow.learning_event_id.length > 0,
    );
    check(
      "escalation.learning_event_id points at the one surviving learning row (no orphan/overwrite)",
      escalationRow.learning_event_id === onlyLearningId,
    );
    check(
      `escalation transitioned to a terminal reject status (got "${escalationRow.status}")`,
      escalationRow.status === "rejected_soft" || escalationRow.status === "rejected_terminal",
    );

    console.log(`\n✅ reject-race repro: ${assertions}/${assertions} — migration 023 race guard verified`);
  } finally {
    await cleanup();
  }
}

main().catch(async (err) => {
  console.error(`\n❌ reject-race repro FAILED: ${err instanceof Error ? err.message : String(err)}`);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
