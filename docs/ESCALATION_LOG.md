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

## Step 10c — Single-shot runner dry run LANDED (2026-04-17 PM)

First end-to-end exercise of the productized pipeline with all 10a + 10b hardening in place. Path A (fresh Veo generation through the HUD runner) was used; Path B manual-insert fallback was not needed.

**Run trail:**
- Seeded: `client_drift-mv` Supabase client row + campaign `b6691def-...` + deliverable `1d7c52f1-...` with Shot 20's full veo_prompt (8s, 16:9, 720p, veo-3.1-generate-001 standard tier).
- Run 1 (`eff85bff-...`): Temp-gen job `b2e5cf5e-...` succeeded in ~3 min, artifact row written + uploaded to Supabase Storage. `/grade_video` call **failed with 404** — the runner was passing `currentArtifact.path` (the Supabase public URL) as `video_path`, and brand-engine's grader treats that as a local filesystem path. First real wire-up bug this session.
- Fix: `createArtifactWithUpload` now writes `metadata.localPath` (the on-disk path before upload) alongside the public-URL `path` field. `gradeAndEscalateVideo` prefers `metadata.localPath` when present, falls back to `artifact.path` for legacy rows.
- Run 2 (`a8e32483-...`): same deliverable re-fired after the fix landed. Temp-gen job `88c30331-...` produced segment_000.mp4, artifact row written with localPath populated, `/grade_video` returned **PASS 5.0** on first call (`consensus_note="not borderline, single call"`). Deliverable transitioned to `reviewing`, run completed, no escalation.
- Also landed in this commit: explicit `consensus: true` in runner's `/grade_video` payload (Rule 1 defensive — guards against a future brand-engine default-flip).

**Orchestrator backend change (10c-2 — Tim's call):**
- Vertex `/api/orchestrator/replay` first call returned 429 RESOURCE_EXHAUSTED (implies request shape including `web_search_20250305` was accepted — a tool rejection would be 400). Retry surfaced `invalid_rapt` — ADC needs reauth.
- `anthropic.ts` refactored to auto-select backend: direct `@anthropic-ai/sdk` when `ANTHROPIC_API_KEY` is set, Vertex fallback when absent. Call-site unchanged (both SDKs expose identical `messages.create`). `OrchestratorCallResult.toolUses` + `webSearchCount` now propagate from `callClaude` so `/api/orchestrator/replay` can audit web_search use.
- Clean 2xx verification of `web_search_20250305` returning `toolUses[]` is a 10d prerequisite (needs `ANTHROPIC_API_KEY` in .env OR fresh ADC).

**Gaps surfaced (for 10d to address):**
1. `runEvents.emit("escalation:${runId}", ...)` — including the 10a `watcher_signal` payload at line 174 of `escalation_loop.ts` — has **zero subscribers**. The SSE `/api/runs/:runId/logs` handler only listens on `log:` + `complete:` channels. Humans watching the SSE stream cannot currently see cumCost / consec-same-prompt / levels-used → cannot "manually cancel" as the 10a commit message promised. Fix: extend `/logs` handler to forward `escalation:` events, or add a separate `/api/runs/:runId/events` endpoint.
2. `ANTHROPIC_API_KEY` not yet in `os-api/.env` — the direct-backend refactor is live but inert until Tim drops the key.
3. Run 1's orphan artifact (`cc98c1c1-...`) in the DB lacks `metadata.localPath`. Harmless (it's in `reviewing` status, no follow-up grade), but worth a cleanup pass before 10d.
4. Original 10c handoff referenced `/api/runs/:runId/stream` — real endpoint is `/api/runs/:runId/logs`. Noted for future handoff accuracy.

**Handoff:** `~/proto_front/.claude/handoffs/2026-04-17-step-10c-closeout-and-10d-prereqs.md` (successor to the historical scope handoff). 10d is gated on the three gaps above + Tim's go-signal.

---

## Step 10d-pre — Vertex SA auth + SSE escalation forwarding LANDED (2026-04-17 PM)

**Commit:** `a961b3b` (`feat(orchestrator): 10d-pre — Vertex SA auth + SSE escalation forwarding + probe assertions`).

