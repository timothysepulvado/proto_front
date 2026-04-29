# `/grade_image_v2` — Stills Critic Endpoint (ADR-004 Phase A)

> **Status:** Production (Phase A landed 2026-04-29)
> **Sidecar:** `brand-engine` on port `8100`
> **Source:** `proto_front/brand-engine/brand_engine/api/server.py` route `grade_image_v2_route`
> **Implementation:** `proto_front/brand-engine/brand_engine/core/image_grader.py`
> **Source of truth (schema):** `brand_engine.core.models.ImageGradeResult`
> **TypeScript mirror:** `os-api/src/types.ts` — `ImageGradeResult`

---

## Purpose

Score a single rendered still image against the 6-criterion stills rubric using
Gemini 3 Pro Vision. Returns a structured verdict (`PASS | WARN | FAIL`) + a
narrowed escalation recommendation (`ship | L1_prompt_fix | L2_approach_change
| L3_redesign`). Phase B's `mode: "stills"` runner consumes this once per shot;
Phase E's HUD audit-mode operator surface displays the triage table.

Two operating modes:

| Mode | Pivot history | Rules 6+7 | Use case |
|---|---|---|---|
| `audit` | None | Skipped | Score a shot in isolation (pre-Veo readiness check, batch triage) |
| `in_loop` | List of prior iters | Active | Score during regen iteration (consume history; degenerate-loop guard) |

---

## Request

`POST http://localhost:8100/grade_image_v2`

```json
{
  "image_path": "/Users/.../Temp-gen/productions/drift-mv/stills/shot_05.png",
  "still_prompt": "A photographic still — NOT a 3D render. Brandy's hand performs...",
  "narrative_beat": {
    "shot_number": 5,
    "section": "hook_1",
    "start_s": 29,
    "end_s": 35,
    "visual": "Brandy's hand performs a slow, elegant telekinetic gesture, holding a stabilized warm light...",
    "characters_needed": ["brandy"]
  },
  "story_context": {
    "brief_md": "...content of BRIEF.md (caller pre-loads)...",
    "narrative_md": "...content of NARRATIVE.md...",
    "lyrics_md": "...content of LYRICS.md..."
  },
  "anchor_paths": [
    "/Users/.../Temp-gen/productions/drift-mv/anchors/brandy_anchor.png"
  ],
  "reference_paths": [
    "/Users/.../Temp-gen/productions/drift-mv/stills/shot_22.png"
  ],
  "pivot_rewrite_history": null,
  "mode": "audit",
  "shot_number": 5
}
```

### Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `image_path` | `string` | yes | Absolute filesystem path. Sidecar must have read access. |
| `still_prompt` | `string` | yes | The prompt that produced this image. **Hard limit: 2000 chars.** Pre-flight rejects with HTTP 422. |
| `narrative_beat` | `object` | yes | Manifest shot N entry: `visual`, `characters_needed`, `section`, `shot_number`. |
| `story_context` | `object` | no | Pre-loaded BRIEF.md / NARRATIVE.md / LYRICS.md content. Sidecar does not read filesystem. |
| `anchor_paths` | `string[]` | no | Character anchor PNG paths (e.g. `brandy_anchor.png`). |
| `reference_paths` | `string[]` | no | Quality-bar exemplar shipped stills. |
| `pivot_rewrite_history` | `array \| null` | no | `null` for audit mode; iter records for in_loop. |
| `mode` | `"audit" \| "in_loop"` | no | Defaults to `audit`. |
| `shot_number` | `int \| null` | no | Optional override of `narrative_beat.shot_number`. |

---

## Response

`200 OK` — `ImageGradeResult`

