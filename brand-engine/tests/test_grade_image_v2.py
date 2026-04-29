"""Gate test for `brand-engine` image-class critic — `/grade_image_v2`.

Test-first scaffold for ADR-004 Phase A. Until the implementation lands in
`brand_engine.core.image_grader` (or wherever Phase A author chooses to put
it), these tests will fail at import — that's the point of test-first.

Phase A acceptance gate (per
`~/agent-vault/briefs/2026-04-29-phase-c-stills-mode-runner-and-image-grading.md`
Phase A section):
- pytest passes (4+ tests)
- Curl smoke matches manual run on shot #5 iter 1 within ±0.3 aggregate score
- Endpoint returns within 30s wall-clock on a 2K image (Gemini 3.1 Pro Vision baseline)

Run via:
    cd brand-engine && python -m pytest tests/test_grade_image_v2.py -v

When implementation lands, these tests should:
1. Pass on a recorded fixture (no live Gemini calls in CI — use respx or VCR
   to record a single live call and replay).
2. Cover: audit-mode happy path, in-loop with Rule 6 history consumption,
   Rule 7 degenerate-loop escalation, image-load-failure graceful FAIL,
   2000-char prompt rejection (pre-flight), JSON-only output validation.

Production rigor: every test should also assert on the structured-log emission
(Phase F observability) once Phase F lands. For now, log assertions are TODO.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

# Test-first: this import will fail until Phase A implementation lands.
# When Phase A author creates the module, update this import to match.
# Suggested module path: brand_engine.core.image_grader
# Suggested function: grade_image_v2(...)
pytest.importorskip("brand_engine.core.image_grader", reason="Phase A pending — module not yet created")

from brand_engine.core.image_grader import grade_image_v2  # noqa: E402


# ─── Test fixtures ──────────────────────────────────────────────────────────

DRIFT_MV_ROOT = Path.home() / "Temp-gen" / "productions" / "drift-mv"
SHOT_5_ITER_1_IMAGE = DRIFT_MV_ROOT / "stills" / "shot_05.png"

SAMPLE_NARRATIVE_BEAT = {
    "shot_number": 5,
    "section": "hook_1",
    "start_s": 29,
    "end_s": 35,
    "visual": "Brandy's hand performs a slow, elegant telekinetic gesture, holding a stabilized warm light. There are no explosive shockwaves, just restrained and controlled energy.",
    "characters_needed": ["brandy"],
    "still_prompt": "...placeholder for fixture...",
}

SAMPLE_STORY_CONTEXT = {
    "brief_md": "...truncated for fixture...",
    "narrative_md": "...truncated for fixture...",
    "lyrics_md": "...truncated for fixture...",
}

SAMPLE_ANCHOR_PATHS = [
    str(DRIFT_MV_ROOT / "anchors" / "brandy_anchor.png"),
]

SAMPLE_REFERENCE_PATHS = [
    str(DRIFT_MV_ROOT / "stills" / "shot_22.png"),
    str(DRIFT_MV_ROOT / "stills" / "shot_23.png"),
]

# Pivot history mirroring the shot 5 audit-driven L1 fix that shipped 2026-04-29
SHOT_5_PIVOT_HISTORY_AFTER_ITER_1 = [
    {
        "iter": 1,
        "timestamp": "2026-04-29T19:36:00Z",
        "trigger": "audit_2026-04-29_15_shots_baseline_critic",
        "audit_critic_verdict": {
            "verdict": "WARN",
            "aggregate_score": 3.92,
            "detected_failure_classes": ["magical_aura_overinterpretation", "ember_glow_overinterpretation"],
            "recommendation": "L1_prompt_fix",
        },
        "orchestrator_decision": {
            "level": "L1",
            "action": "regenerate",
            "failure_class": "magical_aura_overinterpretation",
        },
    }
]

# Pivot history simulating a degenerate loop — same failure_class 2x without score movement
DEGENERATE_LOOP_PIVOT_HISTORY = [
    {
        "iter": 1,
        "timestamp": "2026-04-29T20:00:00Z",
        "audit_critic_verdict": {
            "aggregate_score": 3.50,
            "detected_failure_classes": ["magical_aura_overinterpretation"],
        },
        "orchestrator_decision": {"level": "L1", "failure_class": "magical_aura_overinterpretation"},
    },
    {
        "iter": 2,
        "timestamp": "2026-04-29T20:15:00Z",
        "critic_verdict": {
            "aggregate_score": 3.55,  # +0.05, below 0.3 threshold
            "detected_failure_classes": ["magical_aura_overinterpretation"],
        },
        "orchestrator_decision": {"level": "L1", "failure_class": "magical_aura_overinterpretation"},
    },
]


# ─── Helper — build a valid VideoGradeResult-shaped fixture verdict ─────────

def _ship_verdict_fixture() -> dict[str, Any]:
    """A SHIP verdict matching the 2026-04-29 shot 5 iter 1 in-loop critic result."""
    return {
        "verdict": "PASS",
        "aggregate_score": 4.46,
        "criteria": [
            {"name": "character_consistency", "score": 4.5, "notes": "Glove signature matches Brandy wardrobe DNA"},
            {"name": "hand_anatomy", "score": 4.2, "notes": "Thumb-across-index cup clean"},
            {"name": "mech_color_identity", "score": 5.0, "notes": "n/a — no mechs"},
            {"name": "composition", "score": 4.8, "notes": "Off-center lower-left third executed"},
            {"name": "narrative_alignment", "score": 4.3, "notes": "Restrained-energy beat satisfied"},
            {"name": "aesthetic_match", "score": 4.9, "notes": "Tyler Hicks tradition fully restored"},
        ],
        "detected_failure_classes": [],
        "confidence": 0.88,
        "summary": "Pivot loop iter 1 successfully resolved both audit-flagged failure classes.",
        "reasoning": "All 6 criteria score ≥4.0 with aggregate 4.46. Documentary-dry mantra restored.",
        "recommendation": "ship",
        "model": "gemini-3.1-pro",
        "cost": 0.10,
        "latency_ms": 12500,
    }


# ─── Test cases ─────────────────────────────────────────────────────────────


class TestGradeImageV2AuditMode:
    """Audit-mode: no pivot_rewrite_history; skip Rules 6 + 7 of the rubric."""

    def test_audit_happy_path_ship_verdict_on_shipped_still(self):
        """Audit on a SHIP-grade still returns PASS verdict ≥4.0 with no failure classes."""
        with patch("brand_engine.core.image_grader._call_gemini_vision") as mock_gemini:
            mock_gemini.return_value = json.dumps(_ship_verdict_fixture())

            result = grade_image_v2(
                image_path=str(SHOT_5_ITER_1_IMAGE),
                still_prompt=SAMPLE_NARRATIVE_BEAT["still_prompt"],
                narrative_beat=SAMPLE_NARRATIVE_BEAT,
                story_context=SAMPLE_STORY_CONTEXT,
                anchor_paths=SAMPLE_ANCHOR_PATHS,
                reference_paths=SAMPLE_REFERENCE_PATHS,
                pivot_rewrite_history=None,
                mode="audit",
            )

        assert result["verdict"] == "PASS"
        assert result["aggregate_score"] >= 4.0
        assert result["recommendation"] == "ship"
        assert result["detected_failure_classes"] == []
        assert "L3_accept_with_trim" not in result["recommendation"]  # narrowed union
        # Rule 6 should NOT have been applied (audit mode)
        assert "pivot_rewrite_history" not in result.get("reasoning", "").lower() or \
               "no prior iter" in result.get("reasoning", "").lower()

    def test_audit_skips_rules_6_and_7(self):
        """Audit-mode passes pivot_rewrite_history=None; rubric skips Rules 6 + 7."""
        with patch("brand_engine.core.image_grader._call_gemini_vision") as mock_gemini:
            mock_gemini.return_value = json.dumps(_ship_verdict_fixture())

            result = grade_image_v2(
                image_path=str(SHOT_5_ITER_1_IMAGE),
                still_prompt="...",
                narrative_beat=SAMPLE_NARRATIVE_BEAT,
                story_context=SAMPLE_STORY_CONTEXT,
                anchor_paths=SAMPLE_ANCHOR_PATHS,
                reference_paths=[],
                pivot_rewrite_history=None,
                mode="audit",
            )

        # Verify the system prompt sent to Gemini did NOT include Rule 6/7 application
        call_args = mock_gemini.call_args
        system_prompt = call_args.kwargs.get("system_prompt", call_args.args[0] if call_args.args else "")
        # Rule 6 references should be absent or marked SKIPPED in audit mode
        assert "Rule 6" not in system_prompt or "SKIP Rule 6" in system_prompt or "audit-mode" in system_prompt.lower()


class TestGradeImageV2InLoopMode:
    """In-loop mode: pivot_rewrite_history present; Rules 6 + 7 active."""

    def test_in_loop_consumes_pivot_history_rule_6(self):
        """Rule 6: critic must read pivot_rewrite_history before scoring."""
        with patch("brand_engine.core.image_grader._call_gemini_vision") as mock_gemini:
            verdict = _ship_verdict_fixture()
            verdict["reasoning"] = (
                "Rule 6 consumed: pivot_rewrite_history shows iter 0 (v5 baseline) scored 3.92 WARN. "
                "Iter 1 explicitly checked the orchestrator's expected_failure_modes_for_iter_2_critic_to_check."
            )
            mock_gemini.return_value = json.dumps(verdict)

            result = grade_image_v2(
                image_path=str(SHOT_5_ITER_1_IMAGE),
                still_prompt="...",
                narrative_beat=SAMPLE_NARRATIVE_BEAT,
                story_context=SAMPLE_STORY_CONTEXT,
                anchor_paths=SAMPLE_ANCHOR_PATHS,
                reference_paths=[],
                pivot_rewrite_history=SHOT_5_PIVOT_HISTORY_AFTER_ITER_1,
                mode="in_loop",
            )

        assert "rule 6" in result["reasoning"].lower() or "pivot_rewrite_history" in result["reasoning"].lower()
        assert result["verdict"] == "PASS"

    def test_in_loop_rule_7_degenerate_loop_escalation(self):
        """Rule 7: same failure_class 2x w/o score movement ≥0.3 → auto-escalate."""
        with patch("brand_engine.core.image_grader._call_gemini_vision") as mock_gemini:
            warn_verdict = {
                **_ship_verdict_fixture(),
                "verdict": "WARN",
                "aggregate_score": 3.55,
                "detected_failure_classes": ["magical_aura_overinterpretation"],
                "recommendation": "L2_approach_change",  # Rule 7 escalated L1 → L2
                "reasoning": (
                    "Rule 7 fired: same failure_class magical_aura_overinterpretation appeared in iter 1 (3.50) "
                    "and iter 2 (3.55), score delta 0.05 < 0.3 — auto-escalating to L2 per degenerate-loop guard."
                ),
            }
            mock_gemini.return_value = json.dumps(warn_verdict)

            result = grade_image_v2(
                image_path=str(SHOT_5_ITER_1_IMAGE),
                still_prompt="...",
                narrative_beat=SAMPLE_NARRATIVE_BEAT,
                story_context=SAMPLE_STORY_CONTEXT,
                anchor_paths=SAMPLE_ANCHOR_PATHS,
                reference_paths=[],
                pivot_rewrite_history=DEGENERATE_LOOP_PIVOT_HISTORY,
                mode="in_loop",
            )

        assert result["recommendation"] == "L2_approach_change"
        assert "rule 7" in result["reasoning"].lower() or "degenerate" in result["reasoning"].lower()


class TestGradeImageV2ErrorHandling:
    """Production rigor: graceful degradation on input errors."""

    def test_image_load_failure_returns_fail_verdict(self):
        """Bad image path → graceful FAIL with reasoning (not 5xx, not crash)."""
        result = grade_image_v2(
            image_path="/nonexistent/path/shot_99.png",
            still_prompt="...",
            narrative_beat=SAMPLE_NARRATIVE_BEAT,
            story_context=SAMPLE_STORY_CONTEXT,
            anchor_paths=[],
            reference_paths=[],
            pivot_rewrite_history=None,
            mode="audit",
        )

        assert result["verdict"] == "FAIL"
        assert "image" in result["reasoning"].lower() or "could not be loaded" in result["reasoning"].lower()
        assert result["recommendation"] in ("L3_redesign", "ship")  # implementation choice; document in Phase A

    def test_2000_char_prompt_rejected_pre_flight(self):
        """Pre-flight: prompts > 2000 chars rejected before Gemini call.

        NB Pro hard limit, productized as orchestrator pre-flight check per
        STILLS_AUDIT_15_SHOTS.md "Productization signal" #3.
        """
        oversized_prompt = "x" * 2001  # 2001 chars > 2000 limit
        with pytest.raises((ValueError, AssertionError)) as exc_info:
            grade_image_v2(
                image_path=str(SHOT_5_ITER_1_IMAGE),
                still_prompt=oversized_prompt,
                narrative_beat=SAMPLE_NARRATIVE_BEAT,
                story_context=SAMPLE_STORY_CONTEXT,
                anchor_paths=[],
                reference_paths=[],
                pivot_rewrite_history=None,
                mode="audit",
            )
        assert "2000" in str(exc_info.value) or "char" in str(exc_info.value).lower()

    def test_markdown_fence_in_response_rejected(self):
        """JSON-only output: response wrapped in ```json fences must be rejected/stripped."""
        with patch("brand_engine.core.image_grader._call_gemini_vision") as mock_gemini:
            # Simulate a model that returns markdown-fenced JSON despite the rubric saying NO
            fenced = "```json\n" + json.dumps(_ship_verdict_fixture()) + "\n```"
            mock_gemini.return_value = fenced

            result = grade_image_v2(
                image_path=str(SHOT_5_ITER_1_IMAGE),
                still_prompt="...",
                narrative_beat=SAMPLE_NARRATIVE_BEAT,
                story_context=SAMPLE_STORY_CONTEXT,
                anchor_paths=SAMPLE_ANCHOR_PATHS,
                reference_paths=[],
                pivot_rewrite_history=None,
                mode="audit",
            )

        # Either: implementation strips the fence transparently, OR raises a clear error.
        # Pick one in Phase A and document the choice.
        assert result["verdict"] == "PASS"  # if stripped transparently
        # If choosing to reject: this test should be replaced with pytest.raises


class TestGradeImageV2Smoke:
    """Live smoke against the 2026-04-29 manual audit baseline.

    Skipped by default; opt-in via env var SMOKE_LIVE=1.
    Verifies the curl smoke gate: audit Drift MV shot 5 iter 1 within ±0.3
    aggregate score of the manual run (4.46).
    """

    @pytest.mark.skipif(
        not (Path.home() / "Temp-gen" / "productions" / "drift-mv" / "stills" / "shot_05.png").exists(),
        reason="Drift MV shot_05.png not present; live smoke skipped",
    )
    @pytest.mark.skipif(
        True,  # opt-in only; flip to env-var check in Phase A
        reason="Live smoke opt-in via SMOKE_LIVE=1 (TODO Phase A: wire to env)",
    )
    def test_live_smoke_shot_5_iter_1_matches_manual_audit(self):
        """Smoke: live Gemini call on shot 5 iter 1 → expect ~4.46 ±0.3 aggregate."""
        # No mock — this is a live test
        result = grade_image_v2(
            image_path=str(SHOT_5_ITER_1_IMAGE),
            still_prompt="...load actual prompt from manifest...",
            narrative_beat=SAMPLE_NARRATIVE_BEAT,
            story_context=SAMPLE_STORY_CONTEXT,
            anchor_paths=SAMPLE_ANCHOR_PATHS,
            reference_paths=SAMPLE_REFERENCE_PATHS,
            pivot_rewrite_history=None,
            mode="audit",
        )

        # ±0.3 tolerance per brief Phase A acceptance gate
        assert 4.16 <= result["aggregate_score"] <= 4.76
        assert result["verdict"] == "PASS"
        assert result["recommendation"] == "ship"


# ─── Production rigor TODOs (Phase F integration) ───────────────────────────
#
# When Phase F (observability) lands, add to every test above:
#
# 1. Assert structured-log emission:
#    with caplog.at_level(logging.INFO):
#        result = grade_image_v2(...)
#    assert any("critic_verdict" in r.message for r in caplog.records)
#
# 2. Assert metric emission (cost_usd_per_still_cumulative, endpoint_latency_ms,
#    critic_verdict_aggregate_score histogram bucket).
#
# 3. Assert trace_id propagation (X-Trace-Id header round-trip).
#
# 4. Cost-cap test: exceed STILLS_PER_SHOT_COST_CAP_USD → expect
#    `asset_escalations` row written + warning log.
