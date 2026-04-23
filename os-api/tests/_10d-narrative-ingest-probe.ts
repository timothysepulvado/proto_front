/**
 * Gate test for Chunk 1: post-ingestion data sanity on the Drift MV campaign.
 *
 * Runs AFTER `npx tsx os-api/scripts/ingest-drift-mv-narrative.ts`. Asserts:
 *   - campaign 42f62a1d-…  has guardrails.music_video_context (non-null)
 *   - music_video_context.shot_list_summary has exactly 30 entries
 *   - music_video_context.manifest_sha256 matches current manifest file
 *   - all 30 shots have at least one video artifact
 *   - each artifact has metadata.narrative_context (non-null)
 *   - per-shot narrative_context.shot_number matches its position (1..30)
 *   - narrative_context.beat_name is one of the 9 canonical BeatName values
 *   - narrative_context.previous_shot is null only for shot 1
 *   - narrative_context.next_shot is null only for shot 30
 *   - narrative_context.manifest_sha256 matches campaign's sha256 (consistency)
 *   - 6 shots (5, 7, 15, 18, 20, 27) have non-empty stylization_allowances
 *
 * Usage:
 *   (set -a; . os-api/.env; set +a; npx tsx os-api/tests/_10d-narrative-ingest-probe.ts)
 *
 * Exits non-zero on any assertion failure.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { supabase } from "../src/supabase.js";
import type { BeatName, NarrativeContext, MusicVideoContext } from "../src/types.js";

const CAMPAIGN_ID = "42f62a1d-b9df-57d8-8197-470692733391";
const PRODUCTION_DIR =
  process.env.DRIFT_MV_PROD_DIR ??
  "/Users/timothysepulvado/Temp-gen/productions/drift-mv";
const MANIFEST_PATH = path.join(PRODUCTION_DIR, "manifest.json");

const VALID_BEATS: BeatName[] = [
  "intro",
  "hook_1",
  "verse_1",
  "hook_2",
  "verse_2",
  "bridge",
  "hook_3",
  "final_hook",
  "outro",
];

const DOCUMENTED_STYLIZATION_SHOTS = new Set([5, 7, 15, 18, 20, 27]);

type Check = { name: string; run: () => void | Promise<void> };
const checks: Check[] = [];
function check(name: string, run: () => void | Promise<void>): void {
  checks.push({ name, run });
}

// ─── Preload context ──────────────────────────────────────────────────────

async function preload(): Promise<{
  expectedSha: string;
  campaignGuardrails: Record<string, unknown> | null;
  mvc: MusicVideoContext;
  artifactsByShot: Record<number, Array<{ id: string; metadata: Record<string, unknown> }>>;
}> {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`manifest not found at ${MANIFEST_PATH}`);
  }
  const expectedSha = createHash("sha256")
    .update(readFileSync(MANIFEST_PATH))
    .digest("hex");

  const { data: campaign, error: campErr } = await supabase
    .from("campaigns")
    .select("id, guardrails")
    .eq("id", CAMPAIGN_ID)
    .maybeSingle();
  if (campErr) throw new Error(`campaigns read failed: ${campErr.message}`);
  if (!campaign) throw new Error(`campaign ${CAMPAIGN_ID} not found`);

  const guardrails =
    (campaign.guardrails as Record<string, unknown> | null) ?? null;
  const mvc = (guardrails?.music_video_context as MusicVideoContext | undefined);
  if (!mvc) {
    throw new Error(
      `campaign.guardrails.music_video_context not found — run ingester first`,
    );
  }

  const { data: artifacts, error: artErr } = await supabase
    .from("artifacts")
    .select("id, metadata")
    .eq("campaign_id", CAMPAIGN_ID)
    .eq("type", "video");
  if (artErr) throw new Error(`artifacts read failed: ${artErr.message}`);

  const artifactsByShot: Record<
    number,
    Array<{ id: string; metadata: Record<string, unknown> }>
  > = {};
  for (const a of artifacts ?? []) {
    const meta = (a.metadata as Record<string, unknown> | null) ?? {};
    const shotNum = typeof meta.shotNumber === "number" ? meta.shotNumber : null;
    if (shotNum === null) continue;
    if (!artifactsByShot[shotNum]) artifactsByShot[shotNum] = [];
    artifactsByShot[shotNum].push({ id: a.id, metadata: meta });
  }

  return { expectedSha, campaignGuardrails: guardrails, mvc, artifactsByShot };
}

const ctx = await preload();

// ─── Campaign-level assertions ────────────────────────────────────────────

check("campaign.guardrails.music_video_context.title non-empty", () => {
  assert.ok(typeof ctx.mvc.title === "string" && ctx.mvc.title.length > 0);
});

check("campaign.guardrails.music_video_context.synopsis non-empty", () => {
  assert.ok(
    typeof ctx.mvc.synopsis === "string" && ctx.mvc.synopsis.length >= 100,
    `synopsis too short: ${ctx.mvc.synopsis?.length ?? 0} chars`,
  );
});

check("campaign.guardrails.music_video_context.reference_tone non-empty", () => {
  assert.ok(
    typeof ctx.mvc.reference_tone === "string" && ctx.mvc.reference_tone.length > 0,
  );
});

check("music_video_context.shot_list_summary has exactly 30 entries", () => {
  assert.equal(ctx.mvc.shot_list_summary.length, 30);
});

check("music_video_context.shot_list_summary: shot_numbers are 1..30 in order", () => {
  const numbers = ctx.mvc.shot_list_summary.map((s) => s.shot_number);
  assert.deepEqual(numbers, Array.from({ length: 30 }, (_, i) => i + 1));
});

check("music_video_context.shot_list_summary: beat_names are valid BeatName", () => {
  for (const s of ctx.mvc.shot_list_summary) {
    assert.ok(
      (VALID_BEATS as string[]).includes(s.beat_name),
      `invalid beat_name: ${s.beat_name} (shot ${s.shot_number})`,
    );
  }
});

check("music_video_context.shot_list_summary: each summary ≤ 80 chars", () => {
  for (const s of ctx.mvc.shot_list_summary) {
    assert.ok(
      s.visual_intent_summary.length <= 80,
      `shot ${s.shot_number}: summary ${s.visual_intent_summary.length} chars > 80`,
    );
  }
});

check("music_video_context.manifest_sha256 matches current manifest file", () => {
  assert.equal(ctx.mvc.manifest_sha256, ctx.expectedSha);
});

check("music_video_context.total_shots === 30", () => {
  assert.equal(ctx.mvc.total_shots, 30);
});

// ─── Per-shot artifact assertions ────────────────────────────────────────

check("all 30 shots have at least one video artifact", () => {
  for (let n = 1; n <= 30; n++) {
    const arts = ctx.artifactsByShot[n] ?? [];
    assert.ok(arts.length >= 1, `shot ${n} has no video artifact`);
  }
});

check("every video artifact has metadata.narrative_context", () => {
  for (let n = 1; n <= 30; n++) {
    for (const a of ctx.artifactsByShot[n] ?? []) {
      assert.ok(
        a.metadata?.narrative_context,
        `artifact ${a.id} (shot ${n}) missing metadata.narrative_context`,
      );
    }
  }
});

check("narrative_context.shot_number matches enclosing shot position", () => {
  for (let n = 1; n <= 30; n++) {
    for (const a of ctx.artifactsByShot[n] ?? []) {
      const nc = a.metadata.narrative_context as NarrativeContext;
      assert.equal(
        nc.shot_number,
        n,
        `artifact ${a.id}: shot_number=${nc.shot_number}, expected ${n}`,
      );
    }
  }
});

check("narrative_context.beat_name is valid BeatName (every shot)", () => {
  for (let n = 1; n <= 30; n++) {
    for (const a of ctx.artifactsByShot[n] ?? []) {
      const nc = a.metadata.narrative_context as NarrativeContext;
      assert.ok(
        (VALID_BEATS as string[]).includes(nc.beat_name),
        `shot ${n}: invalid beat_name ${nc.beat_name}`,
      );
    }
  }
});

check("narrative_context.previous_shot is null only for shot 1", () => {
  for (let n = 1; n <= 30; n++) {
    for (const a of ctx.artifactsByShot[n] ?? []) {
      const nc = a.metadata.narrative_context as NarrativeContext;
      if (n === 1) {
        assert.equal(nc.previous_shot, null, "shot 1 previous_shot should be null");
      } else {
        assert.ok(
          nc.previous_shot !== null,
          `shot ${n} previous_shot should not be null`,
        );
        assert.equal(
          nc.previous_shot?.shot_number,
          n - 1,
          `shot ${n} previous_shot.shot_number mismatch`,
        );
      }
    }
  }
});

check("narrative_context.next_shot is null only for shot 30", () => {
  for (let n = 1; n <= 30; n++) {
    for (const a of ctx.artifactsByShot[n] ?? []) {
      const nc = a.metadata.narrative_context as NarrativeContext;
      if (n === 30) {
        assert.equal(nc.next_shot, null, "shot 30 next_shot should be null");
      } else {
        assert.ok(
          nc.next_shot !== null,
          `shot ${n} next_shot should not be null`,
        );
        assert.equal(
          nc.next_shot?.shot_number,
          n + 1,
          `shot ${n} next_shot.shot_number mismatch`,
        );
      }
    }
  }
});

check("narrative_context.manifest_sha256 matches campaign music_video_context", () => {
  for (let n = 1; n <= 30; n++) {
    for (const a of ctx.artifactsByShot[n] ?? []) {
      const nc = a.metadata.narrative_context as NarrativeContext;
      assert.equal(
        nc.manifest_sha256,
        ctx.expectedSha,
        `shot ${n}: narrative_context.manifest_sha256 mismatch`,
      );
    }
  }
});

check("6 QA-documented shots have non-empty stylization_allowances", () => {
  for (const shotNum of DOCUMENTED_STYLIZATION_SHOTS) {
    const arts = ctx.artifactsByShot[shotNum] ?? [];
    assert.ok(arts.length > 0);
    for (const a of arts) {
      const nc = a.metadata.narrative_context as NarrativeContext;
      assert.ok(
        nc.stylization_allowances.length > 0,
        `shot ${shotNum}: expected non-empty stylization_allowances`,
      );
    }
  }
});

check("ALL 30 shots have non-empty stylization_allowances post v5 ingest (2026-04-23)", () => {
  // Added after Phase 2B of plan `fresh-context-today-is-glowing-harp.md`:
  // Jackie authored v5 entries for the 24 non-stylized shots so the
  // narrative-aware critic treats intentional production stylization as
  // within the STYLIZATION BUDGET. This assertion guards against the v5
  // entries being removed / the ingester regressing / a fresh seed wiping
  // allowances on any shot.
  for (let shotNum = 1; shotNum <= 30; shotNum++) {
    const arts = ctx.artifactsByShot[shotNum] ?? [];
    assert.ok(arts.length > 0, `shot ${shotNum}: no artifacts found`);
    for (const a of arts) {
      const nc = a.metadata.narrative_context as NarrativeContext;
      assert.ok(
        nc.stylization_allowances.length > 0,
        `shot ${shotNum}: expected non-empty stylization_allowances (v5 should have landed for non-stylized shots)`,
      );
    }
  }
});

// Pre-v5 invariant retired (2026-04-23): used to assert that ONLY shots 5, 7,
// 15, 18, 20, 27 had allowances. Phase 2B of plan `fresh-context-today-is-
// glowing-harp.md` added v5 allowances for the other 24 non-stylized shots
// so the narrative-aware critic treats intentional production stylization as
// within the STYLIZATION BUDGET. The "ALL 30 shots" assertion above replaces
// this; the pre-v5 invariant is no longer meaningful. Kept as a commented
// reference so the history is traceable, not re-asserted.
//
// check("non-documented shots have empty stylization_allowances", () => {
//   for (let n = 1; n <= 30; n++) {
//     if (DOCUMENTED_STYLIZATION_SHOTS.has(n)) continue;
//     ... used to assert length === 0 ...
//   }
// });

// ─── Seed-metadata preservation ──────────────────────────────────────────

check("artifact.metadata preserves localPath from seed", () => {
  for (let n = 1; n <= 30; n++) {
    for (const a of ctx.artifactsByShot[n] ?? []) {
      assert.ok(
        typeof a.metadata.localPath === "string" &&
          (a.metadata.localPath as string).includes("shot_"),
        `artifact ${a.id}: localPath lost after ingestion`,
      );
    }
  }
});

// ─── Run ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const c of checks) {
  try {
    await c.run();
    console.log(`  ✓ ${c.name}`);
    passed++;
  } catch (err) {
    console.log(`  ✘ ${c.name}`);
    console.log(`    ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}
console.log("");
console.log(
  `10d narrative ingest probe — ${passed} pass, ${failed} fail, ${checks.length} total`,
);
process.exit(failed > 0 ? 1 : 0);
