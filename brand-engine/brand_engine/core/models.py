"""Pydantic models for brand engine inputs and outputs."""

from typing import Literal, Optional
from pydantic import BaseModel, Field, model_validator


# ============ Narrative envelope (Chunk 1 — context-aware grading) ============
# Mirrors os-api/src/types.ts NarrativeContext + NeighborShotSlim. Consumed by
# _build_rails_prompt when a caller passes `narrative_context=<dict>` through
# /grade_video. Field names stay snake_case to match the JSONB envelope as
# stored in campaign_deliverables.metadata.narrative_context.

BeatName = Literal[
    "intro",
    "hook_1",
    "verse_1",
    "hook_2",
    "verse_2",
    "bridge",
    "hook_3",
    "final_hook",
    "outro",
]


class NeighborShotSlim(BaseModel):
    """Slim neighbor-shot summary — fed into critic SHOT POSITION section."""
    shot_number: int
    beat_name: BeatName
    visual_intent_summary: str = Field(
        max_length=80,
        description="≤ 80 chars — truncated visual intent for cache-stable summaries.",
    )


class NarrativeContext(BaseModel):
    """Per-shot narrative envelope ingested from Drift MV manifest + qa docs."""
    shot_number: int
    beat_name: BeatName
    song_start_s: float
    song_end_s: float
    visual_intent: str = Field(description="Full per-shot visual description.")
    characters: list[dict] = Field(
        default_factory=list,
        description="[{slug, role, color_code?}] — looked up from manifest.characters.",
    )
    previous_shot: Optional[NeighborShotSlim] = None
    next_shot: Optional[NeighborShotSlim] = None
    stylization_allowances: list[str] = Field(
        default_factory=list,
        description="Per-shot intentional-stylization notes (from qa_prompt_evolution.md).",
    )
    ingested_at: str = Field(description="ISO timestamp of ingestion.")
    manifest_sha256: str


# ============ Embedding Models ============

class EmbeddingResult(BaseModel):
    """Result from embedding a single item (image or text)."""
    gemini_768: list[float] = Field(description="Gemini Embedding 2 at 768D (MRL)")
    cohere_1536: list[float] = Field(description="Cohere v4 at 1536D")


# ============ Retrieval Models ============

class ModalScore(BaseModel):
    """Score from a single embedding model's Pinecone query."""
    model: str = Field(description="Model name: 'gemini' or 'cohere'")
    raw_score: float = Field(description="Raw cosine similarity from Pinecone")
    z_score: float = Field(description="Z-score normalized against brand baseline")
    top_k_ids: list[str] = Field(default_factory=list, description="Top-K matching vector IDs")


class FusionResult(BaseModel):
    """Result of dual-fusion z-score combination."""
    gemini_score: ModalScore
    cohere_score: ModalScore
    combined_z: float = Field(description="Weighted combined z-score")
    gate_decision: str = Field(description="AUTO_PASS | HITL_REVIEW | AUTO_FAIL")
    confidence: float = Field(ge=0.0, le=1.0, description="Decision confidence")


# ============ Analysis Models ============

class PixelAnalysis(BaseModel):
    """Result of pixel-level image analysis (no embeddings)."""
    saturation_mean: float
    saturation_std: float
    brightness_mean: float
    brightness_std: float
    whitespace_ratio: float
    clutter_score: float
    dominant_colors: list[str] = Field(description="Hex color codes")
    palette_match: Optional[float] = Field(default=None, description="Match against brand palette (0-1)")


# ============ Grade Models ============

class GradeResult(BaseModel):
    """Complete grading result combining fusion retrieval and pixel analysis."""
    fusion: FusionResult
    pixel: Optional[PixelAnalysis] = None
    gate_decision: str = Field(description="Final gate: AUTO_PASS | HITL_REVIEW | AUTO_FAIL")
    hitl_required: bool = Field(description="Whether human review is needed")
    summary: str = Field(description="Human-readable summary of the grade")


# ============ Ingest Models ============

