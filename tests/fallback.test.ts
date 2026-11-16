import { describe, expect, it } from "vitest";
import { AgentError } from "../src/errors.js";
import { createFallbackLlm } from "../src/llm/fallback.js";
import type { ChatResult, LlmClient } from "../src/llm/client.js";
import type { ProviderConfig } from "../src/llm/providers.js";

const usage = { input_tokens: 1_000_000, output_tokens: 0, cached_tokens: 0 };
const ok = (text: string): ChatResult => ({ text, toolCalls: [], usage });

function provider(name: string, inPerM: number): ProviderConfig {
  return {
    name,
    baseUrl: "https://x.test/v1",
    apiKey: "k",
    model: `${name}-model`,
    inPerM,
    outPerM: 0,
  };
}

/** Fake client: behaves as the scripted function says, and records which model was asked. */
function fake(
  script: (
    model: string,
    onText?: (t: string) => void,
  ) => ChatResult | Promise<ChatResult>,
  calls: string[],
) {
  return (p: ProviderConfig): LlmClient => ({
    async chat(params) {
      calls.push(p.name);
      return script(params.model, params.onText);
    },
  });
}

describe("createFallbackLlm", () => {
  it("falls over to the next provider on a fallback-eligible error", async () => {
    const calls: string[] = [];
    const llm = createFallbackLlm([provider("a", 1), provider("b", 2)], {
      makeClient: fake((model) => {
        if (model === "a-model")
          throw new AgentError("rate_limited", "429", true, true);
        return ok("dari b");
      }, calls),
    });
    const r = await llm.chat({ model: "ignored", messages: [], tools: [] });
    expect(r.text).toBe("dari b");
    expect(r.provider).toBe("b");
    expect(calls).toEqual(["a", "b"]);
  });

  it("does not fall over on a non-eligible error", async () => {
    const calls: string[] = [];
    const llm = createFallbackLlm([provider("a", 1), provider("b", 2)], {
      makeClient: fake(() => {
        throw new AgentError("provider_error", "menolak (400)");
      }, calls),
    });
    await expect(
      llm.chat({ model: "x", messages: [], tools: [] }),
    ).rejects.toThrow("menolak");
    expect(calls).toEqual(["a"]);
  });

  it("does not fall over after text was already streamed", async () => {
    const calls: string[] = [];
    const llm = createFallbackLlm([provider("a", 1), provider("b", 2)], {
      makeClient: fake(async (_m, onText) => {
        onText?.("sebagian");
        throw new AgentError("provider_error", "putus", true, true);
      }, calls),
    });
    await expect(
      llm.chat({ model: "x", messages: [], tools: [] }),
    ).rejects.toThrow("putus");
    expect(calls).toEqual(["a"]);
  });

  it("prices each answer with the provider that produced it", async () => {
    const llm = createFallbackLlm(
      [provider("cheap", 0.5), provider("dear", 5)],
      {
        makeClient: fake(
          (model) => (model === "cheap-model" ? ok("x") : ok("y")),
          [],
        ),
      },
    );
    const r = await llm.chat({ model: "x", messages: [], tools: [] });
    expect(r.costUsd).toBeCloseTo(0.5);
  });
});
