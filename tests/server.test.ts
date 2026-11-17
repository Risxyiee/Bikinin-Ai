import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { AgentEvent } from "../src/events.js";
import type { ChatResult, LlmClient, ToolCallReq } from "../src/llm/client.js";
import { createAppServer } from "../src/server/http.js";
import { RunManager } from "../src/server/runs.js";

const usage = { input_tokens: 100, output_tokens: 20, cached_tokens: 0 };
const call = (id: string, name: string, args: unknown): ToolCallReq => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const withCalls = (...toolCalls: ToolCallReq[]): ChatResult => ({
  text: "",
  toolCalls,
  usage,
});
const finalText = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  usage,
});

function scripted(responses: ChatResult[]): LlmClient {
  let i = 0;
  return {
    async chat(p) {
      const r = responses[i++];
      if (!r) throw new Error("skrip habis");
      if (r.text) p.onText?.(r.text);
      return r;
    },
  };
}

const cfg: Config = {
  providers: [
    {
      name: "t",
      baseUrl: "https://x.test/v1",
      apiKey: "SECRET_KEY_VALUE",
      model: "test-model",
      inPerM: 1,
      outPerM: 2,
    },
  ],
  BIKININ_USD_IDR: 17000,
  BIKININ_MAX_STEPS: 10,
  BIKININ_MAX_COST_USD: 1,
  BIKININ_WORKSPACE: "./workspace",
  BIKININ_MAX_VIDEO_SECONDS: 30,
};

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.();
});

async function boot(responses: ChatResult[]) {
  const base = await mkdtemp(join(tmpdir(), "bikinin-srv-"));
  await mkdir(join(base, "ws"));
  const workspace = await realpath(join(base, "ws"));
  await writeFile(join(base, "secret.txt"), "di luar workspace");
  const manager = new RunManager(cfg, {
    workspace,
    systemPrompt: "sys",
    llm: scripted(responses),
  });
  const server = createAppServer(manager, workspace);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  open.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, manager, workspace };
}

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

function parseSse(text: string): AgentEvent[] {
  return text
    .split("\n\n")
    .map((frame) => frame.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(6)) as AgentEvent);
}

