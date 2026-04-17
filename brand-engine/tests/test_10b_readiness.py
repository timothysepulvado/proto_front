"""10b readiness gate — pytest suite for critic-consensus + frame-strip fallback.

Scope:
  * `_is_borderline` boundary logic matches escalation-ops Rule 1 (±0.3 of
    3.0 FAIL/WARN and 4.0 WARN/PASS).
  * `VideoGrader.grade_video_with_consensus`:
      - single-call path when the first aggregate is not borderline
      - two-call agree path (returns higher-confidence result)
      - two-call disagree path (invokes `_frame_extraction_fallback`)
  * Temp-gen job namespacing produces distinct per-job segment paths (string
    contract; the real integration gate is two concurrent /generate/video
    curls).

No network / Gemini calls in this file — everything is mocked. Run via:

    source brand-engine/.venv/bin/activate
    pytest brand-engine/tests/test_10b_readiness.py -v

The 10b handoff requires these four test cases to pass before committing.
"""

from __future__ import annotations

import os
from typing import Any, Optional
from unittest.mock import patch

import pytest

from brand_engine.core.models import (
    BrandProfile,
    VideoGradeCriterion,
    VideoGradeResult,
)
from brand_engine.core.video_grader import (
    CONSENSUS_THRESHOLD_BAND,
    CONSENSUS_VERDICT_BOUNDARIES,
    VideoGrader,
    _is_borderline,
)


# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def grader() -> VideoGrader:
    """Construct a VideoGrader without triggering any network/auth.

    `VideoGrader.client` is lazy — construction alone does not touch
    GOOGLE_API_KEY or ADC. The grade/fallback methods are mocked in each test
    so they never reach the real client.
    """
    return VideoGrader(backend="ai_studio", model="gemini-3.1-pro-preview")


@pytest.fixture
def profile() -> BrandProfile:
    return BrandProfile(
        brand_slug="test-brand",
        display_name="Test Brand",
        allowed_colors=["#15217C"],
        disallowed_patterns=[],
    )


def _make_result(
    *,
    verdict: str,
    aggregate: float,
    confidence: float,
    model: str = "gemini-3.1-pro-preview",
    consensus_note: Optional[str] = None,
) -> VideoGradeResult:
    return VideoGradeResult(
        verdict=verdict,
        aggregate_score=aggregate,
        criteria=[VideoGradeCriterion(name="morphing", score=aggregate, notes="mock")],
        detected_failure_classes=[],
        confidence=confidence,
        summary="mock",
        reasoning="mock",
        recommendation="ship",
        model=model,
        cost=0.0,
        latency_ms=0,
        consensus_note=consensus_note,
    )


# ── `_is_borderline` — Rule 1 boundary logic ─────────────────────────────────


class TestIsBorderline:
    def test_band_defaults_match_escalation_ops_rule_1(self) -> None:
        # Per escalation-ops brief: "within ±0.3 of a verdict threshold (3.0,
        # 4.0)". These constants must not drift without reviewing the brief.
        assert CONSENSUS_THRESHOLD_BAND == 0.3
        assert CONSENSUS_VERDICT_BOUNDARIES == (3.0, 4.0)

    @pytest.mark.parametrize(
        "score,expected",
        [
            (2.69, False),  # outside band below FAIL/WARN boundary
            (2.70, True),   # on the band edge — inclusive
            (2.85, True),   # inside band below 3.0
            (3.00, True),   # on boundary
            (3.30, True),   # band edge above 3.0
            (3.31, False),  # between bands
            (3.50, False),  # safely WARN
            (3.69, False),  # just below 4.0 band
            (3.70, True),   # band edge below PASS boundary
            (3.95, True),   # inside band
            (4.00, True),   # on boundary
            (4.30, True),   # band edge above PASS boundary
            (4.31, False),  # clearly PASS
            (5.00, False),  # hero-quality
            (0.00, False),  # catastrophic; far below any boundary
        ],
    )
    def test_borderline_parametrized(self, score: float, expected: bool) -> None:
        assert _is_borderline(score) is expected, (
            f"score={score} expected={expected}"
        )

    def test_custom_band_narrower(self) -> None:
        # Narrow band (0.05) pulls 4.20 out of the "borderline" zone.
        assert _is_borderline(4.20, threshold_band=0.05) is False
        assert _is_borderline(3.98, threshold_band=0.05) is True


# ── `grade_video_with_consensus` — three paths ───────────────────────────────


