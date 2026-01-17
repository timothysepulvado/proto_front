import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import type { Run, RunLog, Artifact, Client, RunStatus } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "runs.db");

// Ensure data directory exists
import fs from "fs";
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db: InstanceType<typeof Database> = new Database(DB_PATH);

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    runId TEXT PRIMARY KEY,
    clientId TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    stages TEXT NOT NULL DEFAULT '[]',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    startedAt TEXT,
    completedAt TEXT,
    error TEXT,
    hitlRequired INTEGER DEFAULT 0,
    hitlNotes TEXT
  );

  CREATE TABLE IF NOT EXISTS run_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    runId TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    stage TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    FOREIGN KEY (runId) REFERENCES runs(runId)
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    runId TEXT NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (runId) REFERENCES runs(runId)
  );

  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    lastRunId TEXT,
    lastRunAt TEXT,
    lastRunStatus TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_runs_clientId ON runs(clientId);
  CREATE INDEX IF NOT EXISTS idx_run_logs_runId ON run_logs(runId);
  CREATE INDEX IF NOT EXISTS idx_artifacts_runId ON artifacts(runId);
`);

// Run operations
export function createRun(run: Run): Run {
  const stmt = db.prepare(`
    INSERT INTO runs (runId, clientId, mode, status, stages, createdAt, updatedAt, startedAt, completedAt, error, hitlRequired, hitlNotes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    run.runId,
    run.clientId,
    run.mode,
    run.status,
    JSON.stringify(run.stages),
    run.createdAt,
    run.updatedAt,
    run.startedAt ?? null,
    run.completedAt ?? null,
    run.error ?? null,
    run.hitlRequired ? 1 : 0,
    run.hitlNotes ?? null
  );
  return run;
}

export function getRun(runId: string): Run | null {
  const stmt = db.prepare("SELECT * FROM runs WHERE runId = ?");
  const row = stmt.get(runId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    ...row,
    stages: JSON.parse(row.stages as string),
    hitlRequired: Boolean(row.hitlRequired),
  } as Run;
}

export function updateRun(runId: string, updates: Partial<Run>): Run | null {
  const run = getRun(runId);
  if (!run) return null;

  const updated = { ...run, ...updates, updatedAt: new Date().toISOString() };
  const stmt = db.prepare(`
    UPDATE runs SET
      status = ?,
      stages = ?,
      updatedAt = ?,
      startedAt = ?,
      completedAt = ?,
      error = ?,
      hitlRequired = ?,
      hitlNotes = ?
    WHERE runId = ?
  `);
  stmt.run(
    updated.status,
    JSON.stringify(updated.stages),
    updated.updatedAt,
    updated.startedAt ?? null,
    updated.completedAt ?? null,
    updated.error ?? null,
    updated.hitlRequired ? 1 : 0,
    updated.hitlNotes ?? null,
    runId
  );
  return updated;
}

export function getRunsByClient(clientId: string): Run[] {
  const stmt = db.prepare("SELECT * FROM runs WHERE clientId = ? ORDER BY createdAt DESC");
  const rows = stmt.all(clientId) as Record<string, unknown>[];
  return rows.map((row) => ({
    ...row,
    stages: JSON.parse(row.stages as string),
    hitlRequired: Boolean(row.hitlRequired),
  })) as Run[];
}

// Log operations
export function addLog(log: Omit<RunLog, "id">): RunLog {
  const stmt = db.prepare(`
    INSERT INTO run_logs (runId, timestamp, stage, level, message)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(log.runId, log.timestamp, log.stage, log.level, log.message);
  return { ...log, id: result.lastInsertRowid as number };
}

export function getLogsByRun(runId: string, since?: number): RunLog[] {
  let stmt;
  if (since !== undefined) {
    stmt = db.prepare("SELECT * FROM run_logs WHERE runId = ? AND id > ? ORDER BY id ASC");
    return stmt.all(runId, since) as RunLog[];
  }
  stmt = db.prepare("SELECT * FROM run_logs WHERE runId = ? ORDER BY id ASC");
  return stmt.all(runId) as RunLog[];
}

// Artifact operations
export function addArtifact(artifact: Artifact): Artifact {
  const stmt = db.prepare(`
    INSERT INTO artifacts (id, runId, type, name, path, size, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(artifact.id, artifact.runId, artifact.type, artifact.name, artifact.path, artifact.size ?? null, artifact.createdAt);
  return artifact;
}

export function getArtifactsByRun(runId: string): Artifact[] {
  const stmt = db.prepare("SELECT * FROM artifacts WHERE runId = ? ORDER BY createdAt ASC");
  return stmt.all(runId) as Artifact[];
}

// Client operations
export function getClient(clientId: string): Client | null {
  const stmt = db.prepare("SELECT * FROM clients WHERE id = ?");
  return stmt.get(clientId) as Client | null;
}

export function upsertClient(client: Client): Client {
  const stmt = db.prepare(`
    INSERT INTO clients (id, name, status, lastRunId, lastRunAt, lastRunStatus)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      status = excluded.status,
      lastRunId = excluded.lastRunId,
      lastRunAt = excluded.lastRunAt,
      lastRunStatus = excluded.lastRunStatus
  `);
  stmt.run(client.id, client.name, client.status, client.lastRunId ?? null, client.lastRunAt ?? null, client.lastRunStatus ?? null);
  return client;
}

export function getAllClients(): Client[] {
  const stmt = db.prepare("SELECT * FROM clients ORDER BY name ASC");
  return stmt.all() as Client[];
}

export function updateClientLastRun(clientId: string, runId: string, status: RunStatus): void {
  const stmt = db.prepare(`
    UPDATE clients SET lastRunId = ?, lastRunAt = ?, lastRunStatus = ?
    WHERE id = ?
  `);
  stmt.run(runId, new Date().toISOString(), status, clientId);
}

export default db;
