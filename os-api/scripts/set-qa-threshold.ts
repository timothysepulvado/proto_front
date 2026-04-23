/**
 * One-shot script to set `campaigns.guardrails.qa_threshold` on a campaign.
 *
 * Chunk 3 follow-up (2026-04-23) — Path C of plan
 * `fresh-context-today-is-glowing-harp.md`. Enables the borderline-accept
 * short-circuit for a specific campaign by setting the threshold JSONB field
 * on `campaigns.guardrails`. Preserves all other guardrails keys (especially
 * `music_video_context` from Chunk 1).
 *
 * Default target is the Drift MV regrade campaign
 * (`42f62a1d-b9df-57d8-8197-470692733391`) with `pass=3.0 accept=2.5`.
 *
 * Usage:
 *   (set -a; . os-api/.env; set +a; npx tsx os-api/scripts/set-qa-threshold.ts)
 *
 * Environment overrides:
 *   CAMPAIGN_ID         — target campaign UUID (default: Drift MV regrade)
 *   PASS_THRESHOLD      — default 3.0
 *   ACCEPT_THRESHOLD    — default 2.5
 *   DRY=1               — print the intended UPDATE without writing
 */
import { supabase } from "../src/supabase.js";

const DEFAULT_CAMPAIGN_ID = "42f62a1d-b9df-57d8-8197-470692733391";
const CAMPAIGN_ID = process.env.CAMPAIGN_ID ?? DEFAULT_CAMPAIGN_ID;
const PASS = parseFloat(process.env.PASS_THRESHOLD ?? "3.0");
const ACCEPT = parseFloat(process.env.ACCEPT_THRESHOLD ?? "2.5");
const DRY = process.env.DRY === "1";

async function main(): Promise<void> {
  if (!Number.isFinite(PASS) || !Number.isFinite(ACCEPT)) {
    throw new Error("PASS_THRESHOLD + ACCEPT_THRESHOLD must be numbers");
  }
  if (ACCEPT >= PASS) {
    throw new Error(
      `ACCEPT_THRESHOLD (${ACCEPT}) must be strictly less than PASS_THRESHOLD (${PASS})`,
    );
  }

  console.log(`Target campaign: ${CAMPAIGN_ID}`);
  console.log(`  pass_threshold:   ${PASS}`);
  console.log(`  accept_threshold: ${ACCEPT}`);
  console.log("");

  const { data: campaign, error: readErr } = await supabase
    .from("campaigns")
    .select("id, name, guardrails")
    .eq("id", CAMPAIGN_ID)
    .maybeSingle();
  if (readErr) throw new Error(`read failed: ${readErr.message}`);
  if (!campaign) throw new Error(`campaign ${CAMPAIGN_ID} not found`);

  const existing = (campaign.guardrails as Record<string, unknown> | null) ?? {};
  const existingThreshold = existing.qa_threshold as
    | { pass_threshold?: number; accept_threshold?: number }
    | undefined;

  if (
    existingThreshold &&
    existingThreshold.pass_threshold === PASS &&
    existingThreshold.accept_threshold === ACCEPT
  ) {
    console.log(`✓ no-op — threshold already pass=${PASS} accept=${ACCEPT}`);
    return;
  }

  const updated = {
    ...existing,
    qa_threshold: {
      pass_threshold: PASS,
      accept_threshold: ACCEPT,
    },
  };

  const preservedKeys = Object.keys(existing).filter((k) => k !== "qa_threshold");
  console.log(`  preserving guardrails keys: ${preservedKeys.join(", ") || "(none)"}`);
  if (existingThreshold) {
    console.log(
      `  replacing existing: pass=${existingThreshold.pass_threshold} accept=${existingThreshold.accept_threshold}`,
    );
  } else {
    console.log("  setting new qa_threshold (no prior value)");
  }
  console.log("");

  if (DRY) {
    console.log("[DRY] would UPDATE campaigns SET guardrails = ...");
    console.log(JSON.stringify(updated, null, 2));
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
  const verifyThreshold = (verify?.guardrails as Record<string, unknown> | null)
    ?.qa_threshold as { pass_threshold?: number; accept_threshold?: number } | undefined;
  if (
    !verifyThreshold ||
    verifyThreshold.pass_threshold !== PASS ||
    verifyThreshold.accept_threshold !== ACCEPT
  ) {
    throw new Error(
      `verify mismatch — expected pass=${PASS} accept=${ACCEPT}, got ${JSON.stringify(verifyThreshold)}`,
    );
  }

  console.log(`✓ wrote qa_threshold to campaign ${CAMPAIGN_ID}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
