import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowRight,
  BookOpenCheck,
  Loader2,
  ShieldAlert,
  Upload,
  X,
} from "lucide-react";
import {
  getRejectionCategories,
  rejectReviewGateEscalation,
  type RejectReviewGateEscalationResponse,
  type RejectionCategory,
  type RejectionLearningBlockMode,
  type ReviewGateEscalation,
} from "../api";

interface RejectTeachModalProps {
  open: boolean;
  escalation: ReviewGateEscalation;
  onClose: () => void;
  onRejected?: (result: RejectReviewGateEscalationResponse) => void | Promise<void>;
}

type ModalStage = "learning" | "block";

function shotNumberFromText(value: string | undefined): number | null {
  if (!value) return null;
  const match = /shot[_\s#-]*(\d{1,3})/i.exec(value) ?? /#(\d{1,3})\b/.exec(value);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Reference image could not be read."));
    };
    reader.onerror = () => reject(new Error("Reference image could not be read."));
    reader.readAsDataURL(file);
  });
}

export default function RejectTeachModal({
  open,
  escalation: item,
  onClose,
  onRejected,
}: RejectTeachModalProps) {
  const [stage, setStage] = useState<ModalStage>("learning");
  const [categories, setCategories] = useState<RejectionCategory[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [categoryId, setCategoryId] = useState("");
  const [whatWrong, setWhatWrong] = useState("");
  const [correction, setCorrection] = useState("");
  const [refImageData, setRefImageData] = useState<string | undefined>(undefined);
  const [refImageName, setRefImageName] = useState<string | null>(null);
  const [blockMode, setBlockMode] = useState<RejectionLearningBlockMode>("soft");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { escalation, deliverable, run } = item;
  const shotNumber = useMemo(() => shotNumberFromText(deliverable?.description), [deliverable?.description]);
  const learningValid = categoryId && whatWrong.trim().length >= 10 && correction.trim().length >= 10;

  useEffect(() => {
    if (!open) return;
    setStage("learning");
    setCategoryId("");
    setWhatWrong("");
    setCorrection("");
    setRefImageData(undefined);
    setRefImageName(null);
    setBlockMode("soft");
    setError(null);
    setSubmitting(false);
  }, [open, escalation.id]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCategoriesLoading(true);
    getRejectionCategories()
      .then((items) => {
        if (!cancelled) setCategories(items);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load rejection categories.");
      })
      .finally(() => {
        if (!cancelled) setCategoriesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const chooseRefImage = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (file.type !== "image/png") {
      setRefImageData(undefined);
      setRefImageName(null);
      setError("Reference image must be a PNG for Review Gate learning storage.");
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      setRefImageData(dataUrl);
      setRefImageName(file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reference image could not be read.");
    }
  };

  const captureLearning = () => {
    setError(null);
    if (!learningValid) {
      setError("Category, specific issue, and corrective adjustment are required before choosing block mode.");
      return;
    }
    setStage("block");
  };

  const applyBlock = async () => {
    if (!learningValid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await rejectReviewGateEscalation(escalation.id, {
        categoryId,
        whatWrong: whatWrong.trim(),
        correction: correction.trim(),
        refImageData,
        blockMode,
      });
      await onRejected?.(result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reject-as-Teach failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal((
    <div
      data-testid="reject-teach-modal"
      className="fixed inset-0 z-[700] flex items-stretch justify-center bg-black/82 p-2 backdrop-blur-md sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`reject-teach-title-${escalation.id}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void chooseRefImage(event.dataTransfer.files?.[0]);
      }}
    >
      <div className="relative flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-[1.75rem] border border-rose-300/25 bg-[#090b10]/96 shadow-[0_24px_80px_rgba(0,0,0,0.55)]">
        <div className="flex items-start justify-between gap-3 border-b border-white/10 bg-rose-500/[0.08] px-4 py-3 sm:px-5">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-[8px] font-mono font-black uppercase tracking-[0.24em] text-rose-100/80">
              <ShieldAlert size={12} /> Reject-as-Teach
              <span className="rounded-md border border-white/10 bg-black/20 px-2 py-0.5 text-white/45">
                {shotNumber ? `Shot ${String(shotNumber).padStart(2, "0")}` : "Shot unmapped"}
              </span>
              <span className="rounded-md border border-white/10 bg-black/20 px-2 py-0.5 text-white/45">
                {run ? `Run ${run.runId.slice(0, 8)}` : "Run unmapped"}
              </span>
            </div>
            <h2 id={`reject-teach-title-${escalation.id}`} className="mt-2 text-lg font-semibold tracking-tight text-white">
              Teach the critic why this frame should not pass.
            </h2>
            <p className="mt-1 max-w-2xl text-[10px] font-mono leading-relaxed text-white/45">
              Stage 1 captures the learning event. Stage 2 applies a reversible soft block or terminal soft-trash state.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-full border border-white/10 bg-black/25 p-2 text-white/50 transition hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Close Reject-as-Teach modal"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3 sm:px-5">
          <div className={`h-1.5 flex-1 rounded-full ${stage === "learning" ? "bg-rose-300" : "bg-emerald-300"}`} />
          <div className={`h-1.5 flex-1 rounded-full ${stage === "block" ? "bg-rose-300" : "bg-white/10"}`} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          {error && (
            <div className="mb-4 flex items-start rounded-2xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[10px] font-mono leading-relaxed text-red-100">
              <AlertTriangle size={13} className="mr-2 mt-0.5 shrink-0" /> {error}
            </div>
          )}

          {stage === "learning" ? (
            <div data-testid="reject-teach-stage1" className="grid gap-4">
              <label className="block">
                <span className="text-[8px] font-mono font-black uppercase tracking-widest text-rose-100/70">
                  Category · required
                </span>
                <select
                  data-testid="reject-teach-category"
                  value={categoryId}
                  onChange={(event) => setCategoryId(event.target.value)}
                  disabled={categoriesLoading}
                  className="mt-2 w-full rounded-2xl border border-white/10 bg-black/45 px-3 py-3 text-[11px] font-mono text-white/80 outline-none transition focus:border-rose-300/45 focus:ring-2 focus:ring-rose-300/15 disabled:opacity-50"
                >
                  <option value="">{categoriesLoading ? "Loading categories..." : "Choose a rejection category"}</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="block">
                  <span className="text-[8px] font-mono font-black uppercase tracking-widest text-rose-100/70">
                    What went wrong specifically? · required
                  </span>
                  <textarea
                    data-testid="reject-teach-what-wrong"
                    rows={7}
                    value={whatWrong}
                    onChange={(event) => setWhatWrong(event.target.value)}
                    placeholder="Name the visible failure, not just the score. Example: hero mech reintroduced after the campaign moved to human aftermath."
                    className="mt-2 w-full resize-y rounded-2xl border border-white/10 bg-black/45 p-3 text-[11px] font-mono leading-relaxed text-white/80 outline-none transition placeholder:text-white/25 focus:border-rose-300/45 focus:ring-2 focus:ring-rose-300/15"
                  />
                  <span className="mt-1 block text-[8px] font-mono text-white/30">{whatWrong.trim().length}/10 min</span>
                </label>

                <label className="block">
                  <span className="text-[8px] font-mono font-black uppercase tracking-widest text-rose-100/70">
                    Corrective adjustment · required
                  </span>
                  <textarea
                    data-testid="reject-teach-correction"
                    rows={7}
                    value={correction}
                    onChange={(event) => setCorrection(event.target.value)}
                    placeholder="Teach the next prompt what to do instead. Example: keep framing intimate, grounded, and free of heroic mech silhouettes."
                    className="mt-2 w-full resize-y rounded-2xl border border-white/10 bg-black/45 p-3 text-[11px] font-mono leading-relaxed text-white/80 outline-none transition placeholder:text-white/25 focus:border-rose-300/45 focus:ring-2 focus:ring-rose-300/15"
                  />
                  <span className="mt-1 block text-[8px] font-mono text-white/30">{correction.trim().length}/10 min</span>
                </label>
              </div>

              <label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-white/14 bg-white/[0.025] px-4 py-5 text-center transition hover:border-rose-300/35 hover:bg-rose-500/[0.06]">
                <Upload size={18} className="mb-2 text-rose-100/70" />
                <span className="text-[9px] font-mono font-black uppercase tracking-widest text-white/55">
                  {refImageName ? refImageName : "Optional PNG reference image"}
                </span>
                <span className="mt-1 max-w-md text-[9px] font-mono leading-relaxed text-white/30">
                  Drag/drop or browse. Server stores as client_id/run_id/learning/event_id.png and returns a signed URL.
                </span>
                <input
                  type="file"
                  accept="image/png"
                  className="sr-only"
                  onChange={(event) => void chooseRefImage(event.target.files?.[0])}
                />
              </label>
            </div>
          ) : (
            <div data-testid="reject-teach-stage2" className="grid gap-4">
              <div className="rounded-2xl border border-emerald-300/25 bg-emerald-400/10 px-4 py-3">
                <div className="flex items-center text-[10px] font-mono font-black uppercase tracking-widest text-emerald-100">
                  <BookOpenCheck size={14} className="mr-2" /> ✓ Learning captured.
                </div>
                <p className="mt-2 text-[10px] font-mono leading-relaxed text-white/48">
                  Category, issue, correction, and optional reference are locked for this submission. Choose how the rejected asset should be blocked.
                </p>
              </div>

              <fieldset className="grid gap-3 sm:grid-cols-2">
                {[
                  {
                    value: "soft" as const,
                    label: "Soft-block",
                    body: "Default. Keeps the asset queryable and makes an un-reject path possible later.",
                  },
                  {
                    value: "terminal" as const,
                    label: "Terminal",
                    body: "Moves the asset into the rejected terminal soft-trash state for this escalation.",
                  },
                ].map((option) => (
                  <label
                    key={option.value}
                    className={`cursor-pointer rounded-2xl border p-4 transition ${
                      blockMode === option.value
                        ? "border-rose-300/55 bg-rose-400/14 shadow-[0_0_24px_rgba(251,113,133,0.12)]"
                        : "border-white/10 bg-white/[0.025] hover:border-white/20"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-mono font-black uppercase tracking-widest text-white/78">
                        {option.label}
                      </span>
                      <input
                        data-testid={`reject-teach-${option.value}`}
                        type="radio"
                        name={`reject-block-${escalation.id}`}
                        value={option.value}
                        checked={blockMode === option.value}
                        onChange={() => setBlockMode(option.value)}
                        className="accent-rose-300"
                      />
                    </div>
                    <p className="mt-2 text-[10px] font-mono leading-relaxed text-white/42">{option.body}</p>
                  </label>
                ))}
              </fieldset>

              <button
                type="button"
                onClick={() => setStage("learning")}
                disabled={submitting}
                className="w-fit rounded-xl border border-white/10 px-3 py-2 text-[8px] font-mono font-bold uppercase tracking-widest text-white/42 transition hover:border-white/25 hover:text-white/70 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Back to learning fields
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-black/30 px-4 py-3 sm:px-5">
          <p className="max-w-md text-[8px] font-mono uppercase tracking-widest text-white/28">
            {stage === "learning" ? "Stage 2 remains locked until required learning fields pass validation." : `Apply writes status=rejected_${blockMode}.`}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-xl border border-white/10 px-3 py-2 text-[8px] font-mono font-bold uppercase tracking-widest text-white/45 transition hover:border-white/25 hover:text-white/75 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Cancel
            </button>
            {stage === "learning" ? (
              <button
                data-testid="reject-teach-capture"
                type="button"
                onClick={captureLearning}
                disabled={!learningValid || categoriesLoading}
                className="inline-flex items-center rounded-xl bg-rose-300 px-3 py-2 text-[8px] font-black uppercase tracking-[0.18em] text-black transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-45"
              >
                Capture Learning <ArrowRight size={12} className="ml-1.5" />
              </button>
            ) : (
              <button
                data-testid="reject-teach-apply"
                type="button"
                onClick={() => void applyBlock()}
                disabled={submitting}
                className="inline-flex items-center rounded-xl bg-rose-300 px-3 py-2 text-[8px] font-black uppercase tracking-[0.18em] text-black transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-45"
              >
                {submitting ? <Loader2 size={12} className="mr-1.5 animate-spin" /> : <ShieldAlert size={12} className="mr-1.5" />}
                Apply Block
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  ), document.body);
}
