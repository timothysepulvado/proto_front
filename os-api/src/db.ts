import { supabase } from "./supabase.js";
import { existsSync, readFileSync } from "fs";
import path from "path";
import type {
  Run, RunLog, Artifact, Client, HitlDecision, DriftMetric, DriftAlert,
  BrandBaseline, PromptTemplate, PromptScore, RunStatus, RunStage,
  Campaign, CampaignDeliverable, DeliverableStatus,
  KnownLimitation, KnownLimitationSeverity,
  AssetEscalation, EscalationLevel, EscalationStatus, EscalationAction,
  OrchestrationDecisionRecord, PromptHistoryEntry,
  BeatName, ShotSummary, RecentCampaignRun, RunDetail,
  MotionGateShotOfNote, MotionGateShotState, MotionPhaseGateState,
  DirectionDriftIndicator, DirectionDriftVerdictSource,
  ClientUiConfig,
  ArtifactIterationRow, ArtifactIterationsResponse, ArtifactIterationOperatorOverride,
  ArtifactIterationVerdict,
} from "./types.js";
import { VALID_DELIVERABLE_TRANSITIONS } from "./types.js";
import { recordCost, type CostEvent } from "./cost_ledger.js";

// ============ Database Row Types (snake_case, matching Supabase schema) ============

interface DbRun {
  id: string;
  client_id: string;
  campaign_id: string | null;
  mode: string;
  status: string;
  stages: RunStage[];
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  hitl_required: boolean;
  hitl_notes: string | null;
  // ADR-004 Phase B: migration 011_runs_metadata.sql added this column.
  // Default '{}'::jsonb so existing rows fall through cleanly.
  metadata: Record<string, unknown> | null;
}

interface DbRunLog {
  id: number;
  client_id: string;
  run_id: string;
  timestamp: string;
  stage: string;
  level: "info" | "warn" | "error" | "debug";
  message: string;
}

interface DbArtifact {
  id: string;
  run_id: string;
  client_id: string | null;
  campaign_id: string | null;
  deliverable_id: string | null;
  type: "image" | "video" | "report" | "package";
  name: string;
  path: string;
  storage_path: string | null;
  stage: string | null;
  size: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface DbClient {
  id: string;
  name: string;
  status: string;
  last_run_id: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  ui_config: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
}

// ============ Mappers (DB → App) ============

function mapDbClientUiConfig(value: Record<string, unknown> | null): ClientUiConfig | undefined {
  if (!value) return undefined;
  const displayName = typeof value.display_name === "string" ? value.display_name : undefined;
  const entityLabel = typeof value.entity_label === "string" ? value.entity_label : undefined;
  const featured = typeof value.featured === "boolean" ? value.featured : undefined;
  const productionSlug = typeof value.production_slug === "string" ? value.production_slug : undefined;
  const uiConfig: ClientUiConfig = {};
  if (displayName !== undefined) uiConfig.displayName = displayName;
  if (entityLabel !== undefined) uiConfig.entityLabel = entityLabel;
  if (featured !== undefined) uiConfig.featured = featured;
  if (productionSlug !== undefined) uiConfig.productionSlug = productionSlug;
  return Object.keys(uiConfig).length > 0 ? uiConfig : undefined;
}

function mapDbRunToRun(dbRun: DbRun): Run {
  return {
    runId: dbRun.id,
    clientId: dbRun.client_id,
    campaignId: dbRun.campaign_id ?? undefined,
    mode: dbRun.mode as Run["mode"],
    status: dbRun.status as Run["status"],
    stages: dbRun.stages,
    createdAt: dbRun.created_at,
    updatedAt: dbRun.updated_at,
    startedAt: dbRun.started_at ?? undefined,
    completedAt: dbRun.completed_at ?? undefined,
    error: dbRun.error ?? undefined,
    hitlRequired: dbRun.hitl_required,
    hitlNotes: dbRun.hitl_notes ?? undefined,
    metadata: dbRun.metadata ?? undefined,
  };
}

function mapDbLogToRunLog(dbLog: DbRunLog): RunLog {
  return {
    id: dbLog.id,
    clientId: dbLog.client_id,
    runId: dbLog.run_id,
    timestamp: dbLog.timestamp,
    stage: dbLog.stage,
    level: dbLog.level,
    message: dbLog.message,
  };
}

function mapDbArtifactToArtifact(dbArtifact: DbArtifact): Artifact {
  return {
    id: dbArtifact.id,
    runId: dbArtifact.run_id,
    clientId: dbArtifact.client_id ?? undefined,
    campaignId: dbArtifact.campaign_id ?? undefined,
    deliverableId: dbArtifact.deliverable_id ?? undefined,
    type: dbArtifact.type,
    name: dbArtifact.name,
    path: dbArtifact.path,
    storagePath: dbArtifact.storage_path ?? undefined,
    stage: dbArtifact.stage ?? undefined,
    size: dbArtifact.size ?? undefined,
    metadata: dbArtifact.metadata ?? undefined,
    createdAt: dbArtifact.created_at,
  };
}

function mapDbClientToClient(dbClient: DbClient): Client {
  const uiConfig = mapDbClientUiConfig(dbClient.ui_config);
  return {
    id: dbClient.id,
    name: dbClient.name,
    status: dbClient.status,
    uiConfig,
    featured: uiConfig?.featured,
    lastRunId: dbClient.last_run_id ?? undefined,
    lastRunAt: dbClient.last_run_at ?? undefined,
    lastRunStatus: (dbClient.last_run_status as RunStatus) ?? undefined,
  };
}

// ============ Mappers (App → DB) ============

function mapRunUpdatesToDb(updates: Partial<Run>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  if (updates.status !== undefined) mapped.status = updates.status;
  if (updates.stages !== undefined) mapped.stages = updates.stages;
  if (updates.startedAt !== undefined) mapped.started_at = updates.startedAt;
  if (updates.completedAt !== undefined) mapped.completed_at = updates.completedAt;
  if (updates.error !== undefined) mapped.error = updates.error;
  if (updates.hitlRequired !== undefined) mapped.hitl_required = updates.hitlRequired;
  if (updates.hitlNotes !== undefined) mapped.hitl_notes = updates.hitlNotes;
  // ADR-004 Phase B: stills runner uses runs.metadata to persist auditMode at
  // creation and audit_report at completion. Pass through whole-object writes
  // (callers typically read-modify-write to avoid clobbering peer keys).
  if (updates.metadata !== undefined) mapped.metadata = updates.metadata;
  return mapped;
}

const runClientIdCache = new Map<string, string>();
const campaignClientIdCache = new Map<string, string>();
const artifactClientIdCache = new Map<string, string>();
const escalationClientIdCache = new Map<string, string>();
const deliverableClientIdCache = new Map<string, string>();

function requireTenantMatch(
  source: "run" | "campaign" | "artifact" | "escalation" | "deliverable",
  sourceId: string,
  resolvedClientId: string,
  providedClientId?: string,
): string {
  if (providedClientId === undefined) return resolvedClientId;
  const normalizedProvidedClientId = providedClientId.trim();
  if (normalizedProvidedClientId !== resolvedClientId) {
    throw new Error(
      `Tenant mismatch: caller provided client_id=${normalizedProvidedClientId} but ${source} ${sourceId} belongs to client_id=${resolvedClientId}`,
    );
  }
  return resolvedClientId;
}

export async function requireClientIdForRun(runId: string, providedClientId?: string): Promise<string> {
  const cached = runClientIdCache.get(runId);
  if (cached) return requireTenantMatch("run", runId, cached, providedClientId);

  const { data, error } = await supabase
    .from("runs")
    .select("client_id")
    .eq("id", runId)
    .maybeSingle();

  if (error) throw new Error(`Failed to resolve client_id for run ${runId}: ${error.message}`);
  const clientId = (data as { client_id?: string } | null)?.client_id;
  if (!clientId) throw new Error(`Run ${runId} is missing client_id`);
  runClientIdCache.set(runId, clientId);
  return requireTenantMatch("run", runId, clientId, providedClientId);
}

export async function requireClientIdForCampaign(campaignId: string, providedClientId?: string): Promise<string> {
  const cached = campaignClientIdCache.get(campaignId);
  if (cached) return requireTenantMatch("campaign", campaignId, cached, providedClientId);

  const { data, error } = await supabase
    .from("campaigns")
    .select("client_id")
    .eq("id", campaignId)
    .maybeSingle();

  if (error) throw new Error(`Failed to resolve client_id for campaign ${campaignId}: ${error.message}`);
  const clientId = (data as { client_id?: string } | null)?.client_id;
  if (!clientId) throw new Error(`Campaign ${campaignId} is missing client_id`);
  campaignClientIdCache.set(campaignId, clientId);
  return requireTenantMatch("campaign", campaignId, clientId, providedClientId);
}

export async function requireClientIdForArtifact(artifactId: string, providedClientId?: string): Promise<string> {
  const cached = artifactClientIdCache.get(artifactId);
  if (cached) return requireTenantMatch("artifact", artifactId, cached, providedClientId);

  const { data, error } = await supabase
    .from("artifacts")
    .select("client_id")
    .eq("id", artifactId)
    .maybeSingle();

  if (error) throw new Error(`Failed to resolve client_id for artifact ${artifactId}: ${error.message}`);
  const clientId = (data as { client_id?: string } | null)?.client_id;
  if (!clientId) throw new Error(`Artifact ${artifactId} is missing client_id`);
  artifactClientIdCache.set(artifactId, clientId);
  return requireTenantMatch("artifact", artifactId, clientId, providedClientId);
}

export async function requireClientIdForEscalation(escalationId: string, providedClientId?: string): Promise<string> {
  const cached = escalationClientIdCache.get(escalationId);
  if (cached) return requireTenantMatch("escalation", escalationId, cached, providedClientId);

  const { data, error } = await supabase
    .from("asset_escalations")
    .select("client_id")
    .eq("id", escalationId)
    .maybeSingle();

  if (error) throw new Error(`Failed to resolve client_id for escalation ${escalationId}: ${error.message}`);
  const clientId = (data as { client_id?: string } | null)?.client_id;
  if (!clientId) throw new Error(`Escalation ${escalationId} is missing client_id`);
  escalationClientIdCache.set(escalationId, clientId);
  return requireTenantMatch("escalation", escalationId, clientId, providedClientId);
}

export async function requireClientIdForDeliverable(deliverableId: string, providedClientId?: string): Promise<string> {
  const cached = deliverableClientIdCache.get(deliverableId);
  if (cached) return requireTenantMatch("deliverable", deliverableId, cached, providedClientId);

  const { data, error } = await supabase
    .from("campaign_deliverables")
    .select("client_id")
    .eq("id", deliverableId)
    .maybeSingle();

  if (error) throw new Error(`Failed to resolve client_id for deliverable ${deliverableId}: ${error.message}`);
  const clientId = (data as { client_id?: string } | null)?.client_id;
  if (!clientId) throw new Error(`Deliverable ${deliverableId} is missing client_id`);
  deliverableClientIdCache.set(deliverableId, clientId);
  return requireTenantMatch("deliverable", deliverableId, clientId, providedClientId);
}

// ============ Run Operations ============

export async function createRun(run: Run): Promise<Run> {
  const { data, error } = await supabase
    .from("runs")
    .insert({
      id: run.runId,
      client_id: run.clientId,
      campaign_id: run.campaignId ?? null,
      mode: run.mode,
      status: run.status,
      stages: run.stages,
      started_at: run.startedAt ?? null,
      completed_at: run.completedAt ?? null,
      error: run.error ?? null,
      hitl_required: run.hitlRequired ?? false,
      hitl_notes: run.hitlNotes ?? null,
      // ADR-004 Phase B: stills runner reads metadata.audit_mode at execution
      // time to choose the audit vs in-loop path. Default '{}' if caller
      // hasn't set it so the column never holds NULL (matches DB default).
      metadata: run.metadata ?? {},
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create run: ${error.message}`);
  }

  return mapDbRunToRun(data as DbRun);
}

export async function getRun(runId: string): Promise<Run | null> {
  const { data, error } = await supabase
    .from("runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to get run: ${error.message}`);
  }

  if (!data) return null;
  return mapDbRunToRun(data as DbRun);
}

export async function updateRun(runId: string, updates: Partial<Run>): Promise<Run | null> {
  const dbUpdates = mapRunUpdatesToDb(updates);

  const { data, error } = await supabase
    .from("runs")
    .update(dbUpdates)
    .eq("id", runId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update run: ${error.message}`);
  }

  return mapDbRunToRun(data as DbRun);
}

export async function getRunsByClient(clientId: string): Promise<Run[]> {
  const { data, error } = await supabase
    .from("runs")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to get runs by client: ${error.message}`);
  }

  return (data as DbRun[]).map(mapDbRunToRun);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function extractRunShotIds(metadata: Record<string, unknown> | undefined): number[] | null {
  const raw = metadata?.shot_ids;
  if (!Array.isArray(raw)) return null;
  const shotIds = raw
    .map((item) => {
      if (typeof item === "number" && Number.isInteger(item)) return item;
      if (typeof item === "string") {
        const parsed = Number.parseInt(item, 10);
        return Number.isInteger(parsed) ? parsed : null;
      }
      return null;
    })
    .filter((item): item is number => item !== null && item > 0);
  return shotIds.length > 0 ? [...new Set(shotIds)] : null;
}

export function getRunDurationSeconds(run: Pick<Run, "createdAt" | "startedAt" | "completedAt" | "status">, now = new Date()): number | null {
  const startedAt = run.startedAt ?? run.createdAt;
  const startMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startMs)) return null;

  const endSource = run.completedAt ?? (run.status === "running" || run.status === "pending" ? now.toISOString() : undefined);
  if (!endSource) return null;
  const endMs = new Date(endSource).getTime();
  if (!Number.isFinite(endMs) || endMs < startMs) return null;
  return Math.round((endMs - startMs) / 1000);
}

export function summarizeRecentCampaignRun(run: Run, now = new Date()): RecentCampaignRun {
  const metadata = run.metadata ?? {};
  const parentRunId = readString(metadata.parentRunId) ?? readString(metadata.parent_run_id);
  return {
    runId: run.runId,
    clientId: run.clientId,
    campaignId: run.campaignId,
    mode: run.mode,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationSeconds: getRunDurationSeconds(run, now),
    hitlRequired: run.hitlRequired === true,
    hitlNotes: run.hitlNotes,
    shotIds: extractRunShotIds(metadata),
    auditMode: typeof metadata.audit_mode === "boolean" ? metadata.audit_mode : null,
    parentRunId,
  };
}

export function sumOrchestrationDecisionCost(
  decisions: Array<Pick<OrchestrationDecisionRecord, "cost" | "inputContext" | "decision">>,
): number {
  return decisions.reduce((sum, item) => {
    const direct = readNumber(item.cost);
    if (direct !== undefined) return sum + direct;
    const inputMeta = isRecord(item.inputContext.metadata) ? item.inputContext.metadata : null;
    const decisionMeta = isRecord(item.decision.metadata) ? item.decision.metadata : null;
    return sum + (readNumber(inputMeta?.cost) ?? readNumber(decisionMeta?.cost) ?? 0);
  }, 0);
}

export async function getRecentRunsByCampaign(campaignId: string, limit = 10): Promise<RecentCampaignRun[]> {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const { data, error } = await supabase
    .from("runs")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (error) {
    throw new Error(`Failed to get recent campaign runs: ${error.message}`);
  }

  return (data as DbRun[]).map((row) => summarizeRecentCampaignRun(mapDbRunToRun(row)));
}

