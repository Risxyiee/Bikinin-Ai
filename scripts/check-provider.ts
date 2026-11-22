// Checks every configured provider (AGENTS.md section 6): chat, streaming, usage, tool calling.
// Prints PASS/FAIL per provider and check. Never prints API keys.
import { loadConfig } from "../src/config.js";
import { probeProvider } from "../src/llm/probe.js";

async function main(): Promise<number> {
  const cfg = loadConfig();
  const rows: {
    provider: string;
    check: string;
    ok: boolean;
    detail: string;
  }[] = [];
  let spent = 0;
  for (const p of cfg.providers) {
    const r = await probeProvider(p);
    spent += r.spentUsd;
    for (const row of r.rows) rows.push({ provider: p.name, ...row });
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
