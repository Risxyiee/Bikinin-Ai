// One list of selectable models: providers from the environment (read-only) plus providers added
// in the UI. Resolves which model a run uses and the fallback order. Never exposes API keys.
import type { ProviderConfig } from "./providers.js";
import { ProviderStore, type StoredModel } from "./store.js";

export class CatalogError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Choice {
  id: string; // "<providerId>:<model>"
  providerId: string;
  providerName: string;
  model: string;
  inPerM: number;
  outPerM: number;
  source: "env" | "user";
  config: ProviderConfig;
}

export interface PublicProvider {
  id: string;
  name: string;
  host: string;
  source: "env" | "user";
  models: StoredModel[];
}

export const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "provider";

/** https only, no credentials, no localhost, no IP literals: a provider is a public API host. */
export function validateBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new CatalogError(400, "URL tidak valid");
  }
  if (u.protocol !== "https:")
    throw new CatalogError(400, "URL harus diawali https://");
  if (u.username || u.password)
    throw new CatalogError(400, "URL tidak boleh memuat user atau password");
  const host = u.hostname.toLowerCase();
  const isIp =
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.includes(":") ||
    host.startsWith("[");
  if (
    isIp ||
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".")
  ) {
    throw new CatalogError(
      400,
      "Host harus nama domain publik (bukan IP atau localhost)",
    );
  }
  u.hash = "";
  u.search = "";
  return u.toString().replace(/\/+$/, "");
}

export function validateApiKey(raw: string): string {
  const key = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (key.length < 8 || key.length > 512 || /[\s\u0000-\u001f]/.test(key)) {
    throw new CatalogError(
      400,
      "API key tidak valid (8-512 karakter, tanpa spasi)",
    );
  }
  return key;
}

export class Catalog {
  constructor(
    private readonly env: ProviderConfig[],
    readonly store: ProviderStore,
  ) {}

  choices(): Choice[] {
    const out: Choice[] = [];
    for (const p of this.env) {
      const providerId = slug(p.name);
      out.push({
        id: `${providerId}:${p.model}`,
        providerId,
        providerName: p.name,
        model: p.model,
        inPerM: p.inPerM,
        outPerM: p.outPerM,
        source: "env",
        config: p,
      });
    }
    for (const sp of this.store.get().providers) {
      for (const m of sp.models) {
        out.push({
          id: `${sp.id}:${m.id}`,
          providerId: sp.id,
          providerName: sp.name,
          model: m.id,
          inPerM: m.inPerM,
          outPerM: m.outPerM,
          source: "user",
          config: {
            name: sp.name,
            baseUrl: sp.baseUrl,
            apiKey: sp.apiKey,
            model: m.id,
            inPerM: m.inPerM,
            outPerM: m.outPerM,
          },
        });
      }
    }
    return out;
  }

  settings(): { fallback: boolean; default: string } {
    const all = this.choices();
    const saved = this.store.get().settings;
    const def =
      saved.default && all.some((c) => c.id === saved.default)
        ? saved.default
        : all[0].id;
    return { fallback: saved.fallback, default: def };
  }

  /** The model for a run and the order to try on failure. null = the id is not a known model. */
  resolve(
    choiceId?: string,
  ): { selected: Choice; chain: ProviderConfig[] } | null {
    const all = this.choices();
    const id = choiceId ?? this.settings().default;
    const selected = all.find((c) => c.id === id);
    if (!selected) return null;
    const rest = this.settings().fallback
      ? all.filter((c) => c.id !== selected.id).map((c) => c.config)
      : [];
    return { selected, chain: [selected.config, ...rest] };
  }

  providers(): PublicProvider[] {
    const env: PublicProvider[] = this.env.map((p) => ({
      id: slug(p.name),
      name: p.name,
      host: hostOf(p.baseUrl),
      source: "env",
      models: [{ id: p.model, inPerM: p.inPerM, outPerM: p.outPerM }],
    }));
    const user: PublicProvider[] = this.store.get().providers.map((p) => ({
      id: p.id,
      name: p.name,
      host: hostOf(p.baseUrl),
      source: "user",
      models: p.models,
    }));
    return [...env, ...user];
  }

  addProvider(input: {
    name: string;
    baseUrl: string;
    apiKey: string;
  }): PublicProvider {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 32)
      throw new CatalogError(400, "Nama 1-32 karakter");
    const baseUrl = validateBaseUrl(input.baseUrl);
    const apiKey = validateApiKey(input.apiKey);
    const data = this.store.get();
    if (data.providers.length >= 20)
      throw new CatalogError(400, "Maksimal 20 provider");
    const taken = new Set([
      ...this.env.map((p) => slug(p.name)),
      ...data.providers.map((p) => p.id),
    ]);
    let id = slug(name);
    for (let n = 2; taken.has(id); n++) id = `${slug(name).slice(0, 36)}-${n}`;
    this.store.save({
      ...data,
      providers: [...data.providers, { id, name, baseUrl, apiKey, models: [] }],
    });
    return this.providers().find((p) => p.id === id) as PublicProvider;
  }

  private user(id: string) {
    const data = this.store.get();
    const p = data.providers.find((x) => x.id === id);
    if (!p)
      throw new CatalogError(
        404,
        "Provider tidak ditemukan (provider dari .env tidak bisa diubah di sini)",
      );
    return { data, p };
  }

  /** Server-side only: used to call the provider. Never sent to the browser. */
  credentials(id: string): { baseUrl: string; apiKey: string } {
    const { p } = this.user(id);
    return { baseUrl: p.baseUrl, apiKey: p.apiKey };
  }

  setModels(id: string, models: StoredModel[]): PublicProvider {
    const { data } = this.user(id);
    const seen = new Set<string>();
    const unique = models.filter((m) =>
      seen.has(m.id) ? false : (seen.add(m.id), true),
    );
    this.store.save({
      ...data,
      providers: data.providers.map((x) =>
        x.id === id ? { ...x, models: unique } : x,
      ),
    });
    return this.providers().find((p) => p.id === id) as PublicProvider;
  }

  removeProvider(id: string): void {
    const { data } = this.user(id);
    const remaining = data.providers.filter((x) => x.id !== id);
    const def = data.settings.default;
    this.store.save({
      providers: remaining,
      settings: {
        ...data.settings,
        default: def && def.startsWith(`${id}:`) ? undefined : def,
      },
    });
  }

  setSettings(patch: { fallback?: boolean; default?: string | null }): void {
    const data = this.store.get();
    const next = { ...data.settings };
    if (typeof patch.fallback === "boolean") next.fallback = patch.fallback;
    if (patch.default === null) next.default = undefined;
    else if (typeof patch.default === "string") {
      if (!this.choices().some((c) => c.id === patch.default))
        throw new CatalogError(400, "Model tidak dikenal");
      next.default = patch.default;
    }
    this.store.save({ ...data, settings: next });
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}
