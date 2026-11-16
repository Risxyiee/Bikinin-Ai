import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTool, tempWorkspace } from "./helpers.js";

describe("edit_file", () => {
  it("replaces a unique match", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, "a.txt"), "halo dunia\nselamat pagi\n");
    const r = await runTool(
      "edit_file",
      { path: "a.txt", old_str: "selamat pagi", new_str: "selamat malam" },
      ws,
    );
    expect(r.ok).toBe(true);
    expect(await readFile(join(ws, "a.txt"), "utf8")).toBe(
      "halo dunia\nselamat malam\n",
    );
  });

  it("fails when old_str is not found", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, "a.txt"), "isi");
    await expect(
      runTool(
        "edit_file",
        { path: "a.txt", old_str: "tidak ada", new_str: "x" },
        ws,
      ),
    ).rejects.toThrow("tidak ditemukan");
  });

  it("fails when old_str appears more than once", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, "a.txt"), "x x");
    await expect(
      runTool("edit_file", { path: "a.txt", old_str: "x", new_str: "y" }, ws),
    ).rejects.toThrow("muncul 2 kali");
    expect(await readFile(join(ws, "a.txt"), "utf8")).toBe("x x");
  });

  it("treats $ in new_str literally", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, "a.txt"), "harga: X");
    await runTool(
      "edit_file",
      { path: "a.txt", old_str: "X", new_str: "$&$1" },
      ws,
    );
    expect(await readFile(join(ws, "a.txt"), "utf8")).toBe("harga: $&$1");
  });

  it("rejects an empty old_str at argument validation", async () => {
    const ws = await tempWorkspace();
    await expect(
      runTool("edit_file", { path: "a.txt", old_str: "", new_str: "x" }, ws),
    ).rejects.toThrow("argumen tidak valid");
  });
});

describe("write_file and read_file", () => {
  it("writes a new file and reads it back with line numbers", async () => {
    const ws = await tempWorkspace();
    const w = await runTool(
      "write_file",
      { path: "site/index.html", content: "<h1>Kopi</h1>" },
      ws,
    );
    expect(w.changes).toEqual([
      { path: "site/index.html", op: "created", bytes: 13 },
    ]);
    const r = await runTool("read_file", { path: "site/index.html" }, ws);
    expect(r.output).toBe("1\t<h1>Kopi</h1>");
  });
});

describe("list_dir", () => {
  it("lists entries and marks folders", async () => {
    const ws = await tempWorkspace();
    await runTool("write_file", { path: "a/b.txt", content: "x" }, ws);
    await runTool("write_file", { path: "c.txt", content: "y" }, ws);
    const r = await runTool("list_dir", { path: "." }, ws);
    expect(r.output.split("\n").sort()).toEqual(["a/", "c.txt"]);
  });
});
