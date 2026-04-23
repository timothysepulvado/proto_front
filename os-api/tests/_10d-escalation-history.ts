/**
 * Unit test for bug #3 (2026-04-23) — cross-artifact escalation history.
 *
 * Background: `escalation_loop.ts:113` creates a new `asset_escalations` row
 * on every regen artifact because `getEscalationByArtifact(artifact.id)`
 * returns null for a fresh artifact. Before the fix, the orchestrator's Rule 2
 * self-detection (`consecSameRegens`, `cumulativeCost`, `levelsUsed`) queried
 * by `escalation_id` → the new empty escalation reset those signals to zero
 * on every iteration, and `_maybePromoteLevel` saw `iteration_count=0` on a
 * fresh row → never promoted, even after L3 redesign × 2.
 *
 * The fix (Phase 1 of plan `fresh-context-today-is-glowing-harp.md`):
 *   1. `db.ts::getOrchestrationDecisionsForDeliverableInRun` aggregates
 *      orchestration_decisions across ALL escalation rows on the same
 *      (deliverable, run) pair.
 *   2. `db.ts::getLatestOpenEscalationForDeliverableInRun` returns the most
 *      recent `status='in_progress'` escalation for inheritance.
 *   3. `escalation_loop.ts` inherits `currentLevel` + `iterationCount` from
 *      the predecessor when creating a new escalation for a regen artifact.
 *   4. `escalation_loop.ts` calls the aggregated helper instead of the
 *      per-escalation one when assembling orchestrator input.
 *
 * This test exercises the three exported helpers (`_sumCost`, `_collectLevels`,
 * `_countConsecutiveSamePromptRegens`) against hand-crafted decision arrays
 * representing the "pre-fix broken" vs "post-fix aggregated" shapes, asserting
 * that:
 *   - _sumCost aggregates total across multi-escalation decisions
 *   - _collectLevels preserves level ordering across escalation boundaries
 *   - _countConsecutiveSamePromptRegens detects repeated prompts across the
 *     boundary (the signal the orchestrator uses to flag stuck loops)
 *
 * Runs as a pure in-memory test — no Supabase or network. Live DB verification
 * happens in Phase 4A smoke regrade.
 *
 * Usage:
 *   npx tsx os-api/tests/_10d-escalation-history.ts
 */
import assert from "node:assert/strict";

import {
  _sumCost,
  _collectLevels,
  _countConsecutiveSamePromptRegens,
} from "../src/escalation_loop.js";
import type {
  OrchestrationDecisionRecord,
  EscalationLevel,
} from "../src/types.js";

// ── Test fixture helpers ──────────────────────────────────────────────────

let _iter = 0;
function makeDecision(
  escalationId: string,
  opts: {
    level: EscalationLevel;
    action?: string;
    stillPrompt?: string | null;
    veoPrompt?: string | null;
    cost?: number;
  },
): OrchestrationDecisionRecord {
  _iter += 1;
  return {
    id: `dec-${_iter}`,
    escalationId,
    runId: "run-A",
    iteration: _iter,
    inputContext: {},
    decision: {
      level: opts.level,
      action: opts.action ?? "prompt_fix",
      new_still_prompt: opts.stillPrompt ?? null,
      new_veo_prompt: opts.veoPrompt ?? null,
      new_negative_prompt: null,
      failure_class: null,
      known_limitation_id: null,
      redesign_option: null,
      reasoning: "test",
      confidence: 0.9,
      new_candidate_limitation: null,
    },
    model: "claude-opus-4-7",
    tokensIn: 100,
    tokensOut: 50,
    cost: opts.cost ?? 0.08,
    latencyMs: 1000,
    createdAt: new Date().toISOString(),
  };
}

// ── Checks ───────────────────────────────────────────────────────────────

type Check = { name: string; run: () => void | Promise<void> };
const checks: Check[] = [];
function check(name: string, run: () => void | Promise<void>): void {
  checks.push({ name, run });
}

// ─── Single-escalation baseline (pre-fix behavior still correct) ─────────

check("empty decision array: cost=0, levels=[], consecSameRegens=0", () => {
  assert.equal(_sumCost([]), 0);
  assert.deepEqual(_collectLevels([]), []);
  assert.equal(_countConsecutiveSamePromptRegens([]), 0);
});

check("single-escalation: sum + levels match exact values", () => {
  const decisions = [
    makeDecision("esc-A", { level: "L1", stillPrompt: "p1", cost: 0.10 }),
    makeDecision("esc-A", { level: "L1", stillPrompt: "p2", cost: 0.12 }),
    makeDecision("esc-A", { level: "L2", stillPrompt: "p3", cost: 0.15 }),
  ];
  assert.equal(_sumCost(decisions).toFixed(2), "0.37");
  assert.deepEqual(_collectLevels(decisions), ["L1", "L1", "L2"]);
  assert.equal(
    _countConsecutiveSamePromptRegens(decisions),
    0,
    "distinct prompts → 0 consecutive same",
  );
});

check("single-escalation: three identical prompts → consecSameRegens=3", () => {
  // "same prompt" = still+veo fingerprint matches after normalization.
  const decisions = [
    makeDecision("esc-A", { level: "L1", stillPrompt: "same-prompt", cost: 0.10 }),
    makeDecision("esc-A", { level: "L1", stillPrompt: "same-prompt", cost: 0.10 }),
    makeDecision("esc-A", { level: "L1", stillPrompt: "same-prompt", cost: 0.10 }),
  ];
  assert.equal(_countConsecutiveSamePromptRegens(decisions), 3);
});

