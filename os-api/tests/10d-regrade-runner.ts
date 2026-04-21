/**
 * Gate test for 10d Session A: regrade runner path.
 *
 * Unit-level only — no Supabase, no brand-engine, no network. Verifies the
 * pure helpers that drive regrade decisions + the stage definition wiring.
 *
 * What it covers:
 *   - `_shouldSkipDeliverable` — idempotency predicate (only `approved` skips)
 *   - `_decideRegradeStatusTransition` — outcome × liveStatus → transition
 *   - STAGE_DEFINITIONS.regrade — shape + id
 *   - Type-level: "regrade" is a valid RunMode (this file compiles == proof)
 *
 * Not covered here (exercised live by Shot 20 smoke test):
 *   - Supabase reads/writes inside executeRegradeStage
 *   - runVideoQAWithEscalation integration
 *   - SSE log event emission
 *
 * Run via (stubbed env — the runner module imports db.js which needs Supabase
 * vars to initialize, even though we never hit the network):
 *   SUPABASE_URL=http://stub SUPABASE_KEY=stub \
 *     npx tsx os-api/tests/10d-regrade-runner.ts
 *
 * Expected: ALL CHECKS PASSED.
 */
import assert from "node:assert/strict";

import {
  _shouldSkipDeliverable,
  _decideRegradeStatusTransition,
} from "../src/runner.js";
import {
  STAGE_DEFINITIONS,
  type CampaignDeliverable,
  type RunMode,
} from "../src/types.js";

type Check = { name: string; run: () => void };
const checks: Check[] = [];
function check(name: string, run: () => void): void {
  checks.push({ name, run });
}

// ─── Fixture helper ─────────────────────────────────────────────────────

function mkDeliverable(
  status: CampaignDeliverable["status"],
  overrides: Partial<CampaignDeliverable> = {},
): CampaignDeliverable {
  return {
    id: "del-1",
    campaignId: "camp-1",
    status,
    retryCount: 0,
    createdAt: "2026-04-20T00:00:00Z",
    updatedAt: "2026-04-20T00:00:00Z",
    mediaType: "video",
    durationSeconds: 8,
    ...overrides,
  };
}

// ─── 1. _shouldSkipDeliverable ──────────────────────────────────────────

check("_shouldSkipDeliverable skips approved", () => {
  assert.equal(_shouldSkipDeliverable(mkDeliverable("approved")), true);
});
check("_shouldSkipDeliverable does NOT skip pending", () => {
  assert.equal(_shouldSkipDeliverable(mkDeliverable("pending")), false);
});
check("_shouldSkipDeliverable does NOT skip reviewing", () => {
  assert.equal(_shouldSkipDeliverable(mkDeliverable("reviewing")), false);
});
check("_shouldSkipDeliverable does NOT skip generating", () => {
  assert.equal(_shouldSkipDeliverable(mkDeliverable("generating")), false);
});
check("_shouldSkipDeliverable does NOT skip rejected (will re-grade)", () => {
  assert.equal(_shouldSkipDeliverable(mkDeliverable("rejected")), false);
});
check("_shouldSkipDeliverable does NOT skip regenerating", () => {
  assert.equal(_shouldSkipDeliverable(mkDeliverable("regenerating")), false);
});

// ─── 2. _decideRegradeStatusTransition ──────────────────────────────────

check("decideRegradeStatusTransition: resolved @ reviewing → approved", () => {
  const t = _decideRegradeStatusTransition("resolved", "reviewing");
  assert.ok(t);
  assert.equal(t.from, "reviewing");
  assert.equal(t.to, "approved");
  assert.equal(t.reason, undefined);
});

check("decideRegradeStatusTransition: failed @ reviewing → rejected + reason", () => {
  const t = _decideRegradeStatusTransition("failed", "reviewing");
  assert.ok(t);
  assert.equal(t.from, "reviewing");
  assert.equal(t.to, "rejected");
  assert.equal(typeof t.reason, "string");
  assert.ok((t.reason ?? "").length > 0);
});

check("decideRegradeStatusTransition: hitl_required @ reviewing → no transition", () => {
  const t = _decideRegradeStatusTransition("hitl_required", "reviewing");
  assert.equal(t, null);
});

check("decideRegradeStatusTransition: off-path liveStatus = null (defensive)", () => {
  // If the status walk failed earlier, we don't attempt a risky transition.
  // Every non-reviewing liveStatus returns null.
  const statuses: CampaignDeliverable["status"][] = [
    "pending", "generating", "approved", "rejected", "regenerating",
  ];
  for (const s of statuses) {
    assert.equal(
      _decideRegradeStatusTransition("resolved", s), null,
      `resolved @ ${s} should be null`,
    );
    assert.equal(
      _decideRegradeStatusTransition("failed", s), null,
      `failed @ ${s} should be null`,
    );
    assert.equal(
      _decideRegradeStatusTransition("hitl_required", s), null,
      `hitl_required @ ${s} should be null`,
    );
  }
});

// ─── 3. STAGE_DEFINITIONS.regrade wiring ────────────────────────────────

check("STAGE_DEFINITIONS['regrade'] is defined", () => {
  assert.ok(STAGE_DEFINITIONS.regrade);
});

check("STAGE_DEFINITIONS['regrade'] has single stage id='regrade'", () => {
  const stages = STAGE_DEFINITIONS.regrade;
  assert.equal(stages.length, 1, "regrade mode runs a single stage");
  assert.equal(stages[0].id, "regrade");
  assert.ok(typeof stages[0].name === "string" && stages[0].name.length > 0);
});

check("STAGE_DEFINITIONS preserves other modes (no accidental overwrite)", () => {
  assert.ok(STAGE_DEFINITIONS.full, "full mode still defined");
  assert.ok(STAGE_DEFINITIONS.ingest, "ingest mode still defined");
  assert.ok(STAGE_DEFINITIONS.video, "video mode still defined");
  assert.equal(STAGE_DEFINITIONS.full.length, 6, "full mode keeps 6 stages");
});

// ─── 4. Type-level: "regrade" is a valid RunMode ────────────────────────

check("RunMode union includes 'regrade' (compile-time)", () => {
  const m: RunMode = "regrade";
  assert.equal(m, "regrade");
});

// ─── Harness ────────────────────────────────────────────────────────────

function run(): void {
  let pass = 0;
  let fail = 0;
  const failures: Array<{ name: string; err: unknown }> = [];
  for (const c of checks) {
    try {
      c.run();
      pass += 1;
      console.log(`  ✓ ${c.name}`);
    } catch (err) {
      fail += 1;
      failures.push({ name: c.name, err });
      console.log(`  ✗ ${c.name}`);
      console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log("");
  console.log(`10d regrade runner gate — ${pass} pass, ${fail} fail, ${checks.length} total`);
  if (fail > 0) {
    console.log("");
    console.log("Failures:");
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.err instanceof Error ? f.err.message : String(f.err)}`);
    }
    process.exit(1);
  }
}

run();
