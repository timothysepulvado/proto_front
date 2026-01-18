import { useState } from "react";
import { Sparkles, Send, RotateCcw, Loader2 } from "lucide-react";

interface PromptInputProps {
  onSubmit: (prompt: string) => Promise<void>;
  placeholder?: string;
  disabled?: boolean;
  showBrandContext?: boolean;
}

const PROMPT_SUGGESTIONS = [
  "A serene lifestyle moment with soft natural lighting and organic textures",
  "Minimalist product showcase with clean lines and neutral tones",
  "Warm, inviting scene featuring everyday moments of comfort",
  "Modern aesthetic with subtle brand elements and premium feel",
];

export function PromptInput({
  onSubmit,
  placeholder = "Describe the visual style, mood, and key elements...",
  disabled = false,
  showBrandContext = true,
}: PromptInputProps) {
  const [prompt, setPrompt] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!prompt.trim() || isSubmitting || disabled) return;

    setIsSubmitting(true);
    try {
      await onSubmit(prompt.trim());
      setPrompt("");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const useSuggestion = (suggestion: string) => {
    setPrompt(suggestion);
  };

  return (
    <div className="space-y-3">
      {/* Prompt Input */}
      <div className="relative">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || isSubmitting}
          rows={3}
          className="w-full bg-white/5 border border-white/10 p-4 pr-14 rounded-xl outline-none focus:border-cyan-400/50 font-mono text-white text-sm resize-none placeholder:text-white/20 disabled:opacity-50 transition-all"
        />
        <button
          onClick={handleSubmit}
          disabled={!prompt.trim() || isSubmitting || disabled}
          className="absolute right-3 bottom-3 p-2 rounded-lg bg-cyan-500/20 border border-cyan-500/40 text-cyan-400 hover:bg-cyan-500/30 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
        >
          {isSubmitting ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Send size={16} />
          )}
        </button>
      </div>

      {/* Brand Context Indicator */}
      {showBrandContext && (
        <div className="flex items-center space-x-2 text-[9px] font-mono text-cyan-400/60">
          <Sparkles size={10} />
          <span>Brand DNA context will be injected automatically</span>
        </div>
      )}

      {/* Quick Suggestions */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-mono text-white/30 uppercase tracking-wider">
            Quick Prompts
          </span>
          <button
            onClick={() => setPrompt("")}
            className="text-[9px] font-mono text-white/30 hover:text-white/50 flex items-center space-x-1 transition-colors"
          >
            <RotateCcw size={10} />
            <span>Clear</span>
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {PROMPT_SUGGESTIONS.map((suggestion, i) => (
            <button
              key={i}
              onClick={() => useSuggestion(suggestion)}
              disabled={disabled || isSubmitting}
              className="px-3 py-1.5 text-[10px] font-mono bg-white/5 border border-white/10 rounded-lg text-white/50 hover:text-white hover:border-white/20 hover:bg-white/10 transition-all disabled:opacity-30 disabled:cursor-not-allowed truncate max-w-[200px]"
              title={suggestion}
            >
              {suggestion.slice(0, 40)}...
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
