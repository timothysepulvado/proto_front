"""Grading executor - runs brand compliance checks using brand-engine core.

Rewired from subprocess calls to Brand_linter multimodal_retriever.py
to direct imports from brand_engine.core.
"""

import json
import sys
from pathlib import Path
from typing import Callable, Optional

# Add brand-engine to path for direct imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "brand-engine"))

from config import OUTPUT_BASE


class GradingExecutor:
    """Executor for grading (brand drift/compliance) operations.

    Uses brand_engine.core directly — no subprocess, shared model singletons.
    """

    def __init__(self, log_callback: Callable[[str, str, str], None]):
        self.log = log_callback

    def execute(
        self, run_id: str, client_id: str, params: Optional[dict] = None
    ) -> dict:
        """Execute a grading/drift check operation.

        Args:
            run_id: The run ID
            client_id: The client ID
            params: Parameters including 'image_path' and 'text_query'

        Returns:
            dict with status, grade decision, and report artifact
        """
        params = params or {}
        image_path = params.get("image_path")
        text_query = params.get("text_query", "Brand lifestyle image with natural lighting")
        brand_slug = client_id.replace("client_", "")

        if not image_path:
            self.log("grading", "error", "No image provided for grading")
            return {"status": "failed", "error": "No image to grade"}

        self.log("grading", "info", f"Grading image: {image_path}")
        self.log("grading", "info", f"Brand: {brand_slug}, query: {text_query}")

        try:
            from brand_engine.core.grader import BrandGrader
            from brand_engine.core.retriever import load_brand_profile

            profile = load_brand_profile(brand_slug)
            grader = BrandGrader(log_callback=self.log)

            result = grader.grade(
                image_path=image_path,
                profile=profile,
                text_query=text_query,
                include_pixel_analysis=True,
                index_tier="core",
            )

            gate_decision = result.gate_decision
            combined_z = result.fusion.combined_z
            gemini_z = result.fusion.gemini_score.z_score
            cohere_z = result.fusion.cohere_score.z_score

            self.log("grading", "info", f"Gate Decision: {gate_decision}")
            self.log("grading", "info", f"Combined Z-Score: {combined_z:.4f}")
            self.log("grading", "info", f"Gemini Z: {gemini_z:.4f}, Cohere Z: {cohere_z:.4f}")

            hitl_required = result.hitl_required

            if gate_decision == "AUTO_PASS":
                self.log("grading", "info", "Image PASSED brand compliance check")
            elif gate_decision == "AUTO_FAIL":
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
                "grade_decision": gate_decision,
                "metrics": {
                    "combined_z": combined_z,
                    "gemini_z": gemini_z,
                    "cohere_z": cohere_z,
                },
                "artifacts": [
                    {
                        "type": "report",
                        "name": f"grade_{run_id}.json",
                        "path": str(report_path),
                    }
                ],
            }

        except FileNotFoundError as e:
            self.log("grading", "error", f"Brand profile not found: {e}")
            return {"status": "failed", "error": str(e)}
        except Exception as e:
            self.log("grading", "error", f"Grading error: {str(e)}")
            return {"status": "failed", "error": str(e)}
