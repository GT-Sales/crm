'use client';

import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Model text can format an answer, but only server-built source cards can link. */
const components: Components = {
  h1: ({ children }) => <h3 className="text-base font-semibold leading-snug">{children}</h3>,
  h2: ({ children }) => <h3 className="text-sm font-semibold leading-snug">{children}</h3>,
  h3: ({ children }) => <h4 className="text-sm font-semibold leading-snug">{children}</h4>,
  p: ({ children }) => <p className="whitespace-pre-wrap leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5 leading-relaxed [&>p]:my-1">{children}</li>,
  table: ({ children }) => (
    <div
      role="region"
      aria-label="Answer table"
      tabIndex={0}
      className="max-w-full overflow-x-auto rounded-lg border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <table className="w-full border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
  tr: ({ children }) => <tr className="border-b border-border last:border-0">{children}</tr>,
  th: ({ children, style }) => (
    <th style={style} className="px-3 py-2 font-semibold whitespace-nowrap">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="px-3 py-2 align-top">
      {children}
    </td>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  pre: ({ children }) => (
    <pre className="max-w-full overflow-x-auto rounded-lg bg-muted p-3 text-xs">{children}</pre>
  ),
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>
  ),
  hr: () => <hr className="border-border" />,
  // No navigations, remote images, or active HTML from model output.
  a: ({ children }) => <span>{children}</span>,
  img: () => null,
};

export function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 max-w-full space-y-3 break-words text-sm text-foreground [overflow-wrap:anywhere]">
      <Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </Markdown>
    </div>
  );
}
