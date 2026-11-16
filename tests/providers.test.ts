import { describe, expect, it } from "vitest";
import { resolveProviders } from "../src/llm/providers.js";

const LIST = JSON.stringify([
  {
    name: "nano",
    baseUrl: "https://api.nano-gpt.com/api/v1",
    keyEnv: "NANOGPT_API_KEY",
    model: "openai/gpt-6.1-sol",
    inPerM: 1,
    outPerM: 4,
  },
  {
    name: "free",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    model: "z-ai/glm-5.3-flash:free",
    inPerM: 0,
    outPerM: 0,
  },
]);

describe("resolveProviders", () => {
  it("reads keys from the env vars named in BIKININ_PROVIDERS", () => {
    const ps = resolveProviders({
      BIKININ_PROVIDERS: LIST,
      NANOGPT_API_KEY: "k1",
      OPENROUTER_API_KEY: "k2",
    });
    expect(ps.map((p) => [p.name, p.apiKey])).toEqual([
      ["nano", "k1"],
      ["free", "k2"],
    ]);
  });

  it("names the missing variable but never a value", () => {
    expect(() =>
      resolveProviders({ BIKININ_PROVIDERS: LIST, NANOGPT_API_KEY: "k1" }),
    ).toThrow("OPENROUTER_API_KEY");
  });

  it("rejects invalid JSON and invalid entries", () => {
    expect(() =>
      resolveProviders({ BIKININ_PROVIDERS: "{bukan json" }),
    ).toThrow("bukan JSON");
    expect(() => resolveProviders({ BIKININ_PROVIDERS: "[]" })).toThrow(
      "BIKININ_PROVIDERS tidak valid",
    );
  });

  it("falls back to the single LLM_* setup when BIKININ_PROVIDERS is absent", () => {
    const ps = resolveProviders({
      LLM_BASE_URL: "https://api.nano-gpt.com/api/v1",
      LLM_API_KEY: "k",
      BIKININ_MODEL: "m",
      PRICE_INPUT_PER_M: "0",
      PRICE_OUTPUT_PER_M: "0",
    });
    expect(ps).toEqual([
      {
        name: "default",
        baseUrl: "https://api.nano-gpt.com/api/v1",
        apiKey: "k",
        model: "m",
        inPerM: 0,
        outPerM: 0,
      },
    ]);
  });

  it("errors when neither configuration is present", () => {
    expect(() => resolveProviders({})).toThrow("BIKININ_PROVIDERS");
  });
});
