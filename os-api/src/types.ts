export type RunMode = "full" | "ingest" | "images" | "video" | "drift" | "export";

export type RunStatus = "pending" | "running" | "needs_review" | "blocked" | "completed" | "failed" | "cancelled";

export type StageStatus = "pending" | "running" | "completed" | "failed" | "skipped";

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
  type: "image" | "video" | "report" | "package";
  name: string;
  path: string;
  size?: number;
  createdAt: string;
}

export interface ReviewPayload {
  notes?: string;
}

export interface RunCreatePayload {
  mode: RunMode;
  inputs?: Record<string, unknown>;
}

// Stage definitions for each mode
export const STAGE_DEFINITIONS: Record<RunMode, { id: string; name: string }[]> = {
  full: [
    { id: "ingest", name: "Ingest and Index" },
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
