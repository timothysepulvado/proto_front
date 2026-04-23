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
  getLatestOpenEscalationForDeliverableInRun,
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
  getOrchestrationDecisionsForDeliverableInRun,
} from "./db.js";
import type {
  Artifact,
  AssetEscalation,
  Campaign,
  EscalationAction,
  EscalationLevel,
  KnownLimitation,
  MusicVideoContext,
  NarrativeContext,
  OrchestratorDecision,
  OrchestrationDecisionRecord,
  QAThreshold,
  VideoGradeResult,
} from "./types.js";

// ── Budget cap + watcher signals (Rule 5 + autonomous-ops brief) ──────────
/**
 * Per-shot hard cap across all orchestrator calls + regenerations on a single
 * asset. From escalation-ops brief Rule 5.
 */
export const PER_SHOT_HARD_CAP_USD = 4.0;
/**
 * Rough estimate of the next orchestrator-call cost (model tokens only —
 * excludes regen cost, which dwarfs this). Used for pre-flight cap check;
 * better to err low since we halt BEFORE the call, not after.
 */
export const NEXT_ORCHESTRATOR_CALL_ESTIMATE_USD = 0.15;

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
  //
  // Bug #3 fix (2026-04-23): when the current artifact has no escalation row
  // (e.g., fresh regen artifact created by L1/L2/L3 action), we need to
  // inherit level + iteration_count from the LATEST OPEN escalation on this
  // (deliverable, run) pair — otherwise `_maybePromoteLevel` sees
  // iteration_count=0 on every iteration and never promotes, and the
  // orchestrator's Rule 2 self-detection reads a fresh currentLevel="L1"
  // instead of the actual progression. This preserves the true escalation
  // state across artifact boundaries without changing the schema (one row
  // per artifact, audit trail intact).
  // Scope the "existing escalation" lookup to this run — prevents stale
  // escalations from prior runs (Session B bug #1 + the 2026-04-23 smoke
  // mid-flight-kill pattern) from short-circuiting fresh runs.
  let escalation = await getEscalationByArtifact(artifact.id, runId);
  if (!escalation) {
    const predecessor = artifact.deliverableId
      ? await getLatestOpenEscalationForDeliverableInRun(artifact.deliverableId, runId)
      : null;
    escalation = await createEscalation({
      artifactId: artifact.id,
      deliverableId: artifact.deliverableId,
      runId,
      currentLevel: predecessor?.currentLevel ?? "L1",
      status: "in_progress",
    });
    if (predecessor && predecessor.iterationCount > 0) {
      escalation = await updateEscalation(escalation.id, {
        iterationCount: predecessor.iterationCount,
      });
      await logger(
        "info",
        `Inherited escalation state from predecessor ${predecessor.id}: level=${predecessor.currentLevel}, iteration=${predecessor.iterationCount}`,
      );
    }
  }

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

  // ── Watcher signals (Rule 5) — derived from prior orchestration_decisions ──
  //
  // Bug #3 fix (2026-04-23): aggregate across ALL escalation rows on this
  // (deliverable, run) pair rather than just the current escalation row.
  // Each regen artifact creates a new escalation row → querying by
  // escalation.id alone returns an empty (or short) history, which was
  // resetting consecSameRegens / cumulativeCost / levelsUsed every iteration
  // and blinding the orchestrator's Rule 2 self-detection.
  const priorDecisions = await getOrchestrationDecisionsForDeliverableInRun(
    deliverableId,
    runId,
  );
  const cumulativeCost = _sumCost(priorDecisions);
  const levelsUsed = _collectLevels(priorDecisions);
  const consecutiveSameRegens = _countConsecutiveSamePromptRegens(priorDecisions);
  const todayDate = _todayISO();

  await logger(
    "info",
    `Orchestrator input: level=${escalation.currentLevel}, attempts=${escalation.iterationCount}, catalog_size=${catalog.length}, history_size=${promptHistory.length}, cumCost=$${cumulativeCost.toFixed(4)}, consecSameRegens=${consecutiveSameRegens}, levels=[${levelsUsed.join(",")}]`,
  );

  // Emit watcher signal via runEvents so the SSE stream surfaces budget/loop
  // state to humans — Tim's watcher can pull the plug manually when needed.
  runEvents.emit(`escalation:${runId}`, {
    type: "watcher_signal",
    escalationId: escalation.id,
    artifactId: artifact.id,
    cumulativeCost,
    perShotHardCap: PER_SHOT_HARD_CAP_USD,
    consecutiveSameRegens,
    levelsUsed,
    warnBudget: cumulativeCost + NEXT_ORCHESTRATOR_CALL_ESTIMATE_USD >= PER_SHOT_HARD_CAP_USD,
    warnLoop: consecutiveSameRegens >= 3,
  });

  // ── Budget cap short-circuit (Rule 5) ───────────────────────────────────
  // If another orchestrator+regen cycle would blow past the per-shot hard cap,
  // flag hitl_required BEFORE burning more spend. Conservative: we halt on
  // cumulative + est > cap rather than calling and letting Claude vote.
  if (cumulativeCost + NEXT_ORCHESTRATOR_CALL_ESTIMATE_USD > PER_SHOT_HARD_CAP_USD) {
    await logger(
      "warn",
      `Budget cap: cumCost=$${cumulativeCost.toFixed(4)} + est=$${NEXT_ORCHESTRATOR_CALL_ESTIMATE_USD} exceeds per-shot cap $${PER_SHOT_HARD_CAP_USD}. Flagging hitl_required.`,
    );
    escalation = await updateEscalation(escalation.id, {
      status: "hitl_required",
      resolutionNotes: `Budget cap exceeded: cumulative $${cumulativeCost.toFixed(4)} + next-call estimate $${NEXT_ORCHESTRATOR_CALL_ESTIMATE_USD} > $${PER_SHOT_HARD_CAP_USD}`,
    });
    runEvents.emit(`escalation:${runId}`, escalation);
    return {
      outcome: "hitl_required",
      escalation,
      decision: _nullDecision(),
      newPrompts: null,
    };
  }

  // Rule 1 — if the QA verdict carries a consensus_note set by brand-engine's
  // grade_video_with_consensus, treat it as post-consensus and surface that
  // fact to the orchestrator so it doesn't second-guess the verdict. Single-
  // call results from legacy callers (consensus=false) land here with no
  // consensus_note → consensusResolved stays undefined/false.
  const consensusResolved = Boolean(
    (qaVerdict as { consensus_note?: string | null } | undefined)?.consensus_note,
  );
  if (consensusResolved) {
    await logger(
      "info",
      `QA verdict carries consensus_note — passing consensusResolved=true to orchestrator`,
    );
  }

  // ── Chunk 1: narrative envelope ────────────────────────────────────────
  // Per-shot NarrativeContext lives on artifact.metadata.narrative_context
  // (written by os-api/scripts/ingest-drift-mv-narrative.ts). Campaign-level
  // MusicVideoContext lives on campaign.guardrails.music_video_context. Both
  // optional — non-music-video campaigns fall through to baseline behavior.
  const narrativeContext = _extractNarrativeContext(artifact);
  const musicVideoContext = _extractMusicVideoContext(campaign);
  if (narrativeContext) {
    await logger(
      "info",
      `Narrative envelope present: shot ${narrativeContext.shot_number} (${narrativeContext.beat_name}), ` +
        `allowances=${narrativeContext.stylization_allowances.length}`,
    );
  }

  // ── Chunk 3 follow-up: per-production QA threshold short-circuit ────────
  // Path C of plan fresh-context-today-is-glowing-harp.md (2026-04-23).
  // When the campaign has a `qa_threshold` guardrail AND the critic score is
  // in the borderline band [accept_threshold, pass_threshold) AND no detected
  // failure class has severity=blocking → flip to a rule-based L3 accept
  // decision without calling Claude. Preserves audit trail (decision row is
  // recorded with model="rule-based") and orchestrator prompt is untouched
  // (Chunk 1 lock held).
  const qaThreshold = _extractQAThreshold(campaign);
  const borderline = _maybeBorderlineAccept(qaVerdict, qaThreshold, catalog);
  if (borderline) {
    await logger(
      "info",
      `Borderline-accept short-circuit: score=${borderline.score} in [${qaThreshold!.accept_threshold}, ${qaThreshold!.pass_threshold}), no blocking failure class → rule-based L3 accept`,
    );
    const ruleDecision: OrchestratorDecision = {
      level: "L3",
      action: "accept",
      failure_class: borderline.failureClass,
      known_limitation_id: null,
      new_still_prompt: null,
      new_veo_prompt: null,
      new_negative_prompt: null,
      redesign_option: null,
      reasoning:
        `borderline-accept per campaign qa_threshold: score=${borderline.score} ` +
        `in [${qaThreshold!.accept_threshold}, ${qaThreshold!.pass_threshold}) ` +
        `with no blocking failure class (detected=${borderline.detectedClasses.length ? borderline.detectedClasses.join(",") : "none"})`,
      confidence: 1.0,
      new_candidate_limitation: null,
    };
    const iter = escalation.iterationCount + 1;
    await recordOrchestrationDecision({
      escalationId: escalation.id,
      runId,
      iteration: iter,
      inputContext: {
        artifactId: artifact.id,
        deliverableId,
        attemptCount: escalation.iterationCount,
        escalationLevel: escalation.currentLevel,
        qaVerdict,
        qaThreshold,
        shortCircuit: "borderline_accept",
      },
      decision: ruleDecision as unknown as Record<string, unknown>,
      model: "rule-based",
      tokensIn: 0,
      tokensOut: 0,
      cost: 0,
      latencyMs: 0,
    });
    escalation = await updateEscalation(escalation.id, {
      currentLevel: "L3",
      iterationCount: iter,
      failureClass: borderline.failureClass ?? undefined,
      resolutionPath: "accept",
    });
    escalation = await resolveEscalation(escalation.id, "accepted", ruleDecision.reasoning);
    runEvents.emit(`escalation:${runId}`, escalation);
    return {
      outcome: "accepted",
      escalation,
      decision: ruleDecision,
      newPrompts: null,
    };
  }

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
      todayDate,
      perShotCumulativeCost: cumulativeCost,
      consecutiveSamePromptRegens: consecutiveSameRegens,
      levelsUsed,
      consensusResolved,
      narrativeContext,
      musicVideoContext,
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
  if (decision.action === "accept" || decision.action === "post_vfx") {
    // post_vfx reuses `accepted` status + resolution_path = "post_vfx" metadata
    // per 10a decision. Compositor instructions live in decision.reasoning.
    const resolutionNotes = decision.action === "post_vfx"
      ? `[POST_VFX_FLAG] Accept clip as-is; flag for compositor. ${decision.reasoning}`
      : decision.reasoning;
    escalation = await resolveEscalation(escalation.id, "accepted", resolutionNotes);
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

// ── Watcher-signal helpers (Rule 5 derivations) ───────────────────────────

function _todayISO(): string {
  // YYYY-MM-DD — what we inject into orchestrator's user message
  return new Date().toISOString().slice(0, 10);
}

// Exported for unit tests (`_10d-escalation-history.ts`) so the bug #3 fix
// invariants are assertable against hand-crafted OrchestrationDecisionRecord
// arrays without round-tripping Supabase.
export function _sumCost(decisions: OrchestrationDecisionRecord[]): number {
  let total = 0;
  for (const d of decisions) total += d.cost ?? 0;
  return total;
}

export function _collectLevels(decisions: OrchestrationDecisionRecord[]): EscalationLevel[] {
  const out: EscalationLevel[] = [];
  for (const d of decisions) {
    const level = (d.decision as { level?: string } | null)?.level;
    if (level === "L1" || level === "L2" || level === "L3") out.push(level);
  }
  return out;
}

/**
 * Count the number of consecutive prior decisions (from the tail) that proposed
 * a near-identical prompt. Used by Rule 5 to detect "stuck loop" and by human
 * watchers via the SSE stream. Normalization: lowercase, collapse whitespace.
 *
 * Returns 0 when there's <2 decisions to compare, or when the most recent
 * decision's prompt differs from the one before it.
 */
export function _countConsecutiveSamePromptRegens(
  decisions: OrchestrationDecisionRecord[],
): number {
  if (decisions.length < 2) return 0;
  // Pull prompt fingerprint from each decision (still || veo, normalized).
  const fingerprints = decisions
    .map((d) => {
      const dec = d.decision as { new_still_prompt?: string | null; new_veo_prompt?: string | null } | null;
      const still = dec?.new_still_prompt ?? "";
      const veo = dec?.new_veo_prompt ?? "";
      return _normalizePrompt(still + "||" + veo);
    });
  // Walk backward from tail; count consecutive matches against the last one.
  const last = fingerprints[fingerprints.length - 1];
  if (!last) return 0;
  let count = 0;
  for (let i = fingerprints.length - 2; i >= 0; i--) {
    if (fingerprints[i] === last) count += 1;
    else break;
  }
  // Return count of duplicates BEHIND the current — the "current" makes N+1 total.
  // For Rule 5 we want "last N were identical", so we return count + 1 when there
  // was at least one match (i.e., last two are equal). When no match, 0.
  return count > 0 ? count + 1 : 0;
}

function _normalizePrompt(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
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

// ── Chunk 1: narrative envelope extraction ─────────────────────────────────
// These helpers dig NarrativeContext + MusicVideoContext out of the JSONB
// columns populated by os-api/scripts/ingest-drift-mv-narrative.ts. Defensive
// against missing/malformed envelopes — returns undefined so orchestrator
// falls back to the baseline prompt.

/** Shape guard — returns true when the value looks like a NarrativeContext. */
function _isNarrativeContext(v: unknown): v is NarrativeContext {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.shot_number === "number" &&
    typeof o.beat_name === "string" &&
    typeof o.visual_intent === "string" &&
    Array.isArray(o.stylization_allowances)
  );
}

function _isMusicVideoContext(v: unknown): v is MusicVideoContext {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.title === "string" &&
    typeof o.synopsis === "string" &&
    Array.isArray(o.shot_list_summary)
  );
}

