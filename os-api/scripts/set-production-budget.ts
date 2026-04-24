/**
 * One-shot script to set `campaigns.guardrails.production_budget` on a
 * campaign.
 *
 * Post-Chunk-3 follow-up (2026-04-23) — per-production budget cap. Read by
 * `runner.ts::executeRegradeStage` before each deliverable iteration; halts
 * the run + flags `needs_review` when the estimated cumulative cost
 * (orchestrator + Veo + image gen) crosses `hard_stop_at_pct` of `total_usd`.
 *
 * Defaults sized for the Drift MV regrade campaign:
 *   - total_usd: $25 (budget for one full-catalog autonomous run on Veo Fast)
 *   - warn_at_pct: 60 (early warning while there's still room to course-correct)
 *   - hard_stop_at_pct: 100 (halt on full budget consumption)
 *
 * Preserves all other guardrail keys (qa_threshold, music_video_context).
 *
 * Usage:
 *   (set -a; . os-api/.env; set +a; npx tsx os-api/scripts/set-production-budget.ts)
 *
 * Environment overrides:
 *   CAMPAIGN_ID       — target campaign UUID (default: Drift MV regrade)
 *   TOTAL_USD         — default 25
 *   WARN_AT_PCT       — default 60
 *   HARD_STOP_AT_PCT  — default 100
 *   DRY=1             — print intended UPDATE without writing
 */
import { supabase } from "../src/supabase.js";

const DEFAULT_CAMPAIGN_ID = "42f62a1d-b9df-57d8-8197-470692733391";
const CAMPAIGN_ID = process.env.CAMPAIGN_ID ?? DEFAULT_CAMPAIGN_ID;
const TOTAL_USD = parseFloat(process.env.TOTAL_USD ?? "25");
const WARN_AT_PCT = parseFloat(process.env.WARN_AT_PCT ?? "60");
const HARD_STOP_AT_PCT = parseFloat(process.env.HARD_STOP_AT_PCT ?? "100");
const DRY = process.env.DRY === "1";

async function main(): Promise<void> {
  if (!Number.isFinite(TOTAL_USD) || TOTAL_USD <= 0) {
    throw new Error("TOTAL_USD must be a positive number");
  }
  if (!Number.isFinite(WARN_AT_PCT) || WARN_AT_PCT <= 0 || WARN_AT_PCT > 100) {
    throw new Error("WARN_AT_PCT must be between 0 and 100");
  }
  if (!Number.isFinite(HARD_STOP_AT_PCT) || HARD_STOP_AT_PCT <= 0 || HARD_STOP_AT_PCT > 200) {
    throw new Error("HARD_STOP_AT_PCT must be between 0 and 200");
  }
  if (WARN_AT_PCT >= HARD_STOP_AT_PCT) {
    throw new Error(`WARN_AT_PCT (${WARN_AT_PCT}) must be < HARD_STOP_AT_PCT (${HARD_STOP_AT_PCT})`);
  }

  console.log(`Target campaign: ${CAMPAIGN_ID}`);
  console.log(`  total_usd: $${TOTAL_USD}`);
  console.log(`  warn_at_pct: ${WARN_AT_PCT}%  (= $${(TOTAL_USD * WARN_AT_PCT / 100).toFixed(2)})`);
  console.log(`  hard_stop_at_pct: ${HARD_STOP_AT_PCT}%  (= $${(TOTAL_USD * HARD_STOP_AT_PCT / 100).toFixed(2)})`);
  console.log("");

  const { data: campaign, error: readErr } = await supabase
    .from("campaigns")
    .select("id, name, guardrails")
    .eq("id", CAMPAIGN_ID)
    .maybeSingle();
  if (readErr) throw new Error(`read failed: ${readErr.message}`);
  if (!campaign) throw new Error(`campaign ${CAMPAIGN_ID} not found`);

  const existing = (campaign.guardrails as Record<string, unknown> | null) ?? {};
  const existingBudget = existing.production_budget as
    | { total_usd?: number; warn_at_pct?: number; hard_stop_at_pct?: number }
    | undefined;

  if (
    existingBudget &&
    existingBudget.total_usd === TOTAL_USD &&
    existingBudget.warn_at_pct === WARN_AT_PCT &&
    existingBudget.hard_stop_at_pct === HARD_STOP_AT_PCT
  ) {
    console.log("✓ no-op — budget already at target values");
    return;
  }

  const updated = {
    ...existing,
    production_budget: {
      total_usd: TOTAL_USD,
      warn_at_pct: WARN_AT_PCT,
      hard_stop_at_pct: HARD_STOP_AT_PCT,
    },
  };

  const preservedKeys = Object.keys(existing).filter((k) => k !== "production_budget");
  console.log(`  preserving guardrails keys: ${preservedKeys.join(", ") || "(none)"}`);
  if (existingBudget) {
    console.log(
      `  replacing existing: total=$${existingBudget.total_usd} warn=${existingBudget.warn_at_pct}% hard=${existingBudget.hard_stop_at_pct}%`,
    );
  } else {
    console.log("  setting new production_budget (no prior value)");
  }
  console.log("");

  if (DRY) {
    console.log("[DRY] would UPDATE campaigns SET guardrails = ...");
    console.log(JSON.stringify(updated.production_budget, null, 2));
    return;
  }

  const { error: writeErr } = await supabase
    .from("campaigns")
    .update({ guardrails: updated })
    .eq("id", CAMPAIGN_ID);
  if (writeErr) throw new Error(`write failed: ${writeErr.message}`);

  // Verify round-trip.
  const { data: verify, error: verifyErr } = await supabase
    .from("campaigns")
    .select("guardrails")
    .eq("id", CAMPAIGN_ID)
    .maybeSingle();
  if (verifyErr) throw new Error(`verify failed: ${verifyErr.message}`);
  const verifyBudget = (verify?.guardrails as Record<string, unknown> | null)
    ?.production_budget as { total_usd?: number; warn_at_pct?: number; hard_stop_at_pct?: number } | undefined;
  if (
    !verifyBudget ||
    verifyBudget.total_usd !== TOTAL_USD ||
    verifyBudget.warn_at_pct !== WARN_AT_PCT ||
    verifyBudget.hard_stop_at_pct !== HARD_STOP_AT_PCT
  ) {
    throw new Error(`verify mismatch — expected total=${TOTAL_USD} warn=${WARN_AT_PCT} hard=${HARD_STOP_AT_PCT}, got ${JSON.stringify(verifyBudget)}`);
  }

  console.log(`✓ wrote production_budget to campaign ${CAMPAIGN_ID}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
