// HTTP server for the web UI. Node's http module only, no framework.
// Serves the UI, the JSON API from AGENTS.md 8.4, SSE events, and file previews from the workspace.
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentError } from "../errors.js";
import { ApprovalBody, StartRunBody, toSSE } from "../events.js";
import { resolveInWorkspace } from "../safety/paths.js";
import { BusyError, type RunManager } from "./runs.js";

const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));
const MAX_BODY = 64 * 1024;
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

const ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

// Previews run in an opaque origin: no cookies, no access to the UI's storage or API.
const PREVIEW_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "connect-src 'none'",
].join("; ");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body terlalu besar");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "JSON tidak valid");
  }
}

async function sendAsset(res: ServerResponse, key: string): Promise<void> {
  const asset = ASSETS[key];
  const body = await readFile(new URL(asset.file, `file://${PUBLIC_DIR}`));
  res.writeHead(200, {
    "Content-Type": asset.type,
    "Content-Security-Policy": UI_CSP,
    "Cache-Control": "no-cache",
    ...SECURITY_HEADERS,
    "X-Frame-Options": "DENY",
  });
  res.end(body);
}

async function servePreview(
  res: ServerResponse,
  workspace: string,
  rawPath: string,
): Promise<void> {
  let rel: string;
  try {
    rel = decodeURIComponent(rawPath);
  } catch {
    throw new HttpError(400, "path tidak valid");
  }
  let abs: string;
  try {
    ({ abs } = await resolveInWorkspace(workspace, rel));
  } catch (err) {
    if (err instanceof AgentError && err.code === "path_blocked")
      throw new HttpError(403, "path ditolak");
    throw err;
  }
  let st;
  try {
    st = await stat(abs);
  } catch {
    throw new HttpError(404, "file tidak ditemukan");
  }
  if (!st.isFile()) throw new HttpError(404, "file tidak ditemukan");
  if (st.size > MAX_PREVIEW_BYTES)
    throw new HttpError(413, "file terlalu besar");

  const body = await readFile(abs);
  res.writeHead(200, {
    "Content-Type":
      MIME[extname(abs).toLowerCase()] ?? "application/octet-stream",
    "Content-Security-Policy": PREVIEW_CSP,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function streamEvents(
  req: IncomingMessage,
  res: ServerResponse,
  manager: RunManager,
  runId: string,
): void {
  const rec = manager.get(runId);
  if (!rec) throw new HttpError(404, "run tidak ditemukan");

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...SECURITY_HEADERS,
  });

  const header = req.headers["last-event-id"];
  const lastSeen = Number(Array.isArray(header) ? header[0] : (header ?? -1));
  const after = Number.isFinite(lastSeen) ? lastSeen : -1;

  // Replay first, then subscribe. Both happen synchronously, so no event is missed in between.
  for (const e of rec.events) {
    if (e.seq > after) res.write(toSSE(e));
  }
  if (rec.finished) {
    res.end();
    return;
  }

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  const listener = (e: (typeof rec.events)[number]) => {
    res.write(toSSE(e));
    if (e.type === "run_finished") {
      cleanup();
      res.end();
    }
  };
  const cleanup = () => {
    clearInterval(heartbeat);
    rec.listeners.delete(listener);
  };
  rec.listeners.add(listener);
  req.on("close", cleanup);
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  manager: RunManager,
  workspace: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path in ASSETS) return sendAsset(res, path);

  if (method === "GET" && path.startsWith("/preview/")) {
    return servePreview(res, workspace, path.slice("/preview/".length));
  }

  if (method === "GET" && path === "/api/config") {
    return sendJson(res, 200, manager.info());
  }

  if (method === "POST" && path === "/api/runs") {
    const parsed = StartRunBody.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, "isi permintaan tidak valid");
    try {
      return sendJson(res, 201, manager.start(parsed.data));
    } catch (err) {
      if (err instanceof BusyError) throw new HttpError(409, err.message);
      throw err;
    }
  }

  const m = path.match(
    /^\/api\/runs\/(run_[a-f0-9]{8})\/(events|stop|approval)$/,
  );
  if (m) {
    const [, runId, action] = m;
    if (method === "GET" && action === "events")
      return streamEvents(req, res, manager, runId);
    if (method === "POST" && action === "stop") {
      if (!manager.stop(runId)) throw new HttpError(404, "run tidak ditemukan");
      return sendJson(res, 202, { ok: true });
    }
    if (method === "POST" && action === "approval") {
      const parsed = ApprovalBody.safeParse(await readJson(req));
      if (!parsed.success)
        throw new HttpError(400, "isi persetujuan tidak valid");
      if (
        !manager.approve(runId, parsed.data.approval_id, parsed.data.decision)
      ) {
        throw new HttpError(
          404,
          "persetujuan tidak ditemukan atau sudah dijawab",
        );
      }
      return sendJson(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, "tidak ditemukan");
}

export function createAppServer(
  manager: RunManager,
  workspace: string,
): Server {
  return createServer(async (req, res) => {
    try {
      await route(req, res, manager, workspace);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });
}
