/**
 * One-shot cleanup script: close `asset_escalations` rows left in `open` /
 * `in_progress` state by killed regrade runs. Idempotent — safe to re-run.
 *
 * Background (Step 10d Chunk 3 PARTIAL + LANDED, 2026-04-22 → 2026-04-23):
 * Several diagnostic regrade runs were cancelled mid-flight (44447f5d,
 * 92aec59f, others). The escalation_loop creates an `asset_escalations` row
 * per QA-failed artifact, sets status="in_progress", and only resolves it on
 * the final orchestrator decision. When the run is killed mid-loop, the row
 * stays open. Bug #1 fix (2026-04-23) scoped escalation lookups to
 * `(artifact_id, run_id)`, so these stale rows no longer short-circuit fresh
 * runs — but they pollute observability dashboards and confuse manual audits.
 *
 * Default targets: incident-prefix list from chunk 3 PARTIAL +
 * production-budget-cap kill of run 92aec59f. Override via env to clean other
 * known incidents.
 *
 * Usage:
 *   (set -a; . os-api/.env; set +a; npx tsx os-api/scripts/cleanup-stuck-escalations.ts)
 *
 * Environment overrides:
 *   RUN_ID_PREFIXES   — comma-separated UUID prefixes, e.g. "44447f5d,92aec59f"
 *                       (default: the two chunk-3 incidents above)
 *   RESOLUTION_NOTE   — note written to closed rows (default: stuck-cleanup default)
 *   DRY=1             — print what would change without writing
 */
import { supabase } from "../src/supabase.js";

const DEFAULT_PREFIXES = ["44447f5d", "92aec59f"];

const PREFIXES = (process.env.RUN_ID_PREFIXES ?? DEFAULT_PREFIXES.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const RESOLUTION_NOTE =
  process.env.RESOLUTION_NOTE ??
  "Auto-cleanup (2026-04-24): run cancelled mid-flight; escalation closed retroactively. " +
    "See Step 10d Chunk 3 PARTIAL incident notes.";

const DRY = process.env.DRY === "1";

interface StuckEscalation {
  id: string;
  run_id: string | null;
  artifact_id: string | null;
  deliverable_id: string | null;
  status: string;
  current_level: string | null;
  iteration_count: number | null;
  created_at: string;
}

async function main(): Promise<void> {
  if (PREFIXES.length === 0) {
    console.log("No RUN_ID_PREFIXES provided and no defaults — exiting.");
    process.exit(0);
  }

  console.log(`Target run_id prefixes: ${PREFIXES.join(", ")}`);
  console.log(`Mode: ${DRY ? "DRY-RUN (no writes)" : "LIVE (writes will happen)"}`);
  console.log("");

  let totalAffected = 0;

  for (const prefix of PREFIXES) {
    // ILIKE matches the UUID's text representation. PostgREST's `ilike`
    // operator wants the wildcard inline, hence the literal % suffix.
    const { data, error } = await supabase
      .from("asset_escalations")
      .select(
        "id, run_id, artifact_id, deliverable_id, status, current_level, iteration_count, created_at",
      )
      .ilike("run_id", `${prefix}%`)
      .in("status", ["open", "in_progress", "pending"]);

    if (error) {
      console.error(`  ✗ select failed for prefix ${prefix}: ${error.message}`);
      continue;
    }

    const rows = (data ?? []) as StuckEscalation[];
    console.log(`Prefix ${prefix}: ${rows.length} stuck row(s) found`);

    if (rows.length === 0) continue;

    for (const row of rows) {
      console.log(
        `  ${row.id} · run=${row.run_id?.slice(0, 8)} ` +
          `del=${row.deliverable_id?.slice(0, 8)} ` +
          `level=${row.current_level} iter=${row.iteration_count} ` +
          `status=${row.status} created=${row.created_at}`,
      );
    }

    if (DRY) {
      totalAffected += rows.length;
      continue;
    }

    // Update each row individually so we can capture per-row errors. Using
    // batch .update().in() would mask which one failed if Supabase RLS or
    // a constraint trips.
    let updated = 0;
    for (const row of rows) {
      const { error: updErr } = await supabase
        .from("asset_escalations")
        .update({
          status: "closed",
          resolution_notes: RESOLUTION_NOTE,
          resolved_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      if (updErr) {
        console.error(`  ✗ update failed for ${row.id}: ${updErr.message}`);
        continue;
      }
      updated++;
    }
    console.log(`  → updated ${updated}/${rows.length} row(s)`);
    totalAffected += updated;
  }

  console.log("");
  console.log(`Total ${DRY ? "would-be-updated" : "updated"}: ${totalAffected}`);
  console.log(DRY ? "DRY mode — no writes performed." : "Cleanup complete.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
