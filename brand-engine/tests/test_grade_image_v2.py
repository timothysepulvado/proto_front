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
from brand_engine.core.models import ImageGradeRequest  # noqa: E402
from pydantic import ValidationError  # noqa: E402


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


# ─── Phase 4 (2026-04-30) — Direction-drift deductions + campaign axiom ────
#
# Migration 012 introduced `<<DEDUCT: criterion=-N.N, ...>>` markers in
# `known_limitations.mitigation` text. The critic rubric now:
#   1. Tells the model to apply deductions when it flags the failure_class.
#   2. Defensively re-applies deductions server-side
#      (_apply_failure_class_deductions) — idempotent if the model already did.
#   3. Recomputes aggregate from post-deduction criteria scores when any
#      deduction fires.
#
# Plus: a `## CAMPAIGN DIRECTION` section is emitted into the system prompt
# when `story_context.directional_history` is provided, carrying the canonical
# mantra + abandoned_directions list. This closes the loop on Tim's 2026-04-30
# observation that some Drift MV stills regressed back to mech-heavy after
# the 2026-04-25 aftermath/realistic pivot.
#
# These three tests pin the new behavior:


# Two minimal catalog fixtures matching migration 012 shape (just the fields
# the deduction logic needs — failure_mode + severity + mitigation).
_CATALOG_WITH_DEDUCT = [
    {
        "failure_mode": "campaign_direction_reversion_mech_heavy",
        "severity": "blocking",
        "mitigation": (
            "<<DEDUCT: narrative_alignment=-1.5, aesthetic_match=-1.0>> "
            "When detected, deduct 1.5 from narrative_alignment AND 1.0 from "
            "aesthetic_match."
        ),
    },
    {
        "failure_mode": "literal_split_screen_for_panning_reveal",
        "severity": "blocking",
        "mitigation": "<<DEDUCT: composition=-2.0, narrative_alignment=-1.0>> Strip pan/zoom language.",
    },
    {
        "failure_mode": "ember_glow_overinterpretation",
        "severity": "warning",
        "mitigation": "Use STRONGER positive language. (No DEDUCT marker — pre-012 catalog row.)",
    },
]


def _ship_verdict_with_failure_class(
    failure_classes: list[str],
    aggregate_score: float = 4.5,
    narrative_alignment: float = 4.5,
    aesthetic_match: float = 4.8,
    composition: float = 4.7,
) -> dict[str, Any]:
    """Verdict fixture with overridable scores so tests can simulate the
    model NOT having self-applied deductions."""
    base = _ship_verdict_fixture()
    base["detected_failure_classes"] = failure_classes
    base["aggregate_score"] = aggregate_score
    # Inline-override criteria scores for the three we test deductions on.
    for c in base["criteria"]:
        if c["name"] == "narrative_alignment":
            c["score"] = narrative_alignment
        elif c["name"] == "aesthetic_match":
            c["score"] = aesthetic_match
        elif c["name"] == "composition":
            c["score"] = composition
    return base


