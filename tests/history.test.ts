import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";
import {
  compactRun,
  HISTORY_CHAR_BUDGET,
  SessionHistory,
} from "../src/agent/history.js";

const toolCall = (id: string, args: string): Msg => ({
  role: "assistant",
  content: null,
  tool_calls: [
    { id, type: "function", function: { name: "write_file", arguments: args } },
  ],
});

describe("compactRun", () => {
  it("cuts long tool output and long tool arguments but keeps them valid", () => {
    const big = "x".repeat(5000);
    const run: Msg[] = [
      { role: "user", content: "buat halaman" },
      toolCall("c1", JSON.stringify({ path: "index.html", content: big })),
      { role: "tool", tool_call_id: "c1", content: big },
    ];
    const out = compactRun(run);
    const args = JSON.parse(
      (out[1] as { tool_calls: { function: { arguments: string } }[] })
        .tool_calls[0].function.arguments,
    );
    expect(args.path).toBe("index.html");
    expect(args.content.length).toBeLessThan(500);
    expect(args.content).toContain("dipotong");
    expect(String((out[2] as { content: string }).content).length).toBeLessThan(
      1400,
    );
  });

  it("drops a tool-call turn whose results are missing", () => {
    const run: Msg[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "b" },
      toolCall("c1", "{}"),
    ];
    expect(compactRun(run).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });

  it("replaces unparseable arguments with an empty object", () => {
    const out = compactRun([
      { role: "user", content: "a" },
      toolCall("c1", "{rusak"),
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ]);
    expect(
      (out[1] as { tool_calls: { function: { arguments: string } }[] })
        .tool_calls[0].function.arguments,
    ).toBe("{}");
  });
});

describe("SessionHistory", () => {
  it("replays runs in order", () => {
    const h = new SessionHistory();
    h.add([
      { role: "user", content: "satu" },
      { role: "assistant", content: "A" },
    ]);
    h.add([
      { role: "user", content: "dua" },
      { role: "assistant", content: "B" },
    ]);
    expect(h.messages().map((m) => m.content)).toEqual([
      "satu",
      "A",
      "dua",
      "B",
    ]);
  });

  it("drops the oldest runs over budget but always keeps the newest", () => {
    const h = new SessionHistory();
    const chunk = "y".repeat(Math.floor(HISTORY_CHAR_BUDGET / 2));
    h.add([
      { role: "user", content: "lama" },
      { role: "assistant", content: chunk },
    ]);
    h.add([
      { role: "user", content: "tengah" },
      { role: "assistant", content: chunk },
    ]);
    h.add([
      { role: "user", content: "baru" },
      { role: "assistant", content: chunk },
    ]);
    const users = h
      .messages()
      .filter((m) => m.role === "user")
      .map((m) => m.content);
    expect(users).not.toContain("lama");
    expect(users).toContain("baru");
  });
});
