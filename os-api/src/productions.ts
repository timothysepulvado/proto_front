import { EventEmitter } from "node:events";
import { constants, createReadStream, existsSync, mkdirSync, statSync, unlinkSync, copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";
import express from "express";
import type { Request, Response, Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { buildTempGenProcessEnv, getTempGenDir } from "./temp-gen-env.js";
import { ForbiddenPathError, resolveExistingRealPathInsideAllowedRoots, splitAllowedRoots } from "./path-security.js";
import { supabase } from "./supabase.js";

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
  negative_prompt?: string;
};

type ManifestCharacter = {
  canonical_reference_still?: unknown;
  canonical_reference_locked_at?: unknown;
  canonical_reference_locked_by?: unknown;
  canonical_reference_rationale?: unknown;
  [key: string]: unknown;
};

type Manifest = {
  shots: ManifestShot[];
  characters?: Record<string, ManifestCharacter> | unknown;
  [key: string]: unknown;
};

type ProductionShotPatch = {
  visualIntent?: unknown;
  beat?: unknown;
  durationS?: unknown;
  charactersNeeded?: unknown;
  stillPrompt?: unknown;
  veoPrompt?: unknown;
  negativePrompt?: unknown;
};

type ProductionShotResponse = Awaited<ReturnType<typeof buildShotCatalog>>["shots"][number];
type AnchorSource = "regen_stills_pivot.py" | "manifest";

type AnchorCatalogItem = {
  name: string;
  path: string;
  thumb: string;
  exists: boolean;
  sizeBytes?: number;
  mtime?: string;
  canonicalReference?: CanonicalReferenceDescriptor;
};

export type CanonicalReferenceDescriptor = {
  characterName: string;
  stillPath: string;
  thumb: string;
  lockedAt?: string;
  lockedBy?: string;
  rationale?: string;
  exists: boolean;
  sizeBytes?: number;
  mtime?: string;
};

type ShotStillCatalogItem = {
  shot: number;
  currentStillPath: string | null;
  currentStillThumb: string | null;
  currentStill?: ReturnType<typeof nullableFileMeta>;
  backupStillPath?: string;
  backupStill?: ReturnType<typeof nullableFileMeta>;
  anchors: AnchorCatalogItem[];
  anchorsSource: AnchorSource;
};

type ArtifactApprovalRow = {
  id: string;
  deliverable_id: string | null;
  campaign_id: string | null;
  path: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type DeliverableApprovalRow = {
  id: string;
  reference_images: string[] | null;
  updated_at: string;
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

async function readManifestFromDisk(productionSlug: string): Promise<Manifest> {
  const manifestPath = safePath(productionRoot(productionSlug), "manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as Manifest;
  if (!Array.isArray(parsed.shots)) {
    throw new Error(`Manifest for ${productionSlug} is missing shots[]`);
  }
  return parsed;
}

async function loadManifest(productionSlug: string): Promise<Manifest> {
  const cached = manifestCache.get(productionSlug);
  if (cached) return cached;
  const parsed = await readManifestFromDisk(productionSlug);
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

function validationError(message: string): Error {
  const error = new Error(message);
  error.name = "ValidationError";
  return error;
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
    stillBackup: safePath(root, "stills", `shot_${padded}_v5_backup.png`),
    thumbnail: safePath(root, ".thumbnails", `shot_${padded}.jpg`),
    assembly: safePath(root, "assembly", "drift_final.mp4"),
  };
}

function anchorPath(productionSlug: string, name: string): string {
  validateAnchorName(name);
  return safePath(productionRoot(productionSlug), "anchors", `${name}_anchor.png`);
}

function shotStillUrl(productionSlug: string, shotNumber: number): string {
  return `/api/productions/${productionSlug}/shot/${shotNumber}/still`;
}

function anchorUrl(productionSlug: string, name: string): string {
  return `/api/productions/${productionSlug}/anchor/${encodeURIComponent(name)}`;
}

function canonicalReferenceUrl(productionSlug: string, name: string): string {
  return `/api/productions/${productionSlug}/canonical-reference/${encodeURIComponent(name)}`;
}

function validateAnchorName(raw: string): string {
  const name = raw.trim();
  if (!/^[a-z0-9_]{1,64}$/.test(name)) {
    throw validationError("Anchor name must be 1-64 chars using lowercase letters, numbers, and underscores");
  }
  return name;
}

function readManifestString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getManifestCharacters(manifest: Pick<Manifest, "characters">): Record<string, ManifestCharacter> {
  if (!isRecord(manifest.characters)) return {};
  return Object.fromEntries(
    Object.entries(manifest.characters)
      .filter((entry): entry is [string, ManifestCharacter] => isRecord(entry[1])),
  );
}

function canonicalReferencePath(productionSlug: string, stillPath: string): string {
  const trimmed = stillPath.trim();
  if (!/\.(png|jpe?g|webp)$/i.test(trimmed)) {
    throw validationError("canonical_reference_still must resolve to an image file");
  }
  return safePath(productionRoot(productionSlug), trimmed);
}

export function getCanonicalReferencesForManifest(
  productionSlug: string,
  manifest: Pick<Manifest, "characters">,
  options: { includeFileMeta?: boolean } = {},
): Map<string, CanonicalReferenceDescriptor> {
  const includeFileMeta = options.includeFileMeta !== false;
  const references = new Map<string, CanonicalReferenceDescriptor>();

  for (const [rawName, character] of Object.entries(getManifestCharacters(manifest))) {
    const characterName = validateAnchorName(rawName);
    const stillPath = readManifestString(character.canonical_reference_still);
    if (!stillPath) continue;

    const resolvedPath = canonicalReferencePath(productionSlug, stillPath);
    const meta = includeFileMeta ? nullableFileMeta(resolvedPath) : null;
    references.set(characterName, {
      characterName,
      stillPath,
      thumb: canonicalReferenceUrl(productionSlug, characterName),
      lockedAt: readManifestString(character.canonical_reference_locked_at),
      lockedBy: readManifestString(character.canonical_reference_locked_by),
      rationale: readManifestString(character.canonical_reference_rationale),
      exists: includeFileMeta ? meta !== null : false,
      sizeBytes: meta?.sizeBytes,
      mtime: meta?.mtime,
    });
  }

  return references;
}

export function getShotCanonicalReferences(
  charactersNeeded: string[],
  references: Map<string, CanonicalReferenceDescriptor>,
): CanonicalReferenceDescriptor[] {
  const seen = new Set<string>();
  const shotReferences: CanonicalReferenceDescriptor[] = [];
  for (const rawName of charactersNeeded) {
    const name = rawName.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const reference = references.get(name);
    if (reference) shotReferences.push(reference);
  }
  return shotReferences;
}

function parseShotAnchorsFromPython(raw: string): Map<number, string[]> {
  const marker = "SHOT_ANCHORS";
  const markerIndex = raw.indexOf(marker);
  if (markerIndex < 0) return new Map();

  const braceStart = raw.indexOf("{", markerIndex);
  if (braceStart < 0) return new Map();

  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        braceEnd = i;
        break;
      }
    }
  }
  if (braceEnd < 0) return new Map();

  const body = raw.slice(braceStart + 1, braceEnd);
  const anchors = new Map<number, string[]>();
  for (const line of body.split(/\r?\n/)) {
    const withoutComment = line.split("#")[0] ?? "";
    const match = /^\s*(\d+)\s*:\s*\[([^\]]*)\]/.exec(withoutComment);
    if (!match) continue;
    const shotNumber = Number.parseInt(match[1] ?? "", 10);
    const names = [...(match[2] ?? "").matchAll(/["']([a-z0-9_]+)["']/g)].map((item) => item[1]);
    if (Number.isInteger(shotNumber)) anchors.set(shotNumber, names);
  }
  return anchors;
}

async function loadAnchorMap(productionSlug: string, manifest: Manifest): Promise<{ source: AnchorSource; anchorsByShot: Map<number, string[]> }> {
  const pivotPath = safePath(productionRoot(productionSlug), "regen_stills_pivot.py");
  if (existsSync(pivotPath)) {
    const parsed = parseShotAnchorsFromPython(await readFile(pivotPath, "utf8"));
    if (parsed.size > 0) return { source: "regen_stills_pivot.py", anchorsByShot: parsed };
  }

  const fallback = new Map<number, string[]>();
  for (const shot of manifest.shots) {
    const names = Array.isArray(shot.characters_needed)
      ? shot.characters_needed.filter((item): item is string => typeof item === "string")
      : [];
    fallback.set(shot.id, names);
  }
  return { source: "manifest", anchorsByShot: fallback };
}

function anchorCatalogItem(
  productionSlug: string,
  name: string,
  canonicalReferences?: Map<string, CanonicalReferenceDescriptor>,
): AnchorCatalogItem {
  const path = anchorPath(productionSlug, name);
  const meta = nullableFileMeta(path);
  return {
    name,
    path,
    thumb: anchorUrl(productionSlug, name),
    exists: meta !== null,
    sizeBytes: meta?.sizeBytes,
    mtime: meta?.mtime,
    canonicalReference: canonicalReferences?.get(name),
  };
}

async function buildShotStillCatalog(productionSlug: string): Promise<ShotStillCatalogItem[]> {
  const manifest = await loadManifest(productionSlug);
  const anchorMap = await loadAnchorMap(productionSlug, manifest);
  const canonicalReferences = getCanonicalReferencesForManifest(productionSlug, manifest);

  return manifest.shots
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((shot) => {
      const paths = shotPaths(productionSlug, shot.id);
      const currentStill = nullableFileMeta(paths.still);
      const backupStill = nullableFileMeta(paths.stillBackup);
      const anchorNames = anchorMap.anchorsByShot.get(shot.id) ?? [];

      return {
        shot: shot.id,
        currentStillPath: currentStill?.path ?? null,
        currentStillThumb: currentStill ? shotStillUrl(productionSlug, shot.id) : null,
        currentStill,
        backupStillPath: backupStill?.path,
        backupStill,
        anchors: anchorNames.map((name) => anchorCatalogItem(productionSlug, name, canonicalReferences)),
        anchorsSource: anchorMap.source,
      };
    });
}

function resolveUserPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) throw validationError("sourcePath cannot be empty");
  if (trimmed === "~") return process.env.HOME ?? trimmed;
  if (trimmed.startsWith("~/")) return join(process.env.HOME ?? "", trimmed.slice(2));
  return trimmed;
}

export function productionSourceRoots(productionSlug: string): string[] {
  const configured = splitAllowedRoots(process.env.PRODUCTIONS_SOURCE_ROOTS);
  return configured.length > 0 ? configured : [productionRoot(productionSlug)];
}

export function validateStillSourcePath(
  productionSlug: string,
  rawPath: unknown,
  allowedRoots: readonly string[] = productionSourceRoots(productionSlug),
): string {
  if (typeof rawPath !== "string") throw validationError("sourcePath must be a string");
  const sourcePath = resolve(resolveUserPath(rawPath));
  const realSourcePath = resolveExistingRealPathInsideAllowedRoots(sourcePath, allowedRoots, {
    missingMessage: `Replacement still not found: ${sourcePath}`,
    forbiddenMessage: "sourcePath is outside the configured production source roots",
  });
  const stats = statSync(realSourcePath);
  if (!stats.isFile()) throw validationError("sourcePath must resolve to a file");
  if (stats.size > 50 * 1024 * 1024) throw validationError("Replacement still must be 50MB or smaller");
  const allowedExtensions = new Set([".png", ".jpg", ".jpeg"]);
  if (!allowedExtensions.has(extname(realSourcePath).toLowerCase())) {
    throw validationError("Replacement still must be a .png, .jpg, or .jpeg file");
  }

  const signature = readFileSync(realSourcePath).subarray(0, 8);
  const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const isPng = signature.equals(pngSignature);
  const isJpeg = signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
  if (!isPng && !isJpeg) throw validationError("Replacement still must be a valid PNG or JPEG image");
  return realSourcePath;
}

function detectImageExtension(buffer: Buffer): ".png" | ".jpg" {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  if (buffer.subarray(0, 8).equals(pngSignature)) return ".png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  throw validationError("Replacement still must be a valid PNG or JPEG image");
}

function validateStillUploadBody(productionSlug: string, shotNumber: number, fileBase64: unknown, fileName: unknown): string {
  if (typeof fileBase64 !== "string") throw validationError("fileBase64 must be a base64-encoded PNG or JPEG");
  if (fileName !== undefined && typeof fileName !== "string") throw validationError("fileName must be a string");
  if (fileName && fileName.length > 160) throw validationError("fileName must be 160 characters or fewer");

  const trimmed = fileBase64.trim();
  if (!trimmed) throw validationError("fileBase64 cannot be empty");
  const payload = trimmed.includes(",") ? trimmed.slice(trimmed.indexOf(",") + 1) : trimmed;
  const buffer = Buffer.from(payload, "base64");
  if (buffer.byteLength === 0) throw validationError("fileBase64 could not be decoded");
  if (buffer.byteLength > 50 * 1024 * 1024) throw validationError("Replacement still must be 50MB or smaller");

  const detectedExt = detectImageExtension(buffer);
  const namedExt = typeof fileName === "string" ? extname(fileName).toLowerCase() : "";
  if (namedExt && !new Set([".png", ".jpg", ".jpeg"]).has(namedExt)) {
    throw validationError("fileName must end in .png, .jpg, or .jpeg");
  }

  const root = productionRoot(productionSlug);
  const uploadPath = safePath(root, ".uploads", `shot_${padShot(shotNumber)}_${Date.now()}_${uuidv4()}${detectedExt}`);
  mkdirSync(dirname(uploadPath), { recursive: true });
  writeFileSync(uploadPath, buffer, { flag: "wx" });
  return uploadPath;
}

export function updateReferenceImagesForStillDecision(
  currentRefs: readonly string[],
  stillPath: string,
  decision: "approve" | "reject",
): string[] {
  const withoutStill = currentRefs.filter((item) => item !== stillPath);
  return decision === "approve" ? [stillPath, ...withoutStill] : withoutStill;
}

function resolveStillReplacementSource(
  productionSlug: string,
  shotNumber: number,
  body: { sourcePath?: unknown; fileBase64?: unknown; fileName?: unknown },
): { sourcePath: string; tempUploadPath: string | null } {
  if (body.sourcePath !== undefined) {
    return { sourcePath: validateStillSourcePath(productionSlug, body.sourcePath), tempUploadPath: null };
  }
  if (body.fileBase64 !== undefined) {
    const tempUploadPath = validateStillUploadBody(productionSlug, shotNumber, body.fileBase64, body.fileName);
    return { sourcePath: validateStillSourcePath(productionSlug, tempUploadPath), tempUploadPath };
  }
  throw validationError("sourcePath or fileBase64 is required");
}

function replaceShotStill(productionSlug: string, shotNumber: number, sourcePath: string) {
  const paths = shotPaths(productionSlug, shotNumber);
  let backupCreated = false;
  if (existsSync(paths.still) && !existsSync(paths.stillBackup)) {
    copyFileSync(paths.still, paths.stillBackup, constants.COPYFILE_EXCL);
    backupCreated = true;
  }

  const sourceResolved = resolve(sourcePath);
  const targetResolved = resolve(paths.still);
  const replaced = sourceResolved !== targetResolved;
  if (replaced) {
    mkdirSync(dirname(paths.still), { recursive: true });
    copyFileSync(sourcePath, paths.still);
  }

  return {
    shotNumber,
    replaced,
    backupCreated,
    sourcePath,
    currentStill: fileMeta(paths.still),
    backupStill: nullableFileMeta(paths.stillBackup),
  };
}

function snapshotTimestamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

function validateSnapshotLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw validationError("label must be a string");
  const label = value.trim();
  if (!label) throw validationError("label cannot be empty");
  if (label.length > 80) throw validationError("label must be 80 characters or fewer");
  if (!/^[A-Za-z0-9_-]+$/.test(label)) {
    throw validationError("label may only include letters, numbers, underscores, and hyphens");
  }
  return label;
}

