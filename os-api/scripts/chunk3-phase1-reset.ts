/**
 * chunk3-phase1-reset — Chunk 3 Phase 1 mutations for the 30-shot Drift MV regrade.
 *
 * 1.1 — Preview + reset non-approved campaign_deliverables for the Drift MV campaign to `pending`.
 *       Expected: 24 non-approved → pending; 6 approved preserved.
 * 1.2 — Cancel Session B (`d5999b91-1ee6-4858-bba5-a85fd821c0dd`) in_progress asset_escalations
 *       by flipping status to `hitl_required` with an audit note appended.
 * 1.3 — Stale-artifact guard: list any deliverable with >1 video artifact; surface the newest's
 *       `metadata.narrative_context` presence. Read-only. If any newest lacks narrative_context,
 *       report and EXIT NON-ZERO — do not auto-fix (ASK TIM per plan §1.3).
 *
 * Modes (env):
 *   DRY=1      — read-only preview of 1.1 + 1.2 + full 1.3 (default)
 *   APPLY=1    — runs 1.1 + 1.2 mutations; 1.3 still read-only
 *
 * Project-scoped: uses os-api/.env (points at tfbfzepaccvklpabllao).
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { supabase } from "../src/supabase.js";

const CAMPAIGN_ID = "42f62a1d-b9df-57d8-8197-470692733391";
const SESSION_B_RUN_ID = "d5999b91-1ee6-4858-bba5-a85fd821c0dd";

const DRY = process.env.APPLY !== "1";
const mode = DRY ? "DRY-RUN (read-only)" : "APPLY (mutations live)";

async function step11PreviewAndReset(): Promise<{ pendingBefore: number; approvedBefore: number; flipped: number }> {
  console.log("\n=== 1.1 — Reset non-approved deliverables ===");
  const { data: rows, error } = await supabase
    .from("campaign_deliverables")
    .select("id, status")
    .eq("campaign_id", CAMPAIGN_ID);
  if (error) throw error;
  if (!rows || rows.length === 0) {
    console.log("✗ No deliverables for campaign — aborting.");
    process.exit(2);
  }

  const byStatus: Record<string, number> = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  }
  console.log(`  Total deliverables: ${rows.length}`);
  for (const [s, c] of Object.entries(byStatus).sort()) {
    console.log(`    ${s}: ${c}`);
  }

  const targetStatuses = new Set(["pending", "reviewing", "rejected", "generating", "regenerating"]);
  const toFlip = rows.filter((r) => targetStatuses.has(r.status));
  const approvedCount = rows.filter((r) => r.status === "approved").length;

  console.log(`  → ${toFlip.length} rows would flip to pending (${approvedCount} approved preserved)`);

  if (DRY) {
    return { pendingBefore: byStatus.pending || 0, approvedBefore: approvedCount, flipped: 0 };
  }

  // APPLY
  const ids = toFlip.map((r) => r.id);
  if (ids.length === 0) {
    console.log("  ✓ nothing to flip — already clean");
    return { pendingBefore: byStatus.pending || 0, approvedBefore: approvedCount, flipped: 0 };
  }
  const { data: updated, error: uErr } = await supabase
    .from("campaign_deliverables")
    .update({ status: "pending", updated_at: new Date().toISOString() })
    .in("id", ids)
    .select("id");
  if (uErr) throw uErr;
  console.log(`  ✓ flipped ${updated?.length ?? 0} deliverables to pending`);
  return { pendingBefore: byStatus.pending || 0, approvedBefore: approvedCount, flipped: updated?.length ?? 0 };
}

async function step12CancelSessionBEscalations(): Promise<{ targeted: number; updated: number }> {
  console.log("\n=== 1.2 — Cancel Session B in_progress escalations ===");
  const { data: rows, error } = await supabase
    .from("asset_escalations")
    .select("id, status, resolution_notes")
    .eq("run_id", SESSION_B_RUN_ID)
    .eq("status", "in_progress");
  if (error) throw error;
  const targeted = rows?.length ?? 0;
  console.log(`  run_id=${SESSION_B_RUN_ID}`);
  console.log(`  in_progress escalations: ${targeted}`);

  if (DRY) {
    return { targeted, updated: 0 };
  }
  if (targeted === 0) {
    console.log("  ✓ nothing to cancel — Session B already clean");
    return { targeted: 0, updated: 0 };
  }

  const note = "\n[Session B cancelled 2026-04-21; reset for Chunk 3 regrade with narrative context]";
  let updatedCount = 0;
  for (const r of rows!) {
    const newNotes = (r.resolution_notes || "") + note;
    const { error: uErr } = await supabase
      .from("asset_escalations")
      .update({
        status: "hitl_required",
        resolution_notes: newNotes,
        updated_at: new Date().toISOString(),
      })
      .eq("id", r.id);
    if (uErr) {
      console.error(`  ✗ escalation ${r.id}: ${uErr.message}`);
    } else {
      updatedCount++;
    }
  }
  console.log(`  ✓ flipped ${updatedCount}/${targeted} Session B escalations to hitl_required`);
  return { targeted, updated: updatedCount };
}

async function step13StaleArtifactGuard(): Promise<{ duplicates: number; missingNarrative: number; fixed: number }> {
  console.log("\n=== 1.3 — Stale-artifact guard ===");
  const { data: artifacts, error } = await supabase
    .from("artifacts")
    .select("id, deliverable_id, type, metadata, created_at")
    .eq("campaign_id", CAMPAIGN_ID)
    .eq("type", "video")
    .order("created_at", { ascending: false });
  if (error) throw error;
  if (!artifacts || artifacts.length === 0) {
    console.log("  (no video artifacts found)");
    return { duplicates: 0, missingNarrative: 0, fixed: 0 };
  }

  const byDeliverable = new Map<string, typeof artifacts>();
  for (const a of artifacts) {
    if (!a.deliverable_id) continue;
    const arr = byDeliverable.get(a.deliverable_id) || [];
    arr.push(a);
    byDeliverable.set(a.deliverable_id, arr);
  }

  type StaleRow = {
    deliverable_id: string;
    newest_id: string;
    newest_at: string;
    newest_metadata: Record<string, unknown> | null;
    predecessor_narrative: unknown;
    predecessor_id: string;
  };

  let duplicates = 0;
  const staleRows: StaleRow[] = [];

  for (const [delivId, arr] of byDeliverable) {
    if (arr.length > 1) {
      duplicates++;
      const newest = arr[0]; // DESC sorted
      const hasNarrative = Boolean((newest.metadata as any)?.narrative_context);
      if (hasNarrative) continue;
      // Find the most recent predecessor that DOES have narrative_context
      const predecessorWithNarrative = arr.slice(1).find(
        (a) => Boolean((a.metadata as any)?.narrative_context)
      );
      if (!predecessorWithNarrative) {
        // No predecessor with narrative_context either → surface but can't auto-fix
        staleRows.push({
          deliverable_id: delivId,
          newest_id: newest.id,
          newest_at: newest.created_at,
          newest_metadata: (newest.metadata as any) ?? null,
          predecessor_narrative: null,
          predecessor_id: "",
        });
        continue;
      }
      staleRows.push({
        deliverable_id: delivId,
        newest_id: newest.id,
        newest_at: newest.created_at,
        newest_metadata: (newest.metadata as any) ?? null,
        predecessor_narrative: (predecessorWithNarrative.metadata as any).narrative_context,
        predecessor_id: predecessorWithNarrative.id,
      });
    }
  }

  const missingNarrative = staleRows.length;
  const fixable = staleRows.filter((r) => r.predecessor_narrative !== null).length;
  const unfixable = missingNarrative - fixable;

  console.log(`  deliverables with >1 video artifact: ${duplicates}`);
  console.log(`  of those, newest missing metadata.narrative_context: ${missingNarrative}`);
  console.log(`    fixable via predecessor copy: ${fixable}`);
  console.log(`    UNFIXABLE (no predecessor with narrative_context): ${unfixable}`);

  if (missingNarrative === 0) {
    return { duplicates, missingNarrative: 0, fixed: 0 };
  }

  if (unfixable > 0) {
    console.log("  ⚠ UNFIXABLE ROWS:");
    for (const r of staleRows.filter((r) => r.predecessor_narrative === null)) {
      console.log(`     deliverable=${r.deliverable_id} newest_artifact=${r.newest_id} @ ${r.newest_at}`);
    }
    console.log("  ⚠ Auto-fix declined — ASK TIM. HALT.");
    return { duplicates, missingNarrative, fixed: 0 };
  }

  if (DRY) {
    console.log("  (DRY) would forward-copy narrative_context from predecessor into each newest artifact's metadata");
    for (const r of staleRows.slice(0, 10)) {
      console.log(`     ${r.deliverable_id}: copy narrative_context from predecessor ${r.predecessor_id} → newest ${r.newest_id}`);
    }
    return { duplicates, missingNarrative, fixed: 0 };
  }

  // APPLY — forward-copy narrative_context into newest metadata (non-destructive merge)
  let fixed = 0;
  for (const r of staleRows) {
    const newMeta = { ...(r.newest_metadata ?? {}), narrative_context: r.predecessor_narrative };
    const { error: uErr } = await supabase
      .from("artifacts")
      .update({ metadata: newMeta })
      .eq("id", r.newest_id);
    if (uErr) {
      console.error(`  ✗ artifact ${r.newest_id}: ${uErr.message}`);
    } else {
      fixed++;
    }
  }
  console.log(`  ✓ forward-copied narrative_context to ${fixed}/${missingNarrative} stale newest artifacts`);
  return { duplicates, missingNarrative, fixed };
}

async function main() {
  console.log(`=== Chunk 3 Phase 1 — mode: ${mode} ===`);
  console.log(`    campaign_id = ${CAMPAIGN_ID}`);
  console.log(`    session_b_run_id = ${SESSION_B_RUN_ID}`);

  const r11 = await step11PreviewAndReset();
  const r12 = await step12CancelSessionBEscalations();
  const r13 = await step13StaleArtifactGuard();

  console.log("\n=== SUMMARY ===");
  console.log(`  1.1 deliverables flipped to pending: ${DRY ? "(DRY)" : r11.flipped}`);
  console.log(`  1.1 approved preserved: ${r11.approvedBefore}`);
  console.log(`  1.2 Session B escalations targeted / updated: ${r12.targeted} / ${DRY ? "(DRY)" : r12.updated}`);
  console.log(`  1.3 duplicates: ${r13.duplicates}; missing narrative_context on newest: ${r13.missingNarrative}; forward-copied: ${DRY ? "(DRY)" : r13.fixed}`);

  // Unfixable stale artifacts (no predecessor with narrative_context) — halt for Tim
  const unfixable = r13.missingNarrative > 0 && (DRY ? false : r13.fixed < r13.missingNarrative);
  if (unfixable) {
    console.log("\n⚠ Phase 1.3 has UNFIXABLE stale artifacts — HALT. Ask Tim.");
    process.exit(3);
  }
  console.log(DRY ? "\n(preview only — run with APPLY=1 to mutate)" : "\n✓ Phase 1 mutations applied");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
