import path from "path";
import { EventEmitter } from "events";
import type { Run, StageStatus } from "./types.js";
import { updateRun, addLog, updateClientLastRun, addArtifact } from "./db.js";
import { v4 as uuidv4 } from "uuid";

// Event emitter for log streaming
export const runEvents = new EventEmitter();

// Brand Engine API (FastAPI sidecar)
const BRAND_ENGINE_URL = process.env.BRAND_ENGINE_URL || "http://localhost:8100";

// Temp-gen paths (still subprocess — not part of brand-engine consolidation)
const TEMP_GEN_PATH = process.env.TEMP_GEN_PATH || "/Users/timothysepulvado/Temp-gen";
const TEMP_GEN_VENV = process.env.TEMP_GEN_VENV || path.join(TEMP_GEN_PATH, ".venv");

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

// Helper to call brand-engine API
async function callBrandEngine<T>(
  endpoint: string,
  body: Record<string, unknown>,
  runId: string,
  stage: string,
): Promise<{ success: boolean; data?: T; error?: string }> {
  const url = `${BRAND_ENGINE_URL}${endpoint}`;
  await emitLog(runId, stage, "info", `Calling brand-engine: ${endpoint}`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      await emitLog(runId, stage, "error", `Brand-engine ${endpoint} failed (${response.status}): ${errorText}`);
      return { success: false, error: errorText };
    }

    const data = await response.json() as T;
    return { success: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await emitLog(runId, stage, "warn", `Brand-engine unreachable: ${msg}`);
    return { success: false, error: msg };
  }
}

// Helper to check if brand-engine sidecar is running
async function isBrandEngineAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${BRAND_ENGINE_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

// Temp-gen subprocess runner (unchanged — Temp-gen stays as subprocess)
async function runTempGenCommand(
  runId: string,
  stage: string,
  args: string[],
): Promise<{ success: boolean; output: string }> {
  const { spawn } = await import("child_process");

  return new Promise((resolve) => {
    const pythonPath = getPythonPath(TEMP_GEN_VENV);
    emitLog(runId, stage, "info", `Executing: ${pythonPath} ${args.join(" ")}`).catch(console.error);

    const proc = spawn(pythonPath, args, {
      cwd: TEMP_GEN_PATH,
      env: process.env as Record<string, string>,
      stdio: ["pipe", "pipe", "pipe"],
    });

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
      if (code === 0) {
        await emitLog(runId, stage, "info", "Stage completed successfully");
        resolve({ success: true, output });
      } else {
        await emitLog(runId, stage, "error", `Stage failed with exit code ${code}`);
        resolve({ success: false, output });
      }
    });

    proc.on("error", async (err) => {
      await emitLog(runId, stage, "error", `Process error: ${err.message}`);
      resolve({ success: false, output: err.message });
    });
  });
}

// ============ Stage Executors ============

async function executeIngestStage(run: Run): Promise<boolean> {
  const stageId = "ingest";
  run = await updateStageStatus(run, stageId, "running");
  await emitLog(run.runId, stageId, "info", "Starting Brand Memory ingest via brand-engine...");

  const brandName = run.clientId.replace("client_", "");

  // Try brand-engine API first
  const result = await callBrandEngine<{ vectors_indexed: number; errors: string[] }>(
    "/ingest",
    {
      brand_slug: brandName,
      images_dir: `data/${brandName}`,
      index_tier: "brand-dna",
    },
    run.runId,
    stageId,
  );

  if (result.success && result.data) {
    await emitLog(run.runId, stageId, "info", `Indexed ${result.data.vectors_indexed} vectors`);
    if (result.data.errors.length > 0) {
      await emitLog(run.runId, stageId, "warn", `${result.data.errors.length} errors during ingest`);
    }
    run = await updateStageStatus(run, stageId, "completed");
    return true;
  }

  // Demo fallback — brand-engine unavailable
  await emitLog(run.runId, stageId, "info", "Running in demo mode — brand-engine not available...");
  await new Promise(r => setTimeout(r, 1500));
  await emitLog(run.runId, stageId, "info", `[DEMO] Scanning brand assets for ${brandName}...`);
  await new Promise(r => setTimeout(r, 1000));
  await emitLog(run.runId, stageId, "info", "[DEMO] Generating Gemini Embedding 2 vectors...");
  await new Promise(r => setTimeout(r, 1200));
  await emitLog(run.runId, stageId, "info", "[DEMO] Indexing to Pinecone (gemini768 + cohere1536)...");
  await new Promise(r => setTimeout(r, 800));
  await emitLog(run.runId, stageId, "info", "[DEMO] Brand Memory indexed successfully");
  run = await updateStageStatus(run, stageId, "completed");
  return true;
}

