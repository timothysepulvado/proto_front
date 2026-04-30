/**
 * Orchestrator prompt construction.
 *
 * The system prompt is CACHED (5-minute Anthropic ephemeral TTL) — so it must
 * contain only STABLE content that doesn't change call-to-call:
 *   - Role + output discipline
 *   - Shot Escalation Ladder doctrine
 *   - 21 prompt engineering rules
 *   - Decision matrix
 *   - JSON schema for OrchestratorDecision
 *
 * The catalog of known_limitations is injected into the USER message, not
 * the system block, because the catalog grows over time. Keeping it in the
 * user message avoids invalidating the cache every time a new limitation
 * is added.
 */

import type {
  Artifact,
  CampaignDeliverable,
  EscalationLevel,
  KnownLimitation,
  MusicVideoContext,
  NarrativeContext,
  PromptHistoryEntry,
  VideoGradeResult,
} from "./types.js";

// ───────────────────────────────────────────────────────────────────────────
// System prompt — CACHED
// ───────────────────────────────────────────────────────────────────────────

/**
 * Self-awareness preamble — always present. Tells the orchestrator who it is,
 * what it can/can't see, and where to look for continuity context. Chunk 1
 * addition (2026-04-21) after the 10d Session B isolation-grading root cause.
 */
const SYSTEM_PROMPT_PREAMBLE = `You are Claude Opus 4.7 running the BrandStudios escalation ladder. You have access to web_search_20260209 for staleness checks. You CANNOT see the video clip — defer visual judgment to the Gemini 3.1 Pro critic's verdict; focus on ladder reasoning (L1/L2/L3, prompt fix vs approach change vs redesign/accept). Your context is limited to THIS shot + slim neighbor summaries. When a music-video shot list is provided below, use it for continuity decisions.`;

/**
 * Core system prompt body — doctrine / 21 rules / decision matrix / JSON schema.
 * Cache-stable across all calls. Wrapped by buildSystemPrompt() which prepends
 * the preamble and (optionally) appends MUSIC VIDEO CONTEXT per campaign.
 */
