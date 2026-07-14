import { useMemo, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { ID_PATTERN } from "@AiDailyTasks/shared";
import { useTaskDrawer } from "@/lib/navigation";

// Allow our custom `task:` links (and keep highlight.js class names) through sanitize,
// plus embedded images (pasted screenshots) served from our same-origin /api attachment urls.
const schema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "task"],
  },
  tagNames: [...(defaultSchema.tagNames ?? []), "img"],
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), ["className"] as [string]],
    code: [...(defaultSchema.attributes?.code ?? []), ["className"] as [string]],
    img: [...(defaultSchema.attributes?.img ?? []), "src", "alt", "title", "loading"],
  },
};

type AnchorProps = ComponentPropsWithoutRef<"a"> & { node?: unknown };
type ImageProps = ComponentPropsWithoutRef<"img"> & { node?: unknown };

const TASK_TOKEN = /(?<![\w/[])C\d+\b/g;

/**
 * Rewrite bare `C##` tokens and `[[C##]]` wiki-links into `task:` links so they
 * become clickable, without touching fenced or inline code.
 */
function linkifyTaskIds(markdown: string): string {
  const fences = markdown.split(/(```[\s\S]*?```)/g);
  return fences
    .map((block, i) => {
      if (i % 2 === 1) return block; // fenced code — leave untouched
      const inline = block.split(/(`[^`]*`)/g);
      return inline
        .map((seg, j) => {
          if (j % 2 === 1) return seg; // inline code — leave untouched
          return seg
            .replace(/\[\[(C\d+)\]\]/g, (_m, id: string) => `[${id}](task:${id})`)
            .replace(TASK_TOKEN, (m) => `[${m}](task:${m})`);
        })
        .join("");
    })
    .join("");
}

export function MarkdownView({ markdown }: { markdown: string }) {
  const { openTask } = useTaskDrawer();
  const source = useMemo(() => linkifyTaskIds(markdown ?? ""), [markdown]);

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, schema], rehypeHighlight]}
        components={{
          a({ href, children, node: _node, ...rest }: AnchorProps) {
            if (href?.startsWith("task:")) {
              const id = href.slice("task:".length);
              return (
                <a
                  href={`?task=${id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    openTask(id);
                  }}
                >
                  {children}
                </a>
              );
            }
            const bare = typeof children === "string" ? children : "";
            if (!href && ID_PATTERN.test(bare)) {
              return (
                <a
                  href={`?task=${bare}`}
                  onClick={(e) => {
                    e.preventDefault();
                    openTask(bare);
                  }}
                >
                  {children}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer" {...rest}>
                {children}
              </a>
            );
          },
          img({ src, alt, node: _node, ...rest }: ImageProps) {
            if (!src) return null;
            // Open the full-size image in a new tab on click; the inline render is
            // capped by the `.md img` styles so large screenshots stay readable.
            return (
              <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noreferrer">
                <img src={src} alt={alt ?? ""} loading="lazy" {...rest} />
              </a>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
