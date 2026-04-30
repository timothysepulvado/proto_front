# Runbook — `mode: "stills"` (Production Operator Guide)

> **Status:** LIVE for Phase B (audit-mode validated end-to-end; in-loop runner code-complete pending Phase C templates). Phase E HUD CTA + Phase F observability metrics still pending — flagged inline below.
> **Owner:** Brandy
> **Last revised:** 2026-04-29 PM (audit smoke #1 PASS 15/15 vs manual baseline)
> **Implemented by:** commits `ef18a76` (initial) + `4c713b2` (`runs.metadata` refinement) on `feat/step-11-phase-4`
> **Live-validated by:** audit run `389ae296-390c-4333-b289-831d6c0252f5` against the 30-shot Drift MV campaign (closeout: `.claude/handoffs/brandy/2026-04-29-PM-phase-b-audit-smoke-results.md`)

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

### Phase B: fire from curl (Phase E HUD CTA pending — Karl)

Until the HUD "Run Audit" button lands (Phase E), operators fire stills runs via curl against the os-api endpoint.

**One-time per environment** — enable the feature flag:

```bash
# In ~/proto_front/os-api/.env
STILLS_MODE_ENABLED=true
# Optional tuning (defaults shown):
STILLS_AUDIT_CONCURRENCY=8         # parallel critics in flight
STILLS_PER_SHOT_COST_CAP=1.0       # USD; HITL escalation when exceeded
```

Restart os-api after editing `.env`.

**Start the sidecars** (separate terminals):

```bash
cd ~/proto_front/brand-engine && python -m brand_engine.api.server   # :8100
cd ~/Temp-gen && python -m api.server                                # :8200
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

⏸ **Phase E pending:** HUD will render this triage table inline + click-through to `ShotDetailDrawer.Critic` for full per-criterion verdict.

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
3. Else delegate to `escalation_loop.ts::handleQAFailure` — runs degenerate-loop guard (`_countConsecutiveSamePromptRegens` + `_maybePromoteLevel` L1×3 → L2×2 → L3×2 → HITL), records `orchestration_decisions` row, applies $1.00/shot cumulative cost cap (`STILLS_PER_SHOT_COST_CAP`)
4. On `outcome === "regenerate"` → POST Temp-gen `/generate/image` with the orchestrator's new still prompt + manifest anchors as references

⏸ **Phase B+ refinement pending:** the regen → artifact-row closure step (auto-create successor `artifacts` row so the next iter picks it up) is left for Phase E HUD wiring or a Phase B+ pass. Today the operator drives the rest manually.

### Ad-hoc single-shot pivot

⏸ **Phase E pending:** the `ShotDetailDrawer` "Trigger Pivot" button. Until then, seed a deliverable row with description `"Shot N: ..."` and fire `auditMode: false` against the campaign — only the unresolved deliverables process.

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
   - brand-engine: `cd ~/proto_front/brand-engine && python -m api.server`
   - Temp-gen: `cd ~/Temp-gen && python -m api.server`
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
```
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
- [ ] **Phase B+ #1**: brand-engine `.env` SUPABASE_KEY refresh (procedure above) — drops score drift to ≤±0.2
- [ ] **Phase B+ #2**: sidecar X-Trace-Id passthrough — brand-engine `_emit_critic_log` honors the runner's X-Trace-Id rather than generating its own
- [ ] **Phase B+ #3**: cost reporting in `_call_gemini_vision` — compute from token counts × Gemini 3 Pro Vision rate (currently returns 0)
- [ ] **In-loop sidecar smoke** — fire `auditMode: false` against deliberately-broken seed prompt; verify L1→L2 promotion via degenerate-loop guard. ~$0.50 budget. (Best done after Phase C templates land so regen prompts are production-quality.)
- [ ] **Cost-cap sidecar smoke** — `STILLS_PER_SHOT_COST_CAP=0.05` forces HITL escalation. ~$0.20 budget.
- [ ] **Phase C** (Brandy) — image-class L1/L2/L3 prompt templates + 22nd rule for non-human pose-driven subjects + 2000-char ceiling enforcement in orchestrator prompt-builder.
- [ ] **Phase E** (Karl) — HUD "Run Audit" CTA + triage table (reads `runs.metadata.audit_report`) + `ShotDetailDrawer` "Trigger Pivot" button.
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
