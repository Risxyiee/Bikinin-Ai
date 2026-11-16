import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "../public/md.js";

describe("parseInline", () => {
  it("splits bold, italic, code and links", () => {
    expect(parseInline("a **b** *c* `d` [e](https://x.test)")).toEqual([
      { t: "text", v: "a " },
      { t: "strong", v: "b" },
      { t: "text", v: " " },
      { t: "em", v: "c" },
      { t: "text", v: " " },
      { t: "code", v: "d" },
      { t: "text", v: " " },
      { t: "link", v: "e", href: "https://x.test" },
    ]);
  });

  it("keeps non-http links as plain text", () => {
    expect(parseInline("[klik](javascript:alert(1))")).toEqual([
      { t: "text", v: "[klik](javascript:alert(1))" },
    ]);
  });
});

describe("parseBlocks", () => {
  it("parses headings, paragraphs, lists and rules", () => {
    const blocks = parseBlocks(
      "# Judul\n\nTeks **tebal**\nbaris dua\n\n- satu\n- dua\n\n1. a\n2. b\n\n---",
    );
    expect(blocks.map((b) => b.t)).toEqual(["h", "p", "ul", "ol", "hr"]);
    expect(blocks[0]).toMatchObject({ level: 1 });
    expect(blocks[2]).toMatchObject({
      items: [[{ t: "text", v: "satu" }], [{ t: "text", v: "dua" }]],
    });
  });

  it("keeps fenced code verbatim, including markup", () => {
    const blocks = parseBlocks("```html\n<script>alert(1)</script>\n```");
    expect(blocks).toEqual([
      { t: "code", lang: "html", text: "<script>alert(1)</script>" },
    ]);
  });

  it("treats an unclosed fence (still streaming) as code to the end", () => {
    expect(parseBlocks("```\nsedang")).toEqual([
      { t: "code", lang: "", text: "sedang" },
    ]);
  });

  it("does not turn *** or ** at line start into a list", () => {
    expect(parseBlocks("**tebal** di awal")[0].t).toBe("p");
    expect(parseBlocks("***")[0].t).toBe("hr");
  });
});
