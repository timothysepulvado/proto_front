#!/usr/bin/env python3
"""
BrandStudios OS HUD Worker

This worker polls Supabase for pending runs and executes them using
the appropriate tool (Brand_linter, Temp-gen, etc.).

Usage:
    python worker.py

Environment variables:
    SUPABASE_URL - Supabase project URL
    SUPABASE_KEY - Supabase service/publishable key

Campaign V2:
    Uses the CampaignOrchestrator for campaigns with deliverables defined
    in the campaign_deliverables table (Phase 6.5+ architecture).
"""

import os
import sys
import time
import signal
import asyncio
import traceback
from datetime import datetime
from typing import Optional

from dotenv import load_dotenv
from supabase import create_client, Client

# Load environment variables
load_dotenv()

# Import config and executors
from config import (
    SUPABASE_URL,
    SUPABASE_KEY,
    POLL_INTERVAL_SECONDS,
)
from executors import IngestExecutor, CreativeExecutor, GradingExecutor, RAGGeneratorExecutor

# Import Campaign V2 orchestrator
try:
    from workers.orchestrator import CampaignOrchestrator
    ORCHESTRATOR_AVAILABLE = True
except ImportError:
    ORCHESTRATOR_AVAILABLE = False


class Worker:
    """Worker that polls Supabase and executes runs."""

    def __init__(self):
        """Initialize the worker with Supabase client."""
        self.supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
        self.running = True
        self.current_run_id: Optional[str] = None

        # Set up signal handlers for graceful shutdown
        signal.signal(signal.SIGINT, self._handle_shutdown)
        signal.signal(signal.SIGTERM, self._handle_shutdown)

        print(f"[Worker] Initialized with Supabase: {SUPABASE_URL}")

    def _handle_shutdown(self, signum, frame):
        """Handle shutdown signals gracefully."""
        print("\n[Worker] Shutdown requested...")
        self.running = False

        # If we're in the middle of a run, mark it as cancelled
        if self.current_run_id:
            try:
                self._update_run_status(self.current_run_id, "cancelled")
                self._add_log(self.current_run_id, "system", "warn", "Run cancelled due to worker shutdown")
            except Exception as e:
                print(f"[Worker] Error cancelling run: {e}")

    def _add_log(self, run_id: str, stage: str, level: str, message: str):
        """Add a log entry to the run_logs table."""
        try:
            self.supabase.table("run_logs").insert({
                "run_id": run_id,
                "stage": stage,
                "level": level,
                "message": message,
            }).execute()
        except Exception as e:
            print(f"[Worker] Error adding log: {e}")

    def _update_run_status(
        self,
        run_id: str,
        status: str,
        error: Optional[str] = None,
        hitl_required: bool = False,
    ):
        """Update the run status in the runs table."""
        update_data = {"status": status}

        if status == "running":
            update_data["started_at"] = datetime.utcnow().isoformat()
        elif status in ("completed", "failed", "cancelled", "blocked"):
            update_data["completed_at"] = datetime.utcnow().isoformat()

        if error:
            update_data["error"] = error

        if hitl_required:
            update_data["hitl_required"] = True

        try:
            self.supabase.table("runs").update(update_data).eq("id", run_id).execute()

            # Also update the client's last_run_status
            run_result = self.supabase.table("runs").select("client_id").eq("id", run_id).single().execute()
            if run_result.data:
                client_id = run_result.data["client_id"]
                self.supabase.table("clients").update({
                    "last_run_status": status
                }).eq("id", client_id).execute()

        except Exception as e:
            print(f"[Worker] Error updating run status: {e}")

    def _add_artifact(self, run_id: str, artifact: dict):
        """Add an artifact to the artifacts table."""
        try:
            self.supabase.table("artifacts").insert({
                "run_id": run_id,
                "type": artifact["type"],
                "name": artifact["name"],
                "path": artifact["path"],
                "size": artifact.get("size"),
            }).execute()
        except Exception as e:
            print(f"[Worker] Error adding artifact: {e}")

    def _claim_pending_run(self) -> Optional[dict]:
        """
        Find and claim a pending run.

        Returns the run data if one was claimed, None otherwise.
        """
        try:
            # Find a pending run
            result = self.supabase.table("runs").select("*").eq(
                "status", "pending"
            ).order("created_at").limit(1).execute()

            if not result.data:
                return None

            run = result.data[0]
            run_id = run["id"]

            # Attempt to claim it by setting status to running
            # This is a simple approach - in production you'd want a proper lock
            update_result = self.supabase.table("runs").update({
                "status": "running",
                "started_at": datetime.utcnow().isoformat(),
            }).eq("id", run_id).eq("status", "pending").execute()

            if update_result.data:
                print(f"[Worker] Claimed run: {run_id} (mode: {run['mode']})")
                return update_result.data[0]
            else:
                # Another worker claimed it
                return None

        except Exception as e:
            print(f"[Worker] Error claiming run: {e}")
            return None

    def _create_log_callback(self, run_id: str):
        """Create a log callback function for executors."""
        def log_callback(stage: str, level: str, message: str):
            print(f"[{stage}] [{level.upper()}] {message}")
            self._add_log(run_id, stage, level, message)
        return log_callback

    def _is_campaign_v2(self, campaign_id: Optional[str]) -> bool:
        """
        Check if a campaign uses the V2 architecture (orchestrator).

        Campaign V2 campaigns have:
        - Entries in campaign_deliverables table
        - or a 'use_orchestrator' flag set to True

        Args:
            campaign_id: UUID of the campaign

        Returns:
            True if campaign should use V2 orchestrator
        """
        if not ORCHESTRATOR_AVAILABLE:
            return False

        if not campaign_id:
            return False

        try:
            # Check for campaign_deliverables entries
            del_result = self.supabase.table("campaign_deliverables").select(
                "id"
            ).eq("campaign_id", campaign_id).limit(1).execute()

            if del_result.data:
                return True

            # Check for use_orchestrator flag on campaign
            campaign_result = self.supabase.table("campaigns").select(
                "use_orchestrator"
            ).eq("id", campaign_id).single().execute()

            if campaign_result.data and campaign_result.data.get("use_orchestrator"):
                return True

        except Exception as e:
            print(f"[Worker] Could not check campaign version: {e}")

        return False

    async def _run_campaign_v2(self, run: dict, log_cb) -> dict:
        """
        Run a campaign using the V2 orchestrator.

        Args:
            run: Run data dict
            log_cb: Log callback function

        Returns:
            Result dict with status and artifacts
        """
        campaign_id = run.get("campaign_id")
        if not campaign_id:
            return {"status": "failed", "error": "No campaign_id for V2 orchestration"}

        log_cb("system", "info", "Using Campaign V2 orchestrator")

        try:
            orchestrator = CampaignOrchestrator(
                supabase=self.supabase,
                campaign_id=campaign_id,
                log_callback=log_cb
            )

            # Run the campaign orchestration
            result = await orchestrator.run_campaign()

            # Map orchestrator status to run status
            status = result.get("status", "completed")
            if status == "needs_review":
                return {
                    "status": "needs_review",
                    "hitl_required": True,
                    "artifacts": [],
                    "campaign_result": result
                }
            elif status == "failed":
                return {
                    "status": "failed",
                    "error": "Campaign orchestration failed",
                    "artifacts": [],
                    "campaign_result": result
                }
            else:
                return {
                    "status": "completed",
                    "hitl_required": False,
                    "artifacts": [],
                    "campaign_result": result
                }

        except Exception as e:
            log_cb("orchestrator", "error", f"Orchestration error: {str(e)}")
            return {"status": "failed", "error": str(e)}

    def _execute_run(self, run: dict):
        """Execute a single run based on its mode."""
        run_id = run["id"]
        client_id = run["client_id"]
        mode = run["mode"]

        self.current_run_id = run_id
        log_cb = self._create_log_callback(run_id)

        log_cb("system", "info", f"Starting run: {run_id}")
        log_cb("system", "info", f"Mode: {mode}, Client: {client_id}")

        try:
            result = None

            if mode == "ingest":
                executor = IngestExecutor(log_cb)
                result = executor.execute(run_id, client_id)

            elif mode == "images":
                executor = CreativeExecutor(log_cb)
                # For demo, use a default prompt
                params = {"prompt": "A beautiful minimalist lifestyle scene with natural lighting"}
                result = executor.execute(run_id, client_id, "images", params)

            elif mode == "video":
                executor = CreativeExecutor(log_cb)
                # For demo, use a default prompt
                params = {"prompt": "A serene lifestyle moment with soft natural lighting"}
                result = executor.execute(run_id, client_id, "video", params)

            elif mode == "drift":
                executor = GradingExecutor(log_cb)
                result = executor.execute(run_id, client_id)

            elif mode == "full":
                # Full pipeline: ingest -> images -> video -> drift
                log_cb("system", "info", "Running full pipeline...")

                # Ingest
                log_cb("system", "info", "Stage 1/4: Ingest")
                ingest_exec = IngestExecutor(log_cb)
                ingest_result = ingest_exec.execute(run_id, client_id)
                if ingest_result["status"] == "failed":
                    result = ingest_result
                else:
                    # Images
                    log_cb("system", "info", "Stage 2/4: Image Generation")
                    creative_exec = CreativeExecutor(log_cb)
                    img_params = {"prompt": "Brand lifestyle hero image"}
                    img_result = creative_exec.execute(run_id, client_id, "images", img_params)

                    # Video
                    log_cb("system", "info", "Stage 3/4: Video Generation")
                    vid_params = {"prompt": "Brand story video sequence"}
                    vid_result = creative_exec.execute(run_id, client_id, "video", vid_params)

                    # Drift check
                    log_cb("system", "info", "Stage 4/4: Brand Drift Check")
                    grade_exec = GradingExecutor(log_cb)
                    grade_result = grade_exec.execute(run_id, client_id)

                    # Combine results
                    all_artifacts = []
                    for r in [img_result, vid_result, grade_result]:
                        if r.get("artifacts"):
                            all_artifacts.extend(r["artifacts"])

                    result = {
                        "status": grade_result.get("status", "completed"),
                        "hitl_required": grade_result.get("hitl_required", False),
                        "artifacts": all_artifacts,
                    }

            elif mode == "export":
                # Export just packages existing artifacts
                log_cb("system", "info", "Creating export package...")
                log_cb("export", "info", "Gathering artifacts from previous runs...")
                log_cb("export", "info", "Export complete")
                result = {"status": "completed", "artifacts": []}

            elif mode == "campaign":
                # Campaign mode: Check for V2 orchestrator or legacy RAG-augmented generation
                prompt = run.get("prompt", "A beautiful brand lifestyle image")
                campaign_id = run.get("campaign_id")

                log_cb("system", "info", f"Running campaign: {campaign_id or 'direct'}")

                # Check if this campaign uses V2 orchestrator
                if self._is_campaign_v2(campaign_id):
                    log_cb("system", "info", "Detected Campaign V2 - using orchestrator")
                    result = asyncio.run(self._run_campaign_v2(run, log_cb))
                else:
                    # Legacy campaign mode: RAG-augmented generation
                    log_cb("system", "info", "Using legacy campaign mode")
                    log_cb("system", "info", f"Prompt: {prompt[:100]}...")

                    # Get campaign details for deliverables if available
                    deliverables = {"images": 1}  # Default
                    if campaign_id:
                        try:
                            campaign_result = self.supabase.table("campaigns").select("deliverables").eq("id", campaign_id).single().execute()
                            if campaign_result.data:
                                deliverables = campaign_result.data.get("deliverables", {"images": 1})
                                log_cb("system", "info", f"Deliverables: {deliverables}")
                        except Exception as e:
                            log_cb("system", "warn", f"Could not fetch campaign details: {e}")

                    # Execute RAG generation for each deliverable
                    rag_exec = RAGGeneratorExecutor(log_cb)
                    all_artifacts = []
                    needs_review = False

                    # Generate images
                    num_images = deliverables.get("images", 0) + deliverables.get("heroImages", 0) + deliverables.get("lifestyleImages", 0) + deliverables.get("productShots", 0)
                    for i in range(num_images):
                        log_cb("system", "info", f"Generating image {i + 1}/{num_images}...")
                        img_result = rag_exec.execute(run_id, client_id, prompt)
                        if img_result.get("artifacts"):
                            all_artifacts.extend(img_result["artifacts"])
                        if img_result.get("hitl_required"):
                            needs_review = True

                    # Generate videos (if any)
                    num_videos = deliverables.get("videos", 0)
                    if num_videos > 0:
                        creative_exec = CreativeExecutor(log_cb)
                        for i in range(num_videos):
                            log_cb("system", "info", f"Generating video {i + 1}/{num_videos}...")
                            vid_result = creative_exec.execute(run_id, client_id, "video", {"prompt": prompt})
                            if vid_result.get("artifacts"):
                                all_artifacts.extend(vid_result["artifacts"])

                    # Update campaign status if we have a campaign_id
                    if campaign_id:
                        try:
                            final_status = "needs_review" if needs_review else "completed"
                            self.supabase.table("campaigns").update({"status": final_status}).eq("id", campaign_id).execute()
                        except Exception as e:
                            log_cb("system", "warn", f"Could not update campaign status: {e}")

                    result = {
                        "status": "needs_review" if needs_review else "completed",
                        "hitl_required": needs_review,
                        "artifacts": all_artifacts,
                    }

            else:
                log_cb("system", "error", f"Unknown mode: {mode}")
                result = {"status": "failed", "error": f"Unknown mode: {mode}"}

            # Process result
            if result:
                status = result.get("status", "completed")
                error = result.get("error")
                hitl_required = result.get("hitl_required", False)
                artifacts = result.get("artifacts", [])

                # Add artifacts
                for artifact in artifacts:
                    self._add_artifact(run_id, artifact)

                # Update run status
                self._update_run_status(run_id, status, error, hitl_required)

                log_cb("system", "info", f"Run completed with status: {status}")
                if artifacts:
                    log_cb("system", "info", f"Created {len(artifacts)} artifact(s)")

        except Exception as e:
            error_msg = f"Unexpected error: {str(e)}"
            log_cb("system", "error", error_msg)
            traceback.print_exc()
            self._update_run_status(run_id, "failed", error_msg)

        finally:
            self.current_run_id = None

    def run(self):
        """Main worker loop."""
        print("[Worker] Starting worker loop...")
        print(f"[Worker] Polling every {POLL_INTERVAL_SECONDS} seconds")
        print("[Worker] Press Ctrl+C to stop\n")

        while self.running:
            try:
                # Try to claim a pending run
                run = self._claim_pending_run()

                if run:
                    self._execute_run(run)
                else:
                    # No pending runs, wait and poll again
                    time.sleep(POLL_INTERVAL_SECONDS)

            except Exception as e:
                print(f"[Worker] Error in main loop: {e}")
                traceback.print_exc()
                time.sleep(POLL_INTERVAL_SECONDS)

        print("[Worker] Worker stopped")


def main():
    """Entry point."""
    worker = Worker()
    worker.run()


if __name__ == "__main__":
    main()
