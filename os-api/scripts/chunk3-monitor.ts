/**
 * chunk3-monitor — periodic live snapshot of the 30-shot regrade run.
 *
 * Queries:
 *   - runs.status / started_at / finished_at
 *   - orchestration_decisions count + SUM(cost) + action buckets (L1/L2/L3/accept)
 *   - campaign_deliverables status distribution
 *   - asset_escalations count (for this run)
 *
 * Prints a compact table; also evaluates kill-switch triggers and flags red.
 *
 * Usage:
 *   (set -a; . os-api/.env; set +a; RUN_ID=<uuid> npx tsx os-api/scripts/chunk3-monitor.ts)
 *
 * Env:
 *   RUN_ID=<uuid>   (required) the run to monitor
 *   CAMPAIGN_ID=<uuid>  optional; defaults to Drift MV campaign
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { supabase } from "../src/supabase.js";

const RUN_ID = process.env.RUN_ID || "6821c3ef-c796-4dff-9213-f2e10db3f67b";
const CAMPAIGN_ID = process.env.CAMPAIGN_ID || "42f62a1d-b9df-57d8-8197-470692733391";
const VEO_COST_PER_REGEN_USD = 3.2; // plan projection
// Tightened for run 3 (already spent ~$19 between run 1 + 2): remaining ~$10
// for this run. If that's exceeded early, kill.
const BUDGET_EARLY_SHOT = 5;
const BUDGET_EARLY_USD = 8;
const BUDGET_MID_SHOT = 12;
const BUDGET_MID_USD = 15;

async function main() {
  const now = new Date().toISOString();
  console.log(`\n=== chunk3-monitor · ${now} ===`);
  console.log(`  run_id=${RUN_ID}`);

  // 1. Run status
  const { data: run, error: runErr } = await supabase
    .from("runs")
    .select("id, status, mode, started_at, completed_at, updated_at")
    .eq("id", RUN_ID)
    .maybeSingle();
  if (runErr) {
    console.log("  ✗ run query error:", runErr.message);
    process.exit(2);
  }
  if (!run) {
    console.log("  ✗ run not found");
    process.exit(2);
  }
  console.log(`  status=${run.status}  started=${run.started_at ?? "(pending)"}  completed=${run.completed_at ?? "(open)"}`);

  // 2. Orchestration decisions + cost
  const { data: decisions } = await supabase
    .from("orchestration_decisions")
    .select("cost, decision, escalation_id, created_at")
    .eq("run_id", RUN_ID)
    .order("created_at", { ascending: true });
  const decisionCount = decisions?.length ?? 0;
  const totalOrchCost = (decisions ?? []).reduce((sum, d) => sum + (Number(d.cost) || 0), 0);
  const actions = { accept: 0, prompt_fix: 0, approach_change: 0, redesign: 0, replace: 0, other: 0 };
  for (const d of decisions ?? []) {
    const a = (d.decision as any)?.action ?? "other";
    if (a in actions) {
      (actions as any)[a]++;
    } else {
      actions.other++;
    }
  }
  console.log(`  orch decisions=${decisionCount}  total_orch_cost=$${totalOrchCost.toFixed(4)}`);
  console.log(`  actions: accept=${actions.accept} L1=${actions.prompt_fix} L2=${actions.approach_change} L3=${actions.redesign + actions.replace} other=${actions.other}`);

  // 3. Deliverable status
  const { data: deliverables } = await supabase
    .from("campaign_deliverables")
    .select("status")
    .eq("campaign_id", CAMPAIGN_ID);
  const dist: Record<string, number> = {};
  for (const r of deliverables ?? []) {
    dist[r.status] = (dist[r.status] || 0) + 1;
  }
  const pairs = Object.entries(dist).sort();
  console.log(`  deliverables: ${pairs.map(([s, c]) => `${s}=${c}`).join(" ")}`);

  // 4. Escalations
  const { data: escalations } = await supabase
    .from("asset_escalations")
    .select("id, status, deliverable_id")
    .eq("run_id", RUN_ID);
  const escalationsByDeliverable = new Map<string, number>();
  for (const e of escalations ?? []) {
    escalationsByDeliverable.set(e.deliverable_id, (escalationsByDeliverable.get(e.deliverable_id) || 0) + 1);
  }
  const maxEscalationsOnOneShot = Math.max(0, ...escalationsByDeliverable.values());
  console.log(`  escalations (this run): ${escalations?.length ?? 0}  max/shot=${maxEscalationsOnOneShot}`);

  // 5. Estimate Veo regen cost using L2/L3 decisions (proxy)
  const regenCount = actions.approach_change + actions.redesign + actions.replace;
  const estVeoCost = regenCount * VEO_COST_PER_REGEN_USD;
  const estTotalCost = totalOrchCost + estVeoCost;
  console.log(`  est regens=${regenCount}  est_veo_cost=$${estVeoCost.toFixed(2)}  est_total=$${estTotalCost.toFixed(2)}`);

  // 6. Kill-switch evaluation
  const resolved = (dist.approved || 0) + (dist.rejected || 0);
  console.log(`  resolved=${resolved}/30  (approved=${dist.approved || 0}  rejected=${dist.rejected || 0})`);
  const triggers: string[] = [];
  if (resolved >= BUDGET_EARLY_SHOT && estTotalCost > BUDGET_EARLY_USD) {
    triggers.push(`EARLY_SPEND: estTotal=$${estTotalCost.toFixed(2)} > $${BUDGET_EARLY_USD} at ${resolved} shots resolved`);
  }
  if (resolved >= BUDGET_MID_SHOT && estTotalCost > BUDGET_MID_USD) {
    triggers.push(`MID_SPEND: estTotal=$${estTotalCost.toFixed(2)} > $${BUDGET_MID_USD} at ${resolved} shots resolved`);
  }
  if (maxEscalationsOnOneShot > 3) {
    triggers.push(`PER_SHOT_LOOP: shot has ${maxEscalationsOnOneShot} escalations`);
  }
  if (triggers.length > 0) {
    console.log("  🚨 KILL-SWITCH TRIGGERS:");
    for (const t of triggers) console.log(`     - ${t}`);
    console.log("  → RECOMMEND CANCEL: POST /api/runs/" + RUN_ID + "/cancel");
    process.exit(7);
  }

  console.log("  ✓ no kill-switch triggered");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
