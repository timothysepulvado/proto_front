"""
DNA Updater Worker

Updates long-term Brand DNA with approved outputs.
Manages Pinecone index ingestion and brand profile updates.
"""

import os
import subprocess
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional, Any

from supabase import Client


class DNAUpdater:
    """
    Updates Brand DNA with approved outputs.

    Long-term memory components:
    - Pinecone indexes: CLIP, E5, Cohere embeddings
    - brand_profiles.json: Brand statistics and metadata
    """

    def __init__(
        self,
        supabase: Client,
        log_callback: Optional[Callable[[str, str, str], None]] = None
    ):
        """
        Initialize the DNA updater.

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

    async def add_to_dna(
        self,
        approved_items: List[Dict[str, Any]],
        brand_id: str
    ):
        """
        Add approved outputs to long-term brand memory.

        Args:
            approved_items: List of approved deliverable dicts
            brand_id: Brand/client ID
        """
        self.log("dna", "info", f"Updating DNA with {len(approved_items)} approved items")

        # Get brand namespace
        client_result = self.supabase.table("clients").select(
            "pinecone_namespace"
        ).eq("id", brand_id).single().execute()

        namespace = "default"
        if client_result.data:
            namespace = client_result.data.get("pinecone_namespace", "default")

        # Process each approved item
        for item in approved_items:
            artifact_id = item.get("artifact_id")
            if not artifact_id:
                continue

            # Get artifact details
            artifact_result = self.supabase.table("artifacts").select("*").eq(
                "id", artifact_id
            ).single().execute()

            if not artifact_result.data:
                continue

            artifact = artifact_result.data
            image_path = artifact.get("path")

            if image_path and os.path.exists(image_path):
                # Ingest to Pinecone indexes
                await self._ingest_to_pinecone(image_path, namespace, brand_id)

        # Update brand profile stats
        await self._recompute_brand_stats(brand_id)

        self.log("dna", "info", "DNA update complete")

    async def _ingest_to_pinecone(
        self,
        image_path: str,
        namespace: str,
        brand_id: str
    ):
        """
        Ingest image to Pinecone indexes.

        Adds embeddings to:
        - CLIP index (visual features)
        - E5 index (semantic features)
        - Cohere index (multimodal features)
        """
        self.log("dna", "info", f"Ingesting to Pinecone: {os.path.basename(image_path)}")

        # Call the ingestion script
        script_path = os.path.join(self.brand_linter_path, "ingest_to_pinecone.py")

        if not os.path.exists(script_path):
            # Fallback to check_pinecone_vectors.py
            script_path = os.path.join(self.brand_linter_path, "check_pinecone_vectors.py")

        cmd = [
            "python3", script_path,
            "--image", image_path,
            "--namespace", namespace,
            "--mode", "ingest"
        ]

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60,
                cwd=self.brand_linter_path
            )

            if result.returncode == 0:
                self.log("dna", "info", f"Ingested: {os.path.basename(image_path)}")
            else:
                self.log("dna", "warn", f"Ingestion returned: {result.returncode}")
                if result.stderr:
                    self.log("dna", "debug", result.stderr[:300])

        except subprocess.TimeoutExpired:
            self.log("dna", "error", "Ingestion timed out")
        except FileNotFoundError:
            self.log("dna", "warn", "Ingestion script not found")

    async def _recompute_brand_stats(self, brand_id: str):
        """
        Recompute brand profile statistics.

        Updates:
        - Total images count
        - Average scores
        - Last update timestamp
        - Drift monitoring baseline
        """
        self.log("dna", "info", "Recomputing brand stats")

        # Get all approved artifacts for this brand
        runs_result = self.supabase.table("runs").select("id").eq(
            "client_id", brand_id
        ).execute()

        if not runs_result.data:
            return

        run_ids = [r["id"] for r in runs_result.data]

        artifacts_result = self.supabase.table("artifacts").select(
            "id, grade"
        ).in_("run_id", run_ids).execute()

        if not artifacts_result.data:
            return

        artifacts = artifacts_result.data

        # Calculate statistics
        total_count = len(artifacts)
        graded_artifacts = [a for a in artifacts if a.get("grade")]

        avg_scores = {
            "clip": 0.0,
            "e5": 0.0,
            "cohere": 0.0,
            "fused": 0.0
        }

        if graded_artifacts:
            for artifact in graded_artifacts:
                grade = artifact.get("grade", {})
                avg_scores["clip"] += grade.get("clip", 0.0)
                avg_scores["e5"] += grade.get("e5", 0.0)
                avg_scores["cohere"] += grade.get("cohere", 0.0)
                avg_scores["fused"] += grade.get("fused", 0.0)

            count = len(graded_artifacts)
            for key in avg_scores:
                avg_scores[key] /= count

        # Update client with stats (stored in a metadata field if available)
        # For now, log the stats
        self.log("dna", "info",
                f"Brand stats: {total_count} artifacts, "
                f"avg fused score: {avg_scores['fused']:.3f}")

        # Update brand_profiles.json if it exists
        await self._update_brand_profile(brand_id, total_count, avg_scores)

    async def _update_brand_profile(
        self,
        brand_id: str,
        total_count: int,
        avg_scores: Dict[str, float]
    ):
        """
        Update brand_profiles.json with latest stats.
        """
        profile_path = os.path.join(
            self.brand_linter_path,
            "data",
            "brand_profiles.json"
        )

        try:
            import json

            # Read existing profiles
            profiles = {}
            if os.path.exists(profile_path):
                with open(profile_path, 'r') as f:
                    profiles = json.load(f)

            # Update profile for this brand
            profiles[brand_id] = {
                "total_artifacts": total_count,
                "avg_scores": avg_scores,
                "last_updated": datetime.now(timezone.utc).isoformat(),
                "drift_baseline": avg_scores.get("fused", 0.0)
            }

            # Write back
            with open(profile_path, 'w') as f:
                json.dump(profiles, f, indent=2)

            self.log("dna", "info", f"Updated brand profile: {brand_id}")

        except Exception as e:
            self.log("dna", "warn", f"Could not update brand profile: {str(e)}")

    async def check_drift(
        self,
        brand_id: str,
        current_scores: Dict[str, float]
    ) -> Dict[str, Any]:
        """
        Check for brand drift by comparing current scores to baseline.

        Args:
            brand_id: Brand/client ID
            current_scores: Current generation scores

        Returns:
            Dict with drift analysis
        """
        profile_path = os.path.join(
            self.brand_linter_path,
            "data",
            "brand_profiles.json"
        )

        try:
            import json

            if not os.path.exists(profile_path):
                return {"drift_detected": False, "reason": "no_baseline"}

            with open(profile_path, 'r') as f:
                profiles = json.load(f)

            profile = profiles.get(brand_id)
            if not profile:
                return {"drift_detected": False, "reason": "no_brand_profile"}

            baseline = profile.get("drift_baseline", 0.0)
            current = current_scores.get("fused", 0.0)

            # Calculate drift (significant if more than 10% below baseline)
            drift_threshold = 0.10
            drift = baseline - current

            if drift > drift_threshold:
                return {
                    "drift_detected": True,
                    "baseline": baseline,
                    "current": current,
                    "drift_amount": drift,
                    "reason": "score_degradation"
                }

            return {
                "drift_detected": False,
                "baseline": baseline,
                "current": current,
                "drift_amount": drift
            }

        except Exception as e:
            self.log("dna", "warn", f"Drift check error: {str(e)}")
            return {"drift_detected": False, "reason": "check_error"}

    async def remove_from_dna(
        self,
        artifact_id: str,
        brand_id: str
    ):
        """
        Remove an artifact from brand DNA (for rejected items).

        Args:
            artifact_id: UUID of artifact to remove
            brand_id: Brand/client ID
        """
        self.log("dna", "info", f"Removing from DNA: {artifact_id}")

        # Get artifact path
        artifact_result = self.supabase.table("artifacts").select("path").eq(
            "id", artifact_id
        ).single().execute()

        if not artifact_result.data:
            return

        # In a full implementation, this would remove the embedding from Pinecone
        # For now, we log the action
        self.log("dna", "info", f"Marked for removal: {artifact_result.data.get('path')}")
