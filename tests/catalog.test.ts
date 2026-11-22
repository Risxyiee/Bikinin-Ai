import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Catalog,
  CatalogError,
  slug,
  validateApiKey,
  validateBaseUrl,
} from "../src/llm/catalog.js";
import type { ProviderConfig } from "../src/llm/providers.js";
import { ProviderStore } from "../src/llm/store.js";

const env: ProviderConfig[] = [
  {
    name: "sol",
    baseUrl: "https://api.nano-gpt.com/api/v1",
    apiKey: "ENV_KEY_VALUE",
    model: "openai/gpt-6.1-sol",
    inPerM: 2,
    outPerM: 10,
  },
  {
    name: "luna",
    baseUrl: "https://api.nano-gpt.com/api/v1",
    apiKey: "ENV_KEY_VALUE",
    model: "openai/gpt-6-luna",
    inPerM: 0.1,
    outPerM: 0.5,
  },
];
const KEY = "sk-user-secret-123456";

describe("validateBaseUrl", () => {
  it("accepts a public https host and trims trailing slashes, query and hash", () => {
    expect(validateBaseUrl(" https://openrouter.ai/api/v1/?x=1#y ")).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  it.each([
    "http://openrouter.ai/api/v1",
    "https://localhost/v1",
    "https://127.0.0.1/v1",
    "https://10.0.0.5/v1",
    "https://[::1]/v1",
    "https://intranet/v1",
    "https://user:pass@openrouter.ai/v1",
    "bukan url",
    "https://host.internal/v1",
  ])("rejects %s", (url) => {
    expect(() => validateBaseUrl(url)).toThrow(CatalogError);
  });
});

describe("validateApiKey", () => {
  it("rejects short keys and keys with spaces", () => {
    expect(() => validateApiKey("pendek")).toThrow(CatalogError);
    expect(() => validateApiKey("ada spasi di dalam key")).toThrow(
      CatalogError,
    );
    expect(validateApiKey("  sk-valid-key-1234  ")).toBe("sk-valid-key-1234");
  });
});

describe("Catalog", () => {
  const make = () => new Catalog(env, new ProviderStore(null));

  it("lists env models first and uses the first as default", () => {
    const c = make();
    expect(c.choices().map((x) => x.id)).toEqual([
      "sol:openai/gpt-6.1-sol",
      "luna:openai/gpt-6-luna",
    ]);
    expect(c.settings()).toEqual({
      fallback: true,
      default: "sol:openai/gpt-6.1-sol",
    });
  });

  it("adds a provider with a unique id, models, and never returns the key", () => {
    const c = make();
    const a = c.addProvider({
      name: "Sol",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: KEY,
    });
    expect(a.id).toBe("sol-2"); // "sol" is taken by an env entry
    c.setModels(a.id, [
      { id: "z-ai/glm-5.3-flash:free", inPerM: 0, outPerM: 0 },
      { id: "z-ai/glm-5.3-flash:free", inPerM: 1, outPerM: 1 }, // duplicate ids collapse
    ]);
    expect(c.choices().map((x) => x.id)).toContain(
      "sol-2:z-ai/glm-5.3-flash:free",
    );
    expect(JSON.stringify(c.providers())).not.toContain(KEY);
    expect(c.providers().find((p) => p.id === "sol-2")?.models).toHaveLength(1);
  });

  it("resolves the chain with fallback on, off, and for an unknown id", () => {
    const c = make();
    const on = c.resolve("luna:openai/gpt-6-luna");
    expect(on?.chain.map((p) => p.name)).toEqual(["luna", "sol"]);
    c.setSettings({ fallback: false });
    expect(
      c.resolve("luna:openai/gpt-6-luna")?.chain.map((p) => p.name),
    ).toEqual(["luna"]);
    expect(c.resolve("tidak:ada")).toBeNull();
    expect(c.resolve()?.selected.id).toBe("sol:openai/gpt-6.1-sol");
  });

  it("only accepts a known model as default and falls back when it disappears", () => {
    const c = make();
    expect(() => c.setSettings({ default: "x:y" })).toThrow(CatalogError);
    const p = c.addProvider({
      name: "Gratis",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: KEY,
    });
    c.setModels(p.id, [{ id: "m1", inPerM: 0, outPerM: 0 }]);
    c.setSettings({ default: `${p.id}:m1` });
    expect(c.settings().default).toBe(`${p.id}:m1`);
    c.removeProvider(p.id);
    expect(c.settings().default).toBe("sol:openai/gpt-6.1-sol");
  });

  it("does not let env providers be changed or read through the user-provider API", () => {
    const c = make();
    expect(() => c.removeProvider("sol")).toThrow(CatalogError);
    expect(() => c.credentials("sol")).toThrow(CatalogError);
    expect(() => c.setModels("sol", [])).toThrow(CatalogError);
  });

  it("slugs names safely", () => {
    expect(slug("Open Router!!")).toBe("open-router");
    expect(slug("***")).toBe("provider");
  });
});

describe("ProviderStore", () => {
  it("persists to disk with mode 0600 and reloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bikinin-store-"));
    const c1 = new Catalog(env, new ProviderStore(dir));
    const p = c1.addProvider({
      name: "Gratis",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: KEY,
    });
    c1.setModels(p.id, [{ id: "m1", inPerM: 0, outPerM: 0 }]);
    const file = join(dir, "providers.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const c2 = new Catalog(env, new ProviderStore(dir));
    expect(c2.choices().map((x) => x.id)).toContain(`${p.id}:m1`);
    expect(c2.credentials(p.id).apiKey).toBe(KEY);
  });

  it("keeps a copy of an unreadable file and starts clean instead of overwriting it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bikinin-store-"));
    await writeFile(join(dir, "providers.json"), "{rusak");
    const store = new ProviderStore(dir);
    expect(store.get().providers).toEqual([]);
    const { readdir } = await import("node:fs/promises");
    expect(
      (await readdir(dir)).some((f) => f.startsWith("providers.json.bad-")),
    ).toBe(true);
    expect(
      await readFile(
        join(
          dir,
          (await readdir(dir)).find((f) => f.includes(".bad-"))!,
        ),
        "utf8",
      ),
    ).toBe("{rusak");
  });
});
