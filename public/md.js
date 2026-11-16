// Safe Markdown subset -> plain data. Produces no HTML strings: app.js builds DOM nodes from this.
// Supported: paragraphs, #/##/### headings, bullet and numbered lists, fenced code, --- rules,
// **bold**, *italic*, `code`, and [label](https://...) links. Anything else stays as plain text.

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
const LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/;

export function parseInline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) });
    const s = m[0];
    if (s.startsWith("`")) out.push({ t: "code", v: s.slice(1, -1) });
    else if (s.startsWith("**")) out.push({ t: "strong", v: s.slice(2, -2) });
    else if (s.startsWith("*")) out.push({ t: "em", v: s.slice(1, -1) });
    else {
      const [, label, href] = s.match(LINK);
      out.push({ t: "link", v: label, href });
    }
    last = m.index + s.length;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

export function parseBlocks(src) {
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ t: "p", inline: parseInline(para.join("\n")) });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push(list);
      list = null;
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      flushAll();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip the closing fence; an unclosed fence (still streaming) just runs to the end
      blocks.push({ t: "code", lang: fence[1], text: code.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flushAll();
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushAll();
      blocks.push({
        t: "h",
        level: heading[1].length,
        inline: parseInline(heading[2]),
      });
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushAll();
      blocks.push({ t: "hr" });
      i++;
      continue;
    }

    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushPara();
      const t = bullet ? "ul" : "ol";
      if (!list || list.t !== t) {
        flushList();
        list = { t, items: [] };
      }
      list.items.push(parseInline((bullet || numbered)[1]));
      i++;
      continue;
    }

    flushList();
    para.push(line);
    i++;
  }
  flushAll();
  return blocks;
}
