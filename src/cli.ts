// Terminal entry point. Text mode renders events; --json prints NDJSON (one event per line).
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { runAgent } from "./agent/loop.js";
import { loadConfig } from "./config.js";
import { createEmitter, toNDJSON, type AgentEvent } from "./events.js";
import { createOpenAiLlm } from "./llm/client.js";
import { loadSystemPrompt } from "./prompt.js";

function render(e: AgentEvent, usdIdr: number): void {
  const out = (s: string) => process.stdout.write(s);
  switch (e.type) {
    case "text_delta":
      out(e.text);
      break;
    case "tool_call_started":
      out(`\n▸ ${e.label}\n`);
      break;
    case "tool_call_finished":
      out(`  ${e.ok ? "✓" : "✗"} ${e.summary}\n`);
      break;
    case "budget_warning":
      out(`\n⚠ batas ${e.kind} ${e.percent}% (${e.used}/${e.limit})\n`);
      break;
    case "error":
      out(`\n✗ [${e.code}] ${e.message}\n`);
      break;
    case "run_finished": {
      const t = e.totals;
      const rupiah = Math.round(t.cost_usd * usdIdr).toLocaleString("id-ID");
      out(
        `\n\n— ${e.status} · ${t.steps} langkah · token in ${t.input_tokens} / out ${t.output_tokens} · $${t.cost_usd.toFixed(4)} (≈Rp ${rupiah}) · ${(e.duration_ms / 1000).toFixed(1)} dtk\n`,
      );
      break;
    }
    default:
      break;
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const message = argv
    .filter((a) => !a.startsWith("--"))
    .join(" ")
    .trim();
  if (!message) {
    process.stderr.write(
      'Pemakaian: npm run cli -- "buatkan landing page kedai kopi" [--json]\n',
    );
    return 2;
  }

  const cfg = loadConfig();
  await mkdir(cfg.BIKININ_WORKSPACE, { recursive: true });
  const workspace = await realpath(cfg.BIKININ_WORKSPACE);

  const runId = `run_${randomUUID().slice(0, 8)}`;
  const sessionId = `s_${randomUUID().slice(0, 8)}`;
  const rl = json
    ? null
    : createInterface({ input: process.stdin, output: process.stdout });
  const emit = createEmitter(runId, (e) => {
    if (json) process.stdout.write(toNDJSON(e));
    else render(e, cfg.BIKININ_USD_IDR);
  });
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());

  try {
    const result = await runAgent({
      llm: createOpenAiLlm({
        baseURL: cfg.LLM_BASE_URL,
        apiKey: cfg.LLM_API_KEY,
      }),
      model: cfg.BIKININ_MODEL,
      systemPrompt: await loadSystemPrompt(),
      message,
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
      approve: async (req) => {
        if (!rl) return false; // non-interactive: never approve
        const answer = await rl.question(
          `\n⚠ ${req.reason} [risiko ${req.risk}]\n  $ ${req.command}\n  Izinkan? [y/N] `,
        );
        return /^y(es)?$/i.test(answer.trim());
      },
      signal: controller.signal,
    });
    if (!json) process.stdout.write(`\nHasil di: ${workspace}\n`);
    return result.status === "completed" ? 0 : 1;
  } finally {
    rl?.close();
  }
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
