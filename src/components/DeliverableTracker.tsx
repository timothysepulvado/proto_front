import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronRight, Layers, RefreshCw, ShieldCheck } from "lucide-react";
import * as api from "../api";
import { supabase } from "../lib/supabase";
import type { CampaignDeliverable, DeliverableStatus, DirectionDriftIndicator, OperatorOverrideDecision } from "../api";

const OS_API_URL = import.meta.env.VITE_OS_API_URL || "http://localhost:3001";

type EscalationLevel = "L1" | "L2" | "L3";
type EscalationStatus = "in_progress" | "resolved" | "accepted" | "redesigned" | "replaced" | "hitl_required";
type ShotVerdict = "PASS" | "WARN" | "FAIL";

type ShotSummary = {
  deliverableId: string;
  shotNumber: number | null;
  beatName: string | null;
  status: DeliverableStatus;
  retryCount: number;
  escalationLevel: EscalationLevel | null;
  escalationStatus: EscalationStatus | null;
  latestEscalationId?: string | null;
  cumulativeCost: number;
  orchestratorCallCount: number;
  lastVerdict: ShotVerdict | null;
  lastScore: number | null;
  artifactCount: number;
  latestArtifactId: string | null;
};

interface DeliverableTrackerProps {
  campaignId: string;
  runId?: string;
  onShotClick?: (
    shotNumber: number | null,
    deliverableId: string,
    options?: { initialTab?: "narrative" | "critic" | "orchestrator" | "timeline"; runId?: string; pinnedTimelineEventId?: string },
  ) => void;
}

const statusStyles: Record<DeliverableStatus, { text: string; border: string; pulse?: boolean }> = {
  pending: { text: "text-white/30", border: "border-white/10" },
  generating: { text: "text-cyan-400", border: "border-cyan-500/30", pulse: true },
  reviewing: { text: "text-amber-400", border: "border-amber-500/30" },
  approved: { text: "text-emerald-400", border: "border-emerald-500/30" },
  rejected: { text: "text-red-400", border: "border-red-500/30" },
  regenerating: { text: "text-purple-400", border: "border-purple-500/30", pulse: true },
};

const escalationStyles: Record<EscalationLevel, string> = {
  L1: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300",
  L2: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  L3: "border-red-500/30 bg-red-500/10 text-red-300",
};

const verdictStyles: Record<ShotVerdict, string> = {
  PASS: "text-emerald-300",
  WARN: "text-amber-300",
  FAIL: "text-red-300",
};

const getShotSummariesCompat = (api as unknown as {
  getShotSummaries?: (campaignId: string, runId?: string) => Promise<ShotSummary[]>;
}).getShotSummaries;

function formatMoney(value: number) {
  return `$${value.toFixed(2)}`;
}

function formatOverrideScore(value: number | undefined) {
  return value == null ? "—" : value.toFixed(2);
}

function formatOperatorName(value: string | undefined) {
  if (!value) return "Operator";
  return value.toLowerCase().startsWith("tim") ? "Tim" : value;
}

