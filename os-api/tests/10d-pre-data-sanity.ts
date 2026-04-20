/**
 * 10d-pre-data-sanity — confirm Drift MV catalog is intact before 10d.
 *
 * Checks (per 10d-preflight-check.md Phase 3):
 *   1. client_drift-mv row exists with a brand profile
 *   2. A campaign exists tied to client_drift-mv
 *   3. The campaign has 30 campaign_deliverables rows
 *   4. Count of artifacts already associated with those deliverables
 *   5. Spot-check 2-3 existing artifacts for metadata.localPath presence
 *
 * Project-scoped: uses os-api/.env (which points at tfbfzepaccvklpabllao).
 * Never uses a globally-scoped Supabase MCP.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { supabase } from "../src/supabase.js";

async function main() {
  console.log("=== 1. client_drift-mv ===");
  const { data: client, error: cErr } = await supabase
    .from("clients")
    .select("id, name, status, last_run_status, last_run_at")
    .eq("id", "client_drift-mv")
    .maybeSingle();
  if (cErr) throw cErr;
  if (!client) {
    console.log("✗ client_drift-mv NOT FOUND");
    process.exit(1);
  }
  console.log("✓ id:", client.id);
  console.log("  name:", client.name);
  console.log("  status:", client.status);
  console.log("  last_run_status:", client.last_run_status ?? "(null)");
  console.log("  last_run_at:", client.last_run_at ?? "(null)");

  console.log("\n=== 2. campaign for client_drift-mv ===");
  const { data: campaigns, error: ccErr } = await supabase
    .from("campaigns")
    .select("id, name, status, created_at")
    .eq("client_id", "client_drift-mv")
    .order("created_at", { ascending: false });
  if (ccErr) throw ccErr;
  if (!campaigns || campaigns.length === 0) {
    console.log("✗ NO campaigns for client_drift-mv");
    process.exit(1);
  }
  const campaign = campaigns[0];
  console.log(`✓ ${campaigns.length} campaign(s); using most recent:`);
  console.log("  id:", campaign.id);
  console.log("  name:", campaign.name);
  console.log("  status:", campaign.status);

  console.log("\n=== 3. campaign_deliverables count ===");
  // Schema note: no shot_number column. Deliverables carry `description`,
  // `current_prompt`, `media_type`, `platform`, etc.
  const { data: deliverables, error: dErr } = await supabase
    .from("campaign_deliverables")
    .select("id, description, status, media_type, platform, created_at")
    .eq("campaign_id", campaign.id)
    .order("created_at", { ascending: true });
  if (dErr) throw dErr;
  const total = deliverables?.length ?? 0;
  console.log(`${total === 30 ? "✓" : "⚠"} count: ${total} (brief expected 30 for full Drift MV catalog)`);
  for (const d of deliverables ?? []) {
    console.log(
      `  - ${d.id.slice(0, 8)}… status=${d.status} media=${d.media_type} ` +
      `desc=${String(d.description ?? "(null)").slice(0, 80)}`,
    );
  }

  console.log("\n=== 4. artifacts associated with these deliverables ===");
  // Artifact FK is `deliverable_id` (per migration 005)
  const deliverableIds = (deliverables ?? []).map((d) => d.id);
  const { data: artifacts, error: aErr } = await supabase
    .from("artifacts")
    .select("id, deliverable_id, type, grade, metadata, path, storage_path, created_at")
    .in("deliverable_id", deliverableIds)
    .order("created_at", { ascending: false });
  if (aErr) throw aErr;
  console.log(`  total artifacts: ${artifacts?.length ?? 0}`);

  const byDel = new Map<string, number>();
  for (const a of artifacts ?? []) {
    byDel.set(a.deliverable_id, (byDel.get(a.deliverable_id) ?? 0) + 1);
  }
  console.log(`  deliverables with ≥1 artifact: ${byDel.size} / ${total}`);
  const passCount = (artifacts ?? []).filter(
    (a) => a.grade === "PASS" || (typeof a.grade === "number" && a.grade >= 4.5),
  ).length;
  console.log(`  artifacts graded PASS/≥4.5: ${passCount}`);

  console.log("\n=== 5. spot-check metadata.localPath on recent artifacts ===");
  const recent = (artifacts ?? []).slice(0, 5);
  for (const a of recent) {
    const md = (a.metadata ?? {}) as Record<string, unknown>;
    const localPath = md.localPath as string | undefined;
    const hasLocal = typeof localPath === "string" && localPath.length > 0;
    console.log(
      `  ${hasLocal ? "✓" : "○"} artifact ${a.id.slice(0, 8)}… | ` +
      `type=${a.type} grade=${a.grade} | ` +
      `localPath=${hasLocal ? localPath : "(missing)"} | ` +
      `storage_path=${a.storage_path ?? "(null)"}`,
    );
  }

  // ── Dry-run target (Shot 20) ──────────────────────────────────────────
  console.log("\n=== 6. Dry-run target deliverable ===");
  // Identify Shot 20 heuristically — by description match or by being the
  // only deliverable if only one exists.
  const shot20 =
    (deliverables ?? []).find((d) =>
      /shot\s*20|drift/i.test(String(d.description ?? "")),
    ) ??
    (deliverables && deliverables.length === 1 ? deliverables[0] : undefined);
  if (!shot20) {
    console.log("⚠ Could not auto-identify Shot 20; pick manually from list above.");
  } else {
    console.log("✓ id:            ", shot20.id);
    console.log("  description:   ", shot20.description);
    console.log("  status:        ", shot20.status);
    const shot20Artifacts = (artifacts ?? []).filter((a) => a.deliverable_id === shot20.id);
    console.log(`  artifacts:      ${shot20Artifacts.length}`);
    for (const a of shot20Artifacts) {
      const md = (a.metadata ?? {}) as Record<string, unknown>;
      const localPath = md.localPath as string | undefined;
      console.log(
        `    - ${a.id.slice(0, 8)}… type=${a.type} grade=${a.grade} ` +
        `localPath=${localPath ?? "(missing)"} ` +
        `storage_path=${a.storage_path ?? "(null)"}`,
      );
    }
  }

  console.log("\n=== ✓ DATA SANITY REPORT ===");
  if (total !== 30) {
    console.log(
      `⚠ Only ${total} deliverable(s) seeded in Supabase — brief expected 30. ` +
      `This is a 10d prerequisite: 30-shot reuse-first regression needs the catalog ` +
      `seeded first. Pre-flight dry-run (Phase 4) can still proceed against the ` +
      `existing Shot 20 deliverable. Seeder work is a 10d blocker, not a pre-flight one.`,
    );
  }
  if (shot20) {
    console.log(`Run Phase-4 dry-run on deliverable ${shot20.id}.`);
  }
}

main().catch((err) => {
  console.error("=== DATA SANITY ERROR ===");
  console.error(err);
  process.exit(1);
});
