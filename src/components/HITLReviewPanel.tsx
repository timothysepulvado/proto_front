import { useState } from "react";
import {
  X,
  RefreshCw,
  ThumbsUp,
  ThumbsDown,
  MessageSquare,
  BarChart3,
  Loader2,
  History,
  Image as ImageIcon,
  Video,
  FileText,
  AlertCircle,
  Check,
} from "lucide-react";
import type { Artifact, HITLDecision, HITLDecisionType } from "../api";

// Rejection categories with their negative prompts
export const REJECTION_CATEGORIES = [
  { id: "too_dark", label: "Too Dark", negativePrompt: "dark lighting, shadows, underexposed" },
  { id: "too_bright", label: "Too Bright", negativePrompt: "overexposed, washed out, harsh light" },
  { id: "wrong_colors", label: "Wrong Colors", negativePrompt: "neon colors, saturated colors" },
  { id: "off_brand", label: "Off Brand", negativePrompt: "off-brand aesthetic" },
  { id: "wrong_composition", label: "Wrong Composition", negativePrompt: "poor framing, bad crop" },
  { id: "cluttered", label: "Too Cluttered", negativePrompt: "busy background, clutter" },
  { id: "wrong_model", label: "Wrong Model/Person", negativePrompt: "different person" },
  { id: "wrong_outfit", label: "Wrong Outfit", negativePrompt: "wrong clothing" },
  { id: "quality_issue", label: "Quality Issue", negativePrompt: "artifacts, blur, distortion" },
  { id: "other", label: "Other", negativePrompt: "" },
] as const;

export type RejectionCategory = (typeof REJECTION_CATEGORIES)[number]["id"];

interface HITLReviewPanelProps {
  artifact: Artifact;
  previousDecisions?: HITLDecision[];
  onDecision: (
    decision: HITLDecisionType,
    notes?: string,
    rejectionCategories?: RejectionCategory[]
  ) => Promise<void>;
  onClose: () => void;
  deliverableInfo?: {
    retryCount: number;
    maxRetries: number;
    description?: string;
  };
}

const GRADE_THRESHOLDS = {
  AUTO_PASS: { fused: 0.92, label: "Excellent", color: "text-green-400" },
  HITL_REVIEW: { fused: 0.5, label: "Review Needed", color: "text-amber-400" },
  AUTO_FAIL: { fused: 0, label: "Below Standard", color: "text-red-400" },
};

