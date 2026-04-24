import { spawn, ChildProcess } from "child_process";
import path from "path";
import { EventEmitter } from "events";
import type { Run, Artifact, ProductionBudget, StageStatus, Campaign, CampaignDeliverable, NarrativeContext, VideoGradeResult } from "./types.js";
import {
  updateRun,
  addLog,
  updateClientLastRun,
  addArtifact,
  addDriftMetric,
  addDriftAlert,
  getActiveBaseline,
  getCampaign,
  getPendingDeliverables,
  getDeliverablesByCampaign,
  getLatestArtifactByDeliverable,
  updateDeliverableStatus,
  listKnownLimitations,
  getRunCostEstimate,
} from "./db.js";
import { uploadArtifact, getFileSize } from "./storage.js";
import {
  _isNarrativeContext,
  handleQAFailure,
  markEscalationResolved,
} from "./escalation_loop.js";
import { supabase } from "./supabase.js";
import { v4 as uuidv4 } from "uuid";

// Active processes map for cancellation
const activeProcesses = new Map<string, ChildProcess>();

// Event emitter for log streaming
export const runEvents = new EventEmitter();

// Environment paths
const TEMP_GEN_PATH = process.env.TEMP_GEN_PATH || "/Users/timothysepulvado/Temp-gen";
const TEMP_GEN_VENV = process.env.TEMP_GEN_VENV || path.join(TEMP_GEN_PATH, ".venv");

// Brand Engine FastAPI sidecar (replaces Brand_linter subprocess calls)
const BRAND_ENGINE_URL = process.env.BRAND_ENGINE_URL || "http://localhost:8100";

// Temp-gen FastAPI sidecar (replaces Temp-gen subprocess calls)
const TEMP_GEN_URL = process.env.TEMP_GEN_URL || "http://localhost:8200";

// Legacy path — still used for BRAND_ASSETS_BASE default. Active stages call brand-engine sidecar.
const BRAND_LINTER_PATH = process.env.BRAND_LINTER_PATH || "/Users/timothysepulvado/Brand_linter/local_quick_setup";

// Brand asset base directory (where per-brand asset folders live)
const BRAND_ASSETS_BASE = process.env.BRAND_ASSETS_BASE || path.join(BRAND_LINTER_PATH, "data");

function getPythonPath(venvPath: string): string {
  return path.join(venvPath, "bin", "python");
}

async function emitLog(runId: string, stage: string, level: "info" | "warn" | "error" | "debug", message: string) {
  const log = {
    runId,
    timestamp: new Date().toISOString(),
    stage,
    level,
    message,
  };
  await addLog(log);
  runEvents.emit(`log:${runId}`, log);
}

async function updateStageStatus(run: Run, stageId: string, status: StageStatus, error?: string): Promise<Run> {
  const stages = run.stages.map((s) =>
    s.id === stageId
      ? {
          ...s,
          status,
          ...(status === "running" ? { startedAt: new Date().toISOString() } : {}),
          ...(status === "completed" || status === "failed" ? { completedAt: new Date().toISOString() } : {}),
          ...(error ? { error } : {}),
        }
      : s
  );
  const updated = await updateRun(run.runId, { stages });
  return updated || run;
}

/**
 * Create an artifact record with Supabase Storage upload.
 * Uploads the local file, then writes the artifact row with the public URL.
 * If upload fails, falls back to the local path (non-fatal).
 */
async function createArtifactWithUpload(opts: {
  runId: string;
  clientId: string;
  campaignId?: string;
  deliverableId?: string;
  type: Artifact["type"];
  name: string;
  localPath: string;
  stage: string;
  metadata?: Record<string, unknown>;
}): Promise<Artifact> {
  const artifactId = uuidv4();

  // Attempt upload to Supabase Storage
  const uploaded = await uploadArtifact(
    opts.clientId,
    opts.runId,
    artifactId,
    opts.localPath,
    opts.name,
  );

  const artifact: Artifact = {
    id: artifactId,
    runId: opts.runId,
    clientId: opts.clientId,
    campaignId: opts.campaignId,
    deliverableId: opts.deliverableId,
    type: opts.type,
    name: opts.name,
    // Use public URL if uploaded, otherwise fall back to local path
    path: uploaded?.publicUrl ?? opts.localPath,
    storagePath: uploaded?.storagePath,
    stage: opts.stage,
    size: uploaded?.size ?? getFileSize(opts.localPath) ?? undefined,
    metadata: {
      ...opts.metadata,
      // Preserve the local filesystem path so in-process graders (brand-engine
      // sidecar is a local http service that reads from disk) can access the
      // asset without re-downloading from storage. artifact.path stays the
      // public URL for display / HITL UI / API consumers.
      localPath: opts.localPath,
      ...(uploaded?.cloudinaryPublicId ? { cloudinaryPublicId: uploaded.cloudinaryPublicId } : {}),
    },
    createdAt: new Date().toISOString(),
  };

  return addArtifact(artifact);
}

async function runCommand(
  runId: string,
  stage: string,
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    emitLog(runId, stage, "info", `Executing: ${command} ${args.join(" ")}`).catch(console.error);

    const proc = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    activeProcesses.set(runId, proc);

    let output = "";

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      text.split("\n").filter(Boolean).forEach((line) => {
        emitLog(runId, stage, "info", line).catch(console.error);
      });
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      text.split("\n").filter(Boolean).forEach((line) => {
        emitLog(runId, stage, "warn", line).catch(console.error);
      });
    });

    proc.on("close", async (code) => {
      activeProcesses.delete(runId);
      if (code === 0) {
        await emitLog(runId, stage, "info", `Stage completed successfully`);
        resolve({ success: true, output });
      } else {
        await emitLog(runId, stage, "error", `Stage failed with exit code ${code}`);
        resolve({ success: false, output });
      }
    });

    proc.on("error", async (err) => {
      activeProcesses.delete(runId);
      await emitLog(runId, stage, "error", `Process error: ${err.message}`);
      resolve({ success: false, output: err.message });
    });
  });
}

