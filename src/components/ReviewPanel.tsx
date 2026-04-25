import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Eye,
  Image as ImageIcon,
  FileVideo,
  FileText,
  Package,
  RotateCcw,
  X,
  XCircle,
} from "lucide-react";
import {
  getArtifactsForReview,
  getRejectionCategories,
  getHitlDecisions,
  submitBatchHitlDecisions,
  approveReview,
  getCampaignDeliverables,
  type Artifact,
  type RejectionCategory,
  type HitlDecision,
  type HitlDecisionType,
  type CampaignDeliverable,
} from "../api";
import noiseTexture from "../assets/noise.svg";
import FinalHITLPanel from "./FinalHITLPanel";

// -- Overlay (matches HUD)
const OverlayEffects = ({ className = "" }: { className?: string }) => (
  <div className={`absolute inset-0 pointer-events-none overflow-hidden z-10 ${className}`}>
    <div className="absolute inset-0 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.1)_50%),linear-gradient(90deg,rgba(255,0,0,0.02),rgba(0,255,0,0.01),rgba(0,0,255,0.02))] bg-[length:100%_4px,3px_100%]" />
    <div
      className="absolute inset-0 opacity-[0.02] mix-blend-overlay"
      style={{ backgroundImage: `url(${noiseTexture})` }}
    />
    <div className="absolute inset-0 shadow-[inset_0_0_60px_rgba(0,0,0,0.35)]" />
  </div>
);

const TickMarks = ({ count = 40 }: { count?: number }) => (
  <div className="flex justify-between absolute inset-x-0 top-0 h-2">
    {Array.from({ length: count }).map((_, i) => (
      <div
        key={i}
        className={`w-px bg-cyan-400/30 ${i % 5 === 0 ? "h-2" : "h-1"}`}
      />
    ))}
  </div>
);

// -- Types
type ArtifactDecision = {
  decision: HitlDecisionType | null;
  notes: string;
  rejectionCategories: string[];
};

type ArtifactTypeIcon = "image" | "video" | "report" | "package";

const typeIcons: Record<ArtifactTypeIcon, typeof ImageIcon> = {
  image: ImageIcon,
  video: FileVideo,
  report: FileText,
  package: Package,
};

const typeColors: Record<ArtifactTypeIcon, string> = {
  image: "text-cyan-400",
  video: "text-purple-400",
  report: "text-emerald-400",
  package: "text-amber-400",
};

const formatCategoryLabel = (name: string) =>
  name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const formatFileSize = (bytes?: number) => {
  if (!bytes) return "--";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};


function metadataShotNumber(metadata: Record<string, unknown> | undefined): number | null {
  if (!metadata) return null;
  const direct = metadata.shotNumber ?? metadata.shot_number;
  if (typeof direct === "number" && Number.isInteger(direct)) return direct;
  const narrative = metadata.narrative_context;
  if (narrative && typeof narrative === "object") {
    const shot = (narrative as { shot_number?: unknown; shotNumber?: unknown }).shot_number
      ?? (narrative as { shotNumber?: unknown }).shotNumber;
    if (typeof shot === "number" && Number.isInteger(shot)) return shot;
  }
  return null;
}

