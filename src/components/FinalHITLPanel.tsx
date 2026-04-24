import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Loader2,
  PencilLine,
  Play,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  getProductionShots,
  getProductionVideoUrl,
  patchProductionShot,
  promoteProductionShot,
  regenerateProductionShot,
  rejectProductionShot,
  subscribeToProductionEvents,
  type ProductionEvent,
  type ProductionShotPatch,
  type ProductionShotState,
  type ProductionSlug,
} from "../api";

interface FinalHITLPanelProps {
  productionSlug?: ProductionSlug;
  selectedShotNumber?: number | null;
  onShotChange?: (shotNumber: number) => void;
}

type FinalHITLForm = {
  visualIntent: string;
  beat: string;
  durationS: string;
  charactersNeeded: string[];
  stillPrompt: string;
  veoPrompt: string;
};

type LogLine = {
  id: string;
  stream: "stdout" | "stderr";
  line: string;
};

function formFromShot(shot: ProductionShotState): FinalHITLForm {
  return {
    visualIntent: shot.visualIntent,
    beat: shot.beat,
    durationS: String(shot.durationS),
    charactersNeeded: shot.charactersNeeded,
    stillPrompt: shot.stillPrompt ?? "",
    veoPrompt: shot.defaultPrompt,
  };
}

function formatBeat(beat: string): string {
  return beat ? beat.replace(/_/g, " ") : "unmapped";
}

function formatTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function eventShotNumber(event: ProductionEvent): number | null {
  const value = (event as { shotNumber?: unknown }).shotNumber;
  return typeof value === "number" ? value : null;
}

