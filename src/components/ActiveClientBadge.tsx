import { Dna } from "lucide-react";

interface ActiveClientBadgeProps {
  client: {
    id: string;
    name: string;
    displayName?: string;
    entityLabel?: string;
    status?: string;
    featured?: boolean;
  } | null;
}

export default function ActiveClientBadge({ client }: ActiveClientBadgeProps) {
  if (!client) return null;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-cyan-400/20 bg-[#15217C]/35 px-4 py-3 shadow-[0_0_28px_rgba(21,33,124,0.28)]">
      <div className="absolute inset-y-0 left-0 w-1 bg-cyan-300 shadow-[0_0_18px_rgba(34,211,238,0.9)]" />
      <div className="relative flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-cyan-300/30 bg-cyan-300/10">
            <Dna size={14} className="text-cyan-200" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[9px] font-mono uppercase tracking-[0.32em] text-cyan-100/55">
              Active {client.entityLabel ?? "Brand"}
            </p>
            <p className="truncate text-sm font-black uppercase tracking-tight text-white">
              {client.displayName ?? client.name}
            </p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-[8px] uppercase tracking-[0.22em] text-cyan-200/70">
            {client.featured ? "Featured" : client.status ?? "active"}
          </p>
          <p className="mt-1 max-w-[180px] truncate font-mono text-[9px] text-white/45">
            {client.id}
          </p>
        </div>
      </div>
    </div>
  );
}
