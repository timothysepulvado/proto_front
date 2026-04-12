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
