// Tries providers in order. Falls over only on errors marked fallback (429, 5xx, 402, network),
// and only if nothing was streamed yet, so the user never sees duplicated or mixed output.
import { AgentError } from "../errors.js";
import {
  createOpenAiLlm,
  type ChatParams,
  type ChatResult,
  type LlmClient,
} from "./client.js";
import type { ProviderConfig } from "./providers.js";
import { costUsd } from "./pricing.js";

export interface FallbackOptions {
  makeClient?: (p: ProviderConfig) => LlmClient;
}

/** The model argument in ChatParams is ignored: each provider brings its own model. */
export function createFallbackLlm(
  providers: ProviderConfig[],
  opts: FallbackOptions = {},
): LlmClient {
  if (providers.length === 0) throw new Error("daftar provider kosong");
  const makeClient =
    opts.makeClient ??
    ((p: ProviderConfig) =>
      createOpenAiLlm({ baseURL: p.baseUrl, apiKey: p.apiKey }));
  const clients = providers.map((p) => ({ p, client: makeClient(p) }));

  return {
    async chat(params: ChatParams): Promise<ChatResult> {
      let lastError: unknown;
      for (const { p, client } of clients) {
        if (params.signal?.aborted)
          throw new AgentError("provider_error", "Permintaan dibatalkan");
        let streamed = false;
        try {
          const r = await client.chat({
            ...params,
            model: p.model,
            onText: (text) => {
              streamed = true;
              params.onText?.(text);
            },
          });
          return {
            ...r,
            costUsd: costUsd(r.usage, p),
            provider: p.name,
            model: p.model,
          };
        } catch (err) {
          lastError = err;
          const canFallback =
            err instanceof AgentError && err.fallback && !streamed;
          if (!canFallback) throw err;
        }
      }
      throw lastError;
    },
  };
}
