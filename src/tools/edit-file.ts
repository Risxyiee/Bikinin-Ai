import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { AgentError } from "../errors.js";
import { resolveInWorkspace } from "../safety/paths.js";
import { defineTool } from "./types.js";

export const editFileTool = defineTool({
  name: "edit_file",
  description:
    "Ganti satu bagian teks di file (str_replace). old_str harus persis dan muncul tepat satu kali.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_str: { type: "string", description: "Teks lama, harus unik di file" },
      new_str: {
        type: "string",
        description: "Teks pengganti (boleh kosong untuk menghapus)",
      },
    },
    required: ["path", "old_str", "new_str"],
    additionalProperties: false,
  },
  readOnly: false,
  schema: z.object({
    path: z.string().min(1),
    old_str: z.string().min(1),
    new_str: z.string(),
  }),
  label: (a) => `edit_file ${a.path}`,
  publicArgs: (a) => ({ path: a.path }),
  async run(a, ctx) {
    const { abs, rel } = await resolveInWorkspace(ctx.workspace, a.path);
    const text = await readFile(abs, "utf8");
    const count = text.split(a.old_str).length - 1;
    if (count === 0) {
      throw new AgentError(
        "tool_failed",
        "old_str tidak ditemukan. Baca ulang file lalu salin teks persis.",
      );
    }
    if (count > 1) {
      throw new AgentError(
        "tool_failed",
        `old_str muncul ${count} kali. Tambahkan konteks agar unik.`,
      );
    }
    const updated = text.replace(a.old_str, () => a.new_str);
    await writeFile(abs, updated, "utf8");
    return {
      ok: true,
      summary: `${rel} diubah`,
      output: "",
      changes: [
        {
          path: rel,
          op: "modified",
          bytes: Buffer.byteLength(updated, "utf8"),
        },
      ],
    };
  },
});
