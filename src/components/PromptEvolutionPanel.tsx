import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  CheckCircle2,
  Dna,
  GitBranch,
  History,
  Loader2,
  Pencil,
  PlusCircle,
} from "lucide-react";
import {
  getActivePrompt,
  getPromptHistory,
  getPromptScores,
  getPromptLineage,
  subscribeToPrompts,
  createPrompt,
  type PromptTemplate,
} from "../api";

// -- Types
interface PromptScore {
  id: string;
  score: number;
  gateDecision?: string;
  createdAt: string;
}

interface LineageEntry {
  id: string;
  parentPromptId: string;
  childPromptId: string;
  trigger: string;
  reason: string;
  rejectionCategories: string[];
  scoreBefore: number | null;
  scoreAfter: number | null;
  createdAt: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function scoreColor(score: number): string {
  if (score >= 0.85) return "text-emerald-400";
  if (score >= 0.70) return "text-amber-400";
  return "text-red-400";
}

function avgScore(scores: PromptScore[]): number | null {
  if (scores.length === 0) return null;
  return scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
}

// -- Component
interface PromptEvolutionPanelProps {
  clientId: string;
}

export default function PromptEvolutionPanel({ clientId }: PromptEvolutionPanelProps) {
  const [active, setActive] = useState<PromptTemplate | null>(null);
  const [history, setHistory] = useState<PromptTemplate[]>([]);
  const [activeScores, setActiveScores] = useState<PromptScore[]>([]);
  const [lineage, setLineage] = useState<LineageEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Editor state
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Expand states
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [lineageExpanded, setLineageExpanded] = useState(false);
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);

  // Lazy-loaded scores cache for history items
  const [historyScores, setHistoryScores] = useState<Map<string, PromptScore[]>>(new Map());

  // -- Data loading
  const loadData = useCallback(async (cancelled: { current: boolean }) => {
    try {
      setError(null);
      const [activePrompt, allHistory] = await Promise.all([
        getActivePrompt(clientId),
        getPromptHistory(clientId),
      ]);

      if (cancelled.current) return;

      setActive(activePrompt);
      setHistory(allHistory);

      if (activePrompt) {
        const [scores, lin] = await Promise.all([
          getPromptScores(activePrompt.id),
          getPromptLineage(activePrompt.id),
        ]);

        if (cancelled.current) return;

        setActiveScores(scores);
        setLineage(
          (lin ?? []).map((d: Record<string, unknown>) => ({
            id: d.id as string,
            parentPromptId: d.parent_prompt_id as string,
            childPromptId: d.child_prompt_id as string,
            trigger: (d.trigger as string) ?? "unknown",
            reason: (d.reason as string) ?? "",
            rejectionCategories: (d.rejection_categories as string[]) ?? [],
            scoreBefore: (d.score_before as number) ?? null,
            scoreAfter: (d.score_after as number) ?? null,
            createdAt: d.created_at as string,
          }))
        );
      } else {
        setActiveScores([]);
        setLineage([]);
      }
    } catch {
      if (!cancelled.current) {
        setError("Failed to load prompt data");
      }
    } finally {
      if (!cancelled.current) {
        setIsLoading(false);
      }
    }
  }, [clientId]);

  useEffect(() => {
    const cancelled = { current: false };
    setIsLoading(true);
    loadData(cancelled);

    const unsub = subscribeToPrompts(clientId, () => {
      loadData(cancelled);
    });

    return () => {
      cancelled.current = true;
      unsub();
    };
  }, [clientId, loadData]);

  // -- Lazy load history scores
  const loadHistoryScores = useCallback(async (promptId: string) => {
    if (historyScores.has(promptId)) return;
    try {
      const scores = await getPromptScores(promptId);
      setHistoryScores((prev) => new Map(prev).set(promptId, scores));
    } catch {
      // Non-fatal
    }
  }, [historyScores]);

  const handleExpandHistory = useCallback(
    (promptId: string) => {
      if (expandedHistoryId === promptId) {
        setExpandedHistoryId(null);
      } else {
        setExpandedHistoryId(promptId);
        loadHistoryScores(promptId);
      }
    },
    [expandedHistoryId, loadHistoryScores]
  );