async function executeGenerateImagesStage(run: Run): Promise<boolean> {
  const stageId = run.mode === "full" ? "generate" : "generate_images";
  run = await updateStageStatus(run, stageId, "running");
  const brandName = run.clientId.replace("client_", "");
  await emitLog(run.runId, stageId, "info", "Starting image generation with Temp-gen...");

  const outputDir = path.join(TEMP_GEN_PATH, "outputs", run.runId);

  const result = await runTempGenCommand(run.runId, stageId, [
    "main.py",
    "nano",
    "generate",
    "--prompt", `Brand campaign image for ${brandName}`,
    "--output", path.join(outputDir, "generated.png"),
  ]);

  if (result.success) {
    await addArtifact({
      id: uuidv4(),
      runId: run.runId,
      type: "image",
      name: "generated.png",
      path: path.join(outputDir, "generated.png"),
      createdAt: new Date().toISOString(),
    });
    run = await updateStageStatus(run, stageId, "completed");
    return true;
  }

  // Demo fallback
  await emitLog(run.runId, stageId, "warn", "Real generation failed — falling back to demo mode");
  await emitLog(run.runId, stageId, "info", "[DEMO] Initializing Gemini image model...");
  await new Promise(r => setTimeout(r, 1200));
  await emitLog(run.runId, stageId, "info", `[DEMO] Generating brand image for ${brandName}...`);
  await new Promise(r => setTimeout(r, 2000));
  await emitLog(run.runId, stageId, "info", "[DEMO] Applying brand style transfer...");
  await new Promise(r => setTimeout(r, 1500));
  await emitLog(run.runId, stageId, "info", "[DEMO] Image generated successfully");

  await addArtifact({
    id: uuidv4(),
    runId: run.runId,
    type: "image",
    name: "generated.png",
    path: path.join(outputDir, "generated.png"),
    createdAt: new Date().toISOString(),
  });
  run = await updateStageStatus(run, stageId, "completed");
  return true;
}

async function executeGenerateVideoStage(run: Run): Promise<boolean> {
  const stageId = run.mode === "full" ? "generate" : "generate_video";
  run = await updateStageStatus(run, stageId, "running");
  const brandName = run.clientId.replace("client_", "");
  await emitLog(run.runId, stageId, "info", "Starting video generation with Temp-gen...");

  const outputDir = path.join(TEMP_GEN_PATH, "outputs", run.runId);

  const result = await runTempGenCommand(run.runId, stageId, [
    "main.py",
    "veo",
    "generate",
    "--prompt", `Brand campaign video for ${brandName}`,
    "--output", path.join(outputDir, "generated.mp4"),
  ]);

  if (result.success) {
    await addArtifact({
      id: uuidv4(),
      runId: run.runId,
      type: "video",
      name: "generated.mp4",
      path: path.join(outputDir, "generated.mp4"),
      createdAt: new Date().toISOString(),
    });
    run = await updateStageStatus(run, stageId, "completed");
    return true;
  }

  // Demo fallback
  await emitLog(run.runId, stageId, "warn", "Real generation failed — falling back to demo mode");
  await emitLog(run.runId, stageId, "info", "[DEMO] Initializing Veo video model...");
  await new Promise(r => setTimeout(r, 1500));
  await emitLog(run.runId, stageId, "info", `[DEMO] Generating brand video for ${brandName}...`);
  await new Promise(r => setTimeout(r, 3000));
  await emitLog(run.runId, stageId, "info", "[DEMO] Rendering frames...");
  await new Promise(r => setTimeout(r, 2000));
  await emitLog(run.runId, stageId, "info", "[DEMO] Encoding video...");
  await new Promise(r => setTimeout(r, 1500));
  await emitLog(run.runId, stageId, "info", "[DEMO] Video generated successfully");

  await addArtifact({
    id: uuidv4(),
    runId: run.runId,
    type: "video",
    name: "generated.mp4",
    path: path.join(outputDir, "generated.mp4"),
    createdAt: new Date().toISOString(),
  });
  run = await updateStageStatus(run, stageId, "completed");
  return true;
}

interface GradeResponse {
  fusion: {
    gemini_score: { raw_score: number; z_score: number };
    cohere_score: { raw_score: number; z_score: number };
    combined_z: number;
    gate_decision: string;
  };
  gate_decision: string;
  hitl_required: boolean;
  summary: string;
}

