import { setSupabaseClientAccessToken, supabase } from "./supabase";

const JWT_AUTH_ENABLED = import.meta.env.VITE_JWT_AUTH_ENABLED === "true";
const REFRESH_BUFFER_SECONDS = 600;

type ClientTokenResponse = {
  token: string;
  expiresIn: number;
};

type ClientAuthSession = {
  clientId: string;
  osApiUrl: string;
  issuedAtMs: number;
  expiresAtMs: number;
};

type ClientAuthListener = {
  onApplied?: () => void;
  onError?: (error: Error) => void;
};

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let currentSession: ClientAuthSession | null = null;
let visibilityHandlerBound = false;
const listeners = new Set<ClientAuthListener>();

export function isJwtAuthEnabled(): boolean {
  return JWT_AUTH_ENABLED;
}

export function subscribeToClientAuthEvents(
  listener: ClientAuthListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function clearRefreshTimer() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function notifyApplied() {
  for (const listener of listeners) {
    listener.onApplied?.();
  }
}

function notifyError(error: Error) {
  for (const listener of listeners) {
    listener.onError?.(error);
  }
}

async function parseTokenError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  const detail =
    typeof body?.error === "string" && body.error.trim().length > 0
      ? body.error
      : `HTTP ${response.status}`;
  return new Error(`Failed to mint client JWT: ${detail}`);
}

function scheduleRefresh(session: ClientAuthSession) {
  clearRefreshTimer();
  const expiresInMs = session.expiresAtMs - session.issuedAtMs;
  const refreshMs = Math.max(
    60_000,
    expiresInMs - REFRESH_BUFFER_SECONDS * 1000,
  );
  refreshTimer = setTimeout(() => {
    applyClientJwt(session.clientId, session.osApiUrl).catch(
      (error: unknown) => {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        console.error("[clientAuth] failed to refresh client JWT", normalized);
        notifyError(normalized);
      },
    );
  }, refreshMs);
}

function ensureVisibilityRefreshHandler() {
  if (visibilityHandlerBound || typeof document === "undefined") return;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !currentSession) return;
    const tokenLifetimeMs =
      currentSession.expiresAtMs - currentSession.issuedAtMs;
    const midpointMs = currentSession.issuedAtMs + tokenLifetimeMs / 2;
    if (Date.now() < midpointMs) return;

    applyClientJwt(currentSession.clientId, currentSession.osApiUrl).catch(
      (error: unknown) => {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        console.error(
          "[clientAuth] failed to refresh client JWT after tab focus",
          normalized,
        );
        notifyError(normalized);
      },
    );
  });
  visibilityHandlerBound = true;
}

export async function applyClientJwt(
  clientId: string,
  osApiUrl: string,
): Promise<void> {
  if (!JWT_AUTH_ENABLED) return;

  const normalizedClientId = clientId.trim();
  if (!normalizedClientId) {
    throw new Error("clientId required");
  }

  clearRefreshTimer();

  const response = await fetch(`${osApiUrl}/api/auth/client-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: normalizedClientId }),
  });
  if (!response.ok) throw await parseTokenError(response);

  const { token, expiresIn } = (await response.json()) as ClientTokenResponse;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Failed to mint client JWT: token missing from response");
  }
  if (
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new Error(
      "Failed to mint client JWT: expiresIn missing from response",
    );
  }

  setSupabaseClientAccessToken(token);
  const { error } = await supabase.auth.setSession({
    access_token: token,
    refresh_token: token,
  });
  // Supabase-js v2's GoTrue client validates custom app JWTs like user-session
  // tokens. Phase E client JWTs use sub=client_<id> per the architecture lock,
  // so setSession can report "sub claim must be a UUID" even though PostgREST
  // and Realtime accept the token. Keep the required setSession call, but route
  // direct reads through the mutable Authorization header set above.
  if (error && !error.message.includes("sub claim must be a UUID")) {
    throw new Error(`Failed to apply client JWT session: ${error.message}`);
  }

  supabase.realtime.setAuth(token);
  await supabase.removeAllChannels();

  const issuedAtMs = Date.now();
  currentSession = {
    clientId: normalizedClientId,
    osApiUrl,
    issuedAtMs,
    expiresAtMs: issuedAtMs + expiresIn * 1000,
  };
  ensureVisibilityRefreshHandler();
  scheduleRefresh(currentSession);
  notifyApplied();
}

export function clearClientJwtRefresh(): void {
  clearRefreshTimer();
  currentSession = null;
  setSupabaseClientAccessToken(null);
}
