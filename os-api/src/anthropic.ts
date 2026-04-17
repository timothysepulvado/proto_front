/**
 * Anthropic on Vertex AI SDK wrapper for orchestrator calls.
 *
 * First-client infrastructure runs Claude through Google Cloud Vertex AI
 * (project `bran-479523`), NOT the direct Anthropic API. This wrapper talks
 * to `aiplatform.googleapis.com` via `@anthropic-ai/vertex-sdk`.
 *
 * Handles:
 *   - Client init via `AnthropicVertex`
 *       • projectId from `VERTEX_PROJECT_ID` (default: `bran-479523`)
 *       • region from `VERTEX_REGION` (default: `global` — the supported
 *         Claude-on-Vertex endpoint per GCP docs)
 *       • auth precedence: `VERTEX_API_KEY` as `accessToken` → Google
 *         Application Default Credentials. The direct-SDK `apiKey` slot is
 *         unavailable on Vertex; Google credentials are required.
 *   - Prompt caching on stable system blocks (ephemeral `cache_control`,
 *     supported on Claude-on-Vertex per model card)
 *   - Retries on transient errors (429 rate limit, 5xx)
 *   - Structured error handling (retryable vs fatal)
 *   - Per-call cost calculation based on input/output tokens
 *
 * Pricing is read from env (fallback to conservative defaults). Cost is
 * informational — real billing is on the GCP console.
 */

import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";

// ── Config ────────────────────────────────────────────────────────────────
// Vertex uses the unsuffixed model id. The GA version name is
// "claude-opus-4-7@default" but `messages.create()` takes just the base id.
const DEFAULT_MODEL = process.env.CLAUDE_ORCHESTRATOR_MODEL
  ?? "claude-opus-4-7";

const DEFAULT_PROJECT_ID = process.env.VERTEX_PROJECT_ID ?? "bran-479523";
const DEFAULT_REGION = process.env.VERTEX_REGION ?? "global";

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

// Opus 4.7 pricing (USD / 1M tokens) — override via env if billing changes
// Cache-write is billed at input rate × 1.25; cache-read at × 0.1
const INPUT_COST_PER_M = Number(process.env.CLAUDE_INPUT_COST_PER_M ?? "15.00");
const OUTPUT_COST_PER_M = Number(process.env.CLAUDE_OUTPUT_COST_PER_M ?? "75.00");
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

// ── Singleton client ──────────────────────────────────────────────────────
let _client: AnthropicVertex | null = null;

export function getAnthropicClient(): AnthropicVertex {
  if (_client) return _client;
  const projectId = DEFAULT_PROJECT_ID;
  const region = DEFAULT_REGION;
  const accessToken = process.env.VERTEX_API_KEY;
  // If VERTEX_API_KEY is provided, pass it through as an `accessToken`
  // (e.g. short-lived OAuth token from `gcloud auth print-access-token`, or
  // an impersonated credential). If absent, the SDK falls back to Google
  // Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS env,
  // gcloud ADC, or an attached service account).
  _client = new AnthropicVertex({
    projectId,
    region,
    ...(accessToken ? { accessToken } : {}),
  });
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
  /**
   * If true, declare Anthropic's server-executed `web_search_20250305` tool so
   * the orchestrator can verify model ids / tool versions / external facts
   * before proposing them (staleness discipline). Server-side execution — no
   * client-side tool loop needed; results come back inline in the response.
   *
   * Vertex support as of SDK 0.16.0: types present (WebSearchTool20250305).
   * If Vertex rejects the tool at runtime, callers should treat the failure as
   * "web search disabled" and continue — the gate is the arg-shape, not the
   * live call. See 10a handoff: web-search is low-importance for first run.
   */
  enableWebSearch?: boolean;
  /** Max web_search tool uses per call. Default 3. */
  maxWebSearchUses?: number;
  /**
   * Optional additional tool definitions. If you want custom tools (not
   * web_search), pass them here; they will be merged with the web_search
   * declaration. Shape: compatible with @anthropic-ai/sdk ToolUnion.
   */
  extraTools?: unknown[];
}

