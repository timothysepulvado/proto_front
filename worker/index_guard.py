"""
Index Guard - Pinecone Index Management and Safety Guards

Centralized module for:
- Brand identifier conversions (brand_id -> brand_slug)
- Pinecone index name construction
- Core vs Campaign index separation enforcement
- Legacy index migration support

NAMING CONTRACT:
- brand_id: Human-readable with underscores (e.g., "jenni_kayne")
- brand_slug: URL-safe for Pinecone, no underscores (e.g., "jennikayne")
- client_id: Supabase PK with prefix (e.g., "client_jenni_kayne")
"""

import re
from dataclasses import dataclass
from typing import Dict, Literal, Optional


# =============================================================================
# CONSTANTS
# =============================================================================

# Embedding model configurations
MODEL_DIMENSIONS: Dict[str, int] = {
    "clip": 768,
    "e5": 1024,
    "cohere": 1536,
}

# Index types for Core/Campaign separation
IndexType = Literal["core", "campaign"]

# Valid models
VALID_MODELS = frozenset(["clip", "e5", "cohere"])

# Legacy index patterns (treat as Core during migration)
# These are the old naming patterns before Core/Campaign separation
LEGACY_INDEX_PATTERNS = [
    r"^[a-z]+-brand-dna-clip768$",
    r"^[a-z]+-brand-dna-e5$",
    r"^[a-z]+-brand-dna-cohere$",
]

# Index name validation regex
INDEX_NAME_PATTERN = re.compile(
    r"^[a-z]+-(core|campaign|brand-dna)-(clip768|e5-1024|e5|cohere1536|cohere)$"
)


# =============================================================================
# BRAND IDENTIFIER FUNCTIONS
# =============================================================================

def get_brand_slug(brand_id: str) -> str:
    """
    Convert brand_id to URL-safe slug for Pinecone index names.

    The brand_slug is used in Pinecone index names because:
    - Pinecone index names should be simple alphanumeric
    - Underscores can cause parsing issues
    - Consistent format across all brands

    Args:
        brand_id: Human-readable brand identifier (e.g., "jenni_kayne", "Jenni Kayne")

    Returns:
        URL-safe slug (e.g., "jennikayne")

    Examples:
        >>> get_brand_slug("jenni_kayne")
        'jennikayne'
        >>> get_brand_slug("Jenni Kayne")
        'jennikayne'
        >>> get_brand_slug("cylndr")
        'cylndr'
    """
    return brand_id.replace("_", "").replace(" ", "").lower()


def get_client_id(brand_id: str) -> str:
    """
    Convert brand_id to Supabase client_id format.

    Args:
        brand_id: Human-readable brand identifier

    Returns:
        Supabase-compatible client_id with 'client_' prefix

    Examples:
        >>> get_client_id("jenni_kayne")
        'client_jenni_kayne'
    """
    # Normalize to lowercase with underscores
    normalized = brand_id.lower().replace(" ", "_")

    # Add prefix if not already present
    if normalized.startswith("client_"):
        return normalized
    return f"client_{normalized}"


def brand_id_from_client_id(client_id: str) -> str:
    """
    Extract brand_id from Supabase client_id.

    Args:
        client_id: Supabase client_id (e.g., "client_jenni_kayne")

    Returns:
        Human-readable brand_id (e.g., "jenni_kayne")

    Examples:
        >>> brand_id_from_client_id("client_jenni_kayne")
        'jenni_kayne'
    """
    if client_id.startswith("client_"):
        return client_id[7:]  # Remove 'client_' prefix
    return client_id


# =============================================================================
# PINECONE INDEX NAME FUNCTIONS
# =============================================================================

def get_index_name(brand_id: str, model: str, index_type: IndexType) -> str:
    """
    Construct a Pinecone index name from components.

    Pattern: {brand_slug}-{index_type}-{model}{dimension}

    Args:
        brand_id: Human-readable brand identifier
        model: Embedding model ("clip", "e5", "cohere")
        index_type: "core" or "campaign"

    Returns:
        Full index name (e.g., "jennikayne-core-clip768")

    Raises:
        ValueError: If model is not recognized
    """
    if model not in VALID_MODELS:
        raise ValueError(f"Unknown model: {model}. Valid models: {VALID_MODELS}")

    brand_slug = get_brand_slug(brand_id)
    dimension = MODEL_DIMENSIONS[model]

    # E5 uses dash separator for dimension
    if model == "e5":
        return f"{brand_slug}-{index_type}-e5-{dimension}"
    else:
        return f"{brand_slug}-{index_type}-{model}{dimension}"


def get_core_index(brand_id: str, model: str) -> str:
    """
    Get Core index name for grading/scoring.

    Core indexes contain canonical brand DNA and are READ-ONLY for AI.
    They are used for:
    - Scoring generated images
    - Brand consistency checks
    - Reference retrieval

    Args:
        brand_id: Human-readable brand identifier
        model: Embedding model ("clip", "e5", "cohere")

    Returns:
        Core index name (e.g., "jennikayne-core-clip768")

    Examples:
        >>> get_core_index("jenni_kayne", "clip")
        'jennikayne-core-clip768'
        >>> get_core_index("jenni_kayne", "e5")
        'jennikayne-core-e5-1024'
    """
    return get_index_name(brand_id, model, "core")


