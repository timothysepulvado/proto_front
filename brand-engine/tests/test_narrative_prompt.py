"""Gate test for Chunk 1: narrative-envelope critic prompt shaping.

Rendering assertions on brand_engine.core.video_grader._build_rails_prompt
with + without narrative_context. No live Gemini calls. No network.

Run via:
    cd brand-engine && python -m pytest tests/test_narrative_prompt.py -v
"""
from __future__ import annotations

import pytest

from brand_engine.core.models import BrandProfile
from brand_engine.core.video_grader import _build_rails_prompt


# ─── Fixtures ────────────────────────────────────────────────────────────

@pytest.fixture
def profile() -> BrandProfile:
    return BrandProfile(brand_slug="brandstudios", display_name="BrandStudios")


@pytest.fixture
def narrative_shot_20() -> dict:
    return {
        "shot_number": 20,
        "beat_name": "hook_3",
        "song_start_s": 135.0,
        "song_end_s": 143.0,
        "visual_intent": (
            "Four converted mechs standing in front-left sunlight against "
            "darker sky"
        ),
        "characters": [
            {"slug": "mech_openai", "role": "converted", "color_code": "#1A8C3E"}
        ],
        "previous_shot": {
            "shot_number": 19,
            "beat_name": "hook_3",
            "visual_intent_summary": "Brandy raises her arm — mechs converge",
        },
        "next_shot": {
            "shot_number": 21,
            "beat_name": "hook_3",
            "visual_intent_summary": "Brandy walks forward toward camera, slow motion",
        },
        "stylization_allowances": [
            "Front-left lighting intentional — replaces warm-backlight wash failure",
            "Pattern: Front/side lighting for color distinction.",
        ],
        "ingested_at": "2026-04-21T00:00:00Z",
        "manifest_sha256": "abcdef01234567",
    }


@pytest.fixture
def synopsis() -> str:
    return (
        "Brandy the Orchestrator methodically converts rival AI mechs to gold. "
        "Act 3 ends with the unified army dissolving into the BrandStudios.AI logo."
    )


# ─── Tests: narrative_context=None (backwards-compat) ────────────────────

def test_no_narrative_no_new_sections(profile):
    prompt = _build_rails_prompt(
        brand_profile=profile,
        deliverable_context="Shot 20 — converted mech in debris",
        known_limitations_context=None,
        failure_modes_to_check=None,
    )
    assert "## SHOT POSITION IN MUSIC VIDEO" not in prompt
    assert "## STYLIZATION BUDGET FOR THIS SHOT" not in prompt
    assert "Gemini 3.1 Pro scoring shot" not in prompt
    # VERDICT RULES + CRITERIA must still be present (rubric unchanged)
    assert "## VERDICT RULES" in prompt
    assert "## CRITERIA" in prompt


# ─── Tests: narrative_context provided ───────────────────────────────────

def test_narrative_renders_self_awareness_preamble(profile, narrative_shot_20):
    prompt = _build_rails_prompt(
        brand_profile=profile,
        deliverable_context=None,
        known_limitations_context=None,
        failure_modes_to_check=None,
        narrative_context=narrative_shot_20,
    )
    assert "Gemini 3.1 Pro scoring shot 20 of 30" in prompt
    assert "BrandStudios 'Drift' music video" in prompt
    assert "known variance on borderline scores" in prompt


def test_narrative_renders_shot_position_section(profile, narrative_shot_20, synopsis):
    prompt = _build_rails_prompt(
        brand_profile=profile,
        deliverable_context=None,
        known_limitations_context=None,
        failure_modes_to_check=None,
        narrative_context=narrative_shot_20,
        music_video_synopsis=synopsis,
    )
    assert "## SHOT POSITION IN MUSIC VIDEO" in prompt
    assert "**Shot 20 of 30**" in prompt
    assert "hook_3" in prompt
    assert "135.0s–143.0s" in prompt
    assert "Four converted mechs" in prompt
    # Synopsis injected
    assert "Music video:" in prompt
    assert "Brandy the Orchestrator" in prompt
    # Neighbor shots rendered
    assert "Previous shot (19" in prompt
    assert "Next shot (21" in prompt


def test_narrative_renders_stylization_budget_section(profile, narrative_shot_20):
    prompt = _build_rails_prompt(
        brand_profile=profile,
        deliverable_context=None,
        known_limitations_context=None,
        failure_modes_to_check=None,
        narrative_context=narrative_shot_20,
    )
    assert "## STYLIZATION BUDGET FOR THIS SHOT" in prompt
    assert "Front-left lighting intentional" in prompt
    assert "Pattern: Front/side lighting" in prompt
    # Guard: critic is told VERDICT RULES stay fixed
    assert "VERDICT RULES stay fixed" in prompt


