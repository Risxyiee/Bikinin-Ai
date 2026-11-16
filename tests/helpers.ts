import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTool } from "../src/tools/registry.js";
import type { ToolResult } from "../src/tools/types.js";

export async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bikinin-test-"));
}

/** Parses args the same way the loop does, then executes. Rejects if the tool throws. */
export async function runTool(
  name: string,
  raw: unknown,
  workspace: string,
): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) throw new Error(`tool tidak ada: ${name}`);
  const parsed = tool.parse(raw);
  if (!parsed.ok) throw new Error(`argumen tidak valid: ${parsed.error}`);
  return parsed.execute({ workspace });
}
