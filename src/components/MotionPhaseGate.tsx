import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Film,
  Loader2,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import * as api from "../api";
import type { MotionGateShotOfNote, MotionGateShotState, MotionPhaseGateState, Run } from "../api";

interface MotionPhaseGateProps {
  clientId: string;
  campaignId: string;
  onReviewGateClick: () => void;
  onRunStarted?: (run: Run) => void;
}

const stateStyles: Record<MotionGateShotState, string> = {
  locked: "border-emerald-300/25 bg-emerald-300/10 text-emerald-100",
  "operator-override": "border-orange-300/35 bg-orange-300/12 text-orange-100",
  "operator-accepted": "border-amber-300/35 bg-amber-300/12 text-amber-100",
  canonical: "border-cyan-300/35 bg-cyan-300/12 text-cyan-100",
  pending: "border-red-300/35 bg-red-300/12 text-red-100",
};

function stateLabel(state: MotionGateShotState) {
  return state.replace(/-/g, " ");
}

function formatTimestamp(value?: string) {
  if (!value) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
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

function CountTile({ label, value, tone }: { label: string; value: number; tone: "cyan" | "emerald" | "amber" }) {
  const toneClass = tone === "cyan"
    ? "border-cyan-300/20 bg-cyan-300/10 text-cyan-100"
    : tone === "emerald"
      ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-100"
      : "border-amber-300/20 bg-amber-300/10 text-amber-100";

  return (
    <div
      aria-label={`${label}: ${value}`}
      className={`rounded-2xl border px-4 py-3 ${toneClass}`}
    >
      <p className="text-2xl font-black tabular-nums tracking-tight">{value}</p>
      <p className="mt-1 text-[8px] font-mono uppercase tracking-[0.22em] opacity-65">{label}</p>
    </div>
  );
}

function ShotNoteRow({ note }: { note: MotionGateShotOfNote }) {
  return (
    <li className="rounded-2xl border border-white/10 bg-white/[0.035] p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="font-mono text-[11px] font-black uppercase tracking-[0.18em] text-white">
            Shot {String(note.shotNumber).padStart(2, "0")}
          </p>
          <p className="mt-2 text-[9px] leading-relaxed text-white/55">{note.summary}</p>
        </div>
        <span
          aria-label={`Current state ${stateLabel(note.state)}`}
          className={`shrink-0 rounded-full border px-2.5 py-1 text-[8px] font-mono uppercase tracking-[0.18em] ${stateStyles[note.state]}`}
        >
          {stateLabel(note.state)}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[7px] font-mono uppercase tracking-[0.16em] text-white/30">
        <span>source {note.source.replace(/_/g, " ")}</span>
        {note.runId && <span>run {note.runId.slice(0, 8)}</span>}
        {note.criticVerdict && <span>critic {note.criticVerdict}</span>}
        {note.criticScore != null && <span>score {note.criticScore.toFixed(2)}</span>}
        {note.decidedIter != null && <span>iter {note.decidedIter}</span>}
        {note.decisionBy && <span>by {note.decisionBy}</span>}
        {note.decisionAt && <span>at {formatTimestamp(note.decisionAt)}</span>}
      </div>
    </li>
  );
}

function MotionConfirmModal({
  gateState,
  isConfirming,
  error,
  onClose,
  onConfirm,
}: {
  gateState: MotionPhaseGateState;
  isConfirming: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!isConfirming) onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          "button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((element) => !element.getAttribute("aria-hidden"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previous?.focus();
    };
  }, [isConfirming, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="motion-phase-confirm-title"
        aria-describedby="motion-phase-confirm-desc"
        className="max-h-[88vh] w-full max-w-3xl overflow-hidden rounded-[2rem] border border-cyan-300/20 bg-[#070a0f] shadow-[0_0_60px_rgba(0,0,0,0.55)]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/10 p-5">
          <div>
            <p className="text-[8px] font-mono uppercase tracking-[0.32em] text-cyan-200/70">Motion phase confirmation</p>
            <h2 id="motion-phase-confirm-title" className="mt-2 text-xl font-black uppercase tracking-tight text-white">
              Generate Veo motion clips
            </h2>
            <p id="motion-phase-confirm-desc" className="mt-2 max-w-2xl text-[10px] leading-relaxed text-white/45">
              This queues a video run scoped to {gateState.lockedCount} locked stills. Review the operator-sensitive shots before spending Veo budget.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isConfirming}
            aria-label="Close motion phase confirmation"
            className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-white/45 transition-all hover:border-white/25 hover:text-white focus:outline-none focus:ring-2 focus:ring-cyan-300/45 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[56vh] overflow-y-auto p-5">
          {gateState.shotsOfNote.length > 0 ? (
            <ul className="space-y-2">
              {gateState.shotsOfNote.map((note) => <ShotNoteRow key={`${note.shotNumber}:${note.source}:${note.state}`} note={note} />)}
            </ul>
          ) : (
            <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-5 text-center">
              <Sparkles size={18} className="mx-auto text-cyan-200/45" />
              <p className="mt-3 text-[9px] font-mono uppercase tracking-[0.22em] text-white/45">
                No operator-specific shots of note found for this handoff.
              </p>
            </div>
          )}
          {error && (
            <div className="mt-4 rounded-2xl border border-red-300/25 bg-red-300/10 px-4 py-3 text-[10px] text-red-100" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-white/10 p-5 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={isConfirming}
            className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-[9px] font-mono uppercase tracking-[0.2em] text-white/50 transition-all hover:border-white/25 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={isConfirming}
            className="inline-flex items-center justify-center rounded-2xl bg-[#ED4C14] px-4 py-3 text-[9px] font-black uppercase tracking-[0.2em] text-white shadow-[0_0_24px_rgba(237,76,20,0.22)] transition-all hover:bg-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-300/55 disabled:cursor-not-allowed disabled:opacity-55"
          >
            {isConfirming ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Film size={14} className="mr-2" />}
            Confirm motion run
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MotionPhaseGate({ clientId, campaignId, onReviewGateClick, onRunStarted }: MotionPhaseGateProps) {
  const [gateState, setGateState] = useState<MotionPhaseGateState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [lastQueuedRun, setLastQueuedRun] = useState<Run | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    try {
      if (!quiet) setIsRefreshing(true);
      setError(null);
      const next = await api.getMotionPhaseGateState(campaignId);
      setGateState(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load motion-phase gate state");
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [campaignId]);

  useEffect(() => {
    setIsLoading(true);
    setGateState(null);
    setLastQueuedRun(null);
    void refresh(true);

    const unsubscribes = [
      api.subscribeToCampaignDeliverables(campaignId, () => { void refresh(true); }),
      api.subscribeToRunsByClient(clientId, () => { void refresh(true); }),
      api.subscribeToAssetEscalations(clientId, () => { void refresh(true); }),
    ];

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    };
  }, [campaignId, clientId, refresh]);

  const ctaLabel = useMemo(() => {
    const count = gateState?.lockedCount ?? 0;
    return `Generate motion clips from these ${count} locked stills`;
  }, [gateState?.lockedCount]);

  const disabledReasonId = "motion-phase-disabled-reason";
  const isBlocked = gateState?.blocked === true;
  const canOpenConfirm = Boolean(gateState && !isBlocked && gateState.lockedCount > 0 && !isLoading && !isConfirming);

  const handleOpenConfirm = () => {
    if (!canOpenConfirm) return;
    setConfirmError(null);
    setShowConfirm(true);
  };

  const handleConfirm = async () => {
    if (!gateState) return;
    setConfirmError(null);
    setIsConfirming(true);
    try {
      const run = await api.createMotionPhaseRun(clientId, campaignId, gateState);
      setLastQueuedRun(run);
      onRunStarted?.(run);
      setShowConfirm(false);
      void refresh(true);
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : "Failed to queue motion phase run");
    } finally {
      setIsConfirming(false);
    }
  };

  return (
    <section className="mt-4 overflow-hidden rounded-2xl border border-[#ED4C14]/25 bg-[#0c0907]/85 shadow-[0_0_44px_rgba(237,76,20,0.08)] backdrop-blur-xl">
      <div className="flex flex-col gap-4 p-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[8px] font-mono uppercase tracking-[0.32em] text-orange-200/70">
            <Film size={12} /> Stills → Veo motion gate
          </div>
          <h2 className="mt-1 text-xl font-black uppercase tracking-tight text-white">
            Generate motion from locked stills
          </h2>
          <p className="mt-2 max-w-3xl text-[9px] leading-relaxed text-white/42">
            Blocking-aware handoff for the motion phase. Counts refresh from campaign deliverables, stills run history, and escalation state in Realtime.
          </p>

          {isLoading ? (
            <div className="mt-4 flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.025] px-4 py-4 text-[9px] font-mono uppercase tracking-[0.2em] text-white/35">
              <Loader2 size={14} className="animate-spin text-orange-200/70" /> Loading motion gate
            </div>
          ) : error ? (
            <div className="mt-4 rounded-2xl border border-red-300/25 bg-red-300/10 px-4 py-3 text-[10px] text-red-100" role="alert">
              {error}
            </div>
          ) : gateState ? (
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <CountTile label="locked stills" value={gateState.lockedCount} tone="cyan" />
              <CountTile label="operator confirmed" value={gateState.operatorConfirmedCount} tone="emerald" />
              <CountTile label="locked without explicit approval" value={gateState.lockedWithoutExplicitApprovalCount} tone="amber" />
            </div>
          ) : null}
        </div>

        <div className="flex w-full flex-col gap-2 lg:w-[320px] lg:items-stretch">
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label="Refresh motion phase gate counts"
            className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[8px] font-mono uppercase tracking-[0.2em] text-white/45 transition-all hover:border-orange-300/35 hover:text-orange-100 focus:outline-none focus:ring-2 focus:ring-orange-300/40"
          >
            <RefreshCw size={12} className={`mr-2 ${isRefreshing ? "animate-spin" : ""}`} />
            Refresh gate
          </button>
          <button
            type="button"
            onClick={handleOpenConfirm}
            disabled={!canOpenConfirm}
            aria-disabled={!canOpenConfirm}
            aria-describedby={isBlocked ? disabledReasonId : undefined}
            className="inline-flex min-h-[54px] items-center justify-center rounded-2xl bg-[#ED4C14] px-4 py-3 text-center text-[9px] font-black uppercase tracking-[0.18em] text-white shadow-[0_0_26px_rgba(237,76,20,0.22)] transition-all hover:bg-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-300/55 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/30 disabled:shadow-none"
          >
            {isLoading ? <Loader2 size={14} className="mr-2 animate-spin" /> : isBlocked ? <LockKeyhole size={14} className="mr-2" /> : <Film size={14} className="mr-2" />}
            {ctaLabel}
          </button>

          {gateState && isBlocked ? (
            <div id={disabledReasonId} className="rounded-2xl border border-red-300/25 bg-red-300/10 px-3 py-2 text-[9px] leading-relaxed text-red-100">
              <AlertTriangle size={12} className="mr-1.5 inline -translate-y-0.5" />
              {gateState.openHitlCount} still{gateState.openHitlCount === 1 ? "" : "s"} need operator review before motion gen —{" "}
              <button
                type="button"
                onClick={onReviewGateClick}
                className="font-mono uppercase tracking-[0.16em] text-red-50 underline decoration-red-200/45 underline-offset-4 transition-all hover:text-white focus:outline-none focus:ring-2 focus:ring-red-200/45"
              >
                see Review Gate
              </button>
            </div>
          ) : gateState ? (
            <div className="rounded-2xl border border-emerald-300/20 bg-emerald-300/10 px-3 py-2 text-[9px] leading-relaxed text-emerald-100/85">
              <CheckCircle2 size={12} className="mr-1.5 inline -translate-y-0.5" />
              No open stills HITL blockers. {gateState.shotsOfNote.length} operator-sensitive shot{gateState.shotsOfNote.length === 1 ? "" : "s"} will be shown before queueing.
            </div>
          ) : null}

          {lastQueuedRun && (
            <div className="rounded-2xl border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-[9px] text-cyan-100/85" role="status">
              <ShieldCheck size={12} className="mr-1.5 inline -translate-y-0.5" />
              Motion run queued: <span className="font-mono uppercase tracking-wider">{lastQueuedRun.runId.slice(0, 8)}</span>
            </div>
          )}
        </div>
      </div>

      {gateState && gateState.shotsOfNote.length > 0 && (
        <div className="border-t border-white/10 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-[8px] font-mono uppercase tracking-[0.18em] text-white/35">
            <span>Shots of note:</span>
            {gateState.shotsOfNote.slice(0, 8).map((note) => (
              <span key={`${note.shotNumber}:${note.state}`} className={`rounded-full border px-2 py-1 ${stateStyles[note.state]}`}>
                #{String(note.shotNumber).padStart(2, "0")} {stateLabel(note.state)}
              </span>
            ))}
          </div>
        </div>
      )}

      {showConfirm && gateState && (
        <MotionConfirmModal
          gateState={gateState}
          isConfirming={isConfirming}
          error={confirmError}
          onClose={() => {
            if (!isConfirming) setShowConfirm(false);
          }}
          onConfirm={handleConfirm}
        />
      )}
    </section>
  );
}
