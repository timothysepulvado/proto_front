/**
 * Unit test for Path C (2026-04-23) — per-production QA threshold knob.
 *
 * Background: plan `fresh-context-today-is-glowing-harp.md` Phase 2A adds an
 * opt-in `campaigns.guardrails.qa_threshold` field that lets the escalation
 * loop short-circuit borderline non-blocking QA scores to a rule-based L3
 * accept decision without calling Claude. This keeps the orchestrator prompt
 * byte-identical (Chunk 1 lock) while cutting cost + HITL volume on
 * productions where the strict critic rubric penalizes intentional
 * stylization.
 *
 * This test exercises the two exported helpers:
 *   - `_extractQAThreshold(campaign)` — reads the JSONB guardrail, validates
 *     shape, disables on malformed/inverted values.
 *   - `_maybeBorderlineAccept(verdict, threshold, catalog)` — evaluates
 *     whether the verdict should short-circuit.
 *
 * Five primary scenarios (plan Phase 2A §Tests):
 *   1. Score above pass → no short-circuit (Claude path / no-op).
 *   2. Score borderline, no blocking failure class → short-circuit fires.
 *   3. Score borderline, WITH blocking failure class → no short-circuit.
 *   4. Score below accept → no short-circuit (Claude decides L1/L2/L3).
 *   5. Threshold missing on campaign → no short-circuit (feature opt-in).
 *
 * Plus guardrail tests for threshold shape validation.
 *
 * Usage:
 *   (set -a; . os-api/.env; set +a; npx tsx os-api/tests/_10d-qa-threshold.ts)
 */
import assert from "node:assert/strict";

