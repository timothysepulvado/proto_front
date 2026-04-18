/**
 * 10d-pre — bare Vertex Claude probe (no tools, minimal call).
 * Diagnoses whether the 429 in the web_search probe is quota-on-the-model
 * (general Anthropic Vertex quota for bran-479523) vs quota-on-tools
 * (web_search-specific limit). If THIS still 429s, it's the model.
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
      temperature: 0.0,
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
