import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Archive,
  ChevronRight,
  Film,
  Image as ImageIcon,
  Loader2,
  ScrollText,
  Workflow,
  X,
} from "lucide-react";
import * as api from "../api";
import type { Artifact, RunCostLedgerResponse, RunDetail, RunLog, RunStatus } from "../api";

interface RunDetailDrawerProps {
  runId: string | null;
  onClose: () => void;
  onRunSelect?: (runId: string) => void;
}

const terminalStatuses = new Set<RunStatus>(["blocked", "cancelled", "completed", "failed"]);

type LedgerBreakdownMode = "event_type" | "source";

const logStyles: Record<RunLog["level"], string> = {
  info: "border-cyan-400/15 text-cyan-100/80",
  warn: "border-amber-400/25 text-amber-100/85",
  error: "border-red-400/30 text-red-100/90",
  debug: "border-white/10 text-white/45",
};

const statusStyles: Record<RunStatus, string> = {
  pending: "border-white/15 bg-white/[0.04] text-white/55",
  running: "border-cyan-400/35 bg-cyan-400/10 text-cyan-200",
  needs_review: "border-amber-400/35 bg-amber-400/10 text-amber-200",
  blocked: "border-red-400/35 bg-red-400/10 text-red-200",
  completed: "border-emerald-400/35 bg-emerald-400/10 text-emerald-200",
  failed: "border-red-400/35 bg-red-400/10 text-red-200",
  cancelled: "border-white/15 bg-white/[0.03] text-white/35",
};

