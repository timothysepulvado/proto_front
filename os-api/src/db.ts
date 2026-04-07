import { supabase } from "./supabase.js";
import type { Run, RunLog, Artifact, Client, HitlDecision, DriftMetric, DriftAlert, RunStatus, RunStage } from "./types.js";

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
  type: "image" | "video" | "report" | "package";
  name: string;
  path: string;
  size: number | null;
  created_at: string;
}

interface DbClient {
  id: string;
  name: string;
  status: string;
  last_run_id: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  created_at?: string;
  updated_at?: string;
}

// ============ Mappers (DB → App) ============

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
    type: dbArtifact.type,
    name: dbArtifact.name,
    path: dbArtifact.path,
    size: dbArtifact.size ?? undefined,
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
  return mapped;
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

// ============ Log Operations ============

export async function addLog(log: Omit<RunLog, "id">): Promise<RunLog> {
  const { data, error } = await supabase
    .from("run_logs")
    .insert({
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
  const { data, error } = await supabase
    .from("artifacts")
    .insert({
      id: artifact.id,
      run_id: artifact.runId,
      type: artifact.type,
      name: artifact.name,
      path: artifact.path,
      size: artifact.size ?? null,
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
  const { data, error } = await supabase
    .from("hitl_decisions")
    .insert({
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

// ============ Drift Metric Operations ============

export async function addDriftMetric(metric: DriftMetric): Promise<DriftMetric> {
  const { data, error } = await supabase
    .from("drift_metrics")
    .insert({
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

  return {
    id: data.id,
    runId: data.run_id,
    artifactId: data.artifact_id ?? undefined,
    clipZ: data.clip_z ?? undefined,
    e5Z: data.e5_z ?? undefined,
    cohereZ: data.cohere_z ?? undefined,
    fusedZ: data.fused_z ?? undefined,
    clipRaw: data.clip_raw ?? undefined,
    e5Raw: data.e5_raw ?? undefined,
    cohereRaw: data.cohere_raw ?? undefined,
    gateDecision: data.gate_decision ?? undefined,
    createdAt: data.created_at,
  };
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

  return {
    id: data.id,
    clientId: data.client_id,
    runId: data.run_id,
    severity: data.severity,
    message: data.message,
    fusedZ: data.fused_z ?? undefined,
    acknowledged: data.acknowledged,
    createdAt: data.created_at,
  };
}

// ============ Campaign Operations ============

export async function getCampaign(campaignId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to get campaign: ${error.message}`);
  }

  return data;
}
