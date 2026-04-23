/**
 * Ingest Drift MV narrative envelope into Supabase JSONB columns.
 *
 * Chunk 1 of the Context-Aware Grading refactor (2026-04-21). Reads:
 *   - ~/Temp-gen/productions/drift-mv/manifest.json (SOLE structured source —
 *     30 shots + 9 sections + 6 characters + production + style)
 *   - ~/Temp-gen/productions/drift-mv/qa_prompt_evolution.md (per-shot
 *     stylization notes for shots 5, 7, 15, 18, 20, 27)
 *
 * Writes:
 *   - campaigns.guardrails.music_video_context on campaign
 *     `42f62a1d-b9df-57d8-8197-470692733391` — title, synopsis, reference tone,
 *     30-entry cache-stable shot_list_summary, manifest_sha256. Preserves any
 *     other keys already in guardrails.
 *   - artifacts.metadata.narrative_context on each of the 30 seeded video
 *     artifacts — shot_number, beat_name, song timing, visual_intent,
 *     characters, previous_shot, next_shot, stylization_allowances,
 *     manifest_sha256. Preserves all existing metadata keys (localPath,
 *     shotNumber, veoPrompt, etc.).
 *
 * Why NOT campaign_deliverables.metadata or campaigns.metadata: those columns
 * don't exist in the live schema (migrations 001-008) and the approved plan
 * disallows migrations. artifacts.metadata + campaigns.guardrails are the
 * existing JSONB homes; the runner + escalation loop read from there.
 *
 * Idempotency: on re-run, compare existing guardrails.music_video_context
 * .manifest_sha256 to fresh. If unchanged and FORCE is unset, prints "no-op"
 * and exits 0.
 *
 * Run:
 *   cd ~/proto_front
 *   (set -a; . os-api/.env; set +a; npx tsx os-api/scripts/ingest-drift-mv-narrative.ts)
 *
 * Flags:
 *   DRY=1     — print envelopes but don't write to DB
 *   FORCE=1   — rebuild even if manifest_sha256 matches
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync } from "fs";
import { createHash } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { supabase } from "../src/supabase.js";
import type {
  BeatName,
  NarrativeContext,
  MusicVideoContext,
  NeighborShotSlim,
} from "../src/types.js";

// ─── Configuration ──────────────────────────────────────────────────────────

const CAMPAIGN_ID = "42f62a1d-b9df-57d8-8197-470692733391";
const PRODUCTION_DIR =
  process.env.DRIFT_MV_PROD_DIR ??
  "/Users/timothysepulvado/Temp-gen/productions/drift-mv";
const MANIFEST_PATH = path.join(PRODUCTION_DIR, "manifest.json");
const QA_PATH = path.join(PRODUCTION_DIR, "qa_prompt_evolution.md");
const DRY = process.env.DRY === "1";
const FORCE = process.env.FORCE === "1";

/**
 * Hand-authored synopsis — the manifest + shot list describe visuals but
 * don't articulate a narrative thesis anywhere the ingester can parse
 * deterministically. Short-form, cache-stable, fed into orchestrator
 * SYSTEM_PROMPT + critic SHOT POSITION section. ≤ 600 chars for token budget.
 */
const DRIFT_MV_SYNOPSIS =
  "Drift (AI OS) is a 3-act AI-war narrative. Act 1: corporate skyscrapers " +
  "fall as terrified workers flee the rubble of competing AI systems. Act 2: " +
  "Brandy the Orchestrator emerges from the smoke with a golden aura, " +
  "methodically converting competing mechs (OpenAI green, Claude purple, Grok " +
  "blue, Gemini) to gold under her control. Act 3: the converted army stands " +
  "unified as Brandy dissolves into golden data points that snap into the " +
  "final BrandStudios.AI logo.";

// ─── Manifest shape (defensive typing) ──────────────────────────────────────

interface ManifestSection {
  id: string;
  start_s: number;
  end_s: number;
  duration_s?: number;
  lyric_cue?: string;
}

interface ManifestCharacter {
  role: string;
  canonical_description?: string;
  anchor_prompt?: string;
  appears_in_shots?: number[];
}

interface ManifestShot {
  id: number;
  section: string;
  duration_s: number;
  start_s: number;
  end_s: number;
  visual: string;
  characters_needed?: string[];
  veo_prompt?: string;
  still_prompt?: string;
}

