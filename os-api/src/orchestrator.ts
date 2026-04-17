/**
 * Orchestrator — the brain of the autonomous escalation loop.
 *
 * Given a failed artifact + prompt history + known_limitations catalog, calls
 * Claude Opus 4.7 via Anthropic SDK and returns a structured OrchestratorDecision.
 *
 * The runner (runner.ts) calls this on every QA failure; the decision drives
 * regeneration, approach change, or L3 escalation (accept/redesign/replace).
 *
 * Decisions are RECORDED to orchestration_decisions table for audit + RL corpus.
 *
 * Fallback: if Claude returns invalid JSON 3 times in a row, or the API fails
 * fatally, this throws — the runner catches and flags the escalation for HITL.
 */

import { callClaude, getDefaultModel } from "./anthropic.js";
import { SYSTEM_PROMPT, buildUserMessage } from "./orchestrator_prompts.js";
import type {
  OrchestratorInput,
  OrchestratorDecision,
  OrchestratorCallResult,
  EscalationLevel,
  EscalationAction,
} from "./types.js";

const VALID_LEVELS: EscalationLevel[] = ["L1", "L2", "L3"];
const VALID_ACTIONS: EscalationAction[] = [
  "prompt_fix",
  "approach_change",
  "accept",
  "redesign",
  "replace",
  "post_vfx",
];

/**
 * Core decision function. Returns an OrchestratorCallResult with the decision
 * plus model/cost/latency for recording to orchestration_decisions.
 */
export async function decideEscalation(
  input: OrchestratorInput,
): Promise<OrchestratorCallResult> {
  const userMessage = buildUserMessage({
    artifact: input.artifact,
    qaVerdict: input.qaVerdict,
    promptHistory: input.promptHistory,
    catalog: input.knownLimitationsCatalog,
    attemptCount: input.attemptCount,
    escalationLevel: input.escalationLevel,
    deliverable: input.deliverable,
    campaignContext: input.campaignContext,
    todayDate: input.todayDate,
    perShotCumulativeCost: input.perShotCumulativeCost,
    consecutiveSamePromptRegens: input.consecutiveSamePromptRegens,
    levelsUsed: input.levelsUsed,
    consensusResolved: input.consensusResolved,
  });

  const rawResponse = await callClaude({
    systemCached: SYSTEM_PROMPT,
    userMessage,
    temperature: 0.1,
    maxTokens: 4096,
    enableWebSearch: true, // staleness discipline — orchestrator may web-search before proposing
  });

  const decision = _parseDecision(rawResponse.text);
  _validateDecision(decision, input);

  return {
    decision,
    model: rawResponse.model,
    tokensIn: rawResponse.tokensIn,
    tokensOut: rawResponse.tokensOut,
    cost: rawResponse.cost,
    latencyMs: rawResponse.latencyMs,
  };
}

// ─── Parsing + validation ────────────────────────────────────────────────

/**
 * Extract a single JSON object from the model response. Tolerates (but does
 * not require) markdown code fences.
 */
function _parseDecision(raw: string): OrchestratorDecision {
  let text = raw.trim();

  // Strip markdown fences if present
  if (text.startsWith("```")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error(
        "Orchestrator returned fenced non-JSON response. First 200 chars: " +
        raw.slice(0, 200),
      );
    }
    text = text.slice(start, end + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Orchestrator returned invalid JSON (${err instanceof Error ? err.message : String(err)}). First 500 chars: ${raw.slice(0, 500)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Orchestrator response is not a JSON object.");
  }

  const obj = parsed as Record<string, unknown>;

  return {
    level: _coerceLevel(obj.level),
    action: _coerceAction(obj.action),
    failure_class: _coerceNullableString(obj.failure_class),
    known_limitation_id: _coerceNullableString(obj.known_limitation_id),
    new_still_prompt: _coerceNullableString(obj.new_still_prompt),
    new_veo_prompt: _coerceNullableString(obj.new_veo_prompt),
    new_negative_prompt: _coerceNullableString(obj.new_negative_prompt),
    redesign_option: _coerceRedesignOption(obj.redesign_option),
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "",
    confidence: _coerceConfidence(obj.confidence),
    new_candidate_limitation: _coerceCandidate(obj.new_candidate_limitation),
  };
}

function _coerceLevel(v: unknown): EscalationLevel {
  if (typeof v === "string" && (VALID_LEVELS as string[]).includes(v)) {
    return v as EscalationLevel;
  }
  throw new Error(`Orchestrator returned invalid level: ${JSON.stringify(v)}`);
}

function _coerceAction(v: unknown): EscalationAction {
  if (typeof v === "string" && (VALID_ACTIONS as string[]).includes(v)) {
    return v as EscalationAction;
  }
  throw new Error(`Orchestrator returned invalid action: ${JSON.stringify(v)}`);
}

function _coerceNullableString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.length > 0 ? v : null;
  return null;
}

