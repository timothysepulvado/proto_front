import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import dotenv from "dotenv";

let cachedTempGenEnv: Record<string, string> | null = null;

export function getTempGenDir(): string {
  const configured = process.env.TEMP_GEN_PATH ?? process.env.TEMP_GEN_DIR;
  if (configured && configured.trim().length > 0) return configured;
  return join(process.env.HOME ?? process.cwd(), "Temp-gen");
}

export function loadTempGenEnv(): Record<string, string> {
  if (cachedTempGenEnv) return cachedTempGenEnv;

  const tempGenDir = getTempGenDir();
  const envPath = join(tempGenDir, ".env");

  if (!existsSync(envPath)) {
    cachedTempGenEnv = {};
    return cachedTempGenEnv;
  }

  const parsed = dotenv.parse(readFileSync(envPath));
  cachedTempGenEnv = Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return cachedTempGenEnv;
}

export function buildTempGenProcessEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...loadTempGenEnv(),
  };
}
