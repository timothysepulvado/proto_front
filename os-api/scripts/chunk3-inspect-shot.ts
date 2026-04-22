import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { supabase } from "../src/supabase.js";

async function main() {
  const artifactId = process.argv[2] ?? "75223c01-75eb-4ecd-9d9b-2c86d9d56d13";
  const { data: art } = await supabase
    .from("artifacts")
    .select("id, deliverable_id, type, grade, metadata, created_at")
    .eq("id", artifactId)
    .maybeSingle();
  if (!art) {
    console.log("artifact not found");
    return;
  }
  const nc = (art.metadata as any)?.narrative_context ?? {};
  console.log("=== artifact ===");
  console.log(`  id: ${art.id}`);
  console.log(`  deliverable: ${art.deliverable_id}`);
  console.log(`  grade: ${art.grade}`);
  console.log(`  created: ${art.created_at}`);
  console.log(`\n=== narrative_context ===`);
  console.log(`  shot_number:  ${nc.shot_number}`);
  console.log(`  beat_name:    ${nc.beat_name}`);
  console.log(`  song:         ${nc.song_start_s}s–${nc.song_end_s}s`);
  console.log(`  visual_intent: ${String(nc.visual_intent ?? "").slice(0, 150)}...`);
  console.log(`  stylization_allowances: ${JSON.stringify(nc.stylization_allowances ?? [])}`);
  console.log(`  prev_shot: #${nc.previous_shot?.shot_number ?? "n/a"} (${nc.previous_shot?.beat_name ?? "-"})`);
  console.log(`  next_shot: #${nc.next_shot?.shot_number ?? "n/a"} (${nc.next_shot?.beat_name ?? "-"})`);

  const { data: escs } = await supabase
    .from("asset_escalations")
    .select("id, run_id, current_level, status, iteration_count, failure_class, resolution_path, created_at, updated_at")
    .eq("artifact_id", artifactId)
    .order("created_at", { ascending: true });
  console.log(`\n=== escalations on this artifact (${escs?.length ?? 0}) ===`);
  for (const e of escs ?? []) {
    console.log(`  ${e.created_at} run=${e.run_id?.slice(0,8)} lvl=${e.current_level} status=${e.status} iter=${e.iteration_count} fail=${e.failure_class ?? "-"} path=${e.resolution_path ?? "-"}`);
  }

  const { data: decisions } = await supabase
    .from("orchestration_decisions")
    .select("id, created_at, cost, decision, tokens_in, tokens_out")
    .in("escalation_id", (escs ?? []).map((e) => e.id))
    .order("created_at", { ascending: true });
  console.log(`\n=== orchestration_decisions (${decisions?.length ?? 0}) ===`);
  for (const d of decisions ?? []) {
    const dec = (d.decision as any) ?? {};
    const reasoning = String(dec.reasoning ?? "").slice(0, 200);
    console.log(`  ${d.created_at} cost=$${Number(d.cost).toFixed(4)} action=${dec.action} failure=${dec.failure_class ?? "-"}`);
    console.log(`    reasoning: ${reasoning}...`);
  }
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
