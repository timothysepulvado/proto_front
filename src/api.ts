import { supabase } from "./lib/supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

export type RunMode = "full" | "ingest" | "images" | "video" | "drift" | "export" | "regrade" | "stills";
export type RunStatus = "pending" | "running" | "needs_review" | "blocked" | "completed" | "failed" | "cancelled";
export type ClientStatus = "active" | "inactive" | "archived";

export interface RunStage {
  id: string;
  name: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
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
  metadata?: Record<string, unknown>;
}

export interface RunLog {
  id: number;
  runId: string;
  timestamp: string;
  stage: string;
  level: "info" | "warn" | "error" | "debug";
  message: string;
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

export interface RecentCampaignRun {
  runId: string;
  clientId: string;
  campaignId?: string;
  mode: RunMode;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  durationSeconds: number | null;
  hitlRequired: boolean;
  hitlNotes?: string;
  shotIds: number[] | null;
  auditMode: boolean | null;
  parentRunId?: string;
}

export interface RunDetail {
  run: Run;
  logs: RunLog[];
  artifacts: Artifact[];
  orchestrationDecisionCount: number;
  totalOrchestrationCost: number;
  relatedStillsRun?: RecentCampaignRun | null;
}

export type MotionGateShotState =
  | "locked"
  | "operator-override"
  | "operator-accepted"
  | "canonical"
  | "pending";

export interface MotionGateShotOfNote {
  shotNumber: number;
  deliverableId?: string;
  state: MotionGateShotState;
  summary: string;
  source: "operator_override" | "asset_escalation" | "canonical_reference" | "manifest" | "run_history";
  runId?: string;
  criticScore?: number;
  criticVerdict?: string;
  decidedIter?: number;
  decisionBy?: string;
  decisionAt?: string;
}

export interface MotionPhaseGateState {
  campaignId: string;
  productionSlug?: string;
  lockedDeliverableIds: string[];
  lockedCount: number;
  operatorConfirmedCount: number;
  lockedWithoutExplicitApprovalCount: number;
  openHitlCount: number;
  blocked: boolean;
  latestStillsRunId?: string;
  shotsOfNote: MotionGateShotOfNote[];
  generatedAt: string;
}

export type DirectionDriftVerdictSource =
  | "run_logs"
  | "audit_report"
  | "orchestration_decision"
  | "operator_override"
  | "asset_escalation"
  | "manifest_caveat";

export interface DirectionDriftIndicator {
  deliverableId: string;
  shotNumber: number | null;
  directionDrift: boolean;
  latestVerdictRunId: string | null;
  latestVerdictTimestamp: string | null;
  matchedClasses: string[];
  source: DirectionDriftVerdictSource | null;
  verdict: "PASS" | "WARN" | "FAIL" | null;
  score: number | null;
  latestVerdictLogId?: number;
  latestVerdictDecisionId?: string;
  timelineEventId?: string;
}

export interface Client {
  id: string;
  name: string;
  status: ClientStatus;
  featured?: boolean;
  lastRunId?: string;
  lastRunAt?: string;
  lastRunStatus?: RunStatus;
  createdAt: string;
  updatedAt: string;
}

// Database row types (snake_case)
interface DbRun {
  id: string;
  client_id: string;
  campaign_id: string | null;
  mode: RunMode;
  status: RunStatus;
  stages: RunStage[];
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  hitl_required: boolean;
  hitl_notes: string | null;
  metadata: Record<string, unknown> | null;
}

interface DbRunLog {
  id: number;
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
  status: ClientStatus;
  last_run_id: string | null;
  last_run_at: string | null;
  last_run_status: RunStatus | null;
  created_at: string;
  updated_at: string;
}

// Mappers
function mapDbRunToRun(dbRun: DbRun): Run {
  return {
    runId: dbRun.id,
    clientId: dbRun.client_id,
    campaignId: dbRun.campaign_id ?? undefined,
    mode: dbRun.mode,
    status: dbRun.status,
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
  return {
    id: dbClient.id,
    name: dbClient.name,
    status: dbClient.status,
    lastRunId: dbClient.last_run_id ?? undefined,
    lastRunAt: dbClient.last_run_at ?? undefined,
    lastRunStatus: dbClient.last_run_status ?? undefined,
    createdAt: dbClient.created_at,
    updatedAt: dbClient.updated_at,
  };
}

// Get all clients
export async function getClients(): Promise<Client[]> {
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .order("name");

  if (error) {
    throw new Error(`Failed to get clients: ${error.message}`);
  }

  return (data as DbClient[]).map(mapDbClientToClient);
}

// Get a single client
export async function getClient(clientId: string): Promise<Client> {
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("id", clientId)
    .single();

  if (error) {
    throw new Error(`Failed to get client: ${error.message}`);
  }

  return mapDbClientToClient(data as DbClient);
}

// Create a new run
export async function createRun(clientId: string, mode: RunMode): Promise<Run> {
  const { data, error } = await supabase
    .from("runs")
    .insert({
      client_id: clientId,
      mode,
      status: "pending" as RunStatus,
      stages: [],
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create run: ${error.message}`);
  }

  // Update client's last_run info
  await supabase
    .from("clients")
    .update({
      last_run_id: data.id,
      last_run_at: data.created_at,
      last_run_status: data.status,
    })
    .eq("id", clientId);

  return mapDbRunToRun(data as DbRun);
}

// Get run details
export async function getRun(runId: string): Promise<Run> {
  const { data, error } = await supabase
    .from("runs")
    .select("*")
    .eq("id", runId)
    .single();

  if (error) {
    throw new Error(`Failed to get run: ${error.message}`);
  }

  return mapDbRunToRun(data as DbRun);
}

// Get runs for a client
export async function getClientRuns(clientId: string): Promise<Run[]> {
  const { data, error } = await supabase
    .from("runs")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to get client runs: ${error.message}`);
  }

  return (data as DbRun[]).map(mapDbRunToRun);
}

export async function getLatestStillsAuditRun(campaignId: string): Promise<Run | null> {
  const { data, error } = await supabase
    .from("runs")
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("mode", "stills")
    .order("created_at", { ascending: false })
    .limit(25);

  if (error) {
    throw new Error(`Failed to get latest stills audit run: ${error.message}`);
  }

  const auditRuns = (data as DbRun[])
    .map(mapDbRunToRun)
    .filter((run) => run.metadata?.audit_mode === true || Boolean(run.metadata?.audit_report));

  return auditRuns.find((run) => run.status === "completed" && Boolean(run.metadata?.audit_report))
    ?? auditRuns.find((run) => run.status === "running" || run.status === "pending")
    ?? auditRuns[0]
    ?? null;
}

/**
 * Gap 2 (2026-04-30) — staleness signal for the audit triage panel.
 *
 * Counts in-loop stills runs (`mode:'stills'` + `metadata.audit_mode != true`)
 * created strictly after the provided cutoff. The cutoff is the
 * `created_at` of the most recent audit-mode run for the campaign. If no
 * cutoff is provided (no audit ever fired), returns null so the caller
 * can render an "audit never run" state instead of a misleading zero.
 *
 * Used by `<AuditTriageTable>` to render: "Today's in-loop runs: {N} ran
 * since." — operator knows the triage report is N regens behind reality
 * and can fire a fresh audit if needed.
 *
 * Implementation note: filters via JSONB->>'audit_mode' != 'true'. Both
 * `audit_mode: false` and missing-key (null) cases match — both are
 * legitimate in-loop runs (auditMode defaults to false at runner level
 * pre-Phase B persistence; current rows have explicit `audit_mode: false`).
 */
export async function getInLoopRunsSinceAudit(
  campaignId: string,
  auditCutoffISO: string | null,
): Promise<number | null> {
  if (!auditCutoffISO) return null;

  const { data, error } = await supabase
    .from("runs")
    .select("id, metadata")
    .eq("campaign_id", campaignId)
    .eq("mode", "stills")
    .gt("created_at", auditCutoffISO);

  if (error) {
    // Non-fatal — banner will fall back to "—" rather than blocking the panel.
    console.warn("[api] getInLoopRunsSinceAudit failed:", error.message);
    return null;
  }
  if (!data) return 0;
  // Filter out audit-mode runs in JS (JSONB head-count via PostgREST is
  // version-dependent; this is the reliable path).
  const inLoopOnly = (data as Array<{ id: string; metadata: Record<string, unknown> | null }>).filter(
    (row) => {
      const auditMode = row.metadata && (row.metadata as { audit_mode?: unknown }).audit_mode;
      return auditMode !== true;
    },
  );
  return inLoopOnly.length;
}

// ============ Operator Override Audit Trail (Gap 3) ============

export interface OperatorOverrideDecision {
  runId: string;
  campaignId: string;
  runCreatedAt: string;
  shotKey: string;
  shotNumber: number;
  decisionAt: string;
  decisionBy?: string;
  decidedArtifactPath?: string;
  decidedIter?: number;
  criticVerdict?: string;
  criticScore?: number;
  rationale?: string;
  lockedTo?: string;
  runOrdinalForShot?: number;
}

interface DbRunOperatorOverride {
  id: string;
  campaign_id: string | null;
  mode: RunMode;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

const OPERATOR_OVERRIDE_SHOT_KEY = /^shot_(\d+)$/i;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function extractShotIds(metadata: Record<string, unknown> | null): number[] {
  const raw = metadata?.shot_ids;
  if (!Array.isArray(raw)) return [];
  const ids = raw
    .map((item) => {
      if (typeof item === "number" && Number.isInteger(item)) return item;
      if (typeof item === "string") {
        const parsed = Number.parseInt(item, 10);
        return Number.isInteger(parsed) ? parsed : null;
      }
      return null;
    })
    .filter((item): item is number => item !== null && item > 0);
  return [...new Set(ids)];
}

function isAuditModeRun(metadata: Record<string, unknown> | null): boolean {
  return metadata?.audit_mode === true;
}

function eventTimestamp(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Reads `runs.metadata.operator_override` for every run in a campaign and
 * normalizes the sparse JSONB shape into per-shot audit events.
 *
 * The helper intentionally derives a shot-specific in-loop run ordinal
 * (`v5` for today's shot 20 override) from the same campaign run set so the
 * HUD can explain operator choices in the language Tim used during review.
 */
export async function getOperatorOverridesForCampaign(campaignId: string): Promise<OperatorOverrideDecision[]> {
  const { data, error } = await supabase
    .from("runs")
    .select("id,campaign_id,mode,created_at,metadata")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true })
    .limit(250);

  if (error) throw new Error(`Failed to get operator overrides: ${error.message}`);

  const rows = (data as DbRunOperatorOverride[]) ?? [];
  const shotCounts = new Map<number, number>();
  const shotOrdinalByRun = new Map<string, number>();

  for (const row of rows) {
    const metadata = isPlainRecord(row.metadata) ? row.metadata : null;
    if (row.mode !== "stills" || isAuditModeRun(metadata)) continue;

    for (const shotId of extractShotIds(metadata)) {
      const nextOrdinal = (shotCounts.get(shotId) ?? 0) + 1;
      shotCounts.set(shotId, nextOrdinal);
      shotOrdinalByRun.set(`${row.id}:shot_${shotId}`, nextOrdinal);
    }
  }

  const overrides: OperatorOverrideDecision[] = [];
  for (const row of rows) {
    const metadata = isPlainRecord(row.metadata) ? row.metadata : null;
    const operatorOverride = isPlainRecord(metadata?.operator_override)
      ? metadata.operator_override
      : null;
    if (!operatorOverride) continue;

    for (const [shotKey, rawDecision] of Object.entries(operatorOverride)) {
      const shotMatch = OPERATOR_OVERRIDE_SHOT_KEY.exec(shotKey);
      const decision = isPlainRecord(rawDecision) ? rawDecision : null;
      if (!shotMatch || !decision) continue;

      const shotNumber = Number.parseInt(shotMatch[1], 10);
      if (!Number.isInteger(shotNumber)) continue;

      const normalizedShotKey = `shot_${shotNumber}`;
      overrides.push({
        runId: row.id,
        campaignId: row.campaign_id ?? campaignId,
        runCreatedAt: row.created_at,
        shotKey: normalizedShotKey,
        shotNumber,
        decisionAt: readOptionalString(decision, "decision_at") ?? row.created_at,
        decisionBy: readOptionalString(decision, "decision_by"),
        decidedArtifactPath: readOptionalString(decision, "decided_artifact_path"),
        decidedIter: readOptionalNumber(decision, "decided_iter"),
        criticVerdict: readOptionalString(decision, "critic_verdict"),
        criticScore: readOptionalNumber(decision, "critic_score"),
        rationale: readOptionalString(decision, "rationale"),
        lockedTo: readOptionalString(decision, "locked_to"),
        runOrdinalForShot: shotOrdinalByRun.get(`${row.id}:${normalizedShotKey}`),
      });
    }
  }

  return overrides.sort((left, right) => {
    const runDelta = eventTimestamp(right.runCreatedAt) - eventTimestamp(left.runCreatedAt);
    if (runDelta !== 0) return runDelta;
    return eventTimestamp(right.decisionAt) - eventTimestamp(left.decisionAt);
  });
}

// Update run status
export async function updateRunStatus(
  runId: string,
  status: RunStatus,
  updates?: { error?: string; hitl_required?: boolean; hitl_notes?: string }
): Promise<Run> {
  const updateData: Record<string, unknown> = { status, ...updates };

  if (status === "running" && !updates?.error) {
    updateData.started_at = new Date().toISOString();
  }
  if (status === "completed" || status === "failed" || status === "cancelled") {
    updateData.completed_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("runs")
    .update(updateData)
    .eq("id", runId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update run: ${error.message}`);
  }

  // Update client's last_run_status
  await supabase
    .from("clients")
    .update({ last_run_status: status })
    .eq("id", data.client_id);

  return mapDbRunToRun(data as DbRun);
}

// Cancel a run
export async function cancelRun(runId: string): Promise<{ success: boolean; message: string }> {
  await updateRunStatus(runId, "cancelled");
  return { success: true, message: "Run cancelled" };
}

// Approve HITL review
export async function approveReview(runId: string): Promise<Run> {
  return updateRunStatus(runId, "running", { hitl_required: false });
}

// Reject HITL review
export async function rejectReview(runId: string, notes: string): Promise<Run> {
  return updateRunStatus(runId, "blocked", { hitl_notes: notes });
}

// Get artifacts
export async function getArtifacts(runId: string): Promise<Artifact[]> {
  const { data, error } = await supabase
    .from("artifacts")
    .select("*")
    .eq("run_id", runId)
    .order("created_at");

  if (error) {
    throw new Error(`Failed to get artifacts: ${error.message}`);
  }

  return (data as DbArtifact[]).map(mapDbArtifactToArtifact);
}

// Create artifact
export async function createArtifact(
  runId: string,
  artifact: { type: Artifact["type"]; name: string; path: string; size?: number }
): Promise<Artifact> {
  const { data, error } = await supabase
    .from("artifacts")
    .insert({
      run_id: runId,
      type: artifact.type,
      name: artifact.name,
      path: artifact.path,
      size: artifact.size ?? null,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create artifact: ${error.message}`);
  }

  return mapDbArtifactToArtifact(data as DbArtifact);
}

// Export run (get all artifacts)
export async function exportRun(runId: string): Promise<{ artifacts: Artifact[] }> {
  const artifacts = await getArtifacts(runId);
  return { artifacts };
}

// Add a log entry
export async function addRunLog(
  runId: string,
  log: { stage: string; level: RunLog["level"]; message: string }
): Promise<RunLog> {
  const { data, error } = await supabase
    .from("run_logs")
    .insert({
      run_id: runId,
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

// Get logs for a run
export async function getRunLogs(runId: string): Promise<RunLog[]> {
  const { data, error } = await supabase
    .from("run_logs")
    .select("*")
    .eq("run_id", runId)
    .order("timestamp");

  if (error) {
    throw new Error(`Failed to get logs: ${error.message}`);
  }

  return (data as DbRunLog[]).map(mapDbLogToRunLog);
}

// Subscribe to run logs via Supabase Realtime
export function subscribeToLogs(
  runId: string,
  onLog: (log: RunLog) => void,
  onComplete: (result: { runId: string; status: RunStatus }) => void,
  onError: (error: Error) => void
): () => void {
  let channel: RealtimeChannel | null = null;

  // Subscribe to new log entries
  const logsChannel = supabase
    .channel(`run_logs:${runId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "run_logs",
        filter: `run_id=eq.${runId}`,
      },
      (payload) => {
        const dbLog = payload.new as DbRunLog;
        onLog(mapDbLogToRunLog(dbLog));
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        channel = logsChannel;
      } else if (status === "CHANNEL_ERROR") {
        onError(new Error("Failed to subscribe to logs channel"));
      }
    });

  // Subscribe to run status changes
  const runChannel = supabase
    .channel(`run:${runId}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "runs",
        filter: `id=eq.${runId}`,
      },
      (payload) => {
        const dbRun = payload.new as DbRun;
        // Check if run is complete
        if (["completed", "failed", "cancelled", "blocked"].includes(dbRun.status)) {
          onComplete({ runId: dbRun.id, status: dbRun.status });
        }
      }
    )
    .subscribe();

  // Return cleanup function
  return () => {
    if (channel) {
      supabase.removeChannel(channel);
    }
    supabase.removeChannel(logsChannel);
    supabase.removeChannel(runChannel);
  };
}

// Subscribe to all clients (for real-time updates)
export function subscribeToClients(
  onUpdate: (client: Client) => void
): () => void {
  const channel = supabase
    .channel("clients")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "clients",
      },
      (payload) => {
        if (payload.new) {
          onUpdate(mapDbClientToClient(payload.new as DbClient));
        }
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// ============ Prompt Template Operations ============

export interface PromptTemplate {
  id: string;
  clientId: string;
  campaignId?: string;
  stage: string;
  version: number;
  promptText: string;
  parentId?: string;
  isActive: boolean;
  source?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

interface DbPromptTemplate {
  id: string;
  client_id: string;
  campaign_id: string | null;
  stage: string;
  version: number;
  prompt_text: string;
  parent_id: string | null;
  is_active: boolean;
  source: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

function mapDbPromptToPrompt(d: DbPromptTemplate): PromptTemplate {
  return {
    id: d.id, clientId: d.client_id, campaignId: d.campaign_id ?? undefined,
    stage: d.stage, version: d.version, promptText: d.prompt_text,
    parentId: d.parent_id ?? undefined, isActive: d.is_active,
    source: d.source ?? undefined, metadata: d.metadata ?? undefined,
    createdAt: d.created_at,
  };
}

// Get active prompt for a client/stage
export async function getActivePrompt(clientId: string, stage: string = "generate"): Promise<PromptTemplate | null> {
  const { data, error } = await supabase
    .from("prompt_templates")
    .select("*")
    .eq("client_id", clientId)
    .eq("stage", stage)
    .eq("is_active", true)
    .order("version", { ascending: false })
    .limit(1);

  if (error) throw new Error(`Failed to get active prompt: ${error.message}`);
  if (!data || data.length === 0) return null;
  return mapDbPromptToPrompt(data[0] as DbPromptTemplate);
}

// Get prompt version history
export async function getPromptHistory(clientId: string, stage: string = "generate"): Promise<PromptTemplate[]> {
  const { data, error } = await supabase
    .from("prompt_templates")
    .select("*")
    .eq("client_id", clientId)
    .eq("stage", stage)
    .order("version", { ascending: false });

  if (error) throw new Error(`Failed to get prompt history: ${error.message}`);
  return (data as DbPromptTemplate[]).map(mapDbPromptToPrompt);
}

// Get prompt scores
export async function getPromptScores(promptId: string): Promise<{ id: string; score: number; gateDecision?: string; createdAt: string }[]> {
  const { data, error } = await supabase
    .from("prompt_scores")
    .select("*")
    .eq("prompt_id", promptId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to get prompt scores: ${error.message}`);
  return (data ?? []).map((d: Record<string, unknown>) => ({
    id: d.id as string,
    score: d.score as number,
    gateDecision: (d.gate_decision as string) ?? undefined,
    createdAt: d.created_at as string,
  }));
}

// Get evolution lineage
export async function getPromptLineage(promptId: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabase
    .from("prompt_evolution_log")
    .select("*")
    .or(`parent_prompt_id.eq.${promptId},child_prompt_id.eq.${promptId}`)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Failed to get prompt lineage: ${error.message}`);
  return data ?? [];
}

// Subscribe to prompt changes
export function subscribeToPrompts(
  clientId: string,
  onUpdate: (prompt: PromptTemplate) => void
): () => void {
  const channel = supabase
    .channel(`prompts:${clientId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "prompt_templates",
        filter: `client_id=eq.${clientId}`,
      },
      (payload) => {
        if (payload.new) {
          onUpdate(mapDbPromptToPrompt(payload.new as DbPromptTemplate));
        }
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// Create a new prompt (deactivates current active)
export async function createPrompt(
  clientId: string,
  promptText: string,
  stage: string = "generate",
  parentId?: string
): Promise<PromptTemplate> {
  const history = await getPromptHistory(clientId, stage);
  const nextVersion = history.length > 0 ? Math.max(...history.map(h => h.version)) + 1 : 1;

  // Deactivate current active prompt
  await supabase
    .from("prompt_templates")
    .update({ is_active: false })
    .eq("client_id", clientId)
    .eq("stage", stage)
    .eq("is_active", true);

  // Insert new prompt
  const { data, error } = await supabase
    .from("prompt_templates")
    .insert({
      client_id: clientId,
      stage,
      version: nextVersion,
      prompt_text: promptText,
      parent_id: parentId ?? null,
      is_active: true,
      source: "manual",
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create prompt: ${error.message}`);
  return mapDbPromptToPrompt(data as DbPromptTemplate);
}

// ============ HITL Decision Operations ============

export type HitlDecisionType = "approved" | "rejected" | "needs_revision";

export interface HitlDecision {
  id: string;
  runId: string;
  artifactId?: string;
  decision: HitlDecisionType;
  notes?: string;
  gradeScores?: Record<string, number>;
  rejectionCategories: string[];
  createdAt: string;
}

export interface RejectionCategory {
  id: string;
  name: string;
  description?: string;
  negativePrompt?: string;
  positiveGuidance?: string;
}

interface DbHitlDecision {
  id: string;
  run_id: string;
  artifact_id: string | null;
  decision: HitlDecisionType;
  notes: string | null;
  grade_scores: Record<string, number> | null;
  rejection_categories: string[] | null;
  created_at: string;
}

interface DbRejectionCategory {
  id: string;
  name?: string | null;
  label?: string | null;
  description?: string | null;
  negative_prompt: string | null;
  positive_guidance: string | null;
}

function mapDbHitlDecision(d: DbHitlDecision): HitlDecision {
  return {
    id: d.id,
    runId: d.run_id,
    artifactId: d.artifact_id ?? undefined,
    decision: d.decision,
    notes: d.notes ?? undefined,
    gradeScores: d.grade_scores ?? undefined,
    rejectionCategories: d.rejection_categories ?? [],
    createdAt: d.created_at,
  };
}

function mapDbRejectionCategory(d: DbRejectionCategory): RejectionCategory {
  return {
    id: d.id,
    name: d.name ?? d.label ?? d.id,
    description: d.description ?? undefined,
    negativePrompt: d.negative_prompt ?? undefined,
    positiveGuidance: d.positive_guidance ?? undefined,
  };
}

// Get rejection categories taxonomy
export async function getRejectionCategories(): Promise<RejectionCategory[]> {
  // Live proto_front has shipped with both historical shapes:
  //   migration shape: { id UUID, name, description, ... }
  //   seeded demo shape: { id text, label, ... }
  // Select all and sort client-side so Review Gate does not 400 on either.
  const { data, error } = await supabase
    .from("rejection_categories")
    .select("*");

  if (error) throw new Error(`Failed to get rejection categories: ${error.message}`);
  return (data as DbRejectionCategory[])
    .map(mapDbRejectionCategory)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Get artifacts for a run (for review queue)
export async function getArtifactsForReview(runId: string): Promise<Artifact[]> {
  const { data, error } = await supabase
    .from("artifacts")
    .select("*")
    .eq("run_id", runId)
    .order("created_at");

  if (error) throw new Error(`Failed to get artifacts for review: ${error.message}`);
  return (data as DbArtifact[]).map(mapDbArtifactToArtifact);
}

// Get existing HITL decisions for a run
export async function getHitlDecisions(runId: string): Promise<HitlDecision[]> {
  const { data, error } = await supabase
    .from("hitl_decisions")
    .select("*")
    .eq("run_id", runId)
    .order("created_at");

  if (error) throw new Error(`Failed to get HITL decisions: ${error.message}`);
  return (data as DbHitlDecision[]).map(mapDbHitlDecision);
}

// Submit a single HITL decision
export async function submitHitlDecision(
  runId: string,
  decision: HitlDecisionType,
  opts?: {
    artifactId?: string;
    notes?: string;
    gradeScores?: Record<string, number>;
    rejectionCategories?: string[];
  }
): Promise<HitlDecision> {
  const { data, error } = await supabase
    .from("hitl_decisions")
    .insert({
      run_id: runId,
      artifact_id: opts?.artifactId ?? null,
      decision,
      notes: opts?.notes ?? null,
      grade_scores: opts?.gradeScores ?? null,
      rejection_categories: opts?.rejectionCategories ?? [],
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to submit HITL decision: ${error.message}`);
  return mapDbHitlDecision(data as DbHitlDecision);
}

// Batch submit HITL decisions for multiple artifacts
export async function submitBatchHitlDecisions(
  runId: string,
  decisions: Array<{
    artifactId?: string;
    decision: HitlDecisionType;
    notes?: string;
    rejectionCategories?: string[];
  }>
): Promise<HitlDecision[]> {
  const rows = decisions.map((d) => ({
    run_id: runId,
    artifact_id: d.artifactId ?? null,
    decision: d.decision,
    notes: d.notes ?? null,
    grade_scores: null,
    rejection_categories: d.rejectionCategories ?? [],
  }));

  const { data, error } = await supabase
    .from("hitl_decisions")
    .insert(rows)
    .select();

  if (error) throw new Error(`Failed to submit batch HITL decisions: ${error.message}`);
  return (data as DbHitlDecision[]).map(mapDbHitlDecision);
}

// Subscribe to HITL decisions (realtime)
export function subscribeToHitlDecisions(
  runId: string,
  onDecision: (decision: HitlDecision) => void
): () => void {
  const channel = supabase
    .channel(`hitl_decisions:${runId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "hitl_decisions",
        filter: `run_id=eq.${runId}`,
      },
      (payload) => {
        if (payload.new) {
          onDecision(mapDbHitlDecision(payload.new as DbHitlDecision));
        }
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// Get runs pending HITL review for a client
export async function getPendingReviewRuns(clientId: string): Promise<Run[]> {
  const { data, error } = await supabase
    .from("runs")
    .select("*")
    .eq("client_id", clientId)
    .eq("status", "needs_review")
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to get pending review runs: ${error.message}`);
  return (data as DbRun[]).map(mapDbRunToRun);
}

// Get count of all pending reviews across all clients
export async function getPendingReviewCount(): Promise<number> {
  const { count, error } = await supabase
    .from("runs")
    .select("*", { count: "exact", head: true })
    .eq("status", "needs_review");

  if (error) throw new Error(`Failed to get pending review count: ${error.message}`);
  return count ?? 0;
}

// Health check
export async function healthCheck(): Promise<boolean> {
  try {
    const { error } = await supabase.from("clients").select("id").limit(1);
    return !error;
  } catch {
    return false;
  }
}

// ============ Drift Alert & Metric Operations ============

export interface DriftAlert {
  id: string;
  clientId: string;
  runId: string;
  severity: "warn" | "error" | "critical";
  message: string;
  fusedZ?: number;
  acknowledged: boolean;
  acknowledgedAt?: string;
  resolutionNotes?: string;
  createdAt: string;
}

export interface DriftMetric {
  id: string;
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
  createdAt: string;
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

interface DbDriftMetric {
  id: string;
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

function mapDbDriftAlertToDriftAlert(d: DbDriftAlert): DriftAlert {
  return {
    id: d.id,
    clientId: d.client_id,
    runId: d.run_id,
    severity: d.severity,
    message: d.message,
    fusedZ: d.fused_z ?? undefined,
    acknowledged: d.acknowledged,
    acknowledgedAt: d.acknowledged_at ?? undefined,
    resolutionNotes: d.resolution_notes ?? undefined,
    createdAt: d.created_at,
  };
}

function mapDbDriftMetricToDriftMetric(d: DbDriftMetric): DriftMetric {
  return {
    id: d.id,
    runId: d.run_id,
    artifactId: d.artifact_id ?? undefined,
    clipZ: d.clip_z ?? undefined,
    e5Z: d.e5_z ?? undefined,
    cohereZ: d.cohere_z ?? undefined,
    fusedZ: d.fused_z ?? undefined,
    clipRaw: d.clip_raw ?? undefined,
    e5Raw: d.e5_raw ?? undefined,
    cohereRaw: d.cohere_raw ?? undefined,
    gateDecision: d.gate_decision ?? undefined,
    createdAt: d.created_at,
  };
}

// Get drift alerts for a client (unacknowledged first)
export async function getDriftAlerts(clientId: string): Promise<DriftAlert[]> {
  const { data, error } = await supabase
    .from("drift_alerts")
    .select("*")
    .eq("client_id", clientId)
    .order("acknowledged", { ascending: true })
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to get drift alerts: ${error.message}`);
  return (data as DbDriftAlert[]).map(mapDbDriftAlertToDriftAlert);
}

// Get drift metrics for a run
export async function getDriftMetrics(runId: string): Promise<DriftMetric[]> {
  const { data, error } = await supabase
    .from("drift_metrics")
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Failed to get drift metrics: ${error.message}`);
  return (data as DbDriftMetric[]).map(mapDbDriftMetricToDriftMetric);
}

// Acknowledge a drift alert
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

  if (error) throw new Error(`Failed to acknowledge drift alert: ${error.message}`);
  return mapDbDriftAlertToDriftAlert(data as DbDriftAlert);
}

// Subscribe to drift alert changes for a client (realtime)
export function subscribeToDriftAlerts(
  clientId: string,
  onUpdate: (alert: DriftAlert) => void,
): () => void {
  const channel = supabase
    .channel(`drift_alerts:${clientId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "drift_alerts",
        filter: `client_id=eq.${clientId}`,
      },
      (payload) => {
        if (payload.new) {
          onUpdate(mapDbDriftAlertToDriftAlert(payload.new as DbDriftAlert));
        }
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// ============ Platform Variant Operations ============

const OS_API_URL = import.meta.env.VITE_OS_API_URL || "http://localhost:3001";

export async function createStillsAuditRun(clientId: string, campaignId: string): Promise<Run> {
  const resp = await fetch(`${OS_API_URL}/api/clients/${clientId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "stills",
      campaignId,
      auditMode: true,
    }),
  });

  if (!resp.ok) throw await parseOsApiError(resp);
  return (await resp.json()) as Run;
}

export async function getCampaignRecentRuns(campaignId: string, limit = 10): Promise<RecentCampaignRun[]> {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const resp = await fetch(
    `${OS_API_URL}/api/campaigns/${campaignId}/recent-runs?limit=${encodeURIComponent(String(safeLimit))}`,
  );
  if (!resp.ok) throw await parseOsApiError(resp);
  return (await resp.json()) as RecentCampaignRun[];
}

export async function getMotionPhaseGateState(campaignId: string): Promise<MotionPhaseGateState> {
  const resp = await fetch(`${OS_API_URL}/api/campaigns/${campaignId}/motion-phase-gate`);
  if (!resp.ok) throw await parseOsApiError(resp);
  return (await resp.json()) as MotionPhaseGateState;
}

export async function getDirectionDriftIndicators(
  campaignId: string,
): Promise<Record<string, DirectionDriftIndicator>> {
  const resp = await fetch(`${OS_API_URL}/api/campaigns/${campaignId}/direction-drift`);
  if (!resp.ok) throw await parseOsApiError(resp);
  return (await resp.json()) as Record<string, DirectionDriftIndicator>;
}

export async function createMotionPhaseRun(
  clientId: string,
  campaignId: string,
  gateState: MotionPhaseGateState,
): Promise<Run> {
  const resp = await fetch(`${OS_API_URL}/api/clients/${clientId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "video",
      campaignId,
      deliverableIds: gateState.lockedDeliverableIds,
      inputs: {
        source: "motion_phase_gate",
        parentRunId: gateState.latestStillsRunId,
        motionPhaseGate: {
          lockedStillsCount: gateState.lockedCount,
          operatorConfirmedCount: gateState.operatorConfirmedCount,
          lockedWithoutExplicitApprovalCount: gateState.lockedWithoutExplicitApprovalCount,
          openHitlCount: gateState.openHitlCount,
          shotsOfNote: gateState.shotsOfNote.map((shot) => ({
            shotNumber: shot.shotNumber,
            state: shot.state,
            source: shot.source,
            runId: shot.runId,
          })),
        },
      },
    }),
  });

  if (!resp.ok) throw await parseOsApiError(resp);
  return (await resp.json()) as Run;
}

export async function getRunDetail(runId: string): Promise<RunDetail> {
  const resp = await fetch(`${OS_API_URL}/api/runs/${runId}/detail`);
  if (!resp.ok) throw await parseOsApiError(resp);
  return (await resp.json()) as RunDetail;
}

export function subscribeToRunsByClient(
  clientId: string,
  onChange: (run: Run | null) => void,
): () => void {
  const channel = supabase
    .channel(`runs:${clientId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "runs",
        filter: `client_id=eq.${clientId}`,
      },
      (payload) => {
        if (payload.new) {
          onChange(mapDbRunToRun(payload.new as DbRun));
          return;
        }
        onChange(null);
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

export interface PlatformVariant {
  platform: string;
  label: string;
  width: number;
  height: number;
  aspectRatio: string;
  url: string;
}

export interface PlatformVariantsResponse {
  artifactId: string;
  artifactName: string;
  sourceUrl: string;
  availablePlatforms: string[];
  variants: PlatformVariant[];
}

/**
 * Get platform-specific variant URLs for an artifact via the OS API.
 * Requires the artifact to have been uploaded with Cloudinary configured.
 * Returns null if the API call fails or the artifact has no Cloudinary ID.
 */
export async function getArtifactPlatformUrls(
  artifactId: string,
  platforms?: string[],
): Promise<PlatformVariantsResponse | null> {
  try {
    const params = platforms && platforms.length > 0
      ? `?platforms=${platforms.join(",")}`
      : "";
    const resp = await fetch(`${OS_API_URL}/api/artifacts/${artifactId}/platforms${params}`);
    if (!resp.ok) {
      return null;
    }
    return (await resp.json()) as PlatformVariantsResponse;
  } catch (err) {
    console.warn("[api] Failed to get platform variants:", err);
    return null;
  }
}

// ============ Brand Baseline Operations ============

export interface BrandBaseline {
  id: string;
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
  createdAt: string;
}

interface DbBrandBaseline {
  id: string;
  client_id: string;
  version: number;
  is_active: boolean;
  clip_baseline_z: number | null;
  cohere_baseline_z: number | null;
  fused_baseline_z: number | null;
  clip_baseline_raw: number | null;
  cohere_baseline_raw: number | null;
  clip_stddev: number | null;
  cohere_stddev: number | null;
  sample_count: number | null;
  created_at: string;
}

function mapDbBaselineToBaseline(d: DbBrandBaseline): BrandBaseline {
  return {
    id: d.id,
    clientId: d.client_id,
    version: d.version,
    isActive: d.is_active,
    geminiBaselineZ: d.clip_baseline_z ?? undefined,     // clip_* → gemini
    cohereBaselineZ: d.cohere_baseline_z ?? undefined,
    fusedBaselineZ: d.fused_baseline_z ?? undefined,
    geminiBaselineRaw: d.clip_baseline_raw ?? undefined,  // clip_* → gemini raw
    cohereBaselineRaw: d.cohere_baseline_raw ?? undefined,
    geminiStddev: d.clip_stddev ?? undefined,             // clip_stddev → gemini stddev
    cohereStddev: d.cohere_stddev ?? undefined,
    sampleCount: d.sample_count ?? undefined,
    createdAt: d.created_at,
  };
}

// Get active baseline for a client (direct from Supabase)
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

// Get baseline version history for a client
export async function getBaselineHistory(clientId: string): Promise<BrandBaseline[]> {
  const { data, error } = await supabase
    .from("brand_baselines")
    .select("*")
    .eq("client_id", clientId)
    .order("version", { ascending: false });

  if (error) throw new Error(`Failed to get baseline history: ${error.message}`);
  return (data as DbBrandBaseline[]).map(mapDbBaselineToBaseline);
}

// Calculate a new baseline (calls os-api → brand-engine → writes to Supabase)
export async function calculateBaseline(clientId: string): Promise<BrandBaseline> {
  const response = await fetch(`${OS_API_URL}/api/clients/${clientId}/baseline/calculate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(body.error || `HTTP ${response.status}`);
  }

  return response.json();
}

// Subscribe to baseline changes for a client (realtime)
export function subscribeToBaselines(
  clientId: string,
  onUpdate: (baseline: BrandBaseline) => void,
): () => void {
  const channel = supabase
    .channel(`brand_baselines:${clientId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "brand_baselines",
        filter: `client_id=eq.${clientId}`,
      },
      (payload) => {
        if (payload.new) {
          onUpdate(mapDbBaselineToBaseline(payload.new as DbBrandBaseline));
        }
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// ============ Campaign Deliverable Operations ============

export type DeliverableStatus = "pending" | "generating" | "reviewing" | "approved" | "rejected" | "regenerating";

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

interface DbCampaignDeliverable {
  id: string;
  campaign_id: string;
  description: string | null;
  ai_model: string | null;
  current_prompt: string | null;
  original_prompt: string | null;
  status: string;
  retry_count: number;
  rejection_reason?: string | null;
  custom_rejection_note?: string | null;
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

interface DbCampaign {
  id: string;
  client_id: string;
  name: string;
  prompt: string | null;
  deliverables: unknown | null;
  platforms: string[] | null;
  mode: string | null;
  max_retries: number;
  reference_images?: string[] | null;
  guardrails?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function mapDbDeliverableToDeliverable(db: DbCampaignDeliverable): CampaignDeliverable {
  return {
    id: db.id,
    campaignId: db.campaign_id,
    description: db.description ?? undefined,
    aiModel: db.ai_model ?? undefined,
    currentPrompt: db.current_prompt ?? undefined,
    originalPrompt: db.original_prompt ?? undefined,
    status: db.status as DeliverableStatus,
    retryCount: db.retry_count,
    rejectionReason: db.custom_rejection_note ?? db.rejection_reason ?? undefined,
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

function mapDbCampaignToCampaign(db: DbCampaign): Campaign {
  return {
    id: db.id,
    clientId: db.client_id,
    name: db.name,
    prompt: db.prompt ?? undefined,
    deliverables: db.deliverables ?? undefined,
    platforms: db.platforms ?? undefined,
    mode: db.mode ?? undefined,
    maxRetries: db.max_retries,
    referenceImages: db.reference_images ?? undefined,
    guardrails: db.guardrails ?? undefined,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
  };
}

// Get campaigns for a BrandStudios workspace
export async function getCampaignsByClient(clientId: string): Promise<Campaign[]> {
  const { data, error } = await supabase
    .from("campaigns")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to get campaigns: ${error.message}`);
  return (data as DbCampaign[]).map(mapDbCampaignToCampaign);
}

// Get deliverables for a campaign
export async function getCampaignDeliverables(campaignId: string): Promise<CampaignDeliverable[]> {
  const { data, error } = await supabase
    .from("campaign_deliverables")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("created_at");

  if (error) throw new Error(`Failed to get campaign deliverables: ${error.message}`);
  return (data as DbCampaignDeliverable[]).map(mapDbDeliverableToDeliverable);
}

// Get campaign by ID
export async function getCampaign(campaignId: string): Promise<Campaign | null> {
  const { data, error } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();

  if (error) throw new Error(`Failed to get campaign: ${error.message}`);
  if (!data) return null;
  return mapDbCampaignToCampaign(data as DbCampaign);
}


// Get deliverable by ID via os-api (used by drawer detail fallbacks)
export async function getDeliverable(deliverableId: string): Promise<CampaignDeliverable | null> {
  const resp = await fetch(`${OS_API_URL}/api/deliverables/${deliverableId}`);
  if (resp.status === 404) return null;
  if (!resp.ok) throw await parseOsApiError(resp);
  return (await resp.json()) as CampaignDeliverable;
}

// Subscribe to deliverable updates for a campaign (realtime)
export function subscribeToCampaignDeliverables(
  campaignId: string,
  onUpdate: (deliverable: CampaignDeliverable) => void,
): () => void {
  const channel = supabase
    .channel(`campaign_deliverables:${campaignId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "campaign_deliverables",
        filter: `campaign_id=eq.${campaignId}`,
      },
      (payload) => {
        if (payload.new) {
          onUpdate(mapDbDeliverableToDeliverable(payload.new as DbCampaignDeliverable));
        }
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// ============ Review Gate Escalation Surface (Gap 1) ============

// ============ Shot Summaries (Chunk 2 — HUD observability) ============

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
  | "post_vfx";

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

interface DbAssetEscalation {
  id: string;
  artifact_id: string;
  deliverable_id: string | null;
  run_id: string | null;
  current_level: EscalationLevel;
  status: EscalationStatus;
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

function mapDbAssetEscalation(db: DbAssetEscalation): AssetEscalation {
  return {
    id: db.id,
    artifactId: db.artifact_id,
    deliverableId: db.deliverable_id ?? undefined,
    runId: db.run_id ?? undefined,
    currentLevel: db.current_level,
    status: db.status,
    iterationCount: db.iteration_count,
    failureClass: db.failure_class ?? undefined,
    knownLimitationId: db.known_limitation_id ?? undefined,
    resolutionPath: (db.resolution_path ?? undefined) as EscalationAction | undefined,
    resolutionNotes: db.resolution_notes ?? undefined,
    finalArtifactId: db.final_artifact_id ?? undefined,
    resolvedAt: db.resolved_at ?? undefined,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
  };
}

export interface ReviewGateEscalation {
  escalation: AssetEscalation;
  run?: Run;
  deliverable?: CampaignDeliverable;
}

const REVIEW_GATE_OPEN_ESCALATION_STATUSES: EscalationStatus[] = ["hitl_required", "in_progress"];

function reviewGateCutoffIso(days = 30): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export async function getOpenReviewGateEscalations(
  clientId: string,
  days = 30,
): Promise<ReviewGateEscalation[]> {
  const cutoff = reviewGateCutoffIso(days);
  const { data, error } = await supabase
    .from("asset_escalations")
    .select("*")
    .in("status", REVIEW_GATE_OPEN_ESCALATION_STATUSES)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to get Review Gate escalations: ${error.message}`);

  const escalations = (data as DbAssetEscalation[]).map(mapDbAssetEscalation);
  const runIds = [...new Set(escalations.map((item) => item.runId).filter(Boolean))] as string[];
  const deliverableIds = [...new Set(escalations.map((item) => item.deliverableId).filter(Boolean))] as string[];

  const runsById = new Map<string, Run>();
  if (runIds.length > 0) {
    const { data: runRows, error: runError } = await supabase
      .from("runs")
      .select("*")
      .in("id", runIds);

    if (runError) throw new Error(`Failed to get escalation runs: ${runError.message}`);
    for (const row of (runRows as DbRun[])) {
      const run = mapDbRunToRun(row);
      runsById.set(run.runId, run);
    }
  }

  const deliverablesById = new Map<string, CampaignDeliverable>();
  if (deliverableIds.length > 0) {
    const { data: deliverableRows, error: deliverableError } = await supabase
      .from("campaign_deliverables")
      .select("*")
      .in("id", deliverableIds);

    if (deliverableError) throw new Error(`Failed to get escalation deliverables: ${deliverableError.message}`);
    for (const row of (deliverableRows as DbCampaignDeliverable[])) {
      const deliverable = mapDbDeliverableToDeliverable(row);
      deliverablesById.set(deliverable.id, deliverable);
    }
  }

  return escalations
    .map((escalation) => ({
      escalation,
      run: escalation.runId ? runsById.get(escalation.runId) : undefined,
      deliverable: escalation.deliverableId ? deliverablesById.get(escalation.deliverableId) : undefined,
    }))
    .filter((item) => !clientId || item.run?.clientId === clientId);
}

export interface ResolveEscalationResponse {
  escalation: AssetEscalation;
  runHitlCleared: boolean;
}

export async function resolveEscalationAccept(
  escalationId: string,
  resolutionNotes: string,
): Promise<ResolveEscalationResponse> {
  const resp = await fetch(`${OS_API_URL}/api/escalations/${escalationId}/resolve`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "accepted",
      resolution_path: "accept",
      resolution_notes: resolutionNotes,
    }),
  });

  if (!resp.ok) throw await parseOsApiError(resp);
  return (await resp.json()) as ResolveEscalationResponse;
}

export function subscribeToAssetEscalations(
  clientId: string,
  onChange: () => void,
): () => void {
  const channel = supabase
    .channel(`asset_escalations:${clientId || "all"}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "asset_escalations",
      },
      () => {
        onChange();
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

export type BeatName =
  | "intro"
  | "hook_1"
  | "verse_1"
  | "hook_2"
  | "verse_2"
  | "bridge"
  | "hook_3"
  | "final_hook"
  | "outro";

/**
 * Per-shot observability row returned by
 * `GET /api/campaigns/:campaignId/shot-summaries`. Drives the
 * DeliverableTracker's L-badges, cost badges, and click-to-drawer wiring.
 *
 * Fields are nullable where the underlying data hasn't been produced yet —
 * e.g. `lastVerdict`/`lastScore` are null for shots that passed without any
 * escalation (there's no persisted qa_verdict on pass-through).
 */
export interface ShotSummary {
  deliverableId: string;
  shotNumber: number | null;
  beatName: BeatName | null;
  status: DeliverableStatus;
  retryCount: number;
  escalationLevel: EscalationLevel | null;
  escalationStatus: EscalationStatus | null;
  latestEscalationId: string | null;
  cumulativeCost: number;
  orchestratorCallCount: number;
  lastVerdict: "PASS" | "WARN" | "FAIL" | null;
  lastScore: number | null;
  artifactCount: number;
  latestArtifactId: string | null;
}

/**
 * Fetch shot summaries for a campaign. Optional `runId` narrows
 * artifacts / escalations / decisions to a single run so a live regrade's
 * metrics don't bleed across prior runs.
 */
export async function getShotSummaries(
  campaignId: string,
  runId?: string,
): Promise<ShotSummary[]> {
  const params = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
  const resp = await fetch(
    `${OS_API_URL}/api/campaigns/${campaignId}/shot-summaries${params}`,
  );
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(body.error || `HTTP ${resp.status}`);
  }
  return (await resp.json()) as ShotSummary[];
}

/**
 * Realtime bridge so the tracker can re-fetch shot summaries whenever an
 * orchestration_decisions row is INSERTed. Optional `runId` filter narrows
 * the subscription to events for a single run.
 */
export function subscribeToOrchestrationDecisions(
  runId: string,
  onInsert: () => void,
): () => void {
  const channel = supabase
    .channel(`orchestration_decisions:${runId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "orchestration_decisions",
        filter: `run_id=eq.${runId}`,
      },
      () => {
        onInsert();
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

/**
 * Realtime bridge for new artifacts. Used by the tracker to increment
 * per-shot artifact counts live without a full summary refetch.
 */
export function subscribeToArtifacts(
  runId: string,
  onInsert: (artifact: Artifact) => void,
): () => void {
  const channel = supabase
    .channel(`artifacts:${runId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "artifacts",
        filter: `run_id=eq.${runId}`,
      },
      (payload) => {
        if (payload.new) {
          onInsert(mapDbArtifactToArtifact(payload.new as DbArtifact));
        }
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// ============ Production Reshoot Operations (Step 11 HITL UI) ============

export type ProductionSlug = "drift-mv";

export interface ProductionFileMeta {
  path: string;
  sizeBytes: number;
  mtime: string;
}

export interface ProductionShotState {
  shotNumber: number;
  beat: string;
  startS: number;
  endS: number;
  durationS: number;
  visualIntent: string;
  charactersNeeded: string[];
  canonicalReferences: ProductionCanonicalReference[];
  defaultPrompt: string;
  stillPrompt?: string;
  negativePrompt?: string;
  canonical: ProductionFileMeta & { backupExists: boolean };
  pending: ProductionFileMeta | null;
  stillPath: string | null;
  activeJob?: ProductionJob | null;
}

export interface ProductionCanonicalReference {
  characterName: string;
  stillPath: string;
  thumb: string;
  lockedAt?: string;
  lockedBy?: string;
  rationale?: string;
  exists: boolean;
  sizeBytes?: number;
  mtime?: string;
}

export interface ProductionRenderArtifact extends ProductionFileMeta {
  durationS?: number;
}

export interface ProductionJob {
  jobId: string;
  productionSlug: ProductionSlug | string;
  kind: "regenerate" | "render";
  shotNumber?: number;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
}

export interface ProductionShotsResponse {
  shots: ProductionShotState[];
  renderArtifact?: ProductionRenderArtifact | null;
}

export interface ProductionAnchorCatalogItem {
  name: string;
  path: string;
  thumb: string;
  exists: boolean;
  sizeBytes?: number;
  mtime?: string;
  canonicalReference?: ProductionCanonicalReference;
}

export interface ProductionShotStillCatalogItem {
  shot: number;
  currentStillPath: string | null;
  currentStillThumb: string | null;
  currentStill?: ProductionFileMeta | null;
  backupStillPath?: string;
  backupStill?: ProductionFileMeta | null;
  anchors: ProductionAnchorCatalogItem[];
  anchorsSource: "regen_stills_pivot.py" | "manifest";
}

export interface ProductionShotStillsResponse {
  productionSlug: ProductionSlug;
  shots: ProductionShotStillCatalogItem[];
}

export type ProductionEvent =
  | { type: "connected"; productionSlug: string; timestamp: string }
  | { type: "regen_started"; productionSlug: string; timestamp: string; jobId: string; shotNumber: number; promptSource: "override" | "manifest"; useImageConditioning: boolean }
  | { type: "regen_log"; productionSlug: string; timestamp: string; jobId: string; shotNumber?: number; line: string; stream: "stdout" | "stderr" }
  | { type: "regen_complete"; productionSlug: string; timestamp: string; jobId: string; shotNumber?: number; exitCode: number | null; durationMs: number; error?: string }
  | { type: "shot_promoted"; productionSlug: string; timestamp: string; shotNumber: number; backupCreated: boolean; stillUpdated?: boolean; stillBackupCreated?: boolean; currentStillPath?: string; currentStillMtime?: string; warning?: string }
  | { type: "shot_rejected"; productionSlug: string; timestamp: string; shotNumber: number; pendingDeleted: boolean }
  | { type: "shot_still_replaced"; productionSlug: string; timestamp: string; shotNumber: number; replaced: boolean; backupCreated: boolean; currentStillPath: string }
  | { type: "shot_still_snapshot"; productionSlug: string; timestamp: string; shotNumber: number; label: string; snapshotPath: string }
  | { type: "shot_still_approved"; productionSlug: string; timestamp: string; shotNumber: number; approvedAt: string; deliverableId: string; artifactId: string }
  | { type: "shot_still_rejected"; productionSlug: string; timestamp: string; shotNumber: number; rejectedAt: string; deliverableId: string; artifactId: string }
  | { type: "shot_manifest_updated"; productionSlug: string; timestamp: string; shotNumber: number; cumulativeDurationDeltaS: number }
  | { type: "render_started"; productionSlug: string; timestamp: string; jobId: string }
  | { type: "render_log"; productionSlug: string; timestamp: string; jobId: string; line: string; stream: "stdout" | "stderr" }
  | { type: "render_complete"; productionSlug: string; timestamp: string; jobId: string; exitCode: number | null; durationMs: number; error?: string }
  | { type: "render_artifact"; productionSlug: string; timestamp: string; jobId: string; path: string; sizeBytes: number; durationS: number | null }
  | { type: string; productionSlug?: string; timestamp?: string; [key: string]: unknown };

async function parseOsApiError(resp: Response): Promise<Error> {
  const body = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
  const message = typeof body.error === "string" ? body.error : `HTTP ${resp.status}`;
  return new Error(message);
}

export function getProductionStillUrl(productionSlug: ProductionSlug, shotNumber: number): string {
  return `${OS_API_URL}/api/productions/${productionSlug}/shots/${shotNumber}/still`;
}

export function getProductionManagedStillUrl(
  productionSlug: ProductionSlug,
  shotNumber: number,
  cacheBust?: string | number,
): string {
  const suffix = cacheBust === undefined ? "" : `?v=${encodeURIComponent(String(cacheBust))}`;
  return `${OS_API_URL}/api/productions/${productionSlug}/shot/${shotNumber}/still${suffix}`;
}

export function getProductionAnchorUrl(
  productionSlug: ProductionSlug,
  anchorName: string,
  cacheBust?: string | number,
): string {
  const suffix = cacheBust === undefined ? "" : `?v=${encodeURIComponent(String(cacheBust))}`;
  return `${OS_API_URL}/api/productions/${productionSlug}/anchor/${encodeURIComponent(anchorName)}${suffix}`;
}

export function getProductionCanonicalReferenceUrl(
  productionSlug: ProductionSlug,
  characterName: string,
  cacheBust?: string | number,
): string {
  const suffix = cacheBust === undefined ? "" : `?v=${encodeURIComponent(String(cacheBust))}`;
  return `${OS_API_URL}/api/productions/${productionSlug}/canonical-reference/${encodeURIComponent(characterName)}${suffix}`;
}

export function getProductionShotThumbnailUrl(
  productionSlug: ProductionSlug,
  shotNumber: number,
  cacheBust?: string | number,
): string {
  const suffix = cacheBust === undefined ? "" : `?v=${encodeURIComponent(String(cacheBust))}`;
  return `${OS_API_URL}/api/productions/${productionSlug}/shots/${shotNumber}/thumbnail${suffix}`;
}

export function getProductionVideoUrl(
  productionSlug: ProductionSlug,
  shotNumber: number,
  variant: "canonical" | "pending" = "canonical",
): string {
  return `${OS_API_URL}/api/productions/${productionSlug}/shots/${shotNumber}/${variant}.mp4`;
}

export async function getProductionShots(productionSlug: ProductionSlug): Promise<ProductionShotsResponse> {
  const resp = await fetch(`${OS_API_URL}/api/productions/${productionSlug}/shots`);
  if (!resp.ok) throw await parseOsApiError(resp);
  return (await resp.json()) as ProductionShotsResponse;
}

export async function getProductionShotStills(productionSlug: ProductionSlug): Promise<ProductionShotStillsResponse> {
  const resp = await fetch(`${OS_API_URL}/api/productions/${productionSlug}/shot-stills`);
  if (!resp.ok) throw await parseOsApiError(resp);
  return (await resp.json()) as ProductionShotStillsResponse;
}


export interface ProductionShotPatch {
  visualIntent?: string;
  beat?: string;
  durationS?: number;
  charactersNeeded?: string[];
  stillPrompt?: string;
  veoPrompt?: string;
  negativePrompt?: string;
}

export interface ProductionShotPatchResponse {
  ok: true;
  shot: ProductionShotState;
  warning?: string;
}

export async function patchProductionShot(
  productionSlug: ProductionSlug,
  shotNumber: number,
  body: ProductionShotPatch,
): Promise<ProductionShotPatchResponse> {
  const resp = await fetch(`${OS_API_URL}/api/productions/${productionSlug}/shots/${shotNumber}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await parseOsApiError(resp);
  return (await resp.json()) as ProductionShotPatchResponse;
}

export async function regenerateProductionShot(
  productionSlug: ProductionSlug,
  shotNumber: number,
  body?: { prompt?: string; useImageConditioning?: boolean },
): Promise<{ jobId: string; status: "running" }> {
  const resp = await fetch(`${OS_API_URL}/api/productions/${productionSlug}/shots/${shotNumber}/regenerate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!resp.ok) throw await parseOsApiError(resp);
  return (await resp.json()) as { jobId: string; status: "running" };
}

export async function promoteProductionShot(
  productionSlug: ProductionSlug,
  shotNumber: number,
): Promise<{
  shotNumber: number;
  promoted: boolean;
  backupCreated: boolean;
  reason?: string;
  stillUpdated?: boolean;
  stillBackupCreated?: boolean;
  currentStill?: ProductionFileMeta | null;
  warning?: string;
}> {
  const resp = await fetch(`${OS_API_URL}/api/productions/${productionSlug}/shots/${shotNumber}/promote`, {
    method: "POST",
  });
  if (!resp.ok) throw await parseOsApiError(resp);
  return (await resp.json()) as {
    shotNumber: number;
    promoted: boolean;
    backupCreated: boolean;
    reason?: string;
    stillUpdated?: boolean;
    stillBackupCreated?: boolean;
    currentStill?: ProductionFileMeta | null;
    warning?: string;
  };
}

export async function rejectProductionShot(
  productionSlug: ProductionSlug,
  shotNumber: number,
): Promise<{ shotNumber: number; rejected: boolean; pendingDeleted: boolean }> {
  const resp = await fetch(`${OS_API_URL}/api/productions/${productionSlug}/shots/${shotNumber}/reject`, {
    method: "POST",
  });
  if (!resp.ok) throw await parseOsApiError(resp);
  return (await resp.json()) as { shotNumber: number; rejected: boolean; pendingDeleted: boolean };
}

export async function approveProductionShotStill(
  productionSlug: ProductionSlug,
  shotNumber: number,
  body?: { deliverableId?: string },
): Promise<{
  ok: true;
  shotNumber: number;
  approvedAt: string;
  productionSlug: string;
  currentStillPath: string;
  artifactId: string;
  deliverableId: string;
  campaignId: string | null;
  referenceImages: string[];
}> {
  const resp = await fetch(`${OS_API_URL}/api/productions/${productionSlug}/shot/${shotNumber}/approve-still`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!resp.ok) throw await parseOsApiError(resp);
  return (await resp.json()) as {
    ok: true;
    shotNumber: number;
    approvedAt: string;
    productionSlug: string;
    currentStillPath: string;
    artifactId: string;
    deliverableId: string;
    campaignId: string | null;
    referenceImages: string[];
  };
}

export async function rejectProductionShotStill(
  productionSlug: ProductionSlug,
  shotNumber: number,
  body: { reason: string; denied_by?: string | null; deliverableId?: string },
): Promise<{
  ok: true;
  shotNumber: number;
  productionSlug: string;
  still_rejected_at: string;
  still_rejection_reason: string;
  still_denied_by: string | null;
  currentStillPath: string;
  artifactId: string;
  deliverableId: string;
  campaignId: string | null;
  referenceImages: string[];
}> {
  const resp = await fetch(`${OS_API_URL}/api/productions/${productionSlug}/shot/${shotNumber}/reject-still`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await parseOsApiError(resp);
  return (await resp.json()) as {
    ok: true;
    shotNumber: number;
    productionSlug: string;
    still_rejected_at: string;
    still_rejection_reason: string;
    still_denied_by: string | null;
    currentStillPath: string;
    artifactId: string;
    deliverableId: string;
    campaignId: string | null;
    referenceImages: string[];
  };
}

export async function snapshotProductionShotStill(
  productionSlug: ProductionSlug,
  shotNumber: number,
  body?: { label?: string },
): Promise<{
  ok: true;
  existed: false;
  status: 200;
  productionSlug: string;
  shotNumber: number;
  label: string;
  snapshot_path: string;
  snapshot: ProductionFileMeta;
  source_path: string;
}> {
  const resp = await fetch(`${OS_API_URL}/api/productions/${productionSlug}/shot/${shotNumber}/snapshot-still`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!resp.ok) throw await parseOsApiError(resp);
  return (await resp.json()) as {
    ok: true;
    existed: false;
    status: 200;
    productionSlug: string;
    shotNumber: number;
    label: string;
    snapshot_path: string;
    snapshot: ProductionFileMeta;
    source_path: string;
  };
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read selected still file"));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      resolve(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value);
    };
    reader.readAsDataURL(file);
  });
}

export async function replaceProductionShotStill(
  productionSlug: ProductionSlug,
  shotNumber: number,
  source: { sourcePath: string } | { file: File },
): Promise<{
  ok: true;
  shotNumber: number;
  replaced: boolean;
  backupCreated: boolean;
  sourcePath: string;
  currentStill: ProductionFileMeta;
  backupStill: ProductionFileMeta | null;
}> {
  const body = "file" in source
    ? { fileName: source.file.name, fileBase64: await readFileAsBase64(source.file) }
    : { sourcePath: source.sourcePath };

  const resp = await fetch(`${OS_API_URL}/api/productions/${productionSlug}/shot/${shotNumber}/still`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await parseOsApiError(resp);
  return (await resp.json()) as {
    ok: true;
    shotNumber: number;
    replaced: boolean;
    backupCreated: boolean;
    sourcePath: string;
    currentStill: ProductionFileMeta;
    backupStill: ProductionFileMeta | null;
  };
}

export async function triggerProductionRender(
  productionSlug: ProductionSlug,
): Promise<{ jobId: string; status: "running" }> {
  const resp = await fetch(`${OS_API_URL}/api/productions/${productionSlug}/render`, {
    method: "POST",
  });
  if (!resp.ok) throw await parseOsApiError(resp);
  return (await resp.json()) as { jobId: string; status: "running" };
}

export function subscribeToProductionEvents(
  productionSlug: ProductionSlug,
  onEvent: (event: ProductionEvent) => void,
  onError?: (error: Error) => void,
): () => void {
  const source = new EventSource(`${OS_API_URL}/api/productions/${productionSlug}/events`);
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as ProductionEvent);
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error("Failed to parse production event"));
    }
  };
  source.onerror = () => {
    onError?.(new Error("Production event stream disconnected"));
  };
  return () => source.close();
}
