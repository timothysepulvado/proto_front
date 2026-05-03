import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Clock, DollarSign, Layers, Plus, Sparkles } from "lucide-react";
import {
  getCampaignDeliverables,
  getCampaignsByClient,
  getClientRuns,
  type Campaign,
  type CampaignDeliverable,
  type Run,
  type RunStatus,
} from "../api";

type CampaignCard = {
  campaign: Campaign;
  displayName: string;
  subtitle?: string;
  run: Run | null;
  deliverables: CampaignDeliverable[];
  shotCount: number;
  approvedCount: number;
  totalSpend: number;
  lastUpdated: string;
  statusLabel: string;
  statusTone: "live" | "review" | "complete" | "queued" | "blocked";
  actionLabel: string;
};

interface CampaignDashboardProps {
  clientId: string;
  brandName: string;
  onCampaignSelect: (campaign: Campaign, run: Run | null) => void;
}

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const compactDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const getCampaignDisplayName = (campaign: Campaign) => {
  const [primary] = campaign.name.split("—");
  return primary?.trim() || campaign.name;
};

const getCampaignSubtitle = (campaign: Campaign) => {
  const displayName = getCampaignDisplayName(campaign);
  return displayName === campaign.name ? undefined : campaign.name;
};

const getRequestedCount = (campaign: Campaign) => {
  const deliverables = campaign.deliverables;
  if (Array.isArray(deliverables)) return deliverables.length;
  if (deliverables && typeof deliverables === "object") {
    const value = deliverables as Record<string, unknown>;
    if (Array.isArray(value.items)) return value.items.length;
    if (Array.isArray(value.shots)) return value.shots.length;
    if (typeof value.count === "number") return value.count;
    if (typeof value.total === "number") return value.total;
  }

  const nameMatch = campaign.name.match(/(\d+)\s*-?\s*shot/i);
  return nameMatch ? Number(nameMatch[1]) : 0;
};

const getLatestIso = (...values: Array<string | undefined>) => {
  const timestamps = values
    .filter(Boolean)
    .map((value) => new Date(value as string).getTime())
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) return new Date().toISOString();
  return new Date(Math.max(...timestamps)).toISOString();
};

const getStatus = (run: Run | null, deliverables: CampaignDeliverable[]): Pick<CampaignCard, "statusLabel" | "statusTone" | "actionLabel"> => {
  const generating = deliverables.some((deliverable) => ["generating", "regenerating", "reviewing"].includes(deliverable.status));
  const approved = deliverables.length > 0 && deliverables.every((deliverable) => deliverable.status === "approved");

  if (run?.status === "running" || generating) {
    return { statusLabel: "LIVE", statusTone: "live", actionLabel: "Monitor" };
  }
  if (run?.status === "needs_review") {
    return { statusLabel: "REVIEW", statusTone: "review", actionLabel: "Review" };
  }
  if (run?.status === "blocked" || run?.status === "failed" || deliverables.some((deliverable) => deliverable.status === "rejected")) {
    return { statusLabel: "NEEDS WORK", statusTone: "blocked", actionLabel: "Edit" };
  }
  if (run?.status === "completed" || approved) {
    return { statusLabel: "COMPLETE", statusTone: "complete", actionLabel: "Continue" };
  }
  if (run?.status === "pending") {
    return { statusLabel: "QUEUED", statusTone: "queued", actionLabel: "Monitor" };
  }
  return { statusLabel: "DRAFT", statusTone: "queued", actionLabel: "Edit" };
};

const statusClasses: Record<CampaignCard["statusTone"], string> = {
  live: "border-cyan-400/40 bg-cyan-400/10 text-cyan-200",
  review: "border-amber-400/40 bg-amber-400/10 text-amber-200",
  complete: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200",
  queued: "border-white/15 bg-white/5 text-white/55",
  blocked: "border-[#ED4C14]/45 bg-[#ED4C14]/10 text-orange-200",
};

const runStatusLabel = (status?: RunStatus) => status?.replace("_", " ").toUpperCase() ?? "NO RUN";

