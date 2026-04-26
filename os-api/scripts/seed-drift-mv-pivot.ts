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
 *   (set -a; . os-api/.env; set +a; npx tsx os-api/scripts/seed-drift-mv-pivot.ts)
 *   APPLY=1 (set -a; . os-api/.env; set +a; npx tsx os-api/scripts/seed-drift-mv-pivot.ts)
 *
 * Plan: ~/.claude/plans/what-are-the-options-foamy-abelson.md (Option 2)
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { supabase } from "../src/supabase.js";

const CAMPAIGN_ID = "42f62a1d-b9df-57d8-8197-470692733391";
const PROD_DIR = "/Users/timothysepulvado/Temp-gen/productions/drift-mv";
const MANIFEST_PATH = path.join(PROD_DIR, "manifest.json");
const MANIFEST_BACKUP = path.join(PROD_DIR, "manifest_pre_seed_backup.json");
const AUDIT_PATH = path.join(PROD_DIR, "jackie_audit_2026-04-25.md");

const TIER_A_SHOTS = [2, 5, 6, 8, 10, 11, 15, 25, 26, 27] as const;
const TIER_B_SHOTS = [1] as const;
const ALL_REGEN_SHOTS = new Set<number>([...TIER_A_SHOTS, ...TIER_B_SHOTS]);
const KEEP_SHOTS = Array.from({ length: 30 }, (_, i) => i + 1).filter(
  (n) => !ALL_REGEN_SHOTS.has(n),
);

const APPLY = process.env.APPLY === "1";
const DRY = !APPLY;

type ParsedShot = {
  shotNumber: number;
  tier: "A" | "B";
  newVisual: string;
  stillPrompt?: string;
  veoPrompt?: string;
  negativeAntiPatterns?: string[];
};

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

// ─── Manifest update ───────────────────────────────────────────────────────

function readManifest(): any {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
}

function writeManifestAtomically(manifest: any): void {
  // Backup first (only if backup not already present from prior run)
  if (!fs.existsSync(MANIFEST_BACKUP)) {
    fs.copyFileSync(MANIFEST_PATH, MANIFEST_BACKUP);
    console.log(`  ✓ wrote manifest backup → ${path.basename(MANIFEST_BACKUP)}`);
  }
  // Atomic write: write to .tmp, then rename
  const tmpPath = MANIFEST_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmpPath, MANIFEST_PATH);
}

// ─── Supabase mapping ──────────────────────────────────────────────────────

type DeliverableRow = {
  id: string;
  campaign_id: string;
  description: string | null;
  current_prompt: string | null;
  ai_model: string | null;
  status: string;
  reference_images: string[] | null;
  negative_prompts: string[] | null;
};

async function loadDeliverableMap(): Promise<Map<number, DeliverableRow>> {
  const { data, error } = await supabase
    .from("campaign_deliverables")
    .select(
      "id, campaign_id, description, current_prompt, ai_model, status, reference_images, negative_prompts",
    )
    .eq("campaign_id", CAMPAIGN_ID);
  if (error) throw new Error(`load deliverables failed: ${error.message}`);

  const map = new Map<number, DeliverableRow>();
  for (const row of (data ?? []) as DeliverableRow[]) {
    // Map shot number from reference_images path (e.g. ".../stills/shot_02.png")
    let shotNum: number | null = null;
    for (const ref of row.reference_images ?? []) {
      const m = ref.match(/shot_(\d+)\.png/);
      if (m) {
        shotNum = parseInt(m[1], 10);
        break;
      }
    }
    if (shotNum === null && typeof row.description === "string") {
      // Fallback: parse "Shot NN ·" prefix from description
      const m = row.description.match(/^Shot\s+(\d+)/i);
      if (m) shotNum = parseInt(m[1], 10);
    }
    if (shotNum !== null && !map.has(shotNum)) {
      map.set(shotNum, row);
    }
  }
  return map;
}

// ─── Main ──────────────────────────────────────────────────────────────────

function truncate(s: string, n = 80): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

async function main(): Promise<void> {
  console.log(`=== seed-drift-mv-pivot — ${DRY ? "DRY" : "APPLY"} mode ===`);
  console.log(`  Campaign: ${CAMPAIGN_ID}`);
  console.log(`  Manifest: ${MANIFEST_PATH}`);
  console.log(`  Audit:    ${AUDIT_PATH}`);
  console.log(`  Tier A: ${TIER_A_SHOTS.join(", ")} (10 shots)`);
  console.log(`  Tier B: ${TIER_B_SHOTS.join(", ")} (1 shot, manual asset)`);
  console.log(`  KEEP: ${KEEP_SHOTS.length} shots (defensive-lock to 'approved')`);
  console.log("");

  // 1. Parse Jackie's audit
  const auditText = fs.readFileSync(AUDIT_PATH, "utf-8");
  const parsed = parseAudit(auditText);
  console.log(`Parsed ${parsed.size} shot block(s) from Jackie's audit`);
  for (const shotNum of [...TIER_A_SHOTS, ...TIER_B_SHOTS].sort((a, b) => a - b)) {
    const p = parsed.get(shotNum);
    if (!p) {
      throw new Error(`Audit missing required shot #${shotNum}`);
    }
    const status =
      p.tier === "A"
        ? `Tier A · visual+still+veo+${p.negativeAntiPatterns?.length ?? 0}neg`
        : `Tier B · visual-only`;
    console.log(`  shot #${String(shotNum).padStart(2)} · ${status}`);
  }
  console.log("");

  // 2. Load Supabase deliverables
  const deliverables = await loadDeliverableMap();
  console.log(`Loaded ${deliverables.size} deliverables from Supabase`);
  for (const shotNum of TIER_A_SHOTS) {
    const d = deliverables.get(shotNum);
    if (!d) throw new Error(`Supabase missing deliverable for shot #${shotNum}`);
  }
  console.log("");

  // 3. Manifest updates (Tier A — full overwrites; Tier B — visual-only)
  const manifest = readManifest();
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
    writeManifestAtomically(manifest);
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

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
