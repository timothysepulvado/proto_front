/**
 * Stills runner — ADR-004 Phase B.
 *
 * Productizes the manual two-voices critic-in-loop + audit pattern that
 * shipped 30/30 stills on the Drift MV. Two execution paths:
 *
 *   - audit-mode (auditMode: true) — parallel critic verdicts across all
 *     locked stills for the campaign. No regen. Per-shot
 *     `orchestration_decisions` rows form the audit trail; the HUD
 *     reconstructs the triage table by querying decisions for the run.
 *
 *   - in-loop mode (auditMode: false, default) — per-shot iterative
 *     critic → orchestrator → regen via `handleQAFailure` from
 *     `escalation_loop.ts`. The escalation loop already encodes the
 *     degenerate-loop guard, level promotion (L1×3 → L2×2 → L3×2 → HITL),
 *     decision recording, and budget cap; stills passes a tighter cost cap
 *     ($1.00/shot) via `perShotCapOverride`.
 *
 * Public entry: `executeStillsStage(run, opts)`. Wired into `runner.ts` at
 * the `case "stills":` branch.
 *
 * Trace IDs: one per run, propagated as `X-Trace-Id` header on every
 * brand-engine `/grade_image_v2` call so the sidecar's structured logs
 * correlate end-to-end.
 *
 * Feature flag: `STILLS_MODE_ENABLED` (env, default false). Returns failure
 * with a clear log line when off — the rollback lever per ADR-004 quality
 * gate #21.
 *
 * NOT in scope for Phase B (deferred to F/G/H):
 *   - Aggregated metrics (Phase F emits the structured-log substrate)
 *   - Operator runbook prose (Phase G)
 *   - Multi-tenant RLS (Phase H — Phase B reads ~/Temp-gen/productions/<slug>/
 *     directly from the local filesystem)
 *   - Phase C image-class L1/L2/L3 prompt template productization — Phase B
 *     reuses the existing video-class orchestrator; it produces sane
 *     decisions for the in-loop path even before image-class templates land.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

import {
  emitLog,
  updateStageStatus,
  callBrandEngine,
  callTempGen,
  createArtifactWithUpload,
  runEvents,
} from "./runner.js";
import {
  getCampaign,
  getDeliverablesByCampaign,
  getArtifactsByRun,
  getLatestArtifactByDeliverable,
  addArtifact,
  createEscalation,
  getEscalationByArtifact,
  recordOrchestrationDecision,
  updateEscalation,
  updateRun,
} from "./db.js";
import { handleQAFailure } from "./escalation_loop.js";
import { getTempGenDir } from "./temp-gen-env.js";
import type {
  Run,
  ImageGradeResult,
  ImageGradeRequest,
  Artifact,
  CampaignDeliverable,
} from "./types.js";

// ─── Config (env-overridable) ──────────────────────────────────────────────

const TEMP_GEN_PATH = process.env.TEMP_GEN_PATH || getTempGenDir();

/**
 * Per-shot cumulative cost cap for stills runs. Tighter than the video
 * default ($4.00) because image regens are cheaper. Overrides
 * `escalation_loop.ts::PER_SHOT_HARD_CAP_USD` via `perShotCapOverride`.
 */
export const STILLS_PER_SHOT_HARD_CAP_USD = Number.parseFloat(
  process.env.STILLS_PER_SHOT_COST_CAP_USD
    ?? process.env.STILLS_PER_SHOT_COST_CAP
    ?? "1.0",
);

/**
 * Audit-mode parallel concurrency. Conservative default (8). Manual flow
 * proven at 15-20; 8 leaves headroom for Gemini 3 Pro Vision rate limits.
 * Bump after smoke if quotas behave.
 */
export const STILLS_AUDIT_CONCURRENCY = Number.parseInt(
  process.env.STILLS_AUDIT_CONCURRENCY ?? "8",
  10,
);

/**
 * Feature flag — defaults OFF. Operator must opt in per environment.
 * Rollback lever per ADR-004 quality gate #21.
 */
export const STILLS_MODE_ENABLED =
  (process.env.STILLS_MODE_ENABLED ?? "false").toLowerCase() === "true";

// ─── Manifest types ────────────────────────────────────────────────────────

/**
 * Subset of the Temp-gen manifest.json shape that the stills runner needs.
 * Manifest source of truth: `~/Temp-gen/productions/<slug>/manifest.json`.
 * Phase H (multi-tenant) will move manifest content into Supabase; the
 * loader is the seam where that swap happens.
 */
export interface ManifestShot {
  id: number;
  section?: string;
  visual?: string;
  characters_needed?: string[];
  still_prompt?: string;
  pivot_rewrite_history?: Array<Record<string, unknown>>;
}

/**
 * Phase 5 (2026-04-30) — directional integrity payload mirrored from
 * `manifest.directional_history`. Threaded into the critic's `story_context`
 * so brand-engine `_build_critic_system_prompt` can emit the
 * `## CAMPAIGN DIRECTION` axiom + `## ABANDONED DIRECTIONS` list.
 */
export interface DirectionalHistory {
  current_direction_mantra?: string;
  current_direction_summary?: string;
  abandoned_directions?: Array<{
    name: string;
    rejected_at: string;
    reason: string;
    snapshot_ref?: string;
  }>;
}

export interface ManifestPayload {
  productionSlug: string;
  shots: ManifestShot[];
  storyContext: {
    brief?: string;
    narrative?: string;
    lyrics?: string;
    /** Phase 5: campaign direction axiom + abandoned-directions list. The
     *  brand-engine critic reads this from `story_context.directional_history`
     *  and emits a `## CAMPAIGN DIRECTION` section in its system prompt. */
    directional_history?: DirectionalHistory;
  };
  anchorPaths: string[];
  referencePaths: string[];
}

// ─── Manifest loader ───────────────────────────────────────────────────────

/**
 * Read manifest.json + BRIEF/NARRATIVE/LYRICS + anchors directory from the
 * filesystem. Missing optional files (story-context docs, references) are
 * warnings — runner continues. Missing manifest.json is a hard fail.
 *
 * Phase H seam: this function is the only filesystem reader in stills_runner.
 * Replacing it with a Supabase-table reader is a one-function swap.
 */
