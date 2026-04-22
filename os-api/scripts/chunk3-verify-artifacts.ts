import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { supabase } from "../src/supabase.js";

async function main() {
  const CAMPAIGN_ID = "42f62a1d-b9df-57d8-8197-470692733391";

  // Total artifacts for this campaign
  const { data: arts } = await supabase
    .from("artifacts")
    .select("id, deliverable_id, type, metadata")
    .eq("campaign_id", CAMPAIGN_ID);
  console.log(`Total artifacts for campaign: ${arts?.length ?? 0}`);

  const byType: Record<string, number> = {};
  for (const a of arts ?? []) {
    byType[a.type] = (byType[a.type] || 0) + 1;
  }
  console.log(`By type:`, byType);

  const byDel = new Map<string, any[]>();
  for (const a of arts ?? []) {
    const arr = byDel.get(a.deliverable_id) || [];
    arr.push(a);
    byDel.set(a.deliverable_id, arr);
  }

  // Deliverables with 0 artifacts
  const { data: delivs } = await supabase
    .from("campaign_deliverables")
    .select("id, status")
    .eq("campaign_id", CAMPAIGN_ID);
  const delivsMissing = (delivs ?? []).filter((d) => !byDel.has(d.id));
  console.log(`\nDeliverables MISSING artifacts: ${delivsMissing.length}/${delivs?.length ?? 0}`);
  for (const d of delivsMissing.slice(0, 5)) {
    console.log(`  ${d.id} status=${d.status}`);
  }

  // Narrative context count
  const withNarrative = (arts ?? []).filter((a) => (a.metadata as any)?.narrative_context).length;
  console.log(`\nArtifacts with narrative_context: ${withNarrative}/${arts?.length ?? 0}`);

  // Check storage buckets for a sample artifact's localPath
  if (arts && arts.length > 0) {
    const sample = arts.find((a) => (a.metadata as any)?.narrative_context);
    if (sample) {
      console.log(`\nSample artifact with narrative:`);
      console.log(`  id: ${sample.id}`);
      console.log(`  deliverable: ${sample.deliverable_id}`);
      const meta = sample.metadata as any;
      console.log(`  localPath: ${meta?.localPath ?? "(none)"}`);
      console.log(`  narrative.shot_number: ${meta?.narrative_context?.shot_number}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
