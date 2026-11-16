// Parses the provider list. Keys are read from named env vars, never stored in the list itself.
// BIKININ_PROVIDERS (JSON array) takes precedence. Without it, the single LLM_* setup is used.
import { z } from "zod";

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  inPerM: number;
  outPerM: number;
}

type Env = Record<string, string | undefined>;

const ProviderEntry = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  keyEnv: z.string().min(1),
  model: z.string().min(1),
  inPerM: z.number().nonnegative(),
  outPerM: z.number().nonnegative(),
});
const ProviderList = z.array(ProviderEntry).min(1);

const Legacy = z.object({
  LLM_BASE_URL: z.string().url(),
  LLM_API_KEY: z.string().min(1),
  BIKININ_MODEL: z.string().min(1),
  PRICE_INPUT_PER_M: z.coerce.number().nonnegative(),
  PRICE_OUTPUT_PER_M: z.coerce.number().nonnegative(),
});

function issuesText(error: z.ZodError): string {
  return error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}

export function resolveProviders(env: Env): ProviderConfig[] {
  const raw = env.BIKININ_PROVIDERS?.trim();
  if (raw) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error("BIKININ_PROVIDERS bukan JSON yang valid");
    }
    const parsed = ProviderList.safeParse(json);
    if (!parsed.success)
      throw new Error(
        `BIKININ_PROVIDERS tidak valid:\n${issuesText(parsed.error)}`,
      );
    return parsed.data.map((p) => {
      const apiKey = env[p.keyEnv];
      if (!apiKey)
        throw new Error(
          `Variabel ${p.keyEnv} kosong (dibutuhkan provider "${p.name}")`,
        );
      return {
        name: p.name,
        baseUrl: p.baseUrl,
        apiKey,
        model: p.model,
        inPerM: p.inPerM,
        outPerM: p.outPerM,
      };
    });
  }

  const legacy = Legacy.safeParse(env);
  if (!legacy.success) {
    throw new Error(
      `Isi BIKININ_PROVIDERS atau variabel LLM_* di .env:\n${issuesText(legacy.error)}`,
    );
  }
  const d = legacy.data;
  return [
    {
      name: "default",
      baseUrl: d.LLM_BASE_URL,
      apiKey: d.LLM_API_KEY,
      model: d.BIKININ_MODEL,
      inPerM: d.PRICE_INPUT_PER_M,
      outPerM: d.PRICE_OUTPUT_PER_M,
    },
  ];
}