class IngestRequest(BaseModel):
    """Request to ingest brand assets."""
    brand_slug: str
    images_dir: str
    index_tier: str = Field(default="brand-dna", description="brand-dna | core | campaign")
    include_documents: bool = Field(default=False)
    documents_dir: Optional[str] = None


class IngestResult(BaseModel):
    """Result of brand asset ingestion."""
    brand_slug: str
    vectors_indexed: int
    gemini_index: str
    cohere_index: str
    errors: list[str] = Field(default_factory=list)


# ============ Drift Models ============

class DriftReport(BaseModel):
    """Drift check result comparing generated asset against brand baseline."""
    grade: GradeResult
    baseline_combined_z: float = Field(description="Brand baseline combined z-score")
    drift_delta: float = Field(description="Difference from baseline")
    drift_severity: str = Field(description="none | minor | moderate | severe")
    alert_triggered: bool


# ============ Baseline Models ============

class BaselineRequest(BaseModel):
    """Request to calculate brand baselines."""
    brand_slug: str
    sample_limit: Optional[int] = Field(default=None, description="Limit sample size for baseline calc")


class BaselineResult(BaseModel):
    """Calculated brand baseline scores."""
    brand_slug: str
    gemini_baseline_z: float
    gemini_baseline_raw: float
    gemini_stddev: float
    cohere_baseline_z: float
    cohere_baseline_raw: float
    cohere_stddev: float
    fused_baseline_z: float
    sample_count: int


# ============ Brand Profile Models ============

class BrandThresholds(BaseModel):
    """Per-brand pass/fail/review thresholds."""
    auto_pass_z: float = Field(default=1.0, description="Z-score above this → AUTO_PASS")
    auto_fail_z: float = Field(default=-1.5, description="Z-score below this → AUTO_FAIL")
    gemini_weight: float = Field(default=0.6, description="Weight for Gemini in fusion")
    cohere_weight: float = Field(default=0.4, description="Weight for Cohere in fusion")


class BrandProfile(BaseModel):
    """Per-brand configuration."""
    brand_slug: str
    display_name: str
    pinecone_namespace: Optional[str] = None
    thresholds: BrandThresholds = Field(default_factory=BrandThresholds)
    allowed_colors: list[str] = Field(default_factory=list, description="Hex codes")
    disallowed_patterns: list[str] = Field(default_factory=list)
    indexes: dict[str, str] = Field(
        default_factory=dict,
        description="Map of tier+model → index name, e.g. {'brand-dna-gemini768': 'jennikayne-brand-dna-gemini768'}",
    )


# ============ API Request/Response Models ============

class RetrieveRequest(BaseModel):
    """API request for brand context retrieval (text query → Pinecone)."""
    brand_slug: str
    text_query: str
    index_tier: str = Field(default="brand-dna", description="brand-dna | core | campaign")
    top_k: int = Field(default=10, description="Number of results per index")


class GradeRequest(BaseModel):
    """API request to grade an image."""
    image_path: str
    brand_slug: str
    text_query: Optional[str] = Field(default=None, description="Optional text query for semantic matching")
    include_pixel_analysis: bool = Field(default=True)
    index_tier: str = Field(default="brand-dna", description="brand-dna | core | campaign")


class DriftRequest(BaseModel):
    """API request to check drift."""
    image_path: str
    brand_slug: str
    text_query: Optional[str] = None
    index_tier: str = Field(default="core")
    # Baseline stats passed from os-api (read from brand_baselines table)
    baseline_fused_z: Optional[float] = Field(default=None, description="Fused baseline z-score from brand_baselines")
    baseline_gemini_raw: Optional[float] = Field(default=None, description="Gemini baseline raw similarity mean")
    baseline_gemini_stddev: Optional[float] = Field(default=None, description="Gemini baseline raw similarity stddev")
    baseline_cohere_raw: Optional[float] = Field(default=None, description="Cohere baseline raw similarity mean")
    baseline_cohere_stddev: Optional[float] = Field(default=None, description="Cohere baseline raw similarity stddev")


