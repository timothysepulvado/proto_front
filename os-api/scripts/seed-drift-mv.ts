/**
 * Seed the Drift MV 30-shot catalog into Supabase for the Step 10d reuse-first
 * regression run.
 *
 * Source of truth (Tim confirmed 2026-04-20): `~/Temp-gen/productions/drift-mv/`.
 *   - `manifest.json` — 30 shots with id, section, duration_s, visual,
 *     veo_prompt (latest canonical Phase 2 v4 prompt baked in).
 *   - `shots/shot_NN.mp4` — canonical current video per shot on disk.
 *
 * What we write:
 *   - 1 `campaigns` row:      "Drift MV — 30-shot catalog regression (10d)"
 *   - 1 synthetic `runs` row: mode=full, status=completed — exists only to
 *     give the 30 seed artifacts a run_id FK (runs.id is NOT NULL on artifacts).
 *   - 30 `campaign_deliverables` rows — one per shot, with description,
 *     current_prompt + original_prompt (manifest.veo_prompt), media_type=video,
 *     duration_seconds from manifest, aspect_ratio=16:9, resolution=1080p,
 *     quality_tier=standard, status=pending.
 *   - 30 `artifacts` rows — one per shot, type=video, path=localPath,
 *     metadata.localPath=<absolute path to shot_NN.mp4>, stage=seed.
 *
 * Idempotency: all IDs are deterministic uuid-v5 derived from a fixed app
 * namespace + stable keys (campaign name, shot_number). Re-running upserts
 * the same rows — counts stay 30.
 *
 * Non-goal: we do NOT touch the pre-existing 10c dry-run campaign
 * (`b6691def-ff1a-4e89-a26b-30303d2c93c1`) or its two Shot 20 artifacts.
 * The smoke test in Session A runs on that campaign by design.
 *
 * Run:
 *   cd ~/proto_front
 *   (set -a; . os-api/.env; set +a; npx tsx os-api/scripts/seed-drift-mv.ts)
 *
 * Env overrides (optional):
 *   DRIFT_MV_PROD_DIR   — override ~/Temp-gen/productions/drift-mv path
 *   SEED_DRIFT_MV_DRY   — "1" to print what would change without writing
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync, statSync } from "fs";
import { v5 as uuidv5 } from "uuid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { supabase } from "../src/supabase.js";

// ─── Configuration ──────────────────────────────────────────────────────────

const CLIENT_ID = "client_drift-mv";
const CAMPAIGN_NAME = "Drift MV — 30-shot catalog regression (10d)";
const PRODUCTION_DIR =
  process.env.DRIFT_MV_PROD_DIR ?? "/Users/timothysepulvado/Temp-gen/productions/drift-mv";
const MANIFEST_PATH = path.join(PRODUCTION_DIR, "manifest.json");
const SHOTS_DIR = path.join(PRODUCTION_DIR, "shots");
const DRY_RUN = process.env.SEED_DRIFT_MV_DRY === "1";

/**
 * uuid-v5 namespace rooted at the RFC 4122 DNS namespace. Keeps all seeded IDs
 * deterministic across re-runs while isolating this seeder's key space from
 * any future deterministic-id work. Changing SEED_APP_NS regenerates every
 * id, so don't change it casually.
 */
const RFC4122_DNS_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const SEED_APP_NS = uuidv5("brandstudios.os-api.seed-drift-mv.v1", RFC4122_DNS_NS);

// ─── Id derivation (deterministic) ──────────────────────────────────────────

const CAMPAIGN_ID = uuidv5(`campaign::${CLIENT_ID}::${CAMPAIGN_NAME}`, SEED_APP_NS);
const SEED_RUN_ID = uuidv5(`run::seed::${CLIENT_ID}::${CAMPAIGN_NAME}`, SEED_APP_NS);

