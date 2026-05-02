# Runbook — `mode: "stills"` (Production Operator Guide)

> **Status:** LIVE end-to-end. Phase A endpoint, Phase B audit + in-loop runners, Phase B+ #1-#8 (X-Trace-Id passthrough + /health timeout 5→30s + shotIds targeted-regen + Rule 7 prompt budget + auto-seed + loop closure + localPath read + HITL bubble) all SHIPPED. Direction-fix CLOSED 2026-04-30 (5/5 drifted shots locked; operator-override pattern productized). HUD operator-side UX pass 8/8 SHIPPED 2026-05-01 on `feat/step-11-phase-4` (`d4c7ddb` Review Gate escalation surface, `5d56a52` audit-triage staleness banner, `8037366` operator override pill, `51bec11` Recent Runs panel, `23aa631` canonical-ref badges, `e98f111` motion-phase gate, `62e663f` direction-drift indicators, `3a13380` regen iterations browser). **Operators should drive from the HUD now; curl flows below are fallback.** Phase F observability + Phase G runbook expansion + Phase H multi-campaign RLS still queued.
> **Owner:** Brandy
> **Last revised:** 2026-05-01 (HUD UX pass 8/8 SHIPPED — operator-side surfaces are LIVE)
> **Implemented by:** Phase B `ef18a76` + `4c713b2` + Phase B+ commits on `feat/step-11-phase-4`; HUD UX commits `d4c7ddb` → `3a13380` on `feat/step-11-phase-4`
> **Live-validated by:** audit run `389ae296-390c-4333-b289-831d6c0252f5` (Phase B audit smoke #1 — 15/15 baseline match) + drift-mv closing run `01ead7d8-...` (5 shots: 2 SHIP / 1 ACCEPT / 2 HITL → operator override, 2026-04-30) + 28 Playwright screenshots (HUD UX pass 2026-04-30 → 2026-05-01)

## Audit smoke #1 result (2026-04-29 PM)

- **15/15 (100%) recommendation match** vs manual `STILLS_AUDIT_15_SHOTS.md` baseline
- 30/30 shots graded, 0 errors, ~14 min wall-clock at concurrency 8
- Score drift +0.07-0.67 on baseline shots → known degraded-mode artifact (catalog auth — see "Phase B+ env refresh" below)
- Two real fresh catches the manual flow couldn't score: #22 `literal_split_screen` (NEW failure class), #26 multi-failure stack
- audit_report blob shape (canonical): `{runId, traceId, productionSlug, completedAt, summary: {keep, l1, l2, l3, errors, totalCost}, shots: [{shotId, imagePath, verdict, aggregateScore, recommendation, detectedFailureClasses[], cost, latencyMs, errorMessage}]}`

This runbook is the operator's first stop for any production stills work. It covers when to fire each mode, how to read the output, when to override the critic, how to handle escalations, and how to roll back if something breaks. **You should be able to recover from a bad release using only this document.**

---

## What `mode: "stills"` is

Production runner path that grades + iterates a campaign's still images using the two-voices critic-in-loop pattern. Two sub-modes:

- **`auditMode: true`** — fires parallel critics on the full still set, returns a triage table (KEEP_AS_IS / L1_PROMPT_FIX / L2_APPROACH_CHANGE / L3_REDESIGN per shot). Does NOT regenerate. Use this to decide what needs work before burning compute on regen.
- **`auditMode: false`** (in-loop) — per-shot iteration loop: critic → orchestrator → critic.validate → regenerate → critic. Iterates until SHIP verdict, degenerate-loop guard fires, or cost cap hits. Use this AFTER audit identifies which shots need pivot.

Productized from the manual orchestration that shipped the Drift MV inaugural campaign (30/30 stills, 2026-04-25 → 2026-04-29). See ADR-004 for the architecture decision.

---

## Quick start — operator workflows

### Phase B: fire from HUD (preferred) or curl (fallback)

**Preferred (HUD, 2026-05-01+):** Operators fire stills runs from the Drift MV campaign workspace via the existing run-controls. Audit triage table reads `runs.metadata.audit_report` and renders inline in `<AuditTriageTable>`. The Gap 2 staleness banner (`5d56a52`) surfaces "N in-loop runs since this audit · triage may be stale — fire a fresh audit to refresh" when in-loop runs land after the latest audit. Recent runs are visible in `<RecentRunsPanel>` (Gap 4 `51bec11`) and click-through to `<RunDetailDrawer>` for logs + orchestration cost + artifacts.

**Fallback (curl):** When the HUD is down or you're scripting, hit the os-api endpoint directly. Same payload contract as the HUD path.

**One-time per environment** — enable the feature flag:

```bash
# In ~/proto_front/os-api/.env
STILLS_MODE_ENABLED=true
# Optional tuning (defaults shown):
STILLS_AUDIT_CONCURRENCY=8         # parallel critics in flight
STILLS_PER_SHOT_COST_CAP_USD=1.0   # USD; HITL escalation when exceeded
```

Restart os-api after editing `.env`.

**Start the sidecars** (separate terminals):

```bash
cd ~/proto_front/brand-engine && python -m brand_engine.api.server   # :8100
cd ~/Temp-gen && python -m brand_engine.api.server                                # :8200
cd ~/proto_front && npm run dev:api                                  # :3001
```

Confirm both are reachable:

```bash
curl -s http://localhost:8100/health && echo
curl -s http://localhost:8200/health && echo
```

### Audit-mode run (most common Phase B use case)

You're about to fire Veo motion phase on a campaign. Want to know if any starting frames are below quality bar before burning $0.50-1.60 per Veo iteration.

```bash
curl -X POST http://localhost:3001/api/clients/client_drift-mv/runs \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "stills",
    "campaignId": "<drift-mv-campaign-id>",
    "auditMode": true
  }'
```

The route validates: `auditMode` must be boolean; `auditMode: true` requires `campaignId`. Returns the new `Run` row with `metadata.audit_mode: true`.

**Watch progress:**
- HUD's existing `WatcherSignalsPanel` realtime stream surfaces `[audit_verdict shot=N path=… verdict=PASS score=4.46 recommendation=ship cost=0.10 …]` log lines as critics return.
- Aggregate summary log line at run close: `[audit] complete: 14 KEEP / 1 L1 / 0 L2 / 0 L3 / 0 errors. Total cost: $1.50`
- Wall-clock: 60-120s for a 30-shot campaign at concurrency 8.

**Read the triage table** (one-query JSONB):

```bash
PROTO_PAT=$(grep "^SUPABASE_ACCESS_TOKEN=" ~/proto_front/os-api/.env | cut -d= -f2-)
SUPABASE_ACCESS_TOKEN="$PROTO_PAT" supabase db query --linked \
  "SELECT metadata->'audit_report' FROM runs WHERE id = '<run-id>';"
```

The `audit_report` blob shape (persisted to `runs.metadata.audit_report` at audit close):

```json
{
  "runId": "...",
  "traceId": "...",
  "productionSlug": "drift-mv",
  "completedAt": "2026-04-29T...",
  "summary": { "keep": 14, "l1": 1, "l2": 0, "l3": 0, "errors": 0, "totalCost": 1.50 },
  "shots": [
    {
      "shotId": 5,
      "imagePath": "/Users/.../shot_05.png",
      "verdict": "PASS",
      "aggregateScore": 4.46,
      "recommendation": "ship",
      "detectedFailureClasses": [],
      "cost": 0.10,
      "latencyMs": 5234,
      "errorMessage": null
    },
    ...
  ]
}
```

**Per-recommendation operator guidance:**
- `ship` (KEEP_AS_IS) → no regen needed
- `L1_prompt_fix` → minor language fix; cheap in-loop regen (1 iter ≈ $0.14)
- `L2_approach_change` → composition redesign; medium cost (2-3 iters ≈ $0.30-0.50)
- `L3_redesign` → fundamental redesign; expect HITL involvement

✅ **HUD LIVE (2026-04-30 → 2026-05-01):** `<AuditTriageTable>` renders the triage table inline with click-through to `<ShotDetailDrawer>` (5 tabs: Narrative / Critic / Orchestrator / Timeline / Iterations). Gap 2 staleness banner (`5d56a52`) flags when in-loop runs invalidate the triage. Gap 1 `<ReviewGateEscalationSurface>` (`d4c7ddb`) surfaces open `asset_escalations` per shot with Accept flow that auto-clears `runs.hitl_required`. Gap 7 DIRECTION DRIFT pill (`62e663f`) on shot cards reads direction-class failure_classes / manifest_caveat fallback and pins Timeline tab to the verdict on click.

### In-loop run (after audit identifies shots that need pivot)

```bash
curl -X POST http://localhost:3001/api/clients/client_drift-mv/runs \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "stills",
    "campaignId": "<drift-mv-campaign-id>",
    "auditMode": false
  }'
```

In-loop mode iterates `campaign_deliverables` in non-terminal status (`generating`, `reviewing`, `regenerating`). Phase B parses "Shot N" from `deliverable.description` to map to manifest shots; if a deliverable description doesn't include "Shot N", the runner logs a clear warning and skips it (Phase E will replace this with explicit `shot_number` metadata).

**Per-shot loop:**
1. POST to `/grade_image_v2` with `mode: "in_loop"` + `pivot_rewrite_history` from manifest
2. If verdict is `ship` → log SHIP at iter N, move on (operator approves via HUD)
3. Else delegate to `escalation_loop.ts::handleQAFailure` — runs degenerate-loop guard (`_countConsecutiveSamePromptRegens` + `_maybePromoteLevel` L1×3 → L2×2 → L3×2 → HITL), records `orchestration_decisions` row, applies $1.00/shot cumulative cost cap (`STILLS_PER_SHOT_COST_CAP_USD`)
4. On `outcome === "regenerate"` → POST Temp-gen `/generate/image` with the orchestrator's new still prompt + manifest anchors as references

✅ **Phase B+ #6 SHIPPED 2026-04-30 (`2183d33`):** the runner now closes the regen → artifact-row → re-grade loop fully in-process. After Temp-gen writes a regen still, `createArtifactWithUpload` registers it tied to (current run, current deliverable, iter+1) with `metadata.parentArtifactId` provenance; next iter's `getArtifactsByRun` picks it up and the critic re-grades the new image. Phase B+ #7 (`4e9876f`) added `metadata.localPath` read priority so the local-file grader resolves the disk copy instead of the public Storage URL. Phase B+ #3 auto-seed (`29949ad`) registers a synthetic seed artifact when no artifact exists for a (current run, deliverable) pair but a prior-run artifact OR an on-disk locked still exists — escalation can attach. The full chain is now operator-visible via Gap 8 Iterations tab (`3a13380`) in `<ShotDetailDrawer>` with parent breadcrumbs + side-by-side Compare modal.

### Ad-hoc single-shot pivot

⏸ **Per-shot "Trigger Pivot" CTA still pending.** The HUD UX pass (2026-04-30 → 2026-05-01) shipped adjacent affordances — Gap 4 RecentRunsPanel for run-level visibility, Gap 6 MotionPhaseGate for stills→Veo handoff, Gap 8 Iterations tab for per-shot history — but a one-click "re-fire `auditMode:false` scoped to this shot" affordance from `<ShotDetailDrawer>` is still queued. **Today's path:** use the targeted-regen via Phase B+ #5 `shotIds: [N]` body field on a `mode:stills auditMode:false` POST — the runner iterates exactly the listed manifest shot IDs (bypasses `status NOT IN (approved, rejected)` filter). Operator-priority order is preserved.

---

## Reading the triage table

| Field | Meaning |
|---|---|
| `verdict` | PASS (≥4.0 + no blocking failure) / WARN (3.0-4.0 or non-blocking) / FAIL (<3.0 or blocking) |
| `aggregate_score` | Mean of 6 criterion scores (character_consistency, hand_anatomy, mech_color_identity, composition, narrative_alignment, aesthetic_match) |
| `audit_recommendation` | KEEP_AS_IS / L1_PROMPT_FIX / L2_APPROACH_CHANGE / L3_REDESIGN |
| `detected_failure_classes` | snake_case slugs from `known_limitations` table (e.g. `magical_aura_overinterpretation`) |
| `anticipated_pivot_strategy` | 1-2 sentence sketch of what the pivot would target |

Rule of thumb: bias toward KEEP_AS_IS. The audit pattern proven 14:1 on Drift MV — most stills don't need pivot if they're already documentary-dry.

---

## Direction integrity (Phase 4/5, 2026-04-30)

The critic and orchestrator both consume a campaign-level direction axiom when `manifest.directional_history` is populated. The Drift MV manifest carries:

```json
"directional_history": {
  "current_direction_mantra": "Cinematically beautiful · Documentary dry · No effects/gloss/polish · Nothing falling out of the sky",
  "abandoned_directions": [
    {
      "name": "mech_heavy_hero_framing",
      "rejected_at": "2026-04-25",
      "reason": "...",
      "snapshot_ref": "manifest_pre_pivot_backup.json"
    }
  ]
}
```

The brand-engine critic emits a `## CAMPAIGN DIRECTION` section in its system prompt (with the mantra + abandoned-directions list); when it detects a violation, it lists `campaign_direction_reversion_mech_heavy` (or similar) in `detected_failure_classes` and the server applies the migration-012 deductions. The orchestrator's HARD RULE 6 — direction integrity — fires before any `new_still_prompt`/`new_veo_prompt` is finalized: if the proposal would re-introduce an abandoned direction, the orchestrator escalates the level (L1→L2 or L2→L3) and proposes a structurally different approach.

**Why this matters for operators:** if you see a still that LOOKS aftermath/realistic but the critic flagged `campaign_direction_reversion_mech_heavy`, you should usually trust the critic — direction reversion at composition level is harder to spot at a glance than at the rubric level. Don't override on a Rule 6 escalation without strong evidence.

**Calibration ceiling (2026-04-30 re-audit):** Phase 6 found the calibration partial — some drifted shots fire Rule 6 cleanly (shot 7 → FAIL 3.167 + L2), others slip through (shot 4 → PASS 4.5). When the audit triage table shows a borderline-PASS on a shot that LOOKS drifted to you, fall back to manual override + log via `runs.metadata.operator_override`.

**Critic variance on borderline shots (2026-04-30 closing run):** the same locked still can score 3.17 / 3.92 / 4.90 across three single-pass critic calls (shot 7 in runs `a4aa3aff` / `c225fb19` / `01ead7d8`). Single-pass grading is unreliable in the 3.5-4.5 score band. The video pipeline already mitigates via consensus (`grade_video_with_consensus`); the image pipeline doesn't yet — tracked as Phase B+ followup. Until consensus lands for stills, treat single FAIL verdicts in the borderline zone as advisory and apply operator override when visual review confirms the asset is mantra-clean.

---

## Phase B+ shipped patterns (2026-04-30)

Eight Phase B+ improvements shipped today during the drift-mv direction-fix closure. Operators should know what changed:

### `shotIds` targeted regen (Phase B+ #5)

`POST /api/clients/<client>/runs` body now accepts an opt-in `shotIds: number[]` field for `mode:stills + auditMode:false`. When set, the in-loop runner iterates EXACTLY those manifest shot IDs and bypasses the default `status NOT IN (approved, rejected)` filter.

**Use case:** re-grading a small set of stills that were operator-`approved` before a critic-rubric calibration shipped. Without `shotIds`, those approved deliverables are invisible to the in-loop runner.

```bash
# Regen exactly shots 7, 16, 18, 20, 22 — bypass status filter
curl -sS -X POST http://localhost:3001/api/clients/client_drift-mv/runs \
  -H "Content-Type: application/json" \
  -d '{"mode":"stills","auditMode":false,"campaignId":"<campaign-uuid>","shotIds":[7,16,18,20,22]}'
```

**Validation:** integer list in [1, 100], de-duped while preserving operator-priority order. Rejected when `mode != "stills"` OR `auditMode == true`. Persisted to `runs.metadata.shot_ids` so the runner reads it at exec time.

### Rule 7 — prompt-length budget (orchestrator)

Both Temp-gen image-gen and brand-engine `/grade_image_v2` enforce a 2000-character ceiling on the still_prompt. Over-budget produces `HTTP 500 "Prompt exceeds maximum length of 2000 characters."` from Temp-gen and `HTTP 422` from brand-engine pre-flight.

**Doctrine:** `orchestrator_prompts.ts` SYSTEM_PROMPT_CORE Rule 7 instructs the orchestrator to keep `new_still_prompt` and `new_veo_prompt` ≤ 2000 chars, with 5 budget tactics (anti-pattern leads, adjective-stack cuts, hex+color compression, 3-layer scene structure, separate negative_prompt field) + level-escalation when the prompt won't fit.

**Guardrail:** `orchestrator.ts::_enforcePromptBudget()` runs on every parsed decision; if the model emits >2000 chars on either field, truncate at the last sentence terminator before 1990 chars (whitespace fallback, then hard-cut last-resort). Logs `[orchestrator] truncated <field> from <N> → <M> chars` warn — operators should grep `~/agent-vault/streams/os-api.log` for this and treat any occurrence as a Rule 7 compliance signal warranting HITL review on that run.

In a clean run, zero `truncated` warns appear.

### Loop closure (Phase B+ #6)

The in-loop runner closes regen → artifact → re-grade fully. After Temp-gen writes `shot_NN_iter{N+1}.png` to `~/Temp-gen/outputs/<run_id>/`, `createArtifactWithUpload` registers it as an artifact tied to (current run, current deliverable, iter+1) with `metadata.parentArtifactId` provenance. Next iter's `getArtifactsByRun` picks the new artifact as `candidate` and the critic re-grades the new image. Termination via ship OR cost cap OR degenerate-loop guard OR iter cap (default 8) OR artifact-registration failure.

### `localPath` read for grader (Phase B+ #7)

When `createArtifactWithUpload` succeeds, `artifact.path` is the public Supabase Storage URL (correct for HUD/API consumers) but the local disk copy lives at `metadata.localPath`. The brand-engine critic is a local HTTP service that reads from disk — it can't fetch URLs. Runner read order: `candidate.metadata.localPath` → `candidate.path` → fallback locked still. If you see `[in_loop] image not on disk at <URL>` warns, the read order is broken.

### Auto-seed (Phase B+ #3)

When no artifact exists for a (current run, deliverable) pair but a prior-run artifact OR an on-disk locked still exists, the runner registers a synthetic seed artifact with `metadata.seededFromArtifactId` + `metadata.seedReason`. Two seed paths:
- **Carry-forward** (preferred): clones path + storage_path + size from the most recent prior artifact for that deliverable.
- **Disk-only** (fallback): registers a minimal artifact pointing at `productions/<slug>/stills/shot_NN.png` with `seedReason: "no_prior_artifact_disk_only"`.

Eliminates the legacy "Operator must seed an artifact first" error that blocked targeted-regen on operator-approved deliverables.

### HITL bubble (Phase B+ #8)

When `handleQAFailure` returns `outcome: "hitl_required"`, the runner sets `runs.hitl_required = true` + writes a `hitl_notes` summary. Same pattern in `runner.ts` for the video pipeline (line 605 area). The asset_escalations row is the canonical signal; the runs flag is the indexable bubble for HUD queries (Review Gate panel reads `runs.hitl_required`).

### X-Trace-Id passthrough (Phase B+ #2)

brand-engine `/grade_image_v2` route reads the `X-Trace-Id` request header and binds it to a per-request `contextvars.ContextVar` in `image_grader.py`. Emitted `critic_call` JSON metric lines carry the caller's trace ID instead of a fresh-per-call uuid. Lets you correlate os-api logs with brand-engine logs across the X-call boundary.

### `/health` pre-check timeout 5s → 30s (Phase B+ #4)

`stills_runner.ts` health-checks brand-engine before fanning out. Bumped from 5s → 30s to eliminate spurious aborts when brand-engine is busy serializing concurrent requests.

---

## Operator override workflow

Two scenarios where operator overrides the critic verdict on a single shot:

1. **Intent-vs-mantra conflict** (e.g., shot 4 — manifest beat asks for "rampaging mech + magical orb in palm" but the campaign mantra forbids effects/gloss/mech-as-hero). The critic correctly weights shot-level intent over campaign-level mantra. Operator authors an alternative angle proposal that fills the same narrative gap without the conflict.

2. **Critic variance on borderline scores** (e.g., shot 7 graded 3.17/3.92/4.90 across three runs on the same image; shot 20 v5 iter3 graded FAIL 2.80 on visual review of a strong aftermath composition). Operator confirms the asset is mantra-clean via direct visual review and accepts.

### Capture format (mandatory audit trail)

Write to `runs.metadata.operator_override.shot_<id>`:

```json
{
  "decision_at": "YYYY-MM-DD",
  "decision_by": "<operator name or 'Tim direction'>",
  "decided_artifact_path": "productions/<slug>/outputs/<run_id>/shot_NN_iterM.png",
  "decided_iter": <int>,
  "critic_verdict": "<PASS|WARN|FAIL>",
  "critic_score": <float>,
  "rationale": "<why the override is justified — visual evidence + which scenario applies>",
  "locked_to": "productions/<slug>/stills/shot_NN.png"
}
```

### File operations (when locking a regen output)

```bash
# Backup the original (only if first time being replaced this session)
mkdir -p ~/Temp-gen/productions/<slug>/stills/_legacy_pre_iter_lock_<date>
cp -p ~/Temp-gen/productions/<slug>/stills/shot_NN.png \
      ~/Temp-gen/productions/<slug>/stills/_legacy_pre_iter_lock_<date>/

# Lock the chosen iter
cp -p ~/Temp-gen/outputs/<run_id>/shot_NN_iterM.png \
      ~/Temp-gen/productions/<slug>/stills/shot_NN.png

# Save alts the operator also liked but didn't lock as primary
mkdir -p ~/Temp-gen/productions/<slug>/stills/alternates_<date>
cp -p ~/Temp-gen/outputs/<run_id>/shot_NN_iterX.png \
      ~/Temp-gen/productions/<slug>/stills/alternates_<date>/shot_NN_iterX_alt.png
```

### Resolve open escalations

If the operator-override-locked still corresponds to a deliverable with open `asset_escalations.status = 'hitl_required'` rows, mark them resolved:

```sql
UPDATE asset_escalations
SET status = 'accepted',
    resolution_path = 'accept',
    resolution_notes = 'Operator override <date> — visual review accepted. See runs.metadata.operator_override.shot_<id> on run <run_id>. Locked file: stills/shot_<NN>.png. Originals archived to _legacy_pre_iter_lock_<date>/.',
    resolved_at = NOW()
WHERE deliverable_id = '<deliverable-uuid>' AND status = 'hitl_required';

UPDATE runs SET hitl_required = false, hitl_notes = COALESCE(hitl_notes, '') || ' [resolved <date>] Operator override accepted. See metadata.operator_override.'
WHERE id = '<run-uuid>';
```

`resolution_path` constraint allows: `prompt_fix | approach_change | accept | redesign | replace`. Use `accept` for operator overrides.

### Checkpoint after locking

Always checkpoint after a batch of operator-override locks so ADR-005 lineage stays intact:

```bash
~/Temp-gen/productions/<slug>/checkpoint.sh post-direction-fix-locks-<date>
```

This bakes a manifest snapshot, tarball of all 30 stills, meta JSON, git tag in proto_front, and appends to `productions/<slug>/checkpoints.log`.

To capture a new directional pivot:
1. `~/Temp-gen/productions/<slug>/checkpoint.sh <name>` — snapshot the current state
2. Edit `manifest.directional_history.abandoned_directions[]` — add the previous direction with `rejected_at`, `reason`, and `snapshot_ref` pointer to the fresh checkpoint
3. Edit per-shot `visual` / `still_prompt` / `veo_prompt` fields to honor the new direction
4. Re-fire `mode: "stills"` audit to validate

---

## When to override the critic

Per critic rubric Rule 4 (in `~/agent-vault/briefs/2026-04-29-stills-critic-rubric.md`): the critic can be too literal. If a prompt aspect is technically violated but the result is visually superior, the critic should score actual quality not rules-lawyering. The orchestrator overrides on rules-lawyering.

**You override the critic when:**
- The shot is visually a strong final-cut candidate but the critic flagged a minor prompt deviation (e.g. shot #17 OTS-inversion case from 2026-04-29 audit — model rendered exec-portrait instead of OTS, scored 4.65 anyway)
- The critic flagged narrative_alignment <4.0 because the still SOFTENS a beat in a way that actually serves the campaign (e.g. shot #5 v5 closed-fist-shockwave was lyric-aligned but the manifest direction was restrained-energy; the critic correctly flagged the manifest mismatch even though the lyric beat was hit)
- The critic detected a "warning" failure class that's been validated as acceptable for the production (document the override in `runs.metadata.operator_override` for audit trail)

**You do NOT override the critic when:**
- The verdict is FAIL with a blocking failure class. Even if you think it looks good, the structural failure was caught (see shot #11 iter 1 case — Brandy/Opus alone would have shipped a 2.42 FAIL; critic saved it)
- The two-voices pattern fired Rule 7 degenerate-loop guard. That's signal that the path won't converge; force a new approach

---

## Handling escalations

### `asset_escalations.status = 'hitl_required'`

An iteration loop on a single shot fired the degenerate-loop guard (same failure_class 2x without ≥0.3 score movement) OR cost cap tripped.

1. Open `ShotDetailDrawer` for the escalated shot → "Timeline" tab shows iter history
2. Read the `orchestration_decisions` rows in iteration order — what did the orchestrator try? What did the critic say?
3. Decide:
   - **Force composition pivot** (L3): edit prompt manually, set new still_prompt in manifest, re-fire single-shot regen
   - **Accept warning-class failure**: mark resolution_path='accept' with reasoning; ships as-is
   - **Replace with manual asset**: use `Replace/upload` in AnchorStillPanel to install a hand-crafted still
4. Mark `asset_escalations.status = 'resolved' | 'accepted' | 'replaced'` with `resolution_notes`

### Cost cap fired (`STILLS_PER_SHOT_COST_CAP_USD` exceeded)

Shot N has burned >$1.00 cumulative across iterations without converging.

1. Same as above — open Timeline, read decisions
2. **Don't just bump the cap.** That's a code smell — the prompt path isn't working. Pivot the approach.
3. If you genuinely need more budget for this shot (rare), set `STILLS_PER_SHOT_COST_CAP_USD` env var per-run via the run trigger body and document why in the run notes.

### Cross-campaign cap fired (`STILLS_PER_CAMPAIGN_COST_CAP_USD` exceeded)

Whole campaign run has burned >$50.

1. **Halt the run.** Do not just resume. Something systemic is wrong — broken anchor refs, broken story context, model degradation, prompt-builder regression.
2. Check brand-engine sidecar health: `curl http://localhost:8100/health`
3. Check Temp-gen sidecar health: `curl http://localhost:8200/health`
4. Check recent commits for anything that touched orchestrator_prompts.ts, runner.ts, or the rubric brief
5. If nothing obvious, file an `asset_escalations` for the campaign-level escalation and surface to Brandy/Tim

---

## Common failures + recovery

### "Prompt exceeds maximum length of 2000 characters"

Nano Banana Pro hard limit. The orchestrator prompt-builder failed to enforce the pre-flight check.

**Recovery:**
1. Tighten the prompt to <2000 chars (target ≤1800 for headroom)
2. The 5-element L1 fix template (anti-CGI opener + positive containment + strict negation + off-center composition + practical lighting) has been productized to fit; if a generated prompt exceeds 2000, that's an orchestrator bug
3. File an `asset_escalations` row with failure_class='prompt_size_exceeded' for orchestrator team triage

### "Gemini 3.1 Pro Vision returned 429"

Rate limit. Auto-retry with exponential backoff (3 retries max) is built in. If still failing:

**Recovery:**
1. Check Gemini console for quota status
2. Fall back to Claude Opus subagent critic via `agent_fallback=true` body param on the run trigger (proven path; this is what shipped the manual Drift MV audit)
3. Document the fallback in run notes

### "Image could not be loaded" (image_load_failure)

Critic returned `verdict=FAIL` with reasoning indicating bad path or unreadable image.

**Recovery:**
1. Verify file exists: `ls -la ~/Temp-gen/productions/<slug>/stills/shot_NN.png`
2. Verify file size > 100KB (anything smaller is likely truncated)
3. Verify it's actually a PNG: `file <path>`
4. If file is corrupted, restore from `_v5_backup.png` or re-fire generation with `--force`

### Sidecar down (brand-engine or Temp-gen)

`POST /api/clients/:id/runs` returns "Cannot connect to <sidecar>".

**Recovery:**
1. Check sidecar processes: `ps aux | grep -E "api.server|brand-engine"`
2. Restart per project README:
   - brand-engine: `cd ~/proto_front/brand-engine && python -m brand_engine.api.server`
   - Temp-gen: `cd ~/Temp-gen && python -m brand_engine.api.server`
3. **Do NOT proceed with `[DEMO]` fallback** — `[DEMO]`-prefix in real client work is a P1 incident per `AGENTS.md` Production posture. Halt the run, fix sidecar, resume.

---

## Rollback procedure

If `mode: "stills"` introduces a regression:

1. **Feature flag off:** Set `STILLS_MODE_ENABLED=false` in os-api `.env`, restart os-api. The runner returns `false` with a clear log line ("[stills] STILLS_MODE_ENABLED=false. …rollback lever per ADR-004 quality gate #21.") rather than running.
2. **HUD CTA hidden** (Phase E) — when the audit CTA lands, it'll be guarded by the same flag.
3. **Database state preserved:** migrations `009` (image-class known_limitations seed), `010` (stills enum value), `011` (runs.metadata JSONB) are all additive. No rollback needed.
4. **Manual fallback:** the Brandy-session two-voices pattern works as before — see `~/Temp-gen/productions/drift-mv/STILLS_AUDIT_15_SHOTS.md` for the manual workflow that shipped the inaugural campaign.

If a specific PR introduces the regression:

1. Identify the PR via `git log --oneline` (look for changes to `runner.ts`, `stills_runner.ts`, `image_grader.py`, `orchestrator_prompts.ts`, `escalation_loop.ts`).
2. Revert the PR: `git revert <sha>`; rebuild + redeploy.
3. Verify by re-running an audit on Drift MV — verdicts should match the 2026-04-29 baseline within ±0.3 aggregate per shot.

Worker safety: even with the flag off, the worker's `OS_API_OWNED_MODES = ('regrade', 'stills')` filter prevents the Python worker from claiming stills runs. No race-condition risk during rollback.

---

## Phase B+ env refresh — operator procedure (5 minutes)

The audit smoke #1 caught a degraded-mode artifact: brand-engine `known_limitations_loader` hits "Invalid API key" on every request → critic runs without the failure-class catalog → recommendations stay correct but scores skew +0.3-0.5 because deduction prompts aren't applied.

**Symptom in brand-engine log:**

```text
ERROR:brand_engine.core.known_limitations_loader:Failed to create Supabase client: Invalid API key
```

**Fix:**

1. Copy current valid key from os-api (which works):

   ```bash
   grep '^SUPABASE_KEY=' ~/proto_front/os-api/.env | head -1
   ```

2. Compare to brand-engine's:

   ```bash
   grep '^SUPABASE_KEY=' ~/proto_front/brand-engine/.env | head -1
   ```

3. If different, update brand-engine's `.env` with the working value (preserve all other keys).
4. Restart brand-engine sidecar:

   ```bash
   pkill -TERM -f 'brand_engine\.api\.server'
   cd ~/proto_front/brand-engine && .venv/bin/python -m brand_engine.api.server > /tmp/brand-engine.log 2>&1 &
   ```

5. Verify catalog loads — first audit verdict should NOT log the "Invalid API key" error.
6. Re-fire audit smoke (~$3 budget). Expect score drift to drop to ≤±0.2.

## Production rigor TODOs

Phase B SHIPPED 2026-04-29 PM + audit smoke #1 PASS. Remaining gates:

- [x] Phase B (runner) lands — DONE (commits `ef18a76` + `4c713b2`); curl examples above are real
- [x] **Audit smoke #1** — DONE (run `389ae296...`, 15/15 recommendation match, score drift attributed to env not code)
- [x] **Phase B+ #1**: brand-engine `.env` SUPABASE_KEY refresh procedure documented above — live ops path validated
- [x] **Phase B+ #2**: sidecar X-Trace-Id passthrough — brand-engine `_emit_critic_log` honors the runner's X-Trace-Id rather than generating its own
- [x] **Phase B+ #3**: auto-seed when no current-run artifact exists — runner registers a synthetic seed artifact for escalation attachment
- [x] **In-loop sidecar smoke** — drift-mv closing run `01ead7d8-...` verified critic→orchestrator→regen loop, L1/L2/L3/HITL outcomes, and operator override closure
- [x] **Cost-cap / HITL bubble** — hard-cap path persists `runs.hitl_required` plus canonical `asset_escalations` row; use `STILLS_PER_SHOT_COST_CAP_USD=0.05` only for manual smoke
- [x] **Phase B+ #4-#8** — direction integrity, Rule 7 2000-char budget, loop closure, localPath grading, and HITL bubble shipped; Phase C prompt-template tightening remains Brandy-owned follow-up
- [x] **Phase E / HUD operator UX (Karl)** — Review Gate escalation, audit triage, override pills, recent runs, canonical refs, motion gate, direction drift, and regen iterations browser shipped 8/8
- [ ] **Phase F** (Brandy) — `pipeline_metrics` table, cost-alert thresholds, `WatcherSignalsPanel` stills-mode binding, Datadog/OTEL collector option.
- [ ] **Phase G** (Brandy) — architecture mermaid diagram (`docs/architecture/stills-pipeline.md`), troubleshooting failure-mode → recovery table (`docs/troubleshooting/stills-mode.md`).
- [ ] **Phase H** (Brandy) — multi-campaign RLS audit, `GET /api/campaigns/:id/cost-ledger`, `GET /api/campaigns/:id/audit-log`, cross-campaign isolation smoke.
- [ ] First production audit on a non-Drift-MV campaign → adjust thresholds, document edge cases.

---

## Related docs

- `~/proto_front/docs/api/grade_image_v2.md` — endpoint reference
- `~/proto_front/docs/architecture/stills-pipeline.md` — architecture diagram
- `~/proto_front/docs/troubleshooting/stills-mode.md` — failure mode → recovery table
- `~/agent-vault/adr/004-stills-critic-in-loop.md` — architecture decision record (ACCEPTED 2026-04-29)
- `~/agent-vault/briefs/2026-04-29-phase-c-stills-mode-runner-and-image-grading.md` — implementation brief
- `~/agent-vault/briefs/2026-04-29-stills-critic-rubric.md` — critic rubric reference
- `~/Temp-gen/productions/drift-mv/STILLS_AUDIT_15_SHOTS.md` — Drift MV audit baseline
- `~/Temp-gen/productions/drift-mv/STILLS_CRITIC_LOOP_LEARNINGS.md` — failure mode catalog with mitigations
