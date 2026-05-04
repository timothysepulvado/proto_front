import { supabase } from "./supabase.js";

export type CostEvent =
  | "orchestrator_decision"
  | "video_generate"
  | "image_generate"
  | "video_critic"
  | "image_critic"
  | "consensus_critic"
  | "embedding";

export interface CostLedgerInput {
  clientId: string;
  runId?: string;
  deliverableId?: string;
  artifactId?: string;
  escalationId?: string;
  eventType: CostEvent;
  source: string;
  costUsd: number;
  tokensInput?: number;
  tokensOutput?: number;
  tokensCached?: number;
  units?: number;
  unitsKind?: "seconds" | "frames" | "images";
  metadata?: Record<string, unknown>;
  rateCardVersion?: string;
}

const RATE_CARD_VERSION = "v1";

export function finiteNonNegative(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export async function recordCost(input: CostLedgerInput): Promise<void> {
  if (!input.clientId) {
    console.error("[cost_ledger] MISSING client_id, dropping ledger entry", { source: input.source });
    return;
  }
  if (input.costUsd < 0 || !Number.isFinite(input.costUsd)) {
    console.warn("[cost_ledger] invalid costUsd, dropping", { input });
    return;
  }

  try {
    const { error } = await supabase.from("cost_ledger_entries").insert({
      client_id: input.clientId,
      run_id: input.runId ?? null,
      deliverable_id: input.deliverableId ?? null,
      artifact_id: input.artifactId ?? null,
      escalation_id: input.escalationId ?? null,
      event_type: input.eventType,
      source: input.source,
      cost_usd: input.costUsd,
      tokens_input: input.tokensInput ?? null,
      tokens_output: input.tokensOutput ?? null,
      tokens_cached: input.tokensCached ?? null,
      units: input.units ?? null,
      units_kind: input.unitsKind ?? null,
      metadata: input.metadata ?? {},
      rate_card_version: input.rateCardVersion ?? RATE_CARD_VERSION,
    });
    if (error) {
      console.error("[cost_ledger] insert failed", { error: error.message, input });
    }
  } catch (err) {
    console.error("[cost_ledger] insert threw", {
      error: err instanceof Error ? err.message : String(err),
      input,
    });
  }
}
