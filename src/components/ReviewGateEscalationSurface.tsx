import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RadioTower,
  ShieldCheck,
} from "lucide-react";
import {
  acceptReviewGateEscalation,
  commentReviewGateEscalation,
  getArtifactIterationsForDeliverable,
  getOpenReviewGateEscalations,
  subscribeToAssetEscalations,
  type ArtifactIterationRow,
  type ReviewGateCommentScope,
  type ReviewGateEscalation,
} from "../api";
import ReviewGateImageCard from "./ReviewGateImageCard";

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
  const match = /shot[_\s#-]*(\d{1,3})/i.exec(value) ?? /#(\d{1,3})\b/.exec(value);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null;
}

function isAcceptedBoilerplateZombie(item: ReviewGateEscalation): boolean {
  if (/Accepted in Review Gate/i.test(item.escalation.resolutionNotes ?? "")) return true;

  // Live Drift MV still carries the same accepted-zombie family on older
  // in_progress rows where the historical handler failed before writing
  // resolution_notes at all. Keep this UI filter conservative: only hide
  // note-less in_progress rows after they are clearly not fresh active work.
  if (item.escalation.status !== "in_progress" || item.escalation.resolutionNotes) return false;
  const createdAtMs = new Date(item.escalation.createdAt).getTime();
  if (!Number.isFinite(createdAtMs)) return false;
  return Date.now() - createdAtMs > 6 * 60 * 60 * 1000;
}