function formatTimestamp(value: string | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatDuration(start: string | undefined, end: string | undefined) {
  if (!start || !end) return "—";
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return "—";
  const seconds = Math.round((endMs - startMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatMoney(value: number) {
  return `$${value.toFixed(4)}`;
}

function formatLedgerKey(value: string) {
  return value.trim().length > 0 ? value : "unknown";
}

function statusLabel(status: RunStatus) {
  return status.replace(/_/g, " ");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractShotIds(metadata: Record<string, unknown> | undefined): number[] {
  const raw = metadata?.shot_ids;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === "number" && Number.isInteger(item)) return item;
      if (typeof item === "string") {
        const parsed = Number.parseInt(item, 10);
        return Number.isInteger(parsed) ? parsed : null;
      }
      return null;
    })
    .filter((item): item is number => item !== null && item > 0);
}

function artifactThumbSrc(artifact: Artifact) {
  if (/^https?:\/\//i.test(artifact.path)) return artifact.path;
  if (/^https?:\/\//i.test(artifact.storagePath ?? "")) return artifact.storagePath;
  return null;
}

function upsertLog(logs: RunLog[], next: RunLog) {
  const index = logs.findIndex((log) => log.id === next.id);
  if (index !== -1) {
    const copy = [...logs];
    copy[index] = next;
    return copy.sort((a, b) => a.id - b.id);
  }
  return [...logs, next].sort((a, b) => a.id - b.id);
}

function ArtifactTile({ artifact }: { artifact: Artifact }) {
  const thumbSrc = artifactThumbSrc(artifact);
  const isImage = artifact.type === "image";
  const isVideo = artifact.type === "video";

  return (
    <a
      href={thumbSrc ?? artifact.path}
      target="_blank"
      rel="noreferrer"
      className="group block overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] transition-all hover:border-cyan-300/35 focus:outline-none focus:ring-2 focus:ring-cyan-400/45"
    >
      <div className="relative h-24 bg-black/35">
        {thumbSrc && isImage ? (
          <img
            src={thumbSrc}
            alt={artifact.name}
            className="h-full w-full object-cover opacity-80 transition-opacity group-hover:opacity-100"
            loading="lazy"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        ) : thumbSrc && isVideo ? (
          <video src={thumbSrc} muted className="h-full w-full object-cover opacity-80" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-white/20">
            {isVideo ? <Film size={22} /> : <ImageIcon size={22} />}
          </div>
        )}
        <span className="absolute left-2 top-2 rounded-md border border-white/10 bg-black/60 px-1.5 py-0.5 text-[7px] font-mono uppercase tracking-wider text-white/60">
          {artifact.type}
        </span>
      </div>
      <div className="p-2">
        <p className="truncate text-[9px] font-mono text-white/75">{artifact.name}</p>
        <p className="mt-1 truncate text-[7px] font-mono uppercase tracking-wider text-white/30">
          {artifact.id.slice(0, 8)} · {formatTimestamp(artifact.createdAt)}
        </p>
      </div>
    </a>
  );
}

export default function RunDetailDrawer({ runId, onClose, onRunSelect }: RunDetailDrawerProps) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [ledgerBreakdown, setLedgerBreakdown] = useState<LedgerBreakdownMode>("event_type");
  const [ledger, setLedger] = useState<RunCostLedgerResponse | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const loadRequestIdRef = useRef(0);
  const ledgerRequestIdRef = useRef(0);
  const activeRunIdRef = useRef<string | null>(null);

  const loadDetail = useCallback(async (id: string) => {
    const requestId = ++loadRequestIdRef.current;
    activeRunIdRef.current = id;
    try {
      setIsLoading(true);
      setError(null);
      const payload = await api.getRunDetail(id);
      if (requestId !== loadRequestIdRef.current || activeRunIdRef.current !== id) return;
      setDetail(payload);
    } catch (err) {
      if (requestId !== loadRequestIdRef.current || activeRunIdRef.current !== id) return;
      setError(err instanceof Error ? err.message : "Failed to load run detail");
      setDetail(null);
    } finally {
      if (requestId === loadRequestIdRef.current && activeRunIdRef.current === id) {
        setIsLoading(false);
      }
    }
  }, []);

  const loadLedger = useCallback(async (id: string, breakdown: LedgerBreakdownMode) => {
    const requestId = ++ledgerRequestIdRef.current;
    try {
      setLedgerLoading(true);
      setLedgerError(null);
      setLedger(null);
      const payload = await api.getRunCostLedger(id, { breakdown, limit: 50 });
      if (requestId !== ledgerRequestIdRef.current || activeRunIdRef.current !== id) return;
      setLedger(payload);
    } catch {
      if (requestId !== ledgerRequestIdRef.current || activeRunIdRef.current !== id) return;
      setLedgerError("Ledger unavailable");
      setLedger(null);
    } finally {
      if (requestId === ledgerRequestIdRef.current && activeRunIdRef.current === id) {
        setLedgerLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!runId) {
      loadRequestIdRef.current += 1;
      ledgerRequestIdRef.current += 1;
      activeRunIdRef.current = null;
      setDetail(null);
      setError(null);
      setIsLoading(false);
      setLedgerOpen(false);
      setLedgerBreakdown("event_type");
      setLedger(null);
      setLedgerError(null);
      setLedgerLoading(false);
      return undefined;
    }

    void loadDetail(runId);
    window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return undefined;
  }, [loadDetail, runId]);

  useEffect(() => {
    ledgerRequestIdRef.current += 1;
    setLedgerOpen(false);
    setLedgerBreakdown("event_type");
    setLedger(null);
    setLedgerError(null);
    setLedgerLoading(false);
  }, [runId]);

  useEffect(() => {
    if (!runId || !ledgerOpen) return undefined;
    void loadLedger(runId, ledgerBreakdown);
    return undefined;
  }, [ledgerBreakdown, ledgerOpen, loadLedger, runId]);

  const runStatus = detail?.run.status;
  const shouldSubscribe = Boolean(runId && runStatus && !terminalStatuses.has(runStatus));

  useEffect(() => {
    if (!runId || !shouldSubscribe) return undefined;

    const unsubscribe = api.subscribeToLogs(
      runId,
      (log) => {
        if (activeRunIdRef.current !== runId) return;
        setDetail((previous) => previous ? { ...previous, logs: upsertLog(previous.logs, log) } : previous);
      },
      () => {
        if (activeRunIdRef.current !== runId) return;
        void loadDetail(runId);
      },
      (err) => {
        if (activeRunIdRef.current !== runId) return;
        setError(err.message);
      },
    );

    return unsubscribe;
  }, [loadDetail, runId, shouldSubscribe]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ block: "end" });
  }, [detail?.logs.length]);

  useEffect(() => {
    if (!runId) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, runId]);

  const shotIds = useMemo(() => extractShotIds(detail?.run.metadata), [detail?.run.metadata]);
  const auditMode = asRecord(detail?.run.metadata)?.audit_mode === true;
  const artifacts = detail?.artifacts ?? [];
  const logs = detail?.logs ?? [];
  const ledgerBreakdownRows = useMemo(
    () => Object.entries(ledger?.breakdown ?? {})
      .map(([key, value]) => ({
        key: formatLedgerKey(key),
        usd: value.usd,
        count: value.count,
      }))
      .sort((a, b) => b.usd - a.usd),
    [ledger?.breakdown],
  );

  if (!runId) return null;

  return (
    <div className="fixed inset-0 z-[650] flex justify-end bg-black/45 backdrop-blur-sm">
      <button
        type="button"
        aria-label="Close run detail drawer overlay"
        className="hidden flex-1 cursor-default sm:block"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-detail-title"
        className="flex h-full w-full max-w-[620px] flex-col border-l border-cyan-400/20 bg-[#05070b]/95 shadow-[0_0_90px_rgba(0,0,0,0.7)]"
      >
        <header className="shrink-0 border-b border-white/10 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[9px] font-mono uppercase tracking-[0.32em] text-cyan-100/70">
                Run detail
              </p>
              <h2 id="run-detail-title" className="mt-1 truncate text-2xl font-black italic uppercase tracking-tight text-white">
                {runId.slice(0, 8)}
              </h2>
              <p className="mt-1 truncate text-[8px] font-mono uppercase tracking-[0.18em] text-white/35">
                {detail?.run.mode ?? "loading"} · {detail ? formatTimestamp(detail.run.createdAt) : "loading"}
              </p>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label="Close run detail drawer"
              className="rounded-xl border border-white/10 bg-white/[0.03] p-2 text-white/55 transition-all hover:border-red-300/35 hover:text-red-100 focus:outline-none focus:ring-2 focus:ring-cyan-400/45"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error ? (
            <div className="flex items-center gap-2 rounded-2xl border border-red-400/25 bg-red-400/10 p-4 text-[9px] text-red-100">
              <AlertCircle size={14} />
              {error}
            </div>
          ) : isLoading && !detail ? (
            <div className="flex h-48 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.025] text-[9px] font-mono uppercase tracking-widest text-white/35">
              <Loader2 size={16} className="animate-spin text-cyan-300/70" />
              Loading run
            </div>
          ) : detail ? (
            <div className="space-y-4">
              <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    aria-label={`Run status ${statusLabel(detail.run.status)}`}
                    className={`rounded-full border px-2 py-1 text-[8px] font-mono uppercase tracking-[0.16em] ${statusStyles[detail.run.status]}`}
                  >
                    {statusLabel(detail.run.status)}
                  </span>
                  <span className="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-2 py-1 text-[8px] font-mono uppercase tracking-[0.16em] text-cyan-100">
                    {detail.run.mode}
                  </span>
                  {detail.run.hitlRequired && (
                    <span
                      aria-label="HITL required for this run"
                      className="rounded-full border border-amber-300/35 bg-amber-300/10 px-2 py-1 text-[8px] font-mono uppercase tracking-[0.16em] text-amber-100"
                    >
                      HITL REQUIRED
                    </span>
                  )}
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div>
                    <p className="text-[7px] font-mono uppercase tracking-[0.18em] text-white/30">Created</p>
                    <p className="mt-1 text-[9px] font-mono text-white/70">{formatTimestamp(detail.run.createdAt)}</p>
                  </div>
                  <div>
                    <p className="text-[7px] font-mono uppercase tracking-[0.18em] text-white/30">Duration</p>
                    <p className="mt-1 text-[9px] font-mono text-white/70">
                      {formatDuration(detail.run.startedAt ?? detail.run.createdAt, detail.run.completedAt ?? detail.run.updatedAt)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[7px] font-mono uppercase tracking-[0.18em] text-white/30">Shots</p>
                    <p className="mt-1 text-[9px] font-mono text-white/70">
                      {shotIds.length > 0 ? `[${shotIds.join(", ")}]` : auditMode ? "audit/all" : "campaign"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[7px] font-mono uppercase tracking-[0.18em] text-white/30">Run id</p>
                    <p className="mt-1 truncate text-[9px] font-mono text-white/70">{detail.run.runId}</p>
                  </div>
                </div>
              </section>

              <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <ScrollText size={14} className="text-cyan-200/70" />
                    <h3 className="text-[9px] font-mono uppercase tracking-[0.28em] text-white/70">Run logs</h3>
                  </div>
                  {shouldSubscribe && (
                    <span className="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-2 py-1 text-[7px] font-mono uppercase tracking-widest text-cyan-100">
                      realtime
                    </span>
                  )}
                </div>
                <div className="max-h-64 space-y-2 overflow-y-auto rounded-xl border border-black/30 bg-black/30 p-2">
                  {logs.length === 0 ? (
                    <p className="px-2 py-6 text-center text-[8px] font-mono uppercase tracking-widest text-white/30">
                      No logs recorded for this run.
                    </p>
                  ) : (
                    logs.map((log) => (
                      <div key={log.id} className={`rounded-lg border bg-white/[0.025] px-2 py-1.5 ${logStyles[log.level]}`}>
                        <div className="flex flex-wrap items-center gap-2 text-[7px] font-mono uppercase tracking-wider text-white/30">
                          <span>#{log.id}</span>
                          <span>{formatTimestamp(log.timestamp)}</span>
                          <span>{log.stage}</span>
                          <span>{log.level}</span>
                        </div>
                        <p className="mt-1 break-words text-[9px] leading-relaxed">{log.message}</p>
                      </div>
                    ))
                  )}
                  <div ref={logsEndRef} />
                </div>
              </section>

              <section className="space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4">
                    <div className="flex items-center gap-2 text-cyan-100/70">
                      <Workflow size={14} />
                      <h3 className="text-[9px] font-mono uppercase tracking-[0.24em]">Orchestration</h3>
                    </div>
                    <p className="mt-4 text-3xl font-semibold tracking-tight text-white">
                      {detail.orchestrationDecisionCount}
                    </p>
                    <p className="mt-1 text-[8px] font-mono uppercase tracking-widest text-white/35">
                      decisions · {formatMoney(detail.totalOrchestrationCost)} total cost
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4">
                    <div className="flex items-center gap-2 text-cyan-100/70">
                      <Archive size={14} />
                      <h3 className="text-[9px] font-mono uppercase tracking-[0.24em]">Artifacts</h3>
                    </div>
                    <p className="mt-4 text-3xl font-semibold tracking-tight text-white">
                      {artifacts.length}
                    </p>
                    <p className="mt-1 text-[8px] font-mono uppercase tracking-widest text-white/35">
                      produced in this run
                    </p>
                  </div>
                </div>

                <div className="rounded-2xl border border-[#15217C]/55 bg-[#15217C]/20 p-3 shadow-[0_0_24px_rgba(21,33,124,0.16)]">
                  <button
                    type="button"
                    aria-expanded={ledgerOpen}
                    onClick={() => setLedgerOpen((value) => !value)}
                    className="flex w-full items-center justify-between gap-3 rounded-xl px-1 py-1 text-left focus:outline-none focus:ring-2 focus:ring-[#ED4C14]/45"
                  >
                    <span>
                      <span className="block text-[9px] font-mono uppercase tracking-[0.24em] text-[#EFECEB]/80">
                        Per-event ledger
                      </span>
                      <span className="mt-1 block text-[7px] font-mono uppercase tracking-widest text-[#EFECEB]/35">
                        {ledger?.entryCount ?? "—"} append-only entries
                      </span>
                    </span>
                    <ChevronRight
                      size={15}
                      className={`shrink-0 text-[#ED4C14]/80 transition-transform ${ledgerOpen ? "rotate-90" : ""}`}
                    />
                  </button>

                  {ledgerOpen && (
                    <div className="mt-3 border-t border-white/10 pt-3">
                      <div className="mb-3 inline-flex rounded-full border border-white/10 bg-black/25 p-1">
                        {([
                          ["event_type", "By event type"],
                          ["source", "By source"],
                        ] as const).map(([mode, label]) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setLedgerBreakdown(mode)}
                            className={`rounded-full px-3 py-1 text-[7px] font-mono uppercase tracking-widest transition-all ${
                              ledgerBreakdown === mode
                                ? "border border-[#ED4C14]/45 bg-[#ED4C14]/15 text-[#EFECEB]"
                                : "text-[#EFECEB]/40 hover:text-[#EFECEB]/75"
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>

                      {ledgerLoading ? (
                        <div className="space-y-2 rounded-xl border border-white/10 bg-black/25 p-3">
                          {[0, 1, 2].map((item) => (
                            <div key={item} className="grid grid-cols-[1fr_56px_72px] gap-3">
                              <div className="h-3 animate-pulse rounded bg-white/10" />
                              <div className="h-3 animate-pulse rounded bg-white/10" />
                              <div className="h-3 animate-pulse rounded bg-white/10" />
                            </div>
                          ))}
                        </div>
                      ) : ledgerError ? (
                        <div className="rounded-xl border border-amber-300/20 bg-amber-300/10 px-3 py-4 text-[8px] font-mono uppercase tracking-widest text-amber-100/75">
                          Ledger unavailable
                        </div>
                      ) : ledger && ledgerBreakdownRows.length === 0 ? (
                        <div className="rounded-xl border border-white/10 bg-black/25 px-3 py-5 text-center text-[8px] font-mono uppercase tracking-widest text-[#EFECEB]/35">
                          No ledger entries yet — older runs use derived cost estimates
                        </div>
                      ) : ledger ? (
                        <>
                          <div className="overflow-hidden rounded-xl border border-white/10 bg-black/25">
                            <table className="w-full border-collapse text-left font-mono">
                              <thead className="border-b border-white/10 text-[7px] uppercase tracking-widest text-[#EFECEB]/35">
                                <tr>
                                  <th className="px-3 py-2 font-medium">
                                    {ledgerBreakdown === "event_type" ? "event_type" : "source"}
                                  </th>
                                  <th className="px-3 py-2 text-right font-medium">count</th>
                                  <th className="px-3 py-2 text-right font-medium">usd</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-white/5 text-[8px]">
                                {ledgerBreakdownRows.map((row) => (
                                  <tr key={row.key} className="text-[#EFECEB]/75">
                                    <td className="max-w-[260px] truncate px-3 py-2">{row.key}</td>
                                    <td className="px-3 py-2 text-right text-[#EFECEB]/55">{row.count}</td>
                                    <td className="px-3 py-2 text-right text-[#ED4C14]">{formatMoney(row.usd)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="mt-2 text-[7px] font-mono uppercase tracking-widest text-[#EFECEB]/35">
                            Showing {ledger.entries.length} of {ledger.entryCount} entries · rate card {ledger.rateCardVersion}
                          </p>
                        </>
                      ) : null}
                    </div>
                  )}
                </div>
              </section>

              <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <ImageIcon size={14} className="text-cyan-200/70" />
                    <h3 className="text-[9px] font-mono uppercase tracking-[0.28em] text-white/70">
                      Artifact thumbnails
                    </h3>
                  </div>
                  <span className="text-[8px] font-mono uppercase tracking-widest text-white/30">
                    {artifacts.length}
                  </span>
                </div>
                {artifacts.length === 0 ? (
                  <p className="rounded-xl border border-white/10 bg-black/25 px-3 py-6 text-center text-[8px] font-mono uppercase tracking-widest text-white/30">
                    No artifacts produced by this run.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    {artifacts.slice(0, 12).map((artifact) => (
                      <ArtifactTile key={artifact.id} artifact={artifact} />
                    ))}
                  </div>
                )}
              </section>

              {detail.run.mode === "video" && detail.relatedStillsRun && (
                <section className="rounded-2xl border border-purple-300/20 bg-purple-300/10 p-4">
                  <div className="flex items-center gap-2 text-purple-100/80">
                    <Film size={14} />
                    <h3 className="text-[9px] font-mono uppercase tracking-[0.24em]">
                      Veo phase source
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRunSelect?.(detail.relatedStillsRun!.runId)}
                    className="mt-3 flex w-full items-center justify-between rounded-xl border border-purple-300/20 bg-black/25 px-3 py-2 text-left transition-all hover:border-purple-200/45 focus:outline-none focus:ring-2 focus:ring-purple-300/45"
                  >
                    <span>
                      <span className="block text-[10px] font-mono uppercase tracking-[0.2em] text-white">
                        Parent stills run {detail.relatedStillsRun.runId.slice(0, 8)}
                      </span>
                      <span className="mt-1 block text-[8px] font-mono uppercase tracking-wider text-white/35">
                        Open related stills row
                      </span>
                    </span>
                    <ChevronRight size={14} className="text-purple-100/60" />
                  </button>
                </section>
              )}
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
