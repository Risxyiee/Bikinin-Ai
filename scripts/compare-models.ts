// Runs the same task on 2-3 configured providers (by name) in separate workspaces, then prints a table.
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { runAgent } from "../src/agent/loop.js";
import { loadConfig } from "../src/config.js";
import { createEmitter, type AgentEvent } from "../src/events.js";
import { createFallbackLlm } from "../src/llm/fallback.js";
import { loadSystemPrompt } from "../src/prompt.js";

const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40);

async function main(): Promise<number> {
  const [task, ...names] = process.argv.slice(2);
  if (!task || names.length < 2 || names.length > 3) {
    console.error(
      'Pemakaian: npm run compare -- "tugas" nama-provider-a nama-provider-b [nama-provider-c]',
    );
    return 2;
  }

  const cfg = loadConfig();
  const systemPrompt = await loadSystemPrompt();
  const rows: Record<string, string | number>[] = [];

  for (const name of names) {
    const provider = cfg.providers.find((p) => p.name === name);
    if (!provider) {
      console.error(
        `Provider "${name}" tidak ada. Pilihan: ${cfg.providers.map((p) => p.name).join(", ")}`,
      );
      return 2;
    }
    const dir = resolve(
      cfg.BIKININ_WORKSPACE,
      "compare",
      `${slug(name)}-${Date.now()}`,
    );
    await mkdir(dir, { recursive: true });
    const workspace = await realpath(dir);
    const events: AgentEvent[] = [];
    const emit = createEmitter(`run_${slug(name)}`, (e) => events.push(e));

    const result = await runAgent({
      llm: createFallbackLlm([provider]), // no fallback during comparison: each provider runs alone
      model: provider.model,
      systemPrompt,
      message: task,
      sessionId: `cmp_${slug(name)}`,
      workspace,
      limits: {
        maxSteps: cfg.BIKININ_MAX_STEPS,
        maxCostUsd: cfg.BIKININ_MAX_COST_USD,
      },
      prices: { inPerM: provider.inPerM, outPerM: provider.outPerM },
      emit,
      approve: async () => false, // comparisons never run unapproved commands
    });

    rows.push({
      provider: name,
      model: provider.model,
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
