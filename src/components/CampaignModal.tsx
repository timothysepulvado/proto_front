import { useState } from "react";
import {
  X,
  Zap,
  Image,
  Video,
  FileImage,
  ShoppingBag,
  Globe,
  Instagram,
  Mail,
  Megaphone,
  Calendar,
  Loader2,
} from "lucide-react";
import type { Campaign } from "../api";

interface CampaignModalProps {
  clientName: string;
  onClose: () => void;
  onSubmit: (campaign: {
    name: string;
    prompt: string;
    deliverables: Campaign["deliverables"];
    platforms: string[];
    scheduledAt?: string;
  }) => Promise<void>;
}

const PLATFORM_OPTIONS = [
  { id: "web", label: "Web", icon: Globe },
  { id: "instagram", label: "Instagram", icon: Instagram },
  { id: "email", label: "Email", icon: Mail },
  { id: "ads", label: "Ads", icon: Megaphone },
];

const DELIVERABLE_PRESETS = [
  { id: "hero", label: "Hero Image", icon: FileImage, key: "heroImages" as const },
  { id: "lifestyle", label: "Lifestyle", icon: Image, key: "lifestyleImages" as const },
  { id: "product", label: "Product Shots", icon: ShoppingBag, key: "productShots" as const },
  { id: "video", label: "Video", icon: Video, key: "videos" as const },
];

