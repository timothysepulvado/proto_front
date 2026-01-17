import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import type { Request, Response } from "express";
import type { Run, RunCreatePayload, ReviewPayload } from "./types.js";
import { STAGE_DEFINITIONS } from "./types.js";
import {
  createRun,
  getRun,
  updateRun,
  getRunsByClient,
  getLogsByRun,
  getArtifactsByRun,
  getClient,
  getAllClients,
  upsertClient,
} from "./db.js";
import { executeRun, cancelRun, runEvents } from "./runner.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Seed default clients from HUD data
const defaultClients = [
  { id: "client_cylndr", name: "Cylndr", status: "active" },
  { id: "client_jenni_kayne", name: "Jenni Kayne", status: "active" },
  { id: "client_lilydale", name: "Lilydale", status: "active" },
];

defaultClients.forEach((client) => upsertClient(client));

// Helper to extract params safely
function getParam(req: Request, name: string): string {
  return req.params[name] as string;
}

// ============ Client Routes ============

// GET /api/clients - List all clients
app.get("/api/clients", (_req: Request, res: Response) => {
  const clients = getAllClients();
  res.json(clients);
});

// GET /api/clients/:clientId - Get client details
app.get("/api/clients/:clientId", (req: Request, res: Response) => {
  const clientId = getParam(req, "clientId");
  const client = getClient(clientId);
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }
  const runs = getRunsByClient(clientId);
  res.json({ ...client, runs });
});

// POST /api/clients/:clientId/runs - Create a new run
app.post("/api/clients/:clientId/runs", (req: Request, res: Response) => {
  const clientId = getParam(req, "clientId");
  const { mode } = req.body as RunCreatePayload;

  if (!mode || !STAGE_DEFINITIONS[mode]) {
    res.status(400).json({ error: "Invalid mode" });
    return;
  }

  const client = getClient(clientId);
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  const now = new Date().toISOString();
  const stages = STAGE_DEFINITIONS[mode].map((s) => ({
    ...s,
    status: "pending" as const,
  }));

  const run: Run = {
    runId: uuidv4(),
    clientId,
    mode,
    status: "pending",
    stages,
    createdAt: now,
    updatedAt: now,
  };

  createRun(run);

  // Start execution asynchronously
  setImmediate(() => executeRun(run));

  res.status(201).json(run);
});

// ============ Run Routes ============

// GET /api/runs/:runId - Get run details
app.get("/api/runs/:runId", (req: Request, res: Response) => {
  const runId = getParam(req, "runId");
  const run = getRun(runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json(run);
});

// GET /api/runs/:runId/logs - SSE stream for logs
app.get("/api/runs/:runId/logs", (req: Request, res: Response) => {
  const runId = getParam(req, "runId");
  const run = getRun(runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send existing logs
  const since = req.query.since ? Number(req.query.since) : undefined;
  const existingLogs = getLogsByRun(runId, since);
  existingLogs.forEach((log) => {
    res.write(`data: ${JSON.stringify(log)}\n\n`);
  });

  // Listen for new logs
  const logListener = (log: unknown) => {
    res.write(`data: ${JSON.stringify(log)}\n\n`);
  };

  const completeListener = (result: unknown) => {
    res.write(`event: complete\ndata: ${JSON.stringify(result)}\n\n`);
    cleanup();
    res.end();
  };

  runEvents.on(`log:${runId}`, logListener);
  runEvents.once(`complete:${runId}`, completeListener);

  const cleanup = () => {
    runEvents.off(`log:${runId}`, logListener);
    runEvents.off(`complete:${runId}`, completeListener);
  };

  req.on("close", cleanup);

  // Send heartbeat
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15000);

  req.on("close", () => clearInterval(heartbeat));
});

// POST /api/runs/:runId/cancel - Cancel a run
app.post("/api/runs/:runId/cancel", (req: Request, res: Response) => {
  const runId = getParam(req, "runId");
  const run = getRun(runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const cancelled = cancelRun(runId);
  if (cancelled) {
    res.json({ success: true, message: "Run cancelled" });
  } else {
    res.status(400).json({ error: "Run is not active or already completed" });
  }
});

// ============ HITL Routes ============

// GET /api/runs/:runId/review - Get review status
app.get("/api/runs/:runId/review", (req: Request, res: Response) => {
  const runId = getParam(req, "runId");
  const run = getRun(runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  res.json({
    runId,
    requiresReview: run.hitlRequired,
    status: run.status,
    notes: run.hitlNotes,
    artifacts: getArtifactsByRun(runId),
  });
});

// POST /api/runs/:runId/review/approve - Approve HITL review
app.post("/api/runs/:runId/review/approve", (req: Request, res: Response) => {
  const runId = getParam(req, "runId");
  const run = getRun(runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  if (run.status !== "needs_review") {
    res.status(400).json({ error: "Run is not awaiting review" });
    return;
  }

  const updated = updateRun(runId, {
    status: "completed",
    hitlRequired: false,
    hitlNotes: "Approved",
    completedAt: new Date().toISOString(),
  });

  res.json(updated);
});

// POST /api/runs/:runId/review/reject - Reject HITL review
app.post("/api/runs/:runId/review/reject", (req: Request, res: Response) => {
  const runId = getParam(req, "runId");
  const { notes } = req.body as ReviewPayload;

  const run = getRun(runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  if (run.status !== "needs_review") {
    res.status(400).json({ error: "Run is not awaiting review" });
    return;
  }

  const updated = updateRun(runId, {
    status: "blocked",
    hitlNotes: notes || "Rejected",
  });

  res.json(updated);
});

// ============ Artifact Routes ============

// GET /api/runs/:runId/artifacts - Get artifacts for a run
app.get("/api/runs/:runId/artifacts", (req: Request, res: Response) => {
  const runId = getParam(req, "runId");
  const run = getRun(runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const artifacts = getArtifactsByRun(runId);
  res.json(artifacts);
});

// POST /api/runs/:runId/export - Trigger export
app.post("/api/runs/:runId/export", (req: Request, res: Response) => {
  const runId = getParam(req, "runId");
  const run = getRun(runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  // Return existing artifacts as the export
  const artifacts = getArtifactsByRun(runId);
  res.json({
    success: true,
    runId,
    artifacts,
    message: "Export ready",
  });
});

// ============ Health Check ============

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`BrandStudios OS API running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
