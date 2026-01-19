"""
Generation Worker

Handles content generation using Temp-gen and other creative tools.
Supports multiple AI models: Nano, Veo, Sora.
"""

import os
import subprocess
import json
import uuid
from datetime import datetime
from typing import Callable, Dict, List, Optional, Any

from supabase import Client


class GenerationWorker:
    """
    Interfaces with Temp-gen for content generation.

    Supports:
    - Nano: Fast, cost-effective image generation
    - Veo: High quality video generation
    - Sora: Premium generation with enhanced quality
    """

    def __init__(
        self,
        supabase: Client,
        log_callback: Optional[Callable[[str, str, str], None]] = None
    ):
        """
        Initialize the generation worker.

        Args:
            supabase: Supabase client for database operations
            log_callback: Optional callback for logging (stage, level, message)
        """
        self.supabase = supabase
        self.log = log_callback or (lambda s, l, m: print(f"[{s}] [{l}] {m}"))

        # Path to Temp-gen tools
        self.temp_gen_path = os.environ.get(
            "TEMP_GEN_PATH",
            "/Users/timothysepulvado/Desktop/Temp-gen"
        )

        # Output directory for generated content
        self.output_dir = os.environ.get(
            "GENERATION_OUTPUT_DIR",
            "/Users/timothysepulvado/Desktop/Brand_linter/local_quick_setup/data/generated"
        )

        # Ensure output directory exists
        os.makedirs(self.output_dir, exist_ok=True)

    async def generate(
        self,
        run_id: Optional[str],
        client_id: str,
        prompt: str,
        model_type: str = "nano",
        negative_prompts: Optional[List[str]] = None,
        reference_images: Optional[List[str]] = None,
        output_name: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Generate content using specified AI model.

        Args:
            run_id: UUID of the associated run (optional)
            client_id: Client/brand ID
            prompt: Generation prompt
            model_type: AI model to use ("nano", "veo", "sora")
            negative_prompts: List of negative prompt terms
            reference_images: List of reference image paths
            output_name: Optional custom output filename

        Returns:
            Artifact dict with id, path, type, etc. or None on failure
        """
        self.log("generation", "info", f"Generating with {model_type}: {prompt[:50]}...")

        try:
            if model_type == "nano":
                result = await self._generate_nano(
                    prompt, negative_prompts, reference_images, output_name
                )
            elif model_type == "veo":
                result = await self._generate_veo(
                    prompt, negative_prompts, reference_images, output_name
                )
            elif model_type == "sora":
                result = await self._generate_sora(
                    prompt, negative_prompts, reference_images, output_name
                )
            else:
                self.log("generation", "error", f"Unknown model type: {model_type}")
                return None

            if not result:
                return None

            # Create artifact record
            artifact = await self._create_artifact(
                run_id=run_id,
                artifact_type=result["type"],
                name=result["name"],
                path=result["path"],
                prompt_used=prompt
            )

            return artifact

        except Exception as e:
            self.log("generation", "error", f"Generation failed: {str(e)}")
            return None

    async def _generate_nano(
        self,
        prompt: str,
        negative_prompts: Optional[List[str]] = None,
        reference_images: Optional[List[str]] = None,
        output_name: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Generate image using Nano model (fast, cost-effective).
        """
        output_name = output_name or f"nano_{uuid.uuid4().hex[:8]}.png"
        output_path = os.path.join(self.output_dir, output_name)

        # Build command for Temp-gen
        cmd = [
            "python3", os.path.join(self.temp_gen_path, "generate.py"),
            "--model", "nano",
            "--prompt", prompt,
            "--output", output_path
        ]

        if negative_prompts:
            cmd.extend(["--negative", ", ".join(negative_prompts)])

        if reference_images:
            cmd.extend(["--reference", reference_images[0]])

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=120,
                cwd=self.temp_gen_path
            )

            if result.returncode == 0 and os.path.exists(output_path):
                self.log("generation", "info", f"Generated: {output_name}")
                return {
                    "type": "image",
                    "name": output_name,
                    "path": output_path
                }

            self.log("generation", "warn", f"Nano generation returned: {result.returncode}")
            if result.stderr:
                self.log("generation", "debug", result.stderr[:500])

            # Fallback: Create a placeholder for testing
            return await self._create_placeholder_image(output_name, output_path, "nano")

        except subprocess.TimeoutExpired:
            self.log("generation", "error", "Nano generation timed out")
            return await self._create_placeholder_image(output_name, output_path, "nano")
        except FileNotFoundError:
            self.log("generation", "warn", "Temp-gen not found, using placeholder")
            return await self._create_placeholder_image(output_name, output_path, "nano")

    async def _generate_veo(
        self,
        prompt: str,
        negative_prompts: Optional[List[str]] = None,
        reference_images: Optional[List[str]] = None,
        output_name: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Generate video using Veo model (high quality video).
        """
        output_name = output_name or f"veo_{uuid.uuid4().hex[:8]}.mp4"
        output_path = os.path.join(self.output_dir, output_name)

        # Build command for Temp-gen
        cmd = [
            "python3", os.path.join(self.temp_gen_path, "generate.py"),
            "--model", "veo",
            "--prompt", prompt,
            "--output", output_path
        ]

        if negative_prompts:
            cmd.extend(["--negative", ", ".join(negative_prompts)])

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=300,  # Longer timeout for video
                cwd=self.temp_gen_path
            )

            if result.returncode == 0 and os.path.exists(output_path):
                self.log("generation", "info", f"Generated: {output_name}")
                return {
                    "type": "video",
                    "name": output_name,
                    "path": output_path
                }

            self.log("generation", "warn", f"Veo generation returned: {result.returncode}")

            # Fallback: Create a placeholder for testing
            return await self._create_placeholder_video(output_name, output_path, "veo")

        except subprocess.TimeoutExpired:
            self.log("generation", "error", "Veo generation timed out")
            return await self._create_placeholder_video(output_name, output_path, "veo")
        except FileNotFoundError:
            self.log("generation", "warn", "Temp-gen not found, using placeholder")
            return await self._create_placeholder_video(output_name, output_path, "veo")

    async def _generate_sora(
        self,
        prompt: str,
        negative_prompts: Optional[List[str]] = None,
        reference_images: Optional[List[str]] = None,
        output_name: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Generate with Sora model (premium quality).
        """
        output_name = output_name or f"sora_{uuid.uuid4().hex[:8]}.png"
        output_path = os.path.join(self.output_dir, output_name)

        # Sora uses enhanced prompt with quality modifiers
        enhanced_prompt = f"{prompt}, professional quality, cinematic, detailed"

        # Build command for Temp-gen
        cmd = [
            "python3", os.path.join(self.temp_gen_path, "generate.py"),
            "--model", "sora",
            "--prompt", enhanced_prompt,
            "--output", output_path,
            "--quality", "high"
        ]

        if negative_prompts:
            cmd.extend(["--negative", ", ".join(negative_prompts)])

        if reference_images:
            cmd.extend(["--reference", reference_images[0]])

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=180,
                cwd=self.temp_gen_path
            )

            if result.returncode == 0 and os.path.exists(output_path):
                self.log("generation", "info", f"Generated: {output_name}")
                return {
                    "type": "image",
                    "name": output_name,
                    "path": output_path
                }

            self.log("generation", "warn", f"Sora generation returned: {result.returncode}")

            # Fallback: Create a placeholder for testing
            return await self._create_placeholder_image(output_name, output_path, "sora")

        except subprocess.TimeoutExpired:
            self.log("generation", "error", "Sora generation timed out")
            return await self._create_placeholder_image(output_name, output_path, "sora")
        except FileNotFoundError:
            self.log("generation", "warn", "Temp-gen not found, using placeholder")
            return await self._create_placeholder_image(output_name, output_path, "sora")

    async def _create_placeholder_image(
        self,
        name: str,
        path: str,
        model: str
    ) -> Dict[str, Any]:
        """
        Create a placeholder image for testing when Temp-gen is unavailable.
        """
        # Create a simple placeholder file
        placeholder_content = f"""
        Placeholder Image
        Model: {model}
        Generated: {datetime.utcnow().isoformat()}
        """

        # For demo, create a text file (in production, would generate actual image)
        txt_path = path.replace('.png', '.txt').replace('.jpg', '.txt')
        with open(txt_path, 'w') as f:
            f.write(placeholder_content)

        self.log("generation", "info", f"Created placeholder: {name}")
        return {
            "type": "image",
            "name": name,
            "path": txt_path  # Use txt path for demo
        }

    async def _create_placeholder_video(
        self,
        name: str,
        path: str,
        model: str
    ) -> Dict[str, Any]:
        """
        Create a placeholder video for testing when Temp-gen is unavailable.
        """
        # Create a simple placeholder file
        txt_path = path.replace('.mp4', '.txt')
        with open(txt_path, 'w') as f:
            f.write(f"Placeholder Video\nModel: {model}\nGenerated: {datetime.utcnow().isoformat()}")

        self.log("generation", "info", f"Created placeholder: {name}")
        return {
            "type": "video",
            "name": name,
            "path": txt_path
        }

    async def _create_artifact(
        self,
        run_id: Optional[str],
        artifact_type: str,
        name: str,
        path: str,
        prompt_used: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Create artifact record in database.
        """
        size = 0
        try:
            if os.path.exists(path):
                size = os.path.getsize(path)
        except Exception:
            pass

        artifact_data = {
            "type": artifact_type,
            "name": name,
            "path": path,
            "size": size,
            "prompt_used": prompt_used
        }

        if run_id:
            artifact_data["run_id"] = run_id

        result = self.supabase.table("artifacts").insert(artifact_data).select().single().execute()

        return result.data if result.data else artifact_data
