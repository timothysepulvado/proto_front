"""Stills critic-in-loop grader (ADR-004 Phase A).

Public entry: ``grade_image_v2(...)``.

Mirrors the VideoGrader pattern (brand_engine.core.video_grader.VideoGrader)
but for single still images via Gemini 3 Pro Vision. Two modes:

  * ``audit``    — score in isolation; skip rubric Rules 6+7 (no pivot history)
  * ``in_loop``  — score during regen iteration; apply Rules 6+7
                   (consume pivot_rewrite_history; degenerate-loop guard)

Production contracts:
  * ``_call_gemini_vision`` is the module-level helper that the test scaffold
    mocks by name (test_grade_image_v2.py:152, 177, 203, 227, 298). Do NOT
    rename or move it.
  * Pre-flight 2000-char prompt ceiling raises ValueError BEFORE any image
    load or Gemini call (NB Pro hard limit, productized as orchestrator
    pre-flight per STILLS_AUDIT_15_SHOTS.md).
  * Image-load failure returns a synthetic verdict=FAIL ImageGradeResult —
    never raises. Critics always emit a structured verdict.
  * Markdown-fenced responses are stripped transparently via the existing
    _extract_json_block helper (video_grader.py:472) — single source of truth
    for JSON-from-Gemini parsing.
  * 429 retry uses exponential backoff (1s → 2s → 4s, 3 attempts) before
    re-raising. 5xx propagates immediately.
  * Every call emits one structured logger.info JSON line tagged
    ``event=critic_call`` for observability (Phase F).

This module is intentionally feature-flagged at the route level: the brand-
engine core is loaded at import time, but the route in ``brand_engine.api.server``
is only mounted when the FastAPI app starts. Phase B's runner is what makes
it part of the production critical path.
"""
from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from google import genai
from google.genai import types as genai_types

from brand_engine.core.known_limitations_loader import load_image_class_limitations
from brand_engine.core.models import (
    ImageGradeMode,
    ImageGradeRecommendation,
    ImageGradeResult,
    VideoGradeCriterion,
)
from brand_engine.core.video_grader import _extract_json_block

logger = logging.getLogger(__name__)


# ── Backend selection (reuses video critic env for parity) ──────────────────
DEFAULT_IMAGE_CRITIC_BACKEND = os.getenv(
    "GEMINI_IMAGE_CRITIC_BACKEND",
    os.getenv("GEMINI_VIDEO_CRITIC_BACKEND", "ai_studio"),
).lower()
DEFAULT_AI_STUDIO_IMAGE_MODEL = os.getenv(
    "GEMINI_IMAGE_CRITIC_AI_STUDIO_MODEL", "gemini-3.1-pro-preview"
)
DEFAULT_VERTEX_IMAGE_MODEL = os.getenv(
    "GEMINI_IMAGE_CRITIC_VERTEX_MODEL", "gemini-3-pro-preview"
)


# ── Stills rubric — 6 criteria locked to ADR-004 brief ──────────────────────
STILLS_CRITERIA: list[str] = [
    "character_consistency",
    "hand_anatomy",
    "mech_color_identity",
    "composition",
    "narrative_alignment",
    "aesthetic_match",
]

STILLS_CRITERIA_DESCRIPTIONS: dict[str, str] = {
    "character_consistency": (
        "Anchors locked the right faces / mech identities. Score against the "
        "anchor reference images (brandy_anchor, mech_*_anchor, rapper_*_anchor)."
    ),
    "hand_anatomy": (
        "Hands (when present) are anatomically correct. Mangled fingers, extra "
        "digits, or morphing → low score. Hands cropped per composition guard "
        "and not visible → score 5.0 (n/a)."
    ),
    "mech_color_identity": (
        "Hex-coded mech colors clearly distinguishable per faction. Color "
        "homogenization (e.g., backlight gold wash) drops the score."
    ),
    "composition": (
        "Frame, lens, depth, blocking match prompt intent. Symmetric parade "
        "formations, action-figure dioramas, or centered bullseye staging "
        "drop the score."
    ),
    "narrative_alignment": (
        "Image carries the manifest beat for this shot. Active poses for "
        "deactivated/aftermath beats drop the score."
    ),
    "aesthetic_match": (
        "Documentary-dry mantra preserved (Tyler Hicks tradition; real "
        "materials; real lighting). 3D-render polish, fairy dust, magical "
        "auras drop the score."
    ),
}