async function waitFor(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout menunggu kondisi");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("web server", () => {
  it("serves the UI with a strict CSP, and config without secrets", async () => {
    const { url } = await boot([]);
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    const config = await (await fetch(`${url}/api/config`)).text();
    expect(config).toContain("test-model");
    expect(config).not.toContain("SECRET_KEY_VALUE");
    expect(config).not.toContain("x.test");
    expect((await fetch(`${url}/md.js`)).status).toBe(200);
    const font = await fetch(`${url}/fonts/inter-latin-wght-normal.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect((await fetch(`${url}/fonts/../src/events.ts`)).status).toBe(404);
    expect(page.headers.get("content-security-policy")).not.toContain(
      "googleapis",
    );
  });

  it("runs an agent end to end and streams ordered SSE events", async () => {
    const { url, workspace } = await boot([
      withCalls(
        call("t1", "write_file", {
          path: "index.html",
          content: "<h1>Kopi</h1>",
        }),
      ),
      finalText("Selesai."),
    ]);
    const started = await post(`${url}/api/runs`, { message: "buat halaman" });
    expect(started.status).toBe(201);
    const { run_id } = (await started.json()) as { run_id: string };

    const sse = await fetch(`${url}/api/runs/${run_id}/events`);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await sse.text()); // server closes the stream after run_finished
    expect(events[0].type).toBe("run_started");
    expect(events.at(-1)?.type).toBe("run_finished");
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.some((e) => e.type === "file_changed")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("SECRET_KEY_VALUE");
    expect(JSON.stringify(events)).not.toContain(workspace);
  });

  it("replays only newer events when Last-Event-ID is sent", async () => {
    const { url } = await boot([finalText("halo")]);
    const { run_id } = (await (
      await post(`${url}/api/runs`, { message: "hai" })
    ).json()) as { run_id: string };
    await (await fetch(`${url}/api/runs/${run_id}/events`)).text();
    const resumed = await fetch(`${url}/api/runs/${run_id}/events`, {
      headers: { "Last-Event-ID": "1" },
    });
    const events = parseSse(await resumed.text());
    expect(events.every((e) => e.seq > 1)).toBe(true);
    expect(events.at(-1)?.type).toBe("run_finished");
  });

  it("holds a risky command until the user answers, and rejects a second run meanwhile", async () => {
    const { url, manager } = await boot([
      withCalls(call("t1", "run_command", { command: "npm install" })),
      finalText("ok"),
    ]);
    const { run_id } = (await (
      await post(`${url}/api/runs`, { message: "pasang" })
    ).json()) as { run_id: string };
    const rec = manager.get(run_id)!;
    await waitFor(() =>
      rec.events.some((e) => e.type === "approval_requested"),
    );

    const busy = await post(`${url}/api/runs`, { message: "lagi" });
    expect(busy.status).toBe(409);

    const req = rec.events.find((e) => e.type === "approval_requested");
    if (req?.type !== "approval_requested")
      throw new Error("tidak ada approval");
    const ok = await post(`${url}/api/runs/${run_id}/approval`, {
      approval_id: req.approval_id,
      decision: "deny",
    });
    expect(ok.status).toBe(200);
    await waitFor(() => rec.finished);
    expect(
      rec.events.find((e) => e.type === "approval_resolved"),
    ).toMatchObject({ decision: "deny" });

    const again = await post(`${url}/api/runs/${run_id}/approval`, {
      approval_id: req.approval_id,
      decision: "allow",
    });
    expect(again.status).toBe(404);
  });

  it("stop ends a run waiting for approval with status stopped", async () => {
    const { url, manager } = await boot([
      withCalls(call("t1", "run_command", { command: "npm install" })),
    ]);
    const { run_id } = (await (
      await post(`${url}/api/runs`, { message: "pasang" })
    ).json()) as { run_id: string };
    const rec = manager.get(run_id)!;
    await waitFor(() =>
      rec.events.some((e) => e.type === "approval_requested"),
    );
    expect((await post(`${url}/api/runs/${run_id}/stop`, {})).status).toBe(202);
    await waitFor(() => rec.finished);
    const last = rec.events.at(-1);
    expect(last?.type).toBe("run_finished");
  });

  it("remembers earlier messages of the same session, and forgets for a new one", async () => {
    const seen: string[][] = [];
    const responses = [
      finalText("Halo Rizqi."),
      finalText("Namamu Rizqi."),
      finalText("Aku tidak tahu."),
    ];
    let i = 0;
    const llm: LlmClient = {
      async chat(p) {
        seen.push(
          p.messages.map((m) =>
            typeof m.content === "string" ? m.content : "",
          ),
        );
        return responses[i++];
      },
    };
    const base = await mkdtemp(join(tmpdir(), "bikinin-mem-"));
    await mkdir(join(base, "ws"));
    const workspace = await realpath(join(base, "ws"));
    const manager = new RunManager(cfg, {
      workspace,
      systemPrompt: "sys",
      llm,
    });
    const server = createAppServer(manager, workspace);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    open.push(
      () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    );
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const first = (await (
      await post(`${url}/api/runs`, { message: "namaku Rizqi" })
    ).json()) as { run_id: string; session_id: string };
    await (await fetch(`${url}/api/runs/${first.run_id}/events`)).text();

    const second = (await (
      await post(`${url}/api/runs`, {
        message: "siapa namaku?",
        session_id: first.session_id,
      })
    ).json()) as { run_id: string; session_id: string };
    expect(second.session_id).toBe(first.session_id);
    await (await fetch(`${url}/api/runs/${second.run_id}/events`)).text();
    expect(seen[1]).toContain("namaku Rizqi");
    expect(seen[1]).toContain("Halo Rizqi.");

    // an id the server never issued must not read anyone's history
    const third = (await (
      await post(`${url}/api/runs`, {
        message: "siapa namaku?",
        session_id: "s_deadbeef",
      })
    ).json()) as { run_id: string; session_id: string };
    expect(third.session_id).not.toBe("s_deadbeef");
    await (await fetch(`${url}/api/runs/${third.run_id}/events`)).text();
    expect(seen[2]).not.toContain("namaku Rizqi");
  });

  it("validates request bodies", async () => {
    const { url } = await boot([]);
    expect((await post(`${url}/api/runs`, { message: "" })).status).toBe(400);
    expect((await post(`${url}/api/runs`, { nope: 1 })).status).toBe(400);
    const bad = await fetch(`${url}/api/runs`, {
      method: "POST",
      body: "{bukan json",
    });
    expect(bad.status).toBe(400);
    expect((await fetch(`${url}/api/runs/run_deadbeef/events`)).status).toBe(
      404,
    );
  });

  it("previews workspace files in a sandboxed CSP and blocks traversal", async () => {
    const { url, workspace } = await boot([]);
    await writeFile(join(workspace, "index.html"), "<h1>Halo</h1>");
    const ok = await fetch(`${url}/preview/index.html`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("<h1>Halo</h1>");
    expect(ok.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts",
    );
    expect(ok.headers.get("content-security-policy")).toContain(
      "connect-src 'none'",
    );

    expect((await fetch(`${url}/preview/..%2Fsecret.txt`)).status).toBe(403);
    expect((await fetch(`${url}/preview/%2Fetc%2Fpasswd`)).status).toBe(403);
    expect((await fetch(`${url}/preview/tidak-ada.html`)).status).toBe(404);
  });
});