function nextSnapshotIter(productionSlug: string, shotNumber: number): number {
  const root = safePath(productionRoot(productionSlug), "stills");
  if (!existsSync(root)) return 1;

  const padded = padShot(shotNumber);
  const iterPattern = new RegExp(`^shot_${padded}_iter(\\d+).*_backup\\.png$`);
  const maxIter = readdirSync(root).reduce((max, name) => {
    const match = iterPattern.exec(name);
    if (!match) return max;
    const value = Number.parseInt(match[1] ?? "", 10);
    return Number.isInteger(value) ? Math.max(max, value) : max;
  }, 0);

  return maxIter + 1;
}

function snapshotShotStill(productionSlug: string, shotNumber: number, requestedLabel?: unknown) {
  const paths = shotPaths(productionSlug, shotNumber);
  if (!existsSync(paths.still)) {
    throw Object.assign(new Error("Starting still not found"), { name: "NotFoundError" });
  }

  const label = validateSnapshotLabel(requestedLabel) ?? `iter${nextSnapshotIter(productionSlug, shotNumber)}_${snapshotTimestamp()}`;
  const snapshotPath = safePath(productionRoot(productionSlug), "stills", `shot_${padShot(shotNumber)}_${label}_backup.png`);
  if (existsSync(snapshotPath)) {
    return {
      ok: false,
      existed: true,
      status: 409,
      productionSlug,
      shotNumber,
      label,
      snapshot_path: snapshotPath,
      snapshot: fileMeta(snapshotPath),
    };
  }

  mkdirSync(dirname(snapshotPath), { recursive: true });
  copyFileSync(paths.still, snapshotPath, constants.COPYFILE_EXCL);

  return {
    ok: true,
    existed: false,
    status: 200,
    productionSlug,
    shotNumber,
    label,
    snapshot_path: snapshotPath,
    snapshot: fileMeta(snapshotPath),
    source_path: paths.still,
  };
}

