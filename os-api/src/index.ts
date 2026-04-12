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
  getActivePrompt,
  createPromptTemplate,
  getPromptHistory,
  addPromptScore,
  getPromptScores,
  getPromptLineage,
  getCampaign,
  getCampaignsByClient,
  createCampaign,
  getDeliverablesByCampaign,
  getDeliverable,
  createDeliverable,
  updateDeliverableStatus,
  incrementDeliverableRetry,
  getDriftMetricsByRun,
  getDriftAlertsByClient,
  getDriftAlertsByRun,
  acknowledgeDriftAlert,
  getActiveBaseline,
  createBaseline,
  deactivateBaselines,
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

    // HITL cascade: approve all reviewing deliverables for this campaign
    if (run.campaignId) {
      try {
        const deliverables = await getDeliverablesByCampaign(run.campaignId);
        for (const d of deliverables) {
          if (d.status === "reviewing") {
            await updateDeliverableStatus(d.id, "reviewing", "approved");
          }
        }
      } catch (err) {
        console.error("Deliverable approve cascade error:", err);
      }
    }

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

    // HITL cascade: reject deliverables on this campaign
    const { deliverableId: targetDeliverableId } = req.body as { deliverableId?: string };
    if (run.campaignId) {
      try {
        if (targetDeliverableId) {
          // Reject specific deliverable
          const d = await getDeliverable(targetDeliverableId);
          if (d && d.status === "reviewing") {
            await updateDeliverableStatus(d.id, "reviewing", "rejected", {
              rejectionReason: notes || "Rejected",
            });
          }
        } else {
          // Reject all reviewing deliverables
          const deliverables = await getDeliverablesByCampaign(run.campaignId);
          for (const d of deliverables) {
            if (d.status === "reviewing") {
              await updateDeliverableStatus(d.id, "reviewing", "rejected", {
                rejectionReason: notes || "Rejected",
              });
            }
          }
        }
      } catch (err) {
        console.error("Deliverable reject cascade error:", err);
      }
    }

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

// ============ Drift Routes ============