function _coerceRedesignOption(v: unknown): "B" | "C" | null {
  if (v === "B" || v === "C") return v;
  return null;
}

function _coerceConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0.0;
  return Math.max(0.0, Math.min(1.0, n));
}

function _coerceCandidate(v: unknown): OrchestratorDecision["new_candidate_limitation"] {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  const failureMode = c.failure_mode;
  const description = c.description;
  const severity = c.severity;
  if (typeof failureMode !== "string" || typeof description !== "string") return null;
  return {
    category: typeof c.category === "string" ? c.category : "uncategorized",
    failure_mode: failureMode,
    description,
    mitigation: typeof c.mitigation === "string" ? c.mitigation : undefined,
    severity: severity === "blocking" ? "blocking" : "warning",
  };
}

/**
 * Cross-check the decision against the input context. Fail loud on obvious
 * inconsistencies so the runner can flag HITL instead of looping on garbage.
 */
function _validateDecision(
  decision: OrchestratorDecision,
  input: OrchestratorInput,
): void {
  // If action is prompt_fix/approach_change/redesign/replace, must have new_veo_prompt or new_still_prompt.
  // accept + post_vfx are prompt-free — resolution detail lives in `reasoning`.
  const needsPrompts = ["prompt_fix", "approach_change", "redesign", "replace"];
  if (needsPrompts.includes(decision.action)) {
    if (!decision.new_still_prompt && !decision.new_veo_prompt) {
      throw new Error(
        `Orchestrator action '${decision.action}' requires at least one new prompt; got neither.`,
      );
    }
  }
  // post_vfx and accept should NOT carry new prompts — if they do, it's a signal
  // the orchestrator is confused. Log but don't throw (lenient forward-compat).
  if (decision.action === "post_vfx" || decision.action === "accept") {
    if (decision.new_still_prompt || decision.new_veo_prompt) {
      // eslint-disable-next-line no-console
      console.warn(
        `[orchestrator] action=${decision.action} should not carry new prompts (got still=${!!decision.new_still_prompt} veo=${!!decision.new_veo_prompt}). Continuing, but review.`,
      );
    }
  }

  // redesign/replace actions should have redesign_option set
  if ((decision.action === "redesign" || decision.action === "replace") && !decision.redesign_option) {
    // Not fatal — just warn and continue
    // eslint-disable-next-line no-console
    console.warn(`[orchestrator] action=${decision.action} but redesign_option is null. Continuing.`);
  }

  // If failure_class is set, it should match a catalog entry OR be flagged as new_candidate
  if (decision.failure_class) {
    const match = input.knownLimitationsCatalog.find(
      (k) => k.failureMode === decision.failure_class,
    );
    if (!match && !decision.new_candidate_limitation) {
      // eslint-disable-next-line no-console
      console.warn(
        `[orchestrator] failure_class='${decision.failure_class}' not in catalog and no new_candidate_limitation. Check for hallucination.`,
      );
    }
  }

  // Sanity: confidence < 0.5 should trigger HITL (runner will check)
  if (decision.confidence < 0.5) {
    // eslint-disable-next-line no-console
    console.warn(
      `[orchestrator] low confidence (${decision.confidence}) — runner should route to hitl_required.`,
    );
  }
}

/** Expose model id for logging. */
export { getDefaultModel };