function shotNumberFromText(value: string | undefined): number | null {
  if (!value) return null;
  const match = /shot[_\s#-]*(\d{1,2})/i.exec(value) ?? /#(\d{1,2})\b/.exec(value);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 30 ? parsed : null;
}

function inferShotNumberFromArtifact(artifact: Artifact | undefined, deliverable?: CampaignDeliverable): number | null {
  if (!artifact) return null;
  return metadataShotNumber(artifact.metadata)
    ?? shotNumberFromText(deliverable?.description)
    ?? shotNumberFromText(artifact.name)
    ?? shotNumberFromText(artifact.storagePath)
    ?? shotNumberFromText(artifact.path);
}

// -- Component
interface ReviewPanelProps {
  runId: string;
  clientName: string;
  initialFinalHitlShotNumber?: number | null;
  onClose: () => void;
  onComplete: () => void;
}

export default function ReviewPanel({ runId, clientName, initialFinalHitlShotNumber = null, onClose, onComplete }: ReviewPanelProps) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [categories, setCategories] = useState<RejectionCategory[]>([]);
  const [existingDecisions, setExistingDecisions] = useState<HitlDecision[]>([]);
  const [decisions, setDecisions] = useState<Map<string, ArtifactDecision>>(new Map());
  const [deliverableMap, setDeliverableMap] = useState<Map<string, CampaignDeliverable>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [expandedArtifact, setExpandedArtifact] = useState<string | null>(null);
  const [selectedFinalHitlShotNumber, setSelectedFinalHitlShotNumber] = useState<number | null>(initialFinalHitlShotNumber);
  const [reloadNonce, setReloadNonce] = useState(0);

  // Load data
  useEffect(() => {
    let cancelled = false;
    setArtifacts([]);
    setCategories([]);
    setExistingDecisions([]);
    setDecisions(new Map());
    setDeliverableMap(new Map());
    setExpandedArtifact(null);
    setSelectedFinalHitlShotNumber(initialFinalHitlShotNumber);
    setIsSubmitting(false);

    async function load() {
      try {
        setIsLoading(true);
        setSubmitError(null);
        const [arts, cats, existing] = await Promise.all([
          getArtifactsForReview(runId),
          getRejectionCategories(),
          getHitlDecisions(runId),
        ]);
        if (cancelled) return;
        setArtifacts(arts);
        setCategories(cats);
        setExistingDecisions(existing);

        // Load deliverable data if any artifacts have deliverableId
        const campaignIds = new Set(
          arts.filter((a) => a.deliverableId).map((a) => a.campaignId).filter(Boolean) as string[]
        );
        if (campaignIds.size > 0) {
          try {
            const allDeliverables = await Promise.all(
              Array.from(campaignIds).map((cId) => getCampaignDeliverables(cId))
            );
            const dMap = new Map<string, CampaignDeliverable>();
            for (const batch of allDeliverables) {
              for (const d of batch) {
                dMap.set(d.id, d);
              }
            }
            if (!cancelled) setDeliverableMap(dMap);
          } catch {
            // Non-fatal — deliverable context is optional
          }
        }

        // Pre-populate decisions map
        const map = new Map<string, ArtifactDecision>();
        for (const art of arts) {
          const prev = existing.find((d) => d.artifactId === art.id);
          map.set(art.id, {
            decision: prev?.decision ?? null,
            notes: prev?.notes ?? "",
            rejectionCategories: prev?.rejectionCategories ?? [],
          });
        }
        if (cancelled) return;
        setDecisions(map);
        if (arts.length > 0) {
          setExpandedArtifact(arts[0].id);
          setSelectedFinalHitlShotNumber((current) => current ?? inferShotNumberFromArtifact(arts[0]));
        }
      } catch {
        if (!cancelled) setSubmitError("Couldn't load review data. Retry.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [initialFinalHitlShotNumber, runId, reloadNonce]);

  const updateDecision = useCallback(
    (artifactId: string, updates: Partial<ArtifactDecision>) => {
      setDecisions((prev) => {
        const next = new Map(prev);
        const current = next.get(artifactId) ?? { decision: null, notes: "", rejectionCategories: [] };
        next.set(artifactId, { ...current, ...updates });
        return next;
      });
    },
    []
  );

  const toggleCategory = useCallback(
    (artifactId: string, categoryName: string) => {
      setDecisions((prev) => {
        const next = new Map(prev);
        const current = next.get(artifactId) ?? { decision: null, notes: "", rejectionCategories: [] };
        const cats = current.rejectionCategories.includes(categoryName)
          ? current.rejectionCategories.filter((c) => c !== categoryName)
          : [...current.rejectionCategories, categoryName];
        next.set(artifactId, { ...current, rejectionCategories: cats });
        return next;
      });
    },
    []
  );

  // Derived state
  const reviewedCount = Array.from(decisions.values()).filter((d) => d.decision !== null).length;
  const approvedCount = Array.from(decisions.values()).filter((d) => d.decision === "approved").length;
  const rejectedCount = Array.from(decisions.values()).filter((d) => d.decision === "rejected").length;
  const revisionCount = Array.from(decisions.values()).filter((d) => d.decision === "needs_revision").length;
  const allReviewed = artifacts.length > 0 && reviewedCount === artifacts.length;
  const alreadyDecided = useMemo(
    () => new Set(existingDecisions.map((d) => d.artifactId)),
    [existingDecisions]
  );


  useEffect(() => {
    if (typeof initialFinalHitlShotNumber === "number") {
      setSelectedFinalHitlShotNumber(initialFinalHitlShotNumber);
    }
  }, [initialFinalHitlShotNumber]);

  useEffect(() => {
    if (!expandedArtifact) return;
    if (typeof initialFinalHitlShotNumber === "number" && selectedFinalHitlShotNumber === initialFinalHitlShotNumber) return;
    const artifact = artifacts.find((item) => item.id === expandedArtifact);
    const deliverable = artifact?.deliverableId ? deliverableMap.get(artifact.deliverableId) : undefined;
    const inferred = inferShotNumberFromArtifact(artifact, deliverable);
    if (inferred) setSelectedFinalHitlShotNumber(inferred);
  }, [artifacts, deliverableMap, expandedArtifact, initialFinalHitlShotNumber, selectedFinalHitlShotNumber]);

  const handleSubmit = useCallback(async () => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      // Only submit new/changed decisions (skip already-submitted ones)
      const batch = Array.from(decisions.entries())
        .filter(([artifactId, d]) => d.decision !== null && !alreadyDecided.has(artifactId))
        .map(([artifactId, d]) => ({
          artifactId,
          decision: d.decision!,
          notes: d.notes || undefined,
          rejectionCategories: d.rejectionCategories.length > 0 ? d.rejectionCategories : undefined,
        }));

      if (batch.length > 0) {
        await submitBatchHitlDecisions(runId, batch);
      }

      // Resume the run if all approved
      const hasRejections = Array.from(decisions.values()).some(
        (d) => d.decision === "rejected" || d.decision === "needs_revision"
      );
      if (!hasRejections) {
        await approveReview(runId);
      }

      onComplete();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Submit failed");
    } finally {
      setIsSubmitting(false);
    }
  }, [decisions, alreadyDecided, runId, onComplete]);

  // Bulk actions
  const handleApproveAll = useCallback(() => {
    setDecisions((prev) => {
      const next = new Map(prev);
      for (const [id] of next) {
        const current = next.get(id)!;
        next.set(id, { ...current, decision: "approved", rejectionCategories: [] });
      }
      return next;
    });
  }, []);

  const handleResetAll = useCallback(() => {
    setDecisions((prev) => {
      const next = new Map(prev);
      for (const [id] of next) {
        next.set(id, { decision: null, notes: "", rejectionCategories: [] });
      }
      return next;
    });
  }, []);

  return (
    <div className="fixed inset-0 z-[700] flex items-center justify-center p-4 bg-black/70 backdrop-blur-xl fade-zoom-in">
      <div className="w-full max-w-6xl max-h-[92vh] bg-[#0a0c10] border border-cyan-500/30 rounded-[3rem] shadow-[0_0_100px_rgba(0,0,0,0.8)] relative overflow-hidden flex flex-col">
        <TickMarks count={60} />

        {/* Header */}
        <div className="flex justify-between items-center px-10 pt-10 pb-6 border-b border-white/10 relative z-20 shrink-0">
          <div className="flex items-center">
            <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center mr-4 border border-amber-500/40">
              <Eye className="text-amber-400" size={18} />
            </div>
            <div>
              <h2 className="text-lg font-bold tracking-[0.3em] text-white uppercase">
                HITL Review
              </h2>
              <p className="text-[9px] font-mono text-amber-400/60 uppercase tracking-[0.2em]">
                {clientName} — {artifacts.length} artifact{artifacts.length !== 1 ? "s" : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <span className="text-[8px] font-mono text-white/30 uppercase tracking-wider">
              Run {runId.slice(0, 8)}
            </span>
            <X
              onClick={onClose}
              size={18}
              className="cursor-pointer text-white/20 hover:text-white transition-colors"
            />
          </div>
        </div>

        {/* Summary Bar */}
        <div className="px-10 py-3 border-b border-white/5 flex items-center justify-between relative z-20 shrink-0">
          <div className="flex items-center space-x-4 text-[9px] font-mono uppercase tracking-wider">
            <span className="text-white/30">
              Reviewed: <span className="text-white">{reviewedCount}/{artifacts.length}</span>
            </span>
            {approvedCount > 0 && (
              <span className="text-cyan-400 flex items-center">
                <CheckCircle2 size={10} className="mr-1" /> {approvedCount}
              </span>
            )}
            {rejectedCount > 0 && (
              <span className="text-red-400 flex items-center">
                <XCircle size={10} className="mr-1" /> {rejectedCount}
              </span>
            )}
            {revisionCount > 0 && (
              <span className="text-amber-400 flex items-center">
                <AlertTriangle size={10} className="mr-1" /> {revisionCount}
              </span>
            )}
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={handleApproveAll}
              className="px-3 py-1.5 text-[8px] font-mono uppercase tracking-wider text-cyan-400/60 border border-cyan-500/20 rounded-lg hover:bg-cyan-500/10 hover:text-cyan-400 hover:border-cyan-500/40 transition-all"
            >
              Approve All
            </button>
            <button
              onClick={handleResetAll}
              className="px-3 py-1.5 text-[8px] font-mono uppercase tracking-wider text-white/30 border border-white/10 rounded-lg hover:bg-white/5 hover:text-white/60 transition-all"
            >
              <RotateCcw size={10} className="inline mr-1" />
              Reset
            </button>
          </div>
        </div>

        {/* Scrollable Artifact List */}
        <div className="flex-1 overflow-y-auto px-10 py-6 space-y-5 relative z-20 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
          <FinalHITLPanel
            selectedShotNumber={selectedFinalHitlShotNumber}
            onShotChange={setSelectedFinalHitlShotNumber}
          />

          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="w-8 h-8 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
              <span className="mt-4 text-[10px] font-mono text-white/30 uppercase tracking-widest">
                Loading Review Queue
              </span>
            </div>
          ) : submitError && artifacts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <AlertTriangle size={32} className="text-red-400/35 mb-4" />
              <span className="text-[10px] font-mono text-red-300/70 uppercase tracking-widest">
                Couldn't load review queue
              </span>
              <button
                type="button"
                onClick={() => setReloadNonce((value) => value + 1)}
                className="mt-4 rounded-xl border border-cyan-500/25 px-4 py-2 text-[9px] font-mono uppercase tracking-wider text-cyan-300 hover:bg-cyan-500/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/40"
              >
                Retry
              </button>
            </div>
          ) : artifacts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Package size={32} className="text-white/10 mb-4" />
              <span className="text-[10px] font-mono text-white/30 uppercase tracking-widest">
                No items in the review queue
              </span>
              <p className="text-[9px] font-mono text-white/20 mt-2">
                Pipeline artifacts will appear here when a run needs review
              </p>
            </div>
          ) : (
            artifacts.map((artifact) => {
              const d = decisions.get(artifact.id) ?? { decision: null, notes: "", rejectionCategories: [] };
              const isExpanded = expandedArtifact === artifact.id;
              const IconComponent = typeIcons[artifact.type as ArtifactTypeIcon] ?? Package;
              const iconColor = typeColors[artifact.type as ArtifactTypeIcon] ?? "text-white/40";
              const wasAlreadyDecided = alreadyDecided.has(artifact.id);

              return (
                <div
                  key={artifact.id}
                  className={`rounded-2xl border transition-all duration-300 overflow-hidden ${
                    d.decision === "approved"
                      ? "bg-cyan-500/5 border-cyan-500/20"
                      : d.decision === "rejected"
                        ? "bg-red-500/5 border-red-500/20"
                        : d.decision === "needs_revision"
                          ? "bg-amber-500/5 border-amber-500/20"
                          : "bg-white/[0.02] border-white/5 hover:border-white/10"
                  }`}
                >
                  {/* Deliverable context badge */}
                  {artifact.deliverableId && deliverableMap.has(artifact.deliverableId) && (() => {
                    const del = deliverableMap.get(artifact.deliverableId!)!;
                    const statusColor =
                      del.status === "approved" ? "text-emerald-400 border-emerald-500/30" :
                      del.status === "rejected" ? "text-red-400 border-red-500/30" :
                      del.status === "reviewing" ? "text-amber-400 border-amber-500/30" :
                      del.status === "generating" ? "text-cyan-400 border-cyan-500/30" :
                      "text-white/30 border-white/10";
                    return (
                      <div className="px-4 pt-3 pb-1 flex items-center space-x-2">
                        <span className="text-[8px] font-mono text-white/40 uppercase tracking-wider">
                          Deliverable:
                        </span>
                        <span className="text-[8px] font-mono text-white/60 truncate max-w-[200px]">
                          {del.description || del.id.slice(0, 8)}
                        </span>
                        <span className={`text-[7px] font-mono uppercase px-1.5 py-0.5 rounded border ${statusColor}`}>
                          {del.status}
                        </span>
                      </div>
                    );
                  })()}

                  {/* Artifact Header */}
                  <button
                    onClick={() => {
                      setExpandedArtifact(isExpanded ? null : artifact.id);
                      const inferred = inferShotNumberFromArtifact(artifact, artifact.deliverableId ? deliverableMap.get(artifact.deliverableId) : undefined);
                      if (inferred) setSelectedFinalHitlShotNumber(inferred);
                    }}
                    className="w-full flex items-center justify-between p-4 text-left"
                  >
                    <div className="flex items-center space-x-3 min-w-0">
                      <div className={`w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center shrink-0 ${iconColor}`}>
                        <IconComponent size={14} />
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-mono text-white truncate">{artifact.name}</p>
                        <p className="text-[8px] font-mono text-white/30 uppercase tracking-wider">
                          {artifact.type} — {formatFileSize(artifact.size)} — {new Date(artifact.createdAt).toLocaleTimeString("en-US", { hour12: false })}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center space-x-2 shrink-0 ml-3">
                      {wasAlreadyDecided && (
                        <span className="text-[7px] font-mono text-white/20 uppercase px-1.5 py-0.5 border border-white/10 rounded">
                          Prev
                        </span>
                      )}
                      {d.decision && (
                        <span
                          className={`text-[8px] font-mono uppercase px-2 py-1 rounded-lg border ${
                            d.decision === "approved"
                              ? "text-cyan-400 border-cyan-500/30 bg-cyan-500/10"
                              : d.decision === "rejected"
                                ? "text-red-400 border-red-500/30 bg-red-500/10"
                                : "text-amber-400 border-amber-500/30 bg-amber-500/10"
                          }`}
                        >
                          {d.decision === "needs_revision" ? "Revision" : d.decision}
                        </span>
                      )}
                      <ChevronRight
                        size={14}
                        className={`text-white/20 transition-transform duration-200 ${isExpanded ? "rotate-90" : ""}`}
                      />
                    </div>
                  </button>

                  {/* Artifact Preview */}
                  {isExpanded && artifact.path.startsWith("http") && (
                    <div className="px-4 pt-3">
                      {artifact.type === "image" ? (
                        <img
                          src={artifact.path}
                          alt={artifact.name}
                          className="w-full max-h-64 object-contain rounded-lg border border-white/10 bg-black/30"
                          loading="lazy"
                        />
                      ) : artifact.type === "video" ? (
                        <video
                          src={artifact.path}
                          controls
                          className="w-full max-h-64 rounded-lg border border-white/10 bg-black/30"
                          preload="metadata"
                        />
                      ) : null}
                      {artifact.metadata && typeof (artifact.metadata as Record<string, unknown>).prompt === "string" && (
                        <p className="mt-2 text-[9px] font-mono text-white/30 leading-relaxed line-clamp-2">
                          Prompt: {(artifact.metadata as Record<string, string>).prompt}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Expanded Review Controls */}
                  {isExpanded && (
                    <div className="px-4 pb-4 space-y-4 border-t border-white/5">
                      {/* Decision Buttons */}
                      <div className="flex space-x-2 pt-4">
                        <button
                          onClick={() => updateDecision(artifact.id, { decision: "approved", rejectionCategories: [] })}
                          className={`flex-1 py-2.5 rounded-xl text-[10px] font-mono font-bold uppercase tracking-wider flex items-center justify-center transition-all active:scale-95 ${
                            d.decision === "approved"
                              ? "bg-cyan-500/20 text-cyan-400 border border-cyan-400 shadow-[0_0_15px_rgba(34,211,238,0.2)]"
                              : "bg-white/5 text-white/40 border border-white/10 hover:bg-cyan-500/10 hover:text-cyan-400 hover:border-cyan-500/30"
                          }`}
                        >
                          <Check size={12} className="mr-1.5" /> Approve
                        </button>
                        <button
                          onClick={() => updateDecision(artifact.id, { decision: "needs_revision" })}
                          className={`flex-1 py-2.5 rounded-xl text-[10px] font-mono font-bold uppercase tracking-wider flex items-center justify-center transition-all active:scale-95 ${
                            d.decision === "needs_revision"
                              ? "bg-amber-500/20 text-amber-400 border border-amber-400 shadow-[0_0_15px_rgba(245,158,11,0.2)]"
                              : "bg-white/5 text-white/40 border border-white/10 hover:bg-amber-500/10 hover:text-amber-400 hover:border-amber-500/30"
                          }`}
                        >
                          <AlertTriangle size={12} className="mr-1.5" /> Revise
                        </button>
                        <button
                          onClick={() => updateDecision(artifact.id, { decision: "rejected" })}
                          className={`flex-1 py-2.5 rounded-xl text-[10px] font-mono font-bold uppercase tracking-wider flex items-center justify-center transition-all active:scale-95 ${
                            d.decision === "rejected"
                              ? "bg-red-500/20 text-red-400 border border-red-400 shadow-[0_0_15px_rgba(239,68,68,0.2)]"
                              : "bg-white/5 text-white/40 border border-white/10 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/30"
                          }`}
                        >
                          <X size={12} className="mr-1.5" /> Reject
                        </button>
                      </div>

                      {/* Rejection Categories (show when rejected or needs_revision) */}
                      {(d.decision === "rejected" || d.decision === "needs_revision") && (
                        <div className="space-y-2">
                          <span className="text-[8px] font-mono text-white/30 uppercase tracking-widest">
                            Rejection Categories
                          </span>
                          <div className="flex flex-wrap gap-1.5">
                            {categories.map((cat) => {
                              const isSelected = d.rejectionCategories.includes(cat.name);
                              return (
                                <button
                                  key={cat.id}
                                  onClick={() => toggleCategory(artifact.id, cat.name)}
                                  title={cat.description ?? cat.name}
                                  className={`px-2.5 py-1.5 rounded-lg text-[8px] font-mono uppercase tracking-wider transition-all ${
                                    isSelected
                                      ? d.decision === "rejected"
                                        ? "bg-red-500/20 text-red-400 border border-red-500/40"
                                        : "bg-amber-500/20 text-amber-400 border border-amber-500/40"
                                      : "bg-white/5 text-white/30 border border-white/10 hover:bg-white/10 hover:text-white/50"
                                  }`}
                                >
                                  {formatCategoryLabel(cat.name)}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Notes */}
                      {d.decision !== null && d.decision !== "approved" && (
                        <div className="space-y-2">
                          <span className="text-[8px] font-mono text-white/30 uppercase tracking-widest">
                            Notes
                          </span>
                          <textarea
                            value={d.notes}
                            onChange={(e) => updateDecision(artifact.id, { notes: e.target.value })}
                            placeholder="Optional feedback for prompt evolution..."
                            rows={2}
                            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-[10px] font-mono text-white/80 placeholder:text-white/20 outline-none focus:border-cyan-500/40 transition-colors resize-none"
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-10 py-6 border-t border-white/10 relative z-20 shrink-0">
          {submitError && (
            <div className="mb-3 p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-[10px] font-mono text-red-400 flex items-center">
              <AlertTriangle size={12} className="mr-2 shrink-0" />
              {submitError}
            </div>
          )}

          <div className="flex items-center justify-between">
            <div className="text-[9px] font-mono text-white/20 uppercase tracking-wider">
              {allReviewed
                ? rejectedCount > 0 || revisionCount > 0
                  ? "Rejections will feed prompt evolution"
                  : "All approved — run will resume"
                : `${artifacts.length - reviewedCount} artifact${artifacts.length - reviewedCount !== 1 ? "s" : ""} pending review`
              }
            </div>
            <button
              onClick={handleSubmit}
              disabled={!allReviewed || isSubmitting}
              className={`px-8 py-3 font-black uppercase text-xs rounded-2xl transition-all active:scale-95 flex items-center justify-center ${
                allReviewed && !isSubmitting
                  ? "bg-white text-black shadow-[0_0_30px_rgba(255,255,255,0.1)] hover:bg-cyan-400"
                  : "bg-white/10 text-white/30 cursor-not-allowed"
              }`}
            >
              {isSubmitting ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-black/30 border-t-black rounded-full animate-spin mr-2" />
                  Submitting
                </>
              ) : (
                <>
                  <CheckCircle2 size={14} className="mr-2" />
                  Submit Review
                </>
              )}
            </button>
          </div>
        </div>

        <OverlayEffects className="rounded-[3rem]" />
      </div>
    </div>
  );
}
