"""Unified embedding client for Gemini Embedding 2 and Cohere v4.

Replaces the old CLIP + E5 + Cohere triple-model stack with:
- Gemini Embedding 2 at 768D (via MRL) — natively multimodal (image + text)
- Cohere v4 at 1536D — complementary semantic diversity

Gemini subsumes both CLIP (visual) and E5 (text-semantic) in a single model.

Cohere access supports two backends:
1. AWS Bedrock (preferred) — uses existing AWS credentials, model: us.cohere.embed-v4:0
2. Direct Cohere API — uses COHERE_API_KEY, model: embed-v4.0
"""

import logging
import os
from pathlib import Path
from typing import Optional, Union

import cohere
from google import genai
from PIL import Image

# Suppress DecompressionBomb warnings for large brand reference images
# (some JK lifestyle shots are 100M+ pixels — valid, not malicious)
Image.MAX_IMAGE_PIXELS = None

from brand_engine.core.models import EmbeddingResult

logger = logging.getLogger(__name__)

# Singleton instance
_instance: Optional["EmbeddingClient"] = None


def get_embedding_client() -> "EmbeddingClient":
    """Get or create the singleton EmbeddingClient."""
    global _instance
    if _instance is None:
        _instance = EmbeddingClient()
    return _instance


class EmbeddingClient:
    """Manages Gemini Embedding 2 and Cohere v4 connections as singletons.

    Gemini Embedding 2:
      - Natively embeds images and text into the same 3072D space
      - Uses MRL (Matryoshka Representation Learning) to output 768D
      - Replaces both CLIP (visual) and E5 (text-semantic)

    Cohere v4:
      - Text-only embeddings at 1536D
      - For images: caption with Gemini first, then embed caption
      - Provides ensemble diversity from a different training corpus
      - Accessed via AWS Bedrock (preferred) or direct API key
    """

    GEMINI_MODEL = "gemini-embedding-2-preview"
    GEMINI_OUTPUT_DIM = 768

    # Cohere model IDs differ by backend
    COHERE_MODEL_DIRECT = "embed-v4.0"
    COHERE_MODEL_BEDROCK = "us.cohere.embed-v4:0"

    COHERE_INPUT_TYPE_SEARCH_DOC = "search_document"
    COHERE_INPUT_TYPE_SEARCH_QUERY = "search_query"
    GEMINI_CAPTION_MODEL = "gemini-2.5-flash"

    def __init__(self):
        """Initialize API clients from environment variables.

        Gemini: requires GOOGLE_GENAI_API_KEY or GEMINI_API_KEY.
        Cohere: prefers AWS Bedrock (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY),
                falls back to direct API (COHERE_API_KEY).
        """
        # Gemini — accept either env var name
        google_api_key = os.getenv("GOOGLE_GENAI_API_KEY") or os.getenv("GEMINI_API_KEY")
        if not google_api_key:
            raise ValueError(
                "GOOGLE_GENAI_API_KEY or GEMINI_API_KEY environment variable is required"
            )
        self._genai_client = genai.Client(api_key=google_api_key)

        # Cohere — prefer Bedrock, fall back to direct API
        self._cohere_client: Union[cohere.BedrockClient, cohere.Client]
        self._cohere_model: str

        aws_access_key = os.getenv("AWS_ACCESS_KEY_ID")
        aws_secret_key = os.getenv("AWS_SECRET_ACCESS_KEY")
        cohere_api_key = os.getenv("COHERE_API_KEY")

        if aws_access_key and aws_secret_key:
            aws_region = os.getenv("AWS_DEFAULT_REGION", os.getenv("AWS_REGION", "us-east-2"))
            self._cohere_client = cohere.BedrockClient(
                aws_access_key=aws_access_key,
                aws_secret_key=aws_secret_key,
                aws_session_token=os.getenv("AWS_SESSION_TOKEN"),
                aws_region=aws_region,
            )
            self._cohere_model = self.COHERE_MODEL_BEDROCK
            logger.info(
                "Cohere initialized via AWS Bedrock (region=%s, model=%s)",
                aws_region, self._cohere_model,
            )
        elif cohere_api_key:
            self._cohere_client = cohere.Client(api_key=cohere_api_key)
            self._cohere_model = self.COHERE_MODEL_DIRECT
            logger.info("Cohere initialized via direct API (model=%s)", self._cohere_model)
        else:
            raise ValueError(
                "Cohere credentials required: set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY "
                "(for Bedrock) or COHERE_API_KEY (for direct API)"
            )

        logger.info(
            "EmbeddingClient initialized: Gemini=%s (%dD), Cohere=%s (1536D)",
            self.GEMINI_MODEL,
            self.GEMINI_OUTPUT_DIM,
            self._cohere_model,
        )

    def embed_image(self, image_path: str) -> EmbeddingResult:
        """Embed an image using both Gemini and Cohere.

        Gemini: embeds the image directly (natively multimodal).
        Cohere: captions the image with Gemini, then embeds the caption text.

        Args:
            image_path: Path to the image file.

        Returns:
            EmbeddingResult with gemini_768 and cohere_1536 vectors.
        """
        image_path = str(Path(image_path).resolve())

        # Gemini: embed image directly
        gemini_vec = self._embed_image_gemini(image_path)

        # Cohere: caption → embed
        caption = self._caption_image(image_path)
        cohere_vec = self._embed_text_cohere(caption, self.COHERE_INPUT_TYPE_SEARCH_DOC)

        return EmbeddingResult(gemini_768=gemini_vec, cohere_1536=cohere_vec)

    def embed_text(self, text: str, is_query: bool = False) -> EmbeddingResult:
        """Embed text using both Gemini and Cohere.

        Args:
            text: The text to embed.
            is_query: If True, use search_query input type for Cohere (for retrieval queries).
                      If False, use search_document (for indexing).

        Returns:
            EmbeddingResult with gemini_768 and cohere_1536 vectors.
        """
        gemini_vec = self._embed_text_gemini(text)

        cohere_input_type = (
            self.COHERE_INPUT_TYPE_SEARCH_QUERY if is_query else self.COHERE_INPUT_TYPE_SEARCH_DOC
        )
        cohere_vec = self._embed_text_cohere(text, cohere_input_type)

        return EmbeddingResult(gemini_768=gemini_vec, cohere_1536=cohere_vec)

    def embed_image_gemini_only(self, image_path: str) -> list[float]:
        """Embed image with Gemini only (for fast visual-only queries)."""
        return self._embed_image_gemini(str(Path(image_path).resolve()))

    def embed_text_gemini_only(self, text: str) -> list[float]:
        """Embed text with Gemini only."""
        return self._embed_text_gemini(text)

    # ---- Internal methods ----

    def _embed_image_gemini(self, image_path: str) -> list[float]:
        """Embed an image using Gemini Embedding 2 with MRL at 768D."""
        img = Image.open(image_path)

        result = self._genai_client.models.embed_content(
            model=self.GEMINI_MODEL,
            contents=img,
            config={
                "output_dimensionality": self.GEMINI_OUTPUT_DIM,
            },
        )
        return result.embeddings[0].values

    def _embed_text_gemini(self, text: str) -> list[float]:
        """Embed text using Gemini Embedding 2 with MRL at 768D."""
        result = self._genai_client.models.embed_content(
            model=self.GEMINI_MODEL,
            contents=text,
            config={
                "output_dimensionality": self.GEMINI_OUTPUT_DIM,
            },
        )
        return result.embeddings[0].values

    def _embed_text_cohere(self, text: str, input_type: str) -> list[float]:
        """Embed text using Cohere v4 at 1536D."""
        result = self._cohere_client.embed(
            texts=[text],
            model=self._cohere_model,
            input_type=input_type,
            embedding_types=["float"],
        )
        return result.embeddings.float_[0]

    def _caption_image(self, image_path: str) -> str:
        """Generate a text caption for an image using Gemini Flash.

        This caption is used as input to Cohere (which is text-only).
        """
        img = Image.open(image_path)

        response = self._genai_client.models.generate_content(
            model=self.GEMINI_CAPTION_MODEL,
            contents=[
                "Describe this image in detail for brand compliance analysis. "
                "Include: visual style, color palette, composition, mood, "
                "subject matter, lighting, and any text or logos visible.",
                img,
            ],
        )
        caption = response.text.strip()
        logger.debug("Caption for %s: %s", Path(image_path).name, caption[:100])
        return caption

    def check_connectivity(self) -> dict[str, bool]:
        """Test connectivity to both embedding APIs."""
        result = {"gemini": False, "cohere": False}

        try:
            test = self._genai_client.models.embed_content(
                model=self.GEMINI_MODEL,
                contents="connectivity test",
                config={"output_dimensionality": self.GEMINI_OUTPUT_DIM},
            )
            result["gemini"] = len(test.embeddings[0].values) == self.GEMINI_OUTPUT_DIM
        except Exception as e:
            logger.warning("Gemini connectivity check failed: %s", e)

        try:
            test = self._cohere_client.embed(
                texts=["connectivity test"],
                model=self._cohere_model,
                input_type="search_query",
                embedding_types=["float"],
            )
            result["cohere"] = len(test.embeddings.float_[0]) == 1536
        except Exception as e:
            logger.warning("Cohere connectivity check failed: %s", e)

        return result
