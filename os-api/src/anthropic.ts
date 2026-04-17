/**
 * Anthropic SDK wrapper for orchestrator calls.
 *
 * Handles:
 *   - Client init with ANTHROPIC_API_KEY from env
 *   - Prompt caching on stable system blocks (5-minute TTL — amortizes cost
 *     across multiple orchestrator calls within a run)
 *   - Retries on transient errors (429 rate limit, 5xx)
 *   - Structured error handling (retryable vs fatal)
 *   - Per-call cost calculation based on input/output tokens
 *
 * Pricing is read from ~/agent-vault/MODEL_INTELLIGENCE.md at orchestrator-init
 * time (or falls back to conservative defaults). Cost is informational — real
 * billing is via Anthropic dashboard.
 */

import Anthropic from "@anthropic-ai/sdk";

// ── Config ────────────────────────────────────────────────────────────────
const DEFAULT_MODEL = process.env.CLAUDE_ORCHESTRATOR_MODEL
  ?? "claude-opus-4-7-20260101";

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

// Opus 4.7 pricing (USD / 1M tokens) — override via env if billing changes
// Cache-write is billed at input rate × 1.25; cache-read at × 0.1
const INPUT_COST_PER_M = Number(process.env.CLAUDE_INPUT_COST_PER_M ?? "15.00");
const OUTPUT_COST_PER_M = Number(process.env.CLAUDE_OUTPUT_COST_PER_M ?? "75.00");
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

// ── Singleton client ──────────────────────────────────────────────────────
let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Required for orchestrator calls. " +
      "See os-api/.env.example."
    );
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

// ── Request types ─────────────────────────────────────────────────────────
export interface OrchestratorCallRequest {
  /** Stable system text that should be cached across calls within a run. */
  systemCached: string;
  /** Per-call dynamic context (user message). Not cached. */
  userMessage: string;
  /** Optional override model id. */
  model?: string;
  /** Temperature — use very low (0.0-0.1) for decision-making. */
  temperature?: number;
  /** Max output tokens. */
  maxTokens?: number;
}

export interface OrchestratorCallResponse {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  latencyMs: number;
  stopReason: string | null;
}

// ── Main call ─────────────────────────────────────────────────────────────
/**
 * Invoke Claude with a cached system prompt + dynamic user message.
 *
 * Returns text + token accounting + cost estimate. Never throws on transient
 * errors — retries internally up to MAX_RETRIES. Throws only on fatal errors
 * (auth, malformed request, etc.).
 */
export async function callClaude(
  request: OrchestratorCallRequest,
): Promise<OrchestratorCallResponse> {
  const client = getAnthropicClient();
  const model = request.model ?? DEFAULT_MODEL;
  const temperature = request.temperature ?? 0.1;
  const maxTokens = request.maxTokens ?? 4096;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const t0 = Date.now();
    try {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        temperature,
        system: [
          {
            type: "text",
            text: request.systemCached,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: request.userMessage,
          },
        ],
      });

      const latencyMs = Date.now() - t0;

      // Extract text
      const textBlocks = response.content.filter(
        (b: { type: string }) => b.type === "text",
      );
      const text = textBlocks
        .map((b: unknown) => (b as { text: string }).text)
        .join("");

      const usage = response.usage;
      const tokensIn = usage.input_tokens ?? 0;
      const tokensOut = usage.output_tokens ?? 0;
      const cacheReadTokens = (usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
      const cacheWriteTokens = (usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;

      // Cost calc (USD)
      const cost =
        ((tokensIn - cacheReadTokens - cacheWriteTokens) * INPUT_COST_PER_M
          + cacheWriteTokens * INPUT_COST_PER_M * CACHE_WRITE_MULT
          + cacheReadTokens * INPUT_COST_PER_M * CACHE_READ_MULT
          + tokensOut * OUTPUT_COST_PER_M) / 1_000_000;

      return {
        text,
        model: response.model,
        tokensIn,
        tokensOut,
        cacheReadTokens,
        cacheWriteTokens,
        cost,
        latencyMs,
        stopReason: response.stop_reason,
      };
    } catch (err) {
      lastErr = err;
      const retriable = _isRetriable(err);
      if (!retriable || attempt === MAX_RETRIES - 1) {
        throw err;
      }
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      await _sleep(delay);
    }
  }
  // Unreachable — either returned in the loop or threw on last attempt
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ── Internals ─────────────────────────────────────────────────────────────
function _isRetriable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: number }).status;
  if (status === 429) return true;             // rate limit
  if (status && status >= 500 && status < 600) return true;  // server error
  const code = (err as { code?: string }).code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND") return true;
  return false;
}

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Expose model id for logging / DB records. */
export function getDefaultModel(): string {
  return DEFAULT_MODEL;
}
