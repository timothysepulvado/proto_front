# Asset Escalation Log

> Living document — the human-readable view of `known_limitations` + `asset_escalations` + `orchestration_decisions`.
> Before starting a new production, scan this log for applicable limitations.
> When an asset hits a wall in the gen-loop, log it here AND in the DB.

---

## How This Works

The BrandStudios OS runner catches QA failures and routes them through an **autonomous escalation loop**:

```
generate → auto-QA → [gate decision]
  ├─ AUTO_PASS → artifact approved
  └─ not pass → orchestrator (Claude Opus 4.7) decides L1/L2/L3 action
      ├─ L1 prompt_fix   → regen with rewritten prompt
      ├─ L2 approach_change → regen with new camera/lighting/composition
      ├─ L3 accept       → trim/pad in final assembly
      ├─ L3 redesign     → new hero still → new video (same narrative beat)
      └─ L3 replace      → new shot concept (different narrative approach)
```

Every decision writes to `orchestration_decisions` (audit trail). Every escalation writes to `asset_escalations` (state machine). When the orchestrator classifies a failure against the `known_limitations` catalog, the limitation's `times_encountered` increments — so frequency is tracked automatically across productions.

**Shot Escalation Ladder doctrine:** `~/Temp-gen/productions/drift-mv/refs/PRODUCTION_SETTINGS.md` (the human-readable rules that became this system).
**Prompt engineering rules:** `~/Temp-gen/productions/drift-mv/qa_prompt_evolution.md` (21 rules + failure mode taxonomy).

---

## Known Limitations

### Veo 3.1 (`veo-3.1-generate-001`) — Drift MV discoveries

Seven failure modes discovered during Drift MV Phase 2 (v1→v4). All seeded into `known_limitations` via migration 007.

#### 1. `atmospheric_creep_fire_smoke_aerial` — **blocking**

Extended aerial shots over scenes containing fire, smoke columns, or burning buildings accumulate atmospheric haze in the last 3-4 seconds regardless of camera trajectory or negation prompts. Veo exhibits a scene-content-driven atmospheric generation bias even with triple-locked "zero fog, zero cloud, zero atmospheric haze" negation.

- **First encountered:** Drift MV Shot 27 (Phase 2 v2-v4)
- **Mitigation:** Remove fire/smoke from scene description. OR use fixed-altitude lateral orbit AND trim clip to first 60-70 percent. OR redesign as ground-level composition avoiding the aerial entirely.
- **Category:** atmospheric

#### 2. `atmospheric_generation_ascending_aerial` — **blocking**

Ascending camera moves in aerial shots trigger atmospheric layer generation (fog, cloud, haze) regardless of negation prompts like "stays below cloud layer" or "clear visibility throughout." Veo treats ascending trajectory as a cue to add atmospheric layers.

- **First encountered:** Drift MV Shot 27 (Phase 2 v2→v3)
- **Mitigation:** Use fixed-altitude lateral movement (orbit, pan, lateral dolly). Avoid ascending pullbacks when ground detail must remain visible.
- **Category:** atmospheric

#### 3. `scene_progression_vfx_completion` — **warning**

VFX events described with completion-tense verbs (passes through, breaks, shatters) trigger Veo to render the aftermath instead of a sustained effect. By the end of the clip, the VFX has disappeared or the scene has shifted to a post-event rubble state.

- **First encountered:** Drift MV Shot 05 (Phase 2 v2)
- **Fix confirmed:** Shot 05 v3 PASS — end-state lock + continuous-tense rewrite
- **Mitigation:** Use continuous-tense language (expands continuously, radiates outward, crawls across) plus an explicit end-state lock ("remains visible in frame at all times").
- **Category:** temporal

#### 4. `scale_jump_excessive_zoom` — **warning**

Zoom ranges beyond approximately 2 stops in 8 seconds render as a scene cut rather than a smooth pullback or push-in. Macro-to-wide is the most common offender.

- **First encountered:** Drift MV Shot 07 (Phase 2 v2)
- **Fix confirmed:** Shot 07 v3 PASS — limited to close-up → medium
- **Mitigation:** Limit zoom to about 2 stops in 8 seconds. If wider reveal needed, split across two shots.
- **Category:** zoom

#### 5. `subtle_vfx_absorption` — **warning**

Veo temporal coherence smooths away subtle VFX effects (thin grids, faint glows, delicate particles, slow crawls). Small-scale effects get absorbed into the base composition over 8 seconds and become invisible by last frame.

- **First encountered:** Drift MV Shot 15 (Phase 2 v2)
- **Fix confirmed:** Shot 15 v3 PASS — dramatic large-scale VFX rewrite
- **Mitigation:** Use large-scale, dramatic VFX changes. Make the VFX the climactic focal point, not background atmosphere.
- **Category:** temporal

#### 6. `backlight_color_homogenization` — **warning**

