import { getCurrentClientToken } from "./supabase";

/**
 * Returns headers to attach to os-api fetches.
 *
 * When a client JWT is present (clientAuth.ts::applyClientJwt has run and
 * the token has not been cleared), this returns
 * `{ Authorization: 'Bearer <jwt>' }`. Otherwise returns `{}` —
 * bootstrap-fallback path matches the os-api endpoint contract
 * (no enforcement when JWT_AUTH_ENABLED=false on os-api).
 *
 * Callers should spread this into their fetch's `headers` field. When mixing
 * with `Content-Type: application/json` (for POST/PUT bodies), spread auth
 * headers FIRST so explicit content-type wins:
 *
 *   headers: { ...getAuthHeaders(), "Content-Type": "application/json" }
 *
 * Scope: only attach to fetches against `OS_API_URL` (the local os-api
 * service). Do NOT attach to fetches against any external service —
 * leaking the JWT outside the os-api scope is a policy violation.
 */
export function getAuthHeaders(): Record<string, string> {
  const token = getCurrentClientToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}
