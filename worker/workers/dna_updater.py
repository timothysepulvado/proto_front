"""
DNA Updater Worker

Updates long-term Brand DNA with approved outputs.
Manages Pinecone index ingestion and brand profile updates.

NAMING CONTRACT:
- AI writes go to Campaign indexes only (never Core)
- Score variables use _raw (0.0-1.0) or _z (unbounded) suffixes
- See index_guard.py for full naming rules
"""

import os
import subprocess
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional, Any

from supabase import Client

# Import index_guard for naming contract enforcement
from index_guard import (
    get_brand_slug,
    get_campaign_index,
    get_all_indexes,
    assert_ai_write_index,
    brand_id_from_client_id,
    VALID_MODELS,
)


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

        SAFETY: Writes only to Campaign indexes (never Core).
        Uses index_guard to enforce naming contract.

        Args:
            approved_items: List of approved deliverable dicts
            brand_id: Brand/client ID
        """
        self.log("dna", "info", f"Updating DNA with {len(approved_items)} approved items")

        # Extract brand_id from client_id format if necessary
        actual_brand_id = brand_id_from_client_id(brand_id)

        # Get Campaign indexes for AI writes (index_guard enforces correct naming)
        campaign_indexes = get_all_indexes(actual_brand_id, "campaign")

        # Assert all indexes are valid for AI writes (safety check)
        for model, index_name in campaign_indexes.items():
            assert_ai_write_index(index_name)
            self.log("dna", "debug", f"Validated AI write target: {index_name}")

        # Get brand_slug for namespace
        brand_slug = get_brand_slug(actual_brand_id)

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
                # Ingest to Campaign Pinecone indexes
                await self._ingest_to_pinecone(
                    image_path, brand_slug, actual_brand_id, campaign_indexes
                )

        # Update brand profile stats
        await self._recompute_brand_stats(actual_brand_id)

        self.log("dna", "info", "DNA update complete")

    async def _ingest_to_pinecone(
        self,
        image_path: str,
        brand_slug: str,
        brand_id: str,
        campaign_indexes: Dict[str, str]
    ):
        """
        Ingest image to Campaign Pinecone indexes.

        SAFETY: Only writes to Campaign indexes (validated by caller).

        Adds embeddings to Campaign indexes for:
        - CLIP index (visual features)
        - E5 index (semantic features)
        - Cohere index (multimodal features)

        Args:
            image_path: Path to the image to ingest
            brand_slug: URL-safe brand slug for namespace
            brand_id: Human-readable brand identifier
            campaign_indexes: Dict mapping model to Campaign index name
        """
        self.log("dna", "info", f"Ingesting to Campaign indexes: {os.path.basename(image_path)}")

        # Log which indexes we're writing to
        for model, index_name in campaign_indexes.items():
            self.log("dna", "debug", f"Target {model} index: {index_name}")

        # Call the ingestion script (in tools subdirectory)
        script_path = os.path.join(self.brand_linter_path, "tools", "ingest_to_pinecone.py")

        if not os.path.exists(script_path):
            self.log("dna", "warn", f"Ingestion script not found: {script_path}")
            return

        # Pass brand_id and Campaign index names for proper indexing
        # Note: namespace defaults to __default__ (Pinecone API 2025-04+)
        cmd = [
            "python3", script_path,
            "--image", image_path,
            "--brand", brand_id,
            "--index-clip", campaign_indexes["clip"],
            "--index-e5", campaign_indexes["e5"],
            "--index-cohere", campaign_indexes["cohere"],
            "--json"
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
                self.log("dna", "info", f"Ingested to Campaign: {os.path.basename(image_path)}")
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
        - Average scores (using _raw suffix for raw scores, _z for z-scores)
        - Last update timestamp
        - Drift monitoring baseline
        """
        self.log("dna", "info", "Recomputing brand stats")

        # Get client_id from brand_id for database queries
        client_id = f"client_{brand_id}" if not brand_id.startswith("client_") else brand_id

        # Get all approved artifacts for this brand
        runs_result = self.supabase.table("runs").select("id").eq(
            "client_id", client_id
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
        # - Raw scores (0-1 scale): clip_raw, e5_raw, cohere_raw
        # - Z-scores (unbounded): fused_z
        total_count = len(artifacts)
        graded_artifacts = [a for a in artifacts if a.get("grade")]

        avg_scores = {
            "clip_raw": 0.0,
            "e5_raw": 0.0,
            "cohere_raw": 0.0,
            "fused_z": 0.0
        }

        if graded_artifacts:
            for artifact in graded_artifacts:
                grade = artifact.get("grade", {})
                # Support both old and new key names for backward compatibility
                avg_scores["clip_raw"] += grade.get("clip_raw", grade.get("clip", 0.0))
                avg_scores["e5_raw"] += grade.get("e5_raw", grade.get("e5", 0.0))
                avg_scores["cohere_raw"] += grade.get("cohere_raw", grade.get("cohere", 0.0))
                # fused_z is the canonical field; fallback to fused_raw for backward compat
                avg_scores["fused_z"] += grade.get("fused_z", grade.get("fused_raw", grade.get("fused", 0.0)))

            count = len(graded_artifacts)
            for key in avg_scores:
                avg_scores[key] /= count

        # Update client with stats (stored in a metadata field if available)
        # For now, log the stats
        self.log("dna", "info",
                f"Brand stats: {total_count} artifacts, "
                f"avg fused_z score: {avg_scores['fused_z']:.3f}")

        # Update per-brand profile file
        await self._update_brand_profile(brand_id, total_count, avg_scores)

    async def _update_brand_profile(
        self,
        brand_id: str,
        total_count: int,
        avg_scores: Dict[str, float]
    ):
        """
        Update per-brand profile file with latest stats.

        This function performs a merge-update: it reads the existing profile,
        updates only the stats fields, and writes back the merged result.
        This preserves pillars, tone, weights, and other brand configuration.

        Args:
            brand_id: Human-readable brand identifier
            total_count: Total number of artifacts
            avg_scores: Average scores dict (clip_raw, e5_raw, cohere_raw, fused_z)
        """
        import json

        # Per-brand profile path (new structure)
        profiles_dir = os.path.join(self.brand_linter_path, "data", "brand_profiles")
        profile_path = os.path.join(profiles_dir, f"{brand_id}.json")

        try:
            # Ensure directory exists
            os.makedirs(profiles_dir, exist_ok=True)

            # Read existing profile (merge-update, don't overwrite)
            profile = {}
            if os.path.exists(profile_path):
                with open(profile_path, 'r') as f:
                    profile = json.load(f)

            # Merge-update: only update stats fields, preserve everything else
            # Update runtime stats
            profile["total_artifacts"] = total_count
            profile["avg_scores"] = avg_scores
            profile["last_updated"] = datetime.now(timezone.utc).isoformat()

            # Drift baseline uses fused_z (z-score, unbounded)
            profile["drift_baseline_z"] = avg_scores.get("fused_z", 0.0)

            # Ensure brand_id is set
            if "brand_id" not in profile:
                profile["brand_id"] = brand_id

            # Write back merged profile
            with open(profile_path, 'w') as f:
                json.dump(profile, f, indent=2)

            self.log("dna", "info", f"Updated per-brand profile: {profile_path}")

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
            brand_id: Brand/client ID (or client_id format)
            current_scores: Current generation scores (fused_z is the key metric)

        Returns:
            Dict with drift analysis
        """
        import json

        # Extract brand_id from client_id format if necessary
        actual_brand_id = brand_id_from_client_id(brand_id)

        # Per-brand profile path (new structure)
        profile_path = os.path.join(
            self.brand_linter_path,
            "data",
            "brand_profiles",
            f"{actual_brand_id}.json"
        )

        # Fallback to legacy path if per-brand file doesn't exist
        if not os.path.exists(profile_path):
            legacy_path = os.path.join(
                self.brand_linter_path,
                "data",
                "brand_profiles.json"
            )
            if os.path.exists(legacy_path):
                profile_path = legacy_path
            else:
                return {"drift_detected": False, "reason": "no_baseline"}

        try:
            with open(profile_path, 'r') as f:
                profile = json.load(f)

            # Legacy format: dict keyed by brand_id
            if actual_brand_id in profile:
                profile = profile[actual_brand_id]

            if not profile:
                return {"drift_detected": False, "reason": "no_brand_profile"}

            # Support both old and new key names for backward compatibility
            # Priority: drift_baseline_z > drift_baseline_raw > drift_baseline
            baseline_z = profile.get(
                "drift_baseline_z",
                profile.get("drift_baseline_raw", profile.get("drift_baseline", 0.0))
            )

            # Current score: fused_z is canonical; fallback to fused_raw/fused
            current_z = current_scores.get(
                "fused_z",
                current_scores.get("fused_raw", current_scores.get("fused", 0.0))
            )

            # Calculate drift in z-space
            # For z-scores, 0.5 standard deviation below baseline is significant
            drift_threshold_z = 0.5
            drift = baseline_z - current_z

            if drift > drift_threshold_z:
                return {
                    "drift_detected": True,
                    "baseline_z": baseline_z,
                    "current_z": current_z,
                    "drift_amount": drift,
                    "reason": "score_degradation"
                }

            return {
                "drift_detected": False,
                "baseline_z": baseline_z,
                "current_z": current_z,
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

        SAFETY: Only removes from Campaign indexes (never Core).

        Args:
            artifact_id: UUID of artifact to remove
            brand_id: Brand/client ID (or client_id format)
        """
        self.log("dna", "info", f"Removing from DNA: {artifact_id}")

        # Extract brand_id from client_id format if necessary
        actual_brand_id = brand_id_from_client_id(brand_id)

        # Get Campaign indexes (only Campaign can be modified by AI)
        campaign_indexes = get_all_indexes(actual_brand_id, "campaign")
        for model, index_name in campaign_indexes.items():
            assert_ai_write_index(index_name)

        # Get artifact path
        artifact_result = self.supabase.table("artifacts").select("path").eq(
            "id", artifact_id
        ).single().execute()

        if not artifact_result.data:
            return

        # In a full implementation, this would remove the embedding from Campaign indexes
        # For now, we log the action
        self.log("dna", "info", f"Marked for removal from Campaign indexes: {artifact_result.data.get('path')}")
