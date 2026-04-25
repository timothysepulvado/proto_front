import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Film,
  Layers3,
  MessageSquareText,
  Workflow,
  X,
} from "lucide-react";
import * as api from "../api";
import type { Artifact, CampaignDeliverable, DeliverableStatus, ProductionShotState, RunLog } from "../api";

const OS_API_URL = import.meta.env.VITE_OS_API_URL || "http://localhost:3001";

type DrawerTab = "narrative" | "critic" | "orchestrator" | "timeline";
type Verdict = "PASS" | "WARN" | "FAIL";

type NeighborShot = {
  shot_number: number | null;
  beat_name: string | null;
  visual_intent_summary: string;
};

type NarrativeContext = {
  shot_number: number | null;
  beat_name: string | null;
  song_start_s: number | null;
  song_end_s: number | null;
  visual_intent: string;
  characters: unknown[];
  previous_shot: NeighborShot | null;
  next_shot: NeighborShot | null;
  stylization_allowances: string[];
};

type VideoGradeCriterion = {
  name: string;
  score: number;
  notes: string;
};

type VideoGradeResult = {
  verdict: Verdict;
  aggregateScore: number | null;
  criteria: VideoGradeCriterion[];
  detectedFailureClasses: string[];
  reasoning: string;
  consensusNote: string | null;
};

type OrchestratorDecisionPayload = {
  level: string | null;
  action: string | null;
  failureClass: string | null;
  newStillPrompt: string | null;
  newVeoPrompt: string | null;
  newNegativePrompt: string | null;
  reasoning: string;
  confidence: number | null;
};

type OrchestrationDecisionRecord = {
  id: string;
  escalationId: string;
  runId?: string;
  iteration: number;
  inputContext: Record<string, unknown>;
  decision: Record<string, unknown>;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  latencyMs?: number;
  createdAt: string;
};

type DeliverableTrail = {
  deliverable: {
    id: string;
    status?: string;
    description?: string;
  } | null;
  decisionHistory: OrchestrationDecisionRecord[];
};

type RunEscalationReport = {
  deliverables?: DeliverableTrail[];
};

type TimelineEvent = {
  id: string;
  createdAt: string;
  kind: "log" | "grade" | "decision" | "artifact";
  summary: string;
  detail?: string;
};

interface ShotDetailDrawerProps {
  shotNumber: number | null;
  deliverableId: string | null;
  runId?: string;
  onClose: () => void;
}

const tabs: Array<{ id: DrawerTab; label: string; icon: typeof Layers3 }> = [
  { id: "narrative", label: "Narrative", icon: Layers3 },
  { id: "critic", label: "Critic", icon: MessageSquareText },
  { id: "orchestrator", label: "Orchestrator", icon: Workflow },
  { id: "timeline", label: "Timeline", icon: Clock3 },
];

const statusStyles: Partial<Record<DeliverableStatus, string>> = {
  pending: "border-white/10 text-white/45",
  generating: "border-cyan-500/30 text-cyan-300",
  reviewing: "border-amber-500/30 text-amber-300",
  approved: "border-emerald-500/30 text-emerald-300",
  rejected: "border-red-500/30 text-red-300",
  regenerating: "border-purple-500/30 text-purple-300",
};

const verdictStyles: Record<Verdict, string> = {
  PASS: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  WARN: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  FAIL: "border-red-500/30 bg-red-500/10 text-red-300",
};

const apiCompat = api as unknown as Record<string, unknown>;
const getLatestArtifactForDeliverableCompat = typeof apiCompat["getLatestArtifactForDeliverable"] === "function"
  ? (apiCompat["getLatestArtifactForDeliverable"] as (deliverableId: string) => Promise<Artifact | null>)
  : undefined;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function formatMoney(value: number | null | undefined) {
  return `$${(value ?? 0).toFixed(2)}`;
}

function formatBeat(beatName: string | null) {
  return beatName ? beatName.replace(/_/g, " ") : "Unmapped";
}

