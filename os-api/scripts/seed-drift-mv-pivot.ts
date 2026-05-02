/**
 * Seed Drift MV visual-pivot prompts from Jackie's audit into manifest.json
 * and Supabase campaign_deliverables.
 *
 * Source: ~/Temp-gen/productions/drift-mv/jackie_audit_2026-04-25.md
 *   - Tier A: 10 full rewrites for shots #2,#5,#6,#8,#10,#11,#15,#25,#26,#27
 *     (visual + still_prompt + veo_prompt + negative_prompts[])
 *   - Tier B: 1 visual-intent-only block for shot #1 (manual asset already installed)
 *
 * Targets:
 *   - manifest.json shot blocks: visual + still_prompt + veo_prompt (atomic write w/ backup)
 *   - campaign_deliverables (10 Tier A): description + current_prompt + original_prompt
 *     + negative_prompts + ai_model='veo-3.1-generate-001' (Lite→Standard) + status='pending'
 *   - campaign_deliverables defensive lock: shot #1 + 19 KEEPs → status='approved' (idempotent)
 *
 * Modes:
 *   DRY=1    — preview (default)
 *   APPLY=1  — commit writes
 *
 * Usage:
 *   (set -a; . os-api/.env; set +a; npx tsx os-api/scripts/seed-drift-mv-pivot.ts \
 *     --campaign-id <campaign-uuid> \
 *     --prod-dir ~/Temp-gen/productions/drift-mv)
 *   APPLY=1 (set -a; . os-api/.env; set +a; npx tsx os-api/scripts/seed-drift-mv-pivot.ts \
 *     --campaign-id <campaign-uuid> \
 *     --prod-dir ~/Temp-gen/productions/drift-mv)
 *
 * Plan: ~/.claude/plans/what-are-the-options-foamy-abelson.md (Option 2)
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { supabase } from "../src/supabase.js";

type SeedConfig = {
  campaignId: string;
  prodDir: string;
  manifestPath: string;
  manifestBackupPath: string;
  auditPath: string;
};

const TIER_A_SHOTS = [2, 5, 6, 8, 10, 11, 15, 25, 26, 27] as const;
const TIER_B_SHOTS = [1] as const;
const ALL_REGEN_SHOTS = new Set<number>([...TIER_A_SHOTS, ...TIER_B_SHOTS]);
const KEEP_SHOTS = Array.from({ length: 30 }, (_, i) => i + 1).filter(
  (n) => !ALL_REGEN_SHOTS.has(n),
);

const APPLY = process.env.APPLY === "1";
const DRY = !APPLY;

export type ParsedShot = {
  shotNumber: number;
  tier: "A" | "B";
  newVisual: string;
  stillPrompt?: string;
  veoPrompt?: string;
  negativeAntiPatterns?: string[];
};

function usage(): string {
  return [
    "Usage: npx tsx os-api/scripts/seed-drift-mv-pivot.ts --campaign-id <uuid> --prod-dir <production-dir> [--audit-path <path>]",
    "",
    "Required inputs can also be supplied via SEED_CAMPAIGN_ID and SEED_PROD_DIR.",
    "Optional: SEED_AUDIT_PATH (defaults to <prod-dir>/jackie_audit_2026-04-25.md).",
  ].join("\n");
}

function cliValue(argv: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const direct = argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  return undefined;
}

function expandHome(input: string): string {
  if (input === "~") return process.env.HOME ?? input;
  if (input.startsWith("~/")) return path.join(process.env.HOME ?? "", input.slice(2));
  return input;
}

export function parseSeedConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): SeedConfig {
  if (argv.includes("--help") || argv.includes("-h")) {
    throw new Error(usage());
  }
  const campaignId = cliValue(argv, "--campaign-id") ?? env.SEED_CAMPAIGN_ID;
  const prodDirRaw = cliValue(argv, "--prod-dir") ?? env.SEED_PROD_DIR;
  if (!campaignId?.trim()) {
    throw new Error(`Missing campaign id.\n${usage()}`);
  }
  if (!prodDirRaw?.trim()) {
    throw new Error(`Missing production directory.\n${usage()}`);
  }

  const prodDir = path.resolve(expandHome(prodDirRaw.trim()));
  const auditPath = path.resolve(
    expandHome(
      cliValue(argv, "--audit-path")
        ?? env.SEED_AUDIT_PATH
        ?? path.join(prodDir, "jackie_audit_2026-04-25.md"),
    ),
  );
  const manifestPath = path.join(prodDir, "manifest.json");
  return {
    campaignId: campaignId.trim(),
    prodDir,
    manifestPath,
    manifestBackupPath: path.join(prodDir, "manifest_pre_seed_backup.json"),
    auditPath,
  };
}

// ─── Parser ────────────────────────────────────────────────────────────────

function parseAudit(audit: string): Map<number, ParsedShot> {
  const result = new Map<number, ParsedShot>();
  // Split on shot headers; first chunk is the executive summary, skip it.
  const blocks = audit.split(/^## Shot (\d+)\s/gm);
  // blocks: [intro, "1", body1, "2", body2, ...]
  for (let i = 1; i < blocks.length; i += 2) {
    const shotNumber = parseInt(blocks[i], 10);
    const body = blocks[i + 1];
    if (!body) continue;

    const newVisualMatch = body.match(
      /### NEW VISUAL INTENT[^\n]*\n+([\s\S]*?)(?=\n###|\n## |$)/,
    );
    const stillPromptMatch = body.match(
      /### CONCRETE Nano Banana Pro still prompt[^\n]*\n+([\s\S]*?)(?=\n###|\n## |$)/,
    );
    const finalVeoMatch = body.match(
      /### FINAL VEO PROMPT[^\n]*\n+([\s\S]*?)(?=\n###|\n## |$)/,
    );
    const negativeMatch = body.match(
      /### Negative anti-patterns[^\n]*\n+([\s\S]*?)(?=\n###|\n## |$)/,
    );

    if (!newVisualMatch) continue;
    const newVisual = newVisualMatch[1].trim();
    const isTierA = !!finalVeoMatch && !!stillPromptMatch;

    const parsed: ParsedShot = {
      shotNumber,
      tier: isTierA ? "A" : "B",
      newVisual,
    };
    if (isTierA) {
      parsed.stillPrompt = stillPromptMatch[1].trim();
      parsed.veoPrompt = finalVeoMatch[1].trim();
      parsed.negativeAntiPatterns = (negativeMatch?.[1] ?? "")
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    result.set(shotNumber, parsed);
  }
  return result;
}

export function assertExpectedTiers(parsed: Map<number, ParsedShot>): void {
  for (const shotNum of TIER_A_SHOTS) {
    const p = parsed.get(shotNum);
    if (!p) {
      throw new Error(`Audit missing required shot #${shotNum}`);
    }
    if (p.tier !== "A") {
      throw new Error(`Audit shot #${shotNum} parsed as tier ${p.tier} but expected A`);
    }
  }
  for (const shotNum of TIER_B_SHOTS) {
    const p = parsed.get(shotNum);
    if (!p) {
      throw new Error(`Audit missing required shot #${shotNum}`);
    }
    if (p.tier !== "B") {
      throw new Error(`Audit shot #${shotNum} parsed as tier ${p.tier} but expected B`);
    }
  }
}

// ─── Manifest update ───────────────────────────────────────────────────────

function readManifest(config: SeedConfig): any {
  return JSON.parse(fs.readFileSync(config.manifestPath, "utf-8"));
}

function writeManifestAtomically(config: SeedConfig, manifest: any): void {
  // Backup first (only if backup not already present from prior run)
  if (!fs.existsSync(config.manifestBackupPath)) {
    fs.copyFileSync(config.manifestPath, config.manifestBackupPath);
    console.log(`  ✓ wrote manifest backup → ${path.basename(config.manifestBackupPath)}`);
  }
  // Atomic write: write to .tmp, then rename
  const tmpPath = config.manifestPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmpPath, config.manifestPath);
}

// ─── Supabase mapping ──────────────────────────────────────────────────────

export type DeliverableRow = {
  id: string;
  campaign_id: string;
  description: string | null;
  current_prompt: string | null;
  ai_model: string | null;
  status: string;
  reference_images: string[] | null;
  negative_prompts: string[] | null;
};

function shotNumberFromDeliverable(row: DeliverableRow): number | null {
  for (const ref of row.reference_images ?? []) {
    const m = /shot_(\d+)\.(?:png|jpe?g|webp)$/i.exec(ref);
    if (m) return parseInt(m[1], 10);
  }
  if (typeof row.description === "string") {
    // Fallback: parse "Shot NN ·" prefix from description
    const m = row.description.match(/^Shot\s+(\d+)/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

export function mapDeliverablesByShot(rows: DeliverableRow[]): Map<number, DeliverableRow> {
  const map = new Map<number, DeliverableRow>();
  for (const row of rows) {
    const shotNum = shotNumberFromDeliverable(row);
    if (shotNum === null) continue;
    const existing = map.get(shotNum);
    if (existing) {
      throw new Error(
        `Duplicate deliverables mapped to shot #${shotNum}: ${existing.id} and ${row.id}`,
      );
    }
    map.set(shotNum, row);
  }
  return map;
}

async function loadDeliverableMap(campaignId: string): Promise<Map<number, DeliverableRow>> {
  const { data, error } = await supabase
    .from("campaign_deliverables")
    .select(
      "id, campaign_id, description, current_prompt, ai_model, status, reference_images, negative_prompts",
    )
    .eq("campaign_id", campaignId);
  if (error) throw new Error(`load deliverables failed: ${error.message}`);

  return mapDeliverablesByShot((data ?? []) as DeliverableRow[]);
}

// ─── Main ──────────────────────────────────────────────────────────────────

function truncate(s: string, n = 80): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

async function main(): Promise<void> {
  const config = parseSeedConfig();
  console.log(`=== seed-drift-mv-pivot — ${DRY ? "DRY" : "APPLY"} mode ===`);
  console.log(`  Campaign: ${config.campaignId}`);
  console.log(`  Manifest: ${config.manifestPath}`);
  console.log(`  Audit:    ${config.auditPath}`);
  console.log(`  Tier A: ${TIER_A_SHOTS.join(", ")} (10 shots)`);
  console.log(`  Tier B: ${TIER_B_SHOTS.join(", ")} (1 shot, manual asset)`);
  console.log(`  KEEP: ${KEEP_SHOTS.length} shots (defensive-lock to 'approved')`);
  console.log("");

  // 1. Parse Jackie's audit
  const auditText = fs.readFileSync(config.auditPath, "utf-8");
  const parsed = parseAudit(auditText);
  assertExpectedTiers(parsed);
  console.log(`Parsed ${parsed.size} shot block(s) from Jackie's audit`);
  for (const shotNum of [...TIER_A_SHOTS, ...TIER_B_SHOTS].sort((a, b) => a - b)) {
    const p = parsed.get(shotNum)!;
    const status =
      p.tier === "A"
        ? `Tier A · visual+still+veo+${p.negativeAntiPatterns?.length ?? 0}neg`
        : `Tier B · visual-only`;
    console.log(`  shot #${String(shotNum).padStart(2)} · ${status}`);
  }
  console.log("");

  // 2. Load Supabase deliverables
  const deliverables = await loadDeliverableMap(config.campaignId);
  console.log(`Loaded ${deliverables.size} deliverables from Supabase`);
  for (const shotNum of TIER_A_SHOTS) {
    const d = deliverables.get(shotNum);
    if (!d) throw new Error(`Supabase missing deliverable for shot #${shotNum}`);
  }
  console.log("");

  // 3. Manifest updates (Tier A — full overwrites; Tier B — visual-only)
  const manifest = readManifest(config);
  let manifestChanges = 0;

  for (const shotNum of [...TIER_A_SHOTS, ...TIER_B_SHOTS].sort((a, b) => a - b)) {
    const p = parsed.get(shotNum);
    if (!p) continue;
    const shot = manifest.shots.find((s: any) => s.id === shotNum);
    if (!shot) {
      throw new Error(`manifest.shots missing id=${shotNum}`);
    }

    const beforeVisual = shot.visual ?? "";
    const beforeStill = shot.still_prompt ?? "";
    const beforeVeo = shot.veo_prompt ?? "";

    let touched = false;
    if (beforeVisual !== p.newVisual) {
      shot.visual = p.newVisual;
      touched = true;
    }
    if (p.tier === "A") {
      if (beforeStill !== p.stillPrompt) {
        shot.still_prompt = p.stillPrompt;
        touched = true;
      }
      if (beforeVeo !== p.veoPrompt) {
        shot.veo_prompt = p.veoPrompt;
        touched = true;
      }
    }

    if (touched) {
      manifestChanges++;
      console.log(`MANIFEST shot #${shotNum} (${p.tier}) — ${touched ? "WILL UPDATE" : "no-op"}`);
      console.log(`  visual:  ${truncate(beforeVisual)}`);
      console.log(`        →  ${truncate(p.newVisual)}`);
      if (p.tier === "A") {
        console.log(`  still:   ${truncate(beforeStill)}`);
        console.log(`        →  ${truncate(p.stillPrompt!)}`);
        console.log(`  veo:     ${truncate(beforeVeo)}`);
        console.log(`        →  ${truncate(p.veoPrompt!)}`);
      }
      console.log("");
    }
  }

  // 4. Supabase Tier A updates
  let supabaseTouched = 0;
  for (const shotNum of TIER_A_SHOTS) {
    const p = parsed.get(shotNum);
    const d = deliverables.get(shotNum);
    if (!p || !d || p.tier !== "A") continue;

    const updates: Record<string, unknown> = {};
    if (d.description !== p.newVisual) updates.description = p.newVisual;
    if (d.current_prompt !== p.veoPrompt) {
      updates.current_prompt = p.veoPrompt;
      // Also align original_prompt so any orchestrator-driven fallback that
      // uses original_prompt gets the new aesthetic, not the legacy mech-fight one.
      updates.original_prompt = p.veoPrompt;
    }
    const newNegatives = p.negativeAntiPatterns ?? [];
    const oldNegatives = d.negative_prompts ?? [];
    if (
      newNegatives.length !== oldNegatives.length ||
      newNegatives.some((v, i) => oldNegatives[i] !== v)
    ) {
      updates.negative_prompts = newNegatives;
    }
    if (d.ai_model !== "veo-3.1-generate-001") {
      updates.ai_model = "veo-3.1-generate-001";
    }
    if (d.status !== "pending") {
      updates.status = "pending";
    }

    if (Object.keys(updates).length === 0) continue;
    supabaseTouched++;

    console.log(
      `SUPABASE shot #${shotNum} | ${d.id.slice(0, 8)} | status:${d.status}→${updates.status ?? d.status} | model:${d.ai_model}→${updates.ai_model ?? d.ai_model}`,
    );
    if (updates.description) {
      console.log(`  description: ${truncate(d.description ?? "")}`);
      console.log(`           →   ${truncate(updates.description as string)}`);
    }
    if (updates.current_prompt) {
      console.log(`  current_prompt: ${truncate(d.current_prompt ?? "")}`);
      console.log(`              →   ${truncate(updates.current_prompt as string)}`);
    }
    if (updates.negative_prompts) {
      console.log(
        `  negative_prompts: [${oldNegatives.length}] → [${newNegatives.length}]`,
      );
    }

    if (APPLY) {
      const { error } = await supabase
        .from("campaign_deliverables")
        .update(updates)
        .eq("id", d.id);
      if (error) {
        throw new Error(`update ${d.id} failed: ${error.message}`);
      }
      console.log(`  ✓ APPLIED`);
    }
    console.log("");
  }

  // 5. Defensive lock — shot #1 + 19 KEEPs to 'approved' (idempotent).
  console.log(`Defensive lock — ${[...TIER_B_SHOTS, ...KEEP_SHOTS].length} shots → status='approved'`);
  let defensiveLocked = 0;
  for (const shotNum of [...TIER_B_SHOTS, ...KEEP_SHOTS]) {
    const d = deliverables.get(shotNum);
    if (!d) {
      console.log(`  ! shot #${shotNum} — no Supabase row found (skipping)`);
      continue;
    }
    if (d.status === "approved") continue;
    defensiveLocked++;
    console.log(`  shot #${shotNum} | ${d.id.slice(0, 8)} | ${d.status}→approved`);
    if (APPLY) {
      const { error } = await supabase
        .from("campaign_deliverables")
        .update({ status: "approved" })
        .eq("id", d.id);
      if (error) {
        throw new Error(`defensive-lock ${d.id} failed: ${error.message}`);
      }
    }
  }
  console.log("");

  // 6. Manifest write (last so any earlier Supabase error doesn't leave manifest divergent)
  if (manifestChanges > 0 && APPLY) {
    writeManifestAtomically(config, manifest);
    console.log(`✓ MANIFEST written (${manifestChanges} shot(s) updated)`);
  } else if (manifestChanges > 0) {
    console.log(`[DRY] would write manifest (${manifestChanges} shot(s))`);
  } else {
    console.log(`MANIFEST: no changes`);
  }

  console.log("");
  console.log(`=== summary ===`);
  console.log(`  Manifest shots updated: ${manifestChanges}`);
  console.log(`  Supabase Tier A updates: ${supabaseTouched}`);
  console.log(`  Supabase defensive locks: ${defensiveLocked}`);
  console.log(`  Mode: ${DRY ? "DRY (no writes)" : "APPLY (writes committed)"}`);
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  main().catch((err) => {
    console.error("FATAL:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