class HealthResponse(BaseModel):
    """Health check response."""
    status: str
    gemini_connected: bool
    cohere_connected: bool
    pinecone_connected: bool
    version: str


# ============ Video Grade Models (Gemini 3.1 Pro multimodal critic) ============

class VideoGradeRequest(BaseModel):
    """API request to grade a video clip using Gemini 3.1 Pro multimodal.

    The video is evaluated against brand profile + narrative context + a subset
    of known_limitations failure modes. Returns structured scores per criterion,
    detected failure classes, and a PASS/WARN/FAIL verdict.
    """
    video_path: str = Field(description="Local filesystem path to .mp4 (or gs:// URI)")
    brand_slug: str
    failure_modes_to_check: Optional[list[str]] = Field(
        default=None,
        description="Subset of known_limitations.failure_mode to specifically probe. If None, all known modes are considered.",
    )
    deliverable_context: Optional[str] = Field(
        default=None,
        description="Campaign/narrative context — e.g., shot's narrative function, what the clip is supposed to convey",
    )
    hero_still_path: Optional[str] = Field(
        default=None,
        description="Path to the reference hero still for composition-match checks",
    )
    known_limitations_context: Optional[list[dict]] = Field(
        default=None,
        description="Full known_limitations records (failure_mode, description, mitigation) for orchestrator-supplied grounding. Injected into the prompt rails.",
    )
    duration_seconds: Optional[float] = Field(
        default=None,
        description="Clip duration (informational — Gemini reads from the video itself)",
    )
    consensus: bool = Field(
        default=True,
        description=(
            "When true (default), route to grade_video_with_consensus: run Gemini once, "
            "and on borderline aggregate_score (within ±0.3 of 3.0 or 4.0) run a second "
            "pass; on disagreement, tiebreak via 1fps ffmpeg frame extraction. Matches "
            "escalation-ops brief Rule 1. Set false for a raw single-call grade."
        ),
    )
    consensus_threshold_band: float = Field(
        default=0.3,
        ge=0.0,
        le=1.0,
        description="Distance around a verdict boundary (3.0 FAIL/WARN, 4.0 WARN/PASS) that is considered 'borderline' and triggers a second consensus call. Only applied when consensus=true.",
    )
    # ─── Chunk 1: narrative envelope ────────────────────────────────────
    narrative_context: Optional[dict] = Field(
        default=None,
        description=(
            "NarrativeContext-shape dict (see NarrativeContext model above). When "
            "provided, the critic prompt gets a self-awareness preamble, a SHOT "
            "POSITION IN MUSIC VIDEO section, and a STYLIZATION BUDGET section. "
            "VERDICT RULES stay fixed — stylization budget widens the input, not the rubric."
        ),
    )
    music_video_synopsis: Optional[str] = Field(
        default=None,
        description=(
            "3-4 sentence music-video synopsis — rendered into the SHOT POSITION "
            "section as the top line so the critic knows what story this shot "
            "serves. Sourced from campaign.metadata.music_video_context.synopsis."
        ),
    )


class VideoGradeCriterion(BaseModel):
    """One scored dimension of video QA."""
    name: str = Field(description="Criterion name, e.g. 'morphing', 'atmospheric_creep', 'camera_smoothness'")
    score: float = Field(ge=0.0, le=5.0, description="0=catastrophic, 3=warn, 5=hero-quality")
    notes: str = Field(description="Specific observation, ideally with timestamps")


