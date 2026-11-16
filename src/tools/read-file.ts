import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { AgentError } from "../errors.js";
import { resolveInWorkspace } from "../safety/paths.js";
import { defineTool } from "./types.js";

const MAX_BYTES = 2_000_000;

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "Baca isi file teks di workspace, dengan nomor baris. Untuk file besar, pakai max_lines atau run_command dengan head.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      max_lines: {
        type: "integer",
        minimum: 1,
        maximum: 2000,
        description: "Default 400",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  readOnly: true,
  schema: z.object({
    path: z.string().min(1),
    max_lines: z.number().int().min(1).max(2000).default(400),
  }),
  label: (a) => `read_file ${a.path}`,
  publicArgs: (a) => ({ path: a.path, max_lines: a.max_lines }),
  async run(a, ctx) {
    const { abs, rel } = await resolveInWorkspace(ctx.workspace, a.path);
    const st = await stat(abs);
    if (!st.isFile()) throw new AgentError("tool_failed", `${rel} bukan file`);
    if (st.size > MAX_BYTES) {
      throw new AgentError(
        "tool_failed",
        `${rel} terlalu besar (${st.size} B). Baca sebagian: run_command dengan "head -n 200 ${rel}"`,
      );
    }
    const lines = (await readFile(abs, "utf8")).split("\n");
    const shown = lines.slice(0, a.max_lines);
    const body = shown.map((line, i) => `${i + 1}\t${line}`).join("\n");
    const more =
      lines.length > a.max_lines
        ? `\n...[${lines.length - a.max_lines} baris lagi]`
        : "";
    return {
      ok: true,
      summary: `${rel} (${lines.length} baris)`,
      output: body + more,
      changes: [],
    };
  },
});
