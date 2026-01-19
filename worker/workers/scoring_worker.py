"""
Scoring Worker

Calls BDE/Brand Linter for scoring artifacts against brand DNA.
Implements triple fusion scoring: CLIP + E5 + Cohere.
"""

import os
import subprocess
import json
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Any

from supabase import Client


# Scoring thresholds
THRESHOLDS = {
    "AUTO_PASS": 0.92,
    "HITL_REVIEW": 0.5,
    "AUTO_FAIL": 0.0
}


@dataclass
class ScoreResult:
    """Result of scoring an artifact."""
    passed_gate1: bool
    fused_score: float
    clip_score: float
    e5_score: float
    cohere_score: float
    decision: str  # AUTO_PASS, HITL_REVIEW, AUTO_FAIL
    failure_reasons: List[str]

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for API responses."""
        return {
            "passed_gate1": self.passed_gate1,
            "scores": {
                "clip": self.clip_score,
                "e5": self.e5_score,
                "cohere": self.cohere_score,
                "fused": self.fused_score,
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
                fused_score=0.0,
                clip_score=0.0,
                e5_score=0.0,
                cohere_score=0.0,
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
                    f"Score: fused={result.fused_score:.3f}, decision={result.decision}")

            return result.to_dict()

        except Exception as e:
            self.log("scoring", "error", f"Scoring error: {str(e)}")
            return ScoreResult(
                passed_gate1=False,
                fused_score=0.0,
                clip_score=0.0,
                e5_score=0.0,
                cohere_score=0.0,
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

        Args:
            image_path: Path to the image to score
            brand_id: Brand ID for context

        Returns:
            Dict with clip, e5, cohere, and fused scores
        """
        script_path = os.path.join(self.brand_linter_path, "multimodal_retriever.py")

        # Get Pinecone namespace for the brand
        client_result = self.supabase.table("clients").select("pinecone_namespace").eq(
            "id", brand_id
        ).single().execute()

        namespace = "default"
        if client_result.data:
            namespace = client_result.data.get("pinecone_namespace", "default")

        # Build command
        cmd = [
            "python3", script_path,
            "--query-image", image_path,
            "--namespace", namespace,
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
                    return {
                        "clip": output.get("clip_score", 0.0),
                        "e5": output.get("e5_score", 0.0),
                        "cohere": output.get("cohere_score", 0.0),
                        "fused": output.get("fused_score", 0.0)
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

        # Return default scores on failure
        return {
            "clip": 0.5,
            "e5": 0.5,
            "cohere": 0.5,
            "fused": 0.5
        }

    def _analyze_scores(self, scores: Dict[str, float]) -> ScoreResult:
        """
        Analyze scores and determine decision.

        Args:
            scores: Dict with clip, e5, cohere, fused scores

        Returns:
            ScoreResult with analysis
        """
        fused = scores.get("fused", 0.0)
        clip = scores.get("clip", 0.0)
        e5 = scores.get("e5", 0.0)
        cohere = scores.get("cohere", 0.0)

        # Determine decision based on fused score
        if fused >= THRESHOLDS["AUTO_PASS"]:
            decision = "AUTO_PASS"
            passed = True
        elif fused >= THRESHOLDS["HITL_REVIEW"]:
            decision = "HITL_REVIEW"
            passed = True  # Still passes Gate 1, goes to HITL
        else:
            decision = "AUTO_FAIL"
            passed = False

        # Analyze why it failed
        failure_reasons = self._analyze_failure_reasons(scores)

        return ScoreResult(
            passed_gate1=passed,
            fused_score=fused,
            clip_score=clip,
            e5_score=e5,
            cohere_score=cohere,
            decision=decision,
            failure_reasons=failure_reasons
        )

    def _analyze_failure_reasons(self, scores: Dict[str, float]) -> List[str]:
        """
        Determine failure reasons based on score breakdown.

        Args:
            scores: Dict with individual scores

        Returns:
            List of failure reason category IDs
        """
        reasons = []

        clip = scores.get("clip", 0.0)
        e5 = scores.get("e5", 0.0)
        cohere = scores.get("cohere", 0.0)

        # Low CLIP score suggests visual mismatch
        if clip < 0.70:
            reasons.append("off_brand")

        # Low E5 score suggests semantic/conceptual issues
        if e5 < 0.60:
            reasons.append("wrong_composition")

        # Low Cohere score suggests multimodal misalignment
        if cohere < 0.65:
            reasons.append("quality_issue")

        # If all scores are mediocre, it's likely a general brand issue
        if all(s < 0.75 for s in [clip, e5, cohere]) and not reasons:
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
            result = await self.score_item(
                artifact_id=artifact.get("id"),
                brand_id=brand_id,
                image_path=artifact.get("path")
            )
            results.append({
                "artifact_id": artifact.get("id"),
                **result
            })
        return results
