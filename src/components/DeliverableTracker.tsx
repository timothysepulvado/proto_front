import { useEffect, useState } from "react";
import { Layers, RefreshCw } from "lucide-react";
import {
  getCampaignDeliverables,
  subscribeToCampaignDeliverables,
  type CampaignDeliverable,
  type DeliverableStatus,
} from "../api";

// Status badge styling — follows ReviewPanel patterns
const statusStyles: Record<DeliverableStatus, { text: string; border: string; pulse?: boolean }> = {
  pending:      { text: "text-white/30",     border: "border-white/10" },
  generating:   { text: "text-cyan-400",     border: "border-cyan-500/30",    pulse: true },
  reviewing:    { text: "text-amber-400",    border: "border-amber-500/30" },
  approved:     { text: "text-emerald-400",  border: "border-emerald-500/30" },
  rejected:     { text: "text-red-400",      border: "border-red-500/30" },
  regenerating: { text: "text-purple-400",   border: "border-purple-500/30",  pulse: true },
};

interface DeliverableTrackerProps {
  campaignId: string;
}

export default function DeliverableTracker({ campaignId }: DeliverableTrackerProps) {
  const [deliverables, setDeliverables] = useState<CampaignDeliverable[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setIsLoading(true);
        const data = await getCampaignDeliverables(campaignId);
        if (!cancelled) setDeliverables(data);
      } catch (err) {
        console.error("Failed to load deliverables:", err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();

    // Subscribe to realtime updates
    const unsubscribe = subscribeToCampaignDeliverables(campaignId, (updated) => {
      setDeliverables((prev) => {
        const idx = prev.findIndex((d) => d.id === updated.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = updated;
          return next;
        }
        // New deliverable — append
        return [...prev, updated];
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [campaignId]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-8">
        <div className="w-6 h-6 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
        <span className="mt-3 text-[9px] font-mono text-white/30 uppercase tracking-widest">
          Loading Deliverables
        </span>
      </div>
    );
  }

  if (deliverables.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8">
        <Layers size={24} className="text-white/10 mb-3" />
        <span className="text-[9px] font-mono text-white/30 uppercase tracking-widest">
          No deliverables configured
        </span>
        <p className="text-[8px] font-mono text-white/20 mt-1">
          Add deliverables to this campaign to track generation progress
        </p>
      </div>
    );
  }

  // Summary counts
  const counts = deliverables.reduce(
    (acc, d) => {
      acc[d.status] = (acc[d.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <div className="mt-3 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-mono text-cyan-400/80 uppercase tracking-widest flex items-center">
          <Layers size={10} className="mr-1.5" />
          {deliverables.length} deliverable{deliverables.length !== 1 ? "s" : ""}
        </span>
        <div className="flex items-center space-x-2 text-[8px] font-mono uppercase tracking-wider">
          {counts.approved && (
            <span className="text-emerald-400">{counts.approved} approved</span>
          )}
          {counts.reviewing && (
            <span className="text-amber-400">{counts.reviewing} reviewing</span>
          )}
          {counts.generating && (
            <span className="text-cyan-400">{counts.generating} generating</span>
          )}
          {counts.rejected && (
            <span className="text-red-400">{counts.rejected} rejected</span>
          )}
        </div>
      </div>

      {/* Deliverable cards */}
      {deliverables.map((d) => {
        const style = statusStyles[d.status];
        return (
          <div
            key={d.id}
            className={`p-3 rounded-xl bg-white/[0.02] border ${style.border} transition-all`}
          >
            <div className="flex items-center justify-between">
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-mono text-white truncate">
                  {d.description || `Deliverable ${d.id.slice(0, 8)}`}
                </p>
                <p className="text-[8px] font-mono text-white/30 uppercase tracking-wider mt-0.5">
                  {d.aiModel ?? "default model"} — ID {d.id.slice(0, 8)}
                </p>
              </div>

              <div className="flex items-center space-x-2 shrink-0 ml-3">
                {d.retryCount > 0 && (
                  <span className="text-[7px] font-mono text-purple-400/70 flex items-center">
                    <RefreshCw size={8} className="mr-0.5" />
                    {d.retryCount}
                  </span>
                )}
                <span
                  className={`text-[8px] font-mono uppercase px-2 py-1 rounded-lg border ${style.text} ${style.border} ${
                    style.pulse ? "animate-pulse" : ""
                  }`}
                >
                  {d.status}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
