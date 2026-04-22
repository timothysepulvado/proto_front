/**
 * Gate test for Chunk 1: narrative-envelope prompt shaping.
 *
 * Arg-shape + rendering assertions. No live Anthropic or Gemini calls. No
 * Supabase. Run via:
 *   (set -a; . os-api/.env; set +a; npx tsx os-api/tests/_10d-narrative-prompt-shape.ts)
 *
 * Covers:
 *   - buildSystemPrompt(): non-MV mode (preamble + core, no MUSIC VIDEO CONTEXT)
 *   - buildSystemPrompt(mvc): MV mode (cache-stable shot list appended)
 *   - buildUserMessage() without narrativeContext: backwards-compat (no new sections)
 *   - buildUserMessage() with narrativeContext: SHOT POSITION + NEIGHBOR SHOTS + STYLIZATION BUDGET
 *   - Shot 1 fixture (previous_shot=null) renders "(no previous shot…)"
 *   - Shot 30 fixture (next_shot=null) renders "(no next shot…)"
 *   - Stylization allowances render as bullet list when non-empty
 *   - Continuity rule appends to YOUR TASK footer only when narrativeContext present
 *   - SYSTEM_PROMPT alias matches buildSystemPrompt() (non-MV default)
 *
 * Prints PASS/FAIL per check and exits non-zero on any failure.
 */
import assert from "node:assert/strict";

import {
  SYSTEM_PROMPT,
  buildSystemPrompt,
  buildUserMessage,
} from "../src/orchestrator_prompts.js";
import type {
  Artifact,
  BeatName,
  CampaignDeliverable,
  MusicVideoContext,
  NarrativeContext,
  VideoGradeResult,
} from "../src/types.js";

type Check = { name: string; run: () => void };
const checks: Check[] = [];
function check(name: string, run: () => void): void {
  checks.push({ name, run });
}

// ─── Fixtures ────────────────────────────────────────────────────────────

const baseArtifact: Artifact = {
  id: "art-1",
  runId: "run-1",
  type: "video",
  name: "shot_20.mp4",
  path: "/tmp/shot_20.mp4",
  createdAt: "2026-04-21T00:00:00Z",
};

const baseDeliverable: CampaignDeliverable = {
  id: "del-1",
  campaignId: "camp-drift",
  status: "generating",
  retryCount: 0,
  createdAt: "2026-04-21T00:00:00Z",
  updatedAt: "2026-04-21T00:00:00Z",
  mediaType: "video",
  durationSeconds: 8,
  description: "Shot 20",
};

const baseVerdict: VideoGradeResult = {
  verdict: "PASS",
  aggregate_score: 4.9,
  criteria: [],
  detected_failure_classes: [],
  confidence: 0.95,
  summary: "fixture",
  reasoning: "fixture",
  recommendation: "ship",
  model: "gemini-3.1-pro-preview",
  cost: 0.0,
  latency_ms: 100,
};

const MV_CONTEXT: MusicVideoContext = {
  title: "Drift (AI OS) — Music Video",
  synopsis:
    "Brandy the Orchestrator methodically converts rival AI mechs to gold. " +
    "Act 3 ends with the unified army dissolving into the BrandStudios.AI logo.",
  reference_tone:
    "Jay-Z/Kanye 'Run This Town' meets The Matrix Revolutions + Man of Steel",
  total_shots: 30,
  track_duration_s: 213,
  shot_list_summary: Array.from({ length: 30 }, (_, i) => {
    const beats: BeatName[] = [
      "intro",
      "intro",
      "hook_1",
      "hook_1",
      "hook_1",
      "verse_1",
      "verse_1",
      "verse_1",
      "verse_1",
      "verse_1",
      "hook_2",
      "hook_2",
      "hook_2",
      "verse_2",
      "verse_2",
      "verse_2",
      "verse_2",
      "verse_2",
      "hook_3",
      "hook_3",
      "hook_3",
      "bridge",
      "bridge",
      "bridge",
      "final_hook",
      "final_hook",
      "final_hook",
      "outro",
      "outro",
      "outro",
    ];
    return {
      shot_number: i + 1,
      beat_name: beats[i],
      visual_intent_summary: `Synthetic shot ${i + 1} summary for fixture`,
    };
  }),
  ingested_at: "2026-04-21T00:00:00Z",
  manifest_sha256: "abcdef01234567",
};

