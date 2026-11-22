import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { AgentError } from "../src/errors.js";
import type { AgentEvent } from "../src/events.js";
import type { ChatResult, LlmClient } from "../src/llm/client.js";
import { Catalog } from "../src/llm/catalog.js";
import type { ProviderConfig } from "../src/llm/providers.js";
import { ProviderStore } from "../src/llm/store.js";
import { createAppServer } from "../src/server/http.js";
import { RunManager } from "../src/server/runs.js";

const KEY = "sk-user-secret-123456";
const usage = { input_tokens: 10, output_tokens: 5, cached_tokens: 0 };
const ok = (text: string): ChatResult => ({ text, toolCalls: [], usage });

const env: ProviderConfig[] = [
  {
    name: "sol",
    baseUrl: "https://api.nano-gpt.com/api/v1",
    apiKey: "ENV_KEY_VALUE",
    model: "openai/gpt-6.1-sol",
    inPerM: 2,
    outPerM: 10,
  },
];
const cfg: Config = {
  providers: env,
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

async function boot(
  makeClient?: (p: ProviderConfig) => LlmClient,
  fetchImpl?: typeof fetch,
) {
  const base = await mkdtemp(join(tmpdir(), "bikinin-prov-"));
  await mkdir(join(base, "ws"));
  const workspace = await realpath(join(base, "ws"));
  const catalog = new Catalog(env, new ProviderStore(null));
  const manager = new RunManager(cfg, {
    workspace,
    systemPrompt: "sys",
    catalog,
    makeClient,
    fetchImpl,
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
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    manager,
  };
}

const J = { "Content-Type": "application/json" };
const send = (
  url: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(url, {
    method,
    headers: { ...J, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function parseSse(text: string): AgentEvent[] {
  return text
    .split("\n\n")
    .map((f) => f.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(6)) as AgentEvent);
}

async function runOnce(
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; events: AgentEvent[] }> {
  const r = await send(`${url}/api/runs`, "POST", body);
  if (r.status !== 201) return { status: r.status, events: [] };
  const { run_id } = (await r.json()) as { run_id: string };
  return {
    status: 201,
    events: parseSse(
      await (await fetch(`${url}/api/runs/${run_id}/events`)).text(),
    ),
  };
}

async function addProvider(url: string) {
  const r = await send(`${url}/api/providers`, "POST", {
    name: "Gratis",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: KEY,
  });
  expect(r.status).toBe(201);
  const p = (await r.json()) as { id: string };
  const m = await send(`${url}/api/providers/${p.id}/models`, "PUT", {
    models: [
      { id: "bad", inPerM: 0, outPerM: 0 },
      { id: "good", inPerM: 0, outPerM: 0 },
    ],
  });
  expect(m.status).toBe(200);
  return p.id;
}

describe("provider and model API", () => {
  it("adds a provider and never returns the key in any response", async () => {
    const { url } = await boot();
    const id = await addProvider(url);
    const bodies = [
      await (await fetch(`${url}/api/providers`)).text(),
      await (await fetch(`${url}/api/models`)).text(),
      await (await fetch(`${url}/api/config`)).text(),
    ];
    for (const b of bodies) {
      expect(b).not.toContain(KEY);
      expect(b).not.toContain("ENV_KEY_VALUE");
    }
    const models = JSON.parse(bodies[1]) as {
      choices: { id: string; free: boolean }[];
      default: string;
    };
    expect(models.choices.map((c) => c.id)).toContain(`${id}:good`);
    expect(models.choices.find((c) => c.id === `${id}:good`)?.free).toBe(true);
    expect(models.default).toBe("sol:openai/gpt-6.1-sol");
  });

  it("rejects insecure or private provider URLs and bad keys with 400", async () => {
    const { url } = await boot();
    const bad = (b: Record<string, string>) =>
      send(`${url}/api/providers`, "POST", b);
    expect(
      (
        await bad({
          name: "x",
          baseUrl: "http://openrouter.ai/v1",
          apiKey: KEY,
        })
      ).status,
    ).toBe(400);
    expect(
      (await bad({ name: "x", baseUrl: "https://127.0.0.1/v1", apiKey: KEY }))
        .status,
    ).toBe(400);
    expect(
      (
        await bad({
          name: "x",
          baseUrl: "https://openrouter.ai/v1",
          apiKey: "pendek",
        })
      ).status,
    ).toBe(400);
  });

  it("refuses cross-site requests and non-JSON bodies on every mutation", async () => {
    const { url } = await boot();
    const body = {
      name: "x",
      baseUrl: "https://openrouter.ai/v1",
      apiKey: KEY,
    };
    expect(
      (
        await send(`${url}/api/providers`, "POST", body, {
          "Sec-Fetch-Site": "cross-site",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await send(`${url}/api/providers`, "POST", body, {
          "Sec-Fetch-Site": "same-site",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await send(`${url}/api/providers`, "POST", body, {
          "Sec-Fetch-Site": "same-origin",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await send(
          `${url}/api/runs`,
          "POST",
          { message: "hai" },
          { "Sec-Fetch-Site": "cross-site" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await send(
          `${url}/api/settings`,
          "PUT",
          { fallback: false },
          { "Sec-Fetch-Site": "cross-site" },
        )
      ).status,
    ).toBe(403);
    const plain = await fetch(`${url}/api/providers`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(plain.status).toBe(415);
  });

  it("runs the chosen model first and falls over to the others when fallback is on", async () => {
    const calls: string[] = [];
    const makeClient = (p: ProviderConfig): LlmClient => ({
      async chat() {
        calls.push(p.model);
        if (p.model === "bad")
          throw new AgentError("rate_limited", "429", true, true);
        return ok(`dari ${p.model}`);
      },
    });
    const { url } = await boot(makeClient);
    const id = await addProvider(url);

    const r = await runOnce(url, { message: "hai", model: `${id}:bad` });
    expect(r.status).toBe(201);
    expect(calls).toEqual(["bad", "openai/gpt-6.1-sol"]);
    expect(r.events.at(-1)).toMatchObject({
      type: "run_finished",
      status: "completed",
    });
  });

  it("does not fall over when fallback is off, and reports the failure", async () => {
    const calls: string[] = [];
    const makeClient = (p: ProviderConfig): LlmClient => ({
      async chat() {
        calls.push(p.model);
        throw new AgentError("rate_limited", "429", true, true);
      },
    });
    const { url } = await boot(makeClient);
    const id = await addProvider(url);
    expect(
      (await send(`${url}/api/settings`, "PUT", { fallback: false })).status,
    ).toBe(200);

    const r = await runOnce(url, { message: "hai", model: `${id}:bad` });
    expect(calls).toEqual(["bad"]);
    expect(r.events.at(-1)).toMatchObject({
      type: "run_finished",
      status: "error",
    });
  });

  it("rejects a run for an unknown model with 400", async () => {
    const { url } = await boot();
    expect(
      (await runOnce(url, { message: "hai", model: "tidak:ada" })).status,
    ).toBe(400);
  });

  it("discovers models server-side with the stored key, and does not leak it on failure", async () => {
    let auth = "";
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      auth = String((init?.headers as Record<string, string>).Authorization);
      return new Response(
        JSON.stringify({
          data: [{ id: "m-b" }, { id: "m-a" }, { id: "m-a" }, { nope: 1 }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const { url } = await boot(undefined, fetchImpl);
    const id = await addProvider(url);
    const r = await send(`${url}/api/providers/${id}/discover`, "POST");
    expect(await r.json()).toEqual({ models: ["m-a", "m-b"] });
    expect(auth).toBe(`Bearer ${KEY}`);

    const failing = (async () =>
      new Response("nope", { status: 401 })) as typeof fetch;
    const b2 = await boot(undefined, failing);
    const id2 = await addProvider(b2.url);
    const r2 = await send(`${b2.url}/api/providers/${id2}/discover`, "POST");
    expect(r2.status).toBe(502);
    expect(await r2.text()).not.toContain(KEY);
  });

  it("probes a provider and refuses env providers for discovery", async () => {
    const makeClient = (): LlmClient => ({
      async chat(p) {
        p.onText?.("pong");
        return p.tools.length > 0
          ? {
              text: "",
              toolCalls: [
                {
                  id: "c",
                  type: "function",
                  function: { name: "ping", arguments: '{"text":"halo"}' },
                },
              ],
              usage,
            }
          : ok("pong");
      },
    });
    const { url } = await boot(makeClient);
    const id = await addProvider(url);
    const r = await send(`${url}/api/providers/${id}/test`, "POST", {
      model: "good",
    });
    const body = (await r.json()) as {
      ok: boolean;
      rows: { check: string; ok: boolean }[];
    };
    expect(body.ok).toBe(true);
    expect(body.rows.map((x) => x.check)).toEqual([
      "chat biasa",
      "streaming",
      "usage",
      "tool calling",
    ]);
    expect(
      (await send(`${url}/api/providers/sol/discover`, "POST")).status,
    ).toBe(404);
  });

  it("deletes a user provider and resets a default that pointed at it", async () => {
    const { url } = await boot();
    const id = await addProvider(url);
    expect(
      (await send(`${url}/api/settings`, "PUT", { default: `${id}:good` }))
        .status,
    ).toBe(200);
    expect((await send(`${url}/api/providers/${id}`, "DELETE")).status).toBe(
      200,
    );
    const models = (await (await fetch(`${url}/api/models`)).json()) as {
      default: string;
      choices: { id: string }[];
    };
    expect(models.default).toBe("sol:openai/gpt-6.1-sol");
    expect(models.choices.some((c) => c.id.startsWith(`${id}:`))).toBe(false);
    expect((await send(`${url}/api/providers/sol`, "DELETE")).status).toBe(404);
  });
});
