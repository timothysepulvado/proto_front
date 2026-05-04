import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecret = process.env.SUPABASE_SECRET_KEY;
const supabaseKey = supabaseSecret ?? process.env.SUPABASE_KEY;
const isProd = process.env.NODE_ENV === "production";

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY (or legacy SUPABASE_KEY)");
}

if (!supabaseSecret) {
  if (isProd) {
    throw new Error(
      "SUPABASE_SECRET_KEY required in production. Falling back to SUPABASE_KEY (sb_publishable_*) " +
        "fails RLS reads after migration 015.",
    );
  }
  console.warn(
    "[supabase] SUPABASE_SECRET_KEY not set — using SUPABASE_KEY (sb_publishable_* / anon-equivalent " +
      "will fail RLS reads after migration 015; dev-only fallback)",
  );
}

export const supabase = createClient(supabaseUrl, supabaseKey);
