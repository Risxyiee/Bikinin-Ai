// Checks the LLM provider per AGENTS.md section 6: chat, tool calling, streaming, usage.
// Prints PASS/FAIL per check. Never prints the API key.
import { loadConfig } from "../src/config.js";
import { createOpenAiLlm, type ChatResult } from "../src/llm/client.js";
import { costUsd } from "../src/llm/pricing.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

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

interface Row {
  check: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  const llm = createOpenAiLlm({
    baseURL: cfg.LLM_BASE_URL,
    apiKey: cfg.LLM_API_KEY,
  });
  const rows: Row[] = [];
  let deltas = 0;
  let spent = 0;

  try {
    const r: ChatResult = await llm.chat({
      model: cfg.BIKININ_MODEL,
      messages: [{ role: "user", content: "Balas dengan satu kata: pong" }],
      tools: [],
      onText: () => {
        deltas += 1;
      },
    });
    spent += costUsd(r.usage, {
      inPerM: cfg.PRICE_INPUT_PER_M,
      outPerM: cfg.PRICE_OUTPUT_PER_M,
    });
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
    rows.push({
      check: "chat biasa",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const r = await llm.chat({
      model: cfg.BIKININ_MODEL,
      messages: [
        { role: "user", content: 'Panggil tool ping dengan text "halo".' },
      ],
      tools: [PING_TOOL],
    });
    spent += costUsd(r.usage, {
      inPerM: cfg.PRICE_INPUT_PER_M,
      outPerM: cfg.PRICE_OUTPUT_PER_M,
    });
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
    rows.push({
      check: "tool calling",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  console.table(rows);
  console.log(`Perkiraan biaya cek: $${spent.toFixed(6)}`);
  const failed = rows.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(
      `GAGAL: ${failed.map((f) => f.check).join(", ")}. Laporkan ke pemilik sebelum lanjut.`,
    );
    return 1;
  }
  console.log("Semua cek lolos.");
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