export function _extractNarrativeContext(
  artifact: Artifact,
): NarrativeContext | undefined {
  const meta = artifact.metadata;
  if (!meta || typeof meta !== "object") return undefined;
  const nc = (meta as Record<string, unknown>).narrative_context;
  return _isNarrativeContext(nc) ? nc : undefined;
}

export function _extractMusicVideoContext(
  campaign: Campaign | null,
): MusicVideoContext | undefined {
  if (!campaign) return undefined;
  const g = campaign.guardrails;
  if (!g || typeof g !== "object") return undefined;
  const mvc = (g as Record<string, unknown>).music_video_context;
  return _isMusicVideoContext(mvc) ? mvc : undefined;
}

// ── Chunk 3 follow-up: QA threshold (Path C) ──────────────────────────────
// Reads `campaign.guardrails.qa_threshold` and extracts the borderline-accept
// policy. Feature is opt-in per campaign — when the field is absent or
// malformed, returns undefined and the escalation loop falls through to the
// Claude-backed decision path.

export function _extractQAThreshold(
  campaign: Campaign | null,
): QAThreshold | undefined {
  if (!campaign) return undefined;
  const g = campaign.guardrails;
  if (!g || typeof g !== "object") return undefined;
  const t = (g as Record<string, unknown>).qa_threshold;
  if (!t || typeof t !== "object") return undefined;
  const pass = (t as Record<string, unknown>).pass_threshold;
  const accept = (t as Record<string, unknown>).accept_threshold;
  if (typeof pass !== "number" || typeof accept !== "number") return undefined;
  if (!Number.isFinite(pass) || !Number.isFinite(accept)) return undefined;
  // Sanity: accept must be strictly below pass; otherwise the threshold
  // degenerates (band is empty or inverted). Disable the feature.
  if (accept >= pass) return undefined;
  return { pass_threshold: pass, accept_threshold: accept };
}