def test_narrative_stylization_budget_omitted_when_allowances_empty(profile, narrative_shot_20):
    nc = {**narrative_shot_20, "stylization_allowances": []}
    prompt = _build_rails_prompt(
        brand_profile=profile,
        deliverable_context=None,
        known_limitations_context=None,
        failure_modes_to_check=None,
        narrative_context=nc,
    )
    assert "## STYLIZATION BUDGET FOR THIS SHOT" not in prompt
    # But SHOT POSITION still renders
    assert "## SHOT POSITION IN MUSIC VIDEO" in prompt


def test_narrative_shot_1_no_previous(profile, narrative_shot_20):
    nc = {**narrative_shot_20, "shot_number": 1, "previous_shot": None}
    prompt = _build_rails_prompt(
        brand_profile=profile,
        deliverable_context=None,
        known_limitations_context=None,
        failure_modes_to_check=None,
        narrative_context=nc,
    )
    # Must not emit a "Previous shot" line when None
    assert "Previous shot" not in prompt
    # Next shot still renders
    assert "Next shot (21" in prompt
    # Preamble swaps shot number
    assert "scoring shot 1 of 30" in prompt


def test_narrative_shot_30_no_next(profile, narrative_shot_20):
    nc = {**narrative_shot_20, "shot_number": 30, "next_shot": None}
    prompt = _build_rails_prompt(
        brand_profile=profile,
        deliverable_context=None,
        known_limitations_context=None,
        failure_modes_to_check=None,
        narrative_context=nc,
    )
    # Must not emit a "Next shot" line when None
    assert "Next shot" not in prompt
    # Previous shot still renders
    assert "Previous shot (19" in prompt
    assert "scoring shot 30 of 30" in prompt


def test_narrative_section_ordering(profile, narrative_shot_20):
    """SHOT POSITION precedes CRITERIA; STYLIZATION BUDGET precedes VERDICT RULES."""
    prompt = _build_rails_prompt(
        brand_profile=profile,
        deliverable_context="Shot 20 — converted mech",
        known_limitations_context=None,
        failure_modes_to_check=None,
        narrative_context=narrative_shot_20,
    )
    i_preamble = prompt.find("Gemini 3.1 Pro scoring")
    i_narrative = prompt.find("## NARRATIVE CONTEXT")
    i_shot_pos = prompt.find("## SHOT POSITION IN MUSIC VIDEO")
    i_criteria = prompt.find("## CRITERIA")
    i_known_lim = prompt.find("## KNOWN LIMITATION CATALOG")
    i_styl = prompt.find("## STYLIZATION BUDGET FOR THIS SHOT")
    i_verdict = prompt.find("## VERDICT RULES")

    assert i_preamble < i_shot_pos, "preamble should precede SHOT POSITION"
    assert i_narrative < i_shot_pos, "NARRATIVE CONTEXT should precede SHOT POSITION"
    assert i_shot_pos < i_criteria, "SHOT POSITION should precede CRITERIA"
    assert i_known_lim < i_styl, "KNOWN LIMITATION CATALOG should precede STYLIZATION BUDGET"
    assert i_styl < i_verdict, "STYLIZATION BUDGET should precede VERDICT RULES"


def test_narrative_preserves_rubric_unchanged(profile, narrative_shot_20):
    """VERDICT RULES + CRITERIA + OUTPUT SCHEMA must be byte-identical with +
    without narrative_context — the rubric does not widen.
    """
    base = _build_rails_prompt(
        brand_profile=profile,
        deliverable_context=None,
        known_limitations_context=None,
        failure_modes_to_check=None,
    )
    enriched = _build_rails_prompt(
        brand_profile=profile,
        deliverable_context=None,
        known_limitations_context=None,
        failure_modes_to_check=None,
        narrative_context=narrative_shot_20,
    )

    def verdict_block(s: str) -> str:
        start = s.find("## VERDICT RULES")
        return s[start:]  # through end — includes OUTPUT SCHEMA too

    # The tail (VERDICT RULES + OUTPUT SCHEMA) is byte-identical. The head
    # differs because of preamble + SHOT POSITION + STYLIZATION BUDGET.
    assert verdict_block(base) == verdict_block(enriched)


def test_narrative_frame_strip_still_renders_narrative(profile, narrative_shot_20):
    """media_kind='frame_strip' (tiebreak path) also gets narrative envelope."""
    prompt = _build_rails_prompt(
        brand_profile=profile,
        deliverable_context=None,
        known_limitations_context=None,
        failure_modes_to_check=None,
        media_kind="frame_strip",
        frame_strip_count=8,
        narrative_context=narrative_shot_20,
    )
    # Frame strip intro present
    assert "tile grid of 8 frames sampled at 1fps" in prompt
    # Plus narrative
    assert "## SHOT POSITION IN MUSIC VIDEO" in prompt
    assert "## STYLIZATION BUDGET FOR THIS SHOT" in prompt
