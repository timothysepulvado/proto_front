/**
 * ADR-006 D4 cache-stability guard for rejection-learning axiom suffix.
 *
 * This is a static prompt-shape test: no live Anthropic call, no Supabase.
 * It verifies the cache-warm system prompt prefix remains byte-identical and
 * token-count stable when recent rejection learnings are appended after the
 * cache breakpoint.
 *
 * Usage:
 *   cd ~/proto_front
 *   npx tsx os-api/tests/_phase4-cache-stability.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildClaudeSystemBlocks, type ClaudeSystemTextBlock } from "../src/anthropic.js";
import {
  REJECTION_LEARNINGS_HEADING,
  buildSystemPrompt,
  splitSystemPromptForCache,
} from "../src/orchestrator_prompts.js";
import type { BeatName, MusicVideoContext, RejectionLearningEvent } from "../src/types.js";

type Check = { name: string; run: () => void };
const checks: Check[] = [];
function check(name: string, run: () => void): void {
  checks.push({ name, run });
}

const MV_CONTEXT: MusicVideoContext = {
  title: "Drift (AI OS) — Music Video",
  synopsis: "Brandy converts rival AI mechs to gold with documentary-dry realism.",
  reference_tone: "Run This Town meets The Matrix Revolutions, but grounded and aftermath-first.",
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
      visual_intent_summary: `Cache fixture shot ${i + 1}`,
    };
  }),
  ingested_at: "2026-05-10T00:00:00Z",
  manifest_sha256: "phase4cachefixture",
  direction_mantra:
    "Documentary-dry aftermath realism; no glossy mech-heavy hero framing; preserve grounded human-scale stakes.",
  abandoned_directions: [
    {
      name: "mech_heavy_hero_framing",
      reason: "Tim rejected glossy hero-mech framing during direction-fix review.",
      rejected_at: "2026-04-30T00:00:00Z",
      snapshot_ref: "drift-mv-direction-fix",
    },
  ],
};

const LEARNING_A: RejectionLearningEvent = {
  id: "rlearn-a",
  clientId: "client_drift-mv",
  campaignId: "00000000-0000-0000-0000-000000000001",
  shotId: 18,
  assetId: "00000000-0000-0000-0000-000000000002",
  categoryId: "00000000-0000-0000-0000-000000000003",
  categoryLabel: "campaign_direction_reversion",
  whatWrong: "The regen reintroduced glossy mech-heavy hero framing.",
  correction: "Use aftermath-first human-scale composition with grounded materials.",
  blockMode: "soft",
  createdAt: "2026-05-10T00:00:00Z",
  createdBy: "Tim",
};

const LEARNING_B: RejectionLearningEvent = {
  id: "rlearn-b",
  clientId: "client_drift-mv",
  campaignId: "00000000-0000-0000-0000-000000000001",
  shotId: 19,
  categoryLabel: "brand_material_mismatch",
  whatWrong: "The asset used plastic-looking armor instead of weathered welded steel.",
  correction: "Lock weathered welded steel, scuffed edges, and documentary lighting.",
  blockMode: "terminal",
  createdAt: "2026-05-10T00:01:00Z",
  createdBy: "Tim",
};

function cacheWarmPrefix(prompt: string): string {
  const idx = prompt.indexOf(`\n${REJECTION_LEARNINGS_HEADING}`);
  return (idx >= 0 ? prompt.slice(0, idx) : prompt).trimEnd();
}

function approxTokenCount(text: string): number {
  // Matches the existing 10d cache probe's rough sizing convention.
  return Math.round(text.length / 4);
}

type MockCacheUsage = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

class MockAnthropicPromptCache {
  private cachedPrefixes = new Set<string>();

  call(system: ClaudeSystemTextBlock[], userMessage: string): MockCacheUsage {
    assert.equal(system[0]?.cache_control?.type, "ephemeral");
    const cachedPrefix = system[0].text;
    const prefixTokens = approxTokenCount(cachedPrefix);
    const dynamicTokens = system
      .slice(1)
      .reduce((total, block) => total + approxTokenCount(block.text), 0);
    const userTokens = approxTokenCount(userMessage);
    const wasCached = this.cachedPrefixes.has(cachedPrefix);
    this.cachedPrefixes.add(cachedPrefix);
    return {
      inputTokens: dynamicTokens + userTokens,
      cacheReadTokens: wasCached ? prefixTokens : 0,
      cacheWriteTokens: wasCached ? 0 : prefixTokens,
    };
  }
}

function mockOrchestratorProbe(
  prompt: string,
  cache: MockAnthropicPromptCache,
): MockCacheUsage & { system: ClaudeSystemTextBlock[]; dynamicTokens: number } {
  const { cachePrefix, dynamicSuffix } = splitSystemPromptForCache(prompt);
  const system = buildClaudeSystemBlocks(cachePrefix, dynamicSuffix);
  const dynamicTokens = system
    .slice(1)
    .reduce((total, block) => total + approxTokenCount(block.text), 0);
  return {
    ...cache.call(system, "Return a minimal valid JSON escalation decision."),
    system,
    dynamicTokens,
  };
}

const basePrompt = buildSystemPrompt(MV_CONTEXT);
const emptyPrompt = buildSystemPrompt(MV_CONTEXT, []);
const withLearningA = buildSystemPrompt(MV_CONTEXT, [LEARNING_A]);
const withLearningB = buildSystemPrompt(MV_CONTEXT, [LEARNING_B]);

check("empty recentLearnings preserves legacy buildSystemPrompt bytes", () => {
  assert.equal(emptyPrompt, basePrompt);
  assert.ok(!emptyPrompt.includes(REJECTION_LEARNINGS_HEADING));
});

check("populated recentLearnings render after ABANDONED DIRECTIONS", () => {
  const abandonedIdx = withLearningA.indexOf("### ABANDONED DIRECTIONS");
  const learningIdx = withLearningA.indexOf(REJECTION_LEARNINGS_HEADING);
  assert.ok(abandonedIdx >= 0, "fixture must render ABANDONED DIRECTIONS");
  assert.ok(learningIdx > abandonedIdx, "rejection learnings must render after abandoned directions");
});

check("cache-warm prefix bytes stay stable across rejection events", () => {
  const prefixEmpty = cacheWarmPrefix(emptyPrompt);
  assert.equal(cacheWarmPrefix(withLearningA), prefixEmpty);
  assert.equal(cacheWarmPrefix(withLearningB), prefixEmpty);
});

check("cache-warm prefix token count stays stable across rejection events", () => {
  const tokensEmpty = approxTokenCount(cacheWarmPrefix(emptyPrompt));
  assert.equal(approxTokenCount(cacheWarmPrefix(withLearningA)), tokensEmpty);
  assert.equal(approxTokenCount(cacheWarmPrefix(withLearningB)), tokensEmpty);
});

check("Anthropic request shape keeps rejection learnings outside the cached system block", () => {
  const { cachePrefix, dynamicSuffix } = splitSystemPromptForCache(withLearningA);
  const system = buildClaudeSystemBlocks(cachePrefix, dynamicSuffix);
  assert.equal(system.length, 2);
  assert.equal(system[0].cache_control?.type, "ephemeral");
  assert.equal(system[0].text, cacheWarmPrefix(emptyPrompt));
  assert.ok(!system[0].text.includes(REJECTION_LEARNINGS_HEADING));
  assert.ok(system[1].text.includes(REJECTION_LEARNINGS_HEADING));
  assert.equal(system[1].cache_control, undefined);
});

check("Probe 1: empty learnings orchestrator call records cache write tokens", () => {
  const cache = new MockAnthropicPromptCache();
  const probe1 = mockOrchestratorProbe(emptyPrompt, cache);
  assert.equal(probe1.cacheReadTokens, 0);
  assert.ok(probe1.cacheWriteTokens > 0);
  assert.equal(probe1.system.length, 1);
});

check("Probe 2: repeated empty learnings call records cache read tokens equal to Probe 1 write", () => {
  const cache = new MockAnthropicPromptCache();
  const probe1 = mockOrchestratorProbe(emptyPrompt, cache);
  const probe2 = mockOrchestratorProbe(emptyPrompt, cache);
  assert.equal(probe2.cacheWriteTokens, 0);
  assert.equal(probe2.cacheReadTokens, probe1.cacheWriteTokens);
});

check("Probe 3: with-learnings first call writes the unchanged prefix and adds only dynamic delta tokens", () => {
  const cache = new MockAnthropicPromptCache();
  const emptyProbe = mockOrchestratorProbe(emptyPrompt, new MockAnthropicPromptCache());
  const learningProbe = mockOrchestratorProbe(withLearningA, cache);
  assert.equal(learningProbe.cacheReadTokens, 0);
  assert.equal(learningProbe.cacheWriteTokens, emptyProbe.cacheWriteTokens);
  assert.equal(learningProbe.system.length, 2);
  assert.ok(learningProbe.dynamicTokens > 0);
  assert.ok(learningProbe.inputTokens >= learningProbe.dynamicTokens);
});

check("Probe 4: repeated with-learnings call reads the same unchanged cached prefix", () => {
  const cache = new MockAnthropicPromptCache();
  const probe3 = mockOrchestratorProbe(withLearningA, cache);
  const probe4 = mockOrchestratorProbe(withLearningA, cache);
  assert.equal(probe4.cacheWriteTokens, 0);
  assert.equal(probe4.cacheReadTokens, probe3.cacheWriteTokens);
  assert.equal(probe4.dynamicTokens, probe3.dynamicTokens);
});

check("axiom block uses required one-line operator-learning format", () => {
  assert.ok(
    withLearningA.includes(
      "- [campaign_direction_reversion] The regen reintroduced glossy mech-heavy hero framing. → CORRECT: Use aftermath-first human-scale composition with grounded materials.",
    ),
  );
});

check("non-MV prompt can still append learnings without music-video context", () => {
  const nonMv = buildSystemPrompt(undefined, [LEARNING_A]);
  assert.ok(nonMv.includes(REJECTION_LEARNINGS_HEADING));
  assert.ok(!cacheWarmPrefix(nonMv).includes("## MUSIC VIDEO CONTEXT"));
});

check("escalation_loop fetches recent rejection learnings once before the orchestrator call", () => {
  const source = readFileSync(new URL("../src/escalation_loop.ts", import.meta.url), "utf8");
  const fetchMatches = [...source.matchAll(/await getRecentRejectionLearnings\(/g)];
  assert.equal(fetchMatches.length, 1);
  const fetchIdx = source.indexOf("await getRecentRejectionLearnings(");
  const decideIdx = source.indexOf("decisionResult = await decideEscalation(");
  assert.ok(fetchIdx > 0 && decideIdx > fetchIdx);
});

check("escalation_loop passes recentLearnings into decideEscalation and records IDs for audit", () => {
  const source = readFileSync(new URL("../src/escalation_loop.ts", import.meta.url), "utf8");
  const decideIdx = source.indexOf("decisionResult = await decideEscalation(");
  const decideEnd = source.indexOf("});", decideIdx);
  const decideBlock = source.slice(decideIdx, decideEnd);
  assert.ok(decideBlock.includes("recentLearnings,"));
  assert.ok(source.includes("recentRejectionLearningIds: recentLearnings.map((learning) => learning.id)"));
});

let passed = 0;
for (const c of checks) {
  try {
    c.run();
    passed += 1;
    console.log(`✓ ${c.name}`);
  } catch (error) {
    console.error(`✗ ${c.name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

if (process.exitCode) {
  console.error(`\n_phase4-cache-stability: ${passed}/${checks.length} passed`);
} else {
  console.log(`\n_phase4-cache-stability: ${passed}/${checks.length} passed`);
  console.log(`cache-warm prefix approx_tokens=${approxTokenCount(cacheWarmPrefix(emptyPrompt))}`);
}