export interface OrchestratorToolUse {
  /** 'web_search' for web_search_20250305, or a client-defined name. */
  name: string;
  /** The tool call id from the model. */
  id: string;
  /** The tool_use input payload — for web_search this is { query, ... }. */
  input: unknown;
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
  /** Tool invocations observed in the response (server-side web_search, etc.). */
  toolUses: OrchestratorToolUse[];
  /** Count of web_search server-tool invocations (for audit + cost). */
  webSearchCount: number;
}

// ── Main call ─────────────────────────────────────────────────────────────
/**
 * Invoke Claude (on Vertex) with a cached system prompt + dynamic user
 * message.
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

  // Assemble tools array if the caller opted in to web_search
  const tools = _buildTools(request);

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
        // Only include `tools` when the caller declared them — the Vertex SDK
        // 0.16.0 accepts the field and forwards to Anthropic's server. If the
        // Vertex backend rejects a specific server-tool id, the error surfaces
        // as a 400 here and we propagate — caller chooses to retry without
        // web_search. See 10a handoff Q1.
        ...(tools.length > 0 ? { tools: tools as never } : {}),
      });

      const latencyMs = Date.now() - t0;

      // Extract text blocks (assistant's prose / JSON output)
      const textBlocks = response.content.filter(
        (b: { type: string }) => b.type === "text",
      );
      const text = textBlocks
        .map((b: unknown) => (b as { text: string }).text)
        .join("");

      // Extract server_tool_use blocks (web_search invocations, etc.) for audit.
      // Cast via unknown to decouple from the SDK's ContentBlock union shape —
      // we only need `type`/`name`/`id`/`input` fields which exist on both
      // tool_use and server_tool_use block variants.
      const toolUses: OrchestratorToolUse[] = [];
      const blocks = response.content as unknown as Array<Record<string, unknown>>;
      for (const block of blocks) {
        if (block.type === "server_tool_use" || block.type === "tool_use") {
          toolUses.push({
            name: String(block.name ?? ""),
            id: String(block.id ?? ""),
            input: block.input ?? null,
          });
        }
      }

      const usage = response.usage;
      const tokensIn = usage.input_tokens ?? 0;
      const tokensOut = usage.output_tokens ?? 0;
      const cacheReadTokens = (usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
      const cacheWriteTokens = (usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;
      const serverToolUsage = (usage as { server_tool_use?: { web_search_requests?: number } | null }).server_tool_use;
      const webSearchCount = serverToolUsage?.web_search_requests
        ?? toolUses.filter((t) => t.name === "web_search").length;

      // Cost calc (USD) — input/output tokens only. Web search has its own
      // per-request pricing ($0.01/request typical); we surface count but don't
      // add it to the input-token cost figure (keeps the "model cost" clean).
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
        toolUses,
        webSearchCount,
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

/**
 * Build the tools array for a call. Right now this declares Anthropic's
 * server-executed `web_search_20250305` tool when `enableWebSearch` is set,
 * plus any extra tools the caller passed.
 *
 * Shape reference (@anthropic-ai/sdk 0.16 ToolUnion):
 *   { name: "web_search", type: "web_search_20250305", max_uses?: number, ... }
 *
 * Returns unknown[] because we want to tolerate Vertex-side SDK variance
 * without tightly binding the call site to ToolUnion's exact shape.
 */
export function _buildTools(request: OrchestratorCallRequest): unknown[] {
  const out: unknown[] = [];
  if (request.enableWebSearch) {
    out.push({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: request.maxWebSearchUses ?? 3,
    });
  }
  if (request.extraTools && Array.isArray(request.extraTools)) {
    out.push(...request.extraTools);
  }
  return out;
}

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

/** Expose Vertex deployment info for logging / diagnostics. */
export function getVertexConfig(): {
  projectId: string;
  region: string;
  model: string;
  authMode: "access_token" | "adc";
} {
  return {
    projectId: DEFAULT_PROJECT_ID,
    region: DEFAULT_REGION,
    model: DEFAULT_MODEL,
    authMode: process.env.VERTEX_API_KEY ? "access_token" : "adc",
  };
}
