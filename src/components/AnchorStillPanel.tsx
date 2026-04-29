import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Copy,
  ImageIcon,
  Loader2,
  Maximize2,
  RefreshCw,
  ShieldX,
  Upload,
  X,
} from "lucide-react";
import {
  approveProductionShotStill,
  getProductionAnchorUrl,
  getProductionManagedStillUrl,
  getProductionShotStills,
  getProductionShots,
  getProductionVideoUrl,
  rejectProductionShotStill,
  replaceProductionShotStill,
  snapshotProductionShotStill,
  subscribeToCampaignDeliverables,
  subscribeToProductionEvents,
  type ProductionEvent,
  type ProductionFileMeta,
  type ProductionShotState,
  type ProductionShotStillCatalogItem,
  type ProductionSlug,
} from "../api";

interface AnchorStillPanelProps {
  productionSlug?: ProductionSlug;
  shotNumber: number;
  campaignId?: string;
}

type LightboxState = {
  title: string;
  url: string;
} | null;

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "0 B";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
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

function formatTimeStamp(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function labelizeAnchor(name: string): string {
  const replacements: Record<string, string> = {
    brandy: "Brandy",
    mech_openai: "OpenAI Mech",
    mech_claude: "Claude Mech",
    mech_gemini: "Gemini Mech",
    mech_grok: "Grok Mech",
    rapper_1: "Rapper 1",
    rapper_2: "Rapper 2",
  };
  return replacements[name] ?? name.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function FileMetaLine({ label, meta }: { label: string; meta?: ProductionFileMeta | null }) {
  return (
    <div className="mt-2 flex items-center justify-between gap-3 text-[8px] font-mono uppercase tracking-wider text-white/30">
      <span>{label}</span>
      <span className="text-right text-white/45">{formatDate(meta?.mtime)} · {formatBytes(meta?.sizeBytes)}</span>
    </div>
  );
}

function StillFrame({
  src,
  label,
  meta,
  onOpen,
  compact = false,
}: {
  src: string;
  label: string;
  meta?: ProductionFileMeta | null;
  onOpen: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group w-full text-left focus:outline-none focus:ring-2 focus:ring-cyan-400/50 rounded-2xl"
    >
      <div className={`relative overflow-hidden rounded-2xl border border-white/10 bg-black/45 ${compact ? "aspect-video" : "aspect-[16/9]"}`}>
        <img
          src={src}
          alt={label}
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.025]"
        />
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/80 via-black/35 to-transparent px-3 py-2">
          <span className="text-[8px] font-mono uppercase tracking-[0.24em] text-white/65">{label}</span>
          <Maximize2 size={13} className="text-cyan-200/70" />
        </div>
      </div>
      <FileMetaLine label="Still file" meta={meta} />
    </button>
  );
}

export function EmptyAnchorState() {
  return (
    <div className="mt-4 flex min-h-[560px] flex-col items-center justify-center rounded-3xl border border-dashed border-cyan-500/20 bg-[#070a0f]/55 p-6 text-center shadow-[0_0_40px_rgba(0,0,0,0.18)]">
      <div className="rounded-full border border-cyan-500/25 bg-cyan-500/10 p-4 shadow-[0_0_40px_rgba(34,211,238,0.10)]">
        <ImageIcon size={26} className="text-cyan-300/70" />
      </div>
      <p className="mt-4 text-[10px] font-mono uppercase tracking-[0.3em] text-white/45">Select a shot</p>
      <p className="mt-2 max-w-xs text-[9px] leading-relaxed text-white/28">
        Choose a reshoot card to inspect the active starting still, identity anchors, and approve / reject / snapshot controls.
      </p>
    </div>
  );
}

export default function AnchorStillPanel({ productionSlug = "drift-mv", shotNumber, campaignId }: AnchorStillPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const refetchTimerRef = useRef<number | null>(null);
  const badgeTimerRef = useRef<number | null>(null);
  const [still, setStill] = useState<ProductionShotStillCatalogItem | null>(null);
  const [shot, setShot] = useState<ProductionShotState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [startingStillUpdatedAt, setStartingStillUpdatedAt] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"approve" | "reject" | "snapshot" | "replace" | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [snapshotLabel, setSnapshotLabel] = useState("");
  const [lightbox, setLightbox] = useState<LightboxState>(null);
  const [revision, setRevision] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setError(null);
      const [stillResponse, shotResponse] = await Promise.all([
        getProductionShotStills(productionSlug),
        getProductionShots(productionSlug),
      ]);
      setStill(stillResponse.shots.find((item) => item.shot === shotNumber) ?? null);
      setShot(shotResponse.shots.find((item) => item.shotNumber === shotNumber) ?? null);
      setRevision(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load anchor still state.");
    } finally {
      setIsLoading(false);
    }
  }, [productionSlug, shotNumber]);

  const showStartingStillUpdatedBadge = useCallback((timestamp: string) => {
    setStartingStillUpdatedAt(timestamp);
    if (badgeTimerRef.current) window.clearTimeout(badgeTimerRef.current);
    badgeTimerRef.current = window.setTimeout(() => {
      setStartingStillUpdatedAt(null);
      badgeTimerRef.current = null;
    }, 30000);
  }, []);

  const refetchSoon = useCallback((options: { message?: string; startingStillUpdatedAt?: string } = {}) => {
    if (options.message) setActionMessage(options.message);
    if (options.startingStillUpdatedAt) showStartingStillUpdatedBadge(options.startingStillUpdatedAt);
    if (refetchTimerRef.current) window.clearTimeout(refetchTimerRef.current);
    refetchTimerRef.current = window.setTimeout(() => {
      void load();
      refetchTimerRef.current = null;
    }, 300);
  }, [load, showStartingStillUpdatedBadge]);

  useEffect(() => {
    setStill(null);
    setShot(null);
    setIsLoading(true);
    setError(null);
    setActionError(null);
    setActionMessage(null);
    setStartingStillUpdatedAt(null);
    if (badgeTimerRef.current) {
      window.clearTimeout(badgeTimerRef.current);
      badgeTimerRef.current = null;
    }
    setRejectOpen(false);
    setRejectReason("");
    setSnapshotLabel("");
    void load();
  }, [load]);

  useEffect(() => {
    const unsubscribe = subscribeToProductionEvents(
      productionSlug,
      (event: ProductionEvent) => {
        const eventShot = typeof (event as { shotNumber?: unknown }).shotNumber === "number" ? (event as { shotNumber: number }).shotNumber : null;
        if (eventShot !== shotNumber) return;
        if (event.type === "shot_promoted" || event.type === "shot_still_replaced") {
          refetchSoon({ startingStillUpdatedAt: event.timestamp ?? new Date().toISOString() });
          return;
        }
        if (["shot_still_snapshot", "shot_still_approved", "shot_still_rejected", "regen_complete", "shot_rejected"].includes(event.type)) {
          refetchSoon();
        }
      },
      () => {
        // Quiet during local server restarts; manual reload button remains visible on errors.
      },
    );
    return unsubscribe;
  }, [productionSlug, refetchSoon, shotNumber]);

  useEffect(() => {
    const handleLocalStillUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ productionSlug?: string; shotNumber?: number; timestamp?: string }>).detail;
      if (detail?.productionSlug !== productionSlug || detail.shotNumber !== shotNumber) return;
      refetchSoon({ startingStillUpdatedAt: detail.timestamp ?? new Date().toISOString() });
    };
    window.addEventListener("brandstudios:shot-still-updated", handleLocalStillUpdate);
    return () => window.removeEventListener("brandstudios:shot-still-updated", handleLocalStillUpdate);
  }, [productionSlug, refetchSoon, shotNumber]);

  useEffect(() => {
    if (!campaignId) return undefined;
    return subscribeToCampaignDeliverables(campaignId, () => {
      refetchSoon({ message: "Deliverable state synced" });
    });
  }, [campaignId, refetchSoon]);

  useEffect(() => () => {
    if (refetchTimerRef.current) window.clearTimeout(refetchTimerRef.current);
    if (badgeTimerRef.current) window.clearTimeout(badgeTimerRef.current);
  }, []);

  const stillUrl = getProductionManagedStillUrl(productionSlug, shotNumber, revision);
  const canAct = Boolean(still?.currentStillPath) && !busyAction;

  const runAction = async (action: "approve" | "reject" | "snapshot" | "replace", fn: () => Promise<string>) => {
    if (!canAct && action !== "replace") return;
    setBusyAction(action);
    setActionError(null);
    setActionMessage(null);
    try {
      const message = await fn();
      setActionMessage(message);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed. Retry.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleApprove = () => runAction("approve", async () => {
    const result = await approveProductionShotStill(productionSlug, shotNumber);
    return `Approved ${formatDate(result.approvedAt)}`;
  });

  const handleReject = () => runAction("reject", async () => {
    const reason = rejectReason.trim();
    if (!reason) throw new Error("Add a rejection reason first.");
    const result = await rejectProductionShotStill(productionSlug, shotNumber, { reason });
    setRejectOpen(false);
    setRejectReason("");
    return `Rejected: ${result.still_rejection_reason}`;
  });

  const handleSnapshot = () => runAction("snapshot", async () => {
    const result = await snapshotProductionShotStill(productionSlug, shotNumber, {
      label: snapshotLabel.trim() || undefined,
    });
    setSnapshotLabel("");
    return `Snapshot saved: ${result.label}`;
  });

  const handleReplaceClick = () => {
    setActionError(null);
    fileInputRef.current?.click();
  };

  const handleReplaceFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    void runAction("replace", async () => {
      await replaceProductionShotStill(productionSlug, shotNumber, { file });
      return `Replaced from ${file.name}`;
    });
    event.target.value = "";
  };

  if (isLoading) {
    return (
      <div className="mt-4 min-h-[560px] rounded-3xl border border-cyan-500/15 bg-[#070a0f]/75 p-5 animate-pulse">
        <div className="h-4 w-32 rounded bg-white/10" />
        <div className="mt-4 aspect-video rounded-2xl bg-white/[0.06]" />
        <div className="mt-4 grid grid-cols-3 gap-2">
          {Array.from({ length: 3 }).map((_, index) => <div key={index} className="aspect-square rounded-2xl bg-white/[0.05]" />)}
        </div>
      </div>
    );
  }

  return (
    <aside className="mt-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
      <div className="rounded-3xl border border-cyan-500/15 bg-[#070a0f]/85 p-4 shadow-[0_0_50px_rgba(0,0,0,0.25)] backdrop-blur-xl">
        <header className="flex items-start justify-between gap-4 border-b border-white/10 pb-4">
          <div>
            <div className="flex items-center gap-2 text-[8px] font-mono uppercase tracking-[0.32em] text-cyan-300/65">
              <Camera size={12} /> Anchor Still Gate
            </div>
            <h2 className="mt-1 text-xl font-black uppercase tracking-tight text-white">
              Shot #{String(shotNumber).padStart(2, "0")}
            </h2>
            <p className="mt-1 text-[9px] font-mono uppercase tracking-wider text-white/35">
              {shot?.beat?.replace(/_/g, " ") ?? "unmapped"} · {still?.anchorsSource ?? "anchors"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-xl border border-white/10 p-2 text-white/35 transition-all hover:border-cyan-400/40 hover:bg-cyan-500/10 hover:text-cyan-200 focus:outline-none focus:ring-2 focus:ring-cyan-400/50"
            aria-label="Refresh anchor still panel"
          >
            <RefreshCw size={14} />
          </button>
        </header>

        {error && (
          <div className="mt-4 rounded-2xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-[10px] font-mono text-red-200">
            <AlertTriangle size={13} className="mr-2 inline" /> {error}
          </div>
        )}

        {actionError && (
          <div className="mt-4 rounded-2xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-[10px] font-mono text-red-200">
            <AlertTriangle size={13} className="mr-2 inline" /> {actionError}
          </div>
        )}

        {actionMessage && (
          <div className="mt-4 rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-[10px] font-mono uppercase tracking-wider text-emerald-200">
            <CheckCircle2 size={13} className="mr-2 inline" /> {actionMessage}
          </div>
        )}

        {startingStillUpdatedAt && (
          <div className="mt-4 rounded-2xl border border-cyan-400/30 bg-cyan-400/10 px-4 py-3 text-[10px] font-mono uppercase tracking-wider text-cyan-100 shadow-[0_0_26px_rgba(34,211,238,0.10)] transition-opacity duration-500">
            <RefreshCw size={13} className="mr-2 inline" /> Starting still updated {formatTimeStamp(startingStillUpdatedAt)}
          </div>
        )}

        <section className="mt-4">
          {still?.currentStillPath ? (
            <StillFrame
              src={stillUrl}
              label="Current starting still"
              meta={still.currentStill}
              onOpen={() => setLightbox({ title: `Shot ${shotNumber} starting still`, url: stillUrl })}
            />
          ) : (
            <div className="flex aspect-video items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[0.02] text-[9px] font-mono uppercase tracking-widest text-white/25">
              No starting still found
            </div>
          )}
        </section>

        <section className="mt-5 rounded-2xl border border-white/10 bg-white/[0.02] p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-[9px] font-mono uppercase tracking-[0.25em] text-white/55">Identity anchors</h3>
            <span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-0.5 text-[7px] font-mono uppercase tracking-widest text-cyan-200/70">
              {still?.anchors.length ?? 0} refs
            </span>
          </div>
          {still?.anchors.length ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
              {still.anchors.map((anchor) => {
                const url = getProductionAnchorUrl(productionSlug, anchor.name, revision);
                return (
                  <button
                    key={anchor.name}
                    type="button"
                    onClick={() => anchor.exists && setLightbox({ title: labelizeAnchor(anchor.name), url })}
                    disabled={!anchor.exists}
                    className="group overflow-hidden rounded-2xl border border-white/10 bg-black/35 text-left transition-all hover:border-cyan-400/35 hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus:ring-2 focus:ring-cyan-400/50"
                  >
                    <div className="aspect-square overflow-hidden bg-black/40">
                      {anchor.exists ? (
                        <img src={url} alt={`${labelizeAnchor(anchor.name)} anchor`} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-white/18"><ImageIcon size={18} /></div>
                      )}
                    </div>
                    <div className="px-2 py-2">
                      <p className="truncate text-[8px] font-mono uppercase tracking-wider text-white/60">{labelizeAnchor(anchor.name)}</p>
                      <p className="mt-0.5 truncate text-[7px] font-mono uppercase tracking-wider text-white/25">{anchor.exists ? formatBytes(anchor.sizeBytes) : "Missing"}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-white/10 px-3 py-4 text-center text-[9px] font-mono uppercase tracking-widest text-white/25">
              No anchors mapped for this shot
            </p>
          )}
        </section>

        {shot?.pending && (
          <section className="mt-5 rounded-2xl border border-amber-500/20 bg-amber-500/[0.055] p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-[9px] font-mono uppercase tracking-[0.25em] text-amber-200/80">Current vs pending</h3>
              <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[7px] font-mono uppercase tracking-widest text-amber-100/70">Review take</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <StillFrame
                src={stillUrl}
                label="Starting still"
                meta={still?.currentStill}
                compact
                onOpen={() => setLightbox({ title: `Shot ${shotNumber} starting still`, url: stillUrl })}
              />
              <div>
                <div className="overflow-hidden rounded-2xl border border-amber-500/20 bg-black/45">
                  <video
                    src={getProductionVideoUrl(productionSlug, shotNumber, "pending")}
                    controls
                    className="aspect-video w-full bg-black/40 object-cover"
                    preload="metadata"
                  />
                </div>
                <FileMetaLine label="Pending take" meta={shot.pending} />
              </div>
            </div>
          </section>
        )}

        <section className="mt-5 rounded-2xl border border-white/10 bg-black/25 p-3">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={handleApprove}
              disabled={!canAct}
              className="flex items-center justify-center rounded-xl bg-cyan-400 px-3 py-2.5 text-[8px] font-black uppercase tracking-wider text-black transition-all hover:bg-white active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus:ring-2 focus:ring-cyan-300/60"
            >
              {busyAction === "approve" ? <Loader2 size={12} className="mr-1.5 animate-spin" /> : <CheckCircle2 size={12} className="mr-1.5" />}
              Approve
            </button>
            <button
              type="button"
              onClick={() => setRejectOpen(true)}
              disabled={!canAct}
              className="flex items-center justify-center rounded-xl border border-red-500/30 px-3 py-2.5 text-[8px] font-mono font-bold uppercase tracking-wider text-red-300 transition-all hover:bg-red-500/10 active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus:ring-2 focus:ring-red-300/40"
            >
              <ShieldX size={12} className="mr-1.5" /> Reject
            </button>
            <button
              type="button"
              onClick={handleSnapshot}
              disabled={!canAct}
              className="flex items-center justify-center rounded-xl border border-orange-500/30 px-3 py-2.5 text-[8px] font-mono font-bold uppercase tracking-wider text-orange-200 transition-all hover:bg-orange-500/10 active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus:ring-2 focus:ring-orange-300/40"
            >
              {busyAction === "snapshot" ? <Loader2 size={12} className="mr-1.5 animate-spin" /> : <Copy size={12} className="mr-1.5" />}
              Snapshot
            </button>
            <button
              type="button"
              onClick={handleReplaceClick}
              disabled={!still?.currentStillPath || busyAction !== null}
              className="flex items-center justify-center rounded-xl border border-white/15 px-3 py-2.5 text-[8px] font-mono font-bold uppercase tracking-wider text-white/65 transition-all hover:border-cyan-400/35 hover:bg-cyan-500/10 hover:text-cyan-100 active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus:ring-2 focus:ring-cyan-300/40"
            >
              {busyAction === "replace" ? <Loader2 size={12} className="mr-1.5 animate-spin" /> : <Upload size={12} className="mr-1.5" />}
              Replace
            </button>
          </div>
          <label className="mt-3 block text-[8px] font-mono uppercase tracking-widest text-white/30" htmlFor={`snapshot-label-${shotNumber}`}>
            Optional snapshot label
          </label>
          <input
            id={`snapshot-label-${shotNumber}`}
            value={snapshotLabel}
            onChange={(event) => setSnapshotLabel(event.target.value)}
            placeholder="auto iter timestamp"
            className="mt-2 w-full rounded-xl border border-white/10 bg-white/[0.035] px-3 py-2 text-[9px] font-mono text-white/70 outline-none transition-colors placeholder:text-white/18 focus:border-cyan-400/40"
          />
          <input ref={fileInputRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={handleReplaceFile} />
        </section>
      </div>

      {rejectOpen && (
        <div className="fixed inset-0 z-[720] flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setRejectOpen(false);
        }}>
          <div className="w-full max-w-md rounded-3xl border border-red-500/25 bg-[#080b10] p-5 shadow-[0_0_80px_rgba(0,0,0,0.65)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[8px] font-mono uppercase tracking-[0.32em] text-red-300/70">Reject starting still</p>
                <h3 className="mt-1 text-xl font-black uppercase tracking-tight text-white">Shot #{String(shotNumber).padStart(2, "0")}</h3>
              </div>
              <button type="button" onClick={() => setRejectOpen(false)} className="rounded-full border border-white/10 p-2 text-white/35 hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-300 focus:outline-none focus:ring-2 focus:ring-red-300/40">
                <X size={15} />
              </button>
            </div>
            <textarea
              rows={4}
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              placeholder="Reason required — e.g. hand morphing, wrong robot identity, cartoonish render"
              className="mt-4 w-full resize-y rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-[10px] font-mono leading-relaxed text-white/70 outline-none placeholder:text-white/20 focus:border-red-300/45"
            />
            <button
              type="button"
              onClick={handleReject}
              disabled={busyAction !== null || !rejectReason.trim()}
              className="mt-4 flex w-full items-center justify-center rounded-2xl bg-red-500 px-4 py-3 text-[10px] font-black uppercase tracking-[0.25em] text-white transition-all hover:bg-red-400 active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus:ring-2 focus:ring-red-300/50"
            >
              {busyAction === "reject" ? <Loader2 size={14} className="mr-2 animate-spin" /> : <ShieldX size={14} className="mr-2" />}
              Save rejection
            </button>
          </div>
        </div>
      )}

      {lightbox && (
        <div className="fixed inset-0 z-[710] flex items-center justify-center bg-black/85 p-5 backdrop-blur-sm" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setLightbox(null);
        }}>
          <div className="max-h-full w-full max-w-5xl overflow-hidden rounded-3xl border border-cyan-500/20 bg-[#05070a] shadow-[0_0_90px_rgba(0,0,0,0.75)]">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <p className="text-[10px] font-mono uppercase tracking-[0.28em] text-cyan-200/70">{lightbox.title}</p>
              <button type="button" onClick={() => setLightbox(null)} className="rounded-full border border-white/10 p-2 text-white/35 hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-300 focus:outline-none focus:ring-2 focus:ring-cyan-300/40">
                <X size={15} />
              </button>
            </div>
            <div className="max-h-[82vh] overflow-auto p-3">
              <img src={lightbox.url} alt={lightbox.title} className="mx-auto max-h-[78vh] w-auto rounded-2xl object-contain" />
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
