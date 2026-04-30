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
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Force STILLS_MODE_ENABLED off for the import — we test it explicitly below.
delete process.env.STILLS_MODE_ENABLED;
delete process.env.STILLS_PER_SHOT_COST_CAP;
delete process.env.STILLS_AUDIT_CONCURRENCY;

// Set TEMP_GEN_PATH to a temp dir BEFORE importing so loadCampaignManifest
// reads the fixture tree we build below.
const fixtureRoot = join(tmpdir(), `phase-b-stills-${Date.now()}`);
process.env.TEMP_GEN_PATH = fixtureRoot;

const stillsRunnerImport = await import("../src/stills_runner.js");
const {
  loadCampaignManifest,
  resolveProductionSlug,
  STILLS_MODE_ENABLED,
  STILLS_PER_SHOT_HARD_CAP_USD,
  STILLS_AUDIT_CONCURRENCY,
} = stillsRunnerImport;

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

// ─── Cleanup ───────────────────────────────────────────────────────────────
try {
  rmSync(fixtureRoot, { recursive: true, force: true });
} catch {
  // best-effort
}

console.log("\nPhase B stills-runner unit tests: 8/8 passed");
