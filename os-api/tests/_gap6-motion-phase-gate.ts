/**
 * Gap 6 unit tests — MotionPhaseGate aggregation helpers.
 *
 * Pure assertions over the helper layer backing:
 *   - GET /api/campaigns/:campaignId/motion-phase-gate
 *   - <MotionPhaseGate> locked/operator-confirmed/HITL split
 *
 * Usage:
 *   (set -a; . os-api/.env; set +a; npx tsx os-api/tests/_gap6-motion-phase-gate.ts)
 */
import assert from "node:assert/strict";

import { aggregateMotionPhaseGateState } from "../src/db.js";

const state = aggregateMotionPhaseGateState({
  campaignId: "campaign-gap6",
  productionSlug: "drift-mv",
  now: new Date("2026-05-01T08:00:00.000Z"),
  deliverables: [
    { id: "del-shot-01", status: "approved", description: "Shot 01 · intro · locked still" },
    { id: "del-shot-02", status: "reviewing", description: "Shot 02 · intro · prior video review but still locked" },
    { id: "del-shot-03", status: "pending", description: "Shot 03 · hook_1 · not locked" },
    { id: "del-shot-04", status: "approved", description: "Shot 04 · hook_1 · direction caveat" },
  ],
  runs: [
    {
      runId: "stills-new",
      mode: "stills",
      status: "completed",
      createdAt: "2026-05-01T07:30:00.000Z",
      hitlRequired: false,
      metadata: {
        shot_ids: [1, 2, 4],
        operator_override: {
          shot_1: {
            rationale: "Tim accepted iter 3 over critic variance.",
            critic_verdict: "FAIL",
            critic_score: 2.8,
            decided_iter: 3,
            decision_by: "Tim direction",
            decision_at: "2026-04-30",
          },
        },
      },
    },
    {
      runId: "video-old",
      mode: "video",
      status: "completed",
      createdAt: "2026-04-27T07:30:00.000Z",
      hitlRequired: true,
      metadata: {},
    },
  ],
  escalations: [
    {
      id: "esc-accepted",
      deliverableId: "del-shot-02",
      runId: "stills-new",
      status: "accepted",
      resolutionPath: "accept",
      resolutionNotes: "Operator accepted the locked still after visual review.",
      resolvedAt: "2026-05-01T07:45:00.000Z",
    },
    {
      id: "esc-video-hitl-ignored",
      deliverableId: "del-shot-01",
      runId: "video-old",
      status: "hitl_required",
    },
    {
      id: "esc-stills-hitl-blocks",
      deliverableId: "del-shot-04",
      runId: "stills-new",
      status: "hitl_required",
      failureClass: "campaign_direction_reversion_mech_heavy",
    },
  ],
  manifest: {
    characters: {
      mech_openai: {
        canonical_reference_still: "stills/shot_02.png",
        canonical_reference_locked_at: "2026-04-30",
        canonical_reference_locked_by: "Tim direction",
        canonical_reference_rationale: "Use shot 02 as canonical reference.",
      },
    },
    shots: [
      {
        id: 4,
        visual: "Brandy faces a rampaging mech while a glowing digital sphere forms in her palm.",
        still_prompt: "Documentary-dry alt angle still pending.",
        veo_prompt: "Use approved still as source.",
      },
      {
        id: 22,
        visual: "Split-screen human-machine mirror.",
        veo_prompt: "Static split-screen composition remains locked.",
      },
    ],
  },
});

assert.equal(state.lockedCount, 3, "approved + reviewing deliverables are counted as locked stills");
assert.equal(state.operatorConfirmedCount, 2, "operator override + accepted stills escalation confirm two locked shots");
assert.equal(state.lockedWithoutExplicitApprovalCount, 1, "remaining locked shot has no explicit operator approval");
assert.equal(state.openHitlCount, 1, "stills-stage HITL escalation blocks motion gate");
assert.equal(state.blocked, true, "open stills HITL sets blocked=true");
assert.equal(state.latestStillsRunId, "stills-new", "latest stills run is carried for video parentRunId");
assert.deepEqual(state.lockedDeliverableIds, ["del-shot-01", "del-shot-02", "del-shot-04"]);

const notesByShot = new Map(state.shotsOfNote.map((note) => [note.shotNumber, note]));
assert.equal(notesByShot.get(1)?.state, "operator-override", "operator override note wins for shot 1");
assert.equal(notesByShot.get(2)?.state, "operator-accepted", "accepted stills escalation note wins over lower-priority canonical note");
assert.equal(notesByShot.get(4)?.state, "pending", "manifest direction caveat produces a pending shot-of-note");
assert.equal(notesByShot.has(22), false, "manifest split-screen note is skipped when the shot is not locked in this campaign scope");

const unblocked = aggregateMotionPhaseGateState({
  campaignId: "campaign-gap6-unblocked",
  productionSlug: "drift-mv",
  now: new Date("2026-05-01T08:00:00.000Z"),
  deliverables: [
    { id: "del-shot-01", status: "approved", description: "Shot 01 · intro" },
  ],
  runs: [],
  approvedDecisions: [],
  escalations: [],
  manifest: null,
});
assert.equal(unblocked.openHitlCount, 0);
assert.equal(unblocked.blocked, false);

console.log("✓ Gap 6 motion-phase gate helper tests passed");