function sameForm(a: FinalHITLForm, b: FinalHITLForm): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export default function FinalHITLPanel({
  productionSlug = "drift-mv",
  selectedShotNumber,
  onShotChange,
}: FinalHITLPanelProps) {
  const [shots, setShots] = useState<ProductionShotState[]>([]);
  const [localShotNumber, setLocalShotNumber] = useState<number | null>(selectedShotNumber ?? null);
  const [form, setForm] = useState<FinalHITLForm | null>(null);
  const [characterDraft, setCharacterDraft] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);

  const loadShots = useCallback(async () => {
    try {
      setError(null);
      const response = await getProductionShots(productionSlug);
      setShots(response.shots);
      setLocalShotNumber((current) => current ?? selectedShotNumber ?? response.shots[0]?.shotNumber ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load Final HITL shot data.");
    } finally {
      setIsLoading(false);
    }
  }, [productionSlug, selectedShotNumber]);

  useEffect(() => {
    setIsLoading(true);
    void loadShots();
  }, [loadShots]);

  useEffect(() => {
    if (typeof selectedShotNumber === "number") {
      setLocalShotNumber(selectedShotNumber);
    }
  }, [selectedShotNumber]);

  const selectedShot = useMemo(
    () => shots.find((shot) => shot.shotNumber === localShotNumber) ?? null,
    [localShotNumber, shots],
  );

  useEffect(() => {
    if (!selectedShot) return;
    setForm(formFromShot(selectedShot));
    setCharacterDraft("");
    setMessage(null);
    setError(null);
    setLogs([]);
    setIsRegenerating(Boolean(selectedShot.activeJob?.status === "running"));
  }, [selectedShot?.shotNumber, selectedShot?.canonical.mtime, selectedShot?.pending?.mtime, selectedShot?.activeJob?.jobId]);

  useEffect(() => {
    if (!selectedShot) return;
    const unsubscribe = subscribeToProductionEvents(
      productionSlug,
      (event) => {
        if (eventShotNumber(event) !== selectedShot.shotNumber) return;
        if (event.type === "regen_started") {
          setIsRegenerating(true);
          setMessage("Regeneration started from the edited manifest.");
          setLogs([]);
        }
        if (event.type === "regen_log") {
          const typed = event as Extract<ProductionEvent, { type: "regen_log" }>;
          setLogs((prev) => [
            ...prev,
            { id: `${typed.jobId}-${prev.length}-${typed.stream}`, stream: typed.stream, line: typed.line },
          ].slice(-80));
        }
        if (event.type === "regen_complete") {
          const typed = event as Extract<ProductionEvent, { type: "regen_complete" }>;
          setIsRegenerating(false);
          setMessage(typed.exitCode === 0 ? "Regeneration complete. Pending take is ready for review." : null);
          if (typed.exitCode !== 0) setError(typed.error || "Regeneration failed.");
          void loadShots();
        }
        if (event.type === "shot_promoted" || event.type === "shot_rejected" || event.type === "shot_manifest_updated") {
          void loadShots();
        }
      },
      () => {
        // Keep this panel quiet during dev-server restarts; explicit refresh still works.
      },
    );
    return unsubscribe;
  }, [loadShots, productionSlug, selectedShot]);

  const beatOptions = useMemo(
    () => Array.from(new Set(shots.map((shot) => shot.beat).filter(Boolean))).sort(),
    [shots],
  );

  const baselineForm = selectedShot ? formFromShot(selectedShot) : null;
  const dirty = Boolean(form && baselineForm && !sameForm(form, baselineForm));
  const durationValue = Number(form?.durationS ?? selectedShot?.durationS ?? 0);
  const durationDelta = selectedShot && Number.isFinite(durationValue) ? durationValue - selectedShot.durationS : 0;
  const cascadeWarning = selectedShot && Math.abs(durationDelta) > 1
    ? {
        delta: durationDelta,
        affectedShot: shots.find((shot) => shot.shotNumber === selectedShot.shotNumber + 1) ?? null,
      }
    : null;
  const busy = isSaving || isRegenerating || isApproving || isRejecting;

  const patchBody = useCallback((): ProductionShotPatch | null => {
    if (!form) return null;
    const parsedDuration = Number(form.durationS);
    return {
      visualIntent: form.visualIntent,
      beat: form.beat,
      durationS: Number.isFinite(parsedDuration) ? parsedDuration : undefined,
      charactersNeeded: form.charactersNeeded,
      stillPrompt: form.stillPrompt,
      veoPrompt: form.veoPrompt,
    };
  }, [form]);

  const mergeUpdatedShot = useCallback((updated: ProductionShotState) => {
    setShots((prev) => prev.map((shot) => (shot.shotNumber === updated.shotNumber ? updated : shot)));
    setForm(formFromShot(updated));
  }, []);

  const handleSave = async (regenerate: boolean) => {
    if (!selectedShot) return;
    const body = patchBody();
    if (!body) return;
    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await patchProductionShot(productionSlug, selectedShot.shotNumber, body);
      mergeUpdatedShot(result.shot);
      setMessage(result.warning ?? "Manifest edits saved.");
      if (regenerate) {
        setIsRegenerating(true);
        await regenerateProductionShot(productionSlug, selectedShot.shotNumber, { useImageConditioning: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save manifest edits.");
      setIsRegenerating(false);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDiscard = () => {
    if (!selectedShot) return;
    setForm(formFromShot(selectedShot));
    setCharacterDraft("");
    setMessage("Local changes discarded.");
    setError(null);
  };

  const addCharacter = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || !form) return;
    if (form.charactersNeeded.includes(trimmed)) {
      setCharacterDraft("");
      return;
    }
    setForm({ ...form, charactersNeeded: [...form.charactersNeeded, trimmed] });
    setCharacterDraft("");
  };

  const removeCharacter = (value: string) => {
    if (!form) return;
    setForm({ ...form, charactersNeeded: form.charactersNeeded.filter((item) => item !== value) });
  };

  const handleApprove = async () => {
    if (!selectedShot) return;
    setIsApproving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await promoteProductionShot(productionSlug, selectedShot.shotNumber);
      setMessage(result.promoted ? "Pending take promoted to canonical." : "No pending take — current canonical remains approved as-is.");
      await loadShots();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't approve this shot.");
    } finally {
      setIsApproving(false);
    }
  };

  const handleReject = async () => {
    if (!selectedShot) return;
    setIsRejecting(true);
    setError(null);
    setMessage(null);
    try {
      const result = await rejectProductionShot(productionSlug, selectedShot.shotNumber);
      setMessage(result.pendingDeleted ? "Pending take rejected and removed." : "No pending take to reject; canonical left unchanged.");
      await loadShots();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reject this shot.");
    } finally {
      setIsRejecting(false);
    }
  };

  const handleShotSelect = (value: string) => {
    const next = Number(value);
    if (!Number.isFinite(next)) return;
    setLocalShotNumber(next);
    onShotChange?.(next);
  };

  if (isLoading) {
    return (
      <section className="rounded-3xl border border-orange-500/20 bg-orange-500/[0.04] p-5">
        <div className="flex items-center justify-center py-8 text-[9px] font-mono uppercase tracking-widest text-orange-200/50">
          <Loader2 size={14} className="mr-2 animate-spin" /> Loading Final HITL
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-3xl border border-orange-500/25 bg-gradient-to-br from-orange-500/[0.08] via-white/[0.025] to-cyan-500/[0.05] p-5 shadow-[0_0_40px_rgba(237,76,20,0.08)]">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[9px] font-mono uppercase tracking-[0.28em] text-orange-200/80">
            <PencilLine size={12} /> Final HITL Review
          </div>
          <h3 className="mt-1 text-lg font-black uppercase tracking-tight text-white">Change anything before judgment</h3>
          <p className="mt-1 max-w-2xl text-[9px] font-mono leading-relaxed text-white/35">
            Edit manifest fields, save only for batching, or save and immediately regenerate from the edited prompt.
          </p>
        </div>
        <label className="flex items-center gap-2 rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-[8px] font-mono uppercase tracking-widest text-white/35">
          Shot
          <select
            value={localShotNumber ?? ""}
            onChange={(event) => handleShotSelect(event.target.value)}
            className="rounded-lg border border-white/10 bg-black/50 px-2 py-1 text-[10px] text-white outline-none focus:border-cyan-400/40"
          >
            {shots.map((shot) => (
              <option key={shot.shotNumber} value={shot.shotNumber}>
                {String(shot.shotNumber).padStart(2, "0")} · {formatBeat(shot.beat)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div className="mb-3 flex items-center rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[9px] font-mono text-red-200">
          <AlertTriangle size={12} className="mr-2 shrink-0" /> {error}
        </div>
      )}
      {message && (
        <div className={`mb-3 flex items-center rounded-xl border px-3 py-2 text-[9px] font-mono ${message.includes("music sync") || message.includes("cumulativeDurationDelta") ? "border-amber-500/30 bg-amber-500/10 text-amber-100" : "border-cyan-500/25 bg-cyan-500/10 text-cyan-100"}`}>
          <Sparkles size={12} className="mr-2 shrink-0" /> {message}
        </div>
      )}

      {!selectedShot || !form ? (
        <div className="rounded-2xl border border-white/10 bg-black/20 p-6 text-center text-[9px] font-mono uppercase tracking-widest text-white/30">
          No production shot selected
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.05] p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[8px] font-mono uppercase tracking-widest text-emerald-200/75">Current canonical</span>
                <span className="text-[8px] font-mono text-white/35">{formatTime(selectedShot.startS)}–{formatTime(selectedShot.endS)}</span>
              </div>
              <video
                src={getProductionVideoUrl(productionSlug, selectedShot.shotNumber, "canonical")}
                controls
                className="w-full rounded-xl border border-white/10 bg-black/40"
                preload="metadata"
              />
            </div>
            <div className={`rounded-2xl border p-3 ${selectedShot.pending ? "border-amber-500/25 bg-amber-500/[0.06]" : "border-white/10 bg-black/20"}`}>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[8px] font-mono uppercase tracking-widest text-amber-200/75">Most-recent pending</span>
                <span className="text-[8px] font-mono text-white/35">{selectedShot.pending ? "Awaiting judgment" : "No pending take"}</span>
              </div>
              {selectedShot.pending ? (
                <video
                  src={getProductionVideoUrl(productionSlug, selectedShot.shotNumber, "pending")}
                  controls
                  className="w-full rounded-xl border border-white/10 bg-black/40"
                  preload="metadata"
                />
              ) : (
                <div className="flex aspect-video items-center justify-center rounded-xl border border-white/10 bg-white/[0.025] text-[9px] font-mono uppercase tracking-widest text-white/25">
                  Save & Regenerate to create a new pending take
                </div>
              )}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_180px]">
            <label className="space-y-2">
              <span className="text-[8px] font-mono uppercase tracking-widest text-white/35">Visual intent</span>
              <textarea
                value={form.visualIntent}
                rows={4}
                onChange={(event) => setForm({ ...form, visualIntent: event.target.value })}
                className="w-full resize-y rounded-xl border border-white/10 bg-black/35 p-3 text-[10px] font-mono leading-relaxed text-white/75 outline-none transition-colors focus:border-cyan-400/40"
              />
            </label>
            <div className="grid gap-3">
              <label className="space-y-2">
                <span className="text-[8px] font-mono uppercase tracking-widest text-white/35">Beat</span>
                <input
                  list="final-hitl-beats"
                  value={form.beat}
                  onChange={(event) => setForm({ ...form, beat: event.target.value })}
                  className="w-full rounded-xl border border-white/10 bg-black/35 p-3 text-[10px] font-mono text-white/75 outline-none focus:border-cyan-400/40"
                />
                <datalist id="final-hitl-beats">
                  {beatOptions.map((beat) => <option key={beat} value={beat} />)}
                </datalist>
              </label>
              <label className="space-y-2">
                <span className="text-[8px] font-mono uppercase tracking-widest text-white/35">Duration (s)</span>
                <input
                  type="number"
                  min="0.5"
                  max="30"
                  step="0.5"
                  value={form.durationS}
                  onChange={(event) => setForm({ ...form, durationS: event.target.value })}
                  className="w-full rounded-xl border border-white/10 bg-black/35 p-3 text-[10px] font-mono text-white/75 outline-none focus:border-cyan-400/40"
                />
              </label>
            </div>
          </div>

          <div className="space-y-2">
            <span className="text-[8px] font-mono uppercase tracking-widest text-white/35">Characters needed</span>
            <div className="rounded-xl border border-white/10 bg-black/35 p-3">
              <div className="mb-2 flex flex-wrap gap-2">
                {form.charactersNeeded.length === 0 ? (
                  <span className="text-[8px] font-mono uppercase tracking-widest text-white/25">No named characters required</span>
                ) : form.charactersNeeded.map((character) => (
                  <button
                    key={character}
                    type="button"
                    onClick={() => removeCharacter(character)}
                    className="inline-flex items-center rounded-full border border-cyan-500/25 bg-cyan-500/10 px-2 py-1 text-[8px] font-mono text-cyan-100 transition-colors hover:border-red-400/35 hover:bg-red-500/10 hover:text-red-200"
                  >
                    {character} <X size={9} className="ml-1" />
                  </button>
                ))}
              </div>
              <input
                value={characterDraft}
                onChange={(event) => setCharacterDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === ",") {
                    event.preventDefault();
                    addCharacter(characterDraft);
                  }
                }}
                onBlur={() => addCharacter(characterDraft)}
                placeholder="Add character and press Enter"
                className="w-full bg-transparent text-[10px] font-mono text-white/75 outline-none placeholder:text-white/20"
              />
            </div>
          </div>

          <label className="space-y-2 block">
            <span className="text-[8px] font-mono uppercase tracking-widest text-white/35">Still prompt</span>
            <textarea
              value={form.stillPrompt}
              rows={6}
              onChange={(event) => setForm({ ...form, stillPrompt: event.target.value })}
              className="w-full resize-y rounded-xl border border-white/10 bg-black/35 p-3 text-[10px] font-mono leading-relaxed text-white/75 outline-none transition-colors focus:border-cyan-400/40"
            />
          </label>

          <label className="space-y-2 block">
            <span className="text-[8px] font-mono uppercase tracking-widest text-white/35">Veo prompt</span>
            <textarea
              value={form.veoPrompt}
              rows={7}
              onChange={(event) => setForm({ ...form, veoPrompt: event.target.value })}
              className="w-full resize-y rounded-xl border border-white/10 bg-black/35 p-3 text-[10px] font-mono leading-relaxed text-white/75 outline-none transition-colors focus:border-cyan-400/40"
            />
          </label>

          {cascadeWarning && (
            <div className="rounded-2xl border border-amber-500/35 bg-amber-500/10 p-4 text-[10px] font-mono leading-relaxed text-amber-100">
              <div className="mb-1 flex items-center font-bold uppercase tracking-widest">
                <AlertTriangle size={13} className="mr-2" /> Cumulative duration changed by {cascadeWarning.delta > 0 ? "+" : ""}{cascadeWarning.delta.toFixed(1)}s.
              </div>
              {cascadeWarning.affectedShot ? (
                <p>
                  This will shift shot {cascadeWarning.affectedShot.shotNumber} from {formatTime(cascadeWarning.affectedShot.startS)} to {formatTime(cascadeWarning.affectedShot.startS + cascadeWarning.delta)} — music section sync may break. Render the cut to verify before publishing.
                </p>
              ) : (
                <p>This changes the final cut length — music sync may break. Render the cut to verify before publishing.</p>
              )}
            </div>
          )}

          <div className="grid gap-3 xl:grid-cols-[1fr_1fr_1fr]">
            <button
              type="button"
              onClick={() => void handleSave(false)}
              disabled={busy || !dirty}
              className="flex items-center justify-center rounded-2xl border border-orange-500/35 px-4 py-3 text-[9px] font-mono font-bold uppercase tracking-[0.22em] text-orange-200 transition-all hover:bg-orange-500/10 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isSaving ? <Loader2 size={13} className="mr-2 animate-spin" /> : <Save size={13} className="mr-2" />} Save edits only
            </button>
            <button
              type="button"
              onClick={() => void handleSave(true)}
              disabled={busy}
              className="flex items-center justify-center rounded-2xl bg-cyan-400 px-4 py-3 text-[9px] font-black uppercase tracking-[0.22em] text-black transition-all hover:bg-white active:scale-95 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {isRegenerating ? <Loader2 size={13} className="mr-2 animate-spin" /> : <Play size={13} className="mr-2" />} Save & regenerate
            </button>
            <button
              type="button"
              onClick={handleDiscard}
              disabled={busy || !dirty}
              className="flex items-center justify-center rounded-2xl border border-red-500/30 px-4 py-3 text-[9px] font-mono font-bold uppercase tracking-[0.22em] text-red-200 transition-all hover:bg-red-500/10 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RotateCcw size={13} className="mr-2" /> Discard changes
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
            <div className="text-[8px] font-mono uppercase tracking-widest text-white/25">
              <Clock3 size={10} className="mr-1 inline" /> Judgment actions are separate from manifest saves.
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleApprove()}
                disabled={busy}
                className="inline-flex items-center rounded-xl border border-cyan-500/35 bg-cyan-500/10 px-4 py-2.5 text-[9px] font-mono font-bold uppercase tracking-wider text-cyan-100 transition-all hover:bg-cyan-500/20 active:scale-95 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {isApproving ? <Loader2 size={12} className="mr-1.5 animate-spin" /> : <CheckCircle2 size={12} className="mr-1.5" />} Approve current as-is
              </button>
              <button
                type="button"
                onClick={() => void handleReject()}
                disabled={busy}
                title={selectedShot.pending ? "Delete the pending take" : "No pending take; canonical stays unchanged"}
                className="inline-flex items-center rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-2.5 text-[9px] font-mono font-bold uppercase tracking-wider text-red-100 transition-all hover:bg-red-500/20 active:scale-95 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {isRejecting ? <Loader2 size={12} className="mr-1.5 animate-spin" /> : <Trash2 size={12} className="mr-1.5" />} Reject
              </button>
            </div>
          </div>

          {(isRegenerating || logs.length > 0) && (
            <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/[0.04] p-3">
              <div className="mb-2 flex items-center justify-between text-[8px] font-mono uppercase tracking-widest text-cyan-200/70">
                Live regen SSE
                {isRegenerating && <Loader2 size={12} className="animate-spin" />}
              </div>
              <div className="max-h-32 overflow-y-auto rounded-xl border border-white/10 bg-black/45 p-3 text-[9px] font-mono leading-relaxed scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
                {logs.length === 0 ? (
                  <p className="text-white/25">Waiting for generator output…</p>
                ) : logs.map((entry) => (
                  <p key={entry.id} className={entry.stream === "stderr" ? "text-amber-200/80" : "text-cyan-100/75"}>
                    <span className="mr-2 text-white/25">{entry.stream}</span>{entry.line}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