```json
{
  "verdict": "PASS",
  "aggregate_score": 4.46,
  "criteria": [
    {"name": "character_consistency", "score": 4.5, "notes": "Glove signature matches Brandy wardrobe DNA"},
    {"name": "hand_anatomy", "score": 4.2, "notes": "Thumb-across-index cup clean"},
    {"name": "mech_color_identity", "score": 5.0, "notes": "n/a — no mechs in frame"},
    {"name": "composition", "score": 4.8, "notes": "Off-center lower-left third executed"},
    {"name": "narrative_alignment", "score": 4.3, "notes": "Restrained-energy beat satisfied"},
    {"name": "aesthetic_match", "score": 4.9, "notes": "Tyler Hicks tradition fully restored"}
  ],
  "detected_failure_classes": [],
  "confidence": 0.88,
  "summary": "Pivot loop iter 1 successfully resolved both audit-flagged failure classes.",
  "reasoning": "All 6 criteria score ≥4.0 with aggregate 4.46. Documentary-dry mantra restored.",
  "recommendation": "ship",
  "model": "gemini-3.1-pro-preview",
  "cost": 0.10,
  "latency_ms": 12500,
  "shot_number": 5,
  "image_path": "/Users/.../shot_05.png",
  "new_candidate_limitation": null
}
```

### Recommendation values (narrowed for stills)

| Value | When to fire |
|---|---|
| `ship` | PASS verdict — no action needed, lock the shot |
| `L1_prompt_fix` | WARN, fixable with targeted prompt rewrite (apply known mitigation) |
| `L2_approach_change` | WARN/FAIL — needs camera/lighting/composition change |
| `L3_redesign` | FAIL against blocking known_limitation — must redesign or replace |

The video-class union values `L3_escalation` and `L3_accept_with_trim` are **not** part of the stills schema and will be normalized to `L3_redesign` if the model emits them.

---

## Error codes

| Code | Meaning | Cause |
|---|---|---|
| `200` | OK | Verdict returned (including synthetic FAIL on image-load failure) |
| `422` | Unprocessable Entity | `still_prompt` exceeds 2000-char NB Pro hard limit. Orchestrator must shorten before retry. |
| `404` | Not Found | (Reserved — image-load failures return 200 with verdict=FAIL instead) |
| `502` | Bad Gateway | Gemini critic returned malformed JSON (truncation recovery exhausted) |
| `500` | Internal Server Error | Unexpected exception — check sidecar logs |

429s from Gemini are **not surfaced** — the endpoint retries internally with exponential backoff (1s → 2s → 4s, 3 attempts). If all retries exhaust, the underlying `google-genai` exception propagates as a 500.

---

## Curl example — audit mode

```bash
curl -sS -X POST http://localhost:8100/grade_image_v2 \
  -H "Content-Type: application/json" \
  -d @- <<'EOF' | jq '.aggregate_score, .verdict, .recommendation'
{
  "image_path": "/Users/timothysepulvado/Temp-gen/productions/drift-mv/stills/shot_05.png",
  "still_prompt": "A photographic still — NOT a 3D render. Brandy's hand cups a stabilized warm light...",
  "narrative_beat": {
    "shot_number": 5,
    "section": "hook_1",
    "visual": "Brandy's hand performs a restrained telekinetic gesture",
    "characters_needed": ["brandy"]
  },
  "story_context": {},
  "anchor_paths": ["/Users/timothysepulvado/Temp-gen/productions/drift-mv/anchors/brandy_anchor.png"],
  "reference_paths": ["/Users/timothysepulvado/Temp-gen/productions/drift-mv/stills/shot_22.png"],
  "pivot_rewrite_history": null,
  "mode": "audit"
}
EOF
```

Expected (Drift MV shot 5 iter 1 baseline): `aggregate ~4.46`, `verdict "PASS"`, `recommendation "ship"`. Phase A acceptance gate is ±0.3 from this baseline.

---

## Curl example — in_loop with pivot history (Rule 6 + 7)

