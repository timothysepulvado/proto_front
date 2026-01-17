import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(apiRoot, "..");

dotenv.config({ path: path.join(apiRoot, ".env") });

const PORT = Number.parseInt(process.env.OS_API_PORT ?? "4001", 10);
const dataDir = process.env.OS_API_DATA_DIR ?? path.join(apiRoot, "data");
const storePath = process.env.OS_API_STORE_PATH ?? path.join(dataDir, "runs.json");
const exportsDir = process.env.OS_API_EXPORTS_DIR ?? path.join(apiRoot, "exports");

const hudPath = process.env.HUD_JSON_PATH ?? path.join(repoRoot, "hud.json");
const tempGenPath = process.env.TEMP_GEN_PATH ?? path.resolve(repoRoot, "..", "Temp-gen");
const brandLinterPath = process.env.BRAND_LINTER_PATH ?? path.resolve(repoRoot, "..", "BDE");

const pythonBin = process.env.PYTHON_BIN ?? "python3";
const tempGenPython = process.env.TEMP_GEN_PYTHON ?? pythonBin;
const brandLinterPython = process.env.BRAND_LINTER_PYTHON ?? pythonBin;

const brandLinterDataDir = process.env.BRAND_LINTER_DATA_DIR ?? path.join(brandLinterPath, "data");
const brandLinterReferenceRoot =
  process.env.BRAND_LINTER_REFERENCE_ROOT ?? path.join(brandLinterDataDir, "reference_images");
const brandLinterGuidelinesRoot =
  process.env.BRAND_LINTER_GUIDELINES_ROOT ?? path.join(brandLinterDataDir, "brand_guidelines");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(exportsDir, { recursive: true });

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

const stageTemplates = [
  { id: "ingest", label: "Ingest and Index" },
  { id: "generate", label: "Generate" },
  { id: "drift", label: "Drift Check" },
  { id: "hitl", label: "HITL Gate" },
  { id: "export", label: "Export Package" },
];

const runModes = {
  full: ["ingest", "generate", "drift", "hitl", "export"],
  ingest: ["ingest"],
  images: ["generate"],
  video: ["generate"],
  drift: ["drift"],
  export: ["export"],
};

const nowIso = () => new Date().toISOString();

const ensureJsonStore = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.runs)) return raw.runs;
  return [];
};

class RunStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.runs = new Map();
    this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      const list = ensureJsonStore(raw);
      list.forEach((run) => {
        if (run?.runId) this.runs.set(run.runId, run);
      });
    } catch (error) {
      console.error("Failed to load run store", error);
    }
  }

  save() {
    const list = Array.from(this.runs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    fs.writeFileSync(this.filePath, JSON.stringify({ runs: list }, null, 2));
  }

  upsert(run) {
    this.runs.set(run.runId, run);
    this.save();
    return run;
  }

  list() {
    return Array.from(this.runs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  get(runId) {
    return this.runs.get(runId) ?? null;
  }
}

const runStore = new RunStore(storePath);
const sseClients = new Map();
const activeRuns = new Map();

const loadHud = () => {
  try {
    const raw = fs.readFileSync(hudPath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    console.error("Failed to load hud.json", error);
    return { hud: { clients: [] } };
  }
};

const getClients = () => {
  const hud = loadHud();
  return hud?.hud?.clients ?? [];
};

const getClientById = (clientId) => getClients().find((client) => client.id === clientId);

const normalizeBrandId = (client) => {
  if (!client) return "cylndr";
  if (client.brand_id) return client.brand_id;
  if (client.internal_id) return client.internal_id.toLowerCase();
  if (client.name) return client.name.toLowerCase().replace(/\s+/g, "_");
  return client.id ?? "cylndr";
};

const createStages = () =>
  stageTemplates.map((stage) => ({
    ...stage,
    status: "pending",
  }));

const getStage = (run, stageId) => run.stages.find((stage) => stage.id === stageId);

const sendEvent = (res, event, data) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const broadcast = (runId, event, data) => {
  const clients = sseClients.get(runId);
  if (!clients) return;
  clients.forEach((res) => sendEvent(res, event, data));
};

const appendLog = (run, stageId, message, level = "info") => {
  const stage = getStage(run, stageId);
  const entry = {
    time: nowIso(),
    msg: message,
    stage: stage?.label ?? stageId,
    level,
  };

  run.logs = [...(run.logs ?? []), entry].slice(-400);
  run.updatedAt = nowIso();
  runStore.upsert(run);
  broadcast(run.runId, "log", entry);
};

const updateStage = (run, stageId, patch) => {
  const stage = getStage(run, stageId);
  if (!stage) return;
  Object.assign(stage, patch);
  run.updatedAt = nowIso();
  runStore.upsert(run);
  broadcast(run.runId, "stage", { stage });
};

const setRunStatus = (run, status) => {
  run.status = status;
  run.updatedAt = nowIso();
  if (status === "running") {
    run.startedAt = run.startedAt ?? nowIso();
  }
  if (["complete", "blocked", "failed", "canceled", "needs_review"].includes(status)) {
    run.endedAt = run.endedAt ?? nowIso();
  }
  runStore.upsert(run);
  broadcast(run.runId, "status", { status: run.status, updatedAt: run.updatedAt, endedAt: run.endedAt });
};

const registerActiveRun = (runId, child, stageId) => {
  activeRuns.set(runId, { child, stageId });
};

const clearActiveRun = (runId) => {
  activeRuns.delete(runId);
};

const runCommand = ({ run, stageId, command, args, cwd }) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    registerActiveRun(run.runId, child, stageId);

    const bufferOutput = (level) => {
      let buffer = "";
      return (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        lines
          .map((line) => line.trim())
          .filter(Boolean)
          .forEach((line) => appendLog(run, stageId, line, level));
      };
    };

    const handleStdout = bufferOutput("info");
    const handleStderr = bufferOutput("error");

    child.stdout.on("data", handleStdout);
    child.stderr.on("data", handleStderr);

    child.on("error", (error) => {
      appendLog(run, stageId, `Process error: ${error.message}`, "error");
      clearActiveRun(run.runId);
      resolve({ ok: false, code: 1 });
    });

    child.on("close", (code) => {
      clearActiveRun(run.runId);
      if (run.status === "canceled") {
        resolve({ ok: false, canceled: true, code });
        return;
      }
      resolve({ ok: code === 0, code });
    });
  });

const createExportArtifact = (run) => {
  const fileName = `export_${run.runId}.json`;
  const filePath = path.join(exportsDir, fileName);
  const summary = {
    runId: run.runId,
    clientId: run.clientId,
    mode: run.mode,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    stages: run.stages,
    artifacts: run.artifacts ?? [],
  };
  fs.writeFileSync(filePath, JSON.stringify(summary, null, 2));

  const artifact = {
    id: `export_${run.runId}`,
    name: "Run Export Summary",
    type: "json",
    path: filePath,
    stage: "export",
    createdAt: nowIso(),
  };

  run.artifacts = [...(run.artifacts ?? []), artifact];
  runStore.upsert(run);
  return artifact;
};

const runIngestStage = async (run) => {
  if (!fs.existsSync(brandLinterPath)) {
    return { ok: false, message: `Brand linter path not found: ${brandLinterPath}` };
  }

  const brandId = run.brandId ?? "cylndr";
  const referenceDir = path.join(brandLinterReferenceRoot, brandId);
  const guidelinesDir = path.join(brandLinterGuidelinesRoot, brandId);

  if (!fs.existsSync(referenceDir)) {
    return { ok: false, message: `Reference images not found: ${referenceDir}` };
  }

  appendLog(run, "ingest", `Reference path: ${referenceDir}`);

  const ingestClip = await runCommand({
    run,
    stageId: "ingest",
    command: brandLinterPython,
    args: ["tools/ingest_clip768.py", referenceDir, "--brand", brandId],
    cwd: brandLinterPath,
  });

  if (!ingestClip.ok) return { ok: false, message: "CLIP ingest failed" };

  const ingestE5 = await runCommand({
    run,
    stageId: "ingest",
    command: brandLinterPython,
    args: ["tools/ingest_e5_cohere.py", referenceDir, "--brand", brandId],
    cwd: brandLinterPath,
  });

  if (!ingestE5.ok) return { ok: false, message: "E5 ingest failed" };

  if (fs.existsSync(guidelinesDir)) {
    appendLog(run, "ingest", `Guidelines path: ${guidelinesDir}`);
    const ingestDocs = await runCommand({
      run,
      stageId: "ingest",
      command: brandLinterPython,
      args: ["tools/ingest_documents.py", guidelinesDir, "--brand", brandId],
      cwd: brandLinterPath,
    });

    if (!ingestDocs.ok) return { ok: false, message: "Document ingest failed" };
  } else {
    appendLog(run, "ingest", `Guidelines path not found, skipping documents ingest.`);
  }

  return { ok: true };
};

const runGenerateStage = async (run) => {
  if (!fs.existsSync(tempGenPath)) {
    return { ok: false, message: `Temp-gen path not found: ${tempGenPath}` };
  }

  const generateMode = run.inputs?.generate ?? (run.mode === "video" ? "video" : "images");
  const prompt = run.inputs?.prompt ?? `BrandStudios ${run.clientName ?? run.clientId} creative prompt.`;
  const runDir = path.join(tempGenPath, "outputs", "os-api", run.clientId, run.runId);

  fs.mkdirSync(runDir, { recursive: true });

  if (generateMode === "images" || generateMode === "both") {
    const imageOutput = path.join(runDir, "image.png");
    appendLog(run, "generate", "Launching Temp-gen image generation");
    const imageResult = await runCommand({
      run,
      stageId: "generate",
      command: tempGenPython,
      args: ["main.py", "nano", "generate", "--prompt", prompt, "--output", imageOutput, "--campaign", run.runId],
      cwd: tempGenPath,
    });

    if (!imageResult.ok) return { ok: false, message: "Image generation failed" };

    if (fs.existsSync(imageOutput)) {
      run.artifacts = [
        ...(run.artifacts ?? []),
        {
          id: `${run.runId}_image`,
          name: "Generated Image",
          type: "image",
          path: imageOutput,
          stage: "generate",
          createdAt: nowIso(),
        },
      ];
      runStore.upsert(run);
    }
  }

  if (generateMode === "video" || generateMode === "both") {
    const videoOutput = path.join(runDir, "video.mp4");
    appendLog(run, "generate", "Launching Temp-gen video generation");
    const videoResult = await runCommand({
      run,
      stageId: "generate",
      command: tempGenPython,
      args: ["main.py", "veo", "generate", "--prompt", prompt, "--output", videoOutput, "--campaign", run.runId],
      cwd: tempGenPath,
    });

    if (!videoResult.ok) return { ok: false, message: "Video generation failed" };

    if (fs.existsSync(videoOutput)) {
      run.artifacts = [
        ...(run.artifacts ?? []),
        {
          id: `${run.runId}_video`,
          name: "Generated Video",
          type: "video",
          path: videoOutput,
          stage: "generate",
          createdAt: nowIso(),
        },
      ];
      runStore.upsert(run);
    }
  }

  return { ok: true };
};

const runDriftStage = async (run) => {
  appendLog(run, "drift", "Drift check not wired yet. Marking stage as skipped.");
  return { ok: true, skipped: true, message: "Not wired yet" };
};

const runHitlStage = async (run) => {
  const client = getClientById(run.clientId);
  const requiresReview = Boolean(run.inputs?.forceReview) || Boolean(client?.hitl_review_needed);

  run.review = {
    required: requiresReview,
    status: requiresReview ? "pending" : "approved",
    updatedAt: nowIso(),
  };
  runStore.upsert(run);

  if (!requiresReview) {
    return { ok: true, skipped: true, message: "Review not required" };
  }

  appendLog(run, "hitl", "HITL review required before export.");
  return { ok: true, message: "Review required", reviewRequired: true };
};

const runExportStage = async (run) => {
  if (run.review?.required && run.review.status !== "approved") {
    appendLog(run, "export", "Export waiting for HITL approval.");
    return { ok: true, skipped: true, message: "Waiting for review" };
  }

  createExportArtifact(run);
  appendLog(run, "export", "Export package created.");
  return { ok: true };
};

const executeStage = async (run, stage) => {
  if (stage.id === "ingest") return runIngestStage(run);
  if (stage.id === "generate") return runGenerateStage(run);
  if (stage.id === "drift") return runDriftStage(run);
  if (stage.id === "hitl") return runHitlStage(run);
  if (stage.id === "export") return runExportStage(run);
  return { ok: true, skipped: true, message: "Unknown stage" };
};

const runPipeline = async (run) => {
  setRunStatus(run, "running");

  const stagesToRun = new Set(runModes[run.mode] ?? []);

  for (const stage of run.stages) {
    if (!stagesToRun.has(stage.id)) {
      updateStage(run, stage.id, { status: "skipped", endedAt: nowIso() });
      continue;
    }

    if (run.status === "canceled") return;

    updateStage(run, stage.id, { status: "running", startedAt: nowIso() });
    appendLog(run, stage.id, `${stage.label} started.`);

    const result = await executeStage(run, stage);

    if (result?.canceled) {
      updateStage(run, stage.id, { status: "blocked", endedAt: nowIso(), message: "Canceled" });
      setRunStatus(run, "canceled");
      return;
    }

    if (!result?.ok) {
      updateStage(run, stage.id, {
        status: "blocked",
        endedAt: nowIso(),
        message: result?.message ?? "Stage failed",
      });
      appendLog(run, stage.id, result?.message ?? "Stage failed", "error");
      setRunStatus(run, "blocked");
      return;
    }

    if (result?.skipped) {
      updateStage(run, stage.id, {
        status: "skipped",
        endedAt: nowIso(),
        message: result?.message,
      });
      continue;
    }

    updateStage(run, stage.id, { status: "complete", endedAt: nowIso() });
    appendLog(run, stage.id, `${stage.label} complete.`);
  }

  if (run.review?.required && run.review.status !== "approved") {
    setRunStatus(run, "needs_review");
    return;
  }

  setRunStatus(run, "complete");
};

const buildRunRecord = ({ client, mode, inputs }) => {
  const runId = crypto.randomUUID();
  const run = {
    runId,
    clientId: client.id,
    clientName: client.name,
    brandId: normalizeBrandId(client),
    mode,
    status: "ready",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    stages: createStages(),
    logs: [],
    review: {
      required: false,
      status: "pending",
      updatedAt: nowIso(),
    },
    artifacts: [],
    inputs: inputs ?? {},
  };

  runStore.upsert(run);
  return run;
};

app.get("/api/clients", (_req, res) => {
  const clients = getClients();
  const runs = runStore.list();

  const enrichedClients = clients.map((client) => {
    const lastRun = runs.find((run) => run.clientId === client.id) ?? null;
    return { ...client, last_run: lastRun };
  });

  res.json({ clients: enrichedClients });
});

app.get("/api/clients/:clientId", (req, res) => {
  const client = getClientById(req.params.clientId);
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  const lastRun = runStore.list().find((run) => run.clientId === client.id) ?? null;
  res.json({ client: { ...client, last_run: lastRun }, last_run: lastRun });
});

app.post("/api/clients/:clientId/runs", (req, res) => {
  const client = getClientById(req.params.clientId);
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  const mode = req.body?.mode;
  if (!mode || !runModes[mode]) {
    res.status(400).json({ error: "Invalid run mode" });
    return;
  }

  const run = buildRunRecord({ client, mode, inputs: req.body?.inputs });
  res.status(201).json({ run });

  setImmediate(() => {
    void runPipeline(run);
  });
});

app.get("/api/runs/:runId", (req, res) => {
  const run = runStore.get(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json({ run });
});

app.get("/api/runs/:runId/logs", (req, res) => {
  const run = runStore.get(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  sendEvent(res, "snapshot", { run, logs: run.logs ?? [] });

  if (!sseClients.has(run.runId)) {
    sseClients.set(run.runId, new Set());
  }
  sseClients.get(run.runId).add(res);

  const keepAlive = setInterval(() => {
    res.write(":keep-alive\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    const clients = sseClients.get(run.runId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(run.runId);
    }
  });
});

app.post("/api/runs/:runId/cancel", (req, res) => {
  const run = runStore.get(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const active = activeRuns.get(run.runId);
  if (active?.child) {
    appendLog(run, active.stageId, "Cancel requested. Attempting to stop the run.");
    active.child.kill("SIGTERM");
    setTimeout(() => {
      if (!active.child.killed) active.child.kill("SIGKILL");
    }, 5000);
  }

  if (active?.stageId) {
    updateStage(run, active.stageId, { status: "blocked", endedAt: nowIso(), message: "Canceled" });
  }

  setRunStatus(run, "canceled");
  res.json({ run });
});

app.get("/api/runs/:runId/review", (req, res) => {
  const run = runStore.get(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json({ review: run.review ?? { required: false }, status: run.status });
});

app.post("/api/runs/:runId/review/approve", (req, res) => {
  const run = runStore.get(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  run.review = {
    required: false,
    status: "approved",
    notes: req.body?.notes,
    updatedAt: nowIso(),
  };
  updateStage(run, "hitl", { status: "complete", endedAt: nowIso(), message: "Review approved" });
  setRunStatus(run, "complete");
  runStore.upsert(run);
  res.json({ run });
});

app.post("/api/runs/:runId/review/reject", (req, res) => {
  const run = runStore.get(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  run.review = {
    required: true,
    status: "rejected",
    notes: req.body?.notes,
    updatedAt: nowIso(),
  };
  updateStage(run, "hitl", { status: "blocked", endedAt: nowIso(), message: "Review rejected" });
  setRunStatus(run, "blocked");
  runStore.upsert(run);
  res.json({ run });
});

app.get("/api/runs/:runId/artifacts", (req, res) => {
  const run = runStore.get(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const artifacts =
    run.artifacts?.length > 0
      ? run.artifacts
      : [
          {
            id: `summary_${run.runId}`,
            name: "Run Summary",
            type: "summary",
            stage: "export",
            createdAt: run.createdAt,
          },
        ];

  res.json({ artifacts });
});

app.post("/api/runs/:runId/export", (req, res) => {
  const run = runStore.get(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  createExportArtifact(run);
  updateStage(run, "export", { status: "complete", endedAt: nowIso(), message: "Exported" });
  setRunStatus(run, run.review?.required ? "needs_review" : "complete");
  res.json({ run });
});

app.listen(PORT, () => {
  console.log(`BrandStudios os-api listening on http://localhost:${PORT}`);
});
