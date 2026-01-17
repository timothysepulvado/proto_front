import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";
import {
  ChevronDown,
  Dna,
  Layers,
  PlusCircle,
  Radar,
  Settings2,
  ShieldCheck,
  Terminal,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import hudData from "../hud.json";
import type { HudClient, HudRoot } from "./types/hud";
import desktopBg from "./assets/desktop-bg.png";
import noiseTexture from "./assets/noise.svg";

type Orientation = "horizontal" | "vertical";

type RunStageStatus = "pending" | "running" | "complete" | "skipped" | "blocked" | "failed";

type RunStatus =
  | "ready"
  | "running"
  | "needs_review"
  | "blocked"
  | "complete"
  | "failed"
  | "canceled";

type LogEntry = {
  time: string;
  msg: string;
  stage?: string;
  level?: "info" | "warn" | "error";
};

type RunStage = {
  id: string;
  label: string;
  status: RunStageStatus;
  startedAt?: string;
  endedAt?: string;
  message?: string;
};

type RunRecord = {
  runId: string;
  clientId: string;
  mode: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  stages: RunStage[];
  logs?: LogEntry[];
  review?: {
    required: boolean;
    status?: string;
    notes?: string;
    updatedAt?: string;
  };
  artifacts?: Array<{
    id: string;
    name: string;
    type: string;
    path?: string;
    stage?: string;
    createdAt?: string;
  }>;
};

type ApiClient = HudClient & {
  last_run?: RunRecord | null;
};

type DerivedClient = HudClient & {
  alert: boolean;
  internalId: string;
  memoryId: string;
  health: number;
  runsValue: number;
  runsLabel: string;
  typeLabel: string;
  statusLabel: string;
  lastRun?: RunRecord | null;
};

const hudRoot = hudData as HudRoot;
const hud = hudRoot.hud;
const placeholders = hud.data_model?.empty_states?.missing_fields?.placeholders ?? {};

const statusLabels: Record<string, string> = {
  active: "Active",
  pending: "Pending",
  completed: "Completed",
};

const typeByName: Record<string, string> = {
  Cylndr: "Core",
  "Jenni Kayne": "Retail",
  Lilydale: "Agri",
};

const pillars = ["Brand Memory", "Creative Studio", "Brand Drift", "Insight Loop"];

const stageTemplates: Array<Pick<RunStage, "id" | "label">> = [
  { id: "ingest", label: "Ingest and Index" },
  { id: "generate", label: "Generate" },
  { id: "drift", label: "Drift Check" },
  { id: "hitl", label: "HITL Gate" },
  { id: "export", label: "Export Package" },
];

const runOptions = [
  { label: "Full Pipeline", mode: "full", detail: "Brand Memory to Export" },
  { label: "Ingest and Index", mode: "ingest", detail: "Brand Memory" },
  { label: "Generate Images", mode: "images", detail: "Temp-gen" },
  { label: "Generate Video", mode: "video", detail: "Temp-gen" },
  { label: "Drift Check", mode: "drift", detail: "Brand Drift" },
  { label: "Export Package", mode: "export", detail: "Export" },
];

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

const TickMarks = ({
  count = 40,
  orientation = "horizontal",
}: {
  count?: number;
  orientation?: Orientation;
}) => (
  <div
    className={`flex justify-between absolute ${
      orientation === "horizontal"
        ? "inset-x-0 top-0 h-2"
        : "inset-y-0 left-0 w-2 flex-col"
    }`}
  >
    {Array.from({ length: count }).map((_, i) => (
      <div
        key={i}
        className={`${orientation === "horizontal" ? "w-px" : "h-px"} bg-cyan-400/30 ${
          i % 5 === 0
            ? orientation === "horizontal"
              ? "h-2"
              : "w-2"
            : orientation === "horizontal"
              ? "h-1"
              : "w-1"
        }`}
      />
    ))}
  </div>
);

const PancakeCore = ({ active, isDragging }: { active: boolean; isDragging: boolean }) => (
  <div className="relative w-24 h-24 flex items-center justify-center group pointer-events-none">
    <div
      className={`absolute inset-0 bg-cyan-500/20 blur-[40px] rounded-full transition-all duration-1000 ${
        active ? "opacity-100 scale-150 animate-pulse" : "opacity-40 scale-100 group-hover:opacity-80"
      }`}
    />

    <div
      className={`absolute inset-0 border border-cyan-500/20 rounded-full border-dashed transition-transform duration-[20s] linear ${
        active ? "scale-110" : "scale-90"
      }`}
      style={{ animation: "spin 20s linear infinite" }}
    />
    <div
      className={`absolute inset-4 border border-cyan-400/10 rounded-full transition-transform duration-[12s] linear ${
        active ? "scale-125" : "scale-100"
      }`}
      style={{ animation: "spin-reverse 12s linear infinite" }}
    />

    <div
      className={`relative flex flex-col items-center justify-center -space-y-2 transition-all duration-500 transform-gpu ${
        isDragging ? "scale-90 rotate-12 opacity-80" : "scale-100 rotate-0"
      } ${active ? "gap-1" : "gap-0"}`}
    >
      {[1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className={`h-2.5 rounded-full border transition-all duration-700 ease-out transform-gpu ${
            i === 1 ? "w-10" : i === 2 ? "w-14" : i === 3 ? "w-16" : "w-12"
          } ${
            active
              ? "bg-cyan-400 border-white shadow-[0_0_25px_rgba(34,211,238,0.8)]"
              : "bg-gradient-to-r from-cyan-900 via-cyan-600 to-cyan-900 border-cyan-400/30 group-hover:border-cyan-400/60 shadow-lg"
          }`}
          style={{
            transform: active ? `translateZ(${i * 10}px)` : "none",
            opacity: active ? 1 : 1 - i * 0.15,
          }}
        />
      ))}
      <div
        className={`absolute w-3 h-3 bg-white rounded-full blur-[2px] transition-opacity duration-500 ${
          active ? "opacity-100 animate-pulse" : "opacity-0"
        }`}
      />
    </div>
  </div>
);