// GET /api/clients/:clientId/drift-alerts - Get drift alerts for a client
app.get("/api/clients/:clientId/drift-alerts", async (req: Request, res: Response) => {
  try {
    const clientId = getParam(req, "clientId");
    const alerts = await getDriftAlertsByClient(clientId);
    res.json(alerts);
  } catch (err) {
    console.error("GET /api/clients/:clientId/drift-alerts error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/runs/:runId/drift-alerts - Get drift alerts for a run
app.get("/api/runs/:runId/drift-alerts", async (req: Request, res: Response) => {
  try {
    const runId = getParam(req, "runId");
    const alerts = await getDriftAlertsByRun(runId);
    res.json(alerts);
  } catch (err) {
    console.error("GET /api/runs/:runId/drift-alerts error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/runs/:runId/drift-metrics - Get drift metrics for a run
app.get("/api/runs/:runId/drift-metrics", async (req: Request, res: Response) => {
  try {
    const runId = getParam(req, "runId");
    const metrics = await getDriftMetricsByRun(runId);
    res.json(metrics);
  } catch (err) {
    console.error("GET /api/runs/:runId/drift-metrics error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/drift-alerts/:alertId/acknowledge - Acknowledge a drift alert
app.post("/api/drift-alerts/:alertId/acknowledge", async (req: Request, res: Response) => {
  try {
    const alertId = getParam(req, "alertId");
    const { resolutionNotes } = req.body as { resolutionNotes?: string };
    const alert = await acknowledgeDriftAlert(alertId, resolutionNotes);
    res.json(alert);
  } catch (err) {
    console.error("POST /api/drift-alerts/:alertId/acknowledge error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============ Prompt Routes ============

// GET /api/clients/:clientId/prompts - Get prompt history
app.get("/api/clients/:clientId/prompts", async (req: Request, res: Response) => {
  try {
    const clientId = getParam(req, "clientId");
    const stage = (req.query.stage as string) || "generate";
    const prompts = await getPromptHistory(clientId, stage);
    res.json(prompts);
  } catch (err) {
    console.error("GET /api/clients/:clientId/prompts error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/clients/:clientId/prompts/active - Get active prompt
app.get("/api/clients/:clientId/prompts/active", async (req: Request, res: Response) => {
  try {
    const clientId = getParam(req, "clientId");
    const stage = (req.query.stage as string) || "generate";
    const campaignId = req.query.campaignId as string | undefined;
    const prompt = await getActivePrompt(clientId, stage, campaignId);
    if (!prompt) {
      res.status(404).json({ error: "No active prompt found" });
      return;
    }
    res.json(prompt);
  } catch (err) {
    console.error("GET /api/clients/:clientId/prompts/active error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/clients/:clientId/prompts - Create prompt template
app.post("/api/clients/:clientId/prompts", async (req: Request, res: Response) => {
  try {
    const clientId = getParam(req, "clientId");
    const { promptText, stage, campaignId, version } = req.body;
    if (!promptText) {
      res.status(400).json({ error: "promptText is required" });
      return;
    }
    const template = await createPromptTemplate({
      clientId,
      stage: stage || "generate",
      version: version || 1,
      promptText,
      isActive: true,
      source: "manual",
      campaignId,
    });
    res.status(201).json(template);
  } catch (err) {
    console.error("POST /api/clients/:clientId/prompts error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/prompts/:promptId/scores - Get scores for a prompt
app.get("/api/prompts/:promptId/scores", async (req: Request, res: Response) => {
  try {
    const promptId = getParam(req, "promptId");
    const scores = await getPromptScores(promptId);
    res.json(scores);
  } catch (err) {
    console.error("GET /api/prompts/:promptId/scores error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/prompts/:promptId/scores - Record a score
app.post("/api/prompts/:promptId/scores", async (req: Request, res: Response) => {
  try {
    const promptId = getParam(req, "promptId");
    const { runId, score, gateDecision, artifactId, feedback } = req.body;
    if (!runId || score === undefined) {
      res.status(400).json({ error: "runId and score are required" });
      return;
    }
    const result = await addPromptScore({
      promptId, runId, score, gateDecision, artifactId, feedback,
    });
    res.status(201).json(result);
  } catch (err) {
    console.error("POST /api/prompts/:promptId/scores error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/prompts/:promptId/lineage - Get evolution lineage
app.get("/api/prompts/:promptId/lineage", async (req: Request, res: Response) => {
  try {
    const promptId = getParam(req, "promptId");
    const lineage = await getPromptLineage(promptId);
    res.json(lineage);
  } catch (err) {
    console.error("GET /api/prompts/:promptId/lineage error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============ Campaign Routes ============

// GET /api/clients/:clientId/campaigns - List campaigns for client
app.get("/api/clients/:clientId/campaigns", async (req: Request, res: Response) => {
  try {
    const clientId = getParam(req, "clientId");
    const campaigns = await getCampaignsByClient(clientId);
    res.json(campaigns);
  } catch (err) {
    console.error("GET /api/clients/:clientId/campaigns error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/campaigns/:campaignId - Campaign detail with deliverables
app.get("/api/campaigns/:campaignId", async (req: Request, res: Response) => {
  try {
    const campaignId = getParam(req, "campaignId");
    const campaign = await getCampaign(campaignId);
    if (!campaign) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const deliverables = await getDeliverablesByCampaign(campaignId);
    res.json({ ...campaign, deliverablesList: deliverables });
  } catch (err) {
    console.error("GET /api/campaigns/:campaignId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/clients/:clientId/campaigns - Create campaign
app.post("/api/clients/:clientId/campaigns", async (req: Request, res: Response) => {
  try {
    const clientId = getParam(req, "clientId");
    const { name, prompt, platforms, mode, maxRetries } = req.body;
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const campaign = await createCampaign({
      clientId,
      name,
      prompt,
      platforms,
      mode,
      maxRetries,
    });
    res.status(201).json(campaign);
  } catch (err) {
    console.error("POST /api/clients/:clientId/campaigns error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============ Deliverable Routes ============

// GET /api/campaigns/:campaignId/deliverables - List deliverables
app.get("/api/campaigns/:campaignId/deliverables", async (req: Request, res: Response) => {
  try {
    const campaignId = getParam(req, "campaignId");
    const deliverables = await getDeliverablesByCampaign(campaignId);
    res.json(deliverables);
  } catch (err) {
    console.error("GET /api/campaigns/:campaignId/deliverables error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/campaigns/:campaignId/deliverables - Create deliverable
app.post("/api/campaigns/:campaignId/deliverables", async (req: Request, res: Response) => {
  try {
    const campaignId = getParam(req, "campaignId");
    const { description, aiModel, originalPrompt } = req.body;
    const deliverable = await createDeliverable({
      campaignId,
      description,
      aiModel,
      originalPrompt,
    });
    res.status(201).json(deliverable);
  } catch (err) {
    console.error("POST /api/campaigns/:campaignId/deliverables error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/deliverables/:deliverableId - Deliverable detail with linked artifacts
app.get("/api/deliverables/:deliverableId", async (req: Request, res: Response) => {
  try {
    const deliverableId = getParam(req, "deliverableId");
    const deliverable = await getDeliverable(deliverableId);
    if (!deliverable) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }
    res.json(deliverable);
  } catch (err) {
    console.error("GET /api/deliverables/:deliverableId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/deliverables/:deliverableId/status - Transition deliverable status
app.patch("/api/deliverables/:deliverableId/status", async (req: Request, res: Response) => {
  try {
    const deliverableId = getParam(req, "deliverableId");
    const { status, rejectionReason, currentPrompt } = req.body;

    if (!status) {
      res.status(400).json({ error: "status is required" });
      return;
    }

    const deliverable = await getDeliverable(deliverableId);
    if (!deliverable) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }

    const updated = await updateDeliverableStatus(
      deliverableId,
      deliverable.status,
      status,
      { rejectionReason, currentPrompt },
    );
    res.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    if (msg.startsWith("Invalid deliverable transition")) {
      res.status(400).json({ error: msg });
    } else {
      console.error("PATCH /api/deliverables/:deliverableId/status error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// POST /api/deliverables/:deliverableId/regenerate - Trigger regeneration
app.post("/api/deliverables/:deliverableId/regenerate", async (req: Request, res: Response) => {
  try {
    const deliverableId = getParam(req, "deliverableId");
    const { updatedPrompt } = req.body as { updatedPrompt?: string };

    const deliverable = await getDeliverable(deliverableId);
    if (!deliverable) {
      res.status(404).json({ error: "Deliverable not found" });
      return;
    }

    if (deliverable.status !== "rejected") {
      res.status(400).json({ error: "Deliverable must be rejected before regeneration" });
      return;
    }

    // Check max retries against campaign
    const campaign = await getCampaign(deliverable.campaignId);
    if (campaign && deliverable.retryCount >= campaign.maxRetries) {
      res.status(400).json({
        error: `Max retries (${campaign.maxRetries}) reached for this deliverable`,
      });
      return;
    }

    // Update prompt if provided, then increment retry
    if (updatedPrompt) {
      await updateDeliverableStatus(deliverableId, "rejected", "regenerating", {
        currentPrompt: updatedPrompt,
      });
    } else {
      await incrementDeliverableRetry(deliverableId);
    }

    // Re-fetch to return updated state
    const updated = await getDeliverable(deliverableId);
    res.json(updated);
  } catch (err) {
    console.error("POST /api/deliverables/:deliverableId/regenerate error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============ Baseline Routes ============

// POST /api/clients/:clientId/baseline/calculate - Calculate and store a new baseline
app.post("/api/clients/:clientId/baseline/calculate", async (req: Request, res: Response) => {
  try {
    const clientId = getParam(req, "clientId");

    const client = await getClient(clientId);
    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    const brandSlug = clientId.replace("client_", "");
    const brandEngineUrl = process.env.BRAND_ENGINE_URL || "http://localhost:8100";
    const sampleLimit = req.body?.sampleLimit ?? 100;

    // Call brand-engine /baseline to compute real stats
    const engineResponse = await fetch(`${brandEngineUrl}/baseline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand_slug: brandSlug, sample_limit: sampleLimit }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!engineResponse.ok) {
      const text = await engineResponse.text();
      res.status(502).json({ error: `Brand engine error: ${text}` });
      return;
    }

    const engineResult = await engineResponse.json() as {
      gemini_baseline_z: number;
      gemini_baseline_raw: number;
      gemini_stddev: number;
      cohere_baseline_z: number;
      cohere_baseline_raw: number;
      cohere_stddev: number;
      fused_baseline_z: number;
      sample_count: number;
    };

    // Create new baseline in Supabase
    const newBaseline = await createBaseline({
      clientId,
      version: 0, // auto-incremented by createBaseline
      isActive: true,
      geminiBaselineZ: engineResult.gemini_baseline_z,
      cohereBaselineZ: engineResult.cohere_baseline_z,
      fusedBaselineZ: engineResult.fused_baseline_z,
      geminiBaselineRaw: engineResult.gemini_baseline_raw,
      cohereBaselineRaw: engineResult.cohere_baseline_raw,
      geminiStddev: engineResult.gemini_stddev,
      cohereStddev: engineResult.cohere_stddev,
      sampleCount: engineResult.sample_count,
    });

    // Deactivate all previous baselines for this client
    if (newBaseline.id) {
      await deactivateBaselines(clientId, newBaseline.id);
    }

    res.status(201).json(newBaseline);
  } catch (err) {
    console.error("POST /api/clients/:clientId/baseline/calculate error:", err);
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