interface Manifest {
  production: {
    title: string;
    reference_tone: string;
    track_duration_s: number;
    total_shots: number;
  };
  style?: {
    color_palette?: Record<string, string>;
  };
  characters?: Record<string, ManifestCharacter>;
  sections: ManifestSection[];
  shots: ManifestShot[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function truncate(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function hexFromPaletteEntry(entry: string | undefined): string | undefined {
  if (!entry) return undefined;
  const match = entry.match(/#[0-9A-Fa-f]{6}/);
  return match?.[0];
}

function paletteKeyForCharacterSlug(slug: string): string {
  // manifest.characters uses slugs like "mech_openai"; manifest.style.color_palette
  // uses the same key verbatim. Brandy + rappers don't have palette entries
  // (they're in the base palette, not faction colors).
  return slug;
}

/** Parse qa_prompt_evolution.md into { shotNumber: allowances[] }. Only the
 *  6 documented shots (5, 7, 15, 18, 20, 27) produce entries; all others get
 *  an empty array downstream. Pulls the "What changed in v3/v4" bullet list
 *  + the "Pattern" summary line so the critic sees both the concrete
 *  prompt-engineering choices AND the learned-rule rationale. For shots 18 +
 *  27 which have BOTH v3 and v4 entries, the v4 entry (latest) wins.
 */
function parseQAEvolution(md: string): Record<number, string[]> {
  const result: Record<number, string[]> = {};

  // Split by "### Shot NN" header. Preserves document order so v4 sections
  // (later in the file) override earlier v3 entries for the same shot.
  const parts = md.split(/^### Shot (\d+)[^\n]*/m);

  for (let i = 1; i < parts.length; i += 2) {
    const shotNum = parseInt(parts[i], 10);
    const body = parts[i + 1] ?? "";
    const allowances: string[] = [];

    // "What changed in vN:" block → bullet list
    const changeMatch = body.match(
      /\*\*What changed in v\d+:\*\*\s*\n([\s\S]*?)(?=\n\*\*|\n---|\n## )/,
    );
    if (changeMatch) {
      const bullets = changeMatch[1].match(/^- (.+)$/gm) ?? [];
      for (const b of bullets) {
        allowances.push(b.replace(/^- /, "").trim());
      }
    }

    // "Pattern:" / "**Pattern (reinforces #17):**" / "**NEW Pattern (#19):**"
    // line — always single-line, appears after the changes block.
    const patternMatch = body.match(
      /\*\*(?:NEW )?Pattern[^*]*:\*\*\s*([^\n]+)/,
    );
    if (patternMatch) {
      allowances.push(`Pattern: ${patternMatch[1].trim()}`);
    }

    if (allowances.length > 0) {
      result[shotNum] = allowances;
    }
  }
  return result;
}

function neighborSlim(shot: ManifestShot): NeighborShotSlim {
  return {
    shot_number: shot.id,
    beat_name: shot.section as BeatName,
    visual_intent_summary: truncate(shot.visual, 80),
  };
}

// ─── Main ingestion ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(
    `=== ingest-drift-mv-narrative${DRY ? " (DRY)" : ""}${FORCE ? " (FORCE)" : ""} ===`,
  );
  console.log(`  source:       ${PRODUCTION_DIR}`);
  console.log(`  campaign_id:  ${CAMPAIGN_ID}`);
  console.log("");

  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`manifest not found at ${MANIFEST_PATH}`);
  }
  if (!existsSync(QA_PATH)) {
    throw new Error(`qa_prompt_evolution not found at ${QA_PATH}`);
  }

  // 1. Load + hash manifest
  const manifestBytes = readFileSync(MANIFEST_PATH);
  const manifestSha = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;

  console.log(
    `  manifest: ${manifest.shots.length} shots, ${manifest.sections.length} sections, sha256=${manifestSha.slice(0, 12)}…`,
  );

  // 2. Parse qa_prompt_evolution.md
  const qaMd = readFileSync(QA_PATH, "utf8");
  const allowancesByShot = parseQAEvolution(qaMd);
  console.log(
    `  qa-evolution: allowances for ${Object.keys(allowancesByShot).length} shots ` +
      `(${Object.keys(allowancesByShot).sort((a, b) => +a - +b).join(", ")})`,
  );

  // 3. Fetch campaign for idempotency check + guardrails preservation
  const { data: campaign, error: campaignErr } = await supabase
    .from("campaigns")
    .select("id, name, guardrails")
    .eq("id", CAMPAIGN_ID)
    .maybeSingle();
  if (campaignErr) throw new Error(`campaigns read failed: ${campaignErr.message}`);
  if (!campaign) {
    throw new Error(
      `campaign ${CAMPAIGN_ID} not found — seed-drift-mv.ts must run first`,
    );
  }

  const existingGuardrails =
    (campaign.guardrails as Record<string, unknown> | null) ?? {};
  const existingMvc =
    (existingGuardrails.music_video_context as
      | { manifest_sha256?: string }
      | undefined) ?? undefined;

  if (existingMvc?.manifest_sha256 === manifestSha && !FORCE) {
    console.log("");
    console.log(
      `✓ no-op — manifest_sha256 unchanged (${manifestSha.slice(0, 12)}…). ` +
        `Re-run with FORCE=1 to rebuild.`,
    );
    process.exit(0);
  }

  // 4. Build shotsById + sectionsById lookups
  const shotsById: Record<number, ManifestShot> = {};
  for (const s of manifest.shots) shotsById[s.id] = s;
  const sectionsById: Record<string, ManifestSection> = {};
  for (const s of manifest.sections) sectionsById[s.id] = s;

  // 5. Build MusicVideoContext (cache-stable per campaign)
  const ingestedAt = new Date().toISOString();
  const musicVideoContext: MusicVideoContext = {
    title: manifest.production.title,
    synopsis: DRIFT_MV_SYNOPSIS,
    reference_tone: manifest.production.reference_tone,
    total_shots: manifest.production.total_shots ?? manifest.shots.length,
    track_duration_s: manifest.production.track_duration_s,
    shot_list_summary: manifest.shots.map((s) => ({
      shot_number: s.id,
      beat_name: s.section as BeatName,
      visual_intent_summary: truncate(s.visual, 80),
    })),
    ingested_at: ingestedAt,
    manifest_sha256: manifestSha,
  };

  // 6. Build NarrativeContext per shot
  const narrativesByShot: Record<number, NarrativeContext> = {};
  for (const shot of manifest.shots) {
    const section = sectionsById[shot.section];
    const prev = shotsById[shot.id - 1];
    const next = shotsById[shot.id + 1];

    const characters = (shot.characters_needed ?? []).map((slug) => {
      const role = manifest.characters?.[slug]?.role ?? "";
      const paletteKey = paletteKeyForCharacterSlug(slug);
      const color_code = hexFromPaletteEntry(
        manifest.style?.color_palette?.[paletteKey],
      );
      return color_code ? { slug, role, color_code } : { slug, role };
    });

    narrativesByShot[shot.id] = {
      shot_number: shot.id,
      beat_name: shot.section as BeatName,
      song_start_s: section?.start_s ?? shot.start_s,
      song_end_s: section?.end_s ?? shot.end_s,
      visual_intent: shot.visual,
      characters,
      previous_shot: prev ? neighborSlim(prev) : null,
      next_shot: next ? neighborSlim(next) : null,
      stylization_allowances: allowancesByShot[shot.id] ?? [],
      ingested_at: ingestedAt,
      manifest_sha256: manifestSha,
    };
  }

  // 7. Fetch all video artifacts for this campaign
  const { data: artifacts, error: artErr } = await supabase
    .from("artifacts")
    .select("id, metadata, created_at")
    .eq("campaign_id", CAMPAIGN_ID)
    .eq("type", "video");
  if (artErr) throw new Error(`artifacts read failed: ${artErr.message}`);

  if (!artifacts || artifacts.length === 0) {
    throw new Error(
      `no video artifacts found for campaign ${CAMPAIGN_ID} — ` +
        `seed-drift-mv.ts must run first`,
    );
  }

  console.log(`  artifacts:    ${artifacts.length} video rows found`);

  // 8. Group artifacts by shotNumber. Prefer top-level `metadata.shotNumber`
  // (set by seed-drift-mv.ts), fall back to `metadata.narrative_context.shot_number`
  // (set by runner.ts bug #2 fix when forwarding narrative context through
  // regen artifacts — those regens don't get top-level shotNumber). This
  // ensures re-ingest updates ALL artifacts on a deliverable, including
  // forwarded regen artifacts, so v5 allowance updates reach the artifact
  // the runner actually grades (getLatestArtifactByDeliverable picks most-
  // recent, which is often a regen from a prior session).
  const artifactsByShot: Record<number, typeof artifacts> = {};
  for (const a of artifacts) {
    const meta = (a.metadata as Record<string, unknown> | null) ?? {};
    let shotNum = typeof meta.shotNumber === "number" ? meta.shotNumber : null;
    if (shotNum === null) {
      const nc = meta.narrative_context as
        | { shot_number?: number }
        | undefined;
      if (nc && typeof nc.shot_number === "number") {
        shotNum = nc.shot_number;
      }
    }
    if (shotNum === null) continue;
    if (!artifactsByShot[shotNum]) artifactsByShot[shotNum] = [];
    artifactsByShot[shotNum].push(a);
  }

  const shotsWithArtifacts = Object.keys(artifactsByShot).map((k) => +k).sort((a, b) => a - b);
  console.log(`  shots with artifacts: ${shotsWithArtifacts.length} (${shotsWithArtifacts.join(", ")})`);

  // 9. Update each artifact's metadata.narrative_context
  let artifactsUpdated = 0;
  const artifactsSkipped: Array<{ shot: number; reason: string }> = [];
  for (let shotNum = 1; shotNum <= manifest.shots.length; shotNum++) {
    const nc = narrativesByShot[shotNum];
    const shotArtifacts = artifactsByShot[shotNum] ?? [];
    if (!nc) continue;
    if (shotArtifacts.length === 0) {
      artifactsSkipped.push({ shot: shotNum, reason: "no artifact" });
      continue;
    }

    for (const a of shotArtifacts) {
      const oldMeta = (a.metadata as Record<string, unknown> | null) ?? {};
      const newMeta = { ...oldMeta, narrative_context: nc };

      if (DRY) {
        console.log(
          `  [DRY] artifacts.update id=${a.id.slice(0, 8)}… shot=${shotNum} ` +
            `beat=${nc.beat_name} allowances=${nc.stylization_allowances.length}`,
        );
      } else {
        const { error } = await supabase
          .from("artifacts")
          .update({ metadata: newMeta })
          .eq("id", a.id);
        if (error) {
          throw new Error(
            `artifact ${a.id} update failed: ${error.message}`,
          );
        }
      }
      artifactsUpdated++;
    }
  }

  // 10. Update campaign.guardrails.music_video_context (preserve other keys)
  const newGuardrails = {
    ...existingGuardrails,
    music_video_context: musicVideoContext,
  };

  if (DRY) {
    console.log(
      `  [DRY] campaigns.update id=${CAMPAIGN_ID} guardrails.music_video_context ` +
        `(shot_list_summary: ${musicVideoContext.shot_list_summary.length} entries, ` +
        `synopsis: ${musicVideoContext.synopsis.length} chars)`,
    );
  } else {
    const { error } = await supabase
      .from("campaigns")
      .update({ guardrails: newGuardrails })
      .eq("id", CAMPAIGN_ID);
    if (error) throw new Error(`campaigns update failed: ${error.message}`);
  }

  // 11. Summary
  console.log("");
  console.log("=== summary ===");
  console.log(`  music_video_context: ${DRY ? "DRY (not written)" : "written"}`);
  console.log(
    `  artifacts updated:   ${artifactsUpdated} ${DRY ? "(DRY)" : ""}`,
  );
  if (artifactsSkipped.length > 0) {
    console.log(`  shots SKIPPED (missing artifact):`);
    for (const s of artifactsSkipped) {
      console.log(`    - shot ${s.shot}: ${s.reason}`);
    }
  }
  console.log(`  manifest_sha256:     ${manifestSha}`);
  console.log(`  ingested_at:         ${ingestedAt}`);

  if (DRY) {
    console.log("");
    console.log("DRY run — no DB writes performed. Re-run without DRY=1 to apply.");
  }
}

main().catch((err) => {
  console.error("=== INGEST FAILED ===");
  console.error(err);
  process.exit(1);
});
