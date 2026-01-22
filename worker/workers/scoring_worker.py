"""
Scoring Worker

Calls BDE/Brand Linter for scoring artifacts against brand DNA.
Implements triple fusion scoring: CLIP + E5 + Cohere.

NAMING CONTRACT:
- Score variables use _raw (0.0-1.0) or _z (unbounded) suffixes
- Grading reads from Core/legacy indexes only (never Campaign)
- See index_guard.py for full naming rules
"""

import os
import subprocess
import json
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Any

from supabase import Client

# Import index_guard for naming contract enforcement
from index_guard import (
    get_brand_slug,
    get_grading_indexes,
    get_legacy_index,
    assert_grading_index,
    brand_id_from_client_id,
)


# Scoring thresholds
THRESHOLDS = {
    "AUTO_PASS": 0.92,
    "HITL_REVIEW": 0.5,
    "AUTO_FAIL": 0.0
}


@dataclass
class ScoreResult:
    """
    Result of scoring an artifact.

    Score naming convention:
    - *_raw: Raw cosine similarity scores (0.0 - 1.0 scale)
    - *_z: Z-normalized scores (unbounded, for comparisons)

    This class stores raw scores from Pinecone queries.
    """
    passed_gate1: bool
    fused_raw: float  # Weighted combination of raw scores
    clip_raw: float   # CLIP visual similarity (0.0 - 1.0)
    e5_raw: float     # E5 semantic similarity (0.0 - 1.0)
    cohere_raw: float # Cohere multimodal similarity (0.0 - 1.0)
    decision: str     # AUTO_PASS, HITL_REVIEW, AUTO_FAIL
    failure_reasons: List[str]

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for API responses."""
        return {
            "passed_gate1": self.passed_gate1,
            "scores": {
                "clip_raw": self.clip_raw,
                "e5_raw": self.e5_raw,
                "cohere_raw": self.cohere_raw,
                "fused_raw": self.fused_raw,
                "decision": self.decision
            },
            "failure_reasons": self.failure_reasons
        }


class ScoringWorker:
    """
    Calls BDE/Brand Linter for scoring.

    Uses multimodal_retriever for triple fusion scoring:
    - CLIP: Visual similarity
    - E5: Semantic understanding
    - Cohere: Multimodal alignment
    """

    def __init__(
        self,
        supabase: Client,
        log_callback: Optional[Callable[[str, str, str], None]] = None
    ):
        """
        Initialize the scoring worker.

        Args:
            supabase: Supabase client for database operations
            log_callback: Optional callback for logging (stage, level, message)
        """
        self.supabase = supabase
        self.log = log_callback or (lambda s, l, m: print(f"[{s}] [{l}] {m}"))

        # Path to Brand_linter tools
        self.brand_linter_path = os.environ.get(
            "BRAND_LINTER_PATH",
            "/Users/timothysepulvado/Desktop/Brand_linter/local_quick_setup"
        )

    async def score_item(
        self,
        artifact_id: str,
        brand_id: str,
        image_path: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Score single item through Gate 1.

        Args:
            artifact_id: UUID of the artifact to score
            brand_id: Brand/client ID for scoring context
            image_path: Optional direct path to image (if not using artifact)

        Returns:
            ScoreResult dict with scores and decision
        """
        self.log("scoring", "info", f"Scoring artifact: {artifact_id}")

        # Get artifact details if needed
        if not image_path and artifact_id:
            result = self.supabase.table("artifacts").select("*").eq(
                "id", artifact_id
            ).single().execute()

            if result.data:
                image_path = result.data.get("path")

        if not image_path:
            self.log("scoring", "error", "No image path available")
            return ScoreResult(
                passed_gate1=False,
                fused_raw=0.0,
                clip_raw=0.0,
                e5_raw=0.0,
                cohere_raw=0.0,
                decision="AUTO_FAIL",
                failure_reasons=["no_image"]
            ).to_dict()

        try:
            # Call multimodal_retriever for scoring
            scores = await self._call_multimodal_retriever(image_path, brand_id)

            # Analyze results
            result = self._analyze_scores(scores)

            # Update artifact grade in database
            if artifact_id:
                self.supabase.table("artifacts").update({
                    "grade": result.to_dict()["scores"]
                }).eq("id", artifact_id).execute()

            self.log("scoring", "info",
                    f"Score: fused_raw={result.fused_raw:.3f}, decision={result.decision}")

            return result.to_dict()

        except Exception as e:
            self.log("scoring", "error", f"Scoring error: {str(e)}")
            return ScoreResult(
                passed_gate1=False,
                fused_raw=0.0,
                clip_raw=0.0,
                e5_raw=0.0,
                cohere_raw=0.0,
                decision="AUTO_FAIL",
                failure_reasons=["scoring_error"]
            ).to_dict()

    async def _call_multimodal_retriever(
        self,
        image_path: str,
        brand_id: str
    ) -> Dict[str, float]:
        """
        Call the multimodal_retriever.py script for scoring.

        SAFETY: Only reads from Core/legacy indexes (never Campaign).
        Uses index_guard to enforce naming contract.

        Args:
            image_path: Path to the image to score
            brand_id: Brand ID for context

        Returns:
            Dict with clip_raw, e5_raw, cohere_raw, and fused_raw scores
        """
        script_path = os.path.join(self.brand_linter_path, "multimodal_retriever.py")

        # Extract brand_id from client_id format if necessary
        actual_brand_id = brand_id_from_client_id(brand_id)

        # Get grading indexes using index_guard (enforces Core/legacy only)
        grading_indexes = get_grading_indexes(actual_brand_id)

        # Assert all indexes are valid for grading (safety check)
        for model, index_name in grading_indexes.items():
            assert_grading_index(index_name)
            self.log("scoring", "debug", f"Using grading index: {index_name}")

        # Get brand_slug for namespace (Pinecone uses slug format)
        brand_slug = get_brand_slug(actual_brand_id)

        # Build command with proper namespace
        cmd = [
            "python3", script_path,
            "--query-image", image_path,
            "--namespace", brand_slug,
            "--output-format", "json"
        ]

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60,
                cwd=self.brand_linter_path
            )

            if result.returncode == 0 and result.stdout:
                try:
                    output = json.loads(result.stdout)
                    # Return scores with _raw suffix (0.0 - 1.0 scale)
                    return {
                        "clip_raw": output.get("clip_score", 0.0),
                        "e5_raw": output.get("e5_score", 0.0),
                        "cohere_raw": output.get("cohere_score", 0.0),
                        "fused_raw": output.get("fused_score", 0.0)
                    }
                except json.JSONDecodeError:
                    self.log("scoring", "warn", "Could not parse retriever output")

            # Fallback: try to parse from stderr or use defaults
            self.log("scoring", "warn", f"Retriever exit code: {result.returncode}")
            if result.stderr:
                self.log("scoring", "debug", f"Stderr: {result.stderr[:500]}")

        except subprocess.TimeoutExpired:
            self.log("scoring", "error", "Retriever timed out")
        except Exception as e:
            self.log("scoring", "error", f"Retriever error: {str(e)}")

        # Return default scores on failure (with _raw suffix)
        return {
            "clip_raw": 0.5,
            "e5_raw": 0.5,
            "cohere_raw": 0.5,
            "fused_raw": 0.5
        }

    def _analyze_scores(self, scores: Dict[str, float]) -> ScoreResult:
        """
        Analyze scores and determine decision.

        Args:
            scores: Dict with clip_raw, e5_raw, cohere_raw, fused_raw scores

        Returns:
            ScoreResult with analysis
        """
        fused_raw = scores.get("fused_raw", 0.0)
        clip_raw = scores.get("clip_raw", 0.0)
        e5_raw = scores.get("e5_raw", 0.0)
        cohere_raw = scores.get("cohere_raw", 0.0)

        # Determine decision based on fused score
        if fused_raw >= THRESHOLDS["AUTO_PASS"]:
            decision = "AUTO_PASS"
            passed = True
        elif fused_raw >= THRESHOLDS["HITL_REVIEW"]:
            decision = "HITL_REVIEW"
            passed = True  # Still passes Gate 1, goes to HITL
        else:
            decision = "AUTO_FAIL"
            passed = False

        # Analyze why it failed
        failure_reasons = self._analyze_failure_reasons(scores)

        return ScoreResult(
            passed_gate1=passed,
            fused_raw=fused_raw,
            clip_raw=clip_raw,
            e5_raw=e5_raw,
            cohere_raw=cohere_raw,
            decision=decision,
            failure_reasons=failure_reasons
        )

    def _analyze_failure_reasons(self, scores: Dict[str, float]) -> List[str]:
        """
        Determine failure reasons based on score breakdown.

        Args:
            scores: Dict with individual scores (using _raw suffix)

        Returns:
            List of failure reason category IDs
        """
        reasons = []

        clip_raw = scores.get("clip_raw", 0.0)
        e5_raw = scores.get("e5_raw", 0.0)
        cohere_raw = scores.get("cohere_raw", 0.0)

        # Low CLIP score suggests visual mismatch
        if clip_raw < 0.70:
            reasons.append("off_brand")

        # Low E5 score suggests semantic/conceptual issues
        if e5_raw < 0.60:
            reasons.append("wrong_composition")

        # Low Cohere score suggests multimodal misalignment
        if cohere_raw < 0.65:
            reasons.append("quality_issue")

        # If all scores are mediocre, it's likely a general brand issue
        if all(s < 0.75 for s in [clip_raw, e5_raw, cohere_raw]) and not reasons:
            reasons.append("off_brand")

        return reasons

    async def batch_score(
        self,
        artifacts: List[Dict[str, Any]],
        brand_id: str
    ) -> List[Dict[str, Any]]:
        """
        Score multiple artifacts in batch.

        Args:
            artifacts: List of artifact dicts with id and path
            brand_id: Brand ID for context

        Returns:
            List of score results
        """
        results = []
        for artifact in artifacts:
            artifact_id = artifact.get("id", "")
            result = await self.score_item(
                artifact_id=artifact_id,
                brand_id=brand_id,
                image_path=artifact.get("path")
            )
            results.append({
                "artifact_id": artifact_id,
                **result
            })
        return results
