/**
 * chunk3-phase1c-full-reset — comprehensive state reset for the Chunk 3 relaunch.
 *
 * Supersedes both Phase 1.2 (escalation flipping — plan was wrong) and Phase 1b
 * (Session B escalation delete + 3-shot reset) once the runner.ts narrative
 * forwarding bug surfaced mid-run. Cleans up:
 *
 *   - ALL asset_escalations for Drift MV campaign deliverables (Session B + botched run)
 *   - All "context-blind" video artifacts (lacking metadata.narrative_context) on
 *     currently-reviewing deliverables — these were produced by the botched run's
 *     regens that were graded context-blind and will otherwise become the "latest"
 *     artifact that `getLatestArtifactByDeliverable` returns
 *   - Reset reviewing/rejected deliverables → pending, preserving approved
 *
 * After this script + the runner.ts patch, the relaunch will:
 *   1. Grade each non-approved deliverable's latest artifact (which now has
 *      narrative_context because botched regens are purged)
 *   2. If that artifact is borderline/fails, enter the escalation loop which
 *      now carries narrative_context through mid-loop regens (runner.ts fix)
 *   3. Produce clean grading + orchestration decisions that reflect the
 *      narrative-aware pipeline
 *
 * Modes:
 *   DRY=1    — preview (default)
 *   APPLY=1  — delete + reset
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { supabase } from "../src/supabase.js";

const CAMPAIGN_ID = "42f62a1d-b9df-57d8-8197-470692733391";
const DRY = process.env.APPLY !== "1";

async function main() {
  console.log(`=== Chunk 3 Phase 1c — FULL RESET — mode: ${DRY ? "DRY" : "APPLY"} ===`);

  // 1. Get all deliverables for this campaign
  const { data: delivs, error: dErr } = await supabase
    .from("campaign_deliverables")
    .select("id, status")
    .eq("campaign_id", CAMPAIGN_ID);
  if (dErr) throw dErr;
  const allDeliverableIds = (delivs ?? []).map((d) => d.id);
  const byStatus: Record<string, number> = {};
  for (const d of delivs ?? []) {
    byStatus[d.status] = (byStatus[d.status] || 0) + 1;
  }
  console.log(`  Campaign deliverables: ${allDeliverableIds.length}`);
  for (const [s, c] of Object.entries(byStatus).sort()) {
    console.log(`    ${s}: ${c}`);
  }

  // 2. Collect all escalations for these deliverables
  const { data: allEscs } = await supabase
    .from("asset_escalations")
    .select("id, run_id, deliverable_id, artifact_id, status, current_level")
    .in("deliverable_id", allDeliverableIds);
  console.log(`\n  Total escalations in scope: ${allEscs?.length ?? 0}`);
  const escByRun: Record<string, number> = {};
  for (const e of allEscs ?? []) {
    const rid = e.run_id?.slice(0, 8) ?? "(null)";
    escByRun[rid] = (escByRun[rid] || 0) + 1;
  }
  for (const [rid, c] of Object.entries(escByRun).sort()) {
    console.log(`    run=${rid}: ${c}`);
  }

  // 3. Find context-blind artifacts on non-approved deliverables:
  //    video artifacts WHERE metadata->>'narrative_context' IS NULL
  //    Only delete those on deliverables currently in non-approved state.
  const nonApprovedDeliverableIds = (delivs ?? [])
    .filter((d) => d.status !== "approved")
    .map((d) => d.id);
  console.log(`\n  Non-approved deliverables (cleanup targets): ${nonApprovedDeliverableIds.length}`);

  const { data: arts } = await supabase
    .from("artifacts")
    .select("id, deliverable_id, type, metadata, created_at")
    .in("deliverable_id", nonApprovedDeliverableIds)
    .eq("type", "video");

  // Group by deliverable, sort DESC, find context-blind (no narrative_context)
  const byDel = new Map<string, any[]>();
  for (const a of arts ?? []) {
    const arr = byDel.get(a.deliverable_id) || [];
    arr.push(a);
    byDel.set(a.deliverable_id, arr);
  }
  for (const arr of byDel.values()) {
    arr.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  const toDeleteArtifactIds: string[] = [];
  let deliverablesNeedingArtifactCleanup = 0;
  for (const [delivId, arr] of byDel) {
    const contextBlind = arr.filter((a) => !(a.metadata as any)?.narrative_context);
    if (contextBlind.length > 0) {
      deliverablesNeedingArtifactCleanup++;
      for (const a of contextBlind) {
        toDeleteArtifactIds.push(a.id);
      }
      const remainingWithCtx = arr.length - contextBlind.length;
      if (remainingWithCtx === 0) {
        console.log(`  ⚠ deliverable ${delivId.slice(0, 8)}: ${arr.length} artifacts, ALL lack narrative_context — would delete all, leaving deliverable artifactless`);
      }
    }
  }
  console.log(`  Context-blind artifacts to delete: ${toDeleteArtifactIds.length} across ${deliverablesNeedingArtifactCleanup} deliverables`);

  // 4. Deliverables to reset (currently reviewing/rejected)
  const resetTargets = (delivs ?? [])
    .filter((d) => d.status === "reviewing" || d.status === "rejected")
    .map((d) => d.id);
  console.log(`  Deliverables to reset (reviewing/rejected → pending): ${resetTargets.length}`);

  if (DRY) {
    console.log("\n(DRY) would DELETE escalations + context-blind artifacts + reset reviewing/rejected");
    console.log("(run with APPLY=1 to mutate)");
    return;
  }

  // APPLY
  console.log("\n=== APPLY ===");

  // 4a. Delete escalations
  if (allEscs && allEscs.length > 0) {
    const { error: e1, count } = await supabase
      .from("asset_escalations")
      .delete({ count: "exact" })
      .in("id", allEscs.map((e) => e.id));
    if (e1) throw e1;
    console.log(`  ✓ deleted ${count} escalations`);
  }

  // 4b. Delete context-blind artifacts
  if (toDeleteArtifactIds.length > 0) {
    const { error: e2, count } = await supabase
      .from("artifacts")
      .delete({ count: "exact" })
      .in("id", toDeleteArtifactIds);
    if (e2) throw e2;
    console.log(`  ✓ deleted ${count} context-blind artifacts`);
  }

  // 4c. Reset deliverables
  if (resetTargets.length > 0) {
    const { error: e3, count } = await supabase
      .from("campaign_deliverables")
      .update({ status: "pending", updated_at: new Date().toISOString() }, { count: "exact" })
      .in("id", resetTargets);
    if (e3) throw e3;
    console.log(`  ✓ reset ${count} deliverables → pending`);
  }

  // 5. Final state check
  const { data: finalDelivs } = await supabase
    .from("campaign_deliverables")
    .select("status")
    .eq("campaign_id", CAMPAIGN_ID);
  const finalDist: Record<string, number> = {};
  for (const d of finalDelivs ?? []) {
    finalDist[d.status] = (finalDist[d.status] || 0) + 1;
  }
  console.log("\n  Post-reset deliverable distribution:");
  for (const [s, c] of Object.entries(finalDist).sort()) {
    console.log(`    ${s}: ${c}`);
  }
  console.log("\n✓ Phase 1c complete — relaunch regrade");
}
main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
