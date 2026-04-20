/**
 * 10d-pre-cache-hit-probe — verify prompt caching is ACTUALLY wired on the
 * direct Anthropic backend. Mandatory Phase 2 gate in the 10d pre-flight brief.
 *
 * The bug we're guarding against: `cache_control` may be set on the system
 * block yet silently not cache — most commonly because the cacheable prefix
 * is below the model's minimum (4,096 tokens on Opus 4.7/4.6/4.5 & Haiku 4.5;
 * 1,024-2,048 on other models), or because of SDK-version / API-surface drift.
 *
 * What this probe does:
 *   1. Uses SYSTEM_PROMPT (the real orchestrator system prompt) as the
 *      cached prefix — same text the pipeline will use in 10d.
 *   2. Calls callClaude() twice with IDENTICAL systemCached, a few seconds
 *      apart (well under the 5-min ephemeral TTL).
 *   3. Asserts:
 *      Call 1: cacheWriteTokens > 0, cacheReadTokens == 0
 *      Call 2: cacheReadTokens > 0, cacheWriteTokens == 0
 *   4. Prints token accounting + naive cost on both calls so we can eyeball
 *      the savings.
 *
 * Dev-loop: if Call 1 has cacheWriteTokens == 0, the system prompt is below
 * the model's minimum-prefix threshold. Fix by either padding the prompt or
 * moving stable content from the user message into the system block.
 *
 * Cost: ~$0.02-0.05 — negligible vs. full 30-shot 10d run.
 *
 * Usage:
 *   cd ~/proto_front
 *   npx tsx os-api/tests/10d-pre-cache-hit-probe.ts | tee /tmp/10d-pre-cache.log
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Load os-api/.env regardless of CWD.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { callClaude, getVertexConfig, getBackend } from "../src/anthropic.js";
import { SYSTEM_PROMPT } from "../src/orchestrator_prompts.js";

async function main() {
  const cfg = getVertexConfig();
  console.log("=== BACKEND ===");
  console.log("backend:     ", cfg.backend);
  console.log("authMode:    ", cfg.authMode);
  console.log("model:       ", cfg.model);
  console.log("getBackend():", getBackend());
  console.log("");

  console.log("=== SYSTEM PROMPT SIZE ===");
  console.log("chars:         ", SYSTEM_PROMPT.length);
  console.log("approx_tokens: ", Math.round(SYSTEM_PROMPT.length / 4));
  console.log("");

  const userQ1 = "Reply with exactly one word: 'ok'.";
  const userQ2 = "Reply with exactly one word: 'ready'.";

  // ── Call 1: should WRITE cache ────────────────────────────────────────
  console.log("=== CALL 1 (expect cache write) ===");
  const call1 = await callClaude({
    systemCached: SYSTEM_PROMPT,
    userMessage: userQ1,
    maxTokens: 32,
    enableWebSearch: false, // no web_search — we want a pure caching signal
  });
  console.log("tokensIn:         ", call1.tokensIn);
  console.log("tokensOut:        ", call1.tokensOut);
  console.log("cacheWriteTokens: ", call1.cacheWriteTokens);
  console.log("cacheReadTokens:  ", call1.cacheReadTokens);
  console.log("text:             ", JSON.stringify(call1.text));
  console.log("");

  // Small gap — cache entry only becomes readable after first response
  // begins streaming. We've already awaited the full response, so the cache
  // should be committed, but a tiny wait protects against edge timing.
  await new Promise((r) => setTimeout(r, 1000));

  // ── Call 2: should READ cache ─────────────────────────────────────────
  console.log("=== CALL 2 (expect cache read) ===");
  const call2 = await callClaude({
    systemCached: SYSTEM_PROMPT,
    userMessage: userQ2,
    maxTokens: 32,
    enableWebSearch: false,
  });
  console.log("tokensIn:         ", call2.tokensIn);
  console.log("tokensOut:        ", call2.tokensOut);
  console.log("cacheWriteTokens: ", call2.cacheWriteTokens);
  console.log("cacheReadTokens:  ", call2.cacheReadTokens);
  console.log("text:             ", JSON.stringify(call2.text));
  console.log("");

  // ── Assertions ────────────────────────────────────────────────────────
  const failures: string[] = [];
  if (call1.cacheWriteTokens <= 0) {
    failures.push(
      `Call 1: cacheWriteTokens=${call1.cacheWriteTokens} (expected >0). ` +
      `Likely cause: system prompt below model minimum-prefix (4,096 for Opus 4.7). ` +
      `Fix: pad SYSTEM_PROMPT or move stable content from user message to system block.`,
    );
  }
  if (call1.cacheReadTokens !== 0) {
    failures.push(
      `Call 1: cacheReadTokens=${call1.cacheReadTokens} (expected 0 — no prior cache).`,
    );
  }
  if (call2.cacheReadTokens <= 0) {
    failures.push(
      `Call 2: cacheReadTokens=${call2.cacheReadTokens} (expected >0). ` +
      `Cache write in Call 1 didn't produce a readable entry. ` +
      `Check for silent invalidators between calls (date/time in prompt, non-det JSON).`,
    );
  }
  if (call2.cacheWriteTokens !== 0) {
    failures.push(
      `Call 2: cacheWriteTokens=${call2.cacheWriteTokens} (expected 0 — should be a pure read).`,
    );
  }

  if (failures.length > 0) {
    console.log("=== ASSERTIONS FAILED ===");
    for (const f of failures) console.log("✗", f);
    process.exit(1);
  }

  console.log("=== ASSERTIONS PASSED ===");
  console.log("✓ Call 1 wrote cache");
  console.log("✓ Call 2 read cache");
  console.log("");
  console.log("=== SAVINGS ESTIMATE ===");
  const writeTokens = call1.cacheWriteTokens;
  const readTokens = call2.cacheReadTokens;
  console.log(`cache write (1.25x input): ${writeTokens} tokens`);
  console.log(`cache read  (0.10x input): ${readTokens} tokens`);
  console.log(
    `30-shot 10d, ~2 calls/shot: 1 write + 59 reads → ~` +
    `${Math.round(((1.25 + 59 * 0.1) / 60 / 1) * 100)}% of uncached cost for the cached prefix.`,
  );
}

main().catch((err) => {
  console.error("=== PROBE ERROR ===");
  console.error(err);
  process.exit(1);
});
