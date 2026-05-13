/**
 * ADR-006 D4-5 one-shot cleanup for Review Gate zombie escalations.
 *
 * Finds rows that were accepted in the Review Gate but stayed in_progress:
 *   status = 'in_progress'
 *   resolution_notes ILIKE 'Accepted in Review Gate%'
 * plus the live Drift MV legacy variant documented in the 4.D-2 progress log:
 *   status = 'in_progress'
 *   resolution_notes IS NULL
 *   created_at older than the conservative stale-work cutoff
 *
 * Idempotent: each row update is guarded with id + status='in_progress' +
 * the same zombie predicate, so already-resolved rows are not touched.
 *
 * Usage:
 *   PROTO_PAT=$(grep "^SUPABASE_ACCESS_TOKEN=" ~/proto_front/os-api/.env | cut -d= -f2-)
 *   cd ~/proto_front/os-api && tsx scripts/backfill-zombie-escalations.ts
 */
import { backfillZombieReviewGateEscalations } from "../src/db.js";

const EXPECTED_PROJECT_REF = "tfbfzepaccvklpabllao";
const TARGET_CLIENT_ID = process.env.CLIENT_ID ?? "client_drift-mv";

function projectRefFromSupabaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const host = new URL(value).host;
    const [projectRef] = host.split(".");
    return projectRef || null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const projectRef = projectRefFromSupabaseUrl(process.env.SUPABASE_URL);
  if (projectRef !== EXPECTED_PROJECT_REF) {
    throw new Error(
      `Refusing to run zombie backfill against ${projectRef ?? "unknown project"}; expected ${EXPECTED_PROJECT_REF}`,
    );
  }

  console.log(`[zombie-backfill] target project: ${projectRef}`);
  console.log(`[zombie-backfill] target client: ${TARGET_CLIENT_ID}`);
  const result = await backfillZombieReviewGateEscalations({ clientId: TARGET_CLIENT_ID });
  console.log(`[zombie-backfill] ${result.found} zombies found / ${result.resolved} resolved`);
  console.log(
    `[zombie-backfill] reasons: ${result.reasonCounts.accepted_notes} accepted-note, ` +
      `${result.reasonCounts.legacy_null_notes} legacy-null-note`,
  );

  if (result.skippedIds.length > 0) {
    console.log(`[zombie-backfill] ${result.skippedIds.length} skipped by idempotency guard`);
    for (const id of result.skippedIds) console.log(`  skipped ${id}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
