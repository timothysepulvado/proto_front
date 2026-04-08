"""Grading executor — runs brand compliance checks via brand_engine.core.

Replaces the old subprocess-based Brand_linter multimodal_retriever with
direct Python imports from the consolidated brand-engine SDK. Uses
BrandGrader for dual-fusion (Gemini + Cohere) grading with optional
pixel analysis.
"""

import json
import sys
from pathlib import Path
from typing import Callable, Optional

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))
from config import BRAND_ASSETS_BASE, BRAND_PROFILES_DIR, OUTPUT_BASE

# Try importing brand-engine (config.py adds it to sys.path)
try:
    from brand_engine.core import BrandGrader
    from brand_engine.core.retriever import load_brand_profile

    BRAND_ENGINE_AVAILABLE = True
except ImportError:
    BRAND_ENGINE_AVAILABLE = False


class GradingExecutor:
    """Executor for grading (brand drift/compliance) operations.

    Uses brand_engine.core.BrandGrader for dual-fusion retrieval
    (Gemini Embed 2 + Cohere v4 z-score fusion) combined with
    pixel-level image analysis (saturation, clutter, palette match).
    """

    def __init__(self, log_callback: Callable[[str, str, str], None]):
        """
        Initialize the grading executor.

        Args:
            log_callback: Function to call with (stage, level, message) for logging
        """
        self.log = log_callback
        self._grader: Optional[object] = None

    def _get_grader(self) -> "BrandGrader":
        """Lazy-init the BrandGrader with our log callback."""
        if self._grader is None:
            self._grader = BrandGrader(log_callback=self.log)
        return self._grader

    def _find_sample_image(self, brand_slug: str) -> Optional[str]:
        """Find a sample image for demo/fallback grading."""
        candidates = [
            BRAND_ASSETS_BASE / brand_slug / "reference_images",
            BRAND_ASSETS_BASE / brand_slug,
        ]
        image_exts = {".jpg", ".jpeg", ".png", ".webp"}

        for candidate in candidates:
            if candidate.exists():
                images = [
                    f for f in candidate.iterdir()
                    if f.suffix.lower() in image_exts
                ]
                if images:
                    return str(images[0])
        return None

    def execute(
        self, run_id: str, client_id: str, params: Optional[dict] = None
    ) -> dict:
        """
        Execute a grading/drift check operation.

        Grades an image against a brand's compliance profile using
        dual-fusion embedding similarity and pixel analysis.

        Args:
            run_id: The run ID
            client_id: The client ID (e.g., "client_jenni_kayne")
            params: Parameters including:
                - image_path: path to image to grade (required for real grading)
                - text_query: semantic query for retrieval matching
                - index_tier: Pinecone tier (default "brand-dna")
                - include_pixel_analysis: whether to run pixel checks (default True)

        Returns:
            dict with status, grade decision, metrics, and report artifact
        """
        params = params or {}
        brand_slug = client_id.replace("client_", "")
        index_tier = params.get("index_tier", "brand-dna")

        # Get image path — required for grading
        image_path = params.get("image_path")
        text_query = params.get(
            "text_query", "Brand lifestyle image with natural lighting"
        )

        if not image_path:
            # Try to find a sample image for demo
            image_path = self._find_sample_image(brand_slug)
            if image_path:
                self.log("grading", "info", f"Using sample image: {image_path}")
            else:
                self.log("grading", "warn", "No image provided and no samples found")

        self.log("grading", "info", f"Grading for brand '{brand_slug}'")

        # Check if brand-engine is available
        if not BRAND_ENGINE_AVAILABLE:
            self.log("grading", "warn", "brand-engine not available — running demo mode")
            return self._demo_grade(run_id, client_id, brand_slug)

        if not image_path:
            self.log("grading", "warn", "No image to grade — running demo mode")
            return self._demo_grade(run_id, client_id, brand_slug)

        # Load brand profile
        try:
            profiles_dir = str(BRAND_PROFILES_DIR) if BRAND_PROFILES_DIR.exists() else None
            profile = load_brand_profile(brand_slug, profiles_dir=profiles_dir)
            self.log("grading", "info", f"Loaded brand profile: {profile.display_name}")
        except FileNotFoundError:
            self.log("grading", "error", f"No brand profile found for '{brand_slug}'")
            return {"status": "failed", "error": f"Brand profile not found: {brand_slug}"}

        # Run grading via brand-engine
        try:
            grader = self._get_grader()
            result = grader.grade(
                image_path=image_path,
                profile=profile,
                text_query=text_query,
                include_pixel_analysis=params.get("include_pixel_analysis", True),
                index_tier=index_tier,
            )

            self.log("grading", "info", f"Gate Decision: {result.gate_decision}")
            self.log(
                "grading", "info",
                f"Fusion: combined_z={result.fusion.combined_z:.4f}, "
                f"gemini_z={result.fusion.gemini_score.z_score:.4f}, "
                f"cohere_z={result.fusion.cohere_score.z_score:.4f}",
            )
            self.log("grading", "info", f"Confidence: {result.fusion.confidence:.4f}")

            if result.pixel:
                self.log(
                    "grading", "info",
                    f"Pixel: sat={result.pixel.saturation_mean:.2f}, "
                    f"clutter={result.pixel.clutter_score:.2f}, "
                    f"whitespace={result.pixel.whitespace_ratio:.2f}",
                )

            # Determine HITL status
            hitl_required = result.hitl_required

            if result.gate_decision == "AUTO_PASS":
                self.log("grading", "info", "Image PASSED brand compliance check")
            elif result.gate_decision == "AUTO_FAIL":
                self.log("grading", "warn", "Image FAILED brand compliance check")
            else:
                self.log("grading", "warn", "Image requires human review")

            # Save report as artifact
            report_path = OUTPUT_BASE / client_id / "reports" / f"grade_{run_id}.json"
            report_path.parent.mkdir(parents=True, exist_ok=True)

            report_data = result.model_dump()
            with open(report_path, "w") as f:
                json.dump(report_data, f, indent=2)

            self.log("grading", "info", f"Report saved to: {report_path}")

            return {
                "status": "needs_review" if hitl_required else "completed",
                "hitl_required": hitl_required,
                "grade_decision": result.gate_decision,
                "metrics": {
                    "combined_z": result.fusion.combined_z,
                    "gemini_z": result.fusion.gemini_score.z_score,
                    "cohere_z": result.fusion.cohere_score.z_score,
                    "confidence": result.fusion.confidence,
                    "gemini_raw": result.fusion.gemini_score.raw_score,
                    "cohere_raw": result.fusion.cohere_score.raw_score,
                },
                "artifacts": [
                    {
                        "type": "report",
                        "name": f"grade_{run_id}.json",
                        "path": str(report_path),
                    }
                ],
            }

        except Exception as e:
            self.log("grading", "error", f"Brand-engine grading failed: {e}")
            self.log("grading", "warn", "Falling back to demo mode")
            return self._demo_grade(run_id, client_id, brand_slug)

    def _demo_grade(self, run_id: str, client_id: str, brand_slug: str) -> dict:
        """Simulate grading for demo/fallback purposes."""
        import time

        self.log("grading", "info", f"[DEMO] Loading brand embeddings for {brand_slug}...")
        time.sleep(0.8)
        self.log("grading", "info", "[DEMO] Running Gemini Embed 2 similarity...")
        time.sleep(0.6)
        self.log("grading", "info", "[DEMO] Running Cohere v4 similarity...")
        time.sleep(0.6)
        self.log("grading", "info", "[DEMO] Fusing scores (dual-fusion z-score)...")
        time.sleep(0.4)
        self.log("grading", "info", "[DEMO] Running pixel analysis...")
        time.sleep(0.5)
        self.log("grading", "info", "[DEMO] Gate Decision: HITL_REVIEW")
        self.log("grading", "info", "[DEMO] Combined Z-Score: 0.72 (simulated)")

        # Save demo report
        report_path = OUTPUT_BASE / client_id / "reports" / f"grade_{run_id}.json"
        report_path.parent.mkdir(parents=True, exist_ok=True)
        demo_report = {
            "demo": True,
            "gate_decision": "HITL_REVIEW",
            "combined_z": 0.72,
        }
        with open(report_path, "w") as f:
            json.dump(demo_report, f, indent=2)

        return {
            "status": "needs_review",
            "hitl_required": True,
            "grade_decision": "HITL_REVIEW",
            "metrics": {
                "combined_z": 0.72,
                "gemini_z": 0.85,
                "cohere_z": 0.52,
                "confidence": 0.45,
            },
            "artifacts": [
                {
                    "type": "report",
                    "name": f"grade_{run_id}.json",
                    "path": str(report_path),
                }
            ],
        }
