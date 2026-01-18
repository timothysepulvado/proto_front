import { useState, useMemo } from "react";
import {
  X,
  Download,
  Image as ImageIcon,
  Video,
  FileText,
  Package,
  Filter,
  Grid,
  List,
  Eye,
  CheckCircle,
  AlertCircle,
  Clock,
} from "lucide-react";
import type { Artifact } from "../api";

interface ArtifactGalleryProps {
  artifacts: Artifact[];
  onSelect?: (artifact: Artifact) => void;
  onDownload?: (artifact: Artifact) => void;
  onClose?: () => void;
  showFilters?: boolean;
  title?: string;
}

type FilterType = "all" | Artifact["type"];
type ViewMode = "grid" | "list";

const TYPE_ICONS: Record<Artifact["type"], typeof ImageIcon> = {
  image: ImageIcon,
  video: Video,
  report: FileText,
  package: Package,
};

const TYPE_LABELS: Record<Artifact["type"], string> = {
  image: "Images",
  video: "Videos",
  report: "Reports",
  package: "Packages",
};

const GradeBadge = ({ grade }: { grade?: Artifact["grade"] }) => {
  if (!grade) return null;

  const getGradeDisplay = () => {
    if (grade.decision === "AUTO_PASS") {
      return { label: "A+", color: "bg-green-500/20 text-green-400 border-green-500/30" };
    }
    if (grade.fused >= 0.8) {
      return { label: "A", color: "bg-green-500/20 text-green-400 border-green-500/30" };
    }
    if (grade.fused >= 0.7) {
      return { label: "B", color: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30" };
    }
    if (grade.fused >= 0.5) {
      return { label: "C", color: "bg-amber-500/20 text-amber-400 border-amber-500/30" };
    }
    return { label: "D", color: "bg-red-500/20 text-red-400 border-red-500/30" };
  };

  const { label, color } = getGradeDisplay();

  return (
    <span className={`px-2 py-0.5 text-[10px] font-mono font-bold rounded border ${color}`}>
      {label}
    </span>
  );
};

const StatusIcon = ({ grade }: { grade?: Artifact["grade"] }) => {
  if (!grade) {
    return <Clock size={14} className="text-white/30" />;
  }

  switch (grade.decision) {
    case "AUTO_PASS":
      return <CheckCircle size={14} className="text-green-400" />;
    case "AUTO_FAIL":
      return <AlertCircle size={14} className="text-red-400" />;
    case "HITL_REVIEW":
      return <Eye size={14} className="text-amber-400" />;
    default:
      return <Clock size={14} className="text-white/30" />;
  }
};

export function ArtifactGallery({
  artifacts,
  onSelect,
  onDownload,
  onClose,
  showFilters = true,
  title = "Artifact Gallery",
}: ArtifactGalleryProps) {
  const [filter, setFilter] = useState<FilterType>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");

  const filteredArtifacts = useMemo(() => {
    if (filter === "all") return artifacts;
    return artifacts.filter((a) => a.type === filter);
  }, [artifacts, filter]);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: artifacts.length };
    for (const artifact of artifacts) {
      counts[artifact.type] = (counts[artifact.type] || 0) + 1;
    }
    return counts;
  }, [artifacts]);

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  if (artifacts.length === 0) {
    return (
      <div className="p-8 text-center">
        <Package size={48} className="text-white/20 mx-auto mb-4" />
        <p className="text-sm font-mono text-white/40">No artifacts yet</p>
        <p className="text-[10px] font-mono text-white/20 mt-1">
          Run a campaign to generate artifacts
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-white/10">
        <div className="flex items-center space-x-3">
          <ImageIcon size={18} className="text-cyan-400" />
          <span className="text-sm font-mono text-white/80">{title}</span>
          <span className="text-[10px] font-mono text-white/40">
            {filteredArtifacts.length} item{filteredArtifacts.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center space-x-2">
          {/* View Mode Toggle */}
          <div className="flex bg-white/5 rounded-lg p-0.5">
            <button
              onClick={() => setViewMode("grid")}
              className={`p-1.5 rounded transition-all ${
                viewMode === "grid"
                  ? "bg-cyan-500/20 text-cyan-400"
                  : "text-white/40 hover:text-white"
              }`}
            >
              <Grid size={14} />
            </button>
            <button
              onClick={() => setViewMode("list")}
              className={`p-1.5 rounded transition-all ${
                viewMode === "list"
                  ? "bg-cyan-500/20 text-cyan-400"
                  : "text-white/40 hover:text-white"
              }`}
            >
              <List size={14} />
            </button>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-white/10 rounded-lg transition-colors"
            >
              <X size={16} className="text-white/40 hover:text-white" />
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="flex items-center space-x-2 p-4 border-b border-white/5">
          <Filter size={12} className="text-white/30" />
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setFilter("all")}
              className={`px-3 py-1 text-[10px] font-mono rounded-lg border transition-all ${
                filter === "all"
                  ? "bg-cyan-500/20 border-cyan-500/40 text-cyan-400"
                  : "border-white/10 text-white/40 hover:border-white/20"
              }`}
            >
              All ({typeCounts.all})
            </button>
            {(Object.keys(TYPE_LABELS) as Artifact["type"][]).map((type) => {
              const count = typeCounts[type] || 0;
              if (count === 0) return null;
              const Icon = TYPE_ICONS[type];
              return (
                <button
                  key={type}
                  onClick={() => setFilter(type)}
                  className={`px-3 py-1 text-[10px] font-mono rounded-lg border transition-all flex items-center space-x-1.5 ${
                    filter === type
                      ? "bg-cyan-500/20 border-cyan-500/40 text-cyan-400"
                      : "border-white/10 text-white/40 hover:border-white/20"
                  }`}
                >
                  <Icon size={10} />
                  <span>{TYPE_LABELS[type]} ({count})</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {viewMode === "grid" ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {filteredArtifacts.map((artifact) => {
              const Icon = TYPE_ICONS[artifact.type];
              return (
                <div
                  key={artifact.id}
                  onClick={() => onSelect?.(artifact)}
                  className="group relative bg-white/5 border border-white/10 rounded-xl overflow-hidden hover:border-cyan-500/30 transition-all cursor-pointer"
                >
                  {/* Thumbnail */}
                  <div className="aspect-square bg-black/30 flex items-center justify-center">
                    {artifact.thumbnailUrl ? (
                      <img
                        src={artifact.thumbnailUrl}
                        alt={artifact.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Icon size={32} className="text-white/20" />
                    )}
                  </div>

                  {/* Overlay on hover */}
                  <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center space-x-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect?.(artifact);
                      }}
                      className="p-2 bg-cyan-500/20 rounded-lg border border-cyan-500/40 text-cyan-400 hover:bg-cyan-500/30"
                    >
                      <Eye size={16} />
                    </button>
                    {onDownload && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDownload(artifact);
                        }}
                        className="p-2 bg-white/10 rounded-lg border border-white/20 text-white hover:bg-white/20"
                      >
                        <Download size={16} />
                      </button>
                    )}
                  </div>

                  {/* Grade Badge */}
                  <div className="absolute top-2 right-2">
                    <GradeBadge grade={artifact.grade} />
                  </div>

                  {/* Info */}
                  <div className="p-3 space-y-1">
                    <p className="text-[11px] font-mono text-white truncate">
                      {artifact.name}
                    </p>
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] font-mono text-white/30">
                        {formatFileSize(artifact.size)}
                      </span>
                      <StatusIcon grade={artifact.grade} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-2">
            {filteredArtifacts.map((artifact) => {
              const Icon = TYPE_ICONS[artifact.type];
              return (
                <div
                  key={artifact.id}
                  onClick={() => onSelect?.(artifact)}
                  className="flex items-center p-3 bg-white/5 border border-white/10 rounded-xl hover:border-cyan-500/30 transition-all cursor-pointer space-x-4"
                >
                  {/* Icon */}
                  <div className="w-10 h-10 rounded-lg bg-black/30 flex items-center justify-center shrink-0">
                    {artifact.thumbnailUrl ? (
                      <img
                        src={artifact.thumbnailUrl}
                        alt={artifact.name}
                        className="w-full h-full object-cover rounded-lg"
                      />
                    ) : (
                      <Icon size={18} className="text-white/30" />
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-mono text-white truncate">{artifact.name}</p>
                    <p className="text-[10px] font-mono text-white/30">
                      {formatDate(artifact.createdAt)} · {formatFileSize(artifact.size)}
                    </p>
                  </div>

                  {/* Grade */}
                  <GradeBadge grade={artifact.grade} />

                  {/* Status */}
                  <StatusIcon grade={artifact.grade} />

                  {/* Actions */}
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect?.(artifact);
                      }}
                      className="p-2 rounded-lg border border-white/10 text-white/40 hover:border-cyan-500/40 hover:text-cyan-400 transition-all"
                    >
                      <Eye size={14} />
                    </button>
                    {onDownload && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDownload(artifact);
                        }}
                        className="p-2 rounded-lg border border-white/10 text-white/40 hover:border-white/30 hover:text-white transition-all"
                      >
                        <Download size={14} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
