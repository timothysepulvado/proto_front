"""Internal-helper coverage for image_grader.py.

The Phase A test_grade_image_v2.py suite mocks `_call_gemini_vision` and
`load_image_class_limitations` at the module boundary — that's correct for
behavior tests. This file exercises the helpers that those mocks short-
circuit so the merge-blocking 80% coverage gate is met.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from brand_engine.core import image_grader as ig
from brand_engine.core.image_grader import (
    MAX_PROMPT_CHARS,
    STILLS_CRITERIA,
    _build_critic_system_prompt,
    _build_image_load_failure_result,
    _call_gemini_vision,
    _compute_verdict_for_stills,
    _emit_critic_log,
    _get_client,
    _load_image_part,
    _normalize_recommendation,
    _trace_id,
)
from brand_engine.core.models import VideoGradeCriterion


# ─── Recommendation normalization ───────────────────────────────────────────

class TestNormalizeRecommendation:
    """The narrowed stills recommendation union must coerce reliably."""

    @pytest.mark.parametrize("inp,expected", [
        ("ship", "ship"),
        ("L1_prompt_fix", "L1_prompt_fix"),
        ("L2_approach_change", "L2_approach_change"),
        ("L3_redesign", "L3_redesign"),
        ("L3_escalation", "L3_redesign"),  # video-class value → coerce
        ("L3_accept_with_trim", "L3_redesign"),  # video-class value → coerce
        ("", "L1_prompt_fix"),  # empty falls back to safe-default
        ("garbage_value", "L1_prompt_fix"),
        (None, "L1_prompt_fix"),
    ])
    def test_normalize(self, inp, expected):
        assert _normalize_recommendation(inp) == expected


# ─── Verdict gate logic ─────────────────────────────────────────────────────

class TestComputeVerdictForStills:
    """Mirror the video-pattern test for the stills-tuned gate."""

    def _crit(self, score: float) -> VideoGradeCriterion:
        return VideoGradeCriterion(name="x", score=score, notes="")

    def test_pass_when_aggregate_ge_4_and_no_low_or_blocking(self):
        criteria = [self._crit(4.5)] * 6
        assert _compute_verdict_for_stills(4.5, criteria, [], set()) == "PASS"

    def test_warn_when_aggregate_in_3_to_4(self):
        criteria = [self._crit(3.5)] * 6
        assert _compute_verdict_for_stills(3.5, criteria, [], set()) == "WARN"

    def test_fail_when_aggregate_below_3(self):
        criteria = [self._crit(2.5)] * 6
        assert _compute_verdict_for_stills(2.5, criteria, [], set()) == "FAIL"

    def test_fail_when_critical_criterion_present(self):
        # Even with high aggregate, a criterion <=1.0 should FAIL
        criteria = [self._crit(5.0)] * 5 + [self._crit(0.5)]
        # Aggregate is high enough that it'd otherwise PASS
        assert _compute_verdict_for_stills(4.25, criteria, [], set()) == "FAIL"

    def test_fail_when_blocking_failure_class_present(self):
        criteria = [self._crit(4.5)] * 6
        verdict = _compute_verdict_for_stills(
            4.5, criteria,
            ["narrative_beat_inversion_active_vs_deactivated"],
            {"narrative_beat_inversion_active_vs_deactivated"},
        )
        assert verdict == "FAIL"

    def test_warn_when_low_criterion_but_aggregate_high(self):
        # One criterion in [1.0, 3.0) with high aggregate → WARN, not FAIL
        criteria = [self._crit(5.0)] * 5 + [self._crit(2.5)]
        assert _compute_verdict_for_stills(4.58, criteria, [], set()) == "WARN"


# ─── Critic system prompt ───────────────────────────────────────────────────

class TestBuildCriticSystemPrompt:
    """The audit/in_loop split must produce different prompts."""

    def test_audit_skips_rule_6_and_7_with_marker(self):
        prompt = _build_critic_system_prompt(
            mode="audit",
            still_prompt="test prompt",
            narrative_beat={"shot_number": 5, "section": "hook_1", "visual": "x"},
            story_context={},
            anchor_paths=[],
            reference_paths=[],
            pivot_rewrite_history=None,
            known_limitations=[],
        )
        assert "<<< SKIP Rule 6" in prompt
        assert "<<< SKIP Rule 7" in prompt
        # Rule 6 active text should not be present
        assert "MANDATORY consume" not in prompt

    def test_in_loop_includes_rules_6_and_7(self):
        prompt = _build_critic_system_prompt(
            mode="in_loop",
            still_prompt="test prompt",
            narrative_beat={"shot_number": 5, "section": "hook_1", "visual": "x"},
            story_context={},
            anchor_paths=[],
            reference_paths=[],
            pivot_rewrite_history=[{"iter": 1, "audit_critic_verdict": {"aggregate_score": 3.5}}],
            known_limitations=[],
        )
        assert "MANDATORY consume" in prompt
        assert "Degenerate-loop guard" in prompt
        assert "PIVOT HISTORY" in prompt
        assert "<<< SKIP Rule 6" not in prompt

    def test_known_limitations_rendered_in_catalog_section(self):
        prompt = _build_critic_system_prompt(
            mode="audit",
            still_prompt="test",
            narrative_beat={"shot_number": 1},
            story_context={},
            anchor_paths=[],
            reference_paths=[],
            pivot_rewrite_history=None,
            known_limitations=[
                {"failure_mode": "magical_aura_overinterpretation", "severity": "warning",
                 "description": "warm light reads as halos", "mitigation": "5-element template"}
            ],
        )
        assert "magical_aura_overinterpretation" in prompt
        assert "5-element template" in prompt
        assert "[warning]" in prompt

    def test_empty_catalog_emits_fallback_notice(self):
        prompt = _build_critic_system_prompt(
            mode="audit",
            still_prompt="test",
            narrative_beat={},
            story_context={},
            anchor_paths=[],
            reference_paths=[],
            pivot_rewrite_history=None,
            known_limitations=[],
        )
        assert "catalog not provided" in prompt

    def test_story_context_sections_rendered(self):
        prompt = _build_critic_system_prompt(
            mode="audit",
            still_prompt="test",
            narrative_beat={"shot_number": 1},
            story_context={
                "brief_md": "BRIEF SENTINEL",
                "narrative_md": "NARR SENTINEL",
                "lyrics_md": "LYRIC SENTINEL",
            },
            anchor_paths=[],
            reference_paths=[],
            pivot_rewrite_history=None,
            known_limitations=[],
        )
        assert "BRIEF SENTINEL" in prompt
        assert "NARR SENTINEL" in prompt
        assert "LYRIC SENTINEL" in prompt

    def test_anchor_and_reference_paths_listed(self):
        prompt = _build_critic_system_prompt(
            mode="audit",
            still_prompt="test",
            narrative_beat={"shot_number": 1},
            story_context={},
            anchor_paths=["/x/brandy_anchor.png"],
            reference_paths=["/x/shot_22.png"],
            pivot_rewrite_history=None,
            known_limitations=[],
        )
        assert "brandy_anchor.png" in prompt
        assert "shot_22.png" in prompt


# ─── Image-load synthetic FAIL builder ──────────────────────────────────────

class TestImageLoadFailureResult:
    def test_synthetic_fail_has_six_zero_criteria(self):
        result = _build_image_load_failure_result("/no/path.png", shot_number=5)
        assert result.verdict == "FAIL"
        assert result.aggregate_score == 0.0
        assert len(result.criteria) == 6
        assert all(c.score == 0.0 for c in result.criteria)
        # Criteria names must match the rubric
        names = {c.name for c in result.criteria}
        assert names == set(STILLS_CRITERIA)
        assert result.recommendation == "L3_redesign"
        assert result.shot_number == 5
        assert result.image_path == "/no/path.png"


# ─── Trace ID helper ────────────────────────────────────────────────────────

class TestTraceId:
    def test_uses_env_var_when_set(self, monkeypatch):
        monkeypatch.setenv("BRAND_ENGINE_TRACE_ID", "fixed-trace-12")
        assert _trace_id() == "fixed-trace-12"

    def test_generates_fresh_when_unset(self, monkeypatch):
        monkeypatch.delenv("BRAND_ENGINE_TRACE_ID", raising=False)
        a = _trace_id()
        b = _trace_id()
        assert len(a) == 12
        assert len(b) == 12
        assert a != b


# ─── Structured log emission ────────────────────────────────────────────────

class TestEmitCriticLog:
    def test_emits_one_json_line_with_trace_id(self, caplog):
        import logging as _logging
        with caplog.at_level(_logging.INFO, logger="brand_engine.core.image_grader"):
            _emit_critic_log(
                event="critic_call",
                mode="audit",
                image_path="/x.png",
                prompt_len=100,
                latency_ms=1500,
                aggregate_score=4.46,
                verdict="PASS",
                recommendation="ship",
                failure_classes=[],
                shot_number=5,
            )
        assert len(caplog.records) >= 1
        # Find the structured JSON line
        msgs = [r.message for r in caplog.records if r.message.startswith("{")]
        assert msgs, f"No structured log line emitted; saw: {[r.message for r in caplog.records]}"
        payload = json.loads(msgs[-1])
        assert payload["event"] == "critic_call"
        assert payload["verdict"] == "PASS"
        assert "trace_id" in payload
        assert len(payload["trace_id"]) == 12

    def test_does_not_raise_on_unserializable_field(self, caplog):
        # Sanity — a non-JSON-serializable field falls through default=str
        class Weird:
            pass
        # Should NOT raise; logger.exception is the fallback path.
        _emit_critic_log(event="critic_call", weird=Weird())


# ─── Image part loading ─────────────────────────────────────────────────────

class TestLoadImagePart:
    def test_raises_filenotfounderror_when_missing(self):
        with pytest.raises(FileNotFoundError):
            _load_image_part("/nonexistent/foo.png")

    def test_loads_existing_image(self, tmp_path):
        # Create a tiny valid PNG (1x1 pixel) via Pillow so the loader can read it.
        from PIL import Image
        p = tmp_path / "tiny.png"
        Image.new("RGB", (1, 1), color="red").save(p)
        part = _load_image_part(str(p))
        # Part is a genai Part; just verify it round-trips without error.
        assert part is not None


# ─── Gemini client lazy-init ────────────────────────────────────────────────

class TestGetClient:
    def setup_method(self):
        # Reset module-level singleton between tests
        ig._genai_client = None

    def teardown_method(self):
        ig._genai_client = None

    def test_ai_studio_requires_an_api_key(self, monkeypatch):
        for var in ("GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENAI_API_KEY"):
            monkeypatch.delenv(var, raising=False)
        with pytest.raises(ValueError) as exc_info:
            _get_client("ai_studio")
        assert "GOOGLE_GENAI_API_KEY" in str(exc_info.value)

    def test_ai_studio_uses_google_api_key(self, monkeypatch):
        monkeypatch.setenv("GOOGLE_API_KEY", "fake-key-1234")
        with patch("brand_engine.core.image_grader.genai.Client") as mock_client:
            _get_client("ai_studio")
        mock_client.assert_called_once_with(api_key="fake-key-1234")

    def test_vertex_uses_project_id_env(self, monkeypatch):
        monkeypatch.setenv("VERTEX_PROJECT_ID", "test-project-xyz")
        monkeypatch.setenv("VERTEX_REGION", "us-east1")
        with patch("brand_engine.core.image_grader.genai.Client") as mock_client:
            _get_client("vertex")
        mock_client.assert_called_once_with(
            vertexai=True, project="test-project-xyz", location="us-east1",
        )

    def test_singleton_returned_after_first_call(self, monkeypatch):
        monkeypatch.setenv("GOOGLE_API_KEY", "fake-key")
        with patch("brand_engine.core.image_grader.genai.Client") as mock_client:
            mock_client.return_value = MagicMock()
            c1 = _get_client("ai_studio")
            c2 = _get_client("ai_studio")
        assert c1 is c2
        # Client constructor only called once (singleton cache)
        assert mock_client.call_count == 1


# ─── _call_gemini_vision retry behavior ─────────────────────────────────────

class TestCallGeminiVisionRetry:
    """Exercise the retry-on-429 logic inside the real helper.

    The Phase A behavior tests mock this helper at the module boundary, so the
    retry path is uncovered by them. We re-mock the underlying genai client to
    drive different response sequences and assert retry / propagate behavior.
    """

    def setup_method(self):
        ig._genai_client = None

    def teardown_method(self):
        ig._genai_client = None

    def _make_image_at(self, tmp_path: Path) -> str:
        from PIL import Image
        png = tmp_path / "img.png"
        Image.new("RGB", (1, 1), color="blue").save(png)
        return str(png)

    def test_propagates_5xx_immediately(self, tmp_path, monkeypatch):
        monkeypatch.setenv("GOOGLE_API_KEY", "fake")
        img = self._make_image_at(tmp_path)
        mock_gen = MagicMock(side_effect=RuntimeError("500 Internal Server Error"))
        with patch("brand_engine.core.image_grader.genai.Client") as mc:
            mc.return_value.models.generate_content = mock_gen
            with pytest.raises(RuntimeError, match="500"):
                _call_gemini_vision(
                    system_prompt="x",
                    image_path=img,
                    anchor_paths=[],
                    reference_paths=[],
                )
        # 5xx must NOT retry
        assert mock_gen.call_count == 1

    def test_retries_429_then_succeeds(self, tmp_path, monkeypatch):
        monkeypatch.setenv("GOOGLE_API_KEY", "fake")
        img = self._make_image_at(tmp_path)
        success_response = MagicMock(text='{"verdict":"PASS"}')
        mock_gen = MagicMock(side_effect=[
            RuntimeError("429 Too Many Requests"),
            RuntimeError("429 Too Many Requests"),
            success_response,
        ])
        with patch("brand_engine.core.image_grader.genai.Client") as mc, \
             patch("brand_engine.core.image_grader.time.sleep") as mock_sleep:
            mc.return_value.models.generate_content = mock_gen
            out = _call_gemini_vision(
                system_prompt="x",
                image_path=img,
                anchor_paths=[],
                reference_paths=[],
            )
        assert out == '{"verdict":"PASS"}'
        assert mock_gen.call_count == 3
        # Backoff sequence applied (1s, 2s) — third attempt wouldn't sleep
        assert mock_sleep.call_count == 2

    def test_429_exhausts_retries_then_raises(self, tmp_path, monkeypatch):
        monkeypatch.setenv("GOOGLE_API_KEY", "fake")
        img = self._make_image_at(tmp_path)
        mock_gen = MagicMock(side_effect=RuntimeError("429 Too Many Requests"))
        with patch("brand_engine.core.image_grader.genai.Client") as mc, \
             patch("brand_engine.core.image_grader.time.sleep"):
            mc.return_value.models.generate_content = mock_gen
            with pytest.raises(RuntimeError, match="429"):
                _call_gemini_vision(
                    system_prompt="x",
                    image_path=img,
                    anchor_paths=[],
                    reference_paths=[],
                )
        # 3 attempts total
        assert mock_gen.call_count == 3