class VideoGradeResult(BaseModel):
    """Response for /grade_video — structured verdict on a video clip.

    This schema is the contract the Gemini 3.1 Pro video critic is bound to.
    It mirrors the output format Jackie produces manually and is what the
    runner consumes to feed the orchestrator's escalation decision input.
    """
    verdict: str = Field(description="PASS | WARN | FAIL")
    aggregate_score: float = Field(ge=0.0, le=5.0, description="Mean of criterion scores")
    criteria: list[VideoGradeCriterion]
    detected_failure_classes: list[str] = Field(
        default_factory=list,
        description="Failure modes present in the clip — exact snake_case strings from known_limitations.failure_mode, OR new_candidate:<proposed_name> for undiscovered patterns",
    )
    confidence: float = Field(ge=0.0, le=1.0, description="Overall confidence in the verdict")
    summary: str = Field(description="1-2 sentence overall assessment")
    reasoning: str = Field(description="3-5 sentences: what was observed, why the verdict")
    recommendation: str = Field(
        description="ship | L1_prompt_fix | L2_approach_change | L3_escalation | L3_accept_with_trim",
    )
    model: str = Field(description="Gemini model id used")
    cost: float = Field(default=0.0, description="USD cost of the grade call")
    latency_ms: int = Field(default=0, description="Wall-clock latency of the grade call")
    consensus_note: Optional[str] = Field(
        default=None,
        description=(
            "Non-null iff this result passed through grade_video_with_consensus "
            "(escalation-ops brief Rule 1). Values describe the consensus path taken: "
            "'not borderline, single call' | 'agreed N=2' | "
            "'disagreement resolved via frame extraction (...)'. "
            "The os-api caller treats a non-null value as a signal to flip "
            "OrchestratorInput.consensusResolved=true so the orchestrator knows "
            "the verdict is authoritative (not subject to critic variance)."
        ),
    )


# ─── Image grader (ADR-004 Phase A — stills critic-in-loop) ──────────────────
# Mirrors VideoGradeRequest/Result but narrowed for single-image grading via
# Gemini 3 Pro Vision. The recommendation union drops L3_accept_with_trim
# (no clip-trim semantics for stills) and consensus_note is dropped (frame-
# extraction tiebreak is video-only). Adds shot_number, image_path, and
# new_candidate_limitation per the stills critic rubric output JSON shape.
#
# os-api consumes this via the parallel `ImageGradeResult` TypeScript type at
# os-api/src/types.ts. The two must stay in sync.

ImageGradeMode = Literal["audit", "in_loop"]
ImageGradeRecommendation = Literal[
    "ship",
    "L1_prompt_fix",
    "L2_approach_change",
    "L3_redesign",
]


class ImageGradeRequest(BaseModel):
    """API request to grade a single still image using Gemini 3 Pro Vision.

    Two modes:
      * audit    — score in isolation, skip rubric Rules 6+7 (no pivot history)
      * in_loop  — score during regen iteration; Rules 6+7 active (consume
                   pivot_rewrite_history; degenerate-loop guard)

    The 2000-char ceiling on still_prompt is the productized NB Pro hard limit
    per ~/Temp-gen/productions/drift-mv/STILLS_AUDIT_15_SHOTS.md.
    """
    image_path: str = Field(description="Absolute filesystem path to the still PNG/JPG")
    still_prompt: str = Field(
        description="The prompt that produced this image",
        max_length=2000,
    )
    narrative_beat: dict = Field(
        description=(
            "Manifest shot N entry — `visual` + `characters_needed` + `section` + "
            "`shot_number` + optional `pivot_rewrite_history` (the iter log)"
        ),
    )
    story_context: dict = Field(
        default_factory=dict,
        description=(
            "Pre-loaded BRIEF.md + NARRATIVE.md + LYRICS.md content for this campaign. "
            "Caller is responsible for reading these once and threading them through; "
            "the critic does not reach into the filesystem."
        ),
    )
    anchor_paths: list[str] = Field(
        default_factory=list,
        description="Filesystem paths to character anchor PNGs (brandy_anchor.png, etc.)",
    )
    reference_paths: list[str] = Field(
        default_factory=list,
        description="Filesystem paths to quality-bar exemplar shipped stills",
    )
    pivot_rewrite_history: Optional[list[dict]] = Field(
        default=None,
        description=(
            "None for audit-mode; non-empty list of prior iter records for in_loop mode. "
            "Each record holds the iter critic verdict + orchestrator decision. "
            "Triggers Rules 6 (history consume) and 7 (degenerate-loop guard). "
            "Required (non-empty) when mode='in_loop' — enforced by model validator."
        ),
    )
    mode: ImageGradeMode = Field(
        default="audit",
        description=(
            "audit (skip Rules 6+7, pivot_rewrite_history may be None) | "
            "in_loop (apply Rules 6+7, pivot_rewrite_history MUST be non-empty)"
        ),
    )
    shot_number: Optional[int] = Field(
        default=None,
        description="Optional shot number for logging/return — derived from narrative_beat if absent",
    )

    @model_validator(mode="after")
    def _check_in_loop_requires_pivot_history(self) -> "ImageGradeRequest":
        """In-loop mode REQUIRES pivot_rewrite_history with at least one record.

        Without history the critic cannot consume Rule 6 (pivot history consumption)
        or Rule 7 (degenerate-loop guard) — those rules silently no-op and the
        in-loop guarantees collapse to audit-mode behavior. Reject the request
        rather than letting a downstream caller bypass the guardrails.

        PR #2 review item 0.B.22 — see
        ~/agent-vault/briefs/2026-05-02-karl-pr2-cleanup-and-followups.md
        """
        if self.mode == "in_loop" and not self.pivot_rewrite_history:
            raise ValueError(
                "ImageGradeRequest with mode='in_loop' requires non-empty "
                "pivot_rewrite_history (Rules 6+7 cannot apply otherwise). "
                "Use mode='audit' for first-iter calls without history."
            )
        return self