export default function ReviewGateEscalationSurface({
  clientId,
  onOpenDeliverable,
  onCountChange,
}: ReviewGateEscalationSurfaceProps) {
  const [items, setItems] = useState<ReviewGateEscalation[]>([]);
  const [iterationsById, setIterationsById] = useState<Record<string, ArtifactIterationRow[]>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lastRealtimeAt, setLastRealtimeAt] = useState<string | null>(null);
  const refreshRequestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const requestId = ++refreshRequestIdRef.current;
    try {
      setError(null);
      const next = await getOpenReviewGateEscalations(clientId, 30);
      if (requestId !== refreshRequestIdRef.current) return;
      setItems(next);

      const iterationEntries = await Promise.all(
        next.map(async (item): Promise<[string, ArtifactIterationRow[]]> => {
          if (!item.deliverable?.id) return [item.escalation.id, []];
          try {
            const response = await getArtifactIterationsForDeliverable(item.deliverable.id);
            return [item.escalation.id, response.rows];
          } catch {
            return [item.escalation.id, []];
          }
        }),
      );
      if (requestId !== refreshRequestIdRef.current) return;
      setIterationsById(Object.fromEntries(iterationEntries));
    } catch (err) {
      if (requestId !== refreshRequestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Couldn't load escalation queue.");
    } finally {
      if (requestId === refreshRequestIdRef.current) setIsLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    setItems([]);
    setIterationsById({});
    setIsLoading(true);
    setError(null);
    setMessage(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!clientId) return undefined;
    return subscribeToAssetEscalations(clientId, () => {
      setLastRealtimeAt(new Date().toISOString());
      void refresh();
    });
  }, [clientId, refresh]);

  const visibleItems = useMemo(
    () => (showResolved ? items : items.filter((item) => !isAcceptedBoilerplateZombie(item))),
    [items, showResolved],
  );

  useEffect(() => {
    onCountChange?.(visibleItems.length);
  }, [onCountChange, visibleItems.length]);

  const hiddenResolvedCount = useMemo(
    () => items.filter((item) => isAcceptedBoilerplateZombie(item)).length,
    [items],
  );

  const openHitlCount = useMemo(
    () => visibleItems.filter((item) => item.escalation.status === "hitl_required").length,
    [visibleItems],
  );

  const openInProgressCount = visibleItems.length - openHitlCount;

  const handleAction = async (
    item: ReviewGateEscalation,
    action: "accept" | "reject" | "comment",
    payload?: { text?: string; scope?: ReviewGateCommentScope },
  ) => {
    setError(null);
    setMessage(null);

    if (action === "reject") {
      setMessage("Reject-as-Teach learning captured and block applied.");
      await refresh();
      return;
    }

    try {
      if (action === "accept") {
        const result = await acceptReviewGateEscalation(item.escalation.id, defaultResolutionNotes);
        setMessage(
          result.runHitlCleared
            ? "Escalation accepted and run HITL bubble cleared."
            : "Escalation accepted. Other open escalations still hold the run bubble.",
        );
      } else {
        if (!payload?.text || !payload.scope) {
          setError("Comment text and scope are required before regenerating.");
          return;
        }
        const result = await commentReviewGateEscalation(item.escalation.id, {
          text: payload.text,
          scope: payload.scope,
        });
        const targetCopy = result.targetShotIds.length > 0
          ? `targeting shot${result.targetShotIds.length === 1 ? "" : "s"} ${result.targetShotIds.join(", ")}`
          : "no below-threshold regen targets found";
        setMessage(
          result.newRunId
            ? `Comment saved and regen queued (${result.newRunId.slice(0, 8)}), ${targetCopy}.`
            : `Comment saved; ${targetCopy}.`,
        );
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Review Gate action failed.");
      throw err;
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
            Image-first Review Gate queue with signed previews, last-2 iteration compare, Accept, and comment-scoped regen.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 text-[8px] font-mono uppercase tracking-widest">
          <span className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-100">
            {openHitlCount} HITL
          </span>
          <span className="rounded-lg border border-cyan-500/25 bg-cyan-500/10 px-2 py-1 text-cyan-100">
            {openInProgressCount} in progress
          </span>
          <button
            type="button"
            data-testid="review-gate-show-resolved-toggle"
            onClick={() => setShowResolved((value) => !value)}
            className={`rounded-lg border px-2 py-1 transition ${
              showResolved
                ? "border-cyan-300/40 bg-cyan-400/15 text-cyan-50"
                : "border-white/10 bg-white/[0.035] text-white/45 hover:border-cyan-400/30 hover:text-cyan-100"
            }`}
          >
            {showResolved ? "Hide resolved" : `Show resolved${hiddenResolvedCount ? ` (${hiddenResolvedCount})` : ""}`}
          </button>
        </div>
      </div>

      {lastRealtimeAt && (
        <p className="mt-2 text-[8px] font-mono uppercase tracking-widest text-cyan-200/45">
          Realtime update received {new Date(lastRealtimeAt).toLocaleTimeString("en-US", { hour12: false })}
        </p>
      )}

      {hiddenResolvedCount > 0 && !showResolved && (
        <p className="mt-2 text-[8px] font-mono uppercase tracking-widest text-white/30">
          Default queue hides {hiddenResolvedCount} accepted/state-stuck zombie escalation{hiddenResolvedCount === 1 ? "" : "s"}.
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
      ) : visibleItems.length === 0 ? (
        <div className="mt-3 flex items-center rounded-xl border border-cyan-500/20 bg-cyan-500/[0.06] px-3 py-4 text-[9px] font-mono text-cyan-100/70">
          <ShieldCheck size={13} className="mr-2 shrink-0" />
          {items.length > 0 && !showResolved
            ? "Default queue is clear after filtering accepted/state-stuck zombies. Use Show resolved to inspect them."
            : "No open escalation-level HITL in the last 30 days."}
        </div>
      ) : (
        <div className="mt-3 grid gap-3 2xl:grid-cols-2">
          {visibleItems.map((item) => {
            const shotNumber = iterationsById[item.escalation.id]?.[0]?.shotNumber
              ?? shotNumberFromText(item.deliverable?.description);
            return (
              <ReviewGateImageCard
                key={item.escalation.id}
                escalation={item}
                iters={iterationsById[item.escalation.id] ?? []}
                onAction={(action, payload) => handleAction(item, action, payload)}
                onOpenDeepDive={item.deliverable?.id ? () => {
                  onOpenDeliverable?.({
                    deliverableId: item.deliverable!.id,
                    runId: item.run?.runId ?? item.escalation.runId,
                    shotNumber,
                  });
                } : undefined}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