function formatDuration(seconds: number | null) {
  if (seconds === null) return "--:--";
  const mins = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${mins}:${String(remainder).padStart(2, "0")}`;
}

function truncate(value: string | null | undefined, limit: number) {
  if (!value) return "—";
  return value.length > limit ? `${value.slice(0, limit).trim()}…` : value;
}

function isDeliverableStatus(value: string | undefined): value is DeliverableStatus {
  return value === "pending"
    || value === "generating"
    || value === "reviewing"
    || value === "approved"
    || value === "rejected"
    || value === "regenerating";
}

function extractNarrativeContext(artifact: Artifact | null): NarrativeContext | null {
  const metadata = asRecord(artifact?.metadata);
  const narrative = asRecord(metadata?.narrative_context);
  if (!narrative) return null;

  const previousRecord = asRecord(narrative.previous_shot);
  const nextRecord = asRecord(narrative.next_shot);

  const normalizeNeighbor = (record: Record<string, unknown> | null): NeighborShot | null => {
    if (!record) return null;
    return {
      shot_number: readNumber(record, "shot_number"),
      beat_name: readString(record, "beat_name"),
      visual_intent_summary: readString(record, "visual_intent_summary") ?? "",
    };
  };

  return {
    shot_number: readNumber(narrative, "shot_number"),
    beat_name: readString(narrative, "beat_name"),
    song_start_s: readNumber(narrative, "song_start_s"),
    song_end_s: readNumber(narrative, "song_end_s"),
    visual_intent: readString(narrative, "visual_intent") ?? "",
    characters: Array.isArray(narrative.characters) ? narrative.characters : [],
    previous_shot: normalizeNeighbor(previousRecord),
    next_shot: normalizeNeighbor(nextRecord),
    stylization_allowances: readStringArray(narrative.stylization_allowances),
  };
}

function extractQaVerdict(decisions: OrchestrationDecisionRecord[]): VideoGradeResult | null {
  for (const record of decisions) {
    const input = asRecord(record.inputContext);
    const qa = asRecord(input?.qa_verdict ?? input?.qaVerdict);
    if (!qa) continue;

    const verdict = readString(qa, "verdict");
    if (verdict !== "PASS" && verdict !== "WARN" && verdict !== "FAIL") continue;

    const criteria = Array.isArray(qa.criteria)
      ? qa.criteria
          .map((item) => {
            const criterion = asRecord(item);
            const name = readString(criterion, "name");
            const score = readNumber(criterion, "score");
            if (!name || score === null) return null;
            return {
              name,
              score,
              notes: readString(criterion, "notes") ?? "",
            } satisfies VideoGradeCriterion;
          })
          .filter((item): item is VideoGradeCriterion => item !== null)
      : [];

    return {
      verdict,
      aggregateScore: readNumber(qa, "aggregate_score"),
      criteria,
      detectedFailureClasses: readStringArray(qa.detected_failure_classes),
      reasoning: readString(qa, "reasoning") ?? readString(qa, "summary") ?? "",
      consensusNote: readString(qa, "consensus_note"),
    };
  }

  return null;
}

function extractDecisionPayload(record: OrchestrationDecisionRecord): OrchestratorDecisionPayload {
  const decision = asRecord(record.decision);
  return {
    level: readString(decision, "level"),
    action: readString(decision, "action"),
    failureClass: readString(decision, "failure_class"),
    newStillPrompt: readString(decision, "new_still_prompt"),
    newVeoPrompt: readString(decision, "new_veo_prompt"),
    newNegativePrompt: readString(decision, "new_negative_prompt"),
    reasoning: readString(decision, "reasoning") ?? "",
    confidence: readNumber(decision, "confidence"),
  };
}

function extractWebSearchCount(record: OrchestrationDecisionRecord): number | null {
  const input = asRecord(record.inputContext);
  const decision = asRecord(record.decision);
  const direct = readNumber(input, "web_search_count") ?? readNumber(input, "webSearchCount");
  if (direct !== null) return direct;
  return readNumber(decision, "web_search_count") ?? readNumber(decision, "webSearchCount");
}

function formatCharacters(characters: unknown[]) {
  const slugs = characters
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const record = asRecord(entry);
      return readString(record, "slug") ?? readString(record, "role") ?? null;
    })
    .filter((value): value is string => Boolean(value));
  return slugs.length > 0 ? slugs.join(", ") : "—";
}

function buildTimelineEvents(
  logs: RunLog[],
  artifacts: Artifact[],
  decisions: OrchestrationDecisionRecord[],
  deliverableId: string,
  shotNumber: number | null,
): TimelineEvent[] {
  const shortId = deliverableId.slice(0, 8).toLowerCase();
  const shotMatchers = shotNumber === null
    ? []
    : [`shot ${shotNumber}`, `shot_${shotNumber}`, `shot#${shotNumber}`, `shot_number=${shotNumber}`];

  const filteredLogs = logs.filter((log) => {
    const message = log.message.toLowerCase();
    return message.includes(deliverableId.toLowerCase())
      || message.includes(shortId)
      || shotMatchers.some((matcher) => message.includes(matcher));
  });

  const logEvents = filteredLogs.map((log) => ({
    id: `log-${log.id}`,
    createdAt: log.timestamp,
    kind: "log" as const,
    summary: `${log.level.toUpperCase()} — ${log.message}`,
  }));

  const decisionEvents = decisions.flatMap((record) => {
    const payload = extractDecisionPayload(record);
    const qa = extractQaVerdict([record]);
    const events: TimelineEvent[] = [
      {
        id: `decision-${record.id}`,
        createdAt: record.createdAt,
        kind: "decision",
        summary: `L${payload.level?.replace("L", "") ?? "?"} ${payload.action ?? "decision"} — ${payload.failureClass ?? "no failure class"}`,
        detail: payload.reasoning || undefined,
      },
    ];

    if (qa) {
      events.push({
        id: `grade-${record.id}`,
        createdAt: record.createdAt,
        kind: "grade",
        summary: `Grade ${qa.verdict}${qa.aggregateScore !== null ? ` — ${qa.aggregateScore.toFixed(1)}` : ""}`,
      });
    }

    return events;
  });

  const artifactEvents = artifacts.map((artifact) => ({
    id: `artifact-${artifact.id}`,
    createdAt: artifact.createdAt,
    kind: "artifact" as const,
    summary: `${artifact.type === "video" ? "Veo render" : "Artifact created"} ${artifact.name}`,
  }));

  return [...logEvents, ...decisionEvents, ...artifactEvents].sort((left, right) => {
    const timeDelta = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    if (timeDelta !== 0) return timeDelta;
    const rank = { log: 0, grade: 1, decision: 2, artifact: 3 };
    return rank[left.kind] - rank[right.kind];
  });
}