import {
  _extractQAThreshold,
  _maybeBorderlineAccept,
} from "../src/escalation_loop.js";
import type {
  Campaign,
  KnownLimitation,
  VideoGradeResult,
} from "../src/types.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeCampaign(guardrails: Record<string, unknown> | undefined): Campaign {
  return {
    id: "camp-X",
    clientId: "client-X",
    name: "Test Campaign",
    maxRetries: 3,
    guardrails,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeVerdict(
  aggregate_score: number,
  detected: string[] = [],
): VideoGradeResult {
  return {
    verdict:
      aggregate_score >= 4.0 ? "PASS" : aggregate_score >= 3.0 ? "WARN" : "FAIL",
    aggregate_score,
    criteria: [],
    detected_failure_classes: detected,
    confidence: 0.85,
    summary: "test",
    reasoning: "test",
    recommendation:
      aggregate_score >= 4.0 ? "ship" : aggregate_score >= 3.0 ? "L1_prompt_fix" : "L3_escalation",
    model: "gemini-3.1-pro-preview",
    cost: 0.01,
    latency_ms: 500,
  };
}

function makeLimitation(
  failureMode: string,
  severity: "warning" | "blocking",
): KnownLimitation {
  return {
    id: `lim-${failureMode}`,
    model: "veo-3.1-generate-001",
    category: "test",
    failureMode,
    description: "test",
    severity,
    timesEncountered: 1,
    lastEncounteredAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const CATALOG: KnownLimitation[] = [
  makeLimitation("atmospheric_creep_fire_smoke_aerial", "blocking"),
  makeLimitation("subtle_vfx_absorption", "warning"),
  makeLimitation("backlight_color_homogenization", "warning"),
];

const DRIFT_MV_THRESHOLD = { pass_threshold: 3.0, accept_threshold: 2.5 };
const GUARDRAILS_DRIFT_MV = { qa_threshold: DRIFT_MV_THRESHOLD };

// ── Checks ───────────────────────────────────────────────────────────────

type Check = { name: string; run: () => void | Promise<void> };
const checks: Check[] = [];
function check(name: string, run: () => void | Promise<void>): void {
  checks.push({ name, run });
}

// ─── _extractQAThreshold shape validation ────────────────────────────────

check("extractQAThreshold: valid threshold round-trips", () => {
  const t = _extractQAThreshold(makeCampaign(GUARDRAILS_DRIFT_MV));
  assert.deepEqual(t, DRIFT_MV_THRESHOLD);
});

check("extractQAThreshold: null campaign → undefined", () => {
  assert.equal(_extractQAThreshold(null), undefined);
});

check("extractQAThreshold: missing guardrails → undefined", () => {
  assert.equal(_extractQAThreshold(makeCampaign(undefined)), undefined);
});

check("extractQAThreshold: missing qa_threshold field → undefined", () => {
  assert.equal(
    _extractQAThreshold(makeCampaign({ music_video_context: {} })),
    undefined,
  );
});

check("extractQAThreshold: malformed (string instead of number) → undefined", () => {
  const t = _extractQAThreshold(
    makeCampaign({
      qa_threshold: { pass_threshold: "3.0", accept_threshold: 2.5 },
    }),
  );
  assert.equal(t, undefined, "string pass_threshold should disable feature");
});

check("extractQAThreshold: inverted (accept >= pass) → undefined", () => {
  // Degenerate band — disable rather than surface confusing behavior.
  const t = _extractQAThreshold(
    makeCampaign({
      qa_threshold: { pass_threshold: 3.0, accept_threshold: 3.5 },
    }),
  );
  assert.equal(t, undefined, "inverted band should disable feature");
});

check("extractQAThreshold: equal (accept === pass) → undefined", () => {
  const t = _extractQAThreshold(
    makeCampaign({
      qa_threshold: { pass_threshold: 3.0, accept_threshold: 3.0 },
    }),
  );
  assert.equal(t, undefined, "empty band should disable feature");
});

check("extractQAThreshold: non-finite values → undefined", () => {
  const t = _extractQAThreshold(
    makeCampaign({
      qa_threshold: { pass_threshold: 3.0, accept_threshold: Number.NaN },
    }),
  );
  assert.equal(t, undefined);
});

// ─── _maybeBorderlineAccept — 5 primary scenarios ────────────────────────

check("Scenario 1: score 3.2 (above pass), no blocking → null (no short-circuit)", () => {
  // Score >= pass_threshold — critic already said PASS. Short-circuit
  // shouldn't trigger because escalation loop shouldn't be running at all.
  const result = _maybeBorderlineAccept(makeVerdict(3.2), DRIFT_MV_THRESHOLD, CATALOG);
  assert.equal(result, null);
});

check("Scenario 2: score 2.7 (borderline), no blocking → short-circuit fires", () => {
  const result = _maybeBorderlineAccept(
    makeVerdict(2.7, ["subtle_vfx_absorption"]),
    DRIFT_MV_THRESHOLD,
    CATALOG,
  );
  assert.ok(result, "borderline-no-blocking must short-circuit");
  assert.equal(result!.score, 2.7);
  assert.equal(result!.failureClass, "subtle_vfx_absorption");
  assert.deepEqual(result!.detectedClasses, ["subtle_vfx_absorption"]);
});

check("Scenario 3: score 2.7 (borderline), WITH blocking → null", () => {
  // Blocking failure classes always fall through to Claude even at
  // borderline scores — these are unrecoverable via prompt-engineering.
  const result = _maybeBorderlineAccept(
    makeVerdict(2.7, ["atmospheric_creep_fire_smoke_aerial"]),
    DRIFT_MV_THRESHOLD,
    CATALOG,
  );
  assert.equal(result, null, "blocking class must disable short-circuit");
});

check("Scenario 4: score 2.2 (below accept), no blocking → null", () => {
  const result = _maybeBorderlineAccept(makeVerdict(2.2), DRIFT_MV_THRESHOLD, CATALOG);
  assert.equal(result, null, "below accept → Claude path");
});

check("Scenario 5: threshold missing (undefined) → null", () => {
  const result = _maybeBorderlineAccept(makeVerdict(2.7), undefined, CATALOG);
  assert.equal(result, null);
});

// ─── Boundary conditions ─────────────────────────────────────────────────

check("Boundary: score === accept_threshold (inclusive lower bound) → fires", () => {
  const result = _maybeBorderlineAccept(makeVerdict(2.5), DRIFT_MV_THRESHOLD, CATALOG);
  assert.ok(result);
  assert.equal(result!.score, 2.5);
});

check("Boundary: score === pass_threshold (exclusive upper bound) → null", () => {
  const result = _maybeBorderlineAccept(makeVerdict(3.0), DRIFT_MV_THRESHOLD, CATALOG);
  assert.equal(result, null);
});

check("Boundary: score just under pass → fires", () => {
  const result = _maybeBorderlineAccept(makeVerdict(2.99), DRIFT_MV_THRESHOLD, CATALOG);
  assert.ok(result);
  assert.equal(result!.score, 2.99);
});

check("Boundary: score just under accept → null", () => {
  const result = _maybeBorderlineAccept(makeVerdict(2.49), DRIFT_MV_THRESHOLD, CATALOG);
  assert.equal(result, null);
});

// ─── Non-blocking failure class semantics ────────────────────────────────

check("Multiple non-blocking classes still short-circuit (all warnings)", () => {
  const result = _maybeBorderlineAccept(
    makeVerdict(2.7, ["subtle_vfx_absorption", "backlight_color_homogenization"]),
    DRIFT_MV_THRESHOLD,
    CATALOG,
  );
  assert.ok(result);
  assert.deepEqual(result!.detectedClasses, [
    "subtle_vfx_absorption",
    "backlight_color_homogenization",
  ]);
  assert.equal(result!.failureClass, "subtle_vfx_absorption", "first detected class surfaces");
});

check("Mixed blocking+warning → null (blocking wins)", () => {
  const result = _maybeBorderlineAccept(
    makeVerdict(2.7, ["subtle_vfx_absorption", "atmospheric_creep_fire_smoke_aerial"]),
    DRIFT_MV_THRESHOLD,
    CATALOG,
  );
  assert.equal(result, null, "any blocking class in the set disables short-circuit");
});

check("Unknown failure class (not in catalog) treated as warning (non-blocking)", () => {
  // When a detected class isn't in the catalog, we can't confirm severity.
  // Default to allowing short-circuit — the critic scored it borderline, so
  // it's at worst a warning-tier issue. The new_candidate_limitation path
  // (Claude-decided) is how unknowns get triaged when they DO fall through.
  const result = _maybeBorderlineAccept(
    makeVerdict(2.7, ["unknown_new_failure_mode"]),
    DRIFT_MV_THRESHOLD,
    CATALOG,
  );
  assert.ok(result, "unknown class should not block short-circuit");
});

// ─── Non-numeric / malformed verdict guards ──────────────────────────────

check("Non-numeric aggregate_score → null", () => {
  const bad = { aggregate_score: "2.7", detected_failure_classes: [] };
  const result = _maybeBorderlineAccept(bad, DRIFT_MV_THRESHOLD, CATALOG);
  assert.equal(result, null);
});

check("Missing aggregate_score → null", () => {
  const bad = { detected_failure_classes: [] };
  const result = _maybeBorderlineAccept(bad, DRIFT_MV_THRESHOLD, CATALOG);
  assert.equal(result, null);
});

// ─── Reporting ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let pass = 0;
  let fail = 0;
  const failures: { name: string; err: unknown }[] = [];
  for (const c of checks) {
    try {
      await c.run();
      console.log(`  ✓ ${c.name}`);
      pass += 1;
    } catch (err) {
      console.error(`  ✗ ${c.name}`);
      failures.push({ name: c.name, err });
      fail += 1;
    }
  }
  console.log("");
  console.log(`  ${pass}/${pass + fail} passed`);
  if (fail > 0) {
    console.error("");
    for (const f of failures) {
      console.error(`  FAIL: ${f.name}`);
      console.error(
        `    ${f.err instanceof Error ? f.err.stack : String(f.err)}`,
      );
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
