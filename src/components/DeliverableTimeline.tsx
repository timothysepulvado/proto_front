import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock3, Film, RefreshCw } from "lucide-react";
import {
  getProductionShotThumbnailUrl,
  getProductionShots,
  subscribeToProductionEvents,
  type ProductionEvent,
  type ProductionShotState,
  type ProductionSlug,
} from "../api";
import ShotReshootDrawer from "./ShotReshootDrawer";

interface DeliverableTimelineProps {
  productionSlug?: ProductionSlug;
}

const PX_PER_SECOND = 12;
const CARD_HEIGHT = 80;

function formatTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function eventShotNumber(event: ProductionEvent): number | null {
  const value = (event as { shotNumber?: unknown }).shotNumber;
  return typeof value === "number" ? value : null;
}

function timelineStatus(shot: ProductionShotState): { label: string; className: string } {
  if (shot.activeJob?.status === "running") {
    return { label: "regen", className: "border-purple-400/50 bg-purple-500/25 text-purple-100" };
  }
  if (shot.pending) {
    return { label: "pending", className: "border-amber-400/50 bg-amber-500/25 text-amber-100" };
  }
  return { label: "live", className: "border-emerald-400/45 bg-emerald-500/20 text-emerald-100" };
}

function TimelineSkeleton() {
  return (
    <section className="mt-3 overflow-hidden rounded-2xl border border-white/10 bg-black/20 p-4">
      <div className="mb-4 flex items-center justify-between">
        <div className="h-3 w-44 rounded-full bg-white/10" />
        <div className="h-3 w-24 rounded-full bg-white/10" />
      </div>
      <div className="flex gap-2 overflow-hidden">
        {Array.from({ length: 10 }).map((_, index) => (
          <div
            key={index}
            className="h-20 shrink-0 animate-pulse rounded-xl border border-white/10 bg-white/[0.06]"
            style={{ width: `${72 + (index % 3) * 24}px` }}
          />
        ))}
      </div>
    </section>
  );
}

