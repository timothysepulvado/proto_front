/**
 * Unit test for per-production budget cap (post-Chunk-3, 2026-04-23).
 *
 * Plan: `~/.claude/plans/fresh-context-today-is-glowing-harp.md` follow-up.
 * Code: `os-api/src/runner.ts::_extractProductionBudget` +
 *       `os-api/src/db.ts::getRunCostEstimate` (helpers).
 *
 * Pure in-memory tests for the threshold extraction shape + defaults.
 * The cost-estimate helper hits Supabase, so it's exercised via integration
 * during live verification (not here).
 *
 * Usage:
 *   (set -a; . os-api/.env; set +a; npx tsx os-api/tests/_10d-production-budget.ts)
 */
import assert from "node:assert/strict";

import { _extractProductionBudget } from "../src/runner.js";
import { VEO_COST_PER_SECOND_BY_MODEL } from "../src/db.js";
import type { Campaign, ProductionBudget } from "../src/types.js";

function makeCampaign(guardrails: Record<string, unknown> | undefined): Campaign {
  return {
    id: "camp-X",
    clientId: "client-X",
    name: "Test Campaign",
    maxRetries: 3,
    guardrails,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

type Check = { name: string; run: () => void | Promise<void> };
const checks: Check[] = [];
function check(name: string, run: () => void | Promise<void>): void {
  checks.push({ name, run });
}

// ─── _extractProductionBudget shape validation ───────────────────────────

check("extractProductionBudget: valid shape round-trips", () => {
  const b = _extractProductionBudget(
    makeCampaign({
      production_budget: {
        total_usd: 25,
        warn_at_pct: 60,
        hard_stop_at_pct: 100,
      },
    }),
  );
  assert.deepEqual(b, {
    total_usd: 25,
    warn_at_pct: 60,
    hard_stop_at_pct: 100,
  });
});

check("extractProductionBudget: defaults applied when only total_usd set", () => {
  const b = _extractProductionBudget(
    makeCampaign({ production_budget: { total_usd: 50 } }),
  );
  assert.deepEqual(b, {
    total_usd: 50,
    warn_at_pct: 75,
    hard_stop_at_pct: 100,
  });
});

check("extractProductionBudget: null campaign → undefined", () => {
  assert.equal(_extractProductionBudget(null), undefined);
});

check("extractProductionBudget: missing guardrails → undefined", () => {
  assert.equal(_extractProductionBudget(makeCampaign(undefined)), undefined);
});

check("extractProductionBudget: missing production_budget → undefined", () => {
  assert.equal(
    _extractProductionBudget(makeCampaign({ qa_threshold: { pass_threshold: 3 } })),
    undefined,
  );
});

check("extractProductionBudget: malformed total (string) → undefined", () => {
  const b = _extractProductionBudget(
    makeCampaign({ production_budget: { total_usd: "25" } }),
  );
  assert.equal(b, undefined);
});

check("extractProductionBudget: total <= 0 → undefined", () => {
  assert.equal(
    _extractProductionBudget(
      makeCampaign({ production_budget: { total_usd: 0 } }),
    ),
    undefined,
  );
  assert.equal(
    _extractProductionBudget(
      makeCampaign({ production_budget: { total_usd: -10 } }),
    ),
    undefined,
  );
});

check("extractProductionBudget: total non-finite → undefined", () => {
  assert.equal(
    _extractProductionBudget(
      makeCampaign({ production_budget: { total_usd: Number.NaN } }),
    ),
    undefined,
  );
});

check("extractProductionBudget: out-of-range warn_at_pct falls back to default", () => {
  const b = _extractProductionBudget(
    makeCampaign({
      production_budget: { total_usd: 25, warn_at_pct: 150 },
    }),
  );
  assert.equal(b?.warn_at_pct, 75, "warn>100 should fall back to default 75");

  const b2 = _extractProductionBudget(
    makeCampaign({
      production_budget: { total_usd: 25, warn_at_pct: -10 },
    }),
  );
  assert.equal(b2?.warn_at_pct, 75, "negative warn should fall back to default 75");
});

check("extractProductionBudget: out-of-range hard_stop falls back to default", () => {
  const b = _extractProductionBudget(
    makeCampaign({
      production_budget: { total_usd: 25, hard_stop_at_pct: 250 },
    }),
  );
  assert.equal(b?.hard_stop_at_pct, 100, "hard_stop>200 should fall back to 100");
});

check("extractProductionBudget: hard_stop > 100 allowed (200% safety overshoot)", () => {
  // Operators may set a soft warn at 100% and a hard stop at 150% to give
  // some grace before truly halting. Allow 0-200%.
  const b = _extractProductionBudget(
    makeCampaign({
      production_budget: { total_usd: 25, warn_at_pct: 80, hard_stop_at_pct: 150 },
    }),
  );
  assert.equal(b?.hard_stop_at_pct, 150);
});

// ─── VEO_COST_PER_SECOND_BY_MODEL sanity ─────────────────────────────────

check("VEO_COST_PER_SECOND_BY_MODEL has both standard + fast", () => {
  assert.ok(VEO_COST_PER_SECOND_BY_MODEL["veo-3.1-generate-001"] > 0);
  assert.ok(VEO_COST_PER_SECOND_BY_MODEL["veo-3.1-fast-generate-preview"] > 0);
});

check("Veo Fast costs less than standard (the whole point of switching)", () => {
  assert.ok(
    VEO_COST_PER_SECOND_BY_MODEL["veo-3.1-fast-generate-preview"] <
      VEO_COST_PER_SECOND_BY_MODEL["veo-3.1-generate-001"],
    "Fast should be cheaper than standard",
  );
});

// ─── Reporting ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let pass = 0;
  let fail = 0;
  const failures: { name: string; err: unknown }[] = [];
  for (const c of checks) {
    try {
      await c.run();
      console.log(`  ✓ ${c.name}`);
      pass += 1;
    } catch (err) {
      console.error(`  ✗ ${c.name}`);
      failures.push({ name: c.name, err });
      fail += 1;
    }
  }
  console.log("");
  console.log(`  ${pass}/${pass + fail} passed`);
  if (fail > 0) {
    console.error("");
    for (const f of failures) {
      console.error(`  FAIL: ${f.name}`);
      console.error(
        `    ${f.err instanceof Error ? f.err.stack : String(f.err)}`,
      );
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

// Avoid type-only-import lint when Campaign is referenced via fixtures.
const _typeAnchor: ProductionBudget = { total_usd: 1 };
void _typeAnchor;