// ─── Bug #3 fix — multi-escalation aggregation ───────────────────────────

check("bug #3: 2 escalations same (deliverable, run), aggregated cost sums across", () => {
  // Simulates: regen artifact 1 (esc-A) got 2 decisions; regen artifact 2
  // (esc-B) got 1 decision. Under the pre-fix code, querying by esc-B.id
  // would only see 1 decision (cost $0.15). Post-fix aggregated helper
  // returns all 3 decisions ordered chronologically → cost $0.37.
  const aggregated = [
    makeDecision("esc-A", { level: "L3", stillPrompt: "redesign-v1", cost: 0.10 }),
    makeDecision("esc-A", { level: "L3", stillPrompt: "redesign-v1", cost: 0.12 }),
    // Boundary — fresh regen artifact creates esc-B
    makeDecision("esc-B", { level: "L3", stillPrompt: "redesign-v1", cost: 0.15 }),
  ];
  assert.equal(
    _sumCost(aggregated).toFixed(2),
    "0.37",
    "aggregated sum MUST include predecessor escalation decisions",
  );
});

check("bug #3: _collectLevels preserves ordering across escalation boundaries", () => {
  const aggregated = [
    makeDecision("esc-A", { level: "L1", stillPrompt: "p1", cost: 0.08 }),
    makeDecision("esc-A", { level: "L2", stillPrompt: "p2", cost: 0.08 }),
    // Boundary
    makeDecision("esc-B", { level: "L3", stillPrompt: "p3", cost: 0.08 }),
    makeDecision("esc-B", { level: "L3", stillPrompt: "p4", cost: 0.08 }),
  ];
  assert.deepEqual(
    _collectLevels(aggregated),
    ["L1", "L2", "L3", "L3"],
    "levels list must include all four escalation decisions in order",
  );
});

check(
  "bug #3: _countConsecutiveSamePromptRegens detects repetition across escalation boundary",
  () => {
    // Simulates the exact Run 2 shot 2 / Run 3 shot 8 pattern — the orchestrator
    // called L3 redesign with an identical prompt across two escalations
    // (esc-A → regen → esc-B). Pre-fix, the tail-only window missed it
    // because esc-B had exactly 1 decision. Post-fix, aggregated array has
    // both → _countConsecutiveSamePromptRegens catches the loop.
    const aggregated = [
      // esc-A — first L3 redesign with prompt X
      makeDecision("esc-A", { level: "L3", action: "redesign", veoPrompt: "X", cost: 0.08 }),
      // esc-B (new artifact) — second L3 redesign with same prompt X
      makeDecision("esc-B", { level: "L3", action: "redesign", veoPrompt: "X", cost: 0.08 }),
    ];
    assert.equal(
      _countConsecutiveSamePromptRegens(aggregated),
      2,
      "two consecutive identical prompts across boundary → loop-signal=2",
    );
  },
);

check(
  "bug #3: divergent prompts across boundary still read correctly",
  () => {
    const aggregated = [
      makeDecision("esc-A", { level: "L1", stillPrompt: "p1", cost: 0.08 }),
      makeDecision("esc-A", { level: "L1", stillPrompt: "p2", cost: 0.08 }),
      makeDecision("esc-B", { level: "L2", stillPrompt: "p3", cost: 0.08 }),
    ];
    assert.equal(
      _countConsecutiveSamePromptRegens(aggregated),
      0,
      "all distinct prompts → 0 even across boundary",
    );
  },
);

check(
  "bug #3: aggregated window recognizes 3-deep identical-prompt loop across 3 escalations",
  () => {
    // Worst case of the bug: three artifacts, three escalations, each with
    // a single decision that proposed the same prompt. Pre-fix would see
    // esc-C.decisions = [single] → consec=0 → no loop detected → keeps
    // burning Veo budget. Post-fix aggregates all three → consec=3 →
    // orchestrator's Rule 2 self-detection (or human watcher via SSE)
    // intervenes.
    const aggregated = [
      makeDecision("esc-A", { level: "L3", action: "redesign", veoPrompt: "stuck", cost: 0.08 }),
      makeDecision("esc-B", { level: "L3", action: "redesign", veoPrompt: "stuck", cost: 0.08 }),
      makeDecision("esc-C", { level: "L3", action: "redesign", veoPrompt: "stuck", cost: 0.08 }),
    ];
    assert.equal(_countConsecutiveSamePromptRegens(aggregated), 3);
  },
);

// ─── Whitespace / case normalization sanity (preserved through fix) ──────

check("_countConsecutiveSamePromptRegens normalizes whitespace + case", () => {
  const aggregated = [
    makeDecision("esc-A", { level: "L1", stillPrompt: "Same Prompt", cost: 0.08 }),
    // Different capitalization + extra whitespace — should still match.
    makeDecision("esc-B", { level: "L1", stillPrompt: "same  prompt", cost: 0.08 }),
  ];
  assert.equal(
    _countConsecutiveSamePromptRegens(aggregated),
    2,
    "normalization: case + whitespace collapsed",
  );
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
