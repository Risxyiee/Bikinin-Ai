// OpenAI-compatible chat client: streaming, tool calls, bounded retry (429/5xx/network), timeout.
// Base URL, key and model always come from config. Nothing is hardcoded here.
import OpenAI, {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { AgentError } from "../errors.js";

export type ChatMessage = ChatCompletionMessageParam;

export interface ToolCallReq {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  tools: ChatCompletionTool[];
  signal?: AbortSignal;
  onText?: (text: string) => void;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCallReq[];
  usage: Usage;
}

export interface LlmClient {
  chat(params: ChatParams): Promise<ChatResult>;
}

export interface LlmOptions {
  baseURL: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function classify(err: unknown): { retryable: boolean; error: AgentError } {
  if (err instanceof APIUserAbortError) {
    return {
      retryable: false,
      error: new AgentError("provider_error", "Permintaan dibatalkan"),
    };
  }
  if (err instanceof APIConnectionError) {
    return {
      retryable: true,
      error: new AgentError(
        "provider_error",
        "Gagal terhubung ke penyedia (jaringan/timeout)",
        true,
      ),
    };
  }
  if (err instanceof APIError) {
    const status = err.status;
    if (status === 429) {
      return {
        retryable: true,
        error: new AgentError(
          "rate_limited",
          "Kena rate limit penyedia (429)",
          true,
        ),
      };
    }
    if (status !== undefined && status >= 500) {
      return {
        retryable: true,
        error: new AgentError(
          "provider_error",
          `Penyedia error ${status}`,
          true,
        ),
      };
    }
    return {
      retryable: false,
      error: new AgentError(
        "provider_error",
        `Penyedia menolak request (${status ?? "tanpa status"})`,
      ),
    };
  }
  return {
    retryable: false,
    error: new AgentError(
      "provider_error",
      err instanceof Error ? err.message : "Error tidak dikenal",
    ),
  };
}

export function createOpenAiLlm(opts: LlmOptions): LlmClient {
  const client = new OpenAI({
    baseURL: opts.baseURL,
    apiKey: opts.apiKey,
    timeout: opts.timeoutMs ?? 120_000,
    maxRetries: 0, // retries are handled below so they stay visible and bounded
  });
  const maxRetries = opts.maxRetries ?? 3;
  const sleep = opts.sleep ?? defaultSleep;

  return {
    async chat(p) {
      for (let attempt = 0; ; attempt++) {
        let received = false;
        try {
          const stream = await client.chat.completions.create(
            {
              model: p.model,
              messages: p.messages,
              ...(p.tools.length > 0 ? { tools: p.tools } : {}),
              stream: true,
              stream_options: { include_usage: true },
            },
            { signal: p.signal },
          );

          let text = "";
          let usage: Usage = {
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
          };
          const partial = new Map<
            number,
            { id: string; name: string; args: string }
          >();

          for await (const chunk of stream) {
            received = true;
            if (chunk.usage) {
              usage = {
                input_tokens: chunk.usage.prompt_tokens,
                output_tokens: chunk.usage.completion_tokens,
                cached_tokens:
                  chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
              };
            }
            const delta = chunk.choices[0]?.delta;
            if (!delta) continue;
            if (delta.content) {
              text += delta.content;
              p.onText?.(delta.content);
            }
            for (const tc of delta.tool_calls ?? []) {
              const slot = partial.get(tc.index) ?? {
                id: "",
                name: "",
                args: "",
              };
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name) slot.name += tc.function.name;
              if (tc.function?.arguments) slot.args += tc.function.arguments;
              partial.set(tc.index, slot);
            }
          }

          const toolCalls = [...partial.entries()]
            .sort(([a], [b]) => a - b)
            .filter(([, s]) => s.name !== "")
            .map(([i, s]): ToolCallReq => ({
              id: s.id || `call_${i}`,
              type: "function",
              function: { name: s.name, arguments: s.args || "{}" },
            }));

          return { text, toolCalls, usage };
        } catch (err) {
          if (p.signal?.aborted) throw err;
          const { retryable, error } = classify(err);
          // Only retry when nothing was streamed yet, so text is never duplicated.
          if (retryable && !received && attempt < maxRetries) {
            await sleep(1000 * 2 ** attempt);
            continue;
          }
          throw error;
        }
      }
    },
  };
}
