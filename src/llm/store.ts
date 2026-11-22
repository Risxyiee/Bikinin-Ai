// Persistent provider settings entered from the UI. Stored outside the repo (default ~/.bikinin),
// file mode 0600, written atomically. API keys live only here and in memory; they are never
// returned by the API or written to events or logs.
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const StoredModel = z.object({
  id: z.string().min(1).max(200),
  inPerM: z.number().min(0).max(1000),
  outPerM: z.number().min(0).max(1000),
});
export const StoredProvider = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().min(1).max(32),
  baseUrl: z.string().url(),
  apiKey: z.string().min(8).max(512),
  models: z.array(StoredModel).max(50),
});
const StoreSchema = z.object({
  providers: z.array(StoredProvider).max(20),
  settings: z
    .object({
      fallback: z.boolean().default(true),
      default: z.string().max(260).optional(),
    })
    .default({ fallback: true }),
});

export type StoredModel = z.infer<typeof StoredModel>;
export type StoredProvider = z.infer<typeof StoredProvider>;
export type StoreData = z.infer<typeof StoreSchema>;

export const defaultConfigDir = (): string =>
  process.env.BIKININ_CONFIG_DIR ?? join(homedir(), ".bikinin");

const empty = (): StoreData => ({
  providers: [],
  settings: { fallback: true },
});

export class ProviderStore {
  private data: StoreData | null = null;

  /** dir = null keeps everything in memory (tests, or when no config folder is wanted). */
  constructor(private readonly dir: string | null) {}

  private get file(): string | null {
    return this.dir ? join(this.dir, "providers.json") : null;
  }

  get(): StoreData {
    if (this.data) return this.data;
    const file = this.file;
    if (!file) return (this.data = empty());
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return (this.data = empty());
    }
    const parsed = StoreSchema.safeParse(safeJson(raw));
    if (parsed.success) return (this.data = parsed.data);
    // Never overwrite a file we cannot read: keep a copy, then start clean.
    try {
      renameSync(file, `${file}.bad-${Date.now()}`);
    } catch {
      /* best effort */
    }
    return (this.data = empty());
  }

  save(next: StoreData): void {
    const checked = StoreSchema.parse(next);
    this.data = checked;
    const file = this.file;
    if (!file || !this.dir) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(checked, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* not supported on every filesystem */
    }
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