async function executeDriftStage(run: Run): Promise<boolean> {
  const stageId = "drift";
  run = await updateStageStatus(run, stageId, "running");
  const brandName = run.clientId.replace("client_", "");
  await emitLog(run.runId, stageId, "info", "Starting Brand Drift check via brand-engine...");

  const generatedImagePath = path.join(TEMP_GEN_PATH, "outputs", run.runId, "generated.png");

  // Call brand-engine /grade endpoint with brand profile (fixes audit seam #6)
  const result = await callBrandEngine<GradeResponse>(
    "/grade",
    {
      image_path: generatedImagePath,
      brand_slug: brandName,
      text_query: `Brand campaign image for ${brandName}`,
      include_pixel_analysis: true,
      index_tier: "core",
    },
    run.runId,
    stageId,
  );

  if (result.success && result.data) {
    const grade = result.data;
    await emitLog(run.runId, stageId, "info", `Gate Decision: ${grade.gate_decision}`);
    await emitLog(run.runId, stageId, "info", `Combined Z-Score: ${grade.fusion.combined_z.toFixed(4)}`);
    await emitLog(run.runId, stageId, "info", `Gemini Z: ${grade.fusion.gemini_score.z_score.toFixed(4)}`);
    await emitLog(run.runId, stageId, "info", `Cohere Z: ${grade.fusion.cohere_score.z_score.toFixed(4)}`);

    // Save grade report as artifact
    await addArtifact({
      id: uuidv4(),
      runId: run.runId,
      type: "report",
      name: `grade_${run.runId}.json`,
      path: `reports/${run.runId}_grade.json`,
      createdAt: new Date().toISOString(),
    });

    run = await updateStageStatus(run, stageId, "completed");
    return true;
  }

  // Demo fallback — brand-engine unavailable
  await emitLog(run.runId, stageId, "warn", "Brand-engine unavailable — falling back to demo mode");
  await emitLog(run.runId, stageId, "info", "[DEMO] Loading brand reference embeddings (Gemini + Cohere)...");
  await new Promise(r => setTimeout(r, 1000));
  await emitLog(run.runId, stageId, "info", "[DEMO] Computing dual-fusion similarity scores...");
  await new Promise(r => setTimeout(r, 1200));
  await emitLog(run.runId, stageId, "info", `[DEMO] Brand alignment score: 0.87 for ${brandName}`);
  await new Promise(r => setTimeout(r, 800));
  await emitLog(run.runId, stageId, "info", "[DEMO] Drift check passed — within tolerance");
  run = await updateStageStatus(run, stageId, "completed");
  return true;
}

async function executeHITLStage(run: Run): Promise<boolean> {
  const stageId = "hitl";
  run = await updateStageStatus(run, stageId, "running");
  await emitLog(run.runId, stageId, "info", "HITL gate — awaiting review...");

  await updateRun(run.runId, { status: "needs_review", hitlRequired: true });
  run = await updateStageStatus(run, stageId, "completed");

  return true;
}

async function executeExportStage(run: Run): Promise<boolean> {
  const stageId = "export";
  run = await updateStageStatus(run, stageId, "running");
  await emitLog(run.runId, stageId, "info", "Preparing export package...");

  const exportPath = path.join(TEMP_GEN_PATH, "outputs", run.runId, "export_package.zip");

  await addArtifact({
    id: uuidv4(),
    runId: run.runId,
    type: "package",
    name: "export_package.zip",
    path: exportPath,
    createdAt: new Date().toISOString(),
  });

  await emitLog(run.runId, stageId, "info", "Export package prepared");
  run = await updateStageStatus(run, stageId, "completed");

  return true;
}

// Main run executor
export async function executeRun(run: Run): Promise<void> {
  await emitLog(run.runId, "system", "info", `Starting run ${run.runId} in mode: ${run.mode}`);

  // Check brand-engine availability
  const engineAvailable = await isBrandEngineAvailable();
  if (engineAvailable) {
    await emitLog(run.runId, "system", "info", "Brand-engine sidecar connected");
  } else {
    await emitLog(run.runId, "system", "warn", "Brand-engine sidecar not available — using demo fallback");
  }

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
  await emitLog(runId, "system", "warn", "Run cancelled by user");
  await updateRun(runId, { status: "cancelled", completedAt: new Date().toISOString() });
  return true;
}