function metadataShotNumber(metadata: Record<string, unknown> | null): number | null {
  if (!metadata) return null;
  if (typeof metadata.shotNumber === "number") return metadata.shotNumber;
  const narrativeContext = metadata.narrative_context as { shot_number?: unknown } | undefined;
  return typeof narrativeContext?.shot_number === "number" ? narrativeContext.shot_number : null;
}

function artifactMatchesShot(row: ArtifactApprovalRow, shotNumber: number): boolean {
  const fromMetadata = metadataShotNumber(row.metadata);
  if (fromMetadata === shotNumber) return true;
  const padded = padShot(shotNumber);
  return row.path.includes(`shot_${padded}.`);
}

async function findLatestArtifactForShot(shotNumber: number, deliverableId?: string): Promise<ArtifactApprovalRow | null> {
  let query = supabase
    .from("artifacts")
    .select("id, deliverable_id, campaign_id, path, metadata, created_at")
    .order("created_at", { ascending: false })
    .limit(2000);

  if (deliverableId) query = query.eq("deliverable_id", deliverableId);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to resolve shot artifact: ${error.message}`);

  const rows = (data as ArtifactApprovalRow[] | null) ?? [];
  return rows.find((row) => artifactMatchesShot(row, shotNumber) && row.deliverable_id) ?? null;
}

async function approveShotStill(productionSlug: string, shotNumber: number, deliverableId?: string) {
  const paths = shotPaths(productionSlug, shotNumber);
  if (!existsSync(paths.still)) {
    throw Object.assign(new Error("Starting still not found"), { name: "NotFoundError" });
  }

  const artifact = await findLatestArtifactForShot(shotNumber, deliverableId);
  if (!artifact || !artifact.deliverable_id) {
    throw Object.assign(new Error("No deliverable-backed artifact found for this shot"), { name: "NotFoundError" });
  }

  const approvedAt = new Date().toISOString();
  const stillMeta = fileMeta(paths.still);
  const approval = {
    productionSlug,
    shotNumber,
    approvedAt,
    currentStillPath: stillMeta.path,
    currentStillMtime: stillMeta.mtime,
    source: "hud-anchor-still-management",
  };

  const nextArtifactMetadata = {
    ...(artifact.metadata ?? {}),
    starting_still_approved_at: approvedAt,
    starting_still_approval: approval,
  };
  const { error: artifactError } = await supabase
    .from("artifacts")
    .update({ metadata: nextArtifactMetadata })
    .eq("id", artifact.id);
  if (artifactError) throw new Error(`Failed to update artifact approval metadata: ${artifactError.message}`);

  const { data: deliverable, error: deliverableReadError } = await supabase
    .from("campaign_deliverables")
    .select("id, reference_images, updated_at")
    .eq("id", artifact.deliverable_id)
    .maybeSingle();
  if (deliverableReadError) throw new Error(`Failed to read deliverable reference images: ${deliverableReadError.message}`);
  if (!deliverable) throw Object.assign(new Error("Deliverable not found"), { name: "NotFoundError" });

  const currentRefs = Array.isArray((deliverable as DeliverableApprovalRow).reference_images)
    ? ((deliverable as DeliverableApprovalRow).reference_images ?? [])
    : [];
  const nextRefs = updateReferenceImagesForStillDecision(currentRefs, paths.still, "approve");
  const { data: updatedDeliverable, error: deliverableUpdateError } = await supabase
    .from("campaign_deliverables")
    .update({ reference_images: nextRefs })
    .eq("id", artifact.deliverable_id)
    .select("id, reference_images, updated_at")
    .single();
  if (deliverableUpdateError) throw new Error(`Failed to update deliverable reference images: ${deliverableUpdateError.message}`);

  return {
    ok: true,
    shotNumber,
    approvedAt,
    productionSlug,
    currentStillPath: stillMeta.path,
    artifactId: artifact.id,
    deliverableId: artifact.deliverable_id,
    campaignId: artifact.campaign_id,
    referenceImages: (updatedDeliverable as DeliverableApprovalRow).reference_images ?? [],
    storage: "artifacts.metadata.starting_still_approval + campaign_deliverables.reference_images",
    note: "campaign_deliverables.metadata is not present in this schema; approval metadata is stored on the deliverable-backed artifact while reference_images is updated to fire deliverable realtime.",
  };
}

function validateRequiredString(value: unknown, fieldName: string, maxLength: number): string {
  if (typeof value !== "string") throw validationError(`${fieldName} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw validationError(`${fieldName} cannot be empty`);
  if (trimmed.length > maxLength) throw validationError(`${fieldName} must be ${maxLength} characters or fewer`);
  return trimmed;
}

