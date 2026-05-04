/**
 * Anthropic SDK wrapper for orchestrator calls.
 *
 * Backend auto-selects per env. Both SDKs expose the same `messages.create()`
 * shape, so the call-site is identical — only the client factory differs.
 *
 *   • Direct Anthropic (`@anthropic-ai/sdk`) — PRIMARY as of 2026-04-19
 *     (Tim's pivot). Activated when `ANTHROPIC_API_KEY` is set. Billed on
 *     Anthropic's platform ($50 starter credit). Avoids the Vertex Claude
 *     Opus 4.7 regional-quota provisioning loop surfaced in 10d-pre.
 *
 *     NOTE on model surface drift: direct Opus 4.7 DEPRECATED the
 *     `temperature` field (returns 400 invalid_request_error if present).
 *     Vertex used to accept + ignore it. We now treat `temperature` as
 *     opt-in — only forwarded when the caller explicitly sets it. See
 *     `callClaude` below.
 *
 *   • Vertex (`@anthropic-ai/vertex-sdk`) — fallback. Activates when
 *     `ANTHROPIC_API_KEY` is absent. Talks to `aiplatform.googleapis.com`
 *     against project `bran-479523` (default region `global`). Still fully
 *     wired and usable — the 10d-pre service-account auth work
 *     (`GOOGLE_APPLICATION_CREDENTIALS`) is preserved for headless-safe
 *     reactivation. Auth precedence within the Vertex branch:
 *       1. `GOOGLE_APPLICATION_CREDENTIALS` (service-account JSON) —
 *          preferred headless path; no interactive ADC reauth
 *          (`invalid_rapt`) churn.
 *       2. `VERTEX_API_KEY` (OAuth access token) — legacy / dev convenience.
 *          Short-lived; surfaces `invalid_rapt` when ADC expires.
 *       3. Bare ADC (whatever `gcloud auth application-default login` set).
 *     To flip back to Vertex: unset (or comment out) `ANTHROPIC_API_KEY` in
 *     `os-api/.env`; auto-routing picks Vertex on next module load.
 *
 * Both backends support:
 *   - Prompt caching on stable system blocks (ephemeral `cache_control`)
 *   - Internal retries on transient errors (429 rate limit, 5xx)
 *   - Per-call cost calculation from input/output/cache tokens
 *
 * Pricing defaults in env fall through at Anthropic Opus 4.7 rates (USD /
 * 1M tokens). Cost is informational — real billing is on the chosen backend.
 */

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { GoogleAuth } from "google-auth-library";

// ── Config ────────────────────────────────────────────────────────────────
// Vertex uses the unsuffixed model id. The GA version name is
// "claude-opus-4-7@default" but `messages.create()` takes just the base id.
const DEFAULT_MODEL = process.env.CLAUDE_ORCHESTRATOR_MODEL
  ?? "claude-opus-4-7";

const DEFAULT_PROJECT_ID = process.env.VERTEX_PROJECT_ID ?? "bran-479523";
const DEFAULT_REGION = process.env.VERTEX_REGION ?? "global";

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

// Opus 4.7 pricing (USD / 1M tokens) — per Anthropic's public pricing as of
// 2026-04-19 (Opus 4.7 = $5/M input, $25/M output). Prior defaults ($15/$75)
// were stale and produced 3× cost overstatements in orchestration_decisions.
// Override via env if Anthropic changes billing or if we switch models.
// Cache pricing (ephemeral 5-min TTL default):
//   - cache-write: input rate × 1.25
//   - cache-read:  input rate × 0.10
// 1-hour TTL (opt-in via cache_control.ttl = "1h") would be × 2.0 write; we do
// not currently use it — 5-min fits the 10d workload (burst-then-idle per shot).
const INPUT_COST_PER_M = Number(process.env.CLAUDE_INPUT_COST_PER_M ?? "5.00");
const OUTPUT_COST_PER_M = Number(process.env.CLAUDE_OUTPUT_COST_PER_M ?? "25.00");
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

