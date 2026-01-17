"""Grading executor - runs brand compliance checks using multimodal retriever."""

import json
import subprocess
import sys
from pathlib import Path
from typing import Callable, Optional

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))
from config import TOOL_PATHS, TOOL_VENVS, OUTPUT_BASE


class GradingExecutor:
    """Executor for grading (brand drift/compliance) operations."""

    def __init__(self, log_callback: Callable[[str, str, str], None]):
        """
        Initialize the grading executor.

        Args:
            log_callback: Function to call with (stage, level, message) for logging
        """
        self.log = log_callback
        self.tool_path = TOOL_PATHS["brand_linter"]
        self.python = TOOL_VENVS["brand_linter"]

    def execute(
        self, run_id: str, client_id: str, params: Optional[dict] = None
    ) -> dict:
        """
        Execute a grading/drift check operation.

        Args:
            run_id: The run ID
            client_id: The client ID
            params: Parameters including 'image_path' and 'text_query'

        Returns:
            dict with status, grade decision, and report artifact
        """
        params = params or {}

        # Get image path - required for grading
        image_path = params.get("image_path")
        text_query = params.get("text_query", "Brand lifestyle image with natural lighting")

        if not image_path:
            # For demo, use a sample image from the data directory
            sample_images = list((self.tool_path / "data").glob("*.jpg")) + list(
                (self.tool_path / "data").glob("*.png")
            )
            if sample_images:
                image_path = str(sample_images[0])
                self.log("grading", "info", f"Using sample image: {image_path}")
            else:
                self.log("grading", "error", "No image provided and no samples found")
                return {"status": "failed", "error": "No image to grade"}

        self.log("grading", "info", f"Grading image: {image_path}")
        self.log("grading", "info", f"Query: {text_query}")

        script = self.tool_path / "tools" / "multimodal_retriever.py"

        if not script.exists():
            self.log("grading", "error", f"Script not found: {script}")
            return {"status": "failed", "error": "Grading script not found"}

        try:
            # Run the multimodal retriever with JSON output
            cmd = [
                str(self.python),
                str(script),
                image_path,
                text_query,
                "--json",
            ]

            self.log("grading", "info", "Running triple-modal retrieval...")

            result = subprocess.run(
                cmd,
                cwd=str(self.tool_path),
                capture_output=True,
                text=True,
                timeout=120,
            )

            if result.returncode != 0:
                self.log("grading", "error", f"Grading failed: {result.stderr}")
                return {"status": "failed", "error": result.stderr}

            # Parse JSON output
            try:
                grade_result = json.loads(result.stdout)
            except json.JSONDecodeError:
                self.log("grading", "error", "Failed to parse grading output")
                return {"status": "failed", "error": "Invalid grading output"}

            # Extract key metrics
            fusion = grade_result.get("fusion", {})
            gate_decision = fusion.get("gate_decision", "UNKNOWN")
            combined_z = fusion.get("combined_z", 0.0)
            clip_raw = fusion.get("clip_raw_score", 0.0)

            self.log("grading", "info", f"Gate Decision: {gate_decision}")
            self.log("grading", "info", f"Combined Z-Score: {combined_z:.4f}")
            self.log("grading", "info", f"CLIP Raw Score: {clip_raw:.4f}")

            # Determine if HITL review is needed
            hitl_required = gate_decision == "HITL_REVIEW"

            if gate_decision == "AUTO_PASS":
                self.log("grading", "info", "Image PASSED brand compliance check")
            elif gate_decision == "AUTO_FAIL":
                self.log("grading", "warn", "Image FAILED brand compliance check")
            else:
                self.log("grading", "warn", "Image requires human review")

            # Save report as artifact
            report_path = OUTPUT_BASE / client_id / "reports" / f"grade_{run_id}.json"
            report_path.parent.mkdir(parents=True, exist_ok=True)

            with open(report_path, "w") as f:
                json.dump(grade_result, f, indent=2)

            self.log("grading", "info", f"Report saved to: {report_path}")

            return {
                "status": "needs_review" if hitl_required else "completed",
                "hitl_required": hitl_required,
                "grade_decision": gate_decision,
                "metrics": {
                    "combined_z": combined_z,
                    "clip_raw": clip_raw,
                },
                "artifacts": [
                    {
                        "type": "report",
                        "name": f"grade_{run_id}.json",
                        "path": str(report_path),
                    }
                ],
            }

        except subprocess.TimeoutExpired:
            self.log("grading", "error", "Grading timed out after 120s")
            return {"status": "failed", "error": "Timeout"}
        except Exception as e:
            self.log("grading", "error", f"Grading error: {str(e)}")
            return {"status": "failed", "error": str(e)}
