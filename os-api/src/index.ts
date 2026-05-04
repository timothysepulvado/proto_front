import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import { createReadStream } from "fs";
import path from "path";
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
  getArtifactById,
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
  createBaseline,
  deactivateBaselines,
  listKnownLimitations,
  getKnownLimitation,
  getLimitationByFailureMode,
  createKnownLimitation,
  updateKnownLimitation,
  listEscalations,
  getEscalation,
  getEscalationByArtifact,
  listEscalationsByRun,
  updateEscalation,
  getOrchestrationDecisions,
  getOrchestrationDecisionsByRun,
  getShotSummaries,
  getRecentRunsByCampaign,
  getRunDetail,
  getMotionPhaseGateState,
  getDirectionDriftIndicatorsByCampaign,
  getArtifactsForDeliverableWithVerdicts,
} from "./db.js";
import { decideEscalation } from "./orchestrator.js";
import { getPlatformVariants, PLATFORM_SPECS } from "./cloudinary.js";
import { executeRun, cancelRun, runEvents } from "./runner.js";
import { createProductionsRouter } from "./productions.js";
import { getTempGenDir } from "./temp-gen-env.js";
import { ForbiddenPathError, PathNotFoundError, resolveExistingRealPathInsideAllowedRoots } from "./path-security.js";
import { validateCampaignClientScope, validateRunModeFeatureFlag } from "./run-create-guards.js";
import { CLIENT_JWT_EXPIRES_IN_SECONDS, mintClientJwt } from "./auth.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "75mb" }));
app.use("/api/productions", createProductionsRouter());

