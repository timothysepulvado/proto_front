"""Video grader: Gemini 3.1 Pro multimodal critic for generated video clips.

This is the in-process version of what Jackie (the Gemini CLI agent) does
manually. It accepts a video clip + brand context + known-limitation catalog
subset, invokes Gemini 3.1 Pro with a locked prompt harness, and returns a
structured VideoGradeResult.

Design principles:
- Output is ALWAYS structured JSON matching VideoGradeResult (no free-form prose)
- Failure_mode strings must match the catalog exactly (snake_case, no paraphrasing)
- The prompt preamble + rails are the "harness" — rigid so downstream consumers
  (the orchestrator, the runner) can trust the shape
- New failure-mode candidates are prefixed 'new_candidate:' so they're obvious
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Optional

from google import genai
from google.genai import types as genai_types

from brand_engine.core.models import (
    BrandProfile,
    VideoGradeCriterion,
    VideoGradeResult,
)

logger = logging.getLogger(__name__)


# ── Canonical model id (override via env for preview/GA tracking) ────────────
# google-genai SDK uses bare model ids for Gemini. The Gemini 3.x Pro family
# supports multimodal video input up to ~20 minutes.
DEFAULT_GEMINI_VIDEO_MODEL = os.getenv("GEMINI_VIDEO_CRITIC_MODEL", "gemini-3-pro")

# ── Criteria locked to the Jackie-derived taxonomy ───────────────────────────
# These mirror the brief at ~/agent-vault/briefs/drift-mv-jackie-motion-qa.md.
# Extending this list is fine; removing items breaks the orchestrator contract.
CRITERIA_NAMES: list[str] = [
    "morphing",
    "temporal_jitter",
    "lighting_flicker",
    "scale_creep",
    "camera_smoothness",
    "character_drift",
    "wardrobe_drift",
    "atmospheric_creep",
    "vfx_dissipation",
    "composition_stability",
]

CRITERIA_DESCRIPTIONS: dict[str, str] = {
    "morphing": "Face/body/wardrobe warping across frames. Wardrobe textures shifting. Mech armor panels dissolving into each other.",
    "temporal_jitter": "Frame-to-frame pops, strobes, unnatural interpolation. Motion vectors fighting the camera move.",
    "lighting_flicker": "Scene-wide brightness pulses. Tonal shifts. Color-temperature drift across the clip.",
    "scale_creep": "Subjects growing or shrinking unnaturally during a camera move. Proportions changing.",
    "camera_smoothness": "Dolly/orbit/zoom evenness. Acceleration artifacts. 'Two shots spliced' feeling.",
    "character_drift": "Face/skin/hair identity shift over the clip's duration.",
    "wardrobe_drift": "Fabric/material/color/stitching drift on named wardrobe items.",
    "atmospheric_creep": "Fog, haze, cloud, smoke bleeding across the scene where it shouldn't be.",
    "vfx_dissipation": "VFX events that fade, complete, or depart mid-clip despite needing to persist.",
    "composition_stability": "Framing that drifts from hero-still composition unexpectedly.",
}

# ── Verdict thresholds (matches Jackie's brief) ─────────────────────────────
def _compute_verdict(
    aggregate_score: float,
    criteria: list[VideoGradeCriterion],
    detected_failure_classes: list[str],
    known_blocking_modes: set[str],
) -> str:
    """Apply verdict thresholds: PASS ≥4.0 with no criterion <3.0 and no blocking failure."""
    has_blocking = any(fm in known_blocking_modes for fm in detected_failure_classes)
    has_critical_criterion = any(c.score <= 1.0 for c in criteria)
    has_low_criterion = any(c.score < 3.0 for c in criteria)

    if has_critical_criterion or aggregate_score < 3.0 or has_blocking:
        return "FAIL" if (has_critical_criterion or has_blocking) else "FAIL"
    if has_low_criterion or aggregate_score < 4.0:
        return "WARN"
    return "PASS"


def _build_rails_prompt(
    brand_profile: BrandProfile,
    deliverable_context: Optional[str],
    known_limitations_context: Optional[list[dict]],
    failure_modes_to_check: Optional[list[str]],
) -> str:
    """Construct the system-level rails for the Gemini video critic.

    This is the 'harness' that makes the critic's output trustworthy for
    downstream orchestrator consumption. Changes here require re-testing
    against known Shot 20 PASS / Shot 27 WARN baselines.
    """
    lines: list[str] = []
    lines.append("You are a multimodal brand-QA critic for the BrandStudios orchestration engine.")
    lines.append("Your job: watch the attached video clip and produce a structured verdict in JSON.")
    lines.append("")
    lines.append("## OUTPUT DISCIPLINE")
    lines.append("- Respond ONLY with valid JSON matching the VideoGradeResult schema.")
    lines.append("- No prose outside JSON. No markdown. No code fences around the JSON.")
    lines.append("- `failure_mode` strings MUST be copied verbatim from the catalog below.")
    lines.append("- For patterns NOT in the catalog, use prefix 'new_candidate:<snake_case_name>'.")
    lines.append("")
    lines.append(f"## BRAND: {brand_profile.display_name} ({brand_profile.brand_slug})")
    if brand_profile.allowed_colors:
        lines.append(f"Allowed colors (hex): {', '.join(brand_profile.allowed_colors)}")
    if brand_profile.disallowed_patterns:
        lines.append(f"Disallowed patterns: {', '.join(brand_profile.disallowed_patterns)}")
    lines.append("")

    if deliverable_context:
        lines.append("## NARRATIVE CONTEXT")
        lines.append(deliverable_context.strip())
        lines.append("")

    lines.append("## CRITERIA (score each 0.0-5.0)")
    lines.append("Scoring key: 5=hero-quality, 4=ship, 3=warn, 2=fail-minor, 1=fail-major, 0=catastrophic")
    for name in CRITERIA_NAMES:
        lines.append(f"- **{name}**: {CRITERIA_DESCRIPTIONS[name]}")
    lines.append("")

    lines.append("## KNOWN LIMITATION CATALOG")
    lines.append("When you detect one of these patterns in the clip, list its failure_mode (exact string).")
    if known_limitations_context:
        for lim in known_limitations_context:
            mode = lim.get("failure_mode", "")
            desc = lim.get("description", "")
            mitigation = lim.get("mitigation", "")
            sev = lim.get("severity", "warning")
            lines.append(f"- `{mode}` [{sev}]")
            lines.append(f"    Description: {desc}")
            if mitigation:
                lines.append(f"    Mitigation: {mitigation}")
    else:
        lines.append("(catalog not provided — limit detection to criterion-level only)")
    lines.append("")

    if failure_modes_to_check:
        lines.append("## SPECIFICALLY PROBE FOR")
        for fm in failure_modes_to_check:
            lines.append(f"- {fm}")
        lines.append("")

    lines.append("## VERDICT RULES")
    lines.append("- PASS: aggregate >= 4.0 AND no criterion < 3.0 AND no BLOCKING failure_mode detected")
    lines.append("- WARN: aggregate 3.0-3.9 OR any criterion in 2.0-2.9 (fixable)")
    lines.append("- FAIL: aggregate < 3.0 OR any criterion <= 1.0 OR any BLOCKING failure_mode detected")
    lines.append("")
    lines.append("## RECOMMENDATION VALUES (pick one)")
    lines.append("- `ship` — PASS, no action needed")
    lines.append("- `L1_prompt_fix` — WARN, fixable with prompt rewrite (apply known mitigation)")
    lines.append("- `L2_approach_change` — WARN/FAIL, needs camera/lighting/composition change")
    lines.append("- `L3_escalation` — FAIL against blocking known_limitation — must redesign or replace shot")
    lines.append("- `L3_accept_with_trim` — WARN, good portion ≥60% of clip — trim and move on")
    lines.append("")
    lines.append("## OUTPUT SCHEMA (respond with a JSON object exactly matching this)")
    lines.append(json.dumps(_output_schema_example(), indent=2))
    return "\n".join(lines)


def _output_schema_example() -> dict:
    """Example of the expected JSON output (used in the prompt for grounding)."""
    return {
        "verdict": "PASS | WARN | FAIL",
        "aggregate_score": 4.3,
        "criteria": [
            {"name": name, "score": 0.0, "notes": "Specific observation with timestamps"}
            for name in CRITERIA_NAMES
        ],
        "detected_failure_classes": ["<failure_mode or new_candidate:<name>>"],
        "confidence": 0.0,
        "summary": "1-2 sentence overall assessment",
        "reasoning": "3-5 sentences: what was observed, why the verdict",
        "recommendation": "ship | L1_prompt_fix | L2_approach_change | L3_escalation | L3_accept_with_trim",
    }


def _extract_json_block(text: str) -> dict:
    """Recover JSON from the model output, tolerating fenced code blocks."""
    text = text.strip()
    if text.startswith("```"):
        # Strip ```json ... ``` fences
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            text = text[start : end + 1]
    return json.loads(text)


class VideoGrader:
    """Gemini 3.1 Pro-based multimodal video QA grader.

    Usage:
        grader = VideoGrader()
        result = grader.grade(
            video_path="/path/to/shot_27.mp4",
            profile=brand_profile,
            known_limitations=[...catalog rows...],
        )
    """

    def __init__(self, model: str = DEFAULT_GEMINI_VIDEO_MODEL):
        self.model = model
        self._client: Optional[genai.Client] = None

    @property
    def client(self) -> genai.Client:
        """Lazy init — only creates client when grade() is called."""
        if self._client is None:
            # google-genai reads GOOGLE_API_KEY or Application Default Credentials automatically.
            # We fall through to the SDK's env-var detection.
            self._client = genai.Client()
        return self._client

    def grade(
        self,
        video_path: str,
        profile: BrandProfile,
        *,
        deliverable_context: Optional[str] = None,
        hero_still_path: Optional[str] = None,
        known_limitations: Optional[list[dict]] = None,
        failure_modes_to_check: Optional[list[str]] = None,
    ) -> VideoGradeResult:
        """Grade a video clip. Returns structured VideoGradeResult."""
        t0 = time.time()

        video_file = Path(video_path)
        if not video_file.exists():
            raise FileNotFoundError(f"Video not found: {video_path}")

        rails = _build_rails_prompt(
            brand_profile=profile,
            deliverable_context=deliverable_context,
            known_limitations_context=known_limitations,
            failure_modes_to_check=failure_modes_to_check,
        )

        # Upload the video via File API (google-genai handles this transparently
        # for up to ~2GB files). This path is required for video input — inline
        # bytes are not supported for clips > a few MB.
        logger.info("Uploading video to Gemini File API: %s", video_path)
        uploaded = self.client.files.upload(file=str(video_file))

        # Capture the file's name (SDK returns Optional[str] in typing but API
        # guarantees it exists for valid uploads).
        video_file_name = uploaded.name
        if video_file_name is None:
            raise RuntimeError("Gemini File API returned upload with no name")

        # Wait for file to become ACTIVE (videos take a few seconds to process).
        # Poll with a short budget; fail loud if not active within 60s.
        def _state_str(f) -> str:
            return f.state.name if (f.state is not None) else "UNKNOWN"

        deadline = time.time() + 60
        while _state_str(uploaded) != "ACTIVE" and time.time() < deadline:
            time.sleep(2)
            uploaded = self.client.files.get(name=video_file_name)
        if _state_str(uploaded) != "ACTIVE":
            raise RuntimeError(
                f"Gemini File API did not activate video within 60s (state={_state_str(uploaded)})"
            )

        # Hero still grounding (optional — composition match reference)
        still_part = None
        still_file_name: Optional[str] = None
        if hero_still_path and Path(hero_still_path).exists():
            still_uploaded = self.client.files.upload(file=str(Path(hero_still_path)))
            still_part = still_uploaded
            still_file_name = still_uploaded.name

        # Build contents list: [video, optional still, rails text]
        contents: list = [uploaded]
        if still_part is not None:
            contents.append(still_part)
        contents.append(rails)

        # Structured JSON output via response_mime_type
        config = genai_types.GenerateContentConfig(
            response_mime_type="application/json",
            temperature=0.1,  # Low temp — critic should be deterministic
            max_output_tokens=4096,
        )

        logger.info("Calling Gemini video critic: model=%s, criteria=%d, catalog_size=%d",
                    self.model, len(CRITERIA_NAMES), len(known_limitations or []))

        response = self.client.models.generate_content(
            model=self.model,
            contents=contents,
            config=config,
        )

        raw_text = response.text or ""

        try:
            parsed = _extract_json_block(raw_text)
        except json.JSONDecodeError as e:
            logger.error("Gemini returned invalid JSON: %s\n%s", e, raw_text[:500])
            raise ValueError(f"Gemini video critic returned invalid JSON: {e}")

        # Normalize + validate
        criteria = [
            VideoGradeCriterion(
                name=c.get("name", "unknown"),
                score=float(c.get("score", 0.0)),
                notes=str(c.get("notes", "")),
            )
            for c in parsed.get("criteria", [])
        ]

        detected = [str(fm) for fm in parsed.get("detected_failure_classes", [])]

        # Known blocking modes (from catalog, if supplied)
        blocking_modes: set[str] = set()
        if known_limitations:
            blocking_modes = {
                lim.get("failure_mode", "")
                for lim in known_limitations
                if lim.get("severity") == "blocking"
            }

        # Recompute verdict defensively (don't fully trust the model)
        aggregate = float(parsed.get("aggregate_score") or (
            sum(c.score for c in criteria) / len(criteria) if criteria else 0.0
        ))
        verdict_server = _compute_verdict(aggregate, criteria, detected, blocking_modes)
        verdict_model = str(parsed.get("verdict", "WARN")).upper()
        if verdict_model not in ("PASS", "WARN", "FAIL"):
            verdict_model = verdict_server

        # If model and server disagree, prefer the stricter verdict
        severity_order = {"PASS": 0, "WARN": 1, "FAIL": 2}
        verdict_final = verdict_server if severity_order[verdict_server] > severity_order[verdict_model] else verdict_model

        # Best-effort cost (google-genai doesn't return cost; leave 0.0 for caller to fill)
        latency_ms = int((time.time() - t0) * 1000)

        # Clean up the uploaded file after use (best-effort)
        try:
            self.client.files.delete(name=video_file_name)
            if still_file_name is not None:
                self.client.files.delete(name=still_file_name)
        except Exception as e:
            logger.warning("File cleanup failed (non-fatal): %s", e)

        return VideoGradeResult(
            verdict=verdict_final,
            aggregate_score=aggregate,
            criteria=criteria,
            detected_failure_classes=detected,
            confidence=float(parsed.get("confidence", 0.0)),
            summary=str(parsed.get("summary", "")),
            reasoning=str(parsed.get("reasoning", "")),
            recommendation=str(parsed.get("recommendation", "ship")),
            model=self.model,
            cost=0.0,  # TODO: wire Google Cloud Billing export if needed
            latency_ms=latency_ms,
        )