function formatOverrideDate(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function buildOverrideSummary(override: OperatorOverrideDecision) {
  const actor = formatOperatorName(override.decisionBy);
  const version = override.runOrdinalForShot ? `v${override.runOrdinalForShot} ` : "";
  const iter = override.decidedIter != null ? `iter${override.decidedIter}` : "selected iter";
  const critic = override.criticVerdict
    ? `over critic ${override.criticVerdict}${override.criticScore != null ? ` ${formatOverrideScore(override.criticScore)}` : ""}`
    : "over critic";
  return `${actor} accepted ${version}${iter} ${critic} (run ${override.runId.slice(0, 8)})`;
}

function formatDirectionClass(value: string) {
  return value.replace(/_/g, " ");
}

function buildDirectionDriftLabel(indicator: DirectionDriftIndicator) {
  const classes = indicator.matchedClasses.map(formatDirectionClass).join(", ");
  const run = indicator.latestVerdictRunId ? `run ${indicator.latestVerdictRunId.slice(0, 8)}` : "latest verdict";
  return `Direction drift flagged on ${run}${classes ? `: ${classes}` : ""}`;
}

function formatBeatLabel(beatName: string | null) {
  return beatName ? beatName.replace(/_/g, " ") : "unmapped";
}

function deriveShotMetadata(deliverable: CampaignDeliverable, index: number) {
  const description = deliverable.description ?? "";
  const match = /shot\s+(\d{1,2})\s*[·:-]\s*([a-z0-9_]+)/i.exec(description);
  return {
    shotNumber: match ? Number.parseInt(match[1], 10) : index + 1,
    beatName: match?.[2]?.toLowerCase() ?? null,
  };
}

function buildStubShotSummaries(deliverables: CampaignDeliverable[]): ShotSummary[] {
  return deliverables.map((deliverable, index) => {
    const derived = deriveShotMetadata(deliverable, index);
    return {
      deliverableId: deliverable.id,
      shotNumber: derived.shotNumber,
      beatName: derived.beatName,
      status: deliverable.status,
      retryCount: deliverable.retryCount,
      escalationLevel: deliverable.retryCount >= 3 ? "L3" : deliverable.retryCount >= 2 ? "L2" : deliverable.retryCount >= 1 ? "L1" : null,
      escalationStatus: null,
      latestEscalationId: null,
      cumulativeCost: 0,
      orchestratorCallCount: 0,
      lastVerdict: null,
      lastScore: null,
      artifactCount: 0,
      latestArtifactId: null,
    };
  });
}

async function loadShotSummaries(
  campaignId: string,
  deliverables: CampaignDeliverable[],
  runId?: string,
): Promise<ShotSummary[]> {
  try {
    if (getShotSummariesCompat) {
      const summaries = await getShotSummariesCompat(campaignId, runId);
      if (Array.isArray(summaries) && summaries.length > 0) {
        return summaries;
      }
    }

    const params = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
    const response = await fetch(`${OS_API_URL}/api/campaigns/${campaignId}/shot-summaries${params}`);
    if (response.ok) {
      const summaries = (await response.json()) as ShotSummary[];
      if (Array.isArray(summaries)) {
        return summaries;
      }
    }
  } catch {
    // Brief-approved fallback until Phase 1 route/helper lands.
  }

  return buildStubShotSummaries(deliverables);
}

function upsertDeliverable(list: CampaignDeliverable[], deliverable: CampaignDeliverable) {
  const index = list.findIndex((item) => item.id === deliverable.id);
  if (index === -1) return [...list, deliverable];
  const next = [...list];
  next[index] = deliverable;
  return next;
}

function ShotCard({
  deliverable,
  summary,
  operatorOverride,
  directionDrift,
  onShotClick,
}: {
  deliverable: CampaignDeliverable;
  summary: ShotSummary;
  operatorOverride?: OperatorOverrideDecision;
  directionDrift?: DirectionDriftIndicator;
  onShotClick?: DeliverableTrackerProps["onShotClick"];
}) {
  const statusStyle = statusStyles[deliverable.status];
  const costOverCap = summary.cumulativeCost > 4;
  const interactive = Boolean(onShotClick);
  const overrideSummary = operatorOverride ? buildOverrideSummary(operatorOverride) : null;
  const directionLabel = directionDrift?.directionDrift ? buildDirectionDriftLabel(directionDrift) : null;

  const openDefaultDrawer = () => onShotClick?.(
    summary.shotNumber,
    deliverable.id,
    operatorOverride ? { initialTab: "timeline", runId: operatorOverride.runId } : undefined,
  );

  return (
    <div
      className={`group w-full rounded-xl border bg-white/[0.02] p-3 text-left transition-all ${statusStyle.border} ${
        interactive ? "hover:border-cyan-400/40 hover:bg-white/[0.04]" : "cursor-default"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          disabled={!interactive}
          onClick={openDefaultDrawer}
          className={`flex min-w-0 flex-1 gap-3 rounded-lg text-left focus:outline-none focus:ring-2 focus:ring-cyan-400/45 focus:ring-offset-2 focus:ring-offset-[#0b0b0f] ${
            interactive ? "" : "cursor-default"
          }`}
        >
          <div className="relative h-[90px] w-[160px] shrink-0 overflow-hidden rounded-xl border border-white/10 bg-white/[0.035]">
            {summary.shotNumber ? (
              <img
                src={api.getProductionShotThumbnailUrl("drift-mv", summary.shotNumber)}
                alt={`Shot ${summary.shotNumber} thumbnail`}
                loading="lazy"
                className="h-full w-full object-cover opacity-80 transition-opacity group-hover:opacity-100"
                onError={(event) => {
                  event.currentTarget.style.display = "none";
                }}
              />
            ) : null}
            <div className="absolute inset-0 bg-gradient-to-b from-black/20 to-black/55" />
            <span className="absolute bottom-1.5 left-1.5 rounded-md border border-white/15 bg-black/55 px-1.5 py-0.5 text-[7px] font-mono uppercase tracking-wider text-white/70">
              first frame
            </span>
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex items-center gap-2">
              <p className="truncate text-[10px] font-mono text-white">
                <span className="mr-2 text-cyan-300">#{summary.shotNumber ?? "—"}</span>
                {deliverable.description || `Deliverable ${deliverable.id.slice(0, 8)}`}
              </p>
              {summary.beatName && (
                <span className="shrink-0 rounded-full border border-cyan-500/20 bg-cyan-500/10 px-1.5 py-0.5 text-[7px] font-mono uppercase tracking-widest text-cyan-200">
                  {formatBeatLabel(summary.beatName)}
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-[8px] font-mono uppercase tracking-wider text-white/30">
              {deliverable.aiModel ?? "default model"} · {formatBeatLabel(summary.beatName)} · {summary.artifactCount} artifact{summary.artifactCount === 1 ? "" : "s"}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[7px] font-mono uppercase tracking-widest text-white/35">
              <span>ID {deliverable.id.slice(0, 8)}</span>
              {summary.lastVerdict && (
                <span className={verdictStyles[summary.lastVerdict]}>
                  {summary.lastVerdict}
                  {summary.lastScore !== null ? ` ${summary.lastScore.toFixed(1)}` : ""}
                </span>
              )}
              {summary.orchestratorCallCount > 0 && <span>{summary.orchestratorCallCount} call{summary.orchestratorCallCount === 1 ? "" : "s"}</span>}
            </div>
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          {deliverable.retryCount > 0 && (
            <span className="flex items-center text-[7px] font-mono text-purple-400/70">
              <RefreshCw size={8} className="mr-0.5" />
              {deliverable.retryCount}
            </span>
          )}
          <span
            className={`rounded-lg border px-2 py-1 text-[8px] font-mono uppercase ${statusStyle.text} ${statusStyle.border} ${
              statusStyle.pulse ? "animate-pulse" : ""
            }`}
          >
            {deliverable.status}
          </span>
          {summary.escalationLevel && (
            <span className={`rounded-lg border px-1.5 py-1 text-[8px] font-mono uppercase ${escalationStyles[summary.escalationLevel]}`}>
              {summary.escalationLevel}
            </span>
          )}
          {operatorOverride && overrideSummary && (
            <span
              aria-label={`Operator override: ${overrideSummary}`}
              className="inline-flex items-center gap-1 rounded-lg border border-[#ED4C14]/45 bg-[#ED4C14]/15 px-2 py-1 text-[8px] font-mono uppercase tracking-wider text-orange-200 shadow-[0_0_16px_rgba(237,76,20,0.16)]"
              title={overrideSummary}
            >
              <ShieldCheck size={9} />
              Operator Override
            </span>
          )}
          {directionLabel && directionDrift && (
            <button
              type="button"
              aria-label={`${directionLabel}. Open shot ${summary.shotNumber ?? ""} timeline pinned to the verdict.`}
              title={directionLabel}
              onClick={(event) => {
                event.stopPropagation();
                onShotClick?.(summary.shotNumber, deliverable.id, {
                  initialTab: "timeline",
                  runId: directionDrift.latestVerdictRunId ?? undefined,
                  pinnedTimelineEventId: directionDrift.timelineEventId,
                });
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-orange-400/40 bg-orange-500/15 px-2 py-1 text-[8px] font-mono uppercase tracking-wider text-orange-200 shadow-[0_0_16px_rgba(237,76,20,0.16)] transition-colors hover:border-orange-300/60 hover:bg-orange-500/25 focus:outline-none focus:ring-2 focus:ring-orange-300/45 focus:ring-offset-2 focus:ring-offset-[#0b0b0f]"
            >
              <AlertTriangle size={9} />
              Direction Drift
            </button>
          )}
          <span
            className={`rounded-lg border px-2 py-1 text-[8px] font-mono ${
              costOverCap
                ? "border-red-500/30 bg-red-500/10 text-red-300"
                : "border-white/10 bg-white/[0.03] text-white/60"
            }`}
          >
            {formatMoney(summary.cumulativeCost)}
          </span>
          {interactive && <ChevronRight size={12} className="text-white/20" />}
        </div>
      </div>
      {directionLabel && directionDrift && (
        <div className="mt-0 max-h-0 overflow-hidden transition-all duration-300 group-hover:mt-3 group-hover:max-h-40 group-focus-within:mt-3 group-focus-within:max-h-40">
          <div className="rounded-xl border border-orange-400/25 bg-orange-500/10 p-3">
            <div className="flex flex-wrap items-center gap-2 text-[8px] font-mono uppercase tracking-widest text-orange-200">
              <span className="inline-flex items-center gap-1">
                <AlertTriangle size={10} />
                Direction Drift
              </span>
              <span className="text-white/45">
                {directionDrift.verdict ?? "verdict"} · {directionDrift.latestVerdictRunId?.slice(0, 8) ?? "no-run"}
              </span>
            </div>
            <p className="mt-2 text-[10px] leading-5 text-white/65">
              {directionDrift.matchedClasses.map(formatDirectionClass).join(", ")}
            </p>
            <span className="sr-only">
              {directionLabel}. Latest verdict timestamp {directionDrift.latestVerdictTimestamp ?? "unknown"}.
            </span>
          </div>
        </div>
      )}
      {operatorOverride && overrideSummary && (
        <div className="mt-0 max-h-0 overflow-hidden transition-all duration-300 group-hover:mt-3 group-hover:max-h-56 group-focus-within:mt-3 group-focus-within:max-h-56">
          <div className="rounded-xl border border-[#ED4C14]/25 bg-[#ED4C14]/10 p-3">
            <div className="flex flex-wrap items-center gap-2 text-[8px] font-mono uppercase tracking-widest text-orange-200">
              <span className="inline-flex items-center gap-1">
                <ShieldCheck size={10} />
                OPERATOR OVERRIDE
              </span>
              <span className="text-white/45">{overrideSummary}</span>
            </div>
            {operatorOverride.rationale && (
              <p className="mt-2 text-[10px] leading-5 text-white/65">
                {operatorOverride.rationale}
              </p>
            )}
            <div className="mt-2 grid grid-cols-2 gap-2 text-[8px] font-mono uppercase tracking-wider text-white/50 sm:grid-cols-4">
              <span>critic_score <strong className="text-orange-100">{formatOverrideScore(operatorOverride.criticScore)}</strong></span>
              <span>decided_iter <strong className="text-orange-100">{operatorOverride.decidedIter ?? "—"}</strong></span>
              <span>decision_at <strong className="text-orange-100">{formatOverrideDate(operatorOverride.decisionAt)}</strong></span>
              <span>decision_by <strong className="text-orange-100">{operatorOverride.decisionBy ?? "—"}</strong></span>
            </div>
            <span className="sr-only">
              Operator override rationale: {operatorOverride.rationale ?? "No rationale recorded"}.
              Critic score {formatOverrideScore(operatorOverride.criticScore)}.
              Decided iteration {operatorOverride.decidedIter ?? "unknown"}.
              Decision date {operatorOverride.decisionAt}.
              Decision by {operatorOverride.decisionBy ?? "unknown"}.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function DeliverableTracker({ campaignId, runId, onShotClick }: DeliverableTrackerProps) {
  const [deliverables, setDeliverables] = useState<CampaignDeliverable[]>([]);
  const [shotSummaries, setShotSummaries] = useState<ShotSummary[]>([]);
  const [operatorOverrides, setOperatorOverrides] = useState<OperatorOverrideDecision[]>([]);
  const [directionDriftIndicators, setDirectionDriftIndicators] = useState<Record<string, DirectionDriftIndicator>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const deliverablesRef = useRef<CampaignDeliverable[]>([]);

  const refreshShotSummaries = useCallback(
    async (nextDeliverables?: CampaignDeliverable[]) => {
      const base = nextDeliverables ?? deliverablesRef.current;
      try {
        const summaries = await loadShotSummaries(campaignId, base, runId);
        setShotSummaries(summaries);
      } catch {
        setError("Couldn't refresh shot summaries. Retry.");
      }
    },
    [campaignId, runId],
  );

  const refreshOperatorOverrides = useCallback(async () => {
    try {
      setOperatorOverrides(await api.getOperatorOverridesForCampaign(campaignId));
    } catch {
      setError("Couldn't refresh operator overrides. Retry.");
    }
  }, [campaignId]);

  const refreshDirectionDriftIndicators = useCallback(async () => {
    try {
      setDirectionDriftIndicators(await api.getDirectionDriftIndicators(campaignId));
    } catch {
      setError("Couldn't refresh direction drift indicators. Retry.");
    }
  }, [campaignId]);

  useEffect(() => {
    let cancelled = false;
    deliverablesRef.current = [];
    setDeliverables([]);
    setShotSummaries([]);
    setOperatorOverrides([]);
    setDirectionDriftIndicators({});

    async function load() {
      try {
        setIsLoading(true);
        setError(null);
        const [data, overrides, directionIndicators] = await Promise.all([
          api.getCampaignDeliverables(campaignId),
          api.getOperatorOverridesForCampaign(campaignId),
          api.getDirectionDriftIndicators(campaignId),
        ]);
        if (cancelled) return;
        deliverablesRef.current = data;
        setDeliverables(data);
        setOperatorOverrides(overrides);
        setDirectionDriftIndicators(directionIndicators);
        const summaries = await loadShotSummaries(campaignId, data, runId);
        if (!cancelled) setShotSummaries(summaries);
      } catch {
        if (!cancelled) setError("Couldn't load campaign deliverables. Retry.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();

    const unsubscribeDeliverables = api.subscribeToCampaignDeliverables(campaignId, (updated) => {
      setDeliverables((previous) => {
        const next = upsertDeliverable(previous, updated);
        deliverablesRef.current = next;
        void refreshShotSummaries(next);
        return next;
      });
    });

    const decisionsChannel = runId
      ? supabase
          .channel(`orchestration_decisions:${runId}`)
          .on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "orchestration_decisions",
              filter: `run_id=eq.${runId}`,
            },
            () => {
              void refreshShotSummaries();
              void refreshDirectionDriftIndicators();
            },
          )
          .subscribe()
      : null;

    const runsChannel = supabase
      .channel(`operator_overrides:${campaignId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "runs",
          filter: `campaign_id=eq.${campaignId}`,
        },
        () => {
          void refreshOperatorOverrides();
          void refreshDirectionDriftIndicators();
        },
      )
      .subscribe();

    const directionDriftRunLogsChannel = supabase
      .channel(`direction_drift_run_logs:${campaignId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "run_logs",
        },
        () => {
          void refreshDirectionDriftIndicators();
        },
      )
      .subscribe();

    const directionDriftDecisionsChannel = supabase
      .channel(`direction_drift_orchestration_decisions:${campaignId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "orchestration_decisions",
        },
        () => {
          void refreshDirectionDriftIndicators();
        },
      )
      .subscribe();

    const directionDriftEscalationsChannel = supabase
      .channel(`direction_drift_asset_escalations:${campaignId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "asset_escalations",
        },
        () => {
          void refreshDirectionDriftIndicators();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      unsubscribeDeliverables();
      if (decisionsChannel) {
        void supabase.removeChannel(decisionsChannel);
      }
      void supabase.removeChannel(runsChannel);
      void supabase.removeChannel(directionDriftRunLogsChannel);
      void supabase.removeChannel(directionDriftDecisionsChannel);
      void supabase.removeChannel(directionDriftEscalationsChannel);
    };
  }, [campaignId, refreshDirectionDriftIndicators, refreshOperatorOverrides, refreshShotSummaries, reloadNonce, runId]);

  const mergedDeliverables = useMemo(() => {
    const summaryMap = new Map(shotSummaries.map((summary) => [summary.deliverableId, summary]));
    const fallbackMap = new Map(buildStubShotSummaries(deliverables).map((summary) => [summary.deliverableId, summary]));
    const latestOverrideByShot = new Map<number, OperatorOverrideDecision>();
    for (const override of operatorOverrides) {
      if (!latestOverrideByShot.has(override.shotNumber)) {
        latestOverrideByShot.set(override.shotNumber, override);
      }
    }
    return deliverables.map((deliverable) => {
      const summary = summaryMap.get(deliverable.id);
      const fallback = fallbackMap.get(deliverable.id) ?? buildStubShotSummaries([deliverable])[0];
      const resolvedShotNumber = summary?.shotNumber ?? fallback.shotNumber;
      return {
        deliverable,
        summary: summary
          ? {
              ...summary,
              shotNumber: resolvedShotNumber,
              beatName: summary.beatName ?? fallback.beatName,
            }
          : fallback,
        operatorOverride: resolvedShotNumber ? latestOverrideByShot.get(resolvedShotNumber) : undefined,
        directionDrift: directionDriftIndicators[deliverable.id],
      };
    });
  }, [deliverables, directionDriftIndicators, operatorOverrides, shotSummaries]);

  const counts = useMemo(
    () =>
      mergedDeliverables.reduce<Record<DeliverableStatus, number>>(
        (accumulator, item) => {
          accumulator[item.deliverable.status] += 1;
          return accumulator;
        },
        { pending: 0, generating: 0, reviewing: 0, approved: 0, rejected: 0, regenerating: 0 },
      ),
    [mergedDeliverables],
  );

  const totalCost = useMemo(
    () => mergedDeliverables.reduce((sum, item) => sum + item.summary.cumulativeCost, 0),
    [mergedDeliverables],
  );

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-8">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-400" />
        <span className="mt-3 text-[9px] font-mono uppercase tracking-widest text-white/30">Loading Deliverables</span>
      </div>
    );
  }


  if (error && deliverables.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8">
        <Layers size={24} className="mb-3 text-red-400/30" />
        <span className="text-[9px] font-mono uppercase tracking-widest text-red-300/70">Couldn't load deliverables</span>
        <button
          type="button"
          onClick={() => setReloadNonce((value) => value + 1)}
          className="mt-4 rounded-xl border border-cyan-500/25 px-4 py-2 text-[9px] font-mono uppercase tracking-wider text-cyan-300 hover:bg-cyan-500/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/40"
        >
          Retry
        </button>
      </div>
    );
  }

  if (deliverables.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8">
        <Layers size={24} className="mb-3 text-white/10" />
        <span className="text-[9px] font-mono uppercase tracking-widest text-white/30">No deliverables configured</span>
        <p className="mt-1 text-[8px] font-mono text-white/20">Add deliverables to this campaign to track generation progress</p>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3">
      {error && (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[9px] font-mono text-amber-200">
          {error}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center text-[9px] font-mono uppercase tracking-widest text-cyan-400/80">
          <Layers size={10} className="mr-1.5" />
          {deliverables.length} deliverable{deliverables.length !== 1 ? "s" : ""}
        </span>
        <div className="flex flex-wrap items-center justify-end gap-2 text-[8px] font-mono uppercase tracking-wider">
          {counts.approved > 0 && <span className="text-emerald-400">{counts.approved} approved</span>}
          {counts.reviewing > 0 && <span className="text-amber-400">{counts.reviewing} reviewing</span>}
          {counts.generating > 0 && <span className="text-cyan-400">{counts.generating} generating</span>}
          {counts.rejected > 0 && <span className="text-red-400">{counts.rejected} rejected</span>}
          <span className={totalCost > 45 ? "text-red-300" : "text-white/45"}>total cost: {formatMoney(totalCost)}</span>
        </div>
      </div>

      <div className="space-y-2">
        {mergedDeliverables.map(({ deliverable, summary, operatorOverride, directionDrift }) => (
          <ShotCard
            key={deliverable.id}
            deliverable={deliverable}
            summary={summary}
            operatorOverride={operatorOverride}
            directionDrift={directionDrift}
            onShotClick={onShotClick}
          />
        ))}
      </div>
    </div>
  );
}
