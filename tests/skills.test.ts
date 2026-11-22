import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "skills");
const dirs = readdirSync(ROOT).filter((d) =>
  statSync(join(ROOT, d)).isDirectory(),
);

function frontmatter(text: string): {
  fields: Record<string, string>;
  body: string;
} {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("frontmatter tidak ditemukan");
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { fields, body: m[2] };
}

describe("skills/*/SKILL.md (AGENTS.md Lampiran C)", () => {
  it("has at least the website and remotion skills", () => {
    expect(dirs).toEqual(expect.arrayContaining(["website", "remotion"]));
  });

  it.each(dirs)("%s has valid frontmatter and a bounded body", (dir) => {
    const text = readFileSync(join(ROOT, dir, "SKILL.md"), "utf8");
    const { fields, body } = frontmatter(text);
    expect(fields.name).toBe(dir);
    expect(fields.description.length).toBeGreaterThan(20);
    expect(fields.description.length).toBeLessThanOrEqual(300);
    expect(fields.description.startsWith("Gunakan saat")).toBe(true);
    expect(body.trim().length).toBeGreaterThan(200);
    expect(text.length).toBeLessThan(12_000); // loaded into context on use: keep it cheap
  });

  it("never tells the agent to use blocked tools (git, ssh, deploy)", () => {
    for (const dir of dirs) {
      const text = readFileSync(join(ROOT, dir, "SKILL.md"), "utf8");
      expect(text).not.toMatch(/\bgit (push|pull|clone|commit)\b/);
      expect(text).not.toMatch(/wrangler (deploy|publish)/);
    }
  });
});
