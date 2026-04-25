import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  CheckCircle2,
  Clock3,
  Film,
  Loader2,
  PencilLine,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  getProductionVideoUrl,
  promoteProductionShot,
  regenerateProductionShot,
  rejectProductionShot,
  subscribeToProductionEvents,
  type ProductionEvent,
  type ProductionShotState,
  type ProductionSlug,
} from "../api";

interface ShotReshootDrawerProps {
  productionSlug?: ProductionSlug;
  shot: ProductionShotState | null;
  onClose: () => void;
  onRefresh: () => Promise<void> | void;
  onPromoted?: () => void;
}

type LogLine = {
  id: string;
  stream: "stdout" | "stderr";
  line: string;
};

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "Not available";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatBeat(beat: string | undefined): string {
  return beat ? beat.replace(/_/g, " ") : "unmapped";
}

function safeEventShotNumber(event: ProductionEvent): number | null {
  const value = (event as { shotNumber?: unknown }).shotNumber;
  return typeof value === "number" ? value : null;
}

function FileMeta({ label, mtime, sizeBytes }: { label: string; mtime?: string; sizeBytes?: number }) {
  return (
    <div className="mt-2 flex items-center justify-between gap-3 text-[8px] font-mono uppercase tracking-wider text-white/30">
      <span>{label}</span>
      <span className="text-white/45">{formatDate(mtime)} · {formatBytes(sizeBytes)}</span>
    </div>
  );
}