def get_campaign_index(brand_id: str, model: str) -> str:
    """
    Get Campaign index name for AI-approved outputs.

    Campaign indexes store AI-generated and approved content.
    They are WRITE targets for AI and are used for:
    - Storing approved generations
    - Campaign-specific retrieval
    - Drift analysis (comparing against Core)

    Args:
        brand_id: Human-readable brand identifier
        model: Embedding model ("clip", "e5", "cohere")

    Returns:
        Campaign index name (e.g., "jennikayne-campaign-clip768")

    Examples:
        >>> get_campaign_index("jenni_kayne", "clip")
        'jennikayne-campaign-clip768'
        >>> get_campaign_index("jenni_kayne", "e5")
        'jennikayne-campaign-e5-1024'
    """
    return get_index_name(brand_id, model, "campaign")


def get_all_indexes(brand_id: str, index_type: IndexType) -> Dict[str, str]:
    """
    Get all index names for a brand and type.

    Args:
        brand_id: Human-readable brand identifier
        index_type: "core" or "campaign"

    Returns:
        Dict mapping model name to index name

    Examples:
        >>> get_all_indexes("jenni_kayne", "core")
        {'clip': 'jennikayne-core-clip768', 'e5': 'jennikayne-core-e5-1024', 'cohere': 'jennikayne-core-cohere1536'}
    """
    return {
        model: get_index_name(brand_id, model, index_type)
        for model in VALID_MODELS
    }


def get_legacy_index(brand_id: str, model: str) -> str:
    """
    Get legacy index name (pre-Core/Campaign separation).

    Legacy format: {brand_slug}-brand-dna-{model}[dimension]

    Args:
        brand_id: Human-readable brand identifier
        model: Embedding model

    Returns:
        Legacy index name

    Examples:
        >>> get_legacy_index("jenni_kayne", "clip")
        'jennikayne-brand-dna-clip768'
    """
    brand_slug = get_brand_slug(brand_id)

    if model == "clip":
        return f"{brand_slug}-brand-dna-clip768"
    elif model == "e5":
        return f"{brand_slug}-brand-dna-e5"
    elif model == "cohere":
        return f"{brand_slug}-brand-dna-cohere"
    else:
        raise ValueError(f"Unknown model: {model}")


# =============================================================================
# INDEX TYPE DETECTION
# =============================================================================

def parse_index_name(index_name: str) -> Optional[Dict[str, str]]:
    """
    Parse an index name into its components.

    Args:
        index_name: Full index name

    Returns:
        Dict with 'brand_slug', 'index_type', 'model' or None if invalid

    Examples:
        >>> parse_index_name("jennikayne-core-clip768")
        {'brand_slug': 'jennikayne', 'index_type': 'core', 'model': 'clip'}
        >>> parse_index_name("jennikayne-brand-dna-e5")
        {'brand_slug': 'jennikayne', 'index_type': 'legacy', 'model': 'e5'}
    """
    # Try new format: {brand}-{type}-{model}{dim}
    match = re.match(r"^([a-z]+)-(core|campaign)-(clip768|e5-1024|cohere1536)$", index_name)
    if match:
        brand_slug, index_type, model_dim = match.groups()
        model = model_dim.split("-")[0].replace("768", "").replace("1024", "").replace("1536", "")
        if model == "":
            model = "clip" if "768" in model_dim else "cohere"
        return {
            "brand_slug": brand_slug,
            "index_type": index_type,
            "model": model,
        }

    # Try legacy format: {brand}-brand-dna-{model}
    match = re.match(r"^([a-z]+)-brand-dna-(clip768|e5|cohere)$", index_name)
    if match:
        brand_slug, model = match.groups()
        model = model.replace("768", "")
        return {
            "brand_slug": brand_slug,
            "index_type": "legacy",
            "model": model,
        }

    return None


def is_core_index(index_name: str) -> bool:
    """
    Check if an index is a Core index (or legacy, treated as Core).

    Args:
        index_name: Full index name

    Returns:
        True if index is Core or legacy (for grading purposes)
    """
    parsed = parse_index_name(index_name)
    if not parsed:
        return False
    return parsed["index_type"] in ("core", "legacy")


def is_campaign_index(index_name: str) -> bool:
    """
    Check if an index is a Campaign index.

    Args:
        index_name: Full index name

    Returns:
        True if index is Campaign type
    """
    parsed = parse_index_name(index_name)
    if not parsed:
        return False
    return parsed["index_type"] == "campaign"


def is_legacy_index(index_name: str) -> bool:
    """
    Check if an index uses legacy naming.

    Args:
        index_name: Full index name

    Returns:
        True if index uses old brand-dna naming
    """
    parsed = parse_index_name(index_name)
    if not parsed:
        return False
    return parsed["index_type"] == "legacy"