export function loadCampaignManifest(productionSlug: string): ManifestPayload {
  const root = join(TEMP_GEN_PATH, "productions", productionSlug);
  const manifestPath = join(root, "manifest.json");

  if (!existsSync(manifestPath)) {
    throw new Error(
      `manifest.json not found at ${manifestPath} — cannot run stills mode for production '${productionSlug}'.`,
    );
  }

  const raw = readFileSync(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as {
    shots?: ManifestShot[];
    directional_history?: DirectionalHistory;
  };
  if (!Array.isArray(parsed.shots)) {
    throw new Error(`Manifest at ${manifestPath} is missing shots[].`);
  }

  // Story context — best-effort.
  const storyContext: ManifestPayload["storyContext"] = {};
  for (const [key, file] of [
    ["brief", "BRIEF.md"],
    ["narrative", "NARRATIVE.md"],
    ["lyrics", "LYRICS.md"],
  ] as const) {
    const path = join(root, file);
    if (existsSync(path)) {
      try {
        storyContext[key] = readFileSync(path, "utf8");
      } catch {
        // Non-fatal: the critic operates without story context, just less
        // grounded. Logged at run start.
      }
    }
  }

  // Phase 5: thread the directional_history block from manifest top-level
  // into story_context so the critic's `## CAMPAIGN DIRECTION` axiom fires.
  // Defensive: only attach when the shape looks correct (object with at least
  // a mantra OR an abandoned_directions array).
  if (parsed.directional_history && typeof parsed.directional_history === "object") {
    const dh = parsed.directional_history;
    const hasMantra = typeof dh.current_direction_mantra === "string";
    const hasAbandoned = Array.isArray(dh.abandoned_directions);
    if (hasMantra || hasAbandoned) {
      storyContext.directional_history = dh;
    }
  }

  // Anchors — single canonical directory per the manual flow.
  const anchorsDir = join(root, "anchors");
  const anchorPaths: string[] = [];
  if (existsSync(anchorsDir)) {
    try {
      for (const name of readdirSync(anchorsDir)) {
        if (name.endsWith("_anchor.png")) {
          anchorPaths.push(join(anchorsDir, name));
        }
      }
    } catch {
      // Anchors are recommended; runner logs missing dir at run start.
    }
  }

  // Reference quality bar — optional, used by audit critic for aesthetic
  // grounding. Drift MV uses `reference_quality_bar/` per the manual flow.
  const referencesDir = join(root, "reference_quality_bar");
  const referencePaths: string[] = [];
  if (existsSync(referencesDir)) {
    try {
      for (const name of readdirSync(referencesDir)) {
        if (name.endsWith(".png") || name.endsWith(".jpg")) {
          referencePaths.push(join(referencesDir, name));
        }
      }
    } catch {
      // Optional.
    }
  }

  return {
    productionSlug,
    shots: parsed.shots,
    storyContext,
    anchorPaths,
    referencePaths,
  };
}

// ─── Slug resolution (Phase B: derive from clientId) ──────────────────────

/**
 * Resolve the production slug for a stills run. Phase B uses the convention
 * `client_<slug>` → `<slug>` (e.g., `client_drift-mv` → `drift-mv`). Phase H
 * will replace this with a per-tenant lookup; for now it matches the manual
 * flow exactly and unblocks the inaugural campaign.
 *
 * Single-tenant assumption acceptable per ADR-004 production-launch context
 * (Drift MV is the inaugural campaign + final training set).
 */
export function resolveProductionSlug(run: Run): string {
  const fromClient = run.clientId.replace(/^client_/, "");
  if (!fromClient || fromClient === run.clientId) {
    throw new Error(
      `Could not derive production slug from clientId='${run.clientId}'. ` +
        `Expected format 'client_<slug>'.`,
    );
  }
  return fromClient;
}

// ─── Concurrency primitive (no extra dep) ─────────────────────────────────

/**
 * Promise pool — runs `fn(item)` over `items` with at most `limit` in flight
 * at any time. Returns results in input order. No-dep substitute for
 * `p-limit` / `Promise.allSettled` patterns we'd otherwise pull in.
 */
async function pMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const max = Math.max(1, Math.min(limit, items.length || 1));

  const next = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };

  for (let i = 0; i < max; i += 1) workers.push(next());
  await Promise.all(workers);
  return out;
}

// ─── Brand-engine /grade_image_v2 caller ──────────────────────────────────

interface GradeImageV2Args {
  imagePath: string;
  shot: ManifestShot;
  storyContext: ManifestPayload["storyContext"];
  anchorPaths: string[];
  referencePaths: string[];
  pivotRewriteHistory: Array<Record<string, unknown>> | null;
  mode: "audit" | "in_loop";
  traceId: string;
  runId: string;
  stageId: string;
}

/**
 * Single critic call. Wraps `callBrandEngine` with the request shape that
 * `/grade_image_v2` expects (per `os-api/src/types.ts::ImageGradeRequest`)
 * plus trace-ID propagation as `X-Trace-Id` header.
 *
 * Returns `null` on transport / 4xx / 5xx error after logging — the caller
 * decides whether to retry, escalate, or skip.
 */
async function gradeImageV2(args: GradeImageV2Args): Promise<ImageGradeResult | null> {
  const body: ImageGradeRequest = {
    image_path: args.imagePath,
    still_prompt: args.shot.still_prompt ?? "",
    narrative_beat: {
      shot_number: args.shot.id,
      section: args.shot.section,
      visual: args.shot.visual,
      characters_needed: args.shot.characters_needed,
    },
    story_context: args.storyContext as Record<string, unknown>,
    anchor_paths: args.anchorPaths,
    reference_paths: args.referencePaths,
    pivot_rewrite_history: args.pivotRewriteHistory,
    mode: args.mode,
    shot_number: args.shot.id,
  };

  const response = await callBrandEngine<ImageGradeResult>(
    "/grade_image_v2",
    body as unknown as Record<string, unknown>,
    args.runId,
    args.stageId,
    { "X-Trace-Id": args.traceId },
  );

  if (!response.ok) {
    await emitLog(
      args.runId,
      args.stageId,
      "warn",
      `[shot ${args.shot.id}] /grade_image_v2 failed: ${response.error}`,
    );
    return null;
  }
  return response.data;
}

// ─── Audit mode ────────────────────────────────────────────────────────────

