"""RAG Generator executor - generates content with brand DNA context injection."""

import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, Optional

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))
from config import TOOL_PATHS, TOOL_VENVS, OUTPUT_BASE

# Pinecone index suffixes for triple-modal retrieval
INDEX_SUFFIXES = {
    "clip": "-brand-dna",           # CLIP 768D - Visual similarity
    "e5": "-brand-dna-e5",          # E5 1024D - Semantic/text
    "cohere": "-brand-dna-cohere",  # Cohere 1536D - Multimodal
}

# Scoring thresholds
AUTO_PASS_FUSED = 0.92
AUTO_PASS_CLIP_FLOOR = 0.80
AUTO_PASS_CLIP_RAW = 0.70
HITL_THRESHOLD_FUSED = 0.5
HITL_THRESHOLD_CLIP = 0.60
HITL_MIN_VIABLE = 3

# Maximum regeneration attempts
MAX_ATTEMPTS = 3


class RAGGeneratorExecutor:
    """Executor for RAG-augmented content generation with brand DNA context."""

    def __init__(self, log_callback: Callable[[str, str, str], None]):
        """
        Initialize the RAG generator executor.

        Args:
            log_callback: Function to call with (stage, level, message) for logging
        """
        self.log = log_callback
        self.brand_linter_path = TOOL_PATHS["brand_linter"]
        self.temp_gen_path = TOOL_PATHS["temp_gen"]
        self.brand_linter_python = TOOL_VENVS["brand_linter"]
        self.temp_gen_python = TOOL_VENVS["temp_gen"]

    def query_brand_dna(
        self, client_id: str, query_text: str, top_k: int = 5
    ) -> dict:
        """
        Query Pinecone for brand DNA context using the multimodal retriever.

        Args:
            client_id: Client identifier (used to derive namespace)
            query_text: Text query for semantic search
            top_k: Number of results to return

        Returns:
            dict with brand context and top matches
        """
        self.log("rag", "info", f"Querying brand DNA for context: {query_text[:50]}...")

        # Get the pinecone namespace from client_id
        # Format: client_jenni_kayne -> jenni_kayne
        namespace = client_id.replace("client_", "")

        script = self.brand_linter_path / "tools" / "multimodal_retriever.py"

        if not script.exists():
            self.log("rag", "warn", "Multimodal retriever not found, skipping context injection")
            return {"context": "", "matches": []}

        try:
            # Run the retriever with text-only query
            cmd = [
                str(self.brand_linter_python),
                str(script),
                "--text-query",
                query_text,
                "--namespace",
                namespace,
                "--top-k",
                str(top_k),
                "--json",
            ]

            result = subprocess.run(
                cmd,
                cwd=str(self.brand_linter_path),
                capture_output=True,
                text=True,
                timeout=60,
            )

            if result.returncode != 0:
                self.log("rag", "warn", f"Brand DNA query failed: {result.stderr}")
                return {"context": "", "matches": []}

            # Parse JSON output
            try:
                data = json.loads(result.stdout)
                matches = data.get("top_matches", [])

                # Build context string from top matches
                context_parts = []
                for match in matches[:top_k]:
                    if "metadata" in match:
                        meta = match["metadata"]
                        if "description" in meta:
                            context_parts.append(meta["description"])
                        if "tags" in meta:
                            context_parts.append(f"Tags: {', '.join(meta['tags'])}")

                context = ". ".join(context_parts)
                self.log("rag", "info", f"Retrieved {len(matches)} brand DNA matches")

                return {"context": context, "matches": matches}

            except json.JSONDecodeError:
                self.log("rag", "warn", "Failed to parse brand DNA response")
                return {"context": "", "matches": []}

        except subprocess.TimeoutExpired:
            self.log("rag", "warn", "Brand DNA query timed out")
            return {"context": "", "matches": []}
        except Exception as e:
            self.log("rag", "warn", f"Brand DNA query error: {str(e)}")
            return {"context": "", "matches": []}

    def augment_prompt(self, original_prompt: str, brand_context: str) -> str:
        """
        Augment the user prompt with brand DNA context.

        Args:
            original_prompt: The user's original creative prompt
            brand_context: Brand DNA context from Pinecone retrieval

        Returns:
            Augmented prompt with brand context
        """
        if not brand_context:
            return original_prompt

        augmented = f"""{original_prompt}

Brand Context: {brand_context}

Style Guidelines: Maintain visual consistency with the brand's established aesthetic.
Use the brand context above to inform color palette, composition, and mood."""

        return augmented

    def improve_prompt_on_failure(
        self, original_prompt: str, grade_result: dict, attempt: int
    ) -> str:
        """
        Analyze grade failure and suggest prompt improvements.

        Args:
            original_prompt: The prompt that failed
            grade_result: The grading results with scores
            attempt: Current attempt number

        Returns:
            Improved prompt with adjustments
        """
        fusion = grade_result.get("fusion", {})
        clip_score = fusion.get("clip_raw_score", 0)
        e5_score = fusion.get("e5_score", 0)
        cohere_score = fusion.get("cohere_score", 0)

        improvements = []

        # Analyze which scores are lowest
        if clip_score < 0.6:
            improvements.append(
                "Adjust visual elements: ensure cleaner composition, "
                "more balanced lighting, and tighter framing"
            )

        if e5_score < 0.6:
            improvements.append(
                "Refine semantic alignment: use more specific descriptors "
                "that match the brand's language and tone"
            )

        if cohere_score < 0.6:
            improvements.append(
                "Improve multimodal coherence: ensure text and visual elements "
                "work together harmoniously, maintain consistent styling"
            )

        if not improvements:
            improvements.append(
                "General refinement: increase brand consistency, "
                "adjust color palette to match brand guidelines"
            )

        feedback = " ".join(improvements)

        improved_prompt = f"""{original_prompt}

[Attempt {attempt + 1} Adjustments]
{feedback}

Focus on brand consistency and visual coherence."""

        return improved_prompt

    def grade_output(
        self, client_id: str, image_path: str, text_query: str
    ) -> dict:
        """
        Grade the generated output against brand DNA.

        Args:
            client_id: Client identifier
            image_path: Path to the generated image
            text_query: The original text query

        Returns:
            dict with grade decision and scores
        """
        self.log("grading", "info", f"Grading output: {image_path}")

        namespace = client_id.replace("client_", "")
        script = self.brand_linter_path / "tools" / "multimodal_retriever.py"

        if not script.exists():
            self.log("grading", "warn", "Grading script not found")
            return {"status": "skipped", "decision": "HITL_REVIEW"}

        try:
            cmd = [
                str(self.brand_linter_python),
                str(script),
                image_path,
                text_query,
                "--namespace",
                namespace,
                "--json",
            ]

            result = subprocess.run(
                cmd,
                cwd=str(self.brand_linter_path),
                capture_output=True,
                text=True,
                timeout=120,
            )

            if result.returncode != 0:
                self.log("grading", "error", f"Grading failed: {result.stderr}")
                return {"status": "failed", "decision": "HITL_REVIEW"}

            try:
                grade_result = json.loads(result.stdout)
                fusion = grade_result.get("fusion", {})
                decision = fusion.get("gate_decision", "HITL_REVIEW")
                combined_z = fusion.get("combined_z", 0.0)
                clip_raw = fusion.get("clip_raw_score", 0.0)

                self.log("grading", "info", f"Decision: {decision}")
                self.log("grading", "info", f"Fused Z: {combined_z:.4f}, CLIP: {clip_raw:.4f}")

                return {
                    "status": "completed",
                    "decision": decision,
                    "scores": {
                        "fused": combined_z,
                        "clip": clip_raw,
                        "e5": fusion.get("e5_score", 0.0),
                        "cohere": fusion.get("cohere_score", 0.0),
                    },
                    "raw": grade_result,
                }

            except json.JSONDecodeError:
                self.log("grading", "error", "Failed to parse grading output")
                return {"status": "failed", "decision": "HITL_REVIEW"}

        except subprocess.TimeoutExpired:
            self.log("grading", "error", "Grading timed out")
            return {"status": "failed", "decision": "HITL_REVIEW"}
        except Exception as e:
            self.log("grading", "error", f"Grading error: {str(e)}")
            return {"status": "failed", "decision": "HITL_REVIEW"}

    def generate_image(
        self, run_id: str, client_id: str, prompt: str, output_name: Optional[str] = None
    ) -> dict:
        """
        Generate an image using the augmented prompt.

        Args:
            run_id: The run ID
            client_id: The client ID
            prompt: The augmented prompt
            output_name: Optional output filename

        Returns:
            dict with status and artifact path
        """
        self.log("creative", "info", f"Generating image: {prompt[:60]}...")

        timestamp = int(time.time())
        output_name = output_name or f"rag_gen_{client_id}_{timestamp}.png"
        output_path = OUTPUT_BASE / client_id / "images" / output_name
        output_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            cmd = [
                str(self.temp_gen_python),
                "main.py",
                "nano",
                "generate",
                "--prompt",
                prompt,
                "--output",
                str(output_path),
            ]

            self.log("creative", "info", "Running Gemini generation...")

            result = subprocess.run(
                cmd,
                cwd=str(self.temp_gen_path),
                capture_output=True,
                text=True,
                timeout=180,
            )

            for line in result.stdout.strip().split("\n"):
                if line.strip():
                    self.log("creative", "info", line.strip())

            if result.returncode != 0:
                self.log("creative", "error", f"Generation failed: {result.stderr}")
                return {"status": "failed", "error": result.stderr}

            self.log("creative", "info", f"Image generated: {output_path}")

            return {
                "status": "completed",
                "path": str(output_path),
                "name": output_name,
            }

        except subprocess.TimeoutExpired:
            self.log("creative", "error", "Generation timed out")
            return {"status": "failed", "error": "Timeout"}
        except Exception as e:
            self.log("creative", "error", f"Generation error: {str(e)}")
            return {"status": "failed", "error": str(e)}

    def execute(
        self,
        run_id: str,
        client_id: str,
        prompt: str,
        params: Optional[dict] = None,
    ) -> dict:
        """
        Execute RAG-augmented generation with auto-fix loop.

        Args:
            run_id: The run ID
            client_id: The client ID
            prompt: The user's creative prompt
            params: Optional parameters

        Returns:
            dict with status, artifacts, and grade info
        """
        params = params or {}
        max_attempts = params.get("max_attempts", MAX_ATTEMPTS)

        self.log("rag", "info", f"Starting RAG generation for client {client_id}")
        self.log("rag", "info", f"Original prompt: {prompt[:100]}...")

        # Step 1: Query brand DNA for context
        brand_data = self.query_brand_dna(client_id, prompt)
        brand_context = brand_data.get("context", "")

        # Step 2: Augment prompt with brand context
        augmented_prompt = self.augment_prompt(prompt, brand_context)
        self.log("rag", "info", "Prompt augmented with brand context")

        current_prompt = augmented_prompt
        artifacts = []
        final_grade = None

        for attempt in range(max_attempts):
            self.log("rag", "info", f"Generation attempt {attempt + 1}/{max_attempts}")

            # Step 3: Generate image
            gen_result = self.generate_image(run_id, client_id, current_prompt)

            if gen_result["status"] == "failed":
                self.log("rag", "error", f"Generation failed: {gen_result.get('error')}")
                if attempt < max_attempts - 1:
                    self.log("rag", "info", "Retrying with adjusted prompt...")
                    current_prompt = self.improve_prompt_on_failure(
                        current_prompt, {}, attempt
                    )
                    continue
                else:
                    return {
                        "status": "failed",
                        "error": gen_result.get("error"),
                        "artifacts": artifacts,
                    }

            image_path = gen_result["path"]

            # Step 4: Grade the output
            grade_result = self.grade_output(client_id, image_path, prompt)
            decision = grade_result.get("decision", "HITL_REVIEW")
            scores = grade_result.get("scores", {})

            artifact = {
                "type": "image",
                "name": gen_result["name"],
                "path": image_path,
                "grade": {
                    "decision": decision,
                    "clip": scores.get("clip", 0),
                    "e5": scores.get("e5", 0),
                    "cohere": scores.get("cohere", 0),
                    "fused": scores.get("fused", 0),
                },
            }
            artifacts.append(artifact)
            final_grade = grade_result

            # Step 5: Check if we should regenerate
            if decision == "AUTO_PASS":
                self.log("rag", "info", "Image PASSED brand compliance check")
                return {
                    "status": "completed",
                    "hitl_required": False,
                    "grade_decision": decision,
                    "artifacts": artifacts,
                }

            if decision == "AUTO_FAIL" and attempt < max_attempts - 1:
                self.log("rag", "warn", "Image FAILED, regenerating with improved prompt...")
                current_prompt = self.improve_prompt_on_failure(
                    current_prompt, grade_result.get("raw", {}), attempt
                )
                continue

            # HITL_REVIEW or final AUTO_FAIL
            break

        # Determine final status
        decision = final_grade.get("decision", "HITL_REVIEW") if final_grade else "HITL_REVIEW"

        if decision == "AUTO_FAIL":
            self.log("rag", "warn", "Image FAILED after all attempts")
            return {
                "status": "failed",
                "hitl_required": False,
                "grade_decision": decision,
                "artifacts": artifacts,
            }
        else:
            self.log("rag", "info", "Image requires human review")
            return {
                "status": "needs_review",
                "hitl_required": True,
                "grade_decision": decision,
                "artifacts": artifacts,
            }
