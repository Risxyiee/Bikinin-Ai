import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { z } from "zod";
import { AgentError } from "../errors.js";
import { classifyCommand } from "../safety/commands.js";
import { defineTool } from "./types.js";

const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 2 * 1024 * 1024;
const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|CRED/i;

/** Child processes never inherit secrets from the parent environment. */
export function safeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !SECRET_NAME.test(name)),
  );
}

interface ShellResult {
  ok: boolean;
  killed: boolean;
  code: number;
  output: string;
}

function execShell(command: string, cwd: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      {
        cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: { ...safeEnv(process.env), GIT_CEILING_DIRECTORIES: dirname(cwd) },
      },
      (error, stdout, stderr) => {
        const code =
          typeof error?.code === "number" ? error.code : error ? 1 : 0;
        const output = [stdout, stderr ? `[stderr]\n${stderr}` : ""]
          .filter(Boolean)
          .join("\n");
        resolve({ ok: !error, killed: Boolean(error?.killed), code, output });
      },
    );
  });
}

export const runCommandTool = defineTool({
  name: "run_command",
  description:
    "Jalankan perintah shell di folder workspace (timeout 120 dtk). Perintah di luar allowlist butuh persetujuan pengguna.",
  parameters: {
    type: "object",
    properties: { command: { type: "string", description: "Perintah shell" } },
    required: ["command"],
    additionalProperties: false,
  },
  readOnly: false,
  schema: z.object({ command: z.string().trim().min(1).max(2000) }),
  label: (a) => `$ ${a.command.slice(0, 80)}`,
  publicArgs: (a) => ({ command: a.command }),
  gate: (a) => classifyCommand(a.command),
  async run(a, ctx) {
    // Re-check here too: defense in depth if the loop's gate is ever bypassed.
    const verdict = classifyCommand(a.command);
    if (verdict.decision === "block")
      throw new AgentError("command_blocked", verdict.reason);

    const r = await execShell(a.command, ctx.workspace);
    const summary = r.killed
      ? "timeout (120 dtk)"
      : r.ok
        ? "selesai (exit 0)"
        : `gagal (exit ${r.code})`;
    return { ok: r.ok, summary, output: r.output, changes: [] };
  },
});