class TestGradeImageV2DirectionDriftDeductions:
    """Phase 4 (migration 012) — server-side enforcement of `<<DEDUCT>>`.

    Smoke #4 (2026-04-29) found the catalog-aware critic was too generous —
    the existing mitigation text described FIXES, not DEDUCTIONS. Migration
    012 added penalty-shaped markers; these tests pin that the server applies
    them defensively even when the model self-scores at the un-deducted level.
    """

    def test_no_failure_classes_means_no_deductions(self):
        """Sanity: no detected_failure_classes → no deductions, scores unchanged."""
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
                known_limitations=_CATALOG_WITH_DEDUCT,
            )
        # Aggregate unchanged from fixture (4.46) within rounding tolerance.
        assert abs(result["aggregate_score"] - 4.46) < 0.01, (
            f"Expected aggregate ~4.46 (no deductions), got {result['aggregate_score']}"
        )
        assert result["verdict"] == "PASS"

    def test_direction_reversion_failure_class_applies_deductions(self):
        """Migration 012: campaign_direction_reversion_mech_heavy → -1.5/-1.0."""
        # Model returns scores AS IF it didn't apply deductions (4.5 and 4.8).
        # Server should defensively apply -1.5 from narrative_alignment and
        # -1.0 from aesthetic_match → 3.0 and 3.8. Aggregate recomputes.
        verdict = _ship_verdict_with_failure_class(
            failure_classes=["campaign_direction_reversion_mech_heavy"],
            narrative_alignment=4.5,  # pre-deduction
            aesthetic_match=4.8,      # pre-deduction
        )
        with patch("brand_engine.core.image_grader._call_gemini_vision") as mock_gemini:
            mock_gemini.return_value = json.dumps(verdict)
            result = grade_image_v2(
                image_path=str(SHOT_5_ITER_1_IMAGE),
                still_prompt="...",
                narrative_beat=SAMPLE_NARRATIVE_BEAT,
                story_context=SAMPLE_STORY_CONTEXT,
                anchor_paths=SAMPLE_ANCHOR_PATHS,
                reference_paths=[],
                pivot_rewrite_history=None,
                mode="audit",
                known_limitations=_CATALOG_WITH_DEDUCT,
            )
        # Find post-deduction criteria scores in the result.
        crit_by_name = {c["name"]: c for c in result["criteria"]}
        assert crit_by_name["narrative_alignment"]["score"] == pytest.approx(3.0, abs=0.01), (
            f"narrative_alignment: expected 3.0 (4.5 - 1.5), got {crit_by_name['narrative_alignment']['score']}"
        )
        assert crit_by_name["aesthetic_match"]["score"] == pytest.approx(3.8, abs=0.01), (
            f"aesthetic_match: expected 3.8 (4.8 - 1.0), got {crit_by_name['aesthetic_match']['score']}"
        )
        # Aggregate must be RECOMPUTED from post-deduction criteria — it should
        # be lower than the model-emitted aggregate_score=4.5.
        assert result["aggregate_score"] < 4.5, (
            f"Aggregate not recomputed post-deduction: {result['aggregate_score']}"
        )

    def test_idempotency_no_double_deduction_when_model_self_applied(self):
        """Idempotency: if model already self-applied deductions, server doesn't double-punish.

        Tolerance check inside _apply_failure_class_deductions: when criterion
        is already at-or-below post-deduction floor, server skips re-applying.
        """
        # Model returns scores AS IF it correctly self-applied deductions
        # already (3.0 and 3.8 — i.e. 4.5-1.5 and 4.8-1.0 already done).
        verdict = _ship_verdict_with_failure_class(
            failure_classes=["campaign_direction_reversion_mech_heavy"],
            narrative_alignment=3.0,  # post-deduction
            aesthetic_match=3.8,      # post-deduction
        )
        with patch("brand_engine.core.image_grader._call_gemini_vision") as mock_gemini:
            mock_gemini.return_value = json.dumps(verdict)
            result = grade_image_v2(
                image_path=str(SHOT_5_ITER_1_IMAGE),
                still_prompt="...",
                narrative_beat=SAMPLE_NARRATIVE_BEAT,
                story_context=SAMPLE_STORY_CONTEXT,
                anchor_paths=SAMPLE_ANCHOR_PATHS,
                reference_paths=[],
                pivot_rewrite_history=None,
                mode="audit",
                known_limitations=_CATALOG_WITH_DEDUCT,
            )
        # Server must NOT have deducted again — scores stay at the model's
        # already-applied values.
        crit_by_name = {c["name"]: c for c in result["criteria"]}
        assert crit_by_name["narrative_alignment"]["score"] == pytest.approx(3.0, abs=0.05), (
            f"Double-deducted! narrative_alignment expected 3.0, got "
            f"{crit_by_name['narrative_alignment']['score']}"
        )
        assert crit_by_name["aesthetic_match"]["score"] == pytest.approx(3.8, abs=0.05), (
            f"Double-deducted! aesthetic_match expected 3.8, got "
            f"{crit_by_name['aesthetic_match']['score']}"
        )


class TestGradeImageV2CampaignDirectionAxiom:
    """Phase 4 (2026-04-30) — `## CAMPAIGN DIRECTION` section in the system prompt.

    When story_context.directional_history is provided (manifest carries it
    after the Phase 8 Drift MV manifest update), the critic system prompt
    must emit a CAMPAIGN DIRECTION section with mantra + abandoned_directions.
    This is the data substrate that lets the critic apply direction-integrity
    as a hard rule rather than inferring it from BRIEF.md prose.
    """

    def test_campaign_direction_section_emitted_when_directional_history_present(self):
        """story_context.directional_history → ## CAMPAIGN DIRECTION in prompt."""
        story_context_with_direction = {
            **SAMPLE_STORY_CONTEXT,
            "directional_history": {
                "current_direction_mantra": (
                    "Cinematically beautiful · Documentary dry · No effects/gloss/polish · Nothing falling"
                ),
                "current_direction_summary": "Aftermath / realistic / documentary-dry.",
                "abandoned_directions": [
                    {
                        "name": "mech_heavy_hero_framing",
                        "rejected_at": "2026-04-25",
                        "reason": "Tim pivoted to aftermath/realistic.",
                    }
                ],
            },
        }
        with patch("brand_engine.core.image_grader._call_gemini_vision") as mock_gemini:
            mock_gemini.return_value = json.dumps(_ship_verdict_fixture())
            grade_image_v2(
                image_path=str(SHOT_5_ITER_1_IMAGE),
                still_prompt="...",
                narrative_beat=SAMPLE_NARRATIVE_BEAT,
                story_context=story_context_with_direction,
                anchor_paths=SAMPLE_ANCHOR_PATHS,
                reference_paths=[],
                pivot_rewrite_history=None,
                mode="audit",
                known_limitations=_CATALOG_WITH_DEDUCT,
            )
        # The system_prompt is the last positional arg or kwargs in the call.
        call = mock_gemini.call_args
        system_prompt = call.kwargs.get("system_prompt") or (
            call.args[0] if call.args else ""
        )
        assert "## CAMPAIGN DIRECTION" in system_prompt, (
            "CAMPAIGN DIRECTION section missing from system prompt"
        )
        assert "Cinematically beautiful" in system_prompt
        assert "ABANDONED DIRECTIONS" in system_prompt
        assert "mech_heavy_hero_framing" in system_prompt
        assert "Direction integrity" in system_prompt or "direction integrity" in system_prompt.lower()

    def test_campaign_direction_section_absent_when_directional_history_missing(self):
        """No directional_history → no ## CAMPAIGN DIRECTION section (back-compat)."""
        # Plain story_context without directional_history (legacy campaigns).
        with patch("brand_engine.core.image_grader._call_gemini_vision") as mock_gemini:
            mock_gemini.return_value = json.dumps(_ship_verdict_fixture())
            grade_image_v2(
                image_path=str(SHOT_5_ITER_1_IMAGE),
                still_prompt="...",
                narrative_beat=SAMPLE_NARRATIVE_BEAT,
                story_context=SAMPLE_STORY_CONTEXT,  # no directional_history key
                anchor_paths=SAMPLE_ANCHOR_PATHS,
                reference_paths=[],
                pivot_rewrite_history=None,
                mode="audit",
                known_limitations=_CATALOG_WITH_DEDUCT,
            )
        call = mock_gemini.call_args
        system_prompt = call.kwargs.get("system_prompt") or (
            call.args[0] if call.args else ""
        )
        assert "## CAMPAIGN DIRECTION" not in system_prompt, (
            "CAMPAIGN DIRECTION emitted when no directional_history was provided"
        )


