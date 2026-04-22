import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { supabase } from "../src/supabase.js";

const SESSION_B_RUN_ID = "d5999b91-1ee6-4858-bba5-a85fd821c0dd";

async function main() {
  const { data: esc } = await supabase
    .from("asset_escalations")
    .select("deliverable_id, artifact_id, status, current_level")
    .eq("run_id", SESSION_B_RUN_ID);

  const deliverableIds = Array.from(new Set((esc ?? []).map((e: any) => e.deliverable_id).filter(Boolean)));
  const artifactIds = Array.from(new Set((esc ?? []).map((e: any) => e.artifact_id).filter(Boolean)));

  console.log(`=== Session B-touched deliverables: ${deliverableIds.length} ===`);
  console.log(`  IDs: ${deliverableIds.join(", ")}`);
  const { data: delivs, error: dErr } = await supabase
    .from("campaign_deliverables")
    .select("*")
    .in("id", deliverableIds);
  console.log(`  query returned: ${delivs?.length ?? 0} rows, error=${dErr?.message ?? "none"}`);
  const shotOf = (d: any) => d.metadata?.shotNumber ?? d.metadata?.shot_number ?? d.metadata?.narrative_context?.shot_number ?? 0;
  for (const d of (delivs ?? []).sort((a: any, b: any) => shotOf(a) - shotOf(b))) {
    console.log(`  shot=${String(shotOf(d)).padStart(2)} id=${d.id.slice(0,8)} status=${d.status}`);
  }

  console.log(`\n=== Session B-touched artifacts: ${artifactIds.length} ===`);
  const { data: arts } = await supabase
    .from("artifacts")
    .select("id, deliverable_id, type, grade, created_at")
    .in("id", artifactIds);
  for (const a of (arts ?? []).sort((a: any, b: any) => a.created_at.localeCompare(b.created_at))) {
    console.log(`  art=${a.id.slice(0,8)} deliv=${a.deliverable_id?.slice(0,8)} grade=${a.grade ?? "(null)"} type=${a.type}`);
  }

  console.log(`\n=== current reviewing deliverables ===`);
  const { data: reviewing } = await supabase
    .from("campaign_deliverables")
    .select("*, updated_at")
    .eq("status", "reviewing")
    .eq("campaign_id", "42f62a1d-b9df-57d8-8197-470692733391");
  for (const r of (reviewing ?? []) as any[]) {
    const inSessionB = deliverableIds.includes(r.id);
    console.log(`  shot=${String(shotOf(r)).padStart(2)} id=${r.id.slice(0,8)} ${inSessionB ? "[SESSION-B]" : "[NEW]"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