Warm backlighting washes multiple distinct-colored subjects toward the same warm tone. By the end of the clip, faction color identity is lost and all subjects read as gold/bronze.

- **First encountered:** Drift MV Shot 20 (Phase 2 v2)
- **Fix confirmed:** Shot 20 v3 PASS + Shot 18 v4 PASS (pattern transfer)
- **Mitigation:** Use front/side lighting (front-left proven across two shots). Keep background darker than subjects for contrast. Explicitly lock "each subject color remains clearly distinguishable" in the prompt.
- **Category:** lighting

#### 7. `generic_appearance_lock` — **warning**

Generic locks like "exact appearance remains unchanged" are weak and result in wardrobe, material, and feature drift over 8 seconds. Veo needs specific anchoring material descriptions to hold identity.

- **First encountered:** Drift MV Shot 18 (Phase 2 v2)
- **Fix confirmed:** Shot 18 v3 jacket material lock held
- **Mitigation:** Name specific materials, textures, fabrics, thread patterns. Material language (welded steel, chipped paint, thin gold thread) is the strongest identity lock.
- **Category:** character

---

## Active Escalations

*(none currently — all Drift MV Phase-2 escalations resolved as of 2026-04-17. See Resolved section below.)*

---

## Resolved Escalations

### Drift MV — Shot 05 (2026-04-15) [RESOLVED L1]

- **Failure class:** `scene_progression_vfx_completion`
- **Journey:** v1 WARN → v2 FAIL → v3 PASS (5.0)
- **Resolution:** L1 prompt_fix — continuous-tense language + end-state lock
- **Root cause:** Veo interprets completion-tense verbs ("passes through") as event-then-aftermath. The fist and golden shockwave dissolved by t=4s, replaced by generic rubble.
- **Fix:** Changed "pressure wave passes through the dust" → "expands outward continuously"; added "The golden energy ring remains visible in frame at all times"; added "The fist never leaves the center of frame"
- **Lesson:** Encoded as rule #13 (end-state locks for VFX events, continuous-tense language). Added to known_limitations catalog as `scene_progression_vfx_completion`.

### Drift MV — Shot 07 (2026-04-15) [RESOLVED L2]

- **Failure class:** `scale_jump_excessive_zoom`
- **Journey:** v1 WARN → v2 WARN → v3 PASS (4.6)
- **Resolution:** L2 approach_change — zoom range limited
- **Root cause:** v2 prompt spanned 3+ stops of zoom (extreme macro → wide) in 8s. Veo interpolated as a jarring scene cut, not a smooth pullback.
- **Fix:** Reduced zoom to close-up → medium (2 stops). Removed "extreme close-up." End state is "upper body" not "three mechs in full formation." Added "smooth continuous dolly-out at a steady pace."
- **Lesson:** Encoded as rule #14 (2-stop zoom limit in 8s). Added to catalog as `scale_jump_excessive_zoom`.

### Drift MV — Shot 15 (2026-04-15) [RESOLVED L1]

- **Failure class:** `subtle_vfx_absorption`
- **Journey:** v1 WARN → v2 WARN → v3 PASS (4.2)
- **Resolution:** L1 prompt_fix — VFX scale increased
- **Root cause:** "Thin golden digital grid crawls" was too subtle. Veo temporal coherence smoothed it away over 8s.
- **Fix:** "Golden circuitry erupts from the impact point and spreads rapidly"; "golden veins spread across entire torso and limbs"; "red optics flare bright then snap to steady gold." Made the VFX the climax at t=6-8s.
- **Lesson:** Encoded as rule #15 (large-scale VFX changes, subtle effects get smoothed). Added to catalog as `subtle_vfx_absorption`.

### Drift MV — Shot 18 (2026-04-16) [RESOLVED L2 via pattern transfer]

