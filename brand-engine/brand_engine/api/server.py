"""FastAPI sidecar for brand engine.

Exposes /ingest, /grade, /drift, /baseline endpoints over HTTP.
Called by os-api runner.ts (via fetch) and optionally by the Python worker.

Run with: uvicorn brand_engine.api.server:app --port 8100
"""

import logging
import os

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException

from brand_engine import __version__
from brand_engine.core.embeddings import get_embedding_client
from brand_engine.core.grader import BrandGrader
from brand_engine.core.indexer import BrandIndexer
from brand_engine.core.models import (
    BaselineRequest,
    BaselineResult,
    DriftReport,
    DriftRequest,
    GradeRequest,
    GradeResult,
    HealthResponse,
    IngestRequest,
    IngestResult,
)
from brand_engine.core.pinecone_client import check_connectivity as check_pinecone
from brand_engine.core.retriever import DualFusionRetriever, load_brand_profile
from brand_engine.core.trainer import ThresholdTrainer

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Brand Engine API",
    description="Gemini Embed 2 + Cohere v4 dual-fusion brand compliance engine",
    version=__version__,
)

# Lazy-initialized singletons
_grader: BrandGrader | None = None
_indexer: BrandIndexer | None = None
_retriever: DualFusionRetriever | None = None


def _get_grader() -> BrandGrader:
    global _grader
    if _grader is None:
        _grader = BrandGrader()
    return _grader


def _get_indexer() -> BrandIndexer:
    global _indexer
    if _indexer is None:
        _indexer = BrandIndexer()
    return _indexer


def _get_retriever() -> DualFusionRetriever:
    global _retriever
    if _retriever is None:
        _retriever = DualFusionRetriever()
    return _retriever


@app.get("/health", response_model=HealthResponse)
async def health():
    """Check connectivity to all backend services."""
    try:
        embed_client = get_embedding_client()
        connectivity = embed_client.check_connectivity()
    except Exception:
        connectivity = {"gemini": False, "cohere": False}

    pinecone_ok = check_pinecone()

    return HealthResponse(
        status="ok" if all([connectivity.get("gemini"), connectivity.get("cohere"), pinecone_ok]) else "degraded",
        gemini_connected=connectivity.get("gemini", False),
        cohere_connected=connectivity.get("cohere", False),
        pinecone_connected=pinecone_ok,
        version=__version__,
    )


@app.post("/grade", response_model=GradeResult)
async def grade(request: GradeRequest):
    """Grade an image against a brand profile.

    Returns dual-fusion z-scores (Gemini + Cohere), optional pixel analysis,
    and a gate decision (AUTO_PASS / HITL_REVIEW / AUTO_FAIL).
    """
    try:
        profile = load_brand_profile(request.brand_slug)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    try:
        grader = _get_grader()
        result = grader.grade(
            image_path=request.image_path,
            profile=profile,
            text_query=request.text_query,
            include_pixel_analysis=request.include_pixel_analysis,
            index_tier=request.index_tier,
        )
        return result
    except Exception as e:
        logger.error("Grade failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/ingest", response_model=IngestResult)
async def ingest(request: IngestRequest):
    """Ingest brand assets into Pinecone indexes.

    Embeds images with Gemini Embedding 2 (768D) and Cohere v4 (1536D),
    then upserts to the appropriate Pinecone indexes.
    """
    try:
        profile = load_brand_profile(request.brand_slug)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    try:
        indexer = _get_indexer()
        result = indexer.ingest(
            profile=profile,
            images_dir=request.images_dir,
            index_tier=request.index_tier,
            documents_dir=request.documents_dir if request.include_documents else None,
        )
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error("Ingest failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/drift", response_model=DriftReport)
async def drift(request: DriftRequest):
    """Check a generated image for brand drift.

    Runs dual-fusion grading against the 'core' tier (brand baseline corpus)
    and compares the result to the stored baseline scores.
    """
    try:
        profile = load_brand_profile(request.brand_slug)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    try:
        grader = _get_grader()
        grade = grader.grade(
            image_path=request.image_path,
            profile=profile,
            text_query=request.text_query,
            include_pixel_analysis=True,
            index_tier=request.index_tier,
        )

        # Compare against baseline (placeholder — in production, read from brand_baselines table)
        baseline_z = 0.0  # TODO: fetch from Supabase brand_baselines
        drift_delta = grade.fusion.combined_z - baseline_z

        # Classify drift severity
        abs_delta = abs(drift_delta)
        if abs_delta < 0.5:
            severity = "none"
        elif abs_delta < 1.0:
            severity = "minor"
        elif abs_delta < 2.0:
            severity = "moderate"
        else:
            severity = "severe"

        return DriftReport(
            grade=grade,
            baseline_combined_z=baseline_z,
            drift_delta=drift_delta,
            drift_severity=severity,
            alert_triggered=severity in ("moderate", "severe"),
        )
    except Exception as e:
        logger.error("Drift check failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/baseline", response_model=BaselineResult)
async def baseline(request: BaselineRequest):
    """Calculate brand baseline scores from the existing corpus.

    Queries the brand's Pinecone indexes to establish mean similarity
    scores and standard deviations per model. These become the reference
    for drift detection.
    """
    try:
        profile = load_brand_profile(request.brand_slug)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    try:
        retriever = _get_retriever()

        # Sample vectors from the brand-dna index and compute self-similarity stats
        # This is a simplified baseline calculation — in production, you'd
        # query all vectors and compute cross-similarity statistics
        gemini_index_name = profile.indexes.get("brand-dna-gemini768")
        cohere_index_name = profile.indexes.get("brand-dna-cohere")

        if not gemini_index_name or not cohere_index_name:
            raise HTTPException(
                status_code=400,
                detail=f"Brand profile '{request.brand_slug}' missing index names for brand-dna tier",
            )

        from brand_engine.core.pinecone_client import get_index

        gemini_idx = get_index(gemini_index_name)
        cohere_idx = get_index(cohere_index_name)

        # Get index stats for sample count
        gemini_stats = gemini_idx.describe_index_stats()
        sample_count = gemini_stats.total_vector_count

        if sample_count == 0:
            raise HTTPException(
                status_code=400,
                detail=f"No vectors in index {gemini_index_name}. Run ingest first.",
            )

        # For baseline, we use placeholder stats since computing full
        # cross-similarity requires fetching all vectors
        # In production, this would be a batch job
        return BaselineResult(
            brand_slug=request.brand_slug,
            gemini_baseline_z=0.0,
            gemini_baseline_raw=0.5,
            gemini_stddev=0.15,
            cohere_baseline_z=0.0,
            cohere_baseline_raw=0.5,
            cohere_stddev=0.15,
            fused_baseline_z=0.0,
            sample_count=sample_count,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Baseline calculation failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def start():
    """Entry point for brand-engine-api script."""
    port = int(os.getenv("BRAND_ENGINE_PORT", "8100"))
    uvicorn.run(
        "brand_engine.api.server:app",
        host="0.0.0.0",
        port=port,
        log_level="info",
    )


if __name__ == "__main__":
    start()