// Helper to extract params safely
function getParam(req: Request, name: string): string {
  return req.params[name] as string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function artifactLocalPathFromMetadata(value: unknown): string | null {
  const metadata = isRecord(value) ? value : null;
  const localPath = metadata && typeof metadata.localPath === "string" ? metadata.localPath : null;
  return localPath && localPath.trim().length > 0 ? localPath : null;
}

function imageContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

// ============ Auth Routes ============

// POST /api/auth/client-token - Mint a client-scoped Supabase JWT for direct HUD reads
app.post("/api/auth/client-token", async (req: Request, res: Response) => {
  try {
    const { clientId } = (req.body ?? {}) as { clientId?: unknown };
    if (typeof clientId !== "string" || clientId.trim().length === 0) {
      res.status(400).json({ error: "clientId required" });
      return;
    }

    const token = await mintClientJwt(clientId);
    res.json({ token, expiresIn: CLIENT_JWT_EXPIRES_IN_SECONDS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

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
    const { mode, campaignId, deliverableIds, inputs, auditMode, shotIds } = req.body as RunCreatePayload;

    if (!mode || !STAGE_DEFINITIONS[mode]) {
      res.status(400).json({ error: "Invalid mode" });
      return;
    }
    const modeFlag = validateRunModeFeatureFlag(mode);
    if (!modeFlag.ok) {
      res.status(modeFlag.status).json({ error: modeFlag.error });
      return;
    }

    // ADR-004 Phase B: validate auditMode shape + scope.
    // - auditMode is opt-in for mode === "stills"; ignored otherwise (logged
    //   so misconfiguration surfaces in run history).
    // - auditMode: true requires campaignId — audit fans out across the
    //   campaign's locked stills, so a scope is mandatory.
    if (auditMode !== undefined && typeof auditMode !== "boolean") {
      res.status(400).json({ error: "auditMode must be boolean" });
      return;
    }
    if (mode === "stills" && auditMode === true && !campaignId) {
      res.status(400).json({ error: "auditMode=true requires campaignId" });
      return;
    }

    // Phase B+ targeted-regen (2026-04-30): validate shotIds shape + scope.
    // - shotIds is opt-in for mode === "stills" + auditMode !== true; rejected
    //   for other modes / audit-mode runs (audit fans out across the campaign,
    //   shotIds would be ambiguous there).
    // - Every entry must be a positive integer in [1, 100] (manifest shot ids
    //   are 1-based; 100 is a generous upper bound for any future production).
    let normalizedShotIds: number[] | undefined;
    if (shotIds !== undefined) {
      if (!Array.isArray(shotIds) || shotIds.length === 0) {
        res.status(400).json({ error: "shotIds must be a non-empty array of integers when provided" });
        return;
      }
      if (mode !== "stills" || auditMode === true) {
        res.status(400).json({
          error: "shotIds is only valid for mode=stills with auditMode=false (in-loop targeted regen)",
        });
        return;
      }
      if (!campaignId) {
        res.status(400).json({ error: "shotIds requires campaignId" });
        return;
      }
      const invalid = shotIds.find(
        (s) => typeof s !== "number" || !Number.isInteger(s) || s < 1 || s > 100,
      );
      if (invalid !== undefined) {
        res.status(400).json({
          error: `shotIds entries must be integers in [1, 100]; got ${JSON.stringify(invalid)}`,
        });
        return;
      }
      // De-dup while preserving order — the runner's iteration matches input
      // order so operators can prioritize.
      const seen = new Set<number>();
      normalizedShotIds = [];
      for (const s of shotIds) {
        if (!seen.has(s)) {
          seen.add(s);
          normalizedShotIds.push(s);
        }
      }
    }

    let normalizedDeliverableIds: string[] | undefined;
    if (deliverableIds !== undefined) {
      if (!Array.isArray(deliverableIds) || deliverableIds.length === 0) {
        res.status(400).json({ error: "deliverableIds must be a non-empty array of strings when provided" });
        return;
      }
      if (!campaignId) {
        res.status(400).json({ error: "deliverableIds requires campaignId" });
        return;
      }
      const invalid = deliverableIds.find((id) => typeof id !== "string" || id.trim().length === 0);
      if (invalid !== undefined) {
        res.status(400).json({ error: `deliverableIds entries must be non-empty strings; got ${JSON.stringify(invalid)}` });
        return;
      }
      const seen = new Set<string>();
      normalizedDeliverableIds = [];
      for (const id of deliverableIds) {
        const trimmed = id.trim();
        if (!seen.has(trimmed)) {
          seen.add(trimmed);
          normalizedDeliverableIds.push(trimmed);
        }
      }
    }

    if (inputs !== undefined && !isRecord(inputs)) {
      res.status(400).json({ error: "inputs must be an object when provided" });
      return;
    }

    const client = await getClient(clientId);
    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    if (campaignId) {
      const campaign = await getCampaign(campaignId);
      const campaignScope = validateCampaignClientScope(campaign, clientId);
      if (!campaignScope.ok) {
        res.status(campaignScope.status).json({ error: campaignScope.error });
        return;
      }
    }

    if (campaignId && normalizedDeliverableIds && normalizedDeliverableIds.length > 0) {
      const campaignDeliverables = await getDeliverablesByCampaign(campaignId);
      const allowedDeliverableIds = new Set(campaignDeliverables.map((deliverable) => deliverable.id));
      const outOfScope = normalizedDeliverableIds.find((id) => !allowedDeliverableIds.has(id));
      if (outOfScope) {
        res.status(400).json({ error: `deliverableId ${outOfScope} does not belong to campaign ${campaignId}` });
        return;
      }
    }

    const now = new Date().toISOString();
    const stages = STAGE_DEFINITIONS[mode].map((s) => ({
      ...s,
      status: "pending" as const,
    }));

    // ADR-004 Phase B (revision after migration 011_runs_metadata.sql):
    // persist auditMode on the run row at creation time. Survives os-api
    // restart mid-run; the runner reads run.metadata.audit_mode at exec time
    // and the HUD can show audit-vs-in-loop status without an in-memory
    // round-trip. Tim authorized migration 011 explicitly 2026-04-29 PM.
    const runMetadata: Record<string, unknown> = {};
    if (mode === "stills") {
      runMetadata.audit_mode = auditMode ?? false;
      // Phase B+ targeted-regen: persist normalized shotIds so the runner
      // (which reads run.metadata at exec time) can scope iteration. Survives
      // os-api restart mid-run, same as audit_mode.
      if (normalizedShotIds && normalizedShotIds.length > 0) {
        runMetadata.shot_ids = normalizedShotIds;
      }
    }
    if (normalizedDeliverableIds && normalizedDeliverableIds.length > 0) {
      runMetadata.deliverable_ids = normalizedDeliverableIds;
    }
    if (isRecord(inputs)) {
      runMetadata.inputs = inputs;
      const parentRunId = typeof inputs.parentRunId === "string" && inputs.parentRunId.trim().length > 0
        ? inputs.parentRunId.trim()
        : undefined;
      if (parentRunId) runMetadata.parentRunId = parentRunId;
      if (isRecord(inputs.motionPhaseGate)) {
        runMetadata.motion_phase_gate = inputs.motionPhaseGate;
      }
    }

    const run: Run = {
      runId: uuidv4(),
      clientId,
      campaignId,
      mode,
      status: "pending",
      stages,
      createdAt: now,
      updatedAt: now,
      metadata: runMetadata,
    };

    const created = await createRun(run);

    // Start execution asynchronously. opts is now optional (kept on
    // executeRun for any future runtime override that shouldn't persist).
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

// GET /api/runs/:runId/detail - Run drawer payload for HUD operators
app.get("/api/runs/:runId/detail", async (req: Request, res: Response) => {
  try {
    const runId = getParam(req, "runId");
    const detail = await getRunDetail(runId);
    if (!detail) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json(detail);
  } catch (err) {
    console.error("GET /api/runs/:runId/detail error:", err);
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

    // Listen for escalation events (10d-pre-1, closes gap 10c-1).
    // Two payload shapes ride this channel:
    //   • watcher_signal — { type:"watcher_signal", escalationId, artifactId,
    //     cumulativeCost, perShotHardCap, consecutiveSameRegens, levelsUsed,
    //     warnBudget, warnLoop } — emitted before each orchestrator call by
    //     escalation_loop.ts so a human SSE consumer can hit cancel if cost
    //     or loop signals look wrong.
    //   • escalation status update — the AssetEscalation row shape (id,
    //     status, currentLevel, ...) — emitted at every status transition.
    // Wrap with `type:"escalation"` so wire consumers can branch on the
    // discriminator first, then inspect inner shape (e.g.
    // payload.type === "watcher_signal") for sub-typing. Existing log writes
    // stay raw (additive change, no break for legacy consumers).
    const escalationListener = (event: unknown) => {
      res.write(`data: ${JSON.stringify({ type: "escalation", payload: event })}\n\n`);
    };

    const completeListener = (result: unknown) => {
      res.write(`event: complete\ndata: ${JSON.stringify(result)}\n\n`);
      cleanup();
      res.end();
    };

    runEvents.on(`log:${runId}`, logListener);
    runEvents.on(`escalation:${runId}`, escalationListener);
    runEvents.once(`complete:${runId}`, completeListener);

    const cleanup = () => {
      runEvents.off(`log:${runId}`, logListener);
      runEvents.off(`escalation:${runId}`, escalationListener);
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
      clientId: run.clientId,
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
      clientId: run.clientId,
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

// GET /api/deliverables/:deliverableId/iterations - Regen artifacts + critic verdicts
app.get("/api/deliverables/:deliverableId/iterations", async (req: Request, res: Response) => {
  try {
    const deliverableId = getParam(req, "deliverableId");
    const iterations = await getArtifactsForDeliverableWithVerdicts(deliverableId);
    res.json(iterations);
  } catch (err) {
    console.error("GET /api/deliverables/:deliverableId/iterations error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/artifacts/:artifactId/file - Stream trusted local artifact file fallback
app.get("/api/artifacts/:artifactId/file", async (req: Request, res: Response) => {
  try {
    const artifactId = getParam(req, "artifactId");
    const artifact = await getArtifactById(artifactId);
    if (!artifact) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }

    const tempGenRoot = getTempGenDir();
    const localPath = artifactLocalPathFromMetadata(artifact.metadata)
      ?? (artifact.path.startsWith("/") ? artifact.path : null);
    if (!localPath) {
      res.status(404).json({ error: "No local artifact file path available" });
      return;
    }

    let resolved: string;
    try {
      resolved = resolveExistingRealPathInsideAllowedRoots(localPath, [tempGenRoot], {
        missingMessage: "Artifact file not found on disk",
        missingRootMessage: "Configured Temp-gen root not found on disk",
        forbiddenMessage: "Artifact file is outside the configured Temp-gen root",
      });
    } catch (err) {
      if (err instanceof ForbiddenPathError) {
        res.status(403).json({ error: err.message });
        return;
      }
      if (err instanceof PathNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }

    res.setHeader("Content-Type", imageContentType(resolved));
    res.setHeader("Cache-Control", "private, max-age=60");
    createReadStream(resolved).pipe(res);
  } catch (err) {
    console.error("GET /api/artifacts/:artifactId/file error:", err);
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

// ============ Platform Variant Routes ============

// GET /api/artifacts/:artifactId/platforms - Get platform-specific variant URLs
app.get("/api/artifacts/:artifactId/platforms", async (req: Request, res: Response) => {
  try {
    const artifactId = getParam(req, "artifactId");
    const artifact = await getArtifactById(artifactId);
    if (!artifact) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }

    const cloudinaryPublicId = (artifact.metadata as Record<string, unknown> | undefined)?.cloudinaryPublicId as string | undefined;
    if (!cloudinaryPublicId) {
      res.status(404).json({
        error: "No Cloudinary ID found for this artifact",
        hint: "Asset must be uploaded with Cloudinary configured to generate platform variants",
      });
      return;
    }

    // Optional platform filter from query string
    const platformsParam = req.query.platforms as string | undefined;
    const platformFilter = platformsParam
      ? platformsParam.split(",").map((p) => p.trim()).filter(Boolean)
      : undefined;

    const variants = getPlatformVariants(cloudinaryPublicId, platformFilter);

    res.json({
      artifactId: artifact.id,
      artifactName: artifact.name,
      sourceUrl: artifact.path,
      availablePlatforms: Object.keys(PLATFORM_SPECS),
      variants,
    });
  } catch (err) {
    console.error("GET /api/artifacts/:artifactId/platforms error:", err);
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

// GET /api/campaigns/:campaignId/recent-runs - Last N campaign runs for HUD workspace
app.get("/api/campaigns/:campaignId/recent-runs", async (req: Request, res: Response) => {
  try {
    const campaignId = getParam(req, "campaignId");
    const rawLimit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 10;
    const limit = Number.isFinite(rawLimit) ? rawLimit : 10;
    const runs = await getRecentRunsByCampaign(campaignId, limit);
    res.json(runs);
  } catch (err) {
    console.error("GET /api/campaigns/:campaignId/recent-runs error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/campaigns/:campaignId/motion-phase-gate - Stills → Veo handoff state
app.get("/api/campaigns/:campaignId/motion-phase-gate", async (req: Request, res: Response) => {
  try {
    const campaignId = getParam(req, "campaignId");
    const state = await getMotionPhaseGateState(campaignId);
    res.json(state);
  } catch (err) {
    console.error("GET /api/campaigns/:campaignId/motion-phase-gate error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/campaigns/:campaignId/direction-drift - Per-shot direction drift badges
app.get("/api/campaigns/:campaignId/direction-drift", async (req: Request, res: Response) => {
  try {
    const campaignId = getParam(req, "campaignId");
    const indicatorMap = await getDirectionDriftIndicatorsByCampaign(campaignId);
    res.json(Object.fromEntries(indicatorMap.entries()));
  } catch (err) {
    console.error("GET /api/campaigns/:campaignId/direction-drift error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

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

// GET /api/campaigns/:campaignId/shot-summaries - Shot-level observability
//
// Chunk 2 (HUD observability MVP) — aggregates campaign_deliverables +
// latest artifact.metadata.narrative_context + asset_escalations +
// orchestration_decisions into one row per deliverable so the HUD's
// DeliverableTracker can render shot numbers, L-badges, cost badges, and
// verdict state without 4 round-trips per card.
//
// Optional ?run_id=<uuid> filter narrows artifacts / escalations / decisions
// to that run so a live regrade's metrics don't bleed across prior runs.
app.get("/api/campaigns/:campaignId/shot-summaries", async (req: Request, res: Response) => {
  try {
    const campaignId = getParam(req, "campaignId");
    const runId = typeof req.query.run_id === "string" ? req.query.run_id : undefined;
    const summaries = await getShotSummaries(campaignId, runId);
    res.json(summaries);
  } catch (err) {
    console.error("GET /api/campaigns/:campaignId/shot-summaries error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/campaigns/:campaignId/deliverables - Create deliverable
app.post("/api/campaigns/:campaignId/deliverables", async (req: Request, res: Response) => {
  try {
    const campaignId = getParam(req, "campaignId");
    const campaign = await getCampaign(campaignId);
    if (!campaign) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const {
      description, aiModel, originalPrompt,
      format, mediaType, durationSeconds, aspectRatio,
      resolution, platform, qualityTier, referenceImages, estimatedCost,
    } = req.body;
    const deliverable = await createDeliverable({
      clientId: campaign.clientId,
      campaignId,
      description,
      aiModel,
      originalPrompt,
      format,
      mediaType,
      durationSeconds,
      aspectRatio,
      resolution,
      platform,
      qualityTier,
      referenceImages,
      estimatedCost,
    });
    res.status(201).json(deliverable);
  } catch (err) {
    console.error("POST /api/campaigns/:campaignId/deliverables error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/campaigns/:campaignId/estimate-cost - Estimate generation cost for campaign deliverables
app.post("/api/campaigns/:campaignId/estimate-cost", async (req: Request, res: Response) => {
  try {
    const campaignId = getParam(req, "campaignId");
    const deliverables = await getDeliverablesByCampaign(campaignId);

    if (deliverables.length === 0) {
      res.json({ campaignId, deliverables: [], totalCost: 0 });
      return;
    }

    const tempGenUrl = process.env.TEMP_GEN_URL || "http://localhost:8200";
    const estimates: Array<{ deliverableId: string; description?: string; estimatedCost: number }> = [];
    let totalCost = 0;

    for (const d of deliverables) {
      try {
        const estimateResponse = await fetch(`${tempGenUrl}/estimate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            media_type: d.mediaType === "video" ? "video" : "image",
            model: d.aiModel,
            duration_seconds: d.durationSeconds,
            quality_tier: d.qualityTier ?? "standard",
            image_size: d.resolution,
          }),
          signal: AbortSignal.timeout(5_000),
        });

        if (estimateResponse.ok) {
          const data = await estimateResponse.json() as { total_cost: number };
          estimates.push({
            deliverableId: d.id,
            description: d.description,
            estimatedCost: data.total_cost,
          });
          totalCost += data.total_cost;
        } else {
          estimates.push({ deliverableId: d.id, description: d.description, estimatedCost: 0 });
        }
      } catch {
        estimates.push({ deliverableId: d.id, description: d.description, estimatedCost: 0 });
      }
    }

    res.json({ campaignId, deliverables: estimates, totalCost: Math.round(totalCost * 10000) / 10000 });
  } catch (err) {
    console.error("POST /api/campaigns/:campaignId/estimate-cost error:", err);
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

// ============ Known Limitations (migration 007) ============

// GET /api/known-limitations - List catalog (filter by model, category, severity)
app.get("/api/known-limitations", async (req: Request, res: Response) => {
  try {
    const { model, category, severity } = req.query;
    const limits = await listKnownLimitations({
      model: typeof model === "string" ? model : undefined,
      category: typeof category === "string" ? category : undefined,
      severity: severity === "blocking" || severity === "warning" ? severity : undefined,
    });
    res.json(limits);
  } catch (err) {
    console.error("GET /api/known-limitations error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/known-limitations/:id - Get one
app.get("/api/known-limitations/:id", async (req: Request, res: Response) => {
  try {
    const id = getParam(req, "id");
    const limit = await getKnownLimitation(id);
    if (!limit) return res.status(404).json({ error: "Known limitation not found" });
    res.json(limit);
  } catch (err) {
    console.error("GET /api/known-limitations/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/known-limitations - Add new (auto-discovered by orchestrator OR manual)
app.post("/api/known-limitations", async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      model: string;
      category: string;
      failureMode: string;
      description: string;
      mitigation?: string;
      severity?: "warning" | "blocking";
      detectedInProductionId?: string;
      detectedInRunId?: string;
    };
    if (!body.model || !body.category || !body.failureMode || !body.description) {
      return res.status(400).json({ error: "model, category, failureMode, description are required" });
    }
    // Idempotent on failureMode — if it exists, return existing
    const existing = await getLimitationByFailureMode(body.failureMode);
    if (existing) return res.status(200).json(existing);
    const created = await createKnownLimitation({
      model: body.model,
      category: body.category,
      failureMode: body.failureMode,
      description: body.description,
      mitigation: body.mitigation,
      severity: body.severity ?? "warning",
      detectedInProductionId: body.detectedInProductionId,
      detectedInRunId: body.detectedInRunId,
    });
    res.status(201).json(created);
  } catch (err) {
    console.error("POST /api/known-limitations error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/known-limitations/:id - Update mitigation/description as we learn
app.patch("/api/known-limitations/:id", async (req: Request, res: Response) => {
  try {
    const id = getParam(req, "id");
    const body = req.body as { description?: string; mitigation?: string; severity?: "warning" | "blocking" };
    const updated = await updateKnownLimitation(id, body);
    res.json(updated);
  } catch (err) {
    console.error("PATCH /api/known-limitations/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============ Asset Escalations ============

// GET /api/escalations - List (filter by status, run, campaign, client)
app.get("/api/escalations", async (req: Request, res: Response) => {
  try {
    const { status, runId, campaignId, clientId } = req.query;
    const items = await listEscalations({
      status: typeof status === "string" ? (status as never) : undefined,
      runId: typeof runId === "string" ? runId : undefined,
      campaignId: typeof campaignId === "string" ? campaignId : undefined,
      clientId: typeof clientId === "string" ? clientId : undefined,
    });
    res.json(items);
  } catch (err) {
    console.error("GET /api/escalations error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/escalations/:id - Get one with full orchestration_decisions history
app.get("/api/escalations/:id", async (req: Request, res: Response) => {
  try {
    const id = getParam(req, "id");
    const escalation = await getEscalation(id);
    if (!escalation) return res.status(404).json({ error: "Escalation not found" });
    const decisions = await getOrchestrationDecisions(id);
    res.json({ ...escalation, decisions });
  } catch (err) {
    console.error("GET /api/escalations/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/escalations/:id/resolve - Operator resolves an open escalation.
app.patch("/api/escalations/:id/resolve", async (req: Request, res: Response) => {
  try {
    const id = getParam(req, "id");
    const body = req.body as {
      status?: unknown;
      resolution_path?: unknown;
      resolutionPath?: unknown;
      resolution_notes?: unknown;
      resolutionNotes?: unknown;
    };

    const status = body.status;
    const resolutionPath = body.resolution_path ?? body.resolutionPath;
    const resolutionNotes = body.resolution_notes ?? body.resolutionNotes;

    if (status !== "accepted") {
      res.status(400).json({ error: "Only status='accepted' is supported by this Review Gate resolver" });
      return;
    }
    if (resolutionPath !== "accept") {
      res.status(400).json({ error: "resolution_path must be 'accept'" });
      return;
    }
    if (typeof resolutionNotes !== "string" || resolutionNotes.trim().length === 0) {
      res.status(400).json({ error: "resolution_notes is required" });
      return;
    }
    if (resolutionNotes.length > 2000) {
      res.status(400).json({ error: "resolution_notes must be 2000 characters or less" });
      return;
    }

    const existing = await getEscalation(id);
    if (!existing) {
      res.status(404).json({ error: "Escalation not found" });
      return;
    }

    const openStatuses = new Set(["hitl_required", "in_progress"]);
    if (!openStatuses.has(existing.status)) {
      if (existing.status === "accepted" && existing.resolutionPath === "accept") {
        res.json({ escalation: existing, runHitlCleared: false, alreadyResolved: true });
        return;
      }
      res.status(409).json({ error: `Escalation is already terminal (${existing.status})` });
      return;
    }

    const resolvedAt = new Date().toISOString();
    const updated = await updateEscalation(id, {
      status: "accepted",
      resolutionPath: "accept",
      resolutionNotes: resolutionNotes.trim(),
      resolvedAt,
    });

    let runHitlCleared = false;
    if (updated.runId) {
      const runEscalations = await listEscalationsByRun(updated.runId);
      const hasOtherOpenEscalations = runEscalations.some(
        (item) => item.id !== updated.id && openStatuses.has(item.status),
      );

      if (!hasOtherOpenEscalations) {
        const run = await getRun(updated.runId);
        if (run?.hitlRequired) {
          await updateRun(updated.runId, { hitlRequired: false });
          runHitlCleared = true;
        }
      }

      runEvents.emit(`escalation:${updated.runId}`, updated);
    }

    res.json({ escalation: updated, runHitlCleared });
  } catch (err) {
    console.error("PATCH /api/escalations/:id/resolve error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/artifacts/:id/escalation - Get escalation for an artifact (null if none)
app.get("/api/artifacts/:id/escalation", async (req: Request, res: Response) => {
  try {
    const id = getParam(req, "id");
    const escalation = await getEscalationByArtifact(id);
    if (!escalation) return res.status(404).json({ error: "No escalation for this artifact" });
    res.json(escalation);
  } catch (err) {
    console.error("GET /api/artifacts/:id/escalation error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/campaigns/:campaignId/escalations - Campaign-level dashboard
app.get("/api/campaigns/:campaignId/escalations", async (req: Request, res: Response) => {
  try {
    const campaignId = getParam(req, "campaignId");
    const items = await listEscalations({ campaignId });
    res.json(items);
  } catch (err) {
    console.error("GET /api/campaigns/:campaignId/escalations error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============ Run Escalation Report (Final HITL surface) ============

// GET /api/runs/:runId/escalation-report - Full report for final HITL
app.get("/api/runs/:runId/escalation-report", async (req: Request, res: Response) => {
  try {
    const runId = getParam(req, "runId");
    const run = await getRun(runId);
    if (!run) return res.status(404).json({ error: "Run not found" });

    const escalations = await listEscalationsByRun(runId);
    const decisions = await getOrchestrationDecisionsByRun(runId);
    const artifacts = await getArtifactsByRun(runId);

    // Group per deliverable
    const deliverableIds = [...new Set(artifacts.map((a) => a.deliverableId).filter(Boolean))] as string[];
    const deliverableTrails = await Promise.all(
      deliverableIds.map(async (dId) => {
        const d = await getDeliverable(dId);
        const dEscalations = escalations.filter((e) => e.deliverableId === dId);
        const dDecisions = decisions.filter((x) => dEscalations.some((e) => e.id === x.escalationId));
        const knownLimitationIds = [...new Set(dEscalations.map((e) => e.knownLimitationId).filter(Boolean))] as string[];
        const knownLimitationsHit = (await Promise.all(knownLimitationIds.map((lid) => getKnownLimitation(lid)))).filter(Boolean);
        return {
          deliverable: d,
          escalations: dEscalations,
          decisionHistory: dDecisions,
          knownLimitationsHit,
          totalRegenCost: dDecisions.reduce((sum, x) => sum + (x.cost ?? 0), 0),
        };
      }),
    );

    const totalOrchCost = decisions.reduce((sum, d) => sum + (d.cost ?? 0), 0);
    const limitationCounts = new Map<string, number>();
    escalations.forEach((e) => {
      if (e.failureClass) limitationCounts.set(e.failureClass, (limitationCounts.get(e.failureClass) ?? 0) + 1);
    });

    res.json({
      runId: run.runId,
      clientId: run.clientId,
      campaignId: run.campaignId,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      deliverables: deliverableTrails,
      aggregate: {
        totalEscalations: escalations.length,
        totalOrchestratorCalls: decisions.length,
        totalOrchestratorCost: totalOrchCost,
        totalGenerationCost: 0, // TODO: aggregate from artifact.metadata.cost if available
        knownLimitationsHit: [...limitationCounts.entries()].map(([failureMode, count]) => ({ failureMode, count })),
      },
      finalHitl: run.hitlRequired
        ? {
            status: run.status === "completed" ? "approved" : run.status === "failed" ? "rejected" : "pending",
            reviewedAt: run.completedAt,
            reviewerNotes: run.hitlNotes,
          }
        : undefined,
    });
  } catch (err) {
    console.error("GET /api/runs/:runId/escalation-report error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/runs/:runId/final-hitl/approve - Client passes the bundle → completed
app.post("/api/runs/:runId/final-hitl/approve", async (req: Request, res: Response) => {
  try {
    const runId = getParam(req, "runId");
    const body = req.body as { notes?: string; reviewerId?: string };
    const run = await getRun(runId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const updated = await updateRun(runId, {
      status: "completed",
      hitlNotes: body.notes,
      completedAt: new Date().toISOString(),
    });
    runEvents.emit(`complete:${runId}`, { runId, status: "completed" });
    res.json(updated);
  } catch (err) {
    console.error("POST /api/runs/:runId/final-hitl/approve error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/runs/:runId/final-hitl/reject - Client rejects → triggers new orchestrator loop run
app.post("/api/runs/:runId/final-hitl/reject", async (req: Request, res: Response) => {
  try {
    const runId = getParam(req, "runId");
    const body = req.body as { notes: string; deliverableIds?: string[] };
    if (!body.notes) return res.status(400).json({ error: "notes (rejection message) is required" });
    const run = await getRun(runId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    await updateRun(runId, {
      status: "needs_review",
      hitlNotes: body.notes,
    });
    // Create a new run in 'full' mode for the same client/campaign, carrying the rejection
    const newRunId = uuidv4();
    const newRun: Run = {
      runId: newRunId,
      clientId: run.clientId,
      campaignId: run.campaignId,
      mode: "full",
      status: "pending",
      stages: STAGE_DEFINITIONS.full.map((s) => ({ ...s, status: "pending" })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hitlRequired: false,
      hitlNotes: `Triggered by rejection of run ${runId}: ${body.notes}`,
    };
    await createRun(newRun);
    executeRun(newRun).catch((err) => console.error(`Rejection-triggered run ${newRunId} failed:`, err));
    res.status(202).json({ originalRunId: runId, newRunId, status: "rejected_rerun_queued" });
  } catch (err) {
    console.error("POST /api/runs/:runId/final-hitl/reject error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============ Orchestrator (introspection + dev replay) ============

// GET /api/orchestrator/decisions/:escalationId - Full decision history
app.get("/api/orchestrator/decisions/:escalationId", async (req: Request, res: Response) => {
  try {
    const escalationId = getParam(req, "escalationId");
    const decisions = await getOrchestrationDecisions(escalationId);
    res.json(decisions);
  } catch (err) {
    console.error("GET /api/orchestrator/decisions/:escalationId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/orchestrator/replay - Dev-only: replay an escalation input to test orchestrator changes
app.post("/api/orchestrator/replay", async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      artifact: unknown;
      qaVerdict: unknown;
      promptHistory?: unknown[];
      escalationLevel?: "L1" | "L2" | "L3";
      attemptCount?: number;
      deliverableId?: string;
      campaignId?: string;
      brandSlug: string;
    };
    if (!body.artifact || !body.qaVerdict || !body.brandSlug) {
      return res.status(400).json({ error: "artifact, qaVerdict, and brandSlug are required" });
    }
    const catalog = await listKnownLimitations();
    const deliverable = body.deliverableId ? await getDeliverable(body.deliverableId) : null;
    const campaign = body.campaignId ? await getCampaign(body.campaignId) : null;
    if (!deliverable) {
      return res.status(400).json({ error: "deliverableId required to replay orchestrator" });
    }
    const result = await decideEscalation({
      artifact: body.artifact as never,
      qaVerdict: body.qaVerdict as never,
      promptHistory: (body.promptHistory as never) ?? [],
      knownLimitationsCatalog: catalog,
      attemptCount: body.attemptCount ?? 0,
      escalationLevel: body.escalationLevel ?? "L1",
      deliverable,
      campaignContext: {
        prompt: campaign?.prompt,
        brandSlug: body.brandSlug,
      },
      // Replay is a dev endpoint; inject today's date same way escalation_loop does
      todayDate: new Date().toISOString().slice(0, 10),
    });
    res.json(result);
  } catch (err) {
    console.error("POST /api/orchestrator/replay error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
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
