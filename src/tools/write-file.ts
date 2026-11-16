import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { pathExists, resolveInWorkspace } from "../safety/paths.js";
import { defineTool } from "./types.js";

export const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Tulis file baru atau tulis ulang file secara total. Untuk perubahan kecil pakai edit_file.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  },
  readOnly: false,
  schema: z.object({
    path: z.string().min(1),
    content: z.string().max(500_000),
  }),
  label: (a) => `write_file ${a.path}`,
  publicArgs: (a) => ({ path: a.path }), // content is never echoed into events
  async run(a, ctx) {
    const { abs, rel } = await resolveInWorkspace(ctx.workspace, a.path);
    const existed = await pathExists(abs);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, a.content, "utf8");
    const bytes = Buffer.byteLength(a.content, "utf8");
    return {
      ok: true,
      summary: `${rel} ${existed ? "ditimpa" : "dibuat"} (${bytes} B)`,
      output: "",
      changes: [{ path: rel, op: existed ? "modified" : "created", bytes }],
    };
  },
});
