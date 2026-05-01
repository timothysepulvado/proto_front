import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Gauge,
  Play,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";
import * as api from "../api";
import {
  AUDIT_CRITIC_UNIT_COST,
  buildAuditSummary,
  formatAuditRecommendation,
  getAuditRecommendationBucket,
  parseAuditReport,
  parseAuditVerdictLog,
  sortAuditShots,
  upsertAuditShot,
  type AuditReport,
  type AuditReportShot,
  type AuditReportSummary,
  type AuditVerdict,
} from "../lib/auditReport";
import type { CampaignDeliverable, Run, RunLog } from "../api";

type SortMode = "shot" | "risk";

type ShotClickPayload = {
  shotNumber: number;
  deliverableId: string;
  auditShot: AuditReportShot;
  runId: string;
};

interface AuditTriageTableProps {
  clientId: string;
  campaignId: string;
  campaignName: string;
  onAuditRunStarted?: (run: Run) => void;
  onAuditRunSettled?: (run: Run) => void;
  onAuditLog?: (log: RunLog) => void;
  onAuditShotClick?: (payload: ShotClickPayload) => void;
}

const verdictStyles: Record<AuditVerdict, string> = {
  PASS: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  WARN: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  FAIL: "border-red-500/30 bg-red-500/10 text-red-300",
};

const recommendationStyles = {
  KEEP: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
  L1: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300",
  L2: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  L3: "border-red-500/30 bg-red-500/10 text-red-300",
  ERROR: "border-red-500/40 bg-red-500/15 text-red-200",
} satisfies Record<ReturnType<typeof getAuditRecommendationBucket>, string>;

