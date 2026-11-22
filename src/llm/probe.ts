// The provider check from AGENTS.md section 6, shared by `npm run check-provider` and the UI:
// plain chat, streaming, usage and tool calling. Messages never contain API keys.
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { createOpenAiLlm, type LlmClient } from "./client.js";
import { costUsd } from "./pricing.js";
import type { ProviderConfig } from "./providers.js";

const PING_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "ping",
    description: "Mengembalikan teks yang diberikan",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
};

export interface ProbeRow {
  check: string;
  ok: boolean;
  detail: string;
}
export interface ProbeResult {
  ok: boolean;
  rows: ProbeRow[];
  spentUsd: number;
}

const msg = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export async function probeProvider(
  p: ProviderConfig,
  makeClient: (p: ProviderConfig) => LlmClient = (x) =>
    createOpenAiLlm({ baseURL: x.baseUrl, apiKey: x.apiKey }),
): Promise<ProbeResult> {
  const llm = makeClient(p);
  const price = { inPerM: p.inPerM, outPerM: p.outPerM };
  const rows: ProbeRow[] = [];
  let spent = 0;

  let deltas = 0;
  try {
    const r = await llm.chat({
      model: p.model,
      messages: [{ role: "user", content: "Balas dengan satu kata: pong" }],
      tools: [],
      onText: () => {
        deltas += 1;
      },
    });
    spent += costUsd(r.usage, price);
    rows.push({
      check: "chat biasa",
      ok: r.text.trim() !== "",
      detail: r.text.trim().slice(0, 40),
    });
    rows.push({
      check: "streaming",
      ok: deltas > 0,
      detail: `${deltas} delta`,
    });
    rows.push({
      check: "usage",
      ok: r.usage.input_tokens > 0 && r.usage.output_tokens > 0,
      detail: `in ${r.usage.input_tokens} / out ${r.usage.output_tokens}`,
    });
  } catch (err) {
    rows.push({ check: "chat biasa", ok: false, detail: msg(err) });
  }

  try {
    const r = await llm.chat({
      model: p.model,
      messages: [
        { role: "user", content: 'Panggil tool ping dengan text "halo".' },
      ],
      tools: [PING_TOOL],
    });
    spent += costUsd(r.usage, price);
    const call = r.toolCalls.find((c) => c.function.name === "ping");
    let argsOk = false;
    try {
      argsOk =
        call !== undefined &&
        typeof JSON.parse(call.function.arguments).text === "string";
    } catch {
      argsOk = false;
    }
    rows.push({
      check: "tool calling",
      ok: argsOk,
      detail: call
        ? `ping(${call.function.arguments.slice(0, 60)})`
        : "tidak ada tool call",
    });
  } catch (err) {
    rows.push({ check: "tool calling", ok: false, detail: msg(err) });
  }

  return { ok: rows.every((r) => r.ok), rows, spentUsd: spent };
}