async function fetchTrail(runId: string, deliverableId: string): Promise<DeliverableTrail | null> {
  const response = await fetch(`${OS_API_URL}/api/runs/${runId}/escalation-report`);
  if (!response.ok) return null;
  const report = (await response.json()) as RunEscalationReport;
  return report.deliverables?.find((item) => item.deliverable?.id === deliverableId) ?? null;
}

function TimelineIcon({ kind }: { kind: TimelineEvent["kind"] }) {
  if (kind === "artifact") return <Film size={12} className="text-cyan-300" />;
  if (kind === "grade") return <CheckCircle2 size={12} className="text-emerald-300" />;
  if (kind === "decision") return <Workflow size={12} className="text-amber-300" />;
  return <Archive size={12} className="text-white/45" />;
}

export default function ShotDetailDrawer({ shotNumber, deliverableId, runId, onClose }: ShotDetailDrawerProps) {
  const [activeTab, setActiveTab] = useState<DrawerTab>("narrative");
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [logs, setLogs] = useState<RunLog[]>([]);
  const [trail, setTrail] = useState<DeliverableTrail | null>(null);
  const [fallbackDeliverable, setFallbackDeliverable] = useState<CampaignDeliverable | null>(null);
  const [productionShots, setProductionShots] = useState<ProductionShotState[]>([]);
  const [expandedDecisionId, setExpandedDecisionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setActiveTab("narrative");
    setExpandedDecisionId(null);
    setArtifacts([]);
    setLogs([]);
    setTrail(null);
    setFallbackDeliverable(null);
    setProductionShots([]);
    setLoadError(null);
    if (!deliverableId) {
      setIsLoading(false);
    }
  }, [deliverableId, runId]);

  useEffect(() => {
    if (!deliverableId) return;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      const isTyping = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (!isTyping && (event.key === "j" || event.key === "J" || event.key === "k" || event.key === "K")) {
        event.preventDefault();
        const delta = event.key.toLowerCase() === "j" ? 1 : -1;
        setActiveTab((previous) => {
          const index = tabs.findIndex((tab) => tab.id === previous);
          const nextIndex = (index + delta + tabs.length) % tabs.length;
          return tabs[nextIndex].id;
        });
        return;
      }
      if (event.key !== "Tab") return;
      const container = drawerRef.current;
      if (!container) return;
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("disabled"));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [deliverableId, onClose]);

  useEffect(() => {
    if (!deliverableId) return;
    const currentDeliverableId = deliverableId;
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setLoadError(null);
      try {
        const [runArtifacts, runLogs, runTrail, deliverableDetail, productionCatalog] = await Promise.all([
          runId
            ? api.getArtifacts(runId).then((items) => items.filter((item) => item.deliverableId === currentDeliverableId))
            : Promise.resolve<Artifact[]>([]),
          runId ? api.getRunLogs(runId) : Promise.resolve<RunLog[]>([]),
          runId ? fetchTrail(runId, currentDeliverableId) : Promise.resolve<DeliverableTrail | null>(null),
          api.getDeliverable(currentDeliverableId).catch(() => null),
          api.getProductionShots("drift-mv").then((response) => response.shots).catch(() => []),
        ]);

        const sortedArtifacts = [...runArtifacts].sort(
          (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
        );
        const latestArtifact = sortedArtifacts[0] ?? (getLatestArtifactForDeliverableCompat
          ? await getLatestArtifactForDeliverableCompat(currentDeliverableId)
          : null);

        if (cancelled) return;
        setArtifacts(latestArtifact && sortedArtifacts.length === 0 ? [latestArtifact] : sortedArtifacts);
        setLogs(runLogs);
        setTrail(runTrail);
        setFallbackDeliverable(deliverableDetail);
        setProductionShots(productionCatalog);
      } catch {
        if (!cancelled) {
          setLoadError("Couldn't load shot details. Retry.");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [deliverableId, reloadNonce, runId]);

  const latestArtifact = artifacts[0] ?? null;
  const narrative = useMemo(() => extractNarrativeContext(latestArtifact), [latestArtifact]);
  const decisionsNewestFirst = useMemo(
    () => [...(trail?.decisionHistory ?? [])].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()),
    [trail],
  );
  const decisionsById = useMemo(() => {
    const ordered = [...(trail?.decisionHistory ?? [])].sort((left, right) => left.iteration - right.iteration);
    return new Map(
      ordered.map((record, index) => [record.id, index > 0 ? extractDecisionPayload(ordered[index - 1]) : null]),
    );
  }, [trail]);
  const qaVerdict = useMemo(() => extractQaVerdict(decisionsNewestFirst), [decisionsNewestFirst]);
  const resolvedShotNumber = narrative?.shot_number ?? shotNumber;
  const productionShot = productionShots.find((item) => item.shotNumber === resolvedShotNumber) ?? null;
  const previousProductionShot = productionShots.find((item) => item.shotNumber === (resolvedShotNumber ?? 0) - 1) ?? null;
  const nextProductionShot = productionShots.find((item) => item.shotNumber === (resolvedShotNumber ?? 0) + 1) ?? null;
  const resolvedBeat = narrative?.beat_name ?? productionShot?.beat ?? null;
  const deliverable = trail?.deliverable ?? fallbackDeliverable ?? null;
  const deliverableStatus = isDeliverableStatus(deliverable?.status) ? deliverable.status : undefined;
  const timeline = useMemo(
    () => (deliverableId ? buildTimelineEvents(logs, artifacts, decisionsNewestFirst, deliverableId, resolvedShotNumber) : []),
    [artifacts, decisionsNewestFirst, deliverableId, logs, resolvedShotNumber],
  );

  if (!deliverableId) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[730] flex justify-end">
      <button
        type="button"
        aria-label="Close shot drawer"
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shot-detail-title"
        className="relative z-10 flex h-full w-full max-w-[480px] flex-col border-l border-white/10 bg-[#0b0b0f]/95 backdrop-blur-md shadow-[-24px_0_80px_rgba(0,0,0,0.45)] sm:w-[480px]"
      >
        <div className="border-b border-white/10 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[8px] font-mono uppercase tracking-[0.35em] text-cyan-400/65">Shot Detail</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <h2 id="shot-detail-title" className="text-lg font-semibold text-white">
                  #{resolvedShotNumber ?? "—"} {formatBeat(resolvedBeat)}
                </h2>
                <span className={`rounded-full border px-2 py-0.5 text-[8px] font-mono uppercase tracking-wider ${deliverableStatus ? statusStyles[deliverableStatus] : "border-white/10 text-white/45"}`}>
                  {deliverableStatus ?? "pending"}
                </span>
              </div>
              <p className="mt-1 text-[8px] font-mono uppercase tracking-widest text-white/35">
                {deliverable?.description ?? `Deliverable ${deliverableId.slice(0, 8)}`} · {deliverableId.slice(0, 8)}
              </p>
            </div>

            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              className="rounded-full border border-white/10 p-2 text-white/45 transition-colors hover:border-white/20 hover:text-white"
            >
              <X size={14} />
            </button>
          </div>

          <div role="tablist" aria-label="Shot detail tabs" className="mt-4 flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-2 text-[8px] font-mono uppercase tracking-[0.25em] transition-all ${
                    active
                      ? "border border-cyan-500/30 bg-cyan-500/12 text-cyan-200"
                      : "border border-transparent text-white/35 hover:text-white/70"
                  }`}
                >
                  <Icon size={11} />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-400" />
              <span className="mt-3 text-[8px] font-mono uppercase tracking-widest text-white/35">Loading shot detail</span>
            </div>
          ) : loadError ? (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/6 p-4 text-[10px] font-mono text-red-300">
              <p>{loadError}</p>
              <button
                type="button"
                onClick={() => setReloadNonce((value) => value + 1)}
                className="mt-3 rounded-xl border border-cyan-500/25 px-4 py-2 text-[9px] uppercase tracking-wider text-cyan-300 hover:bg-cyan-500/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/40"
              >
                Retry
              </button>
            </div>
          ) : activeTab === "narrative" ? (
            <div className="space-y-4">
              <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/[0.06] p-4">
                <p className="text-[8px] font-mono uppercase tracking-widest text-cyan-300/70">Beat</p>
                <p className="mt-2 text-xl font-semibold text-cyan-300">{formatBeat(resolvedBeat)}</p>
                <div className="mt-4 grid grid-cols-2 gap-3 text-[9px] font-mono uppercase tracking-wider text-white/55">
                  <div className="rounded-xl border border-white/8 bg-white/[0.02] p-3">
                    <p className="text-white/35">Shot</p>
                    <p className="mt-1 text-white">#{resolvedShotNumber ?? "—"} of 30</p>
                  </div>
                  <div className="rounded-xl border border-white/8 bg-white/[0.02] p-3">
                    <p className="text-white/35">Song timing</p>
                    <p className="mt-1 text-white">{formatDuration(narrative?.song_start_s ?? productionShot?.startS ?? null)} → {formatDuration(narrative?.song_end_s ?? productionShot?.endS ?? null)}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                <p className="text-[8px] font-mono uppercase tracking-widest text-white/45">Visual intent</p>
                <p className="mt-2 text-[13px] leading-6 text-white/80">{narrative?.visual_intent || productionShot?.visualIntent || "No narrative envelope found on the latest artifact."}</p>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                  <p className="text-[8px] font-mono uppercase tracking-widest text-white/45">Previous shot</p>
                  <p className="mt-2 text-[12px] leading-5 text-white/65">
                    {narrative?.previous_shot
                      ? `#${narrative.previous_shot.shot_number ?? "—"} · ${truncate(narrative.previous_shot.visual_intent_summary, 80)}`
                      : previousProductionShot
                        ? `#${previousProductionShot.shotNumber} · ${truncate(previousProductionShot.visualIntent, 80)}`
                        : "—"}
                  </p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                  <p className="text-[8px] font-mono uppercase tracking-widest text-white/45">Next shot</p>
                  <p className="mt-2 text-[12px] leading-5 text-white/65">
                    {narrative?.next_shot
                      ? `#${narrative.next_shot.shot_number ?? "—"} · ${truncate(narrative.next_shot.visual_intent_summary, 80)}`
                      : nextProductionShot
                        ? `#${nextProductionShot.shotNumber} · ${truncate(nextProductionShot.visualIntent, 80)}`
                        : "—"}
                  </p>
                </div>
              </div>

              {narrative?.stylization_allowances && narrative.stylization_allowances.length > 0 && (
                <div className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-4">
                  <p className="text-[8px] font-mono uppercase tracking-widest text-amber-300/80">Stylization allowances</p>
                  <ul className="mt-3 space-y-2 text-[12px] leading-5 text-amber-50/80">
                    {narrative.stylization_allowances.map((allowance) => (
                      <li key={allowance} className="flex items-start gap-2">
                        <span className="mt-1 h-1.5 w-1.5 rounded-full bg-amber-300" />
                        <span>{allowance}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                <p className="text-[8px] font-mono uppercase tracking-widest text-white/45">Characters</p>
                <p className="mt-2 text-[12px] leading-5 text-white/70">{narrative ? formatCharacters(narrative.characters) : (productionShot?.charactersNeeded.join(", ") || "—")}</p>
              </div>
            </div>
          ) : activeTab === "critic" ? (
            qaVerdict ? (
              <div className="space-y-4">
                <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className={`rounded-full border px-2.5 py-1 text-[9px] font-mono uppercase tracking-widest ${verdictStyles[qaVerdict.verdict]}`}>
                      {qaVerdict.verdict}
                    </span>
                    <span className="text-3xl font-semibold tracking-tight text-white">
                      {qaVerdict.aggregateScore !== null ? qaVerdict.aggregateScore.toFixed(1) : "—"}
                    </span>
                  </div>
                </div>

                {qaVerdict.criteria.length > 0 && (
                  <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                    <p className="text-[8px] font-mono uppercase tracking-widest text-white/45">Criteria</p>
                    <div className="mt-3 space-y-3">
                      {qaVerdict.criteria.map((criterion) => (
                        <div key={criterion.name} className="space-y-1.5">
                          <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-white/60">
                            <span>{criterion.name}</span>
                            <span>{criterion.score.toFixed(1)} / 5.0</span>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
                            <div className="h-full rounded-full bg-cyan-300" style={{ width: `${Math.max(0, Math.min(100, (criterion.score / 5) * 100))}%` }} />
                          </div>
                          {criterion.notes && <p className="text-[11px] leading-5 text-white/55">{criterion.notes}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                  <p className="text-[8px] font-mono uppercase tracking-widest text-white/45">Failure classes</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {qaVerdict.detectedFailureClasses.length > 0 ? qaVerdict.detectedFailureClasses.map((failureClass) => (
                      <span key={failureClass} className="rounded-full border border-red-500/20 bg-red-500/10 px-2 py-1 text-[8px] font-mono uppercase tracking-widest text-red-300">
                        {failureClass.replace(/_/g, " ")}
                      </span>
                    )) : <span className="text-[11px] text-white/45">None recorded</span>}
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                  <p className="text-[8px] font-mono uppercase tracking-widest text-white/45">Critic reasoning</p>
                  <p className="mt-3 whitespace-pre-wrap text-[12px] leading-6 text-white/70">{qaVerdict.reasoning || "No critic reasoning recorded."}</p>
                  {qaVerdict.consensusNote && (
                    <p className="mt-3 text-[11px] italic leading-5 text-white/50">{qaVerdict.consensusNote}</p>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 text-[12px] text-white/55">
                No critic payload persisted — this shot is approved without escalation.
              </div>
            )
          ) : activeTab === "orchestrator" ? (
            decisionsNewestFirst.length > 0 ? (
              <div className="space-y-3">
                {decisionsNewestFirst.map((record) => {
                  const payload = extractDecisionPayload(record);
                  const previous = decisionsById.get(record.id);
                  const expanded = expandedDecisionId === record.id;
                  const confidenceWidth = Math.max(0, Math.min(100, (payload.confidence ?? 0) * 100));
                  const webSearchCount = extractWebSearchCount(record);

                  return (
                    <div key={record.id} className="rounded-2xl border border-white/10 bg-white/[0.02]">
                      <button
                        type="button"
                        onClick={() => setExpandedDecisionId(expanded ? null : record.id)}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2 text-[8px] font-mono uppercase tracking-widest text-white/50">
                            <span>Iteration {record.iteration}</span>
                            {payload.level && <span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-0.5 text-cyan-300">{payload.level}</span>}
                            {payload.action && <span className="rounded-full border border-white/10 px-2 py-0.5 text-white/70">{payload.action.replace(/_/g, " ")}</span>}
                            {payload.failureClass && <span className="text-red-300">{payload.failureClass.replace(/_/g, " ")}</span>}
                          </div>
                          <div className="mt-3 flex items-center gap-3 text-[10px] font-mono text-white/55">
                            <span>{formatMoney(record.cost)}</span>
                            <span>{new Date(record.createdAt).toLocaleTimeString("en-US", { hour12: false })}</span>
                            <span>Confidence {(payload.confidence ?? 0).toFixed(2)}</span>
                            {webSearchCount !== null && <span>web_search {webSearchCount}</span>}
                          </div>
                          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8">
                            <div className="h-full rounded-full bg-amber-300" style={{ width: `${confidenceWidth}%` }} />
                          </div>
                        </div>
                        <ChevronDown size={14} className={`shrink-0 text-white/35 transition-transform ${expanded ? "rotate-180" : ""}`} />
                      </button>

                      {expanded && (
                        <div className="space-y-4 border-t border-white/10 px-4 py-4">
                          <div>
                            <p className="text-[8px] font-mono uppercase tracking-widest text-white/40">Reasoning</p>
                            <p className="mt-2 whitespace-pre-wrap text-[12px] leading-6 text-white/70">{payload.reasoning || "No orchestrator reasoning recorded."}</p>
                          </div>

                          {payload.newStillPrompt && (
                            <div>
                              <p className="text-[8px] font-mono uppercase tracking-widest text-white/40">Still prompt</p>
                              {previous?.newStillPrompt && previous.newStillPrompt !== payload.newStillPrompt && (
                                <p className="mt-2 text-[10px] font-mono leading-5 text-white/35">Prev: {truncate(previous.newStillPrompt, 160)}</p>
                              )}
                              <p className="mt-2 whitespace-pre-wrap rounded-xl border border-white/10 bg-black/25 p-3 text-[11px] font-mono leading-5 text-white/75">{payload.newStillPrompt}</p>
                            </div>
                          )}

                          {payload.newVeoPrompt && (
                            <div>
                              <p className="text-[8px] font-mono uppercase tracking-widest text-white/40">Veo prompt</p>
                              {previous?.newVeoPrompt && previous.newVeoPrompt !== payload.newVeoPrompt && (
                                <p className="mt-2 text-[10px] font-mono leading-5 text-white/35">Prev: {truncate(previous.newVeoPrompt, 160)}</p>
                              )}
                              <p className="mt-2 whitespace-pre-wrap rounded-xl border border-white/10 bg-black/25 p-3 text-[11px] font-mono leading-5 text-white/75">{payload.newVeoPrompt}</p>
                            </div>
                          )}

                          {payload.newNegativePrompt && (
                            <div>
                              <p className="text-[8px] font-mono uppercase tracking-widest text-white/40">Negative prompt</p>
                              {previous?.newNegativePrompt && previous.newNegativePrompt !== payload.newNegativePrompt && (
                                <p className="mt-2 text-[10px] font-mono leading-5 text-white/35">Prev: {truncate(previous.newNegativePrompt, 160)}</p>
                              )}
                              <p className="mt-2 whitespace-pre-wrap rounded-xl border border-white/10 bg-black/25 p-3 text-[11px] font-mono leading-5 text-white/75">{payload.newNegativePrompt}</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 text-[12px] text-white/55">
                No orchestrator decisions for this shot — reused as-is.
              </div>
            )
          ) : (
            timeline.length > 0 ? (
              <div className="space-y-3">
                {timeline.map((event) => (
                  <div key={event.id} className="relative pl-6">
                    <div className="absolute left-[5px] top-6 h-[calc(100%-8px)] w-px bg-cyan-400/15" />
                    <div className="absolute left-0 top-1.5 flex h-3 w-3 items-center justify-center rounded-full bg-[#0b0b0f]">
                      <TimelineIcon kind={event.kind} />
                    </div>
                    <div className="rounded-xl bg-white/[0.02] px-3 py-2.5">
                      <div className="flex items-center justify-between gap-3 text-[8px] font-mono uppercase tracking-widest text-white/40">
                        <span>{new Date(event.createdAt).toLocaleTimeString("en-US", { hour12: false })}</span>
                        <span>{event.kind}</span>
                      </div>
                      <p className="mt-1 text-[12px] leading-5 text-white/75">{event.summary}</p>
                      {event.detail && <p className="mt-2 text-[11px] leading-5 text-white/45">{truncate(event.detail, 180)}</p>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 text-[12px] text-white/55">
                No timeline events recorded for this shot yet.
              </div>
            )
          )}
        </div>

        <div className="border-t border-white/10 px-5 py-3 text-[8px] font-mono uppercase tracking-widest text-white/30">
          {latestArtifact ? `Latest artifact ${latestArtifact.name}` : "No artifact loaded"}
        </div>
      </div>
    </div>
  );
}
