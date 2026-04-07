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
  addHitlDecision,
  getHitlDecisionsByRun,
} from "./db.js";
import { executeRun, cancelRun, runEvents } from "./runner.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Helper to extract params safely
function getParam(req: Request, name: string): string {
  return req.params[name] as string;
}

// ============ Client Routes ============

// GET /api/clients - List all clients
app.get("/api/clients", async (_req: Request, res: Response) => {
  try {
    const clients = await getAllClients();
    res.json(clients);
  } catch (err) {
    console.error("GET /api/clients error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/clients/:clientId - Get client details
app.get("/api/clients/:clientId", async (req: Request, res: Response) => {
  try {
    const clientId = getParam(req, "clientId");
    const client = await getClient(clientId);
    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }
    const runs = await getRunsByClient(clientId);
    res.json({ ...client, runs });
  } catch (err) {
    console.error("GET /api/clients/:clientId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/clients/:clientId/runs - Create a new run
app.post("/api/clients/:clientId/runs", async (req: Request, res: Response) => {
  try {
    const clientId = getParam(req, "clientId");
    const { mode, campaignId } = req.body as RunCreatePayload;

    if (!mode || !STAGE_DEFINITIONS[mode]) {
      res.status(400).json({ error: "Invalid mode" });
      return;
    }

    const client = await getClient(clientId);
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
      campaignId,
      mode,
      status: "pending",
      stages,
      createdAt: now,
      updatedAt: now,
    };

    const created = await createRun(run);

    // Start execution asynchronously
    setImmediate(() => executeRun(created).catch(console.error));

    res.status(201).json(created);
  } catch (err) {
    console.error("POST /api/clients/:clientId/runs error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============ Run Routes ============

// GET /api/runs/:runId - Get run details
app.get("/api/runs/:runId", async (req: Request, res: Response) => {
  try {
    const runId = getParam(req, "runId");
    const run = await getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json(run);
  } catch (err) {
    console.error("GET /api/runs/:runId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/runs/:runId/logs - SSE stream for logs
app.get("/api/runs/:runId/logs", async (req: Request, res: Response) => {
  try {
    const runId = getParam(req, "runId");
    const run = await getRun(runId);
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
    const existingLogs = await getLogsByRun(runId, since);
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
  } catch (err) {
    console.error("GET /api/runs/:runId/logs error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/runs/:runId/cancel - Cancel a run
app.post("/api/runs/:runId/cancel", async (req: Request, res: Response) => {
  try {
    const runId = getParam(req, "runId");
    const run = await getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    const cancelled = await cancelRun(runId);
    if (cancelled) {
      res.json({ success: true, message: "Run cancelled" });
    } else {
      res.status(400).json({ error: "Run is not active or already completed" });
    }
  } catch (err) {
    console.error("POST /api/runs/:runId/cancel error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============ HITL Routes ============

// GET /api/runs/:runId/review - Get review status
app.get("/api/runs/:runId/review", async (req: Request, res: Response) => {
  try {
    const runId = getParam(req, "runId");
    const run = await getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    const artifacts = await getArtifactsByRun(runId);
    const decisions = await getHitlDecisionsByRun(runId);
    res.json({
      runId,
      requiresReview: run.hitlRequired,
      status: run.status,
      notes: run.hitlNotes,
      artifacts,
      decisions,
    });
  } catch (err) {
    console.error("GET /api/runs/:runId/review error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/runs/:runId/review/approve - Approve HITL review
app.post("/api/runs/:runId/review/approve", async (req: Request, res: Response) => {
  try {
    const runId = getParam(req, "runId");
    const { artifactId, gradeScores, notes } = req.body as ReviewPayload;

    const run = await getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    if (run.status !== "needs_review") {
      res.status(400).json({ error: "Run is not awaiting review" });
      return;
    }

    // Record the HITL decision in hitl_decisions table
    const decision = await addHitlDecision({
      runId,
      artifactId,
      decision: "approved",
      notes: notes || "Approved",
      gradeScores,
    });

    const updated = await updateRun(runId, {
      status: "completed",
      hitlRequired: false,
      hitlNotes: "Approved",
      completedAt: new Date().toISOString(),
    });

    res.json({ ...updated, decision });
  } catch (err) {
    console.error("POST /api/runs/:runId/review/approve error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/runs/:runId/review/reject - Reject HITL review
app.post("/api/runs/:runId/review/reject", async (req: Request, res: Response) => {
  try {
    const runId = getParam(req, "runId");
    const { notes, artifactId, gradeScores, rejectionCategories } = req.body as ReviewPayload;

    const run = await getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    if (run.status !== "needs_review") {
      res.status(400).json({ error: "Run is not awaiting review" });
      return;
    }

    // Record the HITL decision in hitl_decisions table
    const decision = await addHitlDecision({
      runId,
      artifactId,
      decision: "rejected",
      notes: notes || "Rejected",
      gradeScores,
      rejectionCategories,
    });

    const updated = await updateRun(runId, {
      status: "blocked",
      hitlNotes: notes || "Rejected",
    });

    res.json({ ...updated, decision });
  } catch (err) {
    console.error("POST /api/runs/:runId/review/reject error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============ Artifact Routes ============

// GET /api/runs/:runId/artifacts - Get artifacts for a run
app.get("/api/runs/:runId/artifacts", async (req: Request, res: Response) => {
  try {
    const runId = getParam(req, "runId");
    const run = await getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    const artifacts = await getArtifactsByRun(runId);
    res.json(artifacts);
  } catch (err) {
    console.error("GET /api/runs/:runId/artifacts error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/runs/:runId/export - Trigger export
app.post("/api/runs/:runId/export", async (req: Request, res: Response) => {
  try {
    const runId = getParam(req, "runId");
    const run = await getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    // Return existing artifacts as the export
    const artifacts = await getArtifactsByRun(runId);
    res.json({
      success: true,
      runId,
      artifacts,
      message: "Export ready",
    });
  } catch (err) {
    console.error("POST /api/runs/:runId/export error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
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