# =============================================================================
# SAFETY GUARDS (HARD WALLS)
# =============================================================================

class IndexAccessError(Exception):
    """Raised when attempting unauthorized index access."""
    pass


def assert_grading_index(index_name: str) -> None:
    """
    Assert that an index can be used for grading/scoring.

    Grading MUST read from Core indexes (or legacy).
    Campaign indexes are NEVER used for grading.

    Args:
        index_name: Index being accessed for grading

    Raises:
        IndexAccessError: If index is Campaign type

    Examples:
        >>> assert_grading_index("jennikayne-core-clip768")  # OK
        >>> assert_grading_index("jennikayne-brand-dna-clip768")  # OK (legacy)
        >>> assert_grading_index("jennikayne-campaign-clip768")  # RAISES
    """
    if is_campaign_index(index_name):
        raise IndexAccessError(
            f"Cannot grade from Campaign index: {index_name}. "
            "Grading must use Core indexes to maintain brand consistency."
        )


def assert_ai_write_index(index_name: str) -> None:
    """
    Assert that an index can receive AI-generated writes.

    AI writes MUST go to Campaign indexes.
    Core and legacy indexes are NEVER written to by AI.

    Args:
        index_name: Index being written to

    Raises:
        IndexAccessError: If index is Core or legacy type

    Examples:
        >>> assert_ai_write_index("jennikayne-campaign-clip768")  # OK
        >>> assert_ai_write_index("jennikayne-core-clip768")  # RAISES
        >>> assert_ai_write_index("jennikayne-brand-dna-clip768")  # RAISES
    """
    if is_core_index(index_name):
        raise IndexAccessError(
            f"Cannot write AI output to Core/legacy index: {index_name}. "
            "AI writes must target Campaign indexes to protect brand DNA."
        )


def validate_index_name(index_name: str) -> bool:
    """
    Validate that an index name follows the naming contract.

    Args:
        index_name: Index name to validate

    Returns:
        True if valid, False otherwise
    """
    return INDEX_NAME_PATTERN.match(index_name) is not None


# =============================================================================
# METADATA TEMPLATE
# =============================================================================

@dataclass
class VectorMetadata:
    """Standard metadata template for Pinecone vectors."""

    brand_id: str
    source: str  # "reference", "generated", "approved"
    model: str  # "clip", "e5", "cohere"
    timestamp: str  # ISO format
    artifact_id: Optional[str] = None
    campaign_id: Optional[str] = None
    image_path: Optional[str] = None

    def to_dict(self) -> Dict:
        """Convert to dict for Pinecone upsert."""
        result = {
            "brand_id": self.brand_id,
            "source": self.source,
            "model": self.model,
            "timestamp": self.timestamp,
        }
        if self.artifact_id:
            result["artifact_id"] = self.artifact_id
        if self.campaign_id:
            result["campaign_id"] = self.campaign_id
        if self.image_path:
            result["image_path"] = self.image_path
        return result


# =============================================================================
# MIGRATION HELPERS
# =============================================================================

def is_migration_complete(brand_id: str, check_func=None) -> bool:
    """
    Check if a brand has been migrated to Core/Campaign indexes.

    This is used during the transition period when some brands
    may still be using legacy indexes.

    Args:
        brand_id: Brand to check
        check_func: Optional function to check if index exists

    Returns:
        True if Core indexes exist for this brand
    """
    # Default implementation assumes migration is not complete
    # In production, this would check Pinecone for index existence
    if check_func:
        core_index = get_core_index(brand_id, "clip")
        return check_func(core_index)
    return False


def get_grading_indexes(brand_id: str, prefer_core: bool = True) -> Dict[str, str]:
    """
    Get indexes to use for grading, handling migration state.

    During migration, falls back to legacy indexes if Core doesn't exist.

    Args:
        brand_id: Brand to get indexes for
        prefer_core: If True, prefer Core indexes over legacy

    Returns:
        Dict mapping model to index name
    """
    if prefer_core and is_migration_complete(brand_id):
        return get_all_indexes(brand_id, "core")

    # Fall back to legacy
    return {
        "clip": get_legacy_index(brand_id, "clip"),
        "e5": get_legacy_index(brand_id, "e5"),
        "cohere": get_legacy_index(brand_id, "cohere"),
    }


# =============================================================================
# CONVENIENCE EXPORTS
# =============================================================================

__all__ = [
    # Brand identifiers
    "get_brand_slug",
    "get_client_id",
    "brand_id_from_client_id",

    # Index names
    "get_index_name",
    "get_core_index",
    "get_campaign_index",
    "get_all_indexes",
    "get_legacy_index",

    # Index detection
    "parse_index_name",
    "is_core_index",
    "is_campaign_index",
    "is_legacy_index",
    "validate_index_name",

    # Safety guards
    "IndexAccessError",
    "assert_grading_index",
    "assert_ai_write_index",

    # Metadata
    "VectorMetadata",

    # Migration
    "is_migration_complete",
    "get_grading_indexes",

    # Constants
    "MODEL_DIMENSIONS",
    "VALID_MODELS",
]
