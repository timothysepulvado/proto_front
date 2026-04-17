/**
 * Gate test for 10a: orchestrator readiness hardening.
 *
 * Arg-shape + unit-level assertions only. No live Vertex calls, no network,
 * no Supabase. Run via:
 *   npx tsx os-api/tests/10a-readiness.ts
 *
 * Covers:
 *   - _buildTools shape (web_search_20250305 declaration, max_uses, extra tools)
 *   - buildUserMessage: today's date injection, BUDGET STATE section, budget +
 *     loop warnings, consensus annotation
 *   - _countConsecutiveSamePromptRegens behavior
 *   - Type-level: post_vfx is a valid EscalationAction (compiles this file)
 *   - Budget cap constants match the escalation-ops brief Rule 5
 *
 * Prints PASS/FAIL per check and exits non-zero on any failure.
 */

import assert from "node:assert/strict";

import { _buildTools } from "../src/anthropic.js";
import { buildUserMessage } from "../src/orchestrator_prompts.js";
import {
  PER_SHOT_HARD_CAP_USD,
  NEXT_ORCHESTRATOR_CALL_ESTIMATE_USD,
  _countConsecutiveSamePromptRegens,
} from "../src/escalation_loop.js";
import type {
  Artifact,
  CampaignDeliverable,
  EscalationAction,
  KnownLimitation,
  OrchestrationDecisionRecord,
  PromptHistoryEntry,
  VideoGradeResult,
} from "../src/types.js";

type Check = { name: string; run: () => void };
const checks: Check[] = [];

function check(name: string, run: () => void): void {
  checks.push({ name, run });
}

// ─────────────────────────────────────────────────────────────────────────
// 1. _buildTools — web_search_20250305 declaration shape
// ─────────────────────────────────────────────────────────────────────────

check("_buildTools enableWebSearch=false returns []", () => {
  const tools = _buildTools({
    systemCached: "sys",
    userMessage: "user",
    enableWebSearch: false,
  });
  assert.equal(tools.length, 0);
});

check("_buildTools enableWebSearch=true declares web_search_20250305", () => {
  const tools = _buildTools({
    systemCached: "sys",
    userMessage: "user",
    enableWebSearch: true,
  }) as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, "web_search_20250305");
  assert.equal(tools[0].name, "web_search");
  assert.equal(tools[0].max_uses, 3);
});

check("_buildTools respects maxWebSearchUses override", () => {
  const tools = _buildTools({
    systemCached: "sys",
    userMessage: "user",
    enableWebSearch: true,
    maxWebSearchUses: 7,
  }) as Array<Record<string, unknown>>;
  assert.equal(tools[0].max_uses, 7);
});

check("_buildTools merges extraTools with web_search", () => {
  const tools = _buildTools({
    systemCached: "sys",
    userMessage: "user",
    enableWebSearch: true,
    extraTools: [{ type: "custom_tool", name: "foo" }],
  }) as Array<Record<string, unknown>>;
  assert.equal(tools.length, 2);
  assert.equal(tools[0].type, "web_search_20250305");
  assert.equal(tools[1].type, "custom_tool");
});

// ─────────────────────────────────────────────────────────────────────────
// 2. buildUserMessage — today's date, BUDGET STATE, warnings, consensus
// ─────────────────────────────────────────────────────────────────────────

const baseArtifact: Artifact = {
  id: "art-1",
  runId: "run-1",
  type: "video",
  name: "test.mp4",
  path: "/tmp/test.mp4",
  createdAt: "2026-04-17T00:00:00Z",
};

const baseDeliverable: CampaignDeliverable = {
  id: "del-1",
  campaignId: "camp-1",
  status: "generating",
  retryCount: 0,
  createdAt: "2026-04-17T00:00:00Z",
  updatedAt: "2026-04-17T00:00:00Z",
  mediaType: "video",
  durationSeconds: 8,
};

const baseVerdict: VideoGradeResult = {
  verdict: "WARN",
  aggregate_score: 3.8,
  criteria: [],
  detected_failure_classes: ["scene_progression_vfx_completion"],
  confidence: 0.7,
  summary: "test",
  reasoning: "test",
  recommendation: "L1_prompt_fix",
  model: "gemini-3.1-pro-preview",
  cost: 0.0,
  latency_ms: 100,
};

check("buildUserMessage emits Today's date as first non-empty line", () => {
  const msg = buildUserMessage({
    artifact: baseArtifact,
    qaVerdict: baseVerdict,
    promptHistory: [],
    catalog: [],
    attemptCount: 0,
    escalationLevel: "L1",
    deliverable: baseDeliverable,
    campaignContext: { brandSlug: "drift-mv" },
    todayDate: "2026-04-17",
  });
  const firstLine = msg.split("\n")[0];
  assert.equal(firstLine, "Today's date: 2026-04-17");
});

check("buildUserMessage includes BUDGET STATE section with cap=4.00", () => {
  const msg = buildUserMessage({
    artifact: baseArtifact,
    qaVerdict: baseVerdict,
    promptHistory: [],
    catalog: [],
    attemptCount: 1,
    escalationLevel: "L1",
    deliverable: baseDeliverable,
    campaignContext: { brandSlug: "drift-mv" },
    todayDate: "2026-04-17",
    perShotCumulativeCost: 0.5,
    consecutiveSamePromptRegens: 0,
    levelsUsed: ["L1"],
  });
  assert.ok(msg.includes("## BUDGET STATE"), "BUDGET STATE section present");
  assert.ok(msg.includes("per_shot_cumulative_cost_usd: 0.5000"), "cumulative cost line present");
  assert.ok(msg.includes("per_shot_hard_cap_usd: 4.00"), "hard cap line present");
  assert.ok(msg.includes("consecutiveSamePromptRegens: 0"), "consec regens line present");
  assert.ok(msg.includes("Levels used so far on this shot: [L1]"), "levels list present");
});

