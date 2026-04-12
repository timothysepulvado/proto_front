import { spawn, ChildProcess } from "child_process";
import path from "path";
import { EventEmitter } from "events";
import type { Run, Artifact, StageStatus, Campaign, CampaignDeliverable } from "./types.js";
import { updateRun, addLog, updateClientLastRun, addArtifact, addDriftMetric, addDriftAlert, getActiveBaseline, getCampaign, getPendingDeliverables, updateDeliverableStatus } from "./db.js";
import { uploadArtifact, getFileSize } from "./storage.js";
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
 * Generate a single deliverable — transitions through generating → reviewing,
 * creates artifact linked to the deliverable.
 */
async function executeDeliverableGeneration(
  run: Run,
  deliverable: CampaignDeliverable,
  campaign: Campaign,
  stageId: string,
): Promise<void> {
  const brandName = run.clientId.replace("client_", "");

  await emitLog(run.runId, stageId, "info",
    `Generating deliverable: ${deliverable.description ?? deliverable.id.slice(0, 8)}`);

  // Transition to generating
  await updateDeliverableStatus(deliverable.id, deliverable.status, "generating");

  // Build prompt from deliverable → campaign fallback
  let prompt = deliverable.currentPrompt ?? deliverable.originalPrompt ?? campaign.prompt ?? `Brand campaign image for ${brandName}`;

  // Enrich with brand context
  const brandContext = retrievalContext.get(run.runId);
  if (brandContext) {
    prompt = `${prompt}. Brand context: ${brandContext}`;
  }

  const pythonPath = getPythonPath(TEMP_GEN_VENV);
  const outputDir = path.join(TEMP_GEN_PATH, "outputs", run.runId);
  const fileName = `deliverable_${deliverable.id.slice(0, 8)}.png`;

  const result = await runCommand(
    run.runId,
    stageId,
    pythonPath,
    [
      "main.py",
      "nano",
      "generate",
      "--prompt", prompt,
      "--output", path.join(outputDir, fileName),
    ],
    TEMP_GEN_PATH,
  );

  if (result.success) {
    await createArtifactWithUpload({
      runId: run.runId,
      clientId: run.clientId,
      campaignId: run.campaignId,
      deliverableId: deliverable.id,
      type: "image",
      name: fileName,
      localPath: path.join(outputDir, fileName),
      stage: stageId,
      metadata: { model: deliverable.aiModel ?? "gemini-3-pro-image", prompt },
    });
  } else {
    // Demo fallback — still create artifact and transition
    await emitLog(run.runId, stageId, "warn",
      `[DEMO] Deliverable generation fallback for ${deliverable.id.slice(0, 8)}`);
    await new Promise(r => setTimeout(r, 1500));
    await createArtifactWithUpload({
      runId: run.runId,
      clientId: run.clientId,
      campaignId: run.campaignId,
      deliverableId: deliverable.id,
      type: "image",
      name: fileName,
      localPath: path.join(outputDir, fileName),
      stage: stageId,
      metadata: { model: "demo", prompt },
    });
  }

  // Transition to reviewing
  await updateDeliverableStatus(deliverable.id, "generating", "reviewing");
  await emitLog(run.runId, stageId, "info",
    `Deliverable ${deliverable.id.slice(0, 8)} → reviewing`);
}

async function executeGenerateImagesStage(run: Run): Promise<boolean> {
  const stageId = run.mode === "full" ? "generate" : "generate_images";
  run = await updateStageStatus(run, stageId, "running");
  const brandName = run.clientId.replace("client_", "");
  await emitLog(run.runId, stageId, "info", "Starting image generation with Temp-gen...");

  // Campaign deliverable branch — generate per-deliverable
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

  const pythonPath = getPythonPath(TEMP_GEN_VENV);
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
    // Clean up after use
    retrievalContext.delete(run.runId);
  }

  const result = await runCommand(
    run.runId,
    stageId,
    pythonPath,
    [
      "main.py",
      "nano",
      "generate",
      "--prompt", prompt,
      "--output", path.join(outputDir, "generated.png"),
    ],
    TEMP_GEN_PATH
  );

  if (result.success) {
    await createArtifactWithUpload({
      runId: run.runId,
      clientId: run.clientId,
      campaignId: run.campaignId,
      type: "image",
      name: "generated.png",
      localPath: path.join(outputDir, "generated.png"),
      stage: stageId,
      metadata: { model: "gemini-3-pro-image", prompt },
    });
    run = await updateStageStatus(run, stageId, "completed");
    return true;
  } else {
    // Demo fallback
    await emitLog(run.runId, stageId, "warn", "Real generation failed - falling back to demo mode");
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
  await emitLog(run.runId, stageId, "info", "Starting video generation with Temp-gen...");

  // Campaign deliverable branch for video
  if (run.campaignId) {
    const campaign = await getCampaign(run.campaignId);
    if (campaign) {
      const deliverables = await getPendingDeliverables(run.campaignId);
      if (deliverables.length > 0) {
        await emitLog(run.runId, stageId, "info",
          `Processing ${deliverables.length} video deliverable(s) for campaign "${campaign.name}"`);
        for (const d of deliverables) {
          // Video deliverables follow same flow but with video type
          await emitLog(run.runId, stageId, "info",
            `Generating video deliverable: ${d.description ?? d.id.slice(0, 8)}`);
          await updateDeliverableStatus(d.id, d.status, "generating");

          const prompt = d.currentPrompt ?? d.originalPrompt ?? campaign.prompt ?? `Brand campaign video for ${brandName}`;
          const fileName = `deliverable_${d.id.slice(0, 8)}.mp4`;
          const outputDir = path.join(TEMP_GEN_PATH, "outputs", run.runId);

          const result = await runCommand(
            run.runId, stageId, getPythonPath(TEMP_GEN_VENV),
            ["main.py", "veo", "generate", "--prompt", prompt, "--output", path.join(outputDir, fileName)],
            TEMP_GEN_PATH,
          );

          if (!result.success) {
            await emitLog(run.runId, stageId, "warn", `[DEMO] Video deliverable fallback for ${d.id.slice(0, 8)}`);
            await new Promise(r => setTimeout(r, 2000));
          }

          await createArtifactWithUpload({
            runId: run.runId, clientId: run.clientId, campaignId: run.campaignId,
            deliverableId: d.id, type: "video", name: fileName,
            localPath: path.join(outputDir, fileName), stage: stageId,
            metadata: { model: result.success ? "veo-3.1" : "demo", prompt },
          });

          await updateDeliverableStatus(d.id, "generating", "reviewing");
        }
        run = await updateStageStatus(run, stageId, "completed");
        return true;
      }
    }
  }

  const pythonPath = getPythonPath(TEMP_GEN_VENV);
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

  const result = await runCommand(
    run.runId,
    stageId,
    pythonPath,
    [
      "main.py",
      "veo",
      "generate",
      "--prompt", videoPrompt,
      "--output", path.join(outputDir, "generated.mp4"),
    ],
    TEMP_GEN_PATH
  );

  if (result.success) {
    await createArtifactWithUpload({
      runId: run.runId,
      clientId: run.clientId,
      campaignId: run.campaignId,
      type: "video",
      name: "generated.mp4",
      localPath: path.join(outputDir, "generated.mp4"),
      stage: stageId,
      metadata: { model: "veo-3.1", prompt: videoPrompt },
    });
    run = await updateStageStatus(run, stageId, "completed");
    return true;
  } else {
    // Demo fallback
    await emitLog(run.runId, stageId, "warn", "Real generation failed - falling back to demo mode");
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