function narrativeFixture(
  overrides: Partial<NarrativeContext> = {},
): NarrativeContext {
  return {
    shot_number: 20,
    beat_name: "hook_3",
    song_start_s: 135.0,
    song_end_s: 143.0,
    visual_intent:
      "Four converted mechs standing in front-left sunlight against darker sky",
    characters: [
      { slug: "mech_openai", role: "converted", color_code: "#1A8C3E" },
    ],
    previous_shot: {
      shot_number: 19,
      beat_name: "hook_3",
      visual_intent_summary: "Brandy raises her arm — mechs converge",
    },
    next_shot: {
      shot_number: 21,
      beat_name: "hook_3",
      visual_intent_summary: "Brandy walks forward toward camera, slow motion",
    },
    stylization_allowances: [
      "Front-left lighting intentional — replaces warm-backlight wash failure",
      "Pattern: Front/side lighting for color distinction.",
    ],
    ingested_at: "2026-04-21T00:00:00Z",
    manifest_sha256: "abcdef01234567",
    ...overrides,
  };
}

// ─── buildSystemPrompt tests ──────────────────────────────────────────────

check("buildSystemPrompt() non-MV: contains self-awareness preamble", () => {
  const sp = buildSystemPrompt();
  assert.ok(
    sp.includes("You are Claude Opus 4.7 running the BrandStudios escalation"),
    "preamble not rendered",
  );
});

check("buildSystemPrompt() non-MV: does NOT contain MUSIC VIDEO CONTEXT", () => {
  const sp = buildSystemPrompt();
  assert.ok(
    !sp.includes("## MUSIC VIDEO CONTEXT"),
    "MUSIC VIDEO CONTEXT leaked into non-MV prompt",
  );
});

check("buildSystemPrompt() non-MV: contains core doctrine", () => {
  const sp = buildSystemPrompt();
  assert.ok(sp.includes("# THE SHOT ESCALATION LADDER"), "doctrine missing");
  assert.ok(sp.includes("# OUTPUT JSON SCHEMA"), "schema section missing");
});

check("SYSTEM_PROMPT alias === buildSystemPrompt()", () => {
  assert.equal(SYSTEM_PROMPT, buildSystemPrompt());
});

check("buildSystemPrompt(mvc): includes MUSIC VIDEO CONTEXT section", () => {
  const sp = buildSystemPrompt(MV_CONTEXT);
  assert.ok(sp.includes("## MUSIC VIDEO CONTEXT"), "section missing");
  assert.ok(sp.includes("Drift (AI OS) — Music Video"), "title missing");
  assert.ok(sp.includes("Synopsis:"), "synopsis label missing");
  assert.ok(sp.includes("Reference tone:"), "tone label missing");
});