# Output schema example baked into the prompt for grounding (mirrors
# video_grader._output_schema_example pattern).
STILLS_OUTPUT_SCHEMA_EXAMPLE: dict = {
    "verdict": "PASS | WARN | FAIL",
    "aggregate_score": 4.3,
    "criteria": [
        {"name": name, "score": 4.5, "notes": f"Specific observation about {name}"}
        for name in STILLS_CRITERIA
    ],
    "detected_failure_classes": [],
    "confidence": 0.85,
    "summary": "1-2 sentence overall assessment",
    "reasoning": "3-5 sentences: visual evidence + verdict rationale",
    "recommendation": "ship",
    "shot_number": None,
    "new_candidate_limitation": None,
}

# ── Constants ───────────────────────────────────────────────────────────────
MAX_PROMPT_CHARS = 2000  # NB Pro hard limit (productized pre-flight check)
RETRY_BACKOFFS_S: list[float] = [1.0, 2.0, 4.0]  # 3-attempt exponential backoff
GEMINI_MAX_OUTPUT_TOKENS = 16384  # Mirror video_grader; truncation recovery handles overflow

# Penalty-marker syntax embedded in known_limitations.mitigation text. Migration
# 012 (`012_direction_drift_failure_classes.sql`) introduces this format because
# Phase B+ smoke #4 found the existing descriptive mitigation text was too soft
# — the model treated the catalog as "here's how to fix" rather than "deduct
# points if detected." Format: `<<DEDUCT: criterion_a=-N.N, criterion_b=-M.M>>`.
# Phase H replaces this with a typed `deductions` JSONB column on
# known_limitations; for now it stays in mitigation text (additive, no schema
# migration). The deductions are applied SERVER-SIDE in
# `_apply_failure_class_deductions` after the model returns — defensive recompute.
_DEDUCT_MARKER_RE = re.compile(r"<<DEDUCT:\s*([^>]+?)\s*>>")
_DEDUCT_PAIR_RE = re.compile(r"([a-z_][a-z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?)")

# ── Module-scope client cache (lazy-init via _get_client) ───────────────────
_genai_client: Optional[genai.Client] = None


def _parse_deductions_from_mitigation(mitigation: Optional[str]) -> dict[str, float]:
    """Parse a `<<DEDUCT: criterion=-N.N, ...>>` marker from a mitigation string.

    Returns a dict mapping criterion name (snake_case) to deduction (negative
    float). Returns empty dict when no marker is present, when mitigation is
    None/empty, or when the marker is malformed.

    Examples:
        >>> _parse_deductions_from_mitigation("<<DEDUCT: narrative_alignment=-1.5, aesthetic_match=-1.0>>")
        {"narrative_alignment": -1.5, "aesthetic_match": -1.0}
        >>> _parse_deductions_from_mitigation("plain text, no marker")
        {}
    """
    if not mitigation:
        return {}
    m = _DEDUCT_MARKER_RE.search(mitigation)
    if not m:
        return {}
    body = m.group(1)
    out: dict[str, float] = {}
    for pair in _DEDUCT_PAIR_RE.finditer(body):
        try:
            out[pair.group(1)] = float(pair.group(2))
        except (ValueError, TypeError):
            # Malformed numeric — skip this pair, keep parsing rest defensively.
            continue
    return out


def _apply_failure_class_deductions(
    criteria: list["VideoGradeCriterion"],
    detected_failure_classes: list[str],
    known_limitations: list[dict],
) -> tuple[list["VideoGradeCriterion"], dict[str, dict[str, float]]]:
    """Apply server-side deductions for detected failure classes.

    For each failure_class in `detected_failure_classes` that maps to a
    known_limitations row with a parseable `<<DEDUCT: ...>>` marker, subtract
    the deduction from the named criterion's score. Floors at 0.0; never goes
    negative.

    Returns the updated criteria list AND an audit trail
    (`{failure_class: {criterion: deducted_amount, ...}}`) for the structured
    log line and reasoning string.

    Idempotency: this function recomputes scores from the current `criteria`
    state. If the model already self-applied the deductions in its response,
    re-applying server-side would double-deduct. To prevent that, we use a
    tolerance check: if the criterion score is already AT or below the
    expected post-deduction floor, we DON'T re-apply. This is the
    smoke-#4-finding fix: the model is unreliable about applying deductions,
    so we apply them defensively, but we don't double-punish if it did.
    """
    if not detected_failure_classes or not known_limitations:
        return criteria, {}

    # Build a quick lookup from failure_mode → mitigation text.
    mitigation_by_mode: dict[str, str] = {}
    for lim in known_limitations:
        fm = lim.get("failure_mode")
        if isinstance(fm, str):
            mitigation_by_mode[fm] = str(lim.get("mitigation") or "")

    # Index criteria by name for in-place updates.
    criteria_by_name: dict[str, "VideoGradeCriterion"] = {c.name: c for c in criteria}

    audit: dict[str, dict[str, float]] = {}

    for fc in detected_failure_classes:
        # Skip new_candidate:* classes — by definition not in catalog yet.
        if not isinstance(fc, str) or fc.startswith("new_candidate:"):
            continue
        mitigation = mitigation_by_mode.get(fc)
        if not mitigation:
            continue
        deductions = _parse_deductions_from_mitigation(mitigation)
        if not deductions:
            continue

        applied: dict[str, float] = {}
        for crit_name, delta in deductions.items():
            target = criteria_by_name.get(crit_name)
            if target is None:
                # Criterion in marker doesn't exist on this rubric — skip
                # rather than silently mismap. Surface in audit as 0.0 so the
                # log line shows an unresolvable target.
                applied[crit_name] = 0.0
                continue
            # Idempotency check: if score is already at-or-below 5.0+delta
            # tolerance, the model self-applied. Don't double-punish.
            # (delta is negative, so 5.0+delta is the post-deduction ceiling.)
            tolerance = 0.05
            if target.score <= 5.0 + delta + tolerance:
                # Model likely already applied the deduction; record 0 applied.
                applied[crit_name] = 0.0
                continue
            new_score = max(0.0, target.score + delta)
            actual_delta = round(new_score - target.score, 3)
            target.score = new_score
            applied[crit_name] = actual_delta

        if applied:
            audit[fc] = applied

    return list(criteria_by_name.values()), audit