export async function getRunDetail(runId: string): Promise<RunDetail | null> {
  const run = await getRun(runId);
  if (!run) return null;

  const [logs, artifacts, decisions] = await Promise.all([
    getLogsByRun(runId),
    getArtifactsByRun(runId),
    getOrchestrationDecisionsByRun(runId),
  ]);

  let relatedStillsRun: RecentCampaignRun | null = null;
  const metadata = run.metadata ?? {};
  const parentRunId = readString(metadata.parentRunId) ?? readString(metadata.parent_run_id);
  if (run.mode === "video" && parentRunId) {
    const parentRun = await getRun(parentRunId);
    if (parentRun?.mode === "stills") {
      relatedStillsRun = summarizeRecentCampaignRun(parentRun);
    }
  }

  return {
    run,
    logs,
    artifacts,
    orchestrationDecisionCount: decisions.length,
    totalOrchestrationCost: sumOrchestrationDecisionCost(decisions),
    relatedStillsRun,
  };
}

// ── Gap 6: Stills → Veo motion-phase gate helpers ─────────────────────────

const MOTION_GATE_LOCKED_STATUSES = new Set<DeliverableStatus>(["approved", "reviewing"]);
const MOTION_GATE_STILLS_BLOCKING_RUN_MODES = new Set<Run["mode"]>(["stills"]);

interface MotionGateDeliverableInput {
  id: string;
  status: DeliverableStatus;
  description?: string;
}

interface MotionGateRunInput {
  runId: string;
  mode: Run["mode"];
  status: Run["status"];
  createdAt: string;
  hitlRequired?: boolean;
  metadata?: Record<string, unknown>;
}

interface MotionGateEscalationInput {
  id: string;
  deliverableId?: string;
  runId?: string;
  status: EscalationStatus;
  resolutionPath?: EscalationAction;
  resolutionNotes?: string;
  failureClass?: string;
  resolvedAt?: string;
  updatedAt?: string;
}

interface MotionGateApprovedDecisionInput {
  deliverableId: string;
  notes?: string;
  runId?: string;
  createdAt?: string;
}

interface MotionGateManifestShot {
  id?: unknown;
  shot_number?: unknown;
  shotNumber?: unknown;
  visual?: unknown;
  still_prompt?: unknown;
  veo_prompt?: unknown;
  characters_needed?: unknown;
}

interface MotionGateManifest {
  characters?: Record<string, unknown>;
  shots?: MotionGateManifestShot[];
}

export interface MotionPhaseGateAggregationInput {
  campaignId: string;
  productionSlug?: string;
  deliverables: MotionGateDeliverableInput[];
  runs: MotionGateRunInput[];
  escalations: MotionGateEscalationInput[];
  approvedDecisions?: MotionGateApprovedDecisionInput[];
  manifest?: MotionGateManifest | null;
  now?: Date;
}

export function deriveDeliverableShotNumber(
  deliverable: Pick<CampaignDeliverable, "description"> | MotionGateDeliverableInput,
  index = 0,
): number {
  const description = deliverable.description ?? "";
  const match = /shot\s+(\d{1,3})/i.exec(description);
  return match ? Number.parseInt(match[1] as string, 10) : index + 1;
}

function readInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function extractShotNumberFromStillPath(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /shot[_-]?(\d{1,3})/i.exec(value);
  if (!match) return null;
  const parsed = Number.parseInt(match[1] as string, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function textPreview(value: string | undefined, fallback: string, max = 180): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function productionSlugFromRunsOrCampaign(campaign: Campaign | null, runs: Run[]): string | undefined {
  for (const run of runs) {
    const slug = readString(run.metadata?.production_slug);
    if (slug) return slug;
  }
  const guardrails = isRecord(campaign?.guardrails) ? campaign.guardrails : null;
  const configuredSlug = readString(guardrails?.production_slug)
    ?? readString(guardrails?.productionSlug)
    ?? readString(guardrails?.temp_gen_production_slug)
    ?? readString(guardrails?.tempGenProductionSlug);
  if (configuredSlug) return configuredSlug;
  const fallbackSlug = readString(process.env.DEFAULT_PRODUCTION_SLUG)
    ?? readString(process.env.TEMP_GEN_PRODUCTION_SLUG);
  if (fallbackSlug) return fallbackSlug;
  return undefined;
}

function loadMotionGateManifest(productionSlug?: string): MotionGateManifest | null {
  if (!productionSlug) return null;
  const tempGenRoot = process.env.TEMP_GEN_DIR
    ?? process.env.TEMP_GEN_PATH
    ?? path.join(process.env.HOME ?? "", "Temp-gen");
  const manifestPath = path.join(tempGenRoot, "productions", productionSlug, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as MotionGateManifest;
  } catch {
    return null;
  }
}

function notePriority(state: MotionGateShotState): number {
  switch (state) {
    case "pending": return 5;
    case "operator-override": return 4;
    case "operator-accepted": return 3;
    case "canonical": return 2;
    case "locked": return 1;
  }
}

function upsertMotionNote(
  notes: Map<number, MotionGateShotOfNote>,
  note: MotionGateShotOfNote,
): void {
  const existing = notes.get(note.shotNumber);
  if (!existing || notePriority(note.state) > notePriority(existing.state)) {
    notes.set(note.shotNumber, note);
    return;
  }
  if (existing && notePriority(note.state) === notePriority(existing.state)) {
    notes.set(note.shotNumber, {
      ...existing,
      summary: existing.summary.includes(note.summary) ? existing.summary : `${existing.summary} ${note.summary}`,
    });
  }
}

export function aggregateMotionPhaseGateState(input: MotionPhaseGateAggregationInput): MotionPhaseGateState {
  const now = input.now ?? new Date();
  const deliverableEntries = input.deliverables.map((deliverable, index) => ({
    deliverable,
    shotNumber: deriveDeliverableShotNumber(deliverable, index),
  }));
  const deliverableById = new Map(deliverableEntries.map((entry) => [entry.deliverable.id, entry]));
  const deliverableByShot = new Map<number, (typeof deliverableEntries)[number]>();
  for (const entry of deliverableEntries) {
    if (!deliverableByShot.has(entry.shotNumber)) deliverableByShot.set(entry.shotNumber, entry);
  }

  const lockedEntries = deliverableEntries.filter((entry) => MOTION_GATE_LOCKED_STATUSES.has(entry.deliverable.status));
  const lockedShotNumbers = new Set(lockedEntries.map((entry) => entry.shotNumber));
  const lockedDeliverableIds = lockedEntries.map((entry) => entry.deliverable.id);

  const runsById = new Map(input.runs.map((run) => [run.runId, run]));
  const stillsRunIds = new Set(
    input.runs
      .filter((run) => MOTION_GATE_STILLS_BLOCKING_RUN_MODES.has(run.mode))
      .map((run) => run.runId),
  );
  const latestStillsRun = input.runs
    .filter((run) => run.mode === "stills")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

  const operatorConfirmedShots = new Set<number>();
  const openHitlDeliverables = new Set<string>();
  const notes = new Map<number, MotionGateShotOfNote>();

  for (const run of input.runs) {
    const rawOverrides = isRecord(run.metadata?.operator_override) ? run.metadata.operator_override : null;
    if (!rawOverrides) continue;
    for (const [key, rawValue] of Object.entries(rawOverrides)) {
      const match = /^shot_(\d{1,3})$/i.exec(key);
      if (!match || !isRecord(rawValue)) continue;
      const shotNumber = Number.parseInt(match[1] as string, 10);
      if (!lockedShotNumbers.has(shotNumber)) continue;
      operatorConfirmedShots.add(shotNumber);
      const entry = deliverableByShot.get(shotNumber);
      upsertMotionNote(notes, {
        shotNumber,
        deliverableId: entry?.deliverable.id,
        state: "operator-override",
        source: "operator_override",
        runId: run.runId,
        criticScore: readNumber(rawValue.critic_score),
        criticVerdict: readString(rawValue.critic_verdict),
        decidedIter: readInteger(rawValue.decided_iter),
        decisionBy: readString(rawValue.decision_by),
        decisionAt: readString(rawValue.decision_at),
        summary: textPreview(
          readString(rawValue.rationale),
          `Operator override recorded on run ${run.runId.slice(0, 8)}.`,
        ),
      });
    }
  }

  for (const escalation of input.escalations) {
    if (!escalation.deliverableId) continue;
    const entry = deliverableById.get(escalation.deliverableId);
    if (!entry) continue;
    const run = escalation.runId ? runsById.get(escalation.runId) : undefined;
    const isStillsStageSignal = !escalation.runId || stillsRunIds.has(escalation.runId);

    if (escalation.status === "hitl_required" && isStillsStageSignal) {
      openHitlDeliverables.add(escalation.deliverableId);
      upsertMotionNote(notes, {
        shotNumber: entry.shotNumber,
        deliverableId: entry.deliverable.id,
        state: "pending",
        source: "asset_escalation",
        runId: escalation.runId,
        summary: `Pending stills HITL${escalation.failureClass ? `: ${escalation.failureClass.replace(/_/g, " ")}` : ""}.`,
      });
    }

    if (
      escalation.status === "accepted"
      && escalation.resolutionPath === "accept"
      && isStillsStageSignal
      && lockedShotNumbers.has(entry.shotNumber)
    ) {
      operatorConfirmedShots.add(entry.shotNumber);
      upsertMotionNote(notes, {
        shotNumber: entry.shotNumber,
        deliverableId: entry.deliverable.id,
        state: "operator-accepted",
        source: "asset_escalation",
        runId: escalation.runId ?? run?.runId,
        decisionAt: escalation.resolvedAt,
        summary: textPreview(
          escalation.resolutionNotes,
          `Operator accepted still via ${escalation.runId ? `run ${escalation.runId.slice(0, 8)}` : "escalation history"}.`,
        ),
      });
    }
  }

  for (const run of input.runs) {
    if (!run.hitlRequired) continue;
    if (!MOTION_GATE_STILLS_BLOCKING_RUN_MODES.has(run.mode)) continue;
    const shotIds = extractRunShotIds(run.metadata);
    if (shotIds?.length) {
      for (const shotNumber of shotIds) {
        const entry = deliverableByShot.get(shotNumber);
        if (entry) openHitlDeliverables.add(entry.deliverable.id);
      }
    } else {
      for (const entry of lockedEntries) openHitlDeliverables.add(entry.deliverable.id);
    }
  }

  for (const decision of input.approvedDecisions ?? []) {
    const entry = deliverableById.get(decision.deliverableId);
    if (!entry || !lockedShotNumbers.has(entry.shotNumber)) continue;
    operatorConfirmedShots.add(entry.shotNumber);
    upsertMotionNote(notes, {
      shotNumber: entry.shotNumber,
      deliverableId: entry.deliverable.id,
      state: "operator-accepted",
      source: "asset_escalation",
      runId: decision.runId,
      decisionAt: decision.createdAt,
      summary: textPreview(decision.notes, "Explicit HITL approval recorded."),
    });
  }

  const manifest = input.manifest;
  if (manifest?.characters && isRecord(manifest.characters)) {
    for (const [characterName, rawCharacter] of Object.entries(manifest.characters)) {
      if (!isRecord(rawCharacter)) continue;
      const shotNumber = extractShotNumberFromStillPath(rawCharacter.canonical_reference_still);
      if (!shotNumber || !lockedShotNumbers.has(shotNumber)) continue;
      const entry = deliverableByShot.get(shotNumber);
      upsertMotionNote(notes, {
        shotNumber,
        deliverableId: entry?.deliverable.id,
        state: "canonical",
        source: "canonical_reference",
        decisionAt: readString(rawCharacter.canonical_reference_locked_at),
        decisionBy: readString(rawCharacter.canonical_reference_locked_by),
        summary: textPreview(
          readString(rawCharacter.canonical_reference_rationale),
          `${characterName.replace(/_/g, " ")} canonical reference locked for motion anchoring.`,
        ),
      });
    }
  }

  for (const shot of manifest?.shots ?? []) {
    const shotNumber = readInteger(shot.id) ?? readInteger(shot.shot_number) ?? readInteger(shot.shotNumber);
    if (!shotNumber || !lockedShotNumbers.has(shotNumber)) continue;
    const text = [
      readString(shot.visual),
      readString(shot.still_prompt),
      readString(shot.veo_prompt),
      ...readStringArray(shot.characters_needed),
    ].filter(Boolean).join(" ").toLowerCase();
    const entry = deliverableByShot.get(shotNumber);

    if (/\bsplit[-\s]screen\b|\bsplit[-\s]level\b/.test(text)) {
      upsertMotionNote(notes, {
        shotNumber,
        deliverableId: entry?.deliverable.id,
        state: "locked",
        source: "manifest",
        summary: "Split-screen/split-level composition is accepted; preserve the human-machine mirror during Veo motion.",
      });
    }

    if (
      /\brampaging\b/.test(text)
      || /\bglowing\s+(digital\s+)?sphere\b/.test(text)
      || /\bmagical?\s+orb\b/.test(text)
    ) {
      upsertMotionNote(notes, {
        shotNumber,
        deliverableId: entry?.deliverable.id,
        state: "pending",
        source: "manifest",
        summary: "Alt-angle/direction check pending: manifest beat still references a rampaging mech or glowing sphere that can collide with the current documentary-dry mantra.",
      });
    }
  }

  const lockedCount = lockedEntries.length;
  const operatorConfirmedCount = lockedEntries.filter((entry) => operatorConfirmedShots.has(entry.shotNumber)).length;
  const openHitlCount = openHitlDeliverables.size;

  return {
    campaignId: input.campaignId,
    productionSlug: input.productionSlug,
    lockedDeliverableIds,
    lockedCount,
    operatorConfirmedCount,
    lockedWithoutExplicitApprovalCount: Math.max(0, lockedCount - operatorConfirmedCount),
    openHitlCount,
    blocked: openHitlCount > 0,
    latestStillsRunId: latestStillsRun?.runId,
    shotsOfNote: [...notes.values()].sort((a, b) => a.shotNumber - b.shotNumber),
    generatedAt: now.toISOString(),
  };
}

export async function getMotionPhaseGateState(campaignId: string): Promise<MotionPhaseGateState> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  const [deliverables, runs] = await Promise.all([
    getDeliverablesByCampaign(campaignId),
    (async () => {
      const { data, error } = await supabase
        .from("runs")
        .select("*")
        .eq("campaign_id", campaignId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw new Error(`Failed to get campaign runs for motion gate: ${error.message}`);
      return (data as DbRun[]).map((row) => mapDbRunToRun(row));
    })(),
  ]);

  const deliverableIds = deliverables.map((deliverable) => deliverable.id);
  const runIds = runs.map((run) => run.runId);

  let escalations: AssetEscalation[] = [];
  if (deliverableIds.length > 0) {
    const { data, error } = await supabase
      .from("asset_escalations")
      .select("*")
      .in("deliverable_id", deliverableIds)
      .order("updated_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(`Failed to get campaign escalations for motion gate: ${error.message}`);
    escalations = (data as DbAssetEscalation[]).map(mapAssetEscalation);
  }

  const approvedDecisions: MotionGateApprovedDecisionInput[] = [];
  if (deliverableIds.length > 0) {
    const { data: artifacts, error: artifactError } = await supabase
      .from("artifacts")
      .select("id, deliverable_id")
      .in("deliverable_id", deliverableIds);
    if (artifactError) throw new Error(`Failed to get campaign artifacts for motion gate: ${artifactError.message}`);
    const artifactRows = (artifacts ?? []) as Array<{ id: string; deliverable_id: string | null }>;
    const artifactToDeliverable = new Map(
      artifactRows
        .filter((row): row is { id: string; deliverable_id: string } => Boolean(row.deliverable_id))
        .map((row) => [row.id, row.deliverable_id]),
    );
    const artifactIds = [...artifactToDeliverable.keys()];
    if (artifactIds.length > 0) {
      const { data: decisions, error: decisionError } = await supabase
        .from("hitl_decisions")
        .select("*")
        .in("artifact_id", artifactIds)
        .order("created_at", { ascending: false })
        .limit(500);
      if (decisionError) throw new Error(`Failed to get HITL decisions for motion gate: ${decisionError.message}`);
      for (const decision of (decisions as DbHitlDecision[] ?? [])) {
        if (decision.decision !== "approved" && decision.decision !== "approve") continue;
        const deliverableId = decision.artifact_id ? artifactToDeliverable.get(decision.artifact_id) : undefined;
        if (!deliverableId) continue;
        approvedDecisions.push({
          deliverableId,
          notes: decision.notes ?? undefined,
          runId: runIds.includes(decision.run_id) ? decision.run_id : undefined,
          createdAt: decision.created_at,
        });
      }
    }
  }

  const productionSlug = productionSlugFromRunsOrCampaign(campaign, runs);
  const manifest = loadMotionGateManifest(productionSlug);

  return aggregateMotionPhaseGateState({
    campaignId,
    productionSlug,
    deliverables,
    runs,
    escalations,
    approvedDecisions,
    manifest,
  });
}

// ── Gap 7: Direction-drift indicators ──────────────────────────────────────

export const DIRECTION_DRIFT_FALLBACK_CLASS = "direction_reversion_intent_vs_mantra_manifest_caveat";

const DIRECTION_DRIFT_CLASS_PATTERNS = [
  /^campaign_direction_reversion_/i,
  /^documentary_polish_drift_/i,
  /direction_drift/i,
  /direction_reversion/i,
  /abandoned_direction/i,
  /^aftermath_mantra_violation_/i,
];

export function isDirectionDriftFailureClass(value: string | null | undefined): boolean {
  if (!value) return false;
  return DIRECTION_DRIFT_CLASS_PATTERNS.some((pattern) => pattern.test(value));
}

function uniqueDirectionDriftClasses(values: string[]): string[] {
  return [...new Set(values.filter(isDirectionDriftFailureClass))].sort();
}

type DirectionDriftVerdict = "PASS" | "WARN" | "FAIL";

export interface DirectionDriftVerdictEvent {
  deliverableId: string;
  shotNumber: number | null;
  runId: string | null;
  timestamp: string;
  source: DirectionDriftVerdictSource;
  verdict: DirectionDriftVerdict | null;
  score: number | null;
  failureClasses: string[];
  logId?: number;
  decisionId?: string;
  clearsDirectionDrift?: boolean;
}

export interface DirectionDriftAggregationInput {
  deliverables: Array<Pick<CampaignDeliverable, "id" | "description">>;
  events: DirectionDriftVerdictEvent[];
  now?: Date;
}

function directionDriftTimelineEventId(event: DirectionDriftVerdictEvent): string | undefined {
  if (event.logId !== undefined) return `log-${event.logId}`;
  if (event.decisionId) return `grade-${event.decisionId}`;
  return undefined;
}

function directionEventPriority(event: DirectionDriftVerdictEvent): number {
  if (event.clearsDirectionDrift) return 5;
  if (event.source === "manifest_caveat") return 4;
  if (event.decisionId) return 3;
  if (event.logId !== undefined) return 2;
  return 1;
}

export function aggregateDirectionDriftIndicators(
  input: DirectionDriftAggregationInput,
): Map<string, DirectionDriftIndicator> {
  const byDeliverable = new Map<string, DirectionDriftVerdictEvent[]>();
  for (const event of input.events) {
    const list = byDeliverable.get(event.deliverableId) ?? [];
    list.push(event);
    byDeliverable.set(event.deliverableId, list);
  }

  const output = new Map<string, DirectionDriftIndicator>();
  input.deliverables.forEach((deliverable, index) => {
    const events = [...(byDeliverable.get(deliverable.id) ?? [])].sort((left, right) => {
      const timeDelta = new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime();
      if (timeDelta !== 0) return timeDelta;
      const priorityDelta = directionEventPriority(right) - directionEventPriority(left);
      if (priorityDelta !== 0) return priorityDelta;
      return (right.logId ?? 0) - (left.logId ?? 0);
    });
    const latest = events[0] ?? null;
    const matchedClasses = latest ? uniqueDirectionDriftClasses(latest.failureClasses) : [];
    const directionDrift = Boolean(latest && !latest.clearsDirectionDrift && matchedClasses.length > 0);
    output.set(deliverable.id, {
      deliverableId: deliverable.id,
      shotNumber: latest?.shotNumber ?? deriveDeliverableShotNumber(deliverable, index),
      directionDrift,
      latestVerdictRunId: latest?.runId ?? null,
      latestVerdictTimestamp: latest?.timestamp ?? null,
      matchedClasses,
      source: latest?.source ?? null,
      verdict: latest?.verdict ?? null,
      score: latest?.score ?? null,
      latestVerdictLogId: latest?.logId,
      latestVerdictDecisionId: latest?.decisionId,
      timelineEventId: latest ? directionDriftTimelineEventId(latest) : undefined,
    });
  });
  return output;
}

const AUDIT_VERDICT_RE = /\[audit_verdict\]\s+shot=(\d{1,3})\b.*?\bverdict=(PASS|WARN|FAIL)\b.*?\bscore=([0-9.]+).*?\bfailure_classes=([^\s]+)/i;
const IN_LOOP_GRADE_RE = /\[in_loop\]\s+shot\s+(\d{1,3})\s+iter\s+\d+:\s+(PASS|WARN|FAIL)\s+score=([0-9.]+)\s+→\s+([A-Za-z0-9_]+)/i;
const IN_LOOP_SHIP_RE = /\[in_loop\]\s+shot\s+(\d{1,3})\s*:\s+SHIP at iter/i;
const IN_LOOP_ACCEPT_RE = /\[in_loop\]\s+shot\s+(\d{1,3})\s+iter\s+\d+:\s+orchestrator accepted/i;

function parseFailureClasses(value: string | undefined): string[] {
  if (!value || value.toLowerCase() === "none") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function eventTime(value: string | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function readQaFailureClasses(qa: Record<string, unknown> | null): string[] {
  if (!qa) return [];
  return readStringArray(qa.detected_failure_classes)
    .concat(readStringArray(qa.detectedFailureClasses))
    .concat(readStringArray(qa.failure_classes))
    .concat(readStringArray(qa.failureClasses));
}

function extractQaRecord(inputContext: Record<string, unknown>): Record<string, unknown> | null {
  const qa = inputContext.qa_verdict ?? inputContext.qaVerdict;
  return isRecord(qa) ? qa : null;
}

function runTouchesShot(run: Run, shotNumber: number): boolean {
  const shotIds = extractRunShotIds(run.metadata);
  if (!shotIds) return true;
  return shotIds.includes(shotNumber);
}

function extractAuditReportEvents(
  run: Run,
  deliverableByShot: Map<number, CampaignDeliverable>,
): DirectionDriftVerdictEvent[] {
  const auditReport = isRecord(run.metadata?.audit_report) ? run.metadata.audit_report : null;
  const shots = Array.isArray(auditReport?.shots) ? auditReport.shots : [];
  const timestamp = readString(auditReport?.completedAt)
    ?? readString(auditReport?.completed_at)
    ?? run.completedAt
    ?? run.updatedAt
    ?? run.createdAt;
  const events: DirectionDriftVerdictEvent[] = [];

  for (const rawShot of shots) {
    if (!isRecord(rawShot)) continue;
    const shotNumber = readInteger(rawShot.shotId)
      ?? readInteger(rawShot.shot_id)
      ?? readInteger(rawShot.shotNumber)
      ?? readInteger(rawShot.shot_number);
    if (!shotNumber) continue;
    const deliverable = deliverableByShot.get(shotNumber);
    if (!deliverable) continue;
    const verdict = readString(rawShot.verdict);
    events.push({
      deliverableId: deliverable.id,
      shotNumber,
      runId: run.runId,
      timestamp,
      source: "audit_report",
      verdict: verdict === "PASS" || verdict === "WARN" || verdict === "FAIL" ? verdict : null,
      score: readNumber(rawShot.aggregateScore) ?? readNumber(rawShot.aggregate_score) ?? null,
      failureClasses: readStringArray(rawShot.detectedFailureClasses)
        .concat(readStringArray(rawShot.detected_failure_classes))
        .concat(readStringArray(rawShot.failureClasses))
        .concat(readStringArray(rawShot.failure_classes)),
    });
  }

  return events;
}

function extractRunLogDirectionEvents(
  logs: RunLog[],
  runById: Map<string, Run>,
  deliverableByShot: Map<number, CampaignDeliverable>,
): DirectionDriftVerdictEvent[] {
  const events: DirectionDriftVerdictEvent[] = [];

  for (const log of logs) {
    const auditMatch = AUDIT_VERDICT_RE.exec(log.message);
    if (auditMatch) {
      const shotNumber = Number.parseInt(auditMatch[1] as string, 10);
      const deliverable = deliverableByShot.get(shotNumber);
      if (!deliverable) continue;
      events.push({
        deliverableId: deliverable.id,
        shotNumber,
        runId: log.runId,
        timestamp: log.timestamp,
        source: "run_logs",
        verdict: auditMatch[2] as DirectionDriftVerdict,
        score: Number.parseFloat(auditMatch[3] as string),
        failureClasses: parseFailureClasses(auditMatch[4]),
        logId: log.id,
      });
      continue;
    }

    const gradeMatch = IN_LOOP_GRADE_RE.exec(log.message);
    if (gradeMatch) {
      const shotNumber = Number.parseInt(gradeMatch[1] as string, 10);
      const run = runById.get(log.runId);
      if (run && !runTouchesShot(run, shotNumber)) continue;
      const deliverable = deliverableByShot.get(shotNumber);
      if (!deliverable) continue;
      events.push({
        deliverableId: deliverable.id,
        shotNumber,
        runId: log.runId,
        timestamp: log.timestamp,
        source: "run_logs",
        verdict: gradeMatch[2] as DirectionDriftVerdict,
        score: Number.parseFloat(gradeMatch[3] as string),
        failureClasses: [],
        logId: log.id,
      });
      continue;
    }

    const shipMatch = IN_LOOP_SHIP_RE.exec(log.message);
    const acceptMatch = IN_LOOP_ACCEPT_RE.exec(log.message);
    const clearMatch = shipMatch ?? acceptMatch;
    if (clearMatch) {
      const shotNumber = Number.parseInt(clearMatch[1] as string, 10);
      const deliverable = deliverableByShot.get(shotNumber);
      if (!deliverable) continue;
      events.push({
        deliverableId: deliverable.id,
        shotNumber,
        runId: log.runId,
        timestamp: log.timestamp,
        source: "run_logs",
        verdict: shipMatch ? "PASS" : null,
        score: null,
        failureClasses: [],
        logId: log.id,
        clearsDirectionDrift: true,
      });
    }
  }

  return events;
}

function manifestDirectionCaveatEvents(
  manifest: MotionGateManifest | null,
  deliverableByShot: Map<number, CampaignDeliverable>,
  latestAuditEventByShot: Map<number, DirectionDriftVerdictEvent>,
): DirectionDriftVerdictEvent[] {
  // Phase B+ shot-beat-vs-mantra limitation: the audit verdict can PASS the
  // literal shot beat while the manifest still carries the abandoned-direction
  // caveat (for example rampaging mech / glowing sphere). Anchor that read-only
  // HUD signal to the latest audit verdict so the badge opens the real timeline
  // event and any later SHIP / accepted / operator override still clears it.
  const events: DirectionDriftVerdictEvent[] = [];
  for (const shot of manifest?.shots ?? []) {
    const shotNumber = readInteger(shot.id) ?? readInteger(shot.shot_number) ?? readInteger(shot.shotNumber);
    if (!shotNumber) continue;
    const deliverable = deliverableByShot.get(shotNumber);
    if (!deliverable) continue;
    const text = [
      readString(shot.visual),
      readString(shot.still_prompt),
      readString(shot.veo_prompt),
      ...readStringArray(shot.characters_needed),
    ].filter(Boolean).join(" ").toLowerCase();
    const hasDirectionCaveat = /\brampaging\b/.test(text)
      || /\bglowing\s+(digital\s+)?sphere\b/.test(text)
      || /\bmagical?\s+orb\b/.test(text)
      || /\bholographic\s+sphere\b/.test(text);
    if (!hasDirectionCaveat) continue;

    const anchor = latestAuditEventByShot.get(shotNumber);
    if (!anchor) continue;
    events.push({
      ...anchor,
      source: "manifest_caveat",
      failureClasses: [DIRECTION_DRIFT_FALLBACK_CLASS],
      clearsDirectionDrift: false,
    });
  }
  return events;
}

export async function getDirectionDriftIndicatorsByCampaign(
  campaignId: string,
): Promise<Map<string, DirectionDriftIndicator>> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  const [deliverables, runRows] = await Promise.all([
    getDeliverablesByCampaign(campaignId),
    (async () => {
      const { data, error } = await supabase
        .from("runs")
        .select("*")
        .eq("campaign_id", campaignId)
        .eq("mode", "stills")
        .order("created_at", { ascending: false })
        .limit(250);
      if (error) throw new Error(`Failed to get stills runs for direction drift: ${error.message}`);
      return (data as DbRun[] | null ?? []).map((row) => mapDbRunToRun(row));
    })(),
  ]);

  if (deliverables.length === 0) return new Map();

  const deliverableByShot = new Map<number, CampaignDeliverable>();
  deliverables.forEach((deliverable, index) => {
    const shotNumber = deriveDeliverableShotNumber(deliverable, index);
    if (!deliverableByShot.has(shotNumber)) deliverableByShot.set(shotNumber, deliverable);
  });

  const runIds = runRows.map((run) => run.runId);
  const runById = new Map(runRows.map((run) => [run.runId, run]));
  let logs: RunLog[] = [];
  if (runIds.length > 0) {
    const { data, error } = await supabase
      .from("run_logs")
      .select("*")
      .in("run_id", runIds)
      .order("timestamp", { ascending: true })
      .limit(5000);
    if (error) throw new Error(`Failed to get run logs for direction drift: ${error.message}`);
    logs = (data as DbRunLog[] | null ?? []).map(mapDbLogToRunLog);
  }

  let escalations: AssetEscalation[] = [];
  const deliverableIds = deliverables.map((deliverable) => deliverable.id);
  if (deliverableIds.length > 0) {
    const { data, error } = await supabase
      .from("asset_escalations")
      .select("*")
      .in("deliverable_id", deliverableIds)
      .order("updated_at", { ascending: true })
      .limit(1000);
    if (error) throw new Error(`Failed to get escalations for direction drift: ${error.message}`);
    escalations = (data as DbAssetEscalation[] | null ?? []).map(mapAssetEscalation);
  }

  let decisions: OrchestrationDecisionRecord[] = [];
  const escalationIds = escalations.map((escalation) => escalation.id);
  if (escalationIds.length > 0) {
    const { data, error } = await supabase
      .from("orchestration_decisions")
      .select("*")
      .in("escalation_id", escalationIds)
      .order("created_at", { ascending: true })
      .limit(1000);
    if (error) throw new Error(`Failed to get orchestration decisions for direction drift: ${error.message}`);
    decisions = (data as DbOrchestrationDecision[] | null ?? []).map(mapOrchestrationDecision);
  }

  const escalationById = new Map(escalations.map((escalation) => [escalation.id, escalation]));
  const events: DirectionDriftVerdictEvent[] = [];

  for (const run of runRows) {
    events.push(...extractAuditReportEvents(run, deliverableByShot));
  }
  events.push(...extractRunLogDirectionEvents(logs, runById, deliverableByShot));

  for (const decision of decisions) {
    const escalation = escalationById.get(decision.escalationId);
    const deliverableId = readString(decision.inputContext.deliverableId)
      ?? readString(decision.inputContext.deliverable_id)
      ?? escalation?.deliverableId;
    if (!deliverableId) continue;
    const deliverable = deliverables.find((item) => item.id === deliverableId);
    if (!deliverable) continue;
    const shotNumber = deriveDeliverableShotNumber(deliverable, deliverables.indexOf(deliverable));
    const qa = extractQaRecord(decision.inputContext);
    const verdict = readString(qa?.verdict);
    const failureClasses = readQaFailureClasses(qa)
      .concat(readString(decision.decision.failure_class) ? [readString(decision.decision.failure_class) as string] : []);
    events.push({
      deliverableId,
      shotNumber,
      runId: decision.runId ?? escalation?.runId ?? null,
      timestamp: decision.createdAt,
      source: "orchestration_decision",
      verdict: verdict === "PASS" || verdict === "WARN" || verdict === "FAIL" ? verdict : null,
      score: readNumber(qa?.aggregate_score) ?? readNumber(qa?.aggregateScore) ?? null,
      failureClasses,
      decisionId: decision.id,
    });
  }

  for (const escalation of escalations) {
    if (!escalation.deliverableId) continue;
    const deliverable = deliverables.find((item) => item.id === escalation.deliverableId);
    if (!deliverable) continue;
    const shotNumber = deriveDeliverableShotNumber(deliverable, deliverables.indexOf(deliverable));
    if (escalation.status === "accepted" && escalation.resolutionPath === "accept") {
      events.push({
        deliverableId: deliverable.id,
        shotNumber,
        runId: escalation.runId ?? null,
        timestamp: escalation.resolvedAt ?? escalation.updatedAt ?? escalation.createdAt,
        source: "asset_escalation",
        verdict: null,
        score: null,
        failureClasses: [],
        clearsDirectionDrift: true,
      });
    }
  }

  for (const run of runRows) {
    const overrides = isRecord(run.metadata?.operator_override) ? run.metadata.operator_override : null;
    if (!overrides) continue;
    for (const [key, rawValue] of Object.entries(overrides)) {
      const match = /^shot_(\d{1,3})$/i.exec(key);
      if (!match) continue;
      const shotNumber = Number.parseInt(match[1] as string, 10);
      const deliverable = deliverableByShot.get(shotNumber);
      if (!deliverable) continue;
      const rawDecision = isRecord(rawValue) ? rawValue : {};
      const overrideTimestamp = readString(rawDecision.decision_at)
        ?? readString(rawDecision.decisionAt)
        ?? run.updatedAt
        ?? run.completedAt
        ?? run.createdAt;
      events.push({
        deliverableId: deliverable.id,
        shotNumber,
        runId: run.runId,
        timestamp: overrideTimestamp,
        source: "operator_override",
        verdict: null,
        score: readNumber(rawDecision.critic_score) ?? null,
        failureClasses: [],
        clearsDirectionDrift: true,
      });
    }
  }

  const latestAuditEventByShot = new Map<number, DirectionDriftVerdictEvent>();
  for (const event of events) {
    if (event.shotNumber === null) continue;
    if (event.source !== "run_logs" && event.source !== "audit_report") continue;
    const existing = latestAuditEventByShot.get(event.shotNumber);
    const eventMs = eventTime(event.timestamp);
    const existingMs = eventTime(existing?.timestamp);
    const sameRunNearTimestamp = Boolean(
      existing
      && event.runId
      && existing.runId === event.runId
      && Math.abs(eventMs - existingMs) < 60_000,
    );
    if (
      existing
      &&
      sameRunNearTimestamp
      && event.logId !== undefined
      && existing.logId === undefined
    ) {
      latestAuditEventByShot.set(event.shotNumber, {
        ...existing,
        source: event.source,
        logId: event.logId,
      });
    } else if (
      !existing
      || eventMs > existingMs
    ) {
      latestAuditEventByShot.set(event.shotNumber, event);
    }
  }
  const productionSlug = productionSlugFromRunsOrCampaign(campaign, runRows);
  const manifest = loadMotionGateManifest(productionSlug);
  events.push(...manifestDirectionCaveatEvents(manifest, deliverableByShot, latestAuditEventByShot));

  return aggregateDirectionDriftIndicators({ deliverables, events });
}

// ============ Log Operations ============

export async function addLog(log: Omit<RunLog, "id">): Promise<RunLog> {
  const clientId = await requireClientIdForRun(log.runId, log.clientId);
  const { data, error } = await supabase
    .from("run_logs")
    .insert({
      client_id: clientId,
      run_id: log.runId,
      timestamp: log.timestamp,
      stage: log.stage,
      level: log.level,
      message: log.message,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to add log: ${error.message}`);
  }

  return mapDbLogToRunLog(data as DbRunLog);
}

export async function getLogsByRun(runId: string, since?: number): Promise<RunLog[]> {
  let query = supabase
    .from("run_logs")
    .select("*")
    .eq("run_id", runId)
    .order("id", { ascending: true });

  if (since !== undefined) {
    query = query.gt("id", since);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to get logs: ${error.message}`);
  }

  return (data as DbRunLog[]).map(mapDbLogToRunLog);
}

// ============ Artifact Operations ============

export async function addArtifact(artifact: Artifact): Promise<Artifact> {
  const clientId = await requireClientIdForRun(artifact.runId, artifact.clientId);
  if (artifact.campaignId) {
    await requireClientIdForCampaign(artifact.campaignId, clientId);
  }
  if (artifact.deliverableId) {
    await requireClientIdForDeliverable(artifact.deliverableId, clientId);
  }
  const { data, error } = await supabase
    .from("artifacts")
    .insert({
      id: artifact.id,
      run_id: artifact.runId,
      client_id: clientId,
      campaign_id: artifact.campaignId ?? null,
      deliverable_id: artifact.deliverableId ?? null,
      type: artifact.type,
      name: artifact.name,
      path: artifact.path,
      storage_path: artifact.storagePath ?? null,
      stage: artifact.stage ?? null,
      size: artifact.size ?? null,
      metadata: artifact.metadata ?? null,
      created_at: artifact.createdAt,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to add artifact: ${error.message}`);
  }

  return mapDbArtifactToArtifact(data as DbArtifact);
}

export async function getArtifactsByRun(runId: string): Promise<Artifact[]> {
  const { data, error } = await supabase
    .from("artifacts")
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to get artifacts: ${error.message}`);
  }

  return (data as DbArtifact[]).map(mapDbArtifactToArtifact);
}

/**
 * Returns the most-recent artifact of the given type for a deliverable, or
 * null if none exists. Used by the regrade runner path (Step 10d) to pick the
 * artifact to re-grade when no fresh generation has been fired. Ordered by
 * created_at DESC so callers always see the newest successor from any prior
 * escalation loop.
 */
export async function getLatestArtifactByDeliverable(
  deliverableId: string,
  type?: Artifact["type"],
): Promise<Artifact | null> {
  let query = supabase
    .from("artifacts")
    .select("*")
    .eq("deliverable_id", deliverableId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (type) query = query.eq("type", type);
  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new Error(`Failed to get latest artifact: ${error.message}`);
  }
  if (!data) return null;
  return mapDbArtifactToArtifact(data as DbArtifact);
}

export async function getArtifactById(artifactId: string): Promise<Artifact | null> {
  const { data, error } = await supabase
    .from("artifacts")
    .select("*")
    .eq("id", artifactId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to get artifact: ${error.message}`);
  }

  if (!data) return null;
  return mapDbArtifactToArtifact(data as DbArtifact);
}

// ── Gap 8: Per-shot regen iteration browser helpers ───────────────────────

export interface ArtifactIterationAggregationInput {
  deliverableId: string;
  shotNumber: number | null;
  artifacts: Artifact[];
  logs: RunLog[];
  decisions: OrchestrationDecisionRecord[];
  runs: Run[];
  operatorOverrides?: Map<string, ArtifactIterationOperatorOverride>;
  now?: Date;
}

const ITER_FILENAME_RE = /(?:^|[_-])iter[_-]?(\d+)(?=\D|$)/i;
const IN_LOOP_VERDICT_RE = /\[in_loop\]\s+shot\s+(\d{1,3})\s+iter\s+(\d+):\s+(PASS|WARN|FAIL)\s+score=([0-9.]+)\s+→\s+([A-Za-z0-9_]+)/i;
const IN_LOOP_SHIP_ITER_RE = /\[in_loop\]\s+shot\s+(\d{1,3})\s*:\s+SHIP at iter\s+(\d+)/i;

export function parseArtifactIteration(value: Pick<Artifact, "name" | "path" | "storagePath" | "metadata">): number | null {
  const metadata = isRecord(value.metadata) ? value.metadata : null;
  const metadataIter = readInteger(metadata?.iter)
    ?? readInteger(metadata?.iteration)
    ?? readInteger(metadata?.orchestrationIteration);
  if (metadataIter && metadataIter > 0) return metadataIter;

  const haystack = [value.name, value.path, value.storagePath].filter(Boolean).join(" ");
  const match = ITER_FILENAME_RE.exec(haystack);
  if (!match) return null;
  const parsed = Number.parseInt(match[1] as string, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function artifactLocalPath(artifact: Artifact): string | null {
  const metadata = isRecord(artifact.metadata) ? artifact.metadata : null;
  const localPath = readString(metadata?.localPath);
  if (localPath) return localPath;
  return artifact.path.startsWith("/") ? artifact.path : null;
}

export function artifactDisplayUrl(artifact: Artifact): string {
  if (/^https?:\/\//i.test(artifact.path)) return artifact.path;
  return `/api/artifacts/${artifact.id}/file`;
}

function isCarryForwardArtifact(artifact: Artifact): boolean {
  const metadata = isRecord(artifact.metadata) ? artifact.metadata : null;
  return Boolean(readString(metadata?.seedReason) && readString(metadata?.seededFromArtifactId));
}

function parentArtifactId(artifact: Artifact): string | null {
  const metadata = isRecord(artifact.metadata) ? artifact.metadata : null;
  const seededFrom = readString(metadata?.seededFromArtifactId)
    ?? readString(metadata?.seeded_from_artifact_id)
    ?? null;
  const directParent = readString(metadata?.parentArtifactId)
    ?? readString(metadata?.parent_artifact_id)
    ?? null;
  return isCarryForwardArtifact(artifact)
    ? seededFrom ?? directParent
    : directParent ?? seededFrom;
}

function runOrdinalByShot(runs: Run[], shotNumber: number | null): Map<string, number> {
  const output = new Map<string, number>();
  if (!shotNumber) return output;
  let ordinal = 0;
  const stillsRuns = [...runs]
    .filter((run) => run.mode === "stills" && run.metadata?.audit_mode !== true)
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  for (const run of stillsRuns) {
    const shotIds = extractRunShotIds(run.metadata);
    if (shotIds && !shotIds.includes(shotNumber)) continue;
    ordinal += 1;
    output.set(run.runId, ordinal);
  }
  return output;
}

function buildArtifactIterationLabel(runOrdinal: number | null, iter: number | null, artifact: Artifact): string {
  const metadata = isRecord(artifact.metadata) ? artifact.metadata : null;
  const seedReason = readString(metadata?.seedReason);
  const version = runOrdinal ? `v${runOrdinal}` : artifact.runId.slice(0, 8);
  if (iter !== null) return `${version} iter${iter}`;
  if (seedReason) return `${version} locked seed`;
  return `${version} original`;
}

function readQaVerdictRecord(decision: OrchestrationDecisionRecord): Record<string, unknown> | null {
  const input = isRecord(decision.inputContext) ? decision.inputContext : {};
  const qa = input.qaVerdict ?? input.qa_verdict;
  return isRecord(qa) ? qa : null;
}

function verdictFromDecision(decision: OrchestrationDecisionRecord): ArtifactIterationVerdict | null {
  const qa = readQaVerdictRecord(decision);
  if (!qa) return null;
  const verdict = readString(qa.verdict);
  if (verdict !== "PASS" && verdict !== "WARN" && verdict !== "FAIL") return null;
  return {
    verdict,
    score: readNumber(qa.aggregate_score) ?? readNumber(qa.aggregateScore) ?? null,
    recommendation: readString(qa.recommendation) ?? null,
    failureClasses: readStringArray(qa.detected_failure_classes)
      .concat(readStringArray(qa.detectedFailureClasses))
      .concat(readStringArray(qa.failure_classes))
      .concat(readStringArray(qa.failureClasses)),
    decisionId: decision.id,
    timestamp: decision.createdAt,
  };
}

function verdictFromLog(log: RunLog): ArtifactIterationVerdict | null {
  const match = IN_LOOP_VERDICT_RE.exec(log.message);
  if (match) {
    return {
      verdict: match[3] as ArtifactIterationVerdict["verdict"],
      score: Number.parseFloat(match[4] as string),
      recommendation: match[5] as string,
      failureClasses: [],
      logId: log.id,
      timestamp: log.timestamp,
      message: log.message,
    };
  }
  const shipMatch = IN_LOOP_SHIP_ITER_RE.exec(log.message);
  if (shipMatch) {
    return {
      verdict: "SHIP",
      score: null,
      recommendation: "ship",
      failureClasses: [],
      logId: log.id,
      timestamp: log.timestamp,
      message: log.message,
    };
  }
  return null;
}

function logIteration(log: RunLog): { shotNumber: number; iter: number } | null {
  const match = IN_LOOP_VERDICT_RE.exec(log.message) ?? IN_LOOP_SHIP_ITER_RE.exec(log.message);
  if (!match) return null;
  return {
    shotNumber: Number.parseInt(match[1] as string, 10),
    iter: Number.parseInt(match[2] as string, 10),
  };
}

export function aggregateArtifactIterationRows(
  input: ArtifactIterationAggregationInput,
): ArtifactIterationsResponse {
  const sortedArtifacts = [...input.artifacts].sort((left, right) => {
    const timeDelta = eventTime(left.createdAt) - eventTime(right.createdAt);
    if (timeDelta !== 0) return timeDelta;
    return left.id.localeCompare(right.id);
  });
  const runById = new Map(input.runs.map((run) => [run.runId, run]));
  const runOrdinal = runOrdinalByShot(input.runs, input.shotNumber);
  const decisionByArtifactId = new Map<string, OrchestrationDecisionRecord>();

  [...input.decisions]
    .sort((left, right) => eventTime(right.createdAt) - eventTime(left.createdAt))
    .forEach((decision) => {
      const artifactId = readString(decision.inputContext.artifactId) ?? readString(decision.inputContext.artifact_id);
      if (artifactId && !decisionByArtifactId.has(artifactId)) {
        decisionByArtifactId.set(artifactId, decision);
      }
    });

  const latestLogVerdictByRunIter = new Map<string, ArtifactIterationVerdict>();
  for (const log of input.logs) {
    const parsed = logIteration(log);
    if (!parsed) continue;
    if (input.shotNumber !== null && parsed.shotNumber !== input.shotNumber) continue;
    const verdict = verdictFromLog(log);
    if (!verdict) continue;
    const key = `${log.runId}:${parsed.iter}`;
    const existing = latestLogVerdictByRunIter.get(key);
    if (!existing || eventTime(verdict.timestamp) >= eventTime(existing.timestamp)) {
      latestLogVerdictByRunIter.set(key, verdict);
    }
  }

  const rows: ArtifactIterationRow[] = sortedArtifacts.map((artifact) => {
    const iter = parseArtifactIteration(artifact);
    const ordinal = runOrdinal.get(artifact.runId) ?? null;
    const artifactDecision = decisionByArtifactId.get(artifact.id);
    const decisionVerdict = artifactDecision ? verdictFromDecision(artifactDecision) : null;
    const effectiveIter = iter ?? artifactDecision?.iteration ?? null;
    const verdict = decisionVerdict
      ?? (effectiveIter !== null ? latestLogVerdictByRunIter.get(`${artifact.runId}:${effectiveIter}`) ?? null : null);
    const parentId = parentArtifactId(artifact);
    return {
      artifact,
      deliverableId: input.deliverableId,
      shotNumber: input.shotNumber,
      runId: artifact.runId,
      runCreatedAt: runById.get(artifact.runId)?.createdAt ?? null,
      runOrdinalForShot: ordinal,
      iter,
      label: buildArtifactIterationLabel(ordinal, iter, artifact),
      displayUrl: artifactDisplayUrl(artifact),
      localPath: artifactLocalPath(artifact),
      isSeed: Boolean(readString(isRecord(artifact.metadata) ? artifact.metadata.seedReason : undefined)),
      isCarryForward: isCarryForwardArtifact(artifact),
      parentArtifactId: parentId,
      parentLabel: null,
      verdict,
      operatorOverride: (iter !== null ? input.operatorOverrides?.get(`${artifact.runId}:iter${iter}`) : null) ?? null,
    };
  });

  const rowByArtifactId = new Map(rows.map((row) => [row.artifact.id, row]));
  const resolveVisibleParent = (row: ArtifactIterationRow): ArtifactIterationRow | null => {
    let nextId = row.parentArtifactId;
    const seen = new Set<string>();
    while (nextId && !seen.has(nextId)) {
      seen.add(nextId);
      const parent = rowByArtifactId.get(nextId);
      if (!parent) return null;
      if (!parent.isCarryForward) return parent;
      nextId = parent.parentArtifactId;
    }
    return null;
  };
  return {
    deliverableId: input.deliverableId,
    shotNumber: input.shotNumber,
    rows: rows.map((row) => {
      const visibleParent = resolveVisibleParent(row);
      return {
        ...row,
        parentArtifactId: visibleParent?.artifact.id ?? row.parentArtifactId,
        parentLabel: visibleParent?.label ?? (row.parentArtifactId ? row.parentArtifactId.slice(0, 8) : null),
      };
    }),
    generatedAt: (input.now ?? new Date()).toISOString(),
  };
}

function readOperatorOverride(
  value: unknown,
): ArtifactIterationOperatorOverride | null {
  if (!isRecord(value)) return null;
  const decisionAt = readString(value.decision_at) ?? readString(value.decisionAt);
  if (!decisionAt) return null;
  return {
    decisionAt,
    decisionBy: readString(value.decision_by) ?? readString(value.decisionBy),
    decidedArtifactPath: readString(value.decided_artifact_path) ?? readString(value.decidedArtifactPath),
    decidedIter: readInteger(value.decided_iter) ?? readInteger(value.decidedIter),
    criticVerdict: readString(value.critic_verdict) ?? readString(value.criticVerdict),
    criticScore: readNumber(value.critic_score) ?? readNumber(value.criticScore),
    rationale: readString(value.rationale),
    lockedTo: readString(value.locked_to) ?? readString(value.lockedTo),
  };
}

export async function getArtifactsForDeliverableWithVerdicts(
  deliverableId: string,
): Promise<ArtifactIterationsResponse> {
  const deliverable = await getDeliverable(deliverableId);
  if (!deliverable) throw new Error(`Deliverable ${deliverableId} not found`);
  const shotNumber = deriveDeliverableShotNumber(deliverable, 0);

  const { data: artifactData, error: artifactError } = await supabase
    .from("artifacts")
    .select("*")
    .eq("deliverable_id", deliverableId)
    .eq("type", "image")
    .order("created_at", { ascending: true })
    .limit(500);
  if (artifactError) throw new Error(`Failed to get deliverable artifacts: ${artifactError.message}`);
  const artifacts = (artifactData as DbArtifact[] | null ?? []).map(mapDbArtifactToArtifact);

  const runIds = [...new Set(artifacts.map((artifact) => artifact.runId))];
  const [runRows, logRows, escalationRows] = await Promise.all([
    (async () => {
      const { data, error } = await supabase
        .from("runs")
        .select("*")
        .eq("campaign_id", deliverable.campaignId)
        .eq("mode", "stills")
        .order("created_at", { ascending: true })
        .limit(250);
      if (error) throw new Error(`Failed to get stills runs for iteration browser: ${error.message}`);
      return (data as DbRun[] | null ?? []).map(mapDbRunToRun);
    })(),
    (async () => {
      if (runIds.length === 0) return [] as RunLog[];
      const { data, error } = await supabase
        .from("run_logs")
        .select("*")
        .in("run_id", runIds)
        .order("timestamp", { ascending: true })
        .limit(5000);
      if (error) throw new Error(`Failed to get run logs for iteration browser: ${error.message}`);
      return (data as DbRunLog[] | null ?? []).map(mapDbLogToRunLog);
    })(),
    (async () => {
      const { data, error } = await supabase
        .from("asset_escalations")
        .select("*")
        .eq("deliverable_id", deliverableId)
        .order("created_at", { ascending: true })
        .limit(1000);
      if (error) throw new Error(`Failed to get escalations for iteration browser: ${error.message}`);
      return (data as DbAssetEscalation[] | null ?? []).map(mapAssetEscalation);
    })(),
  ]);

  let decisions: OrchestrationDecisionRecord[] = [];
  const escalationIds = escalationRows.map((escalation) => escalation.id);
  if (escalationIds.length > 0) {
    const { data, error } = await supabase
      .from("orchestration_decisions")
      .select("*")
      .in("escalation_id", escalationIds)
      .order("created_at", { ascending: true })
      .limit(1000);
    if (error) throw new Error(`Failed to get orchestration decisions for iteration browser: ${error.message}`);
    decisions = (data as DbOrchestrationDecision[] | null ?? []).map(mapOrchestrationDecision);
  }

  const overrides = new Map<string, ArtifactIterationOperatorOverride>();
  for (const run of runRows) {
    const overrideRoot = isRecord(run.metadata?.operator_override) ? run.metadata.operator_override : null;
    const override = readOperatorOverride(overrideRoot?.[`shot_${shotNumber}`]);
    if (!override || override.decidedIter == null) continue;
    overrides.set(`${run.runId}:iter${override.decidedIter}`, override);
  }

  return aggregateArtifactIterationRows({
    deliverableId,
    shotNumber,
    artifacts,
    logs: logRows,
    decisions,
    runs: runRows,
    operatorOverrides: overrides,
  });
}

// ============ Client Operations ============

export async function getClient(clientId: string): Promise<Client | null> {
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("id", clientId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to get client: ${error.message}`);
  }

  if (!data) return null;
  return mapDbClientToClient(data as DbClient);
}

export async function upsertClient(client: Client): Promise<Client> {
  const { data, error } = await supabase
    .from("clients")
    .upsert({
      id: client.id,
      name: client.name,
      status: client.status,
      last_run_id: client.lastRunId ?? null,
      last_run_at: client.lastRunAt ?? null,
      last_run_status: client.lastRunStatus ?? null,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to upsert client: ${error.message}`);
  }

  return mapDbClientToClient(data as DbClient);
}

export async function getAllClients(): Promise<Client[]> {
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .order("name");

  if (error) {
    throw new Error(`Failed to get clients: ${error.message}`);
  }

  return (data as DbClient[]).map(mapDbClientToClient);
}

export async function updateClientLastRun(clientId: string, runId: string, status: RunStatus): Promise<void> {
  const { error } = await supabase
    .from("clients")
    .update({
      last_run_id: runId,
      last_run_at: new Date().toISOString(),
      last_run_status: status,
    })
    .eq("id", clientId);

  if (error) {
    throw new Error(`Failed to update client last run: ${error.message}`);
  }
}

// ============ HITL Decision Operations ============

interface DbHitlDecision {
  id: string;
  client_id: string;
  run_id: string;
  artifact_id: string | null;
  decision: string;
  notes: string | null;
  grade_scores: Record<string, number> | null;
  rejection_categories: string[] | null;
  created_at: string;
}

function mapDbHitlDecisionToHitlDecision(db: DbHitlDecision): HitlDecision {
  return {
    id: db.id,
    clientId: db.client_id,
    runId: db.run_id,
    artifactId: db.artifact_id ?? undefined,
    decision: db.decision as HitlDecision["decision"],
    notes: db.notes ?? undefined,
    gradeScores: db.grade_scores ?? undefined,
    rejectionCategories: db.rejection_categories ?? undefined,
    createdAt: db.created_at,
  };
}

export async function addHitlDecision(decision: HitlDecision): Promise<HitlDecision> {
  const clientId = await requireClientIdForRun(decision.runId, decision.clientId);
  const { data, error } = await supabase
    .from("hitl_decisions")
    .insert({
      client_id: clientId,
      run_id: decision.runId,
      artifact_id: decision.artifactId ?? null,
      decision: decision.decision,
      notes: decision.notes ?? null,
      grade_scores: decision.gradeScores ?? null,
      rejection_categories: decision.rejectionCategories ?? null,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to add HITL decision: ${error.message}`);
  }

  return mapDbHitlDecisionToHitlDecision(data as DbHitlDecision);
}

export async function getHitlDecisionsByRun(runId: string): Promise<HitlDecision[]> {
  const { data, error } = await supabase
    .from("hitl_decisions")
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to get HITL decisions: ${error.message}`);
  }

  return (data as DbHitlDecision[]).map(mapDbHitlDecisionToHitlDecision);
}

// ============ Drift DB Row Types ============

interface DbDriftMetric {
  id: string;
  client_id: string;
  run_id: string;
  artifact_id: string | null;
  clip_z: number | null;
  e5_z: number | null;
  cohere_z: number | null;
  fused_z: number | null;
  clip_raw: number | null;
  e5_raw: number | null;
  cohere_raw: number | null;
  gate_decision: string | null;
  created_at: string;
}

interface DbDriftAlert {
  id: string;
  client_id: string;
  run_id: string;
  severity: "warn" | "error" | "critical";
  message: string;
  fused_z: number | null;
  acknowledged: boolean;
  acknowledged_at: string | null;
  resolution_notes: string | null;
  created_at: string;
}

// ============ Drift Mappers ============

function mapDbDriftMetricToDriftMetric(row: DbDriftMetric): DriftMetric {
  return {
    id: row.id,
    clientId: row.client_id,
    runId: row.run_id,
    artifactId: row.artifact_id ?? undefined,
    clipZ: row.clip_z ?? undefined,
    e5Z: row.e5_z ?? undefined,
    cohereZ: row.cohere_z ?? undefined,
    fusedZ: row.fused_z ?? undefined,
    clipRaw: row.clip_raw ?? undefined,
    e5Raw: row.e5_raw ?? undefined,
    cohereRaw: row.cohere_raw ?? undefined,
    gateDecision: row.gate_decision ?? undefined,
    createdAt: row.created_at,
  };
}

function mapDbDriftAlertToDriftAlert(row: DbDriftAlert): DriftAlert {
  return {
    id: row.id,
    clientId: row.client_id,
    runId: row.run_id,
    severity: row.severity,
    message: row.message,
    fusedZ: row.fused_z ?? undefined,
    acknowledged: row.acknowledged,
    acknowledgedAt: row.acknowledged_at ?? undefined,
    resolutionNotes: row.resolution_notes ?? undefined,
    createdAt: row.created_at,
  };
}

// ============ Drift Metric Operations ============

export async function addDriftMetric(metric: DriftMetric): Promise<DriftMetric> {
  const clientId = await requireClientIdForRun(metric.runId, metric.clientId);
  const { data, error } = await supabase
    .from("drift_metrics")
    .insert({
      client_id: clientId,
      run_id: metric.runId,
      artifact_id: metric.artifactId ?? null,
      clip_z: metric.clipZ ?? null,
      e5_z: metric.e5Z ?? null,
      cohere_z: metric.cohereZ ?? null,
      fused_z: metric.fusedZ ?? null,
      clip_raw: metric.clipRaw ?? null,
      e5_raw: metric.e5Raw ?? null,
      cohere_raw: metric.cohereRaw ?? null,
      gate_decision: metric.gateDecision ?? null,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to add drift metric: ${error.message}`);
  }

  return mapDbDriftMetricToDriftMetric(data as DbDriftMetric);
}

export async function getDriftMetricsByRun(runId: string): Promise<DriftMetric[]> {
  const { data, error } = await supabase
    .from("drift_metrics")
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to get drift metrics: ${error.message}`);
  }

  return (data as DbDriftMetric[]).map(mapDbDriftMetricToDriftMetric);
}

// ============ Drift Alert Operations ============

export async function addDriftAlert(alert: DriftAlert): Promise<DriftAlert> {
  const { data, error } = await supabase
    .from("drift_alerts")
    .insert({
      client_id: alert.clientId,
      run_id: alert.runId,
      severity: alert.severity,
      message: alert.message,
      fused_z: alert.fusedZ ?? null,
      acknowledged: false,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to add drift alert: ${error.message}`);
  }

  return mapDbDriftAlertToDriftAlert(data as DbDriftAlert);
}

