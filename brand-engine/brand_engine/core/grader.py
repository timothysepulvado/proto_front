"""Brand grader: orchestrates dual-fusion retrieval + pixel analysis into a gate decision.

This is the primary entry point for grading a generated image against a brand.
It combines the DualFusionRetriever (embedding similarity) with the ImageAnalyzer
(pixel-level checks) to produce a final GradeResult.
"""

import logging
from typing import Callable, Optional

from brand_engine.core.analyzer import ImageAnalyzer
from brand_engine.core.embeddings import EmbeddingClient, get_embedding_client
from brand_engine.core.models import (
    BrandProfile,
    GradeResult,
)
from brand_engine.core.retriever import DualFusionRetriever

logger = logging.getLogger(__name__)


class BrandGrader:
    """Orchestrates brand compliance grading.

    Combines:
    1. DualFusionRetriever — Gemini+Cohere embedding similarity vs brand corpus
    2. ImageAnalyzer — pixel-level saturation, whitespace, clutter, palette match

    The fusion result drives the gate decision. Pixel analysis provides
    supplementary signals and can downgrade a passing score if pixel metrics
    are severely off-brand.
    """

    # Pixel thresholds that can override embedding scores
    CLUTTER_REJECT_THRESHOLD = 0.7
    PALETTE_REJECT_THRESHOLD = 0.2

    def __init__(
        self,
        embedding_client: Optional[EmbeddingClient] = None,
        log_callback: Optional[Callable[[str, str, str], None]] = None,
    ):
        self._embed = embedding_client or get_embedding_client()
        self._retriever = DualFusionRetriever(embedding_client=self._embed)
        self._analyzer = ImageAnalyzer()
        self._log = log_callback or self._default_log

    def grade(
        self,
        image_path: str,
        profile: BrandProfile,
        text_query: Optional[str] = None,
        include_pixel_analysis: bool = True,
        index_tier: str = "brand-dna",
        baseline_stats: Optional[dict] = None,
    ) -> GradeResult:
        """Grade an image against a brand profile.

        Args:
            image_path: Path to the image to grade.
            profile: Brand profile with indexes and thresholds.
            text_query: Optional text query for semantic matching.
            include_pixel_analysis: Whether to run pixel analysis.
            index_tier: Pinecone index tier to query.
            baseline_stats: Optional dict with baseline mean/stddev per model
                           from brand_baselines table.

        Returns:
            GradeResult with fusion scores, pixel analysis, and gate decision.
        """
        self._log("grading", "info", f"Grading image: {image_path}")
        self._log("grading", "info", f"Brand: {profile.brand_slug}, tier: {index_tier}")

        # 1. Dual-fusion retrieval
        self._log("grading", "info", "Running dual-fusion retrieval (Gemini + Cohere)...")
        fusion = self._retriever.retrieve(
            image_path=image_path,
            profile=profile,
            text_query=text_query,
            index_tier=index_tier,
            baseline_stats=baseline_stats,
        )

        self._log(
            "grading",
            "info",
            f"Fusion: gemini_z={fusion.gemini_score.z_score:.4f}, "
            f"cohere_z={fusion.cohere_score.z_score:.4f}, "
            f"combined={fusion.combined_z:.4f} → {fusion.gate_decision}",
        )

        # 2. Pixel analysis (optional)
        pixel = None
        if include_pixel_analysis:
            self._log("grading", "info", "Running pixel analysis...")
            pixel = self._analyzer.analyze(
                image_path=image_path,
                brand_palette=profile.allowed_colors or None,
            )

            self._log(
                "grading",
                "info",
                f"Pixel: sat={pixel.saturation_mean:.2f}, "
                f"clutter={pixel.clutter_score:.2f}, "
                f"whitespace={pixel.whitespace_ratio:.2f}"
                + (f", palette_match={pixel.palette_match:.2f}" if pixel.palette_match is not None else ""),
            )

        # 3. Final gate decision (fusion primary, pixel can downgrade)
        gate_decision = fusion.gate_decision

        if pixel:
            gate_decision = self._apply_pixel_overrides(gate_decision, pixel, profile)

        hitl_required = gate_decision == "HITL_REVIEW"
        summary = self._build_summary(fusion, pixel, gate_decision)

        self._log("grading", "info", f"Final decision: {gate_decision}")

        return GradeResult(
            fusion=fusion,
            pixel=pixel,
            gate_decision=gate_decision,
            hitl_required=hitl_required,
            summary=summary,
        )

    def _apply_pixel_overrides(
        self,
        gate_decision: str,
        pixel,
        profile: BrandProfile,
    ) -> str:
        """Pixel metrics can downgrade (but not upgrade) the gate decision."""
        # High clutter → downgrade to review
        if pixel.clutter_score > self.CLUTTER_REJECT_THRESHOLD:
            if gate_decision == "AUTO_PASS":
                logger.info("Pixel override: high clutter (%.2f) → HITL_REVIEW", pixel.clutter_score)
                return "HITL_REVIEW"

        # Poor palette match → downgrade to review
        if pixel.palette_match is not None and pixel.palette_match < self.PALETTE_REJECT_THRESHOLD:
            if gate_decision == "AUTO_PASS":
                logger.info(
                    "Pixel override: poor palette match (%.2f) → HITL_REVIEW",
                    pixel.palette_match,
                )
                return "HITL_REVIEW"

        return gate_decision

    def _build_summary(self, fusion, pixel, gate_decision: str) -> str:
        """Build a human-readable summary of the grade."""
        parts = [f"Gate: {gate_decision}"]
        parts.append(
            f"Fusion z={fusion.combined_z:.3f} "
            f"(Gemini={fusion.gemini_score.z_score:.3f}, "
            f"Cohere={fusion.cohere_score.z_score:.3f})"
        )

        if pixel:
            parts.append(
                f"Pixel: sat={pixel.saturation_mean:.2f}, "
                f"clutter={pixel.clutter_score:.2f}"
            )
            if pixel.palette_match is not None:
                parts.append(f"palette_match={pixel.palette_match:.2f}")

        return " | ".join(parts)

    def _default_log(self, stage: str, level: str, message: str) -> None:
        getattr(logger, level, logger.info)(message)
