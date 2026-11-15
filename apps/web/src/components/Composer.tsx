import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";

const MAX = 4000;

export function Composer({ onSend, onStop, busy }: { onSend: (t: string) => void; onStop: () => void; busy: boolean }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const submit = () => {
    if (!text.trim() || busy) return;
    onSend(text);
    setText("");
  };

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white shadow-sm focus-within:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:focus-within:border-zinc-700">
      <textarea
        ref={ref}
        value={text}
        maxLength={MAX}
        rows={1}
        placeholder="Ask anything, or about something we discussed before…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        className="block max-h-[200px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-6 placeholder:text-zinc-400 focus:outline-none"
      />
      <div className="flex items-center justify-between px-3 pb-2.5">
        <span className="text-[11px] text-zinc-400">{text.length > MAX * 0.8 ? `${text.length}/${MAX}` : "Enter to send · Shift+Enter for a new line"}</span>
        {busy ? (
          <button onClick={onStop} aria-label="Stop" className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900">
            <Square className="h-3.5 w-3.5" fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!text.trim()}
            aria-label="Send"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900 text-white transition hover:bg-zinc-700 disabled:bg-zinc-200 disabled:text-zinc-400 dark:bg-zinc-100 dark:text-zinc-900 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-600"
          >
            <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
}