export async function getDriftAlertsByClient(clientId: string): Promise<DriftAlert[]> {
  const { data, error } = await supabase
    .from("drift_alerts")
    .select("*")
    .eq("client_id", clientId)
    .order("acknowledged", { ascending: true })
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to get drift alerts by client: ${error.message}`);
  }

  return (data as DbDriftAlert[]).map(mapDbDriftAlertToDriftAlert);
}

export async function getDriftAlertsByRun(runId: string): Promise<DriftAlert[]> {
  const { data, error } = await supabase
    .from("drift_alerts")
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to get drift alerts by run: ${error.message}`);
  }

  return (data as DbDriftAlert[]).map(mapDbDriftAlertToDriftAlert);
}

export async function acknowledgeDriftAlert(alertId: string, resolutionNotes?: string): Promise<DriftAlert> {
  const updateData: Record<string, unknown> = {
    acknowledged: true,
    acknowledged_at: new Date().toISOString(),
  };
  if (resolutionNotes !== undefined) {
    updateData.resolution_notes = resolutionNotes;
  }

  const { data, error } = await supabase
    .from("drift_alerts")
    .update(updateData)
    .eq("id", alertId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to acknowledge drift alert: ${error.message}`);
  }

  return mapDbDriftAlertToDriftAlert(data as DbDriftAlert);
}

// ============ Campaign & Deliverable DB Row Types ============

interface DbCampaign {
  id: string;
  client_id: string;
  name: string;
  prompt: string | null;
  deliverables: unknown | null;
  platforms: unknown | null;
  mode: string | null;
  max_retries: number | null;
  reference_images: string[] | null;
  guardrails: Record<string, unknown> | null;
  status: string | null;
  total_deliverables: number | null;
  approved_count: number | null;
  failed_count: number | null;
  created_at: string;
  updated_at: string;
}

interface DbCampaignDeliverable {
  id: string;
  client_id: string;
  campaign_id: string;
  description: string | null;
  ai_model: string | null;
  current_prompt: string | null;
  original_prompt: string | null;
  status: string;
  retry_count: number;
  rejection_reasons: string[] | null;
  custom_rejection_note: string | null;
  // Generation spec columns (migration 006)
  format: string | null;
  media_type: string | null;
  duration_seconds: number | null;
  aspect_ratio: string | null;
  resolution: string | null;
  platform: string | null;
  quality_tier: string | null;
  reference_images: string[] | null;
  estimated_cost: number | null;
  created_at: string;
  updated_at: string;
}

function mapDbCampaignToCampaign(db: DbCampaign): Campaign {
  return {
    id: db.id,
    clientId: db.client_id,
    name: db.name,
    prompt: db.prompt ?? undefined,
    deliverables: db.deliverables ?? undefined,
    platforms: Array.isArray(db.platforms) ? db.platforms as string[] : undefined,
    mode: db.mode ?? undefined,
    maxRetries: db.max_retries ?? 3,
    referenceImages: db.reference_images ?? undefined,
    guardrails: db.guardrails ?? undefined,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
  };
}

function mapDbDeliverableToDeliverable(db: DbCampaignDeliverable): CampaignDeliverable {
  return {
    id: db.id,
    clientId: db.client_id,
    campaignId: db.campaign_id,
    description: db.description ?? undefined,
    aiModel: db.ai_model ?? undefined,
    currentPrompt: db.current_prompt ?? undefined,
    originalPrompt: db.original_prompt ?? undefined,
    status: db.status as DeliverableStatus,
    retryCount: db.retry_count,
    rejectionReason: db.custom_rejection_note ?? undefined,
    // Generation spec fields
    format: (db.format as CampaignDeliverable["format"]) ?? undefined,
    mediaType: (db.media_type as CampaignDeliverable["mediaType"]) ?? undefined,
    durationSeconds: db.duration_seconds ?? undefined,
    aspectRatio: db.aspect_ratio ?? undefined,
    resolution: db.resolution ?? undefined,
    platform: db.platform ?? undefined,
    qualityTier: (db.quality_tier as CampaignDeliverable["qualityTier"]) ?? undefined,
    referenceImages: db.reference_images ?? undefined,
    estimatedCost: db.estimated_cost != null ? Number(db.estimated_cost) : undefined,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
  };
}

// ============ Campaign Operations ============

export async function getCampaign(campaignId: string): Promise<Campaign | null> {
  const { data, error } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to get campaign: ${error.message}`);
  }

  if (!data) return null;
  return mapDbCampaignToCampaign(data as DbCampaign);
}

