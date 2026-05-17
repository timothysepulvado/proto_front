import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Film, Loader2, PlayCircle, Video } from "lucide-react";
import {
  getLatestVideoArtifactForCampaign,
  resolveArtifactDisplayUrl,
  type Artifact,
  type Campaign,
  type Run,
} from "../api";
import { useSignedArtifactUrl } from "../hooks/useSignedArtifactUrl";

interface CurrentCutPreviewProps {
  campaign: Campaign | null;
  campaignId?: string;
  currentRun?: Run | null;
}

type CutSource =
  | {
      kind: "campaign";
      url: string;
      label: string;
      updatedAt?: string;
      artifact: null;
    }
  | {
      kind: "artifact";
      url: null;
      label: string;
      updatedAt?: string;
      artifact: Artifact;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "No timestamp";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function getCampaignCutSource(campaign: Campaign | null): CutSource | null {
  const metadata = isRecord(campaign?.metadata) ? campaign.metadata : undefined;
  const currentCutUrl = readString(metadata, "current_cut_url", "currentCutUrl", "mastered_cut_url", "masteredCutUrl");
  if (!currentCutUrl) return null;

  return {
    kind: "campaign",
    url: resolveArtifactDisplayUrl(currentCutUrl),
    label: readString(metadata, "current_cut_label", "currentCutLabel", "mastered_cut_label", "masteredCutLabel") ?? "Campaign current cut",
    updatedAt: readString(metadata, "current_cut_updated_at", "currentCutUpdatedAt", "mastered_cut_updated_at", "masteredCutUpdatedAt") ?? campaign?.updatedAt,
    artifact: null,
  };
}

function getArtifactLabel(artifact: Artifact): string {
  const metadata = isRecord(artifact.metadata) ? artifact.metadata : undefined;
  return readString(metadata, "cut_label", "label", "media_type", "model") ?? artifact.name ?? "Latest video artifact";
}

export default function CurrentCutPreview({ campaign, campaignId, currentRun }: CurrentCutPreviewProps) {
  const campaignCutSource = useMemo(() => getCampaignCutSource(campaign), [campaign]);
  const [fallbackArtifact, setFallbackArtifact] = useState<Artifact | null>(null);
  const [isLoadingArtifact, setIsLoadingArtifact] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (campaignCutSource || !campaignId) {
      setFallbackArtifact(null);
      setIsLoadingArtifact(false);
      setError(null);
      return undefined;
    }

    async function loadFallbackArtifact() {
      setIsLoadingArtifact(true);
      setError(null);
      try {
        const artifact = await getLatestVideoArtifactForCampaign(campaignId as string);
        if (!cancelled) setFallbackArtifact(artifact);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load current cut artifact");
          setFallbackArtifact(null);
        }
      } finally {
        if (!cancelled) setIsLoadingArtifact(false);
      }
    }

    void loadFallbackArtifact();
    return () => {
      cancelled = true;
    };
  }, [campaignCutSource, campaignId, currentRun?.runId]);

  const artifactSource: CutSource | null = fallbackArtifact
    ? {
        kind: "artifact",
        url: null,
        label: getArtifactLabel(fallbackArtifact),
        updatedAt: fallbackArtifact.createdAt,
        artifact: fallbackArtifact,
      }
    : null;
  const source = campaignCutSource ?? artifactSource;
  const signedArtifactUrl = useSignedArtifactUrl(source?.kind === "artifact" ? source.artifact.id : undefined);
  const videoUrl = source?.kind === "campaign" ? source.url : signedArtifactUrl.url;
  const isVideoLoading = isLoadingArtifact || (source?.kind === "artifact" && signedArtifactUrl.loading);
  const videoError = error ?? (source?.kind === "artifact" ? signedArtifactUrl.error : null);

  return (
    <section className="relative overflow-hidden rounded-2xl border border-cyan-400/15 bg-black/25 p-4 shadow-[0_0_35px_rgba(73,157,216,0.05)]">
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent via-cyan-300/60 to-transparent opacity-50" />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[9px] font-mono uppercase tracking-[0.28em] text-cyan-200/75">
            <Film size={13} /> Current cut preview
          </div>
          <p className="mt-1 text-[8px] font-mono uppercase tracking-[0.2em] text-white/30">
            Mastered cut or latest working video · {source ? source.label : "Awaiting video"}
          </p>
        </div>
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[8px] font-mono uppercase tracking-[0.2em] text-white/40">
          {source ? formatTimestamp(source.updatedAt) : "No cut loaded"}
        </span>
      </div>

      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#05070b]">
        {videoUrl ? (
          <video
            key={videoUrl}
            src={videoUrl}
            controls
            preload="metadata"
            className="h-[220px] w-full bg-black object-contain md:h-[260px] xl:h-[300px]"
          />
        ) : (
          <div className="flex h-[220px] flex-col items-center justify-center gap-3 bg-[radial-gradient(circle_at_center,rgba(73,157,216,0.12),transparent_58%)] px-6 text-center md:h-[260px] xl:h-[300px]">
            {isVideoLoading ? (
              <>
                <Loader2 size={22} className="animate-spin text-cyan-200/70" />
                <p className="text-[9px] font-mono uppercase tracking-[0.24em] text-white/45">Loading current cut</p>
              </>
            ) : videoError ? (
              <>
                <AlertCircle size={22} className="text-amber-200/80" />
                <p className="max-w-xl text-[9px] font-mono uppercase leading-relaxed tracking-[0.2em] text-amber-100/70">
                  Current cut unavailable — {videoError}
                </p>
              </>
            ) : (
              <>
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-cyan-300/25 bg-cyan-300/10 text-cyan-100">
                  <PlayCircle size={24} />
                </div>
                <p className="max-w-xl text-[10px] font-mono uppercase leading-relaxed tracking-[0.22em] text-white/45">
                  No mastered cut yet — generate or master a cut to surface here
                </p>
              </>
            )}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[8px] font-mono uppercase tracking-[0.18em] text-white/28">
        <Video size={10} className="text-cyan-200/50" />
        <span>{source?.kind === "campaign" ? "campaign metadata current_cut_url" : source?.kind === "artifact" ? `artifact ${source.artifact.id.slice(0, 8)}` : "empty state"}</span>
      </div>
    </section>
  );
}