export default function CampaignDashboard({ clientId, brandName, onCampaignSelect }: CampaignDashboardProps) {
  const [cards, setCards] = useState<CampaignCard[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadRequestIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const requestId = ++loadRequestIdRef.current;

    async function loadCampaigns() {
      try {
        setIsLoading(true);
        setError(null);

        const [campaigns, runs] = await Promise.all([
          getCampaignsByClient(clientId),
          getClientRuns(clientId),
        ]);

        const campaignCards = await Promise.all(campaigns.map(async (campaign) => {
          const deliverables = await getCampaignDeliverables(campaign.id).catch(() => []);
          const run = runs
            .filter((candidate) => candidate.campaignId === campaign.id)
            .reduce<Run | null>((latest, candidate) => {
              if (!latest) return candidate;
              return Date.parse(candidate.updatedAt) > Date.parse(latest.updatedAt) ? candidate : latest;
            }, null);
          const latestDeliverableUpdate = deliverables.reduce<string | undefined>((latest, deliverable) => (
            latest ? getLatestIso(latest, deliverable.updatedAt) : deliverable.updatedAt
          ), undefined);
          const shotCount = deliverables.length || getRequestedCount(campaign);
          const approvedCount = deliverables.filter((deliverable) => deliverable.status === "approved").length;
          const totalSpend = deliverables.reduce((sum, deliverable) => sum + (deliverable.estimatedCost ?? 0), 0);
          const status = getStatus(run, deliverables);

          return {
            campaign,
            displayName: getCampaignDisplayName(campaign),
            subtitle: getCampaignSubtitle(campaign),
            run,
            deliverables,
            shotCount,
            approvedCount,
            totalSpend,
            lastUpdated: getLatestIso(campaign.updatedAt, run?.updatedAt, latestDeliverableUpdate),
            ...status,
          } satisfies CampaignCard;
        }));

        if (!cancelled && requestId === loadRequestIdRef.current) {
          setCards(campaignCards);
        }
      } catch (err) {
        if (!cancelled && requestId === loadRequestIdRef.current) {
          setError(err instanceof Error ? err.message : "Failed to load campaigns");
          setCards([]);
        }
      } finally {
        if (!cancelled && requestId === loadRequestIdRef.current) setIsLoading(false);
      }
    }

    void loadCampaigns();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const totals = useMemo(() => cards.reduce((acc, card) => ({
    shots: acc.shots + card.shotCount,
    spend: acc.spend + card.totalSpend,
  }), { shots: 0, spend: 0 }), [cards]);

  return (
    <section className="fade-slide-in space-y-5">
      <div className="relative overflow-hidden rounded-[2rem] border border-cyan-400/15 bg-black/25 p-5 shadow-2xl backdrop-blur-2xl md:p-6">
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent via-[#ED4C14]/70 to-transparent opacity-60" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-3 py-1 text-[8px] font-mono uppercase tracking-[0.28em] text-cyan-200/80">
                BrandStudios / Campaigns
              </span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[8px] font-mono uppercase tracking-[0.24em] text-white/40">
                Presentation Layer
              </span>
            </div>
            <h2 className="text-2xl font-black uppercase italic tracking-tighter text-white md:text-4xl">
              {brandName} Campaign Command
            </h2>
            <p className="mt-2 max-w-2xl text-[10px] font-mono uppercase leading-relaxed tracking-[0.22em] text-white/42">
              Start, continue, edit, or monitor campaign workspaces before entering the pillar controls.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center sm:min-w-[360px]">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
              <p className="text-[8px] font-mono uppercase tracking-[0.22em] text-white/35">Campaigns</p>
              <p className="mt-1 font-mono text-2xl font-black text-white">{cards.length}</p>
            </div>
            <div className="rounded-2xl border border-cyan-400/15 bg-cyan-400/5 p-3">
              <p className="text-[8px] font-mono uppercase tracking-[0.22em] text-cyan-100/45">Shots</p>
              <p className="mt-1 font-mono text-2xl font-black text-cyan-200">{totals.shots}</p>
            </div>
            <div className="rounded-2xl border border-[#ED4C14]/20 bg-[#ED4C14]/10 p-3">
              <p className="text-[8px] font-mono uppercase tracking-[0.22em] text-orange-100/50">Spend</p>
              <p className="mt-1 font-mono text-2xl font-black text-orange-100">{currencyFormatter.format(totals.spend)}</p>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[10px] font-mono uppercase tracking-widest text-red-200">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-64 animate-pulse rounded-[2rem] border border-white/10 bg-white/5" />
          ))
        ) : cards.map((card) => (
          <button
            key={card.campaign.id}
            type="button"
            onClick={() => onCampaignSelect(card.campaign, card.run)}
            className="group relative min-h-64 overflow-hidden rounded-[2rem] border border-white/10 bg-black/25 p-5 text-left shadow-2xl backdrop-blur-xl transition-all hover:-translate-y-1 hover:border-cyan-400/35 hover:bg-cyan-400/5 focus:outline-none focus:ring-2 focus:ring-cyan-300/40"
          >
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent via-cyan-300/50 to-transparent opacity-40 transition-opacity group-hover:opacity-90" />
            <div className="relative flex h-full flex-col justify-between gap-5">
              <div>
                <div className="mb-4 flex items-start justify-between gap-3">
                  <span className={`rounded-full border px-3 py-1 text-[8px] font-mono font-bold uppercase tracking-[0.24em] ${statusClasses[card.statusTone]}`}>
                    {card.statusLabel}
                  </span>
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-2 text-white/45 transition-colors group-hover:text-cyan-200">
                    <Layers size={16} />
                  </div>
                </div>
                <h3 className="text-2xl font-black uppercase italic tracking-tighter text-white">
                  {card.displayName}
                </h3>
                {card.subtitle && (
                  <p className="mt-2 line-clamp-2 text-[9px] font-mono uppercase leading-relaxed tracking-[0.18em] text-white/35">
                    {card.subtitle}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3">
                  <p className="flex items-center gap-1.5 text-[8px] font-mono uppercase tracking-[0.2em] text-white/35">
                    <Sparkles size={10} /> Shots
                  </p>
                  <p className="mt-1 font-mono text-xl font-black text-white">{card.shotCount}</p>
                  {card.approvedCount > 0 && (
                    <p className="mt-1 text-[8px] font-mono uppercase tracking-wider text-emerald-300/65">
                      {card.approvedCount} approved
                    </p>
                  )}
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3">
                  <p className="flex items-center gap-1.5 text-[8px] font-mono uppercase tracking-[0.2em] text-white/35">
                    <DollarSign size={10} /> Spend
                  </p>
                  <p className="mt-1 font-mono text-xl font-black text-white">{currencyFormatter.format(card.totalSpend)}</p>
                  <p className="mt-1 text-[8px] font-mono uppercase tracking-wider text-white/25">
                    estimated
                  </p>
                </div>
              </div>

              <div className="space-y-2 border-t border-white/10 pt-4">
                <div className="flex items-center justify-between gap-3 text-[9px] font-mono uppercase tracking-[0.18em] text-white/35">
                  <span className="flex items-center gap-1.5">
                    <Clock size={11} /> {compactDateFormatter.format(new Date(card.lastUpdated))}
                  </span>
                  <span>{runStatusLabel(card.run?.status)}</span>
                </div>
                <div className="flex items-center justify-between rounded-2xl border border-cyan-400/15 bg-cyan-400/10 px-3 py-2 text-[9px] font-mono font-bold uppercase tracking-[0.22em] text-cyan-100 transition-colors group-hover:bg-cyan-300 group-hover:text-black">
                  {card.actionLabel}
                  <ArrowRight size={13} />
                </div>
              </div>
            </div>
          </button>
        ))}

        {!isLoading && (
          <button
            type="button"
            disabled
            title="Campaign creation is planned for the next workflow pass"
            className="relative min-h-64 overflow-hidden rounded-[2rem] border border-dashed border-white/15 bg-white/[0.03] p-5 text-left opacity-70"
          >
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-3xl border border-[#ED4C14]/30 bg-[#ED4C14]/10 text-orange-200">
                <Plus size={22} />
              </div>
              <div>
                <h3 className="text-lg font-black uppercase italic tracking-tight text-white">Start New Campaign</h3>
                <p className="mt-2 text-[9px] font-mono uppercase leading-relaxed tracking-[0.2em] text-white/35">
                  Intake CTA reserved; no schema changes in this pass.
                </p>
              </div>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[8px] font-mono uppercase tracking-[0.24em] text-white/35">
                Planned
              </span>
            </div>
          </button>
        )}
      </div>

      {!isLoading && cards.length === 0 && !error && (
        <div className="rounded-[2rem] border border-white/10 bg-black/20 p-6 text-center text-[10px] font-mono uppercase tracking-[0.22em] text-white/35">
          No campaigns yet — use Start New Campaign when intake wiring opens.
        </div>
      )}
    </section>
  );
}
