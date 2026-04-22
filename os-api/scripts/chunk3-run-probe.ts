import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { supabase } from "../src/supabase.js";

async function main() {
  console.log("SUPABASE_URL_LAST8:", (process.env.SUPABASE_URL ?? "").slice(-8));
  const RUN_ID = "11c857b7-9914-4c0e-ac5e-a3ccdc4e99a8";
  const { data, error } = await supabase
    .from("runs")
    .select("*")
    .eq("id", RUN_ID);
  console.log("\nexact-match query:");
  console.log("  error:", error);
  console.log("  rowcount:", data?.length ?? 0);
  if (data && data[0]) {
    console.log("  columns:", Object.keys(data[0]).join(", "));
    console.log("  status:", data[0].status);
    console.log("  created_at:", data[0].created_at);
  }
  const { data: recent } = await supabase
    .from("runs")
    .select("id, status, created_at, client_id, mode")
    .order("created_at", { ascending: false })
    .limit(5);
  console.log("\nrecent runs (top 5 by created_at):");
  for (const r of recent ?? []) {
    console.log(`  ${r.id.slice(0, 8)}  ${r.status.padEnd(12)}  ${r.mode?.padEnd(8) ?? "-"}  ${r.created_at}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
