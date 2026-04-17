"""Pydantic models for brand engine inputs and outputs."""

from typing import Optional
from pydantic import BaseModel, Field


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
