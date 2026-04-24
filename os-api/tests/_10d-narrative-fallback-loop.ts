/**
 * Gate test for Bug #2 RESIDUAL fix (2026-04-24): orchestrator-side
 * narrative_context fallback via QAFailureContext.narrativeContextOverride.
 *
 * Symptom (chunk 3 PARTIAL evidence): mid-loop regen artifacts lack
 * metadata.narrative_context because createArtifactWithUpload doesn't
 * forward it. The runner closed this gap for the CRITIC by computing a
 * resolved narrativeContext (initial-artifact + seeded-artifact fallback)
 * and passing it to /grade_video. The ORCHESTRATOR call site inside
 * handleQAFailure still read narrative_context from artifact.metadata
 * directly (`_extractNarrativeContext(artifact)`), so iteration 2+ ran
 * Claude without the music-video shot position / stylization budget —
 * silently regressing context-aware grading on every regen.
 *
 * This gate exercises the new pure helper `_resolveNarrativeContext` which
 * the runner uses to plumb the resolved envelope to handleQAFailure via
 * `narrativeContextOverride`. No Supabase / Anthropic deps; entirely
 * in-memory shape assertions.
 *
 * Pass criteria: 9/9 assertions.
 *
 * Run via:
 *   cd os-api && npx tsx tests/_10d-narrative-fallback-loop.ts
 */
import { strict as assert } from "node:assert";
import { _resolveNarrativeContext } from "../src/escalation_loop.js";
import type { Artifact, NarrativeContext } from "../src/types.js";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${(err as Error).message}`);
    failed++;
  }
}

console.log("\n_10d-narrative-fallback-loop: bug #2 residual orchestrator override\n");

// ── Fixtures ────────────────────────────────────────────────────────────
const baseArtifact = (metadata: Record<string, unknown> | undefined): Artifact => ({
  id: "artifact-test-id",
  runId: "run-test-id",
  deliverableId: "deliverable-test-id",
  type: "video",
  name: "shot_11.mp4",
  path: "/tmp/shot_11.mp4",
  size: 1024,
  metadata,
  createdAt: new Date().toISOString(),
});

const validNc: NarrativeContext = {
  shot_number: 11,
  beat_name: "verse_1",
  song_start_s: 75.0,
  song_end_s: 82.0,
  visual_intent: "Dynamic lateral tracking — Brandy and the duo at high noon",
  characters: [{ slug: "brandy", role: "lead" }],
  previous_shot: null,
  next_shot: null,
  stylization_allowances: ["Lens flare on impact intentional"],
  ingested_at: "2026-04-24T00:00:00Z",
  manifest_sha256: "deadbeef",
};

const validNcOverride: NarrativeContext = {
  ...validNc,
  shot_number: 12, // Different to prove override beats artifact metadata
  beat_name: "verse_1",
  visual_intent: "Slow dolly-in on the duo (override version)",
};

// ── 1. Override provided → wins over artifact metadata ─────────────────
check("override is used when both override and artifact metadata are present", () => {
  const ctx = {
    artifact: baseArtifact({ narrative_context: validNc }),
    narrativeContextOverride: validNcOverride,
  };
  const result = _resolveNarrativeContext(ctx);
  assert.equal(result?.shot_number, 12, "expected override shot_number=12");
  assert.equal(result?.visual_intent, validNcOverride.visual_intent);
});

// ── 2. Override provided + artifact metadata empty → override wins ─────
check("override is used when artifact metadata has no narrative_context", () => {
  const ctx = {
    artifact: baseArtifact({}),
    narrativeContextOverride: validNcOverride,
  };
  const result = _resolveNarrativeContext(ctx);
  assert.equal(result?.shot_number, 12);
});

// ── 3. Override provided + artifact metadata is missing → override wins ───
check("override is used when artifact metadata is undefined", () => {
  const ctx = {
    artifact: baseArtifact(undefined),
    narrativeContextOverride: validNcOverride,
  };
  const result = _resolveNarrativeContext(ctx);
  assert.equal(result?.shot_number, 12);
});

// ── 4. No override → fall back to artifact metadata extraction ─────────
check("when no override given, _extractNarrativeContext is the fallback", () => {
  const ctx = {
    artifact: baseArtifact({ narrative_context: validNc }),
  };
  const result = _resolveNarrativeContext(ctx);
  assert.equal(result?.shot_number, 11, "expected artifact shot_number=11");
  assert.equal(result?.visual_intent, validNc.visual_intent);
});

// ── 5. No override + artifact metadata empty → undefined ───────────────
check("when no override and artifact has no narrative_context → undefined", () => {
  const ctx = { artifact: baseArtifact({}) };
  const result = _resolveNarrativeContext(ctx);
  assert.equal(result, undefined);
});

// ── 6. No override + artifact metadata is missing → undefined ──────────
check("when no override and artifact metadata is undefined → undefined", () => {
  const ctx = { artifact: baseArtifact(undefined) };
  const result = _resolveNarrativeContext(ctx);
  assert.equal(result, undefined);
});

// ── 7. Override is undefined explicitly → fall back to extraction ──────
check("explicit undefined override falls back to extraction (matches optional semantics)", () => {
  const ctx = {
    artifact: baseArtifact({ narrative_context: validNc }),
    narrativeContextOverride: undefined,
  };
  const result = _resolveNarrativeContext(ctx);
  assert.equal(result?.shot_number, 11, "explicit undefined behaves as no-override");
});

// ── 8. Override provided + malformed artifact metadata → override wins ─
check("override survives even when artifact metadata is malformed", () => {
  const ctx = {
    artifact: baseArtifact({
      narrative_context: { not_a_real: "narrative_context" },
    }),
    narrativeContextOverride: validNcOverride,
  };
  const result = _resolveNarrativeContext(ctx);
  assert.equal(result?.shot_number, 12);
});

// ── 9. No override + malformed artifact metadata → undefined ───────────
check("malformed artifact narrative_context returns undefined (existing _isNarrativeContext guard)", () => {
  const ctx = {
    artifact: baseArtifact({
      narrative_context: { not_a_real: "narrative_context" },
    }),
  };
  const result = _resolveNarrativeContext(ctx);
  assert.equal(result, undefined);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  console.log("=== FAILED ===");
  process.exit(1);
}
console.log("=== ASSERTIONS PASSED ===");
process.exit(0);
