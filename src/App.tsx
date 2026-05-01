import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import {
  ChevronDown,
  Dna,
  Download,
  Eye,
  FileText,
  Layers,
  Loader2,
  Play,
  PlusCircle,
  Radar,
  Settings2,
  ShieldCheck,
  Terminal,
  Workflow,
  X,
} from "lucide-react";
import hudData from "../hud.json";
import type { HudRoot } from "./types/hud";
import noiseTexture from "./assets/noise.svg";
import ReviewPanel from "./components/ReviewPanel";
import DeliverableTracker from "./components/DeliverableTracker";
import DeliverableTimeline from "./components/DeliverableTimeline";
import ShotDetailDrawer from "./components/ShotDetailDrawer";
import RecentRunsPanel from "./components/RecentRunsPanel";
import RunDetailDrawer from "./components/RunDetailDrawer";
import WatcherSignalsPanel from "./components/WatcherSignalsPanel";
import DriftAlertPanel from "./components/DriftAlertPanel";
import BaselinePanel from "./components/BaselinePanel";
import PromptEvolutionPanel from "./components/PromptEvolutionPanel";
import ReshootPanel from "./components/ReshootPanel";
import AnchorStillPanel, { EmptyAnchorState } from "./components/AnchorStillPanel";
import ActiveClientBadge from "./components/ActiveClientBadge";
import CampaignDashboard from "./components/CampaignDashboard";
import AuditTriageTable from "./components/AuditTriageTable";
import ReviewGateEscalationSurface from "./components/ReviewGateEscalationSurface";
import type { AuditReportShot } from "./lib/auditReport";
import {
  createRun,
  cancelRun,
  subscribeToLogs,
  approveReview,
  exportRun,
  getClients,
  subscribeToClients,
  getPendingReviewRuns,
  getPendingReviewCount,
  getClientRuns,
  getOpenReviewGateEscalations,
  subscribeToAssetEscalations,
  type Campaign,
  type Run,
  type RunLog,
  type RunMode,
  type Client,
} from "./api";

type Orientation = "horizontal" | "vertical";
type PillarId = "memory" | "creative" | "drift" | "review" | "insight";
type CreativeSubtab = "deliverables" | "reshoots" | "stills";
type ShotDrawerTab = "narrative" | "critic" | "orchestrator" | "timeline";
type SelectedShot = {
  n: number | null;
  id: string | null;
  runId?: string;
  auditShot?: AuditReportShot | null;
  initialTab?: ShotDrawerTab;
};

type LogEntry = {
  time: string;
  msg: string;
  status: "OK" | "WAIT" | "BUSY";
  stage?: string;
};

type DerivedClient = Client & {
  alert: boolean;
  dnaCode: string;
  displayName: string;
  entityLabel: string;
  featured: boolean;
  health: number;
  runsValue: number;
  runsLabel: string;
  typeLabel: string;
  statusLabel: string;
};

const hudRoot = hudData as HudRoot;
const hud = hudRoot.hud;
const placeholders = hud.data_model?.empty_states?.missing_fields?.placeholders ?? {};

const statusLabels: Record<string, string> = {
  active: "ACTIVE",
  pending: "PENDING",
  completed: "COMPLETED",
};

const typeByName: Record<string, string> = {
  Cylndr: "CORE",
  "Jenni Kayne": "RETAIL",
  Lilydale: "AGRI",
};

const clientUiConfig: Record<string, { displayName?: string; entityLabel?: string; featured?: boolean }> = {
  "client_drift-mv": { displayName: "BrandStudios", entityLabel: "Agency", featured: true },
};

const seedLogs: LogEntry[] = [
  { time: "12:04:22", msg: "BRAND_MEMORY_LOADED", status: "OK" },
  { time: "12:04:23", msg: "SYNCING_CREATIVE_STUDIO", status: "WAIT" },
  { time: "12:04:25", msg: "AGENT_READY", status: "OK" },
];