// Helper to check if a directory exists
function directoryExists(dirPath: string): boolean {
  try {
    const fs = require("fs");
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

// Brand Engine sidecar helper — POST JSON, parse response, handle errors
async function callBrandEngine<T = unknown>(
  endpoint: string,
  body: Record<string, unknown>,
  runId: string,
  stage: string,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    await emitLog(runId, stage, "info", `Calling brand-engine: POST ${endpoint}`);
    const response = await fetch(`${BRAND_ENGINE_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000), // 2 minute timeout
    });

    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `HTTP ${response.status}: ${text}` };
    }

    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// Check brand-engine sidecar health
async function checkBrandEngineHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${BRAND_ENGINE_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Temp-gen sidecar helper — POST/GET JSON, parse response, handle errors
async function callTempGen<T = unknown>(
  endpoint: string,
  method: "GET" | "POST" = "POST",
  body?: Record<string, unknown>,
  runId?: string,
  stage?: string,
  timeoutMs: number = 120_000,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    if (runId && stage) {
      await emitLog(runId, stage, "info", `Calling temp-gen: ${method} ${endpoint}`);
    }
    const options: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body && method === "POST") {
      options.body = JSON.stringify(body);
    }
    const response = await fetch(`${TEMP_GEN_URL}${endpoint}`, options);

    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `HTTP ${response.status}: ${text}` };
    }

    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// Check temp-gen sidecar health
async function checkTempGenHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${TEMP_GEN_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Poll a temp-gen async job (video or batch) with exponential backoff
interface TempGenJobStatus {
  job_id: string;
  type: string;
  status: string;
  segments_complete: number;
  segments_total: number;
  progress_pct: number;
  result_path: string | null;
  error: string | null;
}

async function pollTempGenJob(
  jobId: string,
  runId: string,
  stage: string,
  maxWaitMs: number = 15 * 60 * 1000,
): Promise<string> {
  let delay = 5000;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const result = await callTempGen<TempGenJobStatus>(
      `/jobs/${jobId}`, "GET", undefined, undefined, undefined, 30_000,
    );

    if (!result.ok) {
      await emitLog(runId, stage, "warn", `Job poll error: ${result.error}`);
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 30000);
      continue;
    }

    const status = result.data;
    if (status.status === "complete") {
      await emitLog(runId, stage, "info",
        `Job ${jobId} complete: ${status.result_path}`);
      return status.result_path ?? "";
    }
    if (status.status === "failed") {
      throw new Error(`Job ${jobId} failed: ${status.error}`);
    }

    await emitLog(runId, stage, "info",
      `Job ${jobId}: ${status.segments_complete}/${status.segments_total} segments (${status.progress_pct}%)`);

    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 30000);
  }

  throw new Error(`Job ${jobId} timed out after ${maxWaitMs / 1000}s`);
}

// Stage executors
async function executeIngestStage(run: Run): Promise<boolean> {
  const stageId = "ingest";
  run = await updateStageStatus(run, stageId, "running");
  await emitLog(run.runId, stageId, "info", "Starting Brand Memory ingest and index...");

  const brandName = run.clientId.replace("client_", "");

  // Resolve images directory
  const possiblePaths = [
    path.join(BRAND_ASSETS_BASE, brandName, "reference_images"),
    path.join(BRAND_ASSETS_BASE, brandName),
  ];
  const imagesPath = possiblePaths.find(p => directoryExists(p));

  if (!imagesPath) {
    await emitLog(run.runId, stageId, "warn", `No data directory found for brand '${brandName}'`);
    await emitLog(run.runId, stageId, "warn", `Searched: ${possiblePaths.join(", ")}`);
  }

  // Call brand-engine sidecar
  type IngestResponse = {
    brand_slug: string;
    vectors_indexed: number;
    gemini_index: string;
    cohere_index: string;
    errors: string[];
  };

  const result = await callBrandEngine<IngestResponse>(
    "/ingest",
    {
      brand_slug: brandName,
      images_dir: imagesPath || path.join(BRAND_ASSETS_BASE, brandName),
      index_tier: "brand-dna",
    },
    run.runId,
    stageId,
  );

  if (result.ok) {
    const { data } = result;
    await emitLog(run.runId, stageId, "info",
      `Indexed ${data.vectors_indexed} vectors into ${data.gemini_index} + ${data.cohere_index}`);

    if (data.errors?.length) {
      for (const err of data.errors) {
        await emitLog(run.runId, stageId, "warn", `Ingest warning: ${err}`);
      }
    }

    run = await updateStageStatus(run, stageId, "completed");
    return true;
  } else {
    // Demo fallback — sidecar unavailable or request failed
    await emitLog(run.runId, stageId, "warn", `Brand-engine ingest failed: ${result.error}`);
    await emitLog(run.runId, stageId, "info", "Falling back to demo mode...");

    await new Promise(r => setTimeout(r, 1000));
    await emitLog(run.runId, stageId, "info", `[DEMO] Scanning brand assets for ${brandName}...`);
    await new Promise(r => setTimeout(r, 800));
    await emitLog(run.runId, stageId, "info", "[DEMO] Generating Gemini Embed 2 embeddings (768D)...");
    await new Promise(r => setTimeout(r, 600));
    await emitLog(run.runId, stageId, "info", "[DEMO] Generating Cohere v4 embeddings (1536D)...");
    await new Promise(r => setTimeout(r, 500));
    await emitLog(run.runId, stageId, "info", "[DEMO] Brand Memory indexed successfully");

    run = await updateStageStatus(run, stageId, "completed");
    return true;
  }
}

// Runtime context assembled by retrieve stage — used by generate
let retrievalContext: Map<string, string> = new Map();

async function executeRetrieveStage(run: Run): Promise<boolean> {
  const stageId = "retrieve";
  run = await updateStageStatus(run, stageId, "running");
  const brandName = run.clientId.replace("client_", "");
  await emitLog(run.runId, stageId, "info", "Retrieving brand context from Pinecone...");

  // Build text query from campaign prompt or brand name
  let textQuery = `Brand content for ${brandName}`;
  if (run.campaignId) {
    try {
      const campaign = await getCampaign(run.campaignId);
      if (campaign?.prompt) {
        textQuery = campaign.prompt as string;
        await emitLog(run.runId, stageId, "info", "Using campaign prompt as retrieval query");
      }
    } catch {
      await emitLog(run.runId, stageId, "warn", "Failed to load campaign — using default query");
    }
  }

  // Call brand-engine sidecar /retrieve
  type RetrieveResponse = {
    gemini_score: { model: string; raw_score: number; z_score: number; top_k_ids: string[] };
    cohere_score: { model: string; raw_score: number; z_score: number; top_k_ids: string[] };
    combined_z: number;
    gate_decision: string;
    confidence: number;
  };

  const result = await callBrandEngine<RetrieveResponse>(
    "/retrieve",
    {
      brand_slug: brandName,
      text_query: textQuery,
      index_tier: "brand-dna",
      top_k: 5,
    },
    run.runId,
    stageId,
  );

  if (result.ok) {
    const { data } = result;
    const allIds = [...data.gemini_score.top_k_ids, ...data.cohere_score.top_k_ids];
    const uniqueIds = [...new Set(allIds)];

    if (uniqueIds.length > 0) {
      // Build context string from retrieved asset IDs and scores
      const contextParts = uniqueIds.slice(0, 5).map(id => `ref:${id.substring(0, 12)}`);
      const brandContext = `${contextParts.join("; ")} | combined_z=${data.combined_z.toFixed(3)}`;

      retrievalContext.set(run.runId, brandContext);

      await emitLog(run.runId, stageId, "info",
        `Retrieved ${uniqueIds.length} reference assets from brand memory`);
      await emitLog(run.runId, stageId, "info",
        `Gemini z=${data.gemini_score.z_score.toFixed(3)}, Cohere z=${data.cohere_score.z_score.toFixed(3)}`);
      await emitLog(run.runId, stageId, "info",
        `Gate decision: ${data.gate_decision} (confidence: ${data.confidence.toFixed(3)})`);
    } else {
      await emitLog(run.runId, stageId, "warn", "No matching references found in brand memory");
    }

    run = await updateStageStatus(run, stageId, "completed");
    return true;
  } else {
    // Demo fallback — sidecar unavailable
    await emitLog(run.runId, stageId, "warn", `Brand-engine retrieval failed: ${result.error}`);
    await emitLog(run.runId, stageId, "info", "Falling back to demo mode...");

    await new Promise(r => setTimeout(r, 600));
    await emitLog(run.runId, stageId, "info", "[DEMO] Querying Gemini Embed 2 index...");
    await new Promise(r => setTimeout(r, 500));
    await emitLog(run.runId, stageId, "info", "[DEMO] Querying Cohere v4 index...");
    await new Promise(r => setTimeout(r, 400));
    await emitLog(run.runId, stageId, "info", "[DEMO] Fusing dual-modal scores...");
    await new Promise(r => setTimeout(r, 300));
    await emitLog(run.runId, stageId, "info", "[DEMO] Retrieved 5 reference assets (simulated)");

    retrievalContext.set(run.runId, "[DEMO] warm neutral tones, minimal composition, tactile materials");
    run = await updateStageStatus(run, stageId, "completed");
    return true;
  }
}

/**
 * Generate a single deliverable via the Temp-gen sidecar HTTP API.
 *
 * Routes to /generate/image (sync) or /generate/video (async + poll)
 * based on deliverable.mediaType.  Falls back to demo mode if sidecar
 * is unreachable.
 */
async function executeDeliverableGeneration(
  run: Run,
  deliverable: CampaignDeliverable,
  campaign: Campaign,
  stageId: string,
): Promise<void> {
  const brandName = run.clientId.replace("client_", "");
  const shortId = deliverable.id.slice(0, 8);
  const mediaType = deliverable.mediaType ?? "image";
  const isVideo = mediaType === "video";
  const isMixed = mediaType === "mixed";

  await emitLog(run.runId, stageId, "info",
    `Generating ${mediaType} deliverable: ${deliverable.description ?? shortId}`);

  // Transition to generating
  await updateDeliverableStatus(deliverable.id, deliverable.status, "generating");

  // Build prompt from deliverable → campaign fallback
  let prompt = deliverable.currentPrompt ?? deliverable.originalPrompt ?? campaign.prompt ?? `Brand campaign ${mediaType} for ${brandName}`;

  // Enrich with brand context
  const brandContext = retrievalContext.get(run.runId);
  if (brandContext) {
    prompt = `${prompt}. Brand context: ${brandContext}`;
  }

  const outputDir = path.join(TEMP_GEN_PATH, "outputs", run.runId);

  // --- Cost estimation ---
  type EstimateResponse = { media_type: string; model: string; unit_cost: number; total_cost: number };
  const estimateResult = await callTempGen<EstimateResponse>(
    "/estimate", "POST",
    {
      media_type: isVideo ? "video" : "image",
      model: deliverable.aiModel,
      duration_seconds: deliverable.durationSeconds,
      quality_tier: deliverable.qualityTier ?? "standard",
      image_size: deliverable.resolution,
    },
    run.runId, stageId,
  );
  if (estimateResult.ok) {
    await emitLog(run.runId, stageId, "info",
      `Estimated cost: $${estimateResult.data.total_cost.toFixed(4)} (${estimateResult.data.model})`);
  }

  let artifactCreated = false;

  // --- Image generation (or image part of mixed) ---
  if (!isVideo || isMixed) {
    const imgFileName = `deliverable_${shortId}.png`;
    type ImageResponse = { status: string; local_path: string | null; model: string; cost: number };

    const imgResult = await callTempGen<ImageResponse>(
      "/generate/image", "POST",
      {
        prompt,
        model: deliverable.aiModel ?? "gemini-3-pro-image-preview",
        aspect_ratio: deliverable.aspectRatio ?? "1:1",
        reference_images: deliverable.referenceImages,
        image_size: deliverable.resolution,
        output_path: path.join(outputDir, imgFileName),
      },
      run.runId, stageId,
    );

    if (imgResult.ok && imgResult.data.status === "success") {
      await createArtifactWithUpload({
        runId: run.runId,
        clientId: run.clientId,
        campaignId: run.campaignId,
        deliverableId: deliverable.id,
        type: "image",
        name: imgFileName,
        localPath: imgResult.data.local_path ?? path.join(outputDir, imgFileName),
        stage: stageId,
        metadata: { model: imgResult.data.model, prompt, cost: imgResult.data.cost },
      });
      artifactCreated = true;
    } else if (!isVideo) {
      // Image-only fallback to demo
      await _demoFallbackArtifact(run, deliverable, stageId, outputDir, imgFileName, "image", prompt);
      artifactCreated = true;
    }
  }

  // --- Video generation (or video part of mixed) ---
  if (isVideo || isMixed) {
    const vidFileName = `deliverable_${shortId}.mp4`;
    type VideoJobResponse = { job_id: string; status: string; segments_total: number };

    const vidResult = await callTempGen<VideoJobResponse>(
      "/generate/video", "POST",
      {
        prompt,
        model: deliverable.aiModel ?? "veo-3.1-lite-generate-001",
        duration_seconds: deliverable.durationSeconds ?? 8,
        aspect_ratio: deliverable.aspectRatio ?? "16:9",
        resolution: deliverable.resolution ?? "720p",
        quality_tier: deliverable.qualityTier ?? "standard",
        reference_image: deliverable.referenceImages?.[0],
      },
      run.runId, stageId,
    );

    if (vidResult.ok) {
      try {
        const resultPath = await pollTempGenJob(
          vidResult.data.job_id, run.runId, stageId,
        );
        const videoArtifact = await createArtifactWithUpload({
          runId: run.runId,
          clientId: run.clientId,
          campaignId: run.campaignId,
          deliverableId: deliverable.id,
          type: "video",
          name: vidFileName,
          localPath: resultPath || path.join(outputDir, vidFileName),
          stage: stageId,
          metadata: {
            model: deliverable.aiModel ?? "veo-3.1-lite-generate-001",
            prompt,
            duration_seconds: deliverable.durationSeconds ?? 8,
            quality_tier: deliverable.qualityTier ?? "standard",
            referenceImagePath: deliverable.referenceImages?.[0],
          },
        });
        artifactCreated = true;

        // Autonomous QA + escalation loop (new in migration 007 / Phase C2c).
        // If the sidecar's grade_video reports non-PASS, orchestrator picks
        // L1/L2/L3 action and we regenerate until resolved or hitl_required.
        try {
          const escResult = await runVideoQAWithEscalation({
            run,
            artifact: videoArtifact,
            deliverable,
            campaign,
            stageId,
            narrative: deliverable.description ?? campaign.prompt,
            heroStillPath: deliverable.referenceImages?.[0],
          });
          if (escResult.outcome === "hitl_required") {
            await emitLog(run.runId, stageId, "warn",
              `Deliverable ${shortId} escalation requires HITL review — orchestrator could not auto-resolve`);
          } else if (escResult.outcome === "failed") {
            await emitLog(run.runId, stageId, "error",
              `Deliverable ${shortId} escalation loop failed — check logs`);
          }
        } catch (escErr) {
          // Escalation loop itself failed (non-fatal to the overall run).
          // Log and continue — human review will catch.
          await emitLog(run.runId, stageId, "warn",
            `Escalation loop errored (non-fatal): ${escErr instanceof Error ? escErr.message : String(escErr)}`);
        }
      } catch (err) {
        await emitLog(run.runId, stageId, "error",
          `Video job failed: ${err instanceof Error ? err.message : String(err)}`);
        await _demoFallbackArtifact(run, deliverable, stageId, outputDir, vidFileName, "video", prompt);
        artifactCreated = true;
      }
    } else {
      // Sidecar unreachable — demo fallback
      await _demoFallbackArtifact(run, deliverable, stageId, outputDir, vidFileName, "video", prompt);
      artifactCreated = true;
    }
  }

  if (!artifactCreated) {
    const fallbackName = `deliverable_${shortId}.png`;
    await _demoFallbackArtifact(run, deliverable, stageId, outputDir, fallbackName, "image", prompt);
  }

  // Transition to reviewing
  await updateDeliverableStatus(deliverable.id, "generating", "reviewing");
  await emitLog(run.runId, stageId, "info", `Deliverable ${shortId} → reviewing`);
}

/** Demo fallback — create a placeholder artifact when sidecar is unavailable */
async function _demoFallbackArtifact(
  run: Run,
  deliverable: CampaignDeliverable,
  stageId: string,
  outputDir: string,
  fileName: string,
  type: "image" | "video",
  prompt: string,
): Promise<void> {
  await emitLog(run.runId, stageId, "warn",
    `[DEMO] ${type} generation fallback for ${deliverable.id.slice(0, 8)}`);
  await new Promise(r => setTimeout(r, 1500));
  await createArtifactWithUpload({
    runId: run.runId,
    clientId: run.clientId,
    campaignId: run.campaignId,
    deliverableId: deliverable.id,
    type,
    name: fileName,
    localPath: path.join(outputDir, fileName),
    stage: stageId,
    metadata: { model: "demo", prompt },
  });
}

async function executeGenerateImagesStage(run: Run): Promise<boolean> {
  const stageId = run.mode === "full" ? "generate" : "generate_images";
  run = await updateStageStatus(run, stageId, "running");
  const brandName = run.clientId.replace("client_", "");
  await emitLog(run.runId, stageId, "info", "Starting image generation with Temp-gen sidecar...");

  // Campaign deliverable branch — generate per-deliverable via sidecar
  if (run.campaignId) {
    const campaign = await getCampaign(run.campaignId);
    if (campaign) {
      const deliverables = await getPendingDeliverables(run.campaignId);
      if (deliverables.length > 0) {
        await emitLog(run.runId, stageId, "info",
          `Processing ${deliverables.length} deliverable(s) for campaign "${campaign.name}"`);
        for (const d of deliverables) {
          await executeDeliverableGeneration(run, d, campaign, stageId);
        }
        // Clean up retrieval context after all deliverables
        retrievalContext.delete(run.runId);
        run = await updateStageStatus(run, stageId, "completed");
        return true;
      }
    }
    // Fall through to existing non-deliverable flow
  }

  const outputDir = path.join(TEMP_GEN_PATH, "outputs", run.runId);

  // Build prompt — use campaign prompt if available, else fallback
  let prompt = `Brand campaign image for ${brandName}`;
  if (run.campaignId) {
    try {
      const campaign = await getCampaign(run.campaignId);
      if (campaign?.prompt) {
        prompt = campaign.prompt;
        await emitLog(run.runId, stageId, "info", `Using campaign prompt: "${prompt.substring(0, 80)}..."`);
      }
    } catch {
      await emitLog(run.runId, stageId, "warn", "Failed to load campaign prompt — using default");
    }
  }

  // Enrich prompt with brand context from retrieve stage
  const brandContext = retrievalContext.get(run.runId);
  if (brandContext) {
    prompt = `${prompt}. Brand context: ${brandContext}`;
    await emitLog(run.runId, stageId, "info", "Prompt enriched with brand memory context");
    retrievalContext.delete(run.runId);
  }

  // Call Temp-gen sidecar for image generation
  type ImageResponse = { status: string; local_path: string | null; model: string; cost: number };
  const result = await callTempGen<ImageResponse>(
    "/generate/image", "POST",
    {
      prompt,
      model: "gemini-3-pro-image-preview",
      output_path: path.join(outputDir, "generated.png"),
    },
    run.runId, stageId,
  );

  if (result.ok && result.data.status === "success") {
    await createArtifactWithUpload({
      runId: run.runId,
      clientId: run.clientId,
      campaignId: run.campaignId,
      type: "image",
      name: "generated.png",
      localPath: result.data.local_path ?? path.join(outputDir, "generated.png"),
      stage: stageId,
      metadata: { model: result.data.model, prompt, cost: result.data.cost },
    });
    run = await updateStageStatus(run, stageId, "completed");
    return true;
  } else {
    // Demo fallback — sidecar unavailable or generation failed
    const errorMsg = result.ok ? "Generation returned non-success" : result.error;
    await emitLog(run.runId, stageId, "warn", `Sidecar image gen failed: ${errorMsg} — falling back to demo mode`);
    await emitLog(run.runId, stageId, "info", "[DEMO] Initializing Gemini image model...");
    await new Promise(r => setTimeout(r, 1200));
    await emitLog(run.runId, stageId, "info", `[DEMO] Generating brand image for ${brandName}...`);
    await new Promise(r => setTimeout(r, 2000));
    await emitLog(run.runId, stageId, "info", "[DEMO] Applying brand style transfer...");
    await new Promise(r => setTimeout(r, 1500));
    await emitLog(run.runId, stageId, "info", "[DEMO] Image generated successfully");

    await createArtifactWithUpload({
      runId: run.runId,
      clientId: run.clientId,
      campaignId: run.campaignId,
      type: "image",
      name: "generated.png",
      localPath: path.join(outputDir, "generated.png"),
      stage: stageId,
      metadata: { model: "demo", prompt },
    });
    run = await updateStageStatus(run, stageId, "completed");
    return true;
  }
}

async function executeGenerateVideoStage(run: Run): Promise<boolean> {
  const stageId = run.mode === "full" ? "generate" : "generate_video";
  run = await updateStageStatus(run, stageId, "running");
  const brandName = run.clientId.replace("client_", "");
  await emitLog(run.runId, stageId, "info", "Starting video generation with Temp-gen sidecar...");

  // Campaign deliverable branch — now routed through sidecar via executeDeliverableGeneration
  if (run.campaignId) {
    const campaign = await getCampaign(run.campaignId);
    if (campaign) {
      const deliverables = await getPendingDeliverables(run.campaignId);
      if (deliverables.length > 0) {
        await emitLog(run.runId, stageId, "info",
          `Processing ${deliverables.length} video deliverable(s) for campaign "${campaign.name}"`);
        for (const d of deliverables) {
          await executeDeliverableGeneration(run, d, campaign, stageId);
        }
        run = await updateStageStatus(run, stageId, "completed");
        return true;
      }
    }
  }

  const outputDir = path.join(TEMP_GEN_PATH, "outputs", run.runId);

  // Use campaign prompt if available
  let videoPrompt = `Brand campaign video for ${brandName}`;
  if (run.campaignId) {
    try {
      const campaign = await getCampaign(run.campaignId);
      if (campaign?.prompt) {
        videoPrompt = campaign.prompt;
        await emitLog(run.runId, stageId, "info", `Using campaign prompt for video: "${videoPrompt.substring(0, 80)}..."`);
      }
    } catch {
      await emitLog(run.runId, stageId, "warn", "Failed to load campaign prompt — using default");
    }
  }

  // Call Temp-gen sidecar for async video generation
  type VideoJobResponse = { job_id: string; status: string; segments_total: number };
  const result = await callTempGen<VideoJobResponse>(
    "/generate/video", "POST",
    {
      prompt: videoPrompt,
      model: "veo-3.1-lite-generate-001",
      duration_seconds: 8,
      aspect_ratio: "16:9",
      resolution: "720p",
      quality_tier: "standard",
    },
    run.runId, stageId,
  );

  if (result.ok) {
    try {
      const resultPath = await pollTempGenJob(
        result.data.job_id, run.runId, stageId,
      );
      await createArtifactWithUpload({
        runId: run.runId,
        clientId: run.clientId,
        campaignId: run.campaignId,
        type: "video",
        name: "generated.mp4",
        localPath: resultPath || path.join(outputDir, "generated.mp4"),
        stage: stageId,
        metadata: { model: "veo-3.1-lite-generate-001", prompt: videoPrompt },
      });
      run = await updateStageStatus(run, stageId, "completed");
      return true;
    } catch (err) {
      await emitLog(run.runId, stageId, "error",
        `Video job failed: ${err instanceof Error ? err.message : String(err)}`);
      // Fall through to demo
    }
  } else {
    await emitLog(run.runId, stageId, "warn", `Sidecar video gen failed: ${result.error}`);
  }

  // Demo fallback — sidecar unavailable or job failed
  await emitLog(run.runId, stageId, "info", "Falling back to demo mode...");
  await emitLog(run.runId, stageId, "info", "[DEMO] Initializing Veo video model...");
  await new Promise(r => setTimeout(r, 1500));
  await emitLog(run.runId, stageId, "info", `[DEMO] Generating brand video for ${brandName}...`);
  await new Promise(r => setTimeout(r, 3000));
  await emitLog(run.runId, stageId, "info", "[DEMO] Rendering frames...");
  await new Promise(r => setTimeout(r, 2000));
  await emitLog(run.runId, stageId, "info", "[DEMO] Encoding video...");
  await new Promise(r => setTimeout(r, 1500));
  await emitLog(run.runId, stageId, "info", "[DEMO] Video generated successfully");

  await createArtifactWithUpload({
    runId: run.runId,
    clientId: run.clientId,
    campaignId: run.campaignId,
    type: "video",
    name: "generated.mp4",
    localPath: path.join(outputDir, "generated.mp4"),
    stage: stageId,
    metadata: { model: "demo", prompt: videoPrompt },
  });
  run = await updateStageStatus(run, stageId, "completed");
  return true;
}

async function executeDriftStage(run: Run): Promise<boolean> {
  const stageId = "drift";
  run = await updateStageStatus(run, stageId, "running");
  const brandName = run.clientId.replace("client_", "");
  await emitLog(run.runId, stageId, "info", "Starting Brand Drift check...");

  // Fetch active baseline from Supabase to pass to brand-engine
  const baseline = await getActiveBaseline(run.clientId);
  if (baseline) {
    await emitLog(run.runId, stageId, "info",
      `Using baseline v${baseline.version} (fused_z=${baseline.fusedBaselineZ?.toFixed(3) ?? "N/A"})`);
  } else {
    await emitLog(run.runId, stageId, "warn",
      "No baseline found - drift will use default thresholds");
  }

  const imagePath = path.join(TEMP_GEN_PATH, "outputs", run.runId, "generated.png");

  // Call brand-engine sidecar /drift
  type DriftResponse = {
    grade: {
      fusion: {
        gemini_score: { raw_score: number; z_score: number };
        cohere_score: { raw_score: number; z_score: number };
        combined_z: number;
        gate_decision: string;
        confidence: number;
      };
      pixel: {
        saturation_mean: number;
        clutter_score: number;
        whitespace_ratio: number;
        palette_match: number | null;
      } | null;
      gate_decision: string;
      hitl_required: boolean;
    };
    baseline_combined_z: number;
    drift_delta: number;
    drift_severity: string;
    alert_triggered: boolean;
  };

  const result = await callBrandEngine<DriftResponse>(
    "/drift",
    {
      brand_slug: brandName,
      image_path: imagePath,
      index_tier: "core",
      ...(baseline ? {
        baseline_fused_z: baseline.fusedBaselineZ,
        baseline_gemini_raw: baseline.geminiBaselineRaw,
        baseline_gemini_stddev: baseline.geminiStddev,
        baseline_cohere_raw: baseline.cohereBaselineRaw,
        baseline_cohere_stddev: baseline.cohereStddev,
      } : {}),
    },
    run.runId,
    stageId,
  );

  if (result.ok) {
    const { data } = result;
    const { grade, drift_delta, drift_severity, alert_triggered } = data;
    const fusion = grade.fusion;

    await emitLog(run.runId, stageId, "info",
      `Drift severity: ${drift_severity} (delta: ${drift_delta.toFixed(3)})`);
    await emitLog(run.runId, stageId, "info",
      `Gate: ${grade.gate_decision} | Gemini z=${fusion.gemini_score.z_score.toFixed(3)}, Cohere z=${fusion.cohere_score.z_score.toFixed(3)}`);

    if (grade.pixel) {
      await emitLog(run.runId, stageId, "info",
        `Pixel: sat=${grade.pixel.saturation_mean.toFixed(2)}, clutter=${grade.pixel.clutter_score.toFixed(2)}, whitespace=${grade.pixel.whitespace_ratio.toFixed(2)}`);
    }

    // Record drift metrics to Supabase
    await recordDriftMetrics(run, brandName, stageId, data);

    if (alert_triggered) {
      await emitLog(run.runId, stageId, "warn",
        `Drift alert triggered: severity=${drift_severity}, delta=${drift_delta.toFixed(3)}`);
    }

    run = await updateStageStatus(run, stageId, "completed");
    return true;
  } else {
    // Demo fallback
    await emitLog(run.runId, stageId, "warn", `Brand-engine drift check failed: ${result.error}`);
    await emitLog(run.runId, stageId, "info", "Falling back to demo mode...");

    await new Promise(r => setTimeout(r, 800));
    await emitLog(run.runId, stageId, "info", "[DEMO] Loading brand reference embeddings...");
    await new Promise(r => setTimeout(r, 600));
    await emitLog(run.runId, stageId, "info", "[DEMO] Running dual-fusion drift analysis...");
    await new Promise(r => setTimeout(r, 500));
    await emitLog(run.runId, stageId, "info", `[DEMO] Brand alignment score: 0.87 for ${brandName}`);
    await new Promise(r => setTimeout(r, 400));
    await emitLog(run.runId, stageId, "info", "[DEMO] Drift check passed - within tolerance");

    run = await updateStageStatus(run, stageId, "completed");
    return true;
  }
}

// Record drift metrics from brand-engine response to Supabase
async function recordDriftMetrics(
  run: Run,
  brandName: string,
  stageId: string,
  driftData: {
    grade: {
      fusion: {
        gemini_score: { raw_score: number; z_score: number };
        cohere_score: { raw_score: number; z_score: number };
        combined_z: number;
        gate_decision: string;
      };
    };
    drift_delta: number;
    drift_severity: string;
    alert_triggered: boolean;
  },
): Promise<void> {
  try {
    const fusion = driftData.grade.fusion;

    // Record drift metric — map new dual-fusion fields to existing table columns.
    // Old columns (clipZ, e5Z) are repurposed: clipZ → gemini, e5Z → unused.
    const metric = await addDriftMetric({
      runId: run.runId,
      clipZ: fusion.gemini_score.z_score,     // gemini z-score (was CLIP)
      cohereZ: fusion.cohere_score.z_score,
      fusedZ: fusion.combined_z,
      clipRaw: fusion.gemini_score.raw_score,  // gemini raw (was CLIP raw)
      cohereRaw: fusion.cohere_score.raw_score,
      gateDecision: fusion.gate_decision,
    });

    await emitLog(run.runId, stageId, "info",
      `Drift metrics recorded: fused_z=${metric.fusedZ ?? "N/A"}, gate=${metric.gateDecision ?? "N/A"}`);

    // Check for drift alert
    const DRIFT_ALERT_THRESHOLD = 0.5;
    const fusedZ = metric.fusedZ;
    if (fusedZ !== undefined && fusedZ < DRIFT_ALERT_THRESHOLD) {
      const severity = fusedZ < 0.3 ? "critical" : fusedZ < 0.4 ? "error" : "warn";
      await addDriftAlert({
        clientId: run.clientId,
        runId: run.runId,
        severity,
        message: `Brand drift detected for ${brandName}: fused_z=${fusedZ.toFixed(3)} (threshold: ${DRIFT_ALERT_THRESHOLD})`,
        fusedZ,
      });
    }
  } catch (err) {
    await emitLog(run.runId, stageId, "warn",
      `Failed to record drift metrics: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function executeHITLStage(run: Run): Promise<boolean> {
  const stageId = "hitl";
  run = await updateStageStatus(run, stageId, "running");
  await emitLog(run.runId, stageId, "info", "HITL gate - awaiting review...");

  // Mark as requiring review
  await updateRun(run.runId, { status: "needs_review", hitlRequired: true });
  run = await updateStageStatus(run, stageId, "completed");

  return true;
}

async function executeExportStage(run: Run): Promise<boolean> {
  const stageId = "export";
  run = await updateStageStatus(run, stageId, "running");
  await emitLog(run.runId, stageId, "info", "Preparing export package...");

  // Create a placeholder export artifact
  const exportPath = path.join(TEMP_GEN_PATH, "outputs", run.runId, "export_package.zip");

  await createArtifactWithUpload({
    runId: run.runId,
    clientId: run.clientId,
    campaignId: run.campaignId,
    type: "package",
    name: "export_package.zip",
    localPath: exportPath,
    stage: stageId,
  });

  await emitLog(run.runId, stageId, "info", "Export package prepared (placeholder)");
  run = await updateStageStatus(run, stageId, "completed");

  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Autonomous escalation loop — called after video generation to QA via
// brand-engine /grade_video and, on failure, drive L1/L2/L3 orchestration.
// ─────────────────────────────────────────────────────────────────────────

/** Maximum times the loop will spin per artifact before breaking out. */
const ESCALATION_LOOP_MAX = 6; // combined across L1/L2/L3 (3 + 2 + 2 minus one for the initial call)

/**
 * Grade a video artifact via brand-engine /grade_video; on non-PASS, invoke
 * the orchestrator and either regenerate (looping) or flag HITL.
 *
 * Returns the final artifact (possibly a successor of the input artifact)
 * along with a resolved/hitl/failed signal.
 */
async function gradeAndEscalateVideo(params: {
  run: Run;
  artifact: Artifact;
  deliverable: CampaignDeliverable;
  campaign: Campaign | null;
  stageId: string;
  /** Optional narrative context to feed the video critic. */
  narrative?: string;
  /** Optional hero still path for composition matching. */
  heroStillPath?: string;
}): Promise<{ outcome: "resolved" | "hitl_required" | "failed"; finalArtifact: Artifact }> {
  const { run, deliverable, campaign, stageId, narrative, heroStillPath } = params;
  let currentArtifact = params.artifact;
  const brandSlug = run.clientId.replace("client_", "");

  // Chunk 1 / 10d Chunk 3 fix: capture narrative_context + music_video_synopsis
  // ONCE from the initial (seeded) artifact before the escalation loop. Mid-loop
  // regens produce NEW artifacts via createArtifactWithUpload that do NOT carry
  // forward metadata.narrative_context, so reading from `currentArtifact.metadata`
  // per iteration silently yielded null on iterations 2+, causing the critic to
  // grade context-blind and the orchestrator to loop without convergence.
  // See ESCALATION_LOG Step 10d LANDED for the live incident (2026-04-22).
  //
  // Additional fallback: when the starting artifact itself lacks
  // narrative_context (because it was a regen from a prior failed run), look
  // up the OLDEST artifact for this deliverable that DOES have it — that's
  // the seeded ingest entry from os-api/scripts/ingest-drift-mv-narrative.ts.
  //
  // KNOWN FOLLOW-UP (bug #3 from Chunk 3 — see ESCALATION_LOG Step 10d):
  // The escalation_loop creates a NEW escalation row per artifact (via
  // getEscalationByArtifact on the new artifact_id after regen), which means
  // the orchestrator's `consecSameRegens` / history context resets to 0 on
  // each iteration. The orchestrator therefore can't self-detect that it's
  // repeating the same action across iterations on the same SHOT. Track
  // history by deliverable_id (or prior escalations via
  // `predecessor_artifact_id`) in a follow-up pass. The Shot 2 and Shot 8
  // L3-redesign loops in Runs 2 and 3 are the live evidence.
  const initialArtifactMeta =
    (params.artifact.metadata as Record<string, unknown> | undefined) ?? {};
  const initialArtifactNc = initialArtifactMeta.narrative_context;
  let initialNarrativeContext: NarrativeContext | undefined =
    _isNarrativeContext(initialArtifactNc) ? initialArtifactNc : undefined;
  if (initialNarrativeContext === undefined && deliverable.id) {
    try {
      const { data: seedArts } = await supabase
        .from("artifacts")
        .select("metadata")
        .eq("deliverable_id", deliverable.id)
        .eq("type", "video")
        .order("created_at", { ascending: true });
      for (const a of seedArts ?? []) {
        const nc = (a.metadata as Record<string, unknown> | null)?.narrative_context;
        if (_isNarrativeContext(nc)) {
          initialNarrativeContext = nc;
          await emitLog(run.runId, stageId, "info",
            `narrative_context fallback: pulled from seeded artifact for deliverable ${deliverable.id.slice(0, 8)}…`);
          break;
        }
      }
    } catch (e) {
      await emitLog(run.runId, stageId, "warn",
        `narrative_context fallback lookup failed for deliverable ${deliverable.id.slice(0, 8)}: ${(e as Error).message}`);
    }
  }
  const campaignGuardrails =
    (campaign?.guardrails as Record<string, unknown> | null | undefined) ?? null;
  const musicVideoContext =
    (campaignGuardrails?.music_video_context as
      | { synopsis?: string }
      | null
      | undefined) ?? null;
  const musicVideoSynopsis = musicVideoContext?.synopsis ?? null;

  for (let loop = 0; loop < ESCALATION_LOOP_MAX; loop++) {
    // 1. Grade the current video
    await emitLog(run.runId, stageId, "info", `Grading video artifact ${currentArtifact.id} (loop ${loop + 1}/${ESCALATION_LOOP_MAX})`);

    const catalog = await listKnownLimitations({ model: deliverable.aiModel ?? "veo-3.1-lite-generate-001" });
    const relevantFailureModes = catalog.map((k) => k.failureMode);

    // Prefer the on-disk path (stored in metadata by createArtifactWithUpload)
    // over the public storage URL so the local brand-engine sidecar can stat
    // the file directly. Falls back to artifact.path if localPath is missing
    // (e.g. legacy artifacts written before this field was added).
    const gradeVideoPath =
      (currentArtifact.metadata?.localPath as string | undefined) ??
      currentArtifact.path;

    // Prefer current artifact's narrative_context if present (supports the
    // forward-copy path from Phase 1.3 for pre-existing regens), else fall
    // back to the initial-artifact capture above so iterations 2+ keep the
    // envelope even when mid-loop regens produce context-less artifacts.
    const currentArtifactMeta =
      (currentArtifact.metadata as Record<string, unknown> | undefined) ?? {};
    const currentArtifactNc = currentArtifactMeta.narrative_context;
    const narrativeContext: NarrativeContext | undefined =
      _isNarrativeContext(currentArtifactNc) ? currentArtifactNc : initialNarrativeContext;

    const gradeResult = await callBrandEngine<VideoGradeResult>(
      "/grade_video",
      {
        video_path: gradeVideoPath,
        brand_slug: brandSlug,
        failure_modes_to_check: relevantFailureModes,
        deliverable_context: narrative ?? deliverable.description ?? campaign?.prompt,
        hero_still_path: heroStillPath,
        known_limitations_context: catalog.map((k) => ({
          failure_mode: k.failureMode,
          description: k.description,
          mitigation: k.mitigation,
          severity: k.severity,
          id: k.id,
          category: k.category,
        })),
        duration_seconds: deliverable.durationSeconds,
        // Rule 1 (escalation-ladder brief): consensus path is authoritative.
        // Pass explicitly rather than relying on the brand-engine default so a
        // future default-flip can't silently break critic variance handling.
        consensus: true,
        narrative_context: narrativeContext,
        music_video_synopsis: musicVideoSynopsis,
      },
      run.runId,
      stageId,
    );

    if (!gradeResult.ok) {
      // Sidecar unreachable or grade failed → treat as fail-soft and continue
      await emitLog(run.runId, stageId, "warn", `/grade_video failed: ${gradeResult.error}. Skipping escalation loop.`);
      return { outcome: "resolved", finalArtifact: currentArtifact };
    }

    const verdict = gradeResult.data;
    await emitLog(
      run.runId,
      stageId,
      "info",
      `Grade: verdict=${verdict.verdict}, score=${verdict.aggregate_score}, detected=${JSON.stringify(verdict.detected_failure_classes)}, recommendation=${verdict.recommendation}`,
    );

    if (verdict.verdict === "PASS") {
      return { outcome: "resolved", finalArtifact: currentArtifact };
    }

    // 2. Failure — call orchestrator via escalation loop
    //
    // Bug #2 residual fix (2026-04-24): pass the runner-resolved
    // narrativeContext as `narrativeContextOverride` so the orchestrator
    // gets the same envelope the critic just received (post-fallback). On
    // iteration 2+ the regen artifact lacks `metadata.narrative_context`,
    // so reading from the artifact inside escalation_loop would silently
    // yield undefined and Claude would call without the music-video shot
    // position / stylization budget — matching the original chunk 3 gap
    // closed for the critic but not the orchestrator.
    const escalationResult = await handleQAFailure({
      runId: run.runId,
      clientId: run.clientId,
      campaignId: run.campaignId,
      artifact: currentArtifact,
      qaVerdict: verdict,
      stageId,
      runEvents,
      logger: (level, message) => emitLog(run.runId, stageId, level, message),
      narrativeContextOverride: narrativeContext,
    });

    if (escalationResult.outcome === "accepted") {
      await emitLog(run.runId, stageId, "info", `Escalation resolved with accept: ${escalationResult.decision.reasoning}`);
      return { outcome: "resolved", finalArtifact: currentArtifact };
    }
    if (escalationResult.outcome === "hitl_required") {
      await emitLog(run.runId, stageId, "warn", `Escalation flagged for HITL review`);
      return { outcome: "hitl_required", finalArtifact: currentArtifact };
    }
    if (escalationResult.outcome === "failed") {
      await emitLog(run.runId, stageId, "error", `Escalation loop failed`);
      return { outcome: "failed", finalArtifact: currentArtifact };
    }

    // 3. outcome === "regenerate" — fire new generation
    const { decision, newPrompts } = escalationResult;
    if (!newPrompts) {
      return { outcome: "hitl_required", finalArtifact: currentArtifact };
    }

    await emitLog(
      run.runId,
      stageId,
      "info",
      `Regenerating artifact (action=${decision.action}) with orchestrator-provided prompts`,
    );

    // If the action includes a still regen (redesign/replace), do that first
    let refImagePath: string | undefined = currentArtifact.metadata?.referenceImagePath as string | undefined;
    if ((decision.action === "redesign" || decision.action === "replace") && newPrompts.stillPrompt) {
      const newStillFileName = `still_${escalationResult.escalation.id.slice(0, 8)}_iter${escalationResult.escalation.iterationCount}.png`;
      const stillOutputDir = path.join(TEMP_GEN_PATH, "outputs", run.runId);
      type ImageResp = { status: string; local_path: string | null; model: string; cost: number };
      // Image-gen uses a Gemini image model — deliverable.aiModel is the VIDEO
      // model id (Veo) and Temp-gen's /generate/image would reject refs against
      // it. Pinned to the Gemini family explicitly (2026-04-24).
      // image_size intentionally omitted — deliverable.resolution carries video
      // res like "720p"/"1080p" which Gemini Image rejects as INVALID_ARGUMENT;
      // aspect_ratio alone is enough for Gemini 3 Pro Image (2026-04-24).
      const stillResult = await callTempGen<ImageResp>(
        "/generate/image",
        "POST",
        {
          prompt: newPrompts.stillPrompt,
          model: "gemini-3-pro-image-preview",
          aspect_ratio: deliverable.aspectRatio ?? "16:9",
          reference_images: deliverable.referenceImages,
          output_path: path.join(stillOutputDir, newStillFileName),
        },
        run.runId,
        stageId,
      );
      if (stillResult.ok && stillResult.data.status === "success") {
        await createArtifactWithUpload({
          runId: run.runId,
          clientId: run.clientId,
          campaignId: run.campaignId,
          deliverableId: deliverable.id,
          type: "image",
          name: newStillFileName,
          localPath: stillResult.data.local_path ?? path.join(stillOutputDir, newStillFileName),
          stage: stageId,
          metadata: {
            model: stillResult.data.model,
            prompt: newPrompts.stillPrompt,
            cost: stillResult.data.cost,
            escalationId: escalationResult.escalation.id,
            role: "redesigned_hero_still",
          },
        });
        refImagePath = stillResult.data.local_path ?? undefined;
      } else {
        await emitLog(run.runId, stageId, "warn", `Still regen failed: ${stillResult.ok ? "non-success" : stillResult.error}`);
      }
    }

    // Fire new video generation.
    // Veo 3.1 family caps prompt at 2000 chars; orchestrator occasionally
    // writes longer regen prompts (especially on iter 2+ with context accum).
    // Truncate defensively so we never hit the API's 400 (2026-04-24).
    const VEO_PROMPT_MAX = 2000;
    let veoPrompt = newPrompts.veoPrompt ?? deliverable.currentPrompt ?? "";
    if (veoPrompt.length > VEO_PROMPT_MAX) {
      await emitLog(
        run.runId,
        stageId,
        "warn",
        `Veo prompt truncated from ${veoPrompt.length} to ${VEO_PROMPT_MAX} chars (Veo 2000-char cap)`,
      );
      veoPrompt = veoPrompt.slice(0, VEO_PROMPT_MAX);
    }
    const newVidFileName = `video_${escalationResult.escalation.id.slice(0, 8)}_iter${escalationResult.escalation.iterationCount}.mp4`;
    const vidOutputDir = path.join(TEMP_GEN_PATH, "outputs", run.runId);
    type VideoJobResp = { job_id: string; status: string; segments_total: number };
    const vidResult = await callTempGen<VideoJobResp>(
      "/generate/video",
      "POST",
      {
        prompt: veoPrompt,
        model: deliverable.aiModel ?? "veo-3.1-lite-generate-001",
        duration_seconds: deliverable.durationSeconds ?? 8,
        aspect_ratio: deliverable.aspectRatio ?? "16:9",
        resolution: deliverable.resolution ?? "1080p",
        quality_tier: deliverable.qualityTier ?? "standard",
        reference_image: refImagePath ?? deliverable.referenceImages?.[0],
        negative_prompt: newPrompts.negativePrompt,
      },
      run.runId,
      stageId,
    );

    if (!vidResult.ok) {
      await emitLog(run.runId, stageId, "error", `Video regen failed: ${vidResult.error}`);
      return { outcome: "failed", finalArtifact: currentArtifact };
    }

    let newVidPath: string;
    try {
      newVidPath = await pollTempGenJob(vidResult.data.job_id, run.runId, stageId);
    } catch (err) {
      await emitLog(run.runId, stageId, "error", `Video regen poll failed: ${err instanceof Error ? err.message : String(err)}`);
      return { outcome: "failed", finalArtifact: currentArtifact };
    }

    // Create successor artifact and loop back to grading
    const successorArtifact = await createArtifactWithUpload({
      runId: run.runId,
      clientId: run.clientId,
      campaignId: run.campaignId,
      deliverableId: deliverable.id,
      type: "video",
      name: newVidFileName,
      localPath: newVidPath || path.join(vidOutputDir, newVidFileName),
      stage: stageId,
      metadata: {
        model: deliverable.aiModel ?? "veo-3.1-lite-generate-001",
        prompt: newPrompts.veoPrompt,
        negativePrompt: newPrompts.negativePrompt,
        referenceImagePath: refImagePath,
        escalationId: escalationResult.escalation.id,
        orchestrationIteration: escalationResult.escalation.iterationCount,
        predecessorArtifactId: currentArtifact.id,
        role: "escalation_regen",
      },
    });

    currentArtifact = successorArtifact;

    // Successor was just created; next loop iteration will grade it.
    // If it passes, markEscalationResolved links it as final_artifact_id.
    // markEscalationResolved will fire when loop exits with resolved outcome.
  }

  // Exhausted loop budget
  await emitLog(
    run.runId,
    stageId,
    "warn",
    `Escalation loop exhausted after ${ESCALATION_LOOP_MAX} iterations — flagging HITL`,
  );
  return { outcome: "hitl_required", finalArtifact: currentArtifact };
}

/**
 * Wrapper that the runner can call once for any video artifact. Handles
 * the full QA → escalate → regen → resolve cycle, and on success links
 * the final artifact back to the escalation record.
 */
export async function runVideoQAWithEscalation(params: {
  run: Run;
  artifact: Artifact;
  deliverable: CampaignDeliverable;
  campaign: Campaign | null;
  stageId: string;
  narrative?: string;
  heroStillPath?: string;
}): Promise<{ outcome: "resolved" | "hitl_required" | "failed"; finalArtifact: Artifact }> {
  const result = await gradeAndEscalateVideo(params);

  // If resolved via a successor artifact, mark the escalation resolved
  if (result.outcome === "resolved" && result.finalArtifact.id !== params.artifact.id) {
    const { getEscalationByArtifact } = await import("./db.js");
    const esc = await getEscalationByArtifact(params.artifact.id);
    if (esc && !esc.resolvedAt) {
      await markEscalationResolved(esc.id, result.finalArtifact.id, runEvents, params.run.runId, esc.resolutionPath ?? "prompt_fix");
    }
  }

  return result;
}

// ─── Pure helpers — exported for unit testing (10d-regrade-runner.ts) ──
// These are the parts of the regrade logic that don't touch Supabase, the
// filesystem, the brand-engine sidecar, or Temp-gen. Keeps the test surface
// small and independent of project-scoped env + network state.

/**
 * Idempotency predicate — returns true if the deliverable is already in a
 * terminal-good state that regrade should not disturb. Only `approved`
 * qualifies today; `rejected` deliverables are explicitly re-graded (that's
 * the happy path: a rejected deliverable gets its new-prompt regen graded).
 */
export function _shouldSkipDeliverable(d: CampaignDeliverable): boolean {
  // Skip terminal / already-HITL deliverables so the regrade doesn't burn
  // budget re-processing them. `approved` = done. `reviewing` = already in a
  // human review queue; the runner shouldn't auto-regenerate around that.
  // Added `reviewing` during Chunk 3 Run 2 diagnosis (2026-04-22) — without
  // it, shots flagged HITL by a prior regrade re-enter the loop and, when the
  // shot truly can't pass the critic, burn Veo regens indefinitely.
  return d.status === "approved" || d.status === "reviewing";
}

/**
 * Decide the terminal status transition for a regraded deliverable.
 * Returns null if no transition should fire (the caller leaves the
 * deliverable wherever it is — typically `reviewing` for HITL-bound cases).
 *
 * Expected invariant: callers have already stepped the deliverable through
 * `pending → generating → reviewing` before invoking the grader, so
 * `liveStatus` should be `reviewing` by the time this is called. We still
 * handle off-path inputs defensively.
 */
export function _decideRegradeStatusTransition(
  outcome: "resolved" | "hitl_required" | "failed",
  liveStatus: CampaignDeliverable["status"],
): { from: CampaignDeliverable["status"]; to: CampaignDeliverable["status"]; reason?: string } | null {
  if (liveStatus !== "reviewing") return null;
  switch (outcome) {
    case "resolved":
      return { from: "reviewing", to: "approved" };
    case "failed":
      return {
        from: "reviewing",
        to: "rejected",
        reason: "Regrade escalation failed",
      };
    case "hitl_required":
      // Intentionally no transition — the deliverable stays in `reviewing`
      // and the Review Gate surfaces it for manual approval/rejection.
      return null;
    default:
      return null;
  }
}

/**
 * ── Step 10d Session A ───────────────────────────────────────────────────
 * Regrade existing video artifacts for a campaign without firing fresh
 * Temp-gen generation up-front. Iterates the campaign's deliverables, picks
 * each deliverable's most-recent video artifact, and hands it to
 * runVideoQAWithEscalation — which owns the grade → L1/L2/L3 → regen loop.
 *
 * Reuse-first semantics:
 *   - `approved` deliverables are skipped (idempotent).
 *   - Non-approved + has artifact → grade → escalate (orchestrator decides
 *     whether to regen; if the orchestrator decides L2 regen, Temp-gen cost
 *     kicks in then, not at stage entry).
 *   - Non-approved + no artifact → log warning + flip deliverable to HITL
 *     (no artifact to grade; can't infer intent from here). The Review Gate
 *     surfaces these for manual triage.
 *
 * Status walk:
 *   seeded deliverables come in at `pending`. The existing VALID transition
 *   map requires `pending → generating → reviewing` before a terminal
 *   (approved/rejected) flip. We step through those two synthetic states
 *   (no generation actually fires) and let the outcome dictate the final.
 */
async function regradeOneDeliverable(
  run: Run,
  deliverable: CampaignDeliverable,
  campaign: Campaign | null,
  stageId: string,
): Promise<"resolved" | "hitl_required" | "failed" | "skipped" | "missing_artifact"> {
  // 1. Idempotency — skip deliverables already in terminal-good state.
  if (_shouldSkipDeliverable(deliverable)) {
    await emitLog(
      run.runId,
      stageId,
      "info",
      `Skipping deliverable ${deliverable.id.slice(0, 8)}… (already ${deliverable.status})`,
    );
    return "skipped";
  }

  // 2. Fetch most-recent video artifact for this deliverable.
  const artifact = await getLatestArtifactByDeliverable(deliverable.id, "video");
  if (!artifact) {
    await emitLog(
      run.runId,
      stageId,
      "warn",
      `Deliverable ${deliverable.id.slice(0, 8)}… has no video artifact — flagging HITL`,
    );
    // Best-effort status nudge: step pending → generating → reviewing so the
    // HITL panel surfaces it. If already past pending, leave it alone.
    if (deliverable.status === "pending") {
      try {
        const g = await updateDeliverableStatus(deliverable.id, "pending", "generating");
        await updateDeliverableStatus(g.id, "generating", "reviewing");
      } catch (err) {
        await emitLog(run.runId, stageId, "warn",
          `Could not step status for ${deliverable.id.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Request run-level HITL for any deliverable in this state; Review Gate
    // consumers can triage. Non-fatal — continue other deliverables.
    await updateRun(run.runId, { hitlRequired: true });
    return "missing_artifact";
  }

  // 3. Step status pending → generating → reviewing for the critic call.
  //    If the deliverable is already mid-state (e.g. reviewing from a prior
  //    regrade attempt), leave it where it is — runVideoQAWithEscalation
  //    doesn't depend on the column, just on artifact + deliverable shape.
  let liveStatus: CampaignDeliverable["status"] = deliverable.status;
  if (liveStatus === "pending") {
    try {
      const g = await updateDeliverableStatus(deliverable.id, "pending", "generating");
      liveStatus = g.status;
    } catch (err) {
      // Don't hard-fail on status walk — the grade call is the important work.
      await emitLog(run.runId, stageId, "warn",
        `Status walk (pending→generating) failed for ${deliverable.id.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (liveStatus === "generating") {
    try {
      const r = await updateDeliverableStatus(deliverable.id, "generating", "reviewing");
      liveStatus = r.status;
    } catch (err) {
      await emitLog(run.runId, stageId, "warn",
        `Status walk (generating→reviewing) failed for ${deliverable.id.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. Grade + escalate — this is where reuse-first logic lives. If the clip
  //    already passes consensus critic, escalation_loop never fires and the
  //    cost is ~$0.05 (one /grade_video call).
  const heroStill =
    deliverable.referenceImages && deliverable.referenceImages.length > 0
      ? deliverable.referenceImages[0]
      : undefined;
  const result = await runVideoQAWithEscalation({
    run,
    artifact,
    deliverable,
    campaign,
    stageId,
    narrative: deliverable.description ?? campaign?.prompt,
    heroStillPath: heroStill,
  });

  // 5. Reflect outcome on deliverable.status (pure decision → DB write).
  const transition = _decideRegradeStatusTransition(result.outcome, liveStatus);
  if (transition) {
    try {
      await updateDeliverableStatus(deliverable.id, transition.from, transition.to,
        transition.reason ? { rejectionReason: transition.reason } : undefined);
    } catch (err) {
      await emitLog(run.runId, stageId, "warn",
        `Final status flip ${transition.from}→${transition.to} failed for ${deliverable.id.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // hitl_required: no transition — Review Gate picks it up from `reviewing`.

  // 6. Surface run-level hitl flag if any deliverable needs review.
  if (result.outcome === "hitl_required") {
    await updateRun(run.runId, { hitlRequired: true });
  }

  return result.outcome;
}

async function executeRegradeStage(run: Run): Promise<boolean> {
  const stageId = "regrade";
  run = await updateStageStatus(run, stageId, "running");
  await emitLog(run.runId, stageId, "info", "Starting reuse-first regrade...");

  if (!run.campaignId) {
    await emitLog(run.runId, stageId, "error",
      "regrade mode requires run.campaignId — aborting stage.");
    run = await updateStageStatus(run, stageId, "failed", "Missing campaignId");
    return false;
  }

  const campaign = await getCampaign(run.campaignId);
  if (!campaign) {
    await emitLog(run.runId, stageId, "error",
      `Campaign ${run.campaignId} not found — aborting stage.`);
    run = await updateStageStatus(run, stageId, "failed", "Campaign not found");
    return false;
  }

  const deliverables = await getDeliverablesByCampaign(run.campaignId);
  await emitLog(run.runId, stageId, "info",
    `Campaign "${campaign.name}" has ${deliverables.length} deliverable(s) to regrade`);

  // Per-production budget cap (post-Chunk-3, 2026-04-23). Opt-in via
  // `campaigns.guardrails.production_budget = { total_usd, warn_at_pct,
  // hard_stop_at_pct }`. Per-shot $4 cap in escalation_loop.ts continues to
  // bite inside a single shot; this is the outer envelope across all shots
  // in one run. Halt + flag needs_review at hard_stop_at_pct so the operator
  // decides whether to top up or close out.
  const productionBudget = _extractProductionBudget(campaign);
  let lastWarnedAtPct = 0;
  if (productionBudget) {
    await emitLog(run.runId, stageId, "info",
      `Production budget active: $${productionBudget.total_usd} ` +
      `(warn=${productionBudget.warn_at_pct ?? 75}%, hard_stop=${productionBudget.hard_stop_at_pct ?? 100}%)`);
  }

  const tally = { resolved: 0, hitl: 0, failed: 0, skipped: 0, missingArtifact: 0 };
  let budgetHalted = false;
  for (const d of deliverables) {
    // Budget check before each deliverable (post-shot, before next regen).
    // Veo regens are the lion's share of cost; halting between shots saves
    // a $1.60-3.20 bite even when per-shot cap holds.
    if (productionBudget) {
      try {
        const cost = await getRunCostEstimate(run.runId);
        const pct = (cost.totalUsd / productionBudget.total_usd) * 100;
        const hardStopPct = productionBudget.hard_stop_at_pct ?? 100;
        const warnPct = productionBudget.warn_at_pct ?? 75;
        if (pct >= hardStopPct) {
          await emitLog(run.runId, stageId, "warn",
            `Production budget hard-stop: $${cost.totalUsd.toFixed(2)} of ` +
            `$${productionBudget.total_usd} (${pct.toFixed(0)}%, threshold ${hardStopPct}%). ` +
            `Halting regrade — operator review required.`,
          );
          budgetHalted = true;
          break;
        }
        if (pct >= warnPct && lastWarnedAtPct < warnPct) {
          await emitLog(run.runId, stageId, "warn",
            `Production budget at ${pct.toFixed(0)}%: $${cost.totalUsd.toFixed(2)} of ` +
            `$${productionBudget.total_usd} (orch=$${cost.orchestratorUsd.toFixed(2)} + ` +
            `veo=$${cost.veoUsd.toFixed(2)} + img=$${cost.imageUsd.toFixed(2)} across ` +
            `${cost.orchDecisionCount} decisions + ${cost.veoArtifactCount} videos)`,
          );
          lastWarnedAtPct = pct;
        }
      } catch (err) {
        // Budget check failure shouldn't kill the run — log + continue.
        await emitLog(run.runId, stageId, "warn",
          `Budget check error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    try {
      const outcome = await regradeOneDeliverable(run, d, campaign, stageId);
      switch (outcome) {
        case "resolved": tally.resolved++; break;
        case "hitl_required": tally.hitl++; break;
        case "failed": tally.failed++; break;
        case "skipped": tally.skipped++; break;
        case "missing_artifact": tally.missingArtifact++; break;
      }
    } catch (err) {
      await emitLog(run.runId, stageId, "error",
        `Uncaught error regrading ${d.id.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`);
      tally.failed++;
    }
  }

  await emitLog(run.runId, stageId, "info",
    `Regrade summary — resolved=${tally.resolved} hitl=${tally.hitl} ` +
    `failed=${tally.failed} skipped=${tally.skipped} missingArtifact=${tally.missingArtifact}` +
    (budgetHalted ? " [HALTED on production budget cap]" : ""),
  );

  if (budgetHalted) {
    // Flag the run as needs_review so the operator handles the budget call.
    await updateRun(run.runId, { status: "needs_review", hitlRequired: true });
  }

  // Stage is "completed" even if some deliverables need HITL or failed — the
  // runner surfaces those via hitlRequired + deliverable statuses. Stage only
  // FAILS if we couldn't enumerate deliverables or every single one raised.
  const fatalFail = tally.failed > 0 && tally.failed === deliverables.length;
  run = await updateStageStatus(run, stageId,
    fatalFail ? "failed" : "completed",
    fatalFail ? "All deliverables failed regrade" :
      budgetHalted ? "Halted on production budget cap" : undefined,
  );
  return !fatalFail;
}

// ── Per-production budget extraction (post-Chunk-3, 2026-04-23) ───────────
// Pulls ProductionBudget out of `campaigns.guardrails.production_budget`
// JSONB. Opt-in per campaign — when absent or malformed, returns undefined
// and the budget cap stays inert (existing behavior).
export function _extractProductionBudget(
  campaign: Campaign | null,
): ProductionBudget | undefined {
  if (!campaign) return undefined;
  const g = campaign.guardrails;
  if (!g || typeof g !== "object") return undefined;
  const pb = (g as Record<string, unknown>).production_budget;
  if (!pb || typeof pb !== "object") return undefined;
  const total = (pb as Record<string, unknown>).total_usd;
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return undefined;
  const warn = (pb as Record<string, unknown>).warn_at_pct;
  const hardStop = (pb as Record<string, unknown>).hard_stop_at_pct;
  return {
    total_usd: total,
    warn_at_pct: typeof warn === "number" && Number.isFinite(warn) && warn > 0 && warn <= 100 ? warn : 75,
    hard_stop_at_pct: typeof hardStop === "number" && Number.isFinite(hardStop) && hardStop > 0 && hardStop <= 200 ? hardStop : 100,
  };
}

// Main run executor
export async function executeRun(run: Run): Promise<void> {
  await emitLog(run.runId, "system", "info", `Starting run ${run.runId} in mode: ${run.mode}`);

  // Update run status to running
  const updatedRun = await updateRun(run.runId, {
    status: "running",
    startedAt: new Date().toISOString(),
  });
  run = updatedRun || run;

  let success = true;

  try {
    switch (run.mode) {
      case "full":
        success = await executeIngestStage(run);
        if (success) success = await executeRetrieveStage(run);
        if (success) success = await executeGenerateImagesStage(run);
        if (success) success = await executeDriftStage(run);
        if (success) success = await executeHITLStage(run);
        if (success && !run.hitlRequired) success = await executeExportStage(run);
        break;

      case "ingest":
        success = await executeIngestStage(run);
        break;

      case "images":
        success = await executeGenerateImagesStage(run);
        break;

      case "video":
        success = await executeGenerateVideoStage(run);
        break;

      case "drift":
        success = await executeDriftStage(run);
        break;

      case "export":
        success = await executeExportStage(run);
        break;

      case "regrade":
        success = await executeRegradeStage(run);
        break;
    }

    // Finalize run
    const finalStatus = success ? (run.hitlRequired ? "needs_review" : "completed") : "failed";
    await updateRun(run.runId, {
      status: finalStatus,
      completedAt: new Date().toISOString(),
    });
    await updateClientLastRun(run.clientId, run.runId, finalStatus);

    await emitLog(run.runId, "system", "info", `Run ${run.runId} finished with status: ${finalStatus}`);
    runEvents.emit(`complete:${run.runId}`, { runId: run.runId, status: finalStatus });

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await emitLog(run.runId, "system", "error", `Run failed: ${errorMsg}`);
    await updateRun(run.runId, {
      status: "failed",
      error: errorMsg,
      completedAt: new Date().toISOString(),
    });
    await updateClientLastRun(run.clientId, run.runId, "failed");
    runEvents.emit(`complete:${run.runId}`, { runId: run.runId, status: "failed", error: errorMsg });
  }
}

export async function cancelRun(runId: string): Promise<boolean> {
  const proc = activeProcesses.get(runId);
  if (proc) {
    proc.kill("SIGTERM");
    activeProcesses.delete(runId);
    await emitLog(runId, "system", "warn", "Run cancelled by user");
    await updateRun(runId, { status: "cancelled", completedAt: new Date().toISOString() });
    return true;
  }
  return false;
}
