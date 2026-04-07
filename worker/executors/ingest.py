"""Ingest executor - runs Brand_linter indexing via brand-engine core.

Rewired from subprocess calls to brand_engine.core direct imports.
"""

import sys
from pathlib import Path
from typing import Callable, Optional

# Add brand-engine to path for direct imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "brand-engine"))


class IngestExecutor:
    """Executor for ingest (Brand Memory) operations.

    Uses brand_engine.core directly — no subprocess, shared model singletons.
    """

    def __init__(self, log_callback: Callable[[str, str, str], None]):
        self.log = log_callback

    def execute(self, run_id: str, client_id: str, params: Optional[dict] = None) -> dict:
        """Execute the ingest operation.

        Args:
            run_id: The run ID
            client_id: The client ID
            params: Optional parameters (e.g., images_dir, index_tier)

        Returns:
            dict with status and any artifacts
        """
        params = params or {}
        brand_slug = client_id.replace("client_", "")
        images_dir = params.get("images_dir", f"data/{brand_slug}")
        index_tier = params.get("index_tier", "brand-dna")
        documents_dir = params.get("documents_dir")

        self.log("ingest", "info", f"Starting ingest for brand '{brand_slug}'")

        try:
            from brand_engine.core.indexer import BrandIndexer
            from brand_engine.core.retriever import load_brand_profile

            profile = load_brand_profile(brand_slug)
            indexer = BrandIndexer(log_callback=self.log)

            result = indexer.ingest(
                profile=profile,
                images_dir=images_dir,
                index_tier=index_tier,
                documents_dir=documents_dir,
            )

            self.log("ingest", "info", f"Indexed {result.vectors_indexed} vectors")
            self.log("ingest", "info", f"  Gemini index: {result.gemini_index}")
            self.log("ingest", "info", f"  Cohere index: {result.cohere_index}")

            if result.errors:
                self.log("ingest", "warn", f"{len(result.errors)} errors during ingest")
                for err in result.errors[:5]:
                    self.log("ingest", "warn", f"  {err}")

            return {
                "status": "completed",
                "artifacts": [],
                "metrics": {
                    "vectors_indexed": result.vectors_indexed,
                    "errors": len(result.errors),
                },
            }

        except FileNotFoundError as e:
            self.log("ingest", "error", f"Not found: {e}")
            return {"status": "failed", "error": str(e)}
        except Exception as e:
            self.log("ingest", "error", f"Ingest error: {str(e)}")
            return {"status": "failed", "error": str(e)}
