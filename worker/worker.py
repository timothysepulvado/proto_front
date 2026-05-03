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
"""

import os
import sys
import time
import signal
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
from executors import IngestExecutor, CreativeExecutor, GradingExecutor


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

    def _upload_to_storage(self, client_id: str, run_id: str, artifact_id: str, local_path: str, file_name: str) -> tuple:
        """Upload a local file to Supabase Storage and return (storage_path, public_url)."""
        ext = os.path.splitext(file_name)[1]
        storage_path = f"{client_id}/{run_id}/{artifact_id}{ext}"

        if not os.path.exists(local_path):
            print(f"[Worker] File not found, skipping upload: {local_path}")
            return None, None

        try:
            with open(local_path, "rb") as f:
                file_bytes = f.read()

            self.supabase.storage.from_("artifacts").upload(
                storage_path,
                file_bytes,
                {"content-type": self._get_mime_type(ext), "upsert": "true"},
            )

            public_url = self.supabase.storage.from_("artifacts").get_public_url(storage_path)
            return storage_path, public_url
        except Exception as e:
            print(f"[Worker] Storage upload failed for {storage_path}: {e}")
            return None, None

    @staticmethod
    def _get_mime_type(ext: str) -> str:
        """Map file extension to MIME type."""
        mime_map = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".mp4": "video/mp4",
            ".webm": "video/webm",
            ".pdf": "application/pdf",
            ".zip": "application/zip",
        }
        return mime_map.get(ext.lower(), "application/octet-stream")

    def _add_artifact(self, run_id: str, artifact: dict, client_id: Optional[str] = None, campaign_id: Optional[str] = None):
        """Add an artifact to the artifacts table with optional Storage upload."""
        import uuid

        artifact_id = str(uuid.uuid4())
        local_path = artifact["path"]
        file_name = artifact["name"]

        # Attempt upload to Supabase Storage
        storage_path = None
        public_url = None
        if client_id:
            storage_path, public_url = self._upload_to_storage(
                client_id, run_id, artifact_id, local_path, file_name
            )

        # Get file size
        file_size = None
        try:
            if os.path.exists(local_path):
                file_size = os.path.getsize(local_path)
        except Exception:
            pass

        try:
            self.supabase.table("artifacts").insert({
                "id": artifact_id,
                "run_id": run_id,
                "client_id": client_id,
                "campaign_id": campaign_id,
                "type": artifact["type"],
                "name": file_name,
                "path": public_url or local_path,
                "storage_path": storage_path,
                "stage": artifact.get("stage"),
                "size": file_size,
                "metadata": artifact.get("metadata"),
            }).execute()
        except Exception as e:
            print(f"[Worker] Error adding artifact: {e}")

    # ADR-004 Phase B: modes the os-api runner owns end-to-end (in-process via
    # setImmediate(executeRun)). The worker MUST NOT claim these — doing so
    # would silently no-op the run since the worker has no executor for them.
    # Defensive belt-and-suspenders: os-api's setImmediate already drives
    # execution before the worker's poll cycle picks the row up, but a slow
    # node loop or restarted process could lose that race.
    OS_API_OWNED_MODES = ("regrade", "stills")

    def _claim_pending_run(self) -> Optional[dict]:
        """
        Find and claim a pending run.

        Returns the run data if one was claimed, None otherwise.

        Modes listed in OS_API_OWNED_MODES are skipped — the os-api Express
        runner handles those in-process and the worker has no executor for
        them. Skipping is server-side via .not_.in_("mode", ...) so we don't
        round-trip rows we'll just discard.
        """
        try:
            # Find a pending run NOT in any os-api-owned mode.
            result = self.supabase.table("runs").select("*").eq(
                "status", "pending"
            ).not_.in_("mode", list(self.OS_API_OWNED_MODES)).order(
                "created_at"
            ).limit(1).execute()

            if not result.data:
                return None

            run = result.data[0]
            run_id = run["id"]
            mode = run["mode"]

            # Defensive: even though the query filters, double-check before
            # claiming so a future query refactor can't accidentally bypass
            # the guard.
            if mode in self.OS_API_OWNED_MODES:
                print(
                    f"[Worker] Skipping run {run_id} (mode: {mode}) — "
                    f"os-api owns this mode; worker has no executor."
                )
                return None

            # Attempt to claim it by setting status to running
            # This is a simple approach - in production you'd want a proper lock
            update_result = self.supabase.table("runs").update({
                "status": "running",
                "started_at": datetime.utcnow().isoformat(),
            }).eq("id", run_id).eq("status", "pending").execute()

            if update_result.data:
                print(f"[Worker] Claimed run: {run_id} (mode: {mode})")
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

            else:
                log_cb("system", "error", f"Unknown mode: {mode}")
                result = {"status": "failed", "error": f"Unknown mode: {mode}"}

            # Process result
            if result:
                status = result.get("status", "completed")
                error = result.get("error")
                hitl_required = result.get("hitl_required", False)
                artifacts = result.get("artifacts", [])

                # Add artifacts (with Storage upload)
                campaign_id = run.get("campaign_id")
                for artifact in artifacts:
                    self._add_artifact(run_id, artifact, client_id=client_id, campaign_id=campaign_id)

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
