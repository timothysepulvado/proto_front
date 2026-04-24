/**
 * One-shot script to flip existing Drift MV deliverables to use
 * `veo-3.1-lite-generate-001` instead of `veo-3.1-generate-001`.
 *
 * Tim's call (2026-04-23): switch to Veo Fast for the orchestrator-driven
 * regrade pipeline. Roughly half the per-shot cost; latency is also lower.
 * Quality drop is acceptable for what Drift MV needs at this stage.
 *
 * Future seeds use the fast model by default (seed-drift-mv.ts updated in
 * the same change). Runner fallback also flipped to fast in runner.ts so
 * any deliverable without an explicit `aiModel` defaults to fast.
 *
 * Usage:
 *   (set -a; . os-api/.env; set +a; npx tsx os-api/scripts/switch-to-veo-fast.ts)
 *
 * Environment overrides:
 *   CAMPAIGN_ID  — target campaign UUID (default: Drift MV regrade)
 *   FROM_MODEL   — only flip rows currently set to this model id
 *                  (default: 'veo-3.1-generate-001')
 *   TO_MODEL     — destination model id (default: 'veo-3.1-lite-generate-001')
 *   DRY=1        — print intended UPDATE without writing
 */
import { supabase } from "../src/supabase.js";

const DEFAULT_CAMPAIGN_ID = "42f62a1d-b9df-57d8-8197-470692733391";
const CAMPAIGN_ID = process.env.CAMPAIGN_ID ?? DEFAULT_CAMPAIGN_ID;
const FROM_MODEL = process.env.FROM_MODEL ?? "veo-3.1-generate-001";
const TO_MODEL = process.env.TO_MODEL ?? "veo-3.1-lite-generate-001";
const DRY = process.env.DRY === "1";

async function main(): Promise<void> {
  console.log(`Target campaign: ${CAMPAIGN_ID}`);
  console.log(`  ${FROM_MODEL} -> ${TO_MODEL}`);
  console.log("");

  const { data: dels, error: readErr } = await supabase
    .from("campaign_deliverables")
    .select("id, ai_model, status")
    .eq("campaign_id", CAMPAIGN_ID);
  if (readErr) throw new Error(`read failed: ${readErr.message}`);

  const fromCount = (dels ?? []).filter((d) => d.ai_model === FROM_MODEL).length;
  const toCount = (dels ?? []).filter((d) => d.ai_model === TO_MODEL).length;
  const otherCount = (dels ?? []).filter(
    (d) => d.ai_model !== FROM_MODEL && d.ai_model !== TO_MODEL,
  ).length;
  console.log(
    `Current state: ${dels?.length ?? 0} deliverables — ${fromCount} on ${FROM_MODEL}, ${toCount} on ${TO_MODEL}, ${otherCount} other`,
  );

  if (fromCount === 0) {
    console.log(`✓ no-op — no deliverables on ${FROM_MODEL}`);
    return;
  }

  if (DRY) {
    console.log(`[DRY] would UPDATE ${fromCount} rows to ai_model='${TO_MODEL}'`);
    return;
  }

  const { data: updated, error: writeErr } = await supabase
    .from("campaign_deliverables")
    .update({ ai_model: TO_MODEL })
    .eq("campaign_id", CAMPAIGN_ID)
    .eq("ai_model", FROM_MODEL)
    .select("id");
  if (writeErr) throw new Error(`write failed: ${writeErr.message}`);

  console.log(`✓ updated ${updated?.length ?? 0} deliverables to ${TO_MODEL}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