export async function getCampaignsByClient(clientId: string): Promise<Campaign[]> {
  const { data, error } = await supabase
    .from("campaigns")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to get campaigns by client: ${error.message}`);
  }

  return (data as DbCampaign[]).map(mapDbCampaignToCampaign);
}

export async function createCampaign(campaign: {
  clientId: string;
  name: string;
  prompt?: string;
  platforms?: string[];
  mode?: string;
  maxRetries?: number;
}): Promise<Campaign> {
  const { data, error } = await supabase
    .from("campaigns")
    .insert({
      client_id: campaign.clientId,
      name: campaign.name,
      prompt: campaign.prompt ?? null,
      platforms: campaign.platforms ?? null,
      mode: campaign.mode ?? "full",
      max_retries: campaign.maxRetries ?? 3,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create campaign: ${error.message}`);
  }

  return mapDbCampaignToCampaign(data as DbCampaign);
}

// ============ Deliverable Operations ============

export async function getDeliverablesByCampaign(campaignId: string): Promise<CampaignDeliverable[]> {
  const { data, error } = await supabase
    .from("campaign_deliverables")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to get deliverables: ${error.message}`);
  }

  return (data as DbCampaignDeliverable[]).map(mapDbDeliverableToDeliverable);
}

export async function getPendingDeliverables(campaignId: string): Promise<CampaignDeliverable[]> {
  const { data, error } = await supabase
    .from("campaign_deliverables")
    .select("*")
    .eq("campaign_id", campaignId)
    .in("status", ["pending", "regenerating"])
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to get pending deliverables: ${error.message}`);
  }

  return (data as DbCampaignDeliverable[]).map(mapDbDeliverableToDeliverable);
}

