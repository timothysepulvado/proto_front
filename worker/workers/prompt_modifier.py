"""
Prompt Modifier Worker

Modifies prompts based on rejection reasons to improve output quality.
Handles model-specific prompt formatting for different AI models.
"""

from typing import Dict, List, Tuple, Optional


# Rejection categories with their associated prompts
REJECTION_CATEGORIES: Dict[str, Dict[str, str]] = {
    "too_dark": {
        "label": "Too Dark",
        "negative_prompt": "dark lighting, shadows, underexposed, dim, murky",
        "positive_guidance": "bright natural lighting, well-lit environment"
    },
    "too_bright": {
        "label": "Too Bright",
        "negative_prompt": "overexposed, washed out, harsh light, blown out highlights",
        "positive_guidance": "soft natural lighting, balanced exposure"
    },
    "wrong_colors": {
        "label": "Wrong Colors",
        "negative_prompt": "neon colors, saturated colors, vibrant colors, harsh colors",
        "positive_guidance": "natural color palette, muted tones, brand colors"
    },
    "off_brand": {
        "label": "Off Brand",
        "negative_prompt": "off-brand aesthetic, inconsistent style, mismatched vibe",
        "positive_guidance": "brand-aligned aesthetic, consistent styling"
    },
    "wrong_composition": {
        "label": "Wrong Composition",
        "negative_prompt": "poor framing, bad crop, awkward angles, unbalanced",
        "positive_guidance": "well-composed, balanced framing, rule of thirds"
    },
    "cluttered": {
        "label": "Too Cluttered",
        "negative_prompt": "busy background, clutter, distracting elements, messy",
        "positive_guidance": "clean background, minimal distractions, organized"
    },
    "wrong_model": {
        "label": "Wrong Model/Person",
        "negative_prompt": "different person, wrong model, inconsistent face",
        "positive_guidance": "consistent model appearance"
    },
    "wrong_outfit": {
        "label": "Wrong Outfit",
        "negative_prompt": "wrong clothing, incorrect outfit, mismatched attire",
        "positive_guidance": "correct outfit as specified"
    },
    "quality_issue": {
        "label": "Quality Issue",
        "negative_prompt": "artifacts, blur, distortion, noise, compression, low quality",
        "positive_guidance": "high quality, sharp, clean, detailed"
    },
    "other": {
        "label": "Other",
        "negative_prompt": "",
        "positive_guidance": ""
    }
}


