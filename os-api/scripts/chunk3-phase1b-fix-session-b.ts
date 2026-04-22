/**
 * chunk3-phase1b-fix-session-b — corrective for the Phase 1.2 mistake.
 *
 * The original plan's Phase 1.2 flipped Session B (run d5999b91-…)
 * in_progress asset_escalations to status='hitl_required', expecting them to
 * sit harmlessly as audit history. They do NOT.  `getEscalationByArtifact`
 * (in os-api/src/db.ts:1392) matches by artifact_id regardless of run_id, and
 * the escalation_loop (escalation_loop.ts:113) then reuses that historical
 * row instead of creating a fresh one — so the regrade short-circuits on
 * shots that Session B touched and never invokes the narrative-aware
 * orchestrator on them.
 *
 * The correct thing is to DELETE those 13 escalation rows. The Session B
 * audit trail is preserved elsewhere:
 *   - run_logs (all events)
 *   - orchestration_decisions (19 decisions with costs)
 *   - runs row (d5999b91-… still status=cancelled)
 *   - artifacts (all regens still present; metadata.narrative_context was
 *     forward-copied in Phase 1.3)
 *
 * This script also resets any deliverable that got stuck in `reviewing` or
 * `rejected` due to the short-circuit back to `pending`, so the relaunch
 * re-processes them.
 *
 * Modes:
 *   DRY=1     — preview (default)
 *   APPLY=1   — delete + reset
 *
 * Usage:
 *   cd ~/proto_front && (set -a; . os-api/.env; set +a; \
 *     APPLY=1 npx tsx os-api/scripts/chunk3-phase1b-fix-session-b.ts)
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { supabase } from "../src/supabase.js";

const _CAMPAIGN_ID = "42f62a1d-b9df-57d8-8197-470692733391"; // reference
const SESSION_B_RUN_ID = "d5999b91-1ee6-4858-bba5-a85fd821c0dd";
const DRY = process.env.APPLY !== "1";

async function main() {
  console.log(`=== Chunk 3 Phase 1b — mode: ${DRY ? "DRY" : "APPLY"} ===`);

  // 1. Session B escalations still present?
  const { data: sessionBEscs, error: e1 } = await supabase
    .from("asset_escalations")
    .select("id, artifact_id, deliverable_id, status, current_level, resolution_notes")
    .eq("run_id", SESSION_B_RUN_ID);
  if (e1) throw e1;
  console.log(`  Session B escalations (run_id=${SESSION_B_RUN_ID}): ${sessionBEscs?.length ?? 0}`);
  if (sessionBEscs && sessionBEscs.length > 0) {
    const byStatus: Record<string, number> = {};
    for (const e of sessionBEscs) {
      byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    }
    for (const [s, c] of Object.entries(byStatus).sort()) {
      console.log(`    ${s}: ${c}`);
    }
  }

  // 2. Find deliverables stuck in reviewing/rejected due to Session B short-circuit,
  //    but only when they have a Session B escalation on their LATEST artifact.
  const sessionBArtifactIds = new Set((sessionBEscs ?? []).map((e) => e.artifact_id));
  const sessionBDeliverableIds = new Set((sessionBEscs ?? []).map((e) => e.deliverable_id).filter(Boolean) as string[]);
  console.log(`  unique Session B artifact_ids: ${sessionBArtifactIds.size}`);
  console.log(`  unique Session B deliverable_ids: ${sessionBDeliverableIds.size}`);

  const { data: impactedDelivs } = await supabase
    .from("campaign_deliverables")
    .select("id, status")
    .in("id", Array.from(sessionBDeliverableIds))
    .in("status", ["reviewing", "rejected", "pending"]);
  console.log(`  Session B-impacted deliverables needing reset: ${impactedDelivs?.length ?? 0}`);
  if (impactedDelivs && impactedDelivs.length > 0) {
    const byStatus: Record<string, number> = {};
    for (const d of impactedDelivs) {
      byStatus[d.status] = (byStatus[d.status] || 0) + 1;
    }
    for (const [s, c] of Object.entries(byStatus).sort()) {
      console.log(`    ${s}: ${c}`);
    }
  }

  if (DRY) {
    console.log("\n(DRY) would DELETE the Session B escalations + reset impacted deliverables to pending");
    console.log("(run with APPLY=1 to mutate)");
    return;
  }

  // 3. DELETE Session B escalations
  if (sessionBEscs && sessionBEscs.length > 0) {
    const { error: delErr, count } = await supabase
      .from("asset_escalations")
      .delete({ count: "exact" })
      .eq("run_id", SESSION_B_RUN_ID);
    if (delErr) throw delErr;
    console.log(`  ✓ deleted ${count} Session B escalations`);
  }

  // 4. Reset impacted deliverables to pending
  if (impactedDelivs && impactedDelivs.length > 0) {
    const resetIds = impactedDelivs
      .filter((d) => d.status !== "pending")
      .map((d) => d.id);
    if (resetIds.length > 0) {
      const { error: uErr, count } = await supabase
        .from("campaign_deliverables")
        .update({ status: "pending", updated_at: new Date().toISOString() }, { count: "exact" })
        .in("id", resetIds);
      if (uErr) throw uErr;
      console.log(`  ✓ reset ${count} deliverables (reviewing/rejected → pending)`);
    } else {
      console.log(`  (all Session B-impacted deliverables already pending)`);
    }
  }

  console.log("\n✓ Phase 1b complete — relaunch regrade");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
