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

// ─── Phase 5 (2026-04-30): Direction integrity (Rule 6) gate ──────────────
//
// Closes the loop on Tim's 2026-04-30 observation that some Drift MV stills
// regressed to mech-heavy. The orchestrator now sees campaign-level direction
// as a first-class axiom AND a list of explicitly-rejected approaches it
// must not propose. These checks pin the system-prompt rendering of
// MusicVideoContext.direction_mantra and .abandoned_directions.

const MV_CONTEXT_WITH_DIRECTION: MusicVideoContext = {
  ...MV_CONTEXT,
  direction_mantra:
    "Cinematically beautiful · Documentary dry · No effects/gloss/polish · Nothing falling out of the sky",
  abandoned_directions: [
    {
      name: "mech_heavy_hero_framing",
      rejected_at: "2026-04-25",
      reason:
        "Tim pivoted from mech-heavy to aftermath/realistic. Multiple mechs as primary subjects, parade-formation arrangements, action-figure diorama composition, and mech-as-hero framing are all explicitly rejected.",
      snapshot_ref: "manifest_pre_pivot_backup.json",
    },
  ],
};

check("buildSystemPrompt(mvc+direction): emits CAMPAIGN DIRECTION section", () => {
  const sp = buildSystemPrompt(MV_CONTEXT_WITH_DIRECTION);
  // Section heading is rendered with the unique-to-emitted-section
  // "(canonical, applies to ALL shots)" suffix; Rule 6 doctrine just
  // mentions the bare phrase, so this assertion targets the rendered form.
  assert.ok(
    sp.includes("## CAMPAIGN DIRECTION (canonical, applies to ALL shots)"),
    "CAMPAIGN DIRECTION section missing when direction_mantra is set",
  );
  assert.ok(
    sp.includes("Cinematically beautiful"),
    "mantra string not rendered",
  );
});

check("buildSystemPrompt(mvc+direction): emits ABANDONED DIRECTIONS list", () => {
  const sp = buildSystemPrompt(MV_CONTEXT_WITH_DIRECTION);
  assert.ok(
    sp.includes("ABANDONED DIRECTIONS"),
    "ABANDONED DIRECTIONS heading missing",
  );
  assert.ok(
    sp.includes("mech_heavy_hero_framing"),
    "abandoned-direction name not rendered",
  );
  assert.ok(
    sp.includes("rejected 2026-04-25"),
    "abandoned-direction date not rendered",
  );
  assert.ok(
    sp.includes("manifest_pre_pivot_backup.json"),
    "snapshot_ref pointer not rendered",
  );
});

check("buildSystemPrompt(mvc): doctrine carries Rule 6 direction integrity", () => {
  // Rule 6 lives in SYSTEM_PROMPT_CORE so it's present whether or not the
  // campaign has direction data — the rule degrades to no-op without context.
  const sp = buildSystemPrompt(MV_CONTEXT_WITH_DIRECTION);
  assert.ok(
    sp.includes("Rule 6 — Direction integrity"),
    "Rule 6 direction-integrity hard rule missing from doctrine",
  );
  assert.ok(
    sp.includes("direction reversion almost never resolves at prompt level"),
    "Rule 6 escalation guidance missing",
  );
});

check("buildSystemPrompt(mvc, no direction fields): no rendered CAMPAIGN DIRECTION section", () => {
  // Back-compat: campaigns seeded before Phase 5 that don't carry
  // direction_mantra/abandoned_directions still work — Rule 6 becomes a no-op.
  // We assert on the rendered-section marker (with "(canonical..." suffix),
  // not the bare phrase, because Rule 6 doctrine references the section by
  // name and that reference is always present in the cached doctrine.
  const sp = buildSystemPrompt(MV_CONTEXT);
  assert.ok(
    !sp.includes("## CAMPAIGN DIRECTION (canonical, applies to ALL shots)"),
    "CAMPAIGN DIRECTION rendered-section leaked into MVC without direction fields",
  );
  assert.ok(
    !sp.includes("### ABANDONED DIRECTIONS (canonical-rejected"),
    "ABANDONED DIRECTIONS rendered-section leaked into MVC without direction fields",
  );
});

check("buildSystemPrompt(non-MV): no rendered CAMPAIGN DIRECTION section", () => {
  const sp = buildSystemPrompt();
  // Same logic: Rule 6 doctrine references "## CAMPAIGN DIRECTION" by name;
  // assert on the rendered-section marker only.
  assert.ok(
    !sp.includes("## CAMPAIGN DIRECTION (canonical, applies to ALL shots)"),
    "CAMPAIGN DIRECTION rendered-section leaked into non-MV prompt",
  );
});