def _get_client(backend: str) -> genai.Client:
    """Lazy-init Gemini client. Mirrors VideoGrader.client property
    (video_grader.py:553-582). Same env-var precedence + Vertex/AI-Studio
    split — both critics share auth posture."""
    global _genai_client
    if _genai_client is not None:
        return _genai_client
    if backend == "vertex":
        _genai_client = genai.Client(
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
        _genai_client = genai.Client(api_key=api_key)
    return _genai_client


def _trace_id() -> str:
    """Return a 12-char trace ID. Honors ``BRAND_ENGINE_TRACE_ID`` if set
    (caller-propagated trace), else generates a fresh hex-12."""
    return os.getenv("BRAND_ENGINE_TRACE_ID") or uuid.uuid4().hex[:12]


def _build_critic_system_prompt(
    *,
    mode: ImageGradeMode,
    still_prompt: str,
    narrative_beat: dict,
    story_context: dict,
    anchor_paths: list[str],
    reference_paths: list[str],
    pivot_rewrite_history: Optional[list[dict]],
    known_limitations: list[dict],
) -> str:
    """Build the critic system prompt.

    Mirrors brand_engine.core.video_grader._build_rails_prompt structure but
    swaps in the stills rubric (6 criteria) and inserts the audit-mode skip
    markers for Rules 6 + 7 when ``mode='audit'`` (so the audit_skips_rules
    test assertion catches the SKIP marker).
    """
    lines: list[str] = []
    lines.append(
        "You are the independent visual critic for the BrandStudios stills "
        "critic-in-loop pipeline."
    )
    lines.append(
        "Your job: review this single rendered still and emit a structured "
        "verdict in JSON. You are NOT the orchestrator. You do NOT propose "
        "new prompts. You score the rendered evidence."
    )
    lines.append("")
    lines.append("## OUTPUT DISCIPLINE")
    lines.append("- Respond ONLY with valid JSON matching the ImageGradeResult schema below.")
    lines.append("- No prose outside JSON. No markdown. No code fences around the JSON.")
    lines.append(
        "- `failure_mode` strings MUST be copied verbatim from the catalog below."
    )
    lines.append(
        "- For patterns NOT in the catalog, prefix 'new_candidate:<snake_case_name>'."
    )
    lines.append("")

    # ─── Campaign direction axiom (2026-04-30 — closes the loop on Tim's     ─
    #     observation that some Drift MV stills regressed back to mech-heavy  ─
    #     after the 2026-04-25 aftermath/realistic pivot) ─────────────────────
    directional_history = (story_context or {}).get("directional_history") if story_context else None
    if isinstance(directional_history, dict):
        mantra = directional_history.get("current_direction_mantra")
        summary = directional_history.get("current_direction_summary")
        abandoned = directional_history.get("abandoned_directions") or []
        if mantra or summary or abandoned:
            lines.append("## CAMPAIGN DIRECTION (canonical, applies to ALL shots in this campaign)")
            if mantra:
                lines.append(f"Mantra: `{mantra}`")
            if summary:
                lines.append(f"Direction summary: {summary}")
            if abandoned:
                lines.append("")
                lines.append("### ABANDONED DIRECTIONS (canonical-rejected — flag if reintroduced)")
                for entry in abandoned:
                    if not isinstance(entry, dict):
                        continue
                    name = entry.get("name", "(unnamed)")
                    reason = entry.get("reason", "")
                    rejected_at = entry.get("rejected_at", "")
                    line = f"- `{name}`"
                    if rejected_at:
                        line += f" (rejected {rejected_at})"
                    if reason:
                        line += f": {reason[:300]}"
                    lines.append(line)
            lines.append("")
            lines.append(
                "**HARD RULE — Direction integrity:** if the rendered image violates the "
                "campaign mantra OR reintroduces a listed abandoned direction, list "
                "`campaign_direction_reversion_mech_heavy` (or the closest catalog match) "
                "in `detected_failure_classes` AND apply its `<<DEDUCT: ...>>` markers per "
                "the SCORING DEDUCTIONS section below. Direction integrity overrides per-shot "
                "criterion scoring — a directionally-broken still cannot ship even if other "
                "criteria score well."
            )
            lines.append("")

    # ─── Story context ──────────────────────────────────────────────────────
    if story_context:
        if story_context.get("brief_md"):
            lines.append("## BRAND BRIEF (excerpt)")
            lines.append(str(story_context["brief_md"]).strip()[:2000])
            lines.append("")
        if story_context.get("narrative_md"):
            lines.append("## NARRATIVE ARC (excerpt)")
            lines.append(str(story_context["narrative_md"]).strip()[:2000])
            lines.append("")
        if story_context.get("lyrics_md"):
            lines.append("## LYRICS (excerpt)")
            lines.append(str(story_context["lyrics_md"]).strip()[:1500])
            lines.append("")

    # ─── Narrative beat for THIS shot ───────────────────────────────────────
    lines.append("## SHOT BEAT")
    shot_n = narrative_beat.get("shot_number", "(unknown)")
    section = narrative_beat.get("section", "(unknown)")
    visual = narrative_beat.get("visual", "(no visual intent provided)")
    chars = narrative_beat.get("characters_needed", []) or []
    lines.append(f"Shot {shot_n} | section: `{section}`")
    lines.append(f"Visual intent: {visual}")
    if chars:
        lines.append(f"Characters in frame: {', '.join(chars)}")
    lines.append("")

    # ─── Prompt that produced this image ────────────────────────────────────
    lines.append("## PROMPT THAT PRODUCED THIS IMAGE")
    lines.append(still_prompt.strip()[:MAX_PROMPT_CHARS])
    lines.append("")

    # ─── Anchor + reference inventory ───────────────────────────────────────
    if anchor_paths:
        lines.append("## CHARACTER ANCHORS (also attached as images for visual reference)")
        for p in anchor_paths:
            lines.append(f"- {Path(p).name}")
        lines.append("")
    if reference_paths:
        lines.append("## QUALITY-BAR REFERENCES (also attached as images)")
        for p in reference_paths:
            lines.append(f"- {Path(p).name}")
        lines.append("")

    # ─── Criteria ───────────────────────────────────────────────────────────
    lines.append("## CRITERIA (score each 0.0-5.0)")
    lines.append("Scoring key: 5=hero-quality, 4=ship, 3=warn, 2=fail-minor, 1=fail-major, 0=catastrophic")
    for name in STILLS_CRITERIA:
        lines.append(f"- **{name}**: {STILLS_CRITERIA_DESCRIPTIONS[name]}")
    lines.append("")
    lines.append("`aggregate_score` = mean of the 6 criterion scores.")
    lines.append("")

    # ─── SCORING DEDUCTIONS preamble (Phase B+ smoke #4 fix) ────────────────
    # Some catalog mitigations carry `<<DEDUCT: criterion=-N.N, ...>>` markers
    # (added in migration 012). The model MUST apply these deductions when it
    # flags the corresponding failure_class. The server defensively re-applies
    # post-response via _apply_failure_class_deductions, but emitting the
    # instruction here aligns the model's self-scoring with the server.
    has_deduct_markers = any(
        _DEDUCT_MARKER_RE.search(str(lim.get("mitigation") or ""))
        for lim in (known_limitations or [])
    )
    if has_deduct_markers:
        lines.append("## SCORING DEDUCTIONS (mandatory, not advisory)")
        lines.append(
            "Some failure classes in the catalog below carry an inline marker of the "
            "form `<<DEDUCT: criterion=-N.N, ...>>`. When you detect one of these "
            "patterns, you MUST subtract the named amount from each named criterion's "
            "score for THIS image. Examples:"
        )
        lines.append(
            "- Catalog mitigation contains `<<DEDUCT: narrative_alignment=-1.5, aesthetic_match=-1.0>>`"
        )
        lines.append(
            "- You detect this pattern → subtract 1.5 from your `narrative_alignment` score"
        )
        lines.append(
            "  AND subtract 1.0 from your `aesthetic_match` score before computing aggregate."
        )
        lines.append("")
        lines.append(
            "Deductions floor at 0.0 (never negative). Multiple failure_classes stack — "
            "if two classes both deduct from `narrative_alignment`, both deductions apply."
        )
        lines.append(
            "The verdict gate (PASS/WARN/FAIL) computes from the post-deduction "
            "aggregate, so deductions can flip a borderline PASS to FAIL."
        )
        lines.append("")

    # ─── Known-limitation catalog ───────────────────────────────────────────
    lines.append("## KNOWN LIMITATION CATALOG (image-class)")
    if known_limitations:
        lines.append(
            "When you detect one of these patterns, list its `failure_mode` exactly."
        )
        for lim in known_limitations:
            mode_name = lim.get("failure_mode", "")
            sev = lim.get("severity", "warning")
            desc = lim.get("description", "")
            mit = lim.get("mitigation", "")
            lines.append(f"- `{mode_name}` [{sev}]")
            if desc:
                lines.append(f"    Description: {desc[:400]}")
            if mit:
                lines.append(f"    Mitigation: {mit[:400]}")
    else:
        lines.append(
            "(catalog not provided — limit detection to criterion-level only)"
        )
    lines.append("")

    # ─── Hard rules — Rules 1-5 always; Rules 6+7 mode-conditional ──────────
    lines.append("## HARD RULES")
    lines.append("1. Single image only per call — do NOT batch.")
    lines.append("2. Output JSON only — no markdown fences.")
    lines.append(
        "3. Verdict gates: PASS (≥4.0 no-blocking), WARN (3.0-3.9 fixable), "
        "FAIL (<3.0 OR any blocking failure_mode)."
    )
    lines.append(
        "4. The critic can be too literal. If a prompt aspect is technically "
        "violated but the result is visually superior, score the actual quality "
        "not the rules-lawyering match."
    )
    lines.append(
        "5. Hand-anatomy escalation: if hand_anatomy is the only blocking issue "
        "AND a composition guard is already deployed (chest-up crop, hands "
        "cropped, broad grip), recommend L3_redesign directly — don't waste an L1."
    )

    # Rules 6 + 7 are pivot-history-dependent — audit mode skips them.
    if mode == "audit":
        lines.append("<<< SKIP Rule 6 (audit-mode — no pivot history) >>>")
        lines.append("<<< SKIP Rule 7 (audit-mode — no pivot history) >>>")
        lines.append(
            "(audit-mode: no prior iterations exist for this shot in this audit. "
            "Score on the current image alone.)"
        )
    else:
        lines.append(
            "6. Pivot rewrite history (MANDATORY consume): the PIVOT HISTORY "
            "section below shows prior iterations' verdicts + applied "
            "mitigations + outcomes. Use it to detect regression and "
            "calibrate the recommendation level. Note in `reasoning` that you "
            "consumed `pivot_rewrite_history`."
        )
        lines.append(
            "7. Degenerate-loop guard: if the SAME `failure_class` appears in "
            "`detected_failure_classes` for TWO CONSECUTIVE iterations without "
            "aggregate_score moving ≥0.3, AUTO-ESCALATE the recommendation to "
            "the NEXT level (L1→L2, L2→L3) regardless of score gate. Document "
            "the loop detection in `reasoning`: e.g. \"Rule 7 fired: same "
            "failure_class as iter N-1, score delta < 0.3, auto-escalating to "
            "L<next>.\""
        )
    lines.append("")

    # ─── In-loop only — pivot history payload ───────────────────────────────
    if mode == "in_loop" and pivot_rewrite_history:
        lines.append("## PIVOT HISTORY (consume per Rule 6)")
        for entry in pivot_rewrite_history[-5:]:  # last 5 iters max — keep prompt bounded
            lines.append(f"- iter {entry.get('iter', '?')}:")
            lines.append(f"    {json.dumps(entry, default=str)[:500]}")
        lines.append("")

    # ─── Output schema example ──────────────────────────────────────────────
    lines.append("## OUTPUT SCHEMA (respond with a JSON object exactly matching this)")
    lines.append(json.dumps(STILLS_OUTPUT_SCHEMA_EXAMPLE, indent=2))
    return "\n".join(lines)


def _load_image_part(path: str) -> genai_types.Part:
    """Load an image as a genai Part. Raises FileNotFoundError if missing."""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Image not found: {path}")
    mime, _ = mimetypes.guess_type(str(p))
    if mime is None:
        mime = "image/png"
    return genai_types.Part.from_bytes(data=p.read_bytes(), mime_type=mime)


def _call_gemini_vision(
    system_prompt: str,
    image_path: str,
    anchor_paths: list[str],
    reference_paths: list[str],
    *,
    model: Optional[str] = None,
    backend: Optional[str] = None,
) -> str:
    """Call Gemini Vision with the image + anchors + references + system prompt.

    Returns the raw text response (caller is responsible for JSON extraction
    via _extract_json_block).

    Test scaffold mocks this by name — DO NOT rename or move out of module
    scope (test_grade_image_v2.py:152, 177, 203, 227, 298).

    Implements 429 retry with exponential backoff (1s → 2s → 4s, 3 attempts).
    5xx and other exceptions propagate immediately on the first occurrence.
    """
    backend = (backend or DEFAULT_IMAGE_CRITIC_BACKEND).lower()
    if model is None:
        model = (
            DEFAULT_VERTEX_IMAGE_MODEL if backend == "vertex"
            else DEFAULT_AI_STUDIO_IMAGE_MODEL
        )
    client = _get_client(backend)

    # Build contents: [primary_image, *anchor_images, *reference_images, prompt_text]
    contents: list = [_load_image_part(image_path)]
    for ap in anchor_paths:
        if ap and Path(ap).exists():
            contents.append(_load_image_part(ap))
    for rp in reference_paths:
        if rp and Path(rp).exists():
            contents.append(_load_image_part(rp))
    contents.append(system_prompt)

    config = genai_types.GenerateContentConfig(
        response_mime_type="application/json",
        temperature=0.1,  # deterministic critic
        max_output_tokens=GEMINI_MAX_OUTPUT_TOKENS,
    )

    last_err: Optional[Exception] = None
    for attempt, backoff_s in enumerate(RETRY_BACKOFFS_S, start=1):
        try:
            response = client.models.generate_content(
                model=model, contents=contents, config=config,
            )
            return response.text or ""
        except Exception as e:
            last_err = e
            err_str = str(e)
            # 429 → retry; everything else propagates immediately.
            if "429" in err_str or "RESOURCE_EXHAUSTED" in err_str.upper():
                if attempt < len(RETRY_BACKOFFS_S):
                    logger.warning(
                        "Gemini 429 (attempt %d/%d); backing off %.1fs",
                        attempt, len(RETRY_BACKOFFS_S), backoff_s,
                    )
                    time.sleep(backoff_s)
                    continue
            raise
    # All retries exhausted on 429:
    raise last_err if last_err else RuntimeError("Gemini call failed without exception")


def _normalize_recommendation(value: str) -> ImageGradeRecommendation:
    """Coerce a model-emitted recommendation string into the narrowed union.

    The video critic's `L3_accept_with_trim` is meaningless for stills; if it
    leaks in (e.g., model latched onto the video output schema), map to
    L3_redesign. Unknown values default to ship-conservatively WARN: L1_prompt_fix.
    """
    v = (value or "").strip()
    if v in ("ship", "L1_prompt_fix", "L2_approach_change", "L3_redesign"):
        return v  # type: ignore[return-value]
    if v == "L3_escalation" or v == "L3_accept_with_trim":
        return "L3_redesign"
    return "L1_prompt_fix"


def _compute_verdict_for_stills(
    aggregate_score: float,
    criteria: list[VideoGradeCriterion],
    detected_failure_classes: list[str],
    blocking_modes: set[str],
) -> str:
    """Verdict gate per the stills rubric (mirror video pattern but tuned).

    PASS ≥4.0 with no criterion <3.0 and no BLOCKING failure_mode detected.
    FAIL <3.0 OR any criterion ≤1.0 OR any BLOCKING failure_mode detected.
    WARN otherwise.
    """
    has_blocking = any(fm in blocking_modes for fm in detected_failure_classes)
    has_critical_criterion = any(c.score <= 1.0 for c in criteria)
    has_low_criterion = any(c.score < 3.0 for c in criteria)

    if has_critical_criterion or aggregate_score < 3.0 or has_blocking:
        return "FAIL"
    if has_low_criterion or aggregate_score < 4.0:
        return "WARN"
    return "PASS"


def _build_image_load_failure_result(image_path: str, shot_number: Optional[int]) -> ImageGradeResult:
    """Synthetic FAIL verdict when the image can't be loaded. No exception —
    every call returns a structured ImageGradeResult."""
    zero_criteria = [
        VideoGradeCriterion(name=n, score=0.0, notes="(image not loadable — not scored)")
        for n in STILLS_CRITERIA
    ]
    return ImageGradeResult(
        verdict="FAIL",
        aggregate_score=0.0,
        criteria=zero_criteria,
        detected_failure_classes=[],
        confidence=1.0,
        summary="Image could not be loaded; cannot be graded.",
        reasoning=f"image could not be loaded: {image_path}. Verify the path is accessible to the brand-engine sidecar.",
        recommendation="L3_redesign",
        model="(none — image load failed before critic call)",
        cost=0.0,
        latency_ms=0,
        shot_number=shot_number,
        image_path=image_path,
        new_candidate_limitation=None,
    )


def grade_image_v2(
    image_path: str,
    still_prompt: str,
    narrative_beat: dict,
    story_context: Optional[dict] = None,
    anchor_paths: Optional[list[str]] = None,
    reference_paths: Optional[list[str]] = None,
    pivot_rewrite_history: Optional[list[dict]] = None,
    mode: ImageGradeMode = "audit",
    *,
    shot_number: Optional[int] = None,
    known_limitations: Optional[list[dict]] = None,
    model: Optional[str] = None,
    backend: Optional[str] = None,
) -> dict:
    """Grade a single still image. Returns the ImageGradeResult as a dict.

    The dict (not the Pydantic model) is the public return type so the test
    scaffold can do `result["verdict"]` directly without `.dict()`.

    Pre-flight:
      * Validates ``len(still_prompt) <= 2000`` (NB Pro hard limit). Raises
        ``ValueError`` BEFORE any image load or Gemini call.
      * If ``image_path`` doesn't exist, returns synthetic FAIL verdict —
        no exception, graceful degradation per ADR-004.

    Args:
        image_path: Absolute filesystem path to the still image.
        still_prompt: The prompt that produced this image (≤ 2000 chars).
        narrative_beat: Manifest shot N entry (visual + characters_needed +
            section + shot_number).
        story_context: Pre-loaded BRIEF.md/NARRATIVE.md/LYRICS.md content
            (caller threads in; critic does not read filesystem).
        anchor_paths: Character anchor PNG paths.
        reference_paths: Quality-bar exemplar PNG paths.
        pivot_rewrite_history: None for audit mode; list of prior iter records
            for in_loop mode (consumed per Rules 6 + 7).
        mode: 'audit' (skip Rules 6+7) or 'in_loop' (apply them).
        shot_number: Override / supplement ``narrative_beat['shot_number']``.
        known_limitations: Inject a pre-loaded catalog (test fixture path);
            if None, loads from Supabase via known_limitations_loader.
        model: Override the Gemini model id.
        backend: 'ai_studio' or 'vertex'.

    Returns:
        dict matching the ImageGradeResult schema. See models.py for fields.
    """
    t0 = time.time()

    # ─── Pre-flight: 2000-char prompt ceiling ───────────────────────────────
    # MUST raise before any image load or Gemini call so the caller sees the
    # input error clearly. Test scaffold expects ValueError or AssertionError.
    if len(still_prompt) > MAX_PROMPT_CHARS:
        raise ValueError(
            f"still_prompt exceeds {MAX_PROMPT_CHARS}-char NB Pro hard limit "
            f"({len(still_prompt)} chars). Pre-flight rejection — orchestrator "
            f"must shorten the prompt before regen."
        )

    if shot_number is None:
        shot_number = narrative_beat.get("shot_number") if narrative_beat else None

    # ─── Image load — graceful degradation ──────────────────────────────────
    if not Path(image_path).exists():
        result = _build_image_load_failure_result(image_path, shot_number)
        # Structured log the synthetic verdict too.
        _emit_critic_log(
            event="critic_call",
            mode=mode,
            image_path=image_path,
            prompt_len=len(still_prompt),
            latency_ms=int((time.time() - t0) * 1000),
            aggregate_score=0.0,
            verdict="FAIL",
            recommendation="L3_redesign",
            failure_classes=[],
            shot_number=shot_number,
            note="image_load_failure",
        )
        return result.model_dump()

    # ─── Build prompt + load catalog ────────────────────────────────────────
    if known_limitations is None:
        known_limitations = load_image_class_limitations()

    system_prompt = _build_critic_system_prompt(
        mode=mode,
        still_prompt=still_prompt,
        narrative_beat=narrative_beat or {},
        story_context=story_context or {},
        anchor_paths=anchor_paths or [],
        reference_paths=reference_paths or [],
        pivot_rewrite_history=pivot_rewrite_history,
        known_limitations=known_limitations,
    )

    # ─── Gemini call (mocked by tests via _call_gemini_vision) ──────────────
    raw_text = _call_gemini_vision(
        system_prompt=system_prompt,
        image_path=image_path,
        anchor_paths=anchor_paths or [],
        reference_paths=reference_paths or [],
        model=model,
        backend=backend,
    )

    # ─── Parse + normalize ──────────────────────────────────────────────────
    try:
        parsed = _extract_json_block(raw_text)
    except Exception as e:
        logger.error("Gemini stills critic returned invalid JSON: %s\n%s", e, raw_text[:500])
        raise ValueError(f"Gemini stills critic returned invalid JSON: {e}") from e

    criteria = [
        VideoGradeCriterion(
            name=str(c.get("name", "unknown")),
            score=float(c.get("score", 0.0)),
            notes=str(c.get("notes", "")),
        )
        for c in parsed.get("criteria", [])
    ]
    if not criteria:
        # Fall back to zero-scored placeholders so verdict computation doesn't divide by zero
        criteria = [VideoGradeCriterion(name=n, score=0.0, notes="(missing from response)") for n in STILLS_CRITERIA]

    detected = [str(fm) for fm in parsed.get("detected_failure_classes", [])]
    blocking_modes = {
        lim.get("failure_mode", "")
        for lim in (known_limitations or [])
        if lim.get("severity") == "blocking"
    }

    # ─── Server-side deduction recompute (Phase B+ smoke #4 fix) ────────────
    # When migration 012's `<<DEDUCT: ...>>` markers are present in the catalog
    # AND the model flagged the corresponding failure_classes, apply the
    # deductions defensively. Idempotency guard inside _apply_failure_class_deductions
    # prevents double-deduction when the model already self-applied. This is
    # the server-side enforcement of the smoke #4 calibration fix — the model
    # is unreliable about applying deductions, so we apply them here.
    criteria, deduction_audit = _apply_failure_class_deductions(
        criteria, detected, known_limitations or [],
    )

    # Recompute aggregate from POST-deduction criteria scores. Don't trust
    # the model's `aggregate_score` field if deductions were applied — it
    # was computed before the server-side adjustment.
    if deduction_audit:
        aggregate = (
            sum(c.score for c in criteria) / len(criteria) if criteria else 0.0
        )
    else:
        aggregate = float(
            parsed.get("aggregate_score") or (
                sum(c.score for c in criteria) / len(criteria) if criteria else 0.0
            )
        )

    # Recompute verdict; prefer stricter of (server-derived, model-emitted)
    verdict_server = _compute_verdict_for_stills(aggregate, criteria, detected, blocking_modes)
    verdict_model = str(parsed.get("verdict", "WARN")).upper()
    if verdict_model not in ("PASS", "WARN", "FAIL"):
        verdict_model = verdict_server
    severity_order = {"PASS": 0, "WARN": 1, "FAIL": 2}
    verdict_final = (
        verdict_server
        if severity_order[verdict_server] > severity_order[verdict_model]
        else verdict_model
    )

    recommendation = _normalize_recommendation(str(parsed.get("recommendation", "")))

    # New candidate limitation passthrough
    new_candidate = parsed.get("new_candidate_limitation")
    if not isinstance(new_candidate, dict):
        new_candidate = None

    latency_ms = int((time.time() - t0) * 1000)
    used_model = (
        model
        or (DEFAULT_VERTEX_IMAGE_MODEL if (backend or DEFAULT_IMAGE_CRITIC_BACKEND) == "vertex"
            else DEFAULT_AI_STUDIO_IMAGE_MODEL)
    )

    result = ImageGradeResult(
        verdict=verdict_final,
        aggregate_score=round(aggregate, 3),
        criteria=criteria,
        detected_failure_classes=detected,
        confidence=float(parsed.get("confidence", 0.0)),
        summary=str(parsed.get("summary", "")),
        reasoning=str(parsed.get("reasoning", "")),
        recommendation=recommendation,
        model=used_model,
        cost=float(parsed.get("cost", 0.0)),
        latency_ms=latency_ms,
        shot_number=shot_number,
        image_path=image_path,
        new_candidate_limitation=new_candidate,
    )

    _emit_critic_log(
        event="critic_call",
        mode=mode,
        image_path=image_path,
        prompt_len=len(still_prompt),
        latency_ms=latency_ms,
        aggregate_score=result.aggregate_score,
        verdict=result.verdict,
        recommendation=result.recommendation,
        failure_classes=result.detected_failure_classes,
        shot_number=shot_number,
        # Phase 4 (migration 012): record any server-side deductions applied
        # so observability surfaces show calibration is firing as designed.
        # Empty dict when no deductions applied.
        deductions_applied=deduction_audit,
    )

    return result.model_dump()


def _emit_critic_log(**fields: Any) -> None:
    """Emit one structured JSON log line per critic call (Phase F).

    All 9 documented fields plus a trace_id. Pino-style: single `event` key at
    the top level so log aggregators can index on it.
    """
    payload: dict = {"trace_id": _trace_id()}
    payload.update(fields)
    # Coerce non-JSON-safe to repr; keep the line one-line for log parsers.
    try:
        logger.info(json.dumps(payload, default=str))
    except Exception:
        # Log emission must never fail the request.
        logger.exception("Critic log emission failed; payload: %r", payload)
