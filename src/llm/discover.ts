// Asks a provider for its model list (GET <baseUrl>/models). Runs on the server so the key stays there.
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 300;

export type FetchLike = typeof fetch;

export async function discoverModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<string[]> {
  const res = await fetchImpl(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    redirect: "error", // a redirect could carry the key to another host
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Provider menjawab ${res.status}`);

  let text = "";
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new Error("Daftar model terlalu besar");
      }
      text += decoder.decode(value, { stream: true });
    }
  } else {
    text = await res.text();
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Jawaban provider bukan JSON");
  }
  const list = (json as { data?: unknown }).data;
  if (!Array.isArray(list))
    throw new Error("Format daftar model tidak dikenali");
  const ids = list
    .map((m) =>
      m && typeof m === "object" ? (m as { id?: unknown }).id : undefined,
    )
    .filter(
      (id): id is string =>
        typeof id === "string" && id.length > 0 && id.length <= 200,
    );
  return [...new Set(ids)].sort().slice(0, MAX_MODELS);
}
