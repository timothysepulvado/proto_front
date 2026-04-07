"""Pixel-level image analyzer for brand compliance.

Ported from Brand_linter image_analyzer.py. No embedding dependency — this
performs direct pixel analysis: saturation, brightness, whitespace, clutter,
dominant colors, and palette matching.
"""

import logging
from collections import Counter
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image

from brand_engine.core.models import PixelAnalysis

logger = logging.getLogger(__name__)


class ImageAnalyzer:
    """Analyzes images at the pixel level for brand compliance signals.

    This complements the embedding-based retrieval with concrete visual metrics
    that embeddings might miss: exact color matches, whitespace ratios, clutter.
    """

    def analyze(
        self,
        image_path: str,
        brand_palette: Optional[list[str]] = None,
    ) -> PixelAnalysis:
        """Run pixel analysis on an image.

        Args:
            image_path: Path to the image file.
            brand_palette: Optional list of hex color codes for palette matching.

        Returns:
            PixelAnalysis with saturation, brightness, whitespace, clutter, colors.
        """
        img = Image.open(image_path).convert("RGB")
        pixels = np.array(img)

        # Convert to HSV for saturation/brightness analysis
        hsv = self._rgb_to_hsv(pixels)

        saturation = hsv[:, :, 1]
        brightness = hsv[:, :, 2]

        # Dominant colors (quantize to 8 colors)
        dominant_colors = self._extract_dominant_colors(img, n_colors=8)

        # Whitespace ratio (pixels with brightness > 0.9 and saturation < 0.1)
        whitespace_mask = (brightness > 0.9) & (saturation < 0.1)
        whitespace_ratio = float(np.mean(whitespace_mask))

        # Clutter score (based on edge density)
        clutter_score = self._compute_clutter(pixels)

        # Palette match
        palette_match = None
        if brand_palette:
            palette_match = self._compute_palette_match(dominant_colors, brand_palette)

        result = PixelAnalysis(
            saturation_mean=float(np.mean(saturation)),
            saturation_std=float(np.std(saturation)),
            brightness_mean=float(np.mean(brightness)),
            brightness_std=float(np.std(brightness)),
            whitespace_ratio=whitespace_ratio,
            clutter_score=clutter_score,
            dominant_colors=dominant_colors,
            palette_match=palette_match,
        )

        logger.info(
            "Pixel analysis: sat=%.2f, bright=%.2f, whitespace=%.2f, clutter=%.2f",
            result.saturation_mean,
            result.brightness_mean,
            result.whitespace_ratio,
            result.clutter_score,
        )

        return result

    def _rgb_to_hsv(self, rgb: np.ndarray) -> np.ndarray:
        """Convert RGB array to HSV (all values 0-1)."""
        rgb_float = rgb.astype(np.float32) / 255.0

        r, g, b = rgb_float[:, :, 0], rgb_float[:, :, 1], rgb_float[:, :, 2]

        max_c = np.maximum(np.maximum(r, g), b)
        min_c = np.minimum(np.minimum(r, g), b)
        delta = max_c - min_c

        # Hue
        h = np.zeros_like(max_c)
        mask = delta > 0

        r_mask = mask & (max_c == r)
        g_mask = mask & (max_c == g) & ~r_mask
        b_mask = mask & ~r_mask & ~g_mask

        h[r_mask] = ((g[r_mask] - b[r_mask]) / delta[r_mask]) % 6
        h[g_mask] = ((b[g_mask] - r[g_mask]) / delta[g_mask]) + 2
        h[b_mask] = ((r[b_mask] - g[b_mask]) / delta[b_mask]) + 4

        h = h / 6.0

        # Saturation
        s = np.where(max_c > 0, delta / max_c, 0)

        # Value = max_c
        return np.stack([h, s, max_c], axis=2)

    def _extract_dominant_colors(self, img: Image.Image, n_colors: int = 8) -> list[str]:
        """Extract dominant colors by quantizing the image."""
        # Resize for speed
        small = img.resize((100, 100), Image.Resampling.LANCZOS)
        quantized = small.quantize(colors=n_colors, method=Image.Quantize.MEDIANCUT)
        palette = quantized.getpalette()

        if not palette:
            return []

        colors = []
        for i in range(n_colors):
            r, g, b = palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]
            colors.append(f"#{r:02x}{g:02x}{b:02x}")

        return colors

    def _compute_clutter(self, pixels: np.ndarray) -> float:
        """Estimate visual clutter using a simple gradient-based edge density measure."""
        gray = np.mean(pixels.astype(np.float32), axis=2)

        # Sobel-like gradient approximation
        dx = np.abs(np.diff(gray, axis=1))
        dy = np.abs(np.diff(gray, axis=0))

        # Edge density = fraction of pixels with strong gradients
        threshold = 30.0
        edge_ratio_x = float(np.mean(dx > threshold))
        edge_ratio_y = float(np.mean(dy > threshold))

        return (edge_ratio_x + edge_ratio_y) / 2.0

    def _compute_palette_match(
        self, image_colors: list[str], brand_palette: list[str]
    ) -> float:
        """Compute how well the image's dominant colors match the brand palette.

        Returns a score from 0 (no match) to 1 (perfect match).
        Uses CIE color distance approximation in RGB space.
        """
        if not image_colors or not brand_palette:
            return 0.0

        brand_rgb = [self._hex_to_rgb(c) for c in brand_palette]
        image_rgb = [self._hex_to_rgb(c) for c in image_colors]

        total_distance = 0.0
        for img_color in image_rgb:
            min_dist = min(self._color_distance(img_color, bc) for bc in brand_rgb)
            total_distance += min_dist

        # Normalize: max possible distance is ~441 (sqrt(255^2 * 3))
        avg_distance = total_distance / len(image_rgb)
        match_score = max(0.0, 1.0 - (avg_distance / 200.0))

        return round(match_score, 4)

    def _hex_to_rgb(self, hex_color: str) -> tuple[int, int, int]:
        """Convert hex color string to RGB tuple."""
        h = hex_color.lstrip("#")
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))

    def _color_distance(
        self, c1: tuple[int, int, int], c2: tuple[int, int, int]
    ) -> float:
        """Euclidean distance in RGB space."""
        return float(np.sqrt(sum((a - b) ** 2 for a, b in zip(c1, c2))))
