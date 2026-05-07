import jwt from "jsonwebtoken";
import type { Request } from "express";
import { supabase } from "./supabase.js";

export const CLIENT_JWT_EXPIRES_IN_SECONDS = 3600;

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const JWT_AUTH_ENABLED = process.env.JWT_AUTH_ENABLED === "true";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

interface ClientJwtPayload {
  client_id?: unknown;
  sub?: unknown;
  role?: unknown;
  aud?: unknown;
}

if (JWT_AUTH_ENABLED) {
  if (!JWT_SECRET) throw new Error("SUPABASE_JWT_SECRET required when JWT_AUTH_ENABLED=true");
  if (!SUPABASE_SECRET_KEY) {
    throw new Error(
      "SUPABASE_SECRET_KEY required when JWT_AUTH_ENABLED=true — mintClientJwt's clients lookup " +
        "needs RLS bypass; legacy SUPABASE_KEY fallback would fail under migration 015 RLS policies.",
    );
  }
}

export async function mintClientJwt(clientId: string): Promise<string> {
  const normalizedClientId = clientId.trim();
  if (!normalizedClientId) {
    throw new Error("clientId required");
  }
  if (!JWT_SECRET) {
    throw new Error("SUPABASE_JWT_SECRET not set in env");
  }

  const { data, error } = await supabase
    .from("clients")
    .select("id")
    .eq("id", normalizedClientId)
    .maybeSingle();

  if (error) throw new Error(`Failed to validate clientId: ${error.message}`);
  if (!data) throw new Error(`clientId not found: ${normalizedClientId}`);

  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      role: "authenticated",
      sub: `client_${normalizedClientId}`,
      client_id: normalizedClientId,
      aud: "authenticated",
      iss: "os-api",
      iat: now,
      exp: now + CLIENT_JWT_EXPIRES_IN_SECONDS,
    },
    JWT_SECRET,
    { algorithm: "HS256" },
  );
}

/**
 * Verify a client-scoped JWT carried by the Authorization header.
 *
 * Returns `{ clientId }` when:
 *   • JWT_AUTH_ENABLED=true
 *   • Authorization: Bearer <token> header present
 *   • HS256 signature verifies against SUPABASE_JWT_SECRET
 *   • Decoded payload has a non-empty `client_id` claim
 *
 * Returns `null` (bootstrap-fallback / anonymous) when:
 *   • JWT_AUTH_ENABLED=false (flag off — single-operator threat model;
 *     mirrors the cost-ledger endpoint's known-limitation pattern)
 *   • SUPABASE_JWT_SECRET unset (config gap — log + fall through)
 *   • No / malformed Authorization header
 *   • Token verification fails (logged at warn; treated as anonymous)
 *
 * The route layer decides whether `null` callers are allowed: tenant-isolated
 * endpoints typically permit null while the flag is off (no enforcement) and
 * enforce match when the flag is on.
 */
export function verifyClientJwtFromRequest(req: Request): { clientId: string } | null {
  if (!JWT_AUTH_ENABLED) return null;
  if (!JWT_SECRET) return null;

  const header = req.header("authorization") ?? req.header("Authorization");
  if (!header) return null;

  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }) as ClientJwtPayload;
    const clientId = typeof decoded.client_id === "string" ? decoded.client_id.trim() : "";
    if (!clientId) return null;
    return { clientId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[auth] JWT verification failed: ${message}`);
    return null;
  }
}