  // -- Create / edit
  const handleNewPrompt = useCallback(() => {
    setEditText("");
    setIsEditing(true);
  }, []);

  const handleEditPrompt = useCallback(() => {
    setEditText(active?.promptText ?? "");
    setIsEditing(true);
  }, [active]);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
    setEditText("");
  }, []);

  const handleSave = useCallback(async () => {
    if (!editText.trim()) return;
    setIsSaving(true);
    try {
      await createPrompt(clientId, editText.trim(), "generate", active?.id);
      setIsEditing(false);
      setEditText("");
    } catch {
      setError("Failed to save prompt");
    } finally {
      setIsSaving(false);
    }
  }, [clientId, editText, active]);

  // -- Derived
  const activeAvg = avgScore(activeScores);

  // -- Loading state
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-10">
        <Loader2 size={18} className="text-cyan-400/50 animate-spin" />
        <span className="mt-3 text-[9px] font-mono text-white/30 uppercase tracking-widest">
          Loading prompts
        </span>
      </div>
    );
  }

  // -- Error state
  if (error && !active && history.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10">
        <Dna size={20} className="text-red-400/40 mb-2" />
        <span className="text-[9px] font-mono text-red-400/60 uppercase tracking-widest">
          {error}
        </span>
      </div>
    );
  }

  // -- Empty state
  if (!active && history.length === 0 && !isEditing) {
    return (
      <div className="flex flex-col items-center justify-center py-10">
        <Dna size={20} className="text-white/10 mb-3" />
        <span className="text-[9px] font-mono text-white/30 uppercase tracking-widest">
          No prompts yet
        </span>
        <p className="text-[8px] font-mono text-white/20 mt-1 mb-4">
          Create your first prompt to start evolving
        </p>
        <button
          onClick={handleNewPrompt}
          className="flex items-center px-4 py-2 text-[9px] font-mono uppercase tracking-wider text-cyan-400/80 border border-cyan-500/20 rounded-xl hover:bg-cyan-500/10 hover:border-cyan-500/40 transition-all"
        >
          <PlusCircle size={12} className="mr-1.5" />
          Create First Prompt
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3">
      {/* Header Row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Dna size={12} className="text-cyan-400/60" />
          <span className="text-[9px] font-mono text-white/50 uppercase tracking-widest">
            Prompt Evolution
          </span>
          {active && (
            <span className="text-[8px] font-mono text-cyan-400 px-1.5 py-0.5 bg-cyan-500/10 border border-cyan-500/20 rounded">
              v{active.version}
            </span>
          )}
        </div>
        <button
          onClick={handleNewPrompt}
          className="flex items-center px-2.5 py-1.5 text-[8px] font-mono uppercase tracking-wider text-cyan-400/60 border border-cyan-500/20 rounded-lg hover:bg-cyan-500/10 hover:text-cyan-400 hover:border-cyan-500/40 transition-all"
        >
          <PlusCircle size={10} className="mr-1" />
          New Prompt
        </button>
      </div>

      {/* Error banner (non-fatal) */}
      {error && (
        <div className="p-2 bg-red-500/10 border border-red-500/20 rounded-lg text-[8px] font-mono text-red-400/80">
          {error}
        </div>
      )}

      {/* Manual Editor */}
      {isEditing && (
        <div className="p-3 bg-white/[0.02] border border-cyan-500/20 rounded-xl space-y-3">
          <span className="text-[8px] font-mono text-white/30 uppercase tracking-widest">
            {active ? "Edit Prompt" : "New Prompt"}
          </span>
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            placeholder="Enter prompt text..."
            rows={4}
            className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 text-[10px] font-mono text-white/80 placeholder:text-white/20 outline-none focus:border-cyan-500/40 transition-colors resize-none"
            autoFocus
          />
          <div className="flex items-center justify-end space-x-2">
            <button
              onClick={handleCancel}
              className="px-3 py-1.5 text-[8px] font-mono uppercase tracking-wider text-white/30 border border-white/10 rounded-lg hover:bg-white/5 hover:text-white/60 transition-all"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!editText.trim() || isSaving}
              className={`px-4 py-1.5 text-[8px] font-mono uppercase tracking-wider rounded-lg flex items-center transition-all ${
                editText.trim() && !isSaving
                  ? "text-cyan-400 border border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20"
                  : "text-white/20 border border-white/10 cursor-not-allowed"
              }`}
            >
              {isSaving ? (
                <>
                  <Loader2 size={10} className="mr-1 animate-spin" />
                  Saving
                </>
              ) : (
                <>
                  <CheckCircle2 size={10} className="mr-1" />
                  Save & Activate
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Active Prompt Card */}
      {active && (
        <div className="p-3 bg-white/[0.02] border border-white/5 rounded-xl space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span className="text-[8px] font-mono text-white/30 uppercase tracking-widest">
                Active
              </span>
              {active.source && (
                <span className="text-[7px] font-mono text-white/20 px-1.5 py-0.5 border border-white/10 rounded">
                  {active.source}
                </span>
              )}
              <span className="text-[7px] font-mono text-white/20">
                {formatDate(active.createdAt)}
              </span>
            </div>
            <div className="flex items-center space-x-2">
              {activeAvg !== null && (
                <span className={`text-[10px] font-mono font-bold ${scoreColor(activeAvg)}`}>
                  {activeAvg.toFixed(2)}
                </span>
              )}
              <button
                onClick={handleEditPrompt}
                className="p-1 text-white/20 hover:text-cyan-400/60 transition-colors"
                title="Edit prompt"
              >
                <Pencil size={10} />
              </button>
            </div>
          </div>

          {/* Prompt text — truncated, click to expand */}
          <button
            onClick={() => setPromptExpanded(!promptExpanded)}
            className="w-full text-left"
          >
            <p
              className={`text-[10px] font-mono text-white/60 leading-relaxed ${
                promptExpanded ? "" : "line-clamp-3"
              }`}
            >
              {active.promptText}
            </p>
            {active.promptText.length > 200 && (
              <span className="text-[7px] font-mono text-cyan-400/40 uppercase mt-1 inline-block">
                {promptExpanded ? "Show less" : "Show more"}
              </span>
            )}
          </button>
        </div>
      )}

      {/* Version History — Collapsible */}
      {history.length > 0 && (
        <div className="border border-white/5 rounded-xl overflow-hidden">
          <button
            onClick={() => setHistoryExpanded(!historyExpanded)}
            className="w-full flex items-center justify-between p-3 hover:bg-white/[0.02] transition-colors"
          >
            <div className="flex items-center space-x-2">
              <History size={10} className="text-white/30" />
              <span className="text-[8px] font-mono text-white/40 uppercase tracking-widest">
                Version History
              </span>
              <span className="text-[7px] font-mono text-white/20">
                ({history.length})
              </span>
            </div>
            <ChevronDown
              size={12}
              className={`text-white/20 transition-transform duration-200 ${
                historyExpanded ? "rotate-180" : ""
              }`}
            />
          </button>

          {historyExpanded && (
            <div className="border-t border-white/5 divide-y divide-white/5">
              {history.map((prompt) => {
                const isExp = expandedHistoryId === prompt.id;
                const cachedScores = historyScores.get(prompt.id);
                const hAvg = cachedScores ? avgScore(cachedScores) : null;

                return (
                  <div key={prompt.id}>
                    <button
                      onClick={() => handleExpandHistory(prompt.id)}
                      className="w-full flex items-center justify-between px-3 py-2 hover:bg-white/[0.02] transition-colors text-left"
                    >
                      <div className="flex items-center space-x-2 min-w-0">
                        <span className="text-[9px] font-mono text-white/50 shrink-0">
                          v{prompt.version}
                        </span>
                        <span className="text-[8px] font-mono text-white/20 shrink-0">
                          {formatDate(prompt.createdAt)}
                        </span>
                        {prompt.source && (
                          <span className="text-[7px] font-mono text-white/15 px-1 py-0.5 border border-white/5 rounded shrink-0">
                            {prompt.source}
                          </span>
                        )}
                        {prompt.isActive && (
                          <span className="text-[7px] font-mono text-cyan-400 px-1 py-0.5 bg-cyan-500/10 border border-cyan-500/20 rounded shrink-0">
                            active
                          </span>
                        )}
                      </div>
                      <div className="flex items-center space-x-2 shrink-0 ml-2">
                        {hAvg !== null && (
                          <span className={`text-[9px] font-mono font-bold ${scoreColor(hAvg)}`}>
                            {hAvg.toFixed(2)}
                          </span>
                        )}
                        <ChevronDown
                          size={10}
                          className={`text-white/15 transition-transform duration-200 ${
                            isExp ? "rotate-180" : ""
                          }`}
                        />
                      </div>
                    </button>

                    {isExp && (
                      <div className="px-3 pb-3 space-y-2">
                        <p className="text-[9px] font-mono text-white/40 leading-relaxed whitespace-pre-wrap">
                          {prompt.promptText}
                        </p>
                        {cachedScores && cachedScores.length > 0 && (
                          <div className="space-y-1">
                            <span className="text-[7px] font-mono text-white/20 uppercase tracking-widest">
                              Scores
                            </span>
                            {cachedScores.map((s) => (
                              <div key={s.id} className="flex items-center space-x-2 text-[8px] font-mono">
                                <span className={`font-bold ${scoreColor(s.score)}`}>
                                  {s.score.toFixed(2)}
                                </span>
                                {s.gateDecision && (
                                  <span className="text-white/20 px-1 py-0.5 border border-white/5 rounded">
                                    {s.gateDecision}
                                  </span>
                                )}
                                <span className="text-white/15">
                                  {formatDate(s.createdAt)}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        {cachedScores && cachedScores.length === 0 && (
                          <span className="text-[7px] font-mono text-white/15 uppercase">
                            No scores recorded
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Evolution Log — Collapsible */}
      {lineage.length > 0 && (
        <div className="border border-white/5 rounded-xl overflow-hidden">
          <button
            onClick={() => setLineageExpanded(!lineageExpanded)}
            className="w-full flex items-center justify-between p-3 hover:bg-white/[0.02] transition-colors"
          >
            <div className="flex items-center space-x-2">
              <GitBranch size={10} className="text-white/30" />
              <span className="text-[8px] font-mono text-white/40 uppercase tracking-widest">
                Evolution Log
              </span>
              <span className="text-[7px] font-mono text-white/20">
                ({lineage.length})
              </span>
            </div>
            <ChevronDown
              size={12}
              className={`text-white/20 transition-transform duration-200 ${
                lineageExpanded ? "rotate-180" : ""
              }`}
            />
          </button>

          {lineageExpanded && (
            <div className="border-t border-white/5 divide-y divide-white/5">
              {lineage.map((entry) => (
                <div key={entry.id} className="px-3 py-2 space-y-1">
                  <div className="flex items-center space-x-2">
                    <span className="text-[8px] font-mono text-purple-400/60 px-1.5 py-0.5 bg-purple-500/10 border border-purple-500/20 rounded">
                      {entry.trigger}
                    </span>
                    <span className="text-[7px] font-mono text-white/20">
                      {formatDate(entry.createdAt)}
                    </span>
                    {entry.scoreBefore !== null && entry.scoreAfter !== null && (
                      <span className="text-[8px] font-mono text-white/30">
                        <span className={scoreColor(entry.scoreBefore)}>
                          {entry.scoreBefore.toFixed(2)}
                        </span>
                        {" → "}
                        <span className={scoreColor(entry.scoreAfter)}>
                          {entry.scoreAfter.toFixed(2)}
                        </span>
                      </span>
                    )}
                  </div>
                  {entry.reason && (
                    <p className="text-[8px] font-mono text-white/30 leading-relaxed">
                      {entry.reason}
                    </p>
                  )}
                  {entry.rejectionCategories.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {entry.rejectionCategories.map((cat) => (
                        <span
                          key={cat}
                          className="text-[7px] font-mono text-red-400/50 px-1 py-0.5 bg-red-500/5 border border-red-500/10 rounded"
                        >
                          {cat.replace(/_/g, " ")}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
