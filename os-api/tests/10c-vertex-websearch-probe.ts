/**
 * 10c-2 isolation probe — minimum-cost call to verify Vertex accepts the
 * web_search_20250305 tool declaration for bran-479523.
 */
import { callClaude } from "../src/anthropic.js";

async function main() {
  const t0 = Date.now();
  try {
    const res = await callClaude({
      systemCached:
        "You are a research assistant. If a question requires current information, use web_search. Respond tersely.",
      userMessage:
        "What is the current stable version of Claude Opus available via Anthropic public API as of today, 2026-04-17? Use web_search to verify. One sentence.",
      temperature: 0.0,
      maxTokens: 256,
      enableWebSearch: true,
      maxWebSearchUses: 2,
    });
    console.log("=== SUCCESS ===");
    console.log("model:", res.model);
    console.log("stopReason:", res.stopReason);
    console.log("text:", res.text);
    console.log("tokensIn/Out:", res.tokensIn, "/", res.tokensOut);
    console.log("cost:", res.cost);
    console.log("latencyMs:", res.latencyMs);
    console.log("webSearchCount:", res.webSearchCount);
    console.log("toolUses:", JSON.stringify(res.toolUses, null, 2));
    console.log("elapsed:", Date.now() - t0, "ms");
  } catch (e) {
    const dt = Date.now() - t0;
    console.log("=== ERROR ===");
    const err = e as Error & { status?: number; error?: unknown };
    console.log("dt:", dt, "ms");
    console.log("name:", err.name);
    console.log("status:", err.status);
    console.log("message:", err.message?.slice(0, 600));
  }
}
main();