// ─── Rule 7 — prompt-length budget (Phase B+ #5, 2026-04-30) ────────────────

check("buildSystemPrompt: Rule 7 prompt-length budget rendered with 2000-char ceiling", () => {
  const sp = buildSystemPrompt();
  assert.ok(sp.includes("Rule 7 — Prompt-length budget"), "Rule 7 heading present");
  assert.ok(sp.includes("≤ **2000 characters**"), "explicit 2000-char ceiling rendered");
  assert.ok(sp.includes("HTTP 500"), "Temp-gen rejection symptom documented");
  assert.ok(sp.includes("HTTP 422"), "brand-engine rejection symptom documented");
});

check("OUTPUT JSON SCHEMA references Rule 7 ceiling for new_still_prompt + new_veo_prompt", () => {
  const sp = buildSystemPrompt();
  assert.ok(
    sp.includes("\"new_still_prompt\": \"<full prompt text ≤2000 chars (Rule 7 hard ceiling), or null>\""),
    "schema row for new_still_prompt cites Rule 7",
  );
  assert.ok(
    sp.includes("\"new_veo_prompt\": \"<full prompt text ≤2000 chars (Rule 7 hard ceiling), or null>\""),
    "schema row for new_veo_prompt cites Rule 7",
  );
});

// _enforcePromptBudget tests — load via dynamic import so we don't break the
// test file's existing import pattern.
{
  const orch = await import("../src/orchestrator.js");
  const enforce = orch._enforcePromptBudget;
  const BUDGET = orch.ORCHESTRATOR_PROMPT_BUDGET_CHARS;

  check("_enforcePromptBudget: null in → null out", () => {
    assert.equal(enforce(null, "new_still_prompt"), null);
    assert.equal(enforce(null, "new_veo_prompt"), null);
  });

  check("_enforcePromptBudget: under-budget passes through unchanged", () => {
    const short = "A photographic still of a foreground rubble pile, mid-ground subject, distant background. Documentary tradition.";
    assert.equal(enforce(short, "new_still_prompt"), short);
    assert.ok(short.length < BUDGET, "fixture is actually under budget");
  });

  check("_enforcePromptBudget: at-budget exactly passes through", () => {
    const at = "x".repeat(BUDGET);
    assert.equal(enforce(at, "new_still_prompt"), at);
  });

  check("_enforcePromptBudget: over-budget truncates at last sentence terminator before 1990", () => {
    // Build a prompt whose first 1989 chars end with a "." then more sentences after.
    const head = "A".repeat(1900);
    const sentenceEnd = ". Plenty of room here.";
    const tail = " ".concat("More content that should be cut. ".repeat(20));
    const full = head + sentenceEnd + tail;
    assert.ok(full.length > BUDGET, "fixture exceeds budget");
    const trimmed = enforce(full, "new_still_prompt");
    assert.ok(trimmed !== null);
    assert.ok(trimmed.length <= BUDGET, `trimmed length ${trimmed.length} <= ${BUDGET}`);
    assert.ok(trimmed.endsWith(".") || trimmed.endsWith("?") || trimmed.endsWith("!"), "ends on sentence terminator");
  });

  check("_enforcePromptBudget: over-budget with no sentence terminators falls back to whitespace cut", () => {
    // Single very long word-stream (no periods) followed by spaces.
    const stream = "WordOne WordTwo ".repeat(200);
    assert.ok(stream.length > BUDGET, "fixture exceeds budget");
    const trimmed = enforce(stream, "new_still_prompt");
    assert.ok(trimmed !== null);
    assert.ok(trimmed.length <= BUDGET);
    assert.ok(!trimmed.endsWith(" "), "trailing whitespace stripped after cut");
  });

  check("_enforcePromptBudget: hard cut last-resort when no boundaries available in budget", () => {
    // Pathological input: one giant token, no spaces, no terminators.
    const blob = "x".repeat(3000);
    const trimmed = enforce(blob, "new_still_prompt");
    assert.ok(trimmed !== null);
    assert.ok(trimmed.length <= BUDGET);
    assert.ok(trimmed.length >= 1989, "hard cut lands at the soft ceiling");
  });

  check("_enforcePromptBudget: applies independently to still vs veo (no cross-talk)", () => {
    // Different lengths, different terminators — verify the helper treats each
    // call independently (no shared state, no last-call memo).
    const aOver = "First sentence ends here. " + "B".repeat(1800);
    const bUnder = "Short prompt.";
    const aTrimmed = enforce(aOver, "new_still_prompt");
    const bResult = enforce(bUnder, "new_veo_prompt");
    assert.ok(aTrimmed !== null && aTrimmed.length <= BUDGET);
    assert.equal(bResult, bUnder);
  });
}

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