export async function getDeliverable(deliverableId: string): Promise<CampaignDeliverable | null> {
  const { data, error } = await supabase
    .from("campaign_deliverables")
    .select("*")
    .eq("id", deliverableId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to get deliverable: ${error.message}`);
  }

  if (!data) return null;
  return mapDbDeliverableToDeliverable(data as DbCampaignDeliverable);
}

export async function createDeliverable(deliverable: {
  clientId?: string;
  campaignId: string;
  description?: string;
  aiModel?: string;
  originalPrompt?: string;
  // Generation spec fields
  format?: string;
  mediaType?: string;
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
  platform?: string;
  qualityTier?: string;
  referenceImages?: string[];
  estimatedCost?: number;
}): Promise<CampaignDeliverable> {
  const clientId = await requireClientIdForCampaign(deliverable.campaignId, deliverable.clientId);
  const { data, error } = await supabase
    .from("campaign_deliverables")
    .insert({
      client_id: clientId,
      campaign_id: deliverable.campaignId,
      description: deliverable.description ?? null,
      ai_model: deliverable.aiModel ?? null,
      original_prompt: deliverable.originalPrompt ?? null,
      current_prompt: deliverable.originalPrompt ?? null,
      status: "pending",
      retry_count: 0,
      // Generation spec columns
      format: deliverable.format ?? null,
      media_type: deliverable.mediaType ?? "image",
      duration_seconds: deliverable.durationSeconds ?? null,
      aspect_ratio: deliverable.aspectRatio ?? "16:9",
      resolution: deliverable.resolution ?? "720p",
      platform: deliverable.platform ?? null,
      quality_tier: deliverable.qualityTier ?? "standard",
      reference_images: deliverable.referenceImages ?? null,
      estimated_cost: deliverable.estimatedCost ?? null,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create deliverable: ${error.message}`);
  }

  return mapDbDeliverableToDeliverable(data as DbCampaignDeliverable);
}

export async function updateDeliverableStatus(
  deliverableId: string,
  currentStatus: DeliverableStatus,
  newStatus: DeliverableStatus,
  extras?: { rejectionReason?: string; currentPrompt?: string },
): Promise<CampaignDeliverable> {
  // Validate transition
  const allowed = VALID_DELIVERABLE_TRANSITIONS[currentStatus];
  if (!allowed.includes(newStatus)) {
    throw new Error(`Invalid deliverable transition: ${currentStatus} → ${newStatus}`);
  }

  const updateData: Record<string, unknown> = { status: newStatus };
  if (extras?.rejectionReason !== undefined) updateData.custom_rejection_note = extras.rejectionReason;
  if (extras?.currentPrompt !== undefined) updateData.current_prompt = extras.currentPrompt;

  // Use .eq('status', currentStatus) for race-condition safety
  const { data, error } = await supabase
    .from("campaign_deliverables")
    .update(updateData)
    .eq("id", deliverableId)
    .eq("status", currentStatus)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update deliverable status: ${error.message}`);
  }

  return mapDbDeliverableToDeliverable(data as DbCampaignDeliverable);
}

export async function incrementDeliverableRetry(deliverableId: string): Promise<CampaignDeliverable> {
  // First get current state
  const deliverable = await getDeliverable(deliverableId);
  if (!deliverable) {
    throw new Error(`Deliverable ${deliverableId} not found`);
  }

  const { data, error } = await supabase
    .from("campaign_deliverables")
    .update({
      retry_count: deliverable.retryCount + 1,
      status: "regenerating",
    })
    .eq("id", deliverableId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to increment deliverable retry: ${error.message}`);
  }

  return mapDbDeliverableToDeliverable(data as DbCampaignDeliverable);
}

// ============ Prompt Template Operations ============

export async function getActivePrompt(clientId: string, stage: string = "generate", campaignId?: string): Promise<PromptTemplate | null> {
  let query = supabase
    .from("prompt_templates")
    .select("*")
    .eq("client_id", clientId)
    .eq("stage", stage)
    .eq("is_active", true)
    .order("version", { ascending: false })
    .limit(1);

  if (campaignId) {
    query = query.eq("campaign_id", campaignId);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to get active prompt: ${error.message}`);
  if (!data || data.length === 0) return null;

  const d = data[0];
  return {
    id: d.id, clientId: d.client_id, campaignId: d.campaign_id ?? undefined,
    stage: d.stage, version: d.version, promptText: d.prompt_text,
    parentId: d.parent_id ?? undefined, isActive: d.is_active,
    source: d.source ?? undefined, metadata: d.metadata ?? undefined,
    createdAt: d.created_at,
  };
}

export async function createPromptTemplate(template: Omit<PromptTemplate, "id" | "createdAt">): Promise<PromptTemplate> {
  const { data, error } = await supabase
    .from("prompt_templates")
    .insert({
      client_id: template.clientId,
      campaign_id: template.campaignId ?? null,
      stage: template.stage,
      version: template.version,
      prompt_text: template.promptText,
      parent_id: template.parentId ?? null,
      is_active: template.isActive,
      source: template.source ?? "manual",
      metadata: template.metadata ?? null,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create prompt template: ${error.message}`);

  return {
    id: data.id, clientId: data.client_id, campaignId: data.campaign_id ?? undefined,
    stage: data.stage, version: data.version, promptText: data.prompt_text,
    parentId: data.parent_id ?? undefined, isActive: data.is_active,
    source: data.source, metadata: data.metadata, createdAt: data.created_at,
  };
}

export async function getPromptHistory(clientId: string, stage: string = "generate"): Promise<PromptTemplate[]> {
  const { data, error } = await supabase
    .from("prompt_templates")
    .select("*")
    .eq("client_id", clientId)
    .eq("stage", stage)
    .order("version", { ascending: false });

  if (error) throw new Error(`Failed to get prompt history: ${error.message}`);

  return (data ?? []).map((d: Record<string, unknown>) => ({
    id: d.id as string, clientId: d.client_id as string,
    campaignId: (d.campaign_id as string) ?? undefined,
    stage: d.stage as string, version: d.version as number,
    promptText: d.prompt_text as string, parentId: (d.parent_id as string) ?? undefined,
    isActive: d.is_active as boolean, source: (d.source as string) ?? undefined,
    metadata: (d.metadata as Record<string, unknown>) ?? undefined,
    createdAt: d.created_at as string,
  }));
}

export async function addPromptScore(score: Omit<PromptScore, "id" | "createdAt">): Promise<PromptScore> {
  const { data, error } = await supabase
    .from("prompt_scores")
    .insert({
      prompt_id: score.promptId,
      run_id: score.runId,
      artifact_id: score.artifactId ?? null,
      score: score.score,
      gate_decision: score.gateDecision ?? null,
      feedback: score.feedback ?? null,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to add prompt score: ${error.message}`);

  return {
    id: data.id, promptId: data.prompt_id, runId: data.run_id,
    artifactId: data.artifact_id ?? undefined, score: data.score,
    gateDecision: data.gate_decision ?? undefined,
    feedback: data.feedback ?? undefined, createdAt: data.created_at,
  };
}

export async function getPromptScores(promptId: string): Promise<PromptScore[]> {
  const { data, error } = await supabase
    .from("prompt_scores")
    .select("*")
    .eq("prompt_id", promptId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to get prompt scores: ${error.message}`);

  return (data ?? []).map((d: Record<string, unknown>) => ({
    id: d.id as string, promptId: d.prompt_id as string, runId: d.run_id as string,
    artifactId: (d.artifact_id as string) ?? undefined, score: d.score as number,
    gateDecision: (d.gate_decision as string) ?? undefined,
    feedback: (d.feedback as string) ?? undefined, createdAt: d.created_at as string,
  }));
}

export async function getPromptLineage(promptId: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabase
    .from("prompt_evolution_log")
    .select("*")
    .or(`parent_prompt_id.eq.${promptId},child_prompt_id.eq.${promptId}`)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Failed to get prompt lineage: ${error.message}`);
  return data ?? [];
}

// ============ Brand Baseline DB Row Type ============

interface DbBrandBaseline {
  id: string;
  client_id: string;
  version: number;
  is_active: boolean;
  clip_baseline_z: number | null;
  e5_baseline_z: number | null;
  cohere_baseline_z: number | null;
  fused_baseline_z: number | null;
  clip_baseline_raw: number | null;
  e5_baseline_raw: number | null;
  cohere_baseline_raw: number | null;
  clip_stddev: number | null;
  e5_stddev: number | null;
  cohere_stddev: number | null;
  sample_count: number | null;
  created_at: string;
}

// ============ Brand Baseline Mapper ============

function mapDbBaselineToBaseline(row: DbBrandBaseline): BrandBaseline {
  return {
    id: row.id,
    clientId: row.client_id,
    version: row.version,
    isActive: row.is_active,
    geminiBaselineZ: row.clip_baseline_z ?? undefined,   // clip_* → gemini (same as drift_metrics mapping)
    cohereBaselineZ: row.cohere_baseline_z ?? undefined,
    fusedBaselineZ: row.fused_baseline_z ?? undefined,
    geminiBaselineRaw: row.clip_baseline_raw ?? undefined, // clip_* → gemini raw
    cohereBaselineRaw: row.cohere_baseline_raw ?? undefined,
    geminiStddev: row.clip_stddev ?? undefined,            // clip_stddev → gemini stddev
    cohereStddev: row.cohere_stddev ?? undefined,
    sampleCount: row.sample_count ?? undefined,
    createdAt: row.created_at,
  };
}

// ============ Brand Baseline Operations ============

async function getNextBaselineVersion(clientId: string): Promise<number> {
  const { data, error } = await supabase
    .from("brand_baselines")
    .select("version")
    .eq("client_id", clientId)
    .order("version", { ascending: false })
    .limit(1);

  if (error) throw new Error(`Failed to get baseline version: ${error.message}`);
  if (!data || data.length === 0) return 1;
  return (data[0].version as number) + 1;
}

export async function getActiveBaseline(clientId: string): Promise<BrandBaseline | null> {
  const { data, error } = await supabase
    .from("brand_baselines")
    .select("*")
    .eq("client_id", clientId)
    .eq("is_active", true)
    .order("version", { ascending: false })
    .limit(1);

  if (error) throw new Error(`Failed to get active baseline: ${error.message}`);
  if (!data || data.length === 0) return null;
  return mapDbBaselineToBaseline(data[0] as DbBrandBaseline);
}

export async function getBaselineHistory(clientId: string): Promise<BrandBaseline[]> {
  const { data, error } = await supabase
    .from("brand_baselines")
    .select("*")
    .eq("client_id", clientId)
    .order("version", { ascending: false });

  if (error) throw new Error(`Failed to get baseline history: ${error.message}`);
  return (data as DbBrandBaseline[]).map(mapDbBaselineToBaseline);
}

export async function createBaseline(baseline: BrandBaseline): Promise<BrandBaseline> {
  const version = await getNextBaselineVersion(baseline.clientId);

  const { data, error } = await supabase
    .from("brand_baselines")
    .insert({
      client_id: baseline.clientId,
      version,
      is_active: true,
      clip_baseline_z: baseline.geminiBaselineZ ?? null,     // gemini → clip_* columns
      cohere_baseline_z: baseline.cohereBaselineZ ?? null,
      fused_baseline_z: baseline.fusedBaselineZ ?? null,
      clip_baseline_raw: baseline.geminiBaselineRaw ?? null,  // gemini raw → clip_* columns
      cohere_baseline_raw: baseline.cohereBaselineRaw ?? null,
      clip_stddev: baseline.geminiStddev ?? null,             // gemini stddev → clip_stddev
      cohere_stddev: baseline.cohereStddev ?? null,
      sample_count: baseline.sampleCount ?? null,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create baseline: ${error.message}`);
  return mapDbBaselineToBaseline(data as DbBrandBaseline);
}

export async function deactivateBaselines(clientId: string, exceptId: string): Promise<void> {
  const { error } = await supabase
    .from("brand_baselines")
    .update({ is_active: false })
    .eq("client_id", clientId)
    .neq("id", exceptId);

  if (error) throw new Error(`Failed to deactivate baselines: ${error.message}`);
}

// ============================================================================
// Escalation System CRUD (migration 007)
// ============================================================================

interface DbKnownLimitation {
  id: string;
  model: string;
  category: string;
  failure_mode: string;
  description: string;
  mitigation: string | null;
  severity: string;
  detected_in_production_id: string | null;
  detected_in_run_id: string | null;
  times_encountered: number;
  last_encountered_at: string;
  created_at: string;
  updated_at: string;
}

