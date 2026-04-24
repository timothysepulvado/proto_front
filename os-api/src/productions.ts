import { EventEmitter } from "node:events";
import { constants, createReadStream, existsSync, mkdirSync, statSync, unlinkSync, copyFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { spawn } from "node:child_process";
import express from "express";
import type { Request, Response, Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { buildTempGenProcessEnv, getTempGenDir } from "./temp-gen-env.js";

const KNOWN_PRODUCTIONS = new Set(["drift-mv"]);
const SHOT_MIN = 1;
const SHOT_MAX = 30;

export const productionEvents = new EventEmitter();
productionEvents.setMaxListeners(100);

type ManifestShot = {
  id: number;
  section?: string;
  start_s?: number;
  end_s?: number;
  duration_s?: number;
  visual?: string;
  characters_needed?: unknown;
  veo_prompt?: string;
  still_prompt?: string;
};

type Manifest = {
  shots: ManifestShot[];
};

export type ProductionJob = {
  jobId: string;
  productionSlug: string;
  kind: "regenerate" | "render";
  shotNumber?: number;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
};

const jobs = new Map<string, ProductionJob>();
const manifestCache = new Map<string, Manifest>();

function getParam(req: Request, name: string): string {
  return req.params[name] as string;
}

function padShot(shotNumber: number): string {
  return String(shotNumber).padStart(2, "0");
}

function productionRoot(productionSlug: string): string {
  return join(getTempGenDir(), "productions", productionSlug);
}

function validateProductionSlug(slug: string): string {
  if (!KNOWN_PRODUCTIONS.has(slug)) {
    const error = new Error(`Unknown production: ${slug}`);
    error.name = "ValidationError";
    throw error;
  }
  return slug;
}

function parseShotNumber(raw: string): number {
  const shotNumber = Number.parseInt(raw, 10);
  if (!Number.isInteger(shotNumber) || String(shotNumber) !== String(raw).replace(/^0+(?=\d)/, "") || shotNumber < SHOT_MIN || shotNumber > SHOT_MAX) {
    const error = new Error(`shotNumber must be an integer from ${SHOT_MIN} to ${SHOT_MAX}`);
    error.name = "ValidationError";
    throw error;
  }
  return shotNumber;
}

function safePath(root: string, ...segments: string[]): string {
  const target = normalize(join(root, ...segments));
  const normalizedRoot = normalize(root);
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}/`)) {
    const error = new Error("Resolved path escaped production root");
    error.name = "ValidationError";
    throw error;
  }
  return target;
}

async function loadManifest(productionSlug: string): Promise<Manifest> {
  const cached = manifestCache.get(productionSlug);
  if (cached) return cached;
  const manifestPath = safePath(productionRoot(productionSlug), "manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as Manifest;
  if (!Array.isArray(parsed.shots)) {
    throw new Error(`Manifest for ${productionSlug} is missing shots[]`);
  }
  manifestCache.set(productionSlug, parsed);
  return parsed;
}

function fileMeta(path: string) {
  const stats = statSync(path);
  return {
    path,
    sizeBytes: stats.size,
    mtime: stats.mtime.toISOString(),
  };
}

function nullableFileMeta(path: string) {
  return existsSync(path) ? fileMeta(path) : null;
}

function shotPaths(productionSlug: string, shotNumber: number) {
  const root = productionRoot(productionSlug);
  const padded = padShot(shotNumber);
  return {
    root,
    canonical: safePath(root, "shots", `shot_${padded}.mp4`),
    backup: safePath(root, "shots", `shot_${padded}_v5_backup.mp4`),
    pending: safePath(root, "shots", "v5_standard", `shot_${padded}.mp4`),
    still: safePath(root, "stills", `shot_${padded}.png`),
    assembly: safePath(root, "assembly", "drift_final.mp4"),
  };
}

function currentJobForShot(productionSlug: string, shotNumber: number): ProductionJob | null {
  for (const job of jobs.values()) {
    if (job.productionSlug === productionSlug && job.shotNumber === shotNumber && job.status === "running") {
      return job;
    }
  }
  return null;
}

function currentRenderJob(productionSlug: string): ProductionJob | null {
  for (const job of jobs.values()) {
    if (job.productionSlug === productionSlug && job.kind === "render" && job.status === "running") {
      return job;
    }
  }
  return null;
}

function emitProductionEvent(productionSlug: string, payload: Record<string, unknown>): void {
  productionEvents.emit(`event:${productionSlug}`, {
    productionSlug,
    timestamp: new Date().toISOString(),
    ...payload,
  });
}

function streamProcessLines(
  productionSlug: string,
  job: ProductionJob,
  stream: NodeJS.ReadableStream,
  streamName: "stdout" | "stderr",
  eventType: "regen_log" | "render_log",
): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      emitProductionEvent(productionSlug, {
        type: eventType,
        jobId: job.jobId,
        shotNumber: job.shotNumber,
        line,
        stream: streamName,
      });
    }
  });
  stream.on("end", () => {
    if (buffer.trim()) {
      emitProductionEvent(productionSlug, {
        type: eventType,
        jobId: job.jobId,
        shotNumber: job.shotNumber,
        line: buffer,
        stream: streamName,
      });
    }
  });
}

async function buildShotCatalog(productionSlug: string) {
  const manifest = await loadManifest(productionSlug);
  const renderArtifact = nullableFileMeta(shotPaths(productionSlug, SHOT_MIN).assembly);
  const shots = manifest.shots.map((shot) => {
    const shotNumber = shot.id;
    const paths = shotPaths(productionSlug, shotNumber);
    const canonicalMeta = fileMeta(paths.canonical);
    const pending = nullableFileMeta(paths.pending);

    return {
      shotNumber,
      beat: shot.section ?? "unmapped",
      startS: shot.start_s ?? 0,
      endS: shot.end_s ?? (shot.start_s ?? 0) + (shot.duration_s ?? 0),
      durationS: shot.duration_s ?? 0,
      visualIntent: shot.visual ?? "",
      charactersNeeded: Array.isArray(shot.characters_needed)
        ? shot.characters_needed.filter((item): item is string => typeof item === "string")
        : [],
      defaultPrompt: shot.veo_prompt ?? "",
      stillPrompt: shot.still_prompt ?? "",
      canonical: {
        ...canonicalMeta,
        backupExists: existsSync(paths.backup),
      },
      pending,
      stillPath: existsSync(paths.still) ? paths.still : null,
      activeJob: currentJobForShot(productionSlug, shotNumber),
    };
  });

  return { shots, renderArtifact };
}

function sendJsonError(res: Response, err: unknown, label: string): void {
  const message = err instanceof Error ? err.message : "Unknown error";
  if (err instanceof Error && err.name === "ValidationError") {
    res.status(400).json({ error: message });
    return;
  }
  console.error(`${label} error:`, err);
  res.status(500).json({ error: "Internal server error", detail: message });
}

function createJob(productionSlug: string, kind: "regenerate" | "render", shotNumber?: number): ProductionJob {
  const job: ProductionJob = {
    jobId: uuidv4(),
    productionSlug,
    kind,
    shotNumber,
    status: "running",
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.jobId, job);
  return job;
}

function spawnProductionJob(job: ProductionJob): void {
  const startedMs = Date.now();
  const script = job.kind === "regenerate"
    ? ["productions/drift-mv/regen_hitl_standard.py", String(job.shotNumber)]
    : ["productions/drift-mv/gen_assembly.py"];
  const completeType = job.kind === "regenerate" ? "regen_complete" : "render_complete";
  const logType = job.kind === "regenerate" ? "regen_log" : "render_log";

  const proc = spawn(
    ".venv/bin/python",
    script,
    {
      cwd: getTempGenDir(),
      env: buildTempGenProcessEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  streamProcessLines(job.productionSlug, job, proc.stdout, "stdout", logType);
  streamProcessLines(job.productionSlug, job, proc.stderr, "stderr", logType);

  proc.on("error", (err) => {
    job.status = "failed";
    job.completedAt = new Date().toISOString();
    job.durationMs = Date.now() - startedMs;
    jobs.set(job.jobId, job);
    emitProductionEvent(job.productionSlug, {
      type: completeType,
      jobId: job.jobId,
      shotNumber: job.shotNumber,
      exitCode: null,
      durationMs: job.durationMs,
      error: err.message,
    });
  });

  proc.on("close", (exitCode) => {
    job.status = exitCode === 0 ? "completed" : "failed";
    job.completedAt = new Date().toISOString();
    job.durationMs = Date.now() - startedMs;
    job.exitCode = exitCode;
    jobs.set(job.jobId, job);

    emitProductionEvent(job.productionSlug, {
      type: completeType,
      jobId: job.jobId,
      shotNumber: job.shotNumber,
      exitCode,
      durationMs: job.durationMs,
    });

    if (job.kind === "render" && exitCode === 0) {
      const paths = shotPaths(job.productionSlug, SHOT_MIN);
      const artifact = nullableFileMeta(paths.assembly);
      if (artifact) {
        void loadManifest(job.productionSlug).then((manifest) => {
          const durationS = manifest.shots.reduce((sum, shot) => sum + (shot.duration_s ?? 0), 0);
          emitProductionEvent(job.productionSlug, {
            type: "render_artifact",
            jobId: job.jobId,
            path: artifact.path,
            sizeBytes: artifact.sizeBytes,
            durationS,
          });
        }).catch((err: unknown) => {
          emitProductionEvent(job.productionSlug, {
            type: "render_artifact",
            jobId: job.jobId,
            path: artifact.path,
            sizeBytes: artifact.sizeBytes,
            durationS: null,
            warning: err instanceof Error ? err.message : "Unable to read manifest duration",
          });
        });
      }
    }
  });
}

function streamFile(res: Response, path: string, contentType: string): void {
  if (!existsSync(path)) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }

  const stats = statSync(path);
  const range = res.req.headers.range;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=30");
  res.setHeader("Content-Type", contentType);

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match[2] ? Number.parseInt(match[2], 10) : stats.size - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end < stats.size) {
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${stats.size}`);
        res.setHeader("Content-Length", end - start + 1);
        createReadStream(path, { start, end }).pipe(res);
        return;
      }
    }
    res.status(416).setHeader("Content-Range", `bytes */${stats.size}`);
    res.end();
    return;
  }

  res.setHeader("Content-Length", stats.size);
  createReadStream(path).pipe(res);
}