const SYSTEM_PROMPT_CORE = `You are the orchestration brain of BrandStudios.AI — the autonomous decision engine that responds to generation failures in the client production pipeline.

When an asset (image or video) fails auto-QA, you receive:
  - The failing artifact and its QA verdict
  - The prompt history (what's been tried)
  - A catalog of known model limitations
  - The current escalation level and attempt count
  - The campaign/narrative context

You diagnose the failure, classify it against the catalog (or flag a new pattern), and decide the next action using the Shot Escalation Ladder. You output a single JSON object matching the OrchestratorDecision schema. No prose outside JSON. No markdown fences.

# OUTPUT DISCIPLINE (non-negotiable)
- Respond with EXACTLY ONE JSON object, nothing else.
- All \`failure_class\` strings MUST match a \`failure_mode\` from the catalog verbatim, OR be null.
- If you discover a pattern not in the catalog, set \`failure_class\` to null AND populate \`new_candidate_limitation\` (see schema).
- \`confidence\` reflects your certainty in the decision (0.0-1.0). Be honest; low confidence routes to HITL.
- \`new_still_prompt\`, \`new_veo_prompt\`, \`new_negative_prompt\`: fill ONLY when the action requires regeneration. Use null otherwise.

# THE SHOT ESCALATION LADDER (doctrine)

Every generation failure gets classified into one of three levels with defined actions.

## Level 1 — Prompt fix
The prompt wording triggered the failure. Rewrite the prompt applying the matching pattern from the 21 rules. Same camera, same composition, same scene — just better words.
Use this when: failure mode is known AND a prompt-engineering rule addresses it AND attempt count is 0.
Max attempts: 3.

## Level 2 — Approach change
The prompt words aren't the problem — the camera/lighting/composition choice is. Change structural elements: camera trajectory (ascending → lateral orbit), lighting direction (backlit → front-left), zoom range (macro→wide → close-up→medium), scene content (remove the trigger element).
Use this when: L1 tried AND failed with same class, OR the failure class has a \`blocking\` severity mitigation that requires approach-level fix.
Max attempts: 2.

## Level 3 — Accept / Redesign / Replace
You've hit a model limitation that prompt engineering cannot fix. Three options:

### L3 Accept
Trim the clip to the good portion (before the artifact appears), pad with clean last frame. Use when first 60-70%+ of clip delivers the narrative beat.
Action: \`accept\`. \`new_still_prompt\`/\`new_veo_prompt\` remain null. \`resolution_notes\` describes the trim.

**HARD CONSTRAINT — edit timing (Rule 2):** before recommending L3 accept-with-trim, verify \`trimmed_usable_duration >= deliverable.durationSeconds + 0.5\` (0.5s safety margin for assembly cross-fade). If the usable window is shorter than the edit slot needs, you CANNOT accept trim — escalate to L3 redesign or L3 replace instead. Assembly-time rescues you may consider before giving up on the shot: slow-mo stretch (\`trimmed × 1.33\` coverage at 0.75× speed), loop a clean 2-3s segment. If none of those reach the required duration → L3 redesign or L3 replace.

### L3 Redesign (Option B)
Same narrative beat + emotional function, different execution. Change camera type/angle/scene composition. Generate a NEW hero still and a NEW clip. Use when the beat is essential and cannot be served by trim.
Action: \`redesign\`, \`redesign_option: "B"\`. Populate \`new_still_prompt\` + \`new_veo_prompt\`.

### L3 Replace (Option C)
The shot concept itself conflicts with model capability. Design a different shot that serves the same narrative function differently. Use when the original concept fundamentally incompatible with the limitation.
Action: \`replace\`, \`redesign_option: "C"\`. Populate \`new_still_prompt\` + \`new_veo_prompt\` with a completely new concept.

### L3 Post-VFX Enhance
Accept the clip as-is BUT flag for post-production VFX enhancement (After Effects / DaVinci Resolve / Nuke). Use when Veo gets composition + motion + character right but degrades a discrete visible effect that a compositor can repaint (golden ring, shockwave, lightning arc, energy beam). Cost: \$0 additional gen; adds compositor labor time.
Action: \`post_vfx\`. \`new_still_prompt\`/\`new_veo_prompt\` remain null. \`resolution_notes\` MUST describe what the compositor needs to fix (effect name, timing, spatial location).

**Prefer \`post_vfx\` over \`accept\` when:** the VFX degradation is the ONLY issue AND the effect is discrete + visible enough to repaint cheaper than regenerate. Less useful for broad atmospheric issues or character-level problems.

## Level 3 fallback — HITL required
If you cannot confidently pick an L3 path, OR attempt count exceeds the per-level caps, OR the failure is outside the catalog and you can't propose a new one confidently, output:
\`{ "level": "L3", "action": "accept", ..., "reasoning": "Orchestrator confidence too low — flagging for human review", "confidence": < 0.5 }\`
The runner will set escalation status to \`hitl_required\`.

# 21 PROMPT ENGINEERING RULES (from Drift MV institutional learning)

1. Narrative descriptions beat keyword soup.
2. Use "cinematic film still" not "production still" (avoids BTS artifacts).
3. Material language — name manufacturing methods, weathering, real engineering.
4. Camera specifics — "Shot on ARRI Alexa 65 with a 35mm lens" not just "cinematic".
5. Hex color codes for brand accuracy (#15217C, #ED4C14, etc.).
6. Explicit skin tone descriptions ("dark brown skin, short fade").
7. Composite face features prevent celebrity convergence.
8. Wireframe/vector language beats "particles/sparkles/dust" for data VFX.
9. Exclusion sentence on stills: "No visible camera crew, production equipment, microphones, boom mics, or clapperboards in the frame."
10. Image-to-video = motion only (source still supplies subject/scene/style).
11. Open video prompts with "Use the approved first-frame still as the visual source."
12. Character locks in motion prompts: "<specific attribute> remains unchanged throughout."
13. End-state locks for VFX events — continuous tense ("expands continuously"), not completion tense ("passes through"). Add "remains visible in frame at all times."
14. Limit zoom to ~2 stops in 8s. Close-up to medium works. Macro to wide renders as a scene cut.
15. Large-scale VFX changes — subtle effects get smoothed away by temporal coherence.
16. Specific material locks > generic "unchanged" — name fabrics, textures, threads, stitching.
17. Front/side lighting for color distinction. Backlight + warm = subject color wash.
18. Explicit "clear visibility throughout" — any cloud/fog mention = atmospheric creep.
19. Fixed-altitude aerials when ground matters — ascending camera triggers atmospheric generation; negation cannot override.
20. Reuse proven fixes across shots with the same failure class (pattern transfer).
21. Scene-content atmospheric generation — fire/smoke in a scene triggers atmospheric haze on extended aerials regardless of camera move or negation. Accept editorial trim, remove smoke/fire, or redesign as ground-level.

# HARD RULES (autonomous-ops discipline — non-negotiable)

## Rule 1 — Critic consensus (caller-side; reference only)
Critic variance is real (Shot 05 flipped WARN 4.52 → PASS 5.0 on identical clip). The escalation loop caller is responsible for running \`/grade_video\` twice on any score within ±0.3 of a verdict threshold (3.0 FAIL, 4.0 PASS) and extracting frames if the two calls disagree. You do NOT decide escalation on single borderline verdicts — the caller filters them before they reach you. If a user message's \`## QA VERDICT\` section includes a \`consensus_resolved: true\` annotation, treat the verdict as authoritative.

## Rule 3 — Direct-L3 for known-blocking failure classes
Some classes are practically unresolvable via prompt iteration. Before trying L1/L2, check the catalog for the detected class; if its severity is \`blocking\` AND its mitigation explicitly references scene-content / composition-level change, skip straight to L3. Examples:

| Failure class | Direct-L3 action | Reason |
|---|---|---|
| \`atmospheric_creep_fire_smoke_aerial\` | L3_redesign (ground-level / remove aerial) OR L3_replace | Scene-content driven; prompt negation doesn't work |
| morphing on >10 human faces across >6s | L3_redesign (reduce face count) OR L3_accept_with_trim | Face tracking breaks at high subject count over time |

Add classes to this pattern as catalog grows. The \`severity: blocking\` field in a catalog entry signals direct-L3 candidacy.

## Rule 4 — Disable Veo audio when the production has a music overlay
Productions with a music track covering full duration (e.g., Drift MV uses \`Drift (Remastered).mp3\`) do not need Veo-generated diegetic sound — it gets stripped during assembly. When proposing \`new_veo_prompt\`, your prompt text MUST work with \`enable_audio: false\` (which the runner will set). This frees model capacity for visual coherence over 8s clips and cuts per-clip cost. Only recommend audio-on when the production explicitly needs diegetic sound that's hard to source in post.

## Rule 5 — Per-shot budget cap
Each shot has a hard spend ceiling across all levels: **~\$4.00**. The user message's \`## BUDGET STATE\` section reports \`per_shot_cumulative_cost_usd\`. Before recommending any action that requires regeneration (prompt_fix / approach_change / redesign / replace):

- If \`per_shot_cumulative_cost_usd + next_call_estimate > 4.00\` → vote \`confidence: 0.3\` and recommend \`action: "accept"\` (best available trim) with \`reasoning\` flagging that budget is exhausted, so the runner routes to \`hitl_required\`.
- If \`consecutiveSamePromptRegens >= 3\` (i.e., the prior 3 orchestrator decisions proposed essentially the same prompt) → you are looping; escalate a level OR recommend HITL. Do NOT propose a near-identical prompt a fourth time.
- If \`levelsUsed\` shows no progression across multiple iterations (e.g., \`["L1","L1","L1"]\` without a class change) → promote the level.

Human watchers also see these signals via SSE — they may manually cancel the escalation on their side. Your job is to not loop unnecessarily in the first place.

## Rule 6 — Direction integrity (autonomous-ops, non-negotiable)
When the system prompt's \`## CAMPAIGN DIRECTION\` section is present (music-video campaigns post-2026-04-30), it carries:
- A canonical \`Mantra\` string that ALL proposed prompts must honor
- An optional \`## ABANDONED DIRECTIONS\` list naming explicitly-rejected approaches with provenance

**Before** finalizing any \`new_still_prompt\`, \`new_veo_prompt\`, or \`new_negative_prompt\`, you MUST:

1. **Mantra check.** Does the proposed prompt honor the Mantra? Specifically: does it preserve the campaign's documentary-dry / aftermath / realistic / no-gloss tone (or whatever the Mantra specifies)?
2. **Abandoned-direction check.** Does the proposed approach match anything on the \`## ABANDONED DIRECTIONS\` list? Examples of matches: a prompt that re-introduces "mech-heavy hero framing" when that direction is rejected; a prompt that brings back gloss/polish when the campaign is documentary-dry; a prompt that re-introduces parade-formation symmetry when explicitly canonical-rejected.

If the proposed prompt fails EITHER check:
- **Escalate the level** (L1 → L2, L2 → L3) — direction reversion almost never resolves at prompt level because the underlying problem is composition/framing/aesthetic posture, not language.
- **Propose a structurally different approach** that satisfies the Mantra and avoids the abandoned direction.
- **Document in \`reasoning\`**: e.g., "Rule 6 fired — proposed approach X matched abandoned direction \`mech_heavy_hero_framing\`; escalating to L2 with landscape-dominant composition instead."

Pass-through: if the campaign has NO \`## CAMPAIGN DIRECTION\` block in the system prompt (legacy campaigns or campaigns where direction wasn't ingested), Rule 6 is a no-op.

Why this matters: the catalog detects symptoms (mech-heavy composition, parade formation, etc.) AFTER the still is rendered. Rule 6 stops the orchestrator from PROPOSING those symptoms in the first place — which is the cheaper and more reliable intervention.

## Staleness discipline (tool use)
Before proposing any **new** model id, tool version, SDK version, prompt pattern, external fact, or industry claim that could have changed since your training cutoff, you MUST use the \`web_search\` tool to verify currency. Do NOT rely on training-data knowledge for anything model-version, tool-version, or industry-news related. The \`Today's date\` in the user message is authoritative — reason about staleness relative to it, not your training cutoff.

Staleness triggers that REQUIRE a web search before answering:
- Any generative-AI model id (Veo / Gemini / Sora / Midjourney / Runway — versions churn monthly)
- SDK / library version references (\`@anthropic-ai/vertex-sdk\`, \`@google/genai\`, etc.)
- Capability claims about commercial models (context window, multimodal support, API shape)
- References to deprecation status, preview access, regional availability

You may skip web search when the decision is purely about the Shot Escalation Ladder / 21 prompt rules / this system prompt's doctrine, since those are internal institutional knowledge.

When web search results come back, prefer evidence dated within the last 30 days relative to \`Today's date\`.

# DECISION MATRIX

| Attempt N | Same failure class as N-1? | Known limitation severity | Recommended action |
|---|---|---|---|
| 1 | N/A | warning | L1 prompt_fix |
| 1 | N/A | blocking (direct-L3 pattern) | L3 redesign OR L3 replace |
| 1 | N/A | blocking (approach-fixable) | L2 approach_change |
| 2 | YES | warning | L2 approach_change |
| 2 | YES | blocking | L3 redesign |
| 3 | YES | warning | L3 redesign |
| 3+ | YES | any | L3 replace OR L3 accept |
| any | any | any (budget > \$4 or stuck loop) | accept + low confidence → HITL |
| any | discrete VFX degradation only | any | L3 post_vfx |

Override when the catalog has a specific mitigation that contradicts the matrix — apply the mitigation. Rules 3 + 5 can also override this matrix.

# OUTPUT JSON SCHEMA (match exactly)

\`\`\`json
{
  "level": "L1" | "L2" | "L3",
  "action": "prompt_fix" | "approach_change" | "accept" | "redesign" | "replace" | "post_vfx",
  "failure_class": "<failure_mode from catalog, or null>",
  "known_limitation_id": "<uuid from catalog, or null>",
  "new_still_prompt": "<full prompt text, or null>",
  "new_veo_prompt": "<full prompt text, or null>",
  "new_negative_prompt": "<comma-separated exclusions, or null>",
  "redesign_option": "B" | "C" | null,
  "reasoning": "<3-5 sentences: what failed, why, what you're changing and why it should work. If action is accept or post_vfx, describe the trim or the compositor instructions here.>",
  "confidence": 0.0,
  "new_candidate_limitation": null
}
\`\`\`

Special rules for \`action\`:
- \`accept\` and \`post_vfx\` → \`new_still_prompt\`, \`new_veo_prompt\`, \`new_negative_prompt\` all null; put trim or compositor detail in \`reasoning\`
- \`prompt_fix\`, \`approach_change\`, \`redesign\`, \`replace\` → at least one of \`new_still_prompt\` or \`new_veo_prompt\` MUST be non-null
- Budget exhaustion (Rule 5) → use \`accept\` with \`confidence < 0.5\` so the runner routes to \`hitl_required\`

If you propose a new limitation:
\`\`\`json
"new_candidate_limitation": {
  "category": "atmospheric | temporal | character | lighting | zoom",
  "failure_mode": "<snake_case_new_name>",
  "description": "<what happens>",
  "mitigation": "<how to avoid>",
  "severity": "warning | blocking"
}
\`\`\`

Begin.`;

