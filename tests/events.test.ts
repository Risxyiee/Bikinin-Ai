import { describe, expect, it } from "vitest";
import {
  AgentEvent,
  createEmitter,
  toNDJSON,
  toSSE,
  type AgentEvent as Ev,
} from "../src/events.js";

describe("event contract", () => {
  it("createEmitter stamps envelope fields and rejects invalid payloads", () => {
    const events: Ev[] = [];
    const emit = createEmitter("run_x", (e) => events.push(e));
    emit("text_delta", { text: "halo" });
    expect(events[0]).toMatchObject({
      v: 1,
      seq: 0,
      run_id: "run_x",
      type: "text_delta",
    });
    // @ts-expect-error missing required fields on purpose
    expect(() => emit("tool_call_started", { call_id: "x" })).toThrow();
  });

  it("serializes to NDJSON and SSE", () => {
    const e = AgentEvent.parse({
      v: 1,
      seq: 3,
      ts: "2026-11-16T00:00:00.000Z",
      run_id: "r",
      type: "text_delta",
      text: "a",
    });
    expect(toNDJSON(e).endsWith("\n")).toBe(true);
    expect(toSSE(e)).toContain("id: 3\nevent: text_delta\n");
  });
});
