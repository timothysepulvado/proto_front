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
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Literal, Optional

from google import genai
from google.genai import types as genai_types


# Vertex inline-payload ceiling. The total request body must stay under ~20MB;
# we reserve ~2MB for the prompt + rails so video+still together max out at 18MB.
# For clips above this, caller must pre-upload to GCS and pass a gs:// URI
# (not yet wired here; file the TODO when the first >18MB clip appears).
MAX_INLINE_VIDEO_BYTES = 18 * 1024 * 1024

# ── Rule-1 critic-consensus defaults (escalation-ops brief) ───────────────────
# Any aggregate_score within ±CONSENSUS_THRESHOLD_BAND of a verdict boundary
# (3.0 FAIL/WARN or 4.0 WARN/PASS) is treated as "borderline" and triggers a
# second Gemini call, per Rule 1 of ~/agent-vault/briefs/escalation-ladder-
# autonomous-ops.md. On disagreement, the frame-extraction fallback grades a
# tile-grid of 1fps samples as a more deterministic tiebreaker.
CONSENSUS_THRESHOLD_BAND = 0.3
CONSENSUS_VERDICT_BOUNDARIES: tuple[float, float] = (3.0, 4.0)
# Per-frame JPEG quality for the tiebreak tile grid. `ffmpeg -qscale:v 2` is
# Jackie's in-brief default; lower numbers = higher quality.
FRAME_STRIP_JPEG_QUALITY = 2
# Default grid geometry. If the clip yields ≤5 frames we fall back to Nx1, else
# we use 3x3 (covers 8-9s clips at 1fps with one throwaway frame max).
FRAME_STRIP_GRID_MAX_SIDE = 3

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


def _is_borderline(
    aggregate_score: float,
    threshold_band: float = CONSENSUS_THRESHOLD_BAND,
    boundaries: tuple[float, ...] = CONSENSUS_VERDICT_BOUNDARIES,
) -> bool:
    """Return True iff aggregate_score sits within `threshold_band` of any verdict boundary.

    Used by grade_video_with_consensus to trigger a second critic call per
    escalation-ops Rule 1. Boundaries default to 3.0 (FAIL/WARN) and 4.0
    (WARN/PASS). Edge-inclusive (`<=`) because a score sitting exactly on the
    boundary is the canonical borderline case.
    """
    return any(abs(aggregate_score - b) <= threshold_band for b in boundaries)


