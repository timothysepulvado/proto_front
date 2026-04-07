"""Prompt evolution engine — versioned prompts with scoring and auto-evolution."""

import json
import sys
from pathlib import Path
from typing import Callable, Optional, List, Dict, Any

sys.path.insert(0, str(Path(__file__).parent.parent))
from config import SUPABASE_URL, SUPABASE_KEY, PROMPT_AUTO_EVOLVE_THRESHOLD, PROMPT_PASSING_THRESHOLD, MAX_EVOLUTIONS_PER_RUN

from supabase import create_client


class PromptEvolver:
    """Manages versioned prompt templates with scoring and evolution."""

    def __init__(self, supabase_client, log_callback: Callable[[str, str, str], None]):
        self.supabase = supabase_client
        self.log = log_callback
        self.evolutions_this_run = 0

    def get_active_prompt(self, client_id: str, stage: str = "generate",
                          campaign_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Get the current active prompt template for a client/stage."""
        query = (
            self.supabase.table("prompt_templates")
            .select("*")
            .eq("client_id", client_id)
            .eq("stage", stage)
            .eq("is_active", True)
            .order("version", desc=True)
            .limit(1)
        )
        if campaign_id:
            query = query.eq("campaign_id", campaign_id)

        result = query.execute()
        if result.data:
            self.log("prompt", "info", f"Active prompt v{result.data[0]['version']}: {result.data[0]['prompt_text'][:60]}...")
            return result.data[0]
        return None

    def seed_prompt(self, client_id: str, prompt_text: str, stage: str = "generate",
                    campaign_id: Optional[str] = None) -> Dict[str, Any]:
        """Create initial prompt template if none exists."""
        existing = self.get_active_prompt(client_id, stage, campaign_id)
        if existing:
            return existing

        data = {
            "client_id": client_id,
            "stage": stage,
            "version": 1,
            "prompt_text": prompt_text,
            "is_active": True,
            "source": "auto_seed",
        }
        if campaign_id:
            data["campaign_id"] = campaign_id

        result = self.supabase.table("prompt_templates").insert(data).execute()
        self.log("prompt", "info", f"Seeded initial prompt v1 for {client_id}/{stage}")
        return result.data[0]

    def record_score(self, prompt_id: str, run_id: str, score: float,
                     gate_decision: Optional[str] = None,
                     artifact_id: Optional[str] = None,
                     feedback: Optional[str] = None) -> Dict[str, Any]:
        """Record a score for a prompt usage."""
        result = self.supabase.table("prompt_scores").insert({
            "prompt_id": prompt_id,
            "run_id": run_id,
            "score": score,
            "gate_decision": gate_decision,
            "artifact_id": artifact_id,
            "feedback": feedback,
        }).execute()

        self.log("prompt", "info", f"Recorded score {score:.3f} for prompt {prompt_id[:8]}...")
        return result.data[0]

    def get_prompt_history(self, prompt_id: str) -> List[Dict[str, Any]]:
        """Get score history for a prompt."""
        result = (
            self.supabase.table("prompt_scores")
            .select("*")
            .eq("prompt_id", prompt_id)
            .order("created_at", desc=True)
            .limit(20)
            .execute()
        )
        return result.data

    def maybe_evolve(self, prompt_id: str, run_id: str, score: float,
                     rejection_categories: Optional[List[str]] = None,
                     feedback: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Check if prompt should evolve based on score, and evolve if needed."""
        if self.evolutions_this_run >= MAX_EVOLUTIONS_PER_RUN:
            self.log("prompt", "info", f"Max evolutions ({MAX_EVOLUTIONS_PER_RUN}) reached for this run")
            return None

        if score >= PROMPT_PASSING_THRESHOLD:
            self.log("prompt", "info", f"Score {score:.3f} >= {PROMPT_PASSING_THRESHOLD} — prompt is passing, no evolution needed")
            return None

        if score >= PROMPT_AUTO_EVOLVE_THRESHOLD:
            self.log("prompt", "info", f"Score {score:.3f} in review band — flagging for HITL evolution")
            return None

        # Score below threshold — auto-evolve
        self.log("prompt", "info", f"Score {score:.3f} < {PROMPT_AUTO_EVOLVE_THRESHOLD} — triggering auto-evolution")
        return self._evolve_prompt(prompt_id, run_id, score, rejection_categories, feedback, trigger="auto")

    def _evolve_prompt(self, parent_prompt_id: str, run_id: str, score_before: float,
                       rejection_categories: Optional[List[str]] = None,
                       feedback: Optional[str] = None,
                       trigger: str = "auto") -> Optional[Dict[str, Any]]:
        """Create an evolved version of a prompt."""
        # Get parent prompt
        parent = self.supabase.table("prompt_templates").select("*").eq("id", parent_prompt_id).single().execute()
        if not parent.data:
            self.log("prompt", "error", f"Parent prompt {parent_prompt_id} not found")
            return None

        parent_data = parent.data
        old_text = parent_data["prompt_text"]

        # Build evolved prompt using rejection categories
        new_text = self._heuristic_evolve(old_text, rejection_categories, feedback)

        # Deactivate parent
        self.supabase.table("prompt_templates").update({"is_active": False}).eq("id", parent_prompt_id).execute()

        # Create new version
        new_version = parent_data["version"] + 1
        new_prompt = self.supabase.table("prompt_templates").insert({
            "client_id": parent_data["client_id"],
            "campaign_id": parent_data.get("campaign_id"),
            "stage": parent_data["stage"],
            "version": new_version,
            "prompt_text": new_text,
            "parent_id": parent_prompt_id,
            "is_active": True,
            "source": trigger,
            "metadata": {
                "rejection_categories": rejection_categories,
                "score_before": score_before,
                "feedback": feedback,
            },
        }).execute()

        # Log evolution
        self.supabase.table("prompt_evolution_log").insert({
            "parent_prompt_id": parent_prompt_id,
            "child_prompt_id": new_prompt.data[0]["id"],
            "run_id": run_id,
            "trigger": trigger,
            "reason": feedback or f"Score {score_before:.3f} below threshold",
            "rejection_categories": rejection_categories,
            "score_before": score_before,
        }).execute()

        self.evolutions_this_run += 1
        self.log("prompt", "info",
                 f"Evolved prompt v{parent_data['version']} → v{new_version} "
                 f"(trigger: {trigger}, categories: {rejection_categories})")

        return new_prompt.data[0]

    def _heuristic_evolve(self, old_text: str, rejection_categories: Optional[List[str]] = None,
                          feedback: Optional[str] = None) -> str:
        """Evolve a prompt using heuristic rules from rejection categories."""
        if not rejection_categories:
            # Generic improvement
            return f"{old_text}. Improve quality and brand alignment."

        # Load rejection category guidance from Supabase
        result = (
            self.supabase.table("rejection_categories")
            .select("name, negative_prompt, positive_guidance")
            .in_("name", rejection_categories)
            .execute()
        )

        negative_parts = []
        positive_parts = []
        for cat in result.data:
            if cat.get("negative_prompt"):
                negative_parts.append(cat["negative_prompt"])
            if cat.get("positive_guidance"):
                positive_parts.append(cat["positive_guidance"])

        evolved = old_text
        if negative_parts:
            evolved += f". Avoid: {', '.join(negative_parts)}"
        if positive_parts:
            evolved += f". Instead: {', '.join(positive_parts)}"
        if feedback:
            evolved += f". Note: {feedback}"

        return evolved
