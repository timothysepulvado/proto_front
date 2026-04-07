"""RL threshold trainer: calibrates pass/fail/review bands from HITL decisions.

Ported from Brand_linter rl_trainer.py. Rewired from SQLite to Supabase.
Adjusted for 2-model (Gemini+Cohere) weights instead of 3-model (CLIP+E5+Cohere).
"""

import logging
import os
from typing import Optional

import numpy as np
from supabase import Client, create_client

from brand_engine.core.models import BrandProfile, BrandThresholds

logger = logging.getLogger(__name__)


class ThresholdTrainer:
    """Calibrates brand compliance thresholds using HITL decision history.

    Reads approved/rejected decisions from Supabase `hitl_decisions` table,
    analyzes the distribution of z-scores for each decision outcome, and
    proposes updated thresholds that would maximize agreement with human reviewers.
    """

    # Minimum decisions required before proposing threshold changes
    MIN_DECISIONS = 10
    # How much to shift thresholds per training cycle (learning rate)
    LEARNING_RATE = 0.1

    def __init__(self, supabase_client: Optional[Client] = None):
        if supabase_client:
            self._supabase = supabase_client
        else:
            url = os.getenv("SUPABASE_URL")
            key = os.getenv("SUPABASE_KEY")
            if not url or not key:
                raise ValueError("SUPABASE_URL and SUPABASE_KEY required")
            self._supabase = create_client(url, key)

    def train(self, brand_slug: str, profile: BrandProfile) -> dict:
        """Analyze HITL decisions and propose threshold updates.

        Args:
            brand_slug: Brand to train on.
            profile: Current brand profile with thresholds.

        Returns:
            dict with:
              - current_thresholds: BrandThresholds
              - proposed_thresholds: BrandThresholds
              - stats: decision counts, accuracy metrics
              - recommendation: human-readable recommendation
        """
        # Fetch HITL decisions from Supabase
        decisions = self._fetch_decisions(brand_slug)

        if len(decisions) < self.MIN_DECISIONS:
            return {
                "current_thresholds": profile.thresholds,
                "proposed_thresholds": profile.thresholds,
                "stats": {"total_decisions": len(decisions)},
                "recommendation": (
                    f"Need at least {self.MIN_DECISIONS} HITL decisions to train. "
                    f"Currently have {len(decisions)}."
                ),
            }

        # Separate by decision outcome
        approved_scores = []
        rejected_scores = []

        for d in decisions:
            scores = d.get("grade_scores") or {}
            combined_z = scores.get("fused_z") or scores.get("combined_z")

            if combined_z is None:
                continue

            if d["decision"] == "approved":
                approved_scores.append(combined_z)
            elif d["decision"] == "rejected":
                rejected_scores.append(combined_z)

        if not approved_scores or not rejected_scores:
            return {
                "current_thresholds": profile.thresholds,
                "proposed_thresholds": profile.thresholds,
                "stats": {
                    "total_decisions": len(decisions),
                    "approved": len(approved_scores),
                    "rejected": len(rejected_scores),
                },
                "recommendation": "Need both approved and rejected decisions to calibrate.",
            }

        # Calculate proposed thresholds
        approved_arr = np.array(approved_scores)
        rejected_arr = np.array(rejected_scores)

        # Auto-pass: should capture most approved items
        # Set at mean of approved minus 1 stddev
        proposed_pass = float(np.mean(approved_arr) - np.std(approved_arr))

        # Auto-fail: should capture most rejected items
        # Set at mean of rejected plus 1 stddev
        proposed_fail = float(np.mean(rejected_arr) + np.std(rejected_arr))

        # Ensure pass > fail (with a minimum gap)
        if proposed_pass <= proposed_fail:
            midpoint = (proposed_pass + proposed_fail) / 2
            proposed_pass = midpoint + 0.25
            proposed_fail = midpoint - 0.25

        # Apply learning rate (blend with current thresholds)
        current = profile.thresholds
        new_pass = current.auto_pass_z + self.LEARNING_RATE * (proposed_pass - current.auto_pass_z)
        new_fail = current.auto_fail_z + self.LEARNING_RATE * (proposed_fail - current.auto_fail_z)

        proposed = BrandThresholds(
            auto_pass_z=round(new_pass, 4),
            auto_fail_z=round(new_fail, 4),
            gemini_weight=current.gemini_weight,
            cohere_weight=current.cohere_weight,
        )

        # Calculate accuracy metrics
        current_accuracy = self._calc_accuracy(
            approved_scores, rejected_scores, current
        )
        proposed_accuracy = self._calc_accuracy(
            approved_scores, rejected_scores, proposed
        )

        stats = {
            "total_decisions": len(decisions),
            "approved": len(approved_scores),
            "rejected": len(rejected_scores),
            "approved_mean_z": float(np.mean(approved_arr)),
            "rejected_mean_z": float(np.mean(rejected_arr)),
            "current_accuracy": current_accuracy,
            "proposed_accuracy": proposed_accuracy,
        }

        improvement = proposed_accuracy - current_accuracy
        recommendation = (
            f"Proposed thresholds would improve accuracy by {improvement:.1%}. "
            f"Pass: {current.auto_pass_z:.3f} → {proposed.auto_pass_z:.3f}, "
            f"Fail: {current.auto_fail_z:.3f} → {proposed.auto_fail_z:.3f}."
        )

        if improvement <= 0:
            recommendation = "Current thresholds are optimal. No changes recommended."

        return {
            "current_thresholds": current,
            "proposed_thresholds": proposed,
            "stats": stats,
            "recommendation": recommendation,
        }

    def _fetch_decisions(self, brand_slug: str) -> list[dict]:
        """Fetch HITL decisions from Supabase for a brand."""
        # Join through runs → clients to filter by brand
        result = (
            self._supabase.table("hitl_decisions")
            .select("*, runs!inner(client_id, clients!inner(brand_slug))")
            .eq("runs.clients.brand_slug", brand_slug)
            .execute()
        )
        return result.data or []

    def _calc_accuracy(
        self,
        approved_scores: list[float],
        rejected_scores: list[float],
        thresholds: BrandThresholds,
    ) -> float:
        """Calculate how well thresholds agree with human decisions."""
        correct = 0
        total = 0

        for score in approved_scores:
            total += 1
            if score >= thresholds.auto_fail_z:  # Not auto-failed = correct
                correct += 1

        for score in rejected_scores:
            total += 1
            if score < thresholds.auto_pass_z:  # Not auto-passed = correct
                correct += 1

        return correct / total if total > 0 else 0.0
