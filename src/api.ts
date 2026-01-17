const API_BASE = "http://localhost:3001/api";

export type RunMode = "full" | "ingest" | "images" | "video" | "drift" | "export";
export type RunStatus = "pending" | "running" | "needs_review" | "blocked" | "completed" | "failed" | "cancelled";

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

// Create a new run
export async function createRun(clientId: string, mode: RunMode): Promise<Run> {
  const response = await fetch(`${API_BASE}/clients/${clientId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create run: ${response.statusText}`);
  }
  return response.json();
}

// Get run details
export async function getRun(runId: string): Promise<Run> {
  const response = await fetch(`${API_BASE}/runs/${runId}`);
  if (!response.ok) {
    throw new Error(`Failed to get run: ${response.statusText}`);
  }
  return response.json();
}

// Cancel a run
export async function cancelRun(runId: string): Promise<{ success: boolean; message: string }> {
  const response = await fetch(`${API_BASE}/runs/${runId}/cancel`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Failed to cancel run: ${response.statusText}`);
  }
  return response.json();
}

// Approve HITL review
export async function approveReview(runId: string): Promise<Run> {
  const response = await fetch(`${API_BASE}/runs/${runId}/review/approve`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Failed to approve review: ${response.statusText}`);
  }
  return response.json();
}

// Reject HITL review
export async function rejectReview(runId: string, notes: string): Promise<Run> {
  const response = await fetch(`${API_BASE}/runs/${runId}/review/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notes }),
  });
  if (!response.ok) {
    throw new Error(`Failed to reject review: ${response.statusText}`);
  }
  return response.json();
}

// Get artifacts
export async function getArtifacts(runId: string): Promise<Artifact[]> {
  const response = await fetch(`${API_BASE}/runs/${runId}/artifacts`);
  if (!response.ok) {
    throw new Error(`Failed to get artifacts: ${response.statusText}`);
  }
  return response.json();
}

// Export run
export async function exportRun(runId: string): Promise<{ artifacts: Artifact[] }> {
  const response = await fetch(`${API_BASE}/runs/${runId}/export`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Failed to export run: ${response.statusText}`);
  }
  return response.json();
}

// Subscribe to run logs via SSE
export function subscribeToLogs(
  runId: string,
  onLog: (log: RunLog) => void,
  onComplete: (result: { runId: string; status: RunStatus }) => void,
  onError: (error: Error) => void
): () => void {
  const eventSource = new EventSource(`${API_BASE}/runs/${runId}/logs`);

  eventSource.onmessage = (event) => {
    try {
      const log = JSON.parse(event.data) as RunLog;
      onLog(log);
    } catch {
      console.error("Failed to parse log:", event.data);
    }
  };

  eventSource.addEventListener("complete", (event) => {
    try {
      const result = JSON.parse((event as MessageEvent).data);
      onComplete(result);
      eventSource.close();
    } catch {
      console.error("Failed to parse complete event:", (event as MessageEvent).data);
    }
  });

  eventSource.onerror = () => {
    onError(new Error("SSE connection error"));
    eventSource.close();
  };

  // Return cleanup function
  return () => {
    eventSource.close();
  };
}

// Health check
export async function healthCheck(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/health`);
    return response.ok;
  } catch {
    return false;
  }
}