Tim's session-start pivot inverted the 10c-2 "drop ANTHROPIC_API_KEY" plan: stay on Vertex (NOT direct Anthropic). Real fix = service-account JSON for headless-stable Vertex auth. Closes 10c-1 + 10c-2 from the Step 10c gap list; 10c-3 partial (Tim GCP action remains). **[SUPERSEDED 2026-04-19 — see "Step 10c-3 CLOSED — Direct Anthropic pivot" section below. Vertex Opus 4.7 regional quota=0 drove re-inversion to direct Anthropic. Vertex path preserved as fallback, reactivates by unsetting ANTHROPIC_API_KEY.]**

### What landed

**10c-1 CLOSED — SSE escalation forwarding wired.**
- `os-api/src/index.ts` `/api/runs/:runId/logs` handler now subscribes to `escalation:${runId}` and forwards events as `data: {type:"escalation", payload:event}\n\n`. Existing log writes unchanged (additive change — no break for legacy consumers).
- Wire shape: payloads with no `type` field at top level are logs; payloads with `type === "escalation"` are escalation events (then inspect inner `payload.type === "watcher_signal"` for watcher signals specifically). The 10a-promised "human watcher can cancel" capability is now live.
- New wire-level contract test `os-api/tests/10c1-sse-escalation-forward.ts` — 18 assertions across 4 scenarios: watcher_signal forwarding, AssetEscalation row forwarding, cleanup unsubscribes correctly, per-runId isolation. ALL PASSED.

**10c-2 CLOSED — Vertex service-account auth wired.**
- `os-api/src/anthropic.ts` `getAnthropicClient()` now picks Vertex auth in this precedence inside the Vertex branch: `GOOGLE_APPLICATION_CREDENTIALS` (service-account JSON via `googleAuth: new GoogleAuth({keyFile, scopes: cloud-platform})`) > `VERTEX_API_KEY` (legacy accessToken) > bare ADC.
- `getVertexConfig().authMode` union extended with `"service_account"`.
- Service account: `vertex-anthropic@bran-479523.iam.gserviceaccount.com`. Key at `~/agent-vault/secrets/vertex-anthropic-bran-479523.json` (chmod 600, gitignored via new `secrets/` exclusion in `agent-vault/.gitignore`). `os-api/.env` adds `GOOGLE_APPLICATION_CREDENTIALS=...`. `.env.example` documents the new precedence.
- `invalid_rapt` reauth churn eliminated. Verified `backend=vertex, authMode=service_account` in live probe.