def _build_rails_prompt(
    brand_profile: BrandProfile,
    deliverable_context: Optional[str],
    known_limitations_context: Optional[list[dict]],
    failure_modes_to_check: Optional[list[str]],
    media_kind: Literal["video", "frame_strip"] = "video",
    frame_strip_count: Optional[int] = None,
    narrative_context: Optional[dict] = None,
    music_video_synopsis: Optional[str] = None,
) -> str:
    """Construct the system-level rails for the Gemini video critic.

    This is the 'harness' that makes the critic's output trustworthy for
    downstream orchestrator consumption. Changes here require re-testing
    against known Shot 20 PASS / Shot 27 WARN baselines.

    When `media_kind="frame_strip"` the intro is swapped to tell Gemini it's
    seeing a tile grid of 1fps samples — used by the consensus tiebreaker
    (escalation-ops Rule 1) when two raw video calls disagree.

    Chunk 1 (2026-04-21): when `narrative_context` is provided, three extra
    sections are rendered — a self-awareness preamble, ## SHOT POSITION IN
    MUSIC VIDEO, and ## STYLIZATION BUDGET FOR THIS SHOT. VERDICT RULES +
    CRITERIA + OUTPUT SCHEMA are deliberately NOT modified — stylization
    budget widens the input, not the rubric.
    """
    lines: list[str] = []
    if media_kind == "frame_strip":
        n = frame_strip_count or 9
        lines.append("You are a multimodal brand-QA critic for the BrandStudios orchestration engine.")
        lines.append(
            f"Your job: analyze the attached tile grid of {n} frames sampled at 1fps from a generated video clip "
            "and produce a structured verdict in JSON. This is a consensus-tiebreak pass — "
            "two independent calls on the full video disagreed, so you are scoring the discrete frame evidence."
        )
        lines.append(
            "Evaluate the same motion-oriented criteria (morphing, temporal_jitter, lighting_flicker, scale_creep, "
            "camera_smoothness, character_drift, wardrobe_drift, atmospheric_creep, vfx_dissipation, "
            "composition_stability) using across-frame comparisons instead of frame-by-frame animation. "
            "Treat the grid as a left-to-right, top-to-bottom timeline."
        )
        lines.append("")
    else:
        lines.append("You are a multimodal brand-QA critic for the BrandStudios orchestration engine.")
        lines.append("Your job: watch the attached video clip and produce a structured verdict in JSON.")
        lines.append("")

    # ─── Chunk 1: self-awareness preamble (only for music-video shots) ────
    if narrative_context:
        shot_n = narrative_context.get("shot_number")
        lines.append(
            f"You are Gemini 3.1 Pro scoring shot {shot_n} of 30 in the BrandStudios "
            f"'Drift' music video. You have known variance on borderline scores (within "
            f"±0.3 of 3.0 or 4.0) — Rule 1 consensus tiebreak will fire automatically if "
            f"your aggregate lands there. Trust your judgment but note genuine uncertainty "
            f"in `reasoning`. Before scoring morphing, character_drift, or scale_creep as "
            f"catastrophic, check the STYLIZATION BUDGET section below."
        )
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

    # ─── Chunk 1: SHOT POSITION IN MUSIC VIDEO ────────────────────────────
    if narrative_context:
        nc = narrative_context
        lines.append("## SHOT POSITION IN MUSIC VIDEO")
        if music_video_synopsis:
            lines.append(f"**Music video:** {music_video_synopsis}")
        lines.append(
            f"**Shot {nc['shot_number']} of 30** | beat: `{nc['beat_name']}` | "
            f"song: {nc['song_start_s']:.1f}s–{nc['song_end_s']:.1f}s"
        )
        lines.append(f"**Visual intent:** {nc['visual_intent']}")
        if nc.get("previous_shot"):
            ps = nc["previous_shot"]
            lines.append(
                f"**Previous shot ({ps['shot_number']}, {ps['beat_name']}):** "
                f"{ps['visual_intent_summary']}"
            )
        if nc.get("next_shot"):
            ns = nc["next_shot"]
            lines.append(
                f"**Next shot ({ns['shot_number']}, {ns['beat_name']}):** "
                f"{ns['visual_intent_summary']}"
            )
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

    # ─── Chunk 1: STYLIZATION BUDGET FOR THIS SHOT ────────────────────────
    if narrative_context and narrative_context.get("stylization_allowances"):
        lines.append("## STYLIZATION BUDGET FOR THIS SHOT")
        lines.append(
            "The following visual effects are INTENTIONAL for this shot's narrative role:"
        )
        for allowance in narrative_context["stylization_allowances"]:
            lines.append(f"- {allowance}")
        lines.append("")
        lines.append(
            "When detecting a criterion deficit that matches a stylization allowance above, "
            "note this in `reasoning` ('intentional per stylization budget') and do NOT "
            "auto-FAIL on that criterion alone. "
            "**VERDICT RULES stay fixed** — this widens the input, not the rubric."
        )
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


