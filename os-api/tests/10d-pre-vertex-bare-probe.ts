/**
 * 10d-pre — bare Claude orchestrator probe (no tools, minimal call).
 *
 * Originally written to diagnose Vertex Claude Opus 4.7 429s on bran-479523
 * (model-quota vs tool-quota). After the 2026-04-19 direct Anthropic pivot,
 * this probe still works: it uses callClaude() which auto-routes per env.
 * When ANTHROPIC_API_KEY is set → direct path; unset → Vertex fallback.
 *
 * Note: `temperature` removed because Claude Opus 4.7 on direct API
 * deprecated the field (400 invalid_request_error). callClaude() now treats
 * it as opt-in. See anthropic.ts.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { callClaude, getVertexConfig } from "../src/anthropic.js";

async function main() {
  console.log("backend:", JSON.stringify(getVertexConfig()));
  const t0 = Date.now();
  try {
    const res = await callClaude({
      systemCached: "Respond with one word.",
      userMessage: "Say 'pong'.",
      maxTokens: 16,
      enableWebSearch: false,
    });
    console.log("=== SUCCESS (no-tools) ===");
    console.log("text:", res.text);
    console.log("tokensIn/Out:", res.tokensIn, "/", res.tokensOut);
    console.log("cost:", res.cost.toFixed(6));
    console.log("latencyMs:", res.latencyMs);
    console.log("elapsed:", Date.now() - t0, "ms");
  } catch (e) {
    const err = e as Error & { status?: number };
    console.log("=== ERROR (no-tools) ===");
    console.log("status:", err.status);
    console.log("message:", err.message?.slice(0, 400));
    process.exit(1);
  }
}
main();
