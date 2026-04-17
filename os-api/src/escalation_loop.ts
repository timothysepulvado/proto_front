/**
 * Autonomous escalation loop — orchestrates what happens when an artifact
 * fails auto-QA.
 *
 * Public API: `handleQAFailure()` called by runner.ts after any QA stage.
 * Returns a signal indicating whether the runner should continue with the
 * successor artifact or halt + flag HITL.
 *
 * Flow:
 *   1. Create or update asset_escalations row
 *   2. Assemble orchestrator input (catalog + history + artifact + verdict)
 *   3. Call Claude Opus 4.7 orchestrator → OrchestratorDecision
 *   4. Record orchestration_decisions row
 *   5. Apply iteration gates (L1 × 3 → L2, L2 × 2 → L3, L3 redesign × 2 → hitl_required)
 *   6. Execute decision (regen or accept)
 *   7. Emit runEvents.emit("escalation:${runId}") for realtime UI
 */

import { EventEmitter } from "events";

import { decideEscalation } from "./orchestrator.js";
import {
  createEscalation,
  getEscalationByArtifact,
  updateEscalation,
  resolveEscalation,
  recordOrchestrationDecision,
  incrementLimitationCounter,
  getLimitationByFailureMode,
  createKnownLimitation,
  listKnownLimitations,
  getPromptHistoryForDeliverable,
  getDeliverable,
  getCampaign,
} from "./db.js";
import type {
  Artifact,
  AssetEscalation,
  Campaign,
  EscalationAction,
  EscalationLevel,
  OrchestratorDecision,
  VideoGradeResult,
} from "./types.js";

// ── Iteration gates per level ─────────────────────────────────────────────
const MAX_ATTEMPTS: Record<EscalationLevel, number> = {
  L1: 3, // up to 3 prompt fixes before promoting to L2
  L2: 2, // up to 2 approach changes before promoting to L3
  L3: 2, // up to 2 redesigns OR 1 replace before flagging hitl_required
};

// ── Types exported to callers ─────────────────────────────────────────────
export interface QAFailureContext {
  runId: string;
  clientId: string;
  campaignId?: string;
  artifact: Artifact;
  qaVerdict: VideoGradeResult | Record<string, unknown>;
  stageId: string;
  runEvents: EventEmitter;
  logger: (level: "info" | "warn" | "error" | "debug", message: string) => Promise<void>;
}

export interface QAFailureResult {
  /** What the runner should do next. */
  outcome: "regenerate" | "accepted" | "hitl_required" | "failed";
  /** The escalation record (for return to caller for further action). */
  escalation: AssetEscalation;
  /** The orchestrator's decision (for regeneration caller). */
  decision: OrchestratorDecision;
  /** Null when outcome !== "regenerate". */
  newPrompts: {
    stillPrompt: string | null;
    veoPrompt: string | null;
    negativePrompt: string | null;
  } | null;
}

// ── Main entry point ──────────────────────────────────────────────────────

/**
 * Handle a QA failure: call orchestrator, record decision, return action
 * signal to the runner.
 *
 * The runner is responsible for executing the regeneration (calling
 * /generate/image, /generate/video, etc.) based on the returned newPrompts.
 * We keep that separation because the runner already owns the sidecar wrappers.
 */
