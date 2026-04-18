export type RunMode = "full" | "ingest" | "images" | "video" | "drift" | "export";

export type RunStatus = "pending" | "running" | "needs_review" | "blocked" | "completed" | "failed" | "cancelled";

export type StageStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type DeliverableStatus = "pending" | "generating" | "reviewing" | "approved" | "rejected" | "regenerating";

// Valid status transitions for deliverables — enforced by updateDeliverableStatus
export const VALID_DELIVERABLE_TRANSITIONS: Record<DeliverableStatus, DeliverableStatus[]> = {
  pending: ["generating"],
  generating: ["reviewing"],
  reviewing: ["approved", "rejected"],
  approved: [],
  rejected: ["regenerating"],
  regenerating: ["generating"],
};

export interface RunStage {
  id: string;
  name: string;
  status: StageStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface Run {
  runId: string;
  clientId: string;
  campaignId?: string;
  mode: RunMode;
  status: RunStatus;
  stages: RunStage[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  hitlRequired?: boolean;
  hitlNotes?: string;
}

export interface DriftMetric {
  id?: string;
  runId: string;
  artifactId?: string;
  clipZ?: number;
  e5Z?: number;
  cohereZ?: number;
  fusedZ?: number;
  clipRaw?: number;
  e5Raw?: number;
  cohereRaw?: number;
  gateDecision?: string;
  createdAt?: string;
}

export interface DriftAlert {
  id?: string;
  clientId: string;
  runId: string;
  severity: "warn" | "error" | "critical";
  message: string;
  fusedZ?: number;
  acknowledged?: boolean;
  acknowledgedAt?: string;
  resolutionNotes?: string;
  createdAt?: string;
}

export interface BrandBaseline {
  id?: string;
  clientId: string;
  version: number;
  isActive: boolean;
  geminiBaselineZ?: number;
  cohereBaselineZ?: number;
  fusedBaselineZ?: number;
  geminiBaselineRaw?: number;
  cohereBaselineRaw?: number;
  geminiStddev?: number;
  cohereStddev?: number;
  sampleCount?: number;
  createdAt?: string;
}

export interface RunLog {
  id: number;
  runId: string;
  timestamp: string;
  stage: string;
  level: "info" | "warn" | "error" | "debug";
  message: string;
}

export interface Client {
  id: string;
  name: string;
  status: string;
  lastRunId?: string;
  lastRunAt?: string;
  lastRunStatus?: RunStatus;
}

export interface Artifact {
  id: string;
  runId: string;
  clientId?: string;
  campaignId?: string;
  deliverableId?: string;
  type: "image" | "video" | "report" | "package";
  name: string;
  path: string;
  storagePath?: string;
  stage?: string;
  size?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface CampaignDeliverable {
  id: string;
  campaignId: string;
  description?: string;
  aiModel?: string;
  currentPrompt?: string;
  originalPrompt?: string;
  status: DeliverableStatus;
  retryCount: number;
  rejectionReason?: string;
  // Generation spec fields (Temp-gen sidecar pipeline)
  format?: "before_after" | "carousel" | "testimonial" | "heritage"
         | "problem_solution" | "review_ad" | "custom";
  mediaType?: "image" | "video" | "mixed";
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
  platform?: string;
  qualityTier?: "lite" | "fast" | "standard" | "pro";
  referenceImages?: string[];
  estimatedCost?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Campaign {
  id: string;
  clientId: string;
  name: string;
  prompt?: string;
  deliverables?: unknown;
  platforms?: string[];
  mode?: string;
  maxRetries: number;
  referenceImages?: string[];
  guardrails?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface HitlDecision {
  id?: string;
  runId: string;
  artifactId?: string;
  decision: "approved" | "rejected" | "needs_revision";
  notes?: string;
  gradeScores?: Record<string, number>;
  rejectionCategories?: string[];
  createdAt?: string;
}

export interface PlatformSpec {
  key: string;
  label: string;
  width: number;
  height: number;
  aspectRatio: string;
  crop: string;
  gravity: string;
}

export interface PlatformVariant {
  platform: string;
  label: string;
  width: number;
  height: number;
  aspectRatio: string;
  url: string;
}

export interface ReviewPayload {
  notes?: string;
  artifactId?: string;
  gradeScores?: Record<string, number>;
  rejectionCategories?: string[];
}

export interface PromptTemplate {
  id?: string;
  clientId: string;
  campaignId?: string;
  stage: string;
  version: number;
  promptText: string;
  parentId?: string;
  isActive: boolean;
  source?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface PromptScore {
  id?: string;
  promptId: string;
  runId: string;
  artifactId?: string;
  score: number;
  gateDecision?: string;
  feedback?: string;
  createdAt?: string;
}

export interface RunCreatePayload {
  mode: RunMode;
  campaignId?: string;
  deliverableIds?: string[];
  inputs?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────
// Escalation System Types (migration 007)
// ─────────────────────────────────────────────────────────────────────────

export type EscalationLevel = "L1" | "L2" | "L3";

export type EscalationStatus =
  | "in_progress"
  | "resolved"
  | "accepted"
  | "redesigned"
  | "replaced"
  | "hitl_required";

export type EscalationAction =
  | "prompt_fix"
  | "approach_change"
  | "accept"
  | "redesign"
  | "replace"
  // L3 sub-path: accept the clip as-is but flag for post-production VFX
  // enhancement (After Effects / Resolve / Nuke). Use when Veo gets composition
  // + motion + character right but degrades a discrete VFX effect that's easier
  // to repaint than to regenerate. See escalation-ops brief Rule L3_post_vfx_enhance.
  // Status-wise, this reuses `accepted` with resolution_path = "post_vfx".
  | "post_vfx";

export type KnownLimitationSeverity = "warning" | "blocking";

export interface KnownLimitation {
  id: string;
  model: string;
  category: string;
  failureMode: string;
  description: string;
  mitigation?: string;
  severity: KnownLimitationSeverity;
  detectedInProductionId?: string;
  detectedInRunId?: string;
  timesEncountered: number;
  lastEncounteredAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetEscalation {
  id: string;
  artifactId: string;
  deliverableId?: string;
  runId?: string;
  currentLevel: EscalationLevel;
  status: EscalationStatus;
  iterationCount: number;
  failureClass?: string;
  knownLimitationId?: string;
  resolutionPath?: EscalationAction;
  resolutionNotes?: string;
  finalArtifactId?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationDecisionRecord {
  id: string;
  escalationId: string;
  runId?: string;
  iteration: number;
  inputContext: Record<string, unknown>;
  decision: Record<string, unknown>;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  latencyMs?: number;
  createdAt: string;
}

// ─── Video Grade (mirrors brand-engine VideoGradeResult) ─────────────────
export interface VideoGradeCriterion {
  name: string;
  score: number;
  notes: string;
}

export interface VideoGradeResult {
  verdict: "PASS" | "WARN" | "FAIL";
  aggregate_score: number;
  criteria: VideoGradeCriterion[];
  detected_failure_classes: string[];
  confidence: number;
  summary: string;
  reasoning: string;
  recommendation:
    | "ship"
    | "L1_prompt_fix"
    | "L2_approach_change"
    | "L3_escalation"
    | "L3_accept_with_trim";
  model: string;
  cost: number;
  latency_ms: number;
  /**
   * Non-null iff the /grade_video call used the Rule-1 consensus path
   * (escalation-ops brief). Values describe the resolution taken:
   *   - "not borderline, single call"
   *   - "agreed N=2 (...)"
   *   - "disagreement resolved via frame extraction (...)"
   * The escalation loop uses presence of this field to flip
   * OrchestratorInput.consensusResolved = true, which tells the orchestrator
   * the verdict is authoritative and not subject to critic variance.
   */
  consensus_note?: string | null;
}

// ─── Orchestrator (Claude Opus 4.7) input/output contract ────────────────
export interface PromptHistoryEntry {
  iteration: number;
  stillPrompt?: string;
  veoPrompt?: string;
  negativePrompt?: string;
  verdict: string;
  failureClass?: string;
  gradeScore?: number;
  artifactId?: string;
  timestamp?: string;
}

export interface OrchestratorInput {
  artifact: Artifact;
  qaVerdict: VideoGradeResult | Record<string, unknown>; // image grade also acceptable
  promptHistory: PromptHistoryEntry[];
  knownLimitationsCatalog: KnownLimitation[];
  attemptCount: number;
  escalationLevel: EscalationLevel;
  deliverable: CampaignDeliverable;
  campaignContext: { prompt?: string; brandSlug: string; narrative?: string };
  // ─── 10a additions (orchestrator readiness) ────────────────────────────
  /**
   * ISO date (YYYY-MM-DD) as of the call. Injected into the user message so
   * the orchestrator always knows the current date — prevents stale-training
   * drift when reasoning about model ids, tool versions, external facts.
   */
  todayDate: string;
  /**
   * Per-shot cumulative USD cost across all orchestrator calls + any tracked
   * generation costs for this asset. The orchestrator uses this to self-check
   * Rule 5 (budget cap). Optional — caller computes from orchestration_decisions.
   */
  perShotCumulativeCost?: number;
  /**
   * Count of consecutive prior iterations where the orchestrator proposed the
   * same (or near-identical) prompt. Surfaced so orchestrator can escalate
   * instead of looping, and humans watching the SSE stream can intervene.
   */
  consecutiveSamePromptRegens?: number;
  /**
   * Ordered list of escalation levels used so far on this shot (e.g.
   * ["L1", "L1", "L2"]). Surfaced for human watcher + orchestrator self-check
   * on level progression.
   */
  levelsUsed?: EscalationLevel[];
  /**
   * True iff this call includes a post-consensus QA verdict (Rule 1). When
   * present, the orchestrator should treat the verdict as authoritative and
   * not suggest re-running QA.
   */
  consensusResolved?: boolean;
}

export interface OrchestratorDecision {
  level: EscalationLevel;
  action: EscalationAction;
  failure_class: string | null;
  known_limitation_id: string | null;
  new_still_prompt: string | null;
  new_veo_prompt: string | null;
  new_negative_prompt: string | null;
  redesign_option: "B" | "C" | null;
  reasoning: string;
  confidence: number;
  new_candidate_limitation?: {
    category: string;
    failure_mode: string;
    description: string;
    mitigation?: string;
    severity: KnownLimitationSeverity;
  } | null;
}

export interface OrchestratorCallResult {
  decision: OrchestratorDecision;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  latencyMs: number;
  /**
   * Tool invocations observed in the response (server-side web_search etc.).
   * Surfaced so /api/orchestrator/replay + callers that write to
   * orchestration_decisions can audit whether Vertex accepted/used tools.
   */
  toolUses?: {
    name: string;
    id: string;
    input: unknown;
  }[];
  /** Count of web_search server-tool invocations (for audit + cost). */
  webSearchCount?: number;
}

// ─── Run-level escalation report (Final HITL) ────────────────────────────
export interface DeliverableEscalationTrail {
  deliverable: CampaignDeliverable;
  escalations: AssetEscalation[];
  decisionHistory: OrchestrationDecisionRecord[];
  knownLimitationsHit: KnownLimitation[];
  totalRegenCost: number;
}

export interface RunEscalationReport {
  runId: string;
  clientId: string;
  campaignId?: string;
  status: RunStatus;
  startedAt?: string;
  completedAt?: string;
  deliverables: DeliverableEscalationTrail[];
  aggregate: {
    totalEscalations: number;
    totalOrchestratorCalls: number;
    totalOrchestratorCost: number;
    totalGenerationCost: number;
    knownLimitationsHit: { failureMode: string; count: number }[];
  };
  finalHitl?: {
    status: "pending" | "approved" | "rejected";
    reviewedAt?: string;
    reviewerNotes?: string;
  };
}

// Stage definitions for each mode
export const STAGE_DEFINITIONS: Record<RunMode, { id: string; name: string }[]> = {
  full: [
    { id: "ingest", name: "Ingest and Index" },
    { id: "retrieve", name: "Retrieve Brand Context" },
    { id: "generate", name: "Generate" },
    { id: "drift", name: "Drift Check" },
    { id: "hitl", name: "HITL Gate" },
    { id: "export", name: "Export Package" },
  ],
  ingest: [
    { id: "ingest", name: "Ingest and Index" },
  ],
  images: [
    { id: "generate_images", name: "Generate Images" },
  ],
  video: [
    { id: "generate_video", name: "Generate Video" },
  ],
  drift: [
    { id: "drift", name: "Drift Check" },
  ],
  export: [
    { id: "export", name: "Export Package" },
  ],
};
