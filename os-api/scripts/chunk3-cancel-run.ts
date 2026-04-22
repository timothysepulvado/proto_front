import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { supabase } from "../src/supabase.js";

async function main() {
  const RUN_ID = process.argv[2] ?? "11c857b7-9914-4c0e-ac5e-a3ccdc4e99a8";
  const { data, error } = await supabase
    .from("runs")
    .update({
      status: "cancelled",
      completed_at: new Date().toISOString(),
      error: "Cancelled mid-run by Brandy for runner.ts narrative_context bug patch (Chunk 3 Phase 4b).",
    })
    .eq("id", RUN_ID)
    .select()
    .single();
  if (error) throw error;
  console.log(`✓ run ${RUN_ID} marked cancelled (was: ${data.status})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
