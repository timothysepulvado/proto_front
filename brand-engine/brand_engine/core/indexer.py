"""Brand asset indexer: embeds images/documents and upserts to Pinecone.

Ported from Brand_linter brand_dna_indexer.py + BDE ingest_e5_cohere.py.
Replaces CLIP+E5 with Gemini Embedding 2. Cohere ingestion preserved.
"""

import hashlib
import logging
from pathlib import Path
from typing import Callable, Optional

from brand_engine.core.embeddings import EmbeddingClient, get_embedding_client
from brand_engine.core.models import BrandProfile, IngestResult
from brand_engine.core.pinecone_client import get_index

logger = logging.getLogger(__name__)

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"}
DOCUMENT_EXTENSIONS = {".pdf", ".md", ".txt", ".docx"}
BATCH_SIZE = 50


class BrandIndexer:
    """Indexes brand assets (images and documents) into Pinecone
    using Gemini Embedding 2 + Cohere v4.
    """

    def __init__(
        self,
        embedding_client: Optional[EmbeddingClient] = None,
        log_callback: Optional[Callable[[str, str, str], None]] = None,
    ):
        self._embed = embedding_client or get_embedding_client()
        self._log = log_callback or self._default_log

    def ingest(
        self,
        profile: BrandProfile,
        images_dir: str,
        index_tier: str = "brand-dna",
        documents_dir: Optional[str] = None,
    ) -> IngestResult:
        """Ingest brand assets into Pinecone indexes.

        Args:
            profile: Brand profile with index names.
            images_dir: Directory containing brand images.
            index_tier: Pinecone index tier (brand-dna, core, campaign).
            documents_dir: Optional directory with brand documents.

        Returns:
            IngestResult with counts and any errors.
        """
        gemini_index_name = profile.indexes.get(f"{index_tier}-gemini768")
        cohere_index_name = profile.indexes.get(f"{index_tier}-cohere")

        if not gemini_index_name or not cohere_index_name:
            raise ValueError(
                f"Brand profile '{profile.brand_slug}' missing index names for tier '{index_tier}'"
            )

        gemini_index = get_index(gemini_index_name)
        cohere_index = get_index(cohere_index_name)

        images_path = Path(images_dir)
        if not images_path.exists():
            raise FileNotFoundError(f"Images directory not found: {images_dir}")

        # Collect image files
        image_files = sorted(
            f for f in images_path.rglob("*") if f.suffix.lower() in IMAGE_EXTENSIONS
        )

        self._log("ingest", "info", f"Found {len(image_files)} images in {images_dir}")

        vectors_indexed = 0
        errors = []

        # Process images in batches
        gemini_batch = []
        cohere_batch = []

        for i, img_path in enumerate(image_files):
            try:
                self._log(
                    "ingest",
                    "info",
                    f"Embedding [{i+1}/{len(image_files)}]: {img_path.name}",
                )

                result = self._embed.embed_image(str(img_path))

                # Generate a stable vector ID from file path
                vec_id = self._make_vector_id(profile.brand_slug, img_path)

                metadata = {
                    "brand": profile.brand_slug,
                    "filename": img_path.name,
                    "source_path": str(img_path),
                    "tier": index_tier,
                }

                gemini_batch.append((vec_id, result.gemini_768, metadata))
                cohere_batch.append((vec_id, result.cohere_1536, metadata))

                # Flush when batch is full
                if len(gemini_batch) >= BATCH_SIZE:
                    self._upsert_batch(gemini_index, gemini_batch)
                    self._upsert_batch(cohere_index, cohere_batch)
                    vectors_indexed += len(gemini_batch)
                    gemini_batch.clear()
                    cohere_batch.clear()

            except Exception as e:
                error_msg = f"Error embedding {img_path.name}: {e}"
                logger.warning(error_msg)
                errors.append(error_msg)
                self._log("ingest", "warn", error_msg)

        # Flush remaining
        if gemini_batch:
            self._upsert_batch(gemini_index, gemini_batch)
            self._upsert_batch(cohere_index, cohere_batch)
            vectors_indexed += len(gemini_batch)

        # Index documents if provided
        if documents_dir:
            doc_count = self._ingest_documents(
                profile, documents_dir, index_tier, gemini_index, cohere_index, errors
            )
            vectors_indexed += doc_count

        self._log(
            "ingest",
            "info",
            f"Indexing complete: {vectors_indexed} vectors in {gemini_index_name} + {cohere_index_name}",
        )

        return IngestResult(
            brand_slug=profile.brand_slug,
            vectors_indexed=vectors_indexed,
            gemini_index=gemini_index_name,
            cohere_index=cohere_index_name,
            errors=errors,
        )

    def _ingest_documents(
        self,
        profile: BrandProfile,
        documents_dir: str,
        index_tier: str,
        gemini_index,
        cohere_index,
        errors: list[str],
    ) -> int:
        """Ingest text documents using Gemini Embedding 2 for both indexes.

        Documents are embedded as text (not images), so both Gemini and Cohere
        can handle them natively without captioning.
        """
        docs_path = Path(documents_dir)
        if not docs_path.exists():
            self._log("ingest", "warn", f"Documents directory not found: {documents_dir}")
            return 0

        doc_files = sorted(
            f for f in docs_path.rglob("*") if f.suffix.lower() in DOCUMENT_EXTENSIONS
        )

        self._log("ingest", "info", f"Found {len(doc_files)} documents in {documents_dir}")

        count = 0
        gemini_batch = []
        cohere_batch = []

        for doc_path in doc_files:
            try:
                # For now, read text content directly (PDF support would need extraction)
                if doc_path.suffix.lower() in {".md", ".txt"}:
                    text = doc_path.read_text(encoding="utf-8")
                else:
                    self._log("ingest", "warn", f"Skipping non-text document: {doc_path.name}")
                    continue

                # Chunk long documents (simple split at ~1000 chars)
                chunks = self._chunk_text(text, max_chars=1000)

                for chunk_idx, chunk in enumerate(chunks):
                    result = self._embed.embed_text(chunk)
                    vec_id = self._make_vector_id(
                        profile.brand_slug, doc_path, suffix=f"_chunk{chunk_idx}"
                    )

                    metadata = {
                        "brand": profile.brand_slug,
                        "filename": doc_path.name,
                        "chunk_index": chunk_idx,
                        "tier": index_tier,
                        "type": "document",
                    }

                    gemini_batch.append((vec_id, result.gemini_768, metadata))
                    cohere_batch.append((vec_id, result.cohere_1536, metadata))

                    if len(gemini_batch) >= BATCH_SIZE:
                        self._upsert_batch(gemini_index, gemini_batch)
                        self._upsert_batch(cohere_index, cohere_batch)
                        count += len(gemini_batch)
                        gemini_batch.clear()
                        cohere_batch.clear()

            except Exception as e:
                error_msg = f"Error indexing document {doc_path.name}: {e}"
                errors.append(error_msg)
                self._log("ingest", "warn", error_msg)

        if gemini_batch:
            self._upsert_batch(gemini_index, gemini_batch)
            self._upsert_batch(cohere_index, cohere_batch)
            count += len(gemini_batch)

        return count

    def _upsert_batch(self, index, batch: list[tuple]) -> None:
        """Upsert a batch of vectors to a Pinecone index."""
        vectors = [(vid, vec, meta) for vid, vec, meta in batch]
        index.upsert(vectors=vectors)

    def _make_vector_id(self, brand_slug: str, file_path: Path, suffix: str = "") -> str:
        """Generate a stable, unique vector ID from brand + file path."""
        content = f"{brand_slug}:{file_path.name}{suffix}"
        return hashlib.sha256(content.encode()).hexdigest()[:32]

    def _chunk_text(self, text: str, max_chars: int = 1000) -> list[str]:
        """Split text into chunks, trying to break at paragraph boundaries."""
        paragraphs = text.split("\n\n")
        chunks = []
        current = ""

        for para in paragraphs:
            if len(current) + len(para) > max_chars and current:
                chunks.append(current.strip())
                current = para
            else:
                current = current + "\n\n" + para if current else para

        if current.strip():
            chunks.append(current.strip())

        return chunks if chunks else [text]

    def _default_log(self, stage: str, level: str, message: str) -> None:
        getattr(logger, level, logger.info)(message)