const logActions = [
  "BRAND_MEMORY_INDEX",
  "CREATIVE_GENERATE",
  "DRIFT_CHECK",
  "VEO_RENDER",
  "EXPORT_PACKAGE",
  "HITL_REVIEW",
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

const TickMarks = ({ count = 40, orientation = "horizontal" }: { count?: number; orientation?: Orientation }) => (
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
        className={`${
          orientation === "horizontal" ? "w-px" : "h-px"
        } bg-cyan-400/30 ${
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

const CircularTelemetry = ({ percent, label, color = "cyan" }: { percent: number; label: string; color?: "cyan" | "amber" }) => {
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

const formatDna = (value: string | null | undefined, fallback: string) => {
  if (!value) {
    return fallback;
  }
  const cleaned = value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.length > 14 ? cleaned.slice(0, 14) : cleaned;
};

const formatRunsLabel = (value: number) => String(value).padStart(3, "0");

const computeHealth = (status: string, runs: number, index: number) => {
  const base = status === "active" ? 86 : status === "pending" ? 42 : status === "completed" ? 78 : 60;
  const variance = (runs % 12) + index * 2;
  return Math.min(99, Math.max(18, base + variance));
};

const pillarForClient = (client: Pick<DerivedClient, "featured">): PillarId => (
  client.featured ? "creative" : "memory"
);

const getClientIdFromUrl = (availableClients: DerivedClient[]) => {
  if (typeof window === "undefined") return null;
  const requested = new URLSearchParams(window.location.search).get("client");
  return requested && availableClients.some((client) => client.id === requested)
    ? requested
    : null;
};

const getDefaultClient = (availableClients: DerivedClient[]) => (
  availableClients.find((client) => client.featured) ?? availableClients[0] ?? null
);

const updateClientUrl = (clientId: string) => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("client", clientId);
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
};

const buildClients = (list: Client[]): DerivedClient[] => {
  const placeholderDna = typeof placeholders.dna === "string" ? placeholders.dna : "DNA_UNSET";

  return list.map((client, index) => {
    const status = client.status ?? "active";
    const uiConfig = clientUiConfig[client.id];
    // Use last run status to simulate run count
    const runsValue = client.lastRunStatus ? 1 : 0;
    return {
      ...client,
      alert: client.lastRunStatus === "needs_review",
      dnaCode: formatDna(client.id, placeholderDna),
      displayName: uiConfig?.displayName ?? client.name,
      entityLabel: uiConfig?.entityLabel ?? "Brand",
      featured: Boolean(uiConfig?.featured),
      health: computeHealth(status, runsValue, index),
      runsValue,
      runsLabel: formatRunsLabel(runsValue),
      typeLabel: typeByName[client.name] ?? "CUSTOM",
      statusLabel: statusLabels[status] ?? status.toUpperCase(),
    };
  });
};

export default function App() {
  // Client state - load from Supabase
  const [clients, setClients] = useState<DerivedClient[]>([]);
  const [isLoadingClients, setIsLoadingClients] = useState(true);
  const [clientError, setClientError] = useState<string | null>(null);

  const [isExpanded, setIsExpanded] = useState(false);
  const [activeClient, setActiveClient] = useState<string>("");
  const [showIntake, setShowIntake] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>(seedLogs);
  const [isClientDetailOpen, setIsClientDetailOpen] = useState(false);

  const [position, setPosition] = useState({ x: 100, y: 100 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const hasMovedRef = useRef(false);
  const [activePillar, setActivePillar] = useState<PillarId>("creative");
  const [creativeSubtab, setCreativeSubtab] = useState<CreativeSubtab>("deliverables");
  const [showRunMenu, setShowRunMenu] = useState(false);
  const [showReviewPanel, setShowReviewPanel] = useState(false);
  const [finalHitlShotNumber, setFinalHitlShotNumber] = useState<number | null>(null);
  const [pendingReviewRuns, setPendingReviewRuns] = useState<Run[]>([]);
  const [globalPendingCount, setGlobalPendingCount] = useState(0);
  const [openEscalationCount, setOpenEscalationCount] = useState(0);

  // Run state
  const [currentRun, setCurrentRun] = useState<Run | null>(null);
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [selectedShot, setSelectedShot] = useState<SelectedShot>({ n: null, id: null });
  const [selectedRunDetailId, setSelectedRunDetailId] = useState<string | null>(null);
  const [selectedAnchorShot, setSelectedAnchorShot] = useState<number | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const logsContainerRef = useRef<HTMLDivElement>(null);

  const teardownRunSubscriptions = useCallback(() => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
  }, []);

  // Fetch clients from Supabase on mount
  useEffect(() => {
    async function loadClients() {
      try {
        setIsLoadingClients(true);
        const data = await getClients();
        const derived = buildClients(data);
        setClients(derived);
        if (derived.length > 0) {
          const initialClientId = getClientIdFromUrl(derived) ?? getDefaultClient(derived)?.id;
          const initialClient = derived.find((client) => client.id === initialClientId) ?? derived[0];
          setActiveClient(initialClient.id);
          setActivePillar(pillarForClient(initialClient));
          setIsClientDetailOpen(true);
          setIsExpanded(true);
        }
      } catch (err) {
        setClientError(err instanceof Error ? err.message : "Failed to load clients");
      } finally {
        setIsLoadingClients(false);
      }
    }
    loadClients();
  }, []);

  // Subscribe to client updates
  useEffect(() => {
    const unsubscribe = subscribeToClients((updatedClient) => {
      setClients((prev) => {
        const index = prev.findIndex((c) => c.id === updatedClient.id);
        if (index === -1) {
          // New client
          return [...prev, ...buildClients([updatedClient])];
        }
        // Update existing client
        const updated = [...prev];
        updated[index] = buildClients([updatedClient])[0];
        return updated;
      });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!activeClient) return;
    let cancelled = false;

    async function hydrateCampaignRun() {
      try {
        const runs = await getClientRuns(activeClient);
        if (cancelled) return;
        const latestCampaignRun = runs.find((run) => run.campaignId);
        const featuredRun = clientUiConfig[activeClient]?.featured
          ? runs.find((run) => run.runId.startsWith("9bfdf23e"))
          : undefined;
        const preferredRun = featuredRun ?? latestCampaignRun;
        setCurrentRun((previous) => {
          if (previous?.clientId === activeClient && previous.campaignId && previous.runId === preferredRun?.runId) {
            return previous;
          }
          return preferredRun ?? null;
        });
      } catch {
        // Non-critical — creative view can still operate without a hydrated run.
      }
    }

    void hydrateCampaignRun();
    return () => {
      cancelled = true;
    };
  }, [activeClient]);


  useEffect(() => {
    const handleOpenFinalHitl = (event: Event) => {
      const detail = (event as CustomEvent<{ shotNumber?: unknown }>).detail;
      const shotNumber = typeof detail?.shotNumber === "number" ? detail.shotNumber : null;
      setFinalHitlShotNumber(shotNumber);
      setActivePillar("review");
      setShowReviewPanel(true);
    };

    window.addEventListener("brandstudios:open-final-hitl", handleOpenFinalHitl);
    return () => window.removeEventListener("brandstudios:open-final-hitl", handleOpenFinalHitl);
  }, []);

  // Fetch pending HITL reviews for the active client + global count
  useEffect(() => {
    if (!activeClient) return;
    let cancelled = false;
    setPendingReviewRuns([]);
    async function loadPendingReviews() {
      try {
        const [clientRuns, count] = await Promise.all([
          getPendingReviewRuns(activeClient),
          getPendingReviewCount(),
        ]);
        if (cancelled) return;
        setPendingReviewRuns(clientRuns);
        setGlobalPendingCount(count);
      } catch {
        // Silently fail — non-critical
      }
    }
    loadPendingReviews();
    return () => {
      cancelled = true;
    };
  }, [activeClient]);

  // Track escalation-level HITL independently from legacy run.status review queue.
  useEffect(() => {
    if (!activeClient) {
      setOpenEscalationCount(0);
      return undefined;
    }
    let cancelled = false;

    const refreshOpenEscalations = async () => {
      try {
        const items = await getOpenReviewGateEscalations(activeClient, 30);
        if (!cancelled) setOpenEscalationCount(items.length);
      } catch {
        if (!cancelled) setOpenEscalationCount(0);
      }
    };

    void refreshOpenEscalations();
    const unsubscribe = subscribeToAssetEscalations(activeClient, () => {
      void refreshOpenEscalations();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [activeClient]);

  const runMenuOptions = [
    { id: "full", label: "Full Pipeline", mode: "full" },
    { id: "ingest", label: "Ingest and Index", mode: "ingest", pillar: "Brand Memory" },
    { id: "images", label: "Generate Images", mode: "images", pillar: "Creative Studio" },
    { id: "video", label: "Generate Video", mode: "video", pillar: "Creative Studio" },
    { id: "drift", label: "Drift Check", mode: "drift", pillar: "Brand Drift" },
    { id: "export", label: "Export Package", mode: "export" },
  ];

  const pillars = [
    { id: "memory" as const, label: "Brand Memory", description: "Ingest and index brand assets" },
    { id: "creative" as const, label: "Creative Studio", description: "Generate images and video" },
    { id: "drift" as const, label: "Brand Drift", description: "Brand compliance scoring and drift metrics" },
    { id: "review" as const, label: "Review Gate", description: "Human-in-the-loop review and approval" },
  ];

  const currentClient = clients.find((client) => client.id === activeClient) ?? null;
  const isFeaturedClient = Boolean(currentClient?.featured);
  const reviewAttentionCount = pendingReviewRuns.length + openEscalationCount;
  const isCampaignDashboard = Boolean(currentClient && isClientDetailOpen && !selectedCampaign);
  const isAnchorStillLayout = activePillar === "creative" && creativeSubtab === "stills" && isFeaturedClient && Boolean(selectedCampaign);
  const workspaceMaxClass = isAnchorStillLayout
    ? "max-w-[1320px]"
    : isCampaignDashboard || selectedCampaign
      ? "max-w-[1180px]"
      : "max-w-[620px]";
  const selectedCampaignName = selectedCampaign?.name.split("—")[0]?.trim() || selectedCampaign?.name || "Campaign";
  const selectedCampaignSubtitle = selectedCampaign && selectedCampaignName !== selectedCampaign.name
    ? selectedCampaign.name
    : null;

  const intakeModules = [
    { label: "LLM", value: hud.intake.initial_configuration.llm },
    { label: "Agent Tool", value: hud.intake.initial_configuration.agent_tool },
    { label: "Creative Tool", value: hud.intake.initial_configuration.creative_tool },
  ];

  useEffect(() => {
    if (!isExpanded) {
      setIsClientDetailOpen(false);
    }
  }, [isExpanded]);

  useEffect(() => {
    setSelectedAnchorShot(null);
  }, [activeClient, creativeSubtab]);

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

  const handleClientSwitch = useCallback((nextClientId: string) => {
    if (nextClientId === activeClient) {
      setIsClientDetailOpen((prev) => !prev);
      return;
    }

    const nextClient = clients.find((client) => client.id === nextClientId);
    if (!nextClient) return;

    teardownRunSubscriptions();

    setCurrentRun(null);
    setSelectedCampaign(null);
    setPendingReviewRuns([]);
    setSelectedShot({ n: null, id: null });
    setSelectedRunDetailId(null);
    setShowReviewPanel(false);
    setFinalHitlShotNumber(null);
    setIsRunning(false);
    setRunError(null);
    setCurrentStage(null);
    setLogs(seedLogs);
    setShowRunMenu(false);
    setCreativeSubtab("deliverables");
    setActivePillar(pillarForClient(nextClient));
    setIsClientDetailOpen(true);

    setActiveClient(nextClientId);
    updateClientUrl(nextClientId);
  }, [activeClient, clients, teardownRunSubscriptions]);

  const handleCampaignSelect = useCallback((campaign: Campaign, run: Run | null) => {
    teardownRunSubscriptions();
    setSelectedCampaign(campaign);
    setCurrentRun(run);
    setSelectedShot({ n: null, id: null });
    setSelectedRunDetailId(null);
    setSelectedAnchorShot(null);
    setShowReviewPanel(false);
    setFinalHitlShotNumber(null);
    setRunError(null);
    setCurrentStage(null);
    setShowRunMenu(false);
    setCreativeSubtab("deliverables");
    setActivePillar("creative");
  }, [teardownRunSubscriptions]);

  useEffect(() => {
    // Only show seed logs when not running a real run
    if (!isExpanded || isRunning) return;
    const interval = window.setInterval(() => {
      setLogs((prev) => {
        const action = logActions[Math.floor(Math.random() * logActions.length)];
        const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
        const now = new Date().toLocaleTimeString("en-US", { hour12: false });
        const next: LogEntry[] = [
          ...prev,
          {
            time: now,
            msg: `${action}_${suffix}`,
            status: Math.random() > 0.2 ? "OK" : "BUSY",
          },
        ];
        if (next.length > 6) next.shift();
        return next;
      });
    }, 3000);
    return () => window.clearInterval(interval);
  }, [isExpanded, activeClient, isRunning]);

  useEffect(() => {
    setSelectedShot({ n: null, id: null });
  }, [currentRun?.runId]);

  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = "image/svg+xml";
    link.href =
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230b0b0f'/%3E%3Cpath d='M18 32h28' stroke='%2322d3ee' stroke-width='6' stroke-linecap='round'/%3E%3Cpath d='M24 20v24' stroke='%2322d3ee' stroke-width='6' stroke-linecap='round'/%3E%3C/svg%3E";
  }, []);

  // Cleanup SSE subscription on unmount
  useEffect(() => {
    return teardownRunSubscriptions;
  }, [teardownRunSubscriptions]);

  const handleAuditLog = useCallback((log: RunLog) => {
    if (log.stage && log.stage !== "system") {
      setCurrentStage(log.stage);
    }
    setLogs((prev) => {
      const entry: LogEntry = {
        time: new Date(log.timestamp).toLocaleTimeString("en-US", { hour12: false }),
        msg: log.message,
        status: log.level === "error" ? "WAIT" : log.level === "warn" ? "BUSY" : "OK",
        stage: log.stage,
      };
      const next = [...prev, entry];
      if (next.length > 50) next.shift();
      return next;
    });
    setTimeout(() => {
      if (logsContainerRef.current) {
        logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
      }
    }, 10);
  }, []);

  const handleAuditRunStarted = useCallback((run: Run) => {
    teardownRunSubscriptions();
    setCurrentRun(run);
    setRunError(null);
    setIsRunning(true);
    setCurrentStage("grade");
    const now = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLogs([{ time: now, msg: `AUDIT_STARTED_${run.runId.slice(0, 8).toUpperCase()}`, status: "BUSY", stage: "grade" }]);
  }, [teardownRunSubscriptions]);

  const handleAuditRunSettled = useCallback((run: Run) => {
    setCurrentRun(run);
    setIsRunning(false);
    setCurrentStage(null);
    const now = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLogs((prev) => [
      ...prev,
      {
        time: now,
        msg: `AUDIT_${run.status.toUpperCase()}`,
        status: run.status === "completed" ? "OK" : "WAIT",
        stage: "complete",
      },
    ]);
  }, []);

  const handleStartRun = useCallback(async (mode: RunMode) => {
    if (!activeClient) return;
    // Cleanup previous subscription
    teardownRunSubscriptions();

    setRunError(null);
    setIsRunning(true);
    setLogs([]); // Clear logs for new run

    try {
      // Create a new run via API
      const run = await createRun(activeClient, mode);
      setCurrentRun(run);

      // Add initial log entry
      const now = new Date().toLocaleTimeString("en-US", { hour12: false });
      setLogs([{ time: now, msg: `RUN_STARTED_${mode.toUpperCase()}`, status: "BUSY", stage: "init" }]);

      // Subscribe to SSE logs
      const unsubscribe = subscribeToLogs(
        run.runId,
        (log: RunLog) => {
          // Track current stage
          if (log.stage && log.stage !== "system") {
            setCurrentStage(log.stage);
          }
          setLogs((prev) => {
            const entry: LogEntry = {
              time: new Date(log.timestamp).toLocaleTimeString("en-US", { hour12: false }),
              msg: log.message,
              status: log.level === "error" ? "WAIT" : log.level === "warn" ? "BUSY" : "OK",
              stage: log.stage,
            };
            const next = [...prev, entry];
            if (next.length > 50) next.shift(); // Keep more logs during real runs
            return next;
          });
          // Auto-scroll to bottom
          setTimeout(() => {
            if (logsContainerRef.current) {
              logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
            }
          }, 10);
        },
        (result) => {
          // Run completed
          setIsRunning(false);
          setCurrentRun((prev) => prev ? { ...prev, status: result.status } : null);
          const now = new Date().toLocaleTimeString("en-US", { hour12: false });
          setLogs((prev) => [
            ...prev,
            {
              time: now,
              msg: `RUN_${result.status.toUpperCase()}`,
              status: result.status === "completed" ? "OK" : "WAIT",
              stage: "complete",
            },
          ]);
        },
        (error) => {
          // Connection error
          setIsRunning(false);
          setRunError(error.message);
          const now = new Date().toLocaleTimeString("en-US", { hour12: false });
          setLogs((prev) => [
            ...prev,
            { time: now, msg: `SSE_ERROR: ${error.message}`, status: "WAIT", stage: "error" },
          ]);
        }
      );

      unsubscribeRef.current = unsubscribe;
    } catch (err) {
      setIsRunning(false);
      setRunError(err instanceof Error ? err.message : "Failed to start run");
      const now = new Date().toLocaleTimeString("en-US", { hour12: false });
      setLogs((prev) => [
        ...prev,
        { time: now, msg: `RUN_FAILED: ${err instanceof Error ? err.message : "Unknown error"}`, status: "WAIT" },
      ]);
    }
  }, [activeClient, teardownRunSubscriptions]);

  const handleReviewComplete = useCallback(async () => {
    setShowReviewPanel(false);
    // Refresh run state
    if (currentRun) {
      try {
        const updated = await approveReview(currentRun.runId);
        if (updated.clientId === activeClient) {
          setCurrentRun(updated);
        }
      } catch {
        // Run may already be updated — just log
      }
    }
    const now = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLogs((prev) => [...prev, { time: now, msg: "HITL_REVIEW_SUBMITTED", status: "OK" }]);
    // Refresh pending review counts
    try {
      const [clientRuns, count] = await Promise.all([
        getPendingReviewRuns(activeClient),
        getPendingReviewCount(),
      ]);
      setPendingReviewRuns(clientRuns);
      setGlobalPendingCount(count);
    } catch {
      // Non-critical
    }
  }, [currentRun, activeClient]);

  const handleExport = useCallback(async () => {
    if (!currentRun) return;
    try {
      const result = await exportRun(currentRun.runId);
      const now = new Date().toLocaleTimeString("en-US", { hour12: false });
      setLogs((prev) => [...prev, { time: now, msg: `EXPORTED_${result.artifacts.length}_ARTIFACTS`, status: "OK" }]);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Failed to export");
    }
  }, [currentRun]);

  const handleCancelRun = useCallback(async () => {
    if (!currentRun) return;
    try {
      await cancelRun(currentRun.runId);
      // Cleanup SSE subscription
      teardownRunSubscriptions();
      setIsRunning(false);
      setCurrentStage(null);
      const now = new Date().toLocaleTimeString("en-US", { hour12: false });
      setLogs((prev) => [...prev, { time: now, msg: "RUN_CANCELLED", status: "WAIT" }]);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Failed to cancel run");
    }
  }, [currentRun, teardownRunSubscriptions]);

  return (
    <div className="h-screen w-screen text-cyan-50 font-sans overflow-hidden flex relative selection:bg-cyan-500/40 bg-[#141821]">
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
            Standby
          </div>
        )}
      </div>

      <div
	        className={`min-w-0 flex-1 flex flex-row relative z-20 transition-all duration-1000 ease-out ${
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
              {isLoadingClients ? (
                <div className="p-2">
                  <Loader2 size={16} className="text-cyan-400 animate-spin" />
                </div>
              ) : clientError ? (
                <div className="p-2 text-[8px] text-red-400 text-center">
                  Error loading
                </div>
              ) : clients.map((client) => (
                <button
                  key={client.id}
                  onClick={() => handleClientSwitch(client.id)}
                  className={`group relative flex items-center justify-center transition-all duration-500 ${
                    activeClient === client.id
                      ? "scale-110"
                      : "scale-90 opacity-40 hover:opacity-100"
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
                    {client.displayName}
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

        <div className="flex-1 flex flex-col relative min-h-0 min-w-0">
          <div className="pt-2 px-4 sm:px-8 md:px-10 shrink-0">
            <nav className="group h-9 w-full max-w-2xl ml-0 sm:ml-8 border border-cyan-500/10 bg-black/25 backdrop-blur-md flex items-center justify-between px-4 sm:px-6 rounded-full transition-all duration-300 hover:bg-black/35 hover:border-cyan-400/30 relative overflow-hidden">
              <TickMarks count={80} />

              <div className="flex items-center space-x-6 text-[8px] font-mono tracking-[0.35em] z-10">
                <span className="text-cyan-400 flex items-center animate-pulse">
                  <ShieldCheck size={11} className="mr-2" /> Core Sync Ready
                </span>
                <span className="text-white/40 hidden sm:flex items-center">
                  LATENCY: <span className="text-white ml-2">0.0004ms</span>
                </span>
                <span className="text-white/40 hidden md:flex items-center uppercase">
                  Uptime: <span className="text-white ml-2">99.98%</span>
                </span>
              </div>

              <div className="flex items-center space-x-4 z-10">
                {/* HITL Review notification badge */}
                {globalPendingCount > 0 && (
                  <button
                    onClick={() => {
                      if (pendingReviewRuns.length > 0) {
                        setCurrentRun(pendingReviewRuns[0]);
                        setShowReviewPanel(true);
                      }
                    }}
                    className="flex items-center space-x-1.5 px-2.5 py-1 rounded-full bg-amber-500/20 border border-amber-500/40 hover:bg-amber-500/30 transition-all cursor-pointer group"
                    title="Pending HITL reviews"
                  >
                    <Eye size={10} className="text-amber-400" />
                    <span className="text-[8px] font-mono font-bold text-amber-400 tracking-wider">
                      {globalPendingCount}
                    </span>
                    <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  </button>
                )}
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

          <main className="flex-1 p-4 md:p-10 flex flex-col items-start justify-start relative overflow-y-auto min-h-0 min-w-0">
            {selectedCampaign && currentRun?.runId && (
              <div className="pointer-events-auto absolute right-6 top-6 z-30">
                <WatcherSignalsPanel
                  key={currentRun.runId}
                  runId={currentRun.runId}
                  runStatus={currentRun.status}
                  onCancelled={() => {
                    setIsRunning(false);
                    setCurrentStage(null);
                    setCurrentRun((previous) => (
                      previous ? { ...previous, status: "cancelled" } : previous
                    ));
                  }}
                />
              </div>
            )}
            <div className="absolute inset-0 pointer-events-none opacity-20 flex items-center justify-center overflow-hidden">
              <div className="w-[800px] h-[800px] border border-cyan-500/10 rounded-full absolute animate-[ping_10s_linear_infinite]" />
              <div className="w-[1200px] h-[1200px] border border-cyan-500/5 rounded-full absolute" />
              <div className="absolute top-1/2 left-0 w-full h-px bg-cyan-500/5" />
              <div className="absolute top-0 left-1/2 w-px h-full bg-cyan-500/5" />
            </div>

            {currentClient && isClientDetailOpen && (
              <div className={`w-full min-w-0 z-10 space-y-4 ml-0 md:ml-4 ${workspaceMaxClass}`}>
                <div className="flex items-end space-x-6 md:space-x-8 fade-slide-in">
                  <div className="h-20 md:h-24 w-1.5 bg-gradient-to-b from-cyan-400 to-transparent shadow-[0_0_30px_cyan]" />
                  <div className="space-y-2">
                    <h1 className="text-3xl sm:text-4xl md:text-5xl xl:text-6xl font-black italic tracking-tighter uppercase leading-none text-white drop-shadow-2xl break-words sm:whitespace-nowrap">
                      {currentClient.displayName}
                    </h1>
                    <div className="flex items-center space-x-4">
                      <p className="text-[11px] font-mono tracking-[0.5em] text-cyan-400/60 uppercase">
                        {currentClient.entityLabel} Memory <span className="text-white/40 text-[9px] ml-2">{currentClient.dnaCode}</span>
                      </p>
                      <div className="h-px w-20 bg-cyan-500/30" />
                      <span className="px-2 py-0.5 border border-cyan-500/50 rounded text-[8px] font-mono text-cyan-400 bg-cyan-500/10">
                        TYPE_{currentClient.typeLabel}
                      </span>
                      <span className="px-2 py-0.5 border border-white/10 rounded text-[8px] font-mono text-white/60 bg-white/5">
                        {currentClient.statusLabel}
                      </span>
                    </div>
                  </div>
                </div>

                {!selectedCampaign ? (
                  <CampaignDashboard
                    clientId={currentClient.id}
                    brandName={currentClient.displayName}
                    onCampaignSelect={handleCampaignSelect}
                  />
                ) : (
                  <>
                <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 backdrop-blur-xl">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-[8px] font-mono uppercase tracking-[0.28em] text-cyan-200/45">
                        {currentClient.displayName} / Campaigns / Active Workspace
                      </p>
                      <h2 className="mt-1 truncate text-xl font-black uppercase italic tracking-tight text-white">
                        {selectedCampaignName}
                      </h2>
                      {selectedCampaignSubtitle && (
                        <p className="mt-1 truncate text-[9px] font-mono uppercase tracking-[0.18em] text-white/35">
                          {selectedCampaignSubtitle}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedCampaign(null);
                        setSelectedShot({ n: null, id: null });
                        setSelectedRunDetailId(null);
                        setSelectedAnchorShot(null);
                        setShowRunMenu(false);
                      }}
                      className="inline-flex shrink-0 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-[8px] font-mono uppercase tracking-[0.22em] text-cyan-100 transition-all hover:border-cyan-300/45 hover:bg-cyan-300 hover:text-black"
                    >
                      <ChevronDown size={12} className="mr-2 rotate-90" />
                      Campaigns
                    </button>
                  </div>
                </div>

                <ActiveClientBadge client={currentClient} />

                {/* Four Pillars Tabs */}
                <div className="flex space-x-1 bg-black/20 p-1 rounded-xl border border-white/5">
                  {pillars.map((pillar) => (
	                    <button
	                      key={pillar.id}
	                      onClick={() => setActivePillar(pillar.id)}
	                      className={`min-w-0 flex-1 truncate py-2 px-2 sm:px-3 text-[8px] sm:text-[9px] font-mono uppercase tracking-wider rounded-lg transition-all ${
                        activePillar === pillar.id
                          ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                          : "text-white/40 hover:text-white/70 hover:bg-white/5"
                      }`}
                    >
                      {pillar.label}
                    </button>
                  ))}
                </div>

                {/* Pillar Content */}
                <div className="bg-black/10 border border-white/5 backdrop-blur-xl rounded-xl p-4 min-h-[80px]">
                  <p className="text-[10px] font-mono text-white/40">
                    {pillars.find(p => p.id === activePillar)?.description}
                  </p>

                  {/* Review Gate: show escalation-level HITL plus legacy run queue */}
                  {activePillar === "review" ? (
                    <div className="space-y-3">
                      <ReviewGateEscalationSurface
                        clientId={activeClient}
                        onCountChange={setOpenEscalationCount}
                        onOpenDeliverable={({ deliverableId, runId, shotNumber }) => {
                          setSelectedShot({
                            n: shotNumber,
                            id: deliverableId,
                            runId,
                            initialTab: "orchestrator",
                          });
                        }}
                      />

                      {pendingReviewRuns.length > 0 ? (
                        <div className="space-y-2 rounded-2xl border border-white/10 bg-black/20 p-3">
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] font-mono text-amber-400/80 uppercase tracking-widest flex items-center">
                              <Eye size={10} className="mr-1.5" />
                              {pendingReviewRuns.length} run{pendingReviewRuns.length !== 1 ? "s" : ""} awaiting artifact review
                            </span>
                          </div>
                          {pendingReviewRuns.map((run) => (
                            <button
                              key={run.runId}
                              onClick={() => {
                                setCurrentRun(run);
                                setShowReviewPanel(true);
                              }}
                              className="w-full flex items-center justify-between p-3 rounded-xl bg-amber-500/5 border border-amber-500/20 hover:bg-amber-500/10 hover:border-amber-500/30 transition-all group text-left"
                            >
                              <div className="min-w-0">
                                <p className="text-[10px] font-mono text-white truncate">
                                  {run.mode.toUpperCase()} — {new Date(run.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}
                                </p>
                                <p className="text-[8px] font-mono text-white/30 uppercase tracking-wider">
                                  Run {run.runId.slice(0, 8)}
                                </p>
                              </div>
                              <div className="flex items-center space-x-2 shrink-0 ml-2">
                                <span className="text-[8px] font-mono text-amber-400 uppercase px-2 py-0.5 border border-amber-500/30 bg-amber-500/10 rounded">
                                  Review
                                </span>
                                <ChevronDown size={12} className="text-white/20 -rotate-90 group-hover:text-amber-400 transition-colors" />
                              </div>
                            </button>
                          ))}
                        </div>
                      ) : openEscalationCount === 0 ? (
                        <p className="text-[9px] font-mono text-cyan-400/40 mt-2 flex items-center">
                          <ShieldCheck size={10} className="mr-1.5" />
                          No run-level artifact reviews — all clear
                        </p>
                      ) : null}
                    </div>
	                  ) : activePillar === "creative" && activeClient ? (
	                    <>
                        {currentRun?.campaignId && (
                          <RecentRunsPanel
                            clientId={activeClient}
                            campaignId={currentRun.campaignId}
                            onRunClick={setSelectedRunDetailId}
                          />
                        )}
	                      <div className="mt-3 mb-2 flex rounded-xl border border-white/10 bg-black/20 p-1">
	                        {[
	                          { id: "deliverables" as const, label: "Deliverables" },
	                          ...(isFeaturedClient ? [
                              { id: "reshoots" as const, label: "Reshoots" },
                              { id: "stills" as const, label: "Stills + Anchors" },
                            ] : []),
	                        ].map((tab) => (
                          <button
                            key={tab.id}
                            type="button"
                            onClick={() => setCreativeSubtab(tab.id)}
	                            className={`min-w-0 flex-1 truncate rounded-lg px-2 sm:px-3 py-2 text-[7px] sm:text-[8px] font-mono uppercase tracking-[0.18em] sm:tracking-[0.24em] transition-all focus:outline-none focus:ring-2 focus:ring-cyan-400/40 ${
                              creativeSubtab === tab.id
                                ? "border border-cyan-500/30 bg-cyan-500/15 text-cyan-300"
                                : "border border-transparent text-white/35 hover:bg-white/5 hover:text-white/65"
                            }`}
                          >
                            {tab.label}
                          </button>
                        ))}
                      </div>
	                      {creativeSubtab === "reshoots" && isFeaturedClient ? (
	                        <ReshootPanel />
	                      ) : creativeSubtab === "stills" && isFeaturedClient ? (
                          <div className="space-y-3">
                            <div className="rounded-2xl border border-cyan-400/15 bg-cyan-400/5 px-4 py-3">
                              <p className="text-[9px] font-mono uppercase tracking-[0.24em] text-cyan-100/70">
                                Stills + Anchors
                              </p>
                              <p className="mt-1 text-[9px] leading-relaxed text-white/35">
                                Select a shot on the left to curate the campaign anchor still, reject starting frames, snapshot a new frame, or replace the hero visual.
                              </p>
                            </div>
	                          <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(360px,2fr)]">
                              <div className="order-2 min-w-0 lg:order-1">
	                              <ReshootPanel
	                                onShotSelect={setSelectedAnchorShot}
	                                activeShotNumber={selectedAnchorShot}
	                                openDrawerOnSelect={false}
	                              />
                              </div>
                              <div className="order-1 min-w-0 lg:order-2">
	                              {selectedAnchorShot != null ? (
	                                <AnchorStillPanel
	                                  productionSlug="drift-mv"
	                                  shotNumber={selectedAnchorShot}
	                                  campaignId={currentRun?.campaignId}
	                                />
	                              ) : (
	                                <EmptyAnchorState />
	                              )}
                              </div>
	                          </div>
                          </div>
	                      ) : (
                        <>
                          {isFeaturedClient && !currentRun?.campaignId ? (
                            <div className="flex flex-col items-center justify-center py-8">
                              <Loader2 size={18} className="text-cyan-400/50 animate-spin" />
                              <span className="mt-3 text-[9px] font-mono uppercase tracking-widest text-white/30">
                                Loading Drift MV run
                              </span>
                            </div>
                          ) : !currentRun?.campaignId ? (
                            <PromptEvolutionPanel key={activeClient} clientId={activeClient} />
                          ) : (
                            <>
                              {isFeaturedClient && (
                                <AuditTriageTable
                                  key={`audit:${activeClient}:${currentRun.campaignId}`}
                                  clientId={currentClient.id}
                                  campaignId={currentRun.campaignId}
                                  campaignName={selectedCampaignName}
                                  onAuditRunStarted={handleAuditRunStarted}
                                  onAuditRunSettled={handleAuditRunSettled}
                                  onAuditLog={handleAuditLog}
                                  onAuditShotClick={({ shotNumber, deliverableId, auditShot, runId }) => setSelectedShot({
                                    n: shotNumber,
                                    id: deliverableId,
                                    runId,
                                    auditShot,
                                    initialTab: "critic",
                                  })}
                                />
                              )}
                              {isFeaturedClient && <DeliverableTimeline />}
                              <DeliverableTracker
                                key={`${activeClient}:${currentRun.campaignId}:${currentRun.runId}`}
                                campaignId={currentRun.campaignId}
                                runId={currentRun.runId}
                                onShotClick={(n, id, options) => setSelectedShot({
                                  n,
                                  id,
                                  runId: options?.runId,
                                  initialTab: options?.initialTab,
                                })}
                              />
                            </>
                          )}
                        </>
                      )}
                    </>
                  ) : activePillar === "creative" ? (
                    <p className="text-[9px] font-mono text-white/20 mt-2 uppercase">
                      Select a BrandStudios workspace to manage prompt evolution
                    </p>
                  ) : activePillar === "drift" && activeClient ? (
                    <>
                      <BaselinePanel key={`baseline:${activeClient}`} clientId={activeClient} />
                      <DriftAlertPanel key={`drift:${activeClient}`} clientId={activeClient} currentRunId={currentRun?.runId} />
                    </>
                  ) : activePillar === "drift" ? (
                    <p className="text-[9px] font-mono text-white/20 mt-2 uppercase">
                      Select a BrandStudios workspace to view drift alerts
                    </p>
                  ) : activePillar === "insight" ? (
                    <div className="mt-3 rounded-2xl border border-[#ED4C14]/25 bg-[#ED4C14]/10 px-4 py-5">
                      <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-orange-200/80">
                        Insight Loop coming soon
                      </p>
                      <p className="mt-2 text-[9px] leading-relaxed text-white/35">
                        External asset performance and engagement tracking will appear here once Phase 8 starts.
                      </p>
                    </div>
                  ) : (
                    <p className="text-[9px] font-mono text-white/20 mt-2 uppercase">
                      Select a pillar to continue
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-4">
                  <div className="bg-black/20 border border-white/5 backdrop-blur-2xl rounded-[2rem] p-5 flex flex-col justify-between shadow-2xl relative group overflow-hidden">
                    <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-transparent via-cyan-400 to-transparent opacity-30" />
                    <div className="flex justify-between items-center mb-3">
                      <span className="text-[10px] font-mono tracking-widest opacity-40 uppercase">
                        Signals
                      </span>
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
                        <span className="text-[8px] opacity-40 uppercase font-mono mb-1">Agents</span>
                        <span className="text-2xl font-bold font-mono tracking-tighter">
                          {currentClient.runsLabel}
                        </span>
                      </div>
                      <div className="bg-white/5 p-3 rounded-2xl border border-white/5 flex flex-col items-center">
                        <span className="text-[8px] opacity-40 uppercase font-mono mb-1">Health</span>
                        <span className="text-2xl font-bold font-mono tracking-tighter text-cyan-400">
                          Normal
                        </span>
                      </div>
                    </div>
                    <OverlayEffects className="rounded-[2rem]" />
                  </div>

                  <div className="bg-black/10 border border-white/5 backdrop-blur-xl rounded-[2rem] p-5 flex flex-col shadow-2xl relative overflow-hidden">
                    <div className="flex justify-between items-center mb-4">
                      <div className="flex items-center space-x-3">
                        <div className={`w-2 h-2 rounded-full shadow-[0_0_10px_cyan] ${isRunning ? "bg-amber-400 animate-pulse" : "bg-cyan-400"}`} />
                        <span className="text-[10px] font-mono opacity-60 uppercase tracking-widest">
                          Run Feed
                        </span>
                        {isRunning && currentStage && (
                          <span className="text-[9px] font-mono text-amber-400 uppercase animate-pulse">
                            → {currentStage}
                          </span>
                        )}
                      </div>
                      <Terminal size={14} className="opacity-30" />
                    </div>

                    {runError && (
                      <div className="mb-3 p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-[10px] font-mono text-red-400">
                        Error: {runError}
                      </div>
                    )}

                    <div
                      ref={logsContainerRef}
                      className="flex-1 space-y-2 font-mono text-[10px] overflow-y-auto max-h-[200px] scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent"
                    >
                      {logs.map((log, i) => (
                        <div
                          key={`${log.time}-${i}`}
                          className={`flex justify-between py-2.5 px-4 rounded-xl transition-all duration-500 border-l-2 ${
                            i === logs.length - 1
                              ? "bg-cyan-500/10 border-cyan-400 translate-x-1 text-white"
                              : "border-white/5 text-white/40"
                          }`}
                        >
                          <div className="flex space-x-4 min-w-0">
                            <span className="opacity-30 shrink-0">[{log.time}]</span>
                            {log.stage && <span className="text-cyan-600 shrink-0">[{log.stage}]</span>}
                            <span className="truncate">{log.msg}</span>
                          </div>
                          <span className={`shrink-0 ml-2 ${log.status === "OK" ? "text-cyan-400" : "text-amber-500"}`}>
                            // {log.status}
                          </span>
                        </div>
                      ))}
                    </div>

                    {/* Action Row */}
                    <div className="mt-4 space-y-3">
                      {/* Utility Controls */}
                      <div className="flex justify-end space-x-2">
                        <button className="p-2 border border-white/10 rounded-lg hover:bg-white/5 hover:border-white/30 transition-all text-white/40 hover:text-white" title="Logs">
                          <FileText size={14} />
                        </button>
                        <button className="p-2 border border-white/10 rounded-lg hover:bg-white/5 hover:border-white/30 transition-all text-white/40 hover:text-white" title="Settings">
                          <Settings2 size={14} />
                        </button>
                      </div>

                      {/* Main Actions */}
                      <div className="flex space-x-3">
                        {/* Run Button with Dropdown OR Cancel Button */}
                        <div className="relative flex-1">
                          {isRunning ? (
                            <button
                              onClick={handleCancelRun}
                              className="w-full py-3 bg-red-500 text-white font-black uppercase text-xs rounded-2xl hover:bg-red-400 transition-all shadow-[0_0_30px_rgba(239,68,68,0.2)] active:scale-95 flex items-center justify-center"
                            >
                              <X size={14} className="mr-2" /> Cancel Run
                            </button>
                          ) : (
                            <button
                              onClick={() => setShowRunMenu(!showRunMenu)}
                              className="w-full py-3 bg-white text-black font-black uppercase text-xs rounded-2xl hover:bg-cyan-400 transition-all shadow-[0_0_30px_rgba(255,255,255,0.1)] active:scale-95 flex items-center justify-center"
                            >
                              <Play size={14} className="mr-2" /> Run
                              <ChevronDown size={14} className={`ml-2 transition-transform ${showRunMenu ? "rotate-180" : ""}`} />
                            </button>
                          )}

                          {/* Run Menu Dropdown */}
                          {showRunMenu && !isRunning && (
                            <div className="absolute bottom-full mb-2 left-0 right-0 bg-black/90 border border-white/10 rounded-xl overflow-hidden shadow-2xl z-50 backdrop-blur-xl">
                              {runMenuOptions.map((option) => (
                                <button
                                  key={option.id}
                                  onClick={() => {
                                    handleStartRun(option.mode as RunMode);
                                    setShowRunMenu(false);
                                  }}
                                  className="w-full px-4 py-3 text-left text-xs font-mono hover:bg-cyan-500/20 transition-colors flex justify-between items-center border-b border-white/5 last:border-b-0"
                                >
                                  <span className="text-white">{option.label}</span>
                                  {option.pillar && (
                                    <span className="text-[8px] text-white/30 uppercase">{option.pillar}</span>
                                  )}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Review Button - when HITL needed, active run needs review, pending reviews, or open escalations exist */}
                        {(currentClient.alert || currentRun?.status === "needs_review" || reviewAttentionCount > 0) && (
                          <button
                            onClick={() => {
                              const shouldOpenArtifactReview = currentRun?.status === "needs_review" || pendingReviewRuns.length > 0;
                              if (shouldOpenArtifactReview) {
                                // Use current run if it needs review, otherwise use first pending run
                                if (currentRun?.status !== "needs_review" && pendingReviewRuns.length > 0) {
                                  setCurrentRun(pendingReviewRuns[0]);
                                }
                                setShowReviewPanel(true);
                              } else {
                                setActivePillar("review");
                                setIsClientDetailOpen(true);
                                setIsExpanded(true);
                              }
                            }}
                            className="px-6 py-3 bg-amber-500 text-black font-black uppercase text-xs rounded-2xl hover:bg-amber-400 transition-all active:scale-95 flex items-center justify-center shadow-[0_0_20px_rgba(245,158,11,0.3)] animate-pulse"
                          >
                            <Eye size={14} className="mr-2" /> Review
                            {reviewAttentionCount > 0 && (
                              <span className="ml-2 px-1.5 py-0.5 bg-black/20 rounded-lg text-[9px] font-mono">
                                {reviewAttentionCount}
                              </span>
                            )}
                          </button>
                        )}

                        {/* Export Button */}
                        <button
                          onClick={handleExport}
                          disabled={!currentRun || isRunning}
                          className="px-6 py-3 border border-white/20 text-white/70 font-bold uppercase text-xs rounded-2xl hover:bg-white/10 hover:border-white/40 transition-all active:scale-95 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Download size={14} className="mr-2" /> Export
                        </button>
                      </div>
                    </div>
                    <OverlayEffects className="rounded-[2rem]" />
	                  </div>
	                </div>
                  </>
                )}
	              </div>
	            )}
          </main>
        </div>

	        <aside
	          className={`hidden h-full border-l border-transparent sm:flex flex-col items-center py-6 relative pointer-events-none overflow-hidden transition-[width,transform,opacity,background-color,backdrop-filter] duration-500 ${
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

      <ShotDetailDrawer
        key={`${activeClient}:${selectedShot.runId ?? currentRun?.runId ?? "no-run"}:${selectedShot.id ?? "closed"}:${selectedShot.initialTab ?? "narrative"}`}
        shotNumber={selectedShot.n}
        deliverableId={selectedShot.id}
        campaignId={selectedCampaign?.id ?? currentRun?.campaignId}
        runId={selectedShot.runId ?? currentRun?.runId}
        initialTab={selectedShot.initialTab}
        auditShot={selectedShot.auditShot}
        onClose={() => setSelectedShot({ n: null, id: null })}
      />

      <RunDetailDrawer
        runId={selectedRunDetailId}
        onClose={() => setSelectedRunDetailId(null)}
        onRunSelect={setSelectedRunDetailId}
      />

      {showReviewPanel && currentRun && currentClient && (
        <ReviewPanel
          key={`${activeClient}:${currentRun.runId}`}
          runId={currentRun.runId}
          clientName={currentClient.displayName}
          initialFinalHitlShotNumber={finalHitlShotNumber}
          onClose={() => {
            setShowReviewPanel(false);
            setFinalHitlShotNumber(null);
          }}
          onComplete={handleReviewComplete}
        />
      )}

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
	                  <h2 className="text-lg font-bold tracking-[0.3em] text-white uppercase">New BrandStudios Setup</h2>
                  <p className="text-[9px] font-mono text-cyan-400 opacity-50 uppercase tracking-[0.2em]">
	                    Ready to onboard a brand workspace
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
	                    Brand Name
                  </label>
                  <input
                    type="text"
                    placeholder="Brand name"
                    className="w-full bg-white/5 border border-white/10 p-5 rounded-2xl outline-none focus:border-cyan-400/50 font-mono text-white transition-all text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] uppercase font-mono opacity-40 ml-1 tracking-widest">
                    LLM Model
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
	                Create BrandStudios Workspace
              </button>
            </div>
            <OverlayEffects className="rounded-[3rem]" />
          </div>
        </div>
      )}
    </div>
  );
}