**10c-3 PARTIAL — Tim GCP action needed.**
- `os-api/tests/10c-vertex-websearch-probe.ts` hardened with explicit asserts (webSearchCount + toolUses + text length) + dotenv path resolution.
- Live probe: auth ✅, but persistent **429 RESOURCE_EXHAUSTED** on Claude Opus 4.7 for `bran-479523`. Persistent across 60s wait; bare no-tools call also 429s.
- Independent Python `anthropic[vertex]` SDK probe (Tim's diagnostic ask — install in ephemeral venv, run canonical Anthropic snippet with same SA via `GOOGLE_APPLICATION_CREDENTIALS`) returns IDENTICAL 429 RateLimitError. Rules out our Node code, our SDK version, our auth construction.
- **Project-level quota or Model Garden non-enablement on `bran-479523` for Claude Opus 4.7.** Tim must enable at https://console.cloud.google.com/vertex-ai/model-garden?project=bran-479523 + accept Anthropic TOS click-through. After enablement, re-run probe to close 10c-3.

### Bonus finding (free byproduct of having SA wired)

While the SA was wired, probed Gemini 3.x family availability on Vertex `bran-479523` via the same SA. Findings:

| Model id | Vertex bran-479523 | Notes |
|----------|---------------------|-------|
| `gemini-3.1-pro-preview` (text) | ✅ 200 | Current `GEMINI_VIDEO_CRITIC_VERTEX_MODEL` candidate |
| `gemini-3-pro-preview` (text) | ❌ 404 | Doesn't exist on Vertex (the previous "preview access gated" diagnosis was wrong — it was wrong id all along) |
| `gemini-3-pro-image-preview` (image Pro) | ✅ 200 | Same id as AI Studio default for Temp-gen Pro |
| `gemini-3.1-pro-image-preview` (image Pro) | ❌ 404 | Doesn't exist |
| `gemini-3.1-flash-image-preview` (image Flash) | ✅ 200 | Same id as AI Studio Flash draft |
| `gemini-3-pro-image-001` (image Pro speculated GA) | ❌ 404 | Hypothesized GA-style id was wrong |

Naming inconsistency: Google uses `gemini-3.1-*` for text Pro and Flash image, but `gemini-3-*` (no `.1`) for Pro image. Tim's "3.1 not just 3" rule applies to text Pro and Flash image; image Pro is the inverse.

**Implications (NOT actioned this session, queued):**
- Gemini 3 Vertex preview access brief (`~/agent-vault/briefs/gemini-3-vertex-preview-access.md`) marked RESOLVED — preview was always granted; previous failures were wrong model ids.
- brand-engine video critic Vertex backend: switch on with `GEMINI_VIDEO_CRITIC_BACKEND=vertex` + `GEMINI_VIDEO_CRITIC_VERTEX_MODEL=gemini-3.1-pro-preview` + `GOOGLE_APPLICATION_CREDENTIALS` for SA + restart `:8100`. Separate session.
- Temp-gen image Vertex migration brief Phase 1 effectively done — confirmed Vertex ids are `gemini-3-pro-image-preview` (Pro) and `gemini-3.1-flash-image-preview` (Flash), same as AI Studio. Separate session, post-MV per original deferral.

### Pre-existing dead code surfaced (NOT in scope)

5 unused-symbol LSP warnings in `os-api/src/runner.ts` (lines 18, 32, 119, 215, 263 — TEMP_GEN_VENV, getPythonPath, runCommand, checkBrandEngineHealth, checkTempGenHealth). Likely artifacts from the runner subprocess→FastAPI HTTP refactor. Karl-sized cleanup commit, deferred.

### Gates (all green at session close)

- `npx tsc --noEmit -p os-api`: clean (exit 0)
- 10a readiness: 17/17 (no regression)
- 10c1 SSE escalation forward: 18/18 (new)
- brand-engine 10b pytest: 26/26 (no regression)
- Temp-gen job namespacing pytest: 2/2 (no regression)
- **Total: 63/63 + tsc clean**

**Closeout handoff:** `~/proto_front/.claude/handoffs/2026-04-17-step-10d-pre-closeout.md` (filesystem-only). Includes Tim's GCP action steps + fresh-context kickoff prompt for the post-action session. **Do NOT start 10d in the immediate next session.** 10d is its own ~$20-$120 Veo run.

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

## Step 10c-3 CLOSED — Direct Anthropic pivot (2026-04-19)

**Context:** 10d-pre closed 10c-1 (SSE escalation forwarding) + 10c-2 (Vertex SA auth) but left 10c-3 (web_search live-verified with `toolUses[]`) partial — auth was ✅ on Vertex via SA, but Claude Opus 4.7 returned persistent 429 on `bran-479523` global endpoint. 2026-04-18 session diagnosed the 429 as regional-quota=0 (NOT Model Garden enablement as 2026-04-17 initially thought); `us-east5` returned a specific quota-exceeded message instead of the generic "resource exhausted". Tim filled 3 US multi-region quota-increase forms in GCP console but paused before submitting (system update). Rather than wait on Google's approval cycle, Tim pivoted 2026-04-19: switch the orchestrator backend to direct Anthropic API with a $50 starter credit.

**What shipped (pending commit at time of log entry):**

- `ANTHROPIC_API_KEY` set in `os-api/.env`. `getAnthropicClient()` at `os-api/src/anthropic.ts:85-90` auto-routes to `@anthropic-ai/sdk` when the key is present, with zero code change needed for the flip itself. All Vertex infra (SA key at `~/agent-vault/secrets/vertex-anthropic-bran-479523.json`, `GOOGLE_APPLICATION_CREDENTIALS`, `VERTEX_API_KEY`) preserved as fallback — reactivates by unsetting `ANTHROPIC_API_KEY`.
- **Surface-drift bug surfaced by the pivot (real value-add):** Claude Opus 4.7 on direct Anthropic API returns 400 `invalid_request_error: temperature is deprecated for this model` when `temperature` is sent. Vertex used to accept and silently ignore the field on this model. `callClaude()` in `os-api/src/anthropic.ts` now treats `temperature` as opt-in (only forwarded when the caller explicitly passes a value). `orchestrator.ts:62` call-site dropped its hardcoded `temperature: 0.1`. Determinism for decision-making is still fine — web_search + JSON-structured output do most of the constraining.
- `brand-engine/.env` cleaned: `ANTHROPIC_API_KEY` removed (brand-engine is Python, uses Gemini + Cohere only, never calls Claude — key was dead weight there, and less env drift = less future leakage surface).
- Module docstrings in `os-api/src/anthropic.ts` flipped: direct = PRIMARY, Vertex = fallback. Future readers (Karl, Jackie, a fresh Brandy) won't be misled by the 2026-04-17-PM "stay on Vertex" language that has now been inverted.

**Probe result (direct path):**

```
=== BACKEND ===
backend: direct
authMode: direct_api_key
project: bran-479523   # echo only; unused on direct path
region: global          # echo only; unused on direct path
model: claude-opus-4-7
getBackend(): direct

=== SUCCESS ===
model:         claude-opus-4-7
stopReason:    end_turn
text:          The current GA Opus model is `claude-opus-4-7` (Claude Opus 4.7, generally available). Source: https://code.claude.com/docs/en/model-config
tokensIn/Out:  495 / 180
cost:          0.062944
latencyMs:     5021
webSearchCount: 1
toolUses:      [ { name: "web_search", id: "srvtoolu_01T7...", input: { query: "Anthropic API Claude Opus model id current GA 2026" } } ]

=== ASSERTIONS PASSED ===
✓ web_search was invoked
✓ toolUses[] populated
✓ response text present
```

**Cost math for 10d (reuse-first pipeline validation against existing 30-shot catalog):**
- **What 10d actually does:** run each of Drift MV's 30 shots through the productized orchestrator pipeline. Per-shot, the orchestrator decides: reuse existing passing asset, regen via L1/L2/L3 where borderline/failing, or HITL. NOT a from-scratch 30-shot generation.
- Orchestrator calls: $0.063/call × ~10 calls/shot × 30 shots = **~$15-19**, under $15 once system-block caching kicks in.
- Veo re-gen: only where the orchestrator decides to regen. Historical (Steps 1-9) shows ~50% of shots had passing assets after the manual escalation ladder; expect ~5-8 re-gens in 10d = $16-26.
- **Realistic 10d total: $35-45**, not the $100+ a from-scratch run would cost. $50 starter credit covers this band. Top up only if re-gen rate runs much higher than projected.
- **No per-production budget cap implemented** — deliberately deferred. Per-shot `PER_SHOT_HARD_CAP_USD=4` still bites. Monitor live via `SELECT SUM(cost_usd) FROM orchestration_decisions WHERE run_id = ...`. Decision: build a production-level cap later if live data says we need one, with the right thresholds informed by actual spend.

**Gates (green at closeout):**
- `npx tsc --noEmit -p os-api`: clean
- 10a readiness: 17/17
- 10c1 SSE escalation forward: 18/18
- Live direct-path probe: SUCCESS + ASSERTIONS PASSED

**10d is UNBLOCKED.** Next fresh session resume: probe → single-shot `/api/runs` dry run → scale to 30. Explicit non-goal in the closure session: do NOT start 10d's full autonomous run — kickoff is a separate session.

**Superseded handoff:** `~/proto_front/.claude/handoffs/2026-04-18-step-10d-pre-quota-pending.md` — quota request was never submitted; Vertex path shelved (preserved as fallback, not being actively pursued).

**Superseded in part (2026-04-19 PM):** the tool version + cost math in this section are pre-10d-pre-flight:
- `web_search_20250305` → `web_search_20260209` (commit `09370a5`; enables dynamic filtering on Opus 4.7 — model spins up `code_execution` alongside `web_search`).
- Pricing constants $15/$75 per M → $5/$25 per M (Opus 4.7 actual).
- Cost formula: prior formula subtracted cache tokens from `input_tokens`, producing negative `cost_usd` on repeat calls; `input_tokens` is already the non-cached remainder in the modern API (fixed).
- Updated projections: orchestrator spend ~$5-8 / shot-run (was ~$15-19 here); total 10d band still $15-45 depending on Veo regen rate.
- Post-upgrade probe cost: ~$0.09/call (up from $0.063 — dynamic filtering uses more output tokens, but per-shot savings dominate).

See `~/proto_front/docs/PREFLIGHT_REPORT.md` (2026-04-19) for the full readiness state.

---

## Step 10d Pre-Flight CLOSED (2026-04-19 PM)

**Commit:** proto_front `09370a5` (`feat(orchestrator): 10d pre-flight — caching optimizations + dry-run verified`) + agent-vault `bef0a38` (ROADMAP/MISSION updates).

**Brief:** `~/agent-vault/briefs/10d-preflight-check.md` — all 5 phases executed.
**Authoritative readiness doc:** `~/proto_front/docs/PREFLIGHT_REPORT.md`.
**10d kickoff handoff (gitignored):** `~/proto_front/.claude/handoffs/2026-04-19-step-10d-kickoff.md`.

**Patches landed:**
- `anthropic.ts` — cost-formula double-subtract fixed; pricing $15/$75 → $5/$25 per M; `web_search_20250305` → `web_search_20260209`; docstring updates.
- `os-api/package.json` — `@anthropic-ai/sdk` promoted from transitive (via vertex-sdk) to explicit dependency (PRIMARY path hygiene).
- 10a readiness gate updated to assert new tool id — 17/17 still green.
- New reusable probes: `10d-pre-cache-hit-probe.ts` (cache write/read on the 5,214-token `SYSTEM_PROMPT` — ASSERTIONS PASSED live) and `10d-pre-data-sanity.ts` (project-scoped Supabase sanity).

**Live evidence:**
- Websearch probe post-upgrade: `cost=$0.091`, dynamic filtering observed (`code_execution` + `web_search` tool-use blocks).
- Cache-hit probe: Call 1 cacheWrite=5214 / cacheRead=0; Call 2 cacheWrite=0 / cacheRead=5214. 5-min ephemeral TTL confirmed working on Opus 4.7 direct.
- Runner dry-run (`mode: ingest` on client_drift-mv): 6s wall-clock, $0 cost, 12 SSE log events, 0 orchestrator calls (as expected for ingest mode), run status `completed`.

**10d gates flipped from UNBLOCKED → GATED.** Two pre-flight-surfaced prereqs remain (not pre-flight blockers — must be resolved before launching the 30-shot run):
1. **Seed the 29 missing Drift MV deliverables in Supabase** — only Shot 20 (from the 10c dry-run) is currently seeded; 30-shot regression needs the full catalog.
2. **Add a "regrade existing artifact" runner path** — the current runner only grades video inside `executeGenerateVideoStage` (fresh gen); the reuse-first 10d plan needs a mode that grades existing artifacts without regenerating.

See PREFLIGHT_REPORT.md §10d Prerequisites for the detailed remediation plan.

---

## Step 10d Session A LANDED (2026-04-20 → 2026-04-21 close)

**Commits:** proto_front `23b41f4` (`feat(orchestrator): 10d Session A — regrade runner path + Drift MV catalog seeder`) + agent-vault `bed2a43`.

**What shipped:**
- `supabase/migrations/008_regrade_run_mode.sql` — `ALTER TYPE run_mode ADD VALUE 'regrade'` (applied live via Management API).
- `os-api/scripts/seed-drift-mv.ts` — seeds campaign `42f62a1d-b9df-57d8-8197-470692733391` ("Drift MV — 30-shot catalog regression (10d)") with 30/30 `campaign_deliverables` + 30/30 `artifacts` (deterministic uuid-v5 ids, `metadata.localPath` to `~/Temp-gen/productions/drift-mv/shots/shot_NN.mp4`, synthetic seed run `bfe328c8-…`).
- Runner + types additions: `RunMode += "regrade"`, `STAGE_DEFINITIONS.regrade`, pure helpers `_shouldSkipDeliverable` + `_decideRegradeStatusTransition`, `regradeOneDeliverable`, `executeRegradeStage`, `getLatestArtifactByDeliverable`. Idempotent (skips `status=approved`).
- Gate: `10d-regrade-runner.ts` — 14/14.
- Live Shot 20 smoke (`2bce7bc9-…`): PASS 4.9 on first `/grade_video` call, $0 orchestrator cost, wall-clock 35s. Reuse-first path proven.

---

## Step 10d Session B CANCELLED — root cause surfaced (2026-04-21 PM)

**Run:** `d5999b91-…` launched 22:30 UTC against the 30-shot catalog; cancelled 23:48 UTC at 9/30 deliverables.

**Spend:** $1.56 orchestrator (19 decisions, L1×7 / L2×3 / L3×9 — 5 consensus tiebreaks fired live) + ~$41.60 Veo regens (13 clips × ~$3.20) = ~$43.16.

**Cancellation trigger:** Tim asked *"is it grading for the music video story or just individual video with no context?"*. Research agent confirmed: critic + orchestrator graded each shot in isolation. Only narrative signal was `deliverable.description` — no shot number, beat, song timing, neighbor shots, or music-video story awareness. Strict technical criteria (morphing / scale_creep / character_drift / atmospheric_creep) misapplied to intentional cinematic stylization. False-failure cascades on shots where stylization was deliberate (Shot 20 front-left lighting, Shot 27 scene-content haze, etc.).

**Positive signals preserved:**
- SSE `watcher_signal` + `escalation` forwarding verified in production (5 escalation events, 2 watcher_signals observed per run).
- Rule 1 consensus path proven live — 5 tiebreaks fired on genuinely borderline shots (Session A only had smoke-level exposure).
- Cost tracking accurate (post-pre-flight patches): orchestrator ~$0.08/call average, within the $5-8 budget projection.

**Schema observation (for follow-up):** `orchestration_decisions.cost` is the live column; 6 docs (PREFLIGHT_REPORT, ESCALATION_LOG, ROADMAP, brief, etc.) reference `cost_usd`. Correction deferred to Chunk 3 close-out per plan.

**Replan:** Session B work scrapped and the 10d arc restructured into three chunks (plan `~/.claude/plans/streamed-watching-cosmos.md`, APPROVED):
1. **Chunk 1 — Backend context awareness** (below).
2. **Chunk 2 — HUD observability MVP** — DeliverableTracker enhancement + ShotDetailDrawer + WatcherSignalsPanel so the operator can watch + pull the plug during Chunk 3.
3. **Chunk 3 — 30-shot regrade relaunch** — reset statuses on the 9 already-touched shots, launch against the new prompts, monitor, close.

---

## Step 10d Chunk 1 LANDED (2026-04-22) — context-aware grading backend

**Commits:** proto_front `9729b04` (`feat(orchestrator): chunk 1 — context-aware grading (narrative envelope + critic/orchestrator prompts)`) + agent-vault `a102e25`.

**Plan:** `~/.claude/plans/happy-dreaming-manatee.md` (Chunk-1 refinement of the parent plan; validated against live code state before writing).

**Data layer (no migration — rides existing JSONB columns):**
- `artifacts.metadata.narrative_context` on each of 30 seeded video artifacts — `{ shot_number, beat_name, song_start_s, song_end_s, visual_intent, characters[], previous_shot, next_shot, stylization_allowances[], manifest_sha256, ingested_at }`.
- `campaigns.guardrails.music_video_context` on campaign `42f62a1d-…` — `{ title, synopsis, reference_tone, total_shots: 30, track_duration_s, shot_list_summary[30] (≤80 chars each), manifest_sha256, ingested_at }`.
- Ingester: `os-api/scripts/ingest-drift-mv-narrative.ts` — reads `manifest.json` + `qa_prompt_evolution.md`, idempotent via manifest sha256, `DRY=1` + `FORCE=1` flags. Stylization allowances extracted for shots 5/7/15/18/20/27 (v4 overrides v3).

**Design note:** `campaign_deliverables.metadata` + `campaigns.metadata` don't exist in the live schema (only `artifacts.metadata` per migration 004). Approved plan boundary was "no migration" — landed on `artifacts.metadata` + `campaigns.guardrails` instead. This becomes the convention for future music-video campaigns.

**Gemini 3.1 Pro critic (brand-engine):**
- `_build_rails_prompt` + `grade` + `grade_video_with_consensus` + `_frame_extraction_fallback` signatures extended with `narrative_context` + `music_video_synopsis`.
- Self-awareness preamble (only when narrative present): identifies model as Gemini 3.1 Pro, flags known borderline-score variance, directs to STYLIZATION BUDGET before scoring morphing/character_drift/scale_creep as catastrophic.
- `## SHOT POSITION IN MUSIC VIDEO` section (shot N of 30, beat, song timing, visual intent + previous + next summaries).
- `## STYLIZATION BUDGET FOR THIS SHOT` section when allowances non-empty — bullet list + explicit *"VERDICT RULES stay fixed"* rail.
- VERDICT RULES + CRITERIA + OUTPUT SCHEMA are byte-identical with/without narrative (test `test_narrative_preserves_rubric_unchanged`).
- `VideoGradeRequest` Pydantic schema extended; `NarrativeContext` + `NeighborShotSlim` Pydantic mirrors added.

**Claude Opus 4.7 orchestrator (os-api):**
- `SYSTEM_PROMPT` constant → `buildSystemPrompt(musicVideoContext?)` function with self-awareness preamble prepended. `SYSTEM_PROMPT` alias preserved for backwards compat.
- `MUSIC VIDEO CONTEXT` section appended to SYSTEM prompt when mvc provided (synopsis + reference tone + `Full shot list` — 30 entries, cache-stable prefix across per-shot calls).
- `buildUserMessage` extended with `narrativeContext` param → injects `SHOT POSITION`, `NEIGHBOR SHOTS`, `STYLIZATION BUDGET` sections after `CAMPAIGN CONTEXT`.
- Continuity rule appended to `YOUR TASK` footer (prefer L3 accept when neighbors already PASS, unless BLOCKING failure_mode).
- Runner threads `narrative_context` + `music_video_synopsis` into `/grade_video` payload (runner.ts line 1164); escalation_loop threads `narrativeContext` + `musicVideoContext` into `OrchestratorInput` (line 226).
- Envelope extraction helpers `_extractNarrativeContext` / `_extractMusicVideoContext` (shape guards, defensive against missing/malformed envelopes).

**Verification — 8 gate buckets green:**
- `10a-readiness` 17/17.
- `10d-pre-cache-hit-probe` — cache write 5387 / read 5387 tokens (preamble added ~173 tokens to cache-stable prefix; still 12% of uncached cost across 59 per-shot reads).
- `10d-regrade-runner` 14/14.
- **New** `_10d-narrative-prompt-shape` 17/17 — buildSystemPrompt MV + non-MV modes, buildUserMessage with/without narrative, shot 1 + shot 30 edge cases, section ordering, allowances-empty omission, `SYSTEM_PROMPT` alias match.
- **New** `_10d-narrative-ingest-probe` 19/19 — campaign mvc + all 30 artifact envelopes + shot_number consistency + previous/next null-edge + stylization allowances on shots 5/7/15/18/20/27 + manifest_sha256 consistency + localPath preservation from seed.
- **New** `_10d-narrative-live-probe` — Shot 20 PASS 5.0 (Session A was 4.9 — **no regression**; prompt shaping did not degrade the critic).
- `pytest` 36/36 (26 existing + 10 new `test_narrative_prompt.py` — rubric-unchanged invariant, shot 1 + shot 30 null-neighbor handling, frame-strip tiebreak path also gets envelope).
- `tsc --noEmit -p os-api` clean.

**Next:** Chunk 2 (HUD observability MVP) — handoff at `.claude/handoffs/2026-04-21-chunk-2-front-end-observability.md` (gitignored). Ready-for-`/clear`. Chunk 3 (regrade relaunch) follows.

---

## Maintenance

- **Living DB:** query via `SELECT * FROM known_limitations ORDER BY times_encountered DESC;`
- **Audit trail:** query via `SELECT * FROM orchestration_decisions WHERE run_id = '...';`
- **Per-artifact state:** query via `SELECT * FROM asset_escalations WHERE artifact_id = '...';`
- **Update this doc manually after resolving non-trivial escalations** — the DB is source of truth, but this doc is the human-readable narrative for onboarding and archaeology.
