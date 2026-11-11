import React from "react";
import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import CodeFence from "./CodeFence";
it("renders hostile source as inert highlighted text, with no executable tags", () => {
  const html = renderToStaticMarkup(
    <CodeFence>
      <code className="language-xml">
        {"<script>alert(1)</script><img src=x onerror=alert(2)>"}
      </code>
    </CodeFence>,
  );
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img ");
  expect(html).toContain("&lt;");
  expect(html).toContain("hljs-tag");
});
it("escapes unknown languages and offers wrapping/copy controls", () => {
  const html = renderToStaticMarkup(
    <CodeFence>
      <code className="language-unknown">
        {'<iframe src="javascript:alert(1)">'}
      </code>
    </CodeFence>,
  );
  expect(html).toContain("&lt;iframe");
  expect(html).not.toContain("<iframe");
  expect(html).toContain("复制代码");
  expect(html).toContain("自动换行");
});
