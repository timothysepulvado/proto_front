import type { Campaign, RunMode } from "./types.js";

export type RunCreateGuardResult =
  | { ok: true }
  | { ok: false; status: 403 | 404; error: string };

type StillsModeEnv = { [key: string]: string | undefined };

export function isStillsModeEnabled(env: StillsModeEnv = process.env): boolean {
  return (env.STILLS_MODE_ENABLED ?? "false").toLowerCase() === "true";
}

export function validateRunModeFeatureFlag(
  mode: RunMode,
  env: StillsModeEnv = process.env,
): RunCreateGuardResult {
  if (mode === "stills" && !isStillsModeEnabled(env)) {
    return { ok: false, status: 403, error: "stills_mode_disabled" };
  }
  return { ok: true };
}

export function validateCampaignClientScope(
  campaign: Pick<Campaign, "clientId"> | null,
  clientId: string,
): RunCreateGuardResult {
  if (!campaign) {
    return { ok: false, status: 404, error: "Campaign not found" };
  }
  if (campaign.clientId !== clientId) {
    return { ok: false, status: 403, error: "campaign_client_mismatch" };
  }
  return { ok: true };
}
