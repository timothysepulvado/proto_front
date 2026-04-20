/**
 * 10c-websearch-probe — minimum-cost call to verify the active orchestrator
 * backend accepts the configured web_search tool declaration AND actually
 * invokes it. Name retains the "10c-vertex-" prefix for git history continuity
 * — the probe is backend-agnostic.
 *
 * Tool upgraded to `web_search_20260209` in 10d pre-flight (2026-04-19). The
 * newer version enables dynamic filtering on Opus 4.7 — the model spins up
 * `code_execution` alongside `web_search` to filter results before they enter
 * context. Expect `toolUses[]` to contain a mix of `web_search` and
 * `code_execution` blocks; assertion thresholds still gate on
 * `webSearchCount >= 1` + `toolUses.length >= 1`.
 *
 * Hardened in 10d-pre (2026-04-17): exits non-zero with explicit failure
 * messages if web_search isn't invoked. Closes gap 10c-3.
 *
 * Usage:
 *   cd ~/proto_front
 *   npx tsx os-api/tests/10c-vertex-websearch-probe.ts | tee /tmp/probe.log
 *
 * Expected: SUCCESS block, then ASSERTIONS PASSED block.
 *   - webSearchCount >= 1
 *   - toolUses.length >= 1
 *   - text non-empty + cites a current Anthropic model id
 *
 * Backend: since the 10c-3 direct pivot (2026-04-19), getVertexConfig()
 * should report backend="direct" + authMode="direct_api_key" when
 * ANTHROPIC_API_KEY is set. Vertex path (backend="vertex",
 * authMode="service_account") remains viable as fallback.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Load os-api/.env regardless of CWD (the probe is run from
// ~/proto_front, but .env lives at ~/proto_front/os-api/.env).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { callClaude, getVertexConfig, getBackend } from "../src/anthropic.js";

async function main() {
  const cfg = getVertexConfig();
  console.log("=== BACKEND ===");
  console.log("backend:", cfg.backend);
  console.log("authMode:", cfg.authMode);
  console.log("project:", cfg.projectId);
  console.log("region:", cfg.region);
  console.log("model:", cfg.model);
  console.log("getBackend():", getBackend());
  console.log("");

  const t0 = Date.now();
  try {
    const res = await callClaude({
      systemCached:
        "You are a research assistant. ALWAYS use the web_search tool to verify any external fact (model versions, release dates, API specs) before stating it. Cite the source URL. Respond tersely.",
      userMessage:
        "As of today (2026-04-19), what is the current GA Claude Opus model id available on Anthropic's API? Use web_search to verify; cite the source URL. One sentence.",
      maxTokens: 512,
      enableWebSearch: true,
      maxWebSearchUses: 3,
    });

    console.log("=== SUCCESS ===");
    console.log("model:        ", res.model);
    console.log("stopReason:   ", res.stopReason);
    console.log("text:         ", res.text);
    console.log("tokensIn/Out: ", res.tokensIn, "/", res.tokensOut);
    console.log("cost:         ", res.cost.toFixed(6));
    console.log("latencyMs:    ", res.latencyMs);
    console.log("webSearchCount:", res.webSearchCount);
    console.log("toolUses:     ", JSON.stringify(res.toolUses, null, 2));
    console.log("elapsed:      ", Date.now() - t0, "ms");
    console.log("");

    // Hardened assertions — exit non-zero on any failure so this can be
    // chained into CI / a regression suite.
    const failures: string[] = [];
    if (res.webSearchCount < 1) {
      failures.push(`webSearchCount=${res.webSearchCount} (expected >= 1 — model did not invoke web_search)`);
    }
    if (res.toolUses.length < 1) {
      failures.push(`toolUses[].length=${res.toolUses.length} (expected >= 1 — no server_tool_use blocks observed)`);
    }
    if (!res.text || res.text.length < 10) {
      failures.push(`text length=${res.text?.length ?? 0} (expected >= 10 — response is empty or trivially short)`);
    }
    if (failures.length > 0) {
      console.log("=== ASSERTION FAILURES ===");
      for (const f of failures) console.log("  -", f);
      process.exit(1);
    }
    console.log("=== ASSERTIONS PASSED ===");
    console.log("✓ web_search was invoked");
    console.log("✓ toolUses[] populated");
    console.log("✓ response text present");
  } catch (e) {
    const dt = Date.now() - t0;
    const err = e as Error & { status?: number; error?: unknown };
    console.log("=== ERROR ===");
    console.log("dt:     ", dt, "ms");
    console.log("name:   ", err.name);
    console.log("status: ", err.status);
    console.log("message:", err.message?.slice(0, 800));
    if (err.error) console.log("error:  ", JSON.stringify(err.error, null, 2).slice(0, 1500));
    process.exit(1);
  }
}
main();
