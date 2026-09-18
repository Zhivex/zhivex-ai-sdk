import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "../src/markdown.js";

describe("optional Markdown", () => {
  it("renders GFM tables and incomplete streaming code fences with copy controls", () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, { children: "| Name | Value |\n| --- | --- |\n| A | 1 |\n\n```ts\nconst answer = 42;" }));
    expect(html).toContain("<table>");
    expect(html).toContain('class="language-ts"');
    expect(html).toContain("Copy");
    expect(html).toContain("const answer = 42;");
  });
  it("discards raw HTML, unsafe links, and unapproved remote images", () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, { children: '<script>alert(1)</script>\n\n[x](javascript:alert)\n\n![tracker](https://example.com/pixel)' }));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
  });
});