const ScoreBar = ({ label, score, maxScore = 1 }: { label: string; score: number; maxScore?: number }) => {
  const percentage = (score / maxScore) * 100;
  const getColor = () => {
    if (percentage >= 80) return "bg-green-400";
    if (percentage >= 60) return "bg-cyan-400";
    if (percentage >= 40) return "bg-amber-400";
    return "bg-red-400";
  };

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] font-mono">
        <span className="text-white/50 uppercase">{label}</span>
        <span className="text-white">{score.toFixed(3)}</span>
      </div>
      <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${getColor()}`}
          style={{ width: `${Math.min(100, percentage)}%` }}
        />
      </div>
    </div>
  );
};

const ArtifactTypeIcon = ({ type }: { type: Artifact["type"] }) => {
  switch (type) {
    case "image":
      return <ImageIcon size={20} />;
    case "video":
      return <Video size={20} />;
    case "report":
      return <FileText size={20} />;
    default:
      return <FileText size={20} />;
  }
};

export function HITLReviewPanel({
  artifact,
  previousDecisions = [],
  onDecision,
  onClose,
  deliverableInfo,
}: HITLReviewPanelProps) {
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeDecision, setActiveDecision] = useState<HITLDecisionType | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedRejections, setSelectedRejections] = useState<RejectionCategory[]>([]);
  const [customRejectionNote, setCustomRejectionNote] = useState("");

  const grade = artifact.grade;
  const gradeDecision = grade?.decision ?? "HITL_REVIEW";
  const gradeInfo = GRADE_THRESHOLDS[gradeDecision];

  const toggleRejection = (categoryId: RejectionCategory) => {
    if (selectedRejections.includes(categoryId)) {
      setSelectedRejections(selectedRejections.filter((id) => id !== categoryId));
    } else {
      setSelectedRejections([...selectedRejections, categoryId]);
    }
  };

  const handleDecision = async (decision: HITLDecisionType) => {
    setActiveDecision(decision);
    setIsSubmitting(true);
    try {
      const finalNotes =
        decision === "reject" && selectedRejections.includes("other") && customRejectionNote
          ? `${notes}\n[Custom: ${customRejectionNote}]`
          : notes;
      const rejections = decision === "reject" ? selectedRejections : undefined;
      await onDecision(decision, finalNotes.trim() || undefined, rejections);
      onClose();
    } catch {
      setActiveDecision(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[700] flex items-center justify-center p-6 bg-black/70 backdrop-blur-xl">
      <div className="w-full max-w-4xl bg-[#0a0c10] border border-cyan-500/30 rounded-[2rem] overflow-hidden shadow-[0_0_100px_rgba(0,0,0,0.8)] max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex justify-between items-center p-6 border-b border-white/10">
          <div className="flex items-center space-x-4">
            <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center border border-amber-500/40">
              <ArtifactTypeIcon type={artifact.type} />
            </div>
            <div>
              <h2 className="text-lg font-bold tracking-wide text-white">
                Human Review Required
              </h2>
              <div className="flex items-center space-x-2">
                <p className="text-[10px] font-mono text-white/40 uppercase">
                  {artifact.name}
                </p>
                {deliverableInfo && (
                  <span className="px-2 py-0.5 bg-amber-500/20 border border-amber-500/30 rounded text-[8px] font-mono text-amber-400">
                    Retry {deliverableInfo.retryCount}/{deliverableInfo.maxRetries}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <button
              onClick={() => setShowHistory(!showHistory)}
              className={`p-2 rounded-lg border transition-all ${
                showHistory
                  ? "bg-cyan-500/20 border-cyan-500/40 text-cyan-400"
                  : "border-white/10 text-white/40 hover:border-white/20"
              }`}
            >
              <History size={18} />
            </button>
            <button
              onClick={onClose}
              className="p-2 hover:bg-white/10 rounded-lg transition-colors"
            >
              <X className="text-white/40 hover:text-white" size={20} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Preview */}
            <div className="space-y-4">
              <h3 className="text-[10px] font-mono text-white/40 uppercase tracking-widest">
                Artifact Preview
              </h3>
              <div className="aspect-video bg-white/5 border border-white/10 rounded-xl overflow-hidden flex items-center justify-center">
                {artifact.type === "image" ? (
                  artifact.thumbnailUrl ? (
                    <img
                      src={artifact.thumbnailUrl}
                      alt={artifact.name}
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <div className="text-center">
                      <ImageIcon size={48} className="text-white/20 mx-auto mb-2" />
                      <p className="text-[10px] font-mono text-white/30">
                        Preview not available
                      </p>
                      <p className="text-[9px] font-mono text-white/20 mt-1">
                        {artifact.path}
                      </p>
                    </div>
                  )
                ) : artifact.type === "video" ? (
                  <div className="text-center">
                    <Video size={48} className="text-white/20 mx-auto mb-2" />
                    <p className="text-[10px] font-mono text-white/30">
                      Video: {artifact.name}
                    </p>
                  </div>
                ) : (
                  <div className="text-center">
                    <FileText size={48} className="text-white/20 mx-auto mb-2" />
                    <p className="text-[10px] font-mono text-white/30">
                      Report: {artifact.name}
                    </p>
                  </div>
                )}
              </div>

              {/* Deliverable Info */}
              {deliverableInfo?.description && (
                <div className="p-3 rounded-lg bg-white/5 border border-white/10">
                  <span className="text-[9px] font-mono text-white/40 uppercase">
                    Deliverable:
                  </span>
                  <p className="text-xs font-mono text-white mt-1">
                    {deliverableInfo.description}
                  </p>
                </div>
              )}
            </div>

            {/* Scores & Decision */}
            <div className="space-y-6">
              {/* Grade Summary */}
              <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center space-x-2">
                    <BarChart3 size={16} className="text-cyan-400" />
                    <span className="text-xs font-mono text-white/60 uppercase">
                      Brand Alignment Score
                    </span>
                  </div>
                  <span className={`text-xs font-mono font-bold ${gradeInfo.color}`}>
                    {gradeInfo.label}
                  </span>
                </div>

                {grade ? (
                  <div className="space-y-3">
                    <ScoreBar label="CLIP (Visual)" score={grade.clip} />
                    <ScoreBar label="E5 (Semantic)" score={grade.e5} />
                    <ScoreBar label="Cohere (Multimodal)" score={grade.cohere} />
                    <div className="pt-3 border-t border-white/10 mt-3">
                      <ScoreBar label="Fused Score" score={grade.fused} />
                    </div>
                  </div>
                ) : (
                  <p className="text-[10px] font-mono text-white/40 text-center py-4">
                    No grading scores available
                  </p>
                )}
              </div>

              {/* Rejection Categories - Only show when reject is likely */}
              <div className="space-y-2">
                <div className="flex items-center space-x-2">
                  <AlertCircle size={14} className="text-red-400/60" />
                  <span className="text-[10px] font-mono text-white/40 uppercase tracking-widest">
                    Rejection Reasons (select if rejecting)
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {REJECTION_CATEGORIES.map((category) => (
                    <button
                      key={category.id}
                      onClick={() => toggleRejection(category.id)}
                      className={`p-2 rounded-lg border text-left transition-all text-[10px] font-mono flex items-center space-x-2 ${
                        selectedRejections.includes(category.id)
                          ? "bg-red-500/20 border-red-500/40 text-red-400"
                          : "border-white/10 text-white/40 hover:border-white/20"
                      }`}
                    >
                      <div
                        className={`w-4 h-4 rounded border flex items-center justify-center ${
                          selectedRejections.includes(category.id)
                            ? "border-red-400 bg-red-500/20"
                            : "border-white/20"
                        }`}
                      >
                        {selectedRejections.includes(category.id) && (
                          <Check size={10} className="text-red-400" />
                        )}
                      </div>
                      <span>{category.label}</span>
                    </button>
                  ))}
                </div>

                {/* Custom rejection note if "Other" is selected */}
                {selectedRejections.includes("other") && (
                  <input
                    type="text"
                    value={customRejectionNote}
                    onChange={(e) => setCustomRejectionNote(e.target.value)}
                    placeholder="Describe the issue..."
                    className="w-full mt-2 bg-white/5 border border-white/10 p-2 rounded-lg outline-none focus:border-red-400/50 font-mono text-white text-xs placeholder:text-white/20"
                  />
                )}

                {selectedRejections.length > 0 && (
                  <p className="text-[8px] font-mono text-white/20 mt-1">
                    These will be used to modify the prompt for retry.
                  </p>
                )}
              </div>

              {/* Notes */}
              <div className="space-y-2">
                <div className="flex items-center space-x-2">
                  <MessageSquare size={14} className="text-white/40" />
                  <span className="text-[10px] font-mono text-white/40 uppercase tracking-widest">
                    Review Notes
                  </span>
                </div>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Add notes about your decision..."
                  rows={3}
                  className="w-full bg-white/5 border border-white/10 p-3 rounded-xl outline-none focus:border-cyan-400/50 font-mono text-white text-sm resize-none placeholder:text-white/20"
                />
              </div>

              {/* Decision History */}
              {showHistory && previousDecisions.length > 0 && (
                <div className="space-y-2">
                  <span className="text-[10px] font-mono text-white/40 uppercase tracking-widest">
                    Previous Decisions
                  </span>
                  <div className="space-y-2 max-h-32 overflow-y-auto">
                    {previousDecisions.map((decision) => (
                      <div
                        key={decision.id}
                        className="p-3 rounded-lg bg-white/5 border border-white/10 text-[10px] font-mono"
                      >
                        <div className="flex justify-between">
                          <span
                            className={
                              decision.decision === "approve"
                                ? "text-green-400"
                                : decision.decision === "reject"
                                ? "text-red-400"
                                : "text-amber-400"
                            }
                          >
                            {decision.decision.toUpperCase()}
                          </span>
                          <span className="text-white/30">
                            {new Date(decision.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                        {decision.notes && (
                          <p className="text-white/50 mt-1">{decision.notes}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="p-6 border-t border-white/10 bg-black/30">
          <div className="flex space-x-3">
            <button
              onClick={() => handleDecision("reject")}
              disabled={isSubmitting}
              className="flex-1 py-4 bg-red-500/20 border border-red-500/40 text-red-400 font-bold uppercase text-xs rounded-xl hover:bg-red-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2"
            >
              {isSubmitting && activeDecision === "reject" ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <>
                  <ThumbsDown size={16} />
                  <span>Reject{selectedRejections.length > 0 && ` (${selectedRejections.length})`}</span>
                </>
              )}
            </button>
            <button
              onClick={() => handleDecision("changes")}
              disabled={isSubmitting}
              className="flex-1 py-4 bg-amber-500/20 border border-amber-500/40 text-amber-400 font-bold uppercase text-xs rounded-xl hover:bg-amber-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2"
            >
              {isSubmitting && activeDecision === "changes" ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <>
                  <RefreshCw size={16} />
                  <span>Request Changes</span>
                </>
              )}
            </button>
            <button
              onClick={() => handleDecision("approve")}
              disabled={isSubmitting}
              className="flex-1 py-4 bg-green-500/20 border border-green-500/40 text-green-400 font-bold uppercase text-xs rounded-xl hover:bg-green-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2"
            >
              {isSubmitting && activeDecision === "approve" ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <>
                  <ThumbsUp size={16} />
                  <span>Approve</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
