"""Creative executor - runs Temp-gen for image/video generation."""

import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, Optional

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))
from config import TOOL_PATHS, TOOL_VENVS, OUTPUT_BASE


class CreativeExecutor:
    """Executor for creative (image/video generation) operations."""

    def __init__(self, log_callback: Callable[[str, str, str], None]):
        """
        Initialize the creative executor.

        Args:
            log_callback: Function to call with (stage, level, message) for logging
        """
        self.log = log_callback
        self.tool_path = TOOL_PATHS["temp_gen"]
        self.python = TOOL_VENVS["temp_gen"]

    def generate_image(
        self, run_id: str, client_id: str, prompt: str, output_name: Optional[str] = None
    ) -> dict:
        """
        Generate an image using Gemini via nano_banana.

        Args:
            run_id: The run ID
            client_id: The client ID
            prompt: The image generation prompt
            output_name: Optional output filename

        Returns:
            dict with status and artifact info
        """
        self.log("creative", "info", f"Generating image for: {prompt[:50]}...")

        # Generate output path
        timestamp = int(time.time())
        output_name = output_name or f"gen_image_{client_id}_{timestamp}.png"
        output_path = OUTPUT_BASE / client_id / "images" / output_name

        # Ensure output directory exists
        output_path.parent.mkdir(parents=True, exist_ok=True)

        self.log("creative", "info", f"Output path: {output_path}")

        try:
            # Run the nano_banana generate command
            cmd = [
                str(self.python),
                "main.py",
                "nano",
                "generate",
                "--prompt",
                prompt,
                "--output",
                str(output_path),
            ]

            self.log("creative", "info", "Running Gemini image generation...")

            result = subprocess.run(
                cmd,
                cwd=str(self.tool_path),
                capture_output=True,
                text=True,
                timeout=180,  # 3 minutes for image gen
            )

            # Stream stdout lines as logs
            for line in result.stdout.strip().split("\n"):
                if line.strip():
                    self.log("creative", "info", line.strip())

            if result.returncode != 0:
                self.log("creative", "error", f"Image generation failed: {result.stderr}")
                return {"status": "failed", "error": result.stderr}

            self.log("creative", "info", f"Image saved to: {output_path}")

            return {
                "status": "completed",
                "artifacts": [
                    {
                        "type": "image",
                        "name": output_name,
                        "path": str(output_path),
                    }
                ],
            }

        except subprocess.TimeoutExpired:
            self.log("creative", "error", "Image generation timed out after 180s")
            return {"status": "failed", "error": "Timeout"}
        except Exception as e:
            self.log("creative", "error", f"Image generation error: {str(e)}")
            return {"status": "failed", "error": str(e)}

    def generate_video(
        self, run_id: str, client_id: str, prompt: str, output_name: Optional[str] = None
    ) -> dict:
        """
        Generate a video using Veo 3.1.

        Args:
            run_id: The run ID
            client_id: The client ID
            prompt: The video generation prompt
            output_name: Optional output filename

        Returns:
            dict with status and artifact info
        """
        self.log("creative", "info", f"Generating video for: {prompt[:50]}...")

        # Generate output path
        timestamp = int(time.time())
        output_name = output_name or f"gen_video_{client_id}_{timestamp}.mp4"
        output_path = OUTPUT_BASE / client_id / "videos" / output_name

        # Ensure output directory exists
        output_path.parent.mkdir(parents=True, exist_ok=True)

        self.log("creative", "info", f"Output path: {output_path}")

        try:
            # Run the veo generate command
            cmd = [
                str(self.python),
                "main.py",
                "veo",
                "generate",
                "--prompt",
                prompt,
                "--output",
                str(output_path),
            ]

            self.log("creative", "info", "Running Veo 3.1 video generation...")

            result = subprocess.run(
                cmd,
                cwd=str(self.tool_path),
                capture_output=True,
                text=True,
                timeout=600,  # 10 minutes for video gen
            )

            # Stream stdout lines as logs
            for line in result.stdout.strip().split("\n"):
                if line.strip():
                    self.log("creative", "info", line.strip())

            if result.returncode != 0:
                self.log("creative", "error", f"Video generation failed: {result.stderr}")
                return {"status": "failed", "error": result.stderr}

            self.log("creative", "info", f"Video saved to: {output_path}")

            return {
                "status": "completed",
                "artifacts": [
                    {
                        "type": "video",
                        "name": output_name,
                        "path": str(output_path),
                    }
                ],
            }

        except subprocess.TimeoutExpired:
            self.log("creative", "error", "Video generation timed out after 600s")
            return {"status": "failed", "error": "Timeout"}
        except Exception as e:
            self.log("creative", "error", f"Video generation error: {str(e)}")
            return {"status": "failed", "error": str(e)}

    def execute(
        self, run_id: str, client_id: str, mode: str, params: Optional[dict] = None
    ) -> dict:
        """
        Execute a creative operation based on mode.

        Args:
            run_id: The run ID
            client_id: The client ID
            mode: 'images' or 'video'
            params: Parameters including 'prompt'

        Returns:
            dict with status and artifacts
        """
        params = params or {}
        prompt = params.get("prompt", "A beautiful brand lifestyle image")

        if mode == "images":
            return self.generate_image(run_id, client_id, prompt, params.get("output_name"))
        elif mode == "video":
            return self.generate_video(run_id, client_id, prompt, params.get("output_name"))
        else:
            self.log("creative", "error", f"Unknown creative mode: {mode}")
            return {"status": "failed", "error": f"Unknown mode: {mode}"}
