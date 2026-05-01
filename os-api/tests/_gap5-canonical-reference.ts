/**
 * Gap 5 unit tests — manifest canonical_reference_still normalization.
 *
 * Usage:
 *   (set -a; . os-api/.env; set +a; npx tsx os-api/tests/_gap5-canonical-reference.ts)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  getCanonicalReferencesForManifest,
  getShotCanonicalReferences,
} from "../src/productions.js";

const tempGenDir = process.env.TEMP_GEN_DIR ?? join(process.env.HOME ?? "", "Temp-gen");
const manifestPath = join(tempGenDir, "productions", "drift-mv", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { characters?: unknown };

const references = getCanonicalReferencesForManifest("drift-mv", manifest);
const openAiMech = references.get("mech_openai");

assert.ok(openAiMech, "mech_openai canonical reference is present");
assert.equal(openAiMech.stillPath, "stills/shot_07.png");
assert.equal(openAiMech.lockedAt, "2026-04-30");
assert.equal(openAiMech.lockedBy, "Tim direction");
assert.match(openAiMech.rationale ?? "", /visual ground-truth/i);
assert.equal(openAiMech.exists, true, "canonical reference still exists on disk");
assert.equal(openAiMech.thumb, "/api/productions/drift-mv/canonical-reference/mech_openai");

assert.equal(references.has("mech_claude"), false, "characters without canonical_reference_still are omitted");

const shotReferences = getShotCanonicalReferences(
  ["mech_openai", "mech_openai", "brandy", "mech_claude"],
  references,
);
assert.equal(shotReferences.length, 1, "shot references dedupe and include only canonical characters");
assert.equal(shotReferences[0]?.characterName, "mech_openai");

console.log("✓ Gap 5 canonical-reference helper tests passed");
