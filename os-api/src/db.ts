import { supabase } from "./supabase.js";
import type {
  Run, RunLog, Artifact, Client, HitlDecision, DriftMetric, DriftAlert,
  BrandBaseline, PromptTemplate, PromptScore, RunStatus, RunStage,
  Campaign, CampaignDeliverable, DeliverableStatus,
  KnownLimitation, KnownLimitationSeverity,
  AssetEscalation, EscalationLevel, EscalationStatus, EscalationAction,
  OrchestrationDecisionRecord, PromptHistoryEntry,
} from "./types.js";
import { VALID_DELIVERABLE_TRANSITIONS } from "./types.js";

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
      client_id: artifact.clientId ?? null,
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

// ============ Drift DB Row Types ============

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
  const { data, error } = await supabase
    .from("campaign_deliverables")
    .insert({
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

export async function getEscalationByArtifact(artifactId: string): Promise<AssetEscalation | null> {
  const { data, error } = await supabase
    .from("asset_escalations")
    .select("*")
    .eq("artifact_id", artifactId)
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
  artifactId: string;
  deliverableId?: string;
  runId?: string;
  currentLevel?: EscalationLevel;
  status?: EscalationStatus;
  failureClass?: string;
  knownLimitationId?: string;
}): Promise<AssetEscalation> {
  const { data, error } = await supabase
    .from("asset_escalations")
    .insert({
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
  const { data, error } = await supabase
    .from("orchestration_decisions")
    .insert({
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
  return mapOrchestrationDecision(data as DbOrchestrationDecision);
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

export async function getOrchestrationDecisionsByRun(runId: string): Promise<OrchestrationDecisionRecord[]> {
  const { data, error } = await supabase
    .from("orchestration_decisions")
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to get run orchestration decisions: ${error.message}`);
  return (data as DbOrchestrationDecision[]).map(mapOrchestrationDecision);
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