check("buildSystemPrompt(mvc): Full shot list has exactly 30 entries", () => {
  const sp = buildSystemPrompt(MV_CONTEXT);
  const lines = sp.match(/^- Shot \d+ \(/gm) ?? [];
  assert.equal(lines.length, 30, `got ${lines.length} shot list entries`);
});

check("buildSystemPrompt(mvc): preamble still present in MV mode", () => {
  const sp = buildSystemPrompt(MV_CONTEXT);
  assert.ok(sp.includes("You are Claude Opus 4.7 running"));
});

// ─── buildUserMessage backwards-compat (no narrativeContext) ─────────────

check("buildUserMessage without narrativeContext: no SHOT POSITION", () => {
  const msg = buildUserMessage({
    artifact: baseArtifact,
    qaVerdict: baseVerdict,
    promptHistory: [],
    catalog: [],
    attemptCount: 0,
    escalationLevel: "L1",
    deliverable: baseDeliverable,
    campaignContext: { brandSlug: "drift-mv" },
    todayDate: "2026-04-21",
  });
  assert.ok(!msg.includes("## SHOT POSITION"), "SHOT POSITION leaked");
  assert.ok(!msg.includes("## NEIGHBOR SHOTS"), "NEIGHBOR SHOTS leaked");
  assert.ok(!msg.includes("## STYLIZATION BUDGET"), "STYLIZATION BUDGET leaked");
});

check("buildUserMessage without narrativeContext: no Continuity rule", () => {
  const msg = buildUserMessage({
    artifact: baseArtifact,
    qaVerdict: baseVerdict,
    promptHistory: [],
    catalog: [],
    attemptCount: 0,
    escalationLevel: "L1",
    deliverable: baseDeliverable,
    campaignContext: { brandSlug: "drift-mv" },
    todayDate: "2026-04-21",
  });
  assert.ok(!msg.includes("Continuity rule"), "Continuity rule leaked");
});

// ─── buildUserMessage WITH narrativeContext ──────────────────────────────

check("buildUserMessage with narrative: SHOT POSITION renders Shot + Beat + Song + Visual intent", () => {
  const nc = narrativeFixture();
  const msg = buildUserMessage({
    artifact: baseArtifact,
    qaVerdict: baseVerdict,
    promptHistory: [],
    catalog: [],
    attemptCount: 0,
    escalationLevel: "L1",
    deliverable: baseDeliverable,
    campaignContext: { brandSlug: "drift-mv" },
    todayDate: "2026-04-21",
    narrativeContext: nc,
  });
  assert.ok(msg.includes("## SHOT POSITION"));
  assert.ok(msg.includes("Shot 20 of 30"));
  assert.ok(msg.includes("Beat: hook_3"));
  assert.ok(msg.includes("135.0s–143.0s"));
  assert.ok(msg.includes("Four converted mechs"));
});

check("buildUserMessage with narrative: NEIGHBOR SHOTS renders previous + next", () => {
  const nc = narrativeFixture();
  const msg = buildUserMessage({
    artifact: baseArtifact,
    qaVerdict: baseVerdict,
    promptHistory: [],
    catalog: [],
    attemptCount: 0,
    escalationLevel: "L1",
    deliverable: baseDeliverable,
    campaignContext: { brandSlug: "drift-mv" },
    todayDate: "2026-04-21",
    narrativeContext: nc,
  });
  assert.ok(msg.includes("## NEIGHBOR SHOTS"));
  assert.ok(msg.includes("Previous — Shot 19"));
  assert.ok(msg.includes("Brandy raises her arm"));
  assert.ok(msg.includes("Next — Shot 21"));
  assert.ok(msg.includes("Brandy walks forward"));
});

check("buildUserMessage with narrative: STYLIZATION BUDGET bullets render + VERDICT RULES note", () => {
  const nc = narrativeFixture();
  const msg = buildUserMessage({
    artifact: baseArtifact,
    qaVerdict: baseVerdict,
    promptHistory: [],
    catalog: [],
    attemptCount: 0,
    escalationLevel: "L1",
    deliverable: baseDeliverable,
    campaignContext: { brandSlug: "drift-mv" },
    todayDate: "2026-04-21",
    narrativeContext: nc,
  });
  assert.ok(msg.includes("## STYLIZATION BUDGET"));
  assert.ok(msg.includes("Front-left lighting intentional"));
  assert.ok(msg.includes("Pattern: Front/side lighting"));
  assert.ok(
    msg.includes("VERDICT RULES stay fixed"),
    "VERDICT RULES note missing",
  );
});

check("buildUserMessage with narrative: Continuity rule appends to YOUR TASK", () => {
  const nc = narrativeFixture();
  const msg = buildUserMessage({
    artifact: baseArtifact,
    qaVerdict: baseVerdict,
    promptHistory: [],
    catalog: [],
    attemptCount: 0,
    escalationLevel: "L1",
    deliverable: baseDeliverable,
    campaignContext: { brandSlug: "drift-mv" },
    todayDate: "2026-04-21",
    narrativeContext: nc,
  });
  assert.ok(msg.includes("Continuity rule"));
  assert.ok(msg.includes("prefer L3 accept over regen"));
});

check("buildUserMessage shot 1: renders '(no previous shot…)'", () => {
  const nc = narrativeFixture({ shot_number: 1, previous_shot: null });
  const msg = buildUserMessage({
    artifact: baseArtifact,
    qaVerdict: baseVerdict,
    promptHistory: [],
    catalog: [],
    attemptCount: 0,
    escalationLevel: "L1",
    deliverable: baseDeliverable,
    campaignContext: { brandSlug: "drift-mv" },
    todayDate: "2026-04-21",
    narrativeContext: nc,
  });
  assert.ok(
    msg.includes("(no previous shot — this is shot 1)"),
    "no-previous marker missing",
  );
});

check("buildUserMessage shot 30: renders '(no next shot…)'", () => {
  const nc = narrativeFixture({ shot_number: 30, next_shot: null });
  const msg = buildUserMessage({
    artifact: baseArtifact,
    qaVerdict: baseVerdict,
    promptHistory: [],
    catalog: [],
    attemptCount: 0,
    escalationLevel: "L1",
    deliverable: baseDeliverable,
    campaignContext: { brandSlug: "drift-mv" },
    todayDate: "2026-04-21",
    narrativeContext: nc,
  });
  assert.ok(
    msg.includes("(no next shot — this is shot 30)"),
    "no-next marker missing",
  );
});

check("buildUserMessage: STYLIZATION BUDGET omitted when allowances empty", () => {
  const nc = narrativeFixture({ stylization_allowances: [] });
  const msg = buildUserMessage({
    artifact: baseArtifact,
    qaVerdict: baseVerdict,
    promptHistory: [],
    catalog: [],
    attemptCount: 0,
    escalationLevel: "L1",
    deliverable: baseDeliverable,
    campaignContext: { brandSlug: "drift-mv" },
    todayDate: "2026-04-21",
    narrativeContext: nc,
  });
  assert.ok(
    !msg.includes("## STYLIZATION BUDGET"),
    "STYLIZATION BUDGET shown when empty",
  );
  // But SHOT POSITION + NEIGHBOR SHOTS should still render
  assert.ok(msg.includes("## SHOT POSITION"));
  assert.ok(msg.includes("## NEIGHBOR SHOTS"));
});

check("buildUserMessage: section order is SHOT POSITION → NEIGHBOR SHOTS → STYLIZATION BUDGET → QA VERDICT", () => {
  const nc = narrativeFixture();
  const msg = buildUserMessage({
    artifact: baseArtifact,
    qaVerdict: baseVerdict,
    promptHistory: [],
    catalog: [],
    attemptCount: 0,
    escalationLevel: "L1",
    deliverable: baseDeliverable,
    campaignContext: { brandSlug: "drift-mv" },
    todayDate: "2026-04-21",
    narrativeContext: nc,
  });
  const iSp = msg.indexOf("## SHOT POSITION");
  const iNs = msg.indexOf("## NEIGHBOR SHOTS");
  const iSb = msg.indexOf("## STYLIZATION BUDGET");
  const iQa = msg.indexOf("## QA VERDICT");
  assert.ok(iSp > 0 && iNs > iSp && iSb > iNs && iQa > iSb, "section order wrong");
});

// ─── Run ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const c of checks) {
  try {
    c.run();
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
  `10d narrative prompt-shape gate — ${passed} pass, ${failed} fail, ${checks.length} total`,
);
process.exit(failed > 0 ? 1 : 0);
