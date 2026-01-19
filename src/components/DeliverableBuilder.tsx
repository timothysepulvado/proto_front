import { useState } from "react";
import {
  Plus,
  Trash2,
  Image as ImageIcon,
  Video,
  Users,
  Shirt,
  Sparkles,
  ChevronDown,
} from "lucide-react";

export interface Deliverable {
  id: string;
  description: string;
  aiModel: "nano" | "veo" | "sora";
  prompt: string;
  modelRef?: string;
  outfitRef?: string;
  poseRef?: string;
}

interface DeliverableBuilderProps {
  deliverables: Deliverable[];
  onChange: (deliverables: Deliverable[]) => void;
  modelRefs?: string[];
  outfitRefs?: string[];
}

const AI_MODELS = [
  { id: "nano" as const, label: "Nano", description: "Fast, cost-effective" },
  { id: "veo" as const, label: "Veo", description: "High quality video" },
  { id: "sora" as const, label: "Sora", description: "Premium generation" },
];

const PRESET_POSES = [
  "Standing front",
  "Standing 3/4",
  "Walking",
  "Sitting casual",
  "Action shot",
  "Close-up",
  "Full body",
  "Mid shot",
];

export function DeliverableBuilder({
  deliverables,
  onChange,
  modelRefs = [],
  outfitRefs = [],
}: DeliverableBuilderProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const generateId = () => `del_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const addDeliverable = () => {
    const newDeliverable: Deliverable = {
      id: generateId(),
      description: `Deliverable ${deliverables.length + 1}`,
      aiModel: "nano",
      prompt: "",
    };
    onChange([...deliverables, newDeliverable]);
    setExpandedId(newDeliverable.id);
  };

  const removeDeliverable = (id: string) => {
    onChange(deliverables.filter((d) => d.id !== id));
    if (expandedId === id) setExpandedId(null);
  };

  const updateDeliverable = (id: string, updates: Partial<Deliverable>) => {
    onChange(
      deliverables.map((d) => (d.id === id ? { ...d, ...updates } : d))
    );
  };

  const duplicateDeliverable = (deliverable: Deliverable) => {
    const newDeliverable: Deliverable = {
      ...deliverable,
      id: generateId(),
      description: `${deliverable.description} (copy)`,
    };
    onChange([...deliverables, newDeliverable]);
  };

  const generateBatch = () => {
    // Generate a batch of deliverables based on combinations
    const newDeliverables: Deliverable[] = [];
    const models = modelRefs.length > 0 ? modelRefs : ["Model A"];
    const outfits = outfitRefs.length > 0 ? outfitRefs : ["Outfit 1"];
    const poses = PRESET_POSES.slice(0, 3);

    for (const model of models) {
      for (const outfit of outfits) {
        for (const pose of poses) {
          newDeliverables.push({
            id: generateId(),
            description: `${model} - ${outfit} - ${pose}`,
            aiModel: "nano",
            prompt: `${model} wearing ${outfit}, ${pose.toLowerCase()} pose`,
            modelRef: model,
            outfitRef: outfit,
            poseRef: pose,
          });
        }
      }
    }

    onChange([...deliverables, ...newDeliverables]);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Sparkles size={14} className="text-cyan-400" />
          <span className="text-[10px] font-mono text-white/40 uppercase tracking-widest">
            Deliverables ({deliverables.length})
          </span>
        </div>
        <div className="flex space-x-2">
          <button
            onClick={generateBatch}
            className="px-3 py-1.5 text-[9px] font-mono uppercase tracking-wider text-cyan-400 border border-cyan-500/30 rounded-lg hover:bg-cyan-500/10 transition-colors flex items-center space-x-1"
          >
            <Sparkles size={10} />
            <span>Auto-Generate</span>
          </button>
          <button
            onClick={addDeliverable}
            className="px-3 py-1.5 text-[9px] font-mono uppercase tracking-wider text-white bg-white/10 border border-white/20 rounded-lg hover:bg-white/20 transition-colors flex items-center space-x-1"
          >
            <Plus size={10} />
            <span>Add</span>
          </button>
        </div>
      </div>

      {/* Deliverables List */}
      <div className="space-y-2 max-h-[300px] overflow-y-auto pr-2">
        {deliverables.length === 0 ? (
          <div className="p-8 border border-dashed border-white/10 rounded-xl text-center">
            <ImageIcon size={24} className="text-white/20 mx-auto mb-2" />
            <p className="text-[10px] font-mono text-white/30">
              No deliverables yet. Add items or auto-generate a batch.
            </p>
          </div>
        ) : (
          deliverables.map((deliverable, index) => (
            <div
              key={deliverable.id}
              className="border border-white/10 rounded-xl overflow-hidden bg-white/5"
            >
              {/* Collapsed Header */}
              <div
                onClick={() =>
                  setExpandedId(expandedId === deliverable.id ? null : deliverable.id)
                }
                className="flex items-center justify-between p-3 cursor-pointer hover:bg-white/5 transition-colors"
              >
                <div className="flex items-center space-x-3">
                  <span className="text-[9px] font-mono text-white/30 w-6">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="flex items-center space-x-2">
                    {deliverable.aiModel === "veo" ? (
                      <Video size={12} className="text-purple-400" />
                    ) : (
                      <ImageIcon size={12} className="text-cyan-400" />
                    )}
                    <span className="text-xs font-mono text-white truncate max-w-[200px]">
                      {deliverable.description}
                    </span>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  <span className="text-[8px] font-mono text-white/30 uppercase px-2 py-0.5 bg-white/5 rounded">
                    {deliverable.aiModel}
                  </span>
                  <ChevronDown
                    size={14}
                    className={`text-white/30 transition-transform ${
                      expandedId === deliverable.id ? "rotate-180" : ""
                    }`}
                  />
                </div>
              </div>

              {/* Expanded Content */}
              {expandedId === deliverable.id && (
                <div className="p-4 border-t border-white/10 space-y-4">
                  {/* Description */}
                  <div className="space-y-1">
                    <label className="text-[9px] font-mono text-white/40 uppercase tracking-widest">
                      Description
                    </label>
                    <input
                      type="text"
                      value={deliverable.description}
                      onChange={(e) =>
                        updateDeliverable(deliverable.id, { description: e.target.value })
                      }
                      className="w-full bg-white/5 border border-white/10 p-2 rounded-lg outline-none focus:border-cyan-400/50 font-mono text-white text-xs"
                    />
                  </div>

                  {/* AI Model */}
                  <div className="space-y-1">
                    <label className="text-[9px] font-mono text-white/40 uppercase tracking-widest">
                      AI Model
                    </label>
                    <div className="flex space-x-2">
                      {AI_MODELS.map((model) => (
                        <button
                          key={model.id}
                          onClick={() =>
                            updateDeliverable(deliverable.id, { aiModel: model.id })
                          }
                          className={`flex-1 p-2 rounded-lg border text-[9px] font-mono transition-colors ${
                            deliverable.aiModel === model.id
                              ? "bg-cyan-500/20 border-cyan-500/40 text-cyan-400"
                              : "border-white/10 text-white/40 hover:border-white/20"
                          }`}
                        >
                          <div>{model.label}</div>
                          <div className="text-[7px] opacity-50">{model.description}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Prompt */}
                  <div className="space-y-1">
                    <label className="text-[9px] font-mono text-white/40 uppercase tracking-widest">
                      Prompt
                    </label>
                    <textarea
                      value={deliverable.prompt}
                      onChange={(e) =>
                        updateDeliverable(deliverable.id, { prompt: e.target.value })
                      }
                      rows={2}
                      placeholder="Describe what should be generated..."
                      className="w-full bg-white/5 border border-white/10 p-2 rounded-lg outline-none focus:border-cyan-400/50 font-mono text-white text-xs resize-none placeholder:text-white/20"
                    />
                  </div>

                  {/* References Row */}
                  <div className="grid grid-cols-3 gap-2">
                    {/* Model Ref */}
                    <div className="space-y-1">
                      <label className="text-[8px] font-mono text-white/40 uppercase flex items-center">
                        <Users size={10} className="mr-1" /> Model
                      </label>
                      <select
                        value={deliverable.modelRef || ""}
                        onChange={(e) =>
                          updateDeliverable(deliverable.id, { modelRef: e.target.value })
                        }
                        className="w-full bg-white/5 border border-white/10 p-1.5 rounded-lg outline-none focus:border-cyan-400/50 font-mono text-white text-[9px]"
                      >
                        <option value="">None</option>
                        {modelRefs.map((ref) => (
                          <option key={ref} value={ref}>
                            {ref}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Outfit Ref */}
                    <div className="space-y-1">
                      <label className="text-[8px] font-mono text-white/40 uppercase flex items-center">
                        <Shirt size={10} className="mr-1" /> Outfit
                      </label>
                      <select
                        value={deliverable.outfitRef || ""}
                        onChange={(e) =>
                          updateDeliverable(deliverable.id, { outfitRef: e.target.value })
                        }
                        className="w-full bg-white/5 border border-white/10 p-1.5 rounded-lg outline-none focus:border-cyan-400/50 font-mono text-white text-[9px]"
                      >
                        <option value="">None</option>
                        {outfitRefs.map((ref) => (
                          <option key={ref} value={ref}>
                            {ref}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Pose */}
                    <div className="space-y-1">
                      <label className="text-[8px] font-mono text-white/40 uppercase flex items-center">
                        Pose
                      </label>
                      <select
                        value={deliverable.poseRef || ""}
                        onChange={(e) =>
                          updateDeliverable(deliverable.id, { poseRef: e.target.value })
                        }
                        className="w-full bg-white/5 border border-white/10 p-1.5 rounded-lg outline-none focus:border-cyan-400/50 font-mono text-white text-[9px]"
                      >
                        <option value="">None</option>
                        {PRESET_POSES.map((pose) => (
                          <option key={pose} value={pose}>
                            {pose}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex justify-end space-x-2 pt-2 border-t border-white/5">
                    <button
                      onClick={() => duplicateDeliverable(deliverable)}
                      className="px-2 py-1 text-[8px] font-mono text-white/40 hover:text-white transition-colors"
                    >
                      Duplicate
                    </button>
                    <button
                      onClick={() => removeDeliverable(deliverable.id)}
                      className="px-2 py-1 text-[8px] font-mono text-red-400/60 hover:text-red-400 transition-colors flex items-center"
                    >
                      <Trash2 size={10} className="mr-1" />
                      Remove
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Summary */}
      {deliverables.length > 0 && (
        <div className="flex justify-between items-center pt-2 border-t border-white/5 text-[9px] font-mono text-white/30">
          <span>
            {deliverables.filter((d) => d.aiModel === "nano").length} Nano,{" "}
            {deliverables.filter((d) => d.aiModel === "veo").length} Veo,{" "}
            {deliverables.filter((d) => d.aiModel === "sora").length} Sora
          </span>
          <span>Total: {deliverables.length} items</span>
        </div>
      )}
    </div>
  );
}
