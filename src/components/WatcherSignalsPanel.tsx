import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Radar, ShieldX } from "lucide-react";
import * as api from "../api";
import type { RunStatus } from "../api";

const OS_API_URL = import.meta.env.VITE_OS_API_URL || "http://localhost:3001";

type EscalationLevel = "L1" | "L2" | "L3";

type WatcherSignal = {
  type: "watcher_signal";
  escalationId: string;
  artifactId: string;
  cumulativeCost: number;
  perShotHardCap: number;
  consecutiveSameRegens: number;
  levelsUsed: EscalationLevel[];
  warnBudget: boolean;
  warnLoop: boolean;
};

type EscalationUpdate = {
  id: string;
  artifactId: string;
  deliverableId?: string;
  currentLevel: EscalationLevel;
  status: string;
  iterationCount: number;
};

interface WatcherSignalsPanelProps {
  runId: string;
  runStatus?: RunStatus;
  onCancelled?: () => void;
}

const terminalStatuses = new Set<RunStatus>(["blocked", "cancelled", "completed", "failed"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isEscalationLevel(value: unknown): value is EscalationLevel {
  return value === "L1" || value === "L2" || value === "L3";
}

function parseWatcherSignal(payload: unknown): WatcherSignal | null {
  const record = asRecord(payload);
  if (!record || record.type !== "watcher_signal") return null;
  const artifactId = typeof record.artifactId === "string" ? record.artifactId : null;
  const escalationId = typeof record.escalationId === "string" ? record.escalationId : null;
  const cumulativeCost = typeof record.cumulativeCost === "number" ? record.cumulativeCost : null;
  const perShotHardCap = typeof record.perShotHardCap === "number" ? record.perShotHardCap : null;
  const consecutiveSameRegens = typeof record.consecutiveSameRegens === "number" ? record.consecutiveSameRegens : null;
  const levelsUsed = Array.isArray(record.levelsUsed)
    ? record.levelsUsed.filter(isEscalationLevel)
    : [];
  if (!artifactId || !escalationId || cumulativeCost === null || perShotHardCap === null || consecutiveSameRegens === null) {
    return null;
  }
  return {
    type: "watcher_signal",
    escalationId,
    artifactId,
    cumulativeCost,
    perShotHardCap,
    consecutiveSameRegens,
    levelsUsed,
    warnBudget: record.warnBudget === true,
    warnLoop: record.warnLoop === true,
  };
}

function parseEscalationUpdate(payload: unknown): EscalationUpdate | null {
  const record = asRecord(payload);
  if (!record) return null;
  const id = typeof record.id === "string" ? record.id : null;
  const artifactId = typeof record.artifactId === "string" ? record.artifactId : null;
  const currentLevel = isEscalationLevel(record.currentLevel) ? record.currentLevel : null;
  const status = typeof record.status === "string" ? record.status : null;
  const iterationCount = typeof record.iterationCount === "number" ? record.iterationCount : null;
  if (!id || !artifactId || !currentLevel || !status || iterationCount === null) return null;
  return {
    id,
    artifactId,
    deliverableId: typeof record.deliverableId === "string" ? record.deliverableId : undefined,
    currentLevel,
    status,
    iterationCount,
  };
}

async function cancelRunViaApi(runId: string) {
  const response = await fetch(`${OS_API_URL}/api/runs/${runId}/cancel`, { method: "POST" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return response.json();
}

export default function WatcherSignalsPanel({ runId, runStatus, onCancelled }: WatcherSignalsPanelProps) {
  const [signal, setSignal] = useState<WatcherSignal | null>(null);
  const [activeEscalation, setActiveEscalation] = useState<EscalationUpdate | null>(null);
  const [artifactDeliverables, setArtifactDeliverables] = useState<Record<string, string>>({});
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSignal(null);
    setActiveEscalation(null);
    setArtifactDeliverables({});
    setConfirmCancel(false);
    setIsCancelling(false);
    setCancelError(null);

    async function loadArtifacts() {
      try {
        const artifacts = await api.getArtifacts(runId);
        if (cancelled) return;
        setArtifactDeliverables(
          Object.fromEntries(
            artifacts
              .filter((artifact) => artifact.deliverableId)
              .map((artifact) => [artifact.id, artifact.deliverableId as string]),
          ),
        );
      } catch {
        if (!cancelled) {
          setArtifactDeliverables({});
        }
      }
    }

    void loadArtifacts();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  useEffect(() => {
    const source = new EventSource(`${OS_API_URL}/api/runs/${runId}/logs`);

    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as { type?: string; payload?: unknown };
        if (parsed.type !== "escalation") return;
        const watcherSignal = parseWatcherSignal(parsed.payload);
        if (watcherSignal) {
          setSignal(watcherSignal);
          return;
        }
        const escalationUpdate = parseEscalationUpdate(parsed.payload);
        if (escalationUpdate) {
          setActiveEscalation(escalationUpdate);
        }
      } catch {
        // Ignore malformed SSE frames and non-JSON log lines.
      }
    };

    source.addEventListener("complete", () => {
      source.close();
    });

    source.onerror = () => {
      source.close();
    };

    return () => {
      source.close();
    };
  }, [runId]);

  useEffect(() => {
    if (!confirmCancel) return;
    const timeout = window.setTimeout(() => setConfirmCancel(false), 5000);
    return () => window.clearTimeout(timeout);
  }, [confirmCancel]);

  const activeDeliverableId = useMemo(
    () => activeEscalation?.deliverableId ?? (signal ? artifactDeliverables[signal.artifactId] : undefined),
    [activeEscalation?.deliverableId, artifactDeliverables, signal],
  );

  const visible = !runStatus || !terminalStatuses.has(runStatus)
    ? Boolean(signal || activeEscalation)
    : false;

  if (!visible) {
    return null;
  }

  const levelLabel = activeEscalation?.currentLevel ?? signal?.levelsUsed.at(-1) ?? "—";

  const handleCancel = async () => {
    if (!confirmCancel) {
      setConfirmCancel(true);
      return;
    }

    setIsCancelling(true);
    setCancelError(null);
    try {
      await cancelRunViaApi(runId);
      setConfirmCancel(false);
      onCancelled?.();
    } catch (error) {
      try {
        await api.cancelRun(runId);
        setConfirmCancel(false);
        onCancelled?.();
      } catch {
        setCancelError(error instanceof Error ? error.message : "Cancel failed");
      }
    } finally {
      setIsCancelling(false);
    }
  };

  return (
    <div className="w-[280px] rounded-2xl border border-cyan-500/20 bg-[#0b0b0f]/92 p-4 shadow-[0_0_50px_rgba(0,0,0,0.35)] backdrop-blur-xl">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[9px] font-mono uppercase tracking-[0.35em] text-cyan-300/75">Watcher</p>
          <p className="mt-1 text-[11px] font-mono uppercase tracking-widest text-white/55">
            {activeDeliverableId ? `Shot ${activeDeliverableId.slice(0, 8)}` : "Awaiting shot id"}
            {activeEscalation ? ` · iter ${activeEscalation.iterationCount}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Radar size={14} className="text-cyan-300" />
          <span className="rounded-full border border-white/10 px-2 py-1 text-[8px] font-mono uppercase tracking-widest text-white/55">
            {levelLabel}
          </span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <p className="text-[8px] font-mono uppercase tracking-widest text-white/35">Cost</p>
          <p className={`mt-1 text-2xl font-semibold tracking-tight ${signal?.warnBudget ? "text-red-300" : "text-white"}`}>
            ${signal?.cumulativeCost.toFixed(2) ?? "0.00"}
          </p>
          <p className="mt-1 text-[8px] font-mono uppercase tracking-widest text-white/30">
            cap ${signal?.perShotHardCap.toFixed(2) ?? "4.00"}
          </p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <p className="text-[8px] font-mono uppercase tracking-widest text-white/35">Same regens</p>
          <p className={`mt-1 text-2xl font-semibold tracking-tight ${signal?.warnLoop ? "text-red-300" : "text-white"}`}>
            {signal?.consecutiveSameRegens ?? 0}
          </p>
          <p className="mt-1 text-[8px] font-mono uppercase tracking-widest text-white/30">
            levels {signal?.levelsUsed.join("/") || "—"}
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-[9px] font-mono uppercase tracking-widest">
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-white/55">
          <span className={`h-2 w-2 rounded-full ${signal?.warnBudget ? "bg-red-400 shadow-[0_0_12px_rgba(248,113,113,0.8)]" : "bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.7)]"}`} />
          Budget
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-white/55">
          <span className={`h-2 w-2 rounded-full ${signal?.warnLoop ? "bg-red-400 shadow-[0_0_12px_rgba(248,113,113,0.8)]" : "bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.7)]"}`} />
          Loop
        </div>
      </div>

      {cancelError && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/[0.08] px-3 py-2 text-[10px] text-red-200">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>{cancelError}</span>
        </div>
      )}

      <button
        type="button"
        onClick={() => void handleCancel()}
        disabled={isCancelling}
        className={`mt-4 flex w-full items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-[10px] font-mono uppercase tracking-[0.25em] transition-all ${
          confirmCancel
            ? "border-red-500/35 bg-red-500/15 text-red-200 hover:bg-red-500/20"
            : "border-white/10 bg-white/[0.03] text-white/70 hover:border-red-500/20 hover:text-red-200"
        } disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {isCancelling ? (
          <>
            <Loader2 size={12} className="animate-spin" />
            Cancelling
          </>
        ) : confirmCancel ? (
          <>
            <ShieldX size={12} />
            Confirm cancel?
          </>
        ) : (
          <>
            <ShieldX size={12} />
            Cancel run
          </>
        )}
      </button>
    </div>
  );
}