// ── Singleton client ──────────────────────────────────────────────────────
/**
 * Minimal structural type of the two SDK clients. Both expose `messages.create`
 * with identical request/response shapes, which is all the orchestrator uses.
 * Typed as `any` on the method argument because the Vertex SDK's ToolUnion has
 * drifted from the direct SDK's shape; we tolerate that here since the tool
 * payload is constructed in `_buildTools` with a runtime-only `unknown[]`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnthropicLikeClient = { messages: { create: (args: any) => Promise<any> } };

let _client: AnthropicLikeClient | null = null;
let _backend: "direct" | "vertex" | null = null;

/**
 * Returns the active Anthropic client, lazily constructed.
 *
 * Backend selection (top-level):
 *   1. ANTHROPIC_API_KEY set → direct `@anthropic-ai/sdk`. PRIMARY path
 *      (Tim's 2026-04-19 pivot).
 *   2. else → `@anthropic-ai/vertex-sdk` (Vertex AI on bran-479523). Fallback.
 *
 * Vertex auth precedence (within Vertex branch, preserved from 10d-pre):
 *   a. GOOGLE_APPLICATION_CREDENTIALS → service-account JSON via GoogleAuth
 *      ({keyFile}). Headless-safe; no interactive reauth (`invalid_rapt`).
 *   b. VERTEX_API_KEY → OAuth access token. Legacy/dev; short-lived.
 *   c. Bare ADC.
 */
export function getAnthropicClient(): AnthropicLikeClient {
  if (_client) return _client;
  const directKey = process.env.ANTHROPIC_API_KEY;
  if (directKey) {
    _backend = "direct";
    _client = new Anthropic({ apiKey: directKey }) as unknown as AnthropicLikeClient;
    return _client;
  }
  // Vertex (primary path).
  _backend = "vertex";
  const saKeyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const accessToken = process.env.VERTEX_API_KEY;

  if (saKeyPath) {
    // Service-account JSON — headless-safe, no interactive reauth.
    const googleAuth = new GoogleAuth({
      keyFile: saKeyPath,
      scopes: "https://www.googleapis.com/auth/cloud-platform",
    });
    _client = new AnthropicVertex({
      projectId: DEFAULT_PROJECT_ID,
      region: DEFAULT_REGION,
      googleAuth,
    }) as unknown as AnthropicLikeClient;
  } else if (accessToken) {
    // Legacy: short-lived OAuth access token. Surfaces invalid_rapt when the
    // underlying ADC session expires; OK for dev, not for headless overnight.
    _client = new AnthropicVertex({
      projectId: DEFAULT_PROJECT_ID,
      region: DEFAULT_REGION,
      accessToken,
    }) as unknown as AnthropicLikeClient;
  } else {
    // Fallback to bare ADC (whatever `gcloud auth application-default login` set).
    _client = new AnthropicVertex({
      projectId: DEFAULT_PROJECT_ID,
      region: DEFAULT_REGION,
    }) as unknown as AnthropicLikeClient;
  }
  return _client;
}

