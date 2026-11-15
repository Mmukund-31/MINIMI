import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SourceRef } from "../lib/api";

/** Only http(s)/mailto links and internal citation anchors are allowed. */
function safeUrl(url: string): string {
  if (url.startsWith("#cite-")) return url;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:" ? url : "";
  } catch {
    return "";
  }
}

/**
 * Renders model output as markdown. Raw HTML is not rendered (react-markdown
 * default), URLs are protocol-filtered, and [S#] citations become clickable
 * chips that open the original source.
 */
export function Markdown({ text, sources, streaming = false }: { text: string; sources: SourceRef[]; streaming?: boolean }) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const withCitations = text.replace(/\[(S\d+)\]/g, (_m, id: string) => (byId.has(id) ? `[${id}](#cite-${id})` : ""));

  const components: Components = {
    a({ href, children }) {
      if (href?.startsWith("#cite-")) {
        const s = byId.get(href.slice(6));
        if (!s) return null;
        return (
          <a
            href={s.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            title={`${s.title} · ${s.domain}`}
            className="mx-0.5 inline-flex -translate-y-0.5 items-center rounded-md border border-zinc-200 bg-zinc-50 px-1.5 text-[11px] leading-5 font-medium text-zinc-600 no-underline transition hover:border-indigo-300 hover:text-indigo-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-indigo-500 dark:hover:text-indigo-300"
          >
            {s.id.slice(1)}
          </a>
        );
      }
      if (!href) return <>{children}</>;
      return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow">
          {children}
        </a>
      );
    },
  };

  return (
    <div className={`prose-answer ${streaming ? "caret" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeUrl} components={components}>
        {withCitations}
      </ReactMarkdown>
    </div>
  );
}