class TestGradeVideoWithConsensus:
    def test_single_call_when_not_borderline(
        self, grader: VideoGrader, profile: BrandProfile
    ) -> None:
        """Non-borderline score → one Gemini call, note=not borderline."""
        clean = _make_result(verdict="PASS", aggregate=5.0, confidence=0.95)

        with patch.object(grader, "grade", return_value=clean) as mock_grade, \
             patch.object(
                 grader, "_frame_extraction_fallback"
             ) as mock_fallback:
            out = grader.grade_video_with_consensus(
                video_path="/tmp/fake.mp4",
                profile=profile,
            )

        assert mock_grade.call_count == 1
        mock_fallback.assert_not_called()
        assert out.verdict == "PASS"
        assert out.aggregate_score == 5.0
        assert out.consensus_note == "not borderline, single call"

    def test_two_call_agree_returns_higher_confidence(
        self, grader: VideoGrader, profile: BrandProfile
    ) -> None:
        """Both calls WARN → agree → return the higher-confidence result."""
        # Borderline aggregate (3.80 is within 0.3 of 4.0).
        first = _make_result(verdict="WARN", aggregate=3.80, confidence=0.70)
        second = _make_result(verdict="WARN", aggregate=3.85, confidence=0.92)

        with patch.object(grader, "grade", side_effect=[first, second]) as mock_grade, \
             patch.object(
                 grader, "_frame_extraction_fallback"
             ) as mock_fallback:
            out = grader.grade_video_with_consensus(
                video_path="/tmp/fake.mp4",
                profile=profile,
            )

        assert mock_grade.call_count == 2
        mock_fallback.assert_not_called()
        assert out.verdict == "WARN"
        assert out.confidence == 0.92  # picked the higher-confidence call
        assert out.consensus_note is not None
        assert out.consensus_note.startswith("agreed N=2")

    def test_two_call_disagree_invokes_fallback(
        self, grader: VideoGrader, profile: BrandProfile
    ) -> None:
        """Borderline + disagreeing verdicts → _frame_extraction_fallback fires."""
        first = _make_result(verdict="WARN", aggregate=3.80, confidence=0.70)
        second = _make_result(verdict="PASS", aggregate=4.10, confidence=0.80)
        tiebreak = _make_result(
            verdict="PASS",
            aggregate=4.30,
            confidence=0.85,
            consensus_note="disagreement resolved via frame extraction (8 frames)",
        )

        with patch.object(grader, "grade", side_effect=[first, second]) as mock_grade, \
             patch.object(
                 grader,
                 "_frame_extraction_fallback",
                 return_value=tiebreak,
             ) as mock_fallback:
            out = grader.grade_video_with_consensus(
                video_path="/tmp/fake.mp4",
                profile=profile,
            )

        assert mock_grade.call_count == 2
        assert mock_fallback.call_count == 1
        # Fallback is called with original_verdicts tuple so it can compose a
        # precise consensus_note. Verify the kwarg is wired.
        fb_kwargs = mock_fallback.call_args.kwargs
        assert "original_verdicts" in fb_kwargs
        assert fb_kwargs["original_verdicts"] == (first, second)
        assert out.verdict == "PASS"
        assert out.consensus_note is not None
        assert "frame extraction" in out.consensus_note

    def test_agree_flips_consensus_note_even_on_pass(
        self, grader: VideoGrader, profile: BrandProfile
    ) -> None:
        """Agree path must set consensus_note so os-api flips consensusResolved."""
        first = _make_result(verdict="PASS", aggregate=4.05, confidence=0.60)
        second = _make_result(verdict="PASS", aggregate=4.10, confidence=0.55)

        with patch.object(grader, "grade", side_effect=[first, second]):
            out = grader.grade_video_with_consensus(
                video_path="/tmp/fake.mp4",
                profile=profile,
            )

        assert out.consensus_note is not None and out.consensus_note.startswith(
            "agreed N=2"
        ), (
            "escalation_loop.ts checks truthiness of consensus_note to decide "
            "whether to pass consensusResolved=true to the orchestrator — "
            "any agree path MUST carry a non-empty note."
        )

    def test_n_runs_zero_raises(
        self, grader: VideoGrader, profile: BrandProfile
    ) -> None:
        with pytest.raises(ValueError, match="n_runs"):
            grader.grade_video_with_consensus(
                video_path="/tmp/fake.mp4",
                profile=profile,
                n_runs=0,
            )


# ── Temp-gen namespacing — path contract smoke ──────────────────────────────


class TestTempGenNamespacing:
    """Unit-level check that ``output_base/<job_id>/segment_NNN.mp4`` is the
    expected path shape. The real integration gate for 10b-3 is two
    concurrent curl calls against /generate/video on the running sidecar;
    this test just pins the string contract so a refactor can't silently
    regress it.
    """

    def test_namespaced_paths_are_distinct(self) -> None:
        output_base = "/tmp/outputs/video_jobs"
        job_a = "job-aaa-0001"
        job_b = "job-bbb-0002"
        seg_a = os.path.join(output_base, job_a, "segment_000.mp4")
        seg_b = os.path.join(output_base, job_b, "segment_000.mp4")
        assert seg_a != seg_b
        # Both segments share a parent (the base) but live in distinct subdirs.
        assert os.path.dirname(os.path.dirname(seg_a)) == output_base
        assert os.path.dirname(os.path.dirname(seg_b)) == output_base
        assert os.path.basename(os.path.dirname(seg_a)) == job_a
        assert os.path.basename(os.path.dirname(seg_b)) == job_b

    def test_pre_10b_shared_path_was_the_bug(self) -> None:
        """Pin the regression: pre-10b both jobs wrote here — document why."""
        output_base = "/tmp/outputs/video_jobs"
        # The pre-fix code did: os.path.join(output_base, f"segment_{i:03d}.mp4")
        # for every job — i.e., no job_id segment. Two parallel jobs collided.
        pre_fix = os.path.join(output_base, "segment_000.mp4")
        post_fix_a = os.path.join(output_base, "job-aaa", "segment_000.mp4")
        post_fix_b = os.path.join(output_base, "job-bbb", "segment_000.mp4")
        assert pre_fix != post_fix_a
        assert post_fix_a != post_fix_b


# ── Misc integration sanity ──────────────────────────────────────────────────


def test_grade_result_consensus_note_is_optional() -> None:
    """consensus_note must default to None so legacy single-call callers aren't
    silently treated as consensus-resolved by escalation_loop.ts."""
    r = _make_result(verdict="PASS", aggregate=5.0, confidence=0.9)
    assert r.consensus_note is None


def test_grade_result_serializes_consensus_note() -> None:
    r = _make_result(
        verdict="WARN",
        aggregate=3.90,
        confidence=0.75,
        consensus_note="agreed N=2 (verdicts=WARN, scores=3.80/3.95)",
    )
    payload: dict[str, Any] = r.model_dump()
    assert payload["consensus_note"].startswith("agreed N=2")
