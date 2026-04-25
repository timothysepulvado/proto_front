import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock3, Film, Loader2, RefreshCw, Sparkles } from "lucide-react";
import {
  getProductionShots,
  getProductionStillUrl,
  subscribeToProductionEvents,
  triggerProductionRender,
  type ProductionEvent,
  type ProductionRenderArtifact,
  type ProductionShotState,
  type ProductionSlug,
} from "../api";
import ShotReshootDrawer from "./ShotReshootDrawer";

interface ReshootPanelProps {
  productionSlug?: ProductionSlug;
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "0 B";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "Not rendered yet";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatBeat(beat: string): string {
  return beat ? beat.replace(/_/g, " ") : "unmapped";
}

function eventShotNumber(event: ProductionEvent): number | null {
  const value = (event as { shotNumber?: unknown }).shotNumber;
  return typeof value === "number" ? value : null;
}

function ShotSkeleton() {
  return (
    <div className="h-[214px] rounded-2xl border border-white/10 bg-white/[0.025] p-3 animate-pulse">
      <div className="h-4 w-20 rounded bg-white/10" />
      <div className="mt-3 aspect-video rounded-xl bg-white/8" />
      <div className="mt-3 h-3 w-full rounded bg-white/8" />
      <div className="mt-2 h-3 w-2/3 rounded bg-white/8" />
    </div>
  );
}

function StatusBadge({ shot, regenerating }: { shot: ProductionShotState; regenerating: boolean }) {
  if (regenerating) {
    return (
      <span className="rounded-full border border-cyan-400/40 bg-cyan-400/15 px-2 py-0.5 text-[7px] font-mono uppercase tracking-widest text-cyan-200 animate-pulse">
        Regenerating
      </span>
    );
  }
  if (shot.pending) {
    return (
      <span className="rounded-full border border-amber-500/35 bg-amber-500/12 px-2 py-0.5 text-[7px] font-mono uppercase tracking-widest text-amber-200">
        Pending review
      </span>
    );
  }
  return (
    <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[7px] font-mono uppercase tracking-widest text-white/45">
      Canonical
    </span>
  );
}

export default function ReshootPanel({ productionSlug = "drift-mv" }: ReshootPanelProps) {
  const [shots, setShots] = useState<ProductionShotState[]>([]);
  const [renderArtifact, setRenderArtifact] = useState<ProductionRenderArtifact | null>(null);
  const [selectedShotNumber, setSelectedShotNumber] = useState<number | null>(null);
  const [activeRegens, setActiveRegens] = useState<Map<number, string>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renderInFlight, setRenderInFlight] = useState(false);
  const [renderProgress, setRenderProgress] = useState<string | null>(null);
  const [hasPromoteSinceRender, setHasPromoteSinceRender] = useState(false);

  const selectedShot = useMemo(
    () => shots.find((shot) => shot.shotNumber === selectedShotNumber) ?? null,
    [selectedShotNumber, shots],
  );

  const loadShots = useCallback(async () => {
    try {
      setError(null);
      const response = await getProductionShots(productionSlug);
      setShots(response.shots);
      setRenderArtifact(response.renderArtifact ?? null);
      setActiveRegens(() => {
        const next = new Map<number, string>();
        response.shots.forEach((shot) => {
          if (shot.activeJob?.status === "running" && shot.activeJob.jobId) {
            next.set(shot.shotNumber, shot.activeJob.jobId);
          }
        });
        return next;
      });
    } catch {
      setError("Couldn't load the production catalog. Retry.");
    } finally {
      setIsLoading(false);
    }
  }, [productionSlug]);

  useEffect(() => {
    setShots([]);
    setRenderArtifact(null);
    setSelectedShotNumber(null);
    setActiveRegens(new Map());
    setError(null);
    setRenderInFlight(false);
    setRenderProgress(null);
    setHasPromoteSinceRender(false);
    setIsLoading(true);
    void loadShots();
  }, [loadShots]);

