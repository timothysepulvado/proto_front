import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  RadioTower,
  ShieldCheck,
} from "lucide-react";
import {
  getOpenReviewGateEscalations,
  resolveEscalationAccept,
  subscribeToAssetEscalations,
  type ReviewGateEscalation,
} from "../api";

interface ReviewGateEscalationSurfaceProps {
  clientId: string;
  onOpenDeliverable?: (args: {
    deliverableId: string;
    runId?: string;
    shotNumber: number | null;
  }) => void;
  onCountChange?: (count: number) => void;
}

const defaultResolutionNotes =
  "Accepted in Review Gate — operator visual review approved the current asset; clearing escalation for downstream use.";

function shotNumberFromText(value: string | undefined): number | null {
  if (!value) return null;
  const match = /shot[_\s#-]*(\d{1,2})/i.exec(value) ?? /#(\d{1,2})\b/.exec(value);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null;
}

function formatFailureClass(value: string | undefined): string {
  if (!value) return "unclassified";
  return value.replace(/_/g, " ");
}

function formatAge(value: string): string {
  const created = new Date(value).getTime();
  if (!Number.isFinite(created)) return "recent";
  const minutes = Math.max(0, Math.round((Date.now() - created) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function ReviewGateEscalationSurface({
  clientId,
  onOpenDeliverable,
  onCountChange,
}: ReviewGateEscalationSurfaceProps) {
  const [items, setItems] = useState<ReviewGateEscalation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [notesById, setNotesById] = useState<Record<string, string>>({});
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [lastRealtimeAt, setLastRealtimeAt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    try {
      setError(null);
      const next = await getOpenReviewGateEscalations(clientId, 30);
      setItems(next);
      onCountChange?.(next.length);
      setNotesById((current) => {
        const merged: Record<string, string> = {};
        for (const item of next) {
          merged[item.escalation.id] = current[item.escalation.id] ?? defaultResolutionNotes;
        }
        return merged;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load escalation queue.");
    } finally {
      setIsLoading(false);
    }
  }, [clientId, onCountChange]);

  useEffect(() => {
    setItems([]);
    setIsLoading(true);
    setError(null);
    setMessage(null);
    setNotesById({});
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!clientId) return undefined;
    return subscribeToAssetEscalations(clientId, () => {
      setLastRealtimeAt(new Date().toISOString());
      void refresh();
    });
  }, [clientId, refresh]);

  const openHitlCount = useMemo(
    () => items.filter((item) => item.escalation.status === "hitl_required").length,
    [items],
  );

  const openInProgressCount = items.length - openHitlCount;

  const handleAccept = async (item: ReviewGateEscalation) => {
    const notes = (notesById[item.escalation.id] ?? defaultResolutionNotes).trim();
    if (!notes) {
      setError("Resolution notes are required before accepting an escalation.");
      return;
    }

    setResolvingId(item.escalation.id);
    setError(null);
    setMessage(null);
    try {
      const result = await resolveEscalationAccept(item.escalation.id, notes);
      setMessage(
        result.runHitlCleared
          ? "Escalation accepted and run HITL bubble cleared."
          : "Escalation accepted. Other open escalations still hold the run bubble.",
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't accept escalation.");
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <section className="mt-3 rounded-2xl border border-amber-500/20 bg-amber-500/[0.045] p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[8px] font-mono uppercase tracking-[0.24em] text-amber-200/80">
            <RadioTower size={11} /> Escalation-level HITL
          </div>
          <p className="mt-1 max-w-xl text-[9px] font-mono leading-relaxed text-white/35">
            Live queue from asset_escalations where status is hitl_required or in_progress and created in the last 30 days.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[8px] font-mono uppercase tracking-widest">
          <span className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-100">
            {openHitlCount} HITL
          </span>
          <span className="rounded-lg border border-cyan-500/25 bg-cyan-500/10 px-2 py-1 text-cyan-100">
            {openInProgressCount} in progress
          </span>
        </div>
      </div>

      {lastRealtimeAt && (
        <p className="mt-2 text-[8px] font-mono uppercase tracking-widest text-cyan-200/45">
          Realtime update received {new Date(lastRealtimeAt).toLocaleTimeString("en-US", { hour12: false })}
        </p>
      )}

      {error && (
        <div className="mt-3 flex items-center rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[9px] font-mono text-red-200">
          <AlertTriangle size={12} className="mr-2 shrink-0" /> {error}
        </div>
      )}

      {message && (
        <div className="mt-3 flex items-center rounded-xl border border-cyan-500/25 bg-cyan-500/10 px-3 py-2 text-[9px] font-mono text-cyan-100">
          <CheckCircle2 size={12} className="mr-2 shrink-0" /> {message}
        </div>
      )}

      {isLoading ? (
        <div className="mt-3 flex items-center justify-center rounded-xl border border-white/10 bg-black/20 py-6 text-[9px] font-mono uppercase tracking-widest text-white/30">
          <Loader2 size={13} className="mr-2 animate-spin" /> Loading escalation queue
        </div>
      ) : items.length === 0 ? (
        <div className="mt-3 flex items-center rounded-xl border border-cyan-500/20 bg-cyan-500/[0.06] px-3 py-4 text-[9px] font-mono text-cyan-100/70">
          <ShieldCheck size={13} className="mr-2 shrink-0" />
          No open escalation-level HITL in the last 30 days.
        </div>
      ) : (
        <div className="mt-3 grid gap-2 xl:grid-cols-2">
          {items.map((item) => {
            const { escalation, deliverable, run } = item;
            const shotNumber = shotNumberFromText(deliverable?.description);
            const notes = notesById[escalation.id] ?? defaultResolutionNotes;
            const isResolving = resolvingId === escalation.id;

            return (
              <article
                key={escalation.id}
                className="rounded-2xl border border-white/10 bg-black/25 p-3 shadow-[0_0_24px_rgba(0,0,0,0.16)]"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-2 py-1 text-[8px] font-mono font-bold uppercase tracking-widest text-amber-100">
                        {shotNumber ? `Shot ${String(shotNumber).padStart(2, "0")}` : "Shot unmapped"}
                      </span>
                      <span className="rounded-lg border border-white/10 px-2 py-1 text-[8px] font-mono uppercase tracking-widest text-white/45">
                        {escalation.currentLevel} · iter {escalation.iterationCount}
                      </span>
                      <span
                        className={`rounded-lg border px-2 py-1 text-[8px] font-mono uppercase tracking-widest ${
                          escalation.status === "hitl_required"
                            ? "border-amber-500/35 bg-amber-500/10 text-amber-100"
                            : "border-cyan-500/25 bg-cyan-500/10 text-cyan-100"
                        }`}
                      >
                        {escalation.status.replace(/_/g, " ")}
                      </span>
                    </div>
                    <p className="mt-2 line-clamp-2 text-[10px] font-mono leading-relaxed text-white/70">
                      {deliverable?.description ?? `Deliverable ${escalation.deliverableId?.slice(0, 8) ?? "unknown"}`}
                    </p>
                    <p className="mt-1 text-[8px] font-mono uppercase tracking-wider text-white/30">
                      {run ? `Run ${run.runId.slice(0, 8)} · ${run.mode}` : "Run unmapped"} · {formatAge(escalation.createdAt)}
                    </p>
                  </div>
                </div>

                <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.025] px-3 py-2">
                  <p className="text-[8px] font-mono uppercase tracking-widest text-white/30">Failure class</p>
                  <p className="mt-1 text-[9px] font-mono leading-relaxed text-amber-100/80">
                    {formatFailureClass(escalation.failureClass)}
                  </p>
                </div>

                <label className="mt-3 block">
                  <span className="text-[8px] font-mono uppercase tracking-widest text-white/30">
                    Resolution notes
                  </span>
                  <textarea
                    value={notes}
                    rows={2}
                    onChange={(event) => {
                      const value = event.target.value;
                      setNotesById((current) => ({ ...current, [escalation.id]: value }));
                    }}
                    className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-black/35 p-3 text-[9px] font-mono leading-relaxed text-white/75 outline-none transition-colors focus:border-cyan-400/40 focus:ring-2 focus:ring-cyan-400/20"
                  />
                </label>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    disabled={!deliverable?.id}
                    onClick={() => {
                      if (!deliverable?.id) return;
                      onOpenDeliverable?.({
                        deliverableId: deliverable.id,
                        runId: run?.runId ?? escalation.runId,
                        shotNumber,
                      });
                    }}
                    className="inline-flex items-center rounded-xl border border-white/10 px-3 py-2 text-[8px] font-mono font-bold uppercase tracking-wider text-white/45 transition-all hover:border-cyan-400/35 hover:bg-cyan-500/10 hover:text-cyan-100 focus:outline-none focus:ring-2 focus:ring-cyan-400/35 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    Open drawer <ChevronRight size={11} className="ml-1" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleAccept(item)}
                    disabled={isResolving}
                    className="inline-flex items-center rounded-xl bg-cyan-400 px-4 py-2 text-[8px] font-black uppercase tracking-[0.2em] text-black transition-all hover:bg-white focus:outline-none focus:ring-2 focus:ring-cyan-200/70 active:scale-95 disabled:cursor-not-allowed disabled:opacity-45"
                    aria-label={`Accept escalation ${escalation.id}`}
                  >
                    {isResolving ? <Loader2 size={12} className="mr-1.5 animate-spin" /> : <CheckCircle2 size={12} className="mr-1.5" />}
                    Accept
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
