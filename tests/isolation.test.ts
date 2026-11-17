import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertWorkspaceIsolated } from "../src/safety/paths.js";

describe("assertWorkspaceIsolated", () => {
  it("accepts a folder with no project markers above it", async () => {
    const base = await mkdtemp(join(tmpdir(), "bikinin-iso-"));
    const ws = join(base, "ws");
    await mkdir(ws);
    await expect(assertWorkspaceIsolated(ws)).resolves.toBeUndefined();
  });

  it("rejects a workspace inside a folder that has package.json", async () => {
    const base = await mkdtemp(join(tmpdir(), "bikinin-iso-"));
    await writeFile(join(base, "package.json"), "{}");
    const ws = join(base, "workspace");
    await mkdir(ws);
    await expect(assertWorkspaceIsolated(ws)).rejects.toThrow("package.json");
  });

  it("accepts a workspace that holds its own package.json (agent-built project)", async () => {
    const base = await mkdtemp(join(tmpdir(), "bikinin-iso-"));
    const ws = join(base, "ws");
    await mkdir(ws);
    await writeFile(join(ws, "package.json"), "{}");
    await expect(assertWorkspaceIsolated(ws)).resolves.toBeUndefined();
  });

  it("rejects a workspace that is itself a git repository", async () => {
    const base = await mkdtemp(join(tmpdir(), "bikinin-iso-"));
    const ws = join(base, "ws");
    await mkdir(join(ws, ".git"), { recursive: true });
    await expect(assertWorkspaceIsolated(ws)).rejects.toThrow(".git");
  });

  it("rejects a workspace inside a git repository", async () => {
    const base = await mkdtemp(join(tmpdir(), "bikinin-iso-"));
    await mkdir(join(base, ".git"));
    const ws = join(base, "workspace");
    await mkdir(ws);
    await expect(assertWorkspaceIsolated(ws)).rejects.toThrow(".git");
  });
});