```bash
curl -sS -X POST http://localhost:8100/grade_image_v2 \
  -H "Content-Type: application/json" \
  -d @- <<'EOF' | jq
{
  "image_path": "/Users/timothysepulvado/Temp-gen/productions/drift-mv/stills/shot_05.png",
  "still_prompt": "...prompt for iter 2...",
  "narrative_beat": {"shot_number": 5, "section": "hook_1", "visual": "...", "characters_needed": ["brandy"]},
  "story_context": {},
  "anchor_paths": [],
  "reference_paths": [],
  "pivot_rewrite_history": [
    {
      "iter": 1,
      "audit_critic_verdict": {
        "aggregate_score": 3.50,
        "detected_failure_classes": ["magical_aura_overinterpretation"]
      },
      "orchestrator_decision": {"level": "L1", "failure_class": "magical_aura_overinterpretation"}
    }
  ],
  "mode": "in_loop"
}
EOF
```

In `in_loop` mode, the critic is required to consume `pivot_rewrite_history`
and apply Rule 7 (degenerate-loop guard) — same `failure_class` repeating in
two consecutive iters without ≥0.3 score movement triggers auto-escalation
from L1 → L2 → L3 regardless of the score gate.

---

## Performance SLO

- **p99 latency:** < 30s on a 2K still (Gemini 3 Pro Vision baseline)
- **429 retry budget:** 3 attempts (1s + 2s + 4s = 7s max in retries)
- **Cost target:** ~$0.10 per call (audit-mode) — Phase F instrumentation publishes
  `cost_usd_per_still_cumulative` per `(campaign_id, shot_id)` for budget tracking

---

## Observability (Phase F)

Every call emits one structured `logger.info` JSON line tagged `event=critic_call`:

```json
{
  "trace_id": "a3f9c8b21e04",
  "event": "critic_call",
  "mode": "audit",
  "image_path": "/.../shot_05.png",
  "prompt_len": 1842,
  "latency_ms": 12500,
  "aggregate_score": 4.46,
  "verdict": "PASS",
  "recommendation": "ship",
  "failure_classes": [],
  "shot_number": 5
}
```

`trace_id` honors the `BRAND_ENGINE_TRACE_ID` env var if present (caller-propagated), else a fresh hex-12 is generated. Phase B's runner sets this on every fan-out so audit-mode runs roll up cleanly in log aggregators.

---

## Rollback / failure modes

1. **Sidecar down → 503 from os-api caller** — Phase B feature-flags `STILLS_MODE_ENABLED`; flip to false to halt all `mode: "stills"` runs.
2. **Gemini quota exhausted** — endpoint retries 3x then surfaces as 500. Operator should monitor `429`-rate alerts (Phase F).
3. **Supabase known_limitations unreachable** — endpoint degrades gracefully to criterion-only grading (no catalog patterns probed). Logged as warning.
4. **Image path not readable** — endpoint returns 200 with synthetic `verdict=FAIL` and `reasoning="image could not be loaded: <path>"`. No exception raised — the runner can decide whether to retry, escalate to HITL, or fail the shot.

---

## Test harness

- Behavior tests: `proto_front/brand-engine/tests/test_grade_image_v2.py` (Phase A acceptance gate)
- Internals tests: `proto_front/brand-engine/tests/test_image_grader_internals.py`
- Loader tests: `proto_front/brand-engine/tests/test_known_limitations_loader.py`
- Coverage: ≥80% required (currently 95%)

```bash
cd ~/proto_front/brand-engine && python -m pytest tests/test_grade_image_v2.py \
  tests/test_image_grader_internals.py tests/test_known_limitations_loader.py -v \
  --cov=brand_engine.core.image_grader \
  --cov=brand_engine.core.known_limitations_loader \
  --cov-fail-under=80
```

Live smoke against the Drift MV shot 5 iter 1 baseline (4.46 ±0.3) is opt-in:

```bash
SMOKE_LIVE=1 python -m pytest tests/test_grade_image_v2.py::TestGradeImageV2Smoke -v
```

(Phase A wires the `SMOKE_LIVE=1` env-var check; today the smoke is hardcoded
skipif until a manifest-loader helper lands in Phase B.)
