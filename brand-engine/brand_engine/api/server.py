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
    FusionResult,
    GradeRequest,
    GradeResult,
    HealthResponse,
    IngestRequest,
    IngestResult,
    RetrieveRequest,
    VideoGradeRequest,
    VideoGradeResult,
)
from brand_engine.core.pinecone_client import check_connectivity as check_pinecone
from brand_engine.core.retriever import DualFusionRetriever, load_brand_profile
from brand_engine.core.trainer import ThresholdTrainer
from brand_engine.core.video_grader import VideoGrader

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
_video_grader: VideoGrader | None = None


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


def _get_video_grader() -> VideoGrader:
    global _video_grader
    if _video_grader is None:
        _video_grader = VideoGrader()
    return _video_grader


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


@app.post("/retrieve", response_model=FusionResult)
async def retrieve(request: RetrieveRequest):
    """Retrieve brand context using a text query.

    Runs dual-fusion retrieval (Gemini Embed 2 + Cohere v4) against
    the brand's Pinecone indexes using the text query as the embedding
    input. Returns top-K results with z-scores and gate decision.

    Used by os-api runner.ts to build brand context for generation prompts.
    """
    try:
        profile = load_brand_profile(request.brand_slug)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    try:
        retriever = _get_retriever()
        result = retriever.retrieve(
            image_path="",  # Not used when text_query is provided
            profile=profile,
            text_query=request.text_query,
            index_tier=request.index_tier,
            top_k=request.top_k,
        )
        return result
    except Exception as e:
        logger.error("Retrieve failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


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


@app.post("/grade_video", response_model=VideoGradeResult)
async def grade_video(request: VideoGradeRequest):
    """Grade a video clip using Gemini 3.1 Pro multimodal critic.

    Watches the full clip (not stills) and scores 10 motion-specific criteria:
    morphing, temporal_jitter, lighting_flicker, scale_creep, camera_smoothness,
    character_drift, wardrobe_drift, atmospheric_creep, vfx_dissipation,
    composition_stability.

    Cross-references the provided known_limitations catalog to classify
    detected failures. Output is structured VideoGradeResult (JSON) — the
    contract used by the os-api orchestrator to decide L1/L2/L3 escalation
    actions.

    Used by os-api runner.ts after video generation, in place of (or
    alongside) /grade which is image-only.
    """
    try:
        profile = load_brand_profile(request.brand_slug)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    try:
        grader = _get_video_grader()
        if request.consensus:
            # Rule-1 consensus path (escalation-ops brief): single call, second
            # pass on borderline score, ffmpeg frame-strip tiebreak on
            # disagreement. consensus_note on the result is the caller's
            # signal to flip OrchestratorInput.consensusResolved=true.
            result = grader.grade_video_with_consensus(
                video_path=request.video_path,
                profile=profile,
                deliverable_context=request.deliverable_context,
                hero_still_path=request.hero_still_path,
                known_limitations=request.known_limitations_context,
                failure_modes_to_check=request.failure_modes_to_check,
                threshold_band=request.consensus_threshold_band,
                narrative_context=request.narrative_context,
                music_video_synopsis=request.music_video_synopsis,
            )
        else:
            result = grader.grade(
                video_path=request.video_path,
                profile=profile,
                deliverable_context=request.deliverable_context,
                hero_still_path=request.hero_still_path,
                known_limitations=request.known_limitations_context,
                failure_modes_to_check=request.failure_modes_to_check,
                narrative_context=request.narrative_context,
                music_video_synopsis=request.music_video_synopsis,
            )
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        # Invalid JSON from Gemini critic — surfaces as 502 Bad Gateway
        logger.error("Video critic JSON error: %s", e)
        raise HTTPException(status_code=502, detail=f"Video critic returned invalid output: {e}")
    except Exception as e:
        logger.error("Video grade failed: %s", e, exc_info=True)
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
        # Build baseline stats dict from request fields (passed by runner from brand_baselines table)
        baseline_stats = None
        if request.baseline_gemini_raw is not None or request.baseline_cohere_raw is not None:
            baseline_stats = {
                "baseline_gemini_raw": request.baseline_gemini_raw,
                "baseline_gemini_stddev": request.baseline_gemini_stddev,
                "baseline_cohere_raw": request.baseline_cohere_raw,
                "baseline_cohere_stddev": request.baseline_cohere_stddev,
            }
            logger.info("Using stored baseline stats for drift: gemini_raw=%.4f, cohere_raw=%.4f",
                        request.baseline_gemini_raw or 0, request.baseline_cohere_raw or 0)

        grader = _get_grader()
        grade = grader.grade(
            image_path=request.image_path,
            profile=profile,
            text_query=request.text_query,
            include_pixel_analysis=True,
            index_tier=request.index_tier,
            baseline_stats=baseline_stats,
        )

        # Compare against baseline z-score (from brand_baselines table or default 0.0)
        baseline_z = request.baseline_fused_z if request.baseline_fused_z is not None else 0.0
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

        sample_limit = request.sample_limit or 100

        # Compute real self-similarity stats for each index
        gemini_stats = _compute_index_stats(gemini_idx, sample_limit)
        cohere_stats = _compute_index_stats(cohere_idx, sample_limit)

        if gemini_stats["sample_count"] == 0:
            raise HTTPException(
                status_code=400,
                detail=f"No vectors in index {gemini_index_name}. Run ingest first.",
            )

        # Compute fused baseline z-score using default weights
        thresholds = profile.thresholds
        fused_z = (
            thresholds.gemini_weight * gemini_stats["z_score"]
            + thresholds.cohere_weight * cohere_stats["z_score"]
        )

        total_samples = max(gemini_stats["sample_count"], cohere_stats["sample_count"])

        logger.info(
            "Baseline computed for %s: gemini_raw=%.4f (std=%.4f), cohere_raw=%.4f (std=%.4f), fused_z=%.4f, samples=%d",
            request.brand_slug,
            gemini_stats["mean"], gemini_stats["stddev"],
            cohere_stats["mean"], cohere_stats["stddev"],
            fused_z, total_samples,
        )

        return BaselineResult(
            brand_slug=request.brand_slug,
            gemini_baseline_z=gemini_stats["z_score"],
            gemini_baseline_raw=gemini_stats["mean"],
            gemini_stddev=gemini_stats["stddev"],
            cohere_baseline_z=cohere_stats["z_score"],
            cohere_baseline_raw=cohere_stats["mean"],
            cohere_stddev=cohere_stats["stddev"],
            fused_baseline_z=fused_z,
            sample_count=total_samples,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Baseline calculation failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def _compute_index_stats(index, sample_limit: int = 100) -> dict:
    """Compute pairwise cosine similarity stats from a Pinecone index.

    Samples up to `sample_limit` vectors, computes all pairwise cosine
    similarities, and returns mean, stddev, z-score (at mean), and sample count.

    For 100 vectors this is ~4,950 pairs — trivial compute.
    """
    import numpy as np

    stats = index.describe_index_stats()
    total = stats.total_vector_count

    if total == 0:
        return {"mean": 0.0, "stddev": 0.0, "z_score": 0.0, "sample_count": 0}

    # Get sample vector IDs via list()
    try:
        list_result = index.list(limit=min(sample_limit, total))
        vector_ids = [v.id if hasattr(v, "id") else v for v in (list_result.vectors if hasattr(list_result, "vectors") else list_result.get("vectors", []))]

        # Fallback: some Pinecone SDK versions return differently
        if not vector_ids and hasattr(list_result, "__iter__"):
            vector_ids = list(list_result)[:sample_limit]
    except Exception:
        # If list() not available, try query with a zero vector to get IDs
        logger.warning("index.list() failed, falling back to describe_index_stats only")
        return {"mean": 0.5, "stddev": 0.15, "z_score": 0.0, "sample_count": total}

    if len(vector_ids) < 2:
        return {"mean": 0.5, "stddev": 0.15, "z_score": 0.0, "sample_count": len(vector_ids)}

    # Fetch actual vectors
    try:
        fetch_result = index.fetch(ids=vector_ids[:sample_limit])
        vectors_dict = fetch_result.vectors if hasattr(fetch_result, "vectors") else fetch_result.get("vectors", {})
        vectors = {vid: np.array(v.values if hasattr(v, "values") else v["values"])
                   for vid, v in vectors_dict.items()}
    except Exception as e:
        logger.warning("Vector fetch failed (%s), using fallback stats", e)
        return {"mean": 0.5, "stddev": 0.15, "z_score": 0.0, "sample_count": total}

    if len(vectors) < 2:
        return {"mean": 0.5, "stddev": 0.15, "z_score": 0.0, "sample_count": len(vectors)}

    # Compute pairwise cosine similarities
    vecs = list(vectors.values())
    n = len(vecs)
    similarities = []
    for i in range(n):
        for j in range(i + 1, n):
            dot = float(np.dot(vecs[i], vecs[j]))
            norm_i = float(np.linalg.norm(vecs[i]))
            norm_j = float(np.linalg.norm(vecs[j]))
            if norm_i > 0 and norm_j > 0:
                similarities.append(dot / (norm_i * norm_j))

    if not similarities:
        return {"mean": 0.5, "stddev": 0.15, "z_score": 0.0, "sample_count": n}

    mean = float(np.mean(similarities))
    stddev = float(np.std(similarities)) if len(similarities) > 1 else 0.15

    # Z-score of the mean itself is 0 by definition; store mean/std for runtime use
    return {
        "mean": mean,
        "stddev": stddev if stddev > 0 else 0.15,  # Avoid div-by-zero in runtime normalization
        "z_score": 0.0,  # Baseline z-score is 0 (it IS the baseline)
        "sample_count": n,
    }


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