export default function ShotReshootDrawer({
  productionSlug = "drift-mv",
  shot,
  onClose,
  onRefresh,
  onPromoted,
}: ShotReshootDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [overridePrompt, setOverridePrompt] = useState("");
  const [useImageConditioning, setUseImageConditioning] = useState(true);
  const [controlsOpen, setControlsOpen] = useState(true);
  const [regenInFlight, setRegenInFlight] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [isPromoting, setIsPromoting] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);

  const shotNumber = shot?.shotNumber ?? null;
  const startS = shot?.startS ?? 0;
  const endS = shot?.endS ?? startS + (shot?.durationS ?? 0);
  const defaultPrompt = shot?.defaultPrompt || "Manifest prompt unavailable for this shot.";
  const hasPending = Boolean(shot?.pending);

  useEffect(() => {
    if (!shot) return;
    setOverridePrompt("");
    setUseImageConditioning(true);
    setControlsOpen(!shot.pending);
    setActionError(null);
    setLogs([]);
    setRegenInFlight(Boolean(shot.activeJob?.status === "running"));
    setIsPromoting(false);
    setIsRejecting(false);
  }, [productionSlug, shot]);

  useEffect(() => {
    if (!shotNumber) return;
    const unsubscribe = subscribeToProductionEvents(
      productionSlug,
      (event) => {
        if (safeEventShotNumber(event) !== shotNumber) return;
        if (event.type === "regen_started") {
          setRegenInFlight(true);
          setActionError(null);
        }
        if (event.type === "regen_log") {
          const typed = event as Extract<ProductionEvent, { type: "regen_log" }>;
          setLogs((prev) => [
            ...prev,
            { id: `${typed.jobId}-${prev.length}-${typed.stream}`, stream: typed.stream, line: typed.line },
          ].slice(-160));
        }
        if (event.type === "regen_complete") {
          const typed = event as Extract<ProductionEvent, { type: "regen_complete" }>;
          setRegenInFlight(false);
          if (typed.exitCode !== 0) {
            setActionError(typed.error || "Regeneration failed. Review the live log and retry.");
          }
          void onRefresh();
        }
      },
      () => {
        // Keep the drawer quiet during transient reconnects; the grid shows canonical state after refresh.
      },
    );
    return unsubscribe;
  }, [onRefresh, productionSlug, shotNumber]);

  useEffect(() => {
    const node = drawerRef.current;
    if (!node || !shot) return;
    const focusableSelector = "button, [href], input, textarea, video, [tabindex]:not([tabindex='-1'])";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((item) => !item.hasAttribute("disabled") && item.tabIndex !== -1);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    requestAnimationFrame(() => node.querySelector<HTMLElement>(focusableSelector)?.focus());
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, shot]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const canAct = useMemo(() => Boolean(shotNumber) && !regenInFlight && !isPromoting && !isRejecting, [isPromoting, isRejecting, regenInFlight, shotNumber]);

  if (!shot) return null;

  const handleRegenerate = async () => {
    if (!shotNumber || !canAct) return;
    setActionError(null);
    setRegenInFlight(true);
    setLogs([]);
    try {
      await regenerateProductionShot(productionSlug, shotNumber, {
        prompt: overridePrompt.trim() || undefined,
        useImageConditioning,
      });
    } catch (err) {
      setRegenInFlight(false);
      setActionError(err instanceof Error ? err.message : "Couldn't start regeneration. Retry.");
    }
  };

  const handlePromote = async () => {
    if (!shotNumber || !canAct) return;
    setIsPromoting(true);
    setActionError(null);
    try {
      const result = await promoteProductionShot(productionSlug, shotNumber);
      await onRefresh();
      if (result.promoted) onPromoted?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't promote this shot. Retry.");
    } finally {
      setIsPromoting(false);
    }
  };

  const handleReject = async () => {
    if (!shotNumber || !canAct) return;
    setIsRejecting(true);
    setActionError(null);
    try {
      await rejectProductionShot(productionSlug, shotNumber);
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't discard the pending take. Retry.");
    } finally {
      setIsRejecting(false);
    }
  };


  const handleOpenFinalHitl = () => {
    if (!shotNumber) return;
    window.dispatchEvent(new CustomEvent("brandstudios:open-final-hitl", { detail: { shotNumber } }));
  };

  return (
    <div className="fixed inset-0 z-[650] flex justify-end bg-black/60 backdrop-blur-sm" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Shot ${shot.shotNumber} reshoot controls`}
        className="h-full w-full max-w-[560px] overflow-hidden border-l border-cyan-500/20 bg-[#080b10]/95 shadow-[0_0_80px_rgba(0,0,0,0.65)] fade-slide-in"
      >
        <div className="flex h-full flex-col">
          <header className="shrink-0 border-b border-white/10 px-6 py-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-[9px] font-mono uppercase tracking-[0.28em] text-cyan-300/70">
                  <Film size={13} /> Drift MV Reshoot Gate
                </div>
                <h2 className="mt-2 text-2xl font-black uppercase tracking-tight text-white">
                  Shot #{String(shot.shotNumber).padStart(2, "0")}
                </h2>
                <p className="mt-1 text-[10px] font-mono uppercase tracking-wider text-white/40">
                  #{shot.shotNumber}/30 · {formatBeat(shot.beat)} · {startS}s–{endS}s · {shot.durationS}s
                </p>
                <button
                  type="button"
                  onClick={handleOpenFinalHitl}
                  className="mt-3 inline-flex items-center rounded-xl border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-[8px] font-mono font-bold uppercase tracking-[0.22em] text-orange-200 transition-all hover:border-orange-300/50 hover:bg-orange-500/20 focus:outline-none focus:ring-2 focus:ring-orange-300/40"
                >
                  <PencilLine size={11} className="mr-1.5" /> Final HITL
                </button>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full border border-white/10 p-2 text-white/35 transition-all hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-300 focus:outline-none focus:ring-2 focus:ring-cyan-400/50"
                aria-label="Close reshoot drawer"
              >
                <X size={16} />
              </button>
            </div>
          </header>

          <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
            {actionError && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[10px] font-mono text-red-200">
                {actionError}
              </div>
            )}

            <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-[10px] font-mono uppercase tracking-[0.25em] text-white/55">Current canonical</h3>
                <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[7px] font-mono uppercase tracking-widest text-emerald-300">
                  Live cut
                </span>
              </div>
              <video
                src={getProductionVideoUrl(productionSlug, shot.shotNumber, "canonical")}
                controls
                className="w-full max-h-64 rounded-lg border border-white/10 bg-black/30"
                preload="metadata"
              />
              <FileMeta label="Canonical file" mtime={shot.canonical.mtime} sizeBytes={shot.canonical.sizeBytes} />
            </section>

            {hasPending ? (
              <section className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-[10px] font-mono uppercase tracking-[0.25em] text-amber-200/80">Pending review take</h3>
                  <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[7px] font-mono uppercase tracking-widest text-amber-200">
                    Awaiting judgment
                  </span>
                </div>
                <video
                  src={getProductionVideoUrl(productionSlug, shot.shotNumber, "pending")}
                  controls
                  className="w-full max-h-64 rounded-lg border border-white/10 bg-black/30"
                  preload="metadata"
                />
                <FileMeta label="Pending file" mtime={shot.pending?.mtime} sizeBytes={shot.pending?.sizeBytes} />
                <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <button
                    type="button"
                    onClick={handlePromote}
                    disabled={!canAct}
                    className="flex items-center justify-center rounded-xl bg-cyan-400 px-3 py-2.5 text-[9px] font-black uppercase tracking-wider text-black transition-all hover:bg-white active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus:ring-2 focus:ring-cyan-300/60"
                  >
                    {isPromoting ? <Loader2 size={12} className="mr-1.5 animate-spin" /> : <CheckCircle2 size={12} className="mr-1.5" />}
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={handleReject}
                    disabled={!canAct}
                    className="flex items-center justify-center rounded-xl border border-red-500/30 px-3 py-2.5 text-[9px] font-mono font-bold uppercase tracking-wider text-red-300 transition-all hover:bg-red-500/10 active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus:ring-2 focus:ring-red-300/40"
                  >
                    {isRejecting ? <Loader2 size={12} className="mr-1.5 animate-spin" /> : <Trash2 size={12} className="mr-1.5" />}
                    Reject
                  </button>
                  <button
                    type="button"
                    onClick={() => setControlsOpen(true)}
                    className="flex items-center justify-center rounded-xl border border-orange-500/30 px-3 py-2.5 text-[9px] font-mono font-bold uppercase tracking-wider text-orange-300 transition-all hover:bg-orange-500/10 active:scale-95 focus:outline-none focus:ring-2 focus:ring-orange-300/40"
                  >
                    <RotateCcw size={12} className="mr-1.5" /> Regenerate again
                  </button>
                </div>
              </section>
            ) : (
              <section className="rounded-2xl border border-white/10 bg-white/[0.018] p-4 text-center">
                <Sparkles size={18} className="mx-auto text-cyan-400/35" />
                <p className="mt-2 text-[9px] font-mono uppercase tracking-widest text-white/35">
                  No pending take for this shot
                </p>
              </section>
            )}

            <section className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <button
                type="button"
                onClick={() => setControlsOpen((prev) => !prev)}
                className="flex w-full items-center justify-between text-left text-[10px] font-mono uppercase tracking-[0.25em] text-white/60 transition-colors hover:text-cyan-300 focus:outline-none focus:ring-2 focus:ring-cyan-400/40 rounded-lg"
              >
                Request a new take
                <RefreshCw size={13} className={regenInFlight ? "animate-spin text-cyan-300" : "text-white/35"} />
              </button>
              {controlsOpen && (
                <div className="mt-4 space-y-4">
                  <div>
                    <label className="text-[8px] font-mono uppercase tracking-widest text-white/30">Manifest prompt</label>
                    <div className="mt-2 max-h-28 overflow-y-auto rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[9px] font-mono leading-relaxed text-white/45 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
                      {defaultPrompt}
                    </div>
                  </div>
                  <div>
                    <label htmlFor="reshoot-override" className="text-[8px] font-mono uppercase tracking-widest text-white/30">Optional override</label>
                    <textarea
                      id="reshoot-override"
                      rows={4}
                      value={overridePrompt}
                      onChange={(event) => setOverridePrompt(event.target.value)}
                      placeholder="Customize prompt for this regen"
                      className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-white/[0.04] p-3 text-[10px] font-mono leading-relaxed text-white/70 outline-none transition-colors placeholder:text-white/18 focus:border-cyan-400/40"
                    />
                  </div>
                  <label className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.025] px-3 py-2.5">
                    <span className="text-[9px] font-mono uppercase tracking-wider text-white/45">Use image-conditioning</span>
                    <input
                      type="checkbox"
                      checked={useImageConditioning}
                      onChange={(event) => setUseImageConditioning(event.target.checked)}
                      className="h-4 w-4 accent-cyan-400"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={handleRegenerate}
                    disabled={!canAct}
                    className="flex w-full items-center justify-center rounded-2xl bg-[#ED4C14] px-4 py-3 text-[10px] font-black uppercase tracking-[0.25em] text-white shadow-[0_0_30px_rgba(237,76,20,0.18)] transition-all hover:bg-orange-400 active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus:ring-2 focus:ring-orange-300/50"
                  >
                    {regenInFlight ? <Loader2 size={14} className="mr-2 animate-spin" /> : <RefreshCw size={14} className="mr-2" />}
                    {regenInFlight ? "Regenerating" : "Regenerate"}
                  </button>
                </div>
              )}
            </section>

            {(regenInFlight || logs.length > 0) && (
              <section className="rounded-2xl border border-cyan-500/20 bg-cyan-500/[0.04] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-[10px] font-mono uppercase tracking-[0.25em] text-cyan-200/70">Live regen log</h3>
                  {regenInFlight && <Loader2 size={13} className="animate-spin text-cyan-300" />}
                </div>
                <div ref={logRef} className="max-h-48 overflow-y-auto rounded-xl border border-white/10 bg-black/40 p-3 font-mono text-[9px] leading-relaxed scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
                  {logs.length === 0 ? (
                    <p className="text-white/25">Waiting for generator output…</p>
                  ) : logs.map((entry) => (
                    <p key={entry.id} className={entry.stream === "stderr" ? "text-amber-300/80" : "text-cyan-100/70"}>
                      <span className="mr-2 text-white/25">{entry.stream}</span>{entry.line}
                    </p>
                  ))}
                </div>
              </section>
            )}

            {shot.canonical.backupExists && (
              <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                <div className="flex items-start gap-3">
                  <Archive size={15} className="mt-0.5 shrink-0 text-white/35" />
                  <p className="text-[9px] font-mono leading-relaxed text-white/35">
                    Previous version backed up as <span className="text-white/55">shot_{String(shot.shotNumber).padStart(2, "0")}_v5_backup.mp4</span>. Promote replaces canonical; original is recoverable from backup.
                  </p>
                </div>
              </section>
            )}
          </div>

          <footer className="shrink-0 border-t border-white/10 px-6 py-3 text-[8px] font-mono uppercase tracking-widest text-white/25">
            <Clock3 size={10} className="mr-1 inline" /> Human-in-the-loop preview · regenerate · approve
          </footer>
        </div>
      </div>
    </div>
  );
}