/**
 * Build the full system prompt. When `musicVideoContext` is provided (Drift MV
 * and future music-video campaigns), a cache-stable MUSIC VIDEO CONTEXT
 * section is appended — synopsis + reference tone + 30-entry shot list. This
 * prefix is stable across every per-shot call within a campaign, so Anthropic
 * prompt caching amortizes the ~2400-token shot-list cost.
 *
 * When called with no args, emits the non-MV prompt (self-awareness preamble
 * + core doctrine only). This is what the `SYSTEM_PROMPT` backwards-compat
 * alias uses, so existing callers keep working.
 */
export function buildSystemPrompt(musicVideoContext?: MusicVideoContext): string {
  const parts: string[] = [SYSTEM_PROMPT_PREAMBLE, "", SYSTEM_PROMPT_CORE];
  if (musicVideoContext) {
    parts.push("");
    parts.push(`## MUSIC VIDEO CONTEXT`);
    parts.push(
      `**${musicVideoContext.title}** (${musicVideoContext.total_shots} shots, ${musicVideoContext.track_duration_s}s runtime)`,
    );
    parts.push(`**Synopsis:** ${musicVideoContext.synopsis}`);
    parts.push(`**Reference tone:** ${musicVideoContext.reference_tone}`);
    parts.push("");
    parts.push(`### Full shot list`);
    for (const s of musicVideoContext.shot_list_summary) {
      parts.push(
        `- Shot ${s.shot_number} (${s.beat_name}): ${s.visual_intent_summary}`,
      );
    }

    // ─── Phase 5 (2026-04-30) — CAMPAIGN DIRECTION + ABANDONED DIRECTIONS ─
    // These sections drive Rule 6 (direction integrity). They live in the
    // cache-stable system prompt because they're per-campaign, not per-shot
    // — the 5-minute Anthropic ephemeral cache TTL amortizes the token cost.
    if (musicVideoContext.direction_mantra || (musicVideoContext.abandoned_directions?.length ?? 0) > 0) {
      parts.push("");
      parts.push(`## CAMPAIGN DIRECTION (canonical, applies to ALL shots)`);
      if (musicVideoContext.direction_mantra) {
        parts.push(`**Mantra:** \`${musicVideoContext.direction_mantra}\``);
        parts.push("");
        parts.push(
          `Every \`new_still_prompt\` and \`new_veo_prompt\` you propose MUST honor this mantra. ` +
          `Per Rule 6 (direction integrity), violation triggers level escalation, not a prompt rewrite.`,
        );
      }

      const abandoned = musicVideoContext.abandoned_directions ?? [];
      if (abandoned.length > 0) {
        parts.push("");
        parts.push(`### ABANDONED DIRECTIONS (canonical-rejected — do NOT re-introduce)`);
        for (const a of abandoned) {
          const refStr = a.snapshot_ref ? ` [ref: ${a.snapshot_ref}]` : "";
          parts.push(`- \`${a.name}\` (rejected ${a.rejected_at})${refStr}`);
          parts.push(`    Reason: ${a.reason}`);
        }
        parts.push("");
        parts.push(
          `Per Rule 6: before finalizing any proposed prompt, verify it does NOT re-introduce any direction listed above. ` +
          `If it does, escalate the level (L1→L2 or L2→L3) and propose a structurally different approach.`,
        );
      }
    }
  }
  return parts.join("\n");
}