export default function DeliverableTimeline({ productionSlug = "drift-mv" }: DeliverableTimelineProps) {
  const [shots, setShots] = useState<ProductionShotState[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedShotNumber, setSelectedShotNumber] = useState<number | null>(null);
  const [thumbnailBust, setThumbnailBust] = useState<Record<number, number>>({});

  const loadShots = useCallback(async () => {
    try {
      setError(null);
      const response = await getProductionShots(productionSlug);
      setShots(response.shots);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load production timeline.");
    } finally {
      setIsLoading(false);
    }
  }, [productionSlug]);

  useEffect(() => {
    setIsLoading(true);
    void loadShots();
  }, [loadShots]);

  useEffect(() => {
    const unsubscribe = subscribeToProductionEvents(
      productionSlug,
      (event) => {
        const shotNumber = eventShotNumber(event);
        if (
          event.type === "regen_started"
          || event.type === "regen_complete"
          || event.type === "shot_promoted"
          || event.type === "shot_rejected"
          || event.type === "shot_manifest_updated"
        ) {
          if (shotNumber) {
            setThumbnailBust((prev) => ({ ...prev, [shotNumber]: Date.now() }));
          }
          void loadShots();
        }
      },
      () => {
        // The timeline self-heals on the next explicit refresh/event; avoid console noise during HMR/dev restarts.
      },
    );
    return unsubscribe;
  }, [loadShots, productionSlug]);

  const selectedShot = useMemo(
    () => shots.find((shot) => shot.shotNumber === selectedShotNumber) ?? null,
    [selectedShotNumber, shots],
  );

  const totalDuration = useMemo(
    () => Math.max(...shots.map((shot) => shot.endS), shots.reduce((sum, shot) => sum + shot.durationS, 0), 0),
    [shots],
  );
  const timelineWidth = Math.max(totalDuration * PX_PER_SECOND, 900);
  const ticks = useMemo(() => {
    const count = Math.max(1, Math.ceil(totalDuration / 30));
    return Array.from({ length: count + 1 }, (_, index) => index * 30).filter((seconds) => seconds <= totalDuration + 1);
  }, [totalDuration]);

  if (isLoading) return <TimelineSkeleton />;

  return (
    <section className="mt-3 rounded-2xl border border-cyan-500/15 bg-black/25 p-4 shadow-[0_0_30px_rgba(34,211,238,0.04)]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[9px] font-mono uppercase tracking-[0.28em] text-cyan-300/75">
            <Film size={12} /> Visual cut timeline
          </div>
          <p className="mt-1 text-[8px] font-mono uppercase tracking-wider text-white/30">
            First-frame scrub · {shots.length} shots · {formatTime(totalDuration)} total
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadShots()}
          className="inline-flex items-center rounded-xl border border-white/10 px-3 py-2 text-[8px] font-mono uppercase tracking-widest text-white/45 transition-all hover:border-cyan-400/30 hover:bg-cyan-500/10 hover:text-cyan-200 focus:outline-none focus:ring-2 focus:ring-cyan-400/40"
        >
          <RefreshCw size={10} className="mr-1.5" /> Refresh
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[9px] font-mono text-amber-200">
          {error}
        </div>
      )}

      {shots.length === 0 ? (
        <div className="flex h-24 items-center justify-center rounded-xl border border-white/10 bg-white/[0.02] text-[9px] font-mono uppercase tracking-widest text-white/25">
          No production shots loaded
        </div>
      ) : (
        <div className="overflow-x-auto overflow-y-hidden pb-3 scrollbar-thin scrollbar-thumb-cyan-500/20 scrollbar-track-white/5">
          <div className="relative" style={{ width: `${timelineWidth}px` }}>
            <div className="relative mb-2 h-8 border-b border-white/10">
              {ticks.map((seconds) => (
                <div
                  key={seconds}
                  className="absolute bottom-0 top-0 border-l border-cyan-400/25"
                  style={{ left: `${seconds * PX_PER_SECOND}px` }}
                >
                  <span className="absolute -left-3 top-0 text-[8px] font-mono text-cyan-200/45">{formatTime(seconds)}</span>
                </div>
              ))}
            </div>

            <div className="flex items-stretch gap-1.5">
              {shots.map((shot) => {
                const status = timelineStatus(shot);
                const width = Math.max(shot.durationS * PX_PER_SECOND, 48);
                const thumb = getProductionShotThumbnailUrl(productionSlug, shot.shotNumber, thumbnailBust[shot.shotNumber]);
                return (
                  <button
                    key={shot.shotNumber}
                    type="button"
                    title={shot.visualIntent.slice(0, 120)}
                    onClick={() => setSelectedShotNumber(shot.shotNumber)}
                    className="group relative shrink-0 overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] text-left shadow-[0_10px_30px_rgba(0,0,0,0.22)] transition-all hover:z-10 hover:scale-105 hover:border-cyan-300/50 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-cyan-400/50"
                    style={{ width: `${width}px`, height: `${CARD_HEIGHT}px` }}
                  >
                    <img
                      src={thumb}
                      alt={`Shot ${shot.shotNumber} thumbnail`}
                      loading="lazy"
                      className="absolute inset-0 h-full w-full object-cover opacity-75 transition-opacity group-hover:opacity-100"
                      onError={(event) => {
                        event.currentTarget.style.display = "none";
                      }}
                    />
                    <div className="absolute inset-0 bg-gradient-to-b from-black/65 via-black/10 to-black/75" />
                    <span className="absolute left-1.5 top-1.5 rounded-md border border-white/15 bg-black/50 px-1.5 py-0.5 text-[8px] font-mono font-bold text-white">
                      #{String(shot.shotNumber).padStart(2, "0")}
                    </span>
                    <span className="absolute right-1.5 top-1.5 rounded-md border border-white/15 bg-black/50 px-1.5 py-0.5 text-[8px] font-mono text-white/80">
                      {shot.durationS}s
                    </span>
                    <span className="absolute bottom-1.5 left-1.5 max-w-[70%] truncate rounded-md border border-cyan-400/20 bg-cyan-500/15 px-1.5 py-0.5 text-[7px] font-mono uppercase tracking-wider text-cyan-100">
                      {shot.beat.replace(/_/g, " ")}
                    </span>
                    <span className={`absolute bottom-1.5 right-1.5 rounded-md border px-1.5 py-0.5 text-[7px] font-mono uppercase tracking-wider ${status.className}`}>
                      {status.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="mt-2 flex items-center gap-2 text-[8px] font-mono uppercase tracking-widest text-white/25">
        <Clock3 size={10} /> Click a shot to open reshoot controls; use Final HITL inside the drawer for manifest edits.
      </div>

      <ShotReshootDrawer
        productionSlug={productionSlug}
        shot={selectedShot}
        onClose={() => setSelectedShotNumber(null)}
        onRefresh={loadShots}
      />
    </section>
  );
}