const CircularTelemetry = ({
  percent,
  label,
  color = "cyan",
}: {
  percent: number;
  label: string;
  color?: "cyan" | "amber";
}) => {
  const circumference = 2 * Math.PI * 48;
  const dashOffset = circumference - (circumference * percent) / 100;

  return (
    <div className="relative w-28 h-28 flex items-center justify-center">
      <svg className="w-full h-full -rotate-90 drop-shadow-[0_0_8px_rgba(34,211,238,0.4)]">
        <circle cx="56" cy="56" r="48" stroke="currentColor" strokeWidth="1" fill="transparent" className="text-white/5" />
        <circle
          cx="56"
          cy="56"
          r="48"
          stroke="currentColor"
          strokeWidth="3"
          fill="transparent"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          className={`transition-all duration-1000 ${color === "cyan" ? "text-cyan-400" : "text-amber-500"}`}
        />
        {percent > 0 && (
          <circle
            cx="56"
            cy="8"
            r="3"
            fill="white"
            transform={`rotate(${(percent / 100) * 360}, 56, 56)`}
            className="animate-pulse"
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-sm font-mono font-bold text-white tracking-tighter">{percent}%</span>
        <span className="text-[8px] uppercase tracking-widest text-cyan-500/50 font-black">{label}</span>
      </div>
    </div>
  );
};

const formatCode = (value: string | null | undefined, fallback: string, maxLen = 18) => {
  if (!value) {
    return fallback;
  }
  const cleaned = value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
};

const parseRuns = (value: number | string | null | undefined, fallback: number | string | undefined) => {
  const raw = value ?? fallback ?? 0;
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatRunsLabel = (value: number) => String(value).padStart(3, "0");

const computeHealth = (status: string, runs: number, index: number) => {
  const base = status === "active" ? 86 : status === "pending" ? 42 : status === "completed" ? 78 : 60;
  const variance = (runs % 12) + index * 2;
  return Math.min(99, Math.max(18, base + variance));
};

const buildClients = (list: ApiClient[]): DerivedClient[] => {
  const placeholderMemory = typeof placeholders.dna === "string" ? placeholders.dna : "MEMORY_UNSET";
  const placeholderStatus = typeof placeholders.status === "string" ? placeholders.status : "pending";
  const placeholderRuns = placeholders.runs ?? 0;

  return list.map((client, index) => {
    const status = String(client.status ?? placeholderStatus);
    const runsValue = parseRuns(client.runs, placeholderRuns);
    const internalId = formatCode(client.internal_id ?? client.brand_id ?? client.name, "UNKNOWN");
    const memoryId = formatCode(client.brand_memory_id ?? client.dna ?? placeholderMemory, "MEMORY_UNSET", 24);

    return {
      ...client,
      alert: Boolean(client.hitl_review_needed),
      internalId,
      memoryId,
      health: computeHealth(status, runsValue, index),
      runsValue,
      runsLabel: formatRunsLabel(runsValue),
      typeLabel: typeByName[client.name] ?? "Custom",
      statusLabel: statusLabels[status] ?? status.charAt(0).toUpperCase() + status.slice(1),
      lastRun: client.last_run ?? null,
    };
  });
};

const createDefaultStages = (): RunStage[] =>
  stageTemplates.map((stage) => ({ ...stage, status: "pending" }));

const formatTimestamp = (value?: string) => {
  if (!value) return "None";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", { hour12: false });
};

const formatLogTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("en-US", { hour12: false });
};

const getRunStatusLabel = (status?: RunStatus) => {
  if (!status) return "Ready";
  if (status === "needs_review") return "Needs Review";
  if (status === "blocked" || status === "failed" || status === "canceled") return "Blocked";
  if (status === "complete") return "Complete";
  if (status === "running") return "Running";
  return "Ready";
};

const getRunStatusClass = (status?: RunStatus) => {
  if (status === "running") return "text-cyan-400";
  if (status === "needs_review") return "text-amber-400";
  if (status === "complete") return "text-lime-400";
  if (status === "blocked" || status === "failed" || status === "canceled") return "text-red-400";
  return "text-white/60";
};

const getStageStatusLabel = (status: RunStageStatus) => {
  if (status === "running") return "Running";
  if (status === "complete") return "Complete";
  if (status === "skipped") return "Skipped";
  if (status === "blocked" || status === "failed") return "Blocked";
  return "Pending";
};

const getStageStatusClass = (status: RunStageStatus) => {
  if (status === "running") return "text-cyan-400";
  if (status === "complete") return "text-lime-400";
  if (status === "skipped") return "text-white/20";
  if (status === "blocked" || status === "failed") return "text-red-400";
  return "text-white/40";
};

const buildRunInputs = (client: DerivedClient, mode: string) => {
  const basePrompt = `BrandStudios ${client.name} campaign key visual with brand memory alignment.`;

  if (mode === "video") {
    return {
      prompt: `Cinematic ${client.name} brand motion study with clean lighting and clear subject focus.`,
      generate: "video",
    };
  }

  if (mode === "images") {
    return {
      prompt: `Studio stills for ${client.name} with brand memory alignment and clear product focus.`,
      generate: "images",
    };
  }

  if (mode === "full") {
    return {
      prompt: basePrompt,
      generate: "images",
    };
  }

  return { prompt: basePrompt };
};

export default function App() {
  const [clients, setClients] = useState<DerivedClient[]>(buildClients(hud.clients ?? []));
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeClient, setActiveClient] = useState(clients[0]?.id ?? "");
  const [showIntake, setShowIntake] = useState(false);
  const [isClientDetailOpen, setIsClientDetailOpen] = useState(false);
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const [activePillar, setActivePillar] = useState(pillars[0]);
  const [showSettings, setShowSettings] = useState(false);
  const [showRunFeed, setShowRunFeed] = useState(true);
  const [currentRun, setCurrentRun] = useState<RunRecord | null>(null);
  const [runLogs, setRunLogs] = useState<LogEntry[]>([]);
  const [runStages, setRunStages] = useState<RunStage[]>(createDefaultStages());
  const [reviewNotes, setReviewNotes] = useState("");
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [apiAvailable, setApiAvailable] = useState(true);

  const [position, setPosition] = useState({ x: 100, y: 100 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const hasMovedRef = useRef(false);

  const currentClient = useMemo(
    () => clients.find((client) => client.id === activeClient) ?? clients[0],
    [clients, activeClient]
  );

  const intakeModules = [
    { label: "LLM", value: hud.intake.initial_configuration.llm },
    { label: "Agent Tool", value: hud.intake.initial_configuration.agent_tool },
    { label: "Creative Tool", value: hud.intake.initial_configuration.creative_tool },
  ];

  const loadClients = async () => {
    try {
      const response = await fetch("/api/clients");
      if (!response.ok) throw new Error("Failed to fetch clients");
      const payload = (await response.json()) as { clients?: ApiClient[] };
      const nextClients = buildClients(payload.clients ?? []);
      setClients(nextClients.length > 0 ? nextClients : buildClients(hud.clients ?? []));
      setApiAvailable(true);
    } catch (error) {
      setClients(buildClients(hud.clients ?? []));
      setApiAvailable(false);
    }
  };

  useEffect(() => {
    void loadClients();
  }, []);

  useEffect(() => {
    if (clients.length === 0) return;
    if (!clients.some((client) => client.id === activeClient)) {
      setActiveClient(clients[0]?.id ?? "");
    }
  }, [clients, activeClient]);

  useEffect(() => {
    if (!currentClient) return;
    const lastRun = currentClient.lastRun ?? null;
    setCurrentRun(lastRun);
    setRunStages(lastRun?.stages ?? createDefaultStages());
    setRunLogs((lastRun?.logs ?? []).slice(-8));
    setIsReviewOpen(false);
  }, [currentClient?.id, clients]);

  useEffect(() => {
    if (!currentRun?.runId || !apiAvailable) return;

    const eventSource = new EventSource(`/api/runs/${currentRun.runId}/logs`);

    const handleSnapshot = (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as { run?: RunRecord; logs?: LogEntry[] };
      if (payload.run) {
        setCurrentRun(payload.run);
        setRunStages(payload.run.stages ?? createDefaultStages());
      }
      if (payload.logs) {
        setRunLogs(payload.logs.slice(-8));
      }
    };

    const handleLog = (event: MessageEvent) => {
      const entry = JSON.parse(event.data) as LogEntry;
      setRunLogs((prev) => [...prev, entry].slice(-8));
    };

    const handleStage = (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as { stage: RunStage };
      setRunStages((prev) =>
        prev.map((stage) => (stage.id === payload.stage.id ? { ...stage, ...payload.stage } : stage))
      );
    };

    const handleStatus = (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as { status: RunStatus; updatedAt?: string; endedAt?: string };
      setCurrentRun((prev) =>
        prev
          ? {
              ...prev,
              status: payload.status,
              updatedAt: payload.updatedAt ?? prev.updatedAt,
              endedAt: payload.endedAt ?? prev.endedAt,
            }
          : prev
      );
      if (["complete", "needs_review", "blocked", "failed", "canceled"].includes(payload.status)) {
        void loadClients();
      }
    };

    eventSource.addEventListener("snapshot", handleSnapshot);
    eventSource.addEventListener("log", handleLog);
    eventSource.addEventListener("stage", handleStage);
    eventSource.addEventListener("status", handleStatus);

    return () => {
      eventSource.close();
    };
  }, [currentRun?.runId, apiAvailable]);

  useEffect(() => {
    if (isExpanded) {
      setIsClientDetailOpen(false);
    }
  }, [isExpanded]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
    hasMovedRef.current = false;
    dragStartPos.current = {
      x: event.clientX - position.x,
      y: event.clientY - position.y,
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    const newX = event.clientX - dragStartPos.current.x;
    const newY = event.clientY - dragStartPos.current.y;
    if (Math.abs(newX - position.x) > 5 || Math.abs(newY - position.y) > 5) {
      hasMovedRef.current = true;
    }
    const boundedX = Math.max(0, Math.min(window.innerWidth - 96, newX));
    const boundedY = Math.max(0, Math.min(window.innerHeight - 96, newY));
    setPosition({ x: boundedX, y: boundedY });
  };

  const handlePointerUp = () => setIsDragging(false);

  const handleToggle = () => {
    if (!hasMovedRef.current) {
      setIsExpanded((prev) => !prev);
    }
  };

  const startRun = async (mode: string) => {
    if (!currentClient) return;
    setRunMenuOpen(false);
    setIsReviewOpen(false);

    try {
      const response = await fetch(`/api/clients/${currentClient.id}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, inputs: buildRunInputs(currentClient, mode) }),
      });

      if (!response.ok) throw new Error("Failed to start run");

      const payload = (await response.json()) as { run?: RunRecord };
      if (payload.run) {
        setCurrentRun(payload.run);
        setRunStages(payload.run.stages ?? createDefaultStages());
        setRunLogs([]);
      }
      setApiAvailable(true);
      setIsClientDetailOpen(true);
      void loadClients();
    } catch (error) {
      setApiAvailable(false);
    }
  };

  const handleExport = async () => {
    if (!currentRun) return;
    try {
      const response = await fetch(`/api/runs/${currentRun.runId}/export`, { method: "POST" });
      if (!response.ok) throw new Error("Export failed");
      const payload = (await response.json()) as { run?: RunRecord };
      if (payload.run) {
        setCurrentRun(payload.run);
        setRunStages(payload.run.stages ?? runStages);
      }
      setApiAvailable(true);
      void loadClients();
    } catch (error) {
      setApiAvailable(false);
    }
  };

  const handleCancel = async () => {
    if (!currentRun) return;
    try {
      const response = await fetch(`/api/runs/${currentRun.runId}/cancel`, { method: "POST" });
      if (!response.ok) throw new Error("Cancel failed");
      const payload = (await response.json()) as { run?: RunRecord };
      if (payload.run) {
        setCurrentRun(payload.run);
        setRunStages(payload.run.stages ?? runStages);
      }
      setApiAvailable(true);
      void loadClients();
    } catch (error) {
      setApiAvailable(false);
    }
  };

  const handleReview = async (decision: "approve" | "reject") => {
    if (!currentRun) return;

    const endpoint = decision === "approve" ? "approve" : "reject";
    try {
      const response = await fetch(`/api/runs/${currentRun.runId}/review/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: reviewNotes }),
      });

      if (!response.ok) throw new Error("Review update failed");
      const payload = (await response.json()) as { run?: RunRecord };
      if (payload.run) {
        setCurrentRun(payload.run);
        setRunStages(payload.run.stages ?? runStages);
      }
      setReviewNotes("");
      setIsReviewOpen(false);
      setApiAvailable(true);
      void loadClients();
    } catch (error) {
      setApiAvailable(false);
    }
  };

  const needsReview = Boolean(
    (currentRun?.status && currentRun.status === "needs_review") || currentClient?.alert
  );
  const runStateLabel = getRunStatusLabel(currentRun?.status);
  const runStateClass = getRunStatusClass(currentRun?.status);
  const lastRunTime = formatTimestamp(currentRun?.startedAt ?? currentRun?.createdAt);

  return (
    <div className="h-screen w-screen text-cyan-50 font-sans overflow-hidden flex relative selection:bg-cyan-500/40 bg-[#080a0c]">
      <div className="absolute inset-0 z-0">
        <img
          src={desktopBg}
          className="w-full h-full object-cover opacity-100"
          alt="hud background"
        />
      </div>

      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={handleToggle}
        style={{
          left: position.x,
          top: position.y,
          transition: isDragging ? "none" : "all 0.6s cubic-bezier(0.23, 1, 0.32, 1)",
        }}
        className="fixed z-[600] cursor-grab active:cursor-grabbing"
      >
        <PancakeCore active={isExpanded} isDragging={isDragging} />
        {!isExpanded && (
          <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap opacity-40 text-[9px] font-mono tracking-[0.3em] uppercase animate-pulse">
            System Standby
          </div>
        )}
      </div>

      <div
        className={`flex-1 flex flex-row relative z-20 transition-all duration-1000 ease-out ${
          isExpanded ? "opacity-100" : "opacity-0 pointer-events-none scale-[1.05] blur-xl"
        }`}
      >
        <aside
          className={`h-full border-r border-transparent flex flex-col items-center py-5 justify-between relative overflow-hidden transition-[width,transform,opacity,background-color,backdrop-filter] duration-500 ${
            isExpanded
              ? "w-12 opacity-100 bg-black/20 backdrop-blur-xl translate-x-0 border-cyan-500/10"
              : "w-0 opacity-0 bg-transparent backdrop-blur-none -translate-x-4"
          }`}
        >
          <TickMarks count={24} orientation="vertical" />

          <div className="flex flex-col items-center space-y-5 w-full z-10">
            <div className="p-1.5 bg-cyan-500/10 rounded-full mb-1 border border-cyan-500/30">
              <Workflow size={14} className="text-cyan-400" />
            </div>

            <div className="w-full flex flex-col items-center space-y-3 px-1">
              {clients.map((client) => (
                <button
                  key={client.id}
                  onClick={() => {
                    if (client.id === activeClient) {
                      setIsClientDetailOpen((prev) => !prev);
                      return;
                    }
                    setActiveClient(client.id);
                    setIsClientDetailOpen(true);
                  }}
                  className={`group relative flex items-center justify-center transition-all duration-500 ${
                    activeClient === client.id ? "scale-110" : "scale-90 opacity-40 hover:opacity-100"
                  }`}
                >
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center border transition-all ${
                      activeClient === client.id
                        ? "bg-cyan-500/20 border-cyan-400 shadow-[0_0_15px_rgba(34,211,238,0.4)]"
                        : "bg-white/5 border-white/10"
                    }`}
                  >
                    <Dna size={12} className={activeClient === client.id ? "text-cyan-400" : "text-white"} />
                  </div>

                  <span className="absolute left-16 bg-cyan-900/90 px-3 py-1 rounded text-[10px] font-mono border border-cyan-500/30 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none uppercase tracking-widest whitespace-nowrap">
                    {client.name}
                  </span>

                  {client.alert && (
                    <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-amber-500 rounded-full animate-ping" />
                  )}
                </button>
              ))}
              <div className="h-px w-8 bg-white/10 my-2" />
              <button
                onClick={() => setShowIntake(true)}
                className="p-2 rounded-lg hover:bg-cyan-500/10 transition-colors"
              >
                <PlusCircle size={18} className="text-cyan-400/50 hover:text-cyan-400" />
              </button>
            </div>
          </div>

          <div className="flex flex-col items-center space-y-3 mb-4 z-10">
            <Settings2 size={14} className="text-white/20 hover:text-white cursor-pointer transition-colors" />
            <div className="text-[9px] font-mono -rotate-90 opacity-20 tracking-[0.2em] whitespace-nowrap uppercase">
              BrandStudios OS v0.9.4
            </div>
          </div>
          <OverlayEffects />
        </aside>

        <div className="flex-1 flex flex-col relative">
          <div className="pt-6 md:pt-8 px-8 md:px-10">
            <nav className="group h-9 w-full max-w-2xl ml-8 border border-cyan-500/10 bg-black/25 backdrop-blur-md flex items-center justify-between px-6 rounded-full transition-all duration-300 hover:bg-black/35 hover:border-cyan-400/30 relative overflow-hidden">
              <TickMarks count={80} />

              <div className="flex items-center space-x-6 text-[8px] font-mono tracking-[0.35em] z-10">
                <span className="text-cyan-400 flex items-center animate-pulse">
                  <ShieldCheck size={11} className="mr-2" /> Core Sync Ready
                </span>
                <span className="text-white/40 flex items-center">
                  Latency: <span className="text-white ml-2">0.0004ms</span>
                </span>
                <span className="text-white/40 flex items-center">
                  Uptime: <span className="text-white ml-2">99.98%</span>
                </span>
              </div>

              <div className="flex items-center space-x-4 z-10">
                <div className="flex space-x-1.5 h-2 items-center">
                  {[1, 2, 3, 4, 5, 6].map((i) => (
                    <div
                      key={i}
                      className={`h-1 w-1 rounded-full ${
                        i < 5 ? "bg-cyan-400 shadow-[0_0_5px_cyan]" : "bg-white/10"
                      }`}
                    />
                  ))}
                </div>
                <X
                  onClick={() => setIsExpanded(false)}
                  size={16}
                  className="text-white/30 hover:text-red-400 cursor-pointer transition-colors"
                />
              </div>
              <OverlayEffects className="rounded-full" />
            </nav>
          </div>

          <main className="flex-1 p-6 md:p-10 flex flex-col items-start justify-start relative">
            <div className="absolute inset-0 pointer-events-none opacity-20 flex items-center justify-center overflow-hidden">
              <div className="w-[800px] h-[800px] border border-cyan-500/10 rounded-full absolute animate-[ping_10s_linear_infinite]" />
              <div className="w-[1200px] h-[1200px] border border-cyan-500/5 rounded-full absolute" />
              <div className="absolute top-1/2 left-0 w-full h-px bg-cyan-500/5" />
              <div className="absolute top-0 left-1/2 w-px h-full bg-cyan-500/5" />
            </div>

            {currentClient && isClientDetailOpen && (
              <div className="w-full max-w-[520px] z-10 space-y-4 ml-4 max-h-[calc(100vh-200px)] overflow-y-auto pr-2">
                <div className="flex items-start justify-between gap-6 fade-slide-in">
                  <div className="flex items-end space-x-6 md:space-x-8">
                    <div className="h-20 md:h-24 w-1.5 bg-gradient-to-b from-cyan-400 to-transparent shadow-[0_0_30px_cyan]" />
                    <div className="space-y-2">
                      <h1 className="text-4xl md:text-5xl xl:text-6xl font-black italic tracking-tighter uppercase leading-none text-white drop-shadow-2xl whitespace-nowrap">
                        {currentClient.name}
                      </h1>
                      <div className="space-y-2 rounded-2xl border border-white/10 bg-black/35 px-4 py-3 backdrop-blur-xl">
                        <div className="flex flex-wrap items-center gap-4">
                          <div className="flex flex-col">
                            <span className="text-[9px] uppercase tracking-[0.35em] text-cyan-400/70">Brand Memory</span>
                            <span className="text-[11px] font-mono text-white">{currentClient.memoryId}</span>
                          </div>
                          <div className="h-px w-16 bg-cyan-500/30" />
                          <div className="flex flex-col">
                            <span className="text-[9px] uppercase tracking-[0.35em] text-white/60">Type</span>
                            <span className="text-[11px] text-white">{currentClient.typeLabel}</span>
                            <span className="text-[8px] font-mono text-white/40">
                              TYPE_{currentClient.typeLabel.toUpperCase()}
                            </span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-[9px] uppercase tracking-[0.35em] text-white/60">Status</span>
                            <span className="text-[11px] text-white">{currentClient.statusLabel}</span>
                          </div>
                        </div>
                        <div className="text-[9px] font-mono text-white/70 uppercase tracking-[0.25em]">
                          ID: {currentClient.internalId} | Client: {currentClient.id}
                        </div>
                        <div className="flex flex-wrap items-center gap-4 text-[9px] font-mono text-white/70 uppercase tracking-[0.2em]">
                          <span>
                            Run State: <span className={runStateClass}>{runStateLabel}</span>
                          </span>
                          <span>Run ID: {currentRun?.runId ?? "None"}</span>
                          <span>Last Run: {lastRunTime}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowRunFeed((prev) => !prev)}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 text-[9px] font-mono uppercase tracking-[0.2em] text-white/50 hover:text-white hover:border-white/30 transition-colors"
                    >
                      <Terminal size={12} />
                      Logs
                    </button>
                    <button
                      onClick={() => setShowSettings((prev) => !prev)}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 text-[9px] font-mono uppercase tracking-[0.2em] text-white/50 hover:text-white hover:border-white/30 transition-colors"
                    >
                      <Settings2 size={12} />
                      Settings
                    </button>
                  </div>
                </div>

                <div className="bg-black/15 border border-white/5 backdrop-blur-xl rounded-[1.75rem] p-4 flex flex-col gap-4">
                  <div className="flex flex-wrap gap-2">
                    {pillars.map((pillar) => (
                      <button
                        key={pillar}
                        onClick={() => setActivePillar(pillar)}
                        className={`px-4 py-2 rounded-full text-[10px] uppercase tracking-[0.25em] transition-colors ${
                          activePillar === pillar
                            ? "bg-cyan-500/20 border border-cyan-400/50 text-cyan-200"
                            : "bg-white/5 border border-white/10 text-white/50 hover:text-white"
                        }`}
                      >
                        {pillar}
                      </button>
                    ))}
                  </div>
                  <div className="text-[12px] text-white/70 leading-relaxed">
                    {activePillar === "Brand Memory" && (
                      <div className="space-y-2">
                        <div className="text-white/80">
                          Reference signals, ingest history, and structured memory for {currentClient.name}.
                        </div>
                        <div className="text-[10px] font-mono text-white/40 uppercase tracking-[0.25em]">
                          Memory ID: {currentClient.memoryId}
                        </div>
                      </div>
                    )}
                    {activePillar === "Creative Studio" && (
                      <div className="space-y-2">
                        <div className="text-white/80">
                          Temp-gen orchestration, prompts, and creative outputs.
                        </div>
                        <div className="text-[10px] font-mono text-white/40 uppercase tracking-[0.25em]">
                          Default Mode: {currentRun?.mode ?? "Ready"}
                        </div>
                      </div>
                    )}
                    {activePillar === "Brand Drift" && (
                      <div className="space-y-2">
                        <div className="text-white/80">
                          Drift checks, thresholds, and compliance signals.
                        </div>
                        <div className="text-[10px] font-mono text-white/40 uppercase tracking-[0.25em]">
                          Drift Status:{" "}
                          {getStageStatusLabel(runStages.find((stage) => stage.id === "drift")?.status ?? "pending")}
                        </div>
                      </div>
                    )}
                    {activePillar === "Insight Loop" && (
                      <div className="space-y-2">
                        <div className="text-white/80">
                          Run outcomes, approvals, and feedback loops.
                        </div>
                        <div className="text-[10px] font-mono text-white/40 uppercase tracking-[0.25em]">
                          Review: {needsReview ? "Required" : "Clear"}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {showSettings && (
                  <div className="bg-black/25 border border-white/10 backdrop-blur-xl rounded-[1.75rem] p-4 text-[11px] text-white/70">
                    <div className="text-[10px] uppercase tracking-[0.25em] text-white/40 mb-3">Client Settings</div>
                    <div className="space-y-2 font-mono text-white/60">
                      <div>LLM: {currentClient.configuration?.llm ?? "Not set"}</div>
                      <div>Agent Tool: {currentClient.configuration?.agent_tool ?? "Not set"}</div>
                      <div>Creative Tool: {currentClient.configuration?.creative_tool ?? "Not set"}</div>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-4">
                  <div className="bg-black/20 border border-white/5 backdrop-blur-2xl rounded-[2rem] p-5 flex flex-col justify-between shadow-2xl relative group overflow-hidden">
                    <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-transparent via-cyan-400 to-transparent opacity-30" />
                    <div className="flex justify-between items-center mb-3">
                      <span className="text-[10px] font-mono tracking-widest opacity-50">Signals</span>
                      <Radar size={16} className="text-cyan-400 animate-pulse" />
                    </div>

                    <div className="flex justify-center my-2 transform group-hover:scale-105 transition-transform duration-500">
                      <CircularTelemetry
                        percent={currentClient.health}
                        label="Sync"
                        color={currentClient.health < 50 ? "amber" : "cyan"}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2.5 mt-3">
                      <div className="bg-white/5 p-3 rounded-2xl border border-white/5 flex flex-col items-center">
                        <span className="text-[8px] opacity-50 uppercase font-mono mb-1">Agents</span>
                        <span className="text-2xl font-bold font-mono tracking-tighter">
                          {currentClient.runsLabel}
                        </span>
                      </div>
                      <div className="bg-white/5 p-3 rounded-2xl border border-white/5 flex flex-col items-center">
                        <span className="text-[8px] opacity-50 uppercase font-mono mb-1">Health</span>
                        <span className="text-2xl font-bold font-mono tracking-tighter text-cyan-400">Normal</span>
                      </div>
                    </div>
                    <OverlayEffects className="rounded-[2rem]" />
                  </div>

                  {showRunFeed && (
                    <div className="bg-black/10 border border-white/5 backdrop-blur-xl rounded-[2rem] p-5 flex flex-col shadow-2xl relative overflow-hidden">
                      <div className="flex justify-between items-center mb-4">
                        <div className="flex items-center space-x-3">
                          <div className="w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_10px_cyan]" />
                          <span className="text-[10px] font-mono opacity-70 tracking-widest">Run Feed</span>
                        </div>
                        <Terminal size={14} className="opacity-30" />
                      </div>

                      <div className="grid grid-cols-1 gap-2 mb-4">
                        {runStages.map((stage) => (
                          <div
                            key={stage.id}
                            className="flex items-center justify-between px-3 py-2 rounded-xl border border-white/5 text-[10px]"
                          >
                            <span className="text-white/70 uppercase tracking-[0.2em]">{stage.label}</span>
                            <span className={`font-mono uppercase tracking-[0.2em] ${getStageStatusClass(stage.status)}`}>
                              {getStageStatusLabel(stage.status)}
                            </span>
                          </div>
                        ))}
                      </div>

                      <div className="flex-1 space-y-2 font-mono text-[10px] max-h-52 overflow-y-auto pr-1">
                        {runLogs.length === 0 && (
                          <div className="text-white/40 px-3 py-2 border border-white/5 rounded-xl">
                            {apiAvailable ? "No run activity yet." : "Run feed offline. Start the os-api to stream logs."}
                          </div>
                        )}
                        {runLogs.map((log, i) => (
                          <div
                            key={`${log.time}-${i}`}
                            className={`flex items-start justify-between py-2.5 px-4 rounded-xl transition-all duration-500 border-l-2 ${
                              i === runLogs.length - 1
                                ? "bg-cyan-500/10 border-cyan-400 translate-x-1 text-white"
                                : "border-white/5 text-white/50"
                            }`}
                          >
                            <div className="flex flex-1 min-w-0 items-start gap-4">
                              <span className="opacity-40 shrink-0">[{formatLogTime(log.time)}]</span>
                              <span className="uppercase tracking-[0.2em] text-cyan-400/70 shrink-0">
                                {log.stage ?? "Run"}
                              </span>
                              <span className="min-w-0 break-words text-white/80">{log.msg}</span>
                            </div>
                            <span
                              className={
                                log.level === "error"
                                  ? "text-red-400"
                                  : log.level === "warn"
                                    ? "text-amber-400"
                                    : "text-cyan-400"
                              }
                            >
                              //{" "}
                              {log.level === "error"
                                ? "Error"
                                : log.level === "warn"
                                  ? "Warn"
                                  : "OK"}
                            </span>
                          </div>
                        ))}
                      </div>

                      <div className="mt-4 flex flex-col gap-3">
                        <div className="flex space-x-3">
                          <div className="relative flex-1">
                            <div className="flex w-full">
                              <button
                                onClick={() => startRun("full")}
                                className="flex-1 py-3 bg-white text-black font-black uppercase text-xs rounded-l-2xl hover:bg-cyan-400 transition-all shadow-[0_0_30px_rgba(255,255,255,0.1)] active:scale-95 group flex items-center justify-center"
                              >
                                <Zap size={14} className="mr-2" /> Run
                              </button>
                              <button
                                onClick={() => setRunMenuOpen((prev) => !prev)}
                                className="px-4 border border-white/10 rounded-r-2xl hover:bg-white/5 hover:border-white/30 transition-all text-white/60 hover:text-white flex items-center justify-center"
                              >
                                <ChevronDown size={16} />
                              </button>
                            </div>

                            {runMenuOpen && (
                              <div className="absolute left-0 right-0 bottom-full mb-3 bg-[#0a0c10] border border-cyan-500/30 rounded-2xl shadow-2xl p-2 z-20">
                                {runOptions.map((option) => (
                                  <button
                                    key={option.mode}
                                    onClick={() => startRun(option.mode)}
                                    className="w-full text-left px-4 py-3 rounded-xl hover:bg-white/5 transition-colors"
                                  >
                                    <div className="text-[11px] text-white uppercase tracking-[0.2em]">
                                      {option.label}
                                    </div>
                                    <div className="text-[9px] font-mono text-white/40 uppercase tracking-[0.2em]">
                                      {option.detail}
                                    </div>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>

                          {currentRun?.status === "running" && (
                            <button
                              onClick={handleCancel}
                              className="px-4 border border-red-400/40 rounded-2xl hover:bg-red-500/10 hover:border-red-300 transition-all text-red-200 uppercase text-[10px] tracking-[0.2em] font-mono"
                            >
                              Cancel
                            </button>
                          )}

                          {needsReview && (
                            <button
                              onClick={() => setIsReviewOpen((prev) => !prev)}
                              className="px-4 border border-amber-400/40 rounded-2xl hover:bg-amber-400/10 hover:border-amber-300 transition-all text-amber-200 uppercase text-[10px] tracking-[0.2em] font-mono"
                            >
                              Review
                            </button>
                          )}

                          <button
                            onClick={handleExport}
                            className="px-4 border border-white/10 rounded-2xl hover:bg-white/5 hover:border-white/30 transition-all text-white/70 uppercase text-[10px] tracking-[0.2em] font-mono"
                          >
                            Export
                          </button>
                        </div>

                        {needsReview && isReviewOpen && (
                          <div className="rounded-2xl border border-white/10 bg-black/40 p-4 space-y-3">
                            <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-white/60">
                              HITL Review Notes
                            </div>
                            <textarea
                              value={reviewNotes}
                              onChange={(event) => setReviewNotes(event.target.value)}
                              placeholder="Notes for review decision"
                              className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-[11px] text-white/70 outline-none focus:border-cyan-400/50"
                              rows={3}
                            />
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleReview("approve")}
                                className="flex-1 py-2 rounded-xl bg-cyan-400/80 text-black text-[10px] font-mono uppercase tracking-[0.2em] hover:bg-cyan-300"
                              >
                                Approve
                              </button>
                              <button
                                onClick={() => handleReview("reject")}
                                className="flex-1 py-2 rounded-xl border border-red-400/60 text-red-200 text-[10px] font-mono uppercase tracking-[0.2em] hover:bg-red-500/10"
                              >
                                Reject
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                      <OverlayEffects className="rounded-[2rem]" />
                    </div>
                  )}
                </div>
              </div>
            )}
          </main>
        </div>

        <aside
          className={`h-full border-l border-transparent flex flex-col items-center py-6 relative pointer-events-none overflow-hidden transition-[width,transform,opacity,background-color,backdrop-filter] duration-500 ${
            isExpanded
              ? "w-12 opacity-100 bg-black/10 backdrop-blur-sm translate-x-0 border-cyan-500/10"
              : "w-0 opacity-0 bg-transparent backdrop-blur-none translate-x-4"
          }`}
        >
          <TickMarks count={26} orientation="vertical" />
          <div className="flex-1" />
          <div className="w-6 h-px bg-cyan-500/20 mb-4" />
          <OverlayEffects />
        </aside>
      </div>

      {showIntake && (
        <div className="fixed inset-0 z-[700] flex items-center justify-center p-6 bg-black/60 backdrop-blur-xl fade-zoom-in">
          <div className="w-full max-w-2xl bg-[#0a0c10] border border-cyan-500/30 rounded-[3rem] p-12 shadow-[0_0_100px_rgba(0,0,0,0.8)] relative overflow-hidden">
            <TickMarks count={50} />

            <div className="flex justify-between items-center mb-10 border-b border-white/10 pb-8">
              <div className="flex items-center">
                <div className="w-10 h-10 rounded-full bg-cyan-500/20 flex items-center justify-center mr-4 border border-cyan-500/40">
                  <Layers className="text-cyan-400" />
                </div>
                <div>
                  <h2 className="text-lg font-bold tracking-[0.3em] text-white uppercase">Brand Intake</h2>
                  <p className="text-[9px] font-mono text-cyan-400 opacity-50 uppercase tracking-[0.2em]">
                    Intake Ready
                  </p>
                </div>
              </div>
              <X
                onClick={() => setShowIntake(false)}
                className="cursor-pointer text-white/20 hover:text-white transition-colors"
              />
            </div>

            <div className="space-y-8">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-[10px] uppercase font-mono opacity-40 ml-1 tracking-widest">
                    Client Name
                  </label>
                  <input
                    type="text"
                    placeholder="Client name"
                    className="w-full bg-white/5 border border-white/10 p-5 rounded-2xl outline-none focus:border-cyan-400/50 font-mono text-white transition-all text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] uppercase font-mono opacity-40 ml-1 tracking-widest">
                    Brand Memory Protocol
                  </label>
                  <input
                    type="text"
                    placeholder={hud.intake.initial_configuration.llm}
                    className="w-full bg-white/5 border border-white/10 p-5 rounded-2xl outline-none focus:border-cyan-400/50 font-mono text-white transition-all text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {intakeModules.map((module) => (
                  <div
                    key={module.label}
                    className="p-5 rounded-3xl bg-white/5 border border-white/10 hover:border-cyan-400/40 transition-all cursor-pointer group text-center"
                  >
                    <span className="block text-[8px] opacity-30 mb-2 uppercase font-mono tracking-tighter">
                      {module.label}
                    </span>
                    <span className="font-bold text-xs tracking-widest group-hover:text-cyan-400 transition-colors">
                      {module.value}
                    </span>
                  </div>
                ))}
              </div>

              <button className="w-full py-6 bg-cyan-500 text-black font-black uppercase tracking-[0.4em] rounded-3xl shadow-[0_0_50px_rgba(34,211,238,0.3)] hover:bg-white transition-all active:scale-95">
                Create Client
              </button>
            </div>
            <OverlayEffects className="rounded-[3rem]" />
          </div>
        </div>
      )}
    </div>
  );
}
