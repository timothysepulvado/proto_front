import type { ReactNode } from "react";

type PillarPlaceholderProps = {
  title: string;
  phaseLabel?: string;
  body: string;
  accent?: "cyan" | "orange";
  children?: ReactNode;
};

const accentStyles = {
  cyan: {
    border: "border-cyan-400/20",
    wash: "bg-cyan-400/5",
    glow: "from-cyan-400/25 via-cyan-300/10 to-transparent",
    text: "text-cyan-100",
    label: "text-cyan-300/75",
    dot: "bg-cyan-300 shadow-[0_0_18px_rgba(61,231,255,0.7)]",
  },
  orange: {
    border: "border-[#ED4C14]/25",
    wash: "bg-[#ED4C14]/10",
    glow: "from-[#ED4C14]/30 via-orange-300/10 to-transparent",
    text: "text-orange-100",
    label: "text-orange-200/80",
    dot: "bg-[#ED4C14] shadow-[0_0_18px_rgba(237,76,20,0.72)]",
  },
} as const;

export default function PillarPlaceholder({
  title,
  phaseLabel = "Coming in Phase 8",
  body,
  accent = "cyan",
  children,
}: PillarPlaceholderProps) {
  const styles = accentStyles[accent];

  return (
    <section className={`relative mt-3 overflow-hidden rounded-2xl border ${styles.border} ${styles.wash} px-4 py-5 sm:px-5 sm:py-6`}>
      <div className={`absolute inset-x-0 top-0 h-px bg-gradient-to-r ${styles.glow}`} />
      <div className="absolute right-3 top-3 h-20 w-20 rounded-full border border-white/5 bg-white/[0.02] blur-[1px]" />
      <div className="absolute right-6 top-6 h-10 w-10 rounded-full border border-white/10" />

      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 max-w-2xl">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${styles.dot}`} />
            <p className={`text-[9px] font-mono uppercase tracking-[0.28em] ${styles.label}`}>
              {phaseLabel}
            </p>
          </div>
          <h2 className={`mt-3 text-lg font-semibold tracking-[-0.02em] ${styles.text} sm:text-xl`}>
            {title}
          </h2>
          <p className="mt-2 text-[10px] leading-relaxed text-white/45 sm:text-[11px]">
            {body}
          </p>
        </div>

        <div className="grid w-full shrink-0 grid-cols-3 gap-1 sm:w-32">
          {Array.from({ length: 9 }).map((_, index) => (
            <div
              key={index}
              className={`h-8 rounded-lg border border-white/5 bg-black/20 ${index % 2 === 0 ? "opacity-70" : "opacity-35"}`}
            />
          ))}
        </div>
      </div>

      {children ? <div className="relative mt-5">{children}</div> : null}
    </section>
  );
}