def _repair_truncated_json(text: str) -> Optional[dict]:
    """Best-effort recovery for Gemini-truncated JSON output.

    Gemini 3.1 Pro periodically returns truncated JSON when its response runs
    over the `max_output_tokens` budget — measured at ~20% rate during Step 10d
    full-catalog regrade, the chief cause of brand-engine critic failures
    blocking the orchestrator. This helper tries a small ladder of progressive
    repairs and returns the first parse-success, or None if nothing recovers.

    Repair strategies (applied in order, each on top of the last):
      1. Strip trailing whitespace + trailing commas
      2. Drop a partial mid-string value (find unbalanced quote, chop)
      3. Append closers to balance `{` and `[` counts
      4. Try with one more closer in case a partial token confused the count

    On success the recovered structure is annotated with a synthetic
    `_truncation_recovered: true` field so downstream code can flag it for
    quality monitoring (the orchestrator can decide whether a recovered grade
    counts toward consensus or not).
    """
    candidate = text.strip()
    if not candidate:
        return None

    # Step 1: trailing whitespace + trailing commas (common on `,` cutoffs)
    while candidate and candidate[-1] in " \t\n\r,":
        candidate = candidate[:-1]
    if not candidate:
        return None

    # Step 2: detect odd number of unescaped quotes → truncated mid-string.
    # Walk char-by-char respecting backslash escapes.
    quote_count = 0
    i = 0
    while i < len(candidate):
        c = candidate[i]
        if c == "\\":
            i += 2  # skip escaped char
            continue
        if c == '"':
            quote_count += 1
        i += 1
    if quote_count % 2 == 1:
        # Odd quote → we're inside a string. Walk back to the last opening
        # quote and chop everything from that key:value onward (including
        # any preceding comma).
        # Find the last unescaped `"` before truncation.
        j = len(candidate) - 1
        while j >= 0:
            if candidate[j] == '"' and (j == 0 or candidate[j - 1] != "\\"):
                # Walk back further to find the property's preceding `,` or `{`.
                k = j - 1
                while k >= 0 and candidate[k] not in ",{":
                    k -= 1
                if k >= 0:
                    candidate = candidate[: k].rstrip().rstrip(",").rstrip()
                else:
                    candidate = ""
                break
            j -= 1
        if not candidate:
            return None

    # Strip another trailing comma if Step 2 left one
    while candidate and candidate[-1] in " \t\n\r,:":
        candidate = candidate[:-1]
    if not candidate:
        return None

    # Step 3: walk the candidate respecting string boundaries and build a
    # nesting stack of open `{` and `[`. The remaining stack at end-of-walk is
    # what needs closing — close in reverse order so the inner-most opens are
    # closed first (so `[{` closes as `}]`, not `]}`).
    stack: list[str] = []
    in_string = False
    i = 0
    while i < len(candidate):
        c = candidate[i]
        if c == "\\":
            i += 2
            continue
        if c == '"':
            in_string = not in_string
            i += 1
            continue
        if not in_string:
            if c in "{[":
                stack.append(c)
            elif c == "}":
                if not stack or stack[-1] != "{":
                    return None  # malformed shape
                stack.pop()
            elif c == "]":
                if not stack or stack[-1] != "[":
                    return None
                stack.pop()
        i += 1
    # Anything still open in `stack` needs closing (reversed = innermost first).
    closer_chars = []
    for opener in reversed(stack):
        closer_chars.append("}" if opener == "{" else "]")
    closer = "".join(closer_chars)
    repaired = candidate + closer

    try:
        parsed = json.loads(repaired)
    except json.JSONDecodeError:
        # One more attempt: maybe a value is still partial (e.g., a number
        # with a trailing `.`). Add an extra `}` and retry; if still bad, fail.
        try:
            parsed = json.loads(repaired + "}")
        except json.JSONDecodeError:
            return None

    if isinstance(parsed, list):
        if len(parsed) == 1 and isinstance(parsed[0], dict):
            parsed = parsed[0]
        else:
            return None
    if not isinstance(parsed, dict):
        return None

    parsed["_truncation_recovered"] = True
    return parsed