/** Returns which backend the singleton client is using. */
export function getBackend(): "direct" | "vertex" | null {
  if (!_client) getAnthropicClient();
  return _backend;
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
   * If true, declare Anthropic's server-executed `web_search_20260209` tool so
   * the orchestrator can verify model ids / tool versions / external facts
   * before proposing them (staleness discipline). Server-side execution — no
   * client-side tool loop needed; results come back inline in the response.
   *
   * Upgraded from `web_search_20250305` on 2026-04-19 (10d pre-flight). The
   * newer version adds **dynamic filtering** on Opus 4.7 / 4.6 / Sonnet 4.6:
   * Claude writes and runs filter code against search results before they
   * enter the context window, improving accuracy and token efficiency.
   * Backward-compatible declaration shape (same `name: "web_search"`, same
   * `max_uses` field). Activates automatically on Opus 4.7 direct API.
   *
   * SDK coverage: @anthropic-ai/sdk 0.90.0 defines both types (WebSearchTool
   * 20250305 and 20260209). Vertex SDK 0.16.0 also accepts the newer literal.
   * If either backend rejects at runtime, callers should treat the failure as
   * "web search disabled" and continue — the gate is the arg-shape, not the
   * live call.
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
  /** 'web_search' for web_search_20260209, or a client-defined name. */
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
  // Temperature is opt-in: Claude Opus 4.7 on direct Anthropic API deprecated
  // the field (responds 400 `invalid_request_error` if present). Vertex
  // tolerated it. Only forward when caller explicitly set it.
  const temperature = request.temperature;
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
        ...(temperature !== undefined ? { temperature } : {}),
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

      // Cost calc (USD) — input/output tokens + cache activity.
      //
      // Critical: `usage.input_tokens` is ALREADY the non-cached remainder in
      // the Anthropic API response. Total prompt size =
      //   input_tokens + cache_creation_input_tokens + cache_read_input_tokens
      // Subtracting cache_* from tokensIn (as the prior formula did) double-
      // counts and produces negative costs once cacheRead tokens exceed the
      // uncached remainder — which is the common case on repeated calls.
      //
      // Web search has its own per-request pricing ($0.01/request typical);
      // we surface count but don't add it to the input-token cost figure
      // (keeps the "model cost" clean and comparable to prior records).
      const cost =
        (tokensIn * INPUT_COST_PER_M
          + cacheWriteTokens * INPUT_COST_PER_M * CACHE_WRITE_MULT
          + cacheReadTokens * INPUT_COST_PER_M * CACHE_READ_MULT
          + tokensOut * OUTPUT_COST_PER_M) / 1_000_000;
      // Cost ledger note: do NOT write cost_ledger_entries here. This wrapper has
      // no tenant/run/escalation context, so PR #4 Phase E records the
      // orchestrator_decision ledger row in db.ts::recordOrchestrationDecision
      // after client_id has been resolved and the canonical audit row exists.

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
 * Build the tools array for a call. Declares Anthropic's server-executed
 * `web_search_20260209` tool when `enableWebSearch` is set, plus any extra
 * tools the caller passed.
 *
 * Upgraded to 20260209 on 2026-04-19 (10d pre-flight) — same name, same
 * max_uses field; adds dynamic filtering on Opus 4.7 / 4.6 / Sonnet 4.6.
 *
 * Shape reference (@anthropic-ai/sdk 0.90.0 WebSearchTool20260209):
 *   { name: "web_search", type: "web_search_20260209", max_uses?: number,
 *     allowed_domains?, blocked_domains?, allowed_callers? }
 *
 * Returns unknown[] because we want to tolerate Vertex-side SDK variance
 * without tightly binding the call site to ToolUnion's exact shape.
 */
export function _buildTools(request: OrchestratorCallRequest): unknown[] {
  const out: unknown[] = [];
  if (request.enableWebSearch) {
    out.push({
      type: "web_search_20260209",
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

/** Expose deployment info for logging / diagnostics. */
export function getVertexConfig(): {
  projectId: string;
  region: string;
  model: string;
  authMode: "service_account" | "access_token" | "adc" | "direct_api_key";
  backend: "direct" | "vertex";
} {
  const backend: "direct" | "vertex" = process.env.ANTHROPIC_API_KEY
    ? "direct"
    : "vertex";
  // Vertex auth precedence: service_account > access_token > adc.
  // Mirrors the construction in getAnthropicClient(); kept in sync so callers
  // can introspect the active mode without instantiating the client.
  const authMode =
    backend === "direct"
      ? ("direct_api_key" as const)
      : process.env.GOOGLE_APPLICATION_CREDENTIALS
        ? ("service_account" as const)
        : process.env.VERTEX_API_KEY
          ? ("access_token" as const)
          : ("adc" as const);
  return {
    projectId: DEFAULT_PROJECT_ID,
    region: DEFAULT_REGION,
    model: DEFAULT_MODEL,
    authMode,
    backend,
  };
}