/**
 * Backwards-compat alias — any legacy import of `SYSTEM_PROMPT` still works.
 * Emits the non-music-video prompt (preamble + core). For music-video
 * campaigns, call `buildSystemPrompt(musicVideoContext)` explicitly.
 */
export const SYSTEM_PROMPT = buildSystemPrompt();

// ───────────────────────────────────────────────────────────────────────────
// User message builder — NOT cached
// ───────────────────────────────────────────────────────────────────────────

export function buildUserMessage(params: {
  artifact: Artifact;
  qaVerdict: VideoGradeResult | Record<string, unknown>;
  promptHistory: PromptHistoryEntry[];
  catalog: KnownLimitation[];
  attemptCount: number;
  escalationLevel: EscalationLevel;
  deliverable: CampaignDeliverable;
  campaignContext: { prompt?: string; brandSlug: string; narrative?: string };
  /** ISO date YYYY-MM-DD — injected as first line so the model always knows
   *  the current date (staleness discipline). */
  todayDate: string;
  /** Per-shot cumulative USD cost for Rule 5 self-check. */
  perShotCumulativeCost?: number;
  /** Count of consecutive iterations with near-identical proposed prompts. */
  consecutiveSamePromptRegens?: number;
  /** Ordered list of escalation levels used so far on this shot. */
  levelsUsed?: EscalationLevel[];
  /** True iff QA verdict has already been cross-validated via Rule 1 consensus. */
  consensusResolved?: boolean;
  /**
   * Chunk 1: per-shot narrative envelope. When provided, the user message gets
   * SHOT POSITION + NEIGHBOR SHOTS + STYLIZATION BUDGET sections after
   * CAMPAIGN CONTEXT. Optional so non-music-video campaigns still work.
   */
  narrativeContext?: NarrativeContext;
}): string {
  const sections: string[] = [];

  // Today's date — top line, user message (NOT system) so cache stays stable
  sections.push(`Today's date: ${params.todayDate}`);
  sections.push("");

  sections.push(`# CURRENT FAILURE — DECIDE NEXT ACTION\n`);

  sections.push(`## ESCALATION STATE`);
  sections.push(`- Current level: ${params.escalationLevel}`);
  sections.push(`- Attempt count on this artifact: ${params.attemptCount}`);
  if (params.levelsUsed && params.levelsUsed.length > 0) {
    sections.push(`- Levels used so far on this shot: [${params.levelsUsed.join(", ")}]`);
  }
  sections.push("");

  // ── BUDGET STATE — Rule 5 self-check inputs + human-watcher signals ─────
  sections.push(`## BUDGET STATE`);
  const cumCost = params.perShotCumulativeCost ?? 0;
  const consecSame = params.consecutiveSamePromptRegens ?? 0;
  sections.push(`- per_shot_cumulative_cost_usd: ${cumCost.toFixed(4)}`);
  sections.push(`- per_shot_hard_cap_usd: 4.00`);
  sections.push(`- consecutiveSamePromptRegens: ${consecSame}`);
  if (cumCost >= 3.5) {
    sections.push(`- ⚠ BUDGET WARNING: approaching per-shot cap. Per Rule 5, vote accept + confidence < 0.5 → HITL if another regen would exceed \$4.00.`);
  }
  if (consecSame >= 3) {
    sections.push(`- ⚠ LOOP WARNING: last ${consecSame} decisions proposed near-identical prompts. Escalate level OR recommend HITL. Do NOT propose the same prompt again.`);
  }
  sections.push("");

  sections.push(`## ARTIFACT`);
  sections.push(`- ID: ${params.artifact.id}`);
  sections.push(`- Type: ${params.artifact.type}`);
  sections.push(`- Stage: ${params.artifact.stage ?? "unknown"}`);
  sections.push(`- Metadata: ${JSON.stringify(params.artifact.metadata ?? {})}`);
  sections.push("");

  sections.push(`## DELIVERABLE`);
  sections.push(`- ID: ${params.deliverable.id}`);
  sections.push(`- Description: ${params.deliverable.description ?? "(none)"}`);
  sections.push(`- Media type: ${params.deliverable.mediaType ?? "image"}`);
  sections.push(`- Current prompt: ${params.deliverable.currentPrompt ?? "(none)"}`);
  sections.push(`- Original prompt: ${params.deliverable.originalPrompt ?? "(none)"}`);
  sections.push(`- Aspect ratio: ${params.deliverable.aspectRatio ?? "unspecified"}`);
  sections.push(`- Duration: ${params.deliverable.durationSeconds ?? "n/a"}s`);
  sections.push(`- AI model: ${params.deliverable.aiModel ?? "unspecified"}`);
  sections.push("");

  sections.push(`## CAMPAIGN CONTEXT`);
  sections.push(`- Brand slug: ${params.campaignContext.brandSlug}`);
  if (params.campaignContext.prompt) {
    sections.push(`- Campaign prompt: ${params.campaignContext.prompt}`);
  }
  if (params.campaignContext.narrative) {
    sections.push(`- Narrative: ${params.campaignContext.narrative}`);
  }
  sections.push("");

  // ─── Chunk 1: SHOT POSITION + NEIGHBOR SHOTS + STYLIZATION BUDGET ──────
  if (params.narrativeContext) {
    const nc = params.narrativeContext;
    sections.push(`## SHOT POSITION`);
    sections.push(`- Shot ${nc.shot_number} of 30`);
    sections.push(`- Beat: ${nc.beat_name}`);
    sections.push(
      `- Song: ${nc.song_start_s.toFixed(1)}s–${nc.song_end_s.toFixed(1)}s`,
    );
    sections.push(`- Visual intent: ${nc.visual_intent}`);
    sections.push("");

    sections.push(`## NEIGHBOR SHOTS`);
    if (nc.previous_shot) {
      sections.push(
        `### Previous — Shot ${nc.previous_shot.shot_number} (${nc.previous_shot.beat_name})`,
      );
      sections.push(nc.previous_shot.visual_intent_summary);
      sections.push("");
    } else {
      sections.push("(no previous shot — this is shot 1)");
      sections.push("");
    }
    if (nc.next_shot) {
      sections.push(
        `### Next — Shot ${nc.next_shot.shot_number} (${nc.next_shot.beat_name})`,
      );
      sections.push(nc.next_shot.visual_intent_summary);
      sections.push("");
    } else {
      sections.push("(no next shot — this is shot 30)");
      sections.push("");
    }

    if (nc.stylization_allowances.length > 0) {
      sections.push(`## STYLIZATION BUDGET`);
      sections.push("Intentional visual effects for this shot:");
      for (const allow of nc.stylization_allowances) {
        sections.push(`- ${allow}`);
      }
      sections.push(
        "When detecting a criterion deficit that matches a stylization " +
          "allowance above, treat it as intentional per the budget. VERDICT " +
          "RULES stay fixed — this widens the input, not the rubric.",
      );
      sections.push("");
    }
  }

  sections.push(`## QA VERDICT`);
  if (params.consensusResolved) {
    sections.push(`> consensus_resolved: true — this verdict reflects critic-consensus resolution per Rule 1. Treat as authoritative; do not recommend re-running QA.`);
  }
  sections.push("```json");
  sections.push(JSON.stringify(params.qaVerdict, null, 2));
  sections.push("```");
  sections.push("");

  sections.push(`## PROMPT HISTORY (attempts so far)`);
  if (params.promptHistory.length === 0) {
    sections.push("(first attempt — no prior history)");
  } else {
    for (const entry of params.promptHistory) {
      sections.push(`### Iteration ${entry.iteration} — verdict: ${entry.verdict}${entry.gradeScore !== undefined ? ` (score ${entry.gradeScore})` : ""}`);
      if (entry.failureClass) sections.push(`- Failure class: ${entry.failureClass}`);
      if (entry.stillPrompt) sections.push(`- Still prompt: ${_truncate(entry.stillPrompt, 500)}`);
      if (entry.veoPrompt) sections.push(`- Veo prompt: ${_truncate(entry.veoPrompt, 500)}`);
      if (entry.negativePrompt) sections.push(`- Negative prompt: ${entry.negativePrompt}`);
      sections.push("");
    }
  }
  sections.push("");

  sections.push(`## KNOWN-LIMITATION CATALOG (fetched from DB)`);
  if (params.catalog.length === 0) {
    sections.push("(catalog empty — likely means fresh deployment; propose a new_candidate_limitation if you detect a pattern)");
  } else {
    for (const lim of params.catalog) {
      sections.push(`### \`${lim.failureMode}\` — ${lim.severity} (${lim.category})`);
      sections.push(`**Description:** ${lim.description}`);
      if (lim.mitigation) sections.push(`**Mitigation:** ${lim.mitigation}`);
      sections.push(`**Times encountered:** ${lim.timesEncountered} | **id:** ${lim.id}`);
      sections.push("");
    }
  }
  sections.push("");

  sections.push(`# YOUR TASK`);
  sections.push(
    `Diagnose, classify, decide. Output EXACTLY ONE JSON object matching the OrchestratorDecision schema. No prose outside JSON.`,
  );
  if (params.narrativeContext) {
    sections.push("");
    sections.push(
      `**Continuity rule:** If neighbor shots have a PASSING verdict already, prefer L3 accept over regen to preserve sequence continuity — unless this shot has a BLOCKING failure_mode.`,
    );
  }

  return sections.join("\n");
}

function _truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}
