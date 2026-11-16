import { readdir } from "node:fs/promises";
import { z } from "zod";
import { resolveInWorkspace } from "../safety/paths.js";
import { defineTool } from "./types.js";

const MAX_ENTRIES = 200;

export const listDirTool = defineTool({
  name: "list_dir",
  description:
    "Daftar isi sebuah folder di dalam workspace (satu level). Path relatif terhadap workspace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path folder relatif, default '.'" },
    },
    additionalProperties: false,
  },
  readOnly: true,
  schema: z.object({ path: z.string().default(".") }),
  label: (a) => `list_dir ${a.path}`,
  publicArgs: (a) => ({ path: a.path }),
  async run(a, ctx) {
    const { abs, rel } = await resolveInWorkspace(ctx.workspace, a.path);
    const entries = await readdir(abs, { withFileTypes: true });
    const lines = entries
      .slice(0, MAX_ENTRIES)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    if (entries.length > MAX_ENTRIES)
      lines.push(`...[${entries.length - MAX_ENTRIES} item lagi]`);
    return {
      ok: true,
      summary: `${rel}: ${entries.length} item`,
      output: lines.join("\n") || "(kosong)",
      changes: [],
    };
  },
});