function deliverableIdFor(shotNumber: number): string {
  return uuidv5(`deliverable::${CLIENT_ID}::${CAMPAIGN_ID}::shot-${shotNumber}`, SEED_APP_NS);
}
function artifactIdFor(shotNumber: number): string {
  // Version tag reserves the "current canonical production file" slot for this
  // seeder. If a future seeder ever needs to re-seed with a different source
  // (e.g. post-assembly trimmed clips), bump the version to get a fresh id.
  return uuidv5(
    `artifact::${CLIENT_ID}::${CAMPAIGN_ID}::shot-${shotNumber}::production-v1`,
    SEED_APP_NS,
  );
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface ManifestShot {
  id: number;
  section: string;
  duration_s: number;
  start_s: number;
  end_s: number;
  visual: string;
  characters_needed: string[];
  veo_prompt: string;
  still_prompt: string;
  // Post-L3 redesign shots carry a `redesign_version` flag — optional.
  redesign_version?: string;
  trim_end_s?: number;
}

interface Manifest {
  production: { title: string; total_shots: number };
  shots: ManifestShot[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function shotMp4Path(shotNumber: number): string {
  return path.join(SHOTS_DIR, `shot_${String(shotNumber).padStart(2, "0")}.mp4`);
}

function shotDescription(shot: ManifestShot): string {
  // Stable, human-readable one-liner used for UI listings + light grep.
  const visual = shot.visual.replace(/\s+/g, " ").trim();
  const short = visual.length > 140 ? visual.slice(0, 137) + "…" : visual;
  return `Shot ${String(shot.id).padStart(2, "0")} · ${shot.section} · ${short}`;
}

// ─── Seeder ─────────────────────────────────────────────────────────────────

async function ensureClient(): Promise<void> {
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, status")
    .eq("id", CLIENT_ID)
    .maybeSingle();
  if (error) throw new Error(`clients check failed: ${error.message}`);
  if (!data) {
    throw new Error(
      `clients.${CLIENT_ID} missing — expected from 10c seed. ` +
        `Cannot proceed (campaigns.client_id FKs this row). Re-run 10c's client seed first.`,
    );
  }
  console.log(`✓ clients.${CLIENT_ID} exists (${data.name}, status=${data.status})`);
}

async function upsertCampaign(): Promise<void> {
  const now = new Date().toISOString();
  const row = {
    id: CAMPAIGN_ID,
    client_id: CLIENT_ID,
    name: CAMPAIGN_NAME,
    prompt:
      "Drift (AI OS) music video — 30-shot catalog regression. Reuse-first " +
      "pipeline test; each existing shot re-graded by the consensus video critic " +
      "and escalated only where reuse fails. See ~/Temp-gen/productions/drift-mv/BRIEF.md.",
    // NB: live schema uses `campaign_mode` enum, valid values include
    // "campaign" (observed in prod). Migration 002 declared `TEXT DEFAULT 'full'`
    // but the live DB was retyped since. Stay consistent with existing rows.
    mode: "campaign",
    max_retries: 3,
    updated_at: now,
  };
  if (DRY_RUN) {
    console.log(`[DRY] campaigns UPSERT id=${CAMPAIGN_ID}`);
    return;
  }
  const { error } = await supabase
    .from("campaigns")
    .upsert(row, { onConflict: "id" });
  if (error) throw new Error(`campaigns upsert failed: ${error.message}`);
  console.log(`✓ campaigns: upserted ${CAMPAIGN_ID} (${CAMPAIGN_NAME})`);
}

async function upsertSeedRun(): Promise<void> {
  const now = new Date().toISOString();
  const row = {
    id: SEED_RUN_ID,
    client_id: CLIENT_ID,
    campaign_id: CAMPAIGN_ID,
    mode: "full" as const,
    status: "completed" as const,
    stages: [],
    started_at: now,
    completed_at: now,
    updated_at: now,
  };
  if (DRY_RUN) {
    console.log(`[DRY] runs UPSERT id=${SEED_RUN_ID}`);
    return;
  }
  const { error } = await supabase
    .from("runs")
    .upsert(row, { onConflict: "id" });
  if (error) throw new Error(`runs upsert failed: ${error.message}`);
  console.log(`✓ runs: upserted synthetic seed run ${SEED_RUN_ID}`);
}

async function upsertDeliverable(shot: ManifestShot): Promise<void> {
  const id = deliverableIdFor(shot.id);
  const row = {
    id,
    campaign_id: CAMPAIGN_ID,
    description: shotDescription(shot),
    ai_model: "veo-3.1-fast-generate-preview",
    current_prompt: shot.veo_prompt,
    original_prompt: shot.veo_prompt,
    status: "pending",
    retry_count: 0,
    // Generation spec columns (migration 006)
    format: null,
    media_type: "video",
    duration_seconds: shot.duration_s,
    aspect_ratio: "16:9",
    resolution: "1080p",
    platform: null,
    quality_tier: "standard",
    reference_images: [
      // Hero still path — runtime grader can pass this as heroStillPath for
      // composition checks. Kept as a filesystem path (dev shortcut; see ADR-005).
      path.join(PRODUCTION_DIR, "stills", `shot_${String(shot.id).padStart(2, "0")}.png`),
    ],
    estimated_cost: 0.75,
    updated_at: new Date().toISOString(),
  };
  if (DRY_RUN) {
    console.log(`[DRY] campaign_deliverables UPSERT shot=${shot.id} id=${id}`);
    return;
  }
  const { error } = await supabase
    .from("campaign_deliverables")
    .upsert(row, { onConflict: "id" });
  if (error) {
    throw new Error(`deliverable shot=${shot.id} upsert failed: ${error.message}`);
  }
}

async function upsertArtifact(shot: ManifestShot): Promise<{ wrote: boolean; reason?: string }> {
  const localPath = shotMp4Path(shot.id);
  if (!existsSync(localPath)) {
    return { wrote: false, reason: `missing mp4 at ${localPath}` };
  }
  const size = statSync(localPath).size;
  const id = artifactIdFor(shot.id);
  const deliverableId = deliverableIdFor(shot.id);
  const row = {
    id,
    run_id: SEED_RUN_ID,
    client_id: CLIENT_ID,
    campaign_id: CAMPAIGN_ID,
    deliverable_id: deliverableId,
    type: "video",
    name: `shot_${String(shot.id).padStart(2, "0")}.mp4`,
    path: localPath,
    storage_path: null,
    stage: "seed",
    size,
    metadata: {
      // Runtime grader prefers metadata.localPath over path — this is the
      // reason the seed exists (reuse-first regression reads the on-disk file).
      localPath,
      source: "drift-mv-production-seed-2026-04-20",
      shotNumber: shot.id,
      section: shot.section,
      veoPrompt: shot.veo_prompt,
      durationSec: shot.duration_s,
      // Light trace so future audits can tell seeded vs runtime-created rows.
      seedScript: "os-api/scripts/seed-drift-mv.ts",
      redesignVersion: shot.redesign_version ?? null,
      trimEndSec: shot.trim_end_s ?? null,
    },
    created_at: new Date().toISOString(),
  };
  if (DRY_RUN) {
    console.log(`[DRY] artifacts UPSERT shot=${shot.id} id=${id} size=${size}B`);
    return { wrote: true };
  }
  const { error } = await supabase
    .from("artifacts")
    .upsert(row, { onConflict: "id" });
  if (error) {
    throw new Error(`artifact shot=${shot.id} upsert failed: ${error.message}`);
  }
  return { wrote: true };
}

async function main(): Promise<void> {
  console.log(`=== seed-drift-mv${DRY_RUN ? " (DRY RUN)" : ""} ===`);
  console.log(`  source: ${PRODUCTION_DIR}`);
  console.log(`  campaign: ${CAMPAIGN_NAME}`);
  console.log(`  campaign_id: ${CAMPAIGN_ID}`);
  console.log(`  seed run_id: ${SEED_RUN_ID}`);
  console.log("");

  // 1. Parse manifest
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`manifest not found at ${MANIFEST_PATH}`);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
  const shots = manifest.shots;
  if (shots.length !== 30) {
    console.warn(
      `⚠ manifest has ${shots.length} shots (expected 30). Proceeding anyway.`,
    );
  }

  // 2. Pre-flight — client row must exist
  await ensureClient();

  // 3. Upsert campaign + synthetic run
  await upsertCampaign();
  await upsertSeedRun();

  // 4. Per-shot upserts — deliverable then artifact
  let deliverableOk = 0;
  let artifactOk = 0;
  let artifactSkipped: { shot: number; reason: string }[] = [];
  for (const shot of shots) {
    await upsertDeliverable(shot);
    deliverableOk++;
    const a = await upsertArtifact(shot);
    if (a.wrote) artifactOk++;
    else artifactSkipped.push({ shot: shot.id, reason: a.reason ?? "unknown" });
  }

  // 5. Summary
  console.log("");
  console.log("=== summary ===");
  console.log(`  deliverables upserted: ${deliverableOk} / ${shots.length}`);
  console.log(`  artifacts upserted:    ${artifactOk} / ${shots.length}`);
  if (artifactSkipped.length > 0) {
    console.log(`  artifacts SKIPPED (missing mp4):`);
    for (const s of artifactSkipped) {
      console.log(`    - shot ${s.shot}: ${s.reason}`);
    }
  }
  console.log("");
  console.log(`Next: verify via 10d-pre-data-sanity.ts — expect 30/30 with ` +
    `metadata.localPath populated on seeded artifacts.`);
  console.log(`Campaign id for Session B launch handoff: ${CAMPAIGN_ID}`);
}

main().catch((err) => {
  console.error("=== SEED FAILED ===");
  console.error(err);
  process.exit(1);
});