class PromptModifier:
    """
    Modifies prompts based on rejection reasons.

    Handles model-specific formatting:
    - Nano: Embeds guidance in main prompt text
    - Veo: Uses separate negative_prompt parameter
    - Sora: Premium model with enhanced prompt structure
    """

    def __init__(self, custom_categories: Optional[Dict[str, Dict[str, str]]] = None):
        """
        Initialize the prompt modifier.

        Args:
            custom_categories: Optional custom rejection categories to add/override
        """
        self.categories = {**REJECTION_CATEGORIES}
        if custom_categories:
            self.categories.update(custom_categories)

    def get_negative_terms(self, rejection_reasons: List[str]) -> List[str]:
        """
        Map rejection categories to negative prompt terms.

        Args:
            rejection_reasons: List of rejection category IDs

        Returns:
            List of negative prompt terms
        """
        terms = []
        for reason in rejection_reasons:
            category = self.categories.get(reason)
            if category and category.get("negative_prompt"):
                terms.append(category["negative_prompt"])
        return terms

    def get_positive_guidance(self, rejection_reasons: List[str]) -> List[str]:
        """
        Get positive guidance based on rejection reasons.

        Args:
            rejection_reasons: List of rejection category IDs

        Returns:
            List of positive guidance terms
        """
        guidance = []
        for reason in rejection_reasons:
            category = self.categories.get(reason)
            if category and category.get("positive_guidance"):
                guidance.append(category["positive_guidance"])
        return guidance

    def modify_prompt(
        self,
        original_prompt: str,
        rejection_reasons: List[str],
        model_type: str,
        additional_negatives: Optional[List[str]] = None
    ) -> Tuple[str, str]:
        """
        Modify prompt based on rejection reasons and model type.

        Args:
            original_prompt: The original generation prompt
            rejection_reasons: List of rejection category IDs
            model_type: AI model type ("nano", "veo", "sora")
            additional_negatives: Optional additional negative terms

        Returns:
            Tuple of (modified_prompt, negative_prompt)

        Model-specific handling:
        - Nano: Append guidance to main prompt, include negatives inline
        - Veo: Use separate negative_prompt parameter
        - Sora: Enhanced structure with quality modifiers
        """
        negative_terms = self.get_negative_terms(rejection_reasons)
        positive_guidance = self.get_positive_guidance(rejection_reasons)

        if additional_negatives:
            negative_terms.extend(additional_negatives)

        # Remove duplicates while preserving order
        negative_terms = list(dict.fromkeys(negative_terms))
        positive_guidance = list(dict.fromkeys(positive_guidance))

        if model_type == "nano":
            return self._format_nano_prompt(original_prompt, positive_guidance, negative_terms)
        elif model_type == "veo":
            return self._format_veo_prompt(original_prompt, positive_guidance, negative_terms)
        elif model_type == "sora":
            return self._format_sora_prompt(original_prompt, positive_guidance, negative_terms)
        else:
            # Default: basic modification
            return self._format_default_prompt(original_prompt, positive_guidance, negative_terms)

    def _format_nano_prompt(
        self,
        prompt: str,
        positive: List[str],
        negative: List[str]
    ) -> Tuple[str, str]:
        """
        Format prompt for Nano model.
        Nano embeds everything in the main prompt text.
        """
        parts = [prompt]

        if positive:
            parts.append(". ".join(positive))

        if negative:
            parts.append(f"Avoid: {', '.join(negative)}.")

        modified = ". ".join(parts)
        # Nano doesn't use separate negative prompt
        return modified, ""

    def _format_veo_prompt(
        self,
        prompt: str,
        positive: List[str],
        negative: List[str]
    ) -> Tuple[str, str]:
        """
        Format prompt for Veo model.
        Veo uses separate negative_prompt parameter.
        """
        parts = [prompt]

        if positive:
            parts.append(". ".join(positive))

        modified = ". ".join(parts) + "."
        negative_prompt = ", ".join(negative) if negative else ""

        return modified, negative_prompt

    def _format_sora_prompt(
        self,
        prompt: str,
        positive: List[str],
        negative: List[str]
    ) -> Tuple[str, str]:
        """
        Format prompt for Sora model.
        Sora supports enhanced prompt structure with quality modifiers.
        """
        # Add quality enhancers for Sora
        quality_modifiers = ["professional quality", "cinematic", "detailed"]

        parts = [prompt]
        parts.extend(quality_modifiers)

        if positive:
            parts.extend(positive)

        modified = ", ".join(parts)
        negative_prompt = ", ".join(negative) if negative else ""

        return modified, negative_prompt

    def _format_default_prompt(
        self,
        prompt: str,
        positive: List[str],
        negative: List[str]
    ) -> Tuple[str, str]:
        """Default prompt formatting."""
        parts = [prompt]

        if positive:
            parts.append(", ".join(positive))

        modified = ". ".join(parts)
        negative_prompt = ", ".join(negative) if negative else ""

        return modified, negative_prompt

    def enhance_prompt_for_retry(
        self,
        prompt: str,
        retry_count: int,
        model_type: str
    ) -> str:
        """
        Enhance prompt based on retry count.
        Adds progressive quality modifiers for each retry.

        Args:
            prompt: Current prompt
            retry_count: Number of retries so far
            model_type: AI model type

        Returns:
            Enhanced prompt
        """
        # Progressive enhancements
        enhancements = {
            1: ["high quality", "detailed"],
            2: ["professional", "studio quality", "sharp focus"],
            3: ["masterful", "exceptional quality", "perfect lighting"]
        }

        additions = enhancements.get(retry_count, enhancements[3])

        if model_type == "nano":
            return f"{prompt}. {', '.join(additions)}."
        else:
            return f"{prompt}, {', '.join(additions)}"

    @staticmethod
    def get_category_info(category_id: str) -> Optional[Dict[str, str]]:
        """
        Get information about a rejection category.

        Args:
            category_id: The category ID

        Returns:
            Category info dict or None if not found
        """
        return REJECTION_CATEGORIES.get(category_id)

    @staticmethod
    def list_categories() -> List[Dict[str, str]]:
        """
        List all available rejection categories.

        Returns:
            List of category info dicts with id included
        """
        return [
            {"id": cat_id, **cat_info}
            for cat_id, cat_info in REJECTION_CATEGORIES.items()
        ]