const summaryItems: Array<{ key: keyof AuditReportSummary; label: string; className: string }> = [
  { key: "keep", label: "KEEP", className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300" },
  { key: "l1", label: "L1", className: "border-cyan-500/25 bg-cyan-500/10 text-cyan-300" },
  { key: "l2", label: "L2", className: "border-amber-500/25 bg-amber-500/10 text-amber-300" },
  { key: "l3", label: "L3", className: "border-red-500/25 bg-red-500/10 text-red-300" },
  { key: "errors", label: "ERR", className: "border-red-500/25 bg-red-500/10 text-red-200" },
];

function isAuditActive(run: Run | null): run is Run {
  return run?.status === "pending" || run?.status === "running";
}

function formatMoney(value: number | null | undefined) {
  if (value == null) return "—";
  return `$${value.toFixed(2)}`;
}

function formatLatency(value: number | null | undefined) {
  if (value == null) return "—";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${Math.round(value / 1000)}s`;
}

function formatScore(value: number | null | undefined) {
  return value == null ? "—" : value.toFixed(2);
}

function deriveShotNumber(deliverable: CampaignDeliverable, index: number) {
  const description = deliverable.description ?? "";
  const match = /shot\s+(\d{1,2})\s*[·:-]/i.exec(description);
  return match ? Number.parseInt(match[1], 10) : index + 1;
}

function buildDeliverableByShot(deliverables: CampaignDeliverable[]) {
  return new Map(deliverables.map((deliverable, index) => [deriveShotNumber(deliverable, index), deliverable.id]));
}

function getReportFromRun(run: Run | null): AuditReport | null {
  return parseAuditReport(run?.metadata?.audit_report);
}

function rowTone(shot: AuditReportShot) {
  if (shot.errorMessage || shot.verdict === "FAIL") return "hover:border-red-400/40 hover:bg-red-500/[0.04]";
  if (shot.verdict === "WARN") return "hover:border-amber-400/40 hover:bg-amber-500/[0.04]";
  return "hover:border-cyan-400/35 hover:bg-cyan-400/[0.035]";
}

export default function AuditTriageTable({
  clientId,
  campaignId,
  campaignName,
  onAuditRunStarted,
  onAuditRunSettled,
  onAuditLog,
  onAuditShotClick,
}: AuditTriageTableProps) {
  const [deliverables, setDeliverables] = useState<CampaignDeliverable[]>([]);
  const [auditRun, setAuditRun] = useState<Run | null>(null);
  const [auditReport, setAuditReport] = useState<AuditReport | null>(null);
  const [liveShots, setLiveShots] = useState<AuditReportShot[]>([]);
  const [sortMode, setSortMode] = useState<SortMode>("shot");
  const [isLoading, setIsLoading] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Gap 2 (2026-04-30): in-loop runs since the last audit-mode pass.
  // null = no audit run exists yet OR query failed (banner falls back).
  const [inLoopRunsSinceAudit, setInLoopRunsSinceAudit] = useState<number | null>(null);

  const loadAuditState = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [nextDeliverables, latestAuditRun] = await Promise.all([
        api.getCampaignDeliverables(campaignId),
        api.getLatestStillsAuditRun(campaignId),
      ]);
      setDeliverables(nextDeliverables);
      setAuditRun(latestAuditRun);
      setAuditReport(getReportFromRun(latestAuditRun));

      if (isAuditActive(latestAuditRun)) {
        const logs = await api.getRunLogs(latestAuditRun.runId).catch(() => []);
        setLiveShots(
          logs
            .map((log) => parseAuditVerdictLog(log.message))
            .filter((shot): shot is AuditReportShot => shot !== null),
        );
      } else {
        setLiveShots([]);
      }
      // Gap 2: count in-loop runs that have happened SINCE this audit run
      // landed. The cutoff is the audit's createdAt — anything after it is
      // a regen the operator may want reflected in a fresh audit.
      const auditCutoff = latestAuditRun?.createdAt ?? null;
      const sinceCount = await api.getInLoopRunsSinceAudit(campaignId, auditCutoff);
      setInLoopRunsSinceAudit(sinceCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit state");
    } finally {
      setIsLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    void loadAuditState();
  }, [loadAuditState]);

  useEffect(() => {
    if (!isAuditActive(auditRun)) return;
    const runId = auditRun.runId;
    let cancelled = false;

    const settleRun = async () => {
      try {
        const updatedRun = await api.getRun(runId);
        if (!updatedRun || cancelled) return;
        setAuditRun(updatedRun);
        const report = getReportFromRun(updatedRun);
        if (report) setAuditReport(report);
        if (!isAuditActive(updatedRun)) {
          setLiveShots([]);
          onAuditRunSettled?.(updatedRun);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to refresh completed audit run");
        }
      }
    };

    api.getRunLogs(runId)
      .then((logs) => {
        if (cancelled) return;
        setLiveShots(
          logs
            .map((log) => parseAuditVerdictLog(log.message))
            .filter((shot): shot is AuditReportShot => shot !== null),
        );
      })
      .catch(() => undefined);

    const unsubscribe = api.subscribeToLogs(
      runId,
      (log) => {
        onAuditLog?.(log);
        const shot = parseAuditVerdictLog(log.message);
        if (shot) setLiveShots((previous) => upsertAuditShot(previous, shot));
      },
      () => {
        void settleRun();
      },
      (subscriptionError) => {
        setError(subscriptionError.message);
      },
    );

    const poll = window.setInterval(() => {
      void settleRun();
    }, 15000);

    return () => {
      cancelled = true;
      unsubscribe();
      window.clearInterval(poll);
    };
  }, [auditRun?.runId, auditRun?.status, onAuditLog, onAuditRunSettled]);

  const deliverableByShot = useMemo(() => buildDeliverableByShot(deliverables), [deliverables]);
  const sourceRows = auditReport?.shots ?? liveShots;
  const rows = useMemo(() => sortAuditShots(sourceRows, sortMode), [sourceRows, sortMode]);
  const summary = auditReport?.summary ?? buildAuditSummary(sourceRows);
  const estimatedCost = deliverables.length * AUDIT_CRITIC_UNIT_COST;
  const progressTotal = deliverables.length || sourceRows.length || auditReport?.shots.length || 0;
  const progressCount = Math.min(sourceRows.length, progressTotal);
  const progressPct = progressTotal > 0 ? Math.round((progressCount / progressTotal) * 100) : 0;
  const auditRunId = auditRun?.runId ?? null;
  const active = isAuditActive(auditRun);
  const lastCompletedAt = auditReport?.completedAt ? new Date(auditReport.completedAt) : null;

  const startAudit = useCallback(async () => {
    setIsStarting(true);
    setError(null);
    try {
      const run = await api.createStillsAuditRun(clientId, campaignId);
      setAuditRun(run);
      setAuditReport(null);
      setLiveShots([]);
      setConfirmOpen(false);
      onAuditRunStarted?.(run);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start stills audit");
    } finally {
      setIsStarting(false);
    }
  }, [campaignId, clientId, onAuditRunStarted]);

  return (
    <>
      <section data-testid="audit-triage-table" className="mt-4 overflow-hidden rounded-[1.6rem] border border-white/10 bg-black/25 shadow-2xl backdrop-blur-xl">
      <div className="relative border-b border-white/10 p-4 md:p-5">
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent via-[#ED4C14]/70 to-transparent opacity-70" />
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-[#ED4C14]/30 bg-[#ED4C14]/10 px-3 py-1 text-[8px] font-mono font-bold uppercase tracking-[0.24em] text-orange-100">
                Audit Mode
              </span>
              <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-[8px] font-mono uppercase tracking-[0.24em] text-cyan-100/70">
                {active ? "Streaming Verdicts" : auditReport ? "Latest Report" : "Ready"}
              </span>
            </div>
            <h3 className="mt-3 text-xl font-black uppercase italic tracking-tight text-white md:text-2xl">
              Still Audit Triage
            </h3>
            <p className="mt-2 max-w-3xl text-[10px] font-mono uppercase leading-relaxed tracking-[0.16em] text-white/42">
              Fire the parallel critic pass for {campaignName}, monitor per-shot verdicts, then open the critic drawer from any row.
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center xl:justify-end">
            <button
              type="button"
              onClick={() => setSortMode((mode) => (mode === "shot" ? "risk" : "shot"))}
              className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[8px] font-mono uppercase tracking-[0.2em] text-white/50 transition-all hover:border-cyan-400/25 hover:text-cyan-200 focus:outline-none focus:ring-2 focus:ring-cyan-400/40"
            >
              <SlidersHorizontal size={12} className="mr-2" />
              {sortMode === "shot" ? "Sort Risk" : "Sort Shot"}
            </button>
            <button
              type="button"
              onClick={() => void loadAuditState()}
              className="inline-flex items-center justify-center rounded-xl border border-cyan-400/15 bg-cyan-400/10 px-3 py-2 text-[8px] font-mono uppercase tracking-[0.2em] text-cyan-100 transition-all hover:border-cyan-300/40 hover:bg-cyan-300 hover:text-black focus:outline-none focus:ring-2 focus:ring-cyan-400/40"
            >
              <RefreshCw size={12} className="mr-2" /> Refresh
            </button>
            <button
              type="button"
              disabled={isStarting || active || deliverables.length === 0}
              onClick={() => setConfirmOpen(true)}
              className="inline-flex items-center justify-center rounded-xl bg-[#ED4C14] px-4 py-2 text-[8px] font-black uppercase tracking-[0.22em] text-white shadow-[0_0_28px_rgba(237,76,20,0.22)] transition-all hover:bg-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-300/50 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Play size={12} className="mr-2" /> Run Audit
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {summaryItems.map((item) => (
            <div key={item.key} className={`rounded-2xl border px-3 py-2 ${item.className}`}>
              <p className="text-[8px] font-mono uppercase tracking-[0.24em] opacity-70">{item.label}</p>
              <p className="mt-1 font-mono text-2xl font-black">{summary[item.key].toString()}</p>
            </div>
          ))}
          <div className="rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-2 text-white/70">
            <p className="text-[8px] font-mono uppercase tracking-[0.24em] text-white/40">Cost</p>
            <p className="mt-1 font-mono text-2xl font-black text-white">{formatMoney(summary.totalCost)}</p>
            <p className="mt-1 text-[7px] font-mono uppercase tracking-wider text-white/30">est {formatMoney(estimatedCost)}</p>
          </div>
        </div>

        {active && (
          <div className="mt-4 rounded-2xl border border-cyan-400/20 bg-cyan-400/8 p-3">
            <div className="flex items-center justify-between gap-3 text-[9px] font-mono uppercase tracking-[0.2em] text-cyan-100/75">
              <span className="flex items-center gap-2"><Gauge size={12} /> Audit running · {progressCount}/{progressTotal || "—"} verdicts</span>
              <span>{progressPct}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-[#ED4C14] transition-all duration-500" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        )}

        {!active && auditReport && (
          <div className="mt-4 flex flex-wrap items-center gap-2 text-[8px] font-mono uppercase tracking-[0.2em] text-white/35">
            <span className="inline-flex items-center gap-1.5"><CheckCircle2 size={11} className="text-emerald-300" /> Report complete</span>
            {lastCompletedAt && <span>{lastCompletedAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</span>}
            {auditRunId && <span>Run {auditRunId.slice(0, 8)}</span>}
            {auditReport.traceId && <span>Trace {auditReport.traceId.slice(0, 8)}</span>}
          </div>
        )}

        {/* Gap 2 (2026-04-30): staleness banner — fires when in-loop regen
            runs have happened since the last audit-mode pass. Operator
            knows the triage data is N runs behind reality and can hit
            Run Audit to refresh. */}
        {!active && auditReport && inLoopRunsSinceAudit != null && inLoopRunsSinceAudit > 0 && (
          <div className="mt-3 rounded-2xl border border-[#ED4C14]/35 bg-[#ED4C14]/10 px-3 py-2.5 text-[9px] font-mono uppercase tracking-[0.18em] text-orange-100">
            <div className="flex flex-wrap items-center gap-2">
              <Clock3 size={11} className="text-orange-200/85" />
              <span>
                <strong className="font-bold text-orange-100">{inLoopRunsSinceAudit}</strong>
                {" "}in-loop run{inLoopRunsSinceAudit === 1 ? "" : "s"} since this audit
              </span>
              <span className="text-orange-200/60">·</span>
              <span className="text-orange-200/60">
                triage may be stale — fire a fresh audit to refresh
              </span>
            </div>
          </div>
        )}
        {!active && !auditReport && inLoopRunsSinceAudit != null && inLoopRunsSinceAudit > 0 && (
          /* Edge case: no audit_report on the latest audit run (e.g., audit
             never wrote metadata.audit_report) but in-loop runs exist after.
             Still surface the staleness so the operator isn't blind. */
          <div className="mt-3 rounded-2xl border border-[#ED4C14]/35 bg-[#ED4C14]/10 px-3 py-2.5 text-[9px] font-mono uppercase tracking-[0.18em] text-orange-100">
            <div className="flex flex-wrap items-center gap-2">
              <Clock3 size={11} className="text-orange-200/85" />
              <span>
                <strong className="font-bold text-orange-100">{inLoopRunsSinceAudit}</strong>
                {" "}in-loop run{inLoopRunsSinceAudit === 1 ? "" : "s"} since last audit attempt
              </span>
              <span className="text-orange-200/60">· no triage report — fire a fresh audit</span>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-2xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[9px] font-mono text-red-200">
            <AlertTriangle size={12} className="mr-2 inline" /> {error}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-10">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-400" />
          <span className="mt-3 text-[9px] font-mono uppercase tracking-widest text-white/30">Loading audit state</span>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
          <ShieldCheck size={26} className="mb-3 text-white/15" />
          <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-white/45">No audit run on this campaign yet</p>
          <p className="mt-2 max-w-md text-[11px] leading-5 text-white/35">
            Click Run Audit to start a parallel stills critic pass. Verdicts stream here as each shot completes.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-[920px] w-full border-separate border-spacing-0 text-left">
            <thead className="bg-white/[0.025] text-[8px] font-mono uppercase tracking-[0.22em] text-white/35">
              <tr>
                <th className="px-4 py-3 font-medium">Shot</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Score</th>
                <th className="px-4 py-3 font-medium">Recommendation</th>
                <th className="px-4 py-3 font-medium">Failure classes</th>
                <th className="px-4 py-3 font-medium">Cost</th>
                <th className="px-4 py-3 font-medium">Latency</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((shot) => {
                const bucket = getAuditRecommendationBucket(shot.recommendation, Boolean(shot.errorMessage));
                const deliverableId = deliverableByShot.get(shot.shotId);
                const scoreWidth = Math.max(0, Math.min(100, ((shot.aggregateScore ?? 0) / 5) * 100));
                return (
                  <tr
                    key={shot.shotId}
                    tabIndex={deliverableId ? 0 : -1}
                    onClick={() => {
                      if (!deliverableId || !auditRunId) return;
                      onAuditShotClick?.({ shotNumber: shot.shotId, deliverableId, auditShot: shot, runId: auditRunId });
                    }}
                    onKeyDown={(event) => {
                      if ((event.key === "Enter" || event.key === " ") && deliverableId && auditRunId) {
                        event.preventDefault();
                        onAuditShotClick?.({ shotNumber: shot.shotId, deliverableId, auditShot: shot, runId: auditRunId });
                      }
                    }}
                    className={`group border-b border-white/5 text-[10px] transition-all ${deliverableId ? `cursor-pointer ${rowTone(shot)}` : "opacity-60"}`}
                  >
                    <td className="border-t border-white/5 px-4 py-3 align-top">
                      <div className="flex items-center gap-3">
                        <img
                          src={api.getProductionShotThumbnailUrl("drift-mv", shot.shotId)}
                          alt={`Shot ${shot.shotId} thumbnail`}
                          loading="lazy"
                          className="h-11 w-16 rounded-lg border border-white/10 object-cover opacity-80"
                          onError={(event) => {
                            event.currentTarget.style.display = "none";
                          }}
                        />
                        <div>
                          <p className="font-mono text-sm font-black text-white">#{shot.shotId}</p>
                          <p className="mt-0.5 text-[7px] font-mono uppercase tracking-wider text-white/25">
                            {deliverableId ? `deliverable ${deliverableId.slice(0, 8)}` : "unmapped"}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="border-t border-white/5 px-4 py-3 align-top">
                      {shot.verdict ? (
                        <span className={`rounded-full border px-2.5 py-1 text-[8px] font-mono font-bold uppercase tracking-[0.18em] ${verdictStyles[shot.verdict]}`}>
                          {shot.verdict}
                        </span>
                      ) : (
                        <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[8px] font-mono font-bold uppercase tracking-[0.18em] text-red-200">
                          Error
                        </span>
                      )}
                    </td>
                    <td className="border-t border-white/5 px-4 py-3 align-top">
                      <div className="min-w-[110px]">
                        <div className="flex items-center justify-between gap-2 font-mono text-white/75">
                          <span>{formatScore(shot.aggregateScore)}</span>
                          <span className="text-white/25">/ 5</span>
                        </div>
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
                          <div
                            className={`h-full rounded-full ${shot.verdict === "FAIL" ? "bg-red-300" : shot.verdict === "WARN" ? "bg-amber-300" : "bg-cyan-300"}`}
                            style={{ width: `${scoreWidth}%` }}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="border-t border-white/5 px-4 py-3 align-top">
                      <span className={`rounded-full border px-2.5 py-1 text-[8px] font-mono font-bold uppercase tracking-[0.18em] ${recommendationStyles[bucket]}`}>
                        {formatAuditRecommendation(shot.recommendation, Boolean(shot.errorMessage))}
                      </span>
                    </td>
                    <td className="border-t border-white/5 px-4 py-3 align-top">
                      {shot.detectedFailureClasses.length > 0 ? (
                        <div className="flex max-w-[330px] flex-wrap gap-1.5">
                          {shot.detectedFailureClasses.map((failureClass) => (
                            <span key={`${shot.shotId}:${failureClass}`} className="rounded-full border border-[#ED4C14]/25 bg-[#ED4C14]/10 px-2 py-0.5 text-[7px] font-mono uppercase tracking-wider text-orange-100/80">
                              {failureClass.replace(/_/g, " ")}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-[8px] font-mono uppercase tracking-widest text-white/25">none</span>
                      )}
                    </td>
                    <td className="border-t border-white/5 px-4 py-3 align-top font-mono text-white/55">{formatMoney(shot.cost)}</td>
                    <td className="border-t border-white/5 px-4 py-3 align-top font-mono text-white/55">
                      <span className="inline-flex items-center gap-1.5"><Clock3 size={10} className="text-white/25" />{formatLatency(shot.latencyMs)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      </section>

      {confirmOpen && createPortal(
        <div className="fixed inset-0 z-[760] flex items-center justify-center bg-black/60 p-4 backdrop-blur-md">
          <div className="w-full max-w-md overflow-hidden rounded-[2rem] border border-[#ED4C14]/30 bg-[#0b0b0f] shadow-[0_0_80px_rgba(0,0,0,0.65)]">
            <div className="border-b border-white/10 p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[8px] font-mono uppercase tracking-[0.3em] text-orange-200/70">Confirm Audit</p>
                  <h4 className="mt-2 text-xl font-black uppercase italic tracking-tight text-white">Run stills audit?</h4>
                </div>
                <button
                  type="button"
                  onClick={() => setConfirmOpen(false)}
                  className="rounded-full border border-white/10 p-2 text-white/45 hover:border-white/20 hover:text-white"
                >
                  <X size={14} />
                </button>
              </div>
              <p className="mt-4 text-[12px] leading-6 text-white/70">
                Run audit on <span className="font-semibold text-white">{deliverables.length}</span> stills? Estimated cost: <span className="font-semibold text-orange-200">~{formatMoney(estimatedCost)}</span> at $0.10/critic.
              </p>
              <p className="mt-3 rounded-2xl border border-cyan-400/15 bg-cyan-400/8 p-3 text-[10px] font-mono uppercase leading-5 tracking-[0.14em] text-cyan-100/60">
                This starts mode:stills with auditMode=true and streams verdicts back into this table.
              </p>
            </div>
            <div className="flex flex-col gap-2 p-5 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="rounded-xl border border-white/10 px-4 py-2 text-[9px] font-mono uppercase tracking-[0.2em] text-white/55 transition-colors hover:bg-white/5 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isStarting}
                onClick={() => void startAudit()}
                className="rounded-xl bg-[#ED4C14] px-4 py-2 text-[9px] font-black uppercase tracking-[0.2em] text-white transition-colors hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isStarting ? "Starting…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
