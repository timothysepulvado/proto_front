# Runbook — `mode: "stills"` (Production Operator Guide)

> **Status:** SCAFFOLD — completes when Phase B/F implementations land per ADR-004 Phase G acceptance gate.
> **Owner:** Brandy
> **Last revised:** 2026-04-29 PM (initial scaffold)

This runbook is the operator's first stop for any production stills work. It covers when to fire each mode, how to read the output, when to override the critic, how to handle escalations, and how to roll back if something breaks. **You should be able to recover from a bad release using only this document.**

---

## What `mode: "stills"` is

Production runner path that grades + iterates a campaign's still images using the two-voices critic-in-loop pattern. Two sub-modes:

- **`auditMode: true`** — fires parallel critics on the full still set, returns a triage table (KEEP_AS_IS / L1_PROMPT_FIX / L2_APPROACH_CHANGE / L3_REDESIGN per shot). Does NOT regenerate. Use this to decide what needs work before burning compute on regen.
- **`auditMode: false`** (in-loop) — per-shot iteration loop: critic → orchestrator → critic.validate → regenerate → critic. Iterates until SHIP verdict, degenerate-loop guard fires, or cost cap hits. Use this AFTER audit identifies which shots need pivot.

Productized from the manual orchestration that shipped the Drift MV inaugural campaign (30/30 stills, 2026-04-25 → 2026-04-29). See ADR-004 for the architecture decision.

---

## Quick start — operator workflows

### Pre-Veo readiness check (most common use case)

You're about to fire Veo motion phase on a campaign. Want to know if any starting frames are below quality bar before burning $0.50-1.60 per Veo iteration.

1. Open HUD → BrandStudios → Campaigns → **<your campaign>**
2. Click **Run Audit** (top-right of campaign workspace)
3. Confirm cost (~$0.10 × N stills; for a 30-shot campaign ≈ $3)
4. Wait 60-120s for parallel critic batch to complete
5. Triage table appears: each shot row shows verdict, aggregate_score, audit_recommendation
6. **Read the table:**
   - `KEEP_AS_IS` rows → ship as-is, no regen needed
   - `L1_PROMPT_FIX` rows → minor language fix; cheap regen (1 iter ≈ $0.14)
   - `L2_APPROACH_CHANGE` rows → composition redesign; medium cost (2-3 iters ≈ $0.30-0.50)
   - `L3_REDESIGN` rows → fundamental redesign; expect HITL involvement
7. Click any row → opens `ShotDetailDrawer.Critic` with full per-criterion verdict + reasoning + anticipated_pivot_strategy

### Pivot batch on a curated list

After audit, you've decided which shots need regen. Fire in-loop mode on just those shots.

1. Select shots in triage table (checkboxes; sticky multi-select)
2. Click **Pivot Selected** (replaces the legacy single-shot regen button)
3. Confirm cost (~$0.24/iter × shots × expected iters)
4. Per-shot iteration runs in parallel; HUD `WatcherSignalsPanel` streams live cost + iter count + verdict per shot
5. SHIP verdicts auto-promote (artifact metadata + reference_images touch)
6. WARN/FAIL with degenerate-loop guard fires HITL escalation → `asset_escalations` row → operator review

### Ad-hoc single-shot pivot (Tim flagged X manually)

If you have a single shot that needs work and audit-mode is overkill:

1. Open `ShotDetailDrawer` for that shot
2. Click **Trigger Pivot** (specifies failure_class if known)
3. Same iteration loop, single shot
4. Same SHIP/HITL outcomes

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

1. **Feature flag off:** Set `STILLS_MODE_ENABLED=false` in os-api `.env`, restart os-api
2. **HUD CTA hidden:** Run-mode dropdown filters out 'stills' when flag is off; no user-visible breakage
3. **Database state preserved:** migrations 009 + 010 are additive; no rollback needed
4. **Manual fallback:** Brandy session two-voices pattern works as before — see `~/Temp-gen/productions/drift-mv/STILLS_AUDIT_15_SHOTS.md` for the manual workflow that shipped the inaugural campaign

If a specific PR introduces the regression:

1. Identify the PR via `git log --oneline` (look for runner.ts, image_grader.py, orchestrator_prompts.ts changes)
2. Revert the PR: `git revert <sha>`; rebuild + redeploy
3. Verify by re-running an audit on Drift MV — verdicts should match the 2026-04-29 baseline within ±0.3 aggregate per shot

---

## Production rigor TODOs

This scaffold completes when:

- [ ] Phase B (runner) lands → fill in actual run trigger curl examples + endpoint paths
- [ ] Phase F (observability) lands → fill in Datadog / Supabase metric query examples + alert thresholds
- [ ] Phase E (HUD) lands → screenshots for "Run Audit" CTA + triage table
- [ ] Phase H (multi-campaign isolation) lands → cross-campaign access control examples
- [ ] First production audit on a non-Drift-MV campaign → adjust thresholds, document edge cases

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
