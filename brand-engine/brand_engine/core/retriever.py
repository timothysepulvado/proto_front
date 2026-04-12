"""Dual-fusion retriever: Gemini Embedding 2 + Cohere v4 z-score fusion.

Ported from Brand_linter multimodal_retriever.py. Refactored from triple-fusion
(CLIP+E5+Cohere) to dual-fusion (Gemini+Cohere). Gemini Embedding 2 subsumes
both CLIP (visual similarity) and E5 (text-semantic matching).

Z-score normalization logic preserved from original.
"""

import json
import logging
from pathlib import Path
from typing import Optional

import numpy as np

from brand_engine.core.embeddings import EmbeddingClient, get_embedding_client
from brand_engine.core.models import (
    BrandProfile,
    BrandThresholds,
    FusionResult,
    ModalScore,
)
from brand_engine.core.pinecone_client import get_index

logger = logging.getLogger(__name__)


class DualFusionRetriever:
    """Queries Pinecone with both Gemini and Cohere embeddings,
    normalizes scores to z-scores, and fuses them into a gate decision.

    The gate decision is one of:
      - AUTO_PASS: combined z-score above pass threshold
      - HITL_REVIEW: combined z-score between pass and fail thresholds
      - AUTO_FAIL: combined z-score below fail threshold
    """

    DEFAULT_TOP_K = 10

    def __init__(
        self,
        embedding_client: Optional[EmbeddingClient] = None,
    ):
        self._embed = embedding_client or get_embedding_client()

    def retrieve(
        self,
        image_path: str,
        profile: BrandProfile,
        text_query: Optional[str] = None,
        index_tier: str = "brand-dna",
        top_k: int = DEFAULT_TOP_K,
        baseline_stats: Optional[dict] = None,
    ) -> FusionResult:
        """Run dual-fusion retrieval against a brand's Pinecone indexes.

        Args:
            image_path: Path to the image to grade.
            profile: Brand profile with index names and thresholds.
            text_query: Optional text to match semantically.
            index_tier: Which index tier to query (brand-dna, core, campaign).
            top_k: Number of results per query.
            baseline_stats: Optional dict with baseline_gemini_raw, baseline_gemini_stddev,
                           baseline_cohere_raw, baseline_cohere_stddev from brand_baselines table.

        Returns:
            FusionResult with per-model scores and combined gate decision.
        """
        thresholds = profile.thresholds

        # Resolve index names from profile
        gemini_index_name = profile.indexes.get(f"{index_tier}-gemini768")
        cohere_index_name = profile.indexes.get(f"{index_tier}-cohere")

        if not gemini_index_name or not cohere_index_name:
            raise ValueError(
                f"Brand profile '{profile.brand_slug}' missing index names for tier '{index_tier}'. "
                f"Expected keys: '{index_tier}-gemini768', '{index_tier}-cohere'"
            )

        # Generate embeddings
        if text_query:
            embeddings = self._embed.embed_text(text_query, is_query=True)
        else:
            embeddings = self._embed.embed_image(image_path)

        # Query both indexes
        gemini_score = self._query_index(
            gemini_index_name, embeddings.gemini_768, "gemini", top_k
        )
        cohere_score = self._query_index(
            cohere_index_name, embeddings.cohere_1536, "cohere", top_k
        )

        # Extract per-model baseline stats if provided
        gemini_mean = baseline_stats.get("baseline_gemini_raw") if baseline_stats else None
        gemini_std = baseline_stats.get("baseline_gemini_stddev") if baseline_stats else None
        cohere_mean = baseline_stats.get("baseline_cohere_raw") if baseline_stats else None
        cohere_std = baseline_stats.get("baseline_cohere_stddev") if baseline_stats else None

        # Z-score normalization (using baseline if available, else defaults)
        gemini_z = self._normalize_z(gemini_score.raw_score, profile, "gemini", gemini_mean, gemini_std)
        cohere_z = self._normalize_z(cohere_score.raw_score, profile, "cohere", cohere_mean, cohere_std)

        gemini_score.z_score = gemini_z
        cohere_score.z_score = cohere_z

        # Weighted fusion
        combined_z = (
            thresholds.gemini_weight * gemini_z
            + thresholds.cohere_weight * cohere_z
        )

        # Gate decision
        gate_decision = self._gate(combined_z, thresholds)
        confidence = self._confidence(combined_z, thresholds)

        result = FusionResult(
            gemini_score=gemini_score,
            cohere_score=cohere_score,
            combined_z=combined_z,
            gate_decision=gate_decision,
            confidence=confidence,
        )

        logger.info(
            "Dual-fusion result for %s: gemini_z=%.4f, cohere_z=%.4f, combined=%.4f → %s",
            profile.brand_slug,
            gemini_z,
            cohere_z,
            combined_z,
            gate_decision,
        )

        return result

    def _query_index(
        self,
        index_name: str,
        vector: list[float],
        model_name: str,
        top_k: int,
    ) -> ModalScore:
        """Query a single Pinecone index and return the modal score."""
        index = get_index(index_name)

        results = index.query(vector=vector, top_k=top_k, include_metadata=True)

        if not results.matches:
            logger.warning("No matches in index %s", index_name)
            return ModalScore(model=model_name, raw_score=0.0, z_score=0.0, top_k_ids=[])

        # Average of top-K similarity scores
        scores = [m.score for m in results.matches]
        raw_score = float(np.mean(scores))
        top_k_ids = [m.id for m in results.matches]

        return ModalScore(
            model=model_name,
            raw_score=raw_score,
            z_score=0.0,  # Set after normalization
            top_k_ids=top_k_ids,
        )

    def _normalize_z(
        self,
        raw_score: float,
        profile: BrandProfile,
        model_name: str,
        baseline_mean: Optional[float] = None,
        baseline_std: Optional[float] = None,
    ) -> float:
        """Normalize a raw cosine similarity to a z-score using brand baseline.

        Uses provided baseline stats from brand_baselines table when available.
        Falls back to approximate z-scale centering if no baseline exists.
        """
        mean = baseline_mean if baseline_mean is not None else 0.5
        std = baseline_std if baseline_std is not None else 0.15

        if std == 0:
            return 0.0

        return (raw_score - mean) / std

    def _gate(self, combined_z: float, thresholds: BrandThresholds) -> str:
        """Apply gate decision based on combined z-score and thresholds."""
        if combined_z >= thresholds.auto_pass_z:
            return "AUTO_PASS"
        elif combined_z <= thresholds.auto_fail_z:
            return "AUTO_FAIL"
        else:
            return "HITL_REVIEW"

    def _confidence(self, combined_z: float, thresholds: BrandThresholds) -> float:
        """Calculate confidence of the gate decision (0-1).

        Higher confidence when the score is far from the decision boundaries.
        """
        pass_dist = abs(combined_z - thresholds.auto_pass_z)
        fail_dist = abs(combined_z - thresholds.auto_fail_z)
        min_dist = min(pass_dist, fail_dist)
        band_width = thresholds.auto_pass_z - thresholds.auto_fail_z

        if band_width == 0:
            return 1.0

        # Confidence scales with distance from nearest boundary
        confidence = min(min_dist / (band_width * 0.5), 1.0)
        return round(confidence, 4)


def load_brand_profile(brand_slug: str, profiles_dir: Optional[str] = None) -> BrandProfile:
    """Load a brand profile from JSON file.

    Args:
        brand_slug: Brand identifier (e.g., 'jennikayne', 'cylndr').
        profiles_dir: Directory containing profile JSONs. Defaults to
                      brand-engine/data/brand_profiles/.
    """
    if profiles_dir is None:
        profiles_dir = str(
            Path(__file__).parent.parent.parent / "data" / "brand_profiles"
        )

    profile_path = Path(profiles_dir) / f"{brand_slug}.json"

    if not profile_path.exists():
        raise FileNotFoundError(f"Brand profile not found: {profile_path}")

    with open(profile_path) as f:
        data = json.load(f)

    return BrandProfile(**data)
