/**
 * Gate test for Chunk 2: shot-level observability (HUD MVP).
 *
 * Asserts the shape + semantics of `getShotSummaries(campaignId, runId?)` —
 * the DB-layer query that drives `GET /api/campaigns/:campaignId/shot-summaries`
 * and the HUD DeliverableTracker. Prereqs (Chunk 1 / Session A):
 *   - campaign 42f62a1d-… exists with `guardrails.music_video_context` + 30
 *     deliverables + 30 video artifacts with `metadata.narrative_context`.
 *   - If this probe runs BEFORE Chunk 1's ingester, it'll fail on the
 *     narrative_context assertion — which is the correct signal.
 *
 * Usage:
 *   (set -a; . os-api/.env; set +a; npx tsx os-api/tests/_10d-shot-summaries.ts)
 *
 * Exits non-zero on any assertion failure. All checks run so a single failure
 * doesn't mask downstream issues.
 */
import assert from "node:assert/strict";

import { getShotSummaries } from "../src/db.js";
import type { BeatName, ShotSummary } from "../src/types.js";

const CAMPAIGN_ID = "42f62a1d-b9df-57d8-8197-470692733391";

const VALID_BEATS = new Set<BeatName>([
  "intro",
  "hook_1",
  "verse_1",
  "hook_2",
  "verse_2",
  "bridge",
  "hook_3",
  "final_hook",
  "outro",
]);

type Check = { name: string; run: () => void | Promise<void> };
const checks: Check[] = [];
function check(name: string, run: () => void | Promise<void>): void {
  checks.push({ name, run });
}

let summaries: ShotSummary[] = [];
let summariesByRunId: ShotSummary[] = [];

async function preload(): Promise<void> {
  summaries = await getShotSummaries(CAMPAIGN_ID);
  // Use any real run_id on this campaign if one exists — Session A Shot 20
  // smoke (2bce7bc9-…) is the canonical one. If it doesn't exist on this
  // machine, per-run test block is skipped (see check).
  summariesByRunId = await getShotSummaries(
    CAMPAIGN_ID,
    "2bce7bc9-6dbf-47a3-a4fc-754ccd2e73c8",
  );
}

// ─── Row count ────────────────────────────────────────────────────────────

check("returns one row per deliverable on Drift MV (expected 30)", () => {
  // Drift MV catalog is 30 shots. If this fails, Chunk 1 ingestion or the
  // Session A catalog seed is incomplete.
  assert.equal(summaries.length, 30, `expected 30 shot summaries, got ${summaries.length}`);
});

check("returns same row count with runId filter (per-run narrowing is additive, not exclusive)", () => {
  // `getShotSummaries` always returns one row PER DELIVERABLE regardless of
  // runId — the runId filter narrows the _contents_ (artifacts / escalations /
  // decisions) counted for each row, not which deliverables appear. This
  // guarantees the DeliverableTracker UI never loses a card mid-run.
  assert.equal(
    summariesByRunId.length,
    summaries.length,
    "runId filter should not drop deliverable rows",
  );
});

// ─── Shape ────────────────────────────────────────────────────────────────

check("every row has a string deliverableId", () => {
  for (const s of summaries) {
    assert.ok(s.deliverableId, "deliverableId missing");
    assert.equal(typeof s.deliverableId, "string");
  }
});

check("every row has a valid DeliverableStatus", () => {
  const valid = new Set([
    "pending",
    "generating",
    "reviewing",
    "approved",
    "rejected",
    "regenerating",
  ]);
  for (const s of summaries) {
    assert.ok(valid.has(s.status), `unexpected status "${s.status}" on ${s.deliverableId}`);
  }
});

check("every row has numeric retryCount / cumulativeCost / orchestratorCallCount / artifactCount", () => {
  for (const s of summaries) {
    assert.equal(typeof s.retryCount, "number", "retryCount not numeric");
    assert.equal(typeof s.cumulativeCost, "number", "cumulativeCost not numeric");
    assert.equal(typeof s.orchestratorCallCount, "number", "orchestratorCallCount not numeric");
    assert.equal(typeof s.artifactCount, "number", "artifactCount not numeric");
    assert.ok(s.cumulativeCost >= 0, "cumulativeCost must be >= 0");
    assert.ok(s.orchestratorCallCount >= 0, "orchestratorCallCount must be >= 0");
    assert.ok(s.artifactCount >= 0, "artifactCount must be >= 0");
  }
});

// ─── Narrative envelope join ──────────────────────────────────────────────

check("at least 30 rows have a numeric shotNumber (post-Chunk 1 ingest)", () => {
  const withShot = summaries.filter((s) => typeof s.shotNumber === "number");
  assert.ok(
    withShot.length >= 30,
    `expected >=30 rows with narrative_context.shot_number, got ${withShot.length} — did Chunk 1 ingester run?`,
  );
});

check("shot numbers span 1..30 (exactly, no duplicates, no gaps)", () => {
  const nums = summaries
    .map((s) => s.shotNumber)
    .filter((n): n is number => typeof n === "number");
  const unique = new Set(nums);
  const expected = new Set<number>();
  for (let i = 1; i <= 30; i += 1) expected.add(i);
  for (const n of expected) {
    assert.ok(unique.has(n), `missing shot number ${n}`);
  }
  // Ensure no extras outside 1..30
  for (const n of unique) {
    assert.ok(n >= 1 && n <= 30, `shot number out of range: ${n}`);
  }
});

