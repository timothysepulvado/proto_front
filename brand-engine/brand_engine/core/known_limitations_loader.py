"""Image-class known_limitations reader.

Reads the `known_limitations` Supabase table at request time and returns the
subset relevant to image-class grading (model `gemini-3-pro-image-preview`,
categories `character | composition | aesthetic | content | lighting`).

Why request-time-not-startup:
  The catalog evolves as new failure modes are discovered. A long-running
  brand-engine sidecar should pick up new rows without a restart. We cache
  with a short TTL so the per-request cost stays low (~1 Supabase round-trip
  every 60 seconds) without thrashing the database.

Why this module (not lazy-load inside image_grader):
  Test isolation. The grade_image_v2 tests mock this single function and
  never need a Supabase client. Mocking at the module boundary keeps the
  grader's internals testable without monkeypatching `supabase.create_client`.

Canonical Supabase auth pattern (mirrors brand_engine.core.trainer):
  url = os.getenv("SUPABASE_URL")
  key = os.getenv("SUPABASE_KEY")
  client = create_client(url, key)
"""
from __future__ import annotations

import logging
import os
import time
from typing import Optional

from supabase import Client, create_client

logger = logging.getLogger(__name__)

# Image-class categories per ADR-004. `lighting` is a pre-007 category that
# can also surface for image-class shots; the rest were seeded by migration 009.
IMAGE_CLASS_CATEGORIES: list[str] = [
    "character",
    "composition",
    "aesthetic",
    "content",
    "lighting",
]

IMAGE_CLASS_MODEL = "gemini-3-pro-image-preview"

# Module-scope cache. The 60-second TTL lets long-running sidecars pick up
# new failure modes without a restart while keeping Supabase RPC volume low.
_CACHE_TTL_SECONDS = 60
_cache: list[dict] | None = None
_cache_loaded_at: float = 0.0
_cache_client: Optional[Client] = None


def _get_supabase_client() -> Optional[Client]:
    """Lazy-init Supabase client. Returns None if env vars are missing — the
    caller treats that as "no catalog available, grade against criterion-only"
    rather than raising. Brand-engine sidecar must keep grading even when
    Supabase is briefly unreachable."""
    global _cache_client
    if _cache_client is not None:
        return _cache_client
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")
    if not url or not key:
        logger.warning(
            "SUPABASE_URL/SUPABASE_KEY not set; known_limitations catalog will be empty. "
            "Grading will fall back to criterion-only verdicts. Set both env vars in "
            "brand-engine/.env to enable catalog-aware grading."
        )
        return None
    try:
        _cache_client = create_client(url, key)
    except Exception as e:
        logger.error("Failed to create Supabase client: %s", e)
        return None
    return _cache_client


def load_image_class_limitations(force_refresh: bool = False) -> list[dict]:
    """Read image-class known_limitations rows from Supabase, cached 60s.

    Returns a list of dicts with keys:
      failure_mode, category, description, mitigation, severity

    Returns [] if Supabase is unreachable or no rows match. The grade_image_v2
    endpoint treats an empty catalog as "no known patterns to probe for" and
    grades on criterion scores alone — degrade gracefully, never fail the
    request because the catalog read failed.

    The single-flight mutex behavior is intentional: concurrent calls during
    a cache miss may all trigger Supabase reads, but that's bounded by the
    60-second TTL and not worth the lock complexity at typical request volumes.
    """
    global _cache, _cache_loaded_at
    now = time.time()
    if (
        not force_refresh
        and _cache is not None
        and (now - _cache_loaded_at) < _CACHE_TTL_SECONDS
    ):
        return _cache

    client = _get_supabase_client()
    if client is None:
        # No client available; cache empty so we don't keep retrying mid-request.
        _cache = []
        _cache_loaded_at = now
        return _cache

    try:
        response = (
            client.table("known_limitations")
            .select("failure_mode,category,description,mitigation,severity")
            .eq("model", IMAGE_CLASS_MODEL)
            .in_("category", IMAGE_CLASS_CATEGORIES)
            .execute()
        )
        rows = response.data or []
        # Normalize: ensure every row has the 5 fields the grader expects.
        catalog: list[dict] = []
        for row in rows:
            catalog.append({
                "failure_mode": row.get("failure_mode", ""),
                "category": row.get("category", ""),
                "description": row.get("description", ""),
                "mitigation": row.get("mitigation", "") or "",
                "severity": row.get("severity", "warning"),
            })
        _cache = catalog
        _cache_loaded_at = now
        logger.info(
            "Loaded %d image-class known_limitations rows (model=%s, categories=%s)",
            len(catalog), IMAGE_CLASS_MODEL, ",".join(IMAGE_CLASS_CATEGORIES),
        )
        return _cache
    except Exception as e:
        # Supabase unreachable / query error → return whatever we have, or empty.
        logger.error("Failed to load known_limitations: %s; falling back to empty catalog", e)
        if _cache is None:
            _cache = []
            _cache_loaded_at = now
        return _cache


def reset_cache() -> None:
    """Clear the module-scope cache. Used by tests + on-demand refresh."""
    global _cache, _cache_loaded_at, _cache_client
    _cache = None
    _cache_loaded_at = 0.0
    _cache_client = None
