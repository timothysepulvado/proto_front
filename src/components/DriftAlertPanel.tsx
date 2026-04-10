import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";
import {
  getDriftAlerts,
  acknowledgeDriftAlert,
  subscribeToDriftAlerts,
  type DriftAlert,
} from "../api";

const severityStyles = {
  critical: { text: "text-red-400", border: "border-red-500/30", bg: "bg-red-500/5", badge: "bg-red-500/20 border-red-500/40" },
  error: { text: "text-amber-400", border: "border-amber-500/30", bg: "bg-amber-500/5", badge: "bg-amber-500/20 border-amber-500/40" },
  warn: { text: "text-cyan-400", border: "border-cyan-500/30", bg: "bg-cyan-500/5", badge: "bg-cyan-500/20 border-cyan-500/40" },
};

interface DriftAlertPanelProps {
  clientId: string;
  currentRunId?: string;
}

export default function DriftAlertPanel({ clientId }: DriftAlertPanelProps) {
  const [alerts, setAlerts] = useState<DriftAlert[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [acknowledging, setAcknowledging] = useState<string | null>(null);
  const [ackNotes, setAckNotes] = useState<Map<string, string>>(new Map());

  // Load alerts + subscribe to realtime
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setIsLoading(true);
        const data = await getDriftAlerts(clientId);
        if (!cancelled) setAlerts(data);
      } catch (err) {
        console.error("Failed to load drift alerts:", err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();

    // Realtime subscription — on any event, re-fetch the full list
    // to keep ordering consistent (unacknowledged first)
    const cleanup = subscribeToDriftAlerts(clientId, () => {
      if (!cancelled) {
        getDriftAlerts(clientId).then((data) => {
          if (!cancelled) setAlerts(data);
        });
      }
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [clientId]);

  const handleAcknowledge = useCallback(async (alertId: string) => {
    setAcknowledging(alertId);
    try {
      const notes = ackNotes.get(alertId);
      const updated = await acknowledgeDriftAlert(alertId, notes || undefined);
      setAlerts((prev) =>
        prev.map((a) => (a.id === updated.id ? updated : a))
      );
      // Clear notes for this alert
      setAckNotes((prev) => {
        const next = new Map(prev);
        next.delete(alertId);
        return next;
      });
    } catch (err) {
      console.error("Failed to acknowledge drift alert:", err);
    } finally {
      setAcknowledging(null);
    }
  }, [ackNotes]);

  const unacknowledgedCount = alerts.filter((a) => !a.acknowledged).length;
  const criticalCount = alerts.filter((a) => !a.acknowledged && a.severity === "critical").length;
  const errorCount = alerts.filter((a) => !a.acknowledged && a.severity === "error").length;

  // Loading state
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <div className="w-6 h-6 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
        <span className="mt-3 text-[9px] font-mono text-white/30 uppercase tracking-widest">
          Loading Drift Alerts
        </span>
      </div>
    );
  }

  // Empty state
  if (alerts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <ShieldCheck size={28} className="text-cyan-400/30 mb-3" />
        <span className="text-[10px] font-mono text-cyan-400/50 uppercase tracking-widest">
          No drift alerts
        </span>
        <p className="text-[9px] font-mono text-white/20 mt-1">
          Brand alignment healthy
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3">
      {/* Summary bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3 text-[9px] font-mono uppercase tracking-wider">
          <span className="text-white/40">
            Alerts: <span className="text-white">{alerts.length}</span>
          </span>
          {unacknowledgedCount > 0 && (
            <span className="text-amber-400 flex items-center">
              <AlertTriangle size={10} className="mr-1" />
              {unacknowledgedCount} open
            </span>
          )}
          {criticalCount > 0 && (
            <span className="text-red-400">
              {criticalCount} critical
            </span>
          )}
          {errorCount > 0 && (
            <span className="text-amber-400">
              {errorCount} error
            </span>
          )}
          {unacknowledgedCount === 0 && (
            <span className="text-cyan-400/60 flex items-center">
              <CheckCircle2 size={10} className="mr-1" />
              All acknowledged
            </span>
          )}
        </div>
      </div>

      {/* Alert cards */}
      <div className="space-y-2 max-h-[300px] overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent pr-1">
        {alerts.map((alert) => {
          const style = severityStyles[alert.severity];
          const isAcking = acknowledging === alert.id;

          return (
            <div
              key={alert.id}
              className={`rounded-xl border p-3 transition-all ${style.border} ${style.bg} ${
                alert.acknowledged ? "opacity-50" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start space-x-2 min-w-0">
                  {/* Severity badge */}
                  <span
                    className={`shrink-0 text-[7px] font-mono font-bold uppercase px-1.5 py-0.5 rounded border ${style.text} ${style.badge}`}
                  >
                    {alert.severity}
                  </span>
                  <div className="min-w-0">
                    <p className="text-[10px] font-mono text-white/80 leading-relaxed break-words">
                      {alert.message}
                    </p>
                    <div className="flex items-center space-x-3 mt-1.5 text-[8px] font-mono text-white/30 uppercase tracking-wider">
                      {alert.fusedZ !== undefined && (
                        <span>
                          Z: <span className={style.text}>{alert.fusedZ.toFixed(2)}</span>
                        </span>
                      )}
                      <span>
                        {new Date(alert.createdAt).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        })}
                      </span>
                      <span className="truncate">
                        Run {alert.runId.slice(0, 8)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Acknowledge button or status */}
                {!alert.acknowledged ? (
                  <button
                    onClick={() => handleAcknowledge(alert.id)}
                    disabled={isAcking}
                    className="shrink-0 px-2.5 py-1.5 text-[8px] font-mono uppercase tracking-wider text-cyan-400/70 border border-cyan-500/20 rounded-lg hover:bg-cyan-500/10 hover:text-cyan-400 hover:border-cyan-500/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center"
                  >
                    {isAcking ? (
                      <div className="w-3 h-3 border border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
                    ) : (
                      <>
                        <CheckCircle2 size={10} className="mr-1" />
                        Ack
                      </>
                    )}
                  </button>
                ) : (
                  <span className="shrink-0 text-[7px] font-mono text-white/20 uppercase px-1.5 py-0.5 border border-white/10 rounded">
                    Ack'd
                  </span>
                )}
              </div>

              {/* Resolution notes input (for unacknowledged) */}
              {!alert.acknowledged && (
                <input
                  type="text"
                  value={ackNotes.get(alert.id) ?? ""}
                  onChange={(e) =>
                    setAckNotes((prev) => {
                      const next = new Map(prev);
                      next.set(alert.id, e.target.value);
                      return next;
                    })
                  }
                  placeholder="Resolution notes (optional)..."
                  className="w-full mt-2 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-[9px] font-mono text-white/60 placeholder:text-white/15 outline-none focus:border-cyan-500/30 transition-colors"
                />
              )}

              {/* Show acknowledged info */}
              {alert.acknowledged && (alert.acknowledgedAt || alert.resolutionNotes) && (
                <div className="mt-1.5 text-[8px] font-mono text-white/20 space-x-3">
                  {alert.acknowledgedAt && (
                    <span>
                      Resolved{" "}
                      {new Date(alert.acknowledgedAt).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })}
                    </span>
                  )}
                  {alert.resolutionNotes && (
                    <span className="italic">"{alert.resolutionNotes}"</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