export function CampaignModal({ clientName, onClose, onSubmit }: CampaignModalProps) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [deliverables, setDeliverables] = useState<Campaign["deliverables"]>({
    heroImages: 1,
    lifestyleImages: 3,
    productShots: 0,
    videos: 0,
  });
  const [platforms, setPlatforms] = useState<string[]>(["web"]);
  const [scheduleNow, setScheduleNow] = useState(true);
  const [scheduledAt, setScheduledAt] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const togglePlatform = (platformId: string) => {
    setPlatforms((prev) =>
      prev.includes(platformId)
        ? prev.filter((p) => p !== platformId)
        : [...prev, platformId]
    );
  };

  const updateDeliverable = (key: keyof Campaign["deliverables"], delta: number) => {
    setDeliverables((prev) => ({
      ...prev,
      [key]: Math.max(0, (prev[key] ?? 0) + delta),
    }));
  };

  const totalDeliverables = Object.values(deliverables).reduce((sum, v) => sum + (v ?? 0), 0);

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError("Campaign name is required");
      return;
    }
    if (!prompt.trim()) {
      setError("Creative prompt is required");
      return;
    }
    if (totalDeliverables === 0) {
      setError("Select at least one deliverable");
      return;
    }
    if (platforms.length === 0) {
      setError("Select at least one platform");
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      await onSubmit({
        name: name.trim(),
        prompt: prompt.trim(),
        deliverables,
        platforms,
        scheduledAt: scheduleNow ? undefined : scheduledAt || undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create campaign");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[700] flex items-center justify-center p-6 bg-black/70 backdrop-blur-xl">
      <div className="w-full max-w-2xl bg-[#0a0c10] border border-cyan-500/30 rounded-[2rem] p-8 shadow-[0_0_100px_rgba(0,0,0,0.8)] relative overflow-hidden max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-8 border-b border-white/10 pb-6">
          <div className="flex items-center">
            <div className="w-10 h-10 rounded-full bg-cyan-500/20 flex items-center justify-center mr-4 border border-cyan-500/40">
              <Zap className="text-cyan-400" size={20} />
            </div>
            <div>
              <h2 className="text-lg font-bold tracking-[0.2em] text-white uppercase">
                New Campaign
              </h2>
              <p className="text-[9px] font-mono text-cyan-400/60 uppercase tracking-[0.2em]">
                {clientName}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-white/10 rounded-lg transition-colors"
          >
            <X className="text-white/40 hover:text-white" size={20} />
          </button>
        </div>

        {/* Error Display */}
        {error && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Form */}
        <div className="space-y-6">
          {/* Campaign Name */}
          <div className="space-y-2">
            <label className="text-[10px] uppercase font-mono text-white/40 tracking-widest">
              Campaign Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Q1 Spring Collection"
              className="w-full bg-white/5 border border-white/10 p-4 rounded-xl outline-none focus:border-cyan-400/50 font-mono text-white transition-all text-sm placeholder:text-white/20"
            />
          </div>

          {/* Creative Prompt */}
          <div className="space-y-2">
            <label className="text-[10px] uppercase font-mono text-white/40 tracking-widest">
              Creative Direction
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the visual style, mood, and key elements for this campaign..."
              rows={4}
              className="w-full bg-white/5 border border-white/10 p-4 rounded-xl outline-none focus:border-cyan-400/50 font-mono text-white transition-all text-sm resize-none placeholder:text-white/20"
            />
            <p className="text-[9px] font-mono text-white/30">
              This prompt will be enhanced with brand DNA context during generation
            </p>
          </div>

          {/* Deliverables */}
          <div className="space-y-3">
            <label className="text-[10px] uppercase font-mono text-white/40 tracking-widest">
              Deliverables
            </label>
            <div className="grid grid-cols-2 gap-3">
              {DELIVERABLE_PRESETS.map((preset) => {
                const Icon = preset.icon;
                const count = deliverables[preset.key] ?? 0;
                return (
                  <div
                    key={preset.id}
                    className={`p-4 rounded-xl border transition-all ${
                      count > 0
                        ? "bg-cyan-500/10 border-cyan-500/30"
                        : "bg-white/5 border-white/10 hover:border-white/20"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center space-x-2">
                        <Icon size={16} className={count > 0 ? "text-cyan-400" : "text-white/40"} />
                        <span className="text-xs font-mono text-white/70">{preset.label}</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <button
                        onClick={() => updateDeliverable(preset.key, -1)}
                        disabled={count === 0}
                        className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-white/40 hover:text-white hover:border-white/30 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                      >
                        -
                      </button>
                      <span className="text-lg font-mono font-bold text-white">{count}</span>
                      <button
                        onClick={() => updateDeliverable(preset.key, 1)}
                        className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-white/40 hover:text-white hover:border-white/30 transition-all"
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] font-mono text-cyan-400/60">
              Total: {totalDeliverables} deliverable{totalDeliverables !== 1 ? "s" : ""}
            </p>
          </div>

          {/* Platforms */}
          <div className="space-y-3">
            <label className="text-[10px] uppercase font-mono text-white/40 tracking-widest">
              Target Platforms
            </label>
            <div className="flex flex-wrap gap-2">
              {PLATFORM_OPTIONS.map((platform) => {
                const Icon = platform.icon;
                const isSelected = platforms.includes(platform.id);
                return (
                  <button
                    key={platform.id}
                    onClick={() => togglePlatform(platform.id)}
                    className={`flex items-center space-x-2 px-4 py-2 rounded-xl border transition-all ${
                      isSelected
                        ? "bg-cyan-500/20 border-cyan-500/40 text-cyan-400"
                        : "bg-white/5 border-white/10 text-white/50 hover:border-white/20"
                    }`}
                  >
                    <Icon size={14} />
                    <span className="text-xs font-mono">{platform.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Schedule */}
          <div className="space-y-3">
            <label className="text-[10px] uppercase font-mono text-white/40 tracking-widest">
              Schedule
            </label>
            <div className="flex space-x-3">
              <button
                onClick={() => setScheduleNow(true)}
                className={`flex-1 flex items-center justify-center space-x-2 py-3 rounded-xl border transition-all ${
                  scheduleNow
                    ? "bg-cyan-500/20 border-cyan-500/40 text-cyan-400"
                    : "bg-white/5 border-white/10 text-white/50 hover:border-white/20"
                }`}
              >
                <Zap size={14} />
                <span className="text-xs font-mono">Run Now</span>
              </button>
              <button
                onClick={() => setScheduleNow(false)}
                className={`flex-1 flex items-center justify-center space-x-2 py-3 rounded-xl border transition-all ${
                  !scheduleNow
                    ? "bg-cyan-500/20 border-cyan-500/40 text-cyan-400"
                    : "bg-white/5 border-white/10 text-white/50 hover:border-white/20"
                }`}
              >
                <Calendar size={14} />
                <span className="text-xs font-mono">Schedule</span>
              </button>
            </div>
            {!scheduleNow && (
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="w-full bg-white/5 border border-white/10 p-3 rounded-xl outline-none focus:border-cyan-400/50 font-mono text-white text-sm"
              />
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex space-x-3 mt-8 pt-6 border-t border-white/10">
          <button
            onClick={onClose}
            className="flex-1 py-4 border border-white/20 text-white/60 font-bold uppercase text-xs rounded-xl hover:bg-white/5 hover:border-white/30 transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="flex-1 py-4 bg-cyan-500 text-black font-black uppercase text-xs rounded-xl hover:bg-cyan-400 transition-all shadow-[0_0_30px_rgba(34,211,238,0.2)] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
          >
            {isSubmitting ? (
              <Loader2 size={16} className="animate-spin" />
            ) : scheduleNow ? (
              "Create & Run"
            ) : (
              "Schedule Campaign"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