export function createProductionsRouter(): Router {
  const router = express.Router();

  router.get("/:productionSlug/shots", async (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      const catalog = await buildShotCatalog(productionSlug);
      res.json(catalog);
    } catch (err) {
      sendJsonError(res, err, "GET /api/productions/:productionSlug/shots");
    }
  });

  router.get("/:productionSlug/events", (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      res.write(`data: ${JSON.stringify({ type: "connected", productionSlug, timestamp: new Date().toISOString() })}\n\n`);

      const listener = (payload: unknown) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      productionEvents.on(`event:${productionSlug}`, listener);
      const heartbeat = setInterval(() => {
        res.write(": heartbeat\n\n");
      }, 15000);

      req.on("close", () => {
        clearInterval(heartbeat);
        productionEvents.off(`event:${productionSlug}`, listener);
      });
    } catch (err) {
      sendJsonError(res, err, "GET /api/productions/:productionSlug/events");
    }
  });

  router.get("/:productionSlug/shots/:n/still", (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      const shotNumber = parseShotNumber(getParam(req, "n"));
      streamFile(res, shotPaths(productionSlug, shotNumber).still, "image/png");
    } catch (err) {
      sendJsonError(res, err, "GET /api/productions/:productionSlug/shots/:n/still");
    }
  });

  router.get("/:productionSlug/shots/:n/canonical.mp4", (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      const shotNumber = parseShotNumber(getParam(req, "n"));
      streamFile(res, shotPaths(productionSlug, shotNumber).canonical, "video/mp4");
    } catch (err) {
      sendJsonError(res, err, "GET /api/productions/:productionSlug/shots/:n/canonical.mp4");
    }
  });

  router.get("/:productionSlug/shots/:n/pending.mp4", (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      const shotNumber = parseShotNumber(getParam(req, "n"));
      streamFile(res, shotPaths(productionSlug, shotNumber).pending, "video/mp4");
    } catch (err) {
      sendJsonError(res, err, "GET /api/productions/:productionSlug/shots/:n/pending.mp4");
    }
  });

  router.post("/:productionSlug/shots/:n/regenerate", async (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      const shotNumber = parseShotNumber(getParam(req, "n"));
      const body = (req.body ?? {}) as { prompt?: string; useImageConditioning?: boolean };
      const manifest = await loadManifest(productionSlug);
      const shot = manifest.shots.find((item) => item.id === shotNumber);
      if (!shot) {
        res.status(404).json({ error: "Shot not found" });
        return;
      }

      const activeJob = currentJobForShot(productionSlug, shotNumber);
      if (activeJob) {
        res.status(409).json({ error: "Shot regeneration already running", jobId: activeJob.jobId, status: activeJob.status });
        return;
      }

      const job = createJob(productionSlug, "regenerate", shotNumber);
      emitProductionEvent(productionSlug, {
        type: "regen_started",
        jobId: job.jobId,
        shotNumber,
        promptSource: body.prompt?.trim() ? "override" : "manifest",
        useImageConditioning: body.useImageConditioning ?? true,
      });
      spawnProductionJob(job);
      res.status(202).json({ jobId: job.jobId, status: "running" });
    } catch (err) {
      sendJsonError(res, err, "POST /api/productions/:productionSlug/shots/:n/regenerate");
    }
  });

  router.post("/:productionSlug/shots/:n/promote", (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      const shotNumber = parseShotNumber(getParam(req, "n"));
      const paths = shotPaths(productionSlug, shotNumber);

      if (!existsSync(paths.pending)) {
        res.json({ shotNumber, promoted: false, backupCreated: false, reason: "no_pending_artifact" });
        return;
      }

      let backupCreated = false;
      if (existsSync(paths.canonical) && !existsSync(paths.backup)) {
        copyFileSync(paths.canonical, paths.backup, constants.COPYFILE_EXCL);
        backupCreated = true;
      }

      mkdirSync(join(paths.root, "shots"), { recursive: true });
      copyFileSync(paths.pending, paths.canonical);
      unlinkSync(paths.pending);

      emitProductionEvent(productionSlug, {
        type: "shot_promoted",
        shotNumber,
        backupCreated,
      });
      res.json({ shotNumber, promoted: true, backupCreated });
    } catch (err) {
      sendJsonError(res, err, "POST /api/productions/:productionSlug/shots/:n/promote");
    }
  });

  router.post("/:productionSlug/shots/:n/reject", (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      const shotNumber = parseShotNumber(getParam(req, "n"));
      const pending = shotPaths(productionSlug, shotNumber).pending;
      const existed = existsSync(pending);
      if (existed) unlinkSync(pending);
      emitProductionEvent(productionSlug, {
        type: "shot_rejected",
        shotNumber,
        pendingDeleted: existed,
      });
      res.json({ shotNumber, rejected: true, pendingDeleted: existed });
    } catch (err) {
      sendJsonError(res, err, "POST /api/productions/:productionSlug/shots/:n/reject");
    }
  });

  router.post("/:productionSlug/render", (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      const activeJob = currentRenderJob(productionSlug);
      if (activeJob) {
        res.status(409).json({ error: "Render already running", jobId: activeJob.jobId, status: activeJob.status });
        return;
      }
      const job = createJob(productionSlug, "render");
      emitProductionEvent(productionSlug, { type: "render_started", jobId: job.jobId });
      spawnProductionJob(job);
      res.status(202).json({ jobId: job.jobId, status: "running" });
    } catch (err) {
      sendJsonError(res, err, "POST /api/productions/:productionSlug/render");
    }
  });

  router.get("/:productionSlug/jobs", (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      res.json({ jobs: [...jobs.values()].filter((job) => job.productionSlug === productionSlug) });
    } catch (err) {
      sendJsonError(res, err, "GET /api/productions/:productionSlug/jobs");
    }
  });

  return router;
}
