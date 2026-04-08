#!/usr/bin/env python3
"""Re-embed Jenni Kayne reference images through brand-engine indexer.

Task #4: Populate jennikayne-brand-dna-gemini768 and jennikayne-brand-dna-cohere
Pinecone indexes with 23 JK reference images using Gemini Embedding 2 + Cohere v4.

Usage:
    cd brand-engine
    source .venv/bin/activate
    set -a && source .env && set +a
    python scripts/reindex_jk.py [--dry-run]

Requires env vars: GOOGLE_GENAI_API_KEY, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, PINECONE_API_KEY
"""

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path

# Ensure brand_engine package is importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from brand_engine.core.embeddings import get_embedding_client
from brand_engine.core.indexer import BrandIndexer, IMAGE_EXTENSIONS
from brand_engine.core.models import BrandProfile

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# JK reference images — resolve through Brand_linter symlinks
JK_IMAGES_DIR = os.path.expanduser(
    "~/Brand_linter/local_quick_setup/data/jenni_kayne/reference_images"
)

# Brand profile
JK_PROFILE_PATH = Path(__file__).resolve().parent.parent / "data" / "brand_profiles" / "jenni_kayne.json"


def load_profile() -> BrandProfile:
    with open(JK_PROFILE_PATH) as f:
        data = json.load(f)
    return BrandProfile(**data)


def count_images(images_dir: str) -> list[Path]:
    """Count images using os.walk (follows symlinks)."""
    found = []
    for root, _dirs, files in os.walk(images_dir, followlinks=True):
        for fname in files:
            if Path(fname).suffix.lower() in IMAGE_EXTENSIONS:
                found.append(Path(root) / fname)
    return sorted(found)


def main():
    parser = argparse.ArgumentParser(description="Re-embed JK reference images")
    parser.add_argument("--dry-run", action="store_true", help="List images without embedding")
    parser.add_argument("--images-dir", default=JK_IMAGES_DIR, help="Override images directory")
    args = parser.parse_args()

    images_dir = args.images_dir
    logger.info("Images directory: %s", images_dir)

    if not os.path.isdir(images_dir):
        logger.error("Directory not found: %s", images_dir)
        sys.exit(1)

    # Count images
    images = count_images(images_dir)
    logger.info("Found %d images:", len(images))
    for img in images:
        logger.info("  %s", img.name)

    if args.dry_run:
        logger.info("Dry run — exiting without embedding.")
        return

    # Load profile
    profile = load_profile()
    logger.info("Brand profile: %s", profile.display_name)
    logger.info("Gemini index: %s", profile.indexes.get("brand-dna-gemini768"))
    logger.info("Cohere index: %s", profile.indexes.get("brand-dna-cohere"))

    # Check env vars
    required_vars = ["GOOGLE_GENAI_API_KEY", "PINECONE_API_KEY"]
    missing = [v for v in required_vars if not os.getenv(v)]
    # Accept either GOOGLE_GENAI_API_KEY or GEMINI_API_KEY
    if "GOOGLE_GENAI_API_KEY" in missing and os.getenv("GEMINI_API_KEY"):
        missing.remove("GOOGLE_GENAI_API_KEY")
    if missing:
        logger.error("Missing env vars: %s", ", ".join(missing))
        sys.exit(1)

    # Initialize and run
    start = time.time()

    def log_cb(stage: str, level: str, message: str):
        logger.info("[%s] %s", stage, message)

    indexer = BrandIndexer(log_callback=log_cb)

    logger.info("Starting ingest...")
    result = indexer.ingest(
        profile=profile,
        images_dir=images_dir,
        index_tier="brand-dna",
    )

    elapsed = time.time() - start
    logger.info("=" * 60)
    logger.info("DONE in %.1fs", elapsed)
    logger.info("Vectors indexed: %d", result.vectors_indexed)
    logger.info("Gemini index: %s", result.gemini_index)
    logger.info("Cohere index: %s", result.cohere_index)
    if result.errors:
        logger.warning("Errors (%d):", len(result.errors))
        for err in result.errors:
            logger.warning("  %s", err)
    else:
        logger.info("No errors.")
    logger.info("=" * 60)


if __name__ == "__main__":
    main()
