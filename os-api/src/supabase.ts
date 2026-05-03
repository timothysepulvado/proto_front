import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY (or legacy SUPABASE_KEY)");
}

if (!process.env.SUPABASE_SECRET_KEY) {
  console.warn(
    "[supabase] SUPABASE_SECRET_KEY not set — falling back to SUPABASE_KEY (sb_publishable_* / anon-equivalent will fail RLS reads after migration 015)",
  );
}

export const supabase = createClient(supabaseUrl, supabaseKey);
