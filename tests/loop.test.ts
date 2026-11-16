import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent, type AgentDeps } from "../src/agent/loop.js";
import {
  createEmitter,
  type AgentEvent,
  type EventType,
} from "../src/events.js";
import type { ChatResult, LlmClient, ToolCallReq } from "../src/llm/client.js";
import { tempWorkspace } from "./helpers.js";

const usage = { input_tokens: 100, output_tokens: 20, cached_tokens: 0 };

function call(id: string, name: string, args: unknown): ToolCallReq {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}
const withCalls = (...toolCalls: ToolCallReq[]): ChatResult => ({
  text: "",
  toolCalls,
  usage,
});
const finalText = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  usage,
});

function scripted(responses: ChatResult[]): LlmClient {
  let i = 0;
  return {
    async chat(p) {
      const r = responses[i++];
      if (!r) throw new Error("skrip habis");
      if (r.text) p.onText?.(r.text);
      return r;
    },
  };
}

function ofType<T extends EventType>(events: AgentEvent[], type: T) {
  return events.filter(
    (e): e is Extract<AgentEvent, { type: T }> => e.type === type,
  );
}

async function run(
  responses: ChatResult[],
  overrides: Partial<AgentDeps> = {},
) {
  const workspace = await tempWorkspace();
  const events: AgentEvent[] = [];
  const emit = createEmitter("run_test", (e) => events.push(e));
  const deps: AgentDeps = {
    llm: scripted(responses),
    model: "test-model",
    systemPrompt: "sys",
    message: "tes",
    sessionId: "s_test",
    workspace,
    limits: { maxSteps: 10, maxCostUsd: 1 },
    prices: { inPerM: 1, outPerM: 2 },
    emit,
    approve: async () => false,
    ...overrides,
  };
  const result = await runAgent(deps);
  return { workspace, events, result };
}

const types = (events: AgentEvent[]) => events.map((e) => e.type);

function expectWellFormed(events: AgentEvent[]) {
  expect(types(events)[0]).toBe("run_started");
  expect(types(events).at(-1)).toBe("run_finished");
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  const started = ofType(events, "tool_call_started")
    .map((e) => e.call_id)
    .sort();
  const finished = ofType(events, "tool_call_finished")
    .map((e) => e.call_id)
    .sort();
  expect(finished).toEqual(started);
  expect(JSON.stringify(events)).not.toMatch(/\/home\/|LLM_API_KEY/);
}

describe("agent loop event contract", () => {
  it("writes a file, emits valid ordered events, and completes", async () => {
    const { workspace, events, result } = await run([
      withCalls(
        call("t1", "write_file", {
          path: "index.html",
          content: "<h1>Kopi</h1>",
        }),
      ),
      finalText("Selesai."),
    ]);
    expect(result.status).toBe("completed");
    expect(result.filesCreated).toEqual(["index.html"]);
    expect(await readFile(join(workspace, "index.html"), "utf8")).toBe(
      "<h1>Kopi</h1>",
    );
    expect(ofType(events, "file_changed")[0].path).toBe("index.html");
    expectWellFormed(events);
  });

  it("keeps the file content out of emitted arguments", async () => {
    const { events } = await run([
      withCalls(
        call("t1", "write_file", { path: "a.txt", content: "RAHASIA_ISI" }),
      ),
      finalText("ok"),
    ]);
    expect(JSON.stringify(ofType(events, "tool_call_started"))).not.toContain(
      "RAHASIA_ISI",
    );
  });

  it("places approval between tool start and finish, and denies by default", async () => {
    const { workspace, events, result } = await run([
      withCalls(call("t1", "run_command", { command: "npm install" })),
      finalText("ok"),
    ]);
    expect(result.status).toBe("completed");
    const order = types(events);
    const req = order.indexOf("approval_requested");
    expect(req).toBeGreaterThan(order.indexOf("tool_call_started"));
    expect(req).toBeLessThan(order.indexOf("tool_call_finished"));
    expect(ofType(events, "approval_resolved")[0].decision).toBe("deny");
    expect(ofType(events, "tool_call_finished")[0].ok).toBe(false);
    expectWellFormed(events);
    await expect(
      readFile(join(workspace, "node_modules"), "utf8"),
    ).rejects.toThrow();
  });

  it("blocks destructive commands without asking", async () => {
    const { events } = await run([
      withCalls(call("t1", "run_command", { command: "sudo ls" })),
      finalText("ok"),
    ]);
    expect(ofType(events, "approval_requested")).toHaveLength(0);
    expect(ofType(events, "error")[0].code).toBe("command_blocked");
    expectWellFormed(events);
  });

  it("returns invalid tool arguments to the model instead of crashing", async () => {
    const { events, result } = await run([
      withCalls(call("t1", "write_file", { path: "a.txt" })),
      finalText("maaf, saya perbaiki"),
    ]);
    expect(result.status).toBe("completed");
    expect(ofType(events, "tool_call_finished")[0].ok).toBe(false);
    expectWellFormed(events);
  });

  it("stops with budget_exceeded before running tools that would pass the step limit", async () => {
    const { events, result } = await run(
      [
        withCalls(
          call("t1", "list_dir", { path: "." }),
          call("t2", "list_dir", { path: "." }),
        ),
      ],
      { limits: { maxSteps: 1, maxCostUsd: 1 } },
    );
    expect(result.status).toBe("budget_exceeded");
    const finished = ofType(events, "run_finished")[0];
    expect(finished.resumable).toBe(true);
    expect(ofType(events, "tool_call_started")).toHaveLength(0);
    expectWellFormed(events);
  });

  it("ends with status error and a final run_finished when the provider fails", async () => {
    const { events, result } = await run([]);
    expect(result.status).toBe("error");
    expect(ofType(events, "error")[0].code).toBe("internal");
    expectWellFormed(events);
  });
});