# ─── PR #2 review item 0.B.22 — request-contract validator ─────────────────


class TestImageGradeRequestValidator:
    """`ImageGradeRequest` enforces `mode='in_loop' → pivot_rewrite_history non-empty`.

    Without this validator a caller could submit `mode='in_loop'` with no history;
    Rules 6 (history consume) and 7 (degenerate-loop guard) silently no-op and
    the in-loop guarantees collapse to audit-mode behavior. Added 2026-05-02
    per PR #2 review item 0.B.22 (brief 2026-05-02-karl-pr2-cleanup-and-followups.md).
    """

    _BASE_KWARGS = {
        "image_path": str(SHOT_5_ITER_1_IMAGE),
        "still_prompt": "test prompt",
        "narrative_beat": SAMPLE_NARRATIVE_BEAT,
        "story_context": SAMPLE_STORY_CONTEXT,
        "anchor_paths": SAMPLE_ANCHOR_PATHS,
        "reference_paths": SAMPLE_REFERENCE_PATHS,
    }

    def test_in_loop_with_none_history_rejected(self):
        """mode='in_loop' + pivot_rewrite_history=None → ValidationError."""
        with pytest.raises(ValidationError) as exc_info:
            ImageGradeRequest(
                **self._BASE_KWARGS,
                pivot_rewrite_history=None,
                mode="in_loop",
            )
        assert "in_loop" in str(exc_info.value).lower()
        assert "pivot_rewrite_history" in str(exc_info.value).lower()

    def test_in_loop_with_empty_list_history_rejected(self):
        """mode='in_loop' + pivot_rewrite_history=[] → ValidationError (empty list is falsy)."""
        with pytest.raises(ValidationError) as exc_info:
            ImageGradeRequest(
                **self._BASE_KWARGS,
                pivot_rewrite_history=[],
                mode="in_loop",
            )
        assert "in_loop" in str(exc_info.value).lower()

    def test_in_loop_with_populated_history_accepted(self):
        """mode='in_loop' + non-empty pivot_rewrite_history → constructs successfully."""
        request = ImageGradeRequest(
            **self._BASE_KWARGS,
            pivot_rewrite_history=SHOT_5_PIVOT_HISTORY_AFTER_ITER_1,
            mode="in_loop",
        )
        assert request.mode == "in_loop"
        assert request.pivot_rewrite_history == SHOT_5_PIVOT_HISTORY_AFTER_ITER_1

    def test_audit_with_none_history_accepted(self):
        """mode='audit' + pivot_rewrite_history=None → constructs successfully (sanity)."""
        request = ImageGradeRequest(
            **self._BASE_KWARGS,
            pivot_rewrite_history=None,
            mode="audit",
        )
        assert request.mode == "audit"
        assert request.pivot_rewrite_history is None

    def test_audit_with_history_accepted(self):
        """mode='audit' + pivot_rewrite_history=[...] → constructs (audit may carry history but won't use it)."""
        request = ImageGradeRequest(
            **self._BASE_KWARGS,
            pivot_rewrite_history=SHOT_5_PIVOT_HISTORY_AFTER_ITER_1,
            mode="audit",
        )
        assert request.mode == "audit"
        # Validator only blocks the inverse (in_loop without history); audit can carry it.

    def test_default_mode_audit_with_no_history_accepted(self):
        """Defaults: mode='audit', pivot_rewrite_history=None → constructs (sanity)."""
        request = ImageGradeRequest(**self._BASE_KWARGS)
        assert request.mode == "audit"
        assert request.pivot_rewrite_history is None


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
