// Reads configuration from .env / process.env. Never logs values.
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const ConfigSchema = z.object({
  LLM_BASE_URL: z.string().url("harus URL lengkap, contoh https://.../v1"),
  LLM_API_KEY: z.string().min(1, "kosong"),
  BIKININ_MODEL: z.string().min(1, "kosong"),
  BIKININ_CHEAP_MODEL: z.string().optional(),
  PRICE_INPUT_PER_M: z.coerce.number().nonnegative(),
  PRICE_OUTPUT_PER_M: z.coerce.number().nonnegative(),
  BIKININ_USD_IDR: z.coerce.number().positive().default(17000),
  BIKININ_MAX_STEPS: z.coerce.number().int().positive().default(30),
  BIKININ_MAX_COST_USD: z.coerce.number().positive().default(0.5),
  BIKININ_WORKSPACE: z.string().min(1).default("./workspace"),
  BIKININ_MAX_VIDEO_SECONDS: z.coerce.number().int().positive().default(30),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  loadDotenv({ quiet: true });
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join(".")}: ${i.message}`,
    );
    throw new Error(`Konfigurasi .env tidak valid:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