export async function handleQAFailure(ctx: QAFailureContext): Promise<QAFailureResult> {
  const { runId, artifact, qaVerdict, stageId, runEvents, logger } = ctx;

  await logger("info", `[${stageId}] Escalation loop: handling QA failure for artifact ${artifact.id}`);

  // 1. Get or create escalation
  const existingEscalation = await getEscalationByArtifact(artifact.id);
  let escalation = existingEscalation
    ?? await createEscalation({
      artifactId: artifact.id,
      deliverableId: artifact.deliverableId,
      runId,
      currentLevel: "L1",
      status: "in_progress",
    });

  // 2. Check iteration gate — if we're exhausted at current level, promote
  escalation = await _maybePromoteLevel(escalation, logger);
  if (escalation.status === "hitl_required") {
    runEvents.emit(`escalation:${runId}`, escalation);
    return {
      outcome: "hitl_required",
      escalation,
      decision: _nullDecision(),
      newPrompts: null,
    };
  }

  // 3. Assemble orchestrator input
  const deliverableId = artifact.deliverableId;
  if (!deliverableId) {
    await logger("error", "Escalation requires a deliverableId on the artifact; got none");
    return {
      outcome: "failed",
      escalation,
      decision: _nullDecision(),
      newPrompts: null,
    };
  }

  const deliverable = await getDeliverable(deliverableId);
  if (!deliverable) {
    await logger("error", `Deliverable ${deliverableId} not found`);
    return { outcome: "failed", escalation, decision: _nullDecision(), newPrompts: null };
  }

  let campaign: Campaign | null = null;
  if (ctx.campaignId) {
    campaign = await getCampaign(ctx.campaignId);
  }
  const brandSlug = ctx.clientId.replace("client_", "");

  const catalog = await listKnownLimitations();
  const promptHistory = await getPromptHistoryForDeliverable(deliverableId);

  await logger(
    "info",
    `Orchestrator input: level=${escalation.currentLevel}, attempts=${escalation.iterationCount}, catalog_size=${catalog.length}, history_size=${promptHistory.length}`,
  );

  // 4. Call orchestrator
  let decisionResult;
  try {
    decisionResult = await decideEscalation({
      artifact,
      qaVerdict,
      promptHistory,
      knownLimitationsCatalog: catalog,
      attemptCount: escalation.iterationCount,
      escalationLevel: escalation.currentLevel,
      deliverable,
      campaignContext: {
        prompt: campaign?.prompt ?? undefined,
        brandSlug,
        narrative: (deliverable as { narrative?: string }).narrative,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logger("error", `Orchestrator call failed: ${msg}`);
    // Promote to hitl_required on orchestrator failure
    escalation = await updateEscalation(escalation.id, {
      status: "hitl_required",
      resolutionNotes: `Orchestrator error: ${msg}`,
    });
    runEvents.emit(`escalation:${runId}`, escalation);
    return {
      outcome: "hitl_required",
      escalation,
      decision: _nullDecision(),
      newPrompts: null,
    };
  }

  const { decision } = decisionResult;

  await logger(
    "info",
    `Orchestrator decision: level=${decision.level}, action=${decision.action}, failure_class=${decision.failure_class ?? "none"}, confidence=${decision.confidence}`,
  );

  // 5. Record the decision
  const iteration = escalation.iterationCount + 1;
  await recordOrchestrationDecision({
    escalationId: escalation.id,
    runId,
    iteration,
    inputContext: {
      artifactId: artifact.id,
      deliverableId,
      attemptCount: escalation.iterationCount,
      escalationLevel: escalation.currentLevel,
      qaVerdict,
      promptHistoryLength: promptHistory.length,
    },
    decision: decision as unknown as Record<string, unknown>,
    model: decisionResult.model,
    tokensIn: decisionResult.tokensIn,
    tokensOut: decisionResult.tokensOut,
    cost: decisionResult.cost,
    latencyMs: decisionResult.latencyMs,
  });

  // 6. If orchestrator flagged a new_candidate_limitation, add it to the catalog
  if (decision.new_candidate_limitation) {
    try {
      const existing = await getLimitationByFailureMode(decision.new_candidate_limitation.failure_mode);
      if (!existing) {
        const created = await createKnownLimitation({
          model: deliverable.aiModel ?? "unknown",
          category: decision.new_candidate_limitation.category,
          failureMode: decision.new_candidate_limitation.failure_mode,
          description: decision.new_candidate_limitation.description,
          mitigation: decision.new_candidate_limitation.mitigation,
          severity: decision.new_candidate_limitation.severity,
          detectedInProductionId: brandSlug,
          detectedInRunId: runId,
        });
        await logger("info", `New limitation added to catalog: ${created.failureMode} (${created.id})`);
      }
    } catch (err) {
      await logger(
        "warn",
        `Failed to add new candidate limitation (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 7. If failure_class matches an existing limitation, increment counter + link
  let knownLimitationId: string | undefined;
  if (decision.failure_class) {
    try {
      const lim = await getLimitationByFailureMode(decision.failure_class);
      if (lim) {
        knownLimitationId = lim.id;
        await incrementLimitationCounter(lim.id);
      }
    } catch (err) {
      await logger(
        "warn",
        `Failed to link known limitation (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 8. Update escalation with the orchestrator's decision
  escalation = await updateEscalation(escalation.id, {
    currentLevel: decision.level,
    iterationCount: iteration,
    failureClass: decision.failure_class ?? undefined,
    knownLimitationId,
    resolutionPath: decision.action,
  });

  runEvents.emit(`escalation:${runId}`, escalation);

  // 9. Decide outcome based on action
  if (decision.action === "accept") {
    escalation = await resolveEscalation(escalation.id, "accepted", decision.reasoning);
    runEvents.emit(`escalation:${runId}`, escalation);
    return {
      outcome: "accepted",
      escalation,
      decision,
      newPrompts: null,
    };
  }

  // All other actions require regeneration with the new prompts
  if (!decision.new_still_prompt && !decision.new_veo_prompt) {
    await logger(
      "error",
      `Orchestrator action=${decision.action} but no new prompts provided; flagging HITL`,
    );
    escalation = await updateEscalation(escalation.id, { status: "hitl_required" });
    runEvents.emit(`escalation:${runId}`, escalation);
    return {
      outcome: "hitl_required",
      escalation,
      decision,
      newPrompts: null,
    };
  }

  return {
    outcome: "regenerate",
    escalation,
    decision,
    newPrompts: {
      stillPrompt: decision.new_still_prompt,
      veoPrompt: decision.new_veo_prompt,
      negativePrompt: decision.new_negative_prompt,
    },
  };
}

// ── Promotion logic ───────────────────────────────────────────────────────

/**
 * If the escalation has exceeded the per-level max attempts, promote to the
 * next level (L1 → L2 → L3 → hitl_required). Returns the updated escalation.
 */
async function _maybePromoteLevel(
  esc: AssetEscalation,
  logger: QAFailureContext["logger"],
): Promise<AssetEscalation> {
  const max = MAX_ATTEMPTS[esc.currentLevel];
  if (esc.iterationCount < max) return esc;

  if (esc.currentLevel === "L1") {
    await logger("info", `L1 exhausted (${esc.iterationCount}/${max}) — promoting to L2`);
    return updateEscalation(esc.id, { currentLevel: "L2" });
  }
  if (esc.currentLevel === "L2") {
    await logger("info", `L2 exhausted (${esc.iterationCount}/${max}) — promoting to L3`);
    return updateEscalation(esc.id, { currentLevel: "L3" });
  }
  // L3 exhausted → hitl_required
  await logger("warn", `L3 exhausted (${esc.iterationCount}/${max}) — flagging hitl_required`);
  return updateEscalation(esc.id, {
    status: "hitl_required",
    resolutionNotes: `L3 iteration cap (${max}) exceeded without resolution`,
  });
}

// ── Finalize resolution after successor artifact passes QA ────────────────

/**
 * Called by runner when a regenerated artifact passes QA. Marks the escalation
 * as resolved and links the final_artifact_id.
 */
export async function markEscalationResolved(
  escalationId: string,
  finalArtifactId: string,
  runEvents: EventEmitter,
  runId: string,
  action: EscalationAction,
): Promise<AssetEscalation> {
  const status =
    action === "accept"
      ? "accepted"
      : action === "redesign"
        ? "redesigned"
        : action === "replace"
          ? "replaced"
          : "resolved";
  const escalation = await resolveEscalation(escalationId, status, undefined, finalArtifactId);
  runEvents.emit(`escalation:${runId}`, escalation);
  return escalation;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _nullDecision(): OrchestratorDecision {
  return {
    level: "L3",
    action: "accept",
    failure_class: null,
    known_limitation_id: null,
    new_still_prompt: null,
    new_veo_prompt: null,
    new_negative_prompt: null,
    redesign_option: null,
    reasoning: "Null decision (orchestrator bypass / failure).",
    confidence: 0.0,
    new_candidate_limitation: null,
  };
}
