"""Ingest executor - runs Brand_linter indexing."""

import subprocess
import sys
from pathlib import Path
from typing import Callable, Optional

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))
from config import TOOL_PATHS, TOOL_VENVS


class IngestExecutor:
    """Executor for ingest (Brand Memory) operations."""

    def __init__(self, log_callback: Callable[[str, str, str], None]):
        """
        Initialize the ingest executor.

        Args:
            log_callback: Function to call with (stage, level, message) for logging
        """
        self.log = log_callback
        self.tool_path = TOOL_PATHS["brand_linter"]
        self.python = TOOL_VENVS["brand_linter"]

    def execute(self, run_id: str, client_id: str, params: Optional[dict] = None) -> dict:
        """
        Execute the ingest operation.

        For now, this runs the brand_dna_indexer to index brand assets.
        In the future, this could accept file paths or URLs to ingest.

        Args:
            run_id: The run ID
            client_id: The client ID
            params: Optional parameters (e.g., asset_path, asset_type)

        Returns:
            dict with status and any artifacts
        """
        self.log("ingest", "info", f"Starting ingest for client {client_id}")

        # For demo, we'll run the check_pinecone_vectors to verify the index
        # In production, this would run brand_dna_indexer with new assets
        script = self.tool_path / "tools" / "check_pinecone_vectors.py"

        if not script.exists():
            self.log("ingest", "error", f"Script not found: {script}")
            return {"status": "failed", "error": "Script not found"}

        self.log("ingest", "info", "Checking Pinecone index status...")

        try:
            result = subprocess.run(
                [str(self.python), str(script)],
                cwd=str(self.tool_path),
                capture_output=True,
                text=True,
                timeout=120,
            )

            # Stream stdout lines as logs
            for line in result.stdout.strip().split("\n"):
                if line.strip():
                    self.log("ingest", "info", line.strip())

            if result.returncode != 0:
                self.log("ingest", "error", f"Ingest failed: {result.stderr}")
                return {"status": "failed", "error": result.stderr}

            self.log("ingest", "info", "Ingest completed successfully")
            return {"status": "completed", "artifacts": []}

        except subprocess.TimeoutExpired:
            self.log("ingest", "error", "Ingest timed out after 120s")
            return {"status": "failed", "error": "Timeout"}
        except Exception as e:
            self.log("ingest", "error", f"Ingest error: {str(e)}")
            return {"status": "failed", "error": str(e)}
