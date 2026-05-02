/**
 * Gap 7 unit tests — direction-drift failure-class predicate + latest verdict aggregation.
 *
 * Run:
 *   (set -a; . os-api/.env; set +a; npx tsx os-api/tests/_gap7-direction-drift.ts)
 */
import assert from "node:assert/strict";
import {
  aggregateDirectionDriftIndicators,
  DIRECTION_DRIFT_FALLBACK_CLASS,
  isDirectionDriftFailureClass,
  type DirectionDriftVerdictEvent,
} from "../src/db.js";

assert.equal(isDirectionDriftFailureClass("campaign_direction_reversion_mech_heavy"), true);
assert.equal(isDirectionDriftFailureClass("documentary_polish_drift_3d_render"), true);
assert.equal(isDirectionDriftFailureClass("new_candidate:abandoned_direction_reintroduced"), true);
assert.equal(isDirectionDriftFailureClass("foo_direction_drift_bar"), true);
assert.equal(isDirectionDriftFailureClass("aftermath_mantra_violation_active_action"), true);
assert.equal(isDirectionDriftFailureClass("three_mech_parade_formation_staging_bias"), false);
assert.equal(isDirectionDriftFailureClass("literal_split_screen_for_panning_reveal"), false);
assert.equal(isDirectionDriftFailureClass(null), false);

const deliverables = [
  { id: "shot-04", description: "Shot 04 · hook_1 · Brandy raises her hand" },
  { id: "shot-16", description: "Shot 16 · verse_2 · executives cross the courtyard" },
  { id: "shot-20", description: "Shot 20 · bridge · fortress wall" },
  { id: "shot-22", description: "Shot 22 · outro · split screen" },
];

const events: DirectionDriftVerdictEvent[] = [
  {
    deliverableId: "shot-04",
    shotNumber: 4,
    runId: "audit-run",
    timestamp: "2026-04-30T19:06:31.110Z",
    source: "run_logs",
    verdict: "PASS",
    score: 4.5,
    failureClasses: [DIRECTION_DRIFT_FALLBACK_CLASS],
    logId: 404,
  },
  {
    deliverableId: "shot-16",
    shotNumber: 16,
    runId: "audit-run",
    timestamp: "2026-04-30T19:06:32.512Z",
    source: "run_logs",
    verdict: "FAIL",
    score: 2.9,
    failureClasses: ["campaign_direction_reversion_mech_heavy"],
    logId: 416,
  },
  {
    deliverableId: "shot-16",
    shotNumber: 16,
    runId: "in-loop-run",
    timestamp: "2026-04-30T23:10:04.911Z",
    source: "asset_escalation",
    verdict: null,
    score: null,
    failureClasses: [],
    clearsDirectionDrift: true,
  },
  {
    deliverableId: "shot-20",
    shotNumber: 20,
    runId: "v5-run",
    timestamp: "2026-05-01T00:07:43.138Z",
    source: "orchestration_decision",
    verdict: "FAIL",
    score: 3.083,
    failureClasses: ["campaign_direction_reversion_mech_heavy"],
    decisionId: "decision-20",
  },
  {
    deliverableId: "shot-20",
    shotNumber: 20,
    runId: "v5-run",
    timestamp: "2026-05-01T00:09:01.000Z",
    source: "operator_override",
    verdict: null,
    score: 2.8,
    failureClasses: [],
    clearsDirectionDrift: true,
  },
  {
    deliverableId: "shot-22",
    shotNumber: 22,
    runId: "in-loop-run",
    timestamp: "2026-04-30T23:20:48.561Z",
    source: "run_logs",
    verdict: "PASS",
    score: 4.75,
    failureClasses: [],
    logId: 422,
  },
];

const indicators = aggregateDirectionDriftIndicators({ deliverables, events });

const shot4 = indicators.get("shot-04");
assert.ok(shot4);
assert.equal(shot4.directionDrift, true);
assert.deepEqual(shot4.matchedClasses, [DIRECTION_DRIFT_FALLBACK_CLASS]);
assert.equal(shot4.latestVerdictRunId, "audit-run");
assert.equal(shot4.timelineEventId, "log-404");

const shot16 = indicators.get("shot-16");
assert.ok(shot16);
assert.equal(shot16.directionDrift, false);
assert.equal(shot16.source, "asset_escalation");
assert.deepEqual(shot16.matchedClasses, []);

const shot20 = indicators.get("shot-20");
assert.ok(shot20);
assert.equal(shot20.directionDrift, false);
assert.equal(shot20.source, "operator_override");
assert.deepEqual(shot20.matchedClasses, []);

const shot22 = indicators.get("shot-22");
assert.ok(shot22);
assert.equal(shot22.directionDrift, false);
assert.equal(shot22.verdict, "PASS");

const staleOverrideIndicators = aggregateDirectionDriftIndicators({
  deliverables: [{ id: "shot-20", description: "Shot 20 · bridge · fortress wall" }],
  events: [
    {
      deliverableId: "shot-20",
      shotNumber: 20,
      runId: "fresh-audit",
      timestamp: "2026-05-02T09:00:00.000Z",
      source: "orchestration_decision",
      verdict: "FAIL",
      score: 2.6,
      failureClasses: ["campaign_direction_reversion_mech_heavy"],
      decisionId: "fresh-decision",
    },
    {
      deliverableId: "shot-20",
      shotNumber: 20,
      runId: "old-override-run",
      timestamp: "2026-05-01T09:00:00.000Z",
      source: "operator_override",
      verdict: null,
      score: 3.2,
      failureClasses: [],
      clearsDirectionDrift: true,
    },
  ],
});
const staleOverrideShot20 = staleOverrideIndicators.get("shot-20");
assert.ok(staleOverrideShot20);
assert.equal(staleOverrideShot20.directionDrift, true, "older operator override must not clear a fresher drift verdict");
assert.equal(staleOverrideShot20.source, "orchestration_decision");

console.log("✓ Gap 7 direction-drift helper tests passed");