check("every row with a shotNumber also has a valid beatName", () => {
  for (const s of summaries) {
    if (typeof s.shotNumber === "number") {
      assert.ok(
        s.beatName && VALID_BEATS.has(s.beatName),
        `shot ${s.shotNumber} has invalid beatName: ${s.beatName}`,
      );
    }
  }
});

// ─── Sorting ──────────────────────────────────────────────────────────────

check("rows sorted ascending by shotNumber (nulls last)", () => {
  let seenNull = false;
  let lastNum = 0;
  for (const s of summaries) {
    if (s.shotNumber === null) {
      seenNull = true;
      continue;
    }
    assert.ok(!seenNull, "non-null shotNumber after a null row — sort order broken");
    assert.ok(s.shotNumber >= lastNum, `out-of-order shot: ${lastNum} → ${s.shotNumber}`);
    lastNum = s.shotNumber;
  }
});

// ─── Escalation / decision join semantics ─────────────────────────────────

check("escalationLevel is null or L1/L2/L3", () => {
  const valid = new Set([null, "L1", "L2", "L3"]);
  for (const s of summaries) {
    assert.ok(valid.has(s.escalationLevel), `invalid escalationLevel: ${s.escalationLevel}`);
  }
});

check("escalationStatus is null or one of the 6 EscalationStatus values", () => {
  const valid = new Set([
    null,
    "in_progress",
    "resolved",
    "accepted",
    "redesigned",
    "replaced",
    "hitl_required",
  ]);
  for (const s of summaries) {
    assert.ok(valid.has(s.escalationStatus), `invalid escalationStatus: ${s.escalationStatus}`);
  }
});

check("latestEscalationId present iff escalationLevel present", () => {
  for (const s of summaries) {
    if (s.escalationLevel === null) {
      assert.equal(s.latestEscalationId, null, "latestEscalationId should be null when level is null");
    } else {
      assert.ok(s.latestEscalationId, "latestEscalationId missing despite escalationLevel present");
    }
  }
});

check("lastVerdict is null or PASS/WARN/FAIL", () => {
  const valid = new Set([null, "PASS", "WARN", "FAIL"]);
  for (const s of summaries) {
    assert.ok(valid.has(s.lastVerdict), `invalid lastVerdict: ${s.lastVerdict}`);
  }
});

check("lastScore present iff lastVerdict present (both come from same qa_verdict)", () => {
  for (const s of summaries) {
    if (s.lastVerdict === null) {
      assert.equal(s.lastScore, null, "lastScore should be null when lastVerdict is null");
    } else {
      assert.equal(typeof s.lastScore, "number", "lastScore should be numeric when lastVerdict is set");
    }
  }
});

check("orchestratorCallCount == 0 implies cumulativeCost == 0", () => {
  for (const s of summaries) {
    if (s.orchestratorCallCount === 0) {
      assert.equal(s.cumulativeCost, 0, `cost without calls on ${s.deliverableId}`);
    }
  }
});

// ─── Per-run filter narrows, not excludes ─────────────────────────────────

check("per-run summary has orchestratorCallCount + cumulativeCost <= all-time", () => {
  // runId filter should narrow counts/sums — never exceed the all-time totals.
  const allTimeByDel = new Map(summaries.map((s) => [s.deliverableId, s]));
  for (const perRun of summariesByRunId) {
    const allTime = allTimeByDel.get(perRun.deliverableId);
    assert.ok(allTime, `perRun row references unknown deliverable ${perRun.deliverableId}`);
    assert.ok(
      perRun.orchestratorCallCount <= allTime.orchestratorCallCount,
      `per-run orchestratorCallCount exceeds all-time for ${perRun.deliverableId}`,
    );
    assert.ok(
      perRun.cumulativeCost <= allTime.cumulativeCost + 1e-9,
      `per-run cumulativeCost exceeds all-time for ${perRun.deliverableId}`,
    );
    assert.ok(
      perRun.artifactCount <= allTime.artifactCount,
      `per-run artifactCount exceeds all-time for ${perRun.deliverableId}`,
    );
  }
});

// ─── Run ──────────────────────────────────────────────────────────────────

(async () => {
  try {
    await preload();
  } catch (err) {
    console.error("=== PRELOAD FAILED ===");
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(2);
  }

  let passed = 0;
  let failed = 0;
  for (const c of checks) {
    try {
      await c.run();
      console.log(`  ✓ ${c.name}`);
      passed += 1;
    } catch (err) {
      failed += 1;
      console.log(`  ✗ ${c.name}`);
      if (err instanceof Error) {
        console.log(`      ${err.message}`);
      } else {
        console.log(`      ${String(err)}`);
      }
    }
  }

  console.log("");
  if (failed === 0) {
    console.log(`=== ${passed}/${checks.length} PASSED ===`);
    console.log(`=== ASSERTIONS PASSED ===`);
    process.exit(0);
  } else {
    console.log(`=== ${passed}/${checks.length} PASSED, ${failed} FAILED ===`);
    process.exit(1);
  }
})();