- **Failure classes:** `generic_appearance_lock` (v2→v3) + `backlight_color_homogenization` (v3→v4)
- **Journey:** v1 WARN → v2 WARN → v3 partial (material lock worked, lighting didn't) → v4 PASS (4.6)
- **Resolution:** L2 approach_change — front-left lighting fix borrowed from Shot 20's proven pattern
- **Root cause (composite):** (1) Generic "remains unchanged" lock was too weak for Brandy's jacket (drifted v1→v2). (2) Warm backlighting homogenized front-row mech colors even after jacket was fixed (v3).
- **Fix:** Material-specific jacket lock ("fitted matte black tactical jacket with thin gold thread stitching at the collar and cuffs") + Shot 20's front-left lighting approach ("warm golden sunlight illuminates the four mechs from the front left") + darker background for contrast.
- **Lesson:** Proven patterns transfer across shots with the same failure class. Encoded as rule #16 (specific material locks) + rule #17 (front/side lighting) + rule #20 (reuse proven fixes across shots). The pattern-transfer finding validates the orchestrator's catalog-based approach.

### Drift MV — Shot 20 (2026-04-15) [RESOLVED L2]

- **Failure class:** `backlight_color_homogenization`
- **Journey:** v1 WARN → v2 WARN → v3 PASS (4.8)
- **Resolution:** L2 approach_change — lighting direction changed
- **Root cause:** Warm backlight ("golden sunlight breaks through the clouds") + four distinct-colored mechs = all four washed to gold/bronze by end frame.
- **Fix:** "Golden sunlight illuminates the four mechs from the front left"; "the sky behind them remains darker, creating contrast"; "each mech's faction colors remain clearly distinguishable against the sky throughout."
- **Lesson:** Encoded as rule #17 (front/side lighting for color distinction). This resolution's pattern was later applied to Shot 18 (pattern transfer validated).

### Drift MV — Shot 27 (2026-04-17) [RESOLVED L3 replace (Option C)]

- **Failure class:** `atmospheric_creep_fire_smoke_aerial` (severity: **blocking**)
- **Journey:** v2 WARN → v3 WARN (3.25, atmospheric bank) → v4 WARN (3.5, marginal soft haze) → **v5 Option C PASS 4.4**
- **Resolution:** L3 replace — Option C (interior courtyard trust moment, Gemini mech kneeling, worker approaching). Fully eliminates the burning-cityscape trigger from frame.
- **Why Option C over Option B:** Option B (ground-level wide, fortress background) was orchestrator-recommended for confidence, but Option C was picked for the stronger emotional beat at the finale and because it **removes the trigger entirely** instead of working around it.
- **v5 Option C auto-QA:** PASS 4.4, `detected_failure_classes: []`, recommendation `ship`. Critic summary: "completely avoiding the atmospheric_creep_fire_smoke_aerial issue that plagued the previous version."
- **Root cause (confirmed):** Scene-content-driven atmospheric generation. Fire/smoke columns in frame → Veo adds atmospheric haze regardless of camera trajectory or negation prompts. Cannot be negotiated via prompt engineering.
- **Catalog update:** `known_limitations.times_encountered` incremented from 1 → 2 (Drift MV is the second encounter; prior was the original discovery production).
- **Cost:** ~$0.04 still + ~$0.75 clip = ~$0.79 (first-attempt success for Option C).
- **Rule added to escalation-ops brief:** If detected class has `severity: blocking` AND the mitigation is scene-content-level (not prompt-level), orchestrator should skip L1/L2 and go direct-L3 on first encounter (Rule 3 in `~/agent-vault/briefs/escalation-ladder-autonomous-ops.md`).
- **Full Drift-MV-side record:** `~/Temp-gen/productions/drift-mv/docs/ESCALATION_LOG.md`.

---

## Critic Consensus — Rule 1 IMPLEMENTED (2026-04-17)

Shot 05 v3 (logged above) surfaced Gemini-3.1-pro-preview critic variance: single-call aggregate scores for the identical clip swung up to 3 points depending on the call, producing WARN↔PASS verdict flips. That session ran the critic manually N=2 and used frame extraction as a visual tiebreak.

As of proto_front commit **`420a3c3`** (2026-04-17), that practice is **production-wired** in brand-engine:

- `brand_engine/core/video_grader.py::grade_video_with_consensus()` — runs one call; if `aggregate_score` is within ±0.3 of a verdict boundary (3.0 FAIL/WARN, 4.0 WARN/PASS), runs a second call; agree → higher-confidence result; disagree → `_frame_extraction_fallback` (ffmpeg `-vf fps=1` → tile grid → Gemini as image-mode).
- `VideoGradeResult.consensus_note` describes the path taken. When non-null, os-api `escalation_loop.ts` flips `OrchestratorInput.consensusResolved = true`, and SYSTEM_PROMPT Rule 1 tells Claude to treat the verdict as authoritative.
- `/grade_video` endpoint defaults `consensus: true`; legacy `consensus: false` single-call path preserved for callers that don't want it.

Live gate vs Shot 20 this session showed five different verdicts across four calls on the identical clip; consensus + tiebreak reliably resolved to PASS 4.9.

Brief: `~/agent-vault/briefs/escalation-ladder-autonomous-ops.md` Rule 1.

---

## New Failure-Mode Candidates

*(This section accumulates orchestrator discoveries. When Claude identifies a failure pattern not in the catalog with sufficient confidence, it proposes a new entry here. HITL reviewer confirms → POST /api/known-limitations adds to catalog.)*

---

## Maintenance

- **Living DB:** query via `SELECT * FROM known_limitations ORDER BY times_encountered DESC;`
- **Audit trail:** query via `SELECT * FROM orchestration_decisions WHERE run_id = '...';`
- **Per-artifact state:** query via `SELECT * FROM asset_escalations WHERE artifact_id = '...';`
- **Update this doc manually after resolving non-trivial escalations** — the DB is source of truth, but this doc is the human-readable narrative for onboarding and archaeology.