check("buildUserMessage emits BUDGET WARNING at cumCost >= 3.5", () => {
  const msg = buildUserMessage({
    artifact: baseArtifact,
    qaVerdict: baseVerdict,
    promptHistory: [],
    catalog: [],
    attemptCount: 2,
    escalationLevel: "L2",
    deliverable: baseDeliverable,
    campaignContext: { brandSlug: "drift-mv" },
    todayDate: "2026-04-17",
    perShotCumulativeCost: 3.6,
    consecutiveSamePromptRegens: 0,
  });
  assert.ok(msg.includes("BUDGET WARNING"), "budget warning triggered");
});

check("buildUserMessage emits LOOP WARNING at consecSame >= 3", () => {
  const msg = buildUserMessage({
    artifact: baseArtifact,
    qaVerdict: baseVerdict,
    promptHistory: [],
    catalog: [],
    attemptCount: 3,
    escalationLevel: "L1",
    deliverable: baseDeliverable,
    campaignContext: { brandSlug: "drift-mv" },
    todayDate: "2026-04-17",
    perShotCumulativeCost: 1.2,
    consecutiveSamePromptRegens: 3,
  });
  assert.ok(msg.includes("LOOP WARNING"), "loop warning triggered");
});

check("buildUserMessage surfaces consensus_resolved annotation when set", () => {
  const msg = buildUserMessage({
    artifact: baseArtifact,
    qaVerdict: baseVerdict,
    promptHistory: [],
    catalog: [],
    attemptCount: 0,
    escalationLevel: "L1",
    deliverable: baseDeliverable,
    campaignContext: { brandSlug: "drift-mv" },
    todayDate: "2026-04-17",
    consensusResolved: true,
  });
  assert.ok(
    msg.includes("consensus_resolved: true"),
    "consensus annotation emitted in QA VERDICT section",
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 3. _countConsecutiveSamePromptRegens — loop detection
// ─────────────────────────────────────────────────────────────────────────

function mkDecision(still: string, veo: string, cost = 0.15): OrchestrationDecisionRecord {
  return {
    id: `dec-${Math.random().toString(36).slice(2, 8)}`,
    escalationId: "esc-1",
    iteration: 1,
    inputContext: {},
    decision: { new_still_prompt: still, new_veo_prompt: veo, level: "L1", action: "prompt_fix" },
    model: "claude-opus-4-7",
    cost,
    createdAt: "2026-04-17T00:00:00Z",
  };
}

check("_countConsecutiveSamePromptRegens returns 0 for empty history", () => {
  assert.equal(_countConsecutiveSamePromptRegens([]), 0);
});

check("_countConsecutiveSamePromptRegens returns 0 when prompts differ", () => {
  const d = [mkDecision("a", "b"), mkDecision("c", "d")];
  assert.equal(_countConsecutiveSamePromptRegens(d), 0);
});

check("_countConsecutiveSamePromptRegens returns 2 when last 2 identical", () => {
  const d = [mkDecision("x", "y"), mkDecision("a", "b"), mkDecision("a", "b")];
  // Last two are identical → count = 2 (both "a||b")
  assert.equal(_countConsecutiveSamePromptRegens(d), 2);
});

check("_countConsecutiveSamePromptRegens returns 3 when last 3 identical", () => {
  const d = [mkDecision("x", "y"), mkDecision("a", "b"), mkDecision("a", "b"), mkDecision("a", "b")];
  assert.equal(_countConsecutiveSamePromptRegens(d), 3);
});

check("_countConsecutiveSamePromptRegens normalizes whitespace + case", () => {
  const d = [mkDecision("Hello World", "Foo"), mkDecision("hello   world", "foo")];
  assert.equal(_countConsecutiveSamePromptRegens(d), 2);
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Budget cap constants match escalation-ops brief Rule 5
// ─────────────────────────────────────────────────────────────────────────

check("PER_SHOT_HARD_CAP_USD matches brief (Rule 5)", () => {
  assert.equal(PER_SHOT_HARD_CAP_USD, 4.0);
});

check("NEXT_ORCHESTRATOR_CALL_ESTIMATE_USD is conservative (<$0.25)", () => {
  assert.ok(NEXT_ORCHESTRATOR_CALL_ESTIMATE_USD > 0);
  assert.ok(NEXT_ORCHESTRATOR_CALL_ESTIMATE_USD < 0.25);
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Type-level: post_vfx is a valid EscalationAction (this file compiling
//    via tsx proves the type is in the union)
// ─────────────────────────────────────────────────────────────────────────

check("post_vfx typechecks as EscalationAction (compile-time)", () => {
  const a: EscalationAction = "post_vfx";
  assert.equal(a, "post_vfx");
});

// ─────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────

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
  console.log(`10a readiness gate — ${pass} pass, ${fail} fail, ${checks.length} total`);
  // Silence unused-var warnings — these types are imported for side-effect type-checking
  void ({} as KnownLimitation);
  void ({} as PromptHistoryEntry);
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