function validateOptionalNullableString(value: unknown, fieldName: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  return validateRequiredString(value, fieldName, maxLength);
}

async function rejectShotStill(productionSlug: string, shotNumber: number, reason: string, deniedBy: string | null, deliverableId?: string) {
  const paths = shotPaths(productionSlug, shotNumber);
  if (!existsSync(paths.still)) {
    throw Object.assign(new Error("Starting still not found"), { name: "NotFoundError" });
  }

  const artifact = await findLatestArtifactForShot(shotNumber, deliverableId);
  if (!artifact || !artifact.deliverable_id) {
    throw Object.assign(new Error("No deliverable-backed artifact found for this shot"), { name: "NotFoundError" });
  }

  const rejectedAt = new Date().toISOString();
  const nextArtifactMetadata = {
    ...(artifact.metadata ?? {}),
    still_rejected_at: rejectedAt,
    still_rejection_reason: reason,
    still_denied_by: deniedBy,
  };
  const { error: artifactError } = await supabase
    .from("artifacts")
    .update({ metadata: nextArtifactMetadata })
    .eq("id", artifact.id);
  if (artifactError) throw new Error(`Failed to update artifact rejection metadata: ${artifactError.message}`);

  const { data: deliverable, error: deliverableReadError } = await supabase
    .from("campaign_deliverables")
    .select("id, reference_images, updated_at")
    .eq("id", artifact.deliverable_id)
    .maybeSingle();
  if (deliverableReadError) throw new Error(`Failed to read deliverable reference images: ${deliverableReadError.message}`);
  if (!deliverable) throw Object.assign(new Error("Deliverable not found"), { name: "NotFoundError" });

  const currentRefs = Array.isArray((deliverable as DeliverableApprovalRow).reference_images)
    ? ((deliverable as DeliverableApprovalRow).reference_images ?? [])
    : [];
  const nextRefs = updateReferenceImagesForStillDecision(currentRefs, paths.still, "reject");
  const { data: updatedDeliverable, error: deliverableUpdateError } = await supabase
    .from("campaign_deliverables")
    .update({ reference_images: nextRefs })
    .eq("id", artifact.deliverable_id)
    .select("id, reference_images, updated_at")
    .single();
  if (deliverableUpdateError) throw new Error(`Failed to update deliverable reference images: ${deliverableUpdateError.message}`);

  return {
    ok: true,
    shotNumber,
    productionSlug,
    still_rejected_at: rejectedAt,
    still_rejection_reason: reason,
    still_denied_by: deniedBy,
    currentStillPath: paths.still,
    artifactId: artifact.id,
    deliverableId: artifact.deliverable_id,
    campaignId: artifact.campaign_id,
    referenceImages: (updatedDeliverable as DeliverableApprovalRow).reference_images ?? [],
    storage: "artifacts.metadata.still_* rejection fields + campaign_deliverables.reference_images",
    note: "campaign_deliverables.metadata is not present in this schema; rejection metadata is stored on the deliverable-backed artifact while reference_images is updated to fire deliverable realtime.",
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

function mapManifestShotToResponse(
  productionSlug: string,
  shot: ManifestShot,
  canonicalReferences: Map<string, CanonicalReferenceDescriptor>,
) {
  const shotNumber = shot.id;
  const paths = shotPaths(productionSlug, shotNumber);
  const canonicalMeta = fileMeta(paths.canonical);
  const pending = nullableFileMeta(paths.pending);
  const charactersNeeded = Array.isArray(shot.characters_needed)
    ? shot.characters_needed.filter((item): item is string => typeof item === "string")
    : [];

  return {
    shotNumber,
    beat: shot.section ?? "unmapped",
    startS: shot.start_s ?? 0,
    endS: shot.end_s ?? (shot.start_s ?? 0) + (shot.duration_s ?? 0),
    durationS: shot.duration_s ?? 0,
    visualIntent: shot.visual ?? "",
    charactersNeeded,
    canonicalReferences: getShotCanonicalReferences(charactersNeeded, canonicalReferences),
    defaultPrompt: shot.veo_prompt ?? "",
    stillPrompt: shot.still_prompt ?? "",
    negativePrompt: shot.negative_prompt ?? "",
    canonical: {
      ...canonicalMeta,
      backupExists: existsSync(paths.backup),
    },
    pending,
    stillPath: existsSync(paths.still) ? paths.still : null,
    activeJob: currentJobForShot(productionSlug, shotNumber),
  };
}

async function buildShotCatalog(productionSlug: string) {
  const manifest = await loadManifest(productionSlug);
  const canonicalReferences = getCanonicalReferencesForManifest(productionSlug, manifest);
  const renderArtifact = nullableFileMeta(shotPaths(productionSlug, SHOT_MIN).assembly);
  const shots = manifest.shots.map((shot) => mapManifestShotToResponse(productionSlug, shot, canonicalReferences));

  return { shots, renderArtifact };
}


function validateOptionalString(value: unknown, fieldName: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw validationError(`${fieldName} must be a string`);
  if (value.length > maxLength) throw validationError(`${fieldName} must be ${maxLength} characters or fewer`);
  return value;
}

function validateDuration(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw validationError("durationS must be a finite number");
  if (value <= 0 || value > 30) throw validationError("durationS must be > 0 and <= 30");
  return value;
}

function validateCharactersNeeded(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw validationError("charactersNeeded must be an array of strings");
  if (value.length > 20) throw validationError("charactersNeeded may include at most 20 entries");
  return value.map((item, index) => {
    if (typeof item !== "string") throw validationError(`charactersNeeded[${index}] must be a string`);
    const trimmed = item.trim();
    if (trimmed.length > 50) throw validationError(`charactersNeeded[${index}] must be 50 characters or fewer`);
    return trimmed;
  }).filter(Boolean);
}

function recalculateTimeline(shots: ManifestShot[]): void {
  let cursor = 0;
  for (const shot of shots) {
    const duration = typeof shot.duration_s === "number" && Number.isFinite(shot.duration_s) ? shot.duration_s : 0;
    shot.start_s = Number(cursor.toFixed(3));
    cursor += duration;
    shot.end_s = Number(cursor.toFixed(3));
  }
}

function totalDuration(shots: ManifestShot[]): number {
  return shots.reduce((sum, shot) => sum + (typeof shot.duration_s === "number" && Number.isFinite(shot.duration_s) ? shot.duration_s : 0), 0);
}

function applyShotPatch(shot: ManifestShot, patch: ProductionShotPatch): void {
  const visualIntent = validateOptionalString(patch.visualIntent, "visualIntent", 4000);
  const beat = validateOptionalString(patch.beat, "beat", 50);
  const durationS = validateDuration(patch.durationS);
  const charactersNeeded = validateCharactersNeeded(patch.charactersNeeded);
  const stillPrompt = validateOptionalString(patch.stillPrompt, "stillPrompt", 4000);
  const veoPrompt = validateOptionalString(patch.veoPrompt, "veoPrompt", 4000);
  const negativePrompt = validateOptionalString(patch.negativePrompt, "negativePrompt", 4000);

  if (visualIntent !== undefined) shot.visual = visualIntent;
  if (beat !== undefined) shot.section = beat;
  if (durationS !== undefined) shot.duration_s = durationS;
  if (charactersNeeded !== undefined) shot.characters_needed = charactersNeeded;
  if (stillPrompt !== undefined) shot.still_prompt = stillPrompt;
  if (veoPrompt !== undefined) shot.veo_prompt = veoPrompt;
  if (negativePrompt !== undefined) shot.negative_prompt = negativePrompt;
}

async function writeManifestAtomic(productionSlug: string, manifest: Manifest): Promise<void> {
  const manifestPath = safePath(productionRoot(productionSlug), "manifest.json");
  const tmpPath = `${manifestPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(tmpPath, manifestPath);
  manifestCache.delete(productionSlug);
}

async function extractThumbnail(productionSlug: string, shotNumber: number): Promise<string> {
  const paths = shotPaths(productionSlug, shotNumber);
  if (!existsSync(paths.canonical)) {
    throw Object.assign(new Error("Canonical shot video not found"), { name: "NotFoundError" });
  }

  const canonicalStats = statSync(paths.canonical);
  const needsRegenerate = !existsSync(paths.thumbnail) || statSync(paths.thumbnail).mtimeMs < canonicalStats.mtimeMs;
  if (!needsRegenerate) return paths.thumbnail;

  mkdirSync(dirname(paths.thumbnail), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-y",
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      paths.canonical,
      "-vframes",
      "1",
      "-q:v",
      "2",
      paths.thumbnail,
    ], { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
    proc.on("error", reject);
  });

  return paths.thumbnail;
}

async function extractStartingStillFromCanonical(productionSlug: string, shotNumber: number): Promise<{
  currentStill: ReturnType<typeof fileMeta>;
  stillBackupCreated: boolean;
}> {
  const paths = shotPaths(productionSlug, shotNumber);
  if (!existsSync(paths.canonical)) {
    throw Object.assign(new Error("Canonical shot video not found"), { name: "NotFoundError" });
  }

  let stillBackupCreated = false;
  if (existsSync(paths.still) && !existsSync(paths.stillBackup)) {
    copyFileSync(paths.still, paths.stillBackup, constants.COPYFILE_EXCL);
    stillBackupCreated = true;
  }

  mkdirSync(dirname(paths.still), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-y",
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      paths.canonical,
      "-vframes",
      "1",
      paths.still,
    ], { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
    proc.on("error", reject);
  });

  return {
    currentStill: fileMeta(paths.still),
    stillBackupCreated,
  };
}

function sendJsonError(res: Response, err: unknown, label: string): void {
  const message = err instanceof Error ? err.message : "Unknown error";
  if (err instanceof ForbiddenPathError || (err instanceof Error && err.name === "ForbiddenError")) {
    res.status(403).json({ error: message });
    return;
  }
  if (err instanceof Error && err.name === "ValidationError") {
    res.status(400).json({ error: message });
    return;
  }
  if (err instanceof Error && err.name === "NotFoundError") {
    res.status(404).json({ error: message });
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

function imageContentType(path: string): string {
  if (existsSync(path)) {
    try {
      const signature = readFileSync(path).subarray(0, 12);
      const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      if (signature.subarray(0, 8).equals(pngSignature)) return "image/png";
      if (signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff) return "image/jpeg";
      if (
        signature.subarray(0, 4).toString("ascii") === "RIFF"
        && signature.subarray(8, 12).toString("ascii") === "WEBP"
      ) {
        return "image/webp";
      }
    } catch {
      // Fall through to extension detection; streamFile will surface read errors.
    }
  }
  const extension = extname(path).toLowerCase();
  if (extension === ".webp") return "image/webp";
  return extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png";
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

  router.get("/:productionSlug/shot-stills", async (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      const shots = await buildShotStillCatalog(productionSlug);
      res.json({ productionSlug, shots });
    } catch (err) {
      sendJsonError(res, err, "GET /api/productions/:productionSlug/shot-stills");
    }
  });

  router.get("/:productionSlug/canonical-reference/:name", async (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      const name = validateAnchorName(getParam(req, "name"));
      const manifest = await loadManifest(productionSlug);
      const reference = getCanonicalReferencesForManifest(productionSlug, manifest).get(name);
      if (!reference) {
        throw Object.assign(new Error("Canonical reference not found"), { name: "NotFoundError" });
      }
      const path = canonicalReferencePath(productionSlug, reference.stillPath);
      streamFile(res, path, imageContentType(path));
    } catch (err) {
      sendJsonError(res, err, "GET /api/productions/:productionSlug/canonical-reference/:name");
    }
  });

  router.get("/:productionSlug/shot/:shot/still", (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      const shotNumber = parseShotNumber(getParam(req, "shot"));
      const stillPath = shotPaths(productionSlug, shotNumber).still;
      streamFile(res, stillPath, imageContentType(stillPath));
    } catch (err) {
      sendJsonError(res, err, "GET /api/productions/:productionSlug/shot/:shot/still");
    }
  });

  router.get("/:productionSlug/anchor/:name", (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      const name = validateAnchorName(getParam(req, "name"));
      streamFile(res, anchorPath(productionSlug, name), "image/png");
    } catch (err) {
      sendJsonError(res, err, "GET /api/productions/:productionSlug/anchor/:name");
    }
  });

  router.post("/:productionSlug/shot/:shot/still", (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      const shotNumber = parseShotNumber(getParam(req, "shot"));
      const body = (req.body ?? {}) as { sourcePath?: unknown; fileBase64?: unknown; fileName?: unknown };
      const source = resolveStillReplacementSource(productionSlug, shotNumber, body);
      const replacement = replaceShotStill(productionSlug, shotNumber, source.sourcePath);
      if (source.tempUploadPath) {
        try {
          unlinkSync(source.tempUploadPath);
        } catch {
          // Non-fatal: replacement already succeeded, and .uploads is a temp cache.
        }
      }

      emitProductionEvent(productionSlug, {
        type: "shot_still_replaced",
        shotNumber,
        replaced: replacement.replaced,
        backupCreated: replacement.backupCreated,
        currentStillPath: replacement.currentStill.path,
      });

      res.json({ ok: true, ...replacement });
    } catch (err) {
      sendJsonError(res, err, "POST /api/productions/:productionSlug/shot/:shot/still");
    }
  });

  router.post("/:productionSlug/shot/:shot/snapshot-still", (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      const shotNumber = parseShotNumber(getParam(req, "shot"));
      const body = (req.body ?? {}) as { label?: unknown };
      const snapshot = snapshotShotStill(productionSlug, shotNumber, body.label);

      if (snapshot.status === 409) {
        res.status(409).json(snapshot);
        return;
      }

      emitProductionEvent(productionSlug, {
        type: "shot_still_snapshot",
        shotNumber,
        label: snapshot.label,
        snapshotPath: snapshot.snapshot_path,
      });

      res.json(snapshot);
    } catch (err) {
      sendJsonError(res, err, "POST /api/productions/:productionSlug/shot/:shot/snapshot-still");
    }
  });

  router.post("/:productionSlug/shot/:shot/reject-still", async (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      const shotNumber = parseShotNumber(getParam(req, "shot"));
      const body = (req.body ?? {}) as { reason?: unknown; denied_by?: unknown; deliverableId?: unknown };
      const reason = validateRequiredString(body.reason, "reason", 1000);
      const deniedBy = validateOptionalNullableString(body.denied_by, "denied_by", 120);
      const deliverableId = body.deliverableId === undefined
        ? undefined
        : validateOptionalString(body.deliverableId, "deliverableId", 80);
      const result = await rejectShotStill(productionSlug, shotNumber, reason, deniedBy, deliverableId);

      emitProductionEvent(productionSlug, {
        type: "shot_still_rejected",
        shotNumber,
        rejectedAt: result.still_rejected_at,
        deliverableId: result.deliverableId,
        artifactId: result.artifactId,
      });

      res.json(result);
    } catch (err) {
      sendJsonError(res, err, "POST /api/productions/:productionSlug/shot/:shot/reject-still");
    }
  });

  router.post("/:productionSlug/shot/:shot/approve-still", async (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      const shotNumber = parseShotNumber(getParam(req, "shot"));
      const body = (req.body ?? {}) as { deliverableId?: unknown };
      const deliverableId = body.deliverableId === undefined
        ? undefined
        : validateOptionalString(body.deliverableId, "deliverableId", 80);
      const result = await approveShotStill(productionSlug, shotNumber, deliverableId);

      emitProductionEvent(productionSlug, {
        type: "shot_still_approved",
        shotNumber,
        approvedAt: result.approvedAt,
        deliverableId: result.deliverableId,
        artifactId: result.artifactId,
      });

      res.json(result);
    } catch (err) {
      sendJsonError(res, err, "POST /api/productions/:productionSlug/shot/:shot/approve-still");
    }
  });

  router.get("/:productionSlug/shots/:n/thumbnail", async (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      const shotNumber = parseShotNumber(getParam(req, "n"));
      const thumbnailPath = await extractThumbnail(productionSlug, shotNumber);
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=300");
      createReadStream(thumbnailPath).pipe(res);
    } catch (err) {
      const isMissingFfmpeg = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
      if (isMissingFfmpeg) {
        res.status(503).json({ error: "ffmpeg not available", detail: err.message });
        return;
      }
      sendJsonError(res, err, "GET /api/productions/:productionSlug/shots/:n/thumbnail");
    }
  });

  router.patch("/:productionSlug/shots/:n", async (req: Request, res: Response) => {
    try {
      const productionSlug = validateProductionSlug(getParam(req, "productionSlug"));
      const shotNumber = parseShotNumber(getParam(req, "n"));
      const body = (req.body ?? {}) as ProductionShotPatch;
      const manifest = await readManifestFromDisk(productionSlug);
      const shot = manifest.shots.find((item) => item.id === shotNumber);
      if (!shot) {
        res.status(404).json({ error: "Shot not found" });
        return;
      }

      const originalTotalDuration = totalDuration(manifest.shots);
      applyShotPatch(shot, body);
      if (body.durationS !== undefined) recalculateTimeline(manifest.shots);
      const nextTotalDuration = totalDuration(manifest.shots);
      const cumulativeDurationDelta = nextTotalDuration - originalTotalDuration;

      await writeManifestAtomic(productionSlug, manifest);
      const updatedShot = mapManifestShotToResponse(
        productionSlug,
        shot,
        getCanonicalReferencesForManifest(productionSlug, manifest),
      ) as ProductionShotResponse;
      emitProductionEvent(productionSlug, {
        type: "shot_manifest_updated",
        shotNumber,
        cumulativeDurationDeltaS: Number(cumulativeDurationDelta.toFixed(3)),
      });

      const response: { ok: true; shot: ProductionShotResponse; warning?: string } = { ok: true, shot: updatedShot };
      if (Math.abs(cumulativeDurationDelta) > 1) {
        response.warning = `cumulativeDurationDelta=${Number(cumulativeDurationDelta.toFixed(1))}s — music sync may break`;
      }
      res.json(response);
    } catch (err) {
      sendJsonError(res, err, "PATCH /api/productions/:productionSlug/shots/:n");
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
      const stillPath = shotPaths(productionSlug, shotNumber).still;
      streamFile(res, stillPath, imageContentType(stillPath));
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

  router.post("/:productionSlug/shots/:n/promote", async (req: Request, res: Response) => {
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

      let stillUpdate: Awaited<ReturnType<typeof extractStartingStillFromCanonical>> | null = null;
      let stillWarning: string | undefined;
      try {
        stillUpdate = await extractStartingStillFromCanonical(productionSlug, shotNumber);
      } catch (err) {
        stillWarning = err instanceof Error ? err.message : "Unable to extract promoted starting still";
      }

      emitProductionEvent(productionSlug, {
        type: "shot_promoted",
        shotNumber,
        backupCreated,
        stillUpdated: Boolean(stillUpdate),
        stillBackupCreated: stillUpdate?.stillBackupCreated ?? false,
        currentStillPath: stillUpdate?.currentStill.path,
        currentStillMtime: stillUpdate?.currentStill.mtime,
        warning: stillWarning,
      });
      res.json({
        shotNumber,
        promoted: true,
        backupCreated,
        stillUpdated: Boolean(stillUpdate),
        stillBackupCreated: stillUpdate?.stillBackupCreated ?? false,
        currentStill: stillUpdate?.currentStill ?? null,
        warning: stillWarning,
      });
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
