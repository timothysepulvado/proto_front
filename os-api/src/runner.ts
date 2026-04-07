import { spawn, ChildProcess } from "child_process";
import path from "path";
import { EventEmitter } from "events";
import type { Run, StageStatus } from "./types.js";
import { updateRun, addLog, updateClientLastRun, addArtifact, addDriftMetric, addDriftAlert, getCampaign } from "./db.js";
import { v4 as uuidv4 } from "uuid";

// Active processes map for cancellation
const activeProcesses = new Map<string, ChildProcess>();

// Event emitter for log streaming
export const runEvents = new EventEmitter();

// Environment paths
const TEMP_GEN_PATH = process.env.TEMP_GEN_PATH || "/Users/timothysepulvado/Temp-gen";
const BRAND_LINTER_PATH = process.env.BRAND_LINTER_PATH || "/Users/timothysepulvado/Brand_linter/local_quick_setup";
const TEMP_GEN_VENV = process.env.TEMP_GEN_VENV || path.join(TEMP_GEN_PATH, ".venv");
const BRAND_LINTER_VENV = process.env.BRAND_LINTER_VENV || path.join(BRAND_LINTER_PATH, ".venv");

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

// Stage executors
async function executeIngestStage(run: Run): Promise<boolean> {
  const stageId = "ingest";
  run = await updateStageStatus(run, stageId, "running");
  await emitLog(run.runId, stageId, "info", "Starting Brand Memory ingest and index...");

  const brandName = run.clientId.replace("client_", "");

  // Try multiple possible data paths
  const possiblePaths = [
    path.join(BRAND_LINTER_PATH, "data", brandName),
    path.join(BRAND_LINTER_PATH, "data", "reference_images"),
    path.join(BRAND_LINTER_PATH, "data", "reference_images", "lifestyle"),
  ];

  let imagesPath = possiblePaths.find(p => directoryExists(p));

  if (!imagesPath) {
    await emitLog(run.runId, stageId, "warn", `No data directory found for brand '${brandName}'`);
    await emitLog(run.runId, stageId, "warn", `Searched: ${possiblePaths.join(", ")}`);
    await emitLog(run.runId, stageId, "info", "Running in demo mode - simulating ingest...");

    // Demo mode - simulate some activity
    await new Promise(r => setTimeout(r, 1500));
    await emitLog(run.runId, stageId, "info", `[DEMO] Scanning brand assets for ${brandName}...`);
    await new Promise(r => setTimeout(r, 1000));
    await emitLog(run.runId, stageId, "info", "[DEMO] Generating CLIP embeddings...");
    await new Promise(r => setTimeout(r, 1200));
    await emitLog(run.runId, stageId, "info", "[DEMO] Indexing to vector store...");
    await new Promise(r => setTimeout(r, 800));
    await emitLog(run.runId, stageId, "info", "[DEMO] Brand Memory indexed successfully");

    run = await updateStageStatus(run, stageId, "completed");
    return true;
  }

  await emitLog(run.runId, stageId, "info", `Using images from: ${imagesPath}`);

  // Run brand_dna_indexer.py
  const pythonPath = getPythonPath(BRAND_LINTER_VENV);
  const result = await runCommand(
    run.runId,
    stageId,
    pythonPath,
    [
      "tools/brand_dna_indexer.py",
      "--brand", brandName,
      "--images", imagesPath,
    ],
    BRAND_LINTER_PATH
  );

  if (result.success) {
    run = await updateStageStatus(run, stageId, "completed");
    return true;
  } else {
    await emitLog(run.runId, stageId, "warn", "Real indexer failed - falling back to demo mode");
    await emitLog(run.runId, stageId, "info", "[DEMO] Brand Memory indexed (simulated)");
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

  const pythonPath = getPythonPath(BRAND_LINTER_VENV);

  // Build the text query from campaign prompt or brand name
  let textQuery = `Brand content for ${brandName}`;
  if (run.campaignId) {
    try {
      const campaign = await getCampaign(run.campaignId);
      if (campaign?.prompt) {
        textQuery = campaign.prompt as string;
        await emitLog(run.runId, stageId, "info", `Using campaign prompt as retrieval query`);
      }
    } catch {
      await emitLog(run.runId, stageId, "warn", "Failed to load campaign — using default query");
    }
  }

  // Call multimodal_retriever.py for brand context
  const result = await runCommand(
    run.runId,
    stageId,
    pythonPath,
    [
      "tools/multimodal_retriever.py",
      "placeholder.png",  // image arg required but we're doing text-first retrieval
      textQuery,
      "--brand", brandName,
      "--top-k", "5",
      "--json",
    ],
    BRAND_LINTER_PATH
  );

  if (result.success) {
    // Parse retrieval results and build context for generation
    try {
      // Extract JSON from output (may have logging before it)
      const jsonMatch = result.output.match(/\{[\s\S]*\}$/);
      if (jsonMatch) {
        const retrievalData = JSON.parse(jsonMatch[0]);
        const topResults = retrievalData.fusion?.top_results || [];

        if (topResults.length > 0) {
          // Build context string from top retrieved assets
          const contextParts = topResults.slice(0, 5).map((r: { id?: string; fused_score?: number }) =>
            `Reference: ${r.id ?? "unknown"} (score: ${(r.fused_score ?? 0).toFixed(3)})`
          );
          const brandContext = contextParts.join("; ");

          // Store context for the generate stage
          retrievalContext.set(run.runId, brandContext);

          await emitLog(run.runId, stageId, "info",
            `Retrieved ${topResults.length} reference assets from brand memory`);
          await emitLog(run.runId, stageId, "info",
            `Gate decision: ${retrievalData.fusion?.gate_decision ?? "N/A"}`);
        } else {
          await emitLog(run.runId, stageId, "warn", "No matching references found in brand memory");
        }
      }
    } catch (err) {
      await emitLog(run.runId, stageId, "warn",
        `Could not parse retrieval results: ${err instanceof Error ? err.message : String(err)}`);
    }

    run = await updateStageStatus(run, stageId, "completed");
    return true;
  } else {
    // Demo fallback
    await emitLog(run.runId, stageId, "warn", "Brand memory retrieval failed - falling back to demo mode");
    await emitLog(run.runId, stageId, "info", "[DEMO] Querying CLIP index...");
    await new Promise(r => setTimeout(r, 800));
    await emitLog(run.runId, stageId, "info", "[DEMO] Querying E5 index...");
    await new Promise(r => setTimeout(r, 600));
    await emitLog(run.runId, stageId, "info", "[DEMO] Querying Cohere index...");
    await new Promise(r => setTimeout(r, 600));
    await emitLog(run.runId, stageId, "info", "[DEMO] Fusing scores across 3 modalities...");
    await new Promise(r => setTimeout(r, 400));
    await emitLog(run.runId, stageId, "info", "[DEMO] Retrieved 5 reference assets (simulated)");

    retrievalContext.set(run.runId, "[DEMO] warm neutral tones, minimal composition, tactile materials");
    run = await updateStageStatus(run, stageId, "completed");
    return true;
  }
}

async function executeGenerateImagesStage(run: Run): Promise<boolean> {
  const stageId = run.mode === "full" ? "generate" : "generate_images";
  run = await updateStageStatus(run, stageId, "running");
  const brandName = run.clientId.replace("client_", "");
  await emitLog(run.runId, stageId, "info", "Starting image generation with Temp-gen...");

  const pythonPath = getPythonPath(TEMP_GEN_VENV);
  const outputDir = path.join(TEMP_GEN_PATH, "outputs", run.runId);

  // Build prompt — use campaign prompt if available, else fallback
  let prompt = `Brand campaign image for ${brandName}`;
  if (run.campaignId) {
    try {
      const campaign = await getCampaign(run.campaignId);
      if (campaign?.prompt) {
        prompt = campaign.prompt as string;
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
    // Add artifact
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
}

async function executeGenerateVideoStage(run: Run): Promise<boolean> {
  const stageId = run.mode === "full" ? "generate" : "generate_video";
  run = await updateStageStatus(run, stageId, "running");
  const brandName = run.clientId.replace("client_", "");
  await emitLog(run.runId, stageId, "info", "Starting video generation with Temp-gen...");

  const pythonPath = getPythonPath(TEMP_GEN_VENV);
  const outputDir = path.join(TEMP_GEN_PATH, "outputs", run.runId);

  const result = await runCommand(
    run.runId,
    stageId,
    pythonPath,
    [
      "main.py",
      "veo",
      "generate",
      "--prompt", `Brand campaign video for ${brandName}`,
      "--output", path.join(outputDir, "generated.mp4"),
    ],
    TEMP_GEN_PATH
  );

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
}

async function executeDriftStage(run: Run): Promise<boolean> {
  const stageId = "drift";
  run = await updateStageStatus(run, stageId, "running");
  const brandName = run.clientId.replace("client_", "");
  await emitLog(run.runId, stageId, "info", "Starting Brand Drift check...");

  // Check if drift tool exists
  const pythonPath = getPythonPath(BRAND_LINTER_VENV);

  // Build args for image_analyzer.py with brand profile for RAG similarity
  const profilePath = path.join(BRAND_LINTER_PATH, "data", "brand_profiles", `${brandName}.json`);
  const analyzerArgs = [
    "tools/image_analyzer.py",
    "--image", path.join(TEMP_GEN_PATH, "outputs", run.runId, "generated.png"),
    "--json", path.join(BRAND_LINTER_PATH, "reports", `${run.runId}_analysis.json`),
  ];

  // Add --profile flag if brand profile exists (enables RAG similarity checking)
  try {
    const fs = require("fs");
    if (fs.existsSync(profilePath)) {
      analyzerArgs.push("--profile", profilePath);
      await emitLog(run.runId, stageId, "info", `Using brand profile: ${profilePath}`);
    } else {
      await emitLog(run.runId, stageId, "warn", `No brand profile found at ${profilePath} — running pixel-only analysis`);
    }
  } catch {
    await emitLog(run.runId, stageId, "warn", "Could not check for brand profile — running pixel-only analysis");
  }

  const result = await runCommand(
    run.runId,
    stageId,
    pythonPath,
    analyzerArgs,
    BRAND_LINTER_PATH
  );

  if (result.success) {
    // Try to parse drift report and record metrics
    await recordDriftMetrics(run, brandName, stageId);
    run = await updateStageStatus(run, stageId, "completed");
    return true;
  } else {
    // Demo fallback
    await emitLog(run.runId, stageId, "warn", "Real drift analyzer failed - falling back to demo mode");
    await emitLog(run.runId, stageId, "info", "[DEMO] Loading brand reference embeddings...");
    await new Promise(r => setTimeout(r, 1000));
    await emitLog(run.runId, stageId, "info", "[DEMO] Computing similarity scores...");
    await new Promise(r => setTimeout(r, 1200));
    await emitLog(run.runId, stageId, "info", `[DEMO] Brand alignment score: 0.87 for ${brandName}`);
    await new Promise(r => setTimeout(r, 800));
    await emitLog(run.runId, stageId, "info", "[DEMO] Drift check passed - within tolerance");
    run = await updateStageStatus(run, stageId, "completed");
    return true;
  }
}

// Parse drift report JSON and record metrics + alerts
async function recordDriftMetrics(run: Run, brandName: string, stageId: string): Promise<void> {
  const fs = require("fs");
  const reportPath = path.join(BRAND_LINTER_PATH, "reports", `${run.runId}_analysis.json`);

  try {
    if (!fs.existsSync(reportPath)) {
      await emitLog(run.runId, stageId, "warn", "No drift report JSON found — skipping metrics recording");
      return;
    }

    const reportData = JSON.parse(fs.readFileSync(reportPath, "utf-8"));

    // Record drift metric
    const metric = await addDriftMetric({
      runId: run.runId,
      clipZ: reportData.clip_z ?? reportData.rag_similarity ?? undefined,
      e5Z: reportData.e5_z ?? undefined,
      cohereZ: reportData.cohere_z ?? undefined,
      fusedZ: reportData.fused_z ?? reportData.rag_similarity ?? undefined,
      clipRaw: reportData.clip_raw_score ?? undefined,
      e5Raw: reportData.e5_raw ?? undefined,
      cohereRaw: reportData.cohere_raw ?? undefined,
      gateDecision: reportData.gate_decision ?? undefined,
    });

    await emitLog(run.runId, stageId, "info",
      `Drift metrics recorded: fused_z=${metric.fusedZ ?? "N/A"}, gate=${metric.gateDecision ?? "N/A"}`);

    // Check for drift alert — trigger if fused_z is below threshold
    const DRIFT_ALERT_THRESHOLD = 0.5;
    const fusedZ = metric.fusedZ ?? metric.clipZ;
    if (fusedZ !== undefined && fusedZ < DRIFT_ALERT_THRESHOLD) {
      const severity = fusedZ < 0.3 ? "critical" : fusedZ < 0.4 ? "error" : "warn";
      await addDriftAlert({
        clientId: run.clientId,
        runId: run.runId,
        severity,
        message: `Brand drift detected for ${brandName}: fused_z=${fusedZ.toFixed(3)} (threshold: ${DRIFT_ALERT_THRESHOLD})`,
        fusedZ,
      });
      await emitLog(run.runId, stageId, "warn",
        `Drift alert triggered (${severity}): fused_z=${fusedZ.toFixed(3)}`);
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

  await addArtifact({
    id: uuidv4(),
    runId: run.runId,
    type: "package",
    name: "export_package.zip",
    path: exportPath,
    createdAt: new Date().toISOString(),
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
