import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  Clock3,
  Loader2,
  Radio,
  RotateCw,
  Workflow,
} from "lucide-react";
import * as api from "../api";
import type { RecentCampaignRun, RunStatus } from "../api";

interface RecentRunsPanelProps {
  clientId: string;
  campaignId: string;
  onRunClick: (runId: string) => void;
}

const statusStyles: Record<RunStatus, string> = {
  pending: "border-white/15 bg-white/[0.04] text-white/55",
  running: "border-cyan-400/35 bg-cyan-400/10 text-cyan-200",
  needs_review: "border-amber-400/35 bg-amber-400/10 text-amber-200",
  blocked: "border-red-400/35 bg-red-400/10 text-red-200",
  completed: "border-emerald-400/35 bg-emerald-400/10 text-emerald-200",
  failed: "border-red-400/35 bg-red-400/10 text-red-200",
  cancelled: "border-white/15 bg-white/[0.03] text-white/35",
};

function formatDuration(seconds: number | null) {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTimestamp(value: string) {
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

function formatShotIds(run: RecentCampaignRun) {
  if (run.shotIds && run.shotIds.length > 0) {
    return `shot_ids [${run.shotIds.join(", ")}]`;
  }
  if (run.auditMode === true) return "audit: all shots";
  return "full campaign scope";
}

function statusLabel(status: RunStatus) {
  return status.replace(/_/g, " ");
}

export default function RecentRunsPanel({ clientId, campaignId, onRunClick }: RecentRunsPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [hitlOnly, setHitlOnly] = useState(false);
  const [runs, setRuns] = useState<RecentCampaignRun[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const refreshRequestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestIdRef.current;
    try {
      setIsLoading(true);
      setError(null);
      const nextRuns = await api.getCampaignRecentRuns(campaignId, 10);
      if (requestId !== refreshRequestIdRef.current) return;
      setRuns(nextRuns);
      setLastRefreshedAt(new Date().toISOString());
    } catch (err) {
      if (requestId !== refreshRequestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load recent runs");
    } finally {
      if (requestId === refreshRequestIdRef.current) setIsLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    setIsLoading(true);
    setRuns([]);
    void refresh();

    const unsubscribe = api.subscribeToRunsByClient(clientId, () => {
      void refresh();
    });

    return () => {
      unsubscribe();
    };
  }, [clientId, refresh]);

  const visibleRuns = useMemo(
    () => (hitlOnly ? runs.filter((run) => run.hitlRequired) : runs),
    [hitlOnly, runs],
  );

  const activeRunCount = useMemo(
    () => runs.filter((run) => run.status === "pending" || run.status === "running").length,
    [runs],
  );

  return (
    <section className="mt-4 rounded-2xl border border-cyan-400/15 bg-[#070a0f]/80 shadow-[0_0_40px_rgba(0,0,0,0.22)] backdrop-blur-xl">
      <div className="flex flex-col gap-3 border-b border-white/10 p-3 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          onClick={() => setIsExpanded((value) => !value)}
          aria-expanded={isExpanded}
          className="group flex min-w-0 items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-all focus:outline-none focus:ring-2 focus:ring-cyan-400/45 hover:bg-white/[0.04]"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/10 text-cyan-200">
            <Workflow size={15} />
          </span>
          <span className="min-w-0">
            <span className="block text-[9px] font-mono uppercase tracking-[0.28em] text-cyan-100/75">
              Recent runs
            </span>
            <span className="mt-0.5 block truncate text-[8px] font-mono uppercase tracking-[0.18em] text-white/35">
              Last 10 campaign runs · {runs.length} loaded
              {activeRunCount > 0 ? ` · ${activeRunCount} active` : ""}
            </span>
          </span>
          <ChevronDown
            size={14}
            className={`shrink-0 text-white/35 transition-transform group-hover:text-cyan-200 ${isExpanded ? "" : "-rotate-90"}`}
          />
        </button>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setHitlOnly((value) => !value)}
            aria-pressed={hitlOnly}
            aria-label="Filter recent campaign runs to HITL required only"
            className={`rounded-full border px-3 py-1.5 text-[8px] font-mono uppercase tracking-[0.18em] transition-all focus:outline-none focus:ring-2 focus:ring-amber-300/45 ${
              hitlOnly
                ? "border-amber-300/45 bg-amber-300/15 text-amber-100"
                : "border-white/10 bg-white/[0.03] text-white/45 hover:border-amber-300/35 hover:text-amber-100"
            }`}
          >
            HITL only
          </button>
          <button
            type="button"
            onClick={() => {
              setIsLoading(true);
              void refresh();
            }}
            aria-label="Refresh recent campaign runs"
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[8px] font-mono uppercase tracking-[0.18em] text-white/45 transition-all hover:border-cyan-300/35 hover:text-cyan-100 focus:outline-none focus:ring-2 focus:ring-cyan-400/45"
          >
            <RotateCw size={10} className={isLoading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="p-3">
          {error ? (
            <div className="flex items-center gap-2 rounded-xl border border-red-400/25 bg-red-400/10 px-3 py-2 text-[9px] text-red-100">
              <AlertCircle size={13} />
              <span>{error}</span>
            </div>
          ) : isLoading && runs.length === 0 ? (
            <div className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.025] px-3 py-6 text-[9px] font-mono uppercase tracking-widest text-white/35">
              <Loader2 size={14} className="animate-spin text-cyan-300/70" />
              Loading campaign runs
            </div>
          ) : visibleRuns.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.025] px-3 py-6 text-center">
              <p className="text-[9px] font-mono uppercase tracking-[0.22em] text-white/45">
                {hitlOnly ? "No HITL-required runs in the recent 10." : "No campaign runs found."}
              </p>
              {hitlOnly && (
                <p className="mt-2 text-[8px] leading-relaxed text-white/30">
                  All visible Drift MV overrides are resolved; clear the filter to inspect the full run history.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {visibleRuns.map((run) => (
                <button
                  key={run.runId}
                  type="button"
                  onClick={() => onRunClick(run.runId)}
                  className="group grid w-full grid-cols-1 gap-3 rounded-xl border border-white/10 bg-white/[0.025] p-3 text-left transition-all hover:border-cyan-300/35 hover:bg-cyan-300/[0.06] focus:outline-none focus:ring-2 focus:ring-cyan-400/45 md:grid-cols-[minmax(130px,0.9fr)_minmax(190px,1.2fr)_100px_minmax(150px,0.9fr)] md:items-center"
                >
                  <div className="min-w-0">
                    <p className="text-[11px] font-mono font-semibold uppercase tracking-[0.18em] text-white">
                      {run.runId.slice(0, 8)}
                    </p>
                    <p className="mt-1 truncate text-[8px] font-mono uppercase tracking-[0.16em] text-white/35">
                      {formatTimestamp(run.createdAt)}
                    </p>
                  </div>

                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-2 py-1 text-[8px] font-mono uppercase tracking-[0.18em] text-cyan-100">
                        {run.mode}
                      </span>
                      <span className="truncate text-[9px] font-mono text-white/45">
                        {formatShotIds(run)}
                      </span>
                    </div>
                    {run.parentRunId && (
                      <p className="mt-1 text-[8px] font-mono uppercase tracking-wider text-purple-200/60">
                        parent {run.parentRunId.slice(0, 8)}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 text-[9px] font-mono uppercase tracking-wider text-white/45">
                    <Clock3 size={12} className="text-cyan-200/60" />
                    {formatDuration(run.durationSeconds)}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 md:justify-end">
                    <span
                      aria-label={`Run status ${statusLabel(run.status)}`}
                      className={`rounded-full border px-2 py-1 text-[8px] font-mono uppercase tracking-[0.16em] ${statusStyles[run.status]}`}
                    >
                      {statusLabel(run.status)}
                    </span>
                    {run.hitlRequired && (
                      <span
                        aria-label="HITL required for this run"
                        className="inline-flex items-center gap-1 rounded-full border border-amber-300/35 bg-amber-300/10 px-2 py-1 text-[8px] font-mono uppercase tracking-[0.16em] text-amber-100"
                      >
                        <Radio size={8} className="animate-pulse" />
                        HITL
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {lastRefreshedAt && (
            <p className="mt-3 text-right text-[7px] font-mono uppercase tracking-[0.18em] text-white/25">
              Realtime armed · refreshed {formatTimestamp(lastRefreshedAt)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
