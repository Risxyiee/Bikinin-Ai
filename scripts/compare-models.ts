// Runs the same task on 2-3 models in separate workspaces and prints a comparison table.
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { runAgent } from "../src/agent/loop.js";
import { loadConfig } from "../src/config.js";
import { createEmitter, type AgentEvent } from "../src/events.js";
import { createOpenAiLlm } from "../src/llm/client.js";
import { loadSystemPrompt } from "../src/prompt.js";

const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40);

async function main(): Promise<number> {
  const [task, ...models] = process.argv.slice(2);
  if (!task || models.length < 2 || models.length > 3) {
    console.error(
      'Pemakaian: npm run compare -- "tugas" model-a model-b [model-c]',
    );
    return 2;
  }

  const cfg = loadConfig();
  const llm = createOpenAiLlm({
    baseURL: cfg.LLM_BASE_URL,
    apiKey: cfg.LLM_API_KEY,
  });
  const systemPrompt = await loadSystemPrompt();
  const rows: Record<string, string | number>[] = [];

  for (const model of models) {
    const dir = resolve(
      cfg.BIKININ_WORKSPACE,
      "compare",
      `${slug(model)}-${Date.now()}`,
    );
    await mkdir(dir, { recursive: true });
    const workspace = await realpath(dir);
    const sessionId = `cmp_${slug(model)}`;
    const events: AgentEvent[] = [];
    const emit = createEmitter(`run_${slug(model)}`, (e) => events.push(e));

    const result = await runAgent({
      llm,
      model,
      systemPrompt,
      message: task,
      sessionId,
      workspace,
      limits: {
        maxSteps: cfg.BIKININ_MAX_STEPS,
        maxCostUsd: cfg.BIKININ_MAX_COST_USD,
      },
      prices: {
        inPerM: cfg.PRICE_INPUT_PER_M,
        outPerM: cfg.PRICE_OUTPUT_PER_M,
      },
      emit,
      approve: async () => false, // comparisons never run unapproved commands
    });

    rows.push({
      model,
      status: result.status,
      langkah: result.totals.steps,
      token_in: result.totals.input_tokens,
      token_out: result.totals.output_tokens,
      biaya_usd: Number(result.totals.cost_usd.toFixed(5)),
      waktu_dtk: Number((result.durationMs / 1000).toFixed(1)),
      file_terbentuk: result.filesCreated.length > 0 ? "ya" : "tidak",
      folder: dir,
    });
  }

  console.table(rows);
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
