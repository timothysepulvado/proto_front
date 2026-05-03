/**
 * Gap 4 unit tests — RecentRunsPanel/run detail helpers.
 *
 * Pure assertions over the deterministic helper layer that backs:
 *   - GET /api/campaigns/:campaignId/recent-runs
 *   - GET /api/runs/:runId/detail
 *
 * Usage:
 *   (set -a; . os-api/.env; set +a; npx tsx os-api/tests/_gap4-recent-runs.ts)
 */
import assert from "node:assert/strict";

import {
  extractRunShotIds,
  getRunDurationSeconds,
  summarizeRecentCampaignRun,
  sumOrchestrationDecisionCost,
} from "../src/db.js";
import type { OrchestrationDecisionRecord, Run } from "../src/types.js";

const fakeRun: Run = {
  runId: "214265e2-8c4f-4f2e-97ce-155d29c2759f",
  clientId: "client_drift-mv",
  campaignId: "42f62a1d-b9df-57d8-8197-470692733391",
  mode: "stills",
  status: "completed",
  stages: [],
  createdAt: "2026-05-01T00:04:31.010Z",
  updatedAt: "2026-05-01T00:09:00.443Z",
  startedAt: "2026-05-01T00:04:31.406Z",
  completedAt: "2026-05-01T00:09:00.443Z",
  hitlRequired: false,
  metadata: {
    audit_mode: false,
    shot_ids: [20, "20", 7, "16", 0, "bad"],
  },
};

assert.deepEqual(
  extractRunShotIds(fakeRun.metadata),
  [20, 7, 16],
  "shot_ids are normalized, deduped, and invalid entries are dropped",
);

assert.equal(
  getRunDurationSeconds(fakeRun),
  269,
  "duration uses started_at → completed_at and rounds seconds",
);

const pendingRun: Run = {
  ...fakeRun,
  runId: "pending-run",
  status: "running",
  startedAt: "2026-05-01T00:00:00.000Z",
  completedAt: undefined,
};
assert.equal(
  getRunDurationSeconds(pendingRun, new Date("2026-05-01T00:00:05.400Z")),
  5,
  "active duration uses caller-provided now",
);

const summary = summarizeRecentCampaignRun(fakeRun);
assert.equal(summary.runId, fakeRun.runId);
assert.equal(summary.mode, "stills");
assert.equal(summary.auditMode, false);
assert.equal(summary.durationSeconds, 269);
assert.deepEqual(summary.shotIds, [20, 7, 16]);
assert.equal(summary.hitlRequired, false);

const decisions = [
  { cost: 0.11, inputContext: {}, decision: {} },
  { cost: undefined, inputContext: { metadata: { cost: "0.07" } }, decision: {} },
  { cost: undefined, inputContext: {}, decision: { metadata: { cost: 0.03 } } },
  { cost: undefined, inputContext: {}, decision: {} },
] as Array<Pick<OrchestrationDecisionRecord, "cost" | "inputContext" | "decision">>;

assert.equal(
  Number(sumOrchestrationDecisionCost(decisions).toFixed(2)),
  0.21,
  "decision cost sum prefers row.cost and falls back to metadata.cost",
);

console.log("✓ Gap 4 recent-runs/run-detail helper tests passed");