/**
 * Evaluate whether a QA verdict should short-circuit to a rule-based L3
 * `accept` decision under the per-production threshold policy.
 *
 * Returns the short-circuit payload when ALL of:
 *   - a valid QAThreshold exists on the campaign
 *   - the verdict carries a numeric aggregate_score
 *   - score is in the borderline band `[accept_threshold, pass_threshold)`
 *   - no detected_failure_class has severity=blocking in the known_limitations
 *     catalog (blocking classes always fall through to Claude)
 *
 * Returns null otherwise. Null means "let the Claude path decide."
 *
 * Note: we intentionally pass through when `score >= pass_threshold` — the
 * critic already said PASS and the escalation loop shouldn't even be running.
 * If it IS running at that score, something upstream is confused; letting
 * Claude decide surfaces the anomaly rather than masking it with a rule.
 */
export function _maybeBorderlineAccept(
  qaVerdict: VideoGradeResult | Record<string, unknown>,
  threshold: QAThreshold | undefined,
  catalog: KnownLimitation[],
): { score: number; failureClass: string | null; detectedClasses: string[] } | null {
  if (!threshold) return null;
  const v = qaVerdict as VideoGradeResult & { aggregate_score?: unknown };
  const score = typeof v.aggregate_score === "number" ? v.aggregate_score : null;
  if (score === null || !Number.isFinite(score)) return null;
  if (score < threshold.accept_threshold) return null; // too low — Claude decides
  if (score >= threshold.pass_threshold) return null;  // already PASS — no-op

  const detected = Array.isArray(v.detected_failure_classes)
    ? v.detected_failure_classes.filter((x): x is string => typeof x === "string")
    : [];
  // Blocking-severity classes always fall through to Claude even on borderline
  // scores — these are failure modes where prompt-engineering can't fix the
  // clip (e.g., atmospheric_creep_fire_smoke_aerial). Don't auto-accept.
  for (const fc of detected) {
    const match = catalog.find((k) => k.failureMode === fc);
    if (match?.severity === "blocking") return null;
  }
  return {
    score,
    failureClass: detected[0] ?? null,
    detectedClasses: detected,
  };
}
