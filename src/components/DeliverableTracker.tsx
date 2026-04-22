import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Layers, RefreshCw } from "lucide-react";
import * as api from "../api";
import { supabase } from "../lib/supabase";
import type { CampaignDeliverable, DeliverableStatus } from "../api";

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
  onShotClick?: (shotNumber: number | null, deliverableId: string) => void;
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

function formatBeatLabel(beatName: string | null) {
  return beatName ? beatName.replace(/_/g, " ") : "unmapped";
}

function buildStubShotSummaries(deliverables: CampaignDeliverable[]): ShotSummary[] {
  return deliverables.map((deliverable, index) => ({
    deliverableId: deliverable.id,
    shotNumber: index + 1,
    beatName: null,
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
  }));
}

async function loadShotSummaries(
  campaignId: string,
  deliverables: CampaignDeliverable[],
): Promise<ShotSummary[]> {
  try {
    if (getShotSummariesCompat) {
      const summaries = await getShotSummariesCompat(campaignId);
      if (Array.isArray(summaries) && summaries.length > 0) {
        return summaries;
      }
    }

    const response = await fetch(`${OS_API_URL}/api/campaigns/${campaignId}/shot-summaries`);
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
  onShotClick,
}: {
  deliverable: CampaignDeliverable;
  summary: ShotSummary;
  onShotClick?: (shotNumber: number | null, deliverableId: string) => void;
}) {
  const statusStyle = statusStyles[deliverable.status];
  const costOverCap = summary.cumulativeCost > 4;
  const interactive = Boolean(onShotClick);

  return (
    <button
      type="button"
      onClick={() => onShotClick?.(summary.shotNumber, deliverable.id)}
      className={`w-full rounded-xl border bg-white/[0.02] p-3 text-left transition-all ${statusStyle.border} ${
        interactive ? "hover:border-cyan-400/40 hover:bg-white/[0.04]" : "cursor-default"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
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
    </button>
  );
}

export default function DeliverableTracker({ campaignId, runId, onShotClick }: DeliverableTrackerProps) {
  const [deliverables, setDeliverables] = useState<CampaignDeliverable[]>([]);
  const [shotSummaries, setShotSummaries] = useState<ShotSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const deliverablesRef = useRef<CampaignDeliverable[]>([]);

  const refreshShotSummaries = useCallback(
    async (nextDeliverables?: CampaignDeliverable[]) => {
      const base = nextDeliverables ?? deliverablesRef.current;
      const summaries = await loadShotSummaries(campaignId, base);
      setShotSummaries(summaries);
    },
    [campaignId],
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setIsLoading(true);
        const data = await api.getCampaignDeliverables(campaignId);
        if (cancelled) return;
        deliverablesRef.current = data;
        setDeliverables(data);
        const summaries = await loadShotSummaries(campaignId, data);
        if (!cancelled) setShotSummaries(summaries);
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
            },
          )
          .subscribe()
      : null;

    return () => {
      cancelled = true;
      unsubscribeDeliverables();
      if (decisionsChannel) {
        void supabase.removeChannel(decisionsChannel);
      }
    };
  }, [campaignId, refreshShotSummaries, runId]);

  const mergedDeliverables = useMemo(() => {
    const summaryMap = new Map(shotSummaries.map((summary) => [summary.deliverableId, summary]));
    const fallbackMap = new Map(buildStubShotSummaries(deliverables).map((summary) => [summary.deliverableId, summary]));
    return deliverables.map((deliverable) => ({
      deliverable,
      summary: summaryMap.get(deliverable.id) ?? fallbackMap.get(deliverable.id) ?? buildStubShotSummaries([deliverable])[0],
    }));
  }, [deliverables, shotSummaries]);

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
        {mergedDeliverables.map(({ deliverable, summary }) => (
          <ShotCard
            key={deliverable.id}
            deliverable={deliverable}
            summary={summary}
            onShotClick={onShotClick}
          />
        ))}
      </div>
    </div>
  );
}
