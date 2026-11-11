import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import css from "../../third-party/dsh/MarkdownText.module.css";
const CodeFence = React.lazy(() => import("./CodeFence"));
function Fence({ children }: { children?: React.ReactNode }) {
  return (
    <React.Suspense fallback={<pre>{children}</pre>}>
      <CodeFence>{children}</CodeFence>
    </React.Suspense>
  );
}
export default function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className={css.markdown}>
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          pre: Fence,
          img: () => null,
          table: ({ children }) => (
            <div className={css.tableScroll + " " + css.tableFill}>
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