  useEffect(() => {
    const unsubscribe = subscribeToProductionEvents(
      productionSlug,
      (event) => {
        if (event.type === "regen_started") {
          const shotNumber = eventShotNumber(event);
          const jobId = typeof (event as { jobId?: unknown }).jobId === "string" ? (event as { jobId: string }).jobId : "running";
          if (shotNumber) {
            setActiveRegens((prev) => new Map(prev).set(shotNumber, jobId));
          }
        }
        if (event.type === "regen_complete") {
          const shotNumber = eventShotNumber(event);
          if (shotNumber) {
            setActiveRegens((prev) => {
              const next = new Map(prev);
              next.delete(shotNumber);
              return next;
            });
          }
          void loadShots();
        }
        if (event.type === "shot_promoted") {
          setHasPromoteSinceRender(true);
          void loadShots();
        }
        if (event.type === "shot_rejected") {
          void loadShots();
        }
        if (event.type === "render_started") {
          setRenderInFlight(true);
          setRenderProgress("Render queued");
        }
        if (event.type === "render_log") {
          const line = typeof (event as { line?: unknown }).line === "string" ? (event as { line: string }).line : "Rendering final cut";
          setRenderProgress(line.length > 96 ? `${line.slice(0, 96)}…` : line);
        }
        if (event.type === "render_complete") {
          const exitCode = typeof (event as { exitCode?: unknown }).exitCode === "number" ? (event as { exitCode: number }).exitCode : null;
          setRenderInFlight(false);
          setRenderProgress(exitCode === 0 ? "Render complete" : "Render failed");
        }
        if (event.type === "render_artifact") {
          const artifact = event as Extract<ProductionEvent, { type: "render_artifact" }>;
          setRenderArtifact({ path: artifact.path, sizeBytes: artifact.sizeBytes, mtime: artifact.timestamp, durationS: artifact.durationS ?? undefined });
          setHasPromoteSinceRender(false);
        }
      },
      () => {
        // Avoid noisy console warnings during dev server restarts; retry state is visible via refresh.
      },
    );
    return unsubscribe;
  }, [loadShots, productionSlug]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!selectedShotNumber) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const numbers = shots.map((shot) => shot.shotNumber).sort((a, b) => a - b);
      const index = numbers.indexOf(selectedShotNumber);
      if (index === -1) return;
      const next = numbers[Math.min(numbers.length - 1, Math.max(0, index + delta))];
      if (next !== selectedShotNumber) {
        event.preventDefault();
        setSelectedShotNumber(next);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedShotNumber, shots]);

  const pendingCount = shots.filter((shot) => shot.pending).length;
  const backupCount = shots.filter((shot) => shot.canonical.backupExists).length;
  const renderDisabled = renderInFlight || !hasPromoteSinceRender;

  const handleRender = async () => {
    setRenderProgress(null);
    setError(null);
    setRenderInFlight(true);
    try {
      await triggerProductionRender(productionSlug);
    } catch (err) {
      setRenderInFlight(false);
      setError(err instanceof Error ? err.message : "Couldn't start final cut render. Retry.");
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <div className="rounded-2xl border border-cyan-500/15 bg-[#070a0f]/75 p-4 shadow-[0_0_40px_rgba(0,0,0,0.2)]">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2 text-[8px] font-mono uppercase tracking-[0.32em] text-cyan-300/60">
              <Film size={12} /> HITL Production Loop
            </div>
            <h2 className="mt-1 text-xl font-black uppercase tracking-tight text-white">Drift MV — {shots.length || 30} shots</h2>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[8px] font-mono uppercase tracking-wider text-white/35">
              <span className="flex items-center"><Clock3 size={10} className="mr-1" /> Last render: {formatDate(renderArtifact?.mtime)}</span>
              {renderArtifact && <span>{formatBytes(renderArtifact.sizeBytes)}</span>}
              <span>{pendingCount} pending</span>
              <span>{backupCount} backups</span>
            </div>
          </div>
          <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            {renderProgress && (
              <span className={`max-w-xs truncate rounded-full border px-3 py-1.5 text-[8px] font-mono uppercase tracking-wider ${renderInFlight ? "border-cyan-500/25 bg-cyan-500/10 text-cyan-200" : "border-white/10 bg-white/[0.03] text-white/40"}`}>
                {renderProgress}
              </span>
            )}
            <button
              type="button"
              onClick={handleRender}
              disabled={renderDisabled}
              title={renderDisabled && !renderInFlight ? "Promote a pending take first to enable re-render" : "Re-render final cut"}
              className="flex items-center justify-center rounded-2xl bg-[#ED4C14] px-4 py-3 text-[10px] font-black uppercase tracking-[0.22em] text-white shadow-[0_0_24px_rgba(237,76,20,0.18)] transition-all hover:bg-orange-400 active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus:ring-2 focus:ring-orange-300/50"
            >
              {renderInFlight ? <Loader2 size={14} className="mr-2 animate-spin" /> : <RefreshCw size={14} className="mr-2" />}
              Re-render Final Cut
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-[10px] font-mono text-red-200">
          <span className="flex items-center"><AlertTriangle size={13} className="mr-2" /> {error}</span>
          <button type="button" onClick={() => void loadShots()} className="rounded-lg border border-red-400/30 px-3 py-1 uppercase tracking-wider hover:bg-red-500/10">
            Retry
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {Array.from({ length: 10 }).map((_, index) => <ShotSkeleton key={index} />)}
        </div>
      ) : shots.length === 0 ? (
        <div className="rounded-3xl border border-white/10 bg-white/[0.02] px-6 py-14 text-center">
          <Sparkles size={24} className="mx-auto text-cyan-400/35" />
          <p className="mt-3 text-[10px] font-mono uppercase tracking-[0.25em] text-white/35">No shots in this production catalog</p>
          <button type="button" onClick={() => void loadShots()} className="mt-4 rounded-xl border border-cyan-500/25 px-4 py-2 text-[9px] font-mono uppercase tracking-wider text-cyan-300 hover:bg-cyan-500/10">
            Reload catalog
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {shots.map((shot) => {
            const regenerating = activeRegens.has(shot.shotNumber);
            return (
              <button
                key={shot.shotNumber}
                type="button"
                onClick={() => setSelectedShotNumber(shot.shotNumber)}
                className={`group relative overflow-hidden rounded-2xl border bg-white/[0.025] p-3 text-left transition-all hover:-translate-y-0.5 hover:border-cyan-400/40 hover:bg-white/[0.045] focus:outline-none focus:ring-2 focus:ring-cyan-400/40 ${shot.pending ? "border-amber-500/25" : regenerating ? "border-cyan-400/35" : "border-white/10"}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-mono text-xs font-black uppercase text-white">
                      <span className="text-cyan-300">#{String(shot.shotNumber).padStart(2, "0")}</span>
                    </p>
                    <span className="mt-1 inline-flex max-w-full rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-0.5 text-[7px] font-mono uppercase tracking-widest text-cyan-200">
                      <span className="truncate">{formatBeat(shot.beat)}</span>
                    </span>
                  </div>
                  <StatusBadge shot={shot} regenerating={regenerating} />
                </div>

                <div className="mt-3 aspect-video overflow-hidden rounded-xl border border-white/10 bg-black/45">
                  {shot.stillPath ? (
                    <img
                      src={getProductionStillUrl(productionSlug, shot.shotNumber)}
                      alt={`Shot ${shot.shotNumber} first-frame still`}
                      className="h-full w-full object-cover opacity-80 transition-transform duration-500 group-hover:scale-105 group-hover:opacity-100"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-3xl font-black text-white/12">
                      {String(shot.shotNumber).padStart(2, "0")}
                    </div>
                  )}
                </div>

                <p className="mt-3 line-clamp-2 min-h-[2.25rem] text-[9px] leading-relaxed text-white/45">
                  {shot.visualIntent || "Visual intent not captured for this shot."}
                </p>

                <div className="mt-3 flex items-center justify-between gap-2 text-[8px] font-mono uppercase tracking-wider text-white/30">
                  <span>{shot.durationS}s · {shot.startS}s</span>
                  {shot.canonical.backupExists && (
                    <span className="rounded-full border border-white/10 px-2 py-0.5 text-white/35">Backup available</span>
                  )}
                </div>
                {shot.pending && (
                  <div className="absolute right-3 top-12 rounded-full bg-amber-400 shadow-[0_0_18px_rgba(251,191,36,0.65)] h-2 w-2" />
                )}
                {regenerating && <div className="absolute inset-x-0 bottom-0 h-0.5 bg-cyan-400 animate-pulse" />}
              </button>
            );
          })}
        </div>
      )}

      <ShotReshootDrawer
        productionSlug={productionSlug}
        shot={selectedShot}
        onClose={() => setSelectedShotNumber(null)}
        onRefresh={loadShots}
        onPromoted={() => setHasPromoteSinceRender(true)}
      />
    </div>
  );
}
