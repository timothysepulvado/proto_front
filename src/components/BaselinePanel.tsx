import { useCallback, useEffect, useState } from "react";
import { Activity, ChevronDown, Loader2, RefreshCw } from "lucide-react";
import {
  getActiveBaseline,
  getBaselineHistory,
  calculateBaseline,
  subscribeToBaselines,
  type BrandBaseline,
} from "../api";

interface BaselinePanelProps {
  clientId: string;
}

export default function BaselinePanel({ clientId }: BaselinePanelProps) {
  const [active, setActive] = useState<BrandBaseline | null>(null);
  const [history, setHistory] = useState<BrandBaseline[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCalculating, setIsCalculating] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load baseline + subscribe to realtime
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setIsLoading(true);
        setError(null);
        const [activeData, historyData] = await Promise.all([
          getActiveBaseline(clientId),
          getBaselineHistory(clientId),
        ]);
        if (!cancelled) {
          setActive(activeData);
          setHistory(historyData);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load baselines");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();

    // Realtime subscription — re-fetch on any baseline change
    const cleanup = subscribeToBaselines(clientId, () => {
      if (!cancelled) {
        Promise.all([
          getActiveBaseline(clientId),
          getBaselineHistory(clientId),
        ]).then(([a, h]) => {
          if (!cancelled) {
            setActive(a);
            setHistory(h);
          }
        });
      }
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [clientId]);

  const handleCalculate = useCallback(async () => {
    setIsCalculating(true);
    setError(null);
    try {
      const result = await calculateBaseline(clientId);
      setActive(result);
      // Re-fetch history to include the new baseline
      const historyData = await getBaselineHistory(clientId);
      setHistory(historyData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Calculation failed");
    } finally {
      setIsCalculating(false);
    }
  }, [clientId]);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-8">
        <div className="w-5 h-5 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
        <span className="mt-2 text-[8px] font-mono text-white/30 uppercase tracking-widest">
          Loading Baselines
        </span>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3">
      {/* Header with calculate button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2 text-[9px] font-mono uppercase tracking-wider">
          <Activity size={10} className="text-cyan-400/60" />
          <span className="text-white/40">Brand Baseline</span>
          {active && (
            <span className="text-cyan-400/80 px-1.5 py-0.5 border border-cyan-500/20 rounded text-[7px]">
              v{active.version}
            </span>
          )}
        </div>
        <button
          onClick={handleCalculate}
          disabled={isCalculating}
          className="flex items-center px-2.5 py-1.5 text-[8px] font-mono uppercase tracking-wider text-cyan-400/70 border border-cyan-500/20 rounded-lg hover:bg-cyan-500/10 hover:text-cyan-400 hover:border-cyan-500/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isCalculating ? (
            <>
              <Loader2 size={10} className="mr-1 animate-spin" />
              Computing...
            </>
          ) : (
            <>
              <RefreshCw size={10} className="mr-1" />
              Calculate Baseline
            </>
          )}
        </button>
      </div>

      {/* Error display */}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[9px] font-mono text-red-400">
          {error}
        </div>
      )}

      {/* Active baseline card */}
      {active ? (
        <div className="rounded-xl border border-cyan-500/20 bg-white/[0.02] p-3 space-y-2">
          {/* Fused z-score - hero stat */}
          <div className="flex items-baseline justify-between">
            <span className="text-[8px] font-mono text-white/30 uppercase tracking-wider">
              Fused Baseline Z
            </span>
            <span className="text-[14px] font-mono text-cyan-400 font-bold tabular-nums">
              {active.fusedBaselineZ?.toFixed(4) ?? "—"}
            </span>
          </div>

          {/* Per-model stats grid */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-white/[0.03] p-2 space-y-1">
              <span className="text-[7px] font-mono text-white/25 uppercase tracking-widest">
                Gemini
              </span>
              <div className="flex items-baseline justify-between">
                <span className="text-[8px] font-mono text-white/40">raw</span>
                <span className="text-[10px] font-mono text-white/70 tabular-nums">
                  {active.geminiBaselineRaw?.toFixed(4) ?? "—"}
                </span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-[8px] font-mono text-white/40">std</span>
                <span className="text-[10px] font-mono text-white/70 tabular-nums">
                  {active.geminiStddev?.toFixed(4) ?? "—"}
                </span>
              </div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2 space-y-1">
              <span className="text-[7px] font-mono text-white/25 uppercase tracking-widest">
                Cohere
              </span>
              <div className="flex items-baseline justify-between">
                <span className="text-[8px] font-mono text-white/40">raw</span>
                <span className="text-[10px] font-mono text-white/70 tabular-nums">
                  {active.cohereBaselineRaw?.toFixed(4) ?? "—"}
                </span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-[8px] font-mono text-white/40">std</span>
                <span className="text-[10px] font-mono text-white/70 tabular-nums">
                  {active.cohereStddev?.toFixed(4) ?? "—"}
                </span>
              </div>
            </div>
          </div>

          {/* Meta row */}
          <div className="flex items-center justify-between text-[8px] font-mono text-white/20 uppercase tracking-wider pt-1 border-t border-white/5">
            <span>
              Samples: <span className="text-white/40">{active.sampleCount ?? "—"}</span>
            </span>
            <span>
              {active.createdAt
                ? new Date(active.createdAt).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  })
                : "—"}
            </span>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-8 rounded-xl border border-white/5 bg-white/[0.01]">
          <Activity size={24} className="text-white/10 mb-2" />
          <span className="text-[9px] font-mono text-white/25 uppercase tracking-widest">
            No baseline calculated
          </span>
          <p className="text-[8px] font-mono text-white/15 mt-1">
            Click "Calculate Baseline" to compute from brand corpus
          </p>
        </div>
      )}

      {/* History section */}
      {history.length > 1 && (
        <div>
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="flex items-center text-[8px] font-mono text-white/30 uppercase tracking-wider hover:text-white/50 transition-colors"
          >
            <ChevronDown
              size={10}
              className={`mr-1 transition-transform ${showHistory ? "rotate-0" : "-rotate-90"}`}
            />
            Version History ({history.length})
          </button>

          {showHistory && (
            <div className="mt-2 space-y-1 max-h-[160px] overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent pr-1">
              {history.map((b) => (
                <div
                  key={b.id}
                  className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-[8px] font-mono ${
                    b.isActive
                      ? "border border-cyan-500/20 bg-cyan-500/5 text-cyan-400/80"
                      : "border border-white/5 bg-white/[0.01] text-white/30"
                  }`}
                >
                  <div className="flex items-center space-x-2">
                    <span className="font-bold">v{b.version}</span>
                    {b.isActive && (
                      <span className="text-[6px] uppercase px-1 py-0.5 border border-cyan-500/30 bg-cyan-500/10 rounded">
                        Active
                      </span>
                    )}
                  </div>
                  <div className="flex items-center space-x-3">
                    <span className="tabular-nums">
                      fused_z={b.fusedBaselineZ?.toFixed(3) ?? "—"}
                    </span>
                    <span className="text-white/20">
                      {b.createdAt
                        ? new Date(b.createdAt).toLocaleString("en-US", {
                            month: "short",
                            day: "numeric",
                          })
                        : "—"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
