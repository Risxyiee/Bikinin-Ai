import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInWorkspace } from "../src/safety/paths.js";

async function setup() {
  const base = await mkdtemp(join(tmpdir(), "bikinin-paths-"));
  const ws = join(base, "ws");
  const outside = join(base, "outside");
  await mkdir(ws);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "rahasia");
  return { ws, outside };
}

describe("resolveInWorkspace", () => {
  it("accepts a path inside the workspace, including one not yet created", async () => {
    const { ws } = await setup();
    const r = await resolveInWorkspace(ws, "sub/baru/index.html");
    expect(r.rel).toBe("sub/baru/index.html");
  });

  it("blocks ../ traversal", async () => {
    const { ws } = await setup();
    await expect(
      resolveInWorkspace(ws, "../outside/secret.txt"),
    ).rejects.toMatchObject({
      code: "path_blocked",
    });
  });

  it("blocks absolute paths", async () => {
    const { ws, outside } = await setup();
    await expect(
      resolveInWorkspace(ws, join(outside, "secret.txt")),
    ).rejects.toMatchObject({
      code: "path_blocked",
    });
  });

  it("blocks a symlinked directory that points outside", async () => {
    const { ws, outside } = await setup();
    await symlink(outside, join(ws, "link"));
    await expect(
      resolveInWorkspace(ws, "link/secret.txt"),
    ).rejects.toMatchObject({
      code: "path_blocked",
    });
  });

  it("blocks a write to a file that is a symlink to outside", async () => {
    const { ws, outside } = await setup();
    await symlink(join(outside, "secret.txt"), join(ws, "alias.txt"));
    await expect(resolveInWorkspace(ws, "alias.txt")).rejects.toMatchObject({
      code: "path_blocked",
    });
  });
});