class ImageGradeResult(BaseModel):
    """Response for /grade_image_v2 — structured verdict on a single still.

    Mirrors VideoGradeResult field-for-field except:
      * recommendation: narrowed (no L3_accept_with_trim — no clip-trim semantics)
      * consensus_note: dropped (frame-extraction tiebreak is video-only)
      * shot_number, image_path, new_candidate_limitation: added per the stills
        critic rubric output JSON shape

    The TypeScript consumer (os-api/src/types.ts ImageGradeResult) tracks this
    one-for-one — schema changes here require a TS update in the same commit.
    """
    verdict: str = Field(description="PASS | WARN | FAIL")
    aggregate_score: float = Field(ge=0.0, le=5.0, description="Mean of criterion scores")
    criteria: list[VideoGradeCriterion] = Field(
        description=(
            "6 criteria for stills: character_consistency, hand_anatomy, "
            "mech_color_identity, composition, narrative_alignment, aesthetic_match. "
            "Reuses VideoGradeCriterion shape (name/score/notes)."
        ),
    )
    detected_failure_classes: list[str] = Field(
        default_factory=list,
        description=(
            "Failure modes present in the image — exact snake_case strings from "
            "known_limitations.failure_mode, OR new_candidate:<proposed_name>"
        ),
    )
    confidence: float = Field(ge=0.0, le=1.0, description="Overall confidence in the verdict")
    summary: str = Field(description="1-2 sentence overall assessment")
    reasoning: str = Field(description="3-5 sentences: visual evidence + verdict rationale")
    recommendation: ImageGradeRecommendation = Field(
        description="ship | L1_prompt_fix | L2_approach_change | L3_redesign (narrowed for stills)",
    )
    model: str = Field(description="Gemini model id used")
    cost: float = Field(default=0.0, description="USD cost of the grade call")
    latency_ms: int = Field(default=0, description="Wall-clock latency of the grade call")
    shot_number: Optional[int] = Field(
        default=None,
        description="Shot index (1-30 for Drift MV) — echoed from request when present",
    )
    image_path: str = Field(description="Echo of input image_path for downstream tracing")
    new_candidate_limitation: Optional[dict] = Field(
        default=None,
        description=(
            "Populated when critic discovers a failure pattern not in the catalog. "
            "Shape: {failure_mode, category, description, mitigation, severity}. "
            "Orchestrator may seed this back into known_limitations after review."
        ),
    )