interface AuditShotResult {
  shotId: number;
  imagePath: string;
  verdict: ImageGradeResult | null;
  errorMessage: string | null;
}

/** "Shot 7", "Shot 007", "shot_500", "shot-50" — case-insensitive. */
const SHOT_DESCRIPTION_RE = /\bshot[\s_-]*0*(\d{1,3})\b/i;

export function parseShotDescriptionNumber(description: string | null | undefined): number | null {
  const match = description?.match(SHOT_DESCRIPTION_RE);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildAuditDecisionRecordInput(args: {
  escalationId: string;
  artifactId: string;
  runId: string;
  deliverableId?: string;
  shotId: number;
  imagePath: string;
  verdict: ImageGradeResult;
  traceId: string;
}) {
  const failureClass = args.verdict.detected_failure_classes[0] ?? null;
  return {
    escalationId: args.escalationId,
    runId: args.runId,
    iteration: 1,
    inputContext: {
      decision_type: "audit_verdict",
      mode: "audit",
      trace_id: args.traceId,
      artifact_id: args.artifactId,
      artifactId: args.artifactId,
      deliverable_id: args.deliverableId ?? null,
      deliverableId: args.deliverableId ?? null,
      shot_id: args.shotId,
      shotId: args.shotId,
      image_path: args.imagePath,
      imagePath: args.imagePath,
      qa_verdict: args.verdict,
    },
    decision: {
      decision_type: "audit_verdict",
      action: args.verdict.recommendation,
      verdict: args.verdict.verdict,
      recommendation: args.verdict.recommendation,
      aggregate_score: args.verdict.aggregate_score,
      failure_class: failureClass,
      detected_failure_classes: args.verdict.detected_failure_classes,
      confidence: args.verdict.confidence,
      summary: args.verdict.summary,
      reasoning: args.verdict.reasoning,
      trace_id: args.traceId,
    },
    model: args.verdict.model,
    cost: args.verdict.cost,
    latencyMs: args.verdict.latency_ms,
  };
}

async function persistAuditVerdictDecision(
  run: Run,
  stageId: string,
  result: AuditShotResult,
  traceId: string,
  deliverable?: CampaignDeliverable,
): Promise<void> {
  if (!result.verdict) return;
  const padded = String(result.shotId).padStart(2, "0");
  const artifact: Artifact = {
    id: randomUUID(),
    runId: run.runId,
    clientId: run.clientId,
    campaignId: run.campaignId,
    deliverableId: deliverable?.id,
    type: "image",
    name: `audit_shot_${padded}.png`,
    path: result.imagePath,
    stage: stageId,
    metadata: {
      source: "stills_runner_audit_verdict",
      auditMode: true,
      shotNumber: result.shotId,
      localPath: result.imagePath,
      traceId,
    },
    createdAt: new Date().toISOString(),
  };
  const persistedArtifact = await addArtifact(artifact);
  const escalation = await createEscalation({
    artifactId: persistedArtifact.id,
    deliverableId: deliverable?.id,
    runId: run.runId,
    currentLevel: "L1",
    status: "resolved",
    failureClass: result.verdict.detected_failure_classes[0],
  });
  await recordOrchestrationDecision(buildAuditDecisionRecordInput({
    escalationId: escalation.id,
    artifactId: persistedArtifact.id,
    runId: run.runId,
    deliverableId: deliverable?.id,
    shotId: result.shotId,
    imagePath: result.imagePath,
    verdict: result.verdict,
    traceId,
  }));
}

/**
 * Audit mode — parallel critic on every locked still in the manifest. No
 * regen. Per-shot decision rows in `orchestration_decisions` form the audit
 * trail; the HUD reconstructs the triage table by querying decisions for
 * this run_id.
 */
async function runAuditMode(
  run: Run,
  manifest: ManifestPayload,
  traceId: string,
): Promise<boolean> {
  const stageId = "grade";
  const productionRoot = join(TEMP_GEN_PATH, "productions", manifest.productionSlug);
  const deliverableByShot = new Map<number, CampaignDeliverable>();
  if (run.campaignId) {
    try {
      const deliverables = await getDeliverablesByCampaign(run.campaignId);
      for (const deliverable of deliverables) {
        const shotNumber = parseShotDescriptionNumber(deliverable.description);
        if (shotNumber !== null && !deliverableByShot.has(shotNumber)) {
          deliverableByShot.set(shotNumber, deliverable);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await emitLog(
        run.runId,
        stageId,
        "warn",
        `[audit] failed to load deliverables for audit decision linkage (${msg}); decisions will be artifact/run-scoped only.`,
      );
    }
  }

  // Collect shots that have a locked still PNG on disk. Skip with a log
  // line for missing ones — the manual flow shipped only the locked PNGs.
  type Candidate = { shot: ManifestShot; imagePath: string };
  const candidates: Candidate[] = [];
  for (const shot of manifest.shots) {
    const padded = String(shot.id).padStart(2, "0");
    const path = join(productionRoot, "stills", `shot_${padded}.png`);
    if (existsSync(path)) {
      candidates.push({ shot, imagePath: path });
    } else {
      await emitLog(
        run.runId,
        stageId,
        "info",
        `[audit] Skipping shot ${shot.id} — no locked still at ${path}`,
      );
    }
  }

  if (candidates.length === 0) {
    await emitLog(
      run.runId,
      stageId,
      "warn",
      `[audit] No locked stills found under ${productionRoot}/stills/. Audit produced 0 verdicts.`,
    );
    return true; // Not a failure — just an empty audit.
  }

  await emitLog(
    run.runId,
    stageId,
    "info",
    `[audit] Grading ${candidates.length} stills with concurrency=${STILLS_AUDIT_CONCURRENCY}, traceId=${traceId}`,
  );

  // Fan out under the concurrency cap.
  const results: AuditShotResult[] = await pMap(
    candidates,
    STILLS_AUDIT_CONCURRENCY,
    async ({ shot, imagePath }) => {
      const verdict = await gradeImageV2({
        imagePath,
        shot,
        storyContext: manifest.storyContext,
        anchorPaths: manifest.anchorPaths,
        referencePaths: manifest.referencePaths,
        pivotRewriteHistory: null, // audit ignores pivot history (Rules 6+7 skipped)
        mode: "audit",
        traceId,
        runId: run.runId,
        stageId,
      });
      if (verdict) {
        await emitLog(
          run.runId,
          stageId,
          "info",
          `[audit] shot ${shot.id}: ${verdict.verdict} score=${verdict.aggregate_score.toFixed(2)} → ${verdict.recommendation} (failures: ${verdict.detected_failure_classes.join(",") || "none"})`,
        );
      }
      return {
        shotId: shot.id,
        imagePath,
        verdict,
        errorMessage: verdict ? null : "critic_call_failed",
      };
    },
  );

  // Audit trail: emit the legacy structured run_logs row and the canonical
  // orchestration_decisions row. Audit verdicts get a synthetic artifact
  // anchor because orchestration_decisions requires an escalation_id FK.
  for (const r of results) {
    if (!r.verdict) continue; // critic failed — already logged
    const v = r.verdict;
    await emitLog(
      run.runId,
      stageId,
      "info",
      [
        `[audit_verdict]`,
        `shot=${r.shotId}`,
        `path=${r.imagePath}`,
        `verdict=${v.verdict}`,
        `score=${v.aggregate_score.toFixed(3)}`,
        `recommendation=${v.recommendation}`,
        `cost=${v.cost.toFixed(4)}`,
        `latency_ms=${v.latency_ms}`,
        `failure_classes=${(v.detected_failure_classes || []).join(",") || "none"}`,
        `trace_id=${traceId}`,
      ].join(" "),
    );

    // Watcher signal so HUD streams the audit progress in addition to logs.
    runEvents.emit(`audit:${run.runId}`, {
      shotId: r.shotId,
      verdict: v.verdict,
      score: v.aggregate_score,
      recommendation: v.recommendation,
      cost: v.cost,
      traceId,
    });

    try {
      await persistAuditVerdictDecision(
        run,
        stageId,
        r,
        traceId,
        deliverableByShot.get(r.shotId),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await emitLog(
        run.runId,
        stageId,
        "warn",
        `[audit] shot ${r.shotId}: failed to persist audit_verdict orchestration_decision (${msg}); run_logs/audit_report retain the verdict.`,
      );
    }
  }

  // Emit aggregate summary to logs (Phase F will hook a metrics emitter
  // here; Phase B emits the substrate as a structured info line).
  const summary = results.reduce(
    (acc, r) => {
      if (!r.verdict) {
        acc.errors += 1;
        return acc;
      }
      if (r.verdict.recommendation === "ship") acc.keep += 1;
      else if (r.verdict.recommendation === "L1_prompt_fix") acc.l1 += 1;
      else if (r.verdict.recommendation === "L2_approach_change") acc.l2 += 1;
      else if (r.verdict.recommendation === "L3_redesign") acc.l3 += 1;
      acc.totalCost += r.verdict.cost;
      return acc;
    },
    { keep: 0, l1: 0, l2: 0, l3: 0, errors: 0, totalCost: 0 },
  );
  await emitLog(
    run.runId,
    stageId,
    "info",
    `[audit] complete: ${summary.keep} KEEP / ${summary.l1} L1 / ${summary.l2} L2 / ${summary.l3} L3 / ${summary.errors} errors. Total cost: $${summary.totalCost.toFixed(4)}`,
  );

  // Persist the audit_report blob to runs.metadata so the HUD can render the
  // triage table from one row instead of grep-scanning run_logs. Migration
  // 011_runs_metadata.sql backs this column. Read-modify-write to avoid
  // clobbering peer keys (audit_mode, trace_id) the route handler set at
  // creation.
  const auditReport = {
    runId: run.runId,
    traceId,
    productionSlug: manifest.productionSlug,
    completedAt: new Date().toISOString(),
    summary,
    shots: results.map((r) => ({
      shotId: r.shotId,
      imagePath: r.imagePath,
      verdict: r.verdict?.verdict ?? null,
      aggregateScore: r.verdict?.aggregate_score ?? null,
      recommendation: r.verdict?.recommendation ?? null,
      detectedFailureClasses: r.verdict?.detected_failure_classes ?? [],
      cost: r.verdict?.cost ?? null,
      latencyMs: r.verdict?.latency_ms ?? null,
      errorMessage: r.errorMessage,
    })),
  };
  try {
    const merged = { ...(run.metadata ?? {}), audit_report: auditReport };
    await updateRun(run.runId, { metadata: merged });
    await emitLog(
      run.runId,
      stageId,
      "info",
      `[audit] audit_report written to runs.metadata (${results.length} shots, $${summary.totalCost.toFixed(4)} total).`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await emitLog(
      run.runId,
      stageId,
      "warn",
      `[audit] failed to persist audit_report blob (non-fatal — log lines retain the data): ${msg}`,
    );
  }

  // Audit never fails the run on individual WARN/FAIL verdicts — it reports.
  return true;
}

// ─── In-loop mode ──────────────────────────────────────────────────────────

/**
 * Maximum critic-orchestrator-regen iterations per shot before forced HITL.
 * The escalation loop's MAX_ATTEMPTS already enforces L1×3 + L2×2 + L3×2 = 7
 * theoretical max; we cap at 8 here for stills as a backstop in case
 * promotion logic regresses.
 */
const STILLS_IN_LOOP_HARD_CAP = 8;

// ─── In-loop targeting (pure helper, exported for unit testing) ────────────

export type InLoopTarget = {
  shot: ManifestShot;
  deliverable: CampaignDeliverable;
};

export type InLoopTargetingDecision = {
  targets: InLoopTarget[];
  /** Reason-coded skips so callers (runInLoopMode) can emit operator-friendly
   *  warn lines without re-deriving the diagnosis. */
  skipped: Array<{
    reason:
      | "shot_not_in_manifest"
      | "no_deliverable_row_for_shot"
      | "couldnt_parse_shot_number"
      | "deliverable_terminal_status";
    shotId?: number;
    deliverableId?: string;
    description?: string;
  }>;
};

export function buildHardCapHitlPlan(args: {
  runId: string;
  shotId: number;
  iter: number;
  hardCap: number;
  deliverableId: string;
  artifactId: string;
  verdict?: ImageGradeResult | null;
}) {
  const failureClass = args.verdict?.detected_failure_classes[0];
  return {
    runUpdates: {
      hitlRequired: true,
      hitlNotes: `[stills in_loop] shot ${args.shotId} exhausted hard iter cap ${args.hardCap} at iter ${args.iter}; deliverable ${args.deliverableId}; artifact ${args.artifactId}.`,
    },
    escalation: {
      artifactId: args.artifactId,
      deliverableId: args.deliverableId,
      runId: args.runId,
      currentLevel: "L3" as const,
      status: "hitl_required" as const,
      failureClass,
    },
    resolutionNotes: `Forced HITL after STILLS_IN_LOOP_HARD_CAP=${args.hardCap} for shot ${args.shotId}.`,
  };
}

/**
 * Decide which (shot, deliverable) pairs to iterate in in-loop mode.
 *
 * Two paths:
 *
 *  1. **Default** — when ``shotIds`` is empty/null, iterate non-terminal
 *     deliverables and parse shot numbers from each ``description`` via
 *     {@link SHOT_DESCRIPTION_RE}. Matches the convention used by the
 *     inaugural Drift MV deliverables ("Shot 7 · verse_1 · …").
 *
 *  2. **Targeted regen** (Phase B+ 2026-04-30) — when ``shotIds`` is
 *     provided, iterate exactly those manifest shot IDs and bypass the
 *     ``status NOT IN (approved, rejected)`` deliverable filter. Each
 *     shot must have (a) a manifest entry and (b) at least one deliverable
 *     row whose description encodes its shot number — otherwise it's
 *     skipped with a reason-code.
 *
 * Pure function — no I/O, easy to unit-test. The order of returned targets
 * matches input order: default = deliverable order from caller; targeted =
 * shotIds order from caller (operators can prioritize).
 */
export function pickInLoopTargets(
  manifest: ManifestPayload,
  allDeliverables: readonly CampaignDeliverable[],
  shotIds: readonly number[] | null | undefined,
): InLoopTargetingDecision {
  const targets: InLoopTarget[] = [];
  const skipped: InLoopTargetingDecision["skipped"] = [];

  const findDeliverableForShot = (shotId: number): CampaignDeliverable | null => {
    const found = allDeliverables.find((d) => {
      return parseShotDescriptionNumber(d.description) === shotId;
    });
    return found ?? null;
  };

  if (shotIds && shotIds.length > 0) {
    for (const shotId of shotIds) {
      const shot = manifest.shots.find((s) => s.id === shotId);
      if (!shot) {
        skipped.push({ reason: "shot_not_in_manifest", shotId });
        continue;
      }
      const deliverable = findDeliverableForShot(shotId);
      if (!deliverable) {
        skipped.push({ reason: "no_deliverable_row_for_shot", shotId });
        continue;
      }
      targets.push({ shot, deliverable });
    }
    return { targets, skipped };
  }

  // Default: status filter + per-deliverable shot-number parse.
  for (const d of allDeliverables) {
    if (d.status === "approved" || d.status === "rejected") {
      skipped.push({
        reason: "deliverable_terminal_status",
        deliverableId: d.id,
      });
      continue;
    }
    const shotNumber = parseShotDescriptionNumber(d.description);
    if (shotNumber === null || !Number.isFinite(shotNumber)) {
      skipped.push({
        reason: "couldnt_parse_shot_number",
        deliverableId: d.id,
        description: d.description ?? "",
      });
      continue;
    }
    const shot = manifest.shots.find((s) => s.id === shotNumber);
    if (!shot) {
      skipped.push({
        reason: "shot_not_in_manifest",
        shotId: shotNumber,
        deliverableId: d.id,
      });
      continue;
    }
    targets.push({ shot, deliverable: d });
  }
  return { targets, skipped };
}

async function runInLoopMode(
  run: Run,
  manifest: ManifestPayload,
  traceId: string,
): Promise<boolean> {
  const stageId = "grade";

  // Phase B+ (2026-04-30): targeted-regen scope from run.metadata.shot_ids.
  // When present + non-empty, this becomes the authoritative shot set and
  // bypasses the default `status NOT IN (approved, rejected)` filter.
  const persistedShotIds =
    (run.metadata as { shot_ids?: number[] } | undefined)?.shot_ids ?? null;

  // Load all deliverables for the campaign — pickInLoopTargets does the
  // filtering. We still emit an info log with the campaign name so the run
  // history shows scope.
  let allDeliverables: CampaignDeliverable[] = [];
  if (run.campaignId) {
    const campaign = await getCampaign(run.campaignId);
    if (campaign) {
      allDeliverables = await getDeliverablesByCampaign(run.campaignId);
      const scope =
        persistedShotIds && persistedShotIds.length > 0
          ? `targeted-regen shotIds=[${persistedShotIds.join(",")}]`
          : "default (non-terminal deliverables)";
      await emitLog(
        run.runId,
        stageId,
        "info",
        `[in_loop] Campaign '${campaign.name}' — ${allDeliverables.length} total deliverable(s); scope=${scope}`,
      );
    }
  }

  const decision = pickInLoopTargets(manifest, allDeliverables, persistedShotIds);

  // Surface skipped entries so operators can diagnose without crawling logs.
  for (const s of decision.skipped) {
    if (s.reason === "deliverable_terminal_status") continue; // expected silent default-path skip
    await emitLog(
      run.runId,
      stageId,
      "warn",
      `[in_loop] Skipped (${s.reason}): shotId=${s.shotId ?? "?"} deliverableId=${s.deliverableId ?? "?"}${s.description ? ` description='${s.description}'` : ""}`,
    );
  }

  if (decision.targets.length === 0) {
    await emitLog(
      run.runId,
      stageId,
      "warn",
      persistedShotIds && persistedShotIds.length > 0
        ? `[in_loop] No targetable shots from shotIds=[${persistedShotIds.join(",")}] — every requested shot was skipped (see warns above). Nothing to regen.`
        : "[in_loop] No non-terminal deliverables found for this campaign. In-loop mode requires deliverable rows to track regen state. Use auditMode=true for filesystem-only stills.",
    );
    return true;
  }

  const productionRoot = join(TEMP_GEN_PATH, "productions", manifest.productionSlug);

  for (const { shot, deliverable } of decision.targets) {
    const padded = String(shot.id).padStart(2, "0");
    const stillPath = join(productionRoot, "stills", `shot_${padded}.png`);

    let iter = 0;
    let lastArtifact: Artifact | null = null;
    let lastCandidate: Artifact | null = null;
    let lastVerdict: ImageGradeResult | null = null;
    while (iter < STILLS_IN_LOOP_HARD_CAP) {
      iter += 1;

      // Best-effort: pick up the most recent artifact for this run so the
      // critic grades regen output rather than the locked file. Falls back
      // to the locked file on iter 1.
      const artifacts = await getArtifactsByRun(run.runId);
      let candidate: Artifact | undefined = artifacts
        .filter((a) => a.deliverableId === deliverable.id && a.path)
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
      // Phase B+ #7 (2026-04-30): when an artifact was registered via
      // createArtifactWithUpload after a successful Storage upload, `path`
      // is the public URL (correct for HUD/API consumers) but the local
      // disk file lives at metadata.localPath. The brand-engine critic is
      // a local HTTP service that reads from disk — it can't fetch the URL.
      // Read order: metadata.localPath → path → fallback locked still on disk.
      const candidateLocalPath = (candidate?.metadata as { localPath?: string } | undefined)?.localPath;
      const imagePath = candidateLocalPath ?? candidate?.path ?? stillPath;
      lastCandidate = candidate ?? null;
      if (!existsSync(imagePath)) {
        await emitLog(
          run.runId,
          stageId,
          "warn",
          `[in_loop] shot ${shot.id} iter ${iter}: image not on disk at ${imagePath}. Skipping shot.`,
        );
        break;
      }

      const verdict = await gradeImageV2({
        imagePath,
        shot,
        storyContext: manifest.storyContext,
        anchorPaths: manifest.anchorPaths,
        referencePaths: manifest.referencePaths,
        pivotRewriteHistory: shot.pivot_rewrite_history ?? null,
        mode: "in_loop",
        traceId,
        runId: run.runId,
        stageId,
      });
      if (!verdict) {
        await emitLog(
          run.runId,
          stageId,
          "warn",
          `[in_loop] shot ${shot.id} iter ${iter}: critic call failed. Stopping shot.`,
        );
        break;
      }
      lastVerdict = verdict;

      await emitLog(
        run.runId,
        stageId,
        "info",
        `[in_loop] shot ${shot.id} iter ${iter}: ${verdict.verdict} score=${verdict.aggregate_score.toFixed(2)} → ${verdict.recommendation}`,
      );

      if (verdict.recommendation === "ship") {
        // Phase B leaves deliverable status update to the operator (HUD
        // already wires "approve still" affordances). Logging the ship
        // decision is the production audit trail; Phase E will optionally
        // auto-flip status via this code path.
        await emitLog(
          run.runId,
          stageId,
          "info",
          `[in_loop] shot ${shot.id}: SHIP at iter ${iter}. Operator approval pending.`,
        );
        break;
      }

      // Non-ship → invoke the existing escalation loop. It writes the
      // orchestration_decision row, applies the degenerate-loop guard, and
      // returns a regen instruction or HITL flag.
      if (!candidate) {
        // Phase B+ auto-seed (2026-04-30): if no artifact row exists for THIS
        // run + deliverable, register the locked still as a seed artifact so
        // the escalation loop has something to attach orchestration_decisions
        // to. Two paths:
        //   1. Carry forward the most recent prior-run artifact's public URL
        //      + storage_path so the HUD continues to render the same asset
        //      without re-uploading. Path of least cost; preferred.
        //   2. If no prior artifact exists, register a minimal artifact row
        //      pointing at the on-disk locked still. Public URL absent; HUD
        //      shows nothing but the regen flow proceeds.
        // Eliminates the legacy "Operator must seed an artifact first" error
        // that blocked targeted-regen on operator-approved deliverables (the
        // direction-drift fix on the drift-mv campaign 2026-04-30 hit this).
        try {
          const prior = await getLatestArtifactByDeliverable(deliverable.id, "image");
          if (prior) {
            const seeded: Artifact = {
              id: randomUUID(),
              runId: run.runId,
              clientId: run.clientId,
              campaignId: run.campaignId,
              deliverableId: deliverable.id,
              type: "image",
              name: prior.name ?? `shot_${padded}.png`,
              path: prior.path,
              storagePath: prior.storagePath,
              stage: stageId,
              size: prior.size,
              metadata: {
                ...(prior.metadata ?? {}),
                localPath: existsSync(stillPath) ? stillPath : (prior.metadata as { localPath?: string } | undefined)?.localPath,
                seededFromArtifactId: prior.id,
                seedReason: "no_artifact_for_current_run",
              },
              createdAt: new Date().toISOString(),
            };
            candidate = await addArtifact(seeded);
            lastCandidate = candidate;
            await emitLog(
              run.runId,
              stageId,
              "info",
              `[in_loop] shot ${shot.id}: seeded artifact ${candidate.id} for deliverable ${deliverable.id} from prior artifact ${prior.id} (carry-forward path + URL).`,
            );
          } else if (existsSync(stillPath)) {
            const seeded: Artifact = {
              id: randomUUID(),
              runId: run.runId,
              clientId: run.clientId,
              campaignId: run.campaignId,
              deliverableId: deliverable.id,
              type: "image",
              name: `shot_${padded}.png`,
              path: stillPath,
              stage: stageId,
              metadata: {
                localPath: stillPath,
                seedReason: "no_prior_artifact_disk_only",
              },
              createdAt: new Date().toISOString(),
            };
            candidate = await addArtifact(seeded);
            lastCandidate = candidate;
            await emitLog(
              run.runId,
              stageId,
              "info",
              `[in_loop] shot ${shot.id}: seeded artifact ${candidate.id} for deliverable ${deliverable.id} from on-disk still (no prior artifact found).`,
            );
          } else {
            await emitLog(
              run.runId,
              stageId,
              "warn",
              `[in_loop] shot ${shot.id}: no prior artifact AND no still on disk at ${stillPath}; cannot escalate.`,
            );
            break;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await emitLog(
            run.runId,
            stageId,
            "warn",
            `[in_loop] shot ${shot.id}: artifact auto-seed failed (${msg}); cannot escalate.`,
          );
          break;
        }
      }

      const failureCtx = {
        runId: run.runId,
        clientId: run.clientId,
        campaignId: run.campaignId,
        artifact: candidate,
        qaVerdict: verdict as unknown as Record<string, unknown>,
        stageId,
        runEvents,
        logger: async (level: "info" | "warn" | "error" | "debug", msg: string) => {
          await emitLog(run.runId, stageId, level, msg);
        },
        perShotCapOverride: STILLS_PER_SHOT_HARD_CAP_USD,
      };

      const result = await handleQAFailure(failureCtx);

      if (result.outcome === "hitl_required" || result.outcome === "failed") {
        await emitLog(
          run.runId,
          stageId,
          "warn",
          `[in_loop] shot ${shot.id} iter ${iter}: ${result.outcome}. Stopping shot.`,
        );
        // Phase B+ #8 (2026-04-30): bubble hitl_required up to the runs row so
        // the HUD's Review Gate (which reads runs.hitl_required) surfaces the
        // flag for operator review. Without this, today's 3 HITL escalations
        // (asset_escalations rows) were invisible at the campaign-monitoring
        // surface — Review Gate showed "all clear" while shots were stuck.
        // Idempotent: setting an already-true flag is a no-op.
        if (result.outcome === "hitl_required" && !run.hitlRequired) {
          try {
            const updated = await updateRun(run.runId, {
              hitlRequired: true,
              hitlNotes: `[stills in_loop] shot ${shot.id} ${result.outcome} at iter ${iter}; deliverable ${deliverable.id}; escalation ${result.escalation?.id ?? "?"}.`,
            });
            if (updated) run = updated;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await emitLog(
              run.runId,
              stageId,
              "warn",
              `[in_loop] shot ${shot.id}: failed to bubble hitl_required to runs row (${msg}); continuing — escalation row is the canonical signal.`,
            );
          }
        }
        break;
      }
      if (result.outcome === "accepted") {
        await emitLog(
          run.runId,
          stageId,
          "info",
          `[in_loop] shot ${shot.id} iter ${iter}: orchestrator accepted. Stopping shot.`,
        );
        break;
      }
      if (result.outcome === "regenerate") {
        const newPrompt = result.newPrompts?.stillPrompt ?? null;
        if (!newPrompt) {
          await emitLog(
            run.runId,
            stageId,
            "warn",
            `[in_loop] shot ${shot.id} iter ${iter}: regenerate outcome but no new still prompt. Stopping shot.`,
          );
          break;
        }
        // Phase B regen call. Mirrors the existing deliverable image-gen
        // pattern in runner.ts:502-535 — Temp-gen /generate/image with
        // prompt + anchors as references.
        const outDir = join(TEMP_GEN_PATH, "outputs", run.runId, `shot_${padded}_iter${iter + 1}.png`);
        const tempGenRes = await callTempGen<{ status: string; local_path?: string; cost?: number }>(
          "/generate/image",
          "POST",
          {
            prompt: newPrompt,
            model: "gemini-3-pro-image-preview",
            output_path: outDir,
            reference_images: manifest.anchorPaths,
          },
          run.runId,
          stageId,
        );
        if (!tempGenRes.ok || tempGenRes.data.status !== "success") {
          const msg = tempGenRes.ok
            ? `non-success status ${tempGenRes.data.status}`
            : tempGenRes.error;
          await emitLog(
            run.runId,
            stageId,
            "warn",
            `[in_loop] shot ${shot.id} iter ${iter}: regen failed (${msg}). Stopping shot.`,
          );
          break;
        }

        // Phase B+ #6 (2026-04-30): close the regen → artifact → re-grade loop.
        // Previously this branch ended at `break` with the comment "Phase B+
        // closes the regen→artifact loop fully" — now we close it.
        //
        // The flow:
        //   1. Temp-gen wrote the regenerated still to disk (`local_path`).
        //   2. Register it as an artifact row tied to THIS run + deliverable
        //      so the next iter's getArtifactsByRun picks it up as `candidate`
        //      and the critic grades the regenerated image (not the locked
        //      original) on iter+1.
        //   3. Continue the while loop. Termination is enforced by:
        //        * cost cap (handleQAFailure tracks per-shot cumulative spend
        //          via STILLS_PER_SHOT_HARD_CAP_USD)
        //        * STILLS_IN_LOOP_HARD_CAP iter ceiling (defense-in-depth)
        //        * degenerate-loop guard (Rule 5; same prompt 3× → HITL)
        //        * verdict.recommendation === "ship" (success exit)
        const regenLocalPath = tempGenRes.data.local_path ?? outDir;
        try {
          const newArtifact = await createArtifactWithUpload({
            runId: run.runId,
            clientId: run.clientId,
            campaignId: run.campaignId,
            deliverableId: deliverable.id,
            type: "image",
            name: `shot_${padded}_iter${iter + 1}.png`,
            localPath: regenLocalPath,
            stage: stageId,
            metadata: {
              source: "stills_runner_in_loop_regen",
              iter: iter + 1,
              parentArtifactId: candidate.id,
              orchestratorAction: result.decision?.action ?? "regenerate",
              orchestratorLevel: result.decision?.level ?? null,
              orchestratorFailureClass: result.decision?.failure_class ?? null,
              tempGenCost: tempGenRes.data.cost ?? null,
            },
          });
          await emitLog(
            run.runId,
            stageId,
            "info",
            `[in_loop] shot ${shot.id} iter ${iter}: regen wrote ${regenLocalPath}; registered artifact ${newArtifact.id}. Continuing to iter ${iter + 1} for re-grade.`,
          );
          lastArtifact = newArtifact;
          // Continue → next iter's getArtifactsByRun + filter picks newArtifact
          // as `candidate` (most recent for this deliverable + this run).
          continue;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await emitLog(
            run.runId,
            stageId,
            "warn",
            `[in_loop] shot ${shot.id} iter ${iter}: regen wrote ${regenLocalPath} but artifact registration failed (${msg}). Stopping shot to avoid infinite re-grade on stale image.`,
          );
          break;
        }
      }
    }

    if (iter >= STILLS_IN_LOOP_HARD_CAP) {
      await emitLog(
        run.runId,
        stageId,
        "warn",
        `[in_loop] shot ${shot.id}: hit hard iter cap ${STILLS_IN_LOOP_HARD_CAP}. Forcing HITL.`,
      );
      const hitlArtifact = lastArtifact ?? lastCandidate;
      if (!hitlArtifact) {
        await emitLog(
          run.runId,
          stageId,
          "warn",
          `[in_loop] shot ${shot.id}: hard-cap HITL persistence skipped because no artifact was available to anchor asset_escalations.`,
        );
      } else {
        const plan = buildHardCapHitlPlan({
          runId: run.runId,
          shotId: shot.id,
          iter,
          hardCap: STILLS_IN_LOOP_HARD_CAP,
          deliverableId: deliverable.id,
          artifactId: hitlArtifact.id,
          verdict: lastVerdict,
        });
        try {
          const updated = await updateRun(run.runId, plan.runUpdates);
          if (updated) run = updated;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await emitLog(
            run.runId,
            stageId,
            "warn",
            `[in_loop] shot ${shot.id}: failed to bubble hard-cap hitl_required to runs row (${msg}).`,
          );
        }
        try {
          const existing = await getEscalationByArtifact(hitlArtifact.id, run.runId);
          const escalation = existing
            ? await updateEscalation(existing.id, {
                status: "hitl_required",
                failureClass: plan.escalation.failureClass,
                resolutionNotes: plan.resolutionNotes,
              })
            : await createEscalation(plan.escalation);
          runEvents.emit(`escalation:${run.runId}`, escalation);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await emitLog(
            run.runId,
            stageId,
            "warn",
            `[in_loop] shot ${shot.id}: failed to persist hard-cap asset_escalation (${msg}).`,
          );
        }
      }
    }
    if (lastArtifact) {
      // Reserved for a future regen→artifact closure step.
    }
  }

  return true;
}

// ─── Public entry ──────────────────────────────────────────────────────────

/**
 * Execute a `mode: "stills"` run. Called from `runner.ts` switch case.
 *
 * Returns `true` when the stage finished without a runner-fatal error.
 * Per-shot WARN/FAIL is recorded but does NOT fail the run — operators
 * triage the verdicts via the HUD.
 *
 * Reads `auditMode` from `run.metadata.audit_mode` (set by the route handler
 * at creation, persisted via migration 011_runs_metadata.sql). The
 * `opts.auditMode` override exists for tests + any future runtime injection
 * that shouldn't persist; production callers leave it undefined.
 */
export async function executeStillsStage(
  run: Run,
  opts: { auditMode?: boolean } = {},
): Promise<boolean> {
  const stageId = "load_manifest";
  const traceId = randomUUID();
  // Auth source: persisted run.metadata wins; opts is an explicit override
  // path (tests, future runtime knobs). Production callers leave opts empty.
  const persistedAuditMode = Boolean(
    (run.metadata as { audit_mode?: boolean } | undefined)?.audit_mode,
  );
  const auditMode = opts.auditMode ?? persistedAuditMode;

  await emitLog(
    run.runId,
    stageId,
    "info",
    `[stills] Starting stills stage. auditMode=${auditMode} (persisted=${persistedAuditMode}, opts=${opts.auditMode ?? "none"}), traceId=${traceId}`,
  );

  if (!STILLS_MODE_ENABLED) {
    await emitLog(
      run.runId,
      stageId,
      "error",
      "[stills] STILLS_MODE_ENABLED=false. Set the env var on os-api to enable. (Rollback lever per ADR-004 quality gate #21.)",
    );
    return false;
  }

  let manifest: ManifestPayload;
  try {
    const slug = resolveProductionSlug(run);
    await updateStageStatus(run, "load_manifest", "running");
    manifest = loadCampaignManifest(slug);
    // Persist trace_id + production_slug to runs.metadata so the HUD shows
    // them and post-mortem queries can join logs to the run row. Read-modify-
    // write to preserve audit_mode (route-set) and any future peer keys.
    try {
      const merged = {
        ...(run.metadata ?? {}),
        trace_id: traceId,
        production_slug: slug,
      };
      const updated = await updateRun(run.runId, { metadata: merged });
      if (updated) run = updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await emitLog(
        run.runId,
        stageId,
        "warn",
        `[stills] failed to persist trace_id/production_slug to runs.metadata (non-fatal): ${msg}`,
      );
    }
    await emitLog(
      run.runId,
      stageId,
      "info",
      `[stills] Loaded manifest for '${slug}': ${manifest.shots.length} shots, ${manifest.anchorPaths.length} anchors, ${manifest.referencePaths.length} reference images, story_context=${Object.keys(manifest.storyContext).length} doc(s)`,
    );
    run = await updateStageStatus(run, "load_manifest", "completed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await emitLog(run.runId, stageId, "error", `[stills] Manifest load failed: ${msg}`);
    return false;
  }

  // Health check the brand-engine sidecar before fanning out — operators
  // get a clear failure rather than 30 timeouts when :8100 is down.
  // Phase B+ #4 (2026-04-30): timeout bumped 5s → 30s. Under load,
  // brand-engine's /health endpoint serializes behind the request queue
  // (single-worker uvicorn + sync handlers on the threadpool). A 5s budget
  // produced spurious aborts during concurrent audit/regen runs; 30s lines
  // up with the per-call budget on /grade_image_v2 and is operator-friendly.
  try {
    const health = await fetch(`${process.env.BRAND_ENGINE_URL ?? "http://localhost:8100"}/health`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!health.ok) {
      await emitLog(run.runId, "grade", "error", `[stills] brand-engine /health returned HTTP ${health.status}. Aborting.`);
      return false;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await emitLog(run.runId, "grade", "error", `[stills] brand-engine sidecar unreachable: ${msg}. Aborting.`);
    return false;
  }

  run = await updateStageStatus(run, "grade", "running");
  const ok = auditMode
    ? await runAuditMode(run, manifest, traceId)
    : await runInLoopMode(run, manifest, traceId);
  run = await updateStageStatus(run, "grade", ok ? "completed" : "failed");

  // Lock stage is currently a no-op — Phase B leaves locking to the
  // operator (HUD's existing approve-still affordance). Wired here so the
  // stage definition aligns with run_logs and Phase E can flip status when
  // the HUD CTA fires.
  run = await updateStageStatus(run, "lock", "skipped");
  return ok;
}
