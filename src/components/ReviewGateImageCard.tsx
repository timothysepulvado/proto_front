import { useMemo, useState } from "react";
import {
  CheckCircle2,
  ImageOff,
  Loader2,
  MessageSquareText,
  XCircle,
} from "lucide-react";
import {
  resolveArtifactDisplayUrl,
  type ArtifactIterationRow,
  type ReviewGateCommentScope,
  type ReviewGateEscalation,
} from "../api";
import { useSignedArtifactUrl } from "../hooks/useSignedArtifactUrl";
import RejectTeachModal from "./RejectTeachModal";

type ReviewGateImageCardAction = "accept" | "reject" | "comment";

interface ReviewGateImageCardProps {
  escalation: ReviewGateEscalation;
  iters: ArtifactIterationRow[];
  onAction: (
    action: ReviewGateImageCardAction,
    payload?: { text?: string; scope?: ReviewGateCommentScope },
  ) => Promise<void>;
  onOpenDeepDive?: () => void;
}

function formatFailureClass(value: string | undefined): string {
  if (!value) return "unclassified";
  return value.replace(/_/g, " ");
}

function shotNumberFromText(value: string | undefined): number | null {
  if (!value) return null;
  const match = /shot[_\s#-]*(\d{1,3})/i.exec(value) ?? /#(\d{1,3})\b/.exec(value);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null;
}

function criticLabel(row: ArtifactIterationRow): string {
  const verdict = row.verdict?.verdict ?? "—";
  const score = row.verdict?.score;
  return score == null ? `${verdict} critic` : `${verdict} critic ${score.toFixed(2)}`;
}

function IterationImage({ row, single }: { row: ArtifactIterationRow; single: boolean }) {
  const canResolveFromStorage = Boolean(row.artifact.storagePath);
  const { url, loading, error } = useSignedArtifactUrl(canResolveFromStorage ? row.artifact.id : undefined);
  const localFallback =
    !canResolveFromStorage && row.displayUrl?.startsWith("/api/")
      ? resolveArtifactDisplayUrl(row.displayUrl)
      : null;
  const displayUrl = canResolveFromStorage ? url : localFallback;

  return (
    <figure className="min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.035]">
      <div className={`${single ? "aspect-[16/10]" : "aspect-[4/3]"} relative bg-black/45`}>
        {loading ? (
          <div className="flex h-full w-full items-center justify-center bg-white/[0.04]">
            <Loader2 size={16} className="animate-spin text-cyan-100/60" />
          </div>
        ) : displayUrl ? (
          <img
            src={displayUrl}
            alt={`${row.label} preview`}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center text-[8px] font-mono uppercase tracking-widest text-white/35">
            <ImageOff size={18} />
            <span>{error ?? "No signed preview"}</span>
          </div>
        )}
      </div>
      <figcaption className="flex items-center justify-between gap-2 border-t border-white/10 px-3 py-2">
        <span className="truncate text-[8px] font-mono uppercase tracking-widest text-white/45">{row.label}</span>
        <span className="shrink-0 text-[8px] font-mono uppercase tracking-widest text-cyan-100/70">
          {criticLabel(row)}
        </span>
      </figcaption>
    </figure>
  );
}

export default function ReviewGateImageCard({
  escalation: item,
  iters,
  onAction,
  onOpenDeepDive,
}: ReviewGateImageCardProps) {
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [scope, setScope] = useState<ReviewGateCommentScope>("shot");
  const [busyAction, setBusyAction] = useState<ReviewGateImageCardAction | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);

  const { escalation, deliverable, run } = item;
  const shotNumber = iters[0]?.shotNumber ?? shotNumberFromText(deliverable?.description);
  const imageRows = useMemo(
    () => iters.filter((row) => row.artifact.type === "image").slice(-2),
    [iters],
  );
  const latestIter = imageRows.at(-1)?.iter ?? escalation.iterationCount;
  const canSubmitComment = commentText.trim().length > 0 && !busyAction;

  const handleAccept = async () => {
    setBusyAction("accept");
    try {
      await onAction("accept");
    } finally {
      setBusyAction(null);
    }
  };

  const handleComment = async () => {
    if (!canSubmitComment) return;
    setBusyAction("comment");
    try {
      await onAction("comment", { text: commentText.trim(), scope });
      setCommentText("");
      setCommentOpen(false);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <article
      data-testid="review-gate-image-card"
      className="overflow-hidden rounded-[1.75rem] border border-white/10 bg-black/25 shadow-[0_0_30px_rgba(0,0,0,0.20)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-white/[0.025] px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-2.5 py-1 text-[8px] font-mono font-black uppercase tracking-widest text-amber-100">
            {shotNumber ? `Shot ${String(shotNumber).padStart(2, "0")}` : "Shot unmapped"}
          </span>
          <span className="rounded-lg border border-white/10 px-2.5 py-1 text-[8px] font-mono uppercase tracking-widest text-white/50">
            {escalation.currentLevel} · iter {latestIter ?? "—"}
          </span>
          <span
            className={`rounded-lg border px-2.5 py-1 text-[8px] font-mono uppercase tracking-widest ${
              escalation.status === "hitl_required"
                ? "border-amber-500/35 bg-amber-500/10 text-amber-100"
                : "border-cyan-500/25 bg-cyan-500/10 text-cyan-100"
            }`}
          >
            {escalation.status.replace(/_/g, " ")}
          </span>
        </div>
        {onOpenDeepDive && (
          <button
            type="button"
            onClick={onOpenDeepDive}
            className="rounded-lg border border-white/10 px-2.5 py-1 text-[8px] font-mono uppercase tracking-widest text-white/40 transition hover:border-cyan-400/35 hover:text-cyan-100"
          >
            Deep dive
          </button>
        )}
      </div>

      <div className="p-3">
        {imageRows.length > 0 ? (
          <div className={imageRows.length >= 2 ? "grid gap-3 sm:grid-cols-2" : "grid gap-3"}>
            {imageRows.map((row) => (
              <IterationImage key={row.artifact.id} row={row} single={imageRows.length === 1} />
            ))}
          </div>
        ) : (
          <div className="flex min-h-[220px] items-center justify-center rounded-2xl border border-white/10 bg-white/[0.035] px-4 text-center text-[9px] font-mono uppercase tracking-widest text-white/35">
            <ImageOff size={16} className="mr-2" /> Iteration images unavailable
          </div>
        )}

        <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.025] px-3 py-2.5">
          <p className="line-clamp-2 text-[10px] font-mono leading-relaxed text-white/72">
            {deliverable?.description ?? `Deliverable ${escalation.deliverableId?.slice(0, 8) ?? "unknown"}`}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[8px] font-mono uppercase tracking-widest">
            <span className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-amber-100/80">
              Failure: {formatFailureClass(escalation.failureClass)}
            </span>
            <span className="rounded-lg border border-white/10 px-2 py-1 text-white/35">
              {run ? `Run ${run.runId.slice(0, 8)} · ${run.mode}` : "Run unmapped"}
            </span>
          </div>
        </div>

        {commentOpen && (
          <div className="mt-3 rounded-2xl border border-cyan-400/20 bg-cyan-500/[0.06] p-3">
            <label className="block">
              <span className="text-[8px] font-mono uppercase tracking-widest text-cyan-100/65">Comment text</span>
              <textarea
                rows={3}
                value={commentText}
                onChange={(event) => setCommentText(event.target.value)}
                placeholder="Describe the direction change to apply before regenerating."
                className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-black/40 p-3 text-[10px] font-mono leading-relaxed text-white/80 outline-none transition-colors placeholder:text-white/25 focus:border-cyan-300/45 focus:ring-2 focus:ring-cyan-300/20"
              />
            </label>

            <fieldset className="mt-3 grid gap-2 sm:grid-cols-2">
              {[
                ["shot", "This shot only"],
                ["campaign", "Campaign-wide direction"],
              ].map(([value, label]) => (
                <label
                  key={value}
                  className={`flex cursor-pointer items-center rounded-xl border px-3 py-2 text-[8px] font-mono uppercase tracking-widest transition ${
                    scope === value
                      ? "border-cyan-300/45 bg-cyan-400/15 text-cyan-50"
                      : "border-white/10 bg-black/20 text-white/45 hover:border-white/20"
                  }`}
                >
                  <input
                    type="radio"
                    name={`review-scope-${escalation.id}`}
                    value={value}
                    checked={scope === value}
                    onChange={() => setScope(value as ReviewGateCommentScope)}
                    className="mr-2 accent-cyan-300"
                  />
                  {label}
                </label>
              ))}
            </fieldset>

            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setCommentOpen(false);
                  setCommentText("");
                }}
                disabled={busyAction === "comment"}
                className="rounded-xl border border-white/10 px-3 py-2 text-[8px] font-mono font-bold uppercase tracking-widest text-white/45 transition hover:border-white/25 hover:text-white/75 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleComment()}
                disabled={!canSubmitComment}
                className="inline-flex items-center rounded-xl bg-cyan-300 px-3 py-2 text-[8px] font-black uppercase tracking-[0.18em] text-black transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-45"
              >
                {busyAction === "comment" ? <Loader2 size={12} className="mr-1.5 animate-spin" /> : <MessageSquareText size={12} className="mr-1.5" />}
                Submit & Regen
              </button>
            </div>
          </div>
        )}

        <div className="mt-3 grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => {
              setRejectOpen(true);
            }}
            className="inline-flex items-center justify-center rounded-xl border border-rose-400/25 bg-rose-500/10 px-2 py-2 text-[8px] font-black uppercase tracking-[0.14em] text-rose-100 transition hover:border-rose-300/50 hover:bg-rose-500/18"
          >
            <XCircle size={12} className="mr-1" /> Reject
          </button>
          <button
            type="button"
            onClick={() => {
              setCommentOpen((value) => !value);
            }}
            className="inline-flex items-center justify-center rounded-xl border border-cyan-400/25 bg-cyan-500/10 px-2 py-2 text-[8px] font-black uppercase tracking-[0.14em] text-cyan-100 transition hover:border-cyan-300/50 hover:bg-cyan-500/18"
          >
            <MessageSquareText size={12} className="mr-1" /> Comment
          </button>
          <button
            type="button"
            onClick={() => void handleAccept()}
            disabled={busyAction === "accept"}
            className="inline-flex items-center justify-center rounded-xl bg-cyan-300 px-2 py-2 text-[8px] font-black uppercase tracking-[0.14em] text-black transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busyAction === "accept" ? <Loader2 size={12} className="mr-1 animate-spin" /> : <CheckCircle2 size={12} className="mr-1" />}
            Accept
          </button>
        </div>
      </div>
      <RejectTeachModal
        open={rejectOpen}
        escalation={item}
        onClose={() => setRejectOpen(false)}
        onRejected={async () => {
          await onAction("reject");
        }}
      />
    </article>
  );
}
