import { supabase } from "./lib/supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

export type RunMode = "full" | "ingest" | "images" | "video" | "drift" | "export";
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
  type: "image" | "video" | "report" | "package";
  name: string;
  path: string;
  size?: number;
  createdAt: string;
}

export interface Client {
  id: string;
  name: string;
  status: ClientStatus;
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

// Health check
export async function healthCheck(): Promise<boolean> {
  try {
    const { error } = await supabase.from("clients").select("id").limit(1);
    return !error;
  } catch {
    return false;
  }
}
