// Web UI entry point: `npm run serve -- --port 3000`. Bind to localhost; Codespaces forwards the port.
import { mkdir, realpath } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { loadSystemPrompt } from "./prompt.js";
import { createAppServer } from "./server/http.js";
import { RunManager } from "./server/runs.js";

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const port = Number(flag("--port", "3000"));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("--port harus 1-65535");
  const host = flag("--host", "127.0.0.1");

  const cfg = loadConfig();
  await mkdir(cfg.BIKININ_WORKSPACE, { recursive: true });
  const workspace = await realpath(cfg.BIKININ_WORKSPACE);
  const manager = new RunManager(cfg, {
    workspace,
    systemPrompt: await loadSystemPrompt(),
  });

  createAppServer(manager, workspace).listen(port, host, () => {
    console.log(`Bikinin AI: http://${host}:${port}`);
    console.log(
      "Di Codespaces: buka tab Ports, pastikan visibilitas Private, lalu klik port ini.",
    );
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
