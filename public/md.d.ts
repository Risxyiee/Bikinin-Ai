export type Inline =
  | { t: "text" | "strong" | "em" | "code"; v: string }
  | { t: "link"; v: string; href: string };

export type Block =
  | { t: "p"; inline: Inline[] }
  | { t: "h"; level: number; inline: Inline[] }
  | { t: "ul" | "ol"; items: Inline[][] }
  | { t: "code"; lang: string; text: string }
  | { t: "hr" };

export function parseInline(text: string): Inline[];
export function parseBlocks(src: string): Block[];
