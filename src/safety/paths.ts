// Every file operation resolves through here. Blocks traversal, absolute paths and symlink escapes.
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AgentError } from "../errors.js";

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Returns the absolute path and its path relative to the workspace, or throws path_blocked. */
export async function resolveInWorkspace(
  workspace: string,
  rel: string,
): Promise<{ abs: string; rel: string }> {
  if (rel.includes("\0"))
    throw new AgentError(
      "path_blocked",
      "path mengandung karakter tidak valid",
      true,
    );
  if (isAbsolute(rel))
    throw new AgentError(
      "path_blocked",
      `path absolut tidak diizinkan: ${rel}`,
      true,
    );

  const root = await realpath(workspace);
  const abs = resolve(root, rel);
  if (!isInside(root, abs))
    throw new AgentError(
      "path_blocked",
      `path keluar dari workspace: ${rel}`,
      true,
    );

  // Resolve the deepest existing ancestor so symlinks cannot point outside.
  let probe = abs;
  while (!(await pathExists(probe))) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let real: string;
  try {
    real = await realpath(probe);
  } catch {
    throw new AgentError(
      "path_blocked",
      `path tidak bisa diverifikasi: ${rel}`,
      true,
    );
  }
  if (!isInside(root, real))
    throw new AgentError(
      "path_blocked",
      `symlink keluar dari workspace: ${rel}`,
      true,
    );

  return { abs, rel: relative(root, abs) || "." };
}

const PROJECT_MARKERS = [".git", "package.json"];

/**
 * The workspace must not sit inside a project. Otherwise tools like git or npm walk up
 * and act on the app's own repository. Throws if any folder from the workspace upward
 * contains a project marker. The message names the marker, never a full path.
 */
export async function assertWorkspaceIsolated(
  workspace: string,
): Promise<void> {
  let cur = workspace;
  for (;;) {
    for (const marker of PROJECT_MARKERS) {
      if (await pathExists(join(cur, marker))) {
        throw new AgentError(
          "path_blocked",
          `workspace berada di dalam project (ditemukan ${marker}). Pakai folder di luar repo, misalnya ~/bikinin-workspace, lalu atur BIKININ_WORKSPACE.`,
        );
      }
    }
    const parent = dirname(cur);
    if (parent === cur) return;
    cur = parent;
  }
}