interface DbAssetEscalation {
  id: string;
  client_id: string;
  artifact_id: string;
  deliverable_id: string | null;
  run_id: string | null;
  current_level: string;
  status: string;
  iteration_count: number;
  failure_class: string | null;
  known_limitation_id: string | null;
  resolution_path: string | null;
  resolution_notes: string | null;
  final_artifact_id: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DbOrchestrationDecision {
  id: string;
  client_id: string;
  escalation_id: string;
  run_id: string | null;
  iteration: number;
  input_context: Record<string, unknown>;
  decision: Record<string, unknown>;
  model: string;
  tokens_in: number | null;
  tokens_out: number | null;
  cost: number | null;
  latency_ms: number | null;
  created_at: string;
}

// ── Mappers ────────────────────────────────────────────────────────────────
function mapKnownLimitation(d: DbKnownLimitation): KnownLimitation {
  return {
    id: d.id,
    model: d.model,
    category: d.category,
    failureMode: d.failure_mode,
    description: d.description,
    mitigation: d.mitigation ?? undefined,
    severity: (d.severity === "blocking" ? "blocking" : "warning") as KnownLimitationSeverity,
    detectedInProductionId: d.detected_in_production_id ?? undefined,
    detectedInRunId: d.detected_in_run_id ?? undefined,
    timesEncountered: d.times_encountered,
    lastEncounteredAt: d.last_encountered_at,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

function mapAssetEscalation(d: DbAssetEscalation): AssetEscalation {
  return {
    id: d.id,
    clientId: d.client_id,
    artifactId: d.artifact_id,
    deliverableId: d.deliverable_id ?? undefined,
    runId: d.run_id ?? undefined,
    currentLevel: d.current_level as EscalationLevel,
    status: d.status as EscalationStatus,
    iterationCount: d.iteration_count,
    failureClass: d.failure_class ?? undefined,
    knownLimitationId: d.known_limitation_id ?? undefined,
    resolutionPath: (d.resolution_path ?? undefined) as EscalationAction | undefined,
    resolutionNotes: d.resolution_notes ?? undefined,
    finalArtifactId: d.final_artifact_id ?? undefined,
    resolvedAt: d.resolved_at ?? undefined,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

function mapOrchestrationDecision(d: DbOrchestrationDecision): OrchestrationDecisionRecord {
  return {
    id: d.id,
    clientId: d.client_id,
    escalationId: d.escalation_id,
    runId: d.run_id ?? undefined,
    iteration: d.iteration,
    inputContext: d.input_context,
    decision: d.decision,
    model: d.model,
    tokensIn: d.tokens_in ?? undefined,
    tokensOut: d.tokens_out ?? undefined,
    cost: d.cost ?? undefined,
    latencyMs: d.latency_ms ?? undefined,
    createdAt: d.created_at,
  };
}

// ── known_limitations CRUD ─────────────────────────────────────────────────

export async function listKnownLimitations(filters?: {
  model?: string;
  category?: string;
  severity?: KnownLimitationSeverity;
}): Promise<KnownLimitation[]> {
  let q = supabase.from("known_limitations").select("*").order("times_encountered", { ascending: false });
  if (filters?.model) q = q.eq("model", filters.model);
  if (filters?.category) q = q.eq("category", filters.category);
  if (filters?.severity) q = q.eq("severity", filters.severity);
  const { data, error } = await q;
  if (error) throw new Error(`Failed to list known limitations: ${error.message}`);
  return (data as DbKnownLimitation[]).map(mapKnownLimitation);
}

export async function getKnownLimitation(id: string): Promise<KnownLimitation | null> {
  const { data, error } = await supabase
    .from("known_limitations")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Failed to get known limitation: ${error.message}`);
  return data ? mapKnownLimitation(data as DbKnownLimitation) : null;
}

export async function getLimitationByFailureMode(failureMode: string): Promise<KnownLimitation | null> {
  const { data, error } = await supabase
    .from("known_limitations")
    .select("*")
    .eq("failure_mode", failureMode)
    .maybeSingle();
  if (error) throw new Error(`Failed to get limitation by failure_mode: ${error.message}`);
  return data ? mapKnownLimitation(data as DbKnownLimitation) : null;
}

export async function createKnownLimitation(limit: Omit<KnownLimitation, "id" | "timesEncountered" | "lastEncounteredAt" | "createdAt" | "updatedAt">): Promise<KnownLimitation> {
  const { data, error } = await supabase
    .from("known_limitations")
    .insert({
      model: limit.model,
      category: limit.category,
      failure_mode: limit.failureMode,
      description: limit.description,
      mitigation: limit.mitigation ?? null,
      severity: limit.severity,
      detected_in_production_id: limit.detectedInProductionId ?? null,
      detected_in_run_id: limit.detectedInRunId ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(`Failed to create known limitation: ${error.message}`);
  return mapKnownLimitation(data as DbKnownLimitation);
}

export async function updateKnownLimitation(id: string, updates: Partial<KnownLimitation>): Promise<KnownLimitation> {
  const patch: Record<string, unknown> = {};
  if (updates.description !== undefined) patch.description = updates.description;
  if (updates.mitigation !== undefined) patch.mitigation = updates.mitigation;
  if (updates.severity !== undefined) patch.severity = updates.severity;
  const { data, error } = await supabase
    .from("known_limitations")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) throw new Error(`Failed to update known limitation: ${error.message}`);
  return mapKnownLimitation(data as DbKnownLimitation);
}

export async function incrementLimitationCounter(id: string): Promise<void> {
  // Fetch current count, increment atomically via .rpc would be ideal but we
  // don't have the RPC defined — do read-modify-write within a single request.
  const { data: current, error: readErr } = await supabase
    .from("known_limitations")
    .select("times_encountered")
    .eq("id", id)
    .single();
  if (readErr || !current) return;
  const { error } = await supabase
    .from("known_limitations")
    .update({
      times_encountered: ((current as { times_encountered: number }).times_encountered ?? 0) + 1,
      last_encountered_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(`Failed to increment limitation counter: ${error.message}`);
}

// ── asset_escalations CRUD ─────────────────────────────────────────────────

export async function getEscalationByArtifact(
  artifactId: string,
  runId?: string,
): Promise<AssetEscalation | null> {
  // Optional runId narrows the lookup to the current run. Without it, this
  // returned the latest escalation row for the artifact across ALL runs —
  // which surfaced bug #1 in Chunk 3 (Session B escalations bled into new
  // runs) and again in the 2026-04-23 smoke (a cancelled-mid-flight run
  // left an in_progress L2 escalation on an artifact; the NEXT regrade
  // picked it up as "existing" and would have short-circuited). Callers
  // that care about the "did THIS RUN already start an escalation on this
  // artifact?" question should pass runId. Callers that just need the most
  // recent escalation (e.g., audit / HUD) can omit it.
  let q = supabase
    .from("asset_escalations")
    .select("*")
    .eq("artifact_id", artifactId);
  if (runId) q = q.eq("run_id", runId);
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to get escalation for artifact: ${error.message}`);
  return data ? mapAssetEscalation(data as DbAssetEscalation) : null;
}

export async function getEscalation(id: string): Promise<AssetEscalation | null> {
  const { data, error } = await supabase
    .from("asset_escalations")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Failed to get escalation: ${error.message}`);
  return data ? mapAssetEscalation(data as DbAssetEscalation) : null;
}

export async function listEscalations(filters?: {
  status?: EscalationStatus;
  runId?: string;
  campaignId?: string;
  clientId?: string;
}): Promise<AssetEscalation[]> {
  let q = supabase
    .from("asset_escalations")
    .select("*")
    .order("created_at", { ascending: false });
  if (filters?.status) q = q.eq("status", filters.status);
  if (filters?.runId) q = q.eq("run_id", filters.runId);
  // Campaign/client filters need a join through deliverables; defer to a view or
  // two-step query. For now, accept that campaignId and clientId require join.
  const { data, error } = await q;
  if (error) throw new Error(`Failed to list escalations: ${error.message}`);
  let items = (data as DbAssetEscalation[]).map(mapAssetEscalation);
  if (filters?.campaignId || filters?.clientId) {
    // Filter client-side by joining to deliverables/runs
    const deliverableIds = new Set<string>();
    if (filters.campaignId) {
      const { data: dels } = await supabase
        .from("campaign_deliverables")
        .select("id")
        .eq("campaign_id", filters.campaignId);
      (dels ?? []).forEach((d: { id: string }) => deliverableIds.add(d.id));
      items = items.filter((e) => e.deliverableId && deliverableIds.has(e.deliverableId));
    }
    if (filters.clientId) {
      const { data: runs } = await supabase
        .from("runs")
        .select("id")
        .eq("client_id", filters.clientId);
      const runIds = new Set((runs ?? []).map((r: { id: string }) => r.id));
      items = items.filter((e) => e.runId && runIds.has(e.runId));
    }
  }
  return items;
}

export async function listEscalationsByRun(runId: string): Promise<AssetEscalation[]> {
  const { data, error } = await supabase
    .from("asset_escalations")
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to list run escalations: ${error.message}`);
  return (data as DbAssetEscalation[]).map(mapAssetEscalation);
}

export async function createEscalation(params: {
  clientId?: string;
  artifactId: string;
  deliverableId?: string;
  runId?: string;
  currentLevel?: EscalationLevel;
  status?: EscalationStatus;
  failureClass?: string;
  knownLimitationId?: string;
}): Promise<AssetEscalation> {
  const clientId = params.runId
    ? await requireClientIdForRun(params.runId, params.clientId)
    : await requireClientIdForArtifact(params.artifactId, params.clientId);
  await requireClientIdForArtifact(params.artifactId, clientId);
  if (params.deliverableId) {
    await requireClientIdForDeliverable(params.deliverableId, clientId);
  }
  const { data, error } = await supabase
    .from("asset_escalations")
    .insert({
      client_id: clientId,
      artifact_id: params.artifactId,
      deliverable_id: params.deliverableId ?? null,
      run_id: params.runId ?? null,
      current_level: params.currentLevel ?? "L1",
      status: params.status ?? "in_progress",
      iteration_count: 0,
      failure_class: params.failureClass ?? null,
      known_limitation_id: params.knownLimitationId ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(`Failed to create escalation: ${error.message}`);
  return mapAssetEscalation(data as DbAssetEscalation);
}

export async function updateEscalation(id: string, updates: {
  currentLevel?: EscalationLevel;
  status?: EscalationStatus;
  iterationCount?: number;
  failureClass?: string;
  knownLimitationId?: string;
  resolutionPath?: EscalationAction;
  resolutionNotes?: string;
  finalArtifactId?: string;
  resolvedAt?: string | null;
}): Promise<AssetEscalation> {
  const patch: Record<string, unknown> = {};
  if (updates.currentLevel !== undefined) patch.current_level = updates.currentLevel;
  if (updates.status !== undefined) patch.status = updates.status;
  if (updates.iterationCount !== undefined) patch.iteration_count = updates.iterationCount;
  if (updates.failureClass !== undefined) patch.failure_class = updates.failureClass;
  if (updates.knownLimitationId !== undefined) patch.known_limitation_id = updates.knownLimitationId;
  if (updates.resolutionPath !== undefined) patch.resolution_path = updates.resolutionPath;
  if (updates.resolutionNotes !== undefined) patch.resolution_notes = updates.resolutionNotes;
  if (updates.finalArtifactId !== undefined) patch.final_artifact_id = updates.finalArtifactId;
  if (updates.resolvedAt !== undefined) patch.resolved_at = updates.resolvedAt;
  const { data, error } = await supabase
    .from("asset_escalations")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) throw new Error(`Failed to update escalation: ${error.message}`);
  return mapAssetEscalation(data as DbAssetEscalation);
}

export async function resolveEscalation(
  id: string,
  status: EscalationStatus,
  notes?: string,
  finalArtifactId?: string,
): Promise<AssetEscalation> {
  return updateEscalation(id, {
    status,
    resolutionNotes: notes,
    finalArtifactId,
    resolvedAt: new Date().toISOString(),
  });
}

// ── orchestration_decisions CRUD ────────────────────────────────────────────

export async function recordOrchestrationDecision(params: {
  clientId?: string;
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
}): Promise<OrchestrationDecisionRecord> {
  const clientId = params.runId
    ? await requireClientIdForRun(params.runId, params.clientId)
    : await requireClientIdForEscalation(params.escalationId, params.clientId);
  await requireClientIdForEscalation(params.escalationId, clientId);
  const { data, error } = await supabase
    .from("orchestration_decisions")
    .insert({
      client_id: clientId,
      escalation_id: params.escalationId,
      run_id: params.runId ?? null,
      iteration: params.iteration,
      input_context: params.inputContext,
      decision: params.decision,
      model: params.model,
      tokens_in: params.tokensIn ?? null,
      tokens_out: params.tokensOut ?? null,
      cost: params.cost ?? null,
      latency_ms: params.latencyMs ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(`Failed to record orchestration decision: ${error.message}`);
  const decision = mapOrchestrationDecision(data as DbOrchestrationDecision);
  const decisionType = params.inputContext?.decision_type;
  if (decisionType !== "audit_verdict") {
    await recordCost({
      clientId,
      runId: params.runId,
      escalationId: params.escalationId,
      eventType: "orchestrator_decision",
      source: params.model,
      costUsd: params.cost ?? 0,
      tokensInput: params.tokensIn,
      tokensOutput: params.tokensOut,
      metadata: {
        orchestrationDecisionId: decision.id,
        iteration: params.iteration,
        decision_type: decisionType ?? "orchestrator_decision",
      },
    });
  }
  return decision;
}

/**
 * Estimate the total in-flight cost for a run — sum of recorded
 * `orchestration_decisions.cost` (real Anthropic spend, accurate) plus
 * per-Veo-artifact cost ESTIMATED via a model-id → cost-per-second table
 * (Vertex doesn't return realized cost; we approximate from public pricing).
 *
 * Used by `runner.ts::executeRegradeStage` for the per-production
 * `ProductionBudget` cap (2026-04-23). The ESTIMATE is intentionally
 * conservative — better to halt early than to blow past the budget waiting
 * for billing reconciliation.
 *
 * Image-gen cost (Temp-gen `/generate/image` for L3 redesigns) is currently
 * out of scope — Gemini 3 Pro Image cost is small (~$0.03/image) compared
 * to Veo ($1.60-$3.20/clip), so the omission is conservative-favorable
 * (real cost is slightly higher than estimate).
 */
export const VEO_COST_PER_SECOND_BY_MODEL: Record<string, number> = {
  // Vertex Veo 3.1 GA standard ~ $0.40/second (placeholder per Temp-gen
  // cost_utils observed pricing; tune as Vertex publishes official rates).
  "veo-3.1-generate-001": 0.40,
  // Vertex Veo 3.1 Lite (GA) ~ half of standard — matches Fast per-second rate
  // (placeholder pending official Vertex pricing for lite; conservative-favorable).
  "veo-3.1-lite-generate-001": 0.20,
};

export interface RunCostEstimate {
  orchestratorUsd: number;
  veoUsd: number;
  imageUsd: number;
  totalUsd: number;
  orchDecisionCount: number;
  veoArtifactCount: number;
  imageArtifactCount: number;
}

export async function getRunCostEstimate(runId: string): Promise<RunCostEstimate> {
  const [decsRes, artsRes] = await Promise.all([
    supabase
      .from("orchestration_decisions")
      .select("cost")
      .eq("run_id", runId),
    supabase
      .from("artifacts")
      .select("type, metadata")
      .eq("run_id", runId)
      .in("type", ["video", "image"]),
  ]);
  if (decsRes.error)
    throw new Error(`getRunCostEstimate: orchestration_decisions read failed: ${decsRes.error.message}`);
  if (artsRes.error)
    throw new Error(`getRunCostEstimate: artifacts read failed: ${artsRes.error.message}`);

  const orchestratorUsd = (decsRes.data ?? []).reduce(
    (s: number, d: { cost?: number | null }) => s + (d.cost ?? 0),
    0,
  );

  let veoUsd = 0;
  let imageUsd = 0;
  let veoArtifactCount = 0;
  let imageArtifactCount = 0;
  for (const a of artsRes.data ?? []) {
    const meta = (a.metadata as Record<string, unknown> | null) ?? {};
    if (a.type === "video") {
      veoArtifactCount += 1;
      const model = typeof meta.model === "string" ? meta.model : "veo-3.1-lite-generate-001";
      const duration = typeof meta.duration_seconds === "number" ? meta.duration_seconds : 8;
      const perSec = VEO_COST_PER_SECOND_BY_MODEL[model] ?? VEO_COST_PER_SECOND_BY_MODEL["veo-3.1-lite-generate-001"];
      veoUsd += perSec * duration;
    } else if (a.type === "image") {
      imageArtifactCount += 1;
      // Gemini 3 Pro image ~$0.03/image (placeholder; small relative to Veo).
      imageUsd += 0.03;
    }
  }

  return {
    orchestratorUsd,
    veoUsd,
    imageUsd,
    totalUsd: orchestratorUsd + veoUsd + imageUsd,
    orchDecisionCount: (decsRes.data ?? []).length,
    veoArtifactCount,
    imageArtifactCount,
  };
}

export interface RunLedgerCostSummary {
  totalUsd: number;
  byEventType: Record<CostEvent, number>;
  bySource: Record<string, number>;
  entryCount: number;
}

export async function getRunCostFromLedger(runId: string): Promise<RunLedgerCostSummary> {
  const { data, error } = await supabase
    .from("cost_ledger_entries")
    .select("event_type, source, cost_usd")
    .eq("run_id", runId);

  if (error) {
    throw new Error(`getRunCostFromLedger: cost_ledger_entries read failed: ${error.message}`);
  }

  const byEventType = {} as Record<CostEvent, number>;
  const bySource: Record<string, number> = {};
  let totalUsd = 0;

  for (const row of data ?? []) {
    const eventType = String(row.event_type ?? "") as CostEvent;
    const source = String(row.source ?? "unknown");
    const costUsd = Number(row.cost_usd ?? 0);
    const safeCost = Number.isFinite(costUsd) ? costUsd : 0;

    totalUsd += safeCost;
    byEventType[eventType] = (byEventType[eventType] ?? 0) + safeCost;
    bySource[source] = (bySource[source] ?? 0) + safeCost;
  }

  return {
    totalUsd,
    byEventType,
    bySource,
    entryCount: (data ?? []).length,
  };
}

export async function getOrchestrationDecisions(escalationId: string): Promise<OrchestrationDecisionRecord[]> {
  const { data, error } = await supabase
    .from("orchestration_decisions")
    .select("*")
    .eq("escalation_id", escalationId)
    .order("iteration", { ascending: true });
  if (error) throw new Error(`Failed to get orchestration decisions: ${error.message}`);
  return (data as DbOrchestrationDecision[]).map(mapOrchestrationDecision);
}

/**
 * Aggregate orchestration_decisions across ALL escalation rows for a given
 * (deliverable, run) pair, ordered by created_at ascending.
 *
 * Context (bug #3 fix, 2026-04-23): `escalation_loop.ts` creates a new
 * `asset_escalations` row whenever `getEscalationByArtifact(artifact.id)` comes
 * back null — which happens on every regen artifact, because the new artifact
 * has no prior escalation row. Before the fix, the orchestrator's Rule 2
 * self-detection (`consecSameRegens`, `cumulativeCost`, `levelsUsed`) queried
 * by `escalation_id`, so aggregated signals reset to zero on every iteration.
 *
 * This helper lets the escalation loop pull history across ALL predecessor
 * escalations on the same `(deliverable, run)` — so Rule 2 sees the full
 * per-shot-per-run decision trail and can detect genuine repetition.
 *
 * Two-step fetch (escalation ids → decisions) because Supabase PostgREST
 * doesn't let us filter JOINs cleanly without a view.
 */
export async function getOrchestrationDecisionsForDeliverableInRun(
  deliverableId: string,
  runId: string,
): Promise<OrchestrationDecisionRecord[]> {
  // 1. Collect escalation ids for this (deliverable, run) pair.
  const { data: escRows, error: escErr } = await supabase
    .from("asset_escalations")
    .select("id")
    .eq("deliverable_id", deliverableId)
    .eq("run_id", runId);
  if (escErr) throw new Error(`Failed to list escalations for deliverable+run: ${escErr.message}`);
  const escalationIds = (escRows ?? []).map((r: { id: string }) => r.id);
  if (escalationIds.length === 0) return [];

  // 2. Pull all decisions across those escalations, ordered chronologically.
  const { data, error } = await supabase
    .from("orchestration_decisions")
    .select("*")
    .in("escalation_id", escalationIds)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to get aggregated orchestration decisions: ${error.message}`);
  return (data as DbOrchestrationDecision[]).map(mapOrchestrationDecision);
}

/**
 * Latest non-terminal `asset_escalations` row for a given (deliverable, run)
 * pair. Used by escalation_loop.ts to inherit `currentLevel` + `iterationCount`
 * when a regen produces a new artifact (bug #3 fix, 2026-04-23).
 *
 * "Non-terminal" = status === "in_progress". Terminal statuses
 * (resolved/accepted/redesigned/replaced/hitl_required) are excluded — we only
 * want to inherit from an open predecessor, not resurrect a closed one.
 *
 * Returns null when no predecessor exists (e.g., first artifact of a run, or
 * deliverables with no prior escalations).
 */
export async function getLatestOpenEscalationForDeliverableInRun(
  deliverableId: string,
  runId: string,
): Promise<AssetEscalation | null> {
  const { data, error } = await supabase
    .from("asset_escalations")
    .select("*")
    .eq("deliverable_id", deliverableId)
    .eq("run_id", runId)
    .eq("status", "in_progress")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(
      `Failed to get latest open escalation for deliverable+run: ${error.message}`,
    );
  }
  return data ? mapAssetEscalation(data as DbAssetEscalation) : null;
}

export async function getOrchestrationDecisionsByRun(runId: string): Promise<OrchestrationDecisionRecord[]> {
  const { data, error } = await supabase
    .from("orchestration_decisions")
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to get run orchestration decisions: ${error.message}`);
  return (data as DbOrchestrationDecision[]).map(mapOrchestrationDecision);
}

// ── Shot summaries (Chunk 2 — HUD observability) ────────────────────────
//
// Aggregates campaign_deliverables + artifacts.metadata.narrative_context +
// asset_escalations + orchestration_decisions into one row per deliverable so
// the HUD's DeliverableTracker can render L-badges, cost badges, and verdicts
// without 4 separate round-trips per card.
//
// Rationale:
// - Supabase PostgREST can't join cross-table in one call without a view;
//   creating a view is out of scope for Chunk 2 (no migrations).
// - The dataset is bounded (≤30 deliverables for Drift MV today; similar
//   magnitude for other music-video campaigns) — four parallel fetches +
//   in-memory stitching is comfortably fast and avoids N+1 round-trips.
// - Per-run filtering is optional. When `runId` is passed, artifacts /
//   escalations / decisions are narrowed so the HUD reflects the active
//   regrade without cross-run pollution; otherwise the summary reflects
//   all-time state for the deliverable.
//
// Returned rows are sorted by shotNumber asc (nulls last) so the tracker can
// render shots in narrative order without extra work on the consumer side.

export async function getShotSummaries(
  campaignId: string,
  runId?: string,
): Promise<ShotSummary[]> {
  // 1. Deliverables for this campaign.
  const deliverables = await getDeliverablesByCampaign(campaignId);
  if (deliverables.length === 0) return [];
  const deliverableIds = deliverables.map((d) => d.id);

  // 2. Artifacts (optionally narrowed to runId). Sorted DESC so the first row
  //    per deliverable is "latest".
  let artifactsQuery = supabase
    .from("artifacts")
    .select("*")
    .in("deliverable_id", deliverableIds)
    .order("created_at", { ascending: false });
  if (runId) artifactsQuery = artifactsQuery.eq("run_id", runId);
  const { data: artifactRows, error: artifactsErr } = await artifactsQuery;
  if (artifactsErr) {
    throw new Error(`getShotSummaries: artifacts fetch failed: ${artifactsErr.message}`);
  }
  const artifacts = (artifactRows as DbArtifact[] | null ?? []).map(mapDbArtifactToArtifact);

  // 3. Escalations (optionally narrowed to runId). Sorted DESC so first per
  //    deliverable is the latest.
  let escalationsQuery = supabase
    .from("asset_escalations")
    .select("*")
    .in("deliverable_id", deliverableIds)
    .order("updated_at", { ascending: false });
  if (runId) escalationsQuery = escalationsQuery.eq("run_id", runId);
  const { data: escalationRows, error: escalationsErr } = await escalationsQuery;
  if (escalationsErr) {
    throw new Error(`getShotSummaries: escalations fetch failed: ${escalationsErr.message}`);
  }
  const escalations = (escalationRows as DbAssetEscalation[] | null ?? []).map(mapAssetEscalation);
  const escalationIds = escalations.map((e) => e.id);

  // 4. Orchestration decisions for those escalations. Sorted ASC so iteration
  //    ordering is natural and "latest" = last element.
  let decisions: OrchestrationDecisionRecord[] = [];
  if (escalationIds.length > 0) {
    const { data: decisionRows, error: decisionsErr } = await supabase
      .from("orchestration_decisions")
      .select("*")
      .in("escalation_id", escalationIds)
      .order("iteration", { ascending: true });
    if (decisionsErr) {
      throw new Error(`getShotSummaries: decisions fetch failed: ${decisionsErr.message}`);
    }
    decisions = (decisionRows as DbOrchestrationDecision[] | null ?? []).map(mapOrchestrationDecision);
  }

  // 5. Stitch per deliverable.
  const byDelArtifacts = new Map<string, Artifact[]>();
  for (const a of artifacts) {
    if (!a.deliverableId) continue;
    const list = byDelArtifacts.get(a.deliverableId) ?? [];
    list.push(a);
    byDelArtifacts.set(a.deliverableId, list);
  }

  const byDelEscalations = new Map<string, AssetEscalation[]>();
  for (const e of escalations) {
    if (!e.deliverableId) continue;
    const list = byDelEscalations.get(e.deliverableId) ?? [];
    list.push(e);
    byDelEscalations.set(e.deliverableId, list);
  }

  const byEscalationDecisions = new Map<string, OrchestrationDecisionRecord[]>();
  for (const d of decisions) {
    const list = byEscalationDecisions.get(d.escalationId) ?? [];
    list.push(d);
    byEscalationDecisions.set(d.escalationId, list);
  }

  const summaries: ShotSummary[] = deliverables.map((deliverable) => {
    const delArtifacts = byDelArtifacts.get(deliverable.id) ?? [];
    const delEscalations = byDelEscalations.get(deliverable.id) ?? [];

    // Find the latest artifact with a narrative_context envelope (seeded
    // shots have this; runner-created regens may not). Fall back to the
    // newest artifact of any shape for latestArtifactId / artifactCount.
    const latestWithNarrative = delArtifacts.find((a) => {
      const nc = (a.metadata ?? {}) as Record<string, unknown>;
      return nc["narrative_context"] !== undefined;
    });
    const nc = (latestWithNarrative?.metadata?.["narrative_context"] ?? null) as
      | { shot_number?: unknown; beat_name?: unknown }
      | null;
    const shotNumber =
      typeof nc?.shot_number === "number" ? (nc.shot_number as number) : null;
    const beatName =
      typeof nc?.beat_name === "string" ? (nc.beat_name as BeatName) : null;

    // Latest escalation (if any) + decision roll-up across all escalations on
    // this deliverable (surfaces total cost even when the run ran multiple
    // escalations for the same shot).
    const latestEscalation = delEscalations[0] ?? null;
    let cumulativeCost = 0;
    let orchestratorCallCount = 0;
    let latestDecision: OrchestrationDecisionRecord | null = null;
    for (const esc of delEscalations) {
      const escDecisions = byEscalationDecisions.get(esc.id) ?? [];
      for (const d of escDecisions) {
        cumulativeCost += d.cost ?? 0;
        orchestratorCallCount += 1;
        if (
          !latestDecision ||
          new Date(d.createdAt).getTime() > new Date(latestDecision.createdAt).getTime()
        ) {
          latestDecision = d;
        }
      }
    }

    // Pull last verdict from the most-recent decision's input_context. Guard
    // against schema drift — input_context is JSONB so we coerce defensively.
    let lastVerdict: "PASS" | "WARN" | "FAIL" | null = null;
    let lastScore: number | null = null;
    if (latestDecision) {
      const ic = latestDecision.inputContext as Record<string, unknown> | null;
      const qa = (ic?.["qa_verdict"] ?? null) as Record<string, unknown> | null;
      const verdictCandidate = qa?.["verdict"];
      if (verdictCandidate === "PASS" || verdictCandidate === "WARN" || verdictCandidate === "FAIL") {
        lastVerdict = verdictCandidate;
      }
      const scoreCandidate = qa?.["aggregate_score"];
      if (typeof scoreCandidate === "number" && Number.isFinite(scoreCandidate)) {
        lastScore = scoreCandidate;
      }
    }

    return {
      deliverableId: deliverable.id,
      shotNumber,
      beatName,
      status: deliverable.status,
      retryCount: deliverable.retryCount,
      escalationLevel: latestEscalation?.currentLevel ?? null,
      escalationStatus: latestEscalation?.status ?? null,
      latestEscalationId: latestEscalation?.id ?? null,
      cumulativeCost,
      orchestratorCallCount,
      lastVerdict,
      lastScore,
      artifactCount: delArtifacts.length,
      latestArtifactId: delArtifacts[0]?.id ?? null,
    };
  });

  // Sort: shotNumber ascending, nulls last (unseeded / runner-regen rows
  // without narrative_context sink to the bottom so the timeline visualizes
  // cleanly even in partial-seed scenarios).
  summaries.sort((a, b) => {
    if (a.shotNumber === b.shotNumber) return a.deliverableId.localeCompare(b.deliverableId);
    if (a.shotNumber === null) return 1;
    if (b.shotNumber === null) return -1;
    return a.shotNumber - b.shotNumber;
  });

  return summaries;
}

// ── Prompt history helper (for orchestrator input assembly) ────────────────

/**
 * Assemble prompt history for a deliverable from prompt_templates + prompt_scores.
 * Used by runner to feed the orchestrator with "what's been tried" context.
 */
export async function getPromptHistoryForDeliverable(
  deliverableId: string,
): Promise<PromptHistoryEntry[]> {
  // Fetch prompts tied to this deliverable via metadata.deliverableId or related run
  const { data: scores, error } = await supabase
    .from("prompt_scores")
    .select("*, prompt_templates!inner(*)")
    .order("created_at", { ascending: true });
  if (error) {
    // Scores table may be sparse; fall back to empty
    return [];
  }
  const history: PromptHistoryEntry[] = [];
  let iteration = 0;
  for (const row of (scores ?? []) as Array<Record<string, unknown>>) {
    const tmpl = row.prompt_templates as Record<string, unknown> | undefined;
    if (!tmpl) continue;
    const metadata = (tmpl.metadata as Record<string, unknown> | undefined) ?? {};
    if (metadata.deliverableId !== deliverableId) continue;
    iteration += 1;
    history.push({
      iteration,
      stillPrompt: (metadata.stillPrompt as string | undefined) ?? (tmpl.prompt_text as string | undefined),
      veoPrompt: metadata.veoPrompt as string | undefined,
      negativePrompt: metadata.negativePrompt as string | undefined,
      verdict: (row.gate_decision as string | undefined) ?? "unknown",
      failureClass: metadata.failureClass as string | undefined,
      gradeScore: row.score as number | undefined,
      artifactId: (row.artifact_id as string | undefined) ?? undefined,
      timestamp: row.created_at as string | undefined,
    });
  }
  return history;
}
