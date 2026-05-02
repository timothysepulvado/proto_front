"""Shared pytest fixtures for brand-engine tests.

Currently scoped to ADR-004 Phase A — mocking the Supabase known_limitations
loader so test_grade_image_v2.py can run without a network call.
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest
from _pytest.monkeypatch import MonkeyPatch


# Mirror of migration 009_image_class_known_limitations.sql — 8 image-class
# failure modes with the columns the grader reads (failure_mode, category,
# description, mitigation, severity). Kept in-source so fixture drift from
# migration drift is caught by the test_video_grader_truncation regression
# suite (no schema dependency on this fixture).
IMAGE_CLASS_LIMITATIONS_FIXTURE: list[dict[str, Any]] = [
    {
        "failure_mode": "narrative_beat_inversion_active_vs_deactivated",
        "category": "character",
        "description": "Multi-subject aftermath beats render as ACTIVE poses for non-human subjects.",
        "mitigation": "Use POSITIVE STRUCTURAL pose language; replace negation-of-action with shape language.",
        "severity": "blocking",
    },
    {
        "failure_mode": "diorama_posed_tableau_overinterpretation",
        "category": "composition",
        "description": "Multi-subject wide compositions collapse to action-figure dioramas.",
        "mitigation": "Lens-distance language + foreground physical-occlusion device.",
        "severity": "blocking",
    },
    {
        "failure_mode": "humanoid_mech_collapses_to_arachnid_under_close_crop_prone_pose",
        "category": "composition",
        "description": "Humanoid bipedal mechs collapse to arachnid silhouettes under close-crop prone poses.",
        "mitigation": "Explicit bipedal anchor language + side-pose framing.",
        "severity": "blocking",
    },
    {
        "failure_mode": "positive_aesthetic_anchors_overridden_by_mech_subject_bias",
        "category": "aesthetic",
        "description": "Documentary aesthetic anchors lose to mech subject bias.",
        "mitigation": "Head-crop the mech + anti-CGI opener at first-line position.",
        "severity": "warning",
    },
    {
        "failure_mode": "three_mech_parade_formation_staging_bias",
        "category": "composition",
        "description": "Three+ mechs default to evenly-spaced parade formation.",
        "mitigation": "Asymmetric blocking + varied poses + depth wedge.",
        "severity": "warning",
    },
    {
        "failure_mode": "ember_glow_overinterpretation",
        "category": "content",
        "description": "Model adds embers/glowing-coals despite no-fire negation.",
        "mitigation": "Stronger positive language + redundant negation list.",
        "severity": "warning",
    },
    {
        "failure_mode": "documentary_polish_drift_3d_render",
        "category": "aesthetic",
        "description": "Hard-surface subjects render with smooth-plastic CG-render polish.",
        "mitigation": "Anti-CGI opener + explicit material-truth language.",
        "severity": "warning",
    },
    {
        "failure_mode": "magical_aura_overinterpretation",
        "category": "content",
        "description": "Warm-light prompts read as radiating shockwaves / halos / fairy dust.",
        "mitigation": "5-element L1 fix template (anti-CGI + containment + negation block + off-center + practical lighting).",
        "severity": "warning",
    },
]


@pytest.fixture(autouse=True)
def mock_supabase_known_limitations(monkeypatch: MonkeyPatch) -> None:
    """Auto-applied — replaces the Supabase loader with the in-memory fixture
    so every test runs without network access.

    Tests that want to test the loader itself can override this fixture by
    re-monkeypatching inside the test function.
    """
    def fresh_image_class_limitations(*_args: object, **_kwargs: object) -> list[dict[str, Any]]:
        """Return fresh row/list objects so tests cannot share mutable state."""
        return deepcopy(IMAGE_CLASS_LIMITATIONS_FIXTURE)

    monkeypatch.setattr(
        "brand_engine.core.known_limitations_loader.load_image_class_limitations",
        fresh_image_class_limitations,
    )
    # Also patch the symbol as imported into image_grader (Python name binding —
    # the import-time `from known_limitations_loader import load_image_class_limitations`
    # creates a local reference that monkeypatching the source module doesn't update).
    monkeypatch.setattr(
        "brand_engine.core.image_grader.load_image_class_limitations",
        fresh_image_class_limitations,
    )
