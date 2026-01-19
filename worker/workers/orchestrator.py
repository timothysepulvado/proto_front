"""
Campaign Orchestrator Worker

Coordinates the generation feedback loop for campaigns:
1. Initial generation of all deliverables
2. Scoring through BDE/Brand Linter
3. Routing results (pass -> HITL, fail -> retry)
4. Prompt modification and regeneration
5. DNA update on final approval

Memory Architecture:
- Short-term: In-memory per-campaign rejection tracking
- Long-term: Pinecone indexes + brand_profiles.json
"""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, Dict, List, Optional, Any
from enum import Enum

from supabase import Client

from .prompt_modifier import PromptModifier
from .scoring_worker import ScoringWorker
from .generation_worker import GenerationWorker
from .dna_updater import DNAUpdater


class DeliverableStatus(Enum):
    PENDING = "pending"
    GENERATING = "generating"
    SCORING = "scoring"
    HITL = "hitl"
    APPROVED = "approved"
    FAILED = "failed"
    RETRY_QUEUED = "retry_queued"


@dataclass
class ItemMemory:
    """Short-term memory for a single deliverable item."""
    retry_count: int = 0
    rejection_reasons: List[str] = field(default_factory=list)
    negative_prompts: List[str] = field(default_factory=list)
    original_prompt: str = ""
    modified_prompt: str = ""
    scores: List[Dict[str, float]] = field(default_factory=list)


@dataclass
class CampaignShortTermMemory:
    """In-memory per-campaign rejection tracking."""
    campaign_id: str
    items: Dict[str, ItemMemory] = field(default_factory=dict)
    created_at: datetime = field(default_factory=datetime.utcnow)

    def get_item(self, item_id: str) -> ItemMemory:
        """Get or create memory for an item."""
        if item_id not in self.items:
            self.items[item_id] = ItemMemory()
        return self.items[item_id]

    def add_rejection(self, item_id: str, reasons: List[str], negative_prompts: List[str]):
        """Add rejection reasons and negative prompts for an item."""
        item = self.get_item(item_id)
        item.rejection_reasons.extend(reasons)
        item.negative_prompts.extend(negative_prompts)
        item.retry_count += 1


