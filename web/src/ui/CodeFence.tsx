import React, { useEffect, useMemo, useState } from "react";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import cssLanguage from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import diff from "highlight.js/lib/languages/diff";
import css from "../../third-party/dsh/CodeCard.module.css";
import { Icon } from "./Icon";
for (const [name, grammar] of Object.entries({
  javascript,
  typescript,
  json,
  python,
  bash,
  css: cssLanguage,
  xml,
  diff,
}))
  hljs.registerLanguage(name, grammar);
export function escapeCode(code: string) {
  return code
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
export default function CodeFence({ children }: { children: React.ReactNode }) {
  const child = React.Children.toArray(children).find(React.isValidElement) as
    | React.ReactElement<{ className?: string; children?: React.ReactNode }>
    | undefined;
  const code = String(child?.props.children ?? ""),
    language =
      /language-([^\s]+)/.exec(child?.props.className || "")?.[1] || "text";
  const [copied, setCopied] = useState(false),
    [wrap, setWrap] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const html = useMemo(() => {
    try {
      return code.length <= 65536 && hljs.getLanguage(language)
        ? hljs.highlight(code, { language, ignoreIllegals: true }).value
        : escapeCode(code);
    } catch {
      return escapeCode(code);
    }
  }, [code, language]);
  return (
    <div className={css.card + " code-card"}>
      <div className={css.header}>
        <span className={css.language}>{language}</span>
        <div className={css.actions}>
          <button
            className={css.action}
            aria-label="自动换行"
            aria-pressed={wrap}
            title="自动换行"
            onClick={() => setWrap(!wrap)}
          >
            <Icon name="wrap" size={15} />
          </button>
          <button
            className={css.action}
            aria-label={copied ? "已复制" : "复制代码"}
            title={error || "复制代码"}
            onClick={() => {
              void navigator.clipboard
                .writeText(code)
                .then(() => {
                  setCopied(true);
                  setError("");
                })
                .catch(() => setError("复制失败，请手动选择代码。"));
            }}
          >
            <Icon name={copied ? "check" : "copy"} size={15} />
          </button>
        </div>
      </div>
      <div className={css.body}>
        <pre className={"code-source " + (wrap ? "wrapped" : "")} tabIndex={0}>
          <code dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      </div>
      <span className="sr-only" role="status">
        {copied ? "代码已复制" : error}
      </span>
    </div>
  );
}
