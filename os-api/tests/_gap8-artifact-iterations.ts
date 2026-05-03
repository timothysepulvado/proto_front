/**
 * Gap 8 unit tests — regen artifact iteration parse + artifact/verdict aggregation.
 *
 * Run:
 *   (set -a; . os-api/.env; set +a; npx tsx os-api/tests/_gap8-artifact-iterations.ts)
 */
import assert from "node:assert/strict";
import {
  aggregateArtifactIterationRows,
  parseArtifactIteration,
  type ArtifactIterationAggregationInput,
} from "../src/db.js";
import type { Artifact, OrchestrationDecisionRecord, Run, RunLog } from "../src/types.js";

function artifact(partial: Partial<Artifact> & Pick<Artifact, "id" | "runId" | "name" | "createdAt">): Artifact {
  return {
    id: partial.id,
    runId: partial.runId,
    clientId: "client_drift-mv",
    campaignId: "campaign-drift",
    deliverableId: "deliverable-20",
    type: "image",
    name: partial.name,
    path: partial.path ?? `/Users/timothysepulvado/Temp-gen/outputs/${partial.runId}/${partial.name}`,
    storagePath: partial.storagePath,
    stage: "grade",
    metadata: partial.metadata,
    createdAt: partial.createdAt,
  };
}

const seed = artifact({
  id: "seed-1",
  runId: "run-v4",
  name: "shot_20.png",
  createdAt: "2026-04-30T23:14:45.320Z",
  metadata: { localPath: "/Users/timothysepulvado/Temp-gen/productions/drift-mv/stills/shot_20.png", seedReason: "no_prior_artifact_disk_only" },
});
const iter2 = artifact({
  id: "iter-2",
  runId: "run-v4",
  name: "shot_20_iter2.png",
  createdAt: "2026-04-30T23:15:57.302Z",
  metadata: { iter: 2, parentArtifactId: "seed-1", localPath: "/Users/timothysepulvado/Temp-gen/outputs/run-v4/shot_20_iter2.png" },
});
const iter3 = artifact({
  id: "iter-3",
  runId: "run-v5",
  name: "shot_20_iter3.png",
  path: "https://example.test/shot_20_iter3.png",
  createdAt: "2026-05-01T00:08:11.779Z",
  metadata: { parentArtifactId: "iter-2", localPath: "/Users/timothysepulvado/Temp-gen/outputs/run-v5/shot_20_iter3.png" },
});

assert.equal(parseArtifactIteration(seed), null);
assert.equal(parseArtifactIteration(iter2), 2);
assert.equal(parseArtifactIteration(iter3), 3);
assert.equal(parseArtifactIteration({ ...iter3, name: "shot_20.png", path: "https://x/shot_20_iter12.png", metadata: {} }), 12);

const runs: Run[] = [
  {
    runId: "run-v1",
    clientId: "client_drift-mv",
    campaignId: "campaign-drift",
    mode: "stills",
    status: "completed",
    stages: [],
    createdAt: "2026-04-30T20:00:00.000Z",
    updatedAt: "2026-04-30T20:00:00.000Z",
    hitlRequired: false,
    metadata: { shot_ids: [20], audit_mode: false },
  },
  {
    runId: "run-v4",
    clientId: "client_drift-mv",
    campaignId: "campaign-drift",
    mode: "stills",
    status: "completed",
    stages: [],
    createdAt: "2026-04-30T23:00:00.000Z",
    updatedAt: "2026-04-30T23:00:00.000Z",
    hitlRequired: false,
    metadata: { shot_ids: [20], audit_mode: false },
  },
  {
    runId: "run-v5",
    clientId: "client_drift-mv",
    campaignId: "campaign-drift",
    mode: "stills",
    status: "completed",
    stages: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    hitlRequired: false,
    metadata: { shot_ids: [20], audit_mode: false },
  },
];

const logs: RunLog[] = [
  { id: 1, runId: "run-v4", timestamp: "2026-04-30T23:16:37.044Z", stage: "grade", level: "info", message: "[in_loop] shot 20 iter 2: FAIL score=3.22 → L1_prompt_fix" },
  { id: 2, runId: "run-v5", timestamp: "2026-05-01T00:08:58.871Z", stage: "grade", level: "info", message: "[in_loop] shot 20 iter 3: FAIL score=2.80 → L1_prompt_fix" },
];

const decisions: OrchestrationDecisionRecord[] = [
  {
    id: "decision-iter2",
    escalationId: "esc-2",
    runId: "run-v4",
    iteration: 2,
    inputContext: {
      artifactId: "iter-2",
      qaVerdict: {
        verdict: "FAIL",
        aggregate_score: 3.217,
        recommendation: "L1_prompt_fix",
        detected_failure_classes: ["mech_color_identity_drift_off_manifest_spec"],
      },
    },
    decision: { failure_class: "mech_color_identity_drift_off_manifest_spec" },
    model: "claude",
    createdAt: "2026-04-30T23:16:38.000Z",
  },
];

const input: ArtifactIterationAggregationInput = {
  deliverableId: "deliverable-20",
  shotNumber: 20,
  artifacts: [iter3, seed, iter2],
  logs,
  decisions,
  runs,
  operatorOverrides: new Map([
    ["run-v5:iter3", { decisionAt: "2026-05-01", decidedIter: 3, decisionBy: "Tim direction", criticVerdict: "FAIL", criticScore: 2.8 }],
  ]),
};

const result = aggregateArtifactIterationRows(input);
assert.deepEqual(result.rows.map((row) => row.artifact.id), ["seed-1", "iter-2", "iter-3"]);
assert.equal(result.rows[0].label, "v2 locked seed");
assert.equal(result.rows[1].label, "v2 iter2");
assert.equal(result.rows[1].parentLabel, "v2 locked seed");
assert.equal(result.rows[1].verdict?.score, 3.217);
assert.deepEqual(result.rows[1].verdict?.failureClasses, ["mech_color_identity_drift_off_manifest_spec"]);
assert.equal(result.rows[2].label, "v3 iter3");
assert.equal(result.rows[2].verdict?.score, 2.8);
assert.equal(result.rows[2].operatorOverride?.decisionBy, "Tim direction");
assert.equal(result.rows[2].displayUrl, "https://example.test/shot_20_iter3.png");
assert.equal(result.rows[0].displayUrl, "/api/artifacts/seed-1/file");

console.log("✓ Gap 8 artifact iteration helper tests passed");
