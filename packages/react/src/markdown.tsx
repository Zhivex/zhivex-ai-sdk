"use client";
import { useMemo, useState, type ReactNode } from "react";
import type { ContentPart } from "@zhivex-ai/core";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MessagePartRendererProps } from "./components.js";
import { stringMediaSource, useChatLabels, type ChatLabels, type MediaUrlPolicy } from "./component-support.js";

export interface MarkdownContentProps {
  children: string;
  labels?: Partial<ChatLabels>;
  mediaUrlPolicy?: MediaUrlPolicy;
  className?: string;
  onCopyError?: (error: unknown) => void;
  /** Return React nodes; no raw HTML injection is needed. */
  highlightCode?: (code: string, language: string | undefined) => ReactNode;
}

function CodeBlock({ code, language, labels: overrides, highlightCode, onCopyError }: {
  code: string; language?: string;
} & Omit<MarkdownContentProps, "children">) {
  const labels = useChatLabels(overrides);
  const [copied, setCopied] = useState<string>();
  return <div className="zhivex-code-block">
    <button className="zhivex-button zhivex-button--secondary" type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(code); setCopied(code); }
      catch (error) { onCopyError?.(error); }
    }}>{copied === code ? labels.copied : labels.copy}</button>
    <pre><code className={language ? `language-${language}` : undefined}>
      {highlightCode?.(code, language) ?? code}
    </code></pre>
  </div>;
}

export function MarkdownContent({ children, labels, mediaUrlPolicy, className, highlightCode, onCopyError }: MarkdownContentProps) {
  const components = useMemo<Components>(() => ({
    pre: ({ node }) => {
      const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
      if (!code || code.type !== "element") return null;
      const text = code.children.map((child) => child.type === "text" ? child.value : "").join("");
      const classes = code.properties.className;
      const languageClass = Array.isArray(classes) ? classes.find((value) => String(value).startsWith("language-")) : undefined;
      return <CodeBlock code={text.replace(/\n$/, "")} language={languageClass ? String(languageClass).slice(9) : undefined}
        labels={labels} highlightCode={highlightCode} onCopyError={onCopyError} />;
    },
    a: ({ node: _node, ...props }) => <a {...props} rel="noopener noreferrer" referrerPolicy="no-referrer" />,
    img: ({ src, alt }) => {
      const source = typeof src === "string" ? stringMediaSource(src, "image/*", "image", mediaUrlPolicy) : undefined;
      return source ? <img src={source} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" /> : <span>{alt}</span>;
    }
  }), [labels, mediaUrlPolicy, highlightCode, onCopyError]);
  return <div className={className ?? "zhivex-markdown"}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components} urlTransform={defaultUrlTransform}>{children}</ReactMarkdown>
  </div>;
}

export function MarkdownMessagePart({ part, labels, mediaUrlPolicy }: MessagePartRendererProps<Extract<ContentPart, { type: "text" }>>) {
  return <MarkdownContent labels={labels} mediaUrlPolicy={mediaUrlPolicy}>{part.text}</MarkdownContent>;
}
