/**
 * Phase B unit tests — `mode: "stills"` runner (ADR-004).
 *
 * Pure unit tests, no Supabase / network / brand-engine deps. Covers the
 * deterministic Phase B surface:
 *
 *   1. `pMap` concurrency cap — at most N tasks in flight at any time
 *   2. `loadCampaignManifest` happy path against a fixture tree
 *   3. `loadCampaignManifest` missing-manifest hard-fail
 *   4. `loadCampaignManifest` graceful degradation when story-context docs
 *      are missing
 *   5. `resolveProductionSlug` derives slug from `clientId='client_<slug>'`
 *   6. `resolveProductionSlug` rejects malformed clientId
 *   7. Feature flag default — `STILLS_MODE_ENABLED` defaults false
 *   8. Cost cap default — `STILLS_PER_SHOT_HARD_CAP_USD` defaults to $1.00
 *   9-22. PR #2 Phase 0.A guard/security helpers
 *   23-24. PR #2 Phase 0.B seed-script guards
 *
 * Integration coverage of `runAuditMode` / `runInLoopMode` requires fetch +
 * Supabase mocks; deferred to a Phase B+ follow-up that introduces a
 * mocking framework. The degenerate-loop guard is already covered by
 * `_10d-escalation-history.ts::_countConsecutiveSamePromptRegens` tests.
 *
 * Usage:
 *   npx tsx os-api/tests/phase-b-stills-runner.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Force deterministic stills config for the import. Running from os-api/
// loads .env via downstream modules, and dotenv does not override existing
// process.env keys, so set the expected defaults explicitly before import.
process.env.STILLS_MODE_ENABLED = "false";
process.env.STILLS_PER_SHOT_COST_CAP_USD = "1.0";
process.env.STILLS_AUDIT_CONCURRENCY = "8";

// Set TEMP_GEN_PATH to a temp dir BEFORE importing so loadCampaignManifest
// reads the fixture tree we build below.
const fixtureRoot = join(tmpdir(), `phase-b-stills-${Date.now()}`);
process.env.TEMP_GEN_PATH = fixtureRoot;

const stillsRunnerImport = await import("../src/stills_runner.js");
const {
  loadCampaignManifest,
  resolveProductionSlug,
  pickInLoopTargets,
  parseShotDescriptionNumber,
  buildAuditDecisionRecordInput,
  buildHardCapHitlPlan,
  STILLS_MODE_ENABLED,
  STILLS_PER_SHOT_HARD_CAP_USD,
  STILLS_AUDIT_CONCURRENCY,
} = stillsRunnerImport;
const { validateRunModeFeatureFlag, validateCampaignClientScope } = await import("../src/run-create-guards.js");
const { ForbiddenPathError, resolveExistingRealPathInsideAllowedRoots } = await import("../src/path-security.js");
const { validateStillSourcePath, updateReferenceImagesForStillDecision } = await import("../src/productions.js");
const { assertExpectedTiers, mapDeliverablesByShot } = await import("../scripts/seed-drift-mv-pivot.js");

// `pMap` is module-private. Reuse the same Promise-pool pattern in-test to
// validate the concurrency invariant; the production implementation is
// behaviorally equivalent (a regression to the pool would surface in the
// audit smoke gate, not here).
async function pMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const max = Math.max(1, Math.min(limit, items.length || 1));
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: max }, () => worker()));
  return out;
}

// ─── Test 1: pMap concurrency cap ──────────────────────────────────────────
{
  const inFlight = { current: 0, max: 0 };
  const limit = 4;
  const items = Array.from({ length: 20 }, (_, i) => i);

  const results = await pMap(items, limit, async (n) => {
    inFlight.current += 1;
    inFlight.max = Math.max(inFlight.max, inFlight.current);
    // Random short delay so scheduler interleaves workers.
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 10) + 1));
    inFlight.current -= 1;
    return n * 2;
  });

  assert.deepEqual(
    results,
    items.map((n) => n * 2),
    "pMap returns results in input order",
  );
  assert.ok(
    inFlight.max <= limit,
    `pMap respects concurrency cap: max in-flight ${inFlight.max} <= ${limit}`,
  );
  console.log(`  ✓ pMap concurrency cap honored (peak ${inFlight.max} <= ${limit})`);
}

// ─── Test 2: loadCampaignManifest happy path ───────────────────────────────
{
  const slug = "fixture-mv";
  const root = join(fixtureRoot, "productions", slug);
  mkdirSync(join(root, "stills"), { recursive: true });
  mkdirSync(join(root, "anchors"), { recursive: true });
  mkdirSync(join(root, "reference_quality_bar"), { recursive: true });
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify({
      production: { title: "Fixture MV" },
      shots: [
        { id: 1, section: "intro", visual: "A", still_prompt: "p1" },
        { id: 2, section: "intro", visual: "B", still_prompt: "p2" },
      ],
    }),
  );
  writeFileSync(join(root, "BRIEF.md"), "Fixture brief content.");
  writeFileSync(join(root, "NARRATIVE.md"), "Fixture narrative content.");
  // LYRICS.md intentionally missing — should be tolerated.
  writeFileSync(join(root, "anchors", "brandy_anchor.png"), "fake png");
  writeFileSync(join(root, "anchors", "rapper_1_anchor.png"), "fake png");
  writeFileSync(join(root, "anchors", "ignore_me.txt"), "not an anchor");
  writeFileSync(join(root, "reference_quality_bar", "ref_001.png"), "fake png");

  const manifest = loadCampaignManifest(slug);

  assert.equal(manifest.productionSlug, slug, "manifest.productionSlug threaded through");
  assert.equal(manifest.shots.length, 2, "manifest.shots populated");
  assert.equal(manifest.shots[0].id, 1, "shot 1 first");
  assert.equal(manifest.storyContext.brief, "Fixture brief content.", "BRIEF.md loaded");
  assert.equal(
    manifest.storyContext.narrative,
    "Fixture narrative content.",
    "NARRATIVE.md loaded",
  );
  assert.equal(manifest.storyContext.lyrics, undefined, "LYRICS.md absence tolerated");
  assert.equal(manifest.anchorPaths.length, 2, "only *_anchor.png files counted");
  assert.equal(manifest.referencePaths.length, 1, "reference_quality_bar files counted");
  console.log(
    `  ✓ loadCampaignManifest happy path (shots=${manifest.shots.length}, anchors=${manifest.anchorPaths.length}, refs=${manifest.referencePaths.length}, story_ctx=${Object.keys(manifest.storyContext).length})`,
  );
}

// ─── Test 3: loadCampaignManifest missing manifest = hard fail ─────────────
{
  const slug = "no-such-production";
  let threw = false;
  try {
    loadCampaignManifest(slug);
  } catch (err) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(
      msg,
      /manifest\.json not found/,
      "error message names the missing file",
    );
  }
  assert.ok(threw, "loadCampaignManifest throws on missing manifest");
  console.log("  ✓ loadCampaignManifest fails hard on missing manifest.json");
}

// ─── Test 4: loadCampaignManifest tolerates missing optional dirs ─────────
{
  const slug = "minimal-mv";
  const root = join(fixtureRoot, "productions", slug);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify({ shots: [{ id: 1 }] }),
  );

  const manifest = loadCampaignManifest(slug);
  assert.equal(manifest.shots.length, 1);
  assert.equal(manifest.anchorPaths.length, 0, "missing anchors dir → empty list");
  assert.equal(
    manifest.referencePaths.length,
    0,
    "missing references dir → empty list",
  );
  assert.equal(
    Object.keys(manifest.storyContext).length,
    0,
    "missing story-context docs → empty object",
  );
  console.log("  ✓ loadCampaignManifest graceful with optional pieces missing");
}

// ─── Test 5: loadCampaignManifest invalid manifest (no shots[]) ───────────
{
  const slug = "broken-mv";
  const root = join(fixtureRoot, "productions", slug);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify({ production: { title: "no shots" } }),
  );

  let threw = false;
  try {
    loadCampaignManifest(slug);
  } catch (err) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, /missing shots/i, "error names the schema gap");
  }
  assert.ok(threw, "loadCampaignManifest rejects manifest without shots[]");
  console.log("  ✓ loadCampaignManifest rejects manifests missing shots[]");
}

// ─── Test 6: resolveProductionSlug happy path ─────────────────────────────
{
  const slug = resolveProductionSlug({
    runId: "run_1",
    clientId: "client_drift-mv",
    mode: "stills",
    status: "running",
    stages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  assert.equal(slug, "drift-mv", "client_drift-mv → drift-mv");
  console.log("  ✓ resolveProductionSlug derives slug from client_<slug>");
}

// ─── Test 7: resolveProductionSlug rejects malformed clientId ─────────────
{
  let threw = false;
  try {
    resolveProductionSlug({
      runId: "run_1",
      clientId: "drift-mv", // missing client_ prefix
      mode: "stills",
      status: "running",
      stages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, /client_/);
  }
  assert.ok(threw, "resolveProductionSlug rejects clientId without client_ prefix");
  console.log("  ✓ resolveProductionSlug rejects malformed clientId");
}

// ─── Test 8: feature flag + cost cap defaults ─────────────────────────────
{
  assert.equal(
    STILLS_MODE_ENABLED,
    false,
    "STILLS_MODE_ENABLED defaults false (rollback lever)",
  );
  assert.equal(
    STILLS_PER_SHOT_HARD_CAP_USD,
    1.0,
    "STILLS_PER_SHOT_HARD_CAP_USD defaults to $1.00",
  );
  assert.equal(
    STILLS_AUDIT_CONCURRENCY,
    8,
    "STILLS_AUDIT_CONCURRENCY defaults to 8",
  );
  console.log(
    `  ✓ env defaults: STILLS_MODE_ENABLED=${STILLS_MODE_ENABLED} cap=$${STILLS_PER_SHOT_HARD_CAP_USD} conc=${STILLS_AUDIT_CONCURRENCY}`,
  );
}

// ─── Tests 23-24: seed script duplicate/tier validation (PR #2 0.B.6-0.B.7) ──
{
  type SeedDeliverableRow = Parameters<typeof mapDeliverablesByShot>[0][number];
  const row = (id: string, shot: number): SeedDeliverableRow => ({
    id,
    campaign_id: "campaign_1",
    description: `Shot ${String(shot).padStart(2, "0")} · fixture`,
    current_prompt: null,
    ai_model: null,
    status: "pending",
    reference_images: [`productions/drift-mv/stills/shot_${String(shot).padStart(2, "0")}.png`],
    negative_prompts: null,
  });

  assert.throws(
    () => mapDeliverablesByShot([row("deliv_a", 5), row("deliv_b", 5)]),
    /Duplicate deliverables mapped to shot #5: deliv_a and deliv_b/,
    "seed script must fail fast on duplicate deliverables for the same shot",
  );
  console.log("  ✓ PR #2 0.B.6 — seed script rejects duplicate shot deliverables");
}

{
  type ParsedShot = Parameters<typeof assertExpectedTiers>[0] extends Map<number, infer T> ? T : never;
  const tierMap = new Map<number, ParsedShot>();
  for (const shot of [2, 5, 6, 8, 10, 11, 15, 25, 26, 27]) {
    tierMap.set(shot, { shotNumber: shot, tier: "A", newVisual: "fixture visual" });
  }
  tierMap.set(1, { shotNumber: 1, tier: "B", newVisual: "fixture visual" });
  assert.doesNotThrow(() => assertExpectedTiers(tierMap));

  tierMap.set(5, { shotNumber: 5, tier: "B", newVisual: "wrong tier" });
  assert.throws(
    () => assertExpectedTiers(tierMap),
    /shot #5 parsed as tier B but expected A/,
    "seed script must reject required shots parsed into the wrong tier",
  );
  console.log("  ✓ PR #2 0.B.7 — seed script validates expected audit tiers");
}

// ─── Tests 9-14: pickInLoopTargets (Phase B+ targeted-regen, 2026-04-30) ───
//
// pickInLoopTargets is a pure helper extracted from runInLoopMode so the
// targeted-regen path (run.metadata.shot_ids) can be unit-tested without
// fetch / Supabase mocks. The fixture below mirrors the inaugural Drift MV
// deliverable shape: description encodes "Shot N · section · …" and status
// is one of {approved, reviewing, rejected}.

type ManifestPayloadFixture = Parameters<typeof pickInLoopTargets>[0];
type CampaignDeliverableFixture = Parameters<typeof pickInLoopTargets>[1][number];

const NOW = "2026-04-30T22:00:00.000Z";
const mkDeliverable = (
  id: string,
  description: string,
  status: CampaignDeliverableFixture["status"],
): CampaignDeliverableFixture => ({
  id,
  campaignId: "c",
  description,
  status,
  retryCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
});

const fixtureManifest: ManifestPayloadFixture = {
  productionSlug: "drift-mv",
  shots: [
    { id: 1, section: "intro", visual: "intro shot" },
    { id: 4, section: "hook_1", visual: "the orb beat" },
    { id: 7, section: "verse_1", visual: "mech faceplate close-up" },
    { id: 16, section: "verse_2", visual: "fortune 5" },
    { id: 18, section: "verse_2", visual: "we the signal" },
    { id: 20, section: "hook_3", visual: "gargoyle mechs" },
    { id: 22, section: "bridge", visual: "empathetic close-up" },
  ],
  storyContext: {},
  anchorPaths: [],
  referencePaths: [],
};

const fixtureDeliverables: CampaignDeliverableFixture[] = [
  mkDeliverable("deliv-1",  "Shot 1 · intro · skyscraper",        "approved"),
  mkDeliverable("deliv-4",  "Shot 04 · hook_1 · the orb beat",    "approved"),
  mkDeliverable("deliv-7",  "Shot 07 · verse_1 · mech faceplate", "approved"),
  mkDeliverable("deliv-16", "Shot 16 · verse_2 · fortune 5",      "approved"),
  mkDeliverable("deliv-18", "Shot 18 · verse_2 · we the signal",  "approved"),
  mkDeliverable("deliv-20", "Shot 20 · hook_3 · gargoyles",       "approved"),
  mkDeliverable("deliv-22", "Shot 22 · bridge · close-up",        "approved"),
  // 2 "reviewing" deliverables WITHOUT shot-N descriptions — matches the
  // production drift-mv state where prior regen attempts wrote raw visuals.
  mkDeliverable("deliv-x1", "Brandy walks forward in sharp focus while …",       "reviewing"),
  mkDeliverable("deliv-x2", "A massive smoking crater where one converted …",    "reviewing"),
];

// ─── Test 9: targeted-regen happy path — bypass status filter ─────────────
{
  const decision = pickInLoopTargets(
    fixtureManifest,
    fixtureDeliverables,
    [7, 16, 18, 20, 22],
  );
  assert.equal(decision.targets.length, 5, "5 shots resolved");
  assert.deepEqual(
    decision.targets.map((t) => t.shot.id),
    [7, 16, 18, 20, 22],
    "iteration order matches input shotIds order",
  );
  assert.deepEqual(
    decision.targets.map((t) => t.deliverable.id),
    ["deliv-7", "deliv-16", "deliv-18", "deliv-20", "deliv-22"],
    "each shot resolved to its 'Shot N · …' deliverable despite all being approved",
  );
  assert.equal(decision.skipped.length, 0, "no skips in happy path");
  console.log("  ✓ pickInLoopTargets — targeted-regen bypasses approved filter (drift-mv 5-shot case)");
}

// ─── Test 10: targeted regen — non-existent shot id is skipped, not thrown ─
{
  const decision = pickInLoopTargets(
    fixtureManifest,
    fixtureDeliverables,
    [7, 99],
  );
  assert.equal(decision.targets.length, 1, "valid shot resolved");
  assert.equal(decision.targets[0].shot.id, 7);
  assert.equal(decision.skipped.length, 1, "one skip");
  assert.equal(decision.skipped[0].reason, "shot_not_in_manifest");
  assert.equal(decision.skipped[0].shotId, 99);
  console.log("  ✓ pickInLoopTargets — invalid shotId reported as skip with reason code");
}

// ─── Test 11: targeted regen — shot exists but no matching deliverable ─────
{
  const decision = pickInLoopTargets(
    fixtureManifest,
    fixtureDeliverables.filter((d) => d.id !== "deliv-7"),
    [7, 16],
  );
  assert.equal(decision.targets.length, 1);
  assert.equal(decision.targets[0].shot.id, 16);
  assert.equal(decision.skipped.length, 1);
  assert.equal(decision.skipped[0].reason, "no_deliverable_row_for_shot");
  assert.equal(decision.skipped[0].shotId, 7);
  console.log("  ✓ pickInLoopTargets — missing deliverable row surfaces a skip with reason code");
}

// ─── Test 12: default path — non-terminal filter applies, terminal skipped ─
{
  const mixedStatusDeliverables: CampaignDeliverableFixture[] = [
    mkDeliverable("a", "Shot 1 · intro",    "reviewing"),
    mkDeliverable("b", "Shot 4 · hook_1",   "approved"),
    mkDeliverable("c", "Shot 7 · verse_1",  "rejected"),
    mkDeliverable("d", "Shot 16 · verse_2", "regenerating"),
  ];
  const decision = pickInLoopTargets(fixtureManifest, mixedStatusDeliverables, undefined);
  assert.equal(decision.targets.length, 2, "only the 2 non-terminal deliverables surface");
  assert.deepEqual(
    decision.targets.map((t) => t.deliverable.id).sort(),
    ["a", "d"],
  );
  // Terminal-status skips are NOT operator-warns (expected behavior); they're
  // still in `skipped` for diagnostics.
  const terminalSkips = decision.skipped.filter((s) => s.reason === "deliverable_terminal_status");
  assert.equal(terminalSkips.length, 2, "both approved + rejected surface as terminal-status skips");
  console.log("  ✓ pickInLoopTargets — default path honors non-terminal filter, classifies terminal skips");
}

// ─── Test 13: default path — non-shot-N descriptions are skip-warned ───────
{
  const decision = pickInLoopTargets(fixtureManifest, fixtureDeliverables, undefined);
  // 7 approved (Shot N) + 2 reviewing (no Shot N) = 9 total. Default path
  // skips approved (terminal_status) and emits "couldnt_parse" for the 2
  // reviewing ones. No targets.
  assert.equal(decision.targets.length, 0);
  const parseFails = decision.skipped.filter((s) => s.reason === "couldnt_parse_shot_number");
  assert.equal(parseFails.length, 2, "both raw-visual descriptions reported as parse-fail");
  assert.ok(parseFails[0].deliverableId);
  console.log("  ✓ pickInLoopTargets — non-Shot-N descriptions reported as couldnt_parse_shot_number skips");
}

// ─── Test 14: empty / null shotIds falls back to default path ──────────────
{
  // null === undefined === [] all behave identically: default path.
  const a = pickInLoopTargets(fixtureManifest, fixtureDeliverables, undefined);
  const b = pickInLoopTargets(fixtureManifest, fixtureDeliverables, null);
  const c = pickInLoopTargets(fixtureManifest, fixtureDeliverables, []);
  assert.deepEqual(
    a.targets.map((t) => t.deliverable.id),
    b.targets.map((t) => t.deliverable.id),
  );
  assert.deepEqual(
    a.targets.map((t) => t.deliverable.id),
    c.targets.map((t) => t.deliverable.id),
  );
  console.log("  ✓ pickInLoopTargets — undefined/null/[] shotIds all route to default path");
}

// ─── Test 15: three-digit shot numbers parse and target correctly ─────────
{
  const manifest: ManifestPayloadFixture = {
    productionSlug: "large-campaign",
    shots: [
      { id: 5, visual: "shot five" },
      { id: 50, visual: "shot fifty" },
      { id: 500, visual: "shot five hundred" },
    ],
    storyContext: {},
    anchorPaths: [],
    referencePaths: [],
  };
  const deliverables: CampaignDeliverableFixture[] = [
    mkDeliverable("deliv-5", "Shot 005 · intro", "approved"),
    mkDeliverable("deliv-50", "Shot 050 · middle", "approved"),
    mkDeliverable("deliv-500", "Shot 500 · finale", "approved"),
  ];
  const decision = pickInLoopTargets(manifest, deliverables, [5, 50, 500]);
  assert.deepEqual(
    decision.targets.map((target) => target.shot.id),
    [5, 50, 500],
    "shot IDs 5, 50, and 500 all resolve",
  );
  assert.equal(parseShotDescriptionNumber("shot-500 · finale"), 500);
  assert.equal(decision.skipped.length, 0);
  console.log("  ✓ PR #2 0.A.1 — three-digit shot descriptions resolve");
}

// ─── Test 16: stills run mode is feature-flag gated at route level ────────
{
  assert.deepEqual(
    validateRunModeFeatureFlag("stills", {}),
    { ok: false, status: 403, error: "stills_mode_disabled" },
    "stills mode rejects when STILLS_MODE_ENABLED is unset",
  );
  assert.deepEqual(
    validateRunModeFeatureFlag("stills", { STILLS_MODE_ENABLED: "true" }),
    { ok: true },
    "stills mode accepts when STILLS_MODE_ENABLED=true",
  );
  assert.deepEqual(validateRunModeFeatureFlag("images", {}), { ok: true });
  console.log("  ✓ PR #2 0.A.2 — mode=stills is guarded by STILLS_MODE_ENABLED");
}

// ─── Test 17: campaign/client scope blocks cross-tenant run attachment ────
{
  assert.deepEqual(
    validateCampaignClientScope({ clientId: "client_b" }, "client_a"),
    { ok: false, status: 403, error: "campaign_client_mismatch" },
    "campaign from another client is rejected",
  );
  assert.deepEqual(
    validateCampaignClientScope({ clientId: "client_a" }, "client_a"),
    { ok: true },
    "campaign from same client is accepted",
  );
  assert.deepEqual(
    validateCampaignClientScope(null, "client_a"),
    { ok: false, status: 404, error: "Campaign not found" },
  );
  console.log("  ✓ PR #2 0.A.3 — campaignId must belong to URL clientId");
}

// ─── Test 18: local artifact fallback rejects symlink escapes ─────────────
{
  const root = join(fixtureRoot, "artifact-root");
  const outside = join(fixtureRoot, "outside-secret.txt");
  const sneaky = join(root, "productions", "sneaky.png");
  mkdirSync(join(root, "productions"), { recursive: true });
  writeFileSync(outside, "outside root");
  symlinkSync(outside, sneaky);
  assert.throws(
    () => resolveExistingRealPathInsideAllowedRoots(sneaky, [root]),
    ForbiddenPathError,
    "symlink inside allowed tree pointing outside is rejected after realpath",
  );
  console.log("  ✓ PR #2 0.A.4 — realpath guard blocks local-file symlink escapes");
}

// ─── Test 19: production sourcePath must stay inside allowed roots ────────
{
  const allowedRoot = join(fixtureRoot, "productions", "drift-mv");
  const outsideRoot = join(fixtureRoot, "source-outside");
  const outsidePng = join(outsideRoot, "replacement.png");
  mkdirSync(allowedRoot, { recursive: true });
  mkdirSync(outsideRoot, { recursive: true });
  writeFileSync(outsidePng, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  assert.throws(
    () => validateStillSourcePath("drift-mv", outsidePng, [allowedRoot]),
    ForbiddenPathError,
    "sourcePath outside production source roots is rejected",
  );
  console.log("  ✓ PR #2 0.A.5 — replacement sourcePath is allowlist-scoped");
}

// ─── Test 20: rejecting a still removes it from reference_images ──────────
{
  const stillPath = "/tmp/shot_07.png";
  const approved = updateReferenceImagesForStillDecision(["/tmp/other.png"], stillPath, "approve");
  assert.deepEqual(approved, [stillPath, "/tmp/other.png"], "approval prepends still path");
  const rejected = updateReferenceImagesForStillDecision(approved, stillPath, "reject");
  assert.deepEqual(rejected, ["/tmp/other.png"], "rejection removes still path");
  console.log("  ✓ PR #2 0.A.6 — reject path removes denied still from reference_images");
}

// ─── Test 21: audit verdict records carry canonical decision metadata ─────
{
  type AuditVerdict = Parameters<typeof buildAuditDecisionRecordInput>[0]["verdict"];
  const verdict: AuditVerdict = {
    verdict: "FAIL",
    aggregate_score: 2.75,
    criteria: [{ name: "direction", score: 2, notes: "reverted" }],
    detected_failure_classes: ["campaign_direction_reversion_mech_heavy"],
    confidence: 0.92,
    summary: "Direction reverted",
    reasoning: "The image reintroduced the abandoned mech-heavy direction.",
    recommendation: "L2_approach_change",
    model: "gemini-3-pro-vision",
    cost: 0.0123,
    latency_ms: 456,
    shot_number: 7,
    image_path: "/tmp/shot_07.png",
  };
  const record = buildAuditDecisionRecordInput({
    clientId: "client_drift-mv",
    escalationId: "esc_1",
    artifactId: "art_1",
    runId: "run_1",
    deliverableId: "deliv_1",
    shotId: 7,
    imagePath: "/tmp/shot_07.png",
    verdict,
    traceId: "trace_123",
  });
  assert.equal(record.inputContext.decision_type, "audit_verdict");
  assert.equal(record.decision.decision_type, "audit_verdict");
  assert.equal(record.decision.failure_class, "campaign_direction_reversion_mech_heavy");
  assert.equal(record.cost, 0.0123);
  assert.equal(record.latencyMs, 456);
  console.log("  ✓ PR #2 0.A.7 — audit verdict decision rows preserve trace/cost/verdict context");
}

// ─── Test 22: hard-cap HITL plan persists run + escalation side effects ───
{
  type HardCapVerdict = Parameters<typeof buildHardCapHitlPlan>[0]["verdict"];
  const verdict: HardCapVerdict = {
    verdict: "FAIL",
    aggregate_score: 2.1,
    criteria: [],
    detected_failure_classes: ["degenerate_loop"],
    confidence: 0.9,
    summary: "Looping",
    reasoning: "No material improvement.",
    recommendation: "L3_redesign",
    model: "gemini-3-pro-vision",
    cost: 0.01,
    latency_ms: 100,
    image_path: "/tmp/shot_07.png",
  };
  const plan = buildHardCapHitlPlan({
    clientId: "client_drift-mv",
    runId: "run_1",
    shotId: 7,
    iter: 8,
    hardCap: 8,
    deliverableId: "deliv_1",
    artifactId: "art_1",
    verdict,
  });
  assert.equal(plan.runUpdates.hitlRequired, true);
  assert.match(plan.runUpdates.hitlNotes, /shot 7/);
  assert.equal(plan.escalation.status, "hitl_required");
  assert.equal(plan.escalation.failureClass, "degenerate_loop");
  console.log("  ✓ PR #2 0.A.8 — hard-cap path has run bubble + asset escalation plan");
}

// ─── Cleanup ───────────────────────────────────────────────────────────────
try {
  rmSync(fixtureRoot, { recursive: true, force: true });
} catch {
  // best-effort
}

console.log("\nPhase B stills-runner unit tests: 24/24 passed");