def _extract_json_block(text: str) -> dict:
    """Recover JSON from the model output, tolerating fenced code blocks.

    Gemini 3.x sometimes returns `[{...}]` (single-element array) when asked
    for a JSON object via response_mime_type="application/json"; unwrap that.

    Also handles truncated JSON via `_repair_truncated_json` when the initial
    parse fails — Gemini has a measured ~20% truncation rate on long critic
    responses (Step 10d full-catalog regrade evidence). Recovered grades are
    annotated with `_truncation_recovered: true` for downstream monitoring.
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
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as initial_err:
        recovered = _repair_truncated_json(text)
        if recovered is not None:
            logger.warning(
                "Gemini critic JSON was truncated (%d chars); recovered via "
                "best-effort repair. Verdict marked with _truncation_recovered=true.",
                len(text),
            )
            return recovered
        # Re-raise original error with a more helpful tail for diagnosis
        raise json.JSONDecodeError(
            f"{initial_err.msg} (no recovery possible)",
            initial_err.doc,
            initial_err.pos,
        )

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
        narrative_context: Optional[dict] = None,
        music_video_synopsis: Optional[str] = None,
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
            narrative_context=narrative_context,
            music_video_synopsis=music_video_synopsis,
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
            max_output_tokens=16384,
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

        # Best-effort cost (google-genai doesn't return usage/cost yet). Keep 0
        # and let os-api ledger mark metadata.cost_unknown=true until provider
        # billing export/token accounting is plumbed.
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
            cost_usd=0.0,
            latency_ms=latency_ms,
        )

    # ── Rule 1 — critic consensus + frame-extraction tiebreak ─────────────
    # Escalation-ops brief: critic variance is real (Shot 05 swung WARN 4.52 →
    # PASS 5.0 on the same clip). On borderline aggregate scores, we run a
    # second pass; on disagreement between the two passes, we tile a 1fps
    # frame extract and grade the grid as a more deterministic tiebreaker.
    def grade_video_with_consensus(
        self,
        video_path: str,
        profile: BrandProfile,
        *,
        deliverable_context: Optional[str] = None,
        hero_still_path: Optional[str] = None,
        known_limitations: Optional[list[dict]] = None,
        failure_modes_to_check: Optional[list[str]] = None,
        n_runs: int = 2,
        threshold_band: float = CONSENSUS_THRESHOLD_BAND,
        narrative_context: Optional[dict] = None,
        music_video_synopsis: Optional[str] = None,
    ) -> VideoGradeResult:
        """Grade a video with Rule-1 consensus discipline.

        Flow:
          1. Grade once (call 1).
          2. If call 1's aggregate_score is NOT borderline (|score - 3.0| > band
             AND |score - 4.0| > band), return call 1 with
             consensus_note="not borderline, single call".
          3. If borderline, run call 2 — same inputs, fresh Gemini call:
             - If both verdicts agree → return the higher-confidence result
               with consensus_note="agreed N=2".
             - If they disagree → invoke _frame_extraction_fallback as tiebreak;
               return the fallback result with a consensus_note describing
               the resolution.

        `n_runs` is currently supported as 2 (the escalation-ops brief
        specifies N=2). Higher values are accepted for future use but treated
        as 2 by the agreement/disagreement branching; the helper is intentionally
        conservative to match Rule 1 as written.
        """
        if n_runs < 1:
            raise ValueError(f"n_runs must be >= 1, got {n_runs}")

        first = self.grade(
            video_path=video_path,
            profile=profile,
            deliverable_context=deliverable_context,
            hero_still_path=hero_still_path,
            known_limitations=known_limitations,
            failure_modes_to_check=failure_modes_to_check,
            narrative_context=narrative_context,
            music_video_synopsis=music_video_synopsis,
        )

        if not _is_borderline(first.aggregate_score, threshold_band):
            first.consensus_note = "not borderline, single call"
            logger.info(
                "Consensus: single call (aggregate=%.2f outside ±%.2f of %s)",
                first.aggregate_score, threshold_band, CONSENSUS_VERDICT_BOUNDARIES,
            )
            return first

        logger.info(
            "Consensus: aggregate=%.2f is borderline (±%.2f of %s) — running second pass",
            first.aggregate_score, threshold_band, CONSENSUS_VERDICT_BOUNDARIES,
        )
        second = self.grade(
            video_path=video_path,
            profile=profile,
            deliverable_context=deliverable_context,
            hero_still_path=hero_still_path,
            known_limitations=known_limitations,
            failure_modes_to_check=failure_modes_to_check,
            narrative_context=narrative_context,
            music_video_synopsis=music_video_synopsis,
        )

        if first.verdict == second.verdict:
            winner = first if first.confidence >= second.confidence else second
            winner.consensus_note = (
                f"agreed N=2 (verdicts={first.verdict}, "
                f"scores={first.aggregate_score:.2f}/{second.aggregate_score:.2f})"
            )
            logger.info(
                "Consensus: verdicts agreed (%s); returning higher-confidence call (%.2f)",
                first.verdict, winner.confidence,
            )
            return winner

        logger.warning(
            "Consensus: disagreement (call1=%s %.2f, call2=%s %.2f) — invoking frame-extraction fallback",
            first.verdict, first.aggregate_score, second.verdict, second.aggregate_score,
        )
        tiebreak = self._frame_extraction_fallback(
            video_path=video_path,
            profile=profile,
            deliverable_context=deliverable_context,
            hero_still_path=hero_still_path,
            known_limitations=known_limitations,
            failure_modes_to_check=failure_modes_to_check,
            original_verdicts=(first, second),
            narrative_context=narrative_context,
            music_video_synopsis=music_video_synopsis,
        )
        return tiebreak

    def _frame_extraction_fallback(
        self,
        video_path: str,
        profile: BrandProfile,
        *,
        deliverable_context: Optional[str] = None,
        hero_still_path: Optional[str] = None,
        known_limitations: Optional[list[dict]] = None,
        failure_modes_to_check: Optional[list[str]] = None,
        original_verdicts: Optional[tuple[VideoGradeResult, VideoGradeResult]] = None,
        narrative_context: Optional[dict] = None,
        music_video_synopsis: Optional[str] = None,
    ) -> VideoGradeResult:
        """Tile 1fps ffmpeg extracts into a grid image and grade as single image.

        Used by grade_video_with_consensus when two video passes disagree. The
        tile grid gives Gemini discrete evidence of what happens across the
        clip's duration, which is more deterministic than a third full-video
        LLM call on the same variance surface.

        On success returns a VideoGradeResult with consensus_note describing
        the tiebreak. Temp working directory is always cleaned up.
        """
        t0 = time.time()
        video_file = Path(video_path)
        if not video_file.exists():
            raise FileNotFoundError(f"Video not found: {video_path}")

        ffmpeg_bin = shutil.which("ffmpeg")
        if ffmpeg_bin is None:
            raise RuntimeError(
                "ffmpeg not found on PATH; frame-extraction fallback cannot run. "
                "brew install ffmpeg"
            )

        with tempfile.TemporaryDirectory(prefix="be_frames_") as tmp:
            tmp_path = Path(tmp)
            # 1. Extract 1fps frames to tmp/frame_%03d.jpg
            subprocess.run(
                [
                    ffmpeg_bin, "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-y", "-i", str(video_file),
                    "-vf", "fps=1",
                    "-qscale:v", str(FRAME_STRIP_JPEG_QUALITY),
                    str(tmp_path / "frame_%03d.jpg"),
                ],
                check=True,
                capture_output=True,
            )
            frames = sorted(tmp_path.glob("frame_*.jpg"))
            if not frames:
                raise RuntimeError(
                    f"ffmpeg produced no frames for {video_path} — cannot run "
                    "consensus tiebreak. Check that the clip duration is ≥1s."
                )

            frame_count = len(frames)
            # 2. Tile into a grid — 3x3 when we have ≥6 frames, else Nx1.
            if frame_count >= 6:
                cols = FRAME_STRIP_GRID_MAX_SIDE
                tile_spec = f"tile={cols}x{FRAME_STRIP_GRID_MAX_SIDE}"
            else:
                tile_spec = f"tile={frame_count}x1"

            grid_path = tmp_path / "grid.jpg"
            subprocess.run(
                [
                    ffmpeg_bin, "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-y", "-i", str(tmp_path / "frame_%03d.jpg"),
                    "-filter_complex", tile_spec,
                    "-qscale:v", str(FRAME_STRIP_JPEG_QUALITY),
                    str(grid_path),
                ],
                check=True,
                capture_output=True,
            )
            if not grid_path.exists():
                raise RuntimeError("ffmpeg tile pass produced no grid.jpg")

            grid_bytes = grid_path.read_bytes()

        # 3. Grade the grid image against the same rails, with a frame_strip intro.
        rails = _build_rails_prompt(
            brand_profile=profile,
            deliverable_context=deliverable_context,
            known_limitations_context=known_limitations,
            failure_modes_to_check=failure_modes_to_check,
            media_kind="frame_strip",
            frame_strip_count=frame_count,
            narrative_context=narrative_context,
            music_video_synopsis=music_video_synopsis,
        )

        grid_part = genai_types.Part.from_bytes(data=grid_bytes, mime_type="image/jpeg")

        contents: list = [grid_part]
        if hero_still_path and Path(hero_still_path).exists():
            still_file = Path(hero_still_path)
            still_mime, _ = mimetypes.guess_type(str(still_file))
            if still_mime is None:
                still_mime = "image/png"
            contents.append(
                genai_types.Part.from_bytes(
                    data=still_file.read_bytes(),
                    mime_type=still_mime,
                )
            )
        contents.append(rails)

        config = genai_types.GenerateContentConfig(
            response_mime_type="application/json",
            temperature=0.1,
            max_output_tokens=16384,
        )

        logger.info(
            "Frame-strip tiebreak: %d frames, grid=%s, backend=%s, model=%s",
            frame_count, tile_spec, self.backend, self.model,
        )

        response = self.client.models.generate_content(
            model=self.model,
            contents=contents,
            config=config,
        )
        raw_text = response.text or ""
        try:
            parsed = _extract_json_block(raw_text)
        except json.JSONDecodeError as e:
            logger.error("Tiebreak Gemini returned invalid JSON: %s\n%s", e, raw_text[:500])
            raise ValueError(f"Frame-strip tiebreak returned invalid JSON: {e}")

        criteria = [
            VideoGradeCriterion(
                name=c.get("name", "unknown"),
                score=float(c.get("score", 0.0)),
                notes=str(c.get("notes", "")),
            )
            for c in parsed.get("criteria", [])
        ]
        detected = [str(fm) for fm in parsed.get("detected_failure_classes", [])]
        blocking_modes: set[str] = set()
        if known_limitations:
            blocking_modes = {
                lim.get("failure_mode", "")
                for lim in known_limitations
                if lim.get("severity") == "blocking"
            }
        aggregate = float(parsed.get("aggregate_score") or (
            sum(c.score for c in criteria) / len(criteria) if criteria else 0.0
        ))
        verdict_server = _compute_verdict(aggregate, criteria, detected, blocking_modes)
        verdict_model = str(parsed.get("verdict", "WARN")).upper()
        if verdict_model not in ("PASS", "WARN", "FAIL"):
            verdict_model = verdict_server
        severity_order = {"PASS": 0, "WARN": 1, "FAIL": 2}
        verdict_final = verdict_server if severity_order[verdict_server] > severity_order[verdict_model] else verdict_model

        latency_ms = int((time.time() - t0) * 1000)
        note = f"frame-strip tiebreak {frame_count} frames"
        if original_verdicts is not None:
            a, b = original_verdicts
            note = (
                f"disagreement resolved via frame extraction "
                f"({frame_count} frames; call1={a.verdict} {a.aggregate_score:.2f}, "
                f"call2={b.verdict} {b.aggregate_score:.2f})"
            )

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
            cost=0.0,
            cost_usd=0.0,
            latency_ms=latency_ms,
            consensus_note=note,
        )
