"""Shared Pinecone connection singleton."""

import logging
import os
from typing import Optional

from pinecone import Pinecone

logger = logging.getLogger(__name__)

_instance: Optional[Pinecone] = None


def get_pinecone_client() -> Pinecone:
    """Get or create the singleton Pinecone client."""
    global _instance
    if _instance is None:
        api_key = os.getenv("PINECONE_API_KEY")
        if not api_key:
            raise ValueError("PINECONE_API_KEY environment variable is required")
        _instance = Pinecone(api_key=api_key)
        logger.info("Pinecone client initialized")
    return _instance


def get_index(index_name: str):
    """Get a Pinecone index by name."""
    pc = get_pinecone_client()
    return pc.Index(index_name)


def check_connectivity() -> bool:
    """Test Pinecone connectivity by listing indexes."""
    try:
        pc = get_pinecone_client()
        indexes = pc.list_indexes()
        logger.info("Pinecone connected: %d indexes found", len(indexes))
        return True
    except Exception as e:
        logger.warning("Pinecone connectivity check failed: %s", e)
        return False
