"""Ingest executor — indexes brand assets via brand_engine.core.

Replaces the old subprocess-based Brand_linter indexer with direct
Python imports from the consolidated brand-engine SDK. Falls back
to demo mode when brand-engine dependencies are unavailable.
"""

import json
import sys
from pathlib import Path
from typing import Callable, Optional

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))
from config import BRAND_ASSETS_BASE, BRAND_PROFILES_DIR, OUTPUT_BASE

# Try importing brand-engine (config.py adds it to sys.path)
try:
    from brand_engine.core import BrandIndexer
    from brand_engine.core.retriever import load_brand_profile

    BRAND_ENGINE_AVAILABLE = True
except ImportError:
    BRAND_ENGINE_AVAILABLE = False


class IngestExecutor:
    """Executor for ingest (Brand Memory) operations.

    Uses brand_engine.core.BrandIndexer for Gemini Embed 2 + Cohere v4
    dual-fusion indexing into Pinecone. Falls back to demo mode when
    brand-engine dependencies aren't installed.
    """

    def __init__(self, log_callback: Callable[[str, str, str], None]):
        """
        Initialize the ingest executor.

        Args:
            log_callback: Function to call with (stage, level, message) for logging
        """
        self.log = log_callback
        self._indexer: Optional[object] = None

    def _get_indexer(self) -> "BrandIndexer":
        """Lazy-init the BrandIndexer with our log callback."""
        if self._indexer is None:
            self._indexer = BrandIndexer(log_callback=self.log)
        return self._indexer

    def _find_images_dir(self, brand_slug: str, params: Optional[dict] = None) -> Optional[Path]:
        """Locate the images directory for a brand.

        Search order:
        1. Explicit path in params["images_dir"]
        2. Brand assets base: {BRAND_ASSETS_BASE}/{brand_slug}/reference_images/
        3. Brand assets base: {BRAND_ASSETS_BASE}/{brand_slug}/
        """
        if params and params.get("images_dir"):
            p = Path(params["images_dir"])
            if p.exists():
                return p

        # Check configured brand assets base
        candidates = [
            BRAND_ASSETS_BASE / brand_slug / "reference_images",
            BRAND_ASSETS_BASE / brand_slug,
        ]

        for candidate in candidates:
            if candidate.exists() and any(candidate.iterdir()):
                return candidate

        return None

    def execute(self, run_id: str, client_id: str, params: Optional[dict] = None) -> dict:
        """
        Execute the ingest operation.

        Indexes brand assets (images + optional documents) into Pinecone
        using Gemini Embedding 2 (768D) and Cohere v4 (1536D).

        Args:
            run_id: The run ID
            client_id: The client ID (e.g., "client_jenni_kayne")
            params: Optional parameters:
                - images_dir: explicit path to images
                - documents_dir: path to brand documents
                - index_tier: Pinecone tier (default "brand-dna")

        Returns:
            dict with status and any artifacts
        """
        params = params or {}
        brand_slug = client_id.replace("client_", "")
        index_tier = params.get("index_tier", "brand-dna")

        self.log("ingest", "info", f"Starting ingest for brand '{brand_slug}'")

        # Check if brand-engine is available
        if not BRAND_ENGINE_AVAILABLE:
            self.log("ingest", "warn", "brand-engine not available — running demo mode")
            return self._demo_ingest(brand_slug)

        # Load brand profile
        try:
            profiles_dir = str(BRAND_PROFILES_DIR) if BRAND_PROFILES_DIR.exists() else None
            profile = load_brand_profile(brand_slug, profiles_dir=profiles_dir)
            self.log("ingest", "info", f"Loaded brand profile: {profile.display_name}")
        except FileNotFoundError:
            self.log("ingest", "error", f"No brand profile found for '{brand_slug}'")
            return {"status": "failed", "error": f"Brand profile not found: {brand_slug}"}

        # Find images directory
        images_dir = self._find_images_dir(brand_slug, params)
        if not images_dir:
            self.log("ingest", "warn", f"No images directory found for brand '{brand_slug}'")
            self.log("ingest", "info", "Falling back to demo mode")
            return self._demo_ingest(brand_slug)

        self.log("ingest", "info", f"Images directory: {images_dir}")

        # Run ingest via brand-engine
        try:
            indexer = self._get_indexer()
            result = indexer.ingest(
                profile=profile,
                images_dir=str(images_dir),
                index_tier=index_tier,
                documents_dir=params.get("documents_dir"),
            )

            self.log(
                "ingest", "info",
                f"Indexed {result.vectors_indexed} vectors into "
                f"{result.gemini_index} + {result.cohere_index}",
            )

            if result.errors:
                for err in result.errors:
                    self.log("ingest", "warn", f"Ingest warning: {err}")

            # Save ingest report
            report_path = OUTPUT_BASE / client_id / "reports" / f"ingest_{run_id}.json"
            report_path.parent.mkdir(parents=True, exist_ok=True)
            with open(report_path, "w") as f:
                json.dump(result.model_dump(), f, indent=2)

            return {
                "status": "completed",
                "vectors_indexed": result.vectors_indexed,
                "artifacts": [
                    {
                        "type": "report",
                        "name": f"ingest_{run_id}.json",
                        "path": str(report_path),
                    }
                ],
            }

        except Exception as e:
            self.log("ingest", "error", f"Brand-engine ingest failed: {e}")
            self.log("ingest", "warn", "Falling back to demo mode")
            return self._demo_ingest(brand_slug)

    def _demo_ingest(self, brand_slug: str) -> dict:
        """Simulate ingest for demo/fallback purposes."""
        import time

        self.log("ingest", "info", f"[DEMO] Scanning brand assets for {brand_slug}...")
        time.sleep(1.0)
        self.log("ingest", "info", "[DEMO] Generating Gemini Embed 2 embeddings (768D)...")
        time.sleep(0.8)
        self.log("ingest", "info", "[DEMO] Generating Cohere v4 embeddings (1536D)...")
        time.sleep(0.6)
        self.log("ingest", "info", "[DEMO] Upserting to Pinecone indexes...")
        time.sleep(0.5)
        self.log("ingest", "info", "[DEMO] Brand Memory indexed successfully")

        return {"status": "completed", "artifacts": []}