class CampaignOrchestrator:
    """
    Coordinates specialized workers for the generation feedback loop.

    Priorities:
    1. Brand Consistency - Ensure all outputs align with brand DNA
    2. Client Approval - Route to HITL for human verification
    3. Prompt Best Practices - Use model-specific optimizations
    """

    def __init__(
        self,
        supabase: Client,
        campaign_id: str,
        log_callback: Optional[Callable[[str, str, str], None]] = None
    ):
        """
        Initialize the orchestrator.

        Args:
            supabase: Supabase client for database operations
            campaign_id: UUID of the campaign to orchestrate
            log_callback: Optional callback for logging (stage, level, message)
        """
        self.supabase = supabase
        self.campaign_id = campaign_id
        self.log = log_callback or (lambda s, l, m: print(f"[{s}] [{l}] {m}"))

        # Short-term memory for this campaign
        self.memory = CampaignShortTermMemory(campaign_id=campaign_id)

        # Initialize specialized workers
        self.prompt_modifier = PromptModifier()
        self.scoring_worker = ScoringWorker(supabase, log_callback)
        self.generation_worker = GenerationWorker(supabase, log_callback)
        self.dna_updater = DNAUpdater(supabase, log_callback)

        # State tracking
        self.campaign: Optional[Dict[str, Any]] = None
        self.deliverables: List[Dict[str, Any]] = []
        self.retry_batch: List[str] = []  # IDs of deliverables to retry

    async def load_campaign(self) -> Dict[str, Any]:
        """Load campaign details from database."""
        self.log("orchestrator", "info", f"Loading campaign: {self.campaign_id}")

        result = self.supabase.table("campaigns").select("*").eq(
            "id", self.campaign_id
        ).single().execute()

        if not result.data:
            raise ValueError(f"Campaign not found: {self.campaign_id}")

        self.campaign = result.data

        # Load deliverables
        del_result = self.supabase.table("campaign_deliverables").select("*").eq(
            "campaign_id", self.campaign_id
        ).order("created_at").execute()

        self.deliverables = del_result.data or []

        self.log("orchestrator", "info", f"Loaded {len(self.deliverables)} deliverables")
        return self.campaign

    def pending_items(self) -> List[Dict[str, Any]]:
        """Get deliverables that need processing."""
        return [
            d for d in self.deliverables
            if d["status"] in ["pending", "generating", "scoring", "retry_queued"]
        ]

    def all_approved(self) -> bool:
        """Check if all deliverables are approved."""
        return all(d["status"] == "approved" for d in self.deliverables)

    def all_complete(self) -> bool:
        """Check if all deliverables are in a terminal state (approved or failed)."""
        return all(d["status"] in ["approved", "failed"] for d in self.deliverables)

    async def update_deliverable_status(
        self,
        deliverable_id: str,
        status: str,
        updates: Optional[Dict[str, Any]] = None
    ):
        """Update deliverable status in database."""
        update_data = {"status": status}
        if updates:
            update_data.update(updates)

        self.supabase.table("campaign_deliverables").update(
            update_data
        ).eq("id", deliverable_id).execute()

        # Update local cache
        for d in self.deliverables:
            if d["id"] == deliverable_id:
                d.update(update_data)
                break

    async def generate_batch(self, deliverables: List[Dict[str, Any]]):
        """Generate all items in a batch."""
        self.log("orchestrator", "info", f"Generating batch of {len(deliverables)} items")

        for deliverable in deliverables:
            await self.update_deliverable_status(deliverable["id"], "generating")

            try:
                artifact = await self.generation_worker.generate(
                    run_id=self.campaign.get("run_id"),
                    client_id=self.campaign["client_id"],
                    prompt=deliverable["current_prompt"],
                    model_type=deliverable["ai_model"],
                    negative_prompts=deliverable.get("negative_prompts", [])
                )

                if artifact:
                    await self.update_deliverable_status(
                        deliverable["id"],
                        "scoring",
                        {"artifact_id": artifact["id"]}
                    )
                    self.log("generation", "info", f"Generated: {deliverable['description']}")
                else:
                    await self.update_deliverable_status(deliverable["id"], "failed")
                    self.log("generation", "error", f"Generation failed: {deliverable['description']}")

            except Exception as e:
                await self.update_deliverable_status(deliverable["id"], "failed")
                self.log("generation", "error", f"Generation error: {str(e)}")

    async def score_batch(self, deliverables: List[Dict[str, Any]]) -> List[tuple]:
        """Score all items in a batch through Gate 1."""
        self.log("orchestrator", "info", f"Scoring batch of {len(deliverables)} items")

        results = []
        for deliverable in deliverables:
            if deliverable["status"] != "scoring":
                continue

            try:
                score_result = await self.scoring_worker.score_item(
                    artifact_id=deliverable.get("artifact_id"),
                    brand_id=self.campaign["client_id"]
                )

                # Store score in memory
                item_memory = self.memory.get_item(deliverable["id"])
                item_memory.scores.append(score_result.get("scores", {}))

                # Update deliverable with score
                await self.update_deliverable_status(
                    deliverable["id"],
                    deliverable["status"],
                    {"score": score_result.get("scores")}
                )

                results.append((deliverable, score_result))

            except Exception as e:
                self.log("scoring", "error", f"Scoring error: {str(e)}")
                results.append((deliverable, {"passed_gate1": False, "failure_reasons": ["scoring_error"]}))

        return results

    async def send_to_hitl(self, deliverable: Dict[str, Any]):
        """Route deliverable to HITL queue for human review."""
        await self.update_deliverable_status(deliverable["id"], "hitl")
        self.log("orchestrator", "info", f"Sent to HITL: {deliverable['description']}")

    def add_to_retry_batch(self, deliverable: Dict[str, Any], failure_reasons: List[str]):
        """Add deliverable to retry batch with failure reasons."""
        item_memory = self.memory.get_item(deliverable["id"])

        # Get negative prompts for failure reasons
        negative_prompts = self.prompt_modifier.get_negative_terms(failure_reasons)

        self.memory.add_rejection(deliverable["id"], failure_reasons, negative_prompts)
        self.retry_batch.append(deliverable["id"])

        self.log("orchestrator", "info",
                f"Added to retry batch: {deliverable['description']} "
                f"(retry {item_memory.retry_count}/{self.campaign.get('max_retries', 3)})")

    async def flag_for_manual_intervention(self, deliverable: Dict[str, Any]):
        """Flag deliverable for manual intervention after max retries exceeded."""
        await self.update_deliverable_status(deliverable["id"], "failed")
        self.log("orchestrator", "warn",
                f"Max retries exceeded, flagged for manual intervention: {deliverable['description']}")

    async def modify_prompts_and_regenerate(self):
        """Modify prompts for retry batch and regenerate."""
        self.log("orchestrator", "info", f"Processing retry batch of {len(self.retry_batch)} items")

        deliverables_to_retry = []

        for deliverable_id in self.retry_batch:
            # Find deliverable
            deliverable = next((d for d in self.deliverables if d["id"] == deliverable_id), None)
            if not deliverable:
                continue

            item_memory = self.memory.get_item(deliverable_id)

            # Modify prompt
            modified_prompt, negative_prompt = self.prompt_modifier.modify_prompt(
                original_prompt=deliverable["original_prompt"],
                rejection_reasons=item_memory.rejection_reasons,
                model_type=deliverable["ai_model"]
            )

            # Update deliverable with modified prompt
            await self.update_deliverable_status(
                deliverable_id,
                "retry_queued",
                {
                    "current_prompt": modified_prompt,
                    "negative_prompts": item_memory.negative_prompts,
                    "retry_count": item_memory.retry_count
                }
            )

            # Store in memory
            item_memory.modified_prompt = modified_prompt

            # Record in campaign memory table
            self.supabase.table("campaign_memory").insert({
                "campaign_id": self.campaign_id,
                "deliverable_id": deliverable_id,
                "retry_attempt": item_memory.retry_count,
                "rejection_reasons": item_memory.rejection_reasons,
                "negative_prompts": item_memory.negative_prompts,
                "prompt_before": deliverable["current_prompt"],
                "prompt_after": modified_prompt,
            }).execute()

            deliverables_to_retry.append({**deliverable, "current_prompt": modified_prompt})

        # Clear retry batch
        self.retry_batch = []

        # Regenerate
        if deliverables_to_retry:
            await self.generate_batch(deliverables_to_retry)

    async def update_brand_dna(self):
        """Update long-term brand DNA with approved outputs."""
        approved_items = [d for d in self.deliverables if d["status"] == "approved"]

        if not approved_items:
            return

        self.log("orchestrator", "info", f"Updating brand DNA with {len(approved_items)} approved items")

        await self.dna_updater.add_to_dna(
            approved_items=approved_items,
            brand_id=self.campaign["client_id"]
        )

    async def run_campaign(self) -> Dict[str, Any]:
        """
        Main orchestration loop: generate -> score -> route -> retry

        Returns:
            Campaign result summary
        """
        self.log("orchestrator", "info", "Starting campaign orchestration")

        # Load campaign data
        await self.load_campaign()
        max_retries = self.campaign.get("max_retries", 3)

        # Update campaign status to running
        self.supabase.table("campaigns").update({
            "status": "running"
        }).eq("id", self.campaign_id).execute()

        # Initial generation
        pending = [d for d in self.deliverables if d["status"] == "pending"]
        if pending:
            await self.generate_batch(pending)

        # Main loop
        max_iterations = max_retries + 2  # Safety limit
        iteration = 0

        while not self.all_complete() and iteration < max_iterations:
            iteration += 1
            self.log("orchestrator", "info", f"Loop iteration {iteration}")

            # Reload deliverables to get latest status
            del_result = self.supabase.table("campaign_deliverables").select("*").eq(
                "campaign_id", self.campaign_id
            ).execute()
            self.deliverables = del_result.data or []

            # Score pending items
            scoring_items = [d for d in self.deliverables if d["status"] == "scoring"]
            if scoring_items:
                results = await self.score_batch(scoring_items)

                # Route results
                for deliverable, result in results:
                    if result.get("passed_gate1"):
                        await self.send_to_hitl(deliverable)
                    else:
                        item_memory = self.memory.get_item(deliverable["id"])
                        if item_memory.retry_count < max_retries:
                            self.add_to_retry_batch(deliverable, result.get("failure_reasons", []))
                        else:
                            await self.flag_for_manual_intervention(deliverable)

            # Process retry batch
            if self.retry_batch:
                await self.modify_prompts_and_regenerate()

            # Small delay to prevent tight loop
            await asyncio.sleep(0.5)

        # Check final status
        approved_count = sum(1 for d in self.deliverables if d["status"] == "approved")
        failed_count = sum(1 for d in self.deliverables if d["status"] == "failed")
        hitl_count = sum(1 for d in self.deliverables if d["status"] == "hitl")

        # Determine final campaign status
        if approved_count == len(self.deliverables):
            final_status = "completed"
        elif hitl_count > 0:
            final_status = "needs_review"
        elif failed_count > 0:
            final_status = "failed"
        else:
            final_status = "running"

        # Update campaign status and counts
        self.supabase.table("campaigns").update({
            "status": final_status,
            "approved_count": approved_count,
            "failed_count": failed_count
        }).eq("id", self.campaign_id).execute()

        self.log("orchestrator", "info",
                f"Campaign orchestration complete. Status: {final_status}, "
                f"Approved: {approved_count}, Failed: {failed_count}, HITL: {hitl_count}")

        return {
            "status": final_status,
            "total": len(self.deliverables),
            "approved": approved_count,
            "failed": failed_count,
            "hitl_pending": hitl_count
        }

    async def handle_hitl_decision(
        self,
        deliverable_id: str,
        decision: str,
        rejection_reasons: Optional[List[str]] = None,
        custom_note: Optional[str] = None
    ):
        """
        Handle HITL decision for a deliverable.

        Args:
            deliverable_id: ID of the deliverable
            decision: "approve", "reject", or "changes"
            rejection_reasons: List of rejection category IDs
            custom_note: Custom rejection note
        """
        deliverable = next((d for d in self.deliverables if d["id"] == deliverable_id), None)
        if not deliverable:
            self.log("hitl", "error", f"Deliverable not found: {deliverable_id}")
            return

        if decision == "approve":
            await self.update_deliverable_status(deliverable_id, "approved")
            self.log("hitl", "info", f"Approved: {deliverable['description']}")

        elif decision in ["reject", "changes"]:
            if rejection_reasons:
                item_memory = self.memory.get_item(deliverable_id)
                max_retries = self.campaign.get("max_retries", 3)

                if item_memory.retry_count < max_retries:
                    self.add_to_retry_batch(deliverable, rejection_reasons)
                    self.log("hitl", "info", f"Queued for retry: {deliverable['description']}")
                else:
                    await self.flag_for_manual_intervention(deliverable)
            else:
                await self.update_deliverable_status(deliverable_id, "failed")

        # Check if all HITL reviews are complete
        hitl_remaining = sum(1 for d in self.deliverables if d["status"] == "hitl")
        if hitl_remaining == 0 and self.retry_batch:
            # Process any pending retries
            await self.modify_prompts_and_regenerate()

        # If all approved, update DNA
        if self.all_approved():
            await self.update_brand_dna()
