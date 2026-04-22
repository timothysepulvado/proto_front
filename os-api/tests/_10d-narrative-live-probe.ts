/**
 * Live regression probe for Chunk 1: ensures the narrative-enriched critic
 * call against Shot 20 still scores PASS ≥ 4.5.
 *
 * Session A's Shot 20 smoke (2bce7bc9-…) returned PASS 4.9 with no narrative
 * context. This probe repeats the call with narrative_context + music_video
 * _synopsis injected — verdict must NOT regress. A drop to WARN/FAIL here
 * signals that the prompt-shape changes materially affected Gemini's scoring.
 *
 * Requires:
 *   - brand-engine sidecar running on :8100
 *   - GOOGLE_GENAI_API_KEY (or GEMINI_API_KEY / GOOGLE_API_KEY) in env
 *
 * Usage:
 *   cd ~/proto_front/brand-engine && python -m api.server &    # if :8100 is down
 *   (set -a; . os-api/.env; set +a; npx tsx os-api/tests/_10d-narrative-live-probe.ts)
 *
 * Exits 0 on PASS with aggregate_score ≥ 4.5. Exits non-zero otherwise.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import type { VideoGradeResult } from "../src/types.js";

const BRAND_ENGINE_URL =
  process.env.BRAND_ENGINE_URL ?? "http://localhost:8100";
const SHOT_20_PATH =
  process.env.DRIFT_MV_SHOT_20_PATH ??
  "/Users/timothysepulvado/Temp-gen/productions/drift-mv/shots/shot_20.mp4";

// Synthetic narrative_context for Shot 20 — mirrors what the ingester writes
// but is hard-coded here so the probe is a pure prompt-shape regression
// independent of DB state.
const NARRATIVE_SHOT_20 = {
  shot_number: 20,
  beat_name: "hook_3",
  song_start_s: 135.0,
  song_end_s: 143.0,
  visual_intent:
    "Four converted mechs standing in front-left sunlight against darker sky — faction colors remain clearly distinguishable.",
  characters: [
    { slug: "mech_openai", role: "converted", color_code: "#1A8C3E" },
    { slug: "mech_claude", role: "converted", color_code: "#9B59B6" },
    { slug: "mech_grok", role: "converted", color_code: "#2980B9" },
    { slug: "mech_gemini", role: "converted" },
  ],
  previous_shot: {
    shot_number: 19,
    beat_name: "hook_3",
    visual_intent_summary: "Brandy raises her arm — mechs converge in formation",
  },
  next_shot: {
    shot_number: 21,
    beat_name: "hook_3",
    visual_intent_summary: "Brandy walks forward toward camera, slow motion",
  },
  stylization_allowances: [
    "Front-left lighting intentional — replaces warm-backlight wash failure (Pattern #17)",
    "Pattern: Front/side lighting for color distinction — backlight + warm = subject color wash.",
    "Faction-color distinguishability is the PRIMARY intent; scoring must weight this.",
  ],
  ingested_at: "2026-04-21T00:00:00Z",
  manifest_sha256: "regression-probe-synthetic",
};

const MUSIC_VIDEO_SYNOPSIS =
  "Drift (AI OS) is a 3-act AI-war narrative: corporate skyscrapers fall; " +
  "Brandy the Orchestrator converts rival AI mechs to gold; the unified army " +
  "dissolves into the BrandStudios.AI logo.";

const MIN_SCORE = 4.5;

async function main(): Promise<void> {
  if (!existsSync(SHOT_20_PATH)) {
    console.error(`Shot 20 mp4 not found at ${SHOT_20_PATH}`);
    process.exit(1);
  }

  console.log(`=== 10d narrative live probe ===`);
  console.log(`  brand_engine: ${BRAND_ENGINE_URL}`);
  console.log(`  shot:         ${SHOT_20_PATH}`);
  console.log(`  min_score:    ${MIN_SCORE} (PASS regression bar)`);
  console.log("");

  // Pre-flight: /health
  try {
    const health = await fetch(`${BRAND_ENGINE_URL}/health`);
    if (!health.ok) {
      console.error(`brand-engine /health failed: ${health.status}`);
      console.error("Start: cd ~/proto_front/brand-engine && python -m api.server");
      process.exit(1);
    }
  } catch (err) {
    console.error(
      `brand-engine unreachable at ${BRAND_ENGINE_URL}: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error("Start: cd ~/proto_front/brand-engine && python -m api.server");
    process.exit(1);
  }
  console.log("  ✓ /health green");

  const t0 = Date.now();
  const resp = await fetch(`${BRAND_ENGINE_URL}/grade_video`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      video_path: SHOT_20_PATH,
      brand_slug: "drift-mv",
      deliverable_context:
        "Shot 20 — four converted mechs in formation under front-left sunlight",
      consensus: true,
      narrative_context: NARRATIVE_SHOT_20,
      music_video_synopsis: MUSIC_VIDEO_SYNOPSIS,
    }),
  });
  const latencyMs = Date.now() - t0;

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`/grade_video ${resp.status}: ${body.slice(0, 500)}`);
    process.exit(1);
  }

  const verdict = (await resp.json()) as VideoGradeResult;
  console.log("");
  console.log(`=== verdict ===`);
  console.log(`  verdict:         ${verdict.verdict}`);
  console.log(`  aggregate_score: ${verdict.aggregate_score}`);
  console.log(`  confidence:      ${verdict.confidence}`);
  console.log(`  recommendation:  ${verdict.recommendation}`);
  console.log(`  consensus_note:  ${verdict.consensus_note ?? "(none)"}`);
  console.log(`  latency:         ${latencyMs}ms`);
  console.log("");

  try {
    assert.equal(
      verdict.verdict,
      "PASS",
      `Shot 20 regressed — expected PASS, got ${verdict.verdict}`,
    );
    assert.ok(
      verdict.aggregate_score >= MIN_SCORE,
      `Shot 20 score regression — ${verdict.aggregate_score} < ${MIN_SCORE}`,
    );
    console.log(`=== ASSERTIONS PASSED ===`);
    console.log(
      `✓ Shot 20 verdict=PASS, aggregate=${verdict.aggregate_score} ≥ ${MIN_SCORE}`,
    );
    console.log(
      `  Prompt-shape change did not regress critic behavior.`,
    );
    process.exit(0);
  } catch (err) {
    console.error(
      `\n=== REGRESSION ===\n${err instanceof Error ? err.message : String(err)}`,
    );
    console.error("\nFull verdict JSON:");
    console.error(JSON.stringify(verdict, null, 2));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("=== PROBE FAILED ===");
  console.error(err);
  process.exit(1);
});
