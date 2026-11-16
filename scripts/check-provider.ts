// Checks every configured provider (AGENTS.md section 6): chat, streaming, usage, tool calling.
// Prints PASS/FAIL per provider and check. Never prints API keys.
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { loadConfig } from "../src/config.js";
import {
  createOpenAiLlm,
  type ChatResult,
  type LlmClient,
} from "../src/llm/client.js";
import type { ProviderConfig } from "../src/llm/providers.js";
import { costUsd } from "../src/llm/pricing.js";

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
  provider: string;
  check: string;
  ok: boolean;
  detail: string;
}

async function checkOne(
  p: ProviderConfig,
): Promise<{ rows: Row[]; spent: number }> {
  const llm: LlmClient = createOpenAiLlm({
    baseURL: p.baseUrl,
    apiKey: p.apiKey,
  });
  const rows: Row[] = [];
  let spent = 0;
  const price = { inPerM: p.inPerM, outPerM: p.outPerM };

  let deltas = 0;
  try {
    const r: ChatResult = await llm.chat({
      model: p.model,
      messages: [{ role: "user", content: "Balas dengan satu kata: pong" }],
      tools: [],
      onText: () => {
        deltas += 1;
      },
    });
    spent += costUsd(r.usage, price);
    rows.push({
      provider: p.name,
      check: "chat biasa",
      ok: r.text.trim() !== "",
      detail: r.text.trim().slice(0, 40),
    });
    rows.push({
      provider: p.name,
      check: "streaming",
      ok: deltas > 0,
      detail: `${deltas} delta`,
    });
    rows.push({
      provider: p.name,
      check: "usage",
      ok: r.usage.input_tokens > 0 && r.usage.output_tokens > 0,
      detail: `in ${r.usage.input_tokens} / out ${r.usage.output_tokens}`,
    });
  } catch (err) {
    rows.push({
      provider: p.name,
      check: "chat biasa",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
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
      provider: p.name,
      check: "tool calling",
      ok: argsOk,
      detail: call
        ? `ping(${call.function.arguments.slice(0, 60)})`
        : "tidak ada tool call",
    });
  } catch (err) {
    rows.push({
      provider: p.name,
      check: "tool calling",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return { rows, spent };
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  const rows: Row[] = [];
  let spent = 0;
  for (const p of cfg.providers) {
    const r = await checkOne(p);
    rows.push(...r.rows);
    spent += r.spent;
  }
  console.table(rows);
  console.log(`Perkiraan biaya cek: $${spent.toFixed(6)}`);
  const failed = rows.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(
      `GAGAL: ${failed.map((f) => `${f.provider}/${f.check}`).join(", ")}. Jangan pakai provider itu sebagai default.`,
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
