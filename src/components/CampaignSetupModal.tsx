import { useState } from "react";
import {
  X,
  Zap,
  Sparkles,
  Shield,
  Upload,
  Palette,
  Loader2,
  AlertTriangle,
  Settings2,
} from "lucide-react";
import { DeliverableBuilder, type Deliverable } from "./DeliverableBuilder";

export type CampaignMode = "campaign" | "creative";

export interface CampaignGuardrails {
  season?: string;
  colorPalette?: string[];
  styleNotes?: string;
}

export interface CampaignSetupData {
  name: string;
  mode: CampaignMode;
  maxRetries: number;
  deliverables: Deliverable[];
  referenceImages: string[];
  guardrails: CampaignGuardrails;
  prompt: string;
}

interface CampaignSetupModalProps {
  clientName: string;
  onClose: () => void;
  onSubmit: (data: CampaignSetupData) => Promise<void>;
}

const SEASONS = ["Spring", "Summer", "Fall", "Winter", "All Seasons"];
const DEFAULT_COLORS = ["#F5F5DC", "#D2B48C", "#8B7355", "#2F4F4F", "#FFFFFF"];

export function CampaignSetupModal({
  clientName,
  onClose,
  onSubmit,
}: CampaignSetupModalProps) {
  const [step, setStep] = useState<"setup" | "deliverables" | "guardrails">("setup");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [mode, setMode] = useState<CampaignMode>("campaign");
  const [maxRetries, setMaxRetries] = useState(3);
  const [deliverables, setDeliverables] = useState<Deliverable[]>([]);
  const [referenceImages, setReferenceImages] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");

  // Guardrails state
  const [season, setSeason] = useState("");
  const [colorPalette, setColorPalette] = useState<string[]>(DEFAULT_COLORS);
  const [styleNotes, setStyleNotes] = useState("");

  // Model/Outfit refs for deliverable builder
  const [modelRefs] = useState(["Model A", "Model B"]);
  const [outfitRefs] = useState(["Outfit 1", "Outfit 2", "Outfit 3"]);

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError("Campaign name is required");
      return;
    }
    if (deliverables.length === 0) {
      setError("At least one deliverable is required");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await onSubmit({
        name: name.trim(),
        mode,
        maxRetries,
        deliverables,
        referenceImages,
        guardrails: {
          season: season || undefined,
          colorPalette: colorPalette.filter(Boolean),
          styleNotes: styleNotes || undefined,
        },
        prompt: prompt || deliverables.map((d) => d.prompt).join("; "),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create campaign");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files) {
      // In production, upload to storage and get URLs
      // For now, use local file paths
      const newImages = Array.from(files).map((file) => URL.createObjectURL(file));
      setReferenceImages([...referenceImages, ...newImages]);
    }
  };

  const removeReferenceImage = (index: number) => {
    setReferenceImages(referenceImages.filter((_, i) => i !== index));
  };

  const addColor = () => {
    if (colorPalette.length < 10) {
      setColorPalette([...colorPalette, "#888888"]);
    }
  };

  const updateColor = (index: number, color: string) => {
    const updated = [...colorPalette];
    updated[index] = color;
    setColorPalette(updated);
  };

  const removeColor = (index: number) => {
    setColorPalette(colorPalette.filter((_, i) => i !== index));
  };

  return (
    <div className="fixed inset-0 z-[700] flex items-center justify-center p-6 bg-black/70 backdrop-blur-xl">
      <div className="w-full max-w-3xl bg-[#0a0c10] border border-cyan-500/30 rounded-[2rem] overflow-hidden shadow-[0_0_100px_rgba(0,0,0,0.8)] max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex justify-between items-center p-6 border-b border-white/10">
          <div className="flex items-center space-x-4">
            <div className="w-10 h-10 rounded-full bg-cyan-500/20 flex items-center justify-center border border-cyan-500/40">
              <Zap className="text-cyan-400" size={20} />
            </div>
            <div>
              <h2 className="text-lg font-bold tracking-wide text-white">
                Campaign Setup
              </h2>
              <p className="text-[10px] font-mono text-white/40 uppercase">
                {clientName} / New Campaign
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

        {/* Step Indicator */}
        <div className="flex items-center justify-center p-4 border-b border-white/5">
          {["setup", "deliverables", "guardrails"].map((s, i) => (
            <div key={s} className="flex items-center">
              <button
                onClick={() => setStep(s as typeof step)}
                className={`flex items-center space-x-2 px-4 py-2 rounded-lg text-[10px] font-mono uppercase tracking-wider transition-colors ${
                  step === s
                    ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                    : "text-white/40 hover:text-white/70"
                }`}
              >
                <span className="w-5 h-5 rounded-full border border-current flex items-center justify-center text-[9px]">
                  {i + 1}
                </span>
                <span>{s}</span>
              </button>
              {i < 2 && <div className="w-8 h-px bg-white/10 mx-2" />}
            </div>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {error && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-xl flex items-center space-x-2">
              <AlertTriangle size={14} className="text-red-400" />
              <span className="text-[10px] font-mono text-red-400">{error}</span>
            </div>
          )}

          {/* Step 1: Basic Setup */}
          {step === "setup" && (
            <div className="space-y-6">
              {/* Campaign Name */}
              <div className="space-y-2">
                <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest">
                  Campaign Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Fall 2024 Lookbook"
                  className="w-full bg-white/5 border border-white/10 p-4 rounded-xl outline-none focus:border-cyan-400/50 font-mono text-white transition-all"
                />
              </div>

              {/* Mode Selection */}
              <div className="space-y-2">
                <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest">
                  Campaign Mode
                </label>
                <div className="grid grid-cols-2 gap-4">
                  <button
                    onClick={() => setMode("campaign")}
                    className={`p-4 rounded-xl border text-left transition-all ${
                      mode === "campaign"
                        ? "bg-cyan-500/20 border-cyan-500/40"
                        : "border-white/10 hover:border-white/20"
                    }`}
                  >
                    <div className="flex items-center space-x-2 mb-2">
                      <Shield size={16} className={mode === "campaign" ? "text-cyan-400" : "text-white/40"} />
                      <span className={`font-bold ${mode === "campaign" ? "text-cyan-400" : "text-white/60"}`}>
                        Campaign
                      </span>
                    </div>
                    <p className="text-[9px] font-mono text-white/30">
                      Strict brand guardrails. Best for consistent deliverables.
                    </p>
                  </button>
                  <button
                    onClick={() => setMode("creative")}
                    className={`p-4 rounded-xl border text-left transition-all ${
                      mode === "creative"
                        ? "bg-purple-500/20 border-purple-500/40"
                        : "border-white/10 hover:border-white/20"
                    }`}
                  >
                    <div className="flex items-center space-x-2 mb-2">
                      <Sparkles size={16} className={mode === "creative" ? "text-purple-400" : "text-white/40"} />
                      <span className={`font-bold ${mode === "creative" ? "text-purple-400" : "text-white/60"}`}>
                        Creative
                      </span>
                    </div>
                    <p className="text-[9px] font-mono text-white/30">
                      More flexibility. Best for exploration and concepts.
                    </p>
                  </button>
                </div>
              </div>

              {/* Max Retries */}
              <div className="space-y-2">
                <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest flex items-center">
                  <Settings2 size={10} className="mr-1" />
                  Max Retries per Item
                </label>
                <div className="flex items-center space-x-4">
                  <input
                    type="range"
                    min="1"
                    max="5"
                    value={maxRetries}
                    onChange={(e) => setMaxRetries(Number(e.target.value))}
                    className="flex-1 accent-cyan-400"
                  />
                  <span className="text-lg font-bold text-cyan-400 w-8 text-center">
                    {maxRetries}
                  </span>
                </div>
                <p className="text-[8px] font-mono text-white/20">
                  Items failing more than {maxRetries} times will be flagged for manual intervention.
                </p>
              </div>

              {/* Reference Images */}
              <div className="space-y-2">
                <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest">
                  Reference Images
                </label>
                <div className="flex flex-wrap gap-2">
                  {referenceImages.map((img, index) => (
                    <div
                      key={index}
                      className="relative w-16 h-16 rounded-lg overflow-hidden border border-white/10 group"
                    >
                      <img src={img} alt={`Ref ${index + 1}`} className="w-full h-full object-cover" />
                      <button
                        onClick={() => removeReferenceImage(index)}
                        className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                      >
                        <X size={14} className="text-white" />
                      </button>
                    </div>
                  ))}
                  <label className="w-16 h-16 rounded-lg border border-dashed border-white/20 flex items-center justify-center cursor-pointer hover:border-cyan-400/50 transition-colors">
                    <Upload size={16} className="text-white/30" />
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>

              {/* Global Prompt */}
              <div className="space-y-2">
                <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest">
                  Global Prompt (Optional)
                </label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="A global prompt that applies to all deliverables..."
                  rows={3}
                  className="w-full bg-white/5 border border-white/10 p-3 rounded-xl outline-none focus:border-cyan-400/50 font-mono text-white text-sm resize-none placeholder:text-white/20"
                />
              </div>
            </div>
          )}

          {/* Step 2: Deliverables */}
          {step === "deliverables" && (
            <DeliverableBuilder
              deliverables={deliverables}
              onChange={setDeliverables}
              modelRefs={modelRefs}
              outfitRefs={outfitRefs}
            />
          )}

          {/* Step 3: Guardrails */}
          {step === "guardrails" && (
            <div className="space-y-6">
              {/* Season */}
              <div className="space-y-2">
                <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest">
                  Season
                </label>
                <div className="flex flex-wrap gap-2">
                  {SEASONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => setSeason(season === s ? "" : s)}
                      className={`px-3 py-2 rounded-lg text-xs font-mono transition-colors ${
                        season === s
                          ? "bg-cyan-500/20 border border-cyan-500/40 text-cyan-400"
                          : "border border-white/10 text-white/40 hover:border-white/20"
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                {season && (
                  <p className="text-[8px] font-mono text-white/20">
                    Guardrail: No {season === "Summer" ? "winter" : season === "Winter" ? "summer" : ""} clothing items
                  </p>
                )}
              </div>

              {/* Color Palette */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest flex items-center">
                    <Palette size={10} className="mr-1" />
                    Color Palette
                  </label>
                  <button
                    onClick={addColor}
                    className="text-[8px] font-mono text-cyan-400 hover:text-cyan-300"
                  >
                    + Add Color
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {colorPalette.map((color, index) => (
                    <div key={index} className="relative group">
                      <input
                        type="color"
                        value={color}
                        onChange={(e) => updateColor(index, e.target.value)}
                        className="w-10 h-10 rounded-lg cursor-pointer border border-white/10"
                      />
                      <button
                        onClick={() => removeColor(index)}
                        className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                      >
                        <X size={8} className="text-white" />
                      </button>
                    </div>
                  ))}
                </div>
                <p className="text-[8px] font-mono text-white/20">
                  Colors outside this palette will trigger a rejection.
                </p>
              </div>

              {/* Style Notes */}
              <div className="space-y-2">
                <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest">
                  Style Notes
                </label>
                <textarea
                  value={styleNotes}
                  onChange={(e) => setStyleNotes(e.target.value)}
                  placeholder="Additional styling guidance, e.g., 'Minimalist aesthetic, natural lighting, clean backgrounds'"
                  rows={3}
                  className="w-full bg-white/5 border border-white/10 p-3 rounded-xl outline-none focus:border-cyan-400/50 font-mono text-white text-sm resize-none placeholder:text-white/20"
                />
              </div>

              {/* Summary */}
              <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                <h4 className="text-[10px] font-mono text-white/40 uppercase tracking-widest mb-3">
                  Campaign Summary
                </h4>
                <div className="grid grid-cols-2 gap-4 text-xs font-mono">
                  <div>
                    <span className="text-white/30">Name:</span>{" "}
                    <span className="text-white">{name || "Unnamed"}</span>
                  </div>
                  <div>
                    <span className="text-white/30">Mode:</span>{" "}
                    <span className={mode === "campaign" ? "text-cyan-400" : "text-purple-400"}>
                      {mode}
                    </span>
                  </div>
                  <div>
                    <span className="text-white/30">Deliverables:</span>{" "}
                    <span className="text-white">{deliverables.length}</span>
                  </div>
                  <div>
                    <span className="text-white/30">Max Retries:</span>{" "}
                    <span className="text-white">{maxRetries}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-white/10 bg-black/30">
          <div className="flex justify-between">
            <button
              onClick={() => {
                if (step === "deliverables") setStep("setup");
                else if (step === "guardrails") setStep("deliverables");
                else onClose();
              }}
              className="px-6 py-3 border border-white/20 text-white/60 font-bold uppercase text-xs rounded-xl hover:bg-white/10 transition-all"
            >
              {step === "setup" ? "Cancel" : "Back"}
            </button>
            <button
              onClick={() => {
                if (step === "setup") setStep("deliverables");
                else if (step === "deliverables") setStep("guardrails");
                else handleSubmit();
              }}
              disabled={isSubmitting}
              className="px-6 py-3 bg-cyan-500 text-black font-black uppercase text-xs rounded-xl hover:bg-cyan-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
            >
              {isSubmitting && <Loader2 size={14} className="animate-spin" />}
              <span>{step === "guardrails" ? "Launch Campaign" : "Next"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
