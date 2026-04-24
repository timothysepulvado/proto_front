"""Gate test for brand-engine critic JSON truncation recovery.

Step 10d full-catalog regrade surfaced a ~20% rate of Gemini 3.1 Pro returning
truncated JSON when its response exceeds `max_output_tokens` (was 4096; bumped
to 16384 in this same commit). For the remaining truncation cases that still
spill over, `_repair_truncated_json` does best-effort balance + reparse and
annotates recovered grades with `_truncation_recovered: true`.

This gate exercises the recovery ladder against representative Gemini-style
truncation patterns. No live Gemini calls. No network.

Run via:
    cd brand-engine && python -m pytest tests/test_video_grader_truncation.py -v
"""
from __future__ import annotations

import json

import pytest

from brand_engine.core.video_grader import (
    _extract_json_block,
    _repair_truncated_json,
)


# ─── Repair helper unit cases ───────────────────────────────────────────────

class TestRepairTruncatedJson:
    def test_valid_json_repair_returns_dict_with_flag(self):
        """Even valid JSON, when fed to the repair helper, returns a parsed dict.

        The repair helper sets `_truncation_recovered=True` unconditionally when
        it returns successfully — that's correct: callers only invoke it after
        the primary parse failed, so any success here IS a recovery.
        """
        text = '{"verdict": "PASS", "aggregate_score": 4.5}'
        result = _repair_truncated_json(text)
        assert result is not None
        assert result["verdict"] == "PASS"
        assert result["aggregate_score"] == 4.5
        assert result["_truncation_recovered"] is True

    def test_trailing_comma_recovered(self):
        text = '{"verdict": "WARN", "aggregate_score": 3.5,'
        result = _repair_truncated_json(text)
        assert result is not None
        assert result["verdict"] == "WARN"
        assert result["aggregate_score"] == 3.5

    def test_missing_one_closing_brace_recovered(self):
        text = '{"verdict": "PASS", "aggregate_score": 4.0'
        result = _repair_truncated_json(text)
        assert result is not None
        assert result["verdict"] == "PASS"

    def test_missing_brace_and_bracket_recovered(self):
        text = (
            '{"verdict": "WARN", "criteria": ['
            '{"name": "morphing", "score": 3.0, "notes": "Some morph"}'
        )
        result = _repair_truncated_json(text)
        assert result is not None
        assert result["verdict"] == "WARN"
        assert result["criteria"][0]["name"] == "morphing"

    def test_truncated_mid_string_recovered_by_chopping(self):
        """If Gemini cuts off mid-string, drop the partial property and recover
        the prior fields."""
        text = (
            '{"verdict": "FAIL", "aggregate_score": 2.1, '
            '"criteria": [{"name": "morphing", "score": 2.0, '
            '"notes": "Face shifts at t=2s and contin'
        )
        result = _repair_truncated_json(text)
        assert result is not None
        assert result["verdict"] == "FAIL"
        assert result["aggregate_score"] == 2.1
        # The mid-string criterion was dropped; that's OK — caller will see a
        # short criteria list and can fall back to verdict-only.

    def test_truncated_mid_string_in_top_level_value_recovered(self):
        """A simpler truncation: mid-string on a top-level prop."""
        text = '{"verdict": "WARN", "summary": "The clip starts strong but drif'
        result = _repair_truncated_json(text)
        assert result is not None
        assert result["verdict"] == "WARN"
        # `summary` was dropped because it was mid-string

    def test_completely_garbled_returns_none(self):
        text = "this is not json at all"
        result = _repair_truncated_json(text)
        assert result is None

    def test_more_closers_than_openers_returns_none(self):
        # Bracket-close without matching open — open vs close count goes
        # negative, which the helper treats as unrecoverable shape.
        text_unbalanced = '{"verdict": "PASS"]}'
        result = _repair_truncated_json(text_unbalanced)
        assert result is None

    def test_empty_string_returns_none(self):
        assert _repair_truncated_json("") is None
        assert _repair_truncated_json("   \n  ") is None

    def test_nested_array_truncation_recovered(self):
        """Mirror the realistic shape: 10-criterion list cut mid-way."""
        text = (
            '{"verdict": "PASS", "aggregate_score": 4.3, "criteria": ['
            '{"name": "morphing", "score": 5.0, "notes": "clean"},'
            '{"name": "temporal_jitter", "score": 4.5, "notes": "clean"},'
            '{"name": "lighting_flicker", "score": 4.8, "notes": "clean"},'
            '{"name": "scale_creep", "score": 4.0, "notes": "minor"},'
            '{"name": "camera_smoothness", "score": 4.5, "notes": "smooth"}'
        )
        result = _repair_truncated_json(text)
        assert result is not None
        assert result["verdict"] == "PASS"
        assert result["aggregate_score"] == 4.3
        assert len(result["criteria"]) == 5

    def test_truncated_after_array_close_recovered(self):
        """Truncation right after the criteria array closes, before remaining
        top-level fields."""
        text = (
            '{"verdict": "WARN", "aggregate_score": 3.7, "criteria": ['
            '{"name": "morphing", "score": 4.0, "notes": "ok"}'
            '],'
        )
        result = _repair_truncated_json(text)
        assert result is not None
        assert result["verdict"] == "WARN"
        assert len(result["criteria"]) == 1


# ─── Public _extract_json_block integration ─────────────────────────────────

class TestExtractJsonBlock:
    def test_valid_json_no_recovery_flag(self):
        """Valid JSON should NOT carry the recovery flag — recovery only fires
        on parse failure, not as a side effect of every successful parse.
        """
        text = '{"verdict": "PASS", "aggregate_score": 4.5}'
        result = _extract_json_block(text)
        assert result["verdict"] == "PASS"
        assert "_truncation_recovered" not in result

    def test_truncated_json_recovered_with_flag(self):
        text = '{"verdict": "PASS", "aggregate_score": 4.5'
        result = _extract_json_block(text)
        assert result["verdict"] == "PASS"
        assert result.get("_truncation_recovered") is True

    def test_fenced_valid_json_no_recovery_flag(self):
        text = '```json\n{"verdict": "PASS", "aggregate_score": 4.5}\n```'
        result = _extract_json_block(text)
        assert result["verdict"] == "PASS"
        assert "_truncation_recovered" not in result

    def test_unrecoverable_raises_json_decode_error(self):
        text = "absolute garbage no JSON at all here"
        with pytest.raises(json.JSONDecodeError) as exc_info:
            _extract_json_block(text)
        assert "no recovery possible" in str(exc_info.value)

    def test_single_element_array_unwrapped(self):
        """Pre-existing Gemini quirk — single-element arrays are unwrapped to
        the inner object. Verify the bigger refactor didn't break this."""
        text = '[{"verdict": "PASS", "aggregate_score": 4.5}]'
        result = _extract_json_block(text)
        assert result["verdict"] == "PASS"
        assert "_truncation_recovered" not in result
