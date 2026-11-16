// Loads prompts/system-prompt.md. Skill list is filled in Phase 2 (loader).
import { readFile } from "node:fs/promises";

const PROMPT_URL = new URL("../prompts/system-prompt.md", import.meta.url);

export async function loadSystemPrompt(
  skillList = "(belum ada skill)",
): Promise<string> {
  const raw = await readFile(PROMPT_URL, "utf8");
  return raw.replace("{{DAFTAR_SKILL}}", skillList);
}
