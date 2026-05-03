import jwt from "jsonwebtoken";
import { supabase } from "./supabase.js";

export const CLIENT_JWT_EXPIRES_IN_SECONDS = 3600;

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const JWT_AUTH_ENABLED = process.env.JWT_AUTH_ENABLED === "true";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

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
