"""Video grader: Gemini multimodal critic for generated video clips.

Supports two backends (toggle via `GEMINI_VIDEO_CRITIC_BACKEND` env):

  * `ai_studio` (default) — AI Studio via `GOOGLE_GENAI_API_KEY`.
    Default model `gemini-3.1-pro-preview`. Video delivered via the File API.
    This is the operational path while `bran-479523` awaits Gemini 3 Vertex
    preview access.

  * `vertex` — Vertex AI via ADC on `bran-479523`. Default model
    `gemini-2.5-pro` (2.5 is the highest Gemini family available on the
    project today). Video delivered as inline `Part.from_bytes` — Vertex
    does not expose the Developer-API File upload surface. Override to
    `gemini-3-pro-preview` via `GEMINI_VIDEO_CRITIC_VERTEX_MODEL` once the
    project is allow-listed.

This is the in-process version of what Jackie (the Gemini CLI agent) does
manually. It accepts a video clip + brand context + known-limitation catalog
subset, invokes Gemini with a locked prompt harness, and returns a
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
import mimetypes
import os
import time
from pathlib import Path
from typing import Optional

from google import genai
from google.genai import types as genai_types


# Vertex inline-payload ceiling. The total request body must stay under ~20MB;
# we reserve ~2MB for the prompt + rails so video+still together max out at 18MB.
# For clips above this, caller must pre-upload to GCS and pass a gs:// URI
# (not yet wired here; file the TODO when the first >18MB clip appears).
MAX_INLINE_VIDEO_BYTES = 18 * 1024 * 1024

from brand_engine.core.models import (
    BrandProfile,
    VideoGradeCriterion,
    VideoGradeResult,
)

logger = logging.getLogger(__name__)


# ── Backend selection + per-backend model ids ────────────────────────────────
# Two backends supported. Default backend is `ai_studio` because
# `bran-479523` is not yet allow-listed for Gemini 3 Vertex preview access
# (all gemini-3.* ids return 404 on that project as of 2026-04-17).
#
#   BACKEND      MODEL ID                    AUTH                         VIDEO DELIVERY
#   ─────────    ─────────────────────────── ──────────────────────────── ──────────────────────
#   ai_studio    gemini-3.1-pro-preview      GOOGLE_GENAI_API_KEY         File API upload
#   vertex       gemini-3-pro-preview        ADC on bran-479523           inline Part.from_bytes
#
# 2.5-family ids are intentionally not defaults — Drift MV expects Gemini 3
# quality. If Vertex access hasn't landed, stay on the ai_studio backend.
#
# Rotate per-service via env — do not edit these defaults casually:
#   GEMINI_VIDEO_CRITIC_BACKEND=ai_studio|vertex
#   GEMINI_VIDEO_CRITIC_AI_STUDIO_MODEL=<id>
#   GEMINI_VIDEO_CRITIC_VERTEX_MODEL=<id>
DEFAULT_VIDEO_CRITIC_BACKEND = os.getenv("GEMINI_VIDEO_CRITIC_BACKEND", "ai_studio").lower()
DEFAULT_AI_STUDIO_VIDEO_MODEL = os.getenv(
    "GEMINI_VIDEO_CRITIC_AI_STUDIO_MODEL", "gemini-3.1-pro-preview"
)
DEFAULT_VERTEX_VIDEO_MODEL = os.getenv(
    "GEMINI_VIDEO_CRITIC_VERTEX_MODEL", "gemini-3-pro-preview"
)

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
    """Recover JSON from the model output, tolerating fenced code blocks.

    Gemini 3.x sometimes returns `[{...}]` (single-element array) when asked
    for a JSON object via response_mime_type="application/json"; unwrap that.
    """
    text = text.strip()
    if text.startswith("```"):
        # Strip ```json ... ``` fences — keep the first balanced JSON value.
        for open_ch, close_ch in (("{", "}"), ("[", "]")):
            start = text.find(open_ch)
            end = text.rfind(close_ch)
            if start >= 0 and end > start:
                text = text[start : end + 1]
                break
    parsed = json.loads(text)
    if isinstance(parsed, list):
        # Unwrap single-element arrays — a common Gemini quirk.
        if len(parsed) == 1 and isinstance(parsed[0], dict):
            return parsed[0]
        raise ValueError(
            f"Expected a JSON object (VideoGradeResult), got a {len(parsed)}-element array"
        )
    if not isinstance(parsed, dict):
        raise ValueError(f"Expected a JSON object, got {type(parsed).__name__}")
    return parsed


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

    def __init__(
        self,
        model: Optional[str] = None,
        backend: Optional[str] = None,
    ):
        self.backend = (backend or DEFAULT_VIDEO_CRITIC_BACKEND).lower()
        if self.backend not in ("ai_studio", "vertex"):
            raise ValueError(
                f"Unknown backend '{self.backend}'. "
                "Set GEMINI_VIDEO_CRITIC_BACKEND=ai_studio or vertex."
            )
        if model is not None:
            self.model = model
        elif self.backend == "vertex":
            self.model = DEFAULT_VERTEX_VIDEO_MODEL
        else:
            self.model = DEFAULT_AI_STUDIO_VIDEO_MODEL
        self._client: Optional[genai.Client] = None

    @property
    def client(self) -> genai.Client:
        """Lazy init — only creates client when grade() is called.

        Auth depends on backend:
          * ai_studio → GOOGLE_GENAI_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY
          * vertex    → ADC (gcloud auth application-default login) or
                        GOOGLE_APPLICATION_CREDENTIALS → service-account JSON
        """
        if self._client is not None:
            return self._client
        if self.backend == "vertex":
            self._client = genai.Client(
                vertexai=True,
                project=os.getenv("VERTEX_PROJECT_ID", "bran-479523"),
                location=os.getenv("VERTEX_REGION", "global"),
            )
        else:
            api_key = (
                os.getenv("GOOGLE_API_KEY")
                or os.getenv("GEMINI_API_KEY")
                or os.getenv("GOOGLE_GENAI_API_KEY")
            )
            if not api_key:
                raise ValueError(
                    "GOOGLE_GENAI_API_KEY (or GEMINI_API_KEY / GOOGLE_API_KEY) "
                    "is required for the ai_studio backend."
                )
            self._client = genai.Client(api_key=api_key)
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

        # Video delivery depends on backend. AI Studio has the File API (large
        # clips, server-side processing); Vertex does not expose it, so we use
        # inline Part.from_bytes with a safety ceiling.
        uploaded_names: list[str] = []  # remote files to clean up post-response
        if self.backend == "ai_studio":
            logger.info("Uploading video via AI Studio File API: %s", video_path)
            uploaded = self.client.files.upload(file=str(video_file))
            if uploaded.name is None:
                raise RuntimeError("AI Studio File API returned upload with no name")
            video_file_name: str = uploaded.name
            uploaded_names.append(video_file_name)

            def _state(f) -> str:
                return f.state.name if (f.state is not None) else "UNKNOWN"

            deadline = time.time() + 60
            while _state(uploaded) != "ACTIVE" and time.time() < deadline:
                time.sleep(2)
                uploaded = self.client.files.get(name=video_file_name)
            if _state(uploaded) != "ACTIVE":
                raise RuntimeError(
                    f"AI Studio File API did not activate video within 60s (state={_state(uploaded)})"
                )
            video_content = uploaded

            still_content = None
            if hero_still_path and Path(hero_still_path).exists():
                still_up = self.client.files.upload(file=hero_still_path)
                if still_up.name is not None:
                    uploaded_names.append(still_up.name)
                still_content = still_up
        else:  # vertex — inline bytes
            video_size = video_file.stat().st_size
            if video_size > MAX_INLINE_VIDEO_BYTES:
                raise ValueError(
                    f"Video exceeds inline limit ({video_size} bytes > "
                    f"{MAX_INLINE_VIDEO_BYTES}). Upload to GCS and pass a gs:// URI "
                    f"(not yet wired — see video_grader.py TODO)."
                )
            logger.info("Loading video inline for Vertex (%d bytes): %s", video_size, video_path)
            video_content = genai_types.Part.from_bytes(
                data=video_file.read_bytes(),
                mime_type="video/mp4",
            )

            still_content = None
            if hero_still_path and Path(hero_still_path).exists():
                still_file = Path(hero_still_path)
                still_mime, _ = mimetypes.guess_type(str(still_file))
                if still_mime is None:
                    still_mime = "image/png"
                still_content = genai_types.Part.from_bytes(
                    data=still_file.read_bytes(),
                    mime_type=still_mime,
                )

        # Build contents list: [video, optional still, rails text]
        contents: list = [video_content]
        if still_content is not None:
            contents.append(still_content)
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

        # Clean up AI Studio File API uploads (no-op for Vertex inline path).
        for name in uploaded_names:
            try:
                self.client.files.delete(name=name)
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
